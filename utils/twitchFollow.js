// Twitch follow-bot primitives — the mutation + the channel-lookup helper.
//
// Same request scaffolding as utils/twitchInventory.js on purpose: reuse its
// gqlRequest so a follow can egress from the local server OR from any scan
// host (Pi / phone) over SSH + curl, and inherit its token / integrity /
// transport error semantics unchanged. The worker in twitchFollowRunner.js
// stripes the mutation across hosts to spread the IP footprint.
const axios = require("axios");

const GQL_URL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

// Same OAuth/Bearer trim as twitchInventory.js so tokens copied from either
// source drop straight in.
function cleanToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^OAuth\s+/i, "")
    .replace(/^Bearer\s+/i, "");
}

// A "the scan host let us down" error, distinct from any Twitch verdict.
// Callers must never treat this as a hard failure against the bot account —
// retry from a different host instead.
function transportError(message, cause) {
  const err = new Error("scan host: " + message);
  err.transportFailed = true;
  if (cause && cause.unreachable) err.unreachable = true;
  return err;
}

async function gqlRequest({ token, clientId, body, host }) {
  if (host && host.transport && host.transport !== "local") {
    return gqlViaHost({ token, clientId, body, host });
  }
  const res = await axios.post(GQL_URL, body, {
    headers: {
      "Content-Type": "application/json",
      "Client-Id": clientId,
      Authorization: "OAuth " + token,
    },
    timeout: 20000,
    validateStatus: () => true,
  });
  const parsed = Array.isArray(res.data) ? res.data[0] : res.data;
  return { status: res.status, parsed };
}

async function gqlViaHost({ token, clientId, body, host }) {
  const { runShell, shq } = require("./botHosts");
  const cmd =
    "curl -sS --max-time 20 -X POST " +
    shq(GQL_URL) +
    " -H " +
    shq("Content-Type: application/json") +
    " -H " +
    shq("Client-Id: " + clientId) +
    " -H " +
    shq("Authorization: OAuth " + token) +
    " --data-binary @- -w " +
    shq("\\n%{http_code}");
  let stdout;
  try {
    ({ stdout } = await runShell(host, cmd, {
      timeout: 25000,
      input: JSON.stringify(body),
    }));
  } catch (e) {
    throw transportError(
      host.id + " unreachable (" + (e.message || e) + ")",
      e,
    );
  }
  const text = String(stdout || "");
  const nl = text.lastIndexOf("\n");
  const statusStr = (nl >= 0 ? text.slice(nl + 1) : "").trim();
  const bodyStr = nl >= 0 ? text.slice(0, nl) : text;
  const status = parseInt(statusStr, 10) || 0;
  let data;
  try {
    data = JSON.parse(bodyStr);
  } catch {
    throw transportError(host.id + " returned a non-JSON response");
  }
  const parsed = Array.isArray(data) ? data[0] : data;
  return { status, parsed };
}

// Wrap Twitch's errors array into a native Error with a code — same split as
// twitchInventory.gqlError so the runner can dispatch on .code.
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

// Pull a channel login out of whatever the operator pasted. Accepts a raw
// login ("shroud"), a channel URL ("https://twitch.tv/shroud"), URLs with the
// popout / clip / video / vod path prefixes, and stray "@" prefixes.
function parseChannelInput(raw) {
  const s = String(raw || "").trim();
  if (!s) return "";
  // Strip @ (some folks paste "@name").
  const at = s.replace(/^@+/, "");
  // Bare login (no slashes / dots — probably not a URL).
  if (!/[/.]/.test(at)) return at.toLowerCase();
  // Try URL parsing; Twitch paths are /<login>[/...] or /popout/<login>/....
  let path;
  try {
    const u = new URL(at.startsWith("http") ? at : "https://" + at);
    path = u.pathname || "";
  } catch {
    path = at;
  }
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return "";
  // Skip Twitch's non-channel path segments.
  const skip = new Set([
    "popout",
    "videos",
    "clips",
    "clip",
    "directory",
    "collections",
    "moderator",
    "subscribe",
    "u",
  ]);
  for (const p of parts) {
    const low = p.toLowerCase();
    if (skip.has(low)) continue;
    return low;
  }
  return "";
}

