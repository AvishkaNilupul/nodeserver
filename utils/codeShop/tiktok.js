"use strict";
const { parseReward, eligibility, labelOf, buyerLabelOf, imageUrl, PROFILES } = require("../tiktokRewards");
const PREFIX = "tiktok:";
const loginId = (account) => PREFIX + account;
const itemKey = (id) => "run-" + id;
function parse(login, key) {
  const account = String(login || "").slice(PREFIX.length);
  const match = /^run-([a-f0-9]{24})$/.exec(String(key || ""));
  return String(login).startsWith(PREFIX) && /^tiktok-\d{2}$/.test(account) && match ? { account, _id: match[1] } : null;
}
function model(deps) {
  return deps?.models ? deps.models.TikTokFarmRun : require("../../models/TikTokFarmRun");
}
async function rows(deps) {
  const Run = model(deps);
  if (!Run) return [];
  const runs = await Run.find({ state: "completed", rewardBlocked: { $ne: true }, code: { $exists: true }, "reward.verifiedAt": { $exists: true } })
    .select("account campaign task reward createdAt +code").lean();
  const out = [];
  for (const run of runs) {
    const r = run.reward;
    if (eligibility(r) || r.campaign !== run.campaign || (run.task !== "auto" && r.task !== run.task)) continue;
    const game = PROFILES[r.gameId], groupKey = `${game.gameNo}:tiktok-${r.campaign}`;
    out.push({ loginId: loginId(run.account), itemKey: itemKey(run._id), itemId: run._id,
      gameNo: game.gameNo, gameName: game.name, campaignIdx: "tiktok-" + r.campaign,
      campaignTitle: "", campaignEndAt: new Date(r.campaignEndAt), groupKey,
      // Native task IDs keep equally named rewards from switching slots when
      // different accounts earn them in a different order.
      explicitSlotKey: `${groupKey}:task-${r.task}`, nameRaw: labelOf(r), name: buyerLabelOf(r), image: imageUrl(r.image),
      earnedAt: run.createdAt, useBy: new Date(r.useBy), codeEnc: run.code, source: "tiktok" });
  }
  return out;
}
async function encrypted(deps, identities) {
  const Run = model(deps);
  if (!Run || !identities.length) return [];
  const now = deps?.now ? Number(deps.now()) : Date.now();
  const rows = await Run.find({ $or: identities, state: "completed", rewardBlocked: { $ne: true } }).select("account reward +code").lean();
  return rows.filter((r) => !eligibility(r.reward) && r.reward.useBy > now + 36 * 3600e3);
}
async function reveals(deps) {
  const Run = model(deps);
  if (!Run) return new Map();
  const runs = await Run.find({ revealedAt: { $ne: null } }).select("revealedAt").lean();
  return new Map(runs.filter((r) => r.revealedAt).map((r) => [String(r._id), +new Date(r.revealedAt)]));
}
// Native artwork URLs expire independently of the reward. Resolve the latest
// verified URL when rendering a cover, including products approved earlier.
async function images(deps, slots) {
  const keys = new Set(slots.map((s) => s.slotKey).filter((k) => /^\d+:tiktok-\d+:task-\d+$/.test(k)));
  const result = new Map();
  if (!keys.size) return result;
  const Run = model(deps);
  if (!Run) return result;
  const campaigns = [...new Set([...keys].map((k) => k.split(":")[1].slice(7)))];
  const rows = await Run.find({ state: "completed", rewardBlocked: { $ne: true }, campaign: { $in: campaigns },
    "reward.verifiedAt": { $exists: true } }).select("reward").sort({ "reward.verifiedAt": -1 }).lean();
  for (const { reward: r } of rows) {
    if (eligibility(r)) continue;
    const key = `${PROFILES[r.gameId].gameNo}:tiktok-${r.campaign}:task-${r.task}`;
    if (keys.has(key) && !result.has(key) && imageUrl(r.image)) result.set(key, imageUrl(r.image));
  }
  return result;
}
async function withdrawBlocked(deps) {
  const Run = model(deps);
  if (!Run) return;
  const runs = await Run.find({ rewardBlocked: true }).select("_id").lean();
  if (!runs.length) return;
  const Stock = deps?.models?.CodeStock || require("../../models/CodeStock");
  const affected = await Stock.find({ itemId: { $in: runs.map((r) => r._id) }, loginId: /^tiktok:/,
    state: { $in: ["in_stock", "in_unit"] } }).select("unit state").lean();
  const pull = require("./reconcile").pullerOf(deps), pulled = new Set();
  for (const row of affected) {
    if (row.state === "in_unit" && !pulled.has(String(row.unit))) {
      if (!await pull(row.unit, { note: "code unit — reward identity needs review" })) continue;
      pulled.add(String(row.unit));
    }
    await Stock.updateOne({ _id: row._id, state: row.state }, { $set: { state: "held", problem: "Verified reward details changed; review required" } });
  }
}
module.exports = { PREFIX, loginId, itemKey, parse, rows, encrypted, reveals, images, withdrawBlocked, parseReward, eligibility };
