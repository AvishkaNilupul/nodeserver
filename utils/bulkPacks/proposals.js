// Bulk packs — the proposal engine, "the bundler"
// (docs/bulk-packs/MODULES.md §proposals.js, CONTRACT.md).
//
// READ-ONLY. It works out which bulk offers COULD be sent right now and at what
// price, for the owner to pick from on the Bulk packs page. It never reserves,
// publishes or writes anything: Send is always an owner click, handled by
// send.js, which re-checks stock, gate and price itself. So every number here
// is a preview — a stale or partial one can hide a proposal or show one that
// send.js then refuses, but it can never put an offer on sale.
//
// Bounded DB work (CONTRACT I12) — the whole read, per build:
//   DropSet.find           newest 600 non-custom sets with items (+ the few
//                          sets an OPEN offer points at, when outside those)
//   BulkOffer.find         open offers, slotKey only, limit 500
//   shopRoutes.stockForSets one union DropLog aggregation — a cheap UPPER
//                          bound (no listed-login filter) for every set
//   stock.dropsetFreeCounts precise counts for the top `limit` sets only
//   stock.noclaimCounts    at most `limit` no-claim sets, one at a time
//   MarketplaceListing.find active non-bulk rows of the counted sets only
//                          (price anchors), projected, limit 5000
// and the result is cached 5 minutes per function (CONTRACT §9 / MODULES).
//
// Every sibling module is reached lazily through `deps` (CONTRACT §9), so the
// tests fake them and nothing here loads a marketplace client at boot.

// Results live this long; `refresh` (or invalidate()) bypasses.
const CACHE_MS = 5 * 60 * 1000;
// Sets read per build (MODULES: limit(600)).
const SET_CAP = 600;
// Open offers read per build; the loop reads at most 500 too.
const OPEN_CAP = 500;
// Anchor rows read per build — far above what ≤ 2×limit sets carry.
const ROW_CAP = 5000;
// accountProposals({limit}): default and hard ceiling.
const LIMIT_DEFAULT = 40;
const LIMIT_MAX = 100;
// farmProposals: demand window and how many (game, days) rows to propose.
const FARM_DEMAND_DAYS = 60;
const FARM_TOP = 30;

// Custom listings (promo covers, the unclaimed auto-lister's own sets) are not
// bundles the owner farms and sells; a set with no items has nothing to sell.
const SET_FILTER = { custom: { $ne: true }, "items.0": { $exists: true } };
// What stockForSets / dropsetFreeCounts / noclaimCounts (stock scope, items,
// stock source), pickAnchor (price floors) and gameOfSet (cover game, item
// games, source fields) read off a set — and nothing else. `items` is
// projected WHOLE: a sub-field projection (items.image) makes Mongo rebuild
// every item array (routes/dropArchiveRoutes.js measured ~50 s vs ~7 s).
const SET_PROJECTION = {
  name: 1,
  items: 1,
  price: 1,
  minPriceUsd: 1,
  custom: 1,
  stockSource: 1,
  listed: 1,
  coverGame: 1,
  accountScopeLogins: 1,
  accountScopeIds: 1,
  sourceType: 1,
  sourceEventKey: 1,
  sourceEventName: 1,
  autoFarmTaskId: 1,
};
// Exactly the fields send.js reads for pricing.pickAnchor (MODULES §send.js
// step 3), so a proposal's anchor is computed from the same row shape.
const ROW_PROJECTION = {
  price: 1,
  set: 1,
  marketplace: 1,
  status: 1,
  bulkOfferId: 1,
  title: 1,
};

// ---------------------------------------------------------------------------
// Lazy dependencies (CONTRACT §9)
// ---------------------------------------------------------------------------
let depOverrides = {};
const deps = {
  get DropSet() {
    return depOverrides.DropSet || require("../../models/DropSet");
  },
  get BulkOffer() {
    return depOverrides.BulkOffer || require("../../models/BulkOffer");
  },
  get MarketplaceListing() {
    return (
      depOverrides.MarketplaceListing ||
      require("../../models/MarketplaceListing")
    );
  },
  get settings() {
    return depOverrides.settings || require("../settings");
  },
  get config() {
    return depOverrides.config || require("./config");
  },
  get pricing() {
    return depOverrides.pricing || require("./pricing");
  },
  get stock() {
    return depOverrides.stock || require("./stock");
  },
  get farmCapacity() {
    return depOverrides.farmCapacity || require("./farmCapacity");
  },
  get markets() {
    return depOverrides.markets || require("./markets");
  },
  get shopRoutes() {
    return depOverrides.shopRoutes || require("../../routes/shopRoutes");
  },
  // Clock for the cache (tests move it instead of waiting five minutes).
  get now() {
    return depOverrides.now || Date.now;
  },
};

