const express = require("express");

const { requireAdmin, requireSuperadmin } = require("../middleware/auth");
const DropSet = require("../models/DropSet");
const DropLog = require("../models/DropLog");
const BotAccount = require("../models/BotAccount");
const Purchase = require("../models/Purchase");
const { decrypt } = require("../utils/secretBox");
const { getBalance, adjustBalance } = require("../utils/admins");
const BalanceLog = require("../models/BalanceLog");

const router = express.Router();

// Bundle items are keyed by the stored, indexed `itemKey` (a normalised
// name|game that the scanner and the startup backfill always populate). We
// match on it directly so these aggregations use the itemKey index instead of
// scanning the whole DropLog collection on every shop request.

function isSuper(req) {
  return req.session?.admin?.role === "superadmin";
}

// Group DropLog by account for a set of item keys, returning every account that
// holds ALL of `keys` together with the per-item copy counts. This stays inside
// DropLog (driven by the itemKey index) and does NOT join botaccounts — the
// sellable/sold/password filtering is done in a second, _id-indexed query so we
// avoid the expensive per-row $lookup + $strLenCP scan the old pipeline did.
async function holdingsForKeys(keys) {
  if (!keys.length) return [];
  const total = keys.length;
  // Drops already connected/redeemed on a game account cannot be delivered
  // again, so they never count as sellable stock.
  return DropLog.aggregate([
    { $match: { itemKey: { $in: keys }, connected: { $ne: true } } },
    {
      $group: {
        _id: { account: "$account", k: "$itemKey" },
        count: { $sum: "$count" },
      },
    },
    {
      $group: {
        _id: "$_id.account",
        have: { $sum: 1 },
        minCount: { $min: "$count" },
        items: { $push: { k: "$_id.k", count: "$count" } },
      },
    },
    { $match: { have: total } },
  ]);
}

// Of a list of candidate account ids, return the subset that is still sellable
// (not sold AND has a stored password). One indexed query on _id.
async function sellableAccountMap(ids) {
  if (!ids.length) return new Map();
  const accs = await BotAccount.find(
    { _id: { $in: ids }, soldAt: null },
    { login: 1, credPassword: 1, hasPassword: 1, lastScanStatus: 1 },
  ).lean();
  const map = new Map();
  for (const a of accs) {
    // Accounts without a stored password can't be delivered, so they're
    // excluded from the sellable pool.
    if (a.credPassword && String(a.credPassword).length > 0) {
      map.set(String(a._id), a);
    }
  }
  return map;
}

// Accounts that hold EVERY item in the set and have not been sold yet. Each
// such account is one sellable unit (the buyer receives the whole account).
// Sorted so the account that can deliver the most copies comes first.
async function availableAccountsForSet(set) {
  const keys = (set.items || []).map((i) => i.itemKey).filter(Boolean);
  if (!keys.length) return [];
  const rows = await holdingsForKeys(keys);
  if (!rows.length) return [];
  const accMap = await sellableAccountMap(rows.map((r) => r._id));
  const out = [];
  for (const r of rows) {
    const acc = accMap.get(String(r._id));
    if (!acc) continue;
    out.push({
      accountId: r._id,
      login: acc.login,
      hasPassword: acc.hasPassword,
      lastScanStatus: acc.lastScanStatus,
      minCount: r.minCount,
      items: r.items,
    });
  }
  // Prefer accounts with more spare copies of the bundle, then by login.
  out.sort(
    (a, b) =>
      b.minCount - a.minCount ||
      String(a.login || "").localeCompare(String(b.login || "")),
  );
  return out;
}

// Compute stock + delivery preview for MANY sets in a single DropLog
// aggregation + a single botaccounts query, instead of one aggregation per set
// (the old N+1 that made the Shop page slow). Returns a Map<setId, {stock,
// topItems}> where topItems are the per-item copy counts of the account that
// would be delivered next.
async function stockForSets(sets) {
  const result = new Map();
  // Union of every key across all listed sets -> one indexed aggregation.
  const allKeys = [
    ...new Set(
      sets.flatMap((s) => (s.items || []).map((i) => i.itemKey).filter(Boolean)),
    ),
  ];
  if (!allKeys.length) {
    for (const s of sets) result.set(String(s._id), { stock: 0, topItems: [] });
    return result;
  }
  // account -> [{k,count}] across the union of keys (accounts holding ANY key).
  const rows = await DropLog.aggregate([
    { $match: { itemKey: { $in: allKeys }, connected: { $ne: true } } },
    {
      $group: {
        _id: { account: "$account", k: "$itemKey" },
        count: { $sum: "$count" },
      },
    },
    {
      $group: {
        _id: "$_id.account",
        items: { $push: { k: "$_id.k", count: "$count" } },
      },
    },
  ]);
  const accMap = await sellableAccountMap(rows.map((r) => r._id));
  // Keep only sellable accounts; build id -> Map(key->count).
  const holdings = [];
  for (const r of rows) {
    if (!accMap.has(String(r._id))) continue;
    const m = new Map();
    for (const it of r.items) m.set(it.k, it.count || 0);
    holdings.push(m);
  }
  // For each set, count sellable accounts that hold all its keys and remember
  // the one with the most spare copies for the ×N preview.
  for (const set of sets) {
    const keys = (set.items || []).map((i) => i.itemKey).filter(Boolean);
    if (!keys.length) {
      result.set(String(set._id), { stock: 0, topItems: [] });
      continue;
    }
    let stock = 0;
    let bestMin = -1;
    let bestMap = null;
    for (const m of holdings) {
      let ok = true;
      let min = Infinity;
      for (const k of keys) {
        const c = m.get(k);
        if (!c) {
          ok = false;
          break;
        }
        if (c < min) min = c;
      }
      if (!ok) continue;
      stock += 1;
      if (min > bestMin) {
        bestMin = min;
        bestMap = m;
      }
    }
    const topItems = bestMap
      ? keys.map((k) => ({ k, count: bestMap.get(k) || 0 }))
      : [];
    result.set(String(set._id), { stock, topItems });
  }
  return result;
}

