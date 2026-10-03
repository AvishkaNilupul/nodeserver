// Per-game demand and stock, measured from what actually happened.
//
// WHY THIS EXISTS
//
// Two farming systems needed the same facts and neither could get them.
//
// The auto-farmer reads `internalSalesForGame` (SaleSignal, 45 days, sources
// "connected" + "listing_sold") and nothing else — no stock level, no
// sell-through, no time-to-sale. The no-claim / unclaimed farm read NOTHING: it
// had no demand input of any kind, because the operator typed the account count
// into a form.
//
// Worse, for the no-claim games the sale evidence is scattered across five
// places that do not agree, and an audit on 2026-09-08 found three of them
// silently unrecorded:
//
//   UnclaimedAccount  status "sold"     — every automated channel funnels here
//                                         through spendAccount, so this is the
//                                         most complete unit count we have
//   SaleSignal        "listing_sold"    — Gameflip + Digiseller/GGSel only.
//                                         Eldorado / PlayerAuctions / G2G
//                                         write no signal at all
//   SaleSignal        "connected"       — the drop scanner saw a buyer link the
//                                         account. Proves a sale but names no
//                                         price, and covers accounts sold long
//                                         before the ledger existed
//   NoclaimSpentAccount               — what the operator swept out of a bot as
//                                         sold/connected
//   AvailableAccount.manualSold       — the hand-sold tick
//
// Measured on prod: 176 distinct Overwatch logins connected in 30 days, of which
// only 58 have a ledger row. Sizing off the ledger alone would have read
// Overwatch as a 9-sales-a-month game when it is a ~35-a-week game. So this
// module unions every source and DEDUPES BY LOGIN — an account sells exactly
// once, whoever noticed.
//
// Everything here is READ-ONLY. It writes nothing, claims nothing and starts no
// loop; it is the evidence layer under utils/unclaimedAllocator.js and the
// sizing panels.

const AvailableAccount = require("../models/AvailableAccount");
const NoclaimSpentAccount = require("../models/NoclaimSpentAccount");
const SaleSignal = require("../models/SaleSignal");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const settings = require("./settings");
const sizing = require("./farmSizing");

const DAY_MS = 86400000;

// Sources that mean a buyer paid. Same two the auto-farmer trusts, and for the
// same reason: "drop_reserved" is stamped when stock is CLAIMED for a listing,
// which is shelf-filling, not selling. Counting it once closed a loop where
// farming was its own proof of demand (see utils/saleLearning.js).
const REAL_SALE_SOURCES = ["connected", "listing_sold"];

const lower = (s) => String(s || "").trim().toLowerCase();

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

// ---------------------------------------------------------------------------
// Game buckets
// ---------------------------------------------------------------------------

// A no-claim "game" is a keyword, not a label: `noClaimGames` holds "overwatch"
// and "rainbow six", which have to catch "Overwatch", "Overwatch 2" and "Tom
// Clancy's Rainbow Six Siege" alike. Every count in this module is bucketed by
// that keyword, so the three spellings of Overwatch sitting in the ledger right
// now (197 "Overwatch" rows + 50 "overwatch" rows) roll into one number instead
// of reading as two half-sized games.
//
// Matching is EXACTLY settings.isNoClaimGame's rule — substring of the
// normalised label — so a game can never be in a different bucket here than the
// one the farming engines put it in.
function noClaimKeys() {
  const list = settings.getAutoFarm().noClaimGames || [];
  return [...new Set(list.map((g) => settings.normGameName(g)).filter(Boolean))];
}

// Which no-claim bucket a raw game label belongs to, or "" for a label that is
// not a no-claim game at all. When two keywords both match (they should not, but
// the list is operator-editable) the LONGEST wins, so adding "call of duty
// warzone" beside "call of duty" would refine rather than collide.
function bucketFor(game, keys = noClaimKeys()) {
  const g = settings.normGameName(game);
  if (!g) return "";
  let best = "";
  for (const k of keys) {
    if (k && g.includes(k) && k.length > best.length) best = k;
  }
  return best;
}

