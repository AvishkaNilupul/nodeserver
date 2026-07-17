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

async function gqlRequest(token, clientId, body) {
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

// Fetch + parse one account's inventory.
// Returns { twitchId, login, drops: [...] }.
// Throws an Error with .code = "token_invalid" when Twitch rejects the token.
async function fetchInventory(token, clientId) {
  const tok = cleanToken(token);
  const cid = clientId || DEFAULT_CLIENT_ID;
  if (!tok) {
    const e = new Error("No token");
    e.code = "token_invalid";
    throw e;
  }

  let { parsed } = await gqlRequest(tok, cid, [
    { operationName: "Inventory", query: INVENTORY_QUERY, variables: {} },
  ]);

  if (parsed?.errors?.length) {
    // Fall back to Twitch's persisted query (some tokens/clients reject ad-hoc
    // queries), matching the client page's behaviour.
    const retry = await gqlRequest(tok, cid, [
      {
        operationName: "Inventory",
        variables: { fetchRewardCampaigns: true },
        extensions: {
          persistedQuery: { sha256Hash: INVENTORY_HASH, version: 1 },
        },
      },
    ]);
    parsed = retry.parsed;
  }

  if (parsed?.errors?.length) {
    throw gqlError(parsed.errors);
  }

  const user = parsed?.data?.currentUser;
  if (user === null || user === undefined) {
    const e = new Error("Token invalid/expired or client-id mismatch");
    e.code = "token_invalid";
    throw e;
  }
  const inv = user.inventory;
  if (!inv) {
    return { twitchId: user.id || "", login: user.login || "", drops: [] };
  }
  return {
    twitchId: user.id || "",
    login: user.login || "",
    drops: buildDrops(inv),
  };
}

// Fetch the full drop-campaign dashboard with any valid account token.
// Throws an Error with .code = "token_invalid" when Twitch rejects the token.
async function fetchDropCampaigns(token, clientId) {
  const tok = cleanToken(token);
  const cid = clientId || DEFAULT_CLIENT_ID;
  if (!tok) {
    const e = new Error("No token");
    e.code = "token_invalid";
    throw e;
  }
  const { parsed } = await gqlRequest(tok, cid, [
    {
      operationName: "ViewerDropsDashboard",
      query: CAMPAIGNS_QUERY,
      variables: {},
    },
  ]);
  if (parsed?.errors?.length) {
    throw gqlError(parsed.errors);
  }
  const user = parsed?.data?.currentUser;
  if (!user) {
    const e = new Error("Token invalid/expired or client-id mismatch");
    e.code = "token_invalid";
    throw e;
  }
  return user.dropCampaigns || [];
}

module.exports = { fetchInventory, fetchDropCampaigns, DEFAULT_CLIENT_ID };
