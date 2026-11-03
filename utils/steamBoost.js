// Hour-boost pool for Steam accounts. The worker on contabo2
// (workers/steam-boost) logs in to every account in the pool and "plays" free
// games so Steam books idle hours; this module is everything the server knows
// and decides about it. Contract: docs/STEAM-BOOST.md.
//
// Integrity rules:
//  - an account enters only from stage "stock" (atomic stock → boosting) and
//    is in the pool at most once (partial unique index on SteamBoost);
//  - while boosting, its stage is "boosting", so no listing path can sell it;
//  - boostedAt is set on entry and never cleared (the region offers refuse it);
//  - the worker only ever gets accounts whose row is queued/boosting AND whose
//    stage is still "boosting"; anything else is stopped on the next read.
const SteamAccount = require("../models/SteamAccount");
const SteamBoost = require("../models/SteamBoost");
const SteamSalesState = require("../models/SteamSalesState");
const { encrypt } = require("./secretBox");
const games = require("./steamBoostGames");
const sales = require("./steamSales");

const S = sales._shared;
const ACTIVE = ["queued", "boosting"];
const MILESTONES = [500, 1000];
const WORKER_SILENT_MS = 15 * 60 * 1000;
const WORKER_ALERT_EVERY_MS = 6 * 60 * 60 * 1000;
const WATCH_MS = 5 * 60 * 1000;
const DEFAULTS = { enabled: true, maxAccounts: 50, keepPerRegion: 2 };

const deps = {
  readMailFor: (...a) => require("./outlookGraphReader").readMailFor(...a),
  checkInbox: (...a) => S.checkInbox(...a),
  notify: async (text) => {
    try {
      await require("./telegram").sendTelegram(text);
    } catch (e) {
      console.error("[steamBoost] telegram:", (e && e.message) || e);
    }
  },
  now: () => Date.now(),
};

const userError = S.userError;
const dec = S.dec;

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function settings() {
  const doc = await SteamSalesState.findById("main").select("boost").lean();
  const b = (doc && doc.boost) || {};
  return {
    enabled: b.enabled === undefined ? DEFAULTS.enabled : !!b.enabled,
    maxAccounts: Number.isFinite(b.maxAccounts) ? b.maxAccounts : DEFAULTS.maxAccounts,
    keepPerRegion: Number.isFinite(b.keepPerRegion) ? b.keepPerRegion : DEFAULTS.keepPerRegion,
    targetHours: [500, 1000].includes(b.targetHours) ? b.targetHours : 1000,
    prepareGames: b.prepareGames !== false,
    gamePriceUsd: b.gamePriceUsd || 2,
    boostPriceUsd: b.boostPriceUsd || 3,
    games: Array.isArray(b.games) && b.games.length ? b.games.map(Number) : games.defaultGames(),
    workerLastSeenAt: b.workerLastSeenAt || null,
    workerNote: b.workerNote || "",
    workerVersion: b.workerVersion || "",
    workerAlertAt: b.workerAlertAt || null,
  };
}

function intIn(v, lo, hi, what) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw userError(what + " must be a whole number from " + lo + " to " + hi);
  return n;
}

async function setSettings(body, actor) {
  const set = {};
  if ("enabled" in body) set["boost.enabled"] = !!body.enabled;
  if ("maxAccounts" in body) set["boost.maxAccounts"] = intIn(body.maxAccounts, 0, 500, "Most accounts boosting");
  if ("keepPerRegion" in body) set["boost.keepPerRegion"] = intIn(body.keepPerRegion, 0, 50, "Keep per country");
  // Games apply to accounts added from now on; running ones keep theirs.
  if ("games" in body) set["boost.games"] = games.cleanGames(body.games);
  if ("targetHours" in body) {
    if (![500, 1000].includes(Number(body.targetHours))) throw userError("Target must be 500 or 1000 hours");
    set["boost.targetHours"] = Number(body.targetHours);
  }
  if ("prepareGames" in body) set["boost.prepareGames"] = body.prepareGames === true;
  for (const k of ["gamePriceUsd", "boostPriceUsd"]) if (k in body) {
    const v = Number(body[k]);
    if (!Number.isFinite(v) || v < 0.05 || v > 500) throw userError("Price must be between 0.05 and 500");
    set["boost." + k] = Math.round(v * 100) / 100;
  }
  if (!Object.keys(set).length) throw userError("Nothing to save");
  set.updatedBy = String(actor || "");
  await SteamSalesState.updateOne({ _id: "main" }, { $set: set }, { upsert: true });
  return settings();
}

