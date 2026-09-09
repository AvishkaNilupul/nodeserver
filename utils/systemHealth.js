// "Is everything working?" — answered with numbers, so nobody has to check by hand.
//
// WHY THIS EXISTS
// On 2026-09-08 the rental stack sat at 10/10 for nine hours. Two paid
// "Automatic Farming" orders landed in that window: one the owner shipped by
// hand, one the buyer cancelled after 25 failed attempts. Throughout, every dial
// said fine — the pool showed 554 eligible accounts and `previewFreshAccounts`
// answered `willAdd: 1`. Nothing was lying; nothing was measuring the thing that
// had actually run out either. So every check here returns the NUMBER it
// measured and the THRESHOLD it compared against. A bare green tick is what we
// already had, and it cost two orders.
//
// THREE RULES THIS FILE IS BUILT AROUND
//
// 1. READ-ONLY. Nothing here publishes, delists, reprices, provisions or writes
//    a setting. A health check that mutates is a health check nobody dares run
//    — and the one thing worse than not knowing is a "checker" that breaks a
//    live order while looking. Persisting the run record is the caller's job
//    (routes), deliberately not this module's.
//
// 2. A CHECK THAT CANNOT RUN IS `unknown`, NEVER `ok` AND NEVER `fail`. An
//    unreachable Pi is a read failure, not a broken marketplace. Reading a Pi
//    hiccup as a marketplace fault already produced one wrong diagnosis here,
//    so the distinction is enforced in every check rather than left to whoever
//    reads the page.
//
// 3. CHEAP. This runs hourly. DB and cached state answer almost everything;
//    live calls are made only where nothing else can (rent-farm slot occupancy,
//    Gameflip listing status), always sequentially. Atlas serialises concurrent
//    queries and is bytes-bound, and a parallel fan-out at the marketplaces is
//    what we are trying to detect, not add to.
//
// THE DEPENDENCY SEAM
// Every model, marketplace call and settings read a check needs comes from
// `ctx.dep(name)`, defaulting to the real module and resolved lazily on first
// use. That is what makes the whole engine testable with no DB and no network:
// a test passes `deps` and the real module is never even required. It is also
// the second half of rule 1 — a check can only touch what the seam hands it.
const ITEM_CAP = 20; // frozen by the contract: `items` is capped at 20 rows.

// Per-check wall clock. A hung marketplace call must not take the hourly run
// down with it; the loser of the race keeps running in the background but its
// result is discarded, which is safe because nothing here mutates.
const CHECK_TIMEOUT_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Dependency seam
// ---------------------------------------------------------------------------

// Factories, not values: a test that overrides `MarketplaceListing` must never
// pay for mongoose loading the real one. Nothing is required until a check that
// needs it actually runs.
const REAL_DEPS = {
  MarketplaceListing: () => require("../models/MarketplaceListing"),
  AvailableAccount: () => require("../models/AvailableAccount"),
  FarmServiceOrder: () => require("../models/FarmServiceOrder"),
  UnclaimedAccount: () => require("../models/UnclaimedAccount"),
  FleetSnapshot: () => require("../models/FleetSnapshot"),
  AutoFarmSnapshot: () => require("../models/AutoFarmSnapshot"),
  BotAccount: () => require("../models/BotAccount"),
  rentFarmCapacity: () => require("./rentFarmCapacity"),
  unclaimedCoverage: () => require("./unclaimedCoverage"),
  unclaimedListingAudit: () => require("./unclaimedListingAudit"),
  unclaimedAutoList: () => require("./unclaimedAutoList"),
  marketplaces: () => require("./marketplaces"),
  connectors: () => require("./systemHealthConnectors"),
  eldoradoFarmService: () => require("./eldoradoFarmService"),
  settings: () => require("./settings"),
  // routes/renterAdminRoutes requires half the app, so like utils/operatorFarm
  // this is pulled in only at call time — a module-level require here would be
  // a load-order cycle.
  gatherPoolEligibility: () =>
    require("../routes/renterAdminRoutes").gatherPoolEligibility,
};

