// Stream Scout — the server-side "is a drop actually watchable right now?"
// signal that lets botWaker park idle containers during broadcast gaps and wake
// them the moment a qualifying stream goes live. See docs/STREAM-SCOUT-PLAN.md.
//
// WHY THIS EXISTS
// A campaign being *live* (within its calendar window) and a channel-locked drop
// being *earnable right now* are two different questions. botWaker used to
// conflate them — it woke a container on the campaign's startAt and left it
// idle-polling Twitch for days even when no allowed channel was broadcasting.
// The Scout answers the second question every few minutes so wake/park track
// real watchability instead of the calendar.
//
// WHY GATING ON THE CAMPAIGN'S OWN ACL IS THE RIGHT SIGNAL
// The .NET bot (SelectBroadcasterAsync) watches ONLY the channels in the
// campaign's allow-list (campaign.Allow.Channels) that are live and on the right
// game. So if the Scout checks liveness of those SAME channels, its verdict
// matches exactly what the container will farm — no hand-curated channel map to
// drift out of date (docs/STREAM-SCOUT-PLAN.md §13a). streamGatedGames only
// decides WHICH games we bother gating (opt-in, keyword match); the channels
// come from the campaign itself, with an optional per-game override.
//
// FAIL TOWARD FARMING
// A needless wake costs RAM; a missed wake costs drops forever. So every
// uncertainty here resolves toward "watchable": no tokens to check with, no ACL
// on the campaign, an errored pass — all leave the campaign un-gated or its row
// stale, and botWaker treats a missing/stale row as farmable.
//
// Read-only and tokenless-capable: liveness reads never hit the integrity gate,
// so the Scout can never burn or degrade a farming account.
const TwitchCampaign = require("../models/TwitchCampaign");
const CampaignLiveState = require("../models/CampaignLiveState");
const BotAccount = require("../models/BotAccount");
const { getStreamsLive, getGameDropsLive } = require("./twitchWatch");
const { fetchCampaignDetails } = require("./twitchInventory");
const settings = require("./settings");

const TICK_MS = Number(process.env.STREAM_SCOUT_TICK_MS) || 3 * 60 * 1000; // 3 min
// A failed pass retries on a short fuse rather than waiting a full interval —
// liveness is time-sensitive.
const RETRY_MS = 60 * 1000;
// A campaign's ACL rarely changes; cache it in-memory and only re-fetch this
// often. (The channel LIVENESS is what changes minute to minute, not the list.)
const ACL_TTL_MS = 6 * 60 * 60 * 1000; // 6h

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastCounts: { tracked: 0, gated: 0, live: 0, transitions: 0, errors: 0 },
};

// campaignId -> { channels: [login], fetchedAt: ms }
const aclCache = new Map();

function norm(s) {
  return String(s || "")
    .trim()
    .toLowerCase();
}

// Healthy tokens to read liveness with. getStreamInfo works read-only; we prefer
// accounts whose last scan succeeded and rotate off any that turn out dead.
async function borrowTokens(limit = 5) {
  const rows = await BotAccount.find(
    { clientSecret: { $exists: true, $ne: "" }, lastScanStatus: "ok" },
    { clientSecret: 1 },
  )
    .sort({ lastScanAt: -1 })
    .limit(limit)
    .lean();
  return rows.map((r) => String(r.clientSecret || "").trim()).filter(Boolean);
}

// The channels the campaign's ACL says credit this drop (logins). Cached.
async function aclChannels(campaignId, token) {
  const hit = aclCache.get(campaignId);
  if (hit && Date.now() - hit.fetchedAt < ACL_TTL_MS) return hit.channels;
  let channels = [];
  try {
    const camp = await fetchCampaignDetails(token, campaignId);
    const allow = camp && camp.allow;
    if (allow && allow.isEnabled !== false && Array.isArray(allow.channels)) {
      channels = allow.channels
        .map((c) => norm(c && c.name))
        .filter(Boolean);
    }
    aclCache.set(campaignId, { channels, fetchedAt: Date.now() });
  } catch {
    // Leave any prior cache entry in place; if there is none, return [] and the
    // caller treats the campaign as non-gated (fail toward farming).
    return hit ? hit.channels : [];
  }
  return channels;
}