async function activeCount() {
  return SteamBoost.countDocuments({ state: { $in: [...ACTIVE, "stopping"] } });
}

// ---------------------------------------------------------------------------
// Pool: add, stop, retry
// ---------------------------------------------------------------------------

// Why a stock account can't start boosting ([] = it can). Unlike the region
// offers, a boost doesn't need the account empty or never boosted before.
function boostBlockers(acc, inbox) {
  const out = [];
  if (acc.stage !== "stock") out.push(acc.stage === "boosting" ? "already boosting" : "stage is " + acc.stage + ", not in stock");
  if (!S.regionOf(acc)) out.push("no signup country");
  if (!dec(acc.password)) out.push("no saved password");
  if (!/@/.test(dec(acc.email))) out.push("no saved email");
  if (inbox && !inbox.ok) out.push(inbox.reason);
  return out;
}

// Put stock accounts into the pool. Returns { added: [ids], refused: [{id, why}] }.
async function add(accountIds, actor, { checkInboxes = true, purpose = "boost", saleAppId = null } = {}) {
  if (!["game", "boost"].includes(purpose)) throw userError("Unknown preparation purpose");
  const cfg = await settings();
  const ids = [...new Set((accountIds || []).map(String))].filter((x) => /^[a-f\d]{24}$/i.test(x));
  if (!ids.length) throw userError("Pick at least one account");
  const added = [];
  const refused = [];
  for (const id of ids) {
    const acc = await SteamAccount.findById(id).lean();
    if (!acc) {
      refused.push({ id, why: "not found" });
      continue;
    }
    const email = dec(acc.email).toLowerCase();
    const inbox = checkInboxes && email ? await deps.checkInbox(email, { fresh: true }) : null;
    const why = boostBlockers(acc, inbox);
    if (why.length) {
      refused.push({ id, accountName: acc.accountName, why: why.join("; ") });
      continue;
    }
    const now = new Date(deps.now());
    // stock → boosting only if it is still in stock (another path may have taken it).
    const r = await SteamAccount.updateOne({ _id: acc._id, stage: "stock" }, { $set: { stage: "boosting", boostedAt: acc.boostedAt || now } });
    if (!r || r.modifiedCount !== 1) {
      refused.push({ id, accountName: acc.accountName, why: "taken by another path a moment ago" });
      continue;
    }
    try {
      await SteamBoost.create({
        steamAccountId: acc._id,
        accountName: acc.accountName,
        region: S.regionOf(acc),
        state: "queued",
        games: purpose === "game" ? [saleAppId || cfg.games[0]] : cfg.games,
        purpose,
        targetHours: purpose === "game" ? 0 : cfg.targetHours,
        saleAppId: saleAppId || cfg.games[0],
        addedBy: String(actor || ""),
      });
      added.push(id);
    } catch (e) {
      // Put the stage back (boostedAt too, if this call set it).
      const undo = { stage: "stock" };
      if (!acc.boostedAt) undo.boostedAt = null;
      await SteamAccount.updateOne({ _id: acc._id, stage: "boosting" }, { $set: undo });
      refused.push({ id, accountName: acc.accountName, why: e && e.code === 11000 ? "already in the pool" : (e && e.message) || String(e) });
    }
  }
  return { added, refused };
}

