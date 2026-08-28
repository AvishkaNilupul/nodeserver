import { randomBytes, randomUUID } from "node:crypto";

export const WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export function makeDeviceId() {
  return randomBytes(16).toString("hex").toUpperCase();
}

export function makeSessionId() {
  return randomBytes(8).toString("hex").toUpperCase();
}

export function makeDistinctId() {
  return randomUUID().replace(/-/g, "");
}

export function makeSession({ token, clientId = WEB_CLIENT_ID } = {}) {
  if (!token) throw new Error("token required");
  return {
    token,
    clientId,
    deviceId: makeDeviceId(),
    sessionId: makeSessionId(),
    userAgent: UA,
    userId: null,
    login: null,
  };
}

function baseHeaders(session, extra = {}) {
  return {
    "Content-Type": "application/json",
    "Client-Id": session.clientId,
    Authorization: "OAuth " + session.token,
    "X-Device-Id": session.deviceId,
    "Client-Session-Id": session.sessionId,
    "User-Agent": session.userAgent,
    ...extra,
  };
}

export async function validate(session) {
  const r = await fetch("https://id.twitch.tv/oauth2/validate", {
    headers: { Authorization: "OAuth " + session.token },
  });
  if (!r.ok) throw new Error("validate failed: " + r.status);
  const data = await r.json();
  session.userId = data.user_id;
  session.login = data.login;
  session.clientId = data.client_id;
  return data;
}

export async function gql(session, ops) {
  const body = JSON.stringify(Array.isArray(ops) ? ops : [ops]);
  const r = await fetch("https://gql.twitch.tv/gql", {
    method: "POST",
    headers: baseHeaders(session),
    body,
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("gql: non-JSON response (" + r.status + "): " + text.slice(0, 200));
  }
  return json;
}

export async function gqlOne(session, op) {
  const arr = await gql(session, [op]);
  return Array.isArray(arr) ? arr[0] : arr;
}

// -- specific queries the farmer needs -----------------------------------

export function getChannelShell(session, login) {
  return gqlOne(session, {
    operationName: "ChannelShell",
    query: `query ChannelShell($login: String!) {
      user(login: $login) {
        id
        login
        displayName
        stream {
          id
          game { id displayName }
        }
      }
    }`,
    variables: { login },
  });
}

// Sends the FULL query text (not a persisted-query hash). The web client's
// persisted hash is only pre-cached on the GQL edges that particular client
// has warmed; a bot that ONLY ever sends the hash and hits a cold edge (e.g.
// from a different region than the browser that registered it) gets
// `PersistedQueryNotFound` on every call, forever, and never credits watch
// time. Sending the full query is edge-independent and always resolves.
export function getPlaybackAccessToken(session, login) {
  return gqlOne(session, {
    operationName: "PlaybackAccessToken_Template",
    variables: {
      isLive: true,
      login,
      isVod: false,
      vodID: "",
      playerType: "site",
    },
    query: `query PlaybackAccessToken_Template($login: String!, $isLive: Boolean!, $vodID: ID!, $isVod: Boolean!, $playerType: String!) {
      streamPlaybackAccessToken(channelName: $login, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isLive) {
        value
        signature
        __typename
      }
      videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) @include(if: $isVod) {
        value
        signature
        __typename
      }
    }`,
  });
}

export function getInventory(session) {
  return gqlOne(session, {
    operationName: "Inventory",
    query: `query Inventory {
      currentUser {
        id
        inventory {
          dropCampaignsInProgress {
            id
            name
            status
            endAt
            game { id displayName }
            timeBasedDrops {
              id
              name
              requiredMinutesWatched
              startAt
              endAt
              benefitEdges { benefit { id name } }
              self { currentMinutesWatched isClaimed dropInstanceID }
            }
          }
          completedRewardCampaigns { id name }
        }
      }
    }`,
    variables: {},
  });
}

// Full query text for the same edge-cache reason as PlaybackAccessToken above:
// the persisted hash returns `PersistedQueryNotFound` on a cold GQL edge. This
// call is non-fatal (progress is also read from getInventory), but sending the
// full query keeps the per-channel progress log accurate from any region.
export function getDropCurrentSession(session, channelId, channelLogin) {
  return gqlOne(session, {
    operationName: "DropCurrentSessionContext",
    variables: { channelID: String(channelId), channelLogin: String(channelLogin) },
    query: `query DropCurrentSessionContext($channelID: ID, $channelLogin: String) {
      currentUser {
        id
        dropCurrentSession(channelID: $channelID, channelLogin: $channelLogin) {
          channel { id displayName }
          game { id displayName }
          currentMinutesWatched
          requiredMinutesWatched
          dropID
        }
      }
    }`,
  });
}

export function claimDrop(session, dropInstanceID) {
  return gqlOne(session, {
    operationName: "DropsPage_ClaimDropRewards",
    query: `mutation DropsPage_ClaimDropRewards($input: ClaimDropRewardsInput!) {
      claimDropRewards(input: $input) {
        status
      }
    }`,
    variables: { input: { dropInstanceID } },
  });
}

// Live channel discovery for a game — the picker uses the title heuristic
// ("DROPS" in the title) as the drops-enabled signal. Stream-level `tags`
// were deprecated by Twitch in 2024; the DROPS_ENABLED tag now lives on the
// broadcaster's channel-level `freeformTags`, not the stream. Title match is
// what every non-integrity drop bot uses today.
export function getLiveChannelsForGame(session, gameName, limit = 30) {
  return gqlOne(session, {
    query: `query GameStreams($name: String!, $limit: Int!) {
      game(name: $name) {
        id
        displayName
        streams(first: $limit, options: {sort: RELEVANCE}) {
          edges {
            node {
              id
              title
              viewersCount
              broadcaster { id login displayName }
            }
          }
        }
      }
    }`,
    variables: { name: gameName, limit },
  });
}