function __setDeps(partial) {
  depOverrides = {
    ...depOverrides,
    ...(partial && typeof partial === "object" ? partial : {}),
  };
  // A result built with the old dependencies must not outlive them.
  invalidate();
}
function __resetDeps() {
  depOverrides = {};
  invalidate();
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const str = (v) => (v == null ? "" : String(v));
const errText = (e) => (e && e.message) || String(e);
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
// A non-negative whole count; anything unusable is 0.
function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
function clampLimit(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) return LIMIT_DEFAULT;
  return Math.min(n, LIMIT_MAX);
}
function isTrue(v) {
  return v === true || v === 1 || v === "1" || v === "true";
}
function byName(a, b) {
  return (
    str(a.name).localeCompare(str(b.name)) ||
    str(a._id).localeCompare(str(b._id))
  );
}

// Map<String(key), count> from a Map (or a plain object). `pick` reads the
// count off each value (stockForSets values are {stock, topItems}).
function countMap(m, pick = (v) => v) {
  const out = new Map();
  const entries =
    m instanceof Map
      ? [...m.entries()]
      : m && typeof m === "object"
        ? Object.entries(m)
        : [];
  for (const [k, v] of entries) out.set(String(k), count(pick(v)));
  return out;
}

// SOURCE_MARKETS[source] ∩ bp.markets, in SOURCE_MARKETS order. isMarketAllowed
// also refuses blocked (plati/digiseller/ggsel) and unsupported markets, so no
// proposal can ever name one, whatever the settings object holds.
function marketsFor(config, source, bp) {
  const list = (config.SOURCE_MARKETS && config.SOURCE_MARKETS[source]) || [];
  return list.filter((m) => config.isMarketAllowed(m, bp));
}

// The delivery gate depends on (market, source) only, and each read hits the
// settings file, so a build asks once per pair. Never throws: a failed check
// is a closed gate.
function gateReader(config) {
  const memo = new Map();
  return (market, source) => {
    const k = market + "|" + source;
    if (!memo.has(k)) {
      let g;
      try {
        g = config.currentGate(market, source);
      } catch (e) {
        g = { ok: false, reason: "delivery gate check failed: " + errText(e) };
      }
      memo.set(k, { ok: !!(g && g.ok === true), reason: str(g && g.reason) });
    }
    return { ...memo.get(k) };
  };
}

// settings.isNoClaimGame reads the settings file on every call; the distinct
// games across 600 sets are few, so each is asked once per build. A failing
// check reads as "no-claim" — it only ever HIDES a dropset proposal.
function noClaimReader(settings) {
  const memo = new Map();
  return (game) => {
    const g = str(game).trim();
    if (!g) return false;
    if (!memo.has(g)) {
      let v;
      try {
        v = !!settings.isNoClaimGame(g);
      } catch {
        v = true;
      }
      memo.set(g, v);
    }
    return memo.get(g);
  };
}

// Every game label a set touches: the one gameOfSet names, the cover game and
// each item's game.
function gamesOfSet(set, game) {
  const out = [game, set && set.coverGame];
  for (const i of set && Array.isArray(set.items) ? set.items : []) {
    out.push(i && i.game);
  }
  return out.map((g) => str(g).trim()).filter(Boolean);
}

function setView(set, game) {
  const items = (Array.isArray(set.items) ? set.items : [])
    .filter(Boolean)
    .map((i) => ({
      name: str(i.name),
      image: str(i.image),
      // The shop's own copy-count rule (routes/shopRoutes.js listingView).
      qty: Math.max(1, Number(i.qty) || 1),
    }));
  const withImage = items.find((i) => i.image);
  return {
    id: String(set._id),
    name: str(set.name),
    game,
    items,
    image: withImage ? withImage.image : "",
  };
}

