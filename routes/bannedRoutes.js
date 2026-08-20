const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const MarketplaceListing = require("../models/MarketplaceListing");
const { decrypt } = require("../utils/secretBox");
const accountState = require("../utils/twitchAccountState");

const router = express.Router();

// ------------------------------------------------------------------
// Banned accounts
// ------------------------------------------------------------------
// The Drops Archive has a "Bad tokens" tab, but it answers the wrong question:
// it lumps `suspended` (Twitch deleted the account — terminal, nothing to be
// done) together with `token_invalid` (the token expired — re-auth and it comes
// back), sorts them alphabetically, and offers exactly one action. Alphabetical
// order is the worst possible order for this data: bans arrive in WAVES, and a
// wave is only visible on a time axis.
//
// This module treats a ban as an EVENT with a cost, not a row with a bad flag.
// Every view here is built to answer one of:
//   - when did we lose accounts, and was it a wave or a trickle?
//   - which cohort/host/config did the dead ones come from?
//   - what did the loss cost us (drops, sold accounts, live listings)?
//   - is a given account really gone, or just un-authed?
//
// Read-only by design. Nothing here deletes, delists, or rewrites a config —
// the archive already owns those actions, and a page you open to understand a
// loss should not be able to cause one.

const BANNED = "suspended";
const REAUTHABLE = "token_invalid";
const DEAD_STATUSES = [BANNED, REAUTHABLE];

const DAY_MS = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY_MS);

// ------------------------------------------------------------------
// The pool half of the fleet
// ------------------------------------------------------------------
// A ban can land on an account that lives in EITHER of two collections, and for
// a long time this page only read one of them. `BotAccount` is an account
// deployed into a bot config; `AvailableAccount` is the pool row it was fed
// from. Both carry `suspendedAt`, both are counted by the Telegram alert in
// utils/suspendedAccounts.js (`bots.suspended + pool.suspended`), and only the
// first was counted here — so on 2026-08-18 Telegram reported 67 accounts gone
// while this page reported 0, because that entire wave landed on pool rows.
//
// The union has to be deduped by LOGIN, not by id: the same Twitch account is
// routinely present in both tables at once (50 of those 67 pool rows had a
// BotAccount twin). BotAccount deliberately wins the tie — it carries the
// EARLIER, truer ban date (the pool twin is only stamped whenever the pool's
// once-a-day probe happens to catch up, which was up to 13 days later in that
// wave) plus the drops/sale/listing history a pool row has never had.
//
// Case matters here: 684 of ~3,900 prod BotAccount logins carry capitals while
// `usernameLower` is lowercase by construction, so an `$in` of lowercase logins
// silently misses the capitalised twins and re-admits them as pool-only bans.
// The comparison is therefore done on lowercased values on both sides.

// Returns { banned, population }: the banned pool rows that have no BotAccount
// twin, and how many pool rows are pool-only in total. The population is what
// keeps the headline ban RATE honest — folding extra bans into the numerator
// while leaving the denominator at the BotAccount count alone would report a
// higher ban rate purely as an artefact of having started counting the pool.
//
// Three reads, sized so the union costs the page almost nothing:
//   - the banned pool rows themselves (67 on prod), fetched as documents;
//   - `distinct` for both login sets, because the dedupe only needs the strings
//     and 2k+3.7k short strings are a fraction of the documents they came from.
// A lowercase `$in` deliberately isn't used to narrow the twin lookup: it is
// exactly what makes capitalised twins invisible — measured on prod, an
// exact-case `$in` matched 50 of the 67 banned pool rows while the
// case-insensitive comparison matched all 67. The 17 it missed
// ("BrightPanda1p1v7721", "Wild_Falcon_nkbd", …) would each have been reported
// as a fresh pool-only ban that had in fact already been counted on the bot
// side days earlier.
const POOL_SNAPSHOT_TTL_MS = 30000;
let poolSnapshotCache = { at: 0, value: null };

async function poolOnlySnapshot() {
  // The page fires summary/accounts/analytics concurrently and each one needs
  // this, so without a short memo one page load pays for it three times over —
  // and Atlas's shared tier serialises them rather than overlapping them.
  if (
    poolSnapshotCache.value &&
    Date.now() - poolSnapshotCache.at < POOL_SNAPSHOT_TTL_MS
  ) {
    return poolSnapshotCache.value;
  }
  const [bannedRows, poolLogins, botLogins] = await Promise.all([
    AvailableAccount.find(
      { lastCheckStatus: BANNED },
      {
        username: 1,
        usernameLower: 1,
        twitchId: 1,
        suspendedAt: 1,
        createdAt: 1,
        status: 1,
        lastCheckAt: 1,
        lastCheckStatus: 1,
        lastCheckError: 1,
        dropCount: 1,
        hasPassword: 1,
        email: 1,
      },
    ).lean(),
    AvailableAccount.distinct("usernameLower"),
    BotAccount.distinct("login"),
  ]);
  const taken = new Set(
    botLogins.map((l) => String(l || "").toLowerCase()).filter(Boolean),
  );
  const value = {
    banned: bannedRows.filter(
      (r) => r.usernameLower && !taken.has(r.usernameLower),
    ),
    population: poolLogins.filter(
      (u) => u && !taken.has(String(u).toLowerCase()),
    ).length,
  };
  poolSnapshotCache = { at: Date.now(), value };
  return value;
}

