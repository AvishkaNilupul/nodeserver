// Watch-session primitives for the account-aging system.
//
// Sibling of utils/twitchFollow.js, and built the same way on purpose: every
// request can egress from the local server OR from any scan host over SSH +
// curl, so aging inherits the same IP-diversity story the follow-bot has. See
// utils/stashAging.js for the scheduler that drives these.
//
// A "session" is two layers:
//
//   1. Presence — the GraphQL queries a real browser fires when someone opens
//      twitch.tv/<channel> and leaves the tab sitting there. These always run.
//   2. Watch    — minute-watched events POSTed to Twitch's spade endpoint,
//      which is what actually accrues counted watch time (and drop progress).
//      This needs the spade URL, discovered from Twitch's own settings bundle.
//
// If layer 2 can't be established the session still runs as presence-only and
// reports kind:"presence". That distinction is surfaced all the way to the UI
// rather than hidden, because a set whose sessions are all "presence" is a set
// that is not accruing real watch time and the operator needs to know.
//
// Nothing here posts, comments, or otherwise writes into a channel. The only
// outbound writes are the account's own viewing telemetry and (via
// twitchFollow) a follow on a channel it actually watched.
const axios = require("axios");
const twitchIdentity = require("./twitchIdentity");

const GQL_URL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const HOME_URL = "https://www.twitch.tv/";

// Overridable purely as an escape hatch: if Twitch reshuffles its settings
// bundle and discovery breaks, an operator can pin the URL rather than lose
// watch-time accrual fleet-wide until the regex is fixed.
const SPADE_URL_OVERRIDE = process.env.TWITCH_SPADE_URL || "";

const HTTP_TIMEOUT_MS = 20000;
// Host calls go over SSH to a Pi whose link runs at seconds of RTT, so the
// remote budget is deliberately wider than the local one.
const HOST_TIMEOUT_MS = 30000;

function cleanToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^OAuth\s+/i, "")
    .replace(/^Bearer\s+/i, "");
}

// A "the scan host let us down" error, distinct from any Twitch verdict —
// identical contract to twitchFollow/twitchInventory so the runner can treat
// transport failures as "retry elsewhere" rather than "this account is bad".
function transportError(message, cause) {
  const err = new Error("scan host: " + message);
  err.transportFailed = true;
  if (cause && cause.unreachable) err.unreachable = true;
  return err;
}

function gqlError(errors) {
  const msg = errors.map((e) => e.message).join("; ");
  const err = new Error(msg);
  if (/integrity/i.test(msg)) err.code = "integrity_failed";
  return err;
}