// ---------------------------------------------------------------------------
// Cache: 5 minutes per function, `refresh` bypasses, invalidate() clears.
// ---------------------------------------------------------------------------
// Concurrent callers share one build. invalidate() bumps the generation, so a
// build that was already running when an offer was sent still answers its own
// callers but is never stored — the next call rebuilds.
let generation = 0;
const slots = {
  accounts: { cache: new Map(), inflight: new Map() },
  farm: { cache: new Map(), inflight: new Map() },
};

function invalidate() {
  generation += 1;
  slots.accounts.cache.clear();
  slots.farm.cache.clear();
}

function cachedCall(slot, key, refresh, build) {
  const startedAt = deps.now();
  const hit = slot.cache.get(key);
  if (
    !refresh &&
    hit &&
    hit.gen === generation &&
    startedAt >= hit.at &&
    startedAt - hit.at < CACHE_MS
  ) {
    return Promise.resolve(hit.value);
  }
  // A build already running for this generation is as fresh as a new one.
  const running = slot.inflight.get(key);
  if (running && running.gen === generation) return running.promise;
  const gen = generation;
  const entry = { gen, promise: null };
  entry.promise = Promise.resolve()
    .then(() => build(startedAt))
    .then((value) => {
      if (gen === generation) {
        slot.cache.set(key, { at: startedAt, gen, value });
      }
      return value;
    })
    .finally(() => {
      if (slot.inflight.get(key) === entry) slot.inflight.delete(key);
    });
  slot.inflight.set(key, entry);
  return entry.promise;
}

// ---------------------------------------------------------------------------
// Account packs (sources dropset + noclaim)
// ---------------------------------------------------------------------------

// The result is shared with every caller for 5 minutes: treat it as read-only.
async function accountProposals({
  refresh = false,
  limit = LIMIT_DEFAULT,
} = {}) {
  const lim = clampLimit(limit);
  return cachedCall(slots.accounts, String(lim), isTrue(refresh), (startedAt) =>
    buildAccountProposals(lim, startedAt),
  );
}

