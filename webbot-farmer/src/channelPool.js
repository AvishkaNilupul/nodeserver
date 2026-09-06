// Shared, per-game live-channel pool for the multi-account manager. Fetches the
// top drops-enabled channels for a game ONCE per refresh window and hands them
// out round-robin, so accounts spread across many streams instead of all piling
// onto the single highest-viewer channel — which at scale is both a detection
// risk (hundreds of correlated viewers on one stream) and needless load
// concentration. It also collapses N identical getLiveChannelsForGame calls
// (one per account) down to one per game per window.
//
// ACL awareness (docs/WEBBOT-ACL-CHANNELS-CONTRACT.md): a web token cannot read
// a campaign's channel ACL, but the server can, and it writes what it knows to
// /config/channels.json (mounted :ro into the bot container). Every refresh
// window the pool re-reads that file and runs the PURE `selectCandidates`
// below over the community list — so when a campaign is gated to official
// channels and one of them is live, accounts go THERE instead of onto
// community streams that can never credit it.
//
// Note on the autoPicker <-> channelPool import cycle: autoPicker's single
// channel picker reuses `selectCandidates`/`readChannelsFile` from here while
// this module reuses `fetchDropsChannels` from there. Both sides only use
// hoisted function declarations at call time (nothing at module evaluation),
// which ESM resolves cleanly.

import { readFile } from "node:fs/promises";
import { fetchDropsChannels } from "./autoPicker.js";

const REFRESH_MS = 3 * 60 * 1000; // re-fetch a game's channel list this often
const SPREAD_TOP_K = 20; // spread accounts across up to this many channels/game

// channels.json is trusted for this long after its `updatedAt`. Older means the
// server stopped refreshing it (watcher off / SSH broken) — fall back to
// community discovery rather than chase a possibly-ended ACL.
export const CHANNELS_FILE_MAX_AGE_MS = 45 * 60 * 1000;
export const DEFAULT_CHANNELS_FILE = "/config/channels.json";

export function channelsFilePath() {
  return process.env.WEBBOT_CHANNELS_FILE || DEFAULT_CHANNELS_FILE;
}