function authFailedFrom(status, parsed) {
  return (
    status === 401 ||
    status === 403 ||
    /unauthor/i.test(parsed?.error || "") ||
    /unauthor/i.test(parsed?.message || "")
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isLocal(host) {
  return !host || !host.transport || host.transport === "local";
}

// ---------------------------------------------------------------------------
// Generic host-aware HTTP
//
// twitchFollow only ever needed to POST JSON to one endpoint, so it inlines
// its curl. Aging needs three shapes (GQL POST, plain GET for HTML/JS, form
// POST to spade), so the curl construction is factored out here.
// ---------------------------------------------------------------------------

async function httpLocal({ method, url, headers, body }) {
  const res = await axios({
    method: method || "GET",
    url,
    headers: headers || {},
    data: body,
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
    // Twitch's settings bundle is ~1MB of JS; nothing we fetch is bigger.
    maxContentLength: 8 * 1024 * 1024,
    responseType: "text",
    transformResponse: [(d) => d],
  });
  return { status: res.status, text: typeof res.data === "string" ? res.data : JSON.stringify(res.data) };
}

async function httpViaHost(host, { method, url, headers, body }) {
  const { runShell, shq } = require("./botHosts");
  const parts = ["curl -sS --max-time 20"];
  if ((method || "GET").toUpperCase() !== "GET") {
    parts.push("-X " + shq(method.toUpperCase()));
  }
  for (const [k, v] of Object.entries(headers || {})) {
    parts.push("-H " + shq(k + ": " + v));
  }
  if (body != null) parts.push("--data-binary @-");
  // Trailing status marker on its own line — same trick twitchFollow uses to
  // recover the HTTP code from a plain curl body.
  parts.push(shq(url), "-w " + shq("\\n%{http_code}"));
  const cmd = parts.join(" ");

  let stdout;
  try {
    ({ stdout } = await runShell(host, cmd, {
      timeout: HOST_TIMEOUT_MS,
      input: body == null ? undefined : String(body),
    }));
  } catch (e) {
    throw transportError(host.id + " unreachable (" + (e.message || e) + ")", e);
  }
  const text = String(stdout || "");
  const nl = text.lastIndexOf("\n");
  const statusStr = (nl >= 0 ? text.slice(nl + 1) : "").trim();
  return {
    status: parseInt(statusStr, 10) || 0,
    text: nl >= 0 ? text.slice(0, nl) : text,
  };
}

function http(host, req) {
  return isLocal(host) ? httpLocal(req) : httpViaHost(host, req);
}

// `identity` (from utils/twitchIdentity.headersFor) carries the per-account
// device headers. Note it is spread BEFORE Client-Id/Authorization, so an
// identity can never override which client we present as — the tokens are
// bound to one client id through device-auth and swapping it breaks integrity.
async function gqlRequest({ token, clientId, body, host, identity }) {
  const { status, text } = await http(host, {
    method: "POST",
    url: GQL_URL,
    headers: {
      ...(identity || {}),
      "Content-Type": "application/json",
      "Client-Id": clientId || DEFAULT_CLIENT_ID,
      ...(token ? { Authorization: "OAuth " + cleanToken(token) } : {}),
    },
    body: JSON.stringify(body),
  });
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  const parsed = Array.isArray(data) ? data[0] : data;
  return { status, parsed };
}

// ---------------------------------------------------------------------------
// Spade discovery
//
// The minute-watched endpoint isn't a fixed URL — Twitch publishes it inside a
// hashed settings bundle referenced by the homepage. Discovery is two cheap
// GETs, and the answer changes rarely, so it's cached process-wide with a long
// TTL. Cached per host id because a host could in principle be served a
// different bundle.
// ---------------------------------------------------------------------------

const SPADE_TTL_MS = 6 * 60 * 60 * 1000;
const spadeCache = new Map(); // hostId -> { url, at }

const SETTINGS_RE =
  /https:\/\/(?:static\.twitchcdn\.net|assets\.twitch\.tv)\/config\/settings\.[0-9a-fA-F]+\.js/;
const SPADE_RE = /"spade_url"\s*:\s*"([^"]+)"/;

async function resolveSpadeUrl(host, identity) {
  if (SPADE_URL_OVERRIDE) return SPADE_URL_OVERRIDE;
  const key = host && host.id ? host.id : "local";
  const hit = spadeCache.get(key);
  if (hit && Date.now() - hit.at < SPADE_TTL_MS) return hit.url;

  const home = await http(host, {
    method: "GET",
    url: HOME_URL,
    headers: { ...(identity || {}), Accept: "text/html" },
  });
  const settingsMatch = SETTINGS_RE.exec(home.text || "");
  if (!settingsMatch) return "";

  const settings = await http(host, {
    method: "GET",
    url: settingsMatch[0],
    headers: { ...(identity || {}) },
  });
  const spadeMatch = SPADE_RE.exec(settings.text || "");
  if (!spadeMatch) return "";

  const url = spadeMatch[1];
  spadeCache.set(key, { url, at: Date.now() });
  return url;
}

// ---------------------------------------------------------------------------
// Channel / stream lookups
// ---------------------------------------------------------------------------

const STREAM_INFO_QUERY =
  "query($login: String!) { user(login: $login) { id login displayName " +
  "  stream { id type game { id name } } } }";

