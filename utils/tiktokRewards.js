"use strict";
// Redemption metadata is verified against the issued code, never inferred from
// a campaign deadline. Unknown games remain visible but do not enter stock.
const ID = /^\d{1,22}$/;
const PROFILES = Object.freeze({
  "7276576189992524804": { gameNo: "930001", name: "Infinity Nikki", host: "", type: 2 },
  "7277023276584526852": { gameNo: "930002", name: "Happy Clinic", host: "store.nordcurrent.com", type: 1 },
  "7277642444328522756": { gameNo: "930003", name: "World of Tanks", host: "worldoftanks.eu", type: 1 },
  "7279025357352522244": { gameNo: "930004", name: "Wolvesville", host: "vouchers.wolvesville.com", type: 1 },
  "7223211460934503169": { gameNo: "930005", name: "PUBG MOBILE", host: "www.pubgmobile.com", path: "/en/event/redeemcode/", type: 1 },
  "7276730075688531204": { gameNo: "930006", name: "Delta Force Mobile", host: "www.playdeltaforce.com", path: "/en/cdkredeem.html", type: 1 },
  "7276547073576525572": { gameNo: "930007", name: "Delta Force", host: "www.playdeltaforce.com", path: "/en/cdkredeem.html", type: 1 },
  "7278453307944521732": { gameNo: "930008", name: "OneState", host: "onestate.com", path: "/promocode", type: 1, rewardName: /^\$10k State Bucks US$/ },
});
const date = (v) => Number.isSafeInteger(v) && v >= 946684800000 && v < 4102444800000;
const text = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\x00-\x08\x0b-\x1f]/.test(v);
function imageUrl(value) {
  if (typeof value !== "string" || value.length > 2000) return "";
  try {
    const u = new URL(value);
    const nativeCdn = [".tiktokcdn.com", ".tiktokcdn-us.com"].some((suffix) => u.hostname.endsWith(suffix));
    if (!["https:", "http:"].includes(u.protocol) || !nativeCdn || u.username || u.password || u.port || u.hash) return "";
    // The US native response still sends http links; the same signed artwork
    // supports HTTPS. Covers only fetch the upgraded URL.
    u.protocol = "https:";
    return u.href;
  } catch { return ""; }
}
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
      ["items", value.items.map(({ name, count }) => ({ name: name.trim(), count }))], ["image", imageUrl(value.image)],
    ]));
}
function eligibility(reward) {
  if (!reward?.verifiedAt || !parseReward(reward)) return "Waiting for verified reward and redemption dates";
  const profile = PROFILES[reward.gameId];
  if (!profile || profile.name !== reward.gameName) return "New game: redemption guide needs review";
  if (reward.redeemType !== profile.type) return "Redemption method needs review";
  if (profile.host && (!reward.redeemUrl || new URL(reward.redeemUrl).hostname !== profile.host)) return "Redemption region or website needs review";
  if (profile.path && new URL(reward.redeemUrl).pathname !== profile.path) return "Redemption region or website needs review";
  if (profile.rewardName && !profile.rewardName.test(reward.name)) return "Reward region needs review";
  if (profile.type === 2 && !/Pear-Pal.*Other.*Redeem Code/i.test(reward.instructions)) return "Redemption instructions need review";
  return "";
}
function labelOf(reward) {
  return (Array.isArray(reward?.items) ? reward.items : []).map((i) => `${i.count}x ${i.name}`).join(" + ");
}
// Only this verified cosmetic gets a descriptive buyer label. Preserve its
// native name separately; never strip platform words from arbitrary rewards.
function buyerLabelOf(reward) {
  if (reward?.gameId === "7279025357352522244" && reward.items?.length === 1 &&
      reward.items[0].name === "TikTok Hair" && reward.items[0].count === 1) return "1x Hair Cosmetic";
  return labelOf(reward);
}
module.exports = { parseReward, eligibility, labelOf, buyerLabelOf, imageUrl, PROFILES };
