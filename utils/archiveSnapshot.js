// Background builder for the Drops Archive rollups (overview / by-game /
// by-item).
//
// The problem it solves
// --------------------
// Those three views used to be computed per request from ~200k DropLog rows.
// Measured on the production Atlas shared tier, one by-item pass took 33s, and
// the page fires all three on load. A 15s cache hid that only while someone
// kept clicking: a cold key — after a restart, after any archive write cleared
// the cache, or the first time a game filter or a search term was used — made
// the operator sit through the whole aggregation.
//
// What made it slow (measured, not guessed)
// -----------------------------------------
//   group by itemKey, count only ................  5.8s   (index-covered)
//   + numeric counters ..........................  4.6s
//   + $addToSet of account ids .................. 28.5s
//   + $first name/game/campaign, $max image ..... 31.8s
// So the cost was never the scan — it was the two per-item ObjectId sets and
// hauling every row's image URLs off disk to pick one value per item.
//
// Both are avoided here:
//   * distinct-account counts come from a pre-group on (itemKey, account),
//     which the old pipeline already paid for to get min/max copies per
//     account — counting those buckets is free.
//   * display metadata is gathered only for item keys the previous rollup
//     didn't already know, so the steady-state cost is zero.
//
// And the whole thing runs on a timer, off the request path. Readers get the
// last built rollup immediately and filter it in memory, so a game filter or a
// search is now instant instead of a fresh cold aggregation.
const mongoose = require("mongoose");
const DropLog = require("../models/DropLog");
const BotAccount = require("../models/BotAccount");
const ArchiveRollup = require("../models/ArchiveRollup");
const {
  BAD_STATUSES,
  excludedAccountIdsCached,
} = require("./archiveExclusions");

const ROLLUP_KEY = "drops-archive";

// How often the rollup is rebuilt when nothing else triggers it.
const REFRESH_MS =
  Number(process.env.ARCHIVE_SNAPSHOT_REFRESH_MS) || 5 * 60 * 1000;
// After an archive write, rebuild this soon. Long enough that a burst of edits
// (a purge, a bulk sync) collapses into one rebuild.
const BUST_DEBOUNCE_MS = 3000;
// Re-read every item's display metadata this often even when no new item keys
// appeared, so a campaign name change or a newly cached image is picked up.
const META_FULL_REFRESH_MS = 6 * 60 * 60 * 1000;
// How often the rollup is written back to Mongo. The document is ~1MB of item
// rows and the write measured ~11s on the production shared tier — most of a
// rebuild's cost, for a copy whose only job is to survive a restart. Persisting
// every quarter hour means a restart restores numbers at most that stale, and
// it refreshes them in the background immediately after.
const PERSIST_INTERVAL_MS = 15 * 60 * 1000;
// A rollup older than this is not worth serving; a reader will wait for a
// rebuild instead. Only reachable if the refresh loop has been failing for
// hours, in which case stale numbers would be actively misleading.
const MAX_SERVE_AGE_MS = 24 * 60 * 60 * 1000;

// Pool rows are AvailableAccount drops: checked, but not wired into any bot.
// accountModel is absent on older rows, and those are deployed drops — so the
// test is an equality against the pool marker, never a "not BotAccount".
const IS_POOL = { $eq: ["$accountModel", "AvailableAccount"] };
const NOT_POOL = { $not: IS_POOL };

let snapshot = null; // last built rollup, in memory
let building = null; // in-flight build, shared by every waiter
let dbLoad = null; // in-flight "load the persisted rollup" read
let refreshTimer = null;
let bustTimer = null;
let started = false;
let lastPersistAt = 0;

function stateCounter(state) {
  return {
    $sum: {
      $cond: [{ $and: [NOT_POOL, { $eq: ["$state", state] }] }, 1, 0],
    },
  };
}

// One row per (itemKey, game) with every purely numeric tally. Grouping on the
// raw game alongside the key is what lets by-game be derived from this same
// pass instead of costing a second full scan: the group key is exactly the
// `_id: "$game"` the by-game view used to group on.
async function aggregateCounters(match) {
  return DropLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: { k: "$itemKey", g: "$game" },
        drops: { $sum: { $cond: [IS_POOL, 0, 1] } },
        totalCount: { $sum: { $cond: [IS_POOL, 0, "$count"] } },
        claimed: stateCounter("claimed"),
        connect: stateCounter("connect"),
        connected: stateCounter("connected"),
        poolDrops: { $sum: { $cond: [IS_POOL, 1, 0] } },
        poolCount: { $sum: { $cond: [IS_POOL, "$count", 0] } },
      },
    },
  ]);
}