// Resolve a login string to { id, login, displayName }. Uses any working
// account token — same request path as fetchInventory so it inherits IP
// diversity when a host is passed.
const CHANNEL_QUERY =
  "query($login: String!) { user(login: $login) { id login displayName } }";

async function resolveChannel(loginOrUrl, opts = {}) {
  const login = parseChannelInput(loginOrUrl);
  if (!login) {
    const e = new Error("Could not parse channel from input");
    e.code = "bad_input";
    throw e;
  }
  const tok = cleanToken(opts.token || "");
  if (!tok) {
    const e = new Error("No token supplied to resolve channel");
    e.code = "token_invalid";
    throw e;
  }
  const clientId = opts.clientId || DEFAULT_CLIENT_ID;
  const { status, parsed } = await gqlRequest({
    token: tok,
    clientId,
    host: opts.host || null,
    body: [{ query: CHANNEL_QUERY, variables: { login } }],
  });
  if (parsed?.errors?.length) throw gqlError(parsed.errors);
  if (!parsed?.data?.user) {
    if (authFailedFrom(status, parsed)) {
      const e = new Error("Token invalid/expired resolving channel");
      e.code = "token_invalid";
      throw e;
    }
    const e = new Error("Channel '" + login + "' not found");
    e.code = "channel_not_found";
    throw e;
  }
  const u = parsed.data.user;
  return {
    id: String(u.id || ""),
    login: u.login || login,
    displayName: u.displayName || u.login || login,
  };
}

// The follow mutation Twitch's web client uses. Raw query (no persisted
// hash) so we don't tie ourselves to a specific web-client build.
const FOLLOW_MUTATION =
  "mutation($input: FollowUserInput!) { " +
  "  followUser(input: $input) { " +
  "    follow { disableNotifications user { id login } } " +
  "    error { code } " +
  "  } " +
  "}";

// The queries a real browser fires when you land on twitch.tv/<channel>.
// We don't need every one Twitch's SPA runs — the goal is only to leave a
// footprint of "this account visited the channel page N seconds before
// clicking follow", which is the human pattern and NOT what a raw follow
// bot leaves behind. Three shallow queries covers the meaningful signal
// without blowing our request budget per follow.
const CHANNEL_SHELL_QUERY =
  "query ChannelShell($login: String!) { userOrError: userResultByLogin(login: $login) { " +
  "  ... on User { id login displayName primaryColorHex profileImageURL(width: 70) roles { isPartner } " +
  "    stream { id type } lastBroadcast { id startedAt } " +
  "  } " +
  "} }";
const USE_LIVE_QUERY =
  "query UseLive($channelLogin: String!) { user(login: $channelLogin) { id login stream { id type createdAt } } }";
const SUBSCRIBE_BUTTON_QUERY =
  "query ChannelPage_SubscribeButton($login: String!) { user(login: $login) { " +
  "  id login self { subscriptionBenefit { id tier } } " +
  "  subscriptionProducts { id tier } " +
  "} }";
