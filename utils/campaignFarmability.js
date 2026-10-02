// Can a farm account actually EARN anything from this drop campaign?
//
// A time-based drop with requiredSubs > 0 is only granted to a viewer who
// subscribes — no amount of watching earns it, and TwitchDropsBot drops it from
// its own campaign list ("Removing time based drops that require subscription",
// then "No campaign found"). Counting such a campaign as live work kept bots up
// forever: "RL Worlds Sub Drops" (1 drop, 0 minutes, 1 sub) held every Rocket
// League bot on Contabo awake, and "DRON-E Chat Badge" (sub-only, no channel
// ACL) made the no-claim watcher read Rainbow Six as live around the clock.
//
// Watchability comes from the persisted manifest (models/CampaignDrops.js,
// refreshed by utils/campaignWatcher.js). Anything we cannot prove is
// unfarmable — no manifest yet, or a manifest fetched before requiredSubs was
// recorded — counts as FARMABLE, so a gap in the evidence can only ever keep a
// bot up, never strand one.
const CampaignDrops = require("../models/CampaignDrops");

// Bumped when a manifest carries per-drop requiredSubs/requiredMinutesWatched.
const WATCH_VERSION = 1;

function isWatchableDrop(d) {
  return !(Number(d && d.requiredSubs) > 0);
}

function watchabilityKnown(manifest) {
  return (
    !!manifest &&
    Number(manifest.watchVersion) >= WATCH_VERSION &&
    Array.isArray(manifest.drops)
  );
}

function manifestFarmable(manifest) {
  if (!watchabilityKnown(manifest)) return true;
  return manifest.drops.some(isWatchableDrop);
}

// campaigns: [{ campaignId, ... }] → the subset that can be earned by watching.
async function farmableCampaigns(campaigns) {
  const list = Array.isArray(campaigns) ? campaigns : [];
  const ids = list.map((c) => c && c.campaignId).filter(Boolean);
  if (!ids.length) return list.slice();
  const manis = await CampaignDrops.find(
    { campaignId: { $in: ids } },
    { campaignId: 1, watchVersion: 1, drops: 1 },
  ).lean();
  const byId = new Map(manis.map((m) => [m.campaignId, m]));
  return list.filter((c) => manifestFarmable(byId.get(c && c.campaignId)));
}

module.exports = {
  WATCH_VERSION,
  isWatchableDrop,
  watchabilityKnown,
  manifestFarmable,
  farmableCampaigns,
};