// Distinct accounts per item, plus the exact min/max copies a single deployed
// account holds (an account with 4x vs 5x of a drop differs, and the delivery
// picker needs to know). The pre-group on (item, account) is the only stage
// that genuinely needs per-pair granularity; it stays numeric-only so it holds
// well under the 100MB in-memory limit — allowDiskUse is off on the shared
// tier. Counting the surviving buckets in the second stage is what replaces the
// $addToSet that cost 24s.
async function aggregateItemAccounts(match) {
  return DropLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: { k: "$itemKey", a: "$account", p: { $cond: [IS_POOL, 1, 0] } },
        cnt: { $sum: "$count" },
      },
    },
    {
      $group: {
        _id: { k: "$_id.k", p: "$_id.p" },
        accounts: { $sum: 1 },
        minPerAcct: { $min: "$cnt" },
        maxPerAcct: { $max: "$cnt" },
      },
    },
  ]);
}

// Distinct accounts per game — the one by-game number that cannot be derived
// from the per-item rows, because the same account holds many items in a game.
async function aggregateGameAccounts(match) {
  return DropLog.aggregate([
    { $match: match },
    {
      $group: {
        _id: { g: "$game", a: "$account", p: { $cond: [IS_POOL, 1, 0] } },
      },
    },
    { $group: { _id: { g: "$_id.g", p: "$_id.p" }, accounts: { $sum: 1 } } },
  ]);
}

// Display metadata for the given item keys. Matches on the indexed itemKey, so
// asking for a handful of new keys is a cheap targeted read; asking for all of
// them (first build, or the periodic full refresh) is the one expensive pass,
// and it happens in the background.
async function aggregateItemMeta(match, keys) {
  if (!keys.length) return [];
  return DropLog.aggregate([
    { $match: { ...match, itemKey: { $in: keys } } },
    {
      $group: {
        _id: "$itemKey",
        name: { $first: "$name" },
        game: { $first: "$game" },
        imageLocal: { $max: "$imageLocal" },
        // $max, not $first, because a handful of items carry more than one
        // CDN URL for the same reward (Twitch re-uploads the asset). $first
        // returns whichever row the scan reached first, so the card's fallback
        // image changed every time metadata was re-read; $max always picks the
        // same one. imageLocal, which wins when present, already worked this
        // way.
        imageURL: { $max: "$imageURL" },
        campaign: { $first: "$campaign" },
      },
    },
  ]);
}

