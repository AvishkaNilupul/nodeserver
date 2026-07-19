// Bulk orders: sell N drop-bundle accounts to one buyer at once, hand them a
// secret no-login link to view the whole set as an inventory, and health-check
// every account against Twitch (auto-replacing dead ones from the pool).
//
// Stock + the atomic claim are the Shop's (routes/shopRoutes); the check +
// auto-replace live in utils/bulkOrderHealth. This router owns the order
// lifecycle and the two public portal endpoints.
const express = require("express");
const crypto = require("crypto");

const { requireSuperadmin } = require("../middleware/auth");
const BulkOrder = require("../models/BulkOrder");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const { stockForSets } = require("./shopRoutes");
const {
  runHealthCheck,
  reserveUnits,
  recomputeSummary,
  setLikeOf,
  BAD_FOR_SUMMARY,
} = require("../utils/bulkOrderHealth");
const { decrypt } = require("../utils/secretBox");
const { validateLimiter, portalCheckLimiter } = require("../utils/rateLimit");

const router = express.Router();

const MAX_QTY = 1000;

// ------------------------------------------------------------------ helpers

async function makeOrderNo() {
  // Short, human-friendly, collision-checked.
  for (let i = 0; i < 6; i++) {
    const no = "BULK-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    const clash = await BulkOrder.exists({ orderNo: no });
    if (!clash) return no;
  }
  // Extremely unlikely fallback.
  return "BULK-" + crypto.randomBytes(5).toString("hex").toUpperCase();
}

function portalPath(order) {
  return "/set/" + order.accessToken;
}

function buyerLink(req, order) {
  return req.protocol + "://" + req.get("host") + portalPath(order);
}

function initialSummary(units) {
  return {
    total: units.length,
    alive: 0,
    bad: 0,
    unchecked: units.length,
    lastCheckedAt: null,
  };
}

// Operator-facing unit (no credentials).
function unitAdminView(u) {
  return {
    accountId: String(u.account),
    login: u.accountLogin || "",
    itemCounts: u.itemCounts || [],
    health: u.health || { status: "unchecked" },
    active: u.active,
    replacedByLogin: u.replacedByLogin || "",
    replacedFromLogin: u.replacedFromLogin || "",
    replacedAt: u.replacedAt || null,
    revealedAt: u.revealedAt || null,
  };
}

// Compact row for the orders list.
function orderRow(order) {
  const active = (order.units || []).filter((u) => u.active).length;
  return {
    id: String(order._id),
    orderNo: order.orderNo,
    setName: order.setName,
    qtyOrdered: order.qtyOrdered,
    activeCount: active,
    healthSummary: order.healthSummary || initialSummary([]),
    buyerLabel: order.buyerLabel || "",
    status: order.status,
    guaranteeUntil: order.guaranteeUntil || null,
    portalPath: portalPath(order),
    createdAt: order.createdAt,
  };
}

