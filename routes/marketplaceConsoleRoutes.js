// ---------------------------------------------------------------------------
// MARKETPLACE CONSOLE API (superadmin) — backs public/market-console.html.
//
// One place per marketplace to answer "what sold, what did we send, what did it
// make, and what went wrong". It exists because four delivery bugs in one week
// were all found by the owner noticing rather than by the system reporting, and
// the worst of them — PlayerAuctions order 16474028, eleven accounts shipped for
// a $5 sale — left no audit row anywhere at all.
//
// READ-ONLY, like the health page it sits next to. Nothing here publishes,
// delists, reprices, provisions or delivers. It also never calls a marketplace:
// every number comes from our own database, so opening the page cannot disturb a
// live market (feedback_live_market_safety).
//
// ── The honesty problem, and how this file handles it ──────────────────────
//
// Sales evidence is UNEVEN across platforms, measured on prod 2026-09-09:
//
//   source                       who actually has it
//   SaleSignal(listing_sold)     gameflip 51, digiseller 62, ggsel 13 — with price
//   MarketplaceListing.unitsSold gameflip 76, digiseller 72, ggsel 20 — count only
//   units[].deliveredAt          12 rows in total, eldorado 11 + playerauctions 1
//
// Quantity platforms (Gameflip, Digiseller, GGSel) never say "a sale happened" —
// the guardian INFERS one from stock dropping, and records it as a SaleSignal.
// Order-API platforms (Eldorado, PlayerAuctions, G2G) stamp a real unit with a
// real order id. Neither is wrong; they are different evidence, and a single
// "sales" number that silently blended them would be a lie in both directions.
//
// So every figure this API returns carries `basis` — which source it came from
// and therefore what it can and cannot prove. The UI prints it. A number without
// a stated basis is how "0 sold" got reported while a reconciler was being rate
// limited, which is the same class of mistake as the bugs this page is for.
//
// ── Cost ───────────────────────────────────────────────────────────────────
//
// Prod Mongo is a bytes-bound Atlas shared tier with allowDiskUse DISABLED
// (reference_atlas_no_diskuse). Therefore, without exception:
//   * cursor pagination, never skip() — skip walks everything it skips;
//   * every query projected to the fields actually rendered;
//   * every query bounded by .limit();
//   * no $group over a large collection; the per-market rollup is computed in
//     JS over an already-bounded read and cached, because MarketplaceListing is
//     ~1800 rows and units[] is the big field.
// ---------------------------------------------------------------------------
const express = require("express");

const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const MarketplaceListing = require("../models/MarketplaceListing");
const SaleSignal = require("../models/SaleSignal");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const SystemEvent = require("../models/SystemEvent");
const SystemHealthRun = require("../models/SystemHealthRun");

const router = express.Router();

// Z2U is deliberately excluded everywhere: no capture, no card, no category.
const MARKETS = [
  "gameflip",
  "digiseller",
  "ggsel",
  "zeusx",
  "eldorado",
  "playerauctions",
  "g2g",
  "funpay",
];
const MARKET_SET = new Set(MARKETS);

const CATEGORIES = new Set([
  "sales",
  "deliveries",
  "listings",
  "orders",
  "errors",
  "events",
  // Per-market extras. A marketplace's tabs do NOT have to match the others':
  // what is worth looking at depends on how that platform actually delivers.
  "attached",
]);

