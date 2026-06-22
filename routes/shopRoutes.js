const express = require("express");

const { requireAdmin } = require("../middleware/auth");
const DropSet = require("../models/DropSet");
const DropLog = require("../models/DropLog");
const BotAccount = require("../models/BotAccount");
const Purchase = require("../models/Purchase");
const { decrypt } = require("../utils/secretBox");
const { getBalance, adjustBalance } = require("../utils/admins");

const router = express.Router();

// Grouping key for a drop: stored itemKey when present, else a computed
// name|game. Kept identical to the expression used by the drops archive so a
// bundle's items resolve to exactly the same buckets here.
const itemKeyExpr = {
  $cond: [
    { $gt: [{ $strLenCP: { $ifNull: ["$itemKey", ""] } }, 0] },
    "$itemKey",
    {
      $concat: [
        { $toLower: { $trim: { input: { $ifNull: ["$name", ""] } } } },
        "|",
        { $toLower: { $trim: { input: { $ifNull: ["$game", ""] } } } },
      ],
    },
  ],
};

function isSuper(req) {
  return req.session?.admin?.role === "superadmin";
}

// Accounts that hold EVERY item in the set and have not been sold yet. Each
// such account is one sellable unit (the buyer receives the whole account).
// Sorted so the account that can deliver the most copies comes first.
async function availableAccountsForSet(set) {
  const keys = (set.items || []).map((i) => i.itemKey).filter(Boolean);
  if (!keys.length) return [];
  const total = keys.length;
  const rows = await DropLog.aggregate([
    { $addFields: { _k: itemKeyExpr } },
    { $match: { _k: { $in: keys } } },
    {
      $group: {
        _id: { account: "$account", k: "$_k" },
        count: { $sum: "$count" },
      },
    },
    {
      $group: {
        _id: "$_id.account",
        have: { $sum: 1 },
        minCount: { $min: "$count" },
      },
    },
    { $match: { have: total } },
    {
      $lookup: {
        from: "botaccounts",
        localField: "_id",
        foreignField: "_id",
        as: "acc",
      },
    },
    { $unwind: "$acc" },
    { $match: { "acc.soldAt": null } },
    {
      $project: {
        _id: 0,
        accountId: "$_id",
        login: "$acc.login",
        hasPassword: "$acc.hasPassword",
        lastScanStatus: "$acc.lastScanStatus",
        minCount: 1,
      },
    },
    // Prefer accounts with healthy tokens and more spare copies of the bundle.
    { $sort: { minCount: -1, login: 1 } },
  ]);
  return rows;
}

function listingView(set, stock) {
  const items = set.items || [];
  return {
    id: String(set._id),
    name: set.name,
    note: set.note || "",
    price: Number(set.price) || 0,
    itemCount: items.length,
    items: items.map((i) => ({
      itemKey: i.itemKey,
      name: i.name,
      game: i.game,
      image: i.image,
    })),
    stock,
  };
}

function purchaseView(p, { withCreds = false, account = null } = {}) {
  const base = {
    id: String(p._id),
    setId: p.setId,
    setName: p.setName,
    price: p.price,
    items: p.items || [],
    accountLogin: p.accountLogin,
    buyerUsername: p.buyerUsername,
    createdAt: p.createdAt,
  };
  if (withCreds && account) {
    base.credentials = {
      login: account.login || account.credUsername || "",
      username: account.credUsername || account.login || "",
      password: decrypt(account.credPassword) || "",
      email: decrypt(account.credEmail) || "",
    };
  }
  return base;
}

// ------------------------------------------------------------------
// Current admin's wallet (balance) + role flag for the Shop header.
// ------------------------------------------------------------------
router.get("/shop/me", requireAdmin, (req, res) => {
  res.json({
    success: true,
    balance: getBalance(req.session.admin.id),
    role: req.session.admin.role,
    username: req.session.admin.username,
  });
});