// Returns { id, login, displayName, live, streamId, game } — `live:false` when
// the channel exists but isn't broadcasting, which the caller treats as "pick
// someone else" rather than an error.
async function getStreamInfo(token, login, opts = {}) {
  const { status, parsed } = await gqlRequest({
    token,
    clientId: opts.clientId,
    host: opts.host || null,
    identity: opts.identity,
    body: [{ query: STREAM_INFO_QUERY, variables: { login: String(login).toLowerCase() } }],
  });
  if (parsed?.errors?.length) throw gqlError(parsed.errors);
  const u = parsed?.data?.user;
  if (!u) {
    if (authFailedFrom(status, parsed)) {
      const e = new Error("Token invalid/expired reading channel");
      e.code = "token_invalid";
      throw e;
    }
    const e = new Error("Channel '" + login + "' not found");
    e.code = "channel_not_found";
    throw e;
  }
  return {
    id: String(u.id || ""),
    login: u.login || login,
    displayName: u.displayName || u.login || login,
    live: !!(u.stream && u.stream.id),
    streamId: u.stream ? String(u.stream.id || "") : "",
    game: u.stream && u.stream.game ? u.stream.game.name || "" : "",
  };
}

// Batch liveness: which of these channel logins are live right now. One GQL
// request per call (chunk the caller's list), so a campaign whose ACL lists
// hundreds of channels costs a handful of requests, not one per channel — see
// utils/streamScout.js. Twitch returns a null array entry for a login that does
// not exist, so those are skipped. Returns a Set of live logins (lowercased).
const STREAMS_LIVE_QUERY =
  "query($logins:[String!]){ users(logins:$logins){ id login stream{ id } } }";

async function getStreamsLive(token, logins, opts = {}) {
  const list = (Array.isArray(logins) ? logins : [])
    .map((l) => String(l || "").toLowerCase())
    .filter(Boolean);
  const live = new Set();
  if (!list.length) return live;
  const { status, parsed } = await gqlRequest({
    token,
    clientId: opts.clientId,
    host: opts.host || null,
    identity: opts.identity,
    body: [{ query: STREAMS_LIVE_QUERY, variables: { logins: list } }],
  });
  if (parsed?.errors?.length) {
    if (authFailedFrom(status, parsed)) {
      const e = new Error("Token invalid/expired reading stream liveness");
      e.code = "token_invalid";
      throw e;
    }
    throw gqlError(parsed.errors);
  }
  for (const u of parsed?.data?.users || []) {
    if (u && u.stream && u.stream.id) live.add(String(u.login || "").toLowerCase());
  }
  return live;
}

// Who am I — needed for the minute-watched payload's user_id, and doubles as a
// cheap token liveness probe.
const CURRENT_USER_QUERY = "query { currentUser { id login } }";

async function getCurrentUser(token, opts = {}) {
  const { status, parsed } = await gqlRequest({
    token,
    clientId: opts.clientId,
    host: opts.host || null,
    identity: opts.identity,
    body: [{ query: CURRENT_USER_QUERY }],
  });
  if (parsed?.errors?.length) throw gqlError(parsed.errors);
  const u = parsed?.data?.currentUser;
  if (!u) {
    // Same split as fetchInventory: only a hard 401/403 (or an "Unauthorized"
    // body) is a genuinely dead token. A 200 carrying null currentUser — or a
    // 429/5xx — is a transient Twitch hiccup that a perfectly valid token also
    // hits, and coding it token_invalid here was killing aging accounts
    // outright: recordSessionFailure treats token_invalid as terminal and moved
    // them to aging.stage="dead" with nextEligibleAt=null (never retried).
    const authFailed = authFailedFrom(status, parsed);
    const e = new Error(
      authFailed
        ? "Token invalid/expired"
        : "Twitch returned no user (transient; token not confirmed dead)" +
            (status ? " [HTTP " + status + "]" : ""),
    );
    e.code = authFailed ? "token_invalid" : "no_user";
    throw e;
  }
  return { id: String(u.id || ""), login: u.login || "" };
}