// Resolve the full channel set to watch for a campaign: the campaign's ACL
// channels ∪ any per-game override in streamGatedGames. Returns { channels,
// source }.
async function resolveChannels(campaign, entry, token) {
  const override = Array.isArray(entry && entry.channels)
    ? entry.channels.map(norm).filter(Boolean)
    : [];
  const acl = token ? await aclChannels(campaign.campaignId, token) : [];
  const set = new Set([...acl, ...override]);
  const channels = [...set];
  let source = "none";
  if (acl.length && override.length) source = "both";
  else if (acl.length) source = "acl";
  else if (override.length) source = "override";
  return { channels, source };
}

// Twitch accepts a batch of logins per users() query, so an ACL of hundreds of
// co-streamer channels costs a handful of requests, not one per channel. (EWC
// 2026's ACL is 648 channels — one-at-a-time would be 648 reads per dark pass.)
const LIVENESS_BATCH = 100;

// Is any of these channels live right now? Checks in batches and early-exits on
// the first batch that contains a live channel (liveNow only needs one). Rotates
// off a dead token. Returns { liveNow, liveChannels }.
async function anyChannelLive(channels, tokens) {
  let tokenIdx = 0;
  const liveChannels = [];
  for (let i = 0; i < channels.length; i += LIVENESS_BATCH) {
    const chunk = channels.slice(i, i + LIVENESS_BATCH);
    let done = false;
    while (!done) {
      const token = tokens[tokenIdx] || null;
      try {
        const live = await getStreamsLive(token, chunk);
        for (const l of live) liveChannels.push(l);
        done = true;
      } catch (e) {
        if (e && e.code === "token_invalid" && tokenIdx + 1 < tokens.length) {
          tokenIdx++;
          continue; // retry this chunk with the next token
        }
        // Every OTHER failure — a dead last token, a 429/5xx, a network blip —
        // must NOT be allowed to read as "the channel is dark": that would let
        // a Twitch outage park gated bots (the §6 fail-toward-farming contract).
        // Throw so the caller records the error and marks the campaign
        // watchable for this pass.
        throw e;
      }
    }
    if (liveChannels.length) break; // one live channel is enough
  }
  return { liveNow: liveChannels.length > 0, liveChannels };
}

async function activeCampaigns() {
  const now = new Date();
  return TwitchCampaign.find(
    {
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    },
    { campaignId: 1, game: 1, name: 1 },
  ).lean();
}

