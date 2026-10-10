// Price tracker entry point: load evidence, build one report, serve questions.
//
// This is the ONE place that knows how to read the shop's sale evidence for
// pricing. It is READ-ONLY by construction: no function here writes to Mongo, and
// nothing calls a marketplace. Applying advice is a separate, owner-approved act
// (and, for the auto-farm, a later, deliberate wiring — see suggestForNew).
const { buildLedger } = require("./ledger");
const { identify, normGame } = require("./setIdentity");
const { isMarketClaimTag } = require("../marketClaimTags");
const A = require("./analyze");
const G = require("./games");
const { MARKETS, VENUES } = require("./venues");
const { median, DAY } = require("./stats");

const CACHE_MS = 5 * 60 * 1000;
const READ_CAP = 20000;
const CONNECTED_CAP = 60000;
let cache = { at: 0, report: null };
let inflight = null;

/* ----------------------------------- load ---------------------------------- */

// reserved:<accountId>:<setId>:<game> — a Shop or bulk-order sale (ledger.js).
const RESERVED_RE = /^reserved:([0-9a-f]{24}):([^:]*):/i;
const ID_CHUNK = 500;

/**
 * Shop and bulk-order sales are written when the drops are RESERVED, before the buyer
 * is charged, and stay when that is rolled back (refund, failed payment, cancelled
 * order): only the reservation tells a sale from a rollback. One grouped DropLog read
 * returns, per (account, set) pair of these signals, WHO holds its reserved drops, and
 * one BotAccount read names their accounts (the signals carry no login). Both bounded
 * by the signals' own ids, chunked, projected to the pair + holders / the login.
 *
 * A pair counts only while a BUYER holds it. After a refund the account is stock again,
 * and a fulfiller or the auto-lister may reserve the same set on it for a shelf: that
 * holder is a marketplace claim tag (utils/marketClaimTags.js, the one list
 * routes/spentAccountsRoutes.js reads too) — a listing, not a sale. Every other holder
 * is a buyer, by the same rule the rest of the system uses (isRealSale).
 *
 * On any failure: `reservations` null, so the ledger counts NONE of these sales (a
 * phantom sale would grow farming), and `note` says why on the page.
 * @returns {Promise<{ reservations: Set<string>|null, accountLogins: Map<string,string>, note: string }>}
 */
async function reservationEvidence(signals, models = null) {
  const pairs = [];
  for (const s of signals || []) {
    const m = RESERVED_RE.exec(String((s && s.dedupeKey) || ""));
    if (m && m[2]) pairs.push({ account: m[1].toLowerCase(), set: m[2] });
  }
  if (!pairs.length) return { reservations: new Set(), accountLogins: new Map(), note: "" };
  try {
    const M = models || { DropLog: require("../../models/DropLog"), BotAccount: require("../../models/BotAccount") };
    const { Types } = require("mongoose");
    const accounts = [...new Set(pairs.map((p) => p.account))];
    const sets = [...new Set(pairs.map((p) => p.set))];
    const reservations = new Set();
    const accountLogins = new Map();
    for (let i = 0; i < accounts.length; i += ID_CHUNK) {
      const ids = accounts.slice(i, i + ID_CHUNK);
      // aggregate() does not cast: the account ids must be ObjectIds to match.
      const held = await M.DropLog.aggregate([
        { $match: { account: { $in: ids.map((id) => new Types.ObjectId(id)) }, soldSetId: { $in: sets }, soldAt: { $ne: null } } },
        { $group: { _id: { account: "$account", set: "$soldSetId" }, holders: { $addToSet: { $ifNull: ["$soldToUsername", ""] } } } },
        { $limit: ids.length * sets.length }, // every (account, set) pair at most once
      ]);
      for (const r of held) {
        // The shared rule (isRealSale / the spent view): any holder but a claim tag is a buyer.
        const buyer = (r.holders || []).some((h) => !isMarketClaimTag(h));
        if (buyer) reservations.add(String(r._id.account).toLowerCase() + "|" + String(r._id.set));
      }
      const named = await M.BotAccount.find({ _id: { $in: ids } }, { login: 1 }).limit(ids.length).lean();
      for (const a of named) {
        const login = String(a.login || "").trim().toLowerCase();
        if (login) accountLogins.set(String(a._id).toLowerCase(), login);
      }
    }
    return { reservations, accountLogins, note: "" };
  } catch (e) {
    return { reservations: null, accountLogins: new Map(), note: "the reservation read failed: " + (e && e.message ? e.message : String(e)) };
  }
}

