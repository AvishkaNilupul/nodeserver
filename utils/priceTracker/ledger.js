// The sale ledger: ONE list of every sale we can prove, each tied to the exact
// listing, the exact items and (where the platform gives one) the exact order.
//
// Why this exists. Before it, "what did we sell this for?" was answered by four
// separate readers that each re-derived it a little differently and each had
// shipped a bug of its own: utils/pricingEvidence.js (double counted Gameflip
// sales, 284 prices for 147 sales; rent-farm windows set a $16 ceiling; Eldorado
// invisible), utils/systemHealth.js `realisedSales`, the catalog's own signal
// read, and routes/marketplaceConsoleRoutes.js (revenue = delivered units x the
// listing's CURRENT price). This module is the single definition they can all
// read from. It is pure — rows in, records out — so it is tested without a DB and
// can be fed a snapshot.
//
// EVIDENCE SOURCES, strongest first (each record says which it came from):
//   unit     a delivered unit with a real order id (Eldorado / PlayerAuctions /
//            G2G). Price is the listing's price NOW, because nothing stamps the
//            price at delivery — `priceBasis: "listing-now"`, an honest
//            approximation, never presented as the sale price.
//   signal   a "listing_sold" SaleSignal written when the platform told us a
//            unit was bought (Gameflip poller, Plati/GGSel stock drops). The
//            price was recorded at the moment of sale — `priceBasis: "reported"`.
//   row      a MarketplaceListing marked "sold" that neither of the above
//            already explains. `priceBasis: "row"`.
//   hand     the operator's manual mark-sold. Usually no marketplace and no
//            price; it proves demand for a GAME, never a price for a listing.
//
// DEDUPE RULES (each one is a bug that already happened — see
// project_pricing_evidence_sources_1001):
//   * every writer of a priced signal writes ONE PER GAME at the full price, so a
//     3-game bundle would count three times. Signals collapse to one record per
//     (listing, seq).
//   * a signal or a sold row for a listing whose sale is already counted from its
//     delivered units does not count again.
//   * rent-farm windows, bulk packs and anything classified "farm" are a
//     DIFFERENT PRODUCT and are excluded (counted in `excluded`, never silently).
//   * MASS-CLOSE signals are not sales. The Listings delist route records a
//     "listing_sold" signal for stock it closes out, so wiping a market writes
//     one signal per remaining unit. Measured 2026-10-01: 182 of GGSel's 204
//     priced "sales" were written in one 34-minute window on 2026-09-28 (60
//     offers, ~3 units each, every listing delisted within seconds of its
//     signals) and 35 of Digiseller's 63 in one 3-minute window on 2026-08-16.
//     A signal is a mass-close when its listing was DELISTED within 90s of it AND
//     at least 8 such signals share that market and hour. Both conditions: a
//     single sale on a listing that is delisted soon after must still count.
//     They are returned in `suspect`, never silently dropped, and they never
//     enter a price.
//
// DEMAND IS WIDER THAN PRICE (independent review, 2026-10-02). `demandOnly` holds
// sales that prove a buyer took an account but must never set a price. The farm
// brain reads `sales` + `demandOnly` through games.soldUnion, so each rule below
// changes what it sees as demand — on purpose:
//   * a Shop or bulk-order purchase ("reserved:" signal with no price, or market
//     "bulk") is a paying buyer, not a missing price (42 such signals in 135 days
//     were dropped before) — but only while its reservation still holds: a refund,
//     a failed payment or a cancelled order releases it and leaves the signal;
//   * a burst that has the shape of ONE real guardian pass is demand, though never
//     price evidence; a burst bigger than a real pass (counting the delist rule's
//     mass-close records of the same minutes), or one that emptied a listing which
//     was later closed, is a closeout or a wipe;
//   * a Gameflip bulk pack of N is N sales: its sold row is not one more;
//   * units one GGSel / Digiseller detection wrote are one ORDER of price evidence.
const { identify, normGame } = require("./setIdentity");