// Present a pool row in the same shape the table already renders for a
// BotAccount, so one list can hold both. The fields a pool row genuinely cannot
// have (host, config, container, drops farmed, sale) are returned empty rather
// than faked — `source: "pool"` is what tells the UI to render them as "never
// deployed" instead of as a zero.
function poolRowShape(a) {
  return {
    source: "pool",
    commitment: "none",
    commitmentLabel: "",
    id: a._id,
    login: a.username || a.usernameLower,
    twitchId: a.twitchId || "",
    host: "",
    configFile: "",
    container: "",
    enabled: false,
    status: BANNED,
    poolStatus: a.status || "",
    suspendedAt: a.suspendedAt,
    createdAt: a.createdAt,
    lastScanAt: a.lastCheckAt || null,
    lastScanError: a.lastCheckError || "",
    ageDays:
      a.suspendedAt && a.createdAt
        ? (a.suspendedAt - a.createdAt) / DAY_MS
        : null,
    dropCount: a.dropCount || 0,
    dropsLogged: 0,
    games: [],
    inProgressCount: 0,
    inProgressGames: [],
    soldAt: null,
    soldToUsername: "",
    soldToBanDays: null,
    hasPassword: !!a.hasPassword,
    credUsername: a.username || "",
    credEmail: decrypt(a.email) || "",
    copiedCount: 0,
    liveListings: [],
  };
}

// Mongo can't be trusted to have a `status` field here: BotAccount declares one
// in the schema but not a single stored document carries it (Mongoose applies
// defaults on hydration, never retroactively). `lastScanStatus` is the field
// that is actually written, so every query in this file uses it.

// DropLog rows are joined by LOGIN, not accountId. The ref is declared in the
// schema but the scanner doesn't populate it on the rows that exist: measured
// on prod, matching all 817 banned accounts by `accountId` returned 0 drops
// while matching the same accounts by `login` returned 17,273. Joining on the
// declared-but-empty field is how you conclude a ban cost you nothing.
async function dropsByLogin(logins) {
  if (!logins.length) return new Map();
  const rows = await DropLog.aggregate([
    { $match: { login: { $in: logins } } },
    {
      $group: {
        _id: "$login",
        drops: { $sum: 1 },
        games: { $addToSet: "$game" },
      },
    },
  ]);
  return new Map(
    rows.map((r) => [
      r._id,
      { drops: r.drops, games: (r.games || []).filter(Boolean) },
    ]),
  );
}

// `soldToUsername` holds two completely different things and reading it as one
// is the same mistake that produced phantom demand in the auto-farmer: the
// marketplace fulfillers write a PLATFORM TAG ("digiseller", "ggsel", …) when
// an account is merely reserved against a live listing, while a real delivery
// writes a buyer's name. On the banned population that split is 792 platform
// reservations against 14 actual deliveries — so treating them alike would
// report ~800 wronged customers where there are about a dozen.
const MARKET_CLAIM_TAGS = [
  "gameflip",
  "ggsel",
  "digiseller",
  "plati",
  "funpay",
  "epicnpc",
  "zeusx",
];

function commitmentOf(soldToUsername) {
  const v = String(soldToUsername || "").trim();
  if (!v) return { kind: "none", label: "" };
  if (MARKET_CLAIM_TAGS.includes(v.toLowerCase())) {
    return { kind: "listing", label: v };
  }
  if (/^bulk:/i.test(v)) return { kind: "bulk", label: v };
  if (/^reseller:/i.test(v)) return { kind: "reseller", label: v };
  return { kind: "buyer", label: v };
}

function esc(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Percentile from a pre-sorted numeric array. Small helper, but it's used for
// the headline "median age at ban" number so it gets to be exact rather than
// an average that one 300-day survivor can drag around.
function pct(sorted, f) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * f));
  return sorted[i];
}