// ---------------------------------------------------------------------------
// Channel discovery
//
// Pull live channels from Twitch's own directory so the pool rotates with what
// is actually on, instead of ageing a whole fleet against a hand-pinned list.
// ---------------------------------------------------------------------------

// Twitch rejects `first` above 30 outright — "argument 'first' value must be
// between 1 and 30" — so a bigger page size doesn't return fewer results, it
// returns an ERROR and therefore nothing at all. Verified against the live API.
const DIRECTORY_PAGE_MAX = 30;

const DIRECTORY_QUERY =
  "query($limit: Int!, $after: Cursor) { streams(first: $limit, after: $after) { edges { " +
  "  cursor node { id viewersCount game { id name } broadcaster { id login displayName } } " +
  "} } }";

// Returns [{ login, displayName, game, viewers }], walking the cursor to build
// a pool bigger than one page. An empty result means "couldn't pick anything
// this time" and is not fatal to the caller — but it IS logged, because a
// silently-empty directory is indistinguishable from "nothing is live" and
// would leave every session parked forever with no clue why.
async function discoverChannels(token, opts = {}) {
  const want = Math.max(1, Math.min(200, opts.limit || 90));
  const out = [];
  const seen = new Set();
  let after = null;

  while (out.length < want) {
    const limit = Math.min(DIRECTORY_PAGE_MAX, want - out.length);
    let parsed;
    try {
      ({ parsed } = await gqlRequest({
        token,
        clientId: opts.clientId,
        host: opts.host || null,
        identity: opts.identity,
        body: [{ query: DIRECTORY_QUERY, variables: { limit, after } }],
      }));
    } catch (e) {
      console.error("[twitchWatch] directory request failed: " + (e.message || e));
      break;
    }
    if (parsed?.errors?.length) {
      console.error(
        "[twitchWatch] directory query rejected: " +
          parsed.errors.map((x) => x.message).join("; ").slice(0, 200),
      );
      break;
    }
    const edges = parsed?.data?.streams?.edges || [];
    if (!edges.length) break;

    for (const e of edges) {
      const n = e && e.node;
      if (!n || !n.broadcaster || !n.broadcaster.login) continue;
      const login = String(n.broadcaster.login).toLowerCase();
      if (seen.has(login)) continue;
      seen.add(login);
      out.push({
        login,
        displayName: n.broadcaster.displayName || n.broadcaster.login,
        game: (n.game && n.game.name) || "",
        viewers: Number(n.viewersCount) || 0,
      });
    }
    after = edges[edges.length - 1].cursor;
    if (!after) break;
    // Gentle pace between pages — this runs on a shared token.
    await sleep(300 + Math.floor(Math.random() * 200));
  }
  return out;
}