// Human label for a bucket key, for UI. Title-cases the keyword because the
// keyword itself is the only name a bucket has ("rainbow six" -> "Rainbow Six").
function bucketLabel(key) {
  return String(key || "")
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ---------------------------------------------------------------------------
// Sold units — the union, deduped by login
// ---------------------------------------------------------------------------

// ONE SALE, ONE DATE. A source's timestamp is only a sale date when it marks the
// sale itself (ledger soldAt) or its first visible effect (a marketplace's
// listing_sold, the scanner's first `connected`). The other two witnesses only
// CONFIRM a sale: NoclaimSpentAccount.sweptAt is when a bot was cleaned, and a
// hand-sold pool row has no date at all (its updatedAt moves on any write). On
// 2026-09-28 the sold-account backfill swept 142 sales made days or weeks
// earlier and touched 136 hand-sold rows, and dating them by those writes read
// Overwatch as 94.5 sales a week instead of ~60–75. So every source is read
// over the window plus PRIOR_DAYS of history, an account is dated by its
// EARLIEST dating evidence, and it counts in the window only when that date is
// inside it. Confirming-only accounts are reported as `undated` and drive
// nothing — since 2026-09-28 every sale path (hand sales included) writes a
// ledger row, so only legacy hand sales land there.
const DATING_SOURCES = new Set(["ledger", "listing_sold", "connected"]);
const PRIOR_DAYS = 90;

// A `listing_sold` signal names the account the buyer got only when the listing
// sells ONE account. A GGSel/Digiseller quantity row hands out "whichever unit
// the platform picks", so saleLearning.recordListingSale falls back to the
// row's `accountLogin` — which the auto-lister writes as the row's whole
// delivery POOL, `units.map((u) => u.login).join(", ")`. Keyed by that string
// the sale never met its own ledger row: the expiry pass spends a victim out of
// the same pool under the victim's own login (spendAccount), so every no-claim
// quantity sale counted twice, and two units sold in one read three times —
// straight into shelfPerWeek, live again since GGSel re-opened on 2026-10-01.
// Every such sale already has that victim ledger row, so a pooled
// `listing_sold` is dropped (2026-10-03, LIVE-FIXES-1003 §A4) and only counted
// in `pooled`. The pool test is utils/priceTracker's (ledger.js loginList: more
// than one name, split on spaces, commas or semicolons).
function isLoginPool(login) {
  return String(login || "").split(/[\s,;]+/).filter(Boolean).length > 1;
}

// The union as a pure accumulator, so the dating rules are testable without a
// database: `add(game, login, source, extra)` one piece of evidence at a time,
// then `split(since)`. Accounts are keyed by lowercased login; anonymous
// quantity-listing units get a synthetic key, so a hundred unit sales never
// collapse into one. A `listing_sold` naming a login POOL is not a unit at all
// (isLoginPool). `split` returns
//   { units: Map(bucket -> Map(id -> unit)), undated: Map(bucket -> n),
//     pooled: Map(bucket -> n) }
// where `units` holds only the sales whose FIRST dated evidence is inside the
// window, each { sources:Set, priceUsd, market, at, firstAt } plus `pack: true`
// when any evidence says the account went out in a bulk pack (`extra.pack`):
// `market` is the market of the earliest dated evidence, `at` the latest
// evidence of any kind. `pooled` counts the dropped pool sales first seen inside
// the window — exactly the units the union counted twice before 2026-10-03.
function saleAccumulator(keys = noClaimKeys()) {
  const all = new Map(); // bucket -> Map(loginKey -> unit)
  const pools = new Map(); // bucket -> Map(pool string -> first sighting)

  const add = (game, login, source, extra = {}) => {
    const bucket = bucketFor(game, keys);
    if (!bucket) return;
    if (source === "listing_sold" && isLoginPool(login)) {
      // Dated the way a unit would have been, so `pooled` says how many units
      // the old union really added, not how many signal rows there were.
      const at = extra.at ? new Date(extra.at) : null;
      const first = extra.firstAt ? new Date(extra.firstAt) : at;
      const seen = pools.get(bucket) || pools.set(bucket, new Map()).get(bucket);
      const id = lower(login);
      if (first && (!seen.get(id) || first < seen.get(id))) seen.set(id, first);
      return;
    }
    const inner = all.get(bucket) || all.set(bucket, new Map()).get(bucket);
    const id = lower(login) || `anon:${source}:${extra.dedupe || inner.size}`;
    const cur =
      inner.get(id) ||
      { sources: new Set(), priceUsd: 0, market: "", at: null, firstAt: null, confirmedAt: null };
    cur.sources.add(source);
    // Set only when true, so every other unit keeps its exact old shape.
    if (extra.pack === true) cur.pack = true;
    // Keep the best price any source names — a connection flip proves the sale
    // but carries no price, so taking the max is how a sale keeps its money when
    // only one of its two witnesses saw it.
    if (extra.priceUsd > cur.priceUsd) cur.priceUsd = extra.priceUsd;
    const at = extra.at ? new Date(extra.at) : null;
    if (at && (!cur.at || at > cur.at)) cur.at = at;
    if (DATING_SOURCES.has(source)) {
      const first = extra.firstAt ? new Date(extra.firstAt) : at;
      if (first && (!cur.firstAt || first < cur.firstAt)) {
        cur.firstAt = first;
        if (extra.market) cur.market = extra.market;
      } else if (!cur.market && extra.market) {
        cur.market = extra.market;
      }
    } else if (at && (!cur.confirmedAt || at > cur.confirmedAt)) {
      cur.confirmedAt = at;
    }
    inner.set(id, cur);
  };

  const split = (since) => {
    const units = new Map();
    const undated = new Map();
    for (const [bucket, inner] of all) {
      const keep = new Map();
      let n = 0;
      for (const [id, unit] of inner) {
        if (unit.firstAt) {
          if (unit.firstAt >= since) keep.set(id, unit);
        } else if (unit.confirmedAt && unit.confirmedAt >= since) {
          n++;
        }
      }
      units.set(bucket, keep);
      undated.set(bucket, n);
    }
    const pooled = new Map();
    for (const [bucket, seen] of pools) {
      let n = 0;
      for (const first of seen.values()) if (first >= since) n++;
      pooled.set(bucket, n);
    }
    return { units, undated, pooled };
  };

  return { add, split };
}

// Every no-claim sale with evidence, read from the four sources over the window
// plus PRIOR_DAYS of history and dated by saleAccumulator's rules. Returns
//   { since, units: Map(bucket -> Map(id -> unit)), undated: Map(bucket -> n),
//     pooled: Map(bucket -> n) }
// plus `packError` (a message) when the bulk-pack lookup below failed.
async function saleEvidenceByBucket({ days = 30, priorDays = PRIOR_DAYS } = {}) {
  const keys = noClaimKeys();
  const since = new Date(Date.now() - Math.max(1, days) * DAY_MS);
  const lookSince = new Date(since.getTime() - Math.max(0, priorDays) * DAY_MS);
  const acc = saleAccumulator(keys);
  const add = acc.add;

  // 1. The unclaimed ledger — every automated channel, including the four
  //    (Eldorado, PlayerAuctions, G2G) that write no SaleSignal.
  const ledgers = await UnclaimedAccount.find(
    { status: "sold", soldAt: { $gte: lookSince } },
    {
      login: 1,
      game: 1,
      market: 1,
      soldAt: 1,
      set: 1,
      soldPriceUsd: 1,
      soldMarket: 1,
      manualListing: 1,
    },
  ).lean();
  // Rows sold since `soldPriceUsd` shipped carry the price they ACTUALLY sold
  // at. Older rows carry nothing, so their price is reconstructed from the set's
  // live listings — the CURRENT price, not the price at sale, which is good
  // enough to weight a sizing decision and not good enough to call revenue.
  // Only the rows that need it are looked up.
  const setIds = [
    ...new Set(
      ledgers
        .filter((l) => !(Number(l.soldPriceUsd) > 0))
        .map((l) => l.set)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const priceBySet = new Map();
  if (setIds.length) {
    const rows = await MarketplaceListing.find(
      { set: { $in: setIds }, origin: "unclaimed" },
      { set: 1, price: 1 },
    ).lean();
    for (const r of rows) {
      const k = String(r.set);
      const p = Number(r.price) || 0;
      if (p > (priceBySet.get(k) || 0)) priceBySet.set(k, p);
    }
  }
  // Which sales went out in a bulk pack (isBurstSale). A no-claim pack sells
  // through the ordinary claim-at-sale path (noclaimStock.claimForSet ->
  // commitLedger), so its ledger rows carry the market ("eldorado", "g2g")
  // exactly like a single sale; only the listing they were claimed for says
  // "pack" — `manualListing` names it and a pack row has `bulkOfferId`. One
  // indexed read over the few listings these ledgers name. It feeds nothing
  // but the burst guard, which is dark by default, so a failure must not take
  // the live snapshot down with it: caught, reported as `packError`, and
  // unclaimedDemandSnapshot refuses to size with the guard ON while it is set.
  const packListings = new Set();
  let packError = "";
  const listingIds = [
    ...new Set(
      ledgers.map((l) => String(l.manualListing || "")).filter((id) => OBJECT_ID_RE.test(id)),
    ),
  ];
  if (listingIds.length) {
    try {
      const packs = await MarketplaceListing.find(
        { _id: { $in: listingIds }, bulkOfferId: { $ne: null } },
        { _id: 1 },
      ).lean();
      for (const p of packs) packListings.add(String(p._id));
    } catch (e) {
      packError = (e && e.message) || String(e) || "unknown error";
    }
  }
  for (const l of ledgers) {
    const recorded = Math.max(0, Number(l.soldPriceUsd) || 0);
    add(l.game, l.login, "ledger", {
      priceUsd: recorded || priceBySet.get(String(l.set)) || 0,
      market: l.soldMarket || l.market || "",
      at: l.soldAt,
      dedupe: String(l._id),
      pack: packListings.has(String(l.manualListing || "")),
    });
  }

  // 2. SaleSignal — the marketplace pollers and the drop scanner.
  //
  //    PERFORMANCE, measured on prod 2026-09-08. The obvious version — fetch
  //    every real sale signal in the window and bucket them in JS — took 60
  //    seconds, because it dragged 14,096 documents across the wire (the Atlas
  //    bound here is BYTES RETURNED, not query time). A regex prefilter on
  //    gameKey only got it to 37s: an unanchored regex cannot seek the
  //    { gameKey: 1, at: -1 } index, it can only scan it.
  //
  //    So: resolve the EXACT gameKeys that belong to a no-claim bucket first
  //    (a cheap index-covered distinct over a handful of values), then let the
  //    database do the deduping in an aggregation. What comes back is one row
  //    per (game, login) — a few hundred — instead of fourteen thousand.
  //    `bucketFor` still decides which bucket a key lands in, so the answer is
  //    identical; only the volume changed.
  const allKeys = await SaleSignal.distinct("gameKey");
  const mineKeys = (allKeys || []).filter((k) => bucketFor(k, keys));
  if (mineKeys.length) {
    const grouped = await SaleSignal.aggregate([
      {
        $match: {
          gameKey: { $in: mineKeys },
          at: { $gte: lookSince },
          source: { $in: REAL_SALE_SOURCES },
        },
      },
      {
        $group: {
          // An account sells once. Anonymous quantity-listing units carry no
          // login, so they fall back to their dedupeKey — collapsing those onto
          // one row would read a hundred unit sales as a single sale.
          //
          // The test is `login > ""`, NOT $ifNull. SaleSignal.login is declared
          // `default: ""` (models/SaleSignal.js:27), so it is an empty STRING
          // and never null — $ifNull would pass it straight through and every
          // anonymous unit sale on every listing would group under "", reading
          // a whole quantity listing's sales as one.
          _id: {
            g: "$gameKey",
            who: {
              $cond: [
                { $gt: ["$login", ""] },
                "$login",
                { $concat: ["anon:", { $ifNull: ["$dedupeKey", "?"] }] },
              ],
            },
          },
          sources: { $addToSet: "$source" },
          markets: { $addToSet: "$marketplace" },
          // The best price any witness named: a connection flip proves the sale
          // but carries no price, so taking the max is how a sale keeps its
          // money when only one of its two witnesses saw it.
          priceUsd: { $max: { $ifNull: ["$priceUsd", 0] } },
          at: { $max: "$at" },
          // The first time anyone saw this sale — what dates it.
          first: { $min: "$at" },
        },
      },
    ]);
    // A row grouped under a delivery POOL ("a, b, c") is dropped by the
    // accumulator (isLoginPool); an anonymous key is passed as "" so the spaces
    // a gameKey puts into its dedupeKey never read as a pool.
    for (const row of grouped) {
      const login = String(row._id.who || "");
      for (const source of row.sources || []) {
        add(row._id.g, login.startsWith("anon:") ? "" : login, source, {
          priceUsd: Number(row.priceUsd) || 0,
          market: (row.markets || []).find(Boolean) || "",
          at: row.at,
          firstAt: row.first,
          dedupe: login,
        });
      }
    }
  }

  // 3. What the operator swept out of a no-claim bot as sold or connected. It
  //    CONFIRMS a sale (the only witness for an account hand-sold in bulk that
  //    the buyer has not linked yet) but sweptAt is when the bot was cleaned.
  const spent = await NoclaimSpentAccount.find(
    { sweptAt: { $gte: since }, $or: [{ sold: true }, { connected: true }] },
    { loginLower: 1, login: 1, game: 1, sweptAt: 1 },
  ).lean();
  for (const s of spent) {
    add(s.game, s.loginLower || s.login, "swept", { at: s.sweptAt });
  }

  // 4. The hand-sold tick on the pool row. `manualSold` carries no date; its
  //    updatedAt only says the row was written in the window, so it confirms.
  const manual = await AvailableAccount.find(
    { manualSold: true, updatedAt: { $gte: since } },
    { usernameLower: 1, username: 1, soldGames: 1, claimedNote: 1, updatedAt: 1 },
  ).lean();
  for (const m of manual) {
    // A hand-sold pool row names its game either in soldGames or in the
    // "noclaim-farm:<game>" claim note it still carries.
    const games = Array.isArray(m.soldGames) && m.soldGames.length
      ? m.soldGames
      : [String(m.claimedNote || "").replace(/^noclaim-farm:/i, "")];
    for (const g of games) {
      add(g, m.usernameLower || m.username, "manual_sold", { at: m.updatedAt });
    }
  }

  return { since, ...acc.split(since), ...(packError ? { packError } : {}) };
}

// The accounts sold in the window, per bucket — Map(bucket -> Map(id -> unit)).
// Kept as the original name and shape for callers that only want the units.
async function soldUnitsByBucket({ days = 30 } = {}) {
  return (await saleEvidenceByBucket({ days })).units;
}

// ---------------------------------------------------------------------------
// Stock on hand
// ---------------------------------------------------------------------------

// Sellable stock, split by where it is sitting:
//
//   listed   — on an auto-listing right now
//   held     — status "skipped": holds its drops, deliberately on no listing
//              (over the per-game cap, or freed for manual bulk sale)
//   inFlight — claimed out of the pool for this game but not yet sellable, i.e.
//              still farming. Counting it is what stops the allocator ordering
//              the whole gap again every cycle while the last batch is still
//              working.
//
// `expired`/`released` are NOT stock: their drops are gone.
async function stockByBucket() {
  const keys = noClaimKeys();
  const out = new Map();
  const bump = (bucket, field, n = 1) => {
    if (!bucket) return;
    const cur =
      out.get(bucket) ||
      out.set(bucket, { listed: 0, held: 0, inFlight: 0, sold: 0, expired: 0 }).get(bucket);
    cur[field] += n;
  };

  const rows = await UnclaimedAccount.aggregate([
    { $group: { _id: { g: "$game", s: "$status" }, n: { $sum: 1 } } },
  ]);
  for (const r of rows) {
    const bucket = bucketFor(r._id.g, keys);
    if (!bucket) continue;
    if (r._id.s === "listed") bump(bucket, "listed", r.n);
    else if (r._id.s === "skipped") bump(bucket, "held", r.n);
    else if (r._id.s === "sold") bump(bucket, "sold", r.n);
    else if (r._id.s === "expired" || r._id.s === "released") bump(bucket, "expired", r.n);
  }

  // In flight: pool rows this system claimed, minus the ones that already have a
  // ledger row (those are counted above under their real status).
  const claimed = await AvailableAccount.find(
    { status: "claimed", claimedNote: /^noclaim-farm:/i, manualSold: { $ne: true } },
    { usernameLower: 1, claimedNote: 1 },
  ).lean();
  if (claimed.length) {
    const logins = claimed.map((c) => c.usernameLower).filter(Boolean);
    const known = new Set(
      (
        await UnclaimedAccount.find({ loginLower: { $in: logins } }, { loginLower: 1 }).lean()
      ).map((l) => l.loginLower),
    );
    for (const c of claimed) {
      if (known.has(c.usernameLower)) continue;
      bump(bucketFor(String(c.claimedNote || "").replace(/^noclaim-farm:/i, ""), keys), "inFlight");
    }
  }

  return out;
}

// Median hours from listing to sale, per bucket. The median, not the mean: a
// single account that sat unsold for a fortnight before a relist drags a mean
// far enough to hide that Rainbow Six clears in under two days.
async function timeToSaleByBucket({ days = 90 } = {}) {
  const keys = noClaimKeys();
  const since = new Date(Date.now() - Math.max(1, days) * DAY_MS);
  const rows = await UnclaimedAccount.find(
    { status: "sold", soldAt: { $gte: since }, listedAt: { $ne: null } },
    { game: 1, listedAt: 1, soldAt: 1 },
  ).lean();
  const buckets = new Map();
  for (const r of rows) {
    const b = bucketFor(r.game, keys);
    if (!b) continue;
    const hrs = (new Date(r.soldAt) - new Date(r.listedAt)) / 3600000;
    if (!Number.isFinite(hrs) || hrs < 0) continue;
    (buckets.get(b) || buckets.set(b, []).get(b)).push(hrs);
  }
  const out = new Map();
  for (const [b, list] of buckets) {
    list.sort((a, c) => a - c);
    const mid = Math.floor(list.length / 2);
    out.set(b, {
      n: list.length,
      medianHours:
        list.length % 2 ? list[mid] : Math.round(((list[mid - 1] + list[mid]) / 2) * 10) / 10,
      minHours: list[0],
      maxHours: list[list.length - 1],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The snapshot the allocator and the UI both read
// ---------------------------------------------------------------------------

// Markets where the unclaimed auto-lister commits accounts up front (the
// shelf, capped by unclaimedGameCaps). Everything else — Eldorado,
// PlayerAuctions, G2G, hand sales — claims an account only when a buyer pays.
const SHELF_MARKETS = new Set(["gameflip", "ggsel", "digiseller"]);
// The short window the demand rate also looks at, so a rise shows within two
// weeks while a dip never shrinks the rate faster than the full window.
const SHORT_WINDOW_DAYS = 14;

// BURSTS. The in-stock correction reads a day with no sale as a stock-out, which
// is right for a trickle of buyers and wrong for a lump: a hand sale of 40
// accounts, or a bulk pack, lands on ONE day, and divided by the half-window
// floor it reads as 40 a week for 14 days — at 28 days' cover, +160 accounts
// for the feeder to claim (research H2: R6 152 -> 246 on one burst). These are
// the sales that arrive that way by construction:
//   "manual"  — a hand sale (unclaimedAutoList.handSellAccounts is the only
//               writer of soldMarket "manual")
//   pack      — a bulk pack (`unit.pack`, set by saleEvidenceByBucket from the
//               ledger's listing; a pack's market is the claim-at-sale market
//               of any single sale, so the market alone cannot say "pack")
const BURST_MARKETS = new Set(["manual"]);
function isBurstSale(u) {
  return !!u && (u.pack === true || BURST_MARKETS.has(lower(u.market)));
}

// The live switch, autoFarm.noclaimBurstGuard — off unless it is exactly true.
// Read only when a caller did not choose and there IS a burst to guard: every
// getAutoFarm() re-reads settings.json from disk, and the farm brain calls
// demandRates once per game per backtest week.
function burstGuardDefault() {
  return (settings.getAutoFarm() || {}).noclaimBurstGuard === true;
}

// Per-week demand from a game's in-window units, split by where it sold.
//   shelfPerWeek — RAW rate of shelf-market sales (a shelf is never out of stock)
//   otherPerWeek — IN-STOCK rate of every other sale (see sizing.inStockRate):
//                  a claim-at-sale offer with no matching accounts sells nothing,
//                  and those days are a stock-out, not missing buyers
// each the larger of the full-window and the 14-day rate. Pure; `now` pinnable.
//
// `burstGuard` (2026-10-03, LIVE-FIXES-1003 §A4; dark): when on, the other-market
// sales isBurstSale names are counted RAW over each window (n×7/W, the shelf
// rule); the rest keep the in-stock correction over the selling days of ALL
// other-market sales, a burst's day included. A one-day lump of N alone reads
// N/2 a week for 14 days instead of N.
//   The guard may only ever REMOVE inflation, never add any. Dropping the
//   burst-only days from the steady sales' denominator did add some (review,
//   2026-10-03): fewer selling days raise the steady rate, and the burst then
//   came on top — 48 Eldorado sales on 16 days plus 10 single hand sales on 10
//   other days read 15.6 -> 23.5 a week. Keeping every day, each window's
//   guarded figure is at most the unguarded one (W is never below the in-stock
//   denominator), and it is clamped to it as well, so float rounding cannot
//   tip it over either.
// true/false decides; omitted (null) follows the switch (burstGuardDefault),
// which is false today. Off — or on with no burst in the units — every figure is
// the old one to the byte. On with a burst, the result also carries
// `burstSales` (how many sales were counted raw).
function demandRates(
  units,
  { days = 30, shortDays = SHORT_WINDOW_DAYS, now = Date.now(), burstGuard = null } = {},
) {
  const shortW = Math.max(1, Math.min(shortDays, days));
  const shortSince = now - shortW * DAY_MS;
  const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
  let shelf = 0;
  let shelfShort = 0;
  let other = 0;
  let otherShort = 0;
  const otherDays = new Set();
  const otherDaysShort = new Set();
  // The same other-market sales split into bursts and the steady rest, in the
  // same single pass (`units` may be an iterator), for the guarded rate.
  let burst = 0;
  let burstShort = 0;
  let steady = 0;
  let steadyShort = 0;
  for (const u of units || []) {
    const t = u && u.firstAt ? new Date(u.firstAt).getTime() : NaN;
    if (!Number.isFinite(t)) continue;
    const recent = t >= shortSince;
    if (SHELF_MARKETS.has(lower(u.market))) {
      shelf++;
      if (recent) shelfShort++;
    } else {
      other++;
      otherDays.add(dayOf(t));
      if (recent) {
        otherShort++;
        otherDaysShort.add(dayOf(t));
      }
      if (isBurstSale(u)) {
        burst++;
        if (recent) burstShort++;
      } else {
        steady++;
        if (recent) steadyShort++;
      }
    }
  }
  const shelfPerWeek = Math.max(
    sizing.salesPerWeek(shelf, days),
    sizing.salesPerWeek(shelfShort, shortW),
  );
  // Production's figure for each window, and the max of the two.
  const plain = sizing.inStockRate({ count: other, sellingDays: otherDays.size, windowDays: days });
  const plainShort = sizing.inStockRate({
    count: otherShort,
    sellingDays: otherDaysShort.size,
    windowDays: shortW,
  });
  const guarded = burst > 0 && (burstGuard == null ? burstGuardDefault() : burstGuard === true);
  const otherPerWeek = guarded
    ? Math.max(
        Math.min(
          plain,
          sizing.inStockRate({ count: steady, sellingDays: otherDays.size, windowDays: days }) +
            sizing.salesPerWeek(burst, days),
        ),
        Math.min(
          plainShort,
          sizing.inStockRate({ count: steadyShort, sellingDays: otherDaysShort.size, windowDays: shortW }) +
            sizing.salesPerWeek(burstShort, shortW),
        ),
      )
    : Math.max(plain, plainShort);
  const out = {
    shelfPerWeek: round1(shelfPerWeek),
    otherPerWeek: round1(otherPerWeek),
    sellingDays: otherDays.size,
    shelfSales: shelf,
    otherSales: other,
  };
  if (guarded) out.burstSales = burst;
  return out;
}

const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

// One row per no-claim game: what it sells, what it holds, how long that lasts,
// and what the sizing model says it should hold. Deliberately returns the
// EVIDENCE alongside the number — an operator has to be able to see why a game
// is being told to grow before they let anything act on it.
//
// `burstGuard` goes to demandRates for every row (true/false; omitted = the
// autoFarm.noclaimBurstGuard switch, read once here). A row it changed carries
// `sales.burstSales`.
//
// `inputs` (opt-in, 2026-10-03, for the farm brain): the three reads below,
// already made by snapshotInputs({ days, ttsDays }) — so a caller that builds
// the snapshot under both guard settings reads the database ONCE and the two
// rows differ by the guard alone, never by a sale written between two reads.
// Omitted (every other caller), the snapshot reads as it always has.
async function unclaimedDemandSnapshot({ days = 30, ttsDays = 90, burstGuard = null, inputs = null } = {}) {
  const [evidence, stock, tts] = inputs
    ? [inputs.evidence, inputs.stock, inputs.tts]
    : await Promise.all([
        saleEvidenceByBucket({ days }),
        stockByBucket(),
        timeToSaleByBucket({ days: ttsDays }),
      ]);
  const guard = burstGuard == null ? burstGuardDefault() : burstGuard === true;
  // FAIL SAFE. With the guard on, a pack the lookup could not recognise would be
  // counted through the in-stock correction again — the inflation the guard is
  // there to remove — and the allocator would claim pool accounts on it. No
  // snapshot means no growth this pass (the allocator applies nothing when its
  // plan throws), which spends nothing. Guard off, the lookup is unused.
  if (guard && evidence.packError) {
    throw new Error(
      "no-claim demand withheld: the burst guard is on and the bulk-pack lookup failed (" +
        evidence.packError +
        ")",
    );
  }
  const sold = evidence.units;
  const cfg = settings.getNoclaimSizing ? settings.getNoclaimSizing() : {};
  const keys = noClaimKeys();
  const rows = [];

  for (const key of keys) {
    const units = sold.get(key) || new Map();
    const st = stock.get(key) || { listed: 0, held: 0, inFlight: 0, sold: 0, expired: 0 };
    const t = tts.get(key) || null;

    let revenue = 0;
    let priced = 0;
    const bySource = {};
    const byMarket = {};
    for (const u of units.values()) {
      if (u.priceUsd > 0) {
        revenue += u.priceUsd;
        priced++;
      }
      for (const s of u.sources) bySource[s] = (bySource[s] || 0) + 1;
      if (u.market) byMarket[u.market] = (byMarket[u.market] || 0) + 1;
    }
    const count = units.size;
    const avgPrice = priced ? Math.round((revenue / priced) * 100) / 100 : 0;
    const rates = demandRates(units.values(), { days, burstGuard: guard });
    const perWeek = round1(rates.shelfPerWeek + rates.otherPerWeek);

    const coverageDays = numOr(cfg.coverageDaysFor && cfg.coverageDaysFor(key), cfg.coverageDays);
    const safetyStock = numOr(cfg.safetyStockFor && cfg.safetyStockFor(key), cfg.safetyStock);
    const min = numOr(cfg.minFor && cfg.minFor(key), 0);
    const max = numOr(cfg.maxFor && cfg.maxFor(key), sizing.HARD_MAX_ACCOUNTS);

    // The shelf ties up what it holds whatever it sells; the rest of the
    // demand needs its own cover (sizing.shelfAwareTarget).
    const { target, parts } = sizing.shelfAwareTarget({
      shelfHeld: st.listed,
      shelfPerWeek: rates.shelfPerWeek,
      otherPerWeek: rates.otherPerWeek,
      coverageDays,
      safetyStock,
      min,
      max,
    });
    const onHand = st.listed + st.held;
    const gap = sizing.stockGap({ target, onHand, inFlight: st.inFlight });
    const cover = sizing.daysOfCover({ onHand, salesPerWeek: perWeek });

    rows.push({
      key,
      label: bucketLabel(key),
      windowDays: days,
      sales: {
        count,
        perWeek,
        rawPerWeek: round1(sizing.salesPerWeek(count, days)),
        shelfPerWeek: rates.shelfPerWeek,
        otherPerWeek: rates.otherPerWeek,
        sellingDays: rates.sellingDays,
        undated: evidence.undated.get(key) || 0,
        revenue: Math.round(revenue * 100) / 100,
        avgPrice,
        priced,
        bySource,
        byMarket,
        // Only when the guard changed this row, so a guard-off row is the old row.
        ...(rates.burstSales != null ? { burstSales: rates.burstSales } : {}),
      },
      stock: st,
      onHand,
      timeToSale: t,
      daysOfCover: Number.isFinite(cover) ? Math.round(cover * 10) / 10 : null,
      policy: { coverageDays, safetyStock, min, max },
      targetParts: parts,
      ...gap,
      weight: sizing.revenueWeight({ salesPerWeek: perWeek, avgPrice }),
    });
  }

  rows.sort((a, b) => b.sales.perWeek - a.sales.perWeek || b.need - a.need);
  return rows;
}

// The three reads one snapshot makes, for unclaimedDemandSnapshot's `inputs`:
// read once, build as many snapshots from them as needed. Read-only.
async function snapshotInputs({ days = 30, ttsDays = 90 } = {}) {
  const [evidence, stock, tts] = await Promise.all([
    saleEvidenceByBucket({ days }),
    stockByBucket(),
    timeToSaleByBucket({ days: ttsDays }),
  ]);
  return { evidence, stock, tts };
}

function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number(dflt) || 0;
}

// ---------------------------------------------------------------------------
// The auto-farm side: the same weekly rate, for any game
// ---------------------------------------------------------------------------

// Sales per week for ONE game, over `days`, deduped the way the auto-farmer
// dedupes: by account when there is one, by dedupeKey when there is not.
// Matched on the normalised label so "Overwatch 2" and "Overwatch" agree, which
// the auto-farmer's raw `gameKey` equality does not.
async function salesRateForGame(game, { days = sizing.DEFAULT_SALES_WINDOW_DAYS } = {}) {
  const want = settings.normGameName(game);
  if (!want) return { count: 0, perWeek: 0, avgPrice: 0, revenue: 0 };
  const since = new Date(Date.now() - Math.max(1, days) * DAY_MS);
  const rows = await SaleSignal.aggregate([
    { $match: { at: { $gte: since }, source: { $in: REAL_SALE_SOURCES } } },
    {
      $group: {
        _id: { g: "$gameKey", k: { $ifNull: ["$account", "$dedupeKey"] } },
        priceUsd: { $max: { $ifNull: ["$priceUsd", 0] } },
      },
    },
  ]);
  let count = 0;
  let revenue = 0;
  let priced = 0;
  for (const r of rows) {
    if (settings.normGameName(r._id.g) !== want) continue;
    count++;
    if (r.priceUsd > 0) {
      revenue += r.priceUsd;
      priced++;
    }
  }
  return {
    count,
    perWeek: Math.round(sizing.salesPerWeek(count, days) * 10) / 10,
    revenue: Math.round(revenue * 100) / 100,
    avgPrice: priced ? Math.round((revenue / priced) * 100) / 100 : 0,
  };
}

module.exports = {
  REAL_SALE_SOURCES,
  noClaimKeys,
  bucketFor,
  bucketLabel,
  DATING_SOURCES,
  SHELF_MARKETS,
  BURST_MARKETS,
  isLoginPool,
  isBurstSale,
  saleAccumulator,
  demandRates,
  saleEvidenceByBucket,
  soldUnitsByBucket,
  stockByBucket,
  timeToSaleByBucket,
  snapshotInputs,
  unclaimedDemandSnapshot,
  salesRateForGame,
};
