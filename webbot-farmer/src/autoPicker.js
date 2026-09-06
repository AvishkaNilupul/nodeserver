// Game + channel selection for a web-token bot. Mirrors the logic that
// nodeserver/utils/autoFarmer uses conceptually — pick a game the account has
// progress on (finish before starting new), fall back to a priority list —
// then pick a live channel streaming that game with the DROPS_ENABLED tag.

import { getInventory, getLiveChannelsForGame } from "./twitch.js";
// Cycle with channelPool.js (it imports fetchDropsChannels from here) — safe:
// both sides only call hoisted function declarations, never at module load.
import { readChannelsFile, selectCandidates } from "./channelPool.js";

// Score an in-progress campaign by how close it is to a claimable drop.
// "closest to complete" beats "just started" because unfinished drops are the
// ones being paid for — we want to burn them off before opening new work.
function scoreCampaign(c) {
  let bestRatio = 0;
  let bestRemaining = Infinity;
  let anyUnclaimed = false;
  for (const d of c.timeBasedDrops || []) {
    const self = d.self || {};
    if (self.isClaimed) continue;
    const cur = self.currentMinutesWatched || 0;
    const req = d.requiredMinutesWatched || 0;
    if (req <= 0) continue;
    anyUnclaimed = true;
    const remaining = Math.max(0, req - cur);
    const ratio = cur / req;
    if (ratio > bestRatio) bestRatio = ratio;
    if (remaining < bestRemaining) bestRemaining = remaining;
  }
  if (!anyUnclaimed) return null;
  return { ratio: bestRatio, remaining: bestRemaining };
}

// Pick the game to farm right now. Returns { game, source } or null.
export async function pickGame(session, priorityGames = []) {
  const inv = await getInventory(session);
  const progress = inv?.data?.currentUser?.inventory?.dropCampaignsInProgress || [];

  const scored = [];
  for (const c of progress) {
    const s = scoreCampaign(c);
    if (!s) continue;
    scored.push({
      game: c.game?.displayName || "",
      campaign: c.name,
      ratio: s.ratio,
      remaining: s.remaining,
    });
  }
  // closest-to-complete first; tiebreak on smallest remaining
  scored.sort((a, b) => b.ratio - a.ratio || a.remaining - b.remaining);
  const top = scored.find((s) => s.game);
  if (top) return { game: top.game, campaign: top.campaign, source: "inventory" };

  // Nothing in progress → walk the priority list, take the first one that
  // has a live drops-enabled channel right now.
  for (const g of priorityGames) {
    const ch = await pickChannelForGame(session, g);
    if (ch) return { game: g, source: "priority" };
  }
  return null;
}

// Fetch and rank live channels for a game: drops-tagged first (by the title
// heuristic — stream-level tags were deprecated by Twitch in 2024, and
// drops-participating streamers virtually always put "DROPS" in the title),
// then by viewers. Shared by the single-account picker and the manager's
// round-robin channel pool.
export async function fetchDropsChannels(session, gameName, limit = 30) {
  const lim = Math.max(5, Math.min(60, limit || 30));
  const res = await getLiveChannelsForGame(session, gameName, lim);
  const edges = res?.data?.game?.streams?.edges || [];
  const candidates = [];
  for (const e of edges) {
    const n = e.node;
    if (!n?.broadcaster?.login) continue;
    candidates.push({
      login: n.broadcaster.login,
      viewers: n.viewersCount || 0,
      hasDropTag: /drops?/i.test(n.title || ""),
    });
  }
  candidates.sort((a, b) => Number(b.hasDropTag) - Number(a.hasDropTag) || b.viewers - a.viewers);
  return candidates;
}

// Pick a single live drops channel for the game (highest-ranked). Used by the
// single-account --auto path and by pickGame's priority-availability probe.
// The multi-account manager uses the round-robin channelPool instead so that
// many accounts don't all pile onto the top stream.
//
// Honours the server-written channels.json the same way the pool does (see
// channelPool.selectCandidates): a gated campaign with a live ACL channel
// yields ONLY that channel; a gated campaign with none live yields null — so
// pickGame's priority probe does not report a game as farmable when nothing
// can credit it. Without the file (or a stale/other-game one) this is exactly
// the old drops-tagged-first ranking. `opts.file` lets a caller pass the file
// text/object in (tests); default reads WEBBOT_CHANNELS_FILE.
export async function pickChannelForGame(session, gameName, opts = {}) {
  const avoid = new Set((opts.avoid || []).map((s) => String(s).toLowerCase()));
  const limit = opts.limit || 30;
  const all = await fetchDropsChannels(session, gameName, limit);
  const file = opts.file !== undefined ? opts.file : await readChannelsFile();
  const { candidates } = selectCandidates(all, file, Date.now(), { game: gameName, topK: limit });
  for (const c of candidates) {
    if (!avoid.has(c.login.toLowerCase())) return c;
  }
  return null;
}