// Normalised game compare: lowercase, non-alphanumerics → space, trim.
export function normalizeGame(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Raw file text, or null when missing/unreadable. Parsing is left to
// `selectCandidates` so an unparsable file is classified in the pure path.
export async function readChannelsFile(path = channelsFilePath()) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function parseTime(v) {
  if (v === null || v === undefined || v === "") return null;
  const t = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : NaN;
}

const lc = (s) => String(s ?? "").toLowerCase().trim();

// Today's behaviour: drops-tagged channels first (those actually credit),
// falling back to the general list only if none are tagged, top-K.
function communityCandidates(all, topK) {
  const dropsOnly = all.filter((c) => c.hasDropTag);
  return (dropsOnly.length ? dropsOnly : all).slice(0, topK);
}

// Normalised, deduped, sorted campaign-name list — the per-account exclusion
// set in canonical form (also the pool's cache-key suffix).
export function normalizeDoneCampaigns(names) {
  const set = new Set();
  for (const n of Array.isArray(names) ? names : []) {
    const k = normalizeGame(n);
    if (k) set.add(k);
  }
  return [...set].sort();
}

// PURE. From a getInventory result, the names of `game`'s in-progress
// campaigns this account has nothing left to earn from: every timeBasedDrop
// is claimed, or fully watched (currentMinutesWatched >= requiredMinutesWatched
// with requiredMinutesWatched > 0). A campaign with no drops listed is NOT
// done (nothing to judge → fail toward farming). Game compare is normalised.
export function doneCampaignsFromInventory(inv, game) {
  const progress = inv?.data?.currentUser?.inventory?.dropCampaignsInProgress;
  const g = normalizeGame(game);
  const out = [];
  for (const c of Array.isArray(progress) ? progress : []) {
    if (!c || !c.name || normalizeGame(c.game?.displayName) !== g) continue;
    const drops = Array.isArray(c.timeBasedDrops) ? c.timeBasedDrops : [];
    if (!drops.length) continue;
    const allDone = drops.every((d) => {
      const self = (d && d.self) || {};
      if (self.isClaimed) return true;
      const req = Number(d?.requiredMinutesWatched) || 0;
      return req > 0 && (Number(self.currentMinutesWatched) || 0) >= req;
    });
    if (allDone) out.push(c.name);
  }
  return out;
}

// PURE. Decide which channels `game`'s accounts may be spread across.
//   all  — fetchDropsChannels result [{login, viewers, hasDropTag}]
//   file — channels.json as raw text, a parsed object, or null when missing
//   now  — ms epoch
//   opts.game — the game being farmed (file ignored when it names another
//               game); opts.topK — community spread width;
//   opts.doneCampaigns — campaign names THIS account has already completed
//               (see doneCampaignsFromInventory); those file campaigns are
//               dropped before rules 2-6 run, so an official channel that is
//               live only for a campaign the account finished does not pull
//               it there.
// Returns { candidates, source, fileState } where source is one of
//   "acl-live"  — only the gated campaigns' live ACL channels (rule 3)
//   "community" — today's behaviour (rules 1, 4, 6)
//   "none"      — every active campaign is gated and none of its channels is
//                 live → [] so the manager backs off instead of burning
//                 bandwidth on channels that cannot credit (rule 5)
//   "done"      — the file listed campaigns but every one of them is in
//                 doneCampaigns → [] (this account has nothing live to earn
//                 for the game; the manager backs off)
// and fileState explains how the file was treated: "missing" | "unparsable" |
// "stale" | "game-mismatch" | "ok".
export function selectCandidates(all, file, now = Date.now(), opts = {}) {
  const list = (Array.isArray(all) ? all : []).filter((c) => c && c.login);
  const topK = Number(opts.topK) > 0 ? Number(opts.topK) : SPREAD_TOP_K;
  const done = new Set(normalizeDoneCampaigns(opts.doneCampaigns));
  const community = (fileState) => ({
    candidates: communityCandidates(list, topK),
    source: "community",
    fileState,
  });

  // Rule 1 — file missing / unparsable / stale / another game → ignore it.
  let f = file;
  if (typeof f === "string") {
    try {
      f = JSON.parse(f);
    } catch {
      return community("unparsable");
    }
  }
  if (f === null || f === undefined) return community("missing");
  if (typeof f !== "object" || Array.isArray(f)) return community("unparsable");
  const updated = parseTime(f.updatedAt);
  if (updated === null || Number.isNaN(updated)) return community("unparsable");
  if (now - updated > CHANNELS_FILE_MAX_AGE_MS) return community("stale");
  if (opts.game !== undefined && opts.game !== null && normalizeGame(opts.game) !== normalizeGame(f.game)) {
    return community("game-mismatch");
  }

  // Per-account exclusion — drop the campaigns this account already finished
  // BEFORE rules 2-6. If that empties a non-empty list, the account has
  // nothing live to earn for this game.
  const listed = (Array.isArray(f.campaigns) ? f.campaigns : []).filter((c) => c && typeof c === "object");
  const considered = done.size ? listed.filter((c) => !done.has(normalizeGame(c.name))) : listed;
  if (listed.length && !considered.length) return { candidates: [], source: "done", fileState: "ok" };

  // Rule 2 — only campaigns still running. An unparsable endAt is treated as
  // unknown (kept): fail toward farming.
  const active = considered.filter((c) => {
    const end = parseTime(c.endAt);
    return end === null || Number.isNaN(end) || end > now;
  });
  // Rule 6 — the file lists nothing usable → today's behaviour.
  if (!active.length) return community("ok");

  // Un-gated: acl === null (or absent / empty — "any channel of the game").
  const gated = active.filter((c) => Array.isArray(c.acl) && c.acl.length > 0);
  const byLogin = new Map(list.map((c) => [lc(c.login), c]));

  // Rule 3 — liveAcl = union of `live` over gated campaigns. The file can be
  // up to 45 min old and its `live` is [] when the server's liveness read
  // failed, so an ACL login the farmer itself sees live right now (present in
  // `all`) counts as live too — `all` is the fresher signal.
  const liveAcl = new Set();
  for (const c of gated) {
    for (const l of Array.isArray(c.live) ? c.live : []) if (lc(l)) liveAcl.add(lc(l));
    for (const l of c.acl) if (byLogin.has(lc(l))) liveAcl.add(lc(l));
  }
  if (liveAcl.size) {
    const candidates = [...liveAcl].map((login) => {
      const known = byLogin.get(login);
      return {
        login: known ? known.login : login,
        viewers: known ? known.viewers || 0 : 0,
        hasDropTag: true,
        fromAcl: true,
      };
    });
    candidates.sort((a, b) => b.viewers - a.viewers || a.login.localeCompare(b.login));
    return { candidates, source: "acl-live", fileState: "ok" };
  }

  // Rule 4 — some active campaign is un-gated → today's behaviour.
  if (gated.length < active.length) return community("ok");

  // Rule 5 — everything gated, nothing live → nothing can credit.
  return { candidates: [], source: "none", fileState: "ok" };
}

const defaultLog = (msg) => {
  const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  console.log(`[${stamp}] [pool] ${msg}`);
};

// Options beyond the two tunables exist for tests: `fetchChannels` replaces the
// Twitch fetch, `readChannels` the channels.json read, `now` the clock, `log`
// the source-change line.
export function createChannelPool({
  refreshMs = REFRESH_MS,
  topK = SPREAD_TOP_K,
  fetchChannels = fetchDropsChannels,
  readChannels = readChannelsFile,
  now = Date.now,
  log = defaultLog,
} = {}) {
  // Two layers: the Twitch fetch + file read are cached ONCE per game per
  // refresh window (`raw`), while the selection/round-robin state is kept per
  // game + doneCampaigns key (`pools`) — so accounts that finished different
  // campaigns each get a correct answer without a per-account fetch storm.
  const raw = new Map(); // game → { all, file, at, inflight }
  const pools = new Map(); // poolKey → { game, done, list, idx, fetchedAt, inflight, source, fileState, key }

  const poolKeyFor = (game, done) => `${game}|${done.join(",")}`;

  async function fetchRaw(session, game) {
    // A Twitch failure must not hide a live ACL channel the file knows about,
    // so the fetch failure is folded into the selection instead of thrown.
    let all = null;
    try {
      all = await fetchChannels(session, game, 50);
    } catch {
      /* fall through — selection decides whether we can proceed without it */
    }
    let file = null;
    try {
      file = await readChannels();
    } catch {
      /* treated as missing */
    }
    return { all, file };
  }

  // Shared per-game fetch: fresh within the window → reuse; else one fetch,
  // deduped across concurrent pool keys. A failed Twitch fetch is NOT cached
  // (at stays 0) so the next call retries — today's behaviour.
  async function ensureRaw(session, game) {
    let r = raw.get(game);
    if (!r) {
      r = { all: null, file: null, at: 0, inflight: null };
      raw.set(game, r);
    }
    if (r.at && now() - r.at <= refreshMs) return r;
    if (!r.inflight) {
      r.inflight = fetchRaw(session, game)
        .then((res) => {
          r.all = res.all;
          r.file = res.file;
          r.at = res.all === null ? 0 : now();
        })
        .finally(() => {
          r.inflight = null;
        });
    }
    await r.inflight;
    return r;
  }

  async function refresh(session, game, st) {
    const r = await ensureRaw(session, game);
    const all = r.all;
    const sel = selectCandidates(all || [], r.file, now(), { game, topK, doneCampaigns: st.done });
    // Twitch down and nothing better from the file → keep whatever list we
    // had; the next call retries (today's behaviour).
    if (all === null && sel.source !== "acl-live") return;

    st.list = sel.candidates;
    st.fetchedAt = now();
    st.idx = 0;
    // One log line when the selection source changes (or the live ACL set
    // itself changes — a different official channel took over).
    const logins = sel.source === "acl-live" ? sel.candidates.map((c) => c.login) : [];
    const key = sel.source + (logins.length ? ":" + logins.join(",") : "");
    if (key !== st.key) {
      const detail =
        sel.source === "acl-live"
          ? `: ${logins.join(", ")}`
          : sel.fileState !== "ok" && sel.fileState !== "missing"
            ? ` — channels.json ${sel.fileState}, ignored`
            : "";
      const scope = st.done.length ? ` [excluding done: ${st.done.join(", ")}]` : "";
      log(`channels(${game}): ${sel.source} (${sel.candidates.length})${detail}${scope}`);
    }
    st.key = key;
    st.source = sel.source;
    st.fileState = sel.fileState;
  }

  async function ensureFresh(session, game, st) {
    // Freshness is by time, not by list length: an empty list from rule 5 is a
    // valid answer for the whole window (no per-account re-fetch storm).
    const stale = now() - st.fetchedAt > refreshMs;
    if (!stale) return;
    if (!st.inflight) {
      st.inflight = refresh(session, game, st)
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

  function poolFor(game, opts = {}) {
    const done = normalizeDoneCampaigns(opts.doneCampaigns);
    const poolKey = poolKeyFor(game, done);
    let st = pools.get(poolKey);
    if (!st) {
      st = { game, done, list: [], idx: 0, fetchedAt: 0, inflight: null, source: null, fileState: null, key: null };
      pools.set(poolKey, st);
    }
    return st;
  }

  return {
    // Next channel for `game`, round-robin across the cached candidates.
    // Returns null when the game currently has no channel that can credit
    // (no live drops channel at all, or every active campaign is gated and
    // none of its ACL channels is live, or — with doneCampaigns — every
    // listed campaign is one this account already completed; see source()).
    //   opts.avoid — logins to skip for THIS call only (a channel this
    //   account just left without a drop session). If every candidate is
    //   avoided the round-robin pick is returned anyway.
    //   opts.doneCampaigns — campaign names this account has completed for
    //   `game`; selects the game+doneCampaigns pool (own round-robin), while
    //   the underlying Twitch fetch stays shared per game.
    async next(session, game, opts = {}) {
      const st = poolFor(game, opts);
      await ensureFresh(session, game, st);
      const len = st.list.length;
      if (!len) return null;
      const avoid = new Set((opts.avoid || []).map(lc));
      if (avoid.size) {
        for (let i = 0; i < len; i++) {
          const ch = st.list[(st.idx + i) % len];
          if (!avoid.has(lc(ch.login))) {
            st.idx += i + 1;
            return ch;
          }
        }
      }
      const ch = st.list[st.idx % len];
      st.idx++;
      return ch;
    },

    // The cached selection source for game (+ doneCampaigns): "acl-live" |
    // "community" | "none" | "done", or null before the first refresh. Lets
    // the manager tell "nothing can credit" from "this account is finished"
    // after next() returned null. No fetch.
    source(game, opts = {}) {
      const st = pools.get(poolKeyFor(game, normalizeDoneCampaigns(opts.doneCampaigns)));
      return st ? st.source : null;
    },

    // Debug/telemetry: cached channel count + selection source per pool. Keys
    // are the plain game for the no-exclusion pool, `game|done1,done2` for
    // per-account exclusion pools.
    stats() {
      const out = {};
      for (const [poolKey, st] of pools) {
        out[st.done.length ? poolKey : st.game] = {
          channels: st.list.length,
          source: st.source,
          fileState: st.fileState,
          doneCampaigns: st.done,
        };
      }
      return out;
    },
  };
}