async function buildAccountProposals(limit, startedAt) {
  const { config, settings, pricing } = deps;
  const bp = settings.getBulkPacks();
  const tiers = Array.isArray(bp && bp.tiers) ? bp.tiers : [];
  const reserve = count(bp && bp.reserveSingles);
  const minTier = tiers.length
    ? Math.min(...tiers.map((t) => num(t && t.minQty) || Infinity))
    : Infinity;

  // 1. Candidate sets, newest first. The _id sort walks the _id index, so the
  //    cap keeps the NEWEST 600 with no in-memory sort (no allowDiskUse).
  const sets = await deps.DropSet.find(SET_FILTER, SET_PROJECTION)
    .sort({ _id: -1 })
    .limit(SET_CAP)
    .lean();

  // 2. Open offers: slotKey -> offer id (the tier's liveOfferId), and the sets
  //    they sit on — a set with an open offer is always evaluated, so its live
  //    link shows even when every free account is already on that offer.
  const open = await deps.BulkOffer.find(
    { open: true, kind: "accounts" },
    { slotKey: 1, set: 1, source: 1 },
  )
    .limit(OPEN_CAP)
    .lean();
  const liveBySlot = new Map();
  const liveSets = new Set();
  for (const o of open) {
    if (o.slotKey) liveBySlot.set(o.slotKey, String(o._id));
    if (o.set) liveSets.add(String(o.set));
  }
  const loaded = new Set(sets.map((s) => String(s._id)));
  const missing = [];
  for (const o of open) {
    if (!o.set || loaded.has(String(o.set))) continue;
    loaded.add(String(o.set));
    missing.push(o.set);
  }
  if (missing.length) {
    const extra = await deps.DropSet.find(
      { ...SET_FILTER, _id: { $in: missing } },
      SET_PROJECTION,
    )
      .limit(OPEN_CAP)
      .lean();
    sets.push(...extra);
  }

  // 3. Classify. The game comes from the auto-lister's own set->game helper
  //    (markets.gameOfSet), exactly as send.js derives it. A set that touches
  //    a no-claim game ANYWHERE (its game, cover game or any item) is never a
  //    dropset proposal: a claimed Overwatch/R6/CoD drop is worthless to a
  //    buyer. A set whose game cannot be read is skipped, never guessed.
  const markets = deps.markets;
  const isNoClaim = noClaimReader(settings);
  const dropsets = [];
  const noclaims = [];
  for (const set of sets) {
    let game;
    try {
      game = str(await markets.gameOfSet(set)).trim();
    } catch (e) {
      console.warn(
        "bulkPacks proposals: no game for set " +
          String(set._id) +
          ": " +
          errText(e),
      );
      continue;
    }
    const entry = {
      set,
      id: String(set._id),
      game,
      live: liveSets.has(String(set._id)),
    };
    if (set.stockSource === "noclaim") noclaims.push(entry);
    else if (!gamesOfSet(set, game).some(isNoClaim)) dropsets.push(entry);
  }

  // 4. Dropset stock. One cheap upper bound for every set (stockForSets: same
  //    AVAILABLE_DROP + sellable-account test as the precise count, minus the
  //    listed-login filter, so precise <= upper). A set whose upper bound
  //    cannot fit the smallest tier after the singles reserve can never
  //    produce a fitting tier, so only the top `limit` sets that CAN — plus
  //    the sets with an open offer — get the precise (costlier) count.
  let upper = new Map();
  if (dropsets.length) {
    upper = countMap(
      await deps.shopRoutes.stockForSets(dropsets.map((d) => d.set)),
      (v) => (v && typeof v === "object" ? v.stock : v),
    );
  }
  for (const d of dropsets) d.upper = upper.get(d.id) || 0;
  const byUpper = (a, b) => b.upper - a.upper || byName(a.set, b.set);
  const topD = dropsets
    .filter((d) => !d.live && d.upper - reserve >= minTier)
    .sort(byUpper)
    .slice(0, limit);
  const liveD = dropsets
    .filter((d) => d.live)
    .sort(byUpper)
    .slice(0, limit);
  const countedD = liveD.concat(topD);
  let freeById = new Map();
  if (countedD.length) {
    freeById = countMap(
      await deps.stock.dropsetFreeCounts(
        countedD.map((d) => d.set),
        { limit: countedD.length },
      ),
    );
  }
  for (const d of countedD) d.free = freeById.get(d.id) || 0;

  // 5. No-claim stock: at most `limit` sets (newest first) plus the ones with
  //    an open offer, read one at a time. A failed read is that set's problem
  //    only — it counts as no stock (nothing fits), never as an error page.
  const noclaimMarkets =
    (config.SOURCE_MARKETS && config.SOURCE_MARKETS.noclaim) || [];
  const countedN = noclaims
    .filter((n) => n.live)
    .slice(0, limit)
    .concat(noclaims.filter((n) => !n.live).slice(0, limit));
  for (const n of countedN) {
    n.share = {};
    try {
      const c = await deps.stock.noclaimCounts(n.set);
      n.free = count(c && c.free);
      for (const m of noclaimMarkets)
        n.share[m] = count(c && c.share && c.share[m]);
    } catch (e) {
      n.free = 0;
      for (const m of noclaimMarkets) n.share[m] = 0;
      console.warn(
        "bulkPacks proposals: no-claim stock for set " +
          n.id +
          " failed: " +
          errText(e),
      );
    }
  }

  // 6. Price anchors: the counted sets' active, non-bulk rows on the markets
  //    we propose — one projected query (send.js reads the same shape).
  const dropsetMarkets = marketsFor(config, "dropset", bp);
  const noclaimOffered = marketsFor(config, "noclaim", bp);
  const rowMarkets = [
    ...new Set([
      ...(countedD.length ? dropsetMarkets : []),
      ...(countedN.length ? noclaimOffered : []),
    ]),
  ];
  const rowsBySet = new Map();
  const counted = countedD.concat(countedN);
  if (counted.length && rowMarkets.length) {
    const rows = await deps.MarketplaceListing.find(
      {
        set: { $in: counted.map((c) => c.set._id) },
        marketplace: { $in: rowMarkets },
        status: "active",
        bulkOfferId: null,
        price: { $gt: 0 },
      },
      ROW_PROJECTION,
    )
      .limit(ROW_CAP)
      .lean();
    if (rows.length >= ROW_CAP) {
      console.warn(
        "bulkPacks proposals: anchor rows capped at " +
          ROW_CAP +
          " — some previews may fall back to the set price (send.js re-reads its own)",
      );
    }
    for (const r of rows) {
      const k = String(r.set);
      if (!rowsBySet.has(k)) rowsBySet.set(k, []);
      rowsBySet.get(k).push(r);
    }
  }

  // 7. Items.
  const gate = gateReader(config);
  function buildItem(entry, source) {
    const { set, id, game } = entry;
    const kind = config.KIND_OF_SOURCE[source];
    const free = count(entry.free);
    const reserveHere = source === "noclaim" ? 0 : reserve;
    const surplus = free - reserveHere;
    const rows = rowsBySet.get(id) || [];
    const marketList = source === "noclaim" ? noclaimOffered : dropsetMarkets;
    return {
      source,
      set: setView(set, game),
      free,
      reserve: reserveHere,
      surplus,
      markets: marketList.map((market) => {
        const a = pricing.pickAnchor({ rows, set, market }) || {};
        const anchor = num(a.anchor);
        const quotes = pricing.tierQuote({ anchor, market, tiers });
        // What a tier must fit into: the surplus over the singles reserve
        // (dropset, every market), or the share of the no-claim shelf a NEW
        // offer on this market would get.
        const room =
          source === "noclaim"
            ? count(entry.share && entry.share[market])
            : surplus;
        return {
          market,
          gate: gate(market, source),
          anchor,
          basis: str(a.basis),
          tiers: (Array.isArray(quotes) ? quotes : []).map((q) => {
            const minQty = num(q && q.minQty);
            const slot = config.slotKey({
              kind,
              source,
              setId: id,
              market,
              minQty,
            });
            const unitPrice = num(q && q.unitPrice);
            const packPrice = num(q && q.packPrice);
            // No price reference = nothing send.js would publish, so the page
            // must not offer the button (it would only come back 409).
            const priced = market === "gameflip" ? packPrice > 0 : unitPrice > 0;
            return {
              minQty,
              discountPct: num(q && q.discountPct),
              unitPrice,
              packPrice,
              priced,
              fits: priced && minQty > 0 && room >= minQty,
              liveOfferId: liveBySlot.get(slot) || null,
            };
          }),
        };
      }),
    };
  }

  // One set's bad data (a pricing throw) skips that set, never the page.
  const items = [];
  for (const [list, source] of [
    [countedD, "dropset"],
    [countedN, "noclaim"],
  ]) {
    for (const entry of list) {
      try {
        items.push(buildItem(entry, source));
      } catch (e) {
        console.warn(
          "bulkPacks proposals: set " + entry.id + " skipped: " + errText(e),
        );
      }
    }
  }

  // Keep an item with at least one fitting tier OR a live offer; most spare
  // accounts first.
  const kept = items.filter((it) =>
    it.markets.some((m) => m.tiers.some((t) => t.fits || t.liveOfferId)),
  );
  kept.sort(
    (a, b) =>
      b.surplus - a.surplus ||
      b.free - a.free ||
      a.set.name.localeCompare(b.set.name) ||
      a.set.id.localeCompare(b.set.id),
  );
  return { at: new Date(startedAt), items: kept };
}