// The tabs each market shows, in order. The first six are common; anything after
// them answers a question that only makes sense for that platform.
//
// `attached` is the Gameflip/GGSel question and it is the whole ballgame there:
// both attach the account to the listing BEFORE the sale, so "which account is
// behind this offer, and is it still good?" decides whether a buyer gets
// anything. On Eldorado or PlayerAuctions the stock is picked at delivery time
// and the same tab would be meaningless, so they do not get it.
const COMMON_TABS = ["sales", "deliveries", "listings", "orders", "errors", "events"];
const EXTRA_TABS = {
  gameflip: ["attached"],
  ggsel: ["attached"],
};
function tabsFor(market) {
  return COMMON_TABS.concat(EXTRA_TABS[market] || []);
}

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function clampLimit(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

// A cursor is "<ISO date>|<_id>". The _id half is what makes paging correct when
// several rows share a timestamp: ordering by date alone has no tiebreak, so a
// page boundary landing inside a group of equal timestamps silently drops or
// repeats rows. Bulk-published listings share a createdAt to the millisecond, so
// this is the normal case here, not a corner one.
function parseCursor(raw) {
  if (!raw) return null;
  const s = String(raw);
  const bar = s.lastIndexOf("|");
  if (bar < 1) return null;
  const at = new Date(s.slice(0, bar));
  const id = s.slice(bar + 1);
  if (Number.isNaN(at.getTime()) || !/^[a-f0-9]{24}$/i.test(id)) return null;
  return { at, id };
}

function makeCursor(at, id) {
  return new Date(at).toISOString() + "|" + String(id);
}

// The keyset predicate for "strictly older than the cursor".
function olderThan(field, cur) {
  if (!cur) return {};
  return {
    $or: [
      { [field]: { $lt: cur.at } },
      { [field]: cur.at, _id: { $lt: cur.id } },
    ],
  };
}

// Take limit+1 rows, hand back limit of them, and use the extra to answer
// "is there more" without a second count query.
function paginate(rows, limit, field) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page,
    hasMore,
    nextCursor: hasMore && last ? makeCursor(last[field], last._id) : null,
  };
}

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ------------------------------- the rollup ------------------------------ */

// Per-market totals. Recomputed at most once a minute: it reads every listing
// row's units array, which is the single biggest read in this file, and a phone
// refreshing the page must not repeat it.
let rollupCache = { at: 0, data: null };
const ROLLUP_TTL_MS = 60 * 1000;

