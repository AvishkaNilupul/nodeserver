// Find active tasks that are FARMED but UNLISTED due to stale scan data:
// no live gameflip listing, yet assigned accounts LIVE-hold the full bundle
// (checked against Twitch, not the possibly-stale DropLog). Read-only report.
process.chdir("/var/www/redeemer/nodeserver");
require("dotenv").config();
const mongoose = require("mongoose");
const config = require("./config/config");
const AFT = require("./models/AutoFarmTask");
const BotAccount = require("./models/BotAccount");
const autoLister = require("./utils/autoLister");
const mp = require("./utils/marketplaces");
const { fetchCampaignDetails, fetchInventory } = require("./utils/twitchInventory");

async function hasLiveGameflip(task) {
  const ext = task.listing && task.listing.externalId;
  if (!ext) return false;
  try {
    const st = await mp.gameflipListingStatus(ext);
    return st && st !== "expired";
  } catch (e) {
    if (/404|not.?found/i.test(String(e.message || ""))) return false;
    return true;
  }
}

async function main() {
  await mongoose.connect(config.MONGO_URI);
  const okTok = await BotAccount.findOne({ clientSecret: { $ne: "" }, lastScanStatus: "ok" }, { clientSecret: 1 }).lean();
  const tasks = await AFT.find({ status: "active" }).lean();
  console.log("active tasks:", tasks.length, "\n");
  const candidates = [];
  for (const t of tasks) {
    if (await hasLiveGameflip(t)) continue;
    // resolve campaign items (live)
    let keys = [];
    try {
      const camp = await fetchCampaignDetails(okTok.clientSecret, t.campaignId);
      const r = autoLister.resolveCampaignItems(camp, { game: t.game, campaignName: t.campaignName });
      keys = [...new Set(r.items.map((i) => i.itemKey.split("|")[0]))].map((s) => s.toLowerCase());
      if (!r.items.length) continue; // placeholder/unresolvable
    } catch { continue; }
    // live-check up to 6 assigned accounts for the full bundle
    let liveHolders = 0, checked = 0;
    for (const login of (t.assignedAccounts || []).slice(0, 6)) {
      const acc = await BotAccount.findOne({ login: new RegExp("^" + login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$", "i") }, { clientSecret: 1 }).lean();
      if (!acc || !acc.clientSecret) continue;
      checked++;
      try {
        const inv = await fetchInventory(acc.clientSecret);
        const names = (inv.drops || []).filter((d) => !d.connected).map((d) => String(d.name || "").toLowerCase());
        const holdsAll = keys.every((k) => names.some((n) => n.includes(k)));
        if (holdsAll) liveHolders++;
      } catch {}
    }
    if (liveHolders > 0) {
      candidates.push({ id: String(t._id), game: t.game, campaign: t.campaignName, liveHolders, checked });
      console.log("FARMED-BUT-UNLISTED (stale scan): " + t.game + " — " + t.campaignName + " (" + liveHolders + "/" + checked + " sampled hold full bundle live)");
    }
  }
  console.log("\ncandidates:", candidates.length);
  require("fs").writeFileSync("/tmp/more_like_this.json", JSON.stringify(candidates, null, 2));
  await mongoose.disconnect();
}
main().catch((e) => { console.error("ERR", e); process.exit(1); });