// ---------------------------------------------------------------------------
// Farming packs (source farm)
// ---------------------------------------------------------------------------

// The farm-table price for (market, days), 0 when there is none.
function farmAnchor(farmPrices, market, days) {
  const table =
    farmPrices && typeof farmPrices === "object" ? farmPrices[market] : null;
  const v = Number(
    table && typeof table === "object" ? table[String(days)] : NaN,
  );
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function plainCounts(o) {
  const out = {};
  if (o && typeof o === "object" && !Array.isArray(o)) {
    for (const [k, v] of Object.entries(o)) out[k] = count(v);
  }
  return out;
}

// The result is shared with every caller for 5 minutes: treat it as read-only.
async function farmProposals({ refresh = false } = {}) {
  return cachedCall(slots.farm, "farm", isTrue(refresh), (startedAt) =>
    buildFarmProposals(startedAt),
  );
}

async function buildFarmProposals(startedAt) {
  const { config, settings, pricing, farmCapacity } = deps;
  const bp = settings.getBulkPacks();
  const tiers = Array.isArray(bp && bp.tiers) ? bp.tiers : [];
  const durations = new Set(
    (Array.isArray(bp && bp.farmDurations) ? bp.farmDurations : []).map(Number),
  );

  // Capacity: farmCapacity's own 10-minute cache (never forced from here —
  // send.js forces a fresh read before it publishes). read() never throws by
  // contract; a throw anyway reads as zero capacity.
  let capacity;
  try {
    capacity = await farmCapacity.read();
  } catch (e) {
    capacity = {
      bestStackRoom: 0,
      totalFree: 0,
      pristine: 0,
      at: null,
      error: errText(e),
    };
  }
  let advertisable = 0;
  try {
    advertisable = count(farmCapacity.advertisable(capacity, bp));
  } catch {
    advertisable = 0;
  }

  // Demand: the last 60 days of farm orders, on the configured terms only,
  // most orders first, top 30.
  const demandAll = await farmCapacity.demand({ days: FARM_DEMAND_DAYS });
  const keyOf = (game, days) => str(game).trim() + "@" + Number(days);
  const demand = (Array.isArray(demandAll) ? demandAll : []).filter(
    (d) => d && str(d.game).trim() && durations.has(Number(d.days)),
  );
  demand.sort((a, b) => count(b.orders) - count(a.orders));
  const picked = demand.slice(0, FARM_TOP);

  // Open farming offers: their slot's live link, and their (game, days) row
  // even when it has dropped out of the top 30 or off the configured terms.
  const open = await deps.BulkOffer.find(
    { open: true, kind: "farming" },
    { slotKey: 1, game: 1, days: 1 },
  )
    .sort({ _id: 1 })
    .limit(OPEN_CAP)
    .lean();
  const liveBySlot = new Map();
  for (const o of open) if (o.slotKey) liveBySlot.set(o.slotKey, String(o._id));
  const pickedKeys = new Set(picked.map((d) => keyOf(d.game, d.days)));
  for (const o of open) {
    const game = str(o.game).trim();
    const days = Number(o.days);
    if (!game || !(days > 0)) continue;
    const k = keyOf(game, days);
    if (pickedKeys.has(k)) continue;
    pickedKeys.add(k);
    const known = (Array.isArray(demandAll) ? demandAll : []).find(
      (d) => d && keyOf(d.game, d.days) === k,
    );
    picked.push(known || { game, days, orders: 0, accounts: 0, markets: {} });
  }

  const marketList = marketsFor(config, "farm", bp);
  const gate = gateReader(config);
  const items = picked.map((d) => {
    const game = str(d.game).trim();
    const days = Number(d.days);
    return {
      source: "farm",
      game,
      days,
      orders: count(d.orders),
      accounts: count(d.accounts),
      // The demand read's per-market order counts (renamed: `markets` is the
      // proposal list, the same shape as an account item's).
      demandByMarket: plainCounts(d.markets),
      markets: marketList.map((market) => ({
        market,
        gate: gate(market, "farm"),
        anchor: farmAnchor(bp.farmPrices, market, days),
        basis: "farm-table",
        tiers: tiers.map((t) => {
          const minQty = num(t && t.minQty);
          const discountPct = num(t && t.discountPct);
          const slot = config.slotKey({
            kind: "farming",
            source: "farm",
            game,
            days,
            market,
            minQty,
          });
          const unitPrice = num(
            pricing.farmUnitPrice({
              farmPrices: bp.farmPrices,
              market,
              days,
              discountPct,
            }),
          );
          return {
            minQty,
            discountPct,
            unitPrice,
            packPrice: 0,
            priced: unitPrice > 0,
            // send.js refuses below minQty advertisable accounts, and with no
            // farm price for this market/duration.
            fits: unitPrice > 0 && minQty > 0 && advertisable >= minQty,
            liveOfferId: liveBySlot.get(slot) || null,
          };
        }),
      })),
    };
  });

  return { at: new Date(startedAt), capacity, advertisable, items };
}

module.exports = {
  accountProposals,
  farmProposals,
  invalidate,
  __setDeps,
  __resetDeps,
};
