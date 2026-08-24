// Twitch drop-campaign watcher: keeps a local catalog of every drop campaign
// on Twitch's drops dashboard (active + upcoming) and alerts when a new
// farmable campaign appears or an upcoming one goes live, so the bot fleet
// can be pointed at it early.
//
// The dashboard query needs any logged-in Twitch token, so each pass borrows
// the token of a healthy bot account (same tokens the drop scanner already
// uses; the query is read-only).
const BotAccount = require("../models/BotAccount");
const TwitchCampaign = require("../models/TwitchCampaign");
const CampaignDrops = require("../models/CampaignDrops");
const { fetchDropCampaigns, fetchCampaignDetails, itemKeyFor } = require("./twitchInventory");
const { sendTelegram } = require("./telegram");
const settings = require("./settings");

const TICK_MS = 2 * 60 * 60 * 1000; // every 2 hours
// How often a campaign's expected-drops manifest (models/CampaignDrops.js) is
// re-fetched. A campaign's drop list is static for its lifetime, so 6h is far
// more than enough — this only bounds how long a newly-spotted campaign waits
// before verify-earned can check against its real drops.
const MANIFEST_TTL_MS = 6 * 60 * 60 * 1000;
// Don't hammer Twitch with per-campaign detail reads — space them out and cap
// the backlog a single pass will chew through.
const MANIFEST_POLITE_MS = 250;
const MANIFEST_PASS_MAX = 40;
// A failed pass (every borrowed token integrity-gated, network blip) used to
// wait a full interval before trying again, so campaign discovery — and with
// it bot waking and auto-farm decisions — stalled for hours. Errors retry on
// this much shorter fuse instead.
const RETRY_MS = 10 * 60 * 1000;

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastCounts: { active: 0, upcoming: 0, new: 0, started: 0, ended: 0, manifests: 0 },
};

