// Everything the farm brain reads, in one place (docs/DEMAND-BRAIN-PLAN.md §4).
//
// READ-ONLY BY CONSTRUCTION. Every source is either a report another module already builds and
// caches (the price tracker, the market radar) or a plain database read:
//   * the price tracker report — its sale ledger (every market's priced sales and delivered units),
//     its listing history, value per account, stock, the farm engine's latest decision per game
//     (utils/priceTracker, cached 5 min, shared with the page);
//   * buyer-connection flips over the brain's whole history window, grouped in the database to one
//     row per sold account (the report keeps only 45 days of them, which would leave every older
//     forecast window short of the sales only a connection flip proves);
//   * the market radar report — rivals' sales and live listings (utils/marketData/report, cached);
//   * live drop campaigns — one projected find, the same filter the lane engine uses;
//   * the auto-farm's OWN demand functions, called exactly as its decide step calls them:
//     probeGate (two task reads), researchForGame + internalSalesForGame (database reads),
//     demandAllocation and marketStockFloor (pure). Never freshResearchForGame: that re-scans a
//     marketplace;
//   * the auto-farm's failed probes (model v2's cold-start rule): one projected, indexed find of
//     the AutoFarmTask rows its probe gate counts as a cooldown, for the live games only;
//   * the no-claim feeder's demand snapshot and sale evidence (utils/farmDemand, database reads).
//     Never unclaimedAllocator.plan(): it reads the Pi and overwrites the allocator's plan.
// Nothing here writes, calls a marketplace, opens SSH or touches a setting.
const model = require("./model");

const DAY = model.DAY;
// Engine lookups run this many games at a time, so a run never floods the database.
const ENGINE_CONCURRENCY = 3;
// More games than this is a sign something upstream went wrong; the rest are dropped and said so.
const MAX_CLAIM_GAMES = 250;
// Grouped connection rows (one per sold account per game): ~1,100 over 135 days on 2026-10-02.
const CONNECTED_GROUP_CAP = 50000;
// Failed probes read per run (17 of 20 finished probes had failed by 2026-10-02): a runaway bound.
const PROBE_HISTORY_CAP = 5000;

function realDeps() {
  return {
    settings: require("../settings"),
    priceTracker: require("../priceTracker"),
    games: require("../priceTracker/games"),
    marketReport: require("../marketData/report"),
    autoFarmer: require("../autoFarmer"),
    probeGate: require("../farm2/steps/decide").probeGate,
    farmDemand: require("../farmDemand"),
    TwitchCampaign: require("../../models/TwitchCampaign"),
    SaleSignal: require("../../models/SaleSignal"),
    AutoFarmTask: require("../../models/AutoFarmTask"),
    normGame: require("../priceTracker/setIdentity").normGame,
  };
}

const num = (v, d = 0) => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? d : n;
};
const lower = (s) => String(s == null ? "" : s).trim().toLowerCase();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
      // Let delivery and the guardians run between lookups.
      await new Promise((r) => setImmediate(r));
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ------------------------------- our evidence ------------------------------- */

/**
 * Buyer-connection flips over `days`, ONE row per (game, login, account) with its first date —
 * grouped in the database, so ~25k raw rows come back as ~1k. A row with neither login nor account
 * keeps its own dedupe key, so anonymous flips are never merged into one.
 */
async function connectedHistory(d, now, days = model.HISTORY_DAYS) {
  const rows = await d.SaleSignal.aggregate([
    { $match: { source: "connected", at: { $gte: new Date(now - days * DAY) } } },
    {
      $group: {
        _id: {
          g: "$gameKey",
          l: { $ifNull: ["$login", ""] },
          a: { $ifNull: ["$account", null] },
          k: {
            $cond: [{ $or: [{ $gt: [{ $ifNull: ["$login", ""] }, ""] }, { $ne: [{ $ifNull: ["$account", null] }, null] }] }, "", { $ifNull: ["$dedupeKey", ""] }],
          },
        },
        at: { $min: "$at" },
      },
    },
    { $limit: CONNECTED_GROUP_CAP },
  ]);
  return {
    rows: rows.map((r) => ({ gameKey: r._id.g, login: r._id.l || "", account: r._id.a || null, at: r.at, dedupeKey: r._id.k || "" })),
    truncated: rows.length >= CONNECTED_GROUP_CAP,
  };
}

