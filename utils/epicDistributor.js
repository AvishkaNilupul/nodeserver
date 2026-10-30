// Epic auto-distributor: decides where every new sellable Epic account goes
// (PlayerAuctions, an existing Eldorado listing, a G2G Instant offer, or the
// reserve) and, when switched on, lists it there through each market's own
// existing path. Contract: docs/EPIC-DISTRIBUTOR-CONTRACT.md.
//
// Locking: epicPa.publish, epicSales.addAccounts and epicG2g.loadStock each
// take epicSales' shared lock themselves. This file must never hold that lock
// while calling them (the queue is not re-entrant), and never needs to: each of
// those paths re-checks the account's readiness under the lock, so an account
// taken by another path in the meantime is refused there, not sold twice.
const EpicListing = require("../models/EpicListing");
const EpicPaUnit = require("../models/EpicPaUnit");
const EpicG2gUnit = require("../models/EpicG2gUnit");
const State = require("../models/EpicDistributorState");
const { encrypt, decrypt } = require("./secretBox");
const sales = require("./epicSales");

// Loaded lazily: epicG2g reads this module's mode() from its sweep.
const paMod = () => require("./epicPa");
const g2gMod = () => require("./epicG2g");

const ACTOR = "auto-distributor";
const RUN_MS = Number(process.env.EPIC_DISTRIBUTOR_MS) || 10 * 60 * 1000;
const FIRST_RUN_MS = 2 * 60 * 1000;
const BACKOFF_MS = 6 * 3600 * 1000;
const PLAN_ROWS = 60;
const PA_MIN_USD = 5;
// Same rule PlayerAuctions' Account form applies (utils/playerauctionsAccountOffers).
const PHONE_RE = /^[0-9\-., ()]{9,17}$/;

// accountId -> time of the last failed listing attempt (in memory: a restart
// simply retries once, and every market path re-vets the account anyway).
const failures = new Map();
let running = false;
let timer = null;
let firstTimer = null;

function userError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.user = true;
  return e;
}

function intIn(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}

function labelOf(acc) {
  return (acc && (acc.label || acc.displayName || acc.accountId)) || "";
}

