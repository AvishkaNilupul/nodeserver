// Server-side Twitch Drops inventory fetch + parse. Mirrors the client logic in
// public/twitch-inventory.html (same GQL query, same claimed/connect state
// rules) so the archive scanner records exactly what the UI would show.
const axios = require("axios");

const GQL_URL = "https://gql.twitch.tv/gql";
const DEFAULT_CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";
const INVENTORY_HASH =
  "d86775d0ef16a63a33ad52e80eaff963b2d5b72fada7c991504a57496e1d8e4b";

const INVENTORY_QUERY = `
query Inventory {
  currentUser {
    id
    login
    inventory {
      dropCampaignsInProgress {
        id
        name
        status
        game { id displayName name }
        accountLinkURL
        self { isAccountConnected }
        timeBasedDrops {
          id
          name
          requiredMinutesWatched
          benefitEdges {
            benefit { id name imageAssetURL game { id displayName name } }
            entitlementLimit
          }
          self { currentMinutesWatched isClaimed dropInstanceID }
        }
      }
      gameEventDrops {
        id
        name
        imageURL
        lastAwardedAt
        totalCount
        isConnected
        requiredAccountLink
        game { id displayName name }
        benefit { id name game { id displayName name } }
      }
    }
  }
}`;

// Every drop campaign visible to a logged-in viewer (Twitch's drops
// dashboard shows all current + upcoming campaigns, not just joined ones).
const CAMPAIGNS_QUERY = `
query ViewerDropsDashboard {
  currentUser {
    id
    dropCampaigns {
      id
      name
      status
      startAt
      endAt
      detailsURL
      accountLinkURL
      imageURL
      game { id displayName boxArtURL }
      owner { name }
      self { isAccountConnected }
    }
  }
}`;

function cleanToken(raw) {
  return String(raw || "")
    .trim()
    .replace(/^OAuth\s+/i, "")
    .replace(/^Bearer\s+/i, "");
}

// One GQL POST. By default it goes out from this server (axios). Pass a remote
// `host` (a botHosts host object) and the same request is made *from that host*
// instead — the server SSHes in and runs curl there, so the request egresses
// from the host's IP (e.g. a Raspberry Pi's), which is how the account scanner
// spreads its Twitch traffic across more than one address. Only the network hop
// moves; parsing and all the token/integrity rules below stay here on the
// server, so a scan is identical no matter which machine made the call.
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
    // We handle non-2xx ourselves rather than throwing on status.
    validateStatus: () => true,
  });
  const data = res.data;
  const parsed = Array.isArray(data) ? data[0] : data;
  return { status: res.status, parsed };
}

// A "the scan host let us down" error, distinct from any Twitch verdict. The
// scanner must never downgrade an account because a Raspberry Pi went offline
// mid-check, so anything that stops us actually reaching Twitch through the host
// — SSH unreachable, curl missing/failed, a non-JSON body — is tagged with
// .transportFailed so the caller retries the account elsewhere (the server
// always has a worker) instead of writing a bogus status onto it.
function transportError(message, cause) {
  const err = new Error("scan host: " + message);
  err.transportFailed = true;
  if (cause && cause.unreachable) err.unreachable = true;
  return err;
}

// Make the same GQL POST from a remote host over SSH + curl. The JSON body is
// piped in over stdin (`--data-binary @-`) rather than passed as an argument,
// and curl appends the HTTP status on its own final line (`-w '\n%{http_code}'`)
// so we can still tell "Twitch answered" from "the request never happened".
async function gqlViaHost({ token, clientId, body, host }) {
  // Required lazily to avoid a require cycle (botHosts pulls in nothing from
  // here, but keeping the dependency one-directional stays simplest).
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
    // Non-zero curl exit or an SSH transport failure both land here. Either way
    // we didn't get a Twitch answer through this host.
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
    // An HTML error page, an empty body, a truncated response — not something
    // Twitch's GQL API returns for a real auth verdict. Treat as transport.
    throw transportError(host.id + " returned a non-JSON response");
  }
  const parsed = Array.isArray(data) ? data[0] : data;
  return { status, parsed };
}

// Normalise the optional second argument, which is either a legacy client-id
// string or an options object { clientId, host }.
function scanOpts(arg) {
  if (typeof arg === "string") return { clientId: arg || null, host: null };
  const o = arg || {};
  return { clientId: o.clientId || null, host: o.host || null };
}

// Twitch's anti-bot gate, which is separate from token validity. A token can
// authenticate perfectly (Inventory returns the user) and still be refused
// here: integrity is bound to a real device-auth session, so a supplier token
// that never went through that flow passes Inventory and fails this. Tagged
// with a code so callers can tell "no bot can use this" apart from "the token
// is dead" — they need opposite remedies.
function gqlError(errors) {
  const msg = errors.map((e) => e.message).join("; ");
  const err = new Error(msg);
  if (/integrity/i.test(msg)) err.code = "integrity_failed";
  return err;
}