/**
 * Every proven-sold account per game over `days`, as [{ t, m, p }] (time, market, best price) sorted
 * by time — the price tracker's own union (games.soldUnion: one sold account once, whoever saw it,
 * mass-delist signals set aside), fed the full window of connection flips so each sale is dated by
 * its earliest evidence inside the window.
 */
function saleLogFrom(G, { sales = [], connected = [], now, days = model.HISTORY_DAYS }) {
  const out = new Map();
  for (const [game, entries] of G.soldUnion({ sales, connected, now, days })) {
    const arr = [];
    for (const e of entries.values()) arr.push({ t: e.at, m: lower(e.market) || "unknown", p: num(e.price) });
    arr.sort((a, b) => a.t - b.t);
    out.set(game, arr);
  }
  return out;
}

async function claimSaleLog(d, report, now, notes) {
  const ledger = report && report.ledger;
  if (!ledger || !Array.isArray(ledger.sales)) {
    notes.push("The price tracker report has no sale ledger: own sales read as zero.");
    return new Map();
  }
  if (report.truncated) notes.push("The price tracker's read hit its row cap: the oldest sales are missing.");
  const ch = await connectedHistory(d, now);
  if (ch.truncated) notes.push("The connection history hit its cap of " + CONNECTED_GROUP_CAP + " accounts: the oldest are missing.");
  return saleLogFrom(d.games, { sales: ledger.sales.concat(ledger.demandOnly || []), connected: ch.rows, now, days: model.HISTORY_DAYS });
}

/* --------------------------------- the farms --------------------------------- */

/**
 * The engine's game rules, evaluated against ONE settings snapshot. utils/settings re-reads its
 * file on every isNoClaimGame / isReuseOnlyGame call, which is hundreds of synchronous reads per
 * run; these are the same rules (settings.isNoClaimGame: substring of the normalised label;
 * settings.isReuseOnlyGame: exact normalised label) over the snapshot the run already holds, with
 * the settings module's own normaliser.
 */
