const express = require("express");
const mongoose = require("mongoose");

const { requireSuperadmin } = require("../middleware/auth");
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
    const [statusRows, facet] = await Promise.all([
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
        { $match: { suspendedAt: { $ne: null } } },
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
    ]);

    const byStatus = new Map(statusRows.map((r) => [r._id, r]));
    const get = (k) => (byStatus.get(k) ? byStatus.get(k).n : 0);
    const totals = {
      total: statusRows.reduce((s, r) => s + r.n, 0),
      banned: get(BANNED),
      reauthable: get(REAUTHABLE),
      healthy: get("ok"),
    };
    const bannedNoDate = byStatus.get(BANNED) ? byStatus.get(BANNED).noDate : 0;

    const f = facet[0] || {};
    const one = (arr) => (arr && arr[0] ? arr[0].n : 0);
    const series = f.series || [];
    const ages = f.ages && f.ages[0] ? f.ages[0].v : [];
    const span = f.span && f.span[0] ? f.span[0] : {};

    const biggest = series.reduce(
      (best, r) => (!best || r.n > best.n ? { day: r._id, n: r.n } : best),
      null,
    );

    res.json({
      success: true,
      totals,
      rate: totals.total ? (totals.banned / totals.total) * 100 : 0,
      recent: { d1: one(f.d1), d7: one(f.d7), d30: one(f.d30) },
      series: series.map((r) => ({ day: r._id, n: r.n })),
      ageAtBan: {
        n: ages.length,
        p10: pct(ages, 0.1),
        median: pct(ages, 0.5),
        p90: pct(ages, 0.9),
      },
      biggestDay: biggest,
      firstBanAt: span.first || null,
      lastBanAt: span.last || null,
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
    const sort = {};
    sort[ALLOWED_SORT.includes(sortKey) ? sortKey : "suspendedAt"] = dir;

    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);

    const [total, rows] = await Promise.all([
      BotAccount.countDocuments(q),
      BotAccount.find(q, {
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
      })
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
    ]);

    // Enrich the PAGE only — never the whole population. Two extra round trips
    // for up to 500 rows beats 500 round trips, and both are indexed lookups.
    const ids = rows.map((r) => String(r._id));
    const logins = rows.map((r) => r.login).filter(Boolean);
    const [dropsBy, listingRows] = await Promise.all([
      dropsByLogin(logins),
      // Matched on id AND login: id is what the auto-delivery fulfillers write,
      // login is the only handle the older rows carry.
      MarketplaceListing.find(
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
      ).lean(),
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
      accounts: rows.map((a) => {
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
    const aged = await BotAccount.find(
      { suspendedAt: { $ne: null }, createdAt: { $ne: null } },
      { suspendedAt: 1, createdAt: 1 },
    ).lean();
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
    const commitment = { listing: [], buyer: [], bulk: [], none: 0 };
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
    if (!a)
      return res.status(404).json({ success: false, message: "Not found" });

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
    const rows = await BotAccount.find(
      { _id: { $in: valid } },
      { login: 1, lastScanStatus: 1 },
    ).lean();

    const results = [];
    // Sequential on purpose: 40 probes at 20s worst case still beats being
    // rate-limited into a wall of UNKNOWNs that mean nothing.
    for (const r of rows) {
      const verdict = await accountState.probeAccount(r.login);
      results.push({
        id: r._id,
        login: r.login,
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
    const rows = await BotAccount.find(q, {
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
      .lean();

    const cell = (v) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const iso = (d) => (d ? new Date(d).toISOString() : "");
    const header = [
      "login",
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
