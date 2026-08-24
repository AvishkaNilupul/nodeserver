// Auto-farm allocation forecast — the read-only "how many pool accounts will
// this game get, and why" view behind the Bots → Auto farm → Watcher section.
//
// WHY THIS EXISTS
// The engine already decides, every tick, how many accounts each live campaign
// earns (demand → cap → floor → coverage gate → fair-share → seats). The owner
// wanted to SEE that allocation ahead of time — per game/event, how many
// accounts are pooled and farmed, plus the supporting demand/coverage/revenue
// numbers — so a big seller can be spotted and the pool topped up before the
// event instead of after.
//
// HOW IT STAYS TRUTHFUL
// For LIVE campaigns the engine has already written its decision onto the
// AutoFarmTask (targetAccounts = the demand target, plannedAccounts = what it
// actually allocated after every clamp, coverage.archiveHolders = how much was
// already covered, plus the human reason). We READ those numbers rather than
// recompute them: they are exactly what the engine did — including the manual
// stash sweep that needs SSH — so the forecast matches the engine by
// construction and never has to touch a bot host on this request path (an
// offline Pi costs ~63s per read; see [[reference_pi_link_timeouts]]).
//
// For SCHEDULED (not-yet-started) campaigns there is no task yet, so we
// recompute the standalone demand target through the SAME exported helpers the
// tick uses (demandAllocation / marketStockFloor / capForGame) and label it an
// estimate ("when live"). Coverage for those is a DB-only DropLog read with the
// manual stash approximated as empty — a slight over-count of coverage that can
// only UNDER-state the estimate, which is the safe direction for a preview.
//
// LIVE TWITCH ENRICHMENT (rate-safe)
// Neither path knows a drop's required watch minutes from the DB alone, so for
// events missing that fact we make at most a handful of live
// fetchCampaignDetails() reads per build (they never hit the integrity gate,
// same as Stream Scout), cache the result in-memory for 6h AND persist it onto
// the TwitchCampaign so repeat loads are DB-only. Every live call is fail-soft:
// no token or an error just drops that row back to DB-only fields.
const settings = require("./settings");
const autoFarmer = require("./autoFarmer");
const { fetchCampaignDetails } = require("./twitchInventory");
const TwitchCampaign = require("../models/TwitchCampaign");
const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");

// Static drop facts (required minutes + drop count) change only when a campaign
// is re-issued, so cache hard. Persisted onto TwitchCampaign as well, so this
// in-memory map is really only a within-process short-circuit.
const DETAILS_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const detailsCache = new Map(); // campaignId -> { requiredMinutesWatched, dropItemCount, fetchedAt }

// Hard ceiling on live Twitch reads per forecast build, so a first load with
// many un-enriched events can never fan out into hundreds of GraphQL calls.
// SCHEDULED events (nobody farming them yet → ETA matters most) are enriched
// before LIVE ones. Everything else falls back to DB-only for this build and
// gets enriched on later builds as the budget frees up.
const MAX_LIVE_FETCHES_PER_BUILD = 12;

// How far ahead a scheduled campaign is worth previewing by default.
const DEFAULT_WINDOW_DAYS = 14;