function makeCtx({ deps = {}, now } = {}) {
  const cache = new Map();
  return {
    // `now` is injectable so a test can pin the clock: several checks compare
    // ages against budgets, and a real clock makes those assertions flaky.
    now: typeof now === "function" ? now : () => new Date(),
    dep(name) {
      if (Object.prototype.hasOwnProperty.call(deps, name)) return deps[name];
      if (!cache.has(name)) {
        const make = REAL_DEPS[name];
        if (!make) throw new Error("systemHealth: unknown dependency " + name);
        cache.set(name, make());
      }
      return cache.get(name);
    },
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no DB, no network, no clock of their own)
// ---------------------------------------------------------------------------

const STATUSES = ["ok", "warn", "fail", "unknown"];

// Worst-of ordering for a group card. `unknown` sits ABOVE ok and BELOW warn on
// purpose: "we could not measure this" deserves to darken a green card, but it
// must never outrank a real problem sitting next to it in the same group.
const STATUS_RANK = { ok: 0, unknown: 1, warn: 2, fail: 3 };

function normStatus(status) {
  return STATUSES.includes(status) ? status : "unknown";
}

// Accepts checks or bare status strings, so the page can colour a group with
// the same function the engine uses.
function worstStatus(list) {
  let worst = "ok";
  for (const entry of list || []) {
    const s = normStatus(
      typeof entry === "string" ? entry : entry && entry.status,
    );
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

// The frozen `counts` shape, and nothing else — the page and the stored run
// record both destructure it.
function rollup(checks) {
  const counts = { ok: 0, warn: 0, fail: 0, unknown: 0 };
  for (const entry of checks || []) {
    counts[
      normStatus(typeof entry === "string" ? entry : entry && entry.status)
    ] += 1;
  }
  return counts;
}

function capItems(rows, max = ITEM_CAP) {
  const arr = Array.isArray(rows) ? rows : [];
  return arr.slice(0, Math.max(0, max));
}

function ageMs(at, now) {
  const then = at instanceof Date ? at.getTime() : Date.parse(at);
  if (!Number.isFinite(then)) return null;
  const ref = now instanceof Date ? now.getTime() : Date.now();
  return ref - then;
}

// Ages are read on a phone at a glance, so seconds of precision past an hour is
// noise. `null` (nothing ever recorded) must read as "never", not as "0s" —
// that difference is the whole point of loops.alive.
function fmtAge(ms) {
  if (ms == null || !Number.isFinite(ms)) return "never";
  const clamped = Math.max(0, ms);
  const secs = Math.floor(clamped / 1000);
  if (secs < 60) return secs + "s";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "m";
  const hours = Math.floor(mins / 60);
  if (hours < 48) return hours + "h " + (mins % 60) + "m";
  return Math.floor(hours / 24) + "d " + (hours % 24) + "h";
}

function pct(n, total) {
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0) return 0;
  return Math.round(((Number(n) || 0) * 100) / t);
}

// More is worse (offending rows, percentages of dead stock).
function statusForHigh(value, { warnAt, failAt } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "unknown";
  if (failAt != null && n >= failAt) return "fail";
  if (warnAt != null && n >= warnAt) return "warn";
  return "ok";
}

// Less is worse (free slots, eligible accounts).
function statusForLow(value, { warnBelow, failBelow } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "unknown";
  if (failBelow != null && n < failBelow) return "fail";
  if (warnBelow != null && n < warnBelow) return "warn";
  return "ok";
}

// No evidence at all is `unknown`, not `fail`: a freshly deployed box has an
// empty collection, and calling that a dead loop would cry wolf on every deploy.
function statusForAge(age, budgetMs) {
  if (age == null || !Number.isFinite(age)) return "unknown";
  return age > budgetMs ? "fail" : "ok";
}

// Confirming a suspect costs a live marketplace call, so a run confirms a
// window rather than the whole list. The window MOVES each run — without that,
// the same first N suspects would be re-confirmed hourly forever and the tail
// would never be looked at once. `tick` is derived from the clock (hours since
// epoch), so the rotation is deterministic and a test can pin it.
function rotateWindow(list, size, tick) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const n = Math.max(0, Math.floor(size) || 0);
  if (!arr.length || n >= arr.length) return { window: arr, notReached: 0 };
  const t = Number.isFinite(Number(tick)) ? Math.floor(Number(tick)) : 0;
  const start = (((t * n) % arr.length) + arr.length) % arr.length;
  const window = [];
  for (let i = 0; i < n; i += 1) window.push(arr[(start + i) % arr.length]);
  return { window, notReached: arr.length - n };
}

// Deliberately WIDER than utils/eldoradoFarmService's `/\bAutomatic\s+Farming\b/i`,
// which is a contract with our own publisher. This one has to catch anything a
// human ever typed into an offer title — "Auto-Farm", "auto farming", "AutoFarm"
// — because a rent-farm offer this misses is a rent-farm offer nobody checks.
// Over-collecting costs a false candidate; under-collecting cost order e69b19d3.
const RENT_FARM_TITLE = /\bauto(?:matic)?\s*-?\s*farm(?:ing)?\b/i;

function isRentFarmTitle(title) {
  return RENT_FARM_TITLE.test(String(title || ""));
}

// Can this row hand anything over TODAY, without a farm service behind it?
// Three shapes count as stock and they are not interchangeable:
//   - `units[]` entries not yet stamped `deliveredAt` — reserved accounts;
//   - a Gameflip auto-delivery row with an account attached to it;
//   - `lastStock > 0` — what the platform itself reported at the last guardian
//     pass, which is the only stock signal a GGSel quantity offer has.
function hasDeliverableStock(listing) {
  const row = listing || {};
  if ((row.units || []).some((u) => u && !u.deliveredAt)) return true;
  if (row.autoDeliver && String(row.accountLogin || "").trim()) return true;
  if (Number(row.lastStock) > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Measured constants — every number here was observed, not guessed
// ---------------------------------------------------------------------------

// Only these three marketplaces expose an ORDER API, so only they can provision
// an account AFTER the sale (utils/eldoradoFarmService, playerauctionsFarmService,
// g2gFarmService). Gameflip and GGSel deliver content attached BEFORE the sale,
// so a rent-farm offer there has nothing to fall back on — see PART A of
// docs/SYSTEM-HEALTH-CONTRACT.md. This set is the whole reason rentfarm.coverage
// exists.
const FARM_SERVICE_MARKETS = new Set(["eldorado", "playerauctions", "g2g"]);

// How long a paid order may sit before it counts as undelivered. The farm
// services retry on a ~75s loop and re-alert every 10th attempt (~12 min), so
// anything still unshipped at 20 minutes has already failed its retries — it is
// not "just landed". Eldorado order 4b20765f failed four times inside that
// window and the owner found out by looking.
const ORDER_GRACE_MS = 20 * 60 * 1000;

// The all-time realised ceiling: the highest price any of 217 recorded sales
// actually fetched. Anything above it is priced at a number that has never once
// converted.
const REALISED_CEILING_USD = 4.5;

// PlayerAuctions' platform floor. A row sitting at exactly $5.00 there is not
// overpricing, it is the lowest price the platform permits, and flagging it
// every hour would train the owner to ignore this check.
const PA_PLATFORM_FLOOR_USD = 5;

// Pool floors. 364 pristine eligible accounts today. Each rent-farm sale burns
// one for the whole window it sold (180 days, or a year), and the buffered-offer
// design pins one more per LIVE offer, so the useful question is "how many more
// orders can land before this is empty", not a percentage of the pool.
const POOL_WARN_BELOW = 100;
const POOL_FAIL_BELOW = 25;

// Token-less share of the available pool. 204 of 768 today (27%), and every one
// of them still holds a password, so all 204 are recoverable through device-auth
// rather than lost — which is why this check is `info` and not an emergency.
const TOKENLESS_WARN_PCT = 25;
const TOKENLESS_FAIL_PCT = 50;

// How many active listings the stale check resolves per run, and how deep it
// walks each one's stock. Healthy listings answer on the first candidate (the
// ledger pre-pass orders them), so this is ~2 indexed queries per listing.
// These bound LIVE Twitch reads through the Pi, not DB lookups — the switch from
// accountCoverage to liveCoverage changed their units entirely. 60 x 6 would be
// up to 360 GQL calls an hour down the same link the drop scanner uses every 20s,
// which is precisely the fan-out that is banned here. 12 x 2 is <=24 an hour, and
// the rotating window plus the `unknown`-when-incomplete reporting already make
// partial coverage honest rather than hidden.
const STALE_LISTING_CAP = 12;
const STALE_CANDIDATE_POOL = 60;
const STALE_CANDIDATE_CAP = 2;

// Gameflip suspects confirmed per run, one live GET each, sequentially.
const GHOST_CONFIRM_CAP = 20;
// `gameflipListingIdsByStatus` pages in hundreds, and on 2026-09-09 it returned
// exactly 200 ids — a round number is the signature of a cap, not of a fleet.
const GHOST_PAGE_SIZE = 100;

// Loop freshness budgets. Each is a POLICY number, deliberately several times
// the loop's own interval so a slow pass is not reported as a dead one.
const LOOP_BUDGETS = {
  // utils/fleetSnapshot captures every 20 min (FLEET_SNAPSHOT_MS).
  fleetSnapshot: 90 * 60 * 1000,
  // utils/autoFarmSnapshot rebuilds every 45s, but a host pass can stall behind
  // an offline Pi for minutes at a time.
  autoFarmSnapshot: 30 * 60 * 1000,
  // utils/dropScanner ticks every 20s across a fleet of hundreds; six hours
  // without a single successful scan anywhere means the scanner, not the fleet.
  dropScanner: 6 * 60 * 60 * 1000,
  // utils/accountPoolChecker sweeps every 6h (ACCOUNT_POOL_SWEEP_MS). This is
  // the loop that silently had no scheduler at all and checked 0 accounts in
  // seven days, which is what made the "ready pool" number fiction.
  accountPoolChecker: 14 * 60 * 60 * 1000,
};

// How many ticks of the auto-lister may be missed before it counts as stopped.
// utils/unclaimedAutoList runs every 10 minutes and stamps `lastCheckedAt` on
// the ledger rows it touches, so six missed ticks is an hour of silence.
const AUTOLIST_STALE_TICKS = 6;

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

const CHECKS = [
  {
    id: "eldorado.offers",
    title: "Eldorado offers match what we can deliver",
    group: "listings",
    severity: "critical",
    // Three questions the hourly run could not answer before, all from ONE
    // paginated read of Eldorado's own offer list (~4 calls for 158 offers) —
    // cheap enough for an hourly check, unlike one API call per listing.
    //
    // Every one of them was found by hand on 2026-09-09, which is the argument
    // for the check existing at all:
    //
    //  1. DRIFT. Three rows read `status: "active"` here while Eldorado had
    //     them Paused. Nothing reconciles Eldorado status: the only sweep that
    //     reads it back (unclaimedAutoList.reconcileRowsPass) is scoped to
    //     `origin: "unclaimed"`, and 23 of the 24 Eldorado rows are `manual`.
    //     Harmless to a buyer, but it makes every count we render a lie.
    //
    //  2. UNTRACKED SELLABLE OFFERS. Eldorado had 106 active offers against 24
    //     rows. That is not automatically wrong — 87 of them are rent-farm
    //     offers, which the fulfiller matches by TITLE and not by listing row —
    //     but an active BUNDLE offer with no row cannot be auto-delivered at
    //     all: deliverOrder returns "no listing row for offer <id>" and the
    //     buyer waits out the delivery guarantee.
    //
    //  3. UNRESOLVABLE RENT-FARM TITLES. A rent-farm order is filled by parsing
    //     its offer title into a game and a term. All 87 live offers resolve
    //     today, across 29 games — but publishing one for a game the farm does
    //     not know creates an offer that takes money and can never be filled,
    //     and nothing else would notice until a buyer paid.
    async run(ctx) {
      const mp = ctx.dep("marketplaces");
      const MarketplaceListing = ctx.dep("MarketplaceListing");
      const farm = ctx.dep("eldoradoFarmService");

      // Page the account's own offers. Bounded: a runaway page count would turn
      // an hourly check into a crawl of the marketplace.
      const offers = [];
      let page = 1;
      let pages = 1;
      try {
        do {
          const r = await mp.eldoradoMyListings(page, 50);
          if (!r) break;
          pages = Math.min(Number(r.totalPages) || 1, 10);
          for (const o of r.results || []) offers.push(o);
          page += 1;
        } while (page <= pages);
      } catch (e) {
        // A marketplace we could not read is `unknown`, never `fail` — the
        // contract's rule, and the one that stops a session hiccup reading as a
        // broken marketplace.
        return {
          status: "unknown",
          measured: null,
          threshold: "Eldorado's offer list is readable",
          summary: "Could not read Eldorado's offers: " + String(e.message || e).slice(0, 120),
          detail: "Not evidence of a problem — only that this check could not run.",
        };
      }
      if (!offers.length) {
        return {
          status: "unknown",
          measured: 0,
          threshold: "Eldorado's offer list is readable",
          summary: "Eldorado returned no offers at all, which is not a state we can act on",
          detail: "An empty list reads the same as a failed read, so it is reported as unknown.",
        };
      }

      const live = offers.filter((o) => String(o.offerState || "") === "Active");
      const liveIds = new Set(live.map((o) => String(o.id)));
      const rows = await MarketplaceListing.find(
        { marketplace: "eldorado", status: "active" },
        { externalId: 1, title: 1, price: 1 },
      )
        .limit(2000)
        .lean();
      const rowIds = new Set(rows.map((r) => String(r.externalId)));

      const problems = [];

      for (const r of rows) {
        if (!liveIds.has(String(r.externalId))) {
          problems.push({
            kind: "we say active, Eldorado does not",
            offer: r.externalId,
            title: String(r.title || "").slice(0, 70),
          });
        }
      }

      for (const o of live) {
        const title = String(o.offerTitle || "");
        const isFarm = /\bAutomatic\s+Farming\b/i.test(title);
        if (isFarm) {
          // Ask the REAL resolver, in the shape a real order carries.
          const parsed = await farm
            .parseFarmOrder({ orderOfferDetails: { offerTitle: title } })
            .catch(() => null);
          if (!parsed || !parsed.days || !parsed.game) {
            problems.push({
              kind: "rent-farm offer the farm cannot fill",
              offer: String(o.id),
              title: title.slice(0, 70),
              why: !parsed
                ? "title does not parse"
                : !parsed.days
                  ? "no farming term in the title"
                  : 'game "' + parsed.rawGame + '" is unknown to the farm',
            });
          }
          continue;
        }
        if (!rowIds.has(String(o.id))) {
          problems.push({
            kind: "sellable bundle offer with no listing row",
            offer: String(o.id),
            title: title.slice(0, 70),
          });
        }
      }

      const n = problems.length;
      return {
        status: n ? "fail" : "ok",
        measured: n,
        threshold:
          "0 mismatches between Eldorado's " + live.length +
          " live offer(s) and what we can deliver",
        summary: n
          ? n + " Eldorado offer(s) do not line up with our stock: " +
            [...new Set(problems.map((p) => p.kind))].join("; ")
          : "All " + live.length + " live Eldorado offers are tracked and fillable",
        detail:
          "Read from Eldorado's own offer list. A rent-farm offer is matched by " +
          "TITLE rather than by a listing row, so it is checked against the real " +
          "resolver instead of being counted as untracked.",
        items: capItems(problems),
      };
    },
  },
  {
    id: "orders.undelivered",
    title: "Paid orders awaiting delivery",
    group: "orders",
    severity: "critical",
    // The rent-farm queue is where both lost orders were, and it is the only
    // order queue with a local row per PAID order (FarmServiceOrder is claimed
    // on the marketplace order id before anything is provisioned). Bundle sales
    // on the marketplaces leave no such row, so they are honestly out of scope
    // here rather than half-covered.
    async run(ctx) {
      const FarmServiceOrder = ctx.dep("FarmServiceOrder");
      const cutoff = new Date(ctx.now().getTime() - ORDER_GRACE_MS);
      const query = {
        deliveredAt: null,
        // "cancelled" is terminal like "delivered": the buyer walked away, so
        // nobody is waiting. An alert that fires forever over a closed order is
        // an alert that gets ignored on the day it matters.
        state: { $nin: ["delivered", "cancelled"] },
        // A `failed` order gets no grace at all — it has already given up.
        $or: [{ state: "failed" }, { createdAt: { $lte: cutoff } }],
      };
      const total = await FarmServiceOrder.countDocuments(query);
      const rows = total
        ? await FarmServiceOrder.find(query)
            .sort({ createdAt: 1 })
            .limit(ITEM_CAP)
            .lean()
        : [];
      const oldest = rows.length ? ageMs(rows[0].createdAt, ctx.now()) : null;
      return {
        status: total > 0 ? "fail" : "ok",
        measured: total,
        threshold: "0 undelivered after " + fmtAge(ORDER_GRACE_MS),
        summary: total
          ? total +
            " paid order(s) still undelivered — oldest waiting " +
            fmtAge(oldest)
          : "No paid rent-farm order is waiting for delivery",
        detail:
          "FarmServiceOrder rows that are not `delivered` and carry no " +
          "deliveredAt stamp. A buyer is waiting from the moment one appears.",
        items: capItems(
          rows.map((r) => ({
            orderId: r.orderId,
            market: r.market,
            game: r.game,
            state: r.state,
            attempts: r.attempts || 0,
            waiting: fmtAge(ageMs(r.createdAt, ctx.now())),
            lastError: String(r.lastError || "").slice(0, 160),
          })),
        ),
      };
    },
  },

  {
    id: "rentfarm.capacity",
    title: "Rent-farm stack slots free",
    group: "rentfarm",
    severity: "critical",
    // Reuses utils/rentFarmCapacity's own snapshot() and levelFor() rather than
    // recounting slots here. Two numbers for one question is how the 10/10 stack
    // went unnoticed while every other dial read fine; the page and the Telegram
    // alert now cannot disagree, because they are the same function.
    async run(ctx) {
      const rf = ctx.dep("rentFarmCapacity");
      const snap = await rf.snapshot();
      const threshold = "> " + rf.LOW_WATER + " free slots (0 = cannot fill)";
      if (!snap.readable) {
        return {
          status: "unknown",
          measured: null,
          threshold,
          summary: "No rental stack could be read — capacity is unknown",
          detail: snap.offlineHosts.length
            ? "host(s) offline: " + snap.offlineHosts.join(", ")
            : "",
        };
      }
      const level = rf.levelFor(snap.totalFree);
      let status = level === "empty" ? "fail" : level === "low" ? "warn" : "ok";
      let note = "";
      // An offline host is a READ failure, not missing capacity: its slots may
      // be sitting there free. Reporting "0 free" off a partial read is exactly
      // the Pi-hiccup-as-marketplace-fault mistake, so a bad verdict built on an
      // incomplete read is downgraded to `unknown`. A GOOD verdict survives —
      // hosts we could not read can only add slots, never remove them.
      if (snap.offlineHosts.length && status !== "ok") {
        status = "unknown";
        note =
          "verdict withheld: " +
          snap.offlineHosts.length +
          " host(s) offline and not counted (" +
          snap.offlineHosts.join(", ") +
          ")";
      }
      return {
        status,
        measured: snap.totalFree,
        threshold,
        summary:
          snap.totalFree +
          " free slot(s) across " +
          snap.readable +
          " readable stack(s) of " +
          snap.totalCapacity +
          " total",
        detail:
          note ||
          "One order holds one slot until its window lapses (180-day and " +
            "1-year windows are sold), so slots free far slower than they fill.",
        items: capItems(
          snap.stacks
            .slice()
            .sort((a, b) => a.remaining - b.remaining)
            .map((s) => ({
              host: s.host,
              file: s.file,
              used: s.used,
              capacity: s.capacity,
              remaining: s.remaining,
            })),
        ),
      };
    },
  },

  {
    id: "rentfarm.coverage",
    title: "Rent-farm offers that can be delivered",
    group: "rentfarm",
    severity: "critical",
    // The exposure PART A of the contract measured: 8 live "Automatic Farming"
    // offers (gameflip 5, ggsel 3) whose marketplaces have no farm service and
    // which held 0 stock. Each one would take a payment and then fail with
    // "Out of stock — no unsold account holds this whole bundle", which is
    // order e69b19d3's outcome with a different cause. They were paused on
    // 2026-09-09; this check is what proves they stay that way, and catches the
    // next one published by hand.
    async run(ctx) {
      const MarketplaceListing = ctx.dep("MarketplaceListing");
      const rows = await MarketplaceListing.find(
        { status: "active" },
        {
          title: 1,
          marketplace: 1,
          externalId: 1,
          url: 1,
          price: 1,
          autoDeliver: 1,
          accountLogin: 1,
          units: 1,
          lastStock: 1,
          autoPaused: 1,
        },
      ).sort({ _id: 1 })
          .lean();
      const farmOffers = rows.filter((r) => isRentFarmTitle(r.title));
      // A row the stock sync already paused is not on sale, and pausing at zero
      // stock is precisely the handling this check would otherwise demand — so
      // counting it as undeliverable would flag the fix as the fault.
      const live = farmOffers.filter((r) => !r.autoPaused);
      const paused = farmOffers.length - live.length;
      const offenders = live.filter(
        (r) =>
          !FARM_SERVICE_MARKETS.has(r.marketplace) && !hasDeliverableStock(r),
      );
      return {
        status: offenders.length ? "fail" : "ok",
        measured: offenders.length,
        threshold: "0 of " + live.length + " live rent-farm offer(s)",
        summary: offenders.length
          ? offenders.length +
            " live rent-farm offer(s) cannot be delivered at all — no farm " +
            "service on that marketplace and no stock attached"
          : live.length +
            " live rent-farm offer(s), every one either has a farm service or stock",
        detail:
          "Only " +
          [...FARM_SERVICE_MARKETS].join(", ") +
          " can provision an account after the sale. Elsewhere the content must " +
          "already be attached before the buyer pays." +
          (paused ? " " + paused + " paused offer(s) not judged." : ""),
        items: capItems(
          offenders.map((r) => ({
            marketplace: r.marketplace,
            externalId: r.externalId,
            title: String(r.title || "").slice(0, 120),
            price: r.price,
            url: r.url,
          })),
        ),
      };
    },
  },

  {
    id: "listings.stale",
    title: "Listings advertising drops nobody holds",
    group: "listings",
    severity: "critical",
    // Every event we farm dies on a schedule: when a wave ends its drops stop
    // being claimable and leave the account's inventory, while the listing text
    // does not change. Eldorado order 99d443eb sold a 10-item Overwatch bundle
    // as "Week 1 + Week 2" and delivered accounts that by then held only Week 2 —
    // the buyer counted his loot boxes and was right.
    //
    // The verdict comes from unclaimedCoverage.liveCoverage, the SAME gate
    // the fulfillers use at hand-over, so this page can never say a listing is
    // fine that delivery would refuse. Only rows whose stock is the no-claim
    // ledger are judged; an archive-backed row is a different join and is
    // counted as not-judged rather than guessed at.
    async run(ctx) {
      const MarketplaceListing = ctx.dep("MarketplaceListing");
      const UnclaimedAccount = ctx.dep("UnclaimedAccount");
      const coverage = ctx.dep("unclaimedCoverage");
      const audit = ctx.dep("unclaimedListingAudit");

      const listings = await MarketplaceListing.find(
        {
          status: "active",
          autoPaused: { $ne: true },
          "requiredDrops.0": { $exists: true },
        },
        {
          title: 1,
          marketplace: 1,
          externalId: 1,
          url: 1,
          requiredDrops: 1,
          unclaimedGame: 1,
          set: 1,
          origin: 1,
        },
      ).sort({ _id: 1 })
          .lean();

      // `requiredDrops` is the buyer contract and the gate is opt-in per row, so
      // with none declared there is nothing to compare stock against. That is
      // "cannot answer", not "all good".
      if (!listings.length) {
        return {
          status: "unknown",
          measured: null,
          threshold: "0 listings short of their advertised items",
          summary:
            "No active listing declares requiredDrops — nothing to check stock against",
          detail:
            "A row with no advertised item list keeps its pre-gate delivery " +
            "behaviour, so this check has no contract to judge it by.",
        };
      }

      const judgeable = listings.filter(
        (l) => l.unclaimedGame || l.origin === "unclaimed",
      );
      const notJudged = listings.length - judgeable.length;
      if (!judgeable.length) {
        return {
          status: "unknown",
          measured: null,
          threshold: "0 listings short of their advertised items",
          summary:
            notJudged +
            " listing(s) declare items but all are archive-backed — not judged here",
          detail:
            "Archive-backed stock is picked by SET out of the Drop Archive, a " +
            "different join from the no-claim ledger this check reads.",
        };
      }

      const tick = Math.floor(ctx.now().getTime() / (60 * 60 * 1000));
      const { window, notReached } = rotateWindow(
        judgeable,
        STALE_LISTING_CAP,
        tick,
      );

      const offenders = [];
      let unresolved = 0;
      for (const listing of window) {
        const required = coverage.listingRequirements(listing);
        if (!required.size) {
          // `requiredDrops.0` exists but every name is blank (the schema
          // defaults `name` to ""), so there is no contract to check. Skipping
          // it silently counted it toward "judged" and made the check look more
          // thorough than it was.
          unresolved += 1;
          continue;
        }
        const query = listing.unclaimedGame
          ? {
              source: "noclaim",
              game: audit.gameFilter(listing.unclaimedGame),
              status: { $in: audit.SELLABLE_STATUSES },
              soldAt: null,
            }
          : {
              source: "noclaim",
              set: listing.set,
              status: { $in: audit.SELLABLE_STATUSES },
              soldAt: null,
            };
        const candidates = await UnclaimedAccount.find(query, {
          login: 1,
          game: 1,
          drops: 1,
          // liveCoverage -> liveHeld -> candForLedger reads the POOL row by
          // `poolAccountId` to get a token. Without it every candidate resolves
          // to null, every verdict degrades to the DB union, and this check
          // silently becomes the very thing it is meant to replace.
          poolAccountId: 1,
        })
          .limit(STALE_CANDIDATE_POOL)
          .lean();

        // The ledger-only pass is an ordering hint, never a verdict: ledger
        // `drops[]` is whatever the last no-claim scan wrote (3-6 items on rows
        // DropLog knew 7-39 for), so judging on it alone would condemn healthy
        // listings. Try the rows it likes first, then the rest.
        const { covering, short } = coverage.partitionByCoverage(
          candidates,
          required,
        );
        const walk = covering.concat(short).slice(0, STALE_CANDIDATE_CAP);
        let holder = null;
        let degraded = false;
        for (const row of walk) {
          // liveCoverage, NOT accountCoverage. accountCoverage is the DB union
          // (ledger `drops[]` u DropLog) and both of those are HISTORICAL: they
          // still remember a wave after it has expired off the account. This
          // check exists to catch exactly that, so judging it on them makes it
          // blind by construction — and it is what delivery uses
          // (eldoradoFulfiller.js:205, playerauctionsFulfiller.js:228), so
          // anything else would also be checking a different question from the
          // one a buyer actually hits. On the CAH bundle both DB sources said
          // fine while a live read showed Week 1 gone from all 15 accounts.
          const verdict = await coverage.liveCoverage(row, required);
          // A degraded verdict fell back to those same DB sources, so it is not
          // evidence of coverage. It must not produce a holder — honouring it
          // turned a DropLog outage into a clean bill of health for the whole
          // shop.
          if (verdict.degraded) {
            degraded = true;
            continue;
          }
          if (verdict.ok) {
            holder = row;
            break;
          }
        }
        if (holder) continue;
        // A DropLog read that failed leaves a ledger-only verdict, which is
        // exactly the verdict known to be wrong. Count it as unmeasured rather
        // than accuse a listing on evidence we already know under-reports.
        if (degraded) {
          unresolved += 1;
          continue;
        }
        offenders.push({
          marketplace: listing.marketplace,
          externalId: listing.externalId,
          title: String(listing.title || "").slice(0, 120),
          game: listing.unclaimedGame || "",
          advertised: (listing.requiredDrops || []).length,
          candidates: candidates.length,
          missing: candidates.length
            ? coverage.shortfallSummary(candidates, required)
            : "no sellable ledger row for this game/set",
          url: listing.url,
        });
      }

      const status = offenders.length
        ? "fail"
        : unresolved || notReached
          ? "unknown"
          : "ok";
      return {
        status,
        measured: offenders.length,
        threshold:
          "0 of " + window.length + " judged listing(s) short of their items",
        summary: offenders.length
          ? offenders.length +
            " active listing(s) advertise items no sellable account still holds"
          : unresolved
            ? unresolved +
              " listing(s) could not be resolved — the DropLog half of the " +
              "coverage read failed, so no verdict was reached"
            : "Every judged listing has at least one account that covers it" +
              (notReached ? " (" + notReached + " not reached this run)" : ""),
        detail:
          "Verdict is unclaimedCoverage.liveCoverage — the same gate " +
          "delivery uses." +
          (notJudged
            ? " " + notJudged + " archive-backed row(s) not judged."
            : "") +
          (unresolved
            ? " " + unresolved + " row(s) unresolved (DropLog read degraded)."
            : ""),
        items: capItems(offenders),
      };
    },
  },

  {
    id: "listings.overpriced",
    title: "Listings above the realised ceiling",
    group: "listings",
    severity: "warn",
    async run(ctx) {
      const MarketplaceListing = ctx.dep("MarketplaceListing");
      const rows = await MarketplaceListing.find(
        {
          status: "active",
          autoPaused: { $ne: true },
          price: { $gt: REALISED_CEILING_USD },
        },
        {
          title: 1,
          marketplace: 1,
          externalId: 1,
          url: 1,
          price: 1,
          origin: 1,
        },
      ).sort({ _id: 1 })
          .lean();
      const offenders = rows.filter((r) => {
        // $5.00 on PlayerAuctions is the platform's own floor — we could not
        // list lower if we wanted to, so it is not a pricing decision at all.
        if (
          r.marketplace === "playerauctions" &&
          Number(r.price) === PA_PLATFORM_FLOOR_USD
        )
          return false;
        // A rent-farm offer sells a WINDOW, not a farmed account: a different
        // product with a different market (rivals ask 4.99-6.00), so the
        // bundle ceiling says nothing about it.
        if (isRentFarmTitle(r.title)) return false;
        return true;
      });
      const highest = offenders.reduce(
        (max, r) => Math.max(max, Number(r.price) || 0),
        0,
      );
      return {
        status: offenders.length ? "fail" : "ok",
        measured: offenders.length,
        threshold: "$" + REALISED_CEILING_USD.toFixed(2) + " realised ceiling",
        summary: offenders.length
          ? offenders.length +
            " active listing(s) priced above $" +
            REALISED_CEILING_USD.toFixed(2) +
            " (highest $" +
            highest.toFixed(2) +
            ")"
          : "No active listing is priced above what has ever sold",
        detail:
          "$" +
          REALISED_CEILING_USD.toFixed(2) +
          " is the highest price any of 217 recorded sales actually fetched. " +
          "PlayerAuctions rows at exactly $" +
          PA_PLATFORM_FLOOR_USD.toFixed(2) +
          " (platform floor) and rent-farm offers are excluded.",
        items: capItems(
          offenders
            .slice()
            .sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0))
            .map((r) => ({
              marketplace: r.marketplace,
              externalId: r.externalId,
              title: String(r.title || "").slice(0, 120),
              price: r.price,
              origin: r.origin,
              url: r.url,
            })),
        ),
      };
    },
  },

  {
    id: "listings.ghost",
    title: "Active rows the marketplace has already sold",
    group: "listings",
    severity: "warn",
    // 26 genuinely-sold-but-still-active Gameflip rows were found this way,
    // worth $51.80 of revenue nothing had recorded. Each one also pins the
    // account it carries as reserved forever and stops its relist chain.
    //
    // THE TRAP THIS CHECK IS BUILT AROUND: `gameflipListingIdsByStatus("onsale")`
    // returned EXACTLY 200 ids on 2026-09-09 — a round number is the signature
    // of a cap, not of a fleet. Absence from that list is therefore NOT proof of
    // a sale, so nothing is reported until a per-listing status read confirms
    // it, and the run says out loud how many suspects it did not reach.
    timeoutMs: 3 * 60 * 1000,
    async run(ctx) {
      const MarketplaceListing = ctx.dep("MarketplaceListing");
      const mp = ctx.dep("marketplaces");
      const rows = await MarketplaceListing.find(
        { marketplace: "gameflip", status: "active" },
        { externalId: 1, title: 1, price: 1, url: 1, accountLogin: 1 },
      ).sort({ _id: 1 })
          .lean();
      if (!rows.length) {
        return {
          status: "ok",
          measured: 0,
          threshold: "0 sold-but-active rows",
          summary: "No active Gameflip listing to check",
        };
      }
      // A throw here is an auth/rate-limit failure, not evidence of ghosts —
      // let it reach runAll and become `unknown`.
      const onsale = await mp.gameflipListingIdsByStatus("onsale");
      const suspects = rows.filter(
        (r) => r.externalId && !onsale.has(r.externalId),
      );
      const capped = onsale.size > 0 && onsale.size % GHOST_PAGE_SIZE === 0;

      const tick = Math.floor(ctx.now().getTime() / (60 * 60 * 1000));
      const { window, notReached } = rotateWindow(
        suspects,
        GHOST_CONFIRM_CAP,
        tick,
      );
      const ghosts = [];
      let confirmedLive = 0;
      let unreadable = 0;
      // Sequential on purpose: Gameflip rate-limits, and a 429 reads exactly
      // like "not sold yet" — the failure that let sales go unnoticed in the
      // first place.
      for (const row of window) {
        let state;
        try {
          state = await mp.gameflipListingStatus(row.externalId);
        } catch {
          unreadable += 1;
          continue;
        }
        if (state === "onsale") {
          confirmedLive += 1;
          continue;
        }
        if (!state) {
          unreadable += 1;
          continue;
        }
        ghosts.push({
          externalId: row.externalId,
          title: String(row.title || "").slice(0, 120),
          price: row.price,
          accountLogin: row.accountLogin || "",
          marketplaceStatus: state,
          url: row.url,
        });
      }

      const unchecked = notReached + unreadable;
      const status = ghosts.length ? "fail" : unchecked ? "unknown" : "ok";
      return {
        status,
        measured: ghosts.length,
        threshold:
          "0 sold-but-active rows of " + suspects.length + " suspect(s)",
        summary: ghosts.length
          ? ghosts.length +
            " active row(s) confirmed already sold/withdrawn on Gameflip"
          : suspects.length
            ? "No ghost confirmed among " +
              window.length +
              " suspect(s) checked" +
              (unchecked ? "; " + unchecked + " not confirmed this run" : "")
            : "Every active Gameflip row is on sale",
        detail:
          rows.length +
          " active rows, " +
          onsale.size +
          " ids returned by the onsale query" +
          (capped
            ? " (a whole number of pages, so it may or may not be complete)"
            : "") +
          ", " +
          confirmedLive +
          " suspect(s) confirmed still live" +
          (unreadable ? ", " + unreadable + " unreadable" : "") +
          (notReached ? ", " + notReached + " left for the next run" : "") +
          ". Absence from the id list is never treated as proof.",
        items: capItems(ghosts),
      };
    },
  },

  {
    id: "autolist.running",
    title: "Unclaimed auto-lister ticking",
    group: "loops",
    severity: "warn",
    // Proven from `UnclaimedAccount.lastCheckedAt` — a stamp the check pass
    // writes to the DB on every row it touches. The module's own `lastRun` is
    // in-memory and resets on every restart, so it can only ever say "fine".
    async run(ctx) {
      const UnclaimedAccount = ctx.dep("UnclaimedAccount");
      const config = ctx.dep("settings").getAutoFarm();
      const tickMs =
        Number(ctx.dep("unclaimedAutoList").TICK_MS) || 10 * 60 * 1000;
      const budget = tickMs * AUTOLIST_STALE_TICKS;
      const threshold = "a tick within " + fmtAge(budget);
      if (!config.unclaimedAutoList || config.unclaimedAutoListPaused) {
        // Switched off is a KNOWN state, not a broken one — but it is still a
        // state the owner should see rather than a green tick, because a pause
        // set during an incident and never lifted looks identical to healthy.
        return {
          status: "warn",
          measured: 0,
          threshold,
          summary:
            "Auto-lister is switched off in settings (" +
            (config.unclaimedAutoListPaused ? "paused" : "disabled") +
            ") — no accounts are being listed",
          detail: "Nothing is broken; nothing is selling either.",
        };
      }
      const row = await UnclaimedAccount.findOne(
        { lastCheckedAt: { $ne: null } },
        { lastCheckedAt: 1 },
      )
        .sort({ lastCheckedAt: -1 })
        .lean();
      // The stamp is only written to rows the check pass actually walks, and it
      // only walks `listed` ledgers. With none — everything sold or released —
      // a perfectly healthy pass runs its full tick and writes nothing, and an
      // hour later this would report `fail` on a loop that is working fine.
      // Crying wolf is how a monitor gets ignored, so the absence of anything to
      // stamp is `unknown`, not a fault.
      if (!row) {
        const listed = await UnclaimedAccount.countDocuments({ status: "listed" });
        if (!listed) {
          return {
            status: "unknown",
            measured: 0,
            threshold,
            summary:
              "No listed ledger row exists, so the pass has nothing to stamp — " +
              "the lister cannot be proved either way right now",
            detail:
              "Evidence is UnclaimedAccount.lastCheckedAt, which the check pass " +
              "writes only on rows with status 'listed'.",
          };
        }
      }
      const age = row ? ageMs(row.lastCheckedAt, ctx.now()) : null;
      return {
        status: statusForAge(age, budget),
        measured: fmtAge(age),
        threshold,
        summary: row
          ? "Last ledger row checked " + fmtAge(age) + " ago"
          : "No ledger row has ever been checked — no evidence the lister ran",
        detail:
          "Evidence is UnclaimedAccount.lastCheckedAt, written to the DB by " +
          "the check pass. Tick is " +
          fmtAge(tickMs) +
          "; " +
          AUTOLIST_STALE_TICKS +
          " missed ticks is the budget.",
      };
    },
  },

  {
    id: "pool.health",
    title: "Pristine accounts ready to sell",
    group: "pool",
    severity: "warn",
    // Deliberately calls gatherPoolEligibility() — the exact function the
    // provisioner uses — instead of counting `status: available` here. A second
    // definition of "eligible" is how a pool showing 554 accounts fed an order
    // that could not be filled: both numbers were right about different things.
    async run(ctx) {
      const gather = ctx.dep("gatherPoolEligibility");
      const { eligible } = await gather();
      const n = (eligible || []).length;
      return {
        status: statusForLow(n, {
          warnBelow: POOL_WARN_BELOW,
          failBelow: POOL_FAIL_BELOW,
        }),
        measured: n,
        threshold:
          "warn under " + POOL_WARN_BELOW + ", fail under " + POOL_FAIL_BELOW,
        summary:
          n + " pristine pool account(s) eligible to be provisioned right now",
        detail:
          "Eligible means available, verified ok, has a password and a token, " +
          "never hand-sold, not deployed, not on a listing and not assigned to " +
          "a farm task — routes/renterAdminRoutes.gatherPoolEligibility, the " +
          "same filter fulfilment uses. Each rent-farm sale holds one for the " +
          "whole window it sold.",
      };
    },
  },

  {
    id: "pool.tokens",
    title: "Pool accounts with no usable token",
    group: "pool",
    severity: "info",
    async run(ctx) {
      const AvailableAccount = ctx.dep("AvailableAccount");
      const tokenless = {
        status: "available",
        clientSecret: { $in: ["", null] },
      };
      const total = await AvailableAccount.countDocuments({
        status: "available",
      });
      const inert = await AvailableAccount.countDocuments(tokenless);
      // A token-less row that still holds a password is not lost supply: it can
      // be run back through device-auth (tools/twitch-token-fetcher.html). All
      // 204 of today's were recoverable, which is why this check is `info`.
      const recoverable = await AvailableAccount.countDocuments({
        ...tokenless,
        hasPassword: true,
      });
      const share = pct(inert, total);
      return {
        status: statusForHigh(share, {
          warnAt: TOKENLESS_WARN_PCT,
          failAt: TOKENLESS_FAIL_PCT,
        }),
        measured: inert,
        threshold:
          "warn at " +
          TOKENLESS_WARN_PCT +
          "% of available, fail at " +
          TOKENLESS_FAIL_PCT +
          "%",
        summary:
          inert +
          " of " +
          total +
          " available account(s) have no clientSecret (" +
          share +
          "%), " +
          recoverable +
          " of them recoverable",
        detail:
          "An account with no token cannot be dropped into a bot config, so it " +
          "is inert supply that every pool count still reports as stock. One " +
          "with a password can be re-authed; one without is dead weight.",
      };
    },
  },

  {
    id: "loops.alive",
    title: "Background loops doing work",
    group: "loops",
    severity: "warn",
    // Every proof here is a timestamp another process WROTE TO THE DB. An
    // in-memory tick counter proves only that this process is young: the pool
    // checker's counter said "fine" through seven days in which it checked 0
    // accounts, because the number reset on every restart.
    //
    // utils/rentFarmCapacity is deliberately absent: it only persists a row when
    // it ALERTS, so a healthy silent loop is indistinguishable from a dead one
    // and including it would paint this card red forever.
    async run(ctx) {
      const probes = [
        {
          id: "fleetSnapshot",
          label: "fleet metric history",
          budget: LOOP_BUDGETS.fleetSnapshot,
          async at() {
            const row = await ctx
              .dep("FleetSnapshot")
              .findOne({}, { at: 1 })
              .sort({ at: -1 })
              .lean();
            return row ? row.at : null;
          },
        },
        {
          id: "autoFarmSnapshot",
          label: "auto-farm watcher",
          budget: LOOP_BUDGETS.autoFarmSnapshot,
          async at() {
            const row = await ctx
              .dep("AutoFarmSnapshot")
              .findOne({ key: "auto-farm" }, { builtAt: 1 })
              .lean();
            return row ? row.builtAt : null;
          },
        },
        {
          id: "dropScanner",
          label: "drop scanner",
          budget: LOOP_BUDGETS.dropScanner,
          async at() {
            // lastScanAt is stamped only on a completed scan, and it is indexed.
            const row = await ctx
              .dep("BotAccount")
              .findOne({ lastScanAt: { $ne: null } }, { lastScanAt: 1 })
              .sort({ lastScanAt: -1 })
              .lean();
            return row ? row.lastScanAt : null;
          },
        },
        {
          id: "accountPoolChecker",
          label: "pool token re-check sweep",
          budget: LOOP_BUDGETS.accountPoolChecker,
          async at() {
            const row = await ctx
              .dep("AvailableAccount")
              .findOne({ lastCheckAt: { $ne: null } }, { lastCheckAt: 1 })
              .sort({ lastCheckAt: -1 })
              .lean();
            return row ? row.lastCheckAt : null;
          },
        },
      ];

      const items = [];
      for (const probe of probes) {
        let at = null;
        let error = "";
        try {
          at = await probe.at();
        } catch (e) {
          error = (e && e.message) || String(e);
        }
        const age = error ? null : ageMs(at, ctx.now());
        items.push({
          loop: probe.id,
          label: probe.label,
          // A read that FAILED and a loop that never ran are both `unknown`,
          // and they must not be confused with each other in the detail text.
          status: error ? "unknown" : statusForAge(age, probe.budget),
          lastAt: at || null,
          age: fmtAge(age),
          budget: fmtAge(probe.budget),
          error: error.slice(0, 160),
        });
      }
      const fresh = items.filter((i) => i.status === "ok").length;
      const dead = items.filter((i) => i.status === "fail");
      return {
        status: worstStatus(items),
        measured: fresh,
        threshold: items.length + " loops with fresh persisted evidence",
        summary: dead.length
          ? dead.map((d) => d.label).join(", ") +
            " ha" +
            (dead.length === 1 ? "s" : "ve") +
            " done no work inside its budget"
          : fresh + " of " + items.length + " loops proved recent work",
        detail:
          "Each loop is proved by a timestamp it persisted, never by an " +
          "in-process counter — those reset on every restart.",
        items: capItems(items),
      };
    },
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// Losing the race does not cancel the underlying work — nothing here mutates,
// so an abandoned read is harmless.
//
// The timer is deliberately NOT unref'd, unlike the tick timers everywhere else
// in this codebase: an unref'd timeout does not fire when the health run is the
// only thing left pending, so a CLI run of a hung check would exit silently
// instead of reporting `unknown`. It is cleared on every path below, so it can
// hold the loop open only while a check is genuinely still in flight.
function withTimeout(promise, ms, label) {
  let timer = null;
  const expiry = new Promise((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            label +
              " timed out after " +
              // Sub-second budgets only appear in tests, and rounding those to
              // "0s" makes a failing assertion unreadable.
              (ms >= 1000 ? Math.round(ms / 1000) + "s" : ms + "ms"),
          ),
        ),
      ms,
    );
  });
  return Promise.race([promise, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runOne(def, ctx, timeoutMs) {
  const startedAt = Date.now();
  let out;
  try {
    out = await withTimeout(
      // Wrapped so a check that throws SYNCHRONOUSLY is caught here too rather
      // than escaping the runner.
      Promise.resolve().then(() => def.run(ctx)),
      def.timeoutMs || timeoutMs || CHECK_TIMEOUT_MS,
      def.id,
    );
  } catch (e) {
    // The whole reason every check is wrapped: one broken check must never take
    // the hourly run — or the other nine answers — down with it. And it degrades
    // to `unknown`, never to `fail`: we did not measure a fault, we failed to
    // measure at all.
    out = {
      status: "unknown",
      summary: "Check could not run: " + ((e && e.message) || String(e)),
      measured: null,
      threshold: null,
    };
  }
  const result = out && typeof out === "object" ? out : {};
  return {
    id: def.id,
    title: def.title,
    group: def.group,
    status: normStatus(result.status),
    severity: def.severity,
    summary: String(result.summary || ""),
    measured: result.measured === undefined ? null : result.measured,
    threshold: result.threshold === undefined ? null : result.threshold,
    detail: String(result.detail || ""),
    items: capItems(result.items),
    ms: Date.now() - startedAt,
    checkedAt: new Date(),
  };
}

// Run every check (or `only`, a list of ids) against one shared ctx.
//
// SEQUENTIAL, on purpose. Atlas serialises concurrent queries anyway, and the
// live half of this run talks to a rate-limited marketplace and to hosts over a
// seconds-of-RTT link — a fan-out would turn an hourly health read into the kind
// of load this page exists to warn about.
async function runAll({ only, deps, now, timeoutMs } = {}) {
  const ctx = makeCtx({ deps, now });
  const startedAt = ctx.now();
  const wall = Date.now();
  const wanted =
    Array.isArray(only) && only.length
      ? CHECKS.filter((c) => only.includes(c.id))
      : CHECKS;
  const checks = [];
  for (const def of wanted) {
    checks.push(await runOne(def, ctx, timeoutMs));
  }

  // Connector reachability lives in its own module because it is the only group
  // whose members are discovered rather than declared — one check per configured
  // marketplace. It was written and then never registered here, which meant the
  // board could come back entirely green having never asked whether a single
  // marketplace still authenticates. That is the same failure shape as a check
  // that reports `ok` without measuring anything, one level up.
  const wantConnectors =
    !Array.isArray(only) || !only.length || only.some((id) => String(id).startsWith("connector"));
  if (wantConnectors) {
    try {
      const connectors = ctx.dep("connectors");
      const rows = await connectors.connectorChecks(ctx);
      for (const row of Array.isArray(rows) ? rows : []) {
        checks.push({ ...row, checkedAt: row.checkedAt || ctx.now() });
      }
    } catch (e) {
      // The group failing is itself a finding, and it degrades to `unknown` for
      // the same reason every other check does: we did not measure a fault, we
      // failed to measure at all.
      checks.push({
        id: "connector.all",
        title: "Marketplace connectors",
        group: "connectors",
        severity: "critical",
        status: "unknown",
        summary: "Connector checks could not run: " + String(e.message || e).slice(0, 120),
        measured: null,
        threshold: "every configured marketplace authenticates",
        checkedAt: ctx.now(),
        ms: 0,
      });
    }
  }

  return {
    startedAt,
    ms: Date.now() - wall,
    checks,
    counts: rollup(checks),
  };
}

module.exports = {
  CHECKS,
  runAll,
  rollup,
  // Pure helpers — exported so the page and the tests share one definition of
  // "worst", "old" and "over the line" instead of each growing their own.
  worstStatus,
  normStatus,
  capItems,
  ageMs,
  fmtAge,
  pct,
  statusForHigh,
  statusForLow,
  statusForAge,
  rotateWindow,
  isRentFarmTitle,
  hasDeliverableStock,
  makeCtx,
  STATUSES,
  STATUS_RANK,
  ITEM_CAP,
  FARM_SERVICE_MARKETS,
  RENT_FARM_TITLE,
  REALISED_CEILING_USD,
  PA_PLATFORM_FLOOR_USD,
  ORDER_GRACE_MS,
  POOL_WARN_BELOW,
  POOL_FAIL_BELOW,
  TOKENLESS_WARN_PCT,
  TOKENLESS_FAIL_PCT,
  LOOP_BUDGETS,
  AUTOLIST_STALE_TICKS,
  GHOST_CONFIRM_CAP,
  STALE_LISTING_CAP,
  CHECK_TIMEOUT_MS,
};
