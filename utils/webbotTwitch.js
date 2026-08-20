// Web-client (kimne…) OAuth helpers for the WebBotAccount test console.
// Mirrors webbot-drops/src/twitch.js: validate a web token and read its drop
// inventory. Deliberately a DIRECT server-side fetch — this is a low-volume,
// superadmin-only test tool (a few clicks at a time), so unlike the scanners it
// doesn't need to fan the request out over a bot host. Web tokens can READ
// inventory fine; they just can't clear the integrity gate to CLAIM (which is
// why this whole system is farm-only).
const crypto = require("crypto");

const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function tokenInvalid() {
  const e = new Error("token invalid");
  e.code = "token_invalid";
  return e;
}

// GET id.twitch.tv/oauth2/validate — returns login/user_id/client_id/expires_in.
// A 401 means the token is dead and needs replacing.
async function validateToken(webToken) {
  const r = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: "OAuth " + webToken },
  });
  if (r.status === 401) throw tokenInvalid();
  if (!r.ok) throw new Error("validate failed: HTTP " + r.status);
  const d = await r.json();
  return {
    login: d.login || "",
    twitchId: d.user_id ? String(d.user_id) : "",
    clientId: d.client_id || "",
    expiresIn: d.expires_in,
  };
}

const INVENTORY_QUERY = `query Inventory {
  currentUser {
    id
    inventory {
      dropCampaignsInProgress {
        id name status endAt
        game { id displayName }
        timeBasedDrops {
          id name requiredMinutesWatched
          self { currentMinutesWatched isClaimed dropInstanceID }
        }
      }
    }
  }
}`;

// POST gql.twitch.tv — returns the account's in-progress drop campaigns,
// flattened to one row per time-based drop with percent + claim state.
// `farmedUnclaimed` marks a drop the web farmer completed but can't claim.
async function fetchInventory(webToken) {
  const r = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Client-Id": WEB_CLIENT_ID,
      Authorization: "OAuth " + webToken,
      "X-Device-Id": crypto.randomBytes(16).toString("hex").toUpperCase(),
      "User-Agent": UA,
    },
    body: JSON.stringify([{ operationName: "Inventory", query: INVENTORY_QUERY, variables: {} }]),
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("gql: non-JSON response (" + r.status + ")");
  }
  const one = Array.isArray(json) ? json[0] : json;
  // An auth failure surfaces as a GQL error rather than a 401 here.
  if (one?.errors?.some((e) => /unauthorized|authentication|integrity/i.test(e?.message || ""))) {
    // integrity errors are only on mutations; an auth error on a read = dead token
    if (one.errors.some((e) => /unauthorized|authentication/i.test(e?.message || ""))) {
      throw tokenInvalid();
    }
  }
  const campaigns = one?.data?.currentUser?.inventory?.dropCampaignsInProgress || [];
  const drops = [];
  for (const c of campaigns) {
    for (const d of c.timeBasedDrops || []) {
      const s = d.self || {};
      const cur = s.currentMinutesWatched || 0;
      const req = d.requiredMinutesWatched || 0;
      const percent = req > 0 ? Math.min(100, Math.round((cur / req) * 100)) : 0;
      const ready = !!s.dropInstanceID && !s.isClaimed && cur >= req && req > 0;
      drops.push({
        campaign: c.name || "",
        game: c.game?.displayName || "",
        name: d.name || "",
        current: cur,
        required: req,
        percent,
        claimed: !!s.isClaimed,
        ready, // complete + has an instance id, awaiting claim
        farmedUnclaimed: percent >= 100 && !s.isClaimed,
      });
    }
  }
  return { drops };
}

module.exports = { validateToken, fetchInventory, WEB_CLIENT_ID };
