// Shared, per-game live-channel pool for the multi-account manager. Fetches the
// top drops-enabled channels for a game ONCE per refresh window and hands them
// out round-robin, so accounts spread across many streams instead of all piling
// onto the single highest-viewer channel — which at scale is both a detection
// risk (hundreds of correlated viewers on one stream) and needless load
// concentration. It also collapses N identical getLiveChannelsForGame calls
// (one per account) down to one per game per window.

import { fetchDropsChannels } from "./autoPicker.js";

const REFRESH_MS = 3 * 60 * 1000; // re-fetch a game's channel list this often
const SPREAD_TOP_K = 20; // spread accounts across up to this many channels/game

export function createChannelPool({ refreshMs = REFRESH_MS, topK = SPREAD_TOP_K } = {}) {
  const games = new Map(); // game → { list, idx, fetchedAt, inflight }

  async function ensureFresh(session, game, st) {
    const stale = Date.now() - st.fetchedAt > refreshMs;
    if (st.list.length && !stale) return; // fresh enough — serve from cache
    if (!st.inflight) {
      st.inflight = (async () => {
        const all = await fetchDropsChannels(session, game, 50);
        // Spread only across drops-tagged channels — those are the ones that
        // actually credit the drop. Fall back to the general list only if none
        // are live right now (better to farm a maybe-channel than nothing).
        const dropsOnly = all.filter((c) => c.hasDropTag);
        st.list = (dropsOnly.length ? dropsOnly : all).slice(0, topK);
        st.fetchedAt = Date.now();
        st.idx = 0;
      })()
        .catch(() => {
          /* keep whatever list we had; next call retries */
        })
        .finally(() => {
          st.inflight = null;
        });
    }
    // Only block when we have nothing to serve. If the list is merely stale we
    // return it immediately and let the refresh finish in the background.
    if (!st.list.length) await st.inflight;
  }

  return {
    // Next channel for `game`, round-robin across the cached top-K. Returns
    // null only when the game currently has no live drops channels at all.
    async next(session, game) {
      let st = games.get(game);
      if (!st) {
        st = { list: [], idx: 0, fetchedAt: 0, inflight: null };
        games.set(game, st);
      }
      await ensureFresh(session, game, st);
      if (!st.list.length) return null;
      const ch = st.list[st.idx % st.list.length];
      st.idx++;
      return ch;
    },

    // Debug/telemetry: how many channels are cached per game.
    stats() {
      const out = {};
      for (const [g, st] of games) out[g] = st.list.length;
      return out;
    },
  };
}