// Assemble the per-item rows the by-item view returns. Counter rows are keyed
// by (itemKey, game); collapsing them back to one row per itemKey reproduces
// the old `$group: { _id: "$itemKey" }` exactly, including the (currently
// nonexistent) case of one key spanning two spellings of a game.
function buildItems(counterRows, accountRows, metaByKey) {
  const byKey = new Map();
  for (const row of counterRows) {
    const key = row._id.k;
    let item = byKey.get(key);
    if (!item) {
      item = {
        itemKey: key,
        game: row._id.g || "",
        drops: 0,
        totalCount: 0,
        claimed: 0,
        connect: 0,
        connected: 0,
        poolDrops: 0,
        poolCount: 0,
      };
      byKey.set(key, item);
    }
    item.drops += row.drops;
    item.totalCount += row.totalCount;
    item.claimed += row.claimed;
    item.connect += row.connect;
    item.connected += row.connected;
    item.poolDrops += row.poolDrops;
    item.poolCount += row.poolCount;
  }

  for (const row of accountRows) {
    const item = byKey.get(row._id.k);
    if (!item) continue;
    if (row._id.p) {
      item.poolAccounts = row.accounts;
    } else {
      item.accounts = row.accounts;
      item.minPerAcct = row.minPerAcct;
      item.maxPerAcct = row.maxPerAcct;
    }
  }

  const items = [];
  for (const item of byKey.values()) {
    const meta = metaByKey.get(item.itemKey) || {};
    const imageLocal = meta.imageLocal || "";
    items.push({
      itemKey: item.itemKey,
      name: meta.name || "",
      // Metadata carries the display-cased game; the counter row's raw game is
      // the same value and is the fallback while metadata is still catching up.
      game: meta.game != null ? meta.game : item.game,
      image: imageLocal.length ? imageLocal : meta.imageURL || "",
      imageURL: meta.imageURL || "",
      campaign: meta.campaign || "",
      totalCount: item.totalCount,
      accounts: item.accounts || 0,
      claimed: item.claimed,
      connect: item.connect,
      connected: item.connected,
      poolCount: item.poolCount,
      poolAccounts: item.poolAccounts || 0,
      // null (not 0) when the item is held only in the pool, matching the old
      // "no row in the min/max pipeline" case the UI already handles.
      minPerAcct: item.minPerAcct == null ? null : item.minPerAcct,
      maxPerAcct: item.maxPerAcct == null ? null : item.maxPerAcct,
      // Not part of the by-item response — carried so by-game, the overview and
      // the next rebuild's metadata reuse can all work off this array instead
      // of re-scanning the archive.
      drops: item.drops,
      poolDrops: item.poolDrops,
      rawGame: item.game,
      imageLocal,
    });
  }
  // Same order the old { $sort: { accounts: -1, totalCount: -1 } } gave, plus a
  // key tiebreak. Items tied on both counts are common (a game's rewards are
  // farmed together, so they land on identical account counts), and without a
  // third key their relative order came out of whatever order the aggregation
  // happened to emit — so tied cards swapped places between rebuilds for no
  // reason the operator could see.
  items.sort(
    (a, b) =>
      b.accounts - a.accounts ||
      b.totalCount - a.totalCount ||
      (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0),
  );
  return items;
}

// by-game, rolled up from the per-item rows. Grouping on rawGame (the value
// stored on the drops) keeps this identical to the old `_id: "$game"` group,
// including the empty-string bucket for rewards with no game.
function buildGames(items, gameAccountRows) {
  const byGame = new Map();
  for (const item of items) {
    const game = item.rawGame || "";
    let row = byGame.get(game);
    if (!row) {
      row = {
        game,
        drops: 0,
        totalCount: 0,
        accounts: 0,
        items: 0,
        poolDrops: 0,
        poolCount: 0,
        poolAccounts: 0,
        poolItems: 0,
      };
      byGame.set(game, row);
    }
    row.drops += item.drops;
    row.totalCount += item.totalCount;
    row.poolDrops += item.poolDrops;
    row.poolCount += item.poolCount;
    // "items" counted distinct itemKeys among deployed rows only, so an item
    // that exists in this game solely in the pool must not be counted here.
    if (item.drops > 0) row.items += 1;
    if (item.poolDrops > 0) row.poolItems += 1;
  }
  for (const row of gameAccountRows) {
    const game = row._id.g || "";
    const target = byGame.get(game);
    if (!target) continue;
    if (row._id.p) target.poolAccounts = row.accounts;
    else target.accounts = row.accounts;
  }
  const games = [...byGame.values()];
  // Name tiebreak for the same reason as the item sort: games tied on total
  // held must not swap rows between rebuilds.
  games.sort(
    (a, b) =>
      b.totalCount - a.totalCount ||
      (a.game < b.game ? -1 : a.game > b.game ? 1 : 0),
  );
  return games;
}

// The dashboard header, derived from the same rows. `accounts` is the only
// figure that isn't in the archive at all, so it stays a live count — one
// cheap indexed query, not a scan.
function buildOverview(items, accountCount) {
  const overview = {
    accounts: accountCount,
    totalDrops: 0,
    totalItemsHeld: 0,
    games: 0,
    items: 0,
    poolDrops: 0,
    poolItems: 0,
  };
  const games = new Set();
  for (const item of items) {
    overview.totalDrops += item.drops;
    overview.totalItemsHeld += item.totalCount;
    overview.poolDrops += item.poolDrops;
    if (item.drops > 0) {
      overview.items += 1;
      // distinct("game") on the deployed rows, then .filter(Boolean).length —
      // so rewards with no game never counted as a game.
      if (item.rawGame) games.add(item.rawGame);
    }
    if (item.poolDrops > 0) overview.poolItems += 1;
  }
  overview.games = games.size;
  return overview;
}