// Marketplaces whose sales exist only as delivered units on the listing row.
const UNIT_LEDGER_MARKETS = ["eldorado", "playerauctions", "g2g"];

function ts(d) {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

function idStr(x) {
  return x == null ? "" : String(x).toLowerCase();
}

// `login` on a signal is NOT one account: for a quantity listing it is the whole
// delivery pool attached to the listing ("a, b, c"), copied onto every unit sold
// from it (utils/saleLearning.js). Only a single login identifies an account.
function loginList(v) {
  return String(v || "")
    .split(/[\s,;]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ONE DETECTION IS ONE ORDER. GGSel and Digiseller never say who bought: the guardian
// sees a stock pile shrink and records every unit it inferred in one
// saleLearning.recordListingSale call, which stamps all of them with the same `at`
// (the Listings delist route does the same for the units it finds sold). Three units
// from one detection are three accounts sold — demand counts each, by its own key —
// but ONE observation of a price, like several units of one Eldorado order. Measured
// 2026-10-02: one 3-unit detection read as three sales and lifted a GGSel suggestion
// to "medium" on its own.
function detectionGroup(listingId, at, fallback) {
  const t = ts(at);
  return t == null ? fallback : "det:" + listingId + ":" + t;
}

// The guardian's own line between a real pass and a closeout
// (utils/marketplaceGuardian.js MASS_DROP_DEFAULTS: a pass that infers sales on 5 or
// more listings, or 12 or more units, of one marketplace is not recorded). So up to 11
// units on 4 or fewer listings is the shape of one REAL pass, and a burst of that shape
// is demand. The ledger is pure and mirrors the defaults; settings can raise the
// guardian's thresholds (autoFarm.saleOutageGuard), never the ledger's.
const REAL_PASS_MAX_LISTINGS = 4;
const REAL_PASS_MAX_UNITS = 11;
// A listing in one of these states was taken down for good.
const CLOSED_STATUSES = new Set(["delisted", "removed"]);

// reserved:<accountId>:<setId>:<game> — dropReservation.reserveSetOnAccount's key.
const RESERVED_RE = /^reserved:([0-9a-f]{24}):([^:]*):/i;

/**
 * @param {object} input
 * @param {Array}  input.listings MarketplaceListing rows (lean, projected)
 * @param {Array}  input.signals  SaleSignal rows with source "listing_sold"
 * @param {Array}  input.sets     DropSet rows referenced by the listings
 * @param {Set}    [input.reservations] "<accountId>|<setId>" of every Shop / bulk-order
 *                 reservation that still holds (the loader's DropLog read). Absent or
 *                 null = not known: no Shop / bulk-order signal counts.
 * @param {Map}    [input.accountLogins] accountId -> Twitch login, for those signals
 * @param {string} [input.reservationNote] why the reservations could not be read
 * @returns {{ sales: object[], excluded: object, quality: object }}
 */
function buildLedger({ listings = [], signals = [], sets = [], reservations = null, accountLogins = null, reservationNote = "" } = {}) {
  const held = reservations && typeof reservations.has === "function" ? reservations : null;
  const loginOf = (acct) => (accountLogins && typeof accountLogins.get === "function" && accountLogins.get(acct)) || "";
  const setById = new Map(sets.map((s) => [idStr(s._id), s]));
  const listingById = new Map(listings.map((l) => [idStr(l._id), l]));
  const identCache = new Map();
  const identOf = (l) => {
    const k = idStr(l._id);
    if (!identCache.has(k)) identCache.set(k, identify(l, l.set ? setById.get(idStr(l.set)) : null));
    return identCache.get(k);
  };

  const sales = [];
  // Bulk-pack deliveries are never PRICE evidence (a pack is priced for N accounts at
  // a discount) but each unit is still an account the shelf lost, so they count as
  // DEMAND. Kept apart from `sales` so nothing that prices can ever read them.
  const demandOnly = [];
  // Every count is a reason a record is NOT price evidence. `bulk` covers bulk packs
  // and bulk orders, `unpricedSignal` every sale signal that carried no price (in
  // `sales`, or a Shop sale in `demandOnly`), `burst` a burst kept as demand because
  // it has the shape of one real guardian pass, `massClose` everything in `suspect`.
  // Two more are not sales at all: `reservationReleased`, a Shop / bulk-order signal
  // whose reservation was given back (refund, failed payment, cancelled order), and
  // `reservationUnchecked`, one whose reservation could not be looked up.
  const excluded = {
    farm: 0, bulk: 0, noListing: 0, unpricedSignal: 0, duplicate: 0, massClose: 0, burst: 0,
    reservationReleased: 0, reservationUnchecked: 0,
  };
  const suspect = [];

  // Pre-pass: which sold:<listing> signals look like a delist closing out stock?
  const nearDelist = new Map(); // dedupeKey -> hourBucket "market|ISOhour"
  const hourCount = new Map();
  for (const s of signals) {
    const m = /^sold:([0-9a-f]{24}):.*:(\d+)$/i.exec(String(s.dedupeKey || ""));
    if (!m) continue;
    const l = listingById.get(m[1].toLowerCase());
    if (!l || l.status !== "delisted") continue;
    const at = ts(s.at);
    const up = ts(l.updatedAt);
    if (at == null || up == null || Math.abs(up - at) > 90 * 1000) continue;
    const bucket = String(s.marketplace || l.marketplace || "").toLowerCase() + "|" + new Date(at).toISOString().slice(0, 13);
    nearDelist.set(String(s.dedupeKey), bucket);
    hourCount.set(bucket, (hourCount.get(bucket) || 0) + 1);
  }
  const countedByUnits = new Set(); // listing ids whose sales are their units

  const base = (l, ident) => ({
    market: String(l.marketplace || "").toLowerCase(),
    listingId: idStr(l._id),
    externalId: String(l.externalId || ""),
    origin: l.origin || "manual",
    title: String(l.title || ""),
    listedPrice: Number(l.price) || 0,
    listedAt: l.createdAt || null,
    game: ident.game,
    gameKey: ident.gameKey,
    contentKey: ident.contentKey,
    bandKey: ident.bandKey,
    itemCount: ident.countForBand,
    exact: ident.exact,
    titleMismatch: ident.titleMismatch,
    identBasis: ident.basis,
  });

  // 1. delivered units ------------------------------------------------------
  for (const l of listings) {
    if (!UNIT_LEDGER_MARKETS.includes(String(l.marketplace || "").toLowerCase())) continue;
    const delivered = (l.units || []).filter((u) => u && u.orderId && u.deliveredAt);
    if (!delivered.length) continue;
    countedByUnits.add(idStr(l._id));
    const ident = identOf(l);
    if (ident.kind !== "drops") {
      excluded[ident.kind === "bulk" ? "bulk" : "farm"] += delivered.length;
      if (ident.kind === "bulk") {
        delivered.forEach((u, i) =>
          demandOnly.push({
            ...base(l, ident),
            key: "bulkunit:" + idStr(l._id) + ":" + String(u.orderId) + ":" + i,
            saleGroup: "bulkunit:" + idStr(l._id) + ":" + String(u.orderId) + ":" + i,
            login: loginList(u.login).length === 1 ? loginList(u.login)[0] : "",
            logins: loginList(u.login),
            account: "",
            source: "bulk",
            confidence: "exact",
            orderId: String(u.orderId),
            at: new Date(u.deliveredAt),
            priceUsd: 0,
            priceBasis: "none",
            priced: false,
          }),
        );
      }
      continue;
    }
    const price = Number(l.price) || 0;
    let unitIdx = 0;
    for (const u of delivered) {
      sales.push({
        ...base(l, ident),
        // One buyer order can deliver several units (Eldorado: 270 units across
        // 168 orders, one order carried 10). Each unit is its own record (it is
        // its own account and its own revenue), so the key carries the unit
        // index; `saleGroup` names the ORDER, which is what counts as one piece
        // of price evidence.
        login: loginList(u.login).length === 1 ? loginList(u.login)[0] : "",
        key: "unit:" + idStr(l._id) + ":" + String(u.orderId) + ":" + unitIdx++,
        saleGroup: String(l.marketplace || "").toLowerCase() + ":order:" + String(u.orderId),
        source: "unit",
        confidence: "exact",
        orderId: String(u.orderId),
        at: new Date(u.deliveredAt),
        priceUsd: price,
        priceBasis: "listing-now",
        priced: price > 0,
      });
    }
  }

  // 2. sale signals ---------------------------------------------------------
  // dedupeKey shapes: sold:<listingId>:<gameKey>:<seq>, reserved:<accountId>:
  // <setId>:<game>, manual-sold:<accountId>:<game>.
  const seen = new Set();
  const ordered = [...signals].sort((a, b) => (ts(a.at) || 0) - (ts(b.at) || 0));
  for (const s of ordered) {
    const dk = String(s.dedupeKey || "");
    const unit = /^sold:([0-9a-f]{24}):.*:(\d+)$/i.exec(dk);
    const hand = /^manual-sold:([0-9a-f]{24}):/i.exec(dk);
    const shop = /^reserved:([0-9a-f]{24}):/i.exec(dk);
    const price = Number(s.priceUsd) || 0;

    if (unit) {
      const lid = unit[1].toLowerCase();
      const key = "sig:" + lid + ":" + unit[2];
      if (seen.has(key)) {
        excluded.duplicate += 1; // the same sale, written once per game
        continue;
      }
      seen.add(key);
      if (countedByUnits.has(lid)) {
        excluded.duplicate += 1;
        continue;
      }
      const l = listingById.get(lid);
      if (!l) {
        excluded.noListing += 1;
        continue;
      }
      const nb = nearDelist.get(dk);
      if (nb && hourCount.get(nb) >= 8) {
        excluded.massClose += 1;
        suspect.push({ key, market: nb.split("|")[0], at: new Date(s.at), priceUsd: price, listingId: lid, seq: Number(unit[2]), reason: "mass-close" });
        continue;
      }
      const ident = identOf(l);
      if (s.bulk || ident.kind === "bulk") {
        excluded.bulk += 1;
        demandOnly.push({
          ...base(l, ident),
          key,
          saleGroup: key,
          login: loginList(s.login).length === 1 ? loginList(s.login)[0] : "",
          logins: loginList(s.login),
          account: idStr(s.account),
          dedupeKey: dk,
          source: "bulk",
          confidence: "exact",
          orderId: "",
          seq: Number(unit[2]),
          at: new Date(s.at),
          priceUsd: 0,
          priceBasis: "none",
          priced: false,
        });
        continue;
      }
      if (ident.kind === "farm") {
        excluded.farm += 1;
        continue;
      }
      if (price <= 0) excluded.unpricedSignal += 1;
      sales.push({
        ...base(l, ident),
        // The signal's market wins if the row ever disagrees: it is what the
        // platform reported at the time.
        market: String(s.marketplace || l.marketplace || "").toLowerCase(),
        key,
        // Units of one listing written at one instant are one detection: one order.
        saleGroup: detectionGroup(lid, s.at, key),
        login: loginList(s.login).length === 1 ? loginList(s.login)[0] : "",
        logins: loginList(s.login),
        account: idStr(s.account),
        dedupeKey: dk,
        source: "signal",
        confidence: "exact",
        orderId: "",
        seq: Number(unit[2]),
        at: new Date(s.at),
        priceUsd: price,
        priceBasis: "reported",
        priced: price > 0,
      });
      continue;
    }

    if (hand || (shop && price > 0 && s.marketplace !== "bulk" && !s.bulk)) {
      // The GAME is part of the key: one account sold in two games is two sales
      // of two things (the 39 "duplicates" first measured were all this).
      const key = (hand ? "hand:" : "shop:") + (hand || shop)[1].toLowerCase() + ":" + normGame(s.game || s.gameKey);
      if (seen.has(key)) {
        excluded.duplicate += 1;
        continue;
      }
      seen.add(key);
      // Same normalisation as set identity, so one game is one key everywhere
      // (SaleSignal.gameKey is only lower-cased: "pubg: battlegrounds").
      const gk = normGame(s.game || s.gameKey);
      sales.push({
        key,
        saleGroup: key,
        login: loginList(s.login).length === 1 ? loginList(s.login)[0] : "",
        logins: loginList(s.login),
        account: idStr(s.account),
        dedupeKey: dk,
        source: hand ? "hand" : "shop",
        confidence: "hand",
        market: String(s.marketplace || "").toLowerCase() || "unknown",
        listingId: "",
        externalId: "",
        origin: "manual",
        title: String(s.name || ""),
        listedPrice: 0,
        listedAt: null,
        game: String(s.game || ""),
        gameKey: gk,
        contentKey: null,
        bandKey: gk + "|?",
        itemCount: null,
        exact: false,
        titleMismatch: false,
        identBasis: "none",
        orderId: "",
        at: new Date(s.at),
        priceUsd: price,
        priceBasis: price > 0 ? "reported" : "none",
        priced: price > 0,
      });
      continue;
    }

    // SHOP AND BULK-ORDER SALES ARE BUYERS. reserveSetOnAccount writes a "reserved:"
    // listing_sold signal only for a paying buyer (utils/dropReservation.js opts.realSale:
    // the Shop's buy route, marketplace "shop", and bulk orders, marketplace "bulk" —
    // routes/shopRoutes.js, utils/bulkOrderHealth.js). Neither passes a price, and rows
    // promoted from "drop_reserved" on 2026-08-14 (scripts/migrate-sale-signal-sources.js)
    // carry no marketplace at all. They used to fall through every branch above and
    // vanish: 42 such signals in 135 days, last 2026-08-15. They are demand, never a
    // price (a bulk order is priced per order, at a discount). Keyed like the priced Shop
    // sale above, so one account sold in one game is one sale whichever form it took.
    if (shop) {
      const mk = String(s.marketplace || "").toLowerCase();
      const bulkOrder = mk === "bulk" || !!s.bulk;
      // A shape no writer produces (a priced or unpriced reserved signal of some other
      // market) stays out, as before: unknown evidence must not grow farming. So does a
      // "drop_reserved" row if one is ever fed in: that is stock claimed for a shelf
      // (project_phantom_demand_fix), never a buyer.
      if (s.source && s.source !== "listing_sold") continue;
      if (!bulkOrder && !(price <= 0 && (mk === "shop" || mk === ""))) continue;
      // A SALE ONLY WHILE ITS RESERVATION HOLDS. The signal is written the moment the
      // drops are reserved — before the Shop debits the buyer, before the bulk order is
      // saved — and nothing removes it when that is rolled back: a failed debit, a failed
      // Purchase write, a refund, a cancelled or deleted bulk order each release the
      // drops (dropReservation release*: soldAt null, soldSetId "") and leave the signal.
      // So it counts only while a DropLog row of that account still holds that set. A
      // released one must not take the account+game key either (the next real sale of
      // it would read as a duplicate), so this comes before the duplicate check.
      const acct = shop[1].toLowerCase();
      const setId = (RESERVED_RE.exec(dk) || [])[2] || "";
      if (!held || !setId) {
        excluded.reservationUnchecked += 1;
        continue;
      }
      if (!held.has(acct + "|" + setId)) {
        excluded.reservationReleased += 1;
        continue;
      }
      const gk = normGame(s.game || s.gameKey);
      const key = "shop:" + acct + ":" + gk;
      if (seen.has(key)) {
        excluded.duplicate += 1;
        continue;
      }
      seen.add(key);
      excluded[bulkOrder ? "bulk" : "unpricedSignal"] += 1;
      // The signal carries no login (reserveSetOnAccount writes ""), only the account
      // record. A re-minted token is a second record of the same login, and the buyer's
      // redeem may be seen on either: without the login, soldUnion counted that buyer's
      // connection as a second sale. The loader names the account (accountLogins).
      const login = loginList(s.login).length === 1 ? loginList(s.login)[0] : String(loginOf(acct)).trim().toLowerCase();
      demandOnly.push({
        key,
        saleGroup: key,
        login,
        logins: login ? [login] : loginList(s.login),
        account: idStr(s.account),
        dedupeKey: dk,
        source: bulkOrder ? "bulk-order" : "shop",
        confidence: "hand",
        market: mk || "unknown",
        listingId: "",
        externalId: "",
        origin: "manual",
        title: String(s.name || ""),
        listedPrice: 0,
        listedAt: null,
        game: String(s.game || ""),
        gameKey: gk,
        contentKey: null,
        bandKey: gk + "|?",
        itemCount: null,
        exact: false,
        titleMismatch: false,
        identBasis: "none",
        orderId: "",
        at: new Date(s.at),
        priceUsd: 0,
        priceBasis: "none",
        priced: false,
      });
    }
  }

  // 3. rows marked sold that nothing above explains -------------------------
  // A listing whose sale its SIGNALS already tell — priced ones in `sales`, or the
  // bulk-pack units in `demandOnly` — is not told again by its sold row. Reading only
  // `sales` here made a Gameflip pack of N count N + 1: its N bulk signals went to
  // demandOnly and the row, flipped to "sold" by the poller, added one more.
  const fromSignal = (x) => !!x.listingId && String(x.key || "").startsWith("sig:");
  const signalListings = new Set(
    sales
      .filter((x) => x.source === "signal")
      .concat(demandOnly.filter(fromSignal))
      .map((x) => x.listingId),
  );
  for (const l of listings) {
    if (l.status !== "sold") continue;
    const id = idStr(l._id);
    if (countedByUnits.has(id) || signalListings.has(id)) continue;
    const ident = identOf(l);
    if (ident.kind !== "drops") {
      excluded[ident.kind === "bulk" ? "bulk" : "farm"] += 1;
      if (ident.kind === "bulk") {
        demandOnly.push({
          ...base(l, ident),
          key: "bulkrow:" + id,
          saleGroup: "bulkrow:" + id,
          login: "",
          logins: [],
          account: "",
          source: "bulk",
          confidence: "exact",
          orderId: "",
          at: new Date(l.updatedAt || l.createdAt || 0),
          priceUsd: 0,
          priceBasis: "none",
          priced: false,
        });
      }
      continue;
    }
    const price = Number(l.price) || 0;
    sales.push({
      ...base(l, ident),
      key: "row:" + id,
      saleGroup: "row:" + id,
      source: "row",
      confidence: "exact",
      orderId: "",
      at: new Date(l.updatedAt || l.createdAt || 0),
      priceUsd: price,
      priceBasis: "row",
      priced: price > 0,
    });
  }

  sales.sort((a, b) => a.at - b.at);

  // BURSTS on timestamps alone. The delist rule above needs the listing's
  // updatedAt to sit within 90s of the signal, and any later write to the row
  // defeats it: 35 Digiseller signals written in 3 minutes on 2026-08-16 slipped
  // through because every listing was touched again afterwards, and 25 Gameflip
  // signals written ~1 second apart on 2026-09-08 were a bulk mark-sold, not 25
  // purchases. Organic sales do not arrive 8 in 5 minutes on any market this shop
  // sells on, and a burst proves the DETECTION happened at once, not the sales —
  // so for PRICE evidence it is set aside. (Delivered units carry real order ids
  // and are exempt.)
  //
  // For DEMAND a burst is only a closeout when it is bigger than one real guardian
  // pass (REAL_PASS_MAX_*). A pass flushes every sale it inferred within seconds, so a
  // real pass that found 8-11 units on a few listings is a burst by the rule above —
  // and was dropped from demand with the closeouts until 2026-10-03. Flagged records
  // are grouped into bursts (per market, split where two are more than BURST_MS apart:
  // guardian passes are at least 5 minutes apart). A burst of real-pass shape moves to
  // `demandOnly` (still never a price, not in `suspect`); a bigger one is set aside
  // from both, as before.
  //
  // Two things make a small burst a closeout all the same (review of 2026-10-03):
  //   * it is measured WITH the mass-close records the delist rule set aside for the
  //     same market within BURST_MS of it: the listings that slipped the 90-second rule
  //     (their rows were written again later) are the remnant of a big closeout, not a
  //     pass of their own;
  //   * a WIPE: a listing lost its whole stock at once (every unit the guardian kept on
  //     it, `qtyTarget`) and is closed now (delisted / removed). Buyers emptying a
  //     listing leave it on sale and it is refilled; a cleanup empties it and it is taken
  //     down. On the 2026-10-01 snapshot the one burst kept as demand otherwise was
  //     Digiseller Black Desert, 2026-08-14 11:29: 10 units on 3 listings, two of them
  //     emptied (7 of 7, 2 of 2), all delisted later.
  // Either way the burst is set aside, as before. A pass that leaves stock on its
  // listings stays demand. (`qtyTarget` is read as it is now: a target lowered since
  // reads as a wipe — the direction that never invents a sale.)
  {
    const BURST_N = 8;
    const BURST_MS = 5 * 60 * 1000;
    const byMarket = new Map();
    for (const x of sales) {
      if (x.source !== "signal" && x.source !== "row") continue;
      if (!byMarket.has(x.market)) byMarket.set(x.market, []);
      byMarket.get(x.market).push(x);
    }
    const flagged = new Set();
    for (const arr of byMarket.values()) {
      arr.sort((a, b) => a.at - b.at);
      let j = 0;
      for (let i = 0; i < arr.length; i += 1) {
        while (arr[i].at - arr[j].at > BURST_MS) j += 1;
        if (i - j + 1 >= BURST_N) for (let k = j; k <= i; k += 1) flagged.add(arr[k]);
      }
    }
    if (flagged.size) {
      const realPass = new Set();
      const massClose = suspect.filter((x) => x.reason === "mass-close");
      // Units per listing of a burst's shape; a listing it emptied that is closed now = a wipe.
      const wiped = (perListing) =>
        [...perListing].some(([id, n]) => {
          const l = listingById.get(id);
          const kept = l ? Number(l.qtyTarget) || 0 : 0;
          return kept > 0 && n >= kept && CLOSED_STATUSES.has(String(l.status || ""));
        });
      for (const [market, arr] of byMarket) {
        let burst = [];
        const close = () => {
          if (!burst.length) return;
          const from = burst[0].at.getTime() - BURST_MS;
          const to = burst[burst.length - 1].at.getTime() + BURST_MS;
          const shape = burst.concat(massClose.filter((x) => x.market === market && x.at.getTime() >= from && x.at.getTime() <= to));
          const perListing = new Map();
          for (const x of shape) perListing.set(x.listingId, (perListing.get(x.listingId) || 0) + 1);
          if (perListing.size <= REAL_PASS_MAX_LISTINGS && shape.length <= REAL_PASS_MAX_UNITS && !wiped(perListing)) {
            for (const x of burst) realPass.add(x);
          }
          burst = [];
        };
        for (const x of arr) {
          if (!flagged.has(x)) continue;
          if (burst.length && x.at - burst[burst.length - 1].at > BURST_MS) close();
          burst.push(x);
        }
        close();
      }
      for (const x of flagged) {
        if (realPass.has(x)) {
          excluded.burst += 1;
          demandOnly.push({ ...x, priceUsd: 0, priceBasis: "none", priced: false, burst: true });
          continue;
        }
        suspect.push({ key: x.key, market: x.market, at: x.at, priceUsd: x.priceUsd, listingId: x.listingId, seq: x.seq, reason: "burst" });
        excluded.massClose += 1;
      }
      for (let i = sales.length - 1; i >= 0; i -= 1) if (flagged.has(sales[i])) sales.splice(i, 1);
    }
  }

  // Data-quality counters, shown on the page so a gap is visible, not silent.
  const unitsSoldByListing = new Map();
  for (const l of listings) {
    if (Number(l.unitsSold) > 0) unitsSoldByListing.set(idStr(l._id), Number(l.unitsSold));
  }
  const signalCount = new Map();
  for (const x of sales) if (x.source === "signal") signalCount.set(x.listingId, (signalCount.get(x.listingId) || 0) + 1);
  // Mass-close signals are set aside, but the listing's unitsSold counter still
  // includes them — they are accounted for, not "unattributed".
  for (const x of suspect) signalCount.set(x.listingId, (signalCount.get(x.listingId) || 0) + 1);
  // So are the units whose signal went to demandOnly (a bulk pack's N units, a
  // real-pass burst): a pack of N is not also "N units with no record".
  for (const x of demandOnly) if (fromSignal(x)) signalCount.set(x.listingId, (signalCount.get(x.listingId) || 0) + 1);
  let unattributedUnits = 0;
  for (const [id, n] of unitsSoldByListing) {
    const have = signalCount.get(id) || 0;
    if (n > have) unattributedUnits += n - have;
  }
  const quality = {
    total: sales.length,
    priced: sales.filter((x) => x.priced).length,
    byConfidence: sales.reduce((m, x) => ((m[x.confidence] = (m[x.confidence] || 0) + 1), m), {}),
    bySource: sales.reduce((m, x) => ((m[x.source] = (m[x.source] || 0) + 1), m), {}),
    // Units a listing says it sold with no priced signal behind them: real sales
    // whose price we do not know.
    unattributedUnits,
    titleMismatch: sales.filter((x) => x.titleMismatch).length,
    // Distinct buyer orders among delivered units (a unit is one account; an
    // order may carry several).
    orders: new Set(sales.map((x) => x.saleGroup)).size,
    suspectMassClose: suspect.length,
  };

  // "<listingId>:<seq>" of every sale set aside. A suspect sale was written as one
  // signal PER GAME; anything replaying the engine's own count must drop all of
  // those rows, which share this pair in their dedupeKey.
  const suspectSaleKeys = new Set(
    suspect.filter((x) => x.listingId && Number.isFinite(x.seq)).map((x) => x.listingId + ":" + x.seq),
  );

  // `bulkDemandOnly` keeps its meaning (bulk-pack units); the other demand-only
  // records (Shop and bulk-order sales, real-pass bursts) are in the total and by source.
  quality.bulkDemandOnly = demandOnly.filter((x) => x.source === "bulk").length;
  quality.demandOnly = demandOnly.length;
  quality.demandOnlyBySource = demandOnly.reduce((m, x) => ((m[x.source] = (m[x.source] || 0) + 1), m), {});
  // Whether Shop / bulk-order sales could be checked against their reservations.
  quality.reservationCheck = held ? "ok" : "unavailable";
  quality.reservationNote = held ? "" : String(reservationNote || "");
  return { sales, demandOnly, excluded, quality, suspect, suspectSaleKeys };
}

module.exports = { UNIT_LEDGER_MARKETS, REAL_PASS_MAX_LISTINGS, REAL_PASS_MAX_UNITS, buildLedger, round2 };