async function findBoost(id) {
  if (!/^[a-f\d]{24}$/i.test(String(id || ""))) throw userError("Unknown boost row", 404);
  const b = await SteamBoost.findById(id).lean();
  if (!b) throw userError("Unknown boost row", 404);
  return b;
}

// Take an account out of the pool: the worker logs off on its next read
// (≤ 1 min), the saved login is dropped, the account goes back to stock
// (still marked boosted, so the empty-account region offers refuse it).
async function stop(id, reason, actor) {
  const b = await findBoost(id);
  if (!ACTIVE.includes(b.state)) throw userError("That account isn't boosting");
  const r = await SteamBoost.updateOne(
    { _id: b._id, state: { $in: ACTIVE } },
    { $set: { state: "stopping", stoppedAt: new Date(deps.now()), stopReason: String(reason || "stopped by " + (actor || "admin")).slice(0, 200), refreshToken: "", playing: 0 } },
  );
  if (!r || r.modifiedCount !== 1) throw userError("That account isn't boosting");
  return { stopping: true };
}

// Failed (or stopped) → queued again with a new gen, so the worker starts it
// from scratch. The account must be free: stock, needs attention, or still
// marked boosting by this row.
async function retry(id, actor) {
  const b = await findBoost(id);
  if ([...ACTIVE, "stopping"].includes(b.state)) throw userError("It is already in the pool or waiting for logout");
  const acc = await SteamAccount.findById(b.steamAccountId).select("stage").lean();
  if (!acc) throw userError("The account no longer exists");
  if (!["stock", "problem", "boosting"].includes(acc.stage)) throw userError("The account is " + acc.stage + "; only accounts not on sale can boost");
  if (await SteamBoost.exists({ steamAccountId: b.steamAccountId, state: { $in: ACTIVE }, _id: { $ne: b._id } })) {
    throw userError("The account is already in the pool on another row");
  }
  const r = await SteamAccount.updateOne({ _id: b.steamAccountId, stage: acc.stage }, { $set: { stage: "boosting" } });
  if (!r || (r.modifiedCount !== 1 && acc.stage !== "boosting")) throw userError("The account changed a moment ago; try again");
  await SteamBoost.updateOne(
    { _id: b._id },
    { $set: { state: "queued", lastError: "", workerState: "", stoppedAt: null, stopReason: "", addedBy: String(actor || b.addedBy || "") }, $inc: { gen: 1 } },
  );
  return { queued: true };
}

// Steam refused for good (wrong password, ban, lock, authenticator): the row
// fails and the account goes to "needs attention" with the reason.
async function failRow(b, reason) {
  const r = await SteamBoost.updateOne(
    { _id: b._id, gen: b.gen, state: { $in: ACTIVE } },
    { $set: { state: "failed", lastError: String(reason || "").slice(0, 300), stoppedAt: new Date(deps.now()), stopReason: "Steam refused", refreshToken: "", playing: 0 } },
  );
  if (!r || r.modifiedCount !== 1) return false;
  const acc = await SteamAccount.findById(b.steamAccountId).select("notes").lean();
  const note = ((acc && acc.notes) || "") + (acc && acc.notes ? "\n" : "") + "Hour boost stopped: " + String(reason || "").slice(0, 200);
  await SteamAccount.updateOne({ _id: b.steamAccountId, stage: "boosting" }, { $set: { stage: "problem", notes: note.slice(-2000) } });
  await deps.notify("⚠️ Steam hour boost: " + b.accountName + " (" + (S.regionName(b.region) || b.region) + ") stopped — " + String(reason || "Steam refused") + ". It is marked “needs attention”.");
  return true;
}

// ---------------------------------------------------------------------------
// Hours
// ---------------------------------------------------------------------------