// Bounded, projected reads (Atlas shared tier: the cost is bytes returned).
// Models are required lazily so tests and the snapshot preview never need Mongo.
async function loadFromDb({ now = Date.now(), models = null } = {}) {
  const MarketplaceListing = (models && models.MarketplaceListing) || require("../../models/MarketplaceListing");
  const SaleSignal = (models && models.SaleSignal) || require("../../models/SaleSignal");
  const DropSet = (models && models.DropSet) || require("../../models/DropSet");
  const since = new Date(now - 365 * DAY);
  const listings = await MarketplaceListing.find(
    { marketplace: { $in: MARKETS } },
    {
      marketplace: 1, externalId: 1, origin: 1, title: 1, price: 1, status: 1, set: 1,
      unclaimedGame: 1, rentFarm: 1, bulkOfferId: 1, unitsSold: 1, createdAt: 1,
      updatedAt: 1, venueMinPriceUsd: 1, lastStock: 1, qtyTarget: 1,
      "units.deliveredAt": 1, "units.orderId": 1, "units.login": 1,
    },
  )
    .sort({ _id: -1 })
    .limit(READ_CAP)
    .lean();
  const signals = await SaleSignal.find(
    { source: "listing_sold", at: { $gte: since } },
    { marketplace: 1, game: 1, gameKey: 1, name: 1, priceUsd: 1, bulk: 1, dedupeKey: 1, at: 1, account: 1, login: 1, source: 1 },
  )
    .sort({ at: -1 })
    .limit(READ_CAP)
    .lean();
  // Buyer connection flips, 45 days: the farm engine's other demand source.
  const connected = await SaleSignal.find(
    { source: "connected", at: { $gte: new Date(now - 45 * DAY) } },
    { game: 1, gameKey: 1, account: 1, login: 1, at: 1, dedupeKey: 1 },
  )
    .sort({ at: -1 })
    .limit(CONNECTED_CAP)
    .lean();
  // Other sellers + market-wide demand, one scanned row per game (read, never
  // scanned from here — the scanners run on their own schedule).
  const MarketResearch = (models && models.MarketResearch) || require("../../models/MarketResearch");
  const research = await MarketResearch.find(
    {},
    {
      game: 1, markets: 1, sellers: 1, offers: 1, salesPerWeek: 1, demandScore: 1, competitionScore: 1,
      opportunityScore: 1, recommendation: 1, scannedAt: 1, demandTrend: 1, campaign: 1, noClaim: 1,
    },
  )
    .limit(2000)
    .lean();
  // The farm engine's recent decisions. Only a COUNT of assigned accounts leaves
  // the database — never the logins.
  const AutoFarmTask = (models && models.AutoFarmTask) || require("../../models/AutoFarmTask");
  const tasks = await AutoFarmTask.aggregate([
    // decidedAt is indexed (createdAt is not); every task from the last 30 days has one.
    { $match: { decidedAt: { $gte: new Date(now - 30 * DAY) } } },
    { $sort: { decidedAt: -1 } },
    { $limit: 4000 },
    {
      $project: {
        game: 1, campaignName: 1, campaignEndAt: 1, decision: 1, reason: 1, internalSales: 1,
        coverage: 1, plannedAccounts: 1, targetAccounts: 1, decidedAt: 1, createdAt: 1, completedAt: 1,
        assignedN: { $size: { $ifNull: ["$assignedAccounts", []] } },
      },
    },
  ]);
  const ids = [...new Set(listings.map((l) => l.set && String(l.set)).filter(Boolean))];
  const sets = [];
  // Chunked $in: one giant id list is a large request body on a shared tier.
  for (let i = 0; i < ids.length; i += 500) {
    const part = await DropSet.find(
      { _id: { $in: ids.slice(i, i + 500) } },
      { name: 1, price: 1, minPriceUsd: 1, "items.itemKey": 1, "items.game": 1, "items.qty": 1, "items.name": 1 },
    ).lean();
    sets.push(...part);
  }
  // A read that hits its cap silently drops the OLDEST rows; say so, on the page.
  const truncated = listings.length >= READ_CAP || signals.length >= READ_CAP || connected.length >= CONNECTED_CAP;
  // Which Shop / bulk-order sales still hold their reservation, and their logins.
  const resv = await reservationEvidence(signals, models && models.DropLog && models.BotAccount ? models : null);
  return {
    listings, signals, sets, connected, research, tasks, at: new Date(now), truncated,
    reservations: resv.reservations, accountLogins: resv.accountLogins, reservationNote: resv.note,
  };
}

