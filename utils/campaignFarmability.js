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

// PROVEN subscriber-only: the manifest records requiredSubs, lists at least one
// drop, and not one of them can be earned by watching.
//
// This is the test for SPENDING on a campaign (a probe slot, pool accounts, a
// storefront pre-order), so it is deliberately narrower than !manifestFarmable:
// an empty drop list proves nothing about subscriptions and stays "not proven".
// On 2026-10-08 six of the eight probe slots (90 pool accounts) sat on badge
// campaigns whose only drop was 0 minutes / 1 sub — some since 09-29 — while
// six other games waited in the probe queue, two of them subscriber-only too.
function manifestSubOnly(manifest) {
  return (
    watchabilityKnown(manifest) &&
    manifest.drops.length > 0 &&
    !manifest.drops.some(isWatchableDrop)
  );
}

// The off switch. Everything that ACTS on the answer above — the decision gate
// in both engines and the early end of a stuck probe — is inert when
// autoFarm.subOnlyGuard is false, and the engines decide exactly as they did
// before the gate existed. On unless switched off; no restart needed:
//   require("./utils/settings").setAutoFarm({ subOnlyGuard: false })
// The park and wake rules (manifestFarmable, farmableCampaigns) do not read it.
function guardOn(af) {
  return !af || af.subOnlyGuard !== false;
}

// The words both engines record for it, so the row reads the same whichever
// engine decided the campaign.
const SUB_ONLY_REASON =
  "Every drop in this campaign needs a paid Twitch subscription — watching " +
  "cannot earn it. No accounts spent.";

// One campaign → is it proven subscriber-only? Never throws: a manifest that
// is missing, was saved before requiredSubs was recorded, or cannot be read
// answers false, so the campaign is decided exactly as it always was. A
// disconnected database is "cannot be read" too — asking would only queue the
// read behind Mongoose's buffer and stall the decision for its timeout.
async function campaignSubOnly(campaignId) {
  if (campaignId == null || campaignId === "") return false;
  if (CampaignDrops.db.readyState !== 1) return false;
  try {
    const manifest = await CampaignDrops.findOne(
      { campaignId: String(campaignId) },
      { campaignId: 1, watchVersion: 1, drops: 1 },
    ).lean();
    return manifestSubOnly(manifest);
  } catch {
    return false;
  }
}

module.exports = {
  WATCH_VERSION,
  SUB_ONLY_REASON,
  isWatchableDrop,
  watchabilityKnown,
  manifestFarmable,
  manifestSubOnly,
  farmableCampaigns,
  campaignSubOnly,
  guardOn,
};