// Tier hours cover every selected game. A missing, invalid or zero reading
// contributes zero; gamesWithHours still shows how many are accumulating time.
function hoursOf(minutes, gameIds) {
  const values = (gameIds || []).map((g) => {
    const m = Number(minutes && minutes[g]);
    return Number.isFinite(m) && m > 0 ? m : 0;
  });
  return {
    hours: values.length ? Math.floor(Math.min(...values) / 60) : 0,
    gamesWithHours: values.filter((m) => m > 0).length,
  };
}

// ---------------------------------------------------------------------------
// The worker's answers (routes/steamBoostWorkerApi.js)
// ---------------------------------------------------------------------------

async function assignments() {
  const rows = await SteamBoost.find({ state: { $in: ACTIVE } }).lean();
  const stopping = await SteamBoost.find({ state: "stopping" }).select("gen").lean();
  if (!rows.length) return { accounts: [], stopping: stopping.map(b => ({ id: String(b._id), gen: b.gen })) };
  const accs = await SteamAccount.find({ _id: { $in: rows.map((r) => r.steamAccountId) } }).select("stage accountName signupCountry").lean();
  const byId = new Map(accs.map((a) => [String(a._id), a]));
  const out = [];
  for (const r of rows) {
    const acc = byId.get(String(r.steamAccountId));
    if (!acc || acc.stage !== "boosting") {
      // Left the pool by another path (sold, deleted, edited): never hand it out.
      await SteamBoost.updateOne(
        { _id: r._id, state: { $in: ACTIVE } },
        { $set: { state: "stopped", stoppedAt: new Date(deps.now()), stopReason: "account left the pool (" + (acc ? "stage " + acc.stage : "deleted") + ")", refreshToken: "", playing: 0 } },
      );
      continue;
    }
    out.push({
      id: String(r._id),
      gen: r.gen || 1,
      accountName: acc.accountName,
      country: S.regionOf(acc),
      games: r.games || [],
      licensed: r.licensed || [],
      purpose: r.purpose || "boost",
      targetHours: r.targetHours ?? 1000,
    });
  }
  return { accounts: out, stopping: stopping.map(b => ({ id: String(b._id), gen: b.gen })) };
}

// The row for a worker call, only while it is in the pool.
async function liveRow(id, gen) {
  if (!Number.isInteger(gen) || gen < 1) throw userError("Worker generation is required", 409);
  if (!/^[a-f\d]{24}$/i.test(String(id || ""))) throw userError("Unknown account", 404);
  const b = await SteamBoost.findOne({ _id: id, gen, state: { $in: ACTIVE } }).lean();
  if (!b) throw userError("Not in the pool", 404);
  const acc = await SteamAccount.findById(b.steamAccountId).lean();
  if (!acc || acc.stage !== "boosting") throw userError("Not in the pool", 404);
  return { b, acc };
}

async function login(id, gen) {
  const { b, acc } = await liveRow(id, gen);
  const refreshToken = dec(b.refreshToken);
  return {
    accountName: acc.accountName,
    // The password only while there is no saved login.
    password: refreshToken ? "" : dec(acc.password),
    refreshToken: refreshToken || "",
  };
}

async function saveToken(id, token, gen) {
  const { b } = await liveRow(id, gen);
  const t = String(token || "");
  if (t.length < 20 || t.length > 4000) throw userError("That is not a Steam login token");
  await SteamBoost.updateOne({ _id: b._id, gen, state: { $in: ACTIVE } }, { $set: { refreshToken: encrypt(t) } });
  return { saved: true };
}

async function clearToken(id, gen) {
  const { b } = await liveRow(id, gen);
  await SteamBoost.updateOne({ _id: b._id, gen, state: { $in: ACTIVE } }, { $set: { refreshToken: "" } });
  return { cleared: true };
}

// Steam's email codes: 5 characters, no vowels, no 0/1/S. Ordinary words in
// the mail never match in full upper case.
const CODE = /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/;
const NOT_A_CODE_MAIL = /new steam account email verification/i;

function htmlText(html) {
  return String(html || "")
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ");
}

function senderOf(m) {
  const f = m && m.from;
  if (typeof f === "string") return f;
  return (f && f.emailAddress && f.emailAddress.address) || "";
}