async function build() {
  const startedAt = Date.now();
  const badIds = await excludedAccountIdsCached();
  const match = { account: { $nin: badIds } };

  // Sequential on purpose. On the Atlas shared tier concurrent queries
  // serialise at best and contend at worst — a measured Promise.all of seven
  // counts took 1450ms where the same seven in series took 240ms each. Running
  // these back to back also keeps the box usable for live traffic while the
  // rebuild is in flight.
  const counterRows = await aggregateCounters(match);
  const accountRows = await aggregateItemAccounts(match);
  const gameAccountRows = await aggregateGameAccounts(match);

  const keys = [...new Set(counterRows.map((r) => r._id.k))];
  const previous = snapshot;
  const metaExpired =
    !previous ||
    !previous.metaBuiltAt ||
    Date.now() - new Date(previous.metaBuiltAt).getTime() >
      META_FULL_REFRESH_MS;
  const known = new Map();
  if (!metaExpired && previous) {
    // Reuse what the last rollup already resolved. Every metadata field is
    // carried on the item rows verbatim (imageLocal included, even though the
    // response only exposes the resolved `image`) so this round-trips exactly
    // and a reused entry is indistinguishable from a freshly read one.
    for (const item of previous.items) {
      known.set(item.itemKey, {
        name: item.name,
        game: item.game,
        imageLocal: item.imageLocal || "",
        imageURL: item.imageURL,
        campaign: item.campaign,
      });
    }
  }
  const missing = keys.filter((k) => !known.has(k));
  const freshMeta = await aggregateItemMeta(match, missing);
  for (const m of freshMeta) {
    known.set(m._id, {
      name: m.name,
      game: m.game,
      imageLocal: m.imageLocal,
      imageURL: m.imageURL,
      campaign: m.campaign,
    });
  }

  const accountCount = await BotAccount.countDocuments({
    lastScanStatus: { $nin: BAD_STATUSES },
  });

  const items = buildItems(counterRows, accountRows, known);
  const built = {
    builtAt: new Date(),
    buildMs: Date.now() - startedAt,
    metaBuiltAt:
      metaExpired || !previous || !previous.metaBuiltAt
        ? new Date()
        : previous.metaBuiltAt,
    items,
    games: buildGames(items, gameAccountRows),
    overview: buildOverview(items, accountCount),
  };
  snapshot = built;

  // Persist so the next restart serves instantly, but not on every cycle — see
  // PERSIST_INTERVAL_MS. A failure here is not fatal: the in-memory rollup is
  // already live and the next cycle retries.
  let persistMs = 0;
  if (Date.now() - lastPersistAt >= PERSIST_INTERVAL_MS) {
    const persistStart = Date.now();
    try {
      await ArchiveRollup.updateOne(
        { key: ROLLUP_KEY },
        { $set: { key: ROLLUP_KEY, ...built } },
        { upsert: true },
      );
      lastPersistAt = Date.now();
      persistMs = lastPersistAt - persistStart;
    } catch (err) {
      console.error("[archiveSnapshot] persist failed:", err.message);
    }
  }
  console.log(
    "[archiveSnapshot] built " +
      items.length +
      " items / " +
      built.games.length +
      " games in " +
      built.buildMs +
      "ms" +
      (missing.length ? " (metadata for " + missing.length + " keys)" : "") +
      (persistMs ? " (+" + persistMs + "ms persist)" : ""),
  );
  return built;
}

// One build at a time, shared by everyone waiting on it.
function refresh() {
  if (building) return building;
  building = build().finally(() => {
    building = null;
  });
  return building;
}