// A snapshot may carry the reservation evidence ("<account>|<set>" pairs, account -> login);
// without it no Shop / bulk-order sale is counted, exactly as when the read fails.
function loadFromSnapshot(file) {
  const d = JSON.parse(require("fs").readFileSync(file, "utf8"));
  return {
    listings: d.listings, signals: d.signals, sets: d.sets, at: new Date(d.at),
    connected: d.connected || [], research: d.research || [], tasks: d.tasks || [],
    reservations: Array.isArray(d.reservations) ? new Set(d.reservations) : null,
    accountLogins: d.accountLogins && typeof d.accountLogins === "object" ? new Map(Object.entries(d.accountLogins)) : null,
    reservationNote: Array.isArray(d.reservations) ? "" : "the snapshot holds no reservations",
  };
}

/* ---------------------------------- report --------------------------------- */

// ONE code path, two drivers. The report is CPU-bound (~1 s on the dev machine) and
// the live server shares its event loop with delivery and the guardians, so the
// server drives it in phases that yield between steps (buildReportAsync) and tests and
// the preview drive it straight through (buildReport).
function* reportSteps(input, { now = null, fees = {}, sizing = {}, gameCaps = {}, noClaimGames = [], shelfCaps = {}, reuseOnlyGames = [] } = {}) {
  const t = now || (input.at ? new Date(input.at).getTime() : Date.now());
  const ledger = buildLedger(input);
  yield;
  const prepared = A.prepare({ listings: input.listings, sets: input.sets, sales: ledger.sales });
  const venues = A.venueSummary({ sales: ledger.sales, prepared, now: t, fees });
  yield;
  const advice = A.advise({ sales: ledger.sales, prepared, now: t, fees });
  yield;
  const board = A.setBoard({ sales: ledger.sales, prepared, now: t, fees });
  yield;
  const curves = advice.curves;
  const ctx = { sales: ledger.sales, now: t, tr: advice.tr, fees, curves };
  const games = G.gameBoard({
    ledger, prepared, research: input.research || [], tasks: input.tasks || [],
    signals: input.signals || [], connected: input.connected || [], now: t, fees, ctx, sizing, gameCaps,
    noClaimGames, shelfCaps, reuseOnlyGames,
  });
  yield;
  const taskHistory = G.taskHistory(input.tasks || []);
  const report = {
    games,
    taskHistory,
    truncated: !!input.truncated,
    at: new Date(t),
    markets: MARKETS,
    ledger,
    prepared,
    venues,
    advice: advice.rows,
    board,
    curves,
    ctx,
    fees,
  };
  report.insights = insightsFor(report);
  return report;
}