async function rollup() {
  if (rollupCache.data && Date.now() - rollupCache.at < ROLLUP_TTL_MS) {
    return { ...rollupCache.data, cached: true };
  }

  const now = Date.now();
  const day = new Date(now - 24 * 3600e3);
  const week = new Date(now - 7 * 24 * 3600e3);

  // One pass over the listings, projected to exactly what the totals need.
  const rows = await MarketplaceListing.find(
    { marketplace: { $in: MARKETS } },
    {
      marketplace: 1,
      status: 1,
      price: 1,
      unitsSold: 1,
      lastError: 1,
      updatedAt: 1,
      "units.deliveredAt": 1,
    },
  )
    .limit(5000)
    .lean();

  const per = {};
  for (const m of MARKETS) {
    per[m] = {
      market: m,
      listings: 0,
      active: 0,
      errors: 0,
      errorsHistorical: 0,
      deliveredUnits: 0,
      deliveredRevenueUsd: 0,
      unitsSold: 0,
      delivered24h: 0,
      delivered7d: 0,
      salesSignals: 0,
      signalRevenueUsd: 0,
      sales24h: 0,
      sales7d: 0,
      farmOrders: 0,
      farmOpen: 0,
      lastActivityAt: null,
    };
  }

  for (const r of rows) {
    const p = per[r.marketplace];
    if (!p) continue;
    p.listings += 1;
    if (r.status === "active") p.active += 1;
    // ACTIVE rows only. Counting every row's lastError made the cards read
    // "82 with errors" for Gameflip when the true number of live, actionable
    // errors was ZERO — the 82 were historical notes on delisted, sold and
    // removed rows, including the reconciliation notes this console's own
    // tooling writes. A number that sends the operator hunting a problem that
    // does not exist is worse than no number.
    if (r.lastError && r.status === "active") p.errors += 1;
    if (r.lastError) p.errorsHistorical += 1;
    p.unitsSold += Number(r.unitsSold) || 0;
    const price = Number(r.price) || 0;
    for (const u of r.units || []) {
      if (!u.deliveredAt) continue;
      const at = new Date(u.deliveredAt);
      p.deliveredUnits += 1;
      p.deliveredRevenueUsd += price;
      if (at >= day) p.delivered24h += 1;
      if (at >= week) p.delivered7d += 1;
      if (!p.lastActivityAt || at > p.lastActivityAt) p.lastActivityAt = at;
    }
    const up = r.updatedAt ? new Date(r.updatedAt) : null;
    if (up && (!p.lastActivityAt || up > p.lastActivityAt)) p.lastActivityAt = up;
  }

  // Sales signals carry the price the platform actually reported, which is the
  // only revenue evidence the quantity platforms produce at all.
  const signals = await SaleSignal.find(
    { source: "listing_sold", marketplace: { $in: MARKETS } },
    { marketplace: 1, priceUsd: 1, at: 1 },
  )
    .sort({ at: -1 })
    .limit(5000)
    .lean();
  for (const s of signals) {
    const p = per[s.marketplace];
    if (!p) continue;
    p.salesSignals += 1;
    p.signalRevenueUsd += Number(s.priceUsd) || 0;
    const at = new Date(s.at);
    if (at >= day) p.sales24h += 1;
    if (at >= week) p.sales7d += 1;
    if (!p.lastActivityAt || at > p.lastActivityAt) p.lastActivityAt = at;
  }

  const farm = await FarmServiceOrder.find(
    {},
    { market: 1, state: 1 },
  )
    .limit(2000)
    .lean();
  for (const f of farm) {
    const p = per[f.market];
    if (!p) continue;
    p.farmOrders += 1;
    if (f.state !== "delivered" && f.state !== "cancelled") p.farmOpen += 1;
  }

  for (const m of MARKETS) {
    const p = per[m];
    p.deliveredRevenueUsd = money(p.deliveredRevenueUsd);
    p.signalRevenueUsd = money(p.signalRevenueUsd);
    // The honest total: two DIFFERENT kinds of evidence added together, with
    // the split kept so the page can show where it came from. They cannot
    // double-count — a delivered unit carries an order id from an order-API
    // platform, a sale signal is inferred from a quantity platform's stock
    // dropping, and no platform produces both.
    p.revenueUsd = money(p.deliveredRevenueUsd + p.signalRevenueUsd);
    p.soldTotal = p.deliveredUnits + Math.max(p.unitsSold, p.salesSignals);
    p.basis =
      p.deliveredUnits && p.salesSignals
        ? "delivered units + inferred stock drops"
        : p.deliveredUnits
          ? "delivered units (real order ids)"
          : p.salesSignals || p.unitsSold
            ? "inferred from stock dropping — no per-order record"
            : "no sales evidence recorded yet";
  }

  const data = {
    markets: MARKETS.map((m) => per[m]),
    generatedAt: new Date(),
    note:
      "Revenue is evidence, not accounting: order-API platforms report a real " +
      "delivered unit, quantity platforms only report stock going down. Each " +
      "card says which it used.",
  };
  rollupCache = { at: Date.now(), data };
  return { ...data, cached: false };
}

/* -------------------------------- routes --------------------------------- */