// Pull the last persisted rollup into memory. Used once at boot so a restart
// doesn't make the first visitor wait for a full rebuild.
async function loadPersisted() {
  if (snapshot) return snapshot;
  if (dbLoad) return dbLoad;
  dbLoad = (async () => {
    try {
      const doc = await ArchiveRollup.findOne({ key: ROLLUP_KEY }).lean();
      if (doc && Array.isArray(doc.items) && doc.builtAt && !snapshot) {
        snapshot = {
          builtAt: doc.builtAt,
          buildMs: doc.buildMs || 0,
          metaBuiltAt: doc.metaBuiltAt || null,
          items: doc.items,
          games: doc.games || [],
          overview: doc.overview || {},
        };
      }
      return snapshot;
    } catch (err) {
      console.error("[archiveSnapshot] load failed:", err.message);
      return null;
    } finally {
      dbLoad = null;
    }
  })();
  return dbLoad;
}

function ageMs(snap) {
  return Date.now() - new Date(snap.builtAt).getTime();
}

// What every archive read calls. Returns a rollup without ever blocking on the
// aggregation once one exists — a stale-but-instant page beats a correct one
// that takes half a minute to appear, and a rebuild is already on its way.
//
// `fresh` is the exception, for the one case where instant-but-stale is the
// wrong answer: the page reloading straight after a sync, scan or purge, where
// showing the pre-write numbers reads as "my import did nothing". Those callers
// wait for a rebuild that covers their write.
async function getSnapshot(opts) {
  const wantFresh = !!(opts && opts.fresh);
  if (!snapshot) await loadPersisted();
  if (wantFresh) {
    if (bustTimer) {
      clearTimeout(bustTimer);
      bustTimer = null;
    }
    // "Fresh" means built after this request arrived — never a build already in
    // flight, which may have started before the write the caller is waiting on.
    // A sync in particular writes for minutes after its POST returns, so any
    // rebuild triggered by that POST is guaranteed to have missed most of it.
    if (building) await building.catch(() => {});
    return refresh();
  }
  if (snapshot && ageMs(snapshot) < MAX_SERVE_AGE_MS) {
    if (ageMs(snapshot) > REFRESH_MS && !building) {
      refresh().catch((e) =>
        console.error("[archiveSnapshot] background refresh:", e.message),
      );
    }
    return snapshot;
  }
  return refresh();
}

// Whatever is in memory right now, or null. For callers that must not trigger
// or wait on a build.
function peek() {
  return snapshot;
}

// An archive write landed. Rebuild soon, but keep serving the current rollup in
// the meantime — a burst of edits collapses into one rebuild.
function invalidate() {
  if (bustTimer) return;
  bustTimer = setTimeout(() => {
    bustTimer = null;
    refresh().catch((e) =>
      console.error("[archiveSnapshot] post-write refresh:", e.message),
    );
  }, BUST_DEBOUNCE_MS);
  if (bustTimer.unref) bustTimer.unref();
}

function start() {
  if (started) return;
  started = true;
  loadPersisted()
    .then((snap) => {
      if (snap) {
        console.log(
          "[archiveSnapshot] loaded persisted rollup from " +
            new Date(snap.builtAt).toISOString(),
        );
      }
      if (!snap || ageMs(snap) > REFRESH_MS) return refresh();
      return null;
    })
    .catch((e) => console.error("[archiveSnapshot] initial build:", e.message));

  scheduleNext();
}

// Self-rescheduling rather than a fixed interval, so the gap is measured from
// the END of the last rebuild. A rebuild that runs long can never stack up
// behind itself on an already-contended shared tier.
function scheduleNext() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    const done = () => {
      if (started) scheduleNext();
    };
    if (mongoose.connection.readyState !== 1) return done();
    refresh()
      .catch((e) =>
        console.error("[archiveSnapshot] scheduled refresh:", e.message),
      )
      .finally(done);
  }, REFRESH_MS);
  if (refreshTimer.unref) refreshTimer.unref();
}

function stop() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (bustTimer) clearTimeout(bustTimer);
  bustTimer = null;
  started = false;
}

// Test seam: drop all cached state.
function _reset() {
  snapshot = null;
  building = null;
  dbLoad = null;
  lastPersistAt = 0;
  stop();
}

module.exports = {
  REFRESH_MS,
  PERSIST_INTERVAL_MS,
  BUST_DEBOUNCE_MS,
  META_FULL_REFRESH_MS,
  MAX_SERVE_AGE_MS,
  buildItems,
  buildGames,
  buildOverview,
  build,
  refresh,
  getSnapshot,
  peek,
  invalidate,
  start,
  stop,
  _reset,
};