// Full operator detail (no credentials — revealed via /creds).
function orderAdminView(order) {
  return {
    id: String(order._id),
    orderNo: order.orderNo,
    setId: order.setId,
    setName: order.setName,
    items: order.items || [],
    qtyOrdered: order.qtyOrdered,
    price: order.price || 0,
    buyerLabel: order.buyerLabel || "",
    status: order.status,
    guaranteeUntil: order.guaranteeUntil || null,
    healthSummary: order.healthSummary || initialSummary([]),
    portalPath: portalPath(order),
    units: (order.units || []).map(unitAdminView),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
}

// Load + decrypt credentials for the active units. Used by the portal and the
// operator reveal/export routes. Credentials live only on the BotAccount, so
// they are read on demand and never stored on the order.
async function credsForActiveUnits(order) {
  const active = (order.units || []).filter((u) => u.active);
  const ids = active.map((u) => u.account);
  const accs = await BotAccount.find({ _id: { $in: ids } }).lean();
  const byId = new Map(accs.map((a) => [String(a._id), a]));
  return active.map((u) => {
    const a = byId.get(String(u.account)) || {};
    return {
      login: a.login || u.accountLogin || "",
      username: a.credUsername || a.login || u.accountLogin || "",
      password: decrypt(a.credPassword) || "",
      email: decrypt(a.credEmail) || "",
      itemCounts: u.itemCounts || [],
      health: u.health || { status: "unchecked" },
      replacedFromLogin: u.replacedFromLogin || "",
    };
  });
}

// Per-account item breakdown + minimal credentials for the buyer. Deliberately
// excludes everything the buyer doesn't need and we don't want exposed: the
// farming clientSecret, the account email, internal ids, the logins of
// replaced-out accounts, and raw health-error text. The link token is the only
// auth, so the exposed surface is kept as small as possible. Only the three
// credential fields the buyer actually uses are projected out of BotAccount.
async function buyerUnitsView(order) {
  const active = (order.units || []).filter((u) => u.active);
  const ids = active.map((u) => u.account);
  const accs = await BotAccount.find(
    { _id: { $in: ids } },
    { login: 1, credUsername: 1, credPassword: 1 },
  ).lean();
  const byId = new Map(accs.map((a) => [String(a._id), a]));
  const items = order.items || [];
  return active.map((u) => {
    const a = byId.get(String(u.account)) || {};
    const counts = new Map((u.itemCounts || []).map((c) => [c.itemKey, c.count]));
    return {
      login: a.login || a.credUsername || u.accountLogin || "",
      password: decrypt(a.credPassword) || "",
      status: (u.health && u.health.status) || "unchecked",
      wasReplaced: !!u.replacedFromLogin,
      // What THIS account holds: every promised item + its copy count here.
      items: items.map((i) => ({
        name: i.name || "Reward",
        image: i.image || "",
        count: counts.get(i.itemKey) || i.qty || 1,
      })),
    };
  });
}

// Buyer-facing view. The link token IS the auth (like the redeem-code flow),
// and this still never exposes the farming clientSecret, the email, or any
// internal identifier — see buyerUnitsView. Only safe aggregate counts and the
// per-account credentials/items are returned.
async function orderPortalView(order) {
  const units = await buyerUnitsView(order);
  const sm = order.healthSummary || initialSummary(units);
  return {
    orderNo: order.orderNo,
    setName: order.setName,
    guaranteeUntil: order.guaranteeUntil || null,
    healthSummary: {
      total: sm.total || 0,
      alive: sm.alive || 0,
      bad: sm.bad || 0,
      unchecked: sm.unchecked || 0,
    },
    units,
  };
}

// =========================================================================
// Operator (superadmin)
// =========================================================================

// Every set + how many bulk units it can currently fill, for the create picker.
router.get("/bulk-orders/sets", requireSuperadmin, async (req, res) => {
  try {
    const sets = await DropSet.find({}).sort({ updatedAt: -1 }).lean();
    const stockMap = await stockForSets(sets);
    const out = sets.map((s) => {
      const st = stockMap.get(String(s._id)) || { stock: 0 };
      return {
        id: String(s._id),
        name: s.name,
        itemCount: (s.items || []).length,
        items: (s.items || []).map((i) => ({
          name: i.name,
          image: i.image,
          qty: i.qty || 1,
        })),
        price: s.price || 0,
        listed: !!s.listed,
        stock: st.stock,
      };
    });
    res.json({ success: true, sets: out });
  } catch (err) {
    console.error("bulk-orders sets error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Create a bulk order: reserve up to `qty` accounts that hold the whole set.
router.post("/bulk-orders/create", requireSuperadmin, async (req, res) => {
  try {
    const { setId, buyerLabel, price, guaranteeDays } = req.body || {};
    const qty = Math.floor(Number(req.body && req.body.qty));
    if (!setId) {
      return res.status(400).json({ success: false, message: "Set is required" });
    }
    if (!Number.isFinite(qty) || qty < 1) {
      return res
        .status(400)
        .json({ success: false, message: "Quantity must be at least 1" });
    }
    if (qty > MAX_QTY) {
      return res
        .status(400)
        .json({ success: false, message: `Quantity is capped at ${MAX_QTY}` });
    }
    const set = await DropSet.findById(setId).lean();
    if (!set) {
      return res.status(404).json({ success: false, message: "Set not found" });
    }
    if (!(set.items || []).some((i) => i.itemKey)) {
      return res.status(400).json({
        success: false,
        message: "This set has no drops to sell",
      });
    }

    const orderNo = await makeOrderNo();
    const accessToken = crypto.randomBytes(24).toString("hex");
    // Lightweight ref carries just what the claim needs to stamp accounts.
    const orderRef = { orderNo, setId: String(set._id) };
    const { units, claimed, available } = await reserveUnits({
      order: orderRef,
      setLike: set,
      qty,
    });

    const days = Math.floor(Number(guaranteeDays));
    const guaranteeUntil =
      Number.isFinite(days) && days > 0
        ? new Date(Date.now() + days * 24 * 60 * 60 * 1000)
        : null;

    let order;
    try {
      order = await BulkOrder.create({
        orderNo,
        accessToken,
        setId: String(set._id),
        setName: set.name,
        items: (set.items || []).map((i) => ({
          itemKey: i.itemKey,
          name: i.name,
          game: i.game,
          image: i.image,
          qty: i.qty || 1,
        })),
        qtyOrdered: qty,
        price: Number(price) > 0 ? Number(price) : 0,
        buyerLabel: String(buyerLabel || "").slice(0, 200),
        guaranteeUntil,
        units,
        healthSummary: initialSummary(units),
        createdBy: req.session.admin.id,
      });
    } catch (e) {
      // Roll back the reservations so the accounts stay sellable.
      await BotAccount.updateMany(
        { soldBulkOrderId: orderNo },
        {
          $set: {
            soldAt: null,
            soldToUsername: "",
            soldSetId: "",
            soldBulkOrderId: "",
          },
        },
      );
      throw e;
    }

    res.json({
      success: true,
      order: orderAdminView(order),
      claimed,
      available,
      shortfall: Math.max(0, qty - claimed),
      buyerLink: buyerLink(req, order),
    });
  } catch (err) {
    console.error("bulk-orders create error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/bulk-orders/list", requireSuperadmin, async (req, res) => {
  try {
    const orders = await BulkOrder.find({}).sort({ createdAt: -1 }).lean();
    res.json({ success: true, orders: orders.map(orderRow) });
  } catch (err) {
    console.error("bulk-orders list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.get("/bulk-orders/:id", requireSuperadmin, async (req, res) => {
  try {
    const order = await BulkOrder.findById(req.params.id).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    res.json({
      success: true,
      order: orderAdminView(order),
      buyerLink: buyerLink(req, order),
    });
  } catch (err) {
    console.error("bulk-orders detail error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Decrypted credentials for delivery (operator).
router.get("/bulk-orders/:id/creds", requireSuperadmin, async (req, res) => {
  try {
    const order = await BulkOrder.findById(req.params.id).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const units = await credsForActiveUnits(order);
    res.json({ success: true, orderNo: order.orderNo, units });
  } catch (err) {
    console.error("bulk-orders creds error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Run the health check + auto-replace (operator).
router.post(
  "/bulk-orders/:id/health-check",
  requireSuperadmin,
  async (req, res) => {
    try {
      const order = await BulkOrder.findById(req.params.id);
      if (!order) {
        return res.status(404).json({ success: false, message: "Order not found" });
      }
      // Auto-replace is intentionally off: the check reports health but never
      // swaps accounts (so a unit a buyer is actively using is never yanked).
      const report = await runHealthCheck(order, { autoReplace: false });
      await order.save();
      res.json({
        success: true,
        report,
        order: orderAdminView(order),
      });
    } catch (err) {
      console.error("bulk-orders health-check error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Reserve more units for a short order (operator).
router.post("/bulk-orders/:id/topup", requireSuperadmin, async (req, res) => {
  try {
    const add = Math.floor(Number(req.body && req.body.qty));
    if (!Number.isFinite(add) || add < 1) {
      return res
        .status(400)
        .json({ success: false, message: "Quantity must be at least 1" });
    }
    if (add > MAX_QTY) {
      return res
        .status(400)
        .json({ success: false, message: `Quantity is capped at ${MAX_QTY}` });
    }
    const order = await BulkOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const excludeIds = new Set((order.units || []).map((u) => String(u.account)));
    const { units, claimed, available } = await reserveUnits({
      order,
      setLike: setLikeOf(order),
      qty: add,
      excludeIds,
    });
    for (const u of units) order.units.push(u);
    order.qtyOrdered += add;
    recomputeSummary(order);
    await order.save();
    res.json({
      success: true,
      claimed,
      available,
      shortfall: Math.max(0, add - claimed),
      order: orderAdminView(order),
    });
  } catch (err) {
    console.error("bulk-orders topup error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Download active credentials as login:password:email lines (operator).
router.get("/bulk-orders/:id/export", requireSuperadmin, async (req, res) => {
  try {
    const order = await BulkOrder.findById(req.params.id).lean();
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    const units = await credsForActiveUnits(order);
    const lines = units.map((u) =>
      [u.login, u.password].filter((v) => v !== "").join(":"),
    );
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${order.orderNo}.txt"`,
    );
    res.send(lines.join("\n") + "\n");
  } catch (err) {
    console.error("bulk-orders export error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Cancel an order: return still-good accounts to the sellable pool, keep the
// dead ones out (they're dead), then delete the order.
router.delete("/bulk-orders/:id", requireSuperadmin, async (req, res) => {
  try {
    const order = await BulkOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: "Order not found" });
    }
    // Only release accounts we can't tell are broken (alive or never-checked);
    // an account confirmed dead should not go back on the shelf.
    const releaseIds = (order.units || [])
      .filter((u) => !BAD_FOR_SUMMARY.has((u.health && u.health.status) || "unchecked"))
      .map((u) => u.account);
    let released = 0;
    if (releaseIds.length) {
      const r = await BotAccount.updateMany(
        { _id: { $in: releaseIds }, soldBulkOrderId: order.orderNo },
        {
          $set: {
            soldAt: null,
            soldToUsername: "",
            soldSetId: "",
            soldBulkOrderId: "",
          },
        },
      );
      released = r.modifiedCount || 0;
    }
    await BulkOrder.deleteOne({ _id: order._id });
    res.json({ success: true, released });
  } catch (err) {
    console.error("bulk-orders delete error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// =========================================================================
// Buyer portal (public — the token is the secret; no login)
// =========================================================================

router.get(
  "/bulk-orders/portal/:token",
  validateLimiter,
  async (req, res) => {
    try {
      const order = await BulkOrder.findOne({ accessToken: req.params.token });
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }
      // Stamp first-reveal on any active unit the buyer hasn't seen yet.
      let touched = false;
      const now = new Date();
      for (const u of order.units) {
        if (u.active && !u.revealedAt) {
          u.revealedAt = now;
          touched = true;
        }
      }
      if (touched) await order.save();
      res.json({ success: true, order: await orderPortalView(order) });
    } catch (err) {
      console.error("bulk-orders portal error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.post(
  "/bulk-orders/portal/:token/health-check",
  portalCheckLimiter,
  async (req, res) => {
    try {
      const order = await BulkOrder.findOne({ accessToken: req.params.token });
      if (!order) {
        return res
          .status(404)
          .json({ success: false, message: "Order not found" });
      }
      // Auto-replace is intentionally off: the check reports health but never
      // swaps accounts (so a unit a buyer is actively using is never yanked).
      const report = await runHealthCheck(order, { autoReplace: false });
      await order.save();
      res.json({
        success: true,
        report,
        order: await orderPortalView(order),
      });
    } catch (err) {
      console.error("bulk-orders portal health-check error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