// Prefer accounts whose last scan succeeded; fall back to trying a few others
// rather than failing the whole pass on one bad token.
async function fetchWithAnyToken() {
  const candidates = await BotAccount.find({
    clientSecret: { $exists: true, $ne: "" },
  })
    .sort({ lastScanAt: -1 })
    .lean();
  const ok = candidates.filter((a) => a.lastScanStatus === "ok");
  const rest = candidates.filter((a) => a.lastScanStatus !== "ok");
  const ordered = [...ok, ...rest].slice(0, 10);
  if (!ordered.length) {
    throw new Error("No bot account tokens available for the campaign query");
  }
  let lastErr = null;
  for (const acc of ordered) {
    try {
      return await fetchDropCampaigns(acc.clientSecret);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Campaign query failed on every token");
}

// One healthy token for read-only detail queries (same rule the Scout's
// borrowTokens uses: prefer accounts whose last scan succeeded).
async function borrowToken() {
  const acc = await BotAccount.findOne({
    clientSecret: { $exists: true, $ne: "" },
    lastScanStatus: "ok",
  })
    .sort({ lastScanAt: -1 })
    .lean();
  return acc ? String(acc.clientSecret || "").trim() : null;
}

// Persist each ACTIVE campaign's expected drops so the finished verdict can
// verify an account actually holds THIS campaign's drops before parking
// (utils/farmCompletion.js requireEarned). Read-only, ~6h TTL, and failures
// are logged but NEVER break the catalog refresh below.
async function refreshDropsManifests() {
  // No verify-earned, no manifests — keeps the watcher network-neutral while
  // the switch is off (the Scout's "no calls until configured" principle).
  if (!settings.getAutoFarm().verifyEarnedBeforePark) return 0;
  const now = new Date();
  const active = await TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    { campaignId: 1, game: 1, name: 1 },
  ).lean();
  if (!active.length) return 0;
  const ids = active.map((c) => c.campaignId);
  const existing = await CampaignDrops.find(
    { campaignId: { $in: ids } },
    { campaignId: 1, fetchedAt: 1 },
  ).lean();
  const freshIds = new Set(
    existing
      .filter(
        (m) =>
          m.fetchedAt &&
          now - new Date(m.fetchedAt).getTime() < MANIFEST_TTL_MS,
      )
      .map((m) => m.campaignId),
  );
  const need = active
    .filter((c) => !freshIds.has(c.campaignId))
    .slice(0, MANIFEST_PASS_MAX);
  if (!need.length) return 0;
  const token = await borrowToken();
  if (!token) return 0;
  let done = 0;
  for (const c of need) {
    try {
      const camp = await fetchCampaignDetails(token, c.campaignId);
      const drops = ((camp && camp.timeBasedDrops) || []).map((d) => {
        const edge = (d.benefitEdges && d.benefitEdges[0]) || {};
        const b = edge.benefit || {};
        const bg = b.game || camp.game || null;
        const name = b.name || d.name || "";
        const game = bg ? bg.displayName || bg.name || "" : "";
        return {
          benefitId: String(b.id || d.id || ""),
          dropId: String(d.id || ""),
          name,
          itemKey: itemKeyFor(name, game),
        };
      });
      await CampaignDrops.updateOne(
        { campaignId: c.campaignId },
        {
          $set: {
            game: c.game,
            name: c.name,
            drops,
            fetchedAt: new Date(),
          },
        },
        { upsert: true },
      );
      done++;
    } catch (e) {
      console.error(
        "Campaign drops manifest failed for " + c.campaignId + ": " + (e.message || e),
      );
    }
    if (MANIFEST_POLITE_MS > 0) {
      await new Promise((r) => setTimeout(r, MANIFEST_POLITE_MS));
    }
  }
  return done;
}

function normalize(c) {
  return {
    campaignId: c.id,
    name: c.name || "",
    game: (c.game && (c.game.displayName || c.game.name)) || "",
    owner: (c.owner && c.owner.name) || "",
    status: c.status || "",
    startAt: c.startAt ? new Date(c.startAt) : null,
    endAt: c.endAt ? new Date(c.endAt) : null,
    detailsURL: c.detailsURL || "",
    accountLinkURL: c.accountLinkURL || "",
    image: c.imageURL || "",
    boxArt: (c.game && c.game.boxArtURL) || "",
    accountConnected: !!(c.self && c.self.isAccountConnected),
  };
}

function fmtWindow(o) {
  const f = (d) =>
    d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "?";
  return f(o.startAt) + " → " + f(o.endAt) + " UTC";
}

async function runOnce() {
  if (state.running) return state.lastCounts;
  state.running = true;
  try {
    const raw = (await fetchWithAnyToken()).filter((c) => c && c.id);
    const now = new Date();
    const seeding = (await TwitchCampaign.estimatedDocumentCount()) === 0;
    const seenIds = new Set();
    const fresh = [];
    const wentLive = [];
    let active = 0;
    let upcoming = 0;

    for (const c of raw) {
      const o = normalize(c);
      // The dashboard also returns long-expired campaigns; skip them.
      if (o.status === "EXPIRED" || (o.endAt && o.endAt < now)) continue;
      seenIds.add(o.campaignId);
      if (o.status === "ACTIVE") active++;
      else upcoming++;
      const prev = await TwitchCampaign.findOneAndUpdate(
        { campaignId: o.campaignId },
        { $set: { ...o, active: true, lastSeenAt: now } },
        { upsert: true, returnDocument: "before" },
      );
      if (!prev) fresh.push(o);
      else if (prev.status !== "ACTIVE" && o.status === "ACTIVE") {
        wentLive.push(o);
      }
    }

    // Campaigns gone from the dashboard have ended.
    const gone = await TwitchCampaign.updateMany(
      { active: true, campaignId: { $nin: [...seenIds] } },
      { $set: { active: false, status: "EXPIRED" } },
    );

    for (const o of seeding ? [] : fresh) {
      await sendTelegram(
        "🟣 Twitch Drops: new campaign — " +
          o.name +
          " [" +
          o.game +
          "] (" +
          (o.status === "ACTIVE" ? "LIVE now" : "upcoming") +
          ")\n" +
          fmtWindow(o) +
          (o.detailsURL ? "\n" + o.detailsURL : ""),
      ).catch(() => {});
      await TwitchCampaign.updateOne(
        { campaignId: o.campaignId },
        { $set: { notifiedAt: now } },
      ).catch(() => {});
    }

    for (const o of seeding ? [] : wentLive) {
      const doc = await TwitchCampaign.findOne({
        campaignId: o.campaignId,
      }).lean();
      if (doc && doc.startedNotifiedAt) continue;
      await sendTelegram(
        "▶️ Twitch Drops: campaign is LIVE — " +
          o.name +
          " [" +
          o.game +
          "]\n" +
          fmtWindow(o) +
          (o.detailsURL ? "\n" + o.detailsURL : ""),
      ).catch(() => {});
      await TwitchCampaign.updateOne(
        { campaignId: o.campaignId },
        { $set: { startedNotifiedAt: now } },
      ).catch(() => {});
    }

    if (seeding && fresh.length) {
      await TwitchCampaign.updateMany({}, { $set: { notifiedAt: now } }).catch(
        () => {},
      );
      await sendTelegram(
        "🟣 Twitch campaign watcher is live — tracking " +
          active +
          " active and " +
          upcoming +
          " upcoming drop campaign(s). You'll get a ping for every new " +
          "campaign and when an upcoming one goes live.",
      ).catch(() => {});
    }

    // Verify-earned manifests: additive and failure-tolerant, so a Twitch
    // hiccup here can never break the catalog refresh above.
    let manifests = 0;
    try {
      manifests = await refreshDropsManifests();
    } catch (e) {
      console.error("Campaign drops manifest refresh failed:", e.message || e);
    }

    state.lastCounts = {
      active,
      upcoming,
      new: fresh.length,
      started: wentLive.length,
      ended: gone.modifiedCount || 0,
      manifests,
    };
    state.lastError = "";
    return state.lastCounts;
  } catch (err) {
    state.lastError = err.message || String(err);
    throw err;
  } finally {
    state.lastRun = new Date();
    state.running = false;
  }
}

function status() {
  return {
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastCounts: state.lastCounts,
    intervalHours: TICK_MS / 3600000,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    let delay = TICK_MS;
    try {
      await runOnce();
    } catch (err) {
      console.error("campaignWatcher error:", err.message);
      delay = RETRY_MS;
    }
    const t = setTimeout(tick, delay);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, 35000);
  if (t.unref) t.unref();
}

module.exports = { start, runOnce, status };