// Short-lived cache for the listings payload. Browsing the Shop is read-heavy
// and stock only changes on buy/refund (or a scan), so a few seconds of
// staleness is fine — and the buy path re-validates stock atomically anyway.
let listingsCache = { at: 0, data: null };
const LISTINGS_TTL_MS = 15000;
function invalidateListingsCache() {
  listingsCache = { at: 0, data: null };
}

// Per-item copy counts for the account that would be delivered next (the top
// candidate). Lets the shop preview how many copies of each item the buyer
// will actually receive.
function countsFromRow(row) {
  const map = new Map();
  for (const it of (row && row.items) || []) map.set(it.k, it.count || 0);
  return map;
}

// Same as countsFromRow but for the {k,count}[] shape returned by stockForSets.
function countsFromItems(items) {
  const map = new Map();
  for (const it of items || []) map.set(it.k, it.count || 0);
  return map;
}

function listingView(set, stock, countsByKey = null) {
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
      count: countsByKey ? countsByKey.get(i.itemKey) || 0 : null,
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
    buyerAdminId: p.buyerAdminId,
    createdAt: p.createdAt,
    refundedAt: p.refundedAt || null,
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
    if (listingsCache.data && Date.now() - listingsCache.at < LISTINGS_TTL_MS) {
      return res.json({ success: true, listings: listingsCache.data });
    }
    const sets = await DropSet.find({ listed: true, price: { $gt: 0 } })
      .sort({ updatedAt: -1 })
      .lean();
    // One DropLog aggregation + one botaccounts query for ALL bundles, instead
    // of an aggregation per bundle.
    const stockMap = await stockForSets(sets);
    const listings = sets.map((set) => {
      const s = stockMap.get(String(set._id)) || { stock: 0, topItems: [] };
      return listingView(set, s.stock, countsFromItems(s.topItems));
    });
    listingsCache = { at: Date.now(), data: listings };
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
    res.json({
      success: true,
      listing: listingView(set, accounts.length, countsFromRow(accounts[0])),
    });
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
    let claimedCounts = null;
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
        claimedCounts = countsFromRow(c);
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
          count: (claimedCounts && claimedCounts.get(i.itemKey)) || 1,
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
    // Stock changed: drop the cached listings so the next load is accurate.
    invalidateListingsCache();

    // Audit the spend (best-effort; never blocks the sale).
    BalanceLog.create({
      adminId: buyerId,
      username: buyerUsername,
      kind: "purchase",
      delta: -price,
      balanceAfter,
      note: set.name,
      byAdminId: buyerId,
      byUsername: buyerUsername,
      purchaseId: String(purchase._id),
      setId: String(set._id),
    }).catch((e) => console.error("balance log error:", e.message));

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
    // Pagination so the history doesn't grow into an unbounded payload.
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const [purchases, total] = await Promise.all([
      Purchase.find(q)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Purchase.countDocuments(q),
    ]);
    res.json({
      success: true,
      purchases: purchases.map((p) => purchaseView(p)),
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  } catch (err) {
    console.error("shop purchases error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ------------------------------------------------------------------
// Refund / unsell (superadmin only): return the delivered account to the
// sellable pool and credit the buyer back. The purchase stays on record,
// stamped as refunded.
// ------------------------------------------------------------------
router.post(
  "/shop/purchases/:id/refund",
  requireSuperadmin,
  async (req, res) => {
    try {
      const p = await Purchase.findById(req.params.id);
      if (!p) {
        return res
          .status(404)
          .json({ success: false, message: "Purchase not found" });
      }
      if (p.refundedAt) {
        return res
          .status(409)
          .json({ success: false, message: "Already refunded" });
      }
      // Release the account back to the pool.
      await BotAccount.updateOne(
        { _id: p.account },
        {
          $set: {
            soldAt: null,
            soldToAdminId: "",
            soldToUsername: "",
            soldSetId: "",
            soldPurchaseId: "",
          },
        },
      );
      // Credit the buyer back (allowNegative is irrelevant for a credit).
      let balanceAfter = null;
      try {
        balanceAfter = await adjustBalance(p.buyerAdminId, p.price, {
          allowNegative: true,
        });
      } catch (e) {
        console.error("refund credit error:", e.message);
      }
      p.refundedAt = new Date();
      p.refundedBy = req.session.admin.id;
      await p.save();
      // The account is back in the pool: invalidate the cached listings.
      invalidateListingsCache();

      BalanceLog.create({
        adminId: p.buyerAdminId,
        username: p.buyerUsername,
        kind: "refund",
        delta: p.price,
        balanceAfter: balanceAfter == null ? 0 : balanceAfter,
        note: "Refund: " + p.setName,
        byAdminId: req.session.admin.id,
        byUsername: req.session.admin.username,
        purchaseId: String(p._id),
        setId: p.setId,
      }).catch((e) => console.error("balance log error:", e.message));

      res.json({ success: true, balanceAfter });
    } catch (err) {
      console.error("shop refund error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

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
// Also used by the marketplace publisher to pick an account that can fulfil a
// whole bundle (Gameflip auto-delivery).
module.exports.availableAccountsForSet = availableAccountsForSet;
