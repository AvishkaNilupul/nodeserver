// Twitch liveness primitives shared by the Stream Scout and the no-claim
// watcher: batch stream liveness for a list of logins, and category-wide drops
// liveness for a game. Sibling of utils/twitchFollow.js, built the same way on
// purpose — every request can egress from the local server OR from any scan
// host over SSH + curl, so callers inherit the same IP-diversity story.
//
// The account-aging watch-session machinery that used to live here was removed
// with the aging system; what remains is exactly what utils/streamScout.js and
// utils/noclaimWatcher.js import.
const axios = require("axios");

const GQL_URL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

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
// ---------------------------------------------------------------------------

async function httpLocal({ method, url, headers, body }) {
  const res = await axios({
    method: method || "GET",
    url,
    headers: headers || {},
    data: body,
    timeout: HTTP_TIMEOUT_MS,
    validateStatus: () => true,
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
// Stream liveness
// ---------------------------------------------------------------------------

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
  // An HTTP-level failure (429/5xx) or a non-JSON body reads as NO data. It
  // must never be mistaken for "nothing is live" — that would let a Twitch
  // outage park gated bots through the Scout. Throw so callers can fail
  // toward farming (treat as watchable) instead of seeing an empty result.
  if (!parsed?.data && status >= 400) {
    const e = new Error("Twitch liveness read failed (HTTP " + status + ")");
    e.code = "twitch_http";
    throw e;
  }
  for (const u of parsed?.data?.users || []) {
    if (u && u.stream && u.stream.id) live.add(String(u.login || "").toLowerCase());
  }
  return live;
}

// Twitch rejects `first` above 30 outright — "argument 'first' value must be
// between 1 and 30" — so a bigger page size doesn't return fewer results, it
// returns an ERROR and therefore nothing at all. Verified against the live API.
const DIRECTORY_PAGE_MAX = 30;

// Category-wide drops liveness: which drops-enabled channels are live in a
// game's directory right now. This is the Phase-2 signal for games whose drops
// are NOT channel-locked (no ACL) — e.g. Rocket League — so the Stream Scout can
// gate them on "is any drops stream live" the way it gates esports on the ACL.
// Queried by game NAME (we have the campaign's game name, not its slug); an
// empty result means no drops stream is live for that game. Verified live:
// game(name){streams(options:{systemFilters:[DROPS_ENABLED]})} works.
const GAME_DROPS_QUERY =
  "query($name:String!,$first:Int!){ game(name:$name){ id streams(first:$first, " +
  "options:{sort:VIEWER_COUNT, systemFilters:[DROPS_ENABLED]}){ edges{ node{ " +
  "id viewersCount broadcaster{ login } } } } } }";

async function getGameDropsLive(token, gameName, opts = {}) {
  const first = Math.max(1, Math.min(DIRECTORY_PAGE_MAX, opts.first || 5));
  const { status, parsed } = await gqlRequest({
    token,
    clientId: opts.clientId,
    host: opts.host || null,
    identity: opts.identity,
    body: [
      { query: GAME_DROPS_QUERY, variables: { name: String(gameName), first } },
    ],
  });
  if (parsed?.errors?.length) {
    if (authFailedFrom(status, parsed)) {
      const e = new Error("Token invalid/expired reading game directory");
      e.code = "token_invalid";
      throw e;
    }
    throw gqlError(parsed.errors);
  }
  // Same fail-toward-farming rule as getStreamsLive: an HTTP-level failure is
  // NOT "no drops stream is live", it is an error the Scout must surface.
  if (!parsed?.data && status >= 400) {
    const e = new Error("Twitch game-directory read failed (HTTP " + status + ")");
    e.code = "twitch_http";
    throw e;
  }
  const edges = parsed?.data?.game?.streams?.edges || [];
  return edges
    .map((e) => e && e.node && e.node.broadcaster && e.node.broadcaster.login)
    .filter(Boolean)
    .map((l) => String(l).toLowerCase());
}

module.exports = {
  getStreamsLive,
  getGameDropsLive,
  DEFAULT_CLIENT_ID,
};