function profileOf(acc) {
  try {
    const v = JSON.parse(decrypt(acc && acc.accountDetails) || "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function fmtUtc(d) {
  const t = new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function readOwner(enc) {
  if (!enc) return null;
  try {
    const o = JSON.parse(decrypt(enc) || "{}");
    const phone = String(o.phone || "").trim();
    const city = String(o.city || "").trim();
    return phone && city ? { phone, city } : null;
  } catch {
    return null;
  }
}

function normalize(doc) {
  const d = doc || {};
  const pa = d.pa || {};
  const eld = d.eldorado || {};
  const g = d.g2g || {};
  return {
    mode: ["off", "plan", "on"].includes(d.mode) ? d.mode : "plan",
    holdWhileFree: d.holdWhileFree !== false,
    pa: {
      enabled: pa.enabled !== false,
      maxLive: intIn(pa.maxLive, 0, 50, 3),
      priceUsd: Number(pa.priceUsd) >= PA_MIN_USD ? Number(pa.priceUsd) : PA_MIN_USD,
    },
    eldorado: { enabled: eld.enabled !== false, maxPerListing: intIn(eld.maxPerListing, 0, 100, 10) },
    g2g: { enabled: g.enabled !== false, maxStock: intIn(g.maxStock, 0, 200, 10) },
    owner: readOwner(d.ownerEnc),
    ownerUpdatedAt: d.ownerUpdatedAt || null,
    updatedBy: d.updatedBy || "",
    lastRunAt: d.lastRunAt || null,
    lastRunMode: d.lastRunMode || "",
    lastRunOk: d.lastRunOk !== false,
    lastRunNote: d.lastRunNote || "",
    lastPlacedAt: d.lastPlacedAt || null,
    lastPlan: d.lastPlan || [],
    lastMarkets: d.lastMarkets || null,
  };
}

async function getState() {
  return normalize(await State.findById("main").lean());
}

// For the G2G sweep: never throws; an unreadable state keeps today's behaviour.
async function mode() {
  try {
    return (await getState()).mode;
  } catch {
    return "plan";
  }
}

// What the G2G sweep may load by itself: null = anything ready (distributor
// not on), an empty set = nothing new (the distributor places accounts).
async function g2gSweepOnly() {
  return (await mode()) === "on" ? new Set() : null;
}

// The owner's saved phone + city (for epicPa's manual form too), or null.
async function savedOwner() {
  try {
    return (await getState()).owner;
  } catch {
    return null;
  }
}

async function setConfig(patch, actor) {
  const p = patch || {};
  const set = { updatedBy: String(actor || "") };
  if (p.mode != null) {
    const m = String(p.mode);
    if (!["off", "plan", "on"].includes(m)) throw userError("Mode must be off, plan or on");
    if (m === "on" && p.confirm !== true) throw userError("Turning automatic listing on needs confirm: true");
    set.mode = m;
  }
  if (typeof p.holdWhileFree === "boolean") set.holdWhileFree = p.holdWhileFree;
  const num = (v, lo, hi, label) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw userError(label + " must be a whole number from " + lo + " to " + hi);
    return n;
  };
  if (p.pa) {
    if (typeof p.pa.enabled === "boolean") set["pa.enabled"] = p.pa.enabled;
    if (p.pa.maxLive != null) set["pa.maxLive"] = num(p.pa.maxLive, 0, 50, "PlayerAuctions offers");
    if (p.pa.priceUsd != null) {
      const v = Number(p.pa.priceUsd);
      if (!Number.isFinite(v) || v < PA_MIN_USD || v > 500 || Math.abs(Math.round(v * 100) - v * 100) > 1e-7) {
        throw userError("PlayerAuctions price must be $5 to $500 with at most two decimals");
      }
      set["pa.priceUsd"] = v;
    }
  }
  if (p.eldorado) {
    if (typeof p.eldorado.enabled === "boolean") set["eldorado.enabled"] = p.eldorado.enabled;
    if (p.eldorado.maxPerListing != null) set["eldorado.maxPerListing"] = num(p.eldorado.maxPerListing, 0, 100, "Eldorado accounts per listing");
  }
  if (p.g2g) {
    if (typeof p.g2g.enabled === "boolean") set["g2g.enabled"] = p.g2g.enabled;
    if (p.g2g.maxStock != null) set["g2g.maxStock"] = num(p.g2g.maxStock, 0, 200, "G2G stock");
  }
  await State.updateOne({ _id: "main" }, { $set: set }, { upsert: true });
  return view();
}

async function setOwner(body, actor) {
  const b = body || {};
  if (b.clear === true) {
    await State.updateOne(
      { _id: "main" },
      { $set: { ownerEnc: "", ownerUpdatedAt: new Date(), updatedBy: String(actor || "") } },
      { upsert: true },
    );
    return view();
  }
  const phone = String(b.phone || "").trim();
  const city = String(b.city || "").trim();
  if (!PHONE_RE.test(phone)) {
    throw userError("Phone: 9 to 17 characters, digits with spaces, dashes, dots or brackets (no +)");
  }
  if (!city || city.length > 60 || /[<>\r\n]/.test(city)) throw userError("Enter your city (up to 60 characters)");
  await State.updateOne(
    { _id: "main" },
    { $set: { ownerEnc: encrypt(JSON.stringify({ phone, city })), ownerUpdatedAt: new Date(), updatedBy: String(actor || "") } },
    { upsert: true },
  );
  return view();
}

function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  return d ? "•••• " + d.slice(-4) : "";
}

// Panel view: never the owner's phone in clear.
async function view() {
  const s = await getState();
  return {
    config: { mode: s.mode, holdWhileFree: s.holdWhileFree, pa: s.pa, eldorado: s.eldorado, g2g: s.g2g },
    owner: s.owner
      ? { saved: true, phone: maskPhone(s.owner.phone), city: s.owner.city, updatedAt: s.ownerUpdatedAt }
      : { saved: false },
    lastRun: { at: s.lastRunAt, mode: s.lastRunMode, ok: s.lastRunOk, note: s.lastRunNote, placedAt: s.lastPlacedAt },
    plan: s.lastPlan,
    markets: s.lastMarkets,
    runEveryMin: Math.round(RUN_MS / 60000),
  };
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

// PlayerAuctions' original-owner block. Name, email and country are the
// account's own Epic registration; phone and city are only ever the owner's
// saved details. The sample phone/address generated accounts carry
// (contactSource "synthetic-internal") is never used.
function paContact(acc, owner) {
  const p = profileOf(acc);
  return {
    firstName: String(p.firstName || "").trim(),
    lastName: String(p.lastName || "").trim(),
    email: String(decrypt(acc.email) || "").trim().toLowerCase(),
    country: String(p.country || "").trim(),
    phone: (owner && owner.phone) || "",
    city: (owner && owner.city) || "",
  };
}

function stillFree(titles, freebies, now) {
  const want = new Set((titles || []).map((t) => String(t).toLowerCase()));
  return (freebies || []).filter(
    (f) => want.has(String(f.title || "").toLowerCase()) && (!f.endDate || new Date(f.endDate).getTime() > now),
  );
}

function ownsAll(titles, games) {
  const have = new Set((titles || []).map((t) => String(t).trim().toLowerCase()));
  return (games || []).every((g) => have.has(String(g).trim().toLowerCase()));
}

function paSessionAlive(now) {
  try {
    const e = require("./marketplaces").playerauctionsTokenExpiry();
    const r = e && e.refresh ? new Date(e.refresh).getTime() : 0;
    return r > now;
  } catch {
    return false;
  }
}

async function paMarket(cfg, now) {
  const m = { key: "pa", name: "PlayerAuctions", priceUsd: cfg.pa.priceUsd, cap: cfg.pa.maxLive, used: 0, planned: 0, open: 0, ok: false, status: "" };
  m.used = await EpicPaUnit.countDocuments({ state: { $in: ["listed", "paused", "loading", "error"] } });
  const stuck = await EpicPaUnit.countDocuments({ state: { $in: ["loading", "error"] } });
  if (!cfg.pa.enabled) m.status = "Switched off";
  else if (!cfg.owner) m.status = "Needs your phone and city (below)";
  else if (stuck) m.status = stuck + " offer(s) need checking in the PlayerAuctions card first";
  else if (!sales.providerUrl()) m.status = "PUBLIC_BASE_URL is not set";
  else if (!paSessionAlive(now)) m.status = "PlayerAuctions session expired: paste a fresh cookie";
  else m.ok = true;
  m.open = m.ok ? Math.max(0, m.cap - m.used) : 0;
  if (m.ok) m.status = m.open ? m.open + " free" : "Full";
  return m;
}

async function eldoradoMarket(cfg, candidates) {
  const m = { key: "eldorado", name: "Eldorado", listings: [], ok: false, status: "" };
  if (!cfg.eldorado.enabled) {
    m.status = "Switched off";
    return m;
  }
  // Only the Epic Games section: a Rocket League listing takes fresh accounts
  // by hand, never ones the distributor places.
  const live = (await EpicListing.find({ status: { $in: ["active", "sold_out"] } }).lean()).filter(
    (l) => (l.section || "epic") === "epic",
  );
  if (!live.length) {
    m.status = "No live Eldorado listing to add to (listings are made by hand)";
    return m;
  }
  const keys = new Set(candidates.map((c) => sales.gameKey(c.r.titles)));
  const relevant = live.filter((l) => l.gameKey && keys.has(l.gameKey));
  if (!relevant.length) {
    m.status = live.length + " live listing(s), none for these game sets";
    return m;
  }
  // Asked only when an account could go there (cached 10 min in epicSales).
  const perm = await sales._internals.eldoradoPermission();
  if (!perm || perm.canSell !== true) {
    m.status = "Eldorado doesn't allow Epic accounts on this seller yet";
    return m;
  }
  m.ok = true;
  m.listings = relevant.map((l) => ({
    id: String(l._id),
    gameKey: l.gameKey,
    title: l.title,
    priceUsd: l.priceUsd,
    used: (l.accounts || []).filter((u) => u.state === "listed").length,
    planned: 0,
    cap: cfg.eldorado.maxPerListing,
  }));
  const open = m.listings.reduce((n, l) => n + Math.max(0, l.cap - l.used), 0);
  m.status = open ? open + " free" : "Full";
  return m;
}

async function g2gMarket(cfg) {
  const m = { key: "g2g", name: "G2G", offers: [], ok: false, status: "" };
  if (!cfg.g2g.enabled) {
    m.status = "Switched off";
    return m;
  }
  const links = (await g2gMod().instantLinks()).filter((l) => l.mode === "instant" && l.enabled !== false);
  if (!links.length) {
    m.status = "No linked G2G Instant offer";
    return m;
  }
  for (const l of links) {
    const used = await EpicG2gUnit.countDocuments({ offerId: l.offerId, state: { $in: ["listed", "loading"] } });
    m.offers.push({ offerId: l.offerId, title: l.title || "", games: l.games || [], used, planned: 0, cap: cfg.g2g.maxStock });
  }
  m.ok = true;
  const open = m.offers.reduce((n, o) => n + Math.max(0, o.cap - o.used), 0);
  m.status = open ? open + " free" : "Full";
  return m;
}

const ORDER = { pa: 0, eldorado: 1, g2g: 2, reserve: 3, hold: 4, skip: 5 };

async function computePlan(cfg, now = Date.now()) {
  const ctx = await sales.stockContext({ fresh: false });
  const rows = [];
  const candidates = [];
  for (const acc of ctx.accounts) {
    const r = sales.readinessOf(acc, ctx);
    if (r.state === "sold" || r.state === "listed") continue;
    const row = { accountId: String(acc._id), label: labelOf(acc), games: r.titles.slice(0, 12), decision: "", target: "", reason: "", outcome: "" };
    const hold = (reason) => rows.push({ ...row, decision: "hold", reason });
    if (acc.source !== "generated") {
      rows.push({ ...row, decision: "skip", reason: "Added by hand: never listed automatically" });
      continue;
    }
    if (r.state === "blocked") {
      hold(r.blockers.join("; "));
      continue;
    }
    if (!r.titles.length) {
      hold("No games yet: waiting for free-game claims");
      continue;
    }
    if (cfg.holdWhileFree) {
      const free = stillFree(r.titles, ctx.freebies, now);
      if (free.length) {
        hold(free.map((f) => f.title).join(", ") + " is still free on Epic until " + fmtUtc(free[0].endDate));
        continue;
      }
    }
    const failedAt = failures.get(row.accountId);
    if (failedAt && now - failedAt < BACKOFF_MS) {
      hold("Last listing attempt failed; tries again after " + fmtUtc(failedAt + BACKOFF_MS));
      continue;
    }
    candidates.push({ acc, r, row });
  }

  const markets = {
    pa: await paMarket(cfg, now),
    eldorado: await eldoradoMarket(cfg, candidates),
    g2g: await g2gMarket(cfg),
  };
  const taken = new Map();
  const created = (c) => new Date(c.acc.createdAt).getTime() || 0;
  const value = (c) => Number(c.acc.libraryValueUsd) || 0;

  // 1. PlayerAuctions: one account per $5+ offer, the richest accounts first.
  const paSkip = new Map();
  if (markets.pa.ok) {
    let open = markets.pa.open;
    const rich = [...candidates].sort((a, b) => b.r.titles.length - a.r.titles.length || value(b) - value(a) || created(a) - created(b));
    for (const c of rich) {
      if (c.acc.totpSecret) {
        paSkip.set(c.row.accountId, "has 2FA");
        continue;
      }
      const ct = paContact(c.acc, cfg.owner);
      if (!ct.firstName || !ct.lastName || !ct.country || !ct.email) {
        paSkip.set(c.row.accountId, "no registration name/country saved");
        continue;
      }
      if (!open) continue;
      taken.set(c.row.accountId, { decision: "pa", target: "", reason: "PlayerAuctions offer at $" + cfg.pa.priceUsd.toFixed(2) });
      open--;
      markets.pa.planned++;
    }
  }
  // 2. Eldorado: top up a live listing for exactly this game set.
  if (markets.eldorado.ok) {
    for (const l of markets.eldorado.listings) {
      let open = Math.max(0, l.cap - l.used);
      for (const c of candidates) {
        if (!open) break;
        if (taken.has(c.row.accountId) || sales.gameKey(c.r.titles) !== l.gameKey) continue;
        taken.set(c.row.accountId, { decision: "eldorado", target: l.id, reason: "Added to Eldorado listing “" + l.title + "”" });
        open--;
        l.planned++;
      }
    }
  }
  // 3. G2G Instant offers: the leanest accounts that own the offer's games.
  if (markets.g2g.ok) {
    const lean = [...candidates].sort((a, b) => a.r.titles.length - b.r.titles.length || created(a) - created(b));
    for (const o of markets.g2g.offers) {
      let open = Math.max(0, o.cap - o.used);
      for (const c of lean) {
        if (!open) break;
        if (taken.has(c.row.accountId) || !ownsAll(c.r.titles, o.games)) continue;
        taken.set(c.row.accountId, { decision: "g2g", target: o.offerId, reason: "Into G2G offer " + o.offerId + " stock" });
        open--;
        o.planned++;
      }
    }
  }
  // 4. Everything else waits in the reserve, with the reason per market.
  for (const c of candidates) {
    const t = taken.get(c.row.accountId);
    if (t) {
      rows.push({ ...c.row, ...t });
      continue;
    }
    const why = [];
    const pa = markets.pa;
    const full = (x) => "full (" + (x.used + x.planned) + "/" + x.cap + ")";
    const lc = (t) => String(t || "").charAt(0).toLowerCase() + String(t || "").slice(1);
    why.push("PlayerAuctions: " + (paSkip.get(c.row.accountId) || (pa.ok ? full(pa) : lc(pa.status))));
    const eld = markets.eldorado;
    if (eld.ok) {
      const l = eld.listings.find((x) => x.gameKey === sales.gameKey(c.r.titles));
      why.push("Eldorado: " + (l ? full(l) : "no listing for these games"));
    } else if (cfg.eldorado.enabled) {
      why.push("Eldorado: " + lc(eld.status));
    }
    const g = markets.g2g;
    if (g.ok) {
      const fits = g.offers.filter((o) => ownsAll(c.r.titles, o.games));
      why.push("G2G: " + (fits.length ? fits.map(full).join(", ") : "no offer for these games"));
    } else {
      why.push("G2G: " + lc(g.status));
    }
    rows.push({ ...c.row, decision: "reserve", reason: why.join(" · ") });
  }
  rows.sort((a, b) => ORDER[a.decision] - ORDER[b.decision]);
  return { rows, markets, byId: new Map(candidates.map((c) => [c.row.accountId, c])) };
}

function errText(e) {
  return String((e && e.message) || e || "error").slice(0, 200);
}

async function execute(plan, cfg, now = Date.now()) {
  const placed = { pa: 0, eldorado: 0, g2g: 0 };
  const failed = [];
  const fail = (row, msg) => {
    row.outcome = "failed";
    row.reason = msg;
    failures.set(row.accountId, now);
    failed.push(row.label + ": " + msg);
  };

  // PlayerAuctions: ONE publish per run (PA throttles writes, and a publish
  // whose outcome is unclear stays reserved for the owner to reconcile).
  const paRows = plan.rows.filter((r) => r.decision === "pa");
  if (paRows.length) {
    const row = paRows[0];
    const c = plan.byId.get(row.accountId);
    try {
      await paMod().publish(row.accountId, { original: paContact(c.acc, cfg.owner), priceUsd: cfg.pa.priceUsd }, ACTOR);
      row.outcome = "placed";
      placed.pa++;
    } catch (e) {
      fail(row, "PlayerAuctions: " + errText(e));
    }
    for (const r of paRows.slice(1)) {
      r.outcome = "queued";
      r.reason += " (next run: one new PlayerAuctions offer per run)";
    }
  }

  // Eldorado: one call per listing.
  const byListing = new Map();
  for (const r of plan.rows.filter((x) => x.decision === "eldorado")) {
    if (!byListing.has(r.target)) byListing.set(r.target, []);
    byListing.get(r.target).push(r);
  }
  for (const [listingId, rows] of byListing) {
    try {
      await sales.addAccounts(listingId, rows.map((r) => r.accountId), ACTOR);
      for (const r of rows) r.outcome = "placed";
      placed.eldorado += rows.length;
    } catch (e) {
      for (const r of rows) fail(r, "Eldorado: " + errText(e));
    }
  }

  // G2G: load exactly the planned accounts into each offer's stock.
  const byOffer = new Map();
  for (const r of plan.rows.filter((x) => x.decision === "g2g")) {
    if (!byOffer.has(r.target)) byOffer.set(r.target, []);
    byOffer.get(r.target).push(r);
  }
  for (const [offerId, rows] of byOffer) {
    let note = "";
    try {
      const res = await g2gMod().loadStock(offerId, { only: new Set(rows.map((r) => r.accountId)) });
      if (res && res.skipped) note = res.skipped;
    } catch (e) {
      note = errText(e);
    }
    const ids = rows.map((r) => r.accountId);
    const units = await EpicG2gUnit.find({ offerId, epicAccountId: { $in: ids }, state: { $in: ["loading", "listed"] } })
      .select("epicAccountId")
      .lean();
    const loaded = new Set(units.map((u) => String(u.epicAccountId)));
    for (const r of rows) {
      if (loaded.has(r.accountId)) {
        r.outcome = "placed";
        placed.g2g++;
      } else {
        fail(r, "G2G: " + (note || "not taken by the stock load (re-checked and not ready)"));
      }
    }
  }
  return { placed, failed };
}

function summary(placed, rows) {
  const parts = [];
  if (placed.pa) parts.push(placed.pa + " on PlayerAuctions");
  if (placed.eldorado) parts.push(placed.eldorado + " on Eldorado");
  if (placed.g2g) parts.push(placed.g2g + " into G2G stock");
  const count = (d) => rows.filter((r) => r.decision === d).length;
  return (
    "Epic auto-distributor listed " + parts.join(", ") + ". " +
    count("reserve") + " in reserve, " + count("hold") + " held (no games yet, still free on Epic, or blocked)."
  );
}

async function notify(text) {
  try {
    await require("./telegram").sendTelegram(text);
  } catch (e) {
    console.error("[epicDistributor] telegram:", errText(e));
  }
}

function marketsView(m) {
  return {
    pa: { name: m.pa.name, ok: m.pa.ok, status: m.pa.status, used: m.pa.used, cap: m.pa.cap, priceUsd: m.pa.priceUsd },
    eldorado: { name: m.eldorado.name, ok: m.eldorado.ok, status: m.eldorado.status, listings: m.eldorado.listings },
    g2g: { name: m.g2g.name, ok: m.g2g.ok, status: m.g2g.status, offers: m.g2g.offers },
  };
}

// One pass. execute=false (Preview) never changes anything; execute=true acts
// only while the mode is "on".
async function run({ execute: wantExec = true, now = Date.now() } = {}) {
  if (running) return { skipped: "A run is already in progress" };
  running = true;
  try {
    const cfg = await getState();
    if (wantExec && cfg.mode === "off") return { skipped: "Automatic listing is off" };
    let plan;
    try {
      plan = await computePlan(cfg, now);
    } catch (e) {
      await State.updateOne(
        { _id: "main" },
        { $set: { lastRunAt: new Date(now), lastRunOk: false, lastRunNote: "Plan failed: " + errText(e) } },
        { upsert: true },
      );
      throw e;
    }
    const doExec = wantExec && cfg.mode === "on";
    let result = { placed: { pa: 0, eldorado: 0, g2g: 0 }, failed: [] };
    if (doExec) result = await execute(plan, cfg, now);
    const total = result.placed.pa + result.placed.eldorado + result.placed.g2g;
    const note = doExec
      ? (total ? summary(result.placed, plan.rows) : "Nothing new to list.") +
        (result.failed.length ? " Failed: " + result.failed.join("; ") : "")
      : "Plan only: nothing was listed.";
    const set = {
      lastRunAt: new Date(now),
      lastRunMode: doExec ? "on" : "plan",
      lastRunOk: !result.failed.length,
      lastRunNote: note.slice(0, 1000),
      lastPlan: plan.rows.slice(0, PLAN_ROWS),
      lastMarkets: marketsView(plan.markets),
    };
    if (total) set.lastPlacedAt = new Date(now);
    await State.updateOne({ _id: "main" }, { $set: set }, { upsert: true });
    if (total || result.failed.length) await notify(note);
    return { mode: cfg.mode, executed: doExec, placed: result.placed, failed: result.failed, rows: plan.rows, markets: set.lastMarkets };
  } finally {
    running = false;
  }
}

function start() {
  if (timer || firstTimer) return;
  const tick = () =>
    run().catch((e) => console.error("[epicDistributor] run:", errText(e)));
  firstTimer = setTimeout(() => {
    firstTimer = null;
    tick();
    timer = setInterval(tick, RUN_MS);
    if (timer.unref) timer.unref();
  }, FIRST_RUN_MS);
  if (firstTimer.unref) firstTimer.unref();
}

function stop() {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
}

module.exports = {
  start,
  stop,
  run,
  view,
  setConfig,
  setOwner,
  savedOwner,
  mode,
  g2gSweepOnly,
  paContact,
  _internals: { computePlan, execute, failures, normalize, maskPhone, stillFree, ownsAll },
};