const WARM_UP_QUERIES = [
  { operationName: "ChannelShell", query: CHANNEL_SHELL_QUERY, varsFrom: "login" },
  { operationName: "UseLive", query: USE_LIVE_QUERY, varsFrom: "channelLogin" },
  {
    operationName: "ChannelPage_SubscribeButton",
    query: SUBSCRIBE_BUTTON_QUERY,
    varsFrom: "login",
  },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Fire the browser-visit queries on the target channel as if the account
// just clicked into it. Failures here are intentionally swallowed — the
// warm-up is a signal booster, not a gate; a follow that fires after a
// failed warm-up is still better than one that fires with no warm-up.
async function warmUpChannelVisit(token, channelLogin, { clientId, host } = {}) {
  if (!channelLogin) return;
  const cid = clientId || DEFAULT_CLIENT_ID;
  for (const q of WARM_UP_QUERIES) {
    const variables = { [q.varsFrom]: channelLogin };
    try {
      await gqlRequest({
        token,
        clientId: cid,
        host: host || null,
        body: [{ operationName: q.operationName, query: q.query, variables }],
      });
    } catch {
      // ignore — warm-up is best-effort
    }
    // 120-400ms between queries mirrors the SPA's actual firing cadence,
    // which is quick but not instant.
    await sleep(120 + Math.floor(Math.random() * 280));
  }
  // Small extra dwell after warm-up before the follow itself — a real user
  // reads the page for a moment before clicking follow. 500-1800ms.
  await sleep(500 + Math.floor(Math.random() * 1300));
}

// Fire the followUser mutation from one bot account against one channel.
// Returns { status: "ok" | "already_following", follow } on success.
// Throws on hard failures with .code set to one of:
//   token_invalid     — retire this account from this job
//   integrity_failed  — this account has a non-integrity token; skip for
//                       follow-bot use until re-minted via the token-fetcher
//   twitch_error      — Twitch responded with a followUser.error.code
//                       (banned target, blocked, TARGET_IS_SELF, ...); the
//                       original error code lands on .twitchCode
//   no_user           — 200 with null user; transient; retry candidate
// A .transportFailed = true error signals a host issue (same as inventory);
// the worker retries the candidate from another host.
async function followChannel(token, channelId, opts = {}) {
  const tok = cleanToken(token);
  if (!tok) {
    const e = new Error("No token");
    e.code = "token_invalid";
    throw e;
  }
  if (!channelId) throw new Error("channelId required");
  const clientId = opts.clientId || DEFAULT_CLIENT_ID;

  // Stealth+: pretend to visit the channel page a moment before we click
  // follow. Adds ~1.5-3s of pre-follow activity that looks like a browser.
  // Caller opts in explicitly so the plain fast path stays fast.
  if (opts.warmUp && opts.channelLogin) {
    await warmUpChannelVisit(tok, opts.channelLogin, {
      clientId,
      host: opts.host || null,
    });
  }

  // Notification bell state per follow. When randomizeNotifications is on,
  // roughly 30% of follows enable notifications — matching a real user
  // distribution rather than the uniform "always disable" pattern that
  // fingerprints as a bot service.
  let disableNotifications = opts.disableNotifications !== false;
  if (opts.randomizeNotifications) disableNotifications = Math.random() < 0.7;

  const { status, parsed } = await gqlRequest({
    token: tok,
    clientId,
    host: opts.host || null,
    body: [
      {
        query: FOLLOW_MUTATION,
        variables: {
          input: {
            targetID: String(channelId),
            disableNotifications,
          },
        },
      },
    ],
  });
  if (parsed?.errors?.length) throw gqlError(parsed.errors);
  const payload = parsed?.data?.followUser;
  if (!payload) {
    if (authFailedFrom(status, parsed)) {
      const e = new Error("Token invalid/expired");
      e.code = "token_invalid";
      throw e;
    }
    const e = new Error(
      "Twitch returned no followUser payload" +
        (status ? " [HTTP " + status + "]" : ""),
    );
    e.code = "no_user";
    throw e;
  }
  if (payload.error && payload.error.code) {
    const code = String(payload.error.code);
    const e = new Error("Twitch followUser error: " + code);
    e.code = "twitch_error";
    e.twitchCode = code;
    throw e;
  }
  // Twitch's mutation is idempotent: it returns a Follow record whether the
  // account already followed the target or not. We can't tell the two cases
  // apart from the response alone, so we treat every success as "ok". The
  // TwitchFollowLog dedupe upstream is what actually prevents a repeat
  // account from being asked twice.
  return { status: "ok", follow: payload.follow };
}

module.exports = {
  parseChannelInput,
  resolveChannel,
  followChannel,
  warmUpChannelVisit,
  cleanToken,
  DEFAULT_CLIENT_ID,
};