function gameRules(settings, af) {
  const norm = typeof settings.normGameName === "function" ? settings.normGameName : (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const nc = (af.noClaimGames || []).map(norm).filter(Boolean);
  const ro = new Set((af.reuseOnlyGames || []).map(norm).filter(Boolean));
  return {
    isNoClaim: (game) => {
      const g = norm(game);
      return !!g && nc.some((k) => g.includes(k));
    },
    isReuseOnly: (game) => {
      const g = norm(game);
      return !!g && ro.has(g);
    },
  };
}

const noclaimKeysOf = (af, normGame) => [...new Set((af.noClaimGames || []).map((g) => normGame(g)).filter(Boolean))];

/**
 * Live drop campaigns, as the lane engine sees them (active, status ACTIVE, not ended).
 * @returns {{ claim: Map<key,{label,labels,n,endAt,hoursLeft}>, noclaim: Set<string>, read: number }} —
 *          `labels` holds every raw label the game's live campaigns carry (the engine keys its
 *          tasks by the raw label); `noclaim` the raw labels of live no-claim campaigns (bucketed
 *          by the caller).
 */
async function liveCampaigns(d, now, rules) {
  const rows = await d.TwitchCampaign.find(
    { active: true, status: "ACTIVE", $or: [{ endAt: null }, { endAt: { $gt: new Date(now) } }] },
    { game: 1, endAt: 1 },
  )
    .limit(5000)
    .lean();
  const claim = new Map();
  const noclaim = new Set();
  for (const c of rows) {
    if (!c.game) continue;
    if (rules.isNoClaim(c.game)) {
      noclaim.add(c.game);
      continue;
    }
    const key = d.normGame(c.game);
    if (!key) continue;
    const end = c.endAt ? new Date(c.endAt).getTime() : null;
    const cur = claim.get(key);
    if (!cur) claim.set(key, { label: c.game, labels: [c.game], n: 1, endAt: end });
    else {
      cur.n++;
      if (!cur.labels.includes(c.game)) cur.labels.push(c.game);
      // The campaign that runs longest is the one a farm decision is about.
      if (end == null || (cur.endAt != null && end > cur.endAt)) cur.endAt = end;
    }
  }
  for (const v of claim.values()) v.hoursLeft = v.endAt == null ? null : (v.endAt - now) / 3600000;
  return { claim, noclaim, read: rows.length };
}

/**
 * Games the auto-farm already probed and gave up on (model v2's cold-start rule): a task stamped
 * probeOutcome "expired" — its campaign ended, or the stop-loss fired, with 0 sales — and completed
 * inside the re-probe cooldown. The predicate is the engine's own probe gate (decide.probeGate:
 * game, probeOutcome, completedAt ≥ now − probeCooldownDays), asked once for every label of the
 * live games instead of once per game: one projected read on the indexed `game` field.
 * @returns {Promise<Map<string, number>>} game key -> the newest such completedAt (epoch ms)
 */
async function expiredProbes(d, labels, now, cooldownDays) {
  const out = new Map();
  if (!labels.length) return out;
  const rows = await d.AutoFarmTask.find(
    { game: { $in: labels }, probeOutcome: "expired", completedAt: { $gte: new Date(now - cooldownDays * DAY) } },
    { game: 1, completedAt: 1 },
  )
    .limit(PROBE_HISTORY_CAP)
    .lean();
  for (const r of rows) {
    const key = d.normGame(r.game);
    const at = r.completedAt ? new Date(r.completedAt).getTime() : NaN;
    if (!key || !Number.isFinite(at)) continue;
    if (!(out.get(key) >= at)) out.set(key, at);
  }
  return out;
}

/**
 * The auto-farm's own demand verdict for each game, computed now with its own functions — the exact
 * calls utils/farm2/steps/decide.js decideCampaign makes for a shadow lane: the cold-start probe gate
 * (budget and post-failure cooldown), read-only research, the 45-day own-sales count, then
 * demandAllocation with the gate's answer.
 */
async function oldVerdicts(d, games, af) {
  const AF = d.autoFarmer;
  const out = new Map();
  const ok = AF && typeof AF.researchForGame === "function" && typeof AF.internalSalesForGame === "function" && typeof AF.demandAllocation === "function";
  if (!ok) {
    for (const g of games) out.set(g.key, { error: "the auto-farm's demand functions are not exported" });
    return out;
  }
  await mapLimit(games, ENGINE_CONCURRENCY, async (g) => {
    try {
      const gate = typeof d.probeGate === "function" ? await d.probeGate(g.label, af) : { probeAllowed: true, probeBudgetBlocked: false };
      const research = await AF.researchForGame(g.label);
      const sales = await AF.internalSalesForGame(g.label);
      const alloc = AF.demandAllocation(research, af, sales, { probeAllowed: gate.probeAllowed !== false, game: g.label });
      out.set(g.key, {
        alloc,
        sales,
        gate: { probeAllowed: gate.probeAllowed !== false, budgetBlocked: !!gate.probeBudgetBlocked },
        research: research ? { ds: num(research.demandScore), sellers: num(research.sellers), at: research.scannedAt || null } : null,
      });
    } catch (e) {
      out.set(g.key, { error: e && e.message ? e.message : String(e) });
    }
  });
  return out;
}

// The no-claim feeder's sale evidence (every source, first-evidence dated) as entries per bucket,
// or null when this build of utils/farmDemand does not export it. An entry is { t, m, p }, plus
// `pack: true` for a unit the feeder marks as sold in a bulk pack: the burst guard (v2g) counts it
// raw, and its market alone cannot say so. A failed bulk-pack lookup (`packError`) would let packs
// read as ordinary sales and inflate v2g, so the evidence is unreadable for that run — the feeder
// withholds its own guarded snapshot on the same error.
async function noclaimEvidence(FD) {
  if (!FD || typeof FD.saleEvidenceByBucket !== "function") return null;
  const ev = await FD.saleEvidenceByBucket({ days: model.HISTORY_DAYS });
  if (ev && ev.packError) throw new Error("its bulk-pack lookup failed: " + ev.packError);
  const map = new Map();
  for (const [bucket, units] of (ev && ev.units) || new Map()) {
    const arr = [];
    for (const u of units.values()) {
      const t = u && u.firstAt ? new Date(u.firstAt).getTime() : NaN;
      if (!Number.isFinite(t)) continue;
      const entry = { t, m: lower(u.market) || "unknown", p: num(u.priceUsd) };
      if (u.pack === true) entry.pack = true;
      arr.push(entry);
    }
    arr.sort((a, b) => a.t - b.t);
    map.set(bucket, arr);
  }
  return map;
}

/**
 * The no-claim feeder's snapshot (its own target and rates) and its dated sale evidence. A failure
 * here is the no-claim half's failure only: the run carries on with a note.
 */
async function noclaimInputs(d) {
  const FD = d.farmDemand;
  const out = { snap: [], evidence: null, demandRates: null, notes: [] };
  if (!FD || typeof FD.unclaimedDemandSnapshot !== "function") {
    out.notes.push("The no-claim feeder's demand snapshot is unavailable.");
    return out;
  }
  try {
    out.snap = (await FD.unclaimedDemandSnapshot({ days: 30 })) || [];
  } catch (e) {
    out.notes.push("The no-claim feeder's snapshot failed this run (" + (e && e.message ? e.message : e) + "): no-claim rows skipped.");
    return out;
  }
  if (typeof FD.demandRates === "function") out.demandRates = FD.demandRates;
  try {
    out.evidence = await noclaimEvidence(FD);
    if (!out.evidence) out.notes.push("The no-claim feeder exports no dated sale evidence here: only its own rule is logged.");
  } catch (e) {
    out.evidence = null;
    out.notes.push("The no-claim feeder's sale evidence failed this run (" + (e && e.message ? e.message : e) + "): only its own rule is logged.");
  }
  return out;
}

// What the scorer keeps of the radar's sale feed: rivals' drop sales only, three fields each. The
// feed itself (titles, sellers) is the radar report's to cache, not ours.
function slimFeed(feed) {
  const out = [];
  for (const s of feed || []) {
    if (!s || s.ours || s.kind === "farm") continue;
    const t = new Date(s.soldAt).getTime();
    if (Number.isFinite(t)) out.push({ g: s.gameKey, t, u: Math.max(1, num(s.units, 1)) });
  }
  return out;
}

// A game's display name: the live campaign's label, else the tracker's, else the radar's.
function labelFor(key, { campaign, game, radar }) {
  return (campaign && campaign.label) || (game && game.game) || (radar && radar.game) || key;
}

/**
 * Load one run's inputs.
 * @param {object} o
 * @param {number} o.now
 * @param {object} [o.deps] injected modules (tests)
 * @returns {Promise<object>} the pack model.buildRun() takes, plus `evidence` for scoring
 */
async function load({ now = Date.now(), deps = null } = {}) {
  const d = deps || realDeps();
  const notes = [];
  const af = d.settings.getAutoFarm() || {};
  const sz = d.settings.getFarmSizing(af);
  const sizing = { coverageDays: num(sz.coverageDays, 28), safetyStock: num(sz.safetyStock, 6), maxPerGame: num(sz.maxPerGame, 250) };
  const probeSize = Math.max(1, Math.floor(num(af.probeSize, 15)));
  let floor = 0;
  try {
    floor = typeof d.autoFarmer.marketStockFloor === "function" ? Math.max(0, Math.floor(num(d.autoFarmer.marketStockFloor(af)))) : 0;
  } catch {
    floor = 0;
    notes.push("The auto-farm's shelf floor could not be read: compared without it.");
  }
  const engine = { floor, maxPerGame: num(af.maxPerGame, 0) };

  const report = await d.priceTracker.getReport();
  const saleLog = await claimSaleLog(d, report, now, notes);
  const spans = model.listingSpans(report && report.prepared ? report.prepared.rows : [], now);
  const gameRows = new Map(((report && report.games) || []).map((g) => [g.key, g]));

  let radar = null;
  try {
    radar = await d.marketReport.getReport({ days: 30 });
  } catch (e) {
    notes.push("Market radar unreadable this run (" + (e && e.message ? e.message : e) + "): no market evidence.");
  }
  const radarRows = (radar && radar.games) || [];
  const radarByKey = new Map(radarRows.map((r) => [r.key, r]));

  const rules = gameRules(d.settings, af);
  const camps = await liveCampaigns(d, now, rules);

  // No-claim buckets (keyword, substring of the normalised name, longest wins — farmDemand.bucketFor).
  const ncKeys = noclaimKeysOf(af, d.normGame);
  const isNoClaimKey = (key) => !!model.bucketOfKey(key, ncKeys);

  // Candidates: every game with a live claimable campaign, every game we sold in 45 days, and
  // every game the radar has rated rival sales for. Live ones first if the cap ever bites.
  const cand = new Map();
  const add = (key, why) => {
    if (!key || isNoClaimKey(key)) return;
    if (!cand.has(key)) cand.set(key, new Set());
    cand.get(key).add(why);
  };
  for (const key of camps.claim.keys()) add(key, "live");
  for (const [key, entries] of saleLog) if (entries.some((e) => e.t > now - 45 * DAY && e.t <= now)) add(key, "sold");
  for (const r of radarRows) if (r.perWeek != null && r.perWeek > 0) add(r.key, "market");
  let keys = [...cand.keys()].sort((a, b) => (cand.get(b).has("live") ? 1 : 0) - (cand.get(a).has("live") ? 1 : 0));
  if (keys.length > MAX_CLAIM_GAMES) {
    notes.push(keys.length + " candidate games; only the first " + MAX_CLAIM_GAMES + " (live campaigns first) were compared.");
    keys = keys.slice(0, MAX_CLAIM_GAMES);
  }

  const claimGames = [];
  for (const key of keys) {
    const campaign = camps.claim.get(key) || null;
    const game = gameRows.get(key) || null;
    const radarRow = radarByKey.get(key) || null;
    const label = labelFor(key, { campaign, game, radar: radarRow });
    // The engine's own no-claim rule on the label, as the lane engine applies it.
    if (rules.isNoClaim(label)) continue;
    claimGames.push({ key, label, campaign, game, radarRow });
  }
  const old = await oldVerdicts(d, claimGames.map((g) => ({ key: g.key, label: g.label })), af);

  // Known duds for the cold-start rule (model v2), read for the live games only — the rule needs a
  // live campaign. Unreadable = no game is cleared for a cold probe (each stays "unknown"): the
  // brain never suggests probing a game it could not check.
  const probeCooldownDays = model.probeCooldownDaysOf(af);
  let duds = null;
  try {
    if (!d.AutoFarmTask || typeof d.AutoFarmTask.find !== "function") throw new Error("no task model");
    const labels = [...new Set(claimGames.filter((g) => g.campaign).flatMap((g) => g.campaign.labels || [g.label]))];
    duds = await expiredProbes(d, labels, now, probeCooldownDays);
  } catch (e) {
    duds = null;
    notes.push("The auto-farm's probe history was unreadable this run (" + (e && e.message ? e.message : e) + "): no cold probes, new drops stay 'unknown'.");
  }

  const claim = claimGames.map(({ key, label, campaign, game, radarRow }) => {
    let value = game && game.price ? num(game.price.valuePerAccount) : 0;
    let valueBasis = value > 0 ? "our sales" : "";
    const rm = radarRow && radarRow.realised && radarRow.realised.median != null ? num(radarRow.realised.median) : 0;
    if (!(value > 0) && rm > 0) {
      value = Math.round(rm * (1 - model.RIVAL_FEE_SHARE) * 100) / 100;
      valueBasis = "rivals' sold price";
    }
    const stance = game && game.farm && game.farm.engine ? game.farm.engine : null;
    let gameCap = 0;
    try {
      gameCap = num(d.settings.gameAccountCapFor(label, af));
    } catch {
      gameCap = 0;
    }
    return {
      key,
      label,
      live: !!campaign,
      hoursLeft: campaign ? campaign.hoursLeft : null,
      reuseOnly: rules.isReuseOnly(label),
      entries: saleLog.get(key) || [],
      spans: spans.get(key) || [],
      radar: radarRow,
      value,
      valueBasis,
      gameCap,
      stock: game && game.farm ? { onHand: game.farm.onHand, inFlight: game.farm.inFlight } : null,
      act: stance ? { d: stance.decision, at: stance.decidedAt || null, t: num(stance.target) } : null,
      // false = checked, no failed probe; { at, days } = a known dud; null = not checked
      dud: !campaign || !duds ? null : duds.has(key) ? { at: duds.get(key), days: probeCooldownDays } : false,
      old: old.get(key) || { error: "no verdict" },
    };
  });

  const nc = await noclaimInputs(d);
  notes.push(...nc.notes);
  const liveBuckets = new Set();
  for (const label of camps.noclaim) {
    const b = model.bucketOfKey(d.normGame(label), ncKeys);
    if (b) liveBuckets.add(b);
  }
  const bucketSpans = new Map();
  for (const [key, list] of spans) {
    const b = model.bucketOfKey(key, ncKeys);
    if (!b) continue;
    if (!bucketSpans.has(b)) bucketSpans.set(b, []);
    bucketSpans.get(b).push(...list);
  }
  const noclaim = nc.snap.map((row) => ({
    snapRow: row,
    entries: nc.evidence ? nc.evidence.get(row.key) || [] : null,
    spans: bucketSpans.get(row.key) || [],
    radarRows,
    keywords: ncKeys,
    live: liveBuckets.has(row.key),
  }));

  return {
    now,
    sizing,
    probeSize,
    probeCooldownDays,
    engine,
    claim,
    noclaim,
    demandRates: nc.demandRates,
    // The owner's switch for the feeder's burst guard (docs/LIVE-FIXES-1003.md §1, dark): while on,
    // the feeder's snapshot is the guarded rule v2g, not v2.
    burstGuardLive: af.noclaimBurstGuard === true,
    notes,
    // What the scorer needs later, without another load.
    evidence: {
      at: now,
      claim: saleLog,
      spans,
      noclaim: nc.evidence,
      feed: slimFeed(radar && radar.feed),
      radarKeys: new Set(radarRows.map((r) => r.key)),
      noclaimKeys: ncKeys,
      demandRates: nc.demandRates,
    },
    counts: { campaigns: camps.read, claimCandidates: cand.size, claimGames: claim.length, noclaim: noclaim.length, radarGames: radarRows.length },
  };
}

/**
 * Only what the scorer needs (no engine calls, no campaign read): our dated sales per game, listing
 * history, the no-claim evidence and the radar's rival sales. Used when the last run's evidence is
 * older than two hours, or the brain is off.
 */
async function loadEvidence({ now = Date.now(), deps = null } = {}) {
  const d = deps || realDeps();
  const af = d.settings.getAutoFarm() || {};
  const notes = [];
  const report = await d.priceTracker.getReport();
  const claim = await claimSaleLog(d, report, now, notes);
  let radar = null;
  try {
    radar = await d.marketReport.getReport({ days: 30 });
  } catch {
    radar = null;
  }
  const FD = d.farmDemand;
  let noclaim = null;
  try {
    noclaim = await noclaimEvidence(FD);
  } catch {
    noclaim = null;
  }
  return {
    at: now,
    claim,
    spans: model.listingSpans(report && report.prepared ? report.prepared.rows : [], now),
    noclaim,
    feed: slimFeed(radar && radar.feed),
    radarKeys: new Set(((radar && radar.games) || []).map((r) => r.key)),
    noclaimKeys: noclaimKeysOf(af, d.normGame),
    demandRates: FD && typeof FD.demandRates === "function" ? FD.demandRates : null,
    notes,
  };
}

module.exports = {
  load,
  loadEvidence,
  connectedHistory,
  saleLogFrom,
  liveCampaigns,
  expiredProbes,
  oldVerdicts,
  noclaimInputs,
  noclaimEvidence,
  slimFeed,
  mapLimit,
  labelFor,
  gameRules,
  realDeps,
  ENGINE_CONCURRENCY,
  MAX_CLAIM_GAMES,
  CONNECTED_GROUP_CAP,
  PROBE_HISTORY_CAP,
};