// One pass. Never throws — records the error and returns the counts.
async function runOnce() {
  if (state.running) return state.lastCounts;
  state.running = true;
  const counts = { tracked: 0, gated: 0, live: 0, transitions: 0, errors: 0 };
  // First error seen this pass — surfaced on state.lastError so the loop
  // retries on the short fuse (RETRY_MS) instead of waiting a full tick, and
  // so an outage stays visible even when the failing campaign's row is
  // written as watchable.
  let passError = "";
  try {
    const gate = settings.getStreamGate();
    const haveGames = Object.keys(gate.games || {}).length > 0;
    // Nothing configured to gate → do no work at all (no Twitch calls). The
    // switch can be off while games are configured: the Scout still observes so
    // the UI shows liveness, but botWaker only ACTS when the switch is on.
    if (!gate.enabled && !haveGames) {
      state.lastCounts = counts;
      state.lastError = "";
      return counts;
    }

    const campaigns = await activeCampaigns();
    const tokens = await borrowTokens();
    const tracked = [];
    const transitions = [];

    for (const c of campaigns) {
      const entry = settings.streamGatedGameEntry(c.game);
      if (!entry) continue; // game not opted in — never gated
      counts.tracked++;
      tracked.push(c.campaignId);

      const prev = await CampaignLiveState.findOne({
        campaignId: c.campaignId,
      }).lean();
      const { channels, source } = await resolveChannels(c, entry, tokens[0]);
      const category = entry.mode === "category";

      // Not gateable (no ACL, no override channels, and not category mode) →
      // record it as watchable so behaviour is identical to today.
      if (!channels.length && !category) {
        await upsert(c, {
          gated: false,
          source: "none",
          channels: [],
          liveChannels: [],
          liveNow: true,
          lastLiveAt: new Date(),
          darkSince: null,
          checkedAt: new Date(),
          lastError: "",
        });
        continue;
      }

      counts.gated++;
      let liveNow = false;
      let liveChannels = [];
      let lastError = "";
      if (!tokens.length) {
        // No token to check with → fail toward farming: mark watchable, keep
        // checkedAt fresh (a real Scout outage is caught by botWaker staleness).
        liveNow = true;
        lastError = "no token to check liveness";
      } else if (channels.length) {
        // Channel-locked: is any allowed channel live?
        try {
          const res = await anyChannelLive(channels, tokens);
          liveNow = res.liveNow;
          liveChannels = res.liveChannels;
        } catch (e) {
          counts.errors++;
          liveNow = true; // fail toward farming
          lastError = (e && e.message) || String(e);
          if (!passError) passError = lastError;
        }
      } else {
        // Category mode (Phase 2): is any drops-enabled channel live in the
        // game's directory? Rotate off a dead token.
        let tokenIdx = 0;
        let done = false;
        while (!done) {
          const token = tokens[tokenIdx] || null;
          try {
            const chans = await getGameDropsLive(token, c.game);
            liveChannels = chans.slice(0, 10);
            liveNow = chans.length > 0;
            done = true;
          } catch (e) {
            if (
              e &&
              e.code === "token_invalid" &&
              tokenIdx + 1 < tokens.length
            ) {
              tokenIdx++;
              continue;
            }
            counts.errors++;
            liveNow = true; // fail toward farming
            lastError = (e && e.message) || String(e);
            if (!passError) passError = lastError;
            done = true;
          }
        }
      }
      if (liveNow) counts.live++;

      const now = new Date();
      const wasLive = !!(prev && prev.liveNow);
      await upsert(c, {
        gated: true,
        source: channels.length ? source : "category",
        // An ACL can list hundreds of channels; store a bounded sample for the
        // UI (the gate reads liveNow/lastLiveAt, never the full list).
        channels: channels.slice(0, 50),
        liveChannels,
        liveNow,
        checkedAt: now,
        lastError,
        lastLiveAt: liveNow ? now : prev ? prev.lastLiveAt || null : null,
        // darkSince: stamp on live→dark, hold while dark, clear while live.
        darkSince: liveNow ? null : prev && prev.darkSince ? prev.darkSince : now,
      });

      // A real dark→live flip on a gated campaign is worth an immediate wake
      // nudge (cuts wake latency from ~10min tick to ~one Scout pass).
      if (gate.enabled && liveNow && !wasLive) transitions.push(c);
    }

    // Drop rows for campaigns we no longer track (ended, or de-opted).
    if (tracked.length) {
      await CampaignLiveState.deleteMany({ campaignId: { $nin: tracked } });
    } else {
      await CampaignLiveState.deleteMany({});
    }

    counts.transitions = transitions.length;
    if (transitions.length) await nudgeWake(transitions);

    state.lastError = passError;
    return counts;
  } catch (e) {
    state.lastError = (e && e.message) || String(e);
    counts.errors++;
    return counts;
  } finally {
    state.lastCounts = counts;
    state.lastRun = new Date();
    state.running = false;
  }
}

async function upsert(campaign, patch) {
  await CampaignLiveState.updateOne(
    { campaignId: campaign.campaignId },
    { $set: { game: campaign.game, name: campaign.name, ...patch } },
    { upsert: true },
  );
}

// On a dark→live transition, ask botWaker to wake parked bots now rather than
// waiting for the next auto-farm tick. Lazy require avoids a load-time cycle
// (botWaker → farmCompletion → …). botWaker applies its own filters (no-claim
// games, registry membership), so an over-eager nudge is harmless.
async function nudgeWake() {
  try {
    const botWaker = require("./botWaker");
    const hosts = require("./botHosts");
    for (const h of hosts.listHosts()) {
      await botWaker.wakeFinishedBots(h.id).catch(() => {});
    }
  } catch {
    /* best effort */
  }
}

function status() {
  return {
    started: state.started,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastCounts: state.lastCounts,
    tickMs: TICK_MS,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const loop = async () => {
    let delay = TICK_MS;
    try {
      await runOnce();
    } catch {
      delay = RETRY_MS;
    }
    if (state.lastError) delay = RETRY_MS;
    setTimeout(loop, delay);
  };
  // First pass shortly after boot, then on the interval.
  setTimeout(loop, 15 * 1000);
}

// anyChannelLive exported for tests (it is the safety-critical failure path:
// a swallowed error there would read as a confident "dark" verdict).
module.exports = { start, runOnce, status, anyChannelLive };