// Normalised grouping key so the same reward on different accounts collapses
// together in aggregate views (case/space-insensitive name + game).
function itemKeyFor(name, game) {
  return (
    String(name || "")
      .trim()
      .toLowerCase() +
    "|" +
    String(game || "")
      .trim()
      .toLowerCase()
  );
}

// Same label rule as the inventory page: a reward that needs an account link
// but isn't connected is "connect"; linked is "connected"; otherwise "claimed".
function stateFor(link, connected) {
  if (link && !connected) return "connect";
  if (link) return "connected";
  return "claimed";
}

// Normalise the raw inventory into a flat list of deduped drops.
function buildDrops(inv) {
  const out = [];
  const seen = new Set();
  (inv.gameEventDrops || []).forEach((g) => {
    const bg = (g.benefit && g.benefit.game) || g.game || null;
    const benefitId = (g.benefit && g.benefit.id) || g.id || "";
    if (benefitId) seen.add(benefitId);
    const link = g.requiredAccountLink || "";
    const connected = !!g.isConnected;
    out.push({
      benefitId: benefitId || g.name,
      dropId: g.id || "",
      name: g.name || (g.benefit && g.benefit.name) || "Reward",
      imageURL: g.imageURL || "",
      game: bg ? bg.displayName || bg.name : "",
      gameId: bg ? bg.id || "" : "",
      campaign: "",
      itemKey: itemKeyFor(
        g.name || (g.benefit && g.benefit.name),
        bg ? bg.displayName || bg.name : "",
      ),
      count: g.totalCount || 1,
      awardedAt: g.lastAwardedAt || null,
      connected,
      requiredAccountLink: link,
      state: stateFor(link, connected),
      source: "gameEventDrop",
    });
  });
  (inv.dropCampaignsInProgress || []).forEach((c) =>
    (c.timeBasedDrops || []).forEach((d) => {
      if (!(d.self && d.self.isClaimed)) return;
      const edge = (d.benefitEdges && d.benefitEdges[0]) || {};
      const b = edge.benefit || {};
      if (b.id && seen.has(b.id)) return; // already covered by gameEventDrops
      const link = c.accountLinkURL || "";
      const connected = !!(c.self && c.self.isAccountConnected);
      const bg = b.game || c.game || null;
      out.push({
        benefitId: b.id || d.id || d.name,
        dropId: d.id || "",
        name: b.name || d.name || "Reward",
        imageURL: b.imageAssetURL || "",
        game: bg ? bg.displayName || bg.name : "",
        gameId: bg ? bg.id || "" : "",
        campaign: c.name || "",
        itemKey: itemKeyFor(
          b.name || d.name,
          bg ? bg.displayName || bg.name : "",
        ),
        count: edge.entitlementLimit || 1,
        awardedAt: null,
        connected,
        requiredAccountLink: link,
        state: stateFor(link, connected),
        source: "inProgressClaimed",
      });
    }),
  );
  return out;
}

// Parse the LIVE "farming now" view: every in-progress time-based drop with its
// watch-time progress (currentMinutesWatched / requiredMinutesWatched). Unlike
// buildDrops (which only records already-earned rewards), this is what the
// account is actively working toward right now — the same thing the operator's
// twitch-inventory.html progress bars show. Sorted so the closest-to-done,
// still-unclaimed drops come first.
function buildInProgress(inv) {
  const out = [];
  (inv.dropCampaignsInProgress || []).forEach((c) => {
    const connected = !!(c.self && c.self.isAccountConnected);
    (c.timeBasedDrops || []).forEach((d) => {
      const self = d.self || {};
      const edge = (d.benefitEdges && d.benefitEdges[0]) || {};
      const b = edge.benefit || {};
      const bg = b.game || c.game || null;
      const cur = self.currentMinutesWatched || 0;
      const req = d.requiredMinutesWatched || 0;
      const claimed = !!self.isClaimed;
      out.push({
        name: b.name || d.name || "Reward",
        game: bg ? bg.displayName || bg.name : "",
        campaign: c.name || "",
        imageURL: b.imageAssetURL || "",
        current: cur,
        required: req,
        percent: claimed
          ? 100
          : req > 0
            ? Math.min(100, Math.round((cur / req) * 100))
            : 0,
        claimed,
        connected,
      });
    });
  });
  out.sort((a, b) => a.claimed - b.claimed || b.percent - a.percent);
  return out;
}