// The newest Steam mail after `since` that carries a code and isn't excluded.
function steamGuardCode(messages, since, exclude = []) {
  const after = Date.parse(since) - 60 * 1000; // a minute of clock skew
  const sorted = [...(messages || [])].sort((a, b) => Date.parse(b.receivedDateTime) - Date.parse(a.receivedDateTime));
  for (const m of sorted) {
    if (!/@steampowered\.com$/i.test(senderOf(m))) continue;
    if (NOT_A_CODE_MAIL.test(m.subject || "")) continue;
    if (!(Date.parse(m.receivedDateTime) >= after)) continue;
    if (exclude.includes(m.id)) continue;
    const body = typeof m.body === "string" ? m.body : (m.body && m.body.content) || "";
    const text = htmlText(body) + " " + (m.bodyPreview || "");
    const code = text.split(/[^A-Za-z0-9]+/).find((t) => CODE.test(t));
    if (code) return { code, messageId: m.id, subject: m.subject || "", receivedAt: m.receivedDateTime };
  }
  return null;
}

async function guardCode(id, since, exclude, gen) {
  const { acc } = await liveRow(id, gen);
  const t = Date.parse(since);
  if (!Number.isFinite(t)) throw userError("since must be a time");
  const email = dec(acc.email).toLowerCase();
  if (!/@/.test(email)) throw userError("The account has no saved email");
  const { messages } = await deps.readMailFor({ inboxAddress: email, sinceIso: new Date(t - 60 * 1000).toISOString(), top: 10, kind: "steam" });
  const hit = steamGuardCode(messages, new Date(t).toISOString(), Array.isArray(exclude) ? exclude.map(String).slice(0, 50) : []);
  return hit ? { code: hit.code, messageId: hit.messageId, subject: String(hit.subject).slice(0, 120) } : { code: null };
}

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