function lc(s) {
  return String(s || "").toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Healthy tokens to read campaign details with — the same selection Stream
// Scout uses (last scan OK, most recently scanned first). Read-only, so it can
// never burn a farming account. Returns trimmed clientSecret strings.
async function borrowTokens(limit = 5) {
  try {
    const rows = await BotAccount.find(
      { clientSecret: { $exists: true, $ne: "" }, lastScanStatus: "ok" },
      { clientSecret: 1 },
    )
      .sort({ lastScanAt: -1 })
      .limit(limit)
      .lean();
    return rows.map((r) => String(r.clientSecret || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

// Collapse one campaign's timeBasedDrops into the two facts the forecast wants:
// requiredMinutesWatched = the MAX threshold (full watch time to earn EVERY
// drop, from zero progress), dropItemCount = how many time-based drops it grants.
function summariseDetails(camp) {
  const drops = Array.isArray(camp && camp.timeBasedDrops)
    ? camp.timeBasedDrops
    : [];
  let maxMinutes = 0;
  for (const d of drops) {
    const m = num(d && d.requiredMinutesWatched);
    if (m > maxMinutes) maxMinutes = m;
  }
  return { requiredMinutesWatched: maxMinutes, dropItemCount: drops.length };
}

// Resolve a campaign's static drop facts from the cheapest source that has
// them: in-memory cache → persisted TwitchCampaign fields → (only if a fetch
// budget remains and a token exists) one live fetchCampaignDetails, which is
// then cached and persisted. `budget` is a mutable { left } counter shared
// across the build. Returns { requiredMinutesWatched, dropItemCount, source }
// or null when nothing could be resolved (fail-soft: caller shows DB-only row).
async function resolveDetails(campaignId, persisted, tokens, budget) {
  const cid = String(campaignId || "");
  if (!cid) return null;
  const hit = detailsCache.get(cid);
  if (hit && Date.now() - hit.fetchedAt < DETAILS_TTL_MS) {
    return { ...hit, source: "cache" };
  }
  if (persisted && persisted.requiredMinutesWatched != null) {
    const rec = {
      requiredMinutesWatched: num(persisted.requiredMinutesWatched),
      dropItemCount: num(persisted.dropItemCount),
      fetchedAt: Date.now(),
    };
    detailsCache.set(cid, rec);
    return { ...rec, source: "db" };
  }
  if (!tokens.length || budget.left <= 0) return null;
  budget.left -= 1;
  let tokenIdx = 0;
  while (tokenIdx < tokens.length) {
    try {
      const camp = await fetchCampaignDetails(tokens[tokenIdx], cid);
      const rec = { ...summariseDetails(camp), fetchedAt: Date.now() };
      detailsCache.set(cid, rec);
      // Persist so future builds (and other readers) are DB-only. Best-effort:
      // a write failure must never break the forecast.
      TwitchCampaign.updateOne(
        { campaignId: cid },
        {
          $set: {
            requiredMinutesWatched: rec.requiredMinutesWatched,
            dropItemCount: rec.dropItemCount,
          },
        },
      ).catch(() => {});
      return { ...rec, source: "live" };
    } catch (e) {
      // A dead token rotates to the next; any other error is fail-soft.
      if (e && e.code === "token_invalid" && tokenIdx + 1 < tokens.length) {
        tokenIdx++;
        continue;
      }
      return null;
    }
  }
  return null;
}

// Best per-unit price we can defend for a game's accounts, for the revenue
// estimate: our own realised average first (strongest), then a real bundle
// price we set, then the market-observed revenue proxy. 0 when we know nothing.
function unitPriceFor(gameLower, sales, research, dropSetPrice) {
  if (sales && sales.avgPrice > 0) return sales.avgPrice;
  const ds = num(dropSetPrice);
  if (ds > 0) return ds;
  if (research && num(research.observedRevenue) > 0)
    return num(research.observedRevenue);
  return 0;
}

// The standalone demand target for a game (what the tick's fair-share requests
// as `want`), reusing the engine's exported clamp helpers so it tracks whatever
// the engine does. Mirrors autoFarmer's request builder exactly:
//   want = min(max(alloc.target, alloc.probe ? 0 : marketStockFloor(af)), cap)
function wantedFor(alloc, af) {
  if (!alloc || alloc.skip) return 0;
  const floor = alloc.probe ? 0 : autoFarmer.marketStockFloor(af);
  const cap = alloc.cap || af.maxPerGame;
  return Math.min(Math.max(num(alloc.target), floor), cap);
}

// Map campaignId -> best DropSet unit price, for every game in `games`, in one
// query. Games come from the same Twitch source as DropSet.game, but hedge
// against case drift by keying the result lowercased.
async function dropSetPricesByGame(games) {
  const out = new Map();
  const list = [...new Set(games.filter(Boolean))];
  if (!list.length) return out;
  try {
    const rows = await DropSet.find(
      { game: { $in: list }, custom: { $ne: true } },
      { game: 1, price: 1, publicPrice: 1, minPriceUsd: 1 },
    ).lean();
    for (const r of rows) {
      const key = lc(r.game);
      const p = num(r.publicPrice) || num(r.price) || num(r.minPriceUsd);
      if (!out.has(key) || p > out.get(key)) out.set(key, p);
    }
  } catch {
    /* revenue estimate simply omits the DropSet tier */
  }
  return out;
}

// Per-game demand inputs (own sales + stored research), fetched once per unique
// game with bounded parallelism. researchForGame is a pure DB read (NOT the
// live-scout freshResearchForGame the tick uses — the forecast must never fire
// market scouts on a page load).
async function gameInfoMap(games) {
  const list = [...new Set(games.filter(Boolean))];
  const rows = await autoFarmer.mapWithConcurrency(list, 6, async (game) => {
    const [sales, research] = await Promise.all([
      autoFarmer.internalSalesForGame(game).catch(() => ({
        count: 0,
        revenue: 0,
        avgPrice: 0,
      })),
      autoFarmer.researchForGame(game).catch(() => null),
    ]);
    return { game, sales, research };
  });
  const map = new Map();
  for (const r of rows) map.set(lc(r.game), r);
  return map;
}

// Human label + operator hint for what is capping realised allocation, read
// straight from the engine's OWN skip reasons this tick (the most truthful
// signal there is — it is literally why the engine stopped).
function bottleneckFrom(decisionCounts, hasWantedDemand) {
  if (decisionCounts.skip_no_accounts > 0) {
    return {
      key: "pool",
      label: "Pool-limited",
      hint: "The ready pool is at its reserve floor. Add / verify more pool accounts to farm the outstanding demand.",
    };
  }
  if (decisionCounts.skip_no_capacity > 0) {
    return {
      key: "seats",
      label: "Seat-limited",
      hint: "Every auto-bot seat is busy. Raise maxAutoBots or accountsPerBot to farm the outstanding demand.",
    };
  }
  if (!hasWantedDemand) {
    return {
      key: "demand",
      label: "Idle — no demand",
      hint: "No live campaign currently clears the demand tier. Nothing to allocate.",
    };
  }
  return {
    key: "healthy",
    label: "Healthy — demand-limited",
    hint: "Pool and seats can cover every live campaign's target; allocation is bounded only by real demand.",
  };
}

// Build one LIVE-event row straight from the engine's recorded decision.
function liveRow(camp, task, info, unitPrice, details) {
  const sales = (info && info.sales) || { count: 0, revenue: 0, avgPrice: 0 };
  const research = info && info.research;
  const covered = task ? num(task.coverage && task.coverage.archiveHolders) : 0;
  const deployed = task ? (task.assignedAccounts || []).length : 0;
  const target = task ? num(task.targetAccounts) : 0;
  const projected = task ? num(task.plannedAccounts) : 0;
  // Fresh pool accounts the plan still has to add beyond what is already
  // deployed on the task (backfill tops up toward plannedAccounts).
  const freshToPool = Math.max(0, projected - deployed);
  return {
    state: "LIVE",
    game: camp.game || (task && task.game) || "",
    campaignId: camp.campaignId,
    campaignName: camp.name || (task && task.campaignName) || "",
    startAt: camp.startAt || null,
    endAt: camp.endAt || (task && task.campaignEndAt) || null,
    decision: task ? task.decision : "pending",
    reason: task ? task.reason : "Live campaign not yet decided this tick.",
    dryRun: task ? !!task.dryRun : false,
    demandScore: task && task.demandScore != null
      ? num(task.demandScore)
      : research
        ? num(research.demandScore)
        : null,
    sales: { count: sales.count, revenue: sales.revenue, avgPrice: sales.avgPrice },
    // The headline numbers the owner asked for.
    demandTarget: target,
    projected,
    poolSplit: { covered, farmingNow: deployed, freshToPool },
    unitPrice,
    estRevenue: Math.round(projected * unitPrice * 100) / 100,
    requiredMinutesWatched: details ? details.requiredMinutesWatched : null,
    dropItemCount: details
      ? details.dropItemCount
      : camp.dropItemCount != null
        ? num(camp.dropItemCount)
        : null,
    detailsSource: details ? details.source : null,
  };
}

// Build one SCHEDULED-event row by recomputing the standalone demand target.
function scheduledRow(camp, info, af, unitPrice, details) {
  const sales = (info && info.sales) || { count: 0, revenue: 0, avgPrice: 0 };
  const research = info && info.research;
  const alloc = autoFarmer.demandAllocation(research, af, sales);
  const wanted = wantedFor(alloc, af);
  const covered = info ? num(info.covered) : 0;
  const uncovered = Math.max(0, wanted - covered);
  const tierNote = alloc.skip
    ? "Below demand tier — would be skipped."
    : alloc.tierNote || "";
  return {
    state: "SCHEDULED",
    game: camp.game || "",
    campaignId: camp.campaignId,
    campaignName: camp.name || "",
    startAt: camp.startAt || null,
    endAt: camp.endAt || null,
    decision: alloc.skip ? "skip_low_demand" : alloc.probe ? "probe" : "farm",
    reason:
      (tierNote ? tierNote + " " : "") +
      "Estimate — the engine allocates once the campaign goes live (fair-share " +
      "against whatever else is live then).",
    dryRun: false,
    demandScore: research ? num(research.demandScore) : null,
    sales: { count: sales.count, revenue: sales.revenue, avgPrice: sales.avgPrice },
    demandTarget: wanted,
    // No fair-share/seat context for the future, so the estimate is the
    // uncovered demand target, pool permitting when it goes live.
    projected: uncovered,
    poolSplit: { covered, farmingNow: 0, freshToPool: uncovered },
    unitPrice,
    estRevenue: Math.round(uncovered * unitPrice * 100) / 100,
    requiredMinutesWatched: details ? details.requiredMinutesWatched : null,
    dropItemCount: details
      ? details.dropItemCount
      : camp.dropItemCount != null
        ? num(camp.dropItemCount)
        : null,
    detailsSource: details ? details.source : null,
  };
}

// Coverage for scheduled games (no task yet): own unsold DropLog holders that
// this system's auto-listings could deliver — the same archiveHoldersByGame the
// tick uses, but with the manual stash approximated as EMPTY (no SSH sweep on
// this request path). That can only over-count coverage, which under-states the
// estimate — the safe direction for a preview. Ownership unknown → count every
// holder (conservative), matching the engine's fail-open.
async function coverageForGames(games) {
  const out = new Map();
  const list = [...new Set(games.filter(Boolean))];
  if (!list.length) return out;
  try {
    const owned = await autoFarmer.ownedAccounts();
    const holders = await autoFarmer.archiveHoldersByGame(
      list,
      new Set(),
      owned,
    );
    for (const [k, v] of holders) out.set(k, num(v.holders));
  } catch {
    /* leave empty — scheduled rows show 0 covered */
  }
  return out;
}

// The whole payload. windowDays bounds how far ahead scheduled events are shown.
async function getAllocationForecast({ windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  const af = settings.getAutoFarm();
  const now = new Date();
  const nowMs = now.getTime();
  const horizon = new Date(nowMs + Math.max(1, windowDays) * 86400000);

  // Pool + seat capacity (DB-only; seat usage approximated from task rosters so
  // we never touch a host on this path).
  const ready = await autoFarmer.countReadyPool();
  const spendable = Math.max(0, ready - num(af.poolReserve));
  const globalSeatCap = num(af.maxAutoBots) * num(af.accountsPerBot);

  // LIVE campaigns and the engine's recorded decisions for them.
  const liveCamps = await TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    {
      campaignId: 1,
      game: 1,
      name: 1,
      startAt: 1,
      endAt: 1,
      requiredMinutesWatched: 1,
      dropItemCount: 1,
    },
  ).lean();
  const liveIds = liveCamps.map((c) => c.campaignId);
  const taskRows = liveIds.length
    ? await AutoFarmTask.find(
        { campaignId: { $in: liveIds } },
        {
          game: 1,
          campaignId: 1,
          campaignName: 1,
          campaignEndAt: 1,
          decision: 1,
          reason: 1,
          demandScore: 1,
          coverage: 1,
          plannedAccounts: 1,
          targetAccounts: 1,
          assignedAccounts: 1,
          status: 1,
          dryRun: 1,
        },
      ).lean()
    : [];
  const taskById = new Map(taskRows.map((t) => [t.campaignId, t]));

  // SCHEDULED campaigns: known, active, starting inside the window.
  const scheduledCamps = await TwitchCampaign.find(
    {
      active: true,
      startAt: { $gt: now, $lt: horizon },
    },
    {
      campaignId: 1,
      game: 1,
      name: 1,
      startAt: 1,
      endAt: 1,
      requiredMinutesWatched: 1,
      dropItemCount: 1,
    },
  )
    .sort({ startAt: 1 })
    .lean();
  // A campaign can be both "started" and future-listed in edge cases; never
  // double-count — live wins.
  const liveIdSet = new Set(liveIds);
  const scheduledOnly = scheduledCamps.filter(
    (c) => !liveIdSet.has(c.campaignId),
  );

  // Per-game demand inputs + prices, over every game in play.
  const allGames = [
    ...liveCamps.map((c) => c.game),
    ...scheduledOnly.map((c) => c.game),
  ];
  const [infoMap, priceMap, schedCoverage] = await Promise.all([
    gameInfoMap(allGames),
    dropSetPricesByGame(allGames),
    coverageForGames(scheduledOnly.map((c) => c.game)),
  ]);

  // Live enrichment budget + tokens, shared across the whole build.
  const budget = { left: MAX_LIVE_FETCHES_PER_BUILD };
  const tokens = await borrowTokens();
  const liveTokenOk = tokens.length > 0;

  // SCHEDULED first (ETA matters most where nothing is farming yet), then LIVE.
  const scheduledEvents = [];
  for (const camp of scheduledOnly) {
    const info = infoMap.get(lc(camp.game)) || null;
    const withCover = info
      ? { ...info, covered: schedCoverage.get(lc(camp.game)) || 0 }
      : { covered: schedCoverage.get(lc(camp.game)) || 0 };
    const unitPrice = unitPriceFor(
      lc(camp.game),
      info && info.sales,
      info && info.research,
      priceMap.get(lc(camp.game)),
    );
    const details = await resolveDetails(camp.campaignId, camp, tokens, budget);
    scheduledEvents.push(scheduledRow(camp, withCover, af, unitPrice, details));
  }

  const liveEvents = [];
  for (const camp of liveCamps) {
    const task = taskById.get(camp.campaignId) || null;
    const info = infoMap.get(lc(camp.game)) || null;
    const unitPrice = unitPriceFor(
      lc(camp.game),
      info && info.sales,
      info && info.research,
      priceMap.get(lc(camp.game)),
    );
    const details = await resolveDetails(camp.campaignId, camp, tokens, budget);
    liveEvents.push(liveRow(camp, task, info, unitPrice, details));
  }

  // Summary over the LIVE set (the actionable near-term picture). Scheduled
  // rows are future estimates and don't move the bottleneck.
  const decisionCounts = {
    farm: 0,
    probe: 0,
    skip_no_accounts: 0,
    skip_no_capacity: 0,
    skip_already_covered: 0,
    skip_low_demand: 0,
  };
  let totalWanted = 0;
  let totalProjected = 0;
  let totalCovered = 0;
  let totalRevenue = 0;
  let deployedInAuto = 0;
  for (const t of taskRows) {
    if (t.status === "active" || t.status === "planned")
      deployedInAuto += (t.assignedAccounts || []).length;
  }
  for (const ev of liveEvents) {
    if (ev.decision in decisionCounts) decisionCounts[ev.decision]++;
    totalWanted += ev.demandTarget;
    totalProjected += ev.projected;
    totalCovered += ev.poolSplit.covered;
    totalRevenue += ev.estRevenue;
  }
  const hasWantedDemand = liveEvents.some(
    (ev) => ev.decision === "farm" || ev.decision === "probe",
  );
  const freeSeats = Math.max(0, globalSeatCap - deployedInAuto);
  const bottleneck = bottleneckFrom(decisionCounts, hasWantedDemand);

  // Sort each section by what the owner scans for: biggest projected first,
  // then soonest.
  const byProjected = (a, b) =>
    b.projected - a.projected ||
    new Date(a.endAt || a.startAt || 0) - new Date(b.endAt || b.startAt || 0);
  liveEvents.sort(byProjected);
  scheduledEvents.sort(
    (a, b) => new Date(a.startAt || 0) - new Date(b.startAt || 0),
  );

  return {
    builtAt: now.toISOString(),
    summary: {
      ready,
      poolReserve: num(af.poolReserve),
      spendable,
      globalSeatCap,
      freeSeats,
      deployedInAuto,
      accountsPerBot: num(af.accountsPerBot),
      maxAutoBots: num(af.maxAutoBots),
      maxPerGame: num(af.maxPerGame),
      liveCount: liveEvents.length,
      scheduledCount: scheduledEvents.length,
      totalWanted,
      totalProjected,
      totalCovered,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      bottleneck,
      liveTokenOk,
      dryRun: !!af.dryRun,
    },
    events: liveEvents.concat(scheduledEvents),
  };
}

// Test/ops seam: drop the in-memory details cache.
function clearCache() {
  detailsCache.clear();
}

module.exports = {
  getAllocationForecast,
  clearCache,
  DETAILS_TTL_MS,
  MAX_LIVE_FETCHES_PER_BUILD,
  // exported for unit tests
  summariseDetails,
  wantedFor,
  unitPriceFor,
  bottleneckFrom,
};