// Fetch + parse one account's inventory.
// Returns { twitchId, login, drops: [...], inProgress: [...] }.
// The optional second argument is either a client-id string (legacy) or an
// options object { clientId, host } — pass `host` to make the request from a
// remote scan host instead of this server (see gqlRequest).
// Throws an Error with .code = "token_invalid" when Twitch rejects the token,
// or .transportFailed = true when a remote scan host couldn't be reached (the
// account is untouched in that case — retry it elsewhere).
async function fetchInventory(token, arg) {
  const { clientId, host } = scanOpts(arg);
  const tok = cleanToken(token);
  const cid = clientId || DEFAULT_CLIENT_ID;
  if (!tok) {
    const e = new Error("No token");
    e.code = "token_invalid";
    throw e;
  }

  let { status, parsed } = await gqlRequest({
    token: tok,
    clientId: cid,
    host,
    body: [
      { operationName: "Inventory", query: INVENTORY_QUERY, variables: {} },
    ],
  });

  if (parsed?.errors?.length) {
    // Fall back to Twitch's persisted query (some tokens/clients reject ad-hoc
    // queries), matching the client page's behaviour.
    const retry = await gqlRequest({
      token: tok,
      clientId: cid,
      host,
      body: [
        {
          operationName: "Inventory",
          variables: { fetchRewardCampaigns: true },
          extensions: {
            persistedQuery: { sha256Hash: INVENTORY_HASH, version: 1 },
          },
        },
      ],
    });
    status = retry.status;
    parsed = retry.parsed;
  }

  if (parsed?.errors?.length) {
    throw gqlError(parsed.errors);
  }

  const user = parsed?.data?.currentUser;
  if (user === null || user === undefined) {
    // A missing currentUser has two very different causes and only one of them
    // means the token is dead. A genuinely invalid/expired token gets a hard
    // HTTP 401/403 with Twitch's "Unauthorized" body. A 200 carrying a null
    // currentUser — or a 429 / 5xx — is a transient Twitch hiccup that a
    // perfectly valid token also hits (rate limits, integrity gating, the
    // PersistedQueryNotFound waves). Flagging the latter as token_invalid is
    // what paints false "bad token" badges on the Bots page, so only the real
    // auth rejection gets that code; everything else throws a generic,
    // self-healing error the scanner records as "error" (never "bad token").
    const authFailed =
      status === 401 ||
      status === 403 ||
      /unauthor/i.test(parsed?.error || "") ||
      /unauthor/i.test(parsed?.message || "");
    const e = new Error(
      authFailed
        ? "Token invalid/expired or client-id mismatch"
        : "Twitch returned no user (transient; token not confirmed dead)" +
          (status ? " [HTTP " + status + "]" : ""),
    );
    e.code = authFailed ? "token_invalid" : "no_user";
    throw e;
  }
  const inv = user.inventory;
  if (!inv) {
    return {
      twitchId: user.id || "",
      login: user.login || "",
      drops: [],
      inProgress: [],
    };
  }
  return {
    twitchId: user.id || "",
    login: user.login || "",
    drops: buildDrops(inv),
    inProgress: buildInProgress(inv),
  };
}

// Fetch the full drop-campaign dashboard with any valid account token.
// Second argument is a client-id string (legacy) or { clientId, host }; pass
// `host` to run the request from a remote scan host (see gqlRequest).
// Throws .code = "token_invalid" when Twitch rejects the token, or
// .transportFailed = true when a remote scan host couldn't be reached.
async function fetchDropCampaigns(token, arg) {
  const { clientId, host } = scanOpts(arg);
  const tok = cleanToken(token);
  const cid = clientId || DEFAULT_CLIENT_ID;
  if (!tok) {
    const e = new Error("No token");
    e.code = "token_invalid";
    throw e;
  }
  const { status, parsed } = await gqlRequest({
    token: tok,
    clientId: cid,
    host,
    body: [
      {
        operationName: "ViewerDropsDashboard",
        query: CAMPAIGNS_QUERY,
        variables: {},
      },
    ],
  });
  if (parsed?.errors?.length) {
    throw gqlError(parsed.errors);
  }
  const user = parsed?.data?.currentUser;
  if (!user) {
    // Same split as fetchInventory: only a hard auth rejection is a dead token;
    // a 200 with a null user (or 429/5xx) is transient, so don't brand it
    // token_invalid.
    const authFailed =
      status === 401 ||
      status === 403 ||
      /unauthor/i.test(parsed?.error || "") ||
      /unauthor/i.test(parsed?.message || "");
    const e = new Error(
      authFailed
        ? "Token invalid/expired or client-id mismatch"
        : "Twitch returned no user (transient; token not confirmed dead)" +
          (status ? " [HTTP " + status + "]" : ""),
    );
    e.code = authFailed ? "token_invalid" : "no_user";
    throw e;
  }
  return user.dropCampaigns || [];
}

module.exports = { fetchInventory, fetchDropCampaigns, DEFAULT_CLIENT_ID };