function buildReport(input, opts = {}) {
  const it = reportSteps(input, opts);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

async function buildReportAsync(input, opts = {}) {
  const it = reportSteps(input, opts);
  let r = it.next();
  while (!r.done) {
    await new Promise((resolve) => setImmediate(resolve));
    r = it.next();
  }
  return r.value;
}

// The headline findings, each with the evidence it stands on. Plain statements a
// person can check against the tabs, never a score.
function insightsFor(r) {
  const out = [];
  if (r.truncated) {
    out.push({
      id: "truncated",
      level: "warn",
      title: "The data read hit its row cap",
      detail: "Only the newest " + READ_CAP + " rows were read, so older history is missing and every figure here is incomplete.",
    });
  }
  const suspect = r.ledger.suspect || [];
  if (suspect.length) {
    const by = suspect.reduce((m, s) => ((m[s.market] = (m[s.market] || 0) + 1), m), {});
    out.push({
      id: "mass-close",
      level: "warn",
      title: "Some recorded “sales” are really delists",
      detail:
        suspect.length +
        " sale signals (" +
        Object.entries(by).map(([m, n]) => m + " " + n).join(", ") +
        ") were written in bursts of 8+ within five minutes, or within seconds of their listing being delisted: a mass delist or a bulk mark-sold, not purchases. They are set aside here and never enter a price. The existing pricing evidence (utils/pricingEvidence.js) still counts them.",
    });
  }
  for (const v of r.venues) {
    if (v.realised.n >= 10 && v.askVsRealisedPct != null && v.askVsRealisedPct >= 40) {
      out.push({
        id: "ask-gap:" + v.market,
        level: "info",
        title: v.label + ": we ask more than we have ever realised",
        detail:
          "Live asking median $" + v.live.askMedian.toFixed(2) + " vs realised median $" + v.realised.median.toFixed(2) +
          " over " + v.realised.n + " sales (" + v.askVsRealisedPct + "% higher). Check the price curve before assuming the market will pay it.",
      });
    }
    if (v.realised.n >= 10 && v.atFloorShare >= 0.5 && v.floorUsd > 0) {
      out.push({
        id: "at-floor:" + v.market,
        level: "info",
        title: v.label + ": most sales happen at the platform minimum",
        detail:
          Math.round(v.atFloorShare * 100) + "% of " + v.realised.n + " sales were at or within 5% of the $" + v.floorUsd.toFixed(2) +
          " floor — the floor is doing the price discovery, so there is no evidence about higher prices there.",
      });
    }
    if (v.approxShare >= 0.5 && v.realised.n) {
      out.push({
        id: "approx:" + v.market,
        level: "info",
        title: v.label + ": prices are the listing price now, not the price at sale",
        detail:
          Math.round(v.approxShare * 100) + "% of its " + v.realised.n + " sales come from delivered units, which store an order id but not a price. A repriced listing changes its past revenue.",
      });
    }
  }
  for (const m of ["gameflip", "zeusx"]) {
    const c = r.curves[m];
    if (!c || !c.best) continue;
    const best = c.bins.find((b) => b.label === c.best);
    const live = r.advice.filter((a) => a.market === m && a.origin === "auto");
    if (!best || !live.length) continue;
    const weaker = c.bins.filter((b) => !b.thin && b.expectedRevenueLow != null && b.expectedRevenueLow < best.expectedRevenueLow * 0.6);
    const inWeak = live.filter((a) => weaker.some((b) => A.BIN_LABELS.indexOf(b.label) === binIndex(a.current)));
    if (inWeak.length >= 5) {
      out.push({
        id: "curve:" + m,
        level: "opportunity",
        title: m + ": " + inWeak.length + " live auto listings sit where listings earn the least",
        detail:
          "Auto listings priced in the " + best.label + " range earned the most per listing here ($" + best.expectedRevenueLow.toFixed(2) +
          " at the conservative end vs under $" + (best.expectedRevenueLow * 0.6).toFixed(2) + " for the weaker ranges below). " +
          inWeak.length + " of " + live.length + " live auto listings are priced in those weaker ranges. This is a correlation (see the caveat on the curve), so test on a few before moving many.",
      });
    }
  }
  // Per game: where the farm engine's demand picture and the clean one disagree,
  // and where the market buys what we do not sell.
  const own = (r.games || []).filter((g) => g.own);
  const engineSum = own.reduce((a, g) => a + g.demand.engine.count45, 0);
  const unionSum = own.reduce((a, g) => a + g.demand.units45, 0);
  if (own.length && engineSum !== unionSum) {
    const over = own.filter((g) => g.demand.engine.count45 >= g.demand.units45 + 5);
    out.push({
      id: "engine-vs-clean",
      level: engineSum > unionSum ? "warn" : "info",
      title: "The farm engine's sales count is not the real count",
      detail:
        "Over its 45-day window the engine counts " + engineSum + " sales across our games; each sold account counted once, from every source, it is " + unionSum +
        ". The engine counts duplicate-login twin accounts twice and mass-delist signals as sales, and cannot see delivered Eldorado/G2G/PlayerAuctions units. " +
        over.length + " games are over-counted by 5 or more (" + over.slice(0, 5).map((g) => g.game + " " + g.demand.engine.count45 + " vs " + g.demand.units45).join(", ") + (over.length > 5 ? ", …" : "") +
        "). Open the Games tab for each.",
    });
  }
  const missed = (r.games || [])
    .filter((g) => !g.own && g.demand.market && g.demand.market.perWeek >= 30)
    .sort((a, b) => b.demand.market.perWeek - a.demand.market.perWeek)
    .slice(0, 5);
  if (missed.length) {
    out.push({
      id: "market-we-miss",
      level: "opportunity",
      title: missed.length + " games move 30+ units a week on GGSel + Plati and we sell none",
      detail: missed.map((g) => g.game + " ~" + Math.round(g.demand.market.perWeek) + "/wk").join(", ") + ". Whether we can farm them is the farm engine's call; the demand is real.",
    });
  }

  const multi = r.board.filter((b) => b.marketsWithSales >= 2 && b.spread);
  if (multi.length) {
    out.push({
      id: "cross-market",
      level: "info",
      title: multi.length + " exact sets have sold on 2+ markets",
      detail:
        "Median price spread between their cheapest and dearest market is ×" + median(multi.map((b) => b.spread)).toFixed(2) +
        ". These are the only like-for-like cross-market comparisons; everything else is translated.",
    });
  }
  if (r.ledger.quality.unattributedUnits) {
    out.push({
      id: "unattributed",
      level: "info",
      title: r.ledger.quality.unattributedUnits + " sold units have no priced record",
      detail: "Listings count these as sold (unitsSold) but no priced sale signal backs them, so their price is unknown and they are excluded from every average.",
    });
  }
  // Shop and bulk-order sales count only while their reservation holds (ledger.js).
  const ex = r.ledger.excluded || {};
  if (ex.reservationUnchecked) {
    const why = r.ledger.quality.reservationNote;
    out.push({
      id: "reservations-unchecked",
      level: "warn",
      title: ex.reservationUnchecked + " Shop / bulk-order sales could not be confirmed",
      detail:
        "Their reservations could not be read this run" + (why ? " (" + why + ")" : "") +
        ", so none of them counts as demand: a refunded or cancelled order would otherwise read as a sale.",
    });
  }
  if (ex.reservationReleased) {
    out.push({
      id: "reservations-released",
      level: "info",
      title: ex.reservationReleased + " Shop / bulk-order sales were rolled back",
      detail:
        "Their reservations were given back (a failed payment, a refund, a cancelled or deleted bulk order) or are now held by a marketplace listing, not a buyer, so they are not counted as sales.",
    });
  }
  if (r.ledger.quality.wipeCloseUnknown) {
    out.push({
      id: "wipe-close-unknown",
      level: "info",
      title: r.ledger.quality.wipeCloseUnknown + " emptied listings have no time they were closed",
      detail:
        "A burst emptied them and they are delisted now, but their rows do not say when they closed, so the burst was set aside as a wipe. With a close time it would count as sales if they stayed on sale for an hour after it.",
    });
  }
  return out;
}

function binIndex(price) {
  const edges = [0.8, 1.1, 1.35, 1.6, 1.9, 2.4, 3.1, 4.1, Infinity];
  const i = edges.findIndex((e) => price <= e + 1e-9);
  return i < 0 ? edges.length - 1 : i;
}

/* ----------------------------------- cache --------------------------------- */

/**
 * The settings the report depends on, read fresh (utils/settings re-reads its file):
 * fees, the farm-sizing policy (cover days, safety stock, ceiling, your per-game caps),
 * the no-claim games and their shelf caps, and the reuse-only games. Every field is
 * optional; a missing or unreadable setting leaves the tracker on its documented
 * defaults. This is the DEFAULT source for every rebuild, wherever it was triggered
 * from — a publisher's background refresh must not rebuild the page's report with
 * default settings (found by review: it dropped fees, caps and no-claim games).
 */
function settingsInputs() {
  const out = {};
  try {
    const settings = require("../settings");
    const s = settings.loadSettings();
    out.fees = (s && s.priceTracker && s.priceTracker.fees) || {};
    const af = settings.getAutoFarm() || {};
    const sz = settings.getFarmSizing(af);
    out.sizing = { coverageDays: sz.coverageDays, safetyStock: sz.safetyStock, maxAccounts: sz.maxPerGame };
    out.gameCaps = sz.gameCaps || {};
    out.noClaimGames = Array.isArray(af.noClaimGames) ? af.noClaimGames : [];
    out.shelfCaps = af.unclaimedGameCaps && typeof af.unclaimedGameCaps === "object" ? af.unclaimedGameCaps : {};
    out.reuseOnlyGames = Array.isArray(af.reuseOnlyGames) ? af.reuseOnlyGames : [];
  } catch {
    /* defaults */
  }
  return out;
}

// Where rebuilds get their settings. Tests and the preview swap it; production uses
// settingsInputs() (utils/settings, re-read from disk each time).
let settingsProvider = settingsInputs;
function setSettingsProvider(fn) {
  settingsProvider = typeof fn === "function" ? fn : settingsInputs;
}

async function getReport({ force = false, loader = loadFromDb, ...opts } = {}) {
  if (!force && cache.report && Date.now() - cache.at < CACHE_MS) return cache.report;
  // One load at a time: concurrent requests on a stale cache share it instead of
  // each reading Mongo (a bytes-bound shared tier).
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const input = await loader();
      // Explicit options win; everything else comes from settings.
      let fromSettings = {};
      try {
        fromSettings = settingsProvider() || {};
      } catch {
        fromSettings = {};
      }
      const report = await buildReportAsync(input, { ...fromSettings, ...opts });
      cache = { at: Date.now(), report };
      return report;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function invalidate() {
  cache = { at: 0, report: null };
}

/**
 * For callers on a publish path: never wait on the database if a report exists.
 * A stale report is served at once and refreshed in the background; with no report
 * at all it waits up to `timeoutMs` and then gives up (null), so a slow load can
 * delay a listing by at most that long and never fail it.
 */
async function getReportSWR({ timeoutMs = 2500, ...opts } = {}) {
  if (cache.report) {
    if (Date.now() - cache.at >= CACHE_MS && !inflight) getReport({ force: true, ...opts }).catch(() => {});
    return cache.report;
  }
  let timer;
  try {
    return await Promise.race([
      getReport(opts),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------ for the auto-farm -------------------------- */

/**
 * The farm advice for one game, in the shape an engine can read:
 * { target, listed, inFlight, need, spare, direction, perWeek, valuePerAccount, weeklyRevenueUsd, managed }.
 * `direction` is "more" | "hold" | "less" | "none" | "managed" (no-claim games are
 * sized by their own allocator and get no instruction). Null when the game is unknown.
 * NOT consumed by utils/autoFarmer.js yet; see docs/PRICE-TRACKER-PLAN.md.
 */
function farmFor(report, game) {
  const row = (report.games || []).find((g) => g.key === normGame(game));
  if (!row) return null;
  const f = row.farm;
  return { game: row.game, target: f.target, listed: f.listed, inFlight: f.inFlight, need: f.need, spare: f.spare, direction: f.direction, perWeek: f.perWeek, valuePerAccount: f.valuePerAccount, weeklyRevenueUsd: f.weeklyRevenueUsd, managed: f.managed, reasons: f.reasons };
}

/**
 * What should a NEW listing cost on one market? The seam the auto-farm links to.
 *
 * NOT wired into autoLister / autoFarmBundles — wiring it is the deploy step,
 * after the owner has checked the advice against real listings. Until then this
 * is only reachable from the tracker's own API.
 *
 * @param {object} report  a buildReport()/getReport() result
 * @param {object} q       { market, game, itemCount, items:[{itemKey,game,qty}], title }
 */
function suggestForNew(report, q) {
  const market = String(q.market || "").toLowerCase();
  if (!VENUES[market]) return { price: 0, action: "insufficient", reasons: ["unknown market " + market] };
  const items = Array.isArray(q.items) ? q.items : [];
  const title =
    q.title ||
    (q.game ? q.game + " Twitch Drops" + (q.itemCount ? " (" + q.itemCount + " Items)" : "") : "");
  const id = identify({ title }, items.length ? { items } : null);
  if (VENUES[market].blocked) {
    return { price: 0, action: "blocked", confidence: "none", reasons: ["market blocked by owner"], market };
  }
  const rec = A.recommend(report.ctx, {
    market,
    id,
    currentPrice: 0,
    setMinUsd: Number(q.minPriceUsd) || 0,
    venueMinUsd: Number(q.venueMinPriceUsd) || 0,
    ageDays: 0,
  });
  // The game-level price knows other sellers and the whole game's sales on every
  // market; the set-level price knows these exact items. Take the better-evidenced
  // one, and prefer the game-level one on a tie because it has seen the rivals.
  const rank = { high: 3, medium: 2, low: 1, none: 0 };
  const gkey = id.gameKey || normGame(q.game);
  const row = (report.games || []).find((g) => g.key === gkey);
  const gp = row && row.price.markets[market] ? row.price.markets[market].suggested : null;
  let best = { ...rec, source: "set" };
  if (gp && gp.price > 0 && (rank[gp.confidence] || 0) >= (rank[rec.confidence] || 0) && !(rec.basis === "exact set sold on this market")) {
    best = {
      ...rec,
      price: gp.price,
      anchor: gp.anchor,
      basis: gp.basis,
      confidence: gp.confidence,
      evidenceN: gp.evidenceN,
      reasons: gp.reasons,
      floor: gp.floor,
      cap: gp.cap,
      clamped: gp.clamped,
      test: gp.test,
      position: gp.position,
      source: "game",
      action: "new",
    };
  }
  return { ...best, market, contentKey: id.contentKey, exact: id.exact, game: row ? row.game : q.game || "" };
}

module.exports = {
  buildReport,
  buildReportAsync,
  settingsInputs,
  setSettingsProvider,
  _reportSteps: reportSteps,
  getReport,
  getReportSWR,
  farmFor,
  invalidate,
  loadFromDb,
  loadFromSnapshot,
  reservationEvidence,
  suggestForNew,
  insightsFor,
  CACHE_MS,
};