// ------------------------------------------------------------------
// Listed bundles available to buy, with live stock.
// ------------------------------------------------------------------
router.get("/shop/listings", requireAdmin, async (req, res) => {
  try {
    const sets = await DropSet.find({ listed: true, price: { $gt: 0 } })
      .sort({ updatedAt: -1 })
      .lean();
    const listings = [];
    for (const set of sets) {
      const accounts = await availableAccountsForSet(set);
      listings.push(listingView(set, accounts.length));
    }
    res.json({ success: true, listings });
  } catch (err) {
    console.error("shop listings error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// One listing's details + stock.
router.get("/shop/listings/:id", requireAdmin, async (req, res) => {
  try {
    const set = await DropSet.findById(req.params.id).lean();
    if (!set || !set.listed) {
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    }
    const accounts = await availableAccountsForSet(set);
    res.json({ success: true, listing: listingView(set, accounts.length) });
  } catch (err) {
    console.error("shop listing detail error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Buy a bundle: claim one in-stock account, debit balance, record the sale.
// ------------------------------------------------------------------
router.post("/shop/listings/:id/buy", requireAdmin, async (req, res) => {
  const buyerId = req.session.admin.id;
  const buyerUsername = req.session.admin.username;
  try {
    const set = await DropSet.findById(req.params.id).lean();
    if (!set || !set.listed) {
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    }
    const price = Number(set.price) || 0;
    if (price <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "This bundle is not priced yet" });
    }
    if (getBalance(buyerId) < price) {
      return res.status(402).json({
        success: false,
        message: "Insufficient balance. Ask a superadmin to top you up.",
      });
    }

    // Atomically claim the first account that still holds the whole bundle.
    // The conditional update (soldAt: null) guarantees two buyers can never
    // be handed the same account.
    const candidates = await availableAccountsForSet(set);
    let account = null;
    for (const c of candidates) {
      const claimed = await BotAccount.findOneAndUpdate(
        { _id: c.accountId, soldAt: null },
        {
          $set: {
            soldAt: new Date(),
            soldToAdminId: buyerId,
            soldToUsername: buyerUsername,
            soldSetId: String(set._id),
          },
        },
        { new: true },
      );
      if (claimed) {
        account = claimed;
        break;
      }
    }
    if (!account) {
      return res.status(409).json({
        success: false,
        message: "Out of stock — no account currently holds this whole bundle",
      });
    }

    // Debit the buyer. If this fails (e.g. a concurrent purchase drained the
    // balance), release the account so it stays sellable.
    let balanceAfter;
    try {
      balanceAfter = await adjustBalance(buyerId, -price);
    } catch (e) {
      await BotAccount.updateOne(
        { _id: account._id },
        {
          $set: {
            soldAt: null,
            soldToAdminId: "",
            soldToUsername: "",
            soldSetId: "",
          },
        },
      );
      return res
        .status(402)
        .json({ success: false, message: e.message || "Payment failed" });
    }

    // Record the sale. If this somehow fails, refund and release.
    let purchase;
    try {
      purchase = await Purchase.create({
        setId: String(set._id),
        setName: set.name,
        price,
        items: (set.items || []).map((i) => ({
          itemKey: i.itemKey,
          name: i.name,
          game: i.game,
          image: i.image,
        })),
        buyerAdminId: buyerId,
        buyerUsername,
        account: account._id,
        accountLogin: account.login || account.credUsername || "",
        balanceAfter,
      });
    } catch (e) {
      await adjustBalance(buyerId, price, { allowNegative: true });
      await BotAccount.updateOne(
        { _id: account._id },
        {
          $set: {
            soldAt: null,
            soldToAdminId: "",
            soldToUsername: "",
            soldSetId: "",
          },
        },
      );
      console.error("shop purchase record error:", e.message);
      return res
        .status(500)
        .json({ success: false, message: "Could not complete purchase" });
    }

    await BotAccount.updateOne(
      { _id: account._id },
      { $set: { soldPurchaseId: String(purchase._id) } },
    );

    res.json({
      success: true,
      balance: balanceAfter,
      purchase: purchaseView(purchase, { withCreds: true, account }),
    });
  } catch (err) {
    console.error("shop buy error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Purchase history. Regular admins see their own; superadmin may see all.
// ------------------------------------------------------------------
router.get("/shop/purchases", requireAdmin, async (req, res) => {
  try {
    const all = isSuper(req) && String(req.query.all || "") === "1";
    const q = all ? {} : { buyerAdminId: req.session.admin.id };
    const purchases = await Purchase.find(q).sort({ createdAt: -1 }).lean();
    res.json({
      success: true,
      purchases: purchases.map((p) => purchaseView(p)),
    });
  } catch (err) {
    console.error("shop purchases error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// One purchase WITH the delivered account's credentials. Only the buyer (or a
// superadmin) may reveal them.
router.get("/shop/purchases/:id", requireAdmin, async (req, res) => {
  try {
    const p = await Purchase.findById(req.params.id).lean();
    if (!p) {
      return res
        .status(404)
        .json({ success: false, message: "Purchase not found" });
    }
    if (p.buyerAdminId !== req.session.admin.id && !isSuper(req)) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }
    const account = await BotAccount.findById(p.account).lean();
    res.json({
      success: true,
      purchase: purchaseView(p, { withCreds: !!account, account }),
    });
  } catch (err) {
    console.error("shop purchase detail error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;
