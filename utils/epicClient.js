// Thin Epic Games account API client used by the Epic accounts manager.
//
// Auth model: the operator pastes a one-time authorization code (from Epic's
// /id/api/redirect endpoint while logged into the account). We exchange it for
// an OAuth token whose refresh_token is valid for ~1 year, so accounts never
// need re-adding week to week — each run just refreshes silently.
//
// What works purely over the API (no browser): reading the account's
// entitlements/library (owned games + titles + price) and generating a
// short-lived login exchange link. The actual store "purchase" of a free game
// is protected by Epic's Talon captcha, so claiming is one-tap assisted (a
// Telegram login link that opens the game's checkout as that account) rather
// than blindly automated — the safe approach that avoids account flags.
const axios = require("axios");

// Fortnite/legendary public client — supports token exchange, entitlements,
// library and exchange-code generation. Same client the Heroic/legendary
// launchers use, so it's stable and low-risk.
const CLIENT_ID = "34a02cf8f4414e29b15921876da36f9a";
const CLIENT_SECRET = "daafbccc737745039dffe53d94fc76cf";
const BASIC =
  "basic " + Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64");

const OAUTH =
  "https://account-public-service-prod.ol.epicgames.com/account/api";
const ENT =
  "https://entitlement-public-service-prod08.ol.epicgames.com/entitlement/api";
const LIB =
  "https://library-service.live.use1a.on.epicgames.com/library/api/public";
const CATALOG =
  "https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared";

const REDIRECT_URL =
  "https://www.epicgames.com/id/api/redirect?clientId=" +
  CLIENT_ID +
  "&responseType=code";

function form(obj) {
  return Object.entries(obj)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}

async function oauthToken(params) {
  const res = await axios.post(OAUTH + "/oauth/token", form(params), {
    headers: {
      Authorization: BASIC,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (res.status !== 200) {
    const msg =
      (res.data && (res.data.errorMessage || res.data.error_description)) ||
      "HTTP " + res.status;
    const e = new Error(msg);
    e.epicCode = res.data && res.data.errorCode;
    throw e;
  }
  return res.data;
}

// Exchange a one-time authorization code for a token bundle.
function exchangeAuthCode(code) {
  return oauthToken({
    grant_type: "authorization_code",
    code,
    token_type: "eg1",
  });
}

// Refresh an access token from a stored refresh token.
function refresh(refreshToken) {
  return oauthToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

// Short-lived (5 min) exchange code, used to build an auto-login link that
// signs the browser into this specific account.
async function exchangeCode(accessToken) {
  const res = await axios.get(OAUTH + "/oauth/exchange", {
    headers: { Authorization: "bearer " + accessToken },
    timeout: 20000,
    validateStatus: () => true,
  });
  if (res.status !== 200 || !res.data || !res.data.code) {
    throw new Error("Could not create exchange code");
  }
  return res.data.code;
}

// A one-tap link that logs the browser into this account and opens the given
// game's checkout page. The operator taps it, solves the captcha if Epic shows
// one, and confirms the free order.
function claimLink(exCode, namespace, offerId) {
  const checkout =
    "https://www.epicgames.com/store/purchase?highlightColor=0078f2&offers=1-" +
    namespace +
    "-" +
    offerId +
    "&orderId&purchaseToken&showNavigation=true";
  return (
    "https://www.epicgames.com/id/exchange?exchangeCode=" +
    exCode +
    "&redirectUrl=" +
    encodeURIComponent(checkout)
  );
}

async function getEntitlements(accountId, accessToken) {
  const res = await axios.get(
    ENT + "/account/" + accountId + "/entitlements?start=0&count=5000",
    {
      headers: { Authorization: "bearer " + accessToken },
      timeout: 20000,
      validateStatus: () => true,
    },
  );
  return Array.isArray(res.data) ? res.data : [];
}

// The launcher library: one record per owned product with its namespace +
// catalogItemId, which we resolve to titles below.
async function getLibraryRecords(accessToken) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < 20; i++) {
    const url =
      LIB +
      "/items?includeMetadata=true" +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const res = await axios.get(url, {
      headers: { Authorization: "bearer " + accessToken },
      timeout: 20000,
      validateStatus: () => true,
    });
    if (res.status !== 200 || !res.data) break;
    (res.data.records || []).forEach((r) => out.push(r));
    cursor =
      (res.data.responseMetadata && res.data.responseMetadata.nextCursor) || "";
    if (!cursor) break;
  }
  return out;
}

// Resolve a namespace+catalogItemId to { title, developer, priceUsd }.
async function resolveCatalogItem(namespace, catalogItemId, accessToken) {
  try {
    const res = await axios.get(
      CATALOG +
        "/namespace/" +
        namespace +
        "/bulk/items?id=" +
        catalogItemId +
        "&country=US&locale=en-US&includeMainGameDetails=true",
      {
        headers: { Authorization: "bearer " + accessToken },
        timeout: 20000,
        validateStatus: () => true,
      },
    );
    const item = res.data && res.data[catalogItemId];
    if (!item) return null;
    let priceUsd = 0;
    if (item.price != null) priceUsd = Number(item.price) / 100;
    return {
      title: item.title || "",
      developer: item.developer || "",
      priceUsd: isNaN(priceUsd) ? 0 : priceUsd,
    };
  } catch {
    return null;
  }
}

module.exports = {
  CLIENT_ID,
  REDIRECT_URL,
  exchangeAuthCode,
  refresh,
  exchangeCode,
  claimLink,
  getEntitlements,
  getLibraryRecords,
  resolveCatalogItem,
};