// One report from the worker: its own status + one row per account it runs.
async function report(body) {
  const now = new Date(deps.now());
  const w = (body && body.worker) || {};
  const rows = Array.isArray(body && body.accounts) ? body.accounts.slice(0, 1000) : [];
  const note = clip(w.note || rows.length + " account(s) running", 300);
  await SteamSalesState.updateOne(
    { _id: "main" },
    { $set: { "boost.workerLastSeenAt": now, "boost.workerNote": note, "boost.workerVersion": clip(w.version, 40) } },
    { upsert: true },
  );
  let updated = 0;
  for (const row of rows) {
    if (!row || !/^[a-f\d]{24}$/i.test(String(row.id || ""))) continue;
    const b = await SteamBoost.findOne({ _id: row.id, state: { $in: [...ACTIVE, "stopping"] } }).lean();
    if (!b || !Number.isInteger(row.gen) || row.gen !== Number(b.gen || 1)) continue; // a stale run
    if (b.state === "stopping") {
      if (row.stopped === true) await acknowledgeLogout(b);
      continue;
    }
    if (row.failed) {
      if (await failRow(b, clip(row.lastError || "Steam refused", 300))) updated++;
      continue;
    }
    const set = {
      lastSeenAt: now,
      workerState: clip(row.state, 40),
      lastError: clip(row.lastError, 300),
      playing: Array.isArray(row.playing) ? row.playing.length : 0,
    };
    if (/^7656119\d{10}$/.test(String(row.steamID || ""))) set.steamID = String(row.steamID);
    if (row.exit && typeof row.exit === "object") {
      set.exitCountry = clip(row.exit.country, 2);
      set.exitCity = clip(row.exit.city, 80);
    }
    if (Array.isArray(row.licensed)) {
      set.licensed = [...new Set(row.licensed.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 64);
    }
    if (row.playtime && typeof row.playtime === "object") {
      const minutes = {};
      for (const g of b.games || []) {
        const v = row.playtime[g];
        const m = Number(v && typeof v === "object" ? v.minutes : v);
        if (Number.isFinite(m) && m >= 0) minutes[g] = Math.floor(m);
      }
      // Steam's playtime only goes up; never let a bad read lower it.
      for (const [g, m] of Object.entries(b.minutes || {})) if (!(g in minutes) || minutes[g] < m) minutes[g] = m;
      const h = hoursOf(minutes, b.games);
      set.minutes = minutes;
      set.hours = h.hours;
      set.gamesWithHours = h.gamesWithHours;
      set.hoursAt = now;
      for (const n of MILESTONES) {
        const key = "reached" + n + "At";
        if (h.hours >= n && !b[key]) {
          set[key] = now;
          await deps.notify("🎮 Steam hour boost: " + b.accountName + " (" + (S.regionName(b.region) || b.region) + ") reached " + n + " h on " + h.gamesWithHours + " games.");
        }
      }
    }
    if (b.state === "queued" && /^playing$/.test(String(row.state || ""))) {
      set.state = "boosting";
      if (!b.onlineAt) set.onlineAt = now;
    }
    const saved = await SteamBoost.findOneAndUpdate({ _id: b._id, state: { $in: ACTIVE }, gen: b.gen }, { $set: set }, { returnDocument: "after" }).lean();
    if (saved) {
      const required = saved.purpose === "game" ? 2 : saved.targetHours * 60;
      const complete = saved.games.length > 0 && saved.games.every(g => Number(saved.minutes?.[g]) >= required && saved.licensed.includes(g));
      if (complete) await SteamBoost.updateOne({ _id: saved._id, gen: saved.gen, state: { $in: ACTIVE } }, { $set: { state: "stopping", stopReason: "target reached", playing: 0 } });
    }
    updated++;
  }
  return { ok: true, updated };
}


// The worker has logged off this exact generation. Only now release its hold.
async function acknowledgeLogout(b) {
  const ready = b.stopReason === "target reached";
  const r = await SteamBoost.updateOne({ _id: b._id, gen: b.gen, state: "stopping" }, { $set: { state: ready ? "ready" : "stopped", logoutAt: new Date(deps.now()), refreshToken: "", playing: 0 } });
  if (r.modifiedCount !== 1) return;
  const acc = await SteamAccount.findById(b.steamAccountId).lean();
  if (!acc || acc.stage !== "boosting") return;
  const owned = new Map((acc.games || []).map(g => [g.appId, g]));
  for (const id of b.licensed || []) if ((b.games || []).includes(id)) owned.set(id, { appId: id, name: games.nameOf(id), priceUsd: 0, playtimeMinutes: Number(b.minutes?.[id]) || 0, verifiedAt: b.hoursAt || null });
  await SteamAccount.updateOne({ _id: b.steamAccountId, stage: "boosting" }, { $set: { stage: "stock", games: [...owned.values()], steamId64: b.steamID || acc.steamId64 } });
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

function etaFor(b, target, now) {
  if (b.hours >= target) return null;
  if (b.state !== "boosting") return null;
  return new Date(now + (target - b.hours) * 60 * 60 * 1000);
}

async function panelView() {
  const cfg = await settings();
  const now = deps.now();
  const live = await SteamBoost.find({ state: { $in: [...ACTIVE, "stopping", "ready"] } }).sort({ createdAt: 1 }).lean();
  const ended = await SteamBoost.find({ state: { $nin: ACTIVE } }).sort({ updatedAt: -1 }).limit(20).lean();
  const seen = cfg.workerLastSeenAt ? new Date(cfg.workerLastSeenAt).getTime() : 0;
  const row = (b) => ({
    _id: String(b._id),
    accountName: b.accountName,
    region: b.region,
    regionName: S.regionName(b.region) || b.region,
    state: b.state,
    purpose: b.purpose, targetHours: b.targetHours, saleAppId: b.saleAppId,
    workerState: b.workerState || "",
    hours: b.hours || 0,
    gamesWithHours: b.gamesWithHours || 0,
    games: (b.games || []).length,
    playing: b.playing || 0,
    licensed: (b.licensed || []).length,
    apexHours: Math.floor(Number((b.minutes || {})[1172470] || 0) / 60),
    cs2Hours: Math.floor(Number((b.minutes || {})[730] || 0) / 60),
    eta500: etaFor(b, 500, now),
    eta1000: etaFor(b, 1000, now),
    reached500At: b.reached500At || null,
    reached1000At: b.reached1000At || null,
    onlineAt: b.onlineAt || null,
    lastSeenAt: b.lastSeenAt || null,
    exit: b.exitCountry ? b.exitCountry + (b.exitCity ? " · " + b.exitCity : "") : "",
    lastError: b.lastError || "",
    stopReason: b.stopReason || "",
    stoppedAt: b.stoppedAt || null,
    createdAt: b.createdAt || null,
  });
  return {
    settings: { enabled: cfg.enabled, maxAccounts: cfg.maxAccounts, keepPerRegion: cfg.keepPerRegion, games: cfg.games, targetHours: cfg.targetHours, prepareGames: cfg.prepareGames, gamePriceUsd: cfg.gamePriceUsd, boostPriceUsd: cfg.boostPriceUsd },
    catalog: games.GAMES.map((g) => ({ appId: g.appId, name: g.name })),
    worker: {
      lastSeenAt: cfg.workerLastSeenAt,
      online: !!seen && now - seen < 3 * 60 * 1000,
      note: cfg.workerNote,
      version: cfg.workerVersion,
    },
    counts: {
      active: live.filter(b => ACTIVE.includes(b.state) || b.state === "stopping").length,
      ready: live.filter(b => b.state === "ready").length,
      playing: live.filter((b) => b.state === "boosting" && b.playing > 0).length,
      queued: live.filter((b) => b.state === "queued").length,
      reached500: live.filter((b) => b.reached500At).length,
    },
    live: live.map(row),
    ended: ended.map(row),
  };
}

// ---------------------------------------------------------------------------
// Watch: the worker going silent while accounts wait
// ---------------------------------------------------------------------------

async function watch() {
  const cfg = await settings();
  const active = await activeCount();
  if (!active) return { quiet: true };
  const now = deps.now();
  const seen = cfg.workerLastSeenAt ? new Date(cfg.workerLastSeenAt).getTime() : 0;
  if (seen && now - seen < WORKER_SILENT_MS) return { ok: true };
  const alerted = cfg.workerAlertAt ? new Date(cfg.workerAlertAt).getTime() : 0;
  if (alerted && now - alerted < WORKER_ALERT_EVERY_MS) return { silent: true, alerted: false };
  await SteamSalesState.updateOne({ _id: "main" }, { $set: { "boost.workerAlertAt": new Date(now) } }, { upsert: true });
  await deps.notify(
    "⚠️ Steam hour boost: the booster on contabo2 has not reported " +
      (seen ? "since " + new Date(seen).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "yet") +
      "; " + active + " account(s) are waiting. Check the steam-booster container and the steam-boost-tunnel service.",
  );
  return { silent: true, alerted: true };
}

let timer = null;
function start() {
  if (timer) return;
  const loop = async () => {
    try {
      await watch();
    } catch (e) {
      console.error("[steamBoost] watch failed:", (e && e.message) || e);
    }
    timer = setTimeout(loop, WATCH_MS);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(loop, WATCH_MS);
  if (timer.unref) timer.unref();
}

function stopTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

module.exports = {
  ACTIVE,
  settings,
  setSettings,
  activeCount,
  add,
  stop,
  retry,
  assignments,
  login,
  saveToken,
  clearToken,
  guardCode,
  report,
  panelView,
  watch,
  start,
  stopTimer,
  _internal: { hoursOf, steamGuardCode, boostBlockers, failRow, CODE },
  _setDeps(over) {
    Object.assign(deps, over || {});
  },
};
