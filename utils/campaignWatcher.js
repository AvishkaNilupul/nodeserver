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
const { fetchDropCampaigns } = require("./twitchInventory");
const { sendTelegram } = require("./telegram");

const TICK_MS = 6 * 60 * 60 * 1000; // every 6 hours

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastCounts: { active: 0, upcoming: 0, new: 0, started: 0, ended: 0 },
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
  const ordered = [...ok, ...rest].slice(0, 5);
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

    state.lastCounts = {
      active,
      upcoming,
      new: fresh.length,
      started: wentLive.length,
      ended: gone.modifiedCount || 0,
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
    try {
      await runOnce();
    } catch (err) {
      console.error("campaignWatcher error:", err.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, 35000);
  if (t.unref) t.unref();
}

module.exports = { start, runOnce, status };
