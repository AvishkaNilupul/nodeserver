const { parseReward, eligibility, labelOf } = require("../utils/tiktokRewards");
const source = require("../utils/codeShop/tiktok");
const OBJECT_ID = /^[a-f0-9]{24}$/;
const shop = () => require("../utils/codeShop/service").service;
const Stock = () => require("../models/CodeStock");

async function inventoryStatus(rows, now = Date.now()) {
  const entries = rows.length ? await Stock().find({ loginId: /^tiktok:/, itemId: { $in: rows.map((r) => r._id) } })
    .select("itemId state product problem useBy").lean() : [];
  const byId = new Map(entries.map((e) => [String(e.itemId), e]));
  return rows.map((r) => {
    const ledger = byId.get(String(r._id)), reason = r.rewardBlocked ? "Verified reward details changed; review required" : eligibility(r.reward);
    return { ...r, shop: ledger ? { state: ledger.state, product: ledger.product, reason: ledger.problem || "" } : {
      state: reason ? "review" : r.reward.useBy <= now + 36 * 3600e3 ? "expiring" : r.revealedAt ? "held" : "pending",
      reason: reason || (r.revealedAt ? "Code was revealed; review before selling" : "Waiting for the next code-shop cycle"),
    }, rewardLabel: r.reward ? labelOf(r.reward) : "", useBy: r.reward?.useBy || null };
  });
}

async function reveal(Model, id, now) {
  return shop().exclusive(async () => {
    const stock = await Stock().findOne({ itemId: id, loginId: /^tiktok:/ }).select("state").lean();
    if (stock && stock.state !== "in_stock" && stock.state !== "held" && stock.state !== "expired" && stock.state !== "expiring")
      return { status: 409, error: "This code is allocated or sold. Manage it in Code shop to avoid giving it out twice." };
    const row = await Model.findOneAndUpdate({ _id: id, state: "completed", code: { $exists: true } },
      { $set: { revealedAt: new Date(now) } }, { returnDocument: "after", timestamps: false }).select("+code").lean();
    if (!row) return { status: 404, error: "Code not found" };
    await Stock().updateOne({ itemId: id, loginId: /^tiktok:/, state: "in_stock" }, { $set: {
      state: "held", problem: "its code was shown in the farm panel" }, $push: { history: { $each: [{ at: new Date(now),
        from: "in_stock", to: "held", why: "its code was shown in the farm panel" }], $slice: -20 } } });
    return { code: require("../utils/secretBox").decrypt(row.code) };
  });
}

function mount(router, { Model, authenticate, jsonOnly, wrap, admin, now }) {
  router.post("/api/tiktok-farm/worker/stock", authenticate, jsonOnly, wrap(async (req, res) => {
    const { id, account, codeHash, reward, error } = req.body || {};
    if (!OBJECT_ID.test(id || "") || !/^tiktok-\d{2}$/.test(account || "") || !/^[a-f0-9]{64}$/.test(codeHash || ""))
      return res.status(400).json({ error: "Invalid reward identity" });
    const query = { _id: id, account, state: "completed", codeHash };
    const row = await Model.findOne(query).select("campaign task reward").lean();
    if (!row) return res.status(409).json({ error: "Stored reward does not match" });
    if (error) {
      await Model.updateOne(query, { $set: { rewardCheckError: "Reward details could not be verified",
        rewardNextCheckAt: new Date(now() + 3600e3) } }, { timestamps: false });
      return res.json({ ok: true, verified: false });
    }
    const parsed = parseReward(reward);
    if (!parsed || parsed.campaign !== row.campaign || row.task !== "auto" && parsed.task !== row.task)
      return res.status(400).json({ error: "Reward metadata is incomplete or mismatched" });
    if (row.reward && (["gameId", "giftId", "task", "redeemType", "redeemUrl"].some((k) => row.reward[k] !== parsed[k]) ||
        JSON.stringify(row.reward.items) !== JSON.stringify(parsed.items))) {
      await Model.updateOne(query, { $set: { rewardBlocked: true, rewardCheckError: "Verified reward details changed; review required" } }, { timestamps: false });
      return res.status(409).json({ error: "Stored reward identity changed" });
    }
    await Model.updateOne(query, { $set: { reward: { ...parsed, verifiedAt: now() }, rewardCheckError: "",
      rewardNextCheckAt: new Date(now() + 6 * 3600e3) } }, { timestamps: false });
    res.json({ ok: true, verified: true });
  }));
  router.get("/api/tiktok-farm/sales", ...admin, wrap(async (_req, res) => {
    const cfg = await shop().modules.config.get();
    const products = await require("../models/CodeProduct").find({ groupKeys: /:tiktok-/ })
      .select("name status texts.title pricing useBy proposed publish offer slots.slotKey").lean();
    const offers = products.map((p) => p.offer).filter(Boolean);
    const listings = offers.length ? await require("../models/MarketplaceListing").find({ accountOffer: { $in: offers } })
      .select("accountOffer marketplace status url title price quantity").lean() : [];
    const counts = await Stock().aggregate([{ $match: { loginId: /^tiktok:/ } }, { $group: { _id: "$state", count: { $sum: 1 } } }]);
    const dates = await Stock().aggregate([{ $match: { loginId: /^tiktok:/, state: { $in: ["in_stock", "in_unit"] } } },
      { $group: { _id: "$slotKey", at: { $min: "$useBy" } } }]);
    const dateOfSlot = new Map(dates.filter((r) => r.at).map((r) => [r._id, +r.at]));
    const pending = await Model.find({ state: "completed", code: { $exists: true } })
      .select("account campaign task eventName reward revealedAt rewardCheckError rewardBlocked").lean();
    res.json({ enabled: cfg.sources.tiktok === true, autoPublish: cfg.autoPublish, leadHours: cfg.expiryLeadHours,
      products: products.map((p) => { const times = p.slots.map((s) => dateOfSlot.get(s.slotKey)).filter(Number.isFinite); return {
        ...p, useBy: times.length ? new Date(Math.min(...times)) : p.useBy,
        listings: listings.filter((l) => String(l.accountOffer) === String(p.offer)) }; }),
      counts: Object.fromEntries(counts.map((c) => [c._id, c.count])), inventory: await inventoryStatus(pending, now()) });
  }));
}
module.exports = { mount, reveal, inventoryStatus };