// The set of game names that currently have an active drop campaign. Aging
// sessions avoid these by default — a session on a drop-enabled channel
// produces exactly the history the farm already produces, so it adds nothing
// and costs requests. Best-effort: a failure here degrades to "don't exclude
// anything" rather than blocking the session.
async function activeDropGames(token, opts = {}) {
  const { fetchDropCampaigns } = require("./twitchInventory");
  try {
    const campaigns = await fetchDropCampaigns(token, opts.host ? { host: opts.host } : undefined);
    const names = new Set();
    const now = Date.now();
    for (const c of campaigns || []) {
      if (!c) continue;
      // Only campaigns running right now matter. An expired campaign's game is
      // fair game again — often a better aging target than average, since the
      // farm has moved off it.
      if (c.status && String(c.status).toUpperCase() !== "ACTIVE") continue;
      if (c.endAt && new Date(c.endAt).getTime() < now) continue;
      const g = c.game && (c.game.displayName || c.game.name);
      if (g) names.add(String(g).toLowerCase());
    }
    return names;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Presence: the queries a browser fires on a channel page
// ---------------------------------------------------------------------------

const CHANNEL_SHELL_QUERY =
  "query ChannelShell($login: String!) { userOrError: userResultByLogin(login: $login) { " +
  "  ... on User { id login displayName primaryColorHex profileImageURL(width: 70) roles { isPartner } " +
  "    stream { id type } lastBroadcast { id startedAt } } } }";
const USE_LIVE_QUERY =
  "query UseLive($channelLogin: String!) { user(login: $channelLogin) { id login stream { id type createdAt } } }";
const VIDEO_PLAYER_QUERY =
  "query VideoPlayerStreamInfoOverlayChannel($channel: String!) { user(login: $channel) { " +
  "  id login displayName profileURL stream { id createdAt game { id name } } } }";

const PLAYBACK_TOKEN_QUERY =
  "query($login: String!, $playerType: String!) { " +
  "  streamPlaybackAccessToken(channelName: $login, params: { platform: \"web\", " +
  "    playerBackend: \"mediaplayer\", playerType: $playerType }) { value signature } }";

// Fire the page-load queries. Best-effort throughout: presence is a signal
// booster, and a session that loses one of these is still a valid session.
async function channelPageVisit(token, channelLogin, opts = {}) {
  const queries = [
    { operationName: "ChannelShell", query: CHANNEL_SHELL_QUERY, vars: { login: channelLogin } },
    { operationName: "UseLive", query: USE_LIVE_QUERY, vars: { channelLogin } },
    {
      operationName: "VideoPlayerStreamInfoOverlayChannel",
      query: VIDEO_PLAYER_QUERY,
      vars: { channel: channelLogin },
    },
  ];
  for (const q of queries) {
    try {
      await gqlRequest({
        token,
        clientId: opts.clientId,
        host: opts.host || null,
        identity: opts.identity,
        body: [{ operationName: q.operationName, query: q.query, variables: q.vars }],
      });
    } catch {
      // ignore — best effort
    }
    await sleep(120 + Math.floor(Math.random() * 280));
  }
}

// Ask for the stream playback token, exactly as the player does before it
// starts pulling HLS. Returns true when Twitch handed one over. We don't
// actually fetch the video (that's the whole point — no bandwidth), but the
// request itself is part of a genuine viewing footprint.
async function requestPlaybackToken(token, channelLogin, opts = {}) {
  try {
    const { parsed } = await gqlRequest({
      token,
      clientId: opts.clientId,
      host: opts.host || null,
      identity: opts.identity,
      body: [
        {
          query: PLAYBACK_TOKEN_QUERY,
          variables: { login: channelLogin, playerType: "site" },
        },
      ],
    });
    return !!parsed?.data?.streamPlaybackAccessToken?.value;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// minute-watched
// ---------------------------------------------------------------------------

// One minute-watched beat. Twitch takes a base64'd JSON array in a form field.
// Returns true on a 2xx — spade answers 204 on success.
async function sendMinuteWatched(spadeUrl, payload, opts = {}) {
  const encoded = Buffer.from(JSON.stringify([payload]), "utf8").toString("base64");
  const { status } = await http(opts.host || null, {
    method: "POST",
    url: spadeUrl,
    headers: {
      // The account's own User-Agent, so its telemetry and its GraphQL agree
      // about what device it is. A bare "Mozilla/5.0" — which is what this sent
      // before — is a string no real browser has ever produced.
      ...(opts.identity || {}),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "data=" + encodeURIComponent(encoded),
  });
  return status >= 200 && status < 300;
}

function minuteWatchedPayload({ channelId, channelLogin, streamId, userId, userLogin, game }) {
  return {
    event: "minute-watched",
    properties: {
      channel_id: Number(channelId) || channelId,
      channel: channelLogin,
      broadcast_id: Number(streamId) || streamId,
      user_id: Number(userId) || userId,
      login: userLogin,
      player: "site",
      platform: "web",
      live: true,
      game: game || "",
      url: "https://www.twitch.tv/" + channelLogin,
      hidden: false,
      muted: false,
    },
  };
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

// Watch one channel for `minutes`, reporting progress as it goes.
//
// Returns { kind, minutesWatched, channel, game, stopped }:
//   kind "watched"  — minute-watched beats were accepted
//   kind "presence" — page/player queries ran but no watch time accrued
//
// Throws only for things that say something about the ACCOUNT (token_invalid,
// integrity_failed) or the transport. A channel going offline mid-session is a
// normal ending, not an error — it returns with whatever time it banked, which
// is also a more human-shaped session than always running the full duration.
async function watchSession(token, opts = {}) {
  const tok = cleanToken(token);
  if (!tok) {
    const e = new Error("No token");
    e.code = "token_invalid";
    throw e;
  }
  const {
    channelLogin,
    minutes = 20,
    host = null,
    clientId,
    onProgress,
    shouldStop,
    dryRun = false,
    identitySeed,
  } = opts;
  if (!channelLogin) throw new Error("channelLogin required");

  if (dryRun) {
    // Plan-only: report the shape of the session without a single request.
    return {
      kind: "dry",
      minutesWatched: minutes,
      channel: channelLogin,
      game: "",
      stopped: "dry-run",
    };
  }

  // One device, one session id, held for the whole sitting — that is what a
  // real app launch looks like. Every request below carries it, so the session
  // hangs together as one device doing one thing rather than N anonymous calls.
  const sessionId = twitchIdentity.newSessionId();
  const identity = identitySeed
    ? twitchIdentity.headersFor(identitySeed, sessionId)
    : {};
  const ctx = { host, clientId, identity };

  const me = await getCurrentUser(tok, ctx);
  const info = await getStreamInfo(tok, channelLogin, ctx);
  if (!info.live) {
    return { kind: "offline", minutesWatched: 0, channel: channelLogin, game: "", stopped: "offline" };
  }

  // Land on the page like a browser would, then ask for the playback token.
  await channelPageVisit(tok, info.login, ctx);
  await requestPlaybackToken(tok, info.login, ctx);

  const spadeUrl = await resolveSpadeUrl(host, identity).catch(() => "");
  const payload = minuteWatchedPayload({
    channelId: info.id,
    channelLogin: info.login,
    streamId: info.streamId,
    userId: me.id,
    userLogin: me.login,
    game: info.game,
  });

  let banked = 0;
  let accepted = 0;
  let stopped = "completed";

  for (let i = 0; i < minutes; i++) {
    if (typeof shouldStop === "function" && shouldStop()) {
      stopped = "cancelled";
      break;
    }

    if (spadeUrl) {
      try {
        if (await sendMinuteWatched(spadeUrl, payload, { host, identity })) accepted++;
      } catch (e) {
        // A transport failure mid-session ends it early rather than throwing:
        // the minutes already banked are real and worth keeping.
        if (e.transportFailed) {
          stopped = "transport";
          break;
        }
      }
    }
    banked++;
    if (typeof onProgress === "function") onProgress({ minute: banked, of: minutes });

    // Beat roughly once a minute, jittered — a player's telemetry is periodic
    // but not metronomic. Skipped after the final beat so a session doesn't
    // idle for a minute after its last useful action.
    if (i < minutes - 1) {
      await sleep(55000 + Math.floor(Math.random() * 12000));

      // Re-check liveness every ~10 minutes: watching a channel that ended is
      // both useless and unlike a real viewer, who closes the tab.
      if (banked % 10 === 0) {
        try {
          const still = await getStreamInfo(tok, info.login, ctx);
          if (!still.live) {
            stopped = "channel-ended";
            break;
          }
        } catch {
          // A failed liveness probe isn't reason enough to abandon the session.
        }
      }
    }
  }

  return {
    kind: accepted > 0 ? "watched" : "presence",
    minutesWatched: banked,
    acceptedBeats: accepted,
    channel: info.login,
    game: info.game,
    stopped,
  };
}

module.exports = {
  watchSession,
  getStreamInfo,
  getStreamsLive,
  getCurrentUser,
  discoverChannels,
  activeDropGames,
  resolveSpadeUrl,
  channelPageVisit,
  DEFAULT_CLIENT_ID,
};