router.get(
  "/api/market-console/summary",
  requireSuperadmin,
  enforce2fa,
  async (req, res) => {
    try {
      const data = await rollup();
      // The newest health run, so each card can show its connector state
      // without the page making a second round trip.
      const run = await SystemHealthRun.findOne({}, { at: 1, checks: 1 })
        .sort({ at: -1 })
        .lean();
      const health = {};
      for (const c of (run && run.checks) || []) {
        const m = String(c.id || "").startsWith("connector.")
          ? String(c.id).slice("connector.".length)
          : "";
        if (m && MARKET_SET.has(m)) health[m] = { status: c.status, summary: c.summary };
      }
      res.json({
        success: true,
        ...data,
        health,
        healthAt: (run && run.at) || null,
        tabs: Object.fromEntries(MARKETS.map((m) => [m, tabsFor(m)])),
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

router.get(
  "/api/market-console/:market/:category",
  requireSuperadmin,
  enforce2fa,
  async (req, res) => {
    try {
      const market = String(req.params.market || "").toLowerCase();
      const category = String(req.params.category || "").toLowerCase();
      if (market === "z2u") {
        return res
          .status(400)
          .json({ success: false, message: "z2u is deliberately excluded from the console" });
      }
      if (!MARKET_SET.has(market)) {
        return res.status(400).json({ success: false, message: "unknown marketplace" });
      }
      if (!CATEGORIES.has(category)) {
        return res.status(400).json({ success: false, message: "unknown category" });
      }
      if (!tabsFor(market).includes(category)) {
        return res.status(400).json({
          success: false,
          message: category + " is not a category " + market + " has",
        });
      }
      const limit = clampLimit(req.query.limit);
      const cur = parseCursor(req.query.cursor);
      const q = String(req.query.q || "").trim().slice(0, 80);

      if (category === "sales") {
        const rows = await SaleSignal.find(
          {
            marketplace: market,
            source: "listing_sold",
            ...(q ? { game: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") } : {}),
            ...olderThan("at", cur),
          },
          { game: 1, name: 1, login: 1, priceUsd: 1, at: 1, itemKey: 1 },
        )
          .sort({ at: -1, _id: -1 })
          .limit(limit + 1)
          .lean();
        const out = paginate(rows, limit, "at");
        return res.json({
          success: true,
          ...out,
          basis:
            "SaleSignal rows the guardian recorded when a platform's stock " +
            "dropped. Price is what the platform reported (0 = it did not say).",
        });
      }

      if (category === "deliveries") {
        // Units carry the order id and the delivery stamp — the only per-order
        // record that exists. Read the listings that hold them, newest first.
        const rows = await MarketplaceListing.find(
          {
            marketplace: market,
            "units.deliveredAt": { $ne: null },
            ...olderThan("updatedAt", cur),
          },
          { title: 1, price: 1, externalId: 1, units: 1, updatedAt: 1, set: 1 },
        )
          .sort({ updatedAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean();
        const out = paginate(rows, limit, "updatedAt");
        out.items = out.items.map((r) => ({
          _id: r._id,
          title: r.title,
          externalId: r.externalId,
          priceUsd: Number(r.price) || 0,
          updatedAt: r.updatedAt,
          deliveries: (r.units || [])
            .filter((u) => u.deliveredAt)
            .map((u) => ({
              login: u.login,
              orderId: u.orderId,
              deliveredAt: u.deliveredAt,
              messagedAt: u.messagedAt,
            })),
        }));
        return res.json({
          success: true,
          ...out,
          basis:
            "units[] entries stamped deliveredAt — a real order id per account. " +
            "Only the order-API platforms produce these.",
        });
      }

      if (category === "listings") {
        const rows = await MarketplaceListing.find(
          {
            marketplace: market,
            ...(q
              ? { title: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }
              : {}),
            ...olderThan("createdAt", cur),
          },
          {
            title: 1,
            externalId: 1,
            price: 1,
            status: 1,
            origin: 1,
            unitsSold: 1,
            lastError: 1,
            createdAt: 1,
            unclaimedGame: 1,
          },
        )
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean();
        return res.json({
          success: true,
          ...paginate(rows, limit, "createdAt"),
          basis: "MarketplaceListing rows, newest first.",
        });
      }

      if (category === "orders") {
        const rows = await FarmServiceOrder.find(
          { market, ...olderThan("createdAt", cur) },
          {
            orderId: 1,
            offerTitle: 1,
            game: 1,
            days: 1,
            quantity: 1,
            accounts: 1,
            state: 1,
            attempts: 1,
            lastError: 1,
            createdAt: 1,
            deliveredAt: 1,
          },
        )
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean();
        return res.json({
          success: true,
          ...paginate(rows, limit, "createdAt"),
          basis: "Rent-farm orders (FarmServiceOrder). Bundle sales do not appear here.",
        });
      }

      if (category === "errors") {
        // The TAB keeps the history — a delisted row's last error is often
        // exactly what explains why it was delisted — but each row carries its
        // status so a dead one cannot be mistaken for a live problem. The CARD
        // count above deliberately counts only active rows.
        const rows = await MarketplaceListing.find(
          {
            marketplace: market,
            lastError: { $ne: "" },
            ...olderThan("updatedAt", cur),
          },
          { title: 1, externalId: 1, lastError: 1, status: 1, updatedAt: 1, price: 1 },
        )
          .sort({ updatedAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean();
        return res.json({
          success: true,
          ...paginate(rows, limit, "updatedAt"),
          basis:
            "The last error recorded ON a listing row, live and historical. Rows " +
            "that are not `active` are past problems kept for context — the " +
            "card's error count on the previous screen counts ACTIVE rows only.",
        });
      }

      if (category === "attached") {
        // Gameflip and GGSel hand over content that was attached BEFORE the
        // sale, so a live listing is only as good as the account behind it. This
        // answers the question that actually decides a delivery there: which
        // account backs this offer, and is that account still ours to sell?
        const rows = await MarketplaceListing.find(
          {
            marketplace: market,
            status: "active",
            ...olderThan("createdAt", cur),
          },
          {
            title: 1,
            externalId: 1,
            price: 1,
            accountId: 1,
            accountLogin: 1,
            autoDeliver: 1,
            unitsSold: 1,
            createdAt: 1,
            origin: 1,
          },
        )
          .sort({ createdAt: -1, _id: -1 })
          .limit(limit + 1)
          .lean();
        const out = paginate(rows, limit, "createdAt");

        // Resolve each backing account's CURRENT state in one query, not one per
        // row: this list is paged and a per-row lookup would be 25 round trips a
        // page on a bytes-bound tier.
        const logins = [
          ...new Set(
            out.items
              .flatMap((r) => String(r.accountLogin || "").split(/[,\s]+/))
              .map((x) => String(x).trim().toLowerCase())
              .filter(Boolean),
          ),
        ];
        const BotAccount = require("../models/BotAccount");
        const accounts = logins.length
          ? await BotAccount.find(
              { login: { $in: logins } },
              { login: 1, soldAt: 1, soldToUsername: 1, suspendedAt: 1, dropCount: 1 },
            )
              .limit(200)
              .lean()
          : [];
        const byLogin = new Map(accounts.map((a) => [String(a.login).toLowerCase(), a]));

        out.items = out.items.map((r) => {
          const names = String(r.accountLogin || "")
            .split(/[,\s]+/)
            .map((x) => x.trim())
            .filter(Boolean);
          return {
            _id: r._id,
            title: r.title,
            externalId: r.externalId,
            price: r.price,
            origin: r.origin,
            autoDeliver: !!r.autoDeliver,
            unitsSold: r.unitsSold || 0,
            createdAt: r.createdAt,
            // No account named at all is the state worth seeing first: an
            // auto-deliver listing with nothing behind it takes money for
            // nothing.
            attached: names.map((n) => {
              const a = byLogin.get(n.toLowerCase());
              return {
                login: n,
                known: !!a,
                drops: a ? a.dropCount || 0 : null,
                soldElsewhere: !!(a && a.soldAt),
                soldTo: (a && a.soldToUsername) || "",
                suspended: !!(a && a.suspendedAt),
              };
            }),
          };
        });
        return res.json({
          success: true,
          ...out,
          basis:
            "The account attached to each live listing, with that account's " +
            "current state. " + market + " hands over content attached BEFORE " +
            "the sale, so a listing with no usable account behind it takes " +
            "money and delivers nothing.",
        });
      }

      // events — the audit trail, filtered to anything naming this market.
      const rx = new RegExp(market, "i");
      const rows = await SystemEvent.find(
        {
          $or: [{ subject: rx }, { actor: rx }, { detail: rx }],
          ...olderThan("at", cur),
        },
        { at: 1, category: 1, action: 1, actor: 1, severity: 1, subject: 1, detail: 1, count: 1 },
      )
        .sort({ at: -1, _id: -1 })
        .limit(limit + 1)
        .lean();
      return res.json({
        success: true,
        ...paginate(rows, limit, "at"),
        basis:
          "SystemEvent rows mentioning this marketplace. The delivery paths " +
          "write very few of these today — that gap is why this console exists.",
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

// Everything known about ONE order, oldest first. The view the whole page exists
// for: a buyer says "I got nothing", and this answers what we did and when.
router.get(
  "/api/market-console/order/:orderId",
  requireSuperadmin,
  enforce2fa,
  async (req, res) => {
    try {
      const id = String(req.params.orderId || "").trim().slice(0, 80);
      if (!id) return res.status(400).json({ success: false, message: "no order id" });
      const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rx = new RegExp(esc, "i");

      const trail = [];

      const listings = await MarketplaceListing.find(
        { "units.orderId": id },
        { marketplace: 1, title: 1, externalId: 1, price: 1, units: 1 },
      )
        .limit(10)
        .lean();
      for (const l of listings) {
        for (const u of l.units || []) {
          if (String(u.orderId || "") !== id) continue;
          if (u.addedAt) {
            trail.push({
              at: u.addedAt,
              kind: "reserved",
              market: l.marketplace,
              detail: "account " + u.login + " reserved onto " + l.externalId,
            });
          }
          if (u.messagedAt) {
            trail.push({
              at: u.messagedAt,
              kind: "message_sent",
              market: l.marketplace,
              detail: "credentials for " + u.login + " sent to the buyer",
            });
          }
          if (u.deliveredAt) {
            trail.push({
              at: u.deliveredAt,
              kind: "delivered",
              market: l.marketplace,
              detail:
                "delivery confirmed for " + u.login +
                " ($" + (Number(l.price) || 0).toFixed(2) + ")",
            });
          }
        }
      }

      const farm = await FarmServiceOrder.findOne({
        $or: [{ orderId: id }, { orderId: rx }],
      }).lean();
      if (farm) {
        const add = (at, kind, detail) => at && trail.push({ at, kind, market: farm.market, detail });
        add(farm.createdAt, "order_seen", "rent-farm order claimed: " + farm.game + " / " + farm.days + "d x" + farm.quantity);
        add(farm.provisionedAt, "provisioned", (farm.accounts || []).map((a) => a.login).join(", ") || "no accounts");
        add(farm.messageSentAt, "message_sent", "credentials sent to the buyer");
        add(farm.deliveredAt, "delivered", "order marked delivered");
        if (farm.state === "failed" || farm.state === "cancelled") {
          add(farm.updatedAt, farm.state, farm.lastError || "");
        }
      }

      const events = await SystemEvent.find(
        { $or: [{ subject: rx }, { detail: rx }] },
        { at: 1, category: 1, action: 1, actor: 1, severity: 1, detail: 1 },
      )
        .sort({ at: -1 })
        .limit(50)
        .lean();
      for (const e of events) {
        trail.push({
          at: e.at,
          kind: e.action || e.category,
          severity: e.severity,
          actor: e.actor,
          detail: e.detail,
        });
      }

      trail.sort((a, b) => new Date(a.at) - new Date(b.at));
      res.json({
        success: true,
        orderId: id,
        trail: trail.slice(0, 200),
        listings: listings.map((l) => ({
          marketplace: l.marketplace,
          title: l.title,
          externalId: l.externalId,
          priceUsd: Number(l.price) || 0,
        })),
        farmOrder: farm || null,
      });
    } catch (e) {
      res.status(500).json({ success: false, message: e.message });
    }
  },
);

module.exports = router;
module.exports.MARKETS = MARKETS;
module.exports.parseCursor = parseCursor;
module.exports.makeCursor = makeCursor;
module.exports.clampLimit = clampLimit;
module.exports.paginate = paginate;
module.exports.tabsFor = tabsFor;
module.exports.COMMON_TABS = COMMON_TABS;