// ------------------------------------------------------------------
// GET /banned/summary — the headline numbers + the wave timeline
// ------------------------------------------------------------------
router.get("/banned/summary", requireSuperadmin, async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 90, 7), 365);

    // Two aggregations, not twelve queries. Prod's Mongo is an Atlas shared
    // tier that serialises concurrent operations (~230ms each even when they're
    // issued in parallel), so the win here is round trips, not concurrency —
    // the naive version of this handler took 5s wall-clock for numbers that
    // fit in two pipelines.
    const [statusRows, facet, poolRows] = await Promise.all([
      BotAccount.aggregate([
        {
          $group: {
            _id: "$lastScanStatus",
            n: { $sum: 1 },
            // A ban with no date can't appear on the timeline. Counted here so
            // the chart can admit what it isn't showing.
            noDate: {
              $sum: { $cond: [{ $eq: ["$suspendedAt", null] }, 1, 0] },
            },
          },
        },
      ]),
      BotAccount.aggregate([
        // Scoped to accounts that are STILL banned, not merely to rows that
        // carry a date. `suspendedAt` is written with `acc.suspendedAt || now`
        // and is never cleared when an account comes back, so an account that
        // was suspended and later recovered keeps its stamp forever — matching
        // on the date alone would leave it on the ban timeline for good. Every
        // dated row happens to still be banned on prod today (817/817), so this
        // costs nothing now and stops the chart drifting later.
        { $match: { lastScanStatus: BANNED, suspendedAt: { $ne: null } } },
        {
          $project: {
            suspendedAt: 1,
            ageDays: {
              $divide: [{ $subtract: ["$suspendedAt", "$createdAt"] }, DAY_MS],
            },
          },
        },
        {
          $facet: {
            series: [
              { $match: { suspendedAt: { $gte: daysAgo(days) } } },
              {
                $group: {
                  _id: {
                    $dateToString: {
                      format: "%Y-%m-%d",
                      date: "$suspendedAt",
                    },
                  },
                  n: { $sum: 1 },
                },
              },
              { $sort: { _id: 1 } },
            ],
            d1: [
              { $match: { suspendedAt: { $gte: daysAgo(1) } } },
              { $count: "n" },
            ],
            d7: [
              { $match: { suspendedAt: { $gte: daysAgo(7) } } },
              { $count: "n" },
            ],
            d30: [
              { $match: { suspendedAt: { $gte: daysAgo(30) } } },
              { $count: "n" },
            ],
            ages: [
              { $match: { ageDays: { $gte: 0 } } },
              { $sort: { ageDays: 1 } },
              { $group: { _id: null, v: { $push: "$ageDays" } } },
            ],
            span: [
              {
                $group: {
                  _id: null,
                  first: { $min: "$suspendedAt" },
                  last: { $max: "$suspendedAt" },
                },
              },
            ],
          },
        },
      ]),
      poolOnlySnapshot(),
    ]);

    const byStatus = new Map(statusRows.map((r) => [r._id, r]));
    const get = (k) => (byStatus.get(k) ? byStatus.get(k).n : 0);

    const f = facet[0] || {};
    const one = (arr) => (arr && arr[0] ? arr[0].n : 0);
    const span = f.span && f.span[0] ? f.span[0] : {};

    // Fold the pool-only bans into every headline number. Done here in JS
    // rather than with a $unionWith so the two collections keep their own
    // indexes and their own (differently named) status fields, and so the
    // bot/pool split stays reportable instead of being flattened away.
    const poolBanned = poolRows.banned;
    const poolDated = poolBanned.filter((r) => r.suspendedAt);
    const cutoff = { d1: daysAgo(1), d7: daysAgo(7), d30: daysAgo(30) };
    const poolSince = (from) =>
      poolDated.filter((r) => r.suspendedAt >= from).length;

    const totals = {
      total: statusRows.reduce((s, r) => s + r.n, 0) + poolRows.population,
      banned: get(BANNED) + poolBanned.length,
      reauthable: get(REAUTHABLE),
      healthy: get("ok"),
    };
    // Kept split so the page can say WHERE the losses landed — a wave that hits
    // only pool rows means accounts dying before they ever farmed, which is a
    // different problem from a wave that hits deployed bots.
    const sources = {
      bot: get(BANNED),
      pool: poolBanned.length,
      botPopulation: statusRows.reduce((s, r) => s + r.n, 0),
      poolPopulation: poolRows.population,
    };
    const bannedNoDate =
      (byStatus.get(BANNED) ? byStatus.get(BANNED).noDate : 0) +
      (poolBanned.length - poolDated.length);

    const seriesBy = new Map(
      (f.series || []).map((r) => [r._id, { bot: r.n, pool: 0 }]),
    );
    const from = daysAgo(days);
    for (const r of poolDated) {
      if (r.suspendedAt < from) continue;
      const day = r.suspendedAt.toISOString().slice(0, 10);
      if (!seriesBy.has(day)) seriesBy.set(day, { bot: 0, pool: 0 });
      seriesBy.get(day).pool++;
    }
    const series = [...seriesBy.entries()]
      .map(([day, v]) => ({ day, n: v.bot + v.pool, bot: v.bot, pool: v.pool }))
      .sort((a, b) => (a.day < b.day ? -1 : 1));

    // Pool rows are real bans with real birthdays, so they belong in the
    // age-at-ban percentiles too; merging then re-sorting keeps `pct` exact.
    const ages = (f.ages && f.ages[0] ? f.ages[0].v : []).slice();
    for (const r of poolDated) {
      if (!r.createdAt) continue;
      const d = (r.suspendedAt - r.createdAt) / DAY_MS;
      if (d >= 0) ages.push(d);
    }
    ages.sort((a, b) => a - b);

    const poolFirst = poolDated.reduce(
      (m, r) => (!m || r.suspendedAt < m ? r.suspendedAt : m),
      null,
    );
    const poolLast = poolDated.reduce(
      (m, r) => (!m || r.suspendedAt > m ? r.suspendedAt : m),
      null,
    );
    const minDate = (a, b) => (!a ? b : !b ? a : a < b ? a : b);
    const maxDate = (a, b) => (!a ? b : !b ? a : a > b ? a : b);

    const biggest = series.reduce(
      (best, r) => (!best || r.n > best.n ? { day: r.day, n: r.n } : best),
      null,
    );

    res.json({
      success: true,
      totals,
      sources,
      rate: totals.total ? (totals.banned / totals.total) * 100 : 0,
      recent: {
        d1: one(f.d1) + poolSince(cutoff.d1),
        d7: one(f.d7) + poolSince(cutoff.d7),
        d30: one(f.d30) + poolSince(cutoff.d30),
      },
      series,
      ageAtBan: {
        n: ages.length,
        p10: pct(ages, 0.1),
        median: pct(ages, 0.5),
        p90: pct(ages, 0.9),
      },
      biggestDay: biggest,
      firstBanAt: minDate(span.first || null, poolFirst),
      lastBanAt: maxDate(span.last || null, poolLast),
      bannedNoDate,
    });
  } catch (err) {
    console.error("banned summary error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// GET /banned/accounts — the list
// ------------------------------------------------------------------
// Sorted newest-ban-first by default, which is the order that makes a wave
// obvious. Every filter is optional and composable.
router.get("/banned/accounts", requireSuperadmin, async (req, res) => {
  try {
    const status = String(req.query.status || BANNED);
    const q = {};
    if (status === "all_dead") q.lastScanStatus = { $in: DEAD_STATUSES };
    else if (status === "any") {
      /* no status filter */
    } else q.lastScanStatus = status;

    const host = String(req.query.host || "").trim();
    if (host) q.host = host;

    const configFile = String(req.query.configFile || "").trim();
    if (configFile) q.configFile = configFile;

    const sold = String(req.query.sold || "");
    if (sold === "yes") q.soldAt = { $ne: null };
    else if (sold === "no") q.soldAt = null;

    const since = Number(req.query.since) || 0;
    if (since) q.suspendedAt = { $gte: daysAgo(since) };

    const search = String(req.query.search || "").trim();
    if (search) {
      const re = new RegExp(esc(search), "i");
      q.$or = [
        { login: re },
        { credUsername: re },
        { configFile: re },
        { container: re },
        { twitchId: re },
      ];
    }

    const sortKey = String(req.query.sort || "suspendedAt");
    const dir = String(req.query.dir || "desc") === "asc" ? 1 : -1;
    const ALLOWED_SORT = [
      "suspendedAt",
      "createdAt",
      "login",
      "dropCount",
      "lastScanAt",
      "soldAt",
      "host",
      "configFile",
    ];
    const sortField = ALLOWED_SORT.includes(sortKey) ? sortKey : "suspendedAt";
    const sort = {};
    sort[sortField] = dir;
    // `_id` breaks ties, and without it this table silently loses rows. Bans are
    // stamped by a bulk `updateMany`, so a whole wave shares one identical
    // `suspendedAt` down to the millisecond — 664 accounts on 2026-08-05 alone.
    // Mongo is free to order equal keys differently for each skip/limit call, so
    // paging through the default sort returned some rows twice and never
    // returned others at all: walking all 9 pages of the 817 banned accounts
    // yielded 673 unique rows with 144 duplicates. A unique tiebreaker makes the
    // order total, and therefore the pagination complete.
    sort._id = dir;

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    // Which half of the fleet to list. Default `all` because the page exists to
    // answer "how many did we lose", and for a long time it answered that with
    // deployed bots only — the 2026-08-18 wave of 67 pool bans showed up here
    // as zero. `bot`/`pool` stay available for isolating one side.
    const source = String(req.query.source || "all");
    const wantsBanned =
      status === BANNED || status === "any" || status === "all_dead";
    // A pool row was never deployed, so it has no host, no config file, no
    // container and no sale. Any filter on those fields is by definition a
    // filter for deployed accounts, and matching pool rows against it would be
    // inventing data — they are excluded rather than defaulted.
    const poolEligible =
      source !== "bot" && wantsBanned && !host && !configFile && sold !== "yes";

    let poolMatches = [];
    if (poolEligible) {
      const snap = await poolOnlySnapshot();
      const cutoff = since ? daysAgo(since) : null;
      const re = search ? new RegExp(esc(search), "i") : null;
      poolMatches = snap.banned.filter((r) => {
        if (cutoff && !(r.suspendedAt && r.suspendedAt >= cutoff)) return false;
        if (re && !(re.test(r.username || "") || re.test(r.twitchId || ""))) {
          return false;
        }
        return true;
      });
    }

    const wantsBot = source !== "pool";
    const botTotal = wantsBot ? await BotAccount.countDocuments(q) : 0;
    const total = botTotal + poolMatches.length;

    const PROJECTION = {
      login: 1,
      twitchId: 1,
      host: 1,
      configFile: 1,
      container: 1,
      enabled: 1,
      dropCount: 1,
      inProgressCount: 1,
      inProgressGames: 1,
      lastScanAt: 1,
      lastScanStatus: 1,
      lastScanError: 1,
      suspendedAt: 1,
      createdAt: 1,
      soldAt: 1,
      soldToUsername: 1,
      soldSetId: 1,
      hasPassword: 1,
      credUsername: 1,
      credEmail: 1,
      copiedCount: 1,
    };

    // Two collections cannot share one Mongo cursor, so the page has to be cut
    // after the merge. The bot side is still bounded: nothing beyond the first
    // `page * limit` bot rows can possibly land on or before the requested
    // page, however the few pool rows interleave. With no pool rows in play the
    // original skip/limit path is kept verbatim, so the common case pays
    // nothing for the union.
    let botRows = [];
    if (wantsBot) {
      const query = BotAccount.find(q, PROJECTION).sort(sort);
      botRows = poolMatches.length
        ? await query.limit(page * limit).lean()
        : await query
            .skip((page - 1) * limit)
            .limit(limit)
            .lean();
    }

    let pageRows;
    if (!poolMatches.length) {
      pageRows = botRows.map((doc) => ({ kind: "bot", doc }));
    } else {
      const merged = botRows
        .map((doc) => ({ kind: "bot", doc, key: doc[sortField] }))
        .concat(
          poolMatches.map((doc) => ({
            kind: "pool",
            doc,
            // The pool's field names differ from the bot's for the same idea;
            // mapping them here is what lets one comparator sort both.
            key:
              sortField === "login"
                ? doc.username
                : sortField === "lastScanAt"
                  ? doc.lastCheckAt
                  : sortField === "host" || sortField === "configFile"
                    ? ""
                    : sortField === "soldAt"
                      ? null
                      : doc[sortField],
          })),
        );
      const rank = (v) => {
        if (v === null || v === undefined || v === "") return null;
        return v instanceof Date ? v.getTime() : v;
      };
      const cmpId = (a, b) => {
        const x = String(a.doc._id);
        const y = String(b.doc._id);
        return x < y ? -dir : x > y ? dir : 0;
      };
      merged.sort((a, b) => {
        const x = rank(a.key);
        const y = rank(b.key);
        // Nulls last in both directions: a row with no ban date is missing
        // data, not the oldest ban in the fleet.
        if (x === null && y === null) return cmpId(a, b);
        if (x === null) return 1;
        if (y === null) return -1;
        if (x < y) return -dir;
        if (x > y) return dir;
        // Same tiebreaker as the Mongo sort above, for the same reason: a whole
        // ban wave shares one timestamp, and an unstable order across pages
        // drops rows.
        return cmpId(a, b);
      });
      pageRows = merged.slice((page - 1) * limit, page * limit);
    }

    // Enrich the PAGE only — never the whole population. Two extra round trips
    // for up to 500 rows beats 500 round trips, and both are indexed lookups.
    // Only bot rows need it: a pool row has never farmed a drop and has never
    // been attached to a listing, so there is nothing to look up.
    const botPage = pageRows.filter((r) => r.kind === "bot").map((r) => r.doc);
    const ids = botPage.map((r) => String(r._id));
    const logins = botPage.map((r) => r.login).filter(Boolean);
    const [dropsBy, listingRows] = await Promise.all([
      dropsByLogin(logins),
      // Matched on id AND login: id is what the auto-delivery fulfillers write,
      // login is the only handle the older rows carry.
      ids.length || logins.length
        ? MarketplaceListing.find(
            {
              status: "active",
              $or: [
                { accountId: { $in: ids } },
                { accountLogin: { $in: logins } },
                { "units.accountId": { $in: ids } },
                { "units.login": { $in: logins } },
              ],
            },
            {
              accountId: 1,
              accountLogin: 1,
              units: 1,
              marketplace: 1,
              title: 1,
              url: 1,
              price: 1,
            },
          ).lean()
        : [],
    ]);

    // A listing can reference an account either directly (Gameflip/ZeusX
    // single-account auto-delivery) or through a Digiseller unit. Key the
    // index by both id and login so either kind of row finds its account.
    const listingsBy = new Map();
    const addListing = (key, l) => {
      if (!key) return;
      if (!listingsBy.has(key)) listingsBy.set(key, []);
      const bucket = listingsBy.get(key);
      if (
        bucket.some(
          (x) => x.title === l.title && x.marketplace === l.marketplace,
        )
      ) {
        return;
      }
      bucket.push({
        marketplace: l.marketplace,
        title: l.title,
        url: l.url,
        price: l.price,
      });
    };
    for (const l of listingRows) {
      addListing(l.accountId ? String(l.accountId) : "", l);
      addListing(l.accountLogin || "", l);
      for (const u of l.units || []) {
        addListing(u.accountId ? String(u.accountId) : "", l);
        addListing(u.login || "", l);
      }
    }

    res.json({
      success: true,
      total,
      page,
      limit,
      sources: { bot: botTotal, pool: poolMatches.length },
      accounts: pageRows.map((row) => {
        if (row.kind === "pool") return poolRowShape(row.doc);
        const a = row.doc;
        const d = dropsBy.get(a.login) || { drops: 0, games: [] };
        const seenListing = new Set();
        const live = (listingsBy.get(String(a._id)) || [])
          .concat(listingsBy.get(a.login) || [])
          .filter((l) => {
            const k = l.marketplace + "|" + l.title;
            if (seenListing.has(k)) return false;
            seenListing.add(k);
            return true;
          });
        const ageDays =
          a.suspendedAt && a.createdAt
            ? (a.suspendedAt - a.createdAt) / DAY_MS
            : null;
        // The number that turns a ban into a refund risk: an account banned
        // days after it was handed to a buyer is a dispute waiting to happen.
        const soldToBanDays =
          a.suspendedAt && a.soldAt
            ? (a.suspendedAt - a.soldAt) / DAY_MS
            : null;
        const commit = commitmentOf(a.soldToUsername);
        return {
          source: "bot",
          commitment: commit.kind,
          commitmentLabel: commit.label,
          id: a._id,
          login: a.login,
          twitchId: a.twitchId || "",
          host: a.host || "local",
          configFile: a.configFile || "",
          container: a.container || "",
          enabled: !!a.enabled,
          status: a.lastScanStatus,
          suspendedAt: a.suspendedAt,
          createdAt: a.createdAt,
          lastScanAt: a.lastScanAt,
          lastScanError: a.lastScanError || "",
          ageDays,
          dropCount: a.dropCount || 0,
          dropsLogged: d.drops,
          games: d.games.slice(0, 12),
          inProgressCount: a.inProgressCount || 0,
          inProgressGames: a.inProgressGames || [],
          soldAt: a.soldAt,
          soldToUsername: a.soldToUsername || "",
          soldToBanDays,
          hasPassword: !!a.hasPassword,
          credUsername: a.credUsername || "",
          credEmail: decrypt(a.credEmail) || "",
          copiedCount: a.copiedCount || 0,
          liveListings: live,
        };
      }),
    });
  } catch (err) {
    console.error("banned accounts error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// GET /banned/analytics — where the dead accounts came from
// ------------------------------------------------------------------
// Raw ban counts are almost useless on their own: the host running 3000
// accounts will always "lose more" than the one running 300. Everything here is
// a RATE against that group's own population, which is the only form in which
// "this config is dying faster than the others" is a real finding.
router.get("/banned/analytics", requireSuperadmin, async (req, res) => {
  try {
    const groupRates = async (field) => {
      const rows = await BotAccount.aggregate([
        {
          $group: {
            _id: "$" + field,
            total: { $sum: 1 },
            banned: {
              $sum: { $cond: [{ $eq: ["$lastScanStatus", BANNED] }, 1, 0] },
            },
            reauthable: {
              $sum: { $cond: [{ $eq: ["$lastScanStatus", REAUTHABLE] }, 1, 0] },
            },
          },
        },
        { $sort: { banned: -1 } },
        { $limit: 60 },
      ]);
      return rows.map((r) => ({
        key: r._id || "(none)",
        total: r.total,
        banned: r.banned,
        reauthable: r.reauthable,
        rate: r.total ? (r.banned / r.total) * 100 : 0,
      }));
    };

    // Survival by intake cohort: of everything that entered the rig on day X,
    // what share is dead now? This is the view that tells you whether a
    // particular batch of accounts was born bad.
    const cohorts = await BotAccount.aggregate([
      { $match: { createdAt: { $gte: daysAgo(120) } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          total: { $sum: 1 },
          banned: {
            $sum: { $cond: [{ $eq: ["$lastScanStatus", BANNED] }, 1, 0] },
          },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    // Age-at-ban histogram, bucketed the way the question is actually asked:
    // "did it die before it earned anything back?"
    //
    // Pool-only bans are folded in for the same reason the summary's
    // percentiles include them: they are real accounts with a real birthday and
    // a real death, and this histogram sits on the same page as a median that
    // already counts them. Two panels describing one population off two
    // different denominators is how a page stops being trusted.
    const [agedBots, poolSnap] = await Promise.all([
      BotAccount.find(
        {
          lastScanStatus: BANNED,
          suspendedAt: { $ne: null },
          createdAt: { $ne: null },
        },
        { suspendedAt: 1, createdAt: 1 },
      ).lean(),
      poolOnlySnapshot(),
    ]);
    const aged = agedBots.concat(
      poolSnap.banned.filter((r) => r.suspendedAt && r.createdAt),
    );
    const BUCKETS = [
      { label: "< 1d", max: 1 },
      { label: "1-3d", max: 3 },
      { label: "3-7d", max: 7 },
      { label: "1-2w", max: 14 },
      { label: "2-4w", max: 30 },
      { label: "1-3m", max: 90 },
      { label: "3m+", max: Infinity },
    ];
    const hist = BUCKETS.map((b) => ({ label: b.label, n: 0 }));
    for (const a of aged) {
      const d = (a.suspendedAt - a.createdAt) / DAY_MS;
      if (d < 0) continue;
      hist[BUCKETS.findIndex((b) => d < b.max)].n++;
    }

    // Where the dead accounts were committed. NOT a "who did we wrong" list —
    // most of these are platform reservation tags, so the split between a
    // marketplace hold and a real buyer is the whole point (see commitmentOf).
    const commitRows = await BotAccount.aggregate([
      { $match: { lastScanStatus: BANNED } },
      { $group: { _id: "$soldToUsername", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
    const commitment = {
      listing: [],
      buyer: [],
      bulk: [],
      reseller: [],
      none: 0,
    };
    for (const r of commitRows) {
      const c = commitmentOf(r._id);
      if (c.kind === "none") commitment.none += r.n;
      else commitment[c.kind].push({ label: c.label, n: r.n });
    }

    // configFile is deliberately NOT offered as a breakdown: retiring a
    // suspended account clears its bot placement, so every banned row has an
    // empty configFile (verified on prod: 817/817). A "ban rate by config"
    // chart built on that field would show one meaningless 100% bucket.
    const byHost = await groupRates("host");

    res.json({
      success: true,
      byHost,
      commitment,
      cohorts: cohorts.map((c) => ({
        day: c._id,
        total: c.total,
        banned: c.banned,
        rate: c.total ? (c.banned / c.total) * 100 : 0,
      })),
      ageHistogram: hist,
    });
  } catch (err) {
    console.error("banned analytics error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// GET /banned/exposure — what the bans are costing right now
// ------------------------------------------------------------------
// The two cases that need a human today:
//   1. a banned account is attached to a LIVE listing — the next buyer pays for
//      a dead account, so this is a delist-now list;
//   2. a banned account was already DELIVERED — the buyer may already be
//      holding something worthless, and if the ban landed shortly after the
//      sale it is very likely to come back as a dispute.
router.get("/banned/exposure", requireSuperadmin, async (req, res) => {
  try {
    const banned = await BotAccount.find(
      { lastScanStatus: BANNED },
      { login: 1, suspendedAt: 1, soldAt: 1, soldToUsername: 1, dropCount: 1 },
    ).lean();
    const byId = new Map(banned.map((a) => [String(a._id), a]));
    const ids = banned.map((a) => String(a._id));

    const bannedLogins = banned.map((a) => a.login).filter(Boolean);
    const byLogin = new Map(banned.map((a) => [a.login, a]));

    const listings = await MarketplaceListing.find(
      {
        status: "active",
        $or: [
          { accountId: { $in: ids } },
          { accountLogin: { $in: bannedLogins } },
          { "units.accountId": { $in: ids } },
          { "units.login": { $in: bannedLogins } },
        ],
      },
      {
        marketplace: 1,
        title: 1,
        url: 1,
        price: 1,
        currency: 1,
        accountId: 1,
        accountLogin: 1,
        units: 1,
        origin: 1,
        createdAt: 1,
      },
    ).lean();

    const live = [];
    for (const l of listings) {
      // Collect the banned accounts this listing touches, by whichever handle
      // the row happens to carry.
      const hit = new Map();
      const note = (acc) => {
        if (acc) hit.set(String(acc._id), acc);
      };
      if (l.accountId) note(byId.get(String(l.accountId)));
      if (l.accountLogin) note(byLogin.get(l.accountLogin));
      for (const u of l.units || []) {
        if (u.accountId) note(byId.get(String(u.accountId)));
        if (u.login) note(byLogin.get(u.login));
      }
      for (const [id, acc] of hit) {
        live.push({
          marketplace: l.marketplace,
          title: l.title,
          url: l.url,
          price: l.price,
          currency: l.currency || "USD",
          origin: l.origin,
          listedAt: l.createdAt,
          login: acc.login,
          accountId: id,
          suspendedAt: acc.suspendedAt,
        });
      }
    }

    // Committed-then-banned, split by what the commitment actually was. A
    // platform reservation that died is lost stock; a delivered account that
    // died is a wronged customer. Reporting the first as the second is how you
    // manufacture a crisis out of ordinary shrinkage.
    const committed = banned
      .filter((a) => a.soldAt)
      .map((a) => {
        const c = commitmentOf(a.soldToUsername);
        return {
          login: a.login,
          soldAt: a.soldAt,
          soldToUsername: a.soldToUsername || "",
          commitment: c.kind,
          suspendedAt: a.suspendedAt,
          dropCount: a.dropCount || 0,
          daysAfterSale:
            a.suspendedAt && a.soldAt
              ? (a.suspendedAt - a.soldAt) / DAY_MS
              : null,
        };
      })
      .sort((x, y) => (y.suspendedAt || 0) - (x.suspendedAt || 0));

    const deliveredRows = committed.filter(
      (r) => r.commitment === "buyer" || r.commitment === "bulk",
    );
    const reservedRows = committed.filter((r) => r.commitment === "listing");

    // Drops that died with the accounts. Matched on LOGIN — DropLog.accountId
    // is declared but not populated (see dropsByLogin).
    const lost = await DropLog.aggregate([
      { $match: { login: { $in: bannedLogins } } },
      { $group: { _id: "$game", n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 25 },
    ]);
    const lostTotal = lost.reduce((s, r) => s + r.n, 0);

    res.json({
      success: true,
      liveListings: live.sort((a, b) => (b.price || 0) - (a.price || 0)),
      liveValue: live.reduce((s, r) => s + (r.price || 0), 0),
      // Actually handed to someone. This is the chargeback list.
      delivered: deliveredRows,
      deliveredFast: deliveredRows.filter(
        (r) => r.daysAfterSale != null && r.daysAfterSale <= 14,
      ).length,
      // Held against a marketplace listing when they died — lost stock, no
      // customer involved.
      reserved: reservedRows.slice(0, 300),
      reservedTotal: reservedRows.length,
      lostDropsTotal: lostTotal,
      lostDropsByGame: lost.map((r) => ({
        game: r._id || "(unknown)",
        n: r.n,
      })),
    });
  } catch (err) {
    console.error("banned exposure error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// GET /banned/account/:id — one account's full story
// ------------------------------------------------------------------
router.get("/banned/account/:id", requireSuperadmin, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Bad id" });
    }
    const a = await BotAccount.findById(req.params.id).lean();
    // The list can now hand back pool rows, so their ids have to resolve here
    // too or clicking one of them 404s. A pool row has no drops, no listings
    // and no config peers by definition — there is nothing to join, which is
    // itself the answer: this account died before it ever earned anything.
    if (!a) {
      const p = await AvailableAccount.findById(req.params.id).lean();
      if (!p) {
        return res.status(404).json({ success: false, message: "Not found" });
      }
      return res.json({
        success: true,
        account: {
          source: "pool",
          id: p._id,
          login: p.username || p.usernameLower,
          twitchId: p.twitchId || "",
          uniqueId: p.uniqueId || "",
          host: "",
          configFile: "",
          container: "",
          enabled: false,
          status: p.lastCheckStatus,
          poolStatus: p.status || "",
          lastScanAt: p.lastCheckAt,
          lastScanError: p.lastCheckError || "",
          suspendedAt: p.suspendedAt,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          dropCount: p.dropCount || 0,
          inProgressCount: 0,
          inProgressGames: [],
          farmingCompleteAt: null,
          soldAt: null,
          soldToUsername: "",
          soldSetId: "",
          soldPurchaseId: "",
          soldBulkOrderId: "",
          hasPassword: !!p.hasPassword,
          credUsername: p.username || "",
          credEmail: decrypt(p.email) || "",
          copiedCount: 0,
          lastCopiedAt: null,
          poolSource: p.source || "",
        },
        drops: [],
        listings: [],
        configPeers: [],
      });
    }

    const [drops, listings, siblings] = await Promise.all([
      DropLog.find(
        { login: a.login },
        { name: 1, game: 1, campaign: 1, awardedAt: 1, soldAt: 1, state: 1 },
      )
        .sort({ awardedAt: -1 })
        .limit(300)
        .lean(),
      MarketplaceListing.find(
        {
          $or: [
            { accountId: String(a._id) },
            { accountLogin: a.login },
            { "units.accountId": String(a._id) },
            { "units.login": a.login },
          ],
        },
        { marketplace: 1, title: 1, url: 1, price: 1, status: 1, createdAt: 1 },
      ).lean(),
      // Accounts that shared this one's config file, and how they fared. If a
      // whole container went down together, this is where it shows.
      a.configFile
        ? BotAccount.aggregate([
            { $match: { configFile: a.configFile, host: a.host || "local" } },
            { $group: { _id: "$lastScanStatus", n: { $sum: 1 } } },
          ])
        : Promise.resolve([]),
    ]);

    res.json({
      success: true,
      account: {
        id: a._id,
        login: a.login,
        twitchId: a.twitchId || "",
        uniqueId: a.uniqueId || "",
        host: a.host || "local",
        configFile: a.configFile || "",
        container: a.container || "",
        enabled: !!a.enabled,
        status: a.lastScanStatus,
        lastScanAt: a.lastScanAt,
        lastScanError: a.lastScanError || "",
        suspendedAt: a.suspendedAt,
        createdAt: a.createdAt,
        updatedAt: a.updatedAt,
        dropCount: a.dropCount || 0,
        inProgressCount: a.inProgressCount || 0,
        inProgressGames: a.inProgressGames || [],
        farmingCompleteAt: a.farmingCompleteAt,
        soldAt: a.soldAt,
        soldToUsername: a.soldToUsername || "",
        soldSetId: a.soldSetId || "",
        soldPurchaseId: a.soldPurchaseId || "",
        soldBulkOrderId: a.soldBulkOrderId || "",
        hasPassword: !!a.hasPassword,
        credUsername: a.credUsername || "",
        credEmail: decrypt(a.credEmail) || "",
        copiedCount: a.copiedCount || 0,
        lastCopiedAt: a.lastCopiedAt,
      },
      drops: drops.map((d) => ({
        name: d.name,
        game: d.game,
        campaign: d.campaign,
        awardedAt: d.awardedAt,
        soldAt: d.soldAt,
        state: d.state,
      })),
      listings,
      configPeers: siblings.map((s) => ({
        status: s._id || "unknown",
        n: s.n,
      })),
    });
  } catch (err) {
    console.error("banned account error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// POST /banned/recheck — ask Twitch, don't guess
// ------------------------------------------------------------------
// utils/twitchAccountState probes the PUBLIC user query, so this needs no token
// and can't be fooled by an expired one: a live account returns a user, a
// suspended/deleted one returns null, and anything else (429, 5xx, network) is
// UNKNOWN and reported as such.
//
// Deliberately REPORT-ONLY. It never writes lastScanStatus or suspendedAt —
// this page exists to explain losses, and a viewer that can silently reclassify
// accounts is a viewer that can cause one. Act on a surprise in the archive.
router.post("/banned/recheck", requireSuperadmin, async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const valid = ids
      .filter((id) => mongoose.Types.ObjectId.isValid(id))
      .slice(0, 40);
    if (!valid.length) {
      return res.status(400).json({ success: false, message: "No accounts" });
    }
    // Ids can now come from either collection, so both are asked. Normalised to
    // one shape here so the probe loop below stays indifferent to which table a
    // given account came out of.
    const [botRows, poolRows] = await Promise.all([
      BotAccount.find({ _id: { $in: valid } }, { login: 1, lastScanStatus: 1 })
        .lean()
        .then((rs) => rs.map((r) => ({ ...r, source: "bot" }))),
      AvailableAccount.find(
        { _id: { $in: valid } },
        { username: 1, usernameLower: 1, lastCheckStatus: 1 },
      )
        .lean()
        .then((rs) =>
          rs.map((r) => ({
            _id: r._id,
            login: r.username || r.usernameLower,
            lastScanStatus: r.lastCheckStatus,
            source: "pool",
          })),
        ),
    ]);
    const rows = botRows.concat(poolRows);

    const results = [];
    // Sequential on purpose: 40 probes at 20s worst case still beats being
    // rate-limited into a wall of UNKNOWNs that mean nothing.
    for (const r of rows) {
      const verdict = await accountState.probeAccount(r.login);
      results.push({
        id: r._id,
        login: r.login,
        source: r.source,
        stored: r.lastScanStatus,
        verdict,
        // The interesting row: we have it filed as banned but Twitch still
        // serves the profile.
        disagrees: verdict === "exists" && r.lastScanStatus === BANNED,
      });
    }
    res.json({
      success: true,
      results,
      disagreements: results.filter((r) => r.disagrees).length,
    });
  } catch (err) {
    console.error("banned recheck error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// GET /banned/export.csv — the whole filtered set, not just the page
// ------------------------------------------------------------------
router.get("/banned/export.csv", requireSuperadmin, async (req, res) => {
  try {
    const status = String(req.query.status || BANNED);
    const q =
      status === "all_dead"
        ? { lastScanStatus: { $in: DEAD_STATUSES } }
        : status === "any"
          ? {}
          : { lastScanStatus: status };
    const source = String(req.query.source || "all");
    const wantsBanned =
      status === BANNED || status === "any" || status === "all_dead";
    const [botRows, poolSnap] = await Promise.all([
      source === "pool"
        ? []
        : BotAccount.find(q, {
            login: 1,
            twitchId: 1,
            host: 1,
            configFile: 1,
            container: 1,
            lastScanStatus: 1,
            lastScanError: 1,
            suspendedAt: 1,
            createdAt: 1,
            lastScanAt: 1,
            dropCount: 1,
            soldAt: 1,
            soldToUsername: 1,
            hasPassword: 1,
            credUsername: 1,
          })
            .sort({ suspendedAt: -1 })
            .limit(20000)
            .lean(),
      source !== "bot" && wantsBanned
        ? poolOnlySnapshot()
        : Promise.resolve({ banned: [] }),
    ]);
    // The export has to agree with the table it was exported from, so the pool
    // half comes along — flagged in its own column rather than silently blended,
    // because a pool row's empty host/config/drops mean "never deployed", not
    // "deployed and produced nothing".
    const rows = botRows
      .map((a) => ({ ...a, __source: "bot" }))
      .concat(
        poolSnap.banned.map((a) => ({
          __source: "pool",
          login: a.username || a.usernameLower,
          twitchId: a.twitchId,
          host: "",
          configFile: "",
          container: "",
          lastScanStatus: BANNED,
          lastScanError: a.lastCheckError,
          suspendedAt: a.suspendedAt,
          createdAt: a.createdAt,
          lastScanAt: a.lastCheckAt,
          dropCount: a.dropCount,
          soldAt: null,
          soldToUsername: "",
          hasPassword: a.hasPassword,
          credUsername: a.username,
        })),
      )
      .sort((x, y) => (y.suspendedAt || 0) - (x.suspendedAt || 0));

    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const iso = (d) => (d ? new Date(d).toISOString() : "");
    const header = [
      "login",
      "source",
      "twitchId",
      "status",
      "bannedAt",
      "createdAt",
      "ageAtBanDays",
      "host",
      "configFile",
      "container",
      "drops",
      "soldAt",
      "soldTo",
      "daysSoldToBan",
      "hasPassword",
      "credUsername",
      "lastScanAt",
      "lastScanError",
    ];
    const lines = [header.join(",")];
    for (const a of rows) {
      const age =
        a.suspendedAt && a.createdAt
          ? ((a.suspendedAt - a.createdAt) / DAY_MS).toFixed(2)
          : "";
      const sold =
        a.suspendedAt && a.soldAt
          ? ((a.suspendedAt - a.soldAt) / DAY_MS).toFixed(2)
          : "";
      lines.push(
        [
          a.login,
          a.__source,
          a.twitchId,
          a.lastScanStatus,
          iso(a.suspendedAt),
          iso(a.createdAt),
          age,
          a.host || "local",
          a.configFile,
          a.container,
          a.dropCount || 0,
          iso(a.soldAt),
          a.soldToUsername,
          sold,
          a.hasPassword ? "yes" : "no",
          a.credUsername,
          iso(a.lastScanAt),
          a.lastScanError,
        ]
          .map(cell)
          .join(","),
      );
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="banned-accounts-' +
        new Date().toISOString().slice(0, 10) +
        '.csv"',
    );
    res.send(lines.join("\n"));
  } catch (err) {
    console.error("banned export error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Host list for the filter dropdown — derived from the data so it can't drift
// out of sync with whatever hosts actually exist.
router.get("/banned/facets", requireSuperadmin, async (req, res) => {
  try {
    const [hosts, configs] = await Promise.all([
      BotAccount.distinct("host", { lastScanStatus: { $in: DEAD_STATUSES } }),
      BotAccount.distinct("configFile", { lastScanStatus: BANNED }),
    ]);
    res.json({
      success: true,
      hosts: hosts.filter(Boolean).sort(),
      configs: configs.filter(Boolean).sort(),
    });
  } catch (err) {
    console.error("banned facets error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
// Exported on the router object for the focused classification test; Express
// still receives the same callable router value.
module.exports.commitmentOf = commitmentOf;
