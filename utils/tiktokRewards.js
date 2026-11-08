"use strict";
// Redemption metadata is verified against the issued code, never inferred from
// a campaign deadline. Unknown games remain visible but do not enter stock.
const ID = /^\d{1,22}$/;
const PROFILES = Object.freeze({
  "7276576189992524804": { gameNo: "930001", name: "Infinity Nikki", host: "", type: 2 },
  "7277023276584526852": { gameNo: "930002", name: "Happy Clinic", host: "store.nordcurrent.com", type: 1 },
  "7277642444328522756": { gameNo: "930003", name: "World of Tanks", host: "worldoftanks.eu", type: 1 },
  "7279025357352522244": { gameNo: "930004", name: "Wolvesville", host: "vouchers.wolvesville.com", type: 1 },
});
const date = (v) => Number.isSafeInteger(v) && v >= 946684800000 && v < 4102444800000;
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\x00-\x08\x0b-\x1f]/.test(v);
function parseReward(value) {
  if (!value || ![value.campaign, value.task, value.gameId, value.giftId].every((v) => typeof v === "string" && ID.test(v)) ||
      !text(value.gameName, 100) || !text(value.name, 160) || value.needAuth !== false ||
      ![value.campaignStartAt, value.campaignEndAt, value.useBy].every(date) ||
      value.campaignStartAt >= value.campaignEndAt || value.useBy <= value.campaignStartAt ||
      ![1, 2].includes(value.redeemType) || typeof value.redeemUrl !== "string" || value.redeemUrl.length > 500 ||
      !text(value.instructions, 1500) || !Array.isArray(value.items) || !value.items.length || value.items.length > 12 ||
      !value.items.every((i) => i && text(i.name, 120) && Number.isSafeInteger(i.count) && i.count > 0 && i.count <= 1e9)) return null;
  if (value.redeemUrl) {
    try { const u = new URL(value.redeemUrl); if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null; }
    catch { return null; }
  }
  return Object.fromEntries(["campaign", "task", "gameId", "gameName", "giftId", "name", "needAuth", "campaignStartAt",
    "campaignEndAt", "useBy", "redeemType", "redeemUrl", "instructions"].map((k) => [k, value[k]]).concat([
      ["items", value.items.map(({ name, count }) => ({ name: name.trim(), count }))],
    ]));
}
function eligibility(reward) {
  if (!reward?.verifiedAt || !parseReward(reward)) return "Waiting for verified reward and redemption dates";
  const profile = PROFILES[reward.gameId];
  if (!profile || profile.name !== reward.gameName) return "New game: redemption guide needs review";
  if (reward.redeemType !== profile.type) return "Redemption method needs review";
  if (profile.host && (!reward.redeemUrl || new URL(reward.redeemUrl).hostname !== profile.host)) return "Redemption region or website needs review";
  if (profile.type === 2 && !/Pear-Pal.*Other.*Redeem Code/i.test(reward.instructions)) return "Redemption instructions need review";
  return "";
}
function labelOf(reward) {
  return (Array.isArray(reward?.items) ? reward.items : []).map((i) => `${i.count}x ${i.name}`).join(" + ");
}
module.exports = { parseReward, eligibility, labelOf, PROFILES };
