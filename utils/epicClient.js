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

// ---------------------------------------------------------------------------
// Direct-API purchase path (auto-claim without an operator tap).
//
// The store frontend calls the payment-website-pci endpoints against a
// browser SSO cookie (EPIC_SESSION_AP + XSRF-TOKEN). We mint that cookie by
// consuming a fresh exchange code the same way /id/exchange?exchangeCode=…
// does when the operator taps a claim link — but keep the resulting cookies
// in-process instead of handing them to a browser.
//
// For a *free* game the flow is:
//   1. createStoreSession(accessToken)     → { cookie, xsrf }
//   2. orderPreview(session, ns, offer)    → { syncToken, needsCaptcha, … }
//   3. confirmOrder(session, ns, offer, syncToken, { captchaToken? })
//      → { orderComplete, captchaKey? }
//
// If step 3 comes back with a captcha challenge the caller solves it via
// utils/captchaSolver and retries confirm with the captchaToken. Talon fires
// hardest during Mega Sale weeks and for very-new accounts; on quiet weeks
// this whole path just goes through.
const PAY = "https://payment-website-pci.ol.epicgames.com/purchase";
const STORE_URL = "https://www.epicgames.com/store/";
// A recent Chrome UA — payment-website-pci refuses obviously-scripted UAs.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function parseSetCookieValues(setCookie) {
  const out = {};
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie].filter(Boolean);
  for (const line of arr) {
    const first = String(line).split(";")[0];
    const eq = first.indexOf("=");
    if (eq > 0) out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => k + "=" + v)
    .join("; ");
}

// Mint a store SSO session tied to this OAuth account. Returns a cookie jar
// + XSRF token ready for /purchase/* calls.
//
// The proven path is the same /id/exchange redirect chain the operator's
// Telegram tap-link goes through: axios with cookie capture at every hop
// gets us the EPIC_SESSION_AP + XSRF-TOKEN the payment endpoints check for.
// We aim the final redirect at /store/ (neutral page) so we can't get
// bounced back to /id/login if SSO didn't take.
async function createStoreSession(accessToken) {
  const jar = {};
  const code = await exchangeCode(accessToken);
  const redirectUrl = STORE_URL;
  const tapUrl =
    "https://www.epicgames.com/id/exchange?exchangeCode=" +
    encodeURIComponent(code) +
    "&redirectUrl=" + encodeURIComponent(redirectUrl);
  // Walk the redirect chain manually so we capture set-cookie at every hop
  // (axios's maxRedirects follows cookies but doesn't return them all).
  let next = tapUrl;
  for (let i = 0; i < 6 && next; i++) {
    const res = await axios.get(next, {
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: cookieHeader(jar),
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      maxRedirects: 0,
      timeout: 20000,
      validateStatus: () => true,
    });
    Object.assign(jar, parseSetCookieValues(res.headers["set-cookie"]));
    const loc = res.headers.location || res.headers.Location || "";
    if (!loc) break;
    next = loc.startsWith("http")
      ? loc
      : "https://www.epicgames.com" + (loc.startsWith("/") ? "" : "/") + loc;
    // Guard against a login bounce — that means SSO didn't take.
    if (/\/id\/login/.test(next)) {
      throw new Error("store session bounced to /id/login (SSO did not take)");
    }
  }
  // A /store hit refreshes the XSRF-TOKEN cookie the payment endpoints check.
  const pre = await axios.get(STORE_URL, {
    headers: { "User-Agent": BROWSER_UA, Cookie: cookieHeader(jar) },
    timeout: 20000,
    validateStatus: () => true,
  });
  Object.assign(jar, parseSetCookieValues(pre.headers["set-cookie"]));
  if (!jar["EPIC_SESSION_AP"]) {
    throw new Error("store session cookie missing after tap-link redirect");
  }
  return { jar, xsrf: jar["XSRF-TOKEN"] || "" };
}

function purchaseForm(namespace, offerId, extra) {
  // Same shape the store frontend POSTs for a $0 quick-purchase. useDefault +
  // useDefaultBillingAccount + canQuickPurchase are what tell payment-website-
  // pci to skip the payment-method sheet on a free game.
  const base = {
    useDefault: "true",
    setDefault: "false",
    namespace,
    country: "US",
    countryName: "United States",
    orderId: "",
    orderComplete: "",
    orderError: "",
    orderPending: "",
    offers: offerId,
    offerPrice: "",
    affiliateId: "",
    creatorSource: "",
    threeDSToken: "",
    voucherCode: "",
    isFreeOrder: "false",
    eulaId: "",
    useDefaultBillingAccount: "true",
    canQuickPurchase: "true",
    ...(extra || {}),
  };
  return Object.entries(base)
    .map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v))
    .join("&");
}

async function orderPreview(session, namespace, offerId) {
  const res = await axios.post(
    PAY + "/order-preview",
    purchaseForm(namespace, offerId),
    {
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: cookieHeader(session.jar),
        "x-xsrf-token": session.xsrf,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://www.epicgames.com",
        Referer:
          "https://www.epicgames.com/store/purchase?highlightColor=0078f2&offers=1-" +
          namespace + "-" + offerId,
      },
      timeout: 25000,
      validateStatus: () => true,
    },
  );
  // Cookie jar may be rotated on the response.
  Object.assign(session.jar, parseSetCookieValues(res.headers["set-cookie"]));
  if (res.headers["set-cookie"]) {
    session.xsrf = session.jar["XSRF-TOKEN"] || session.xsrf;
  }
  const data = res.data || {};
  const captchaKey =
    data.captchaKey ||
    (data.orderResponse && data.orderResponse.captchaKey) ||
    "";
  return {
    ok: res.status === 200,
    status: res.status,
    syncToken: data.syncToken || "",
    orderResponse: data.orderResponse || null,
    needsCaptcha: !!captchaKey,
    captchaKey,
    errorCode: data.errorCode || "",
    message: data.message || "",
    raw: data,
  };
}

async function confirmOrder(session, namespace, offerId, syncToken, opts) {
  const extra = { syncToken, expectedTotalPrice: "0" };
  if (opts && opts.captchaToken) extra.captchaToken = opts.captchaToken;
  const res = await axios.post(
    PAY + "/confirm-order",
    purchaseForm(namespace, offerId, extra),
    {
      headers: {
        "User-Agent": BROWSER_UA,
        Cookie: cookieHeader(session.jar),
        "x-xsrf-token": session.xsrf,
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://www.epicgames.com",
        Referer:
          "https://www.epicgames.com/store/purchase?highlightColor=0078f2&offers=1-" +
          namespace + "-" + offerId,
      },
      timeout: 30000,
      validateStatus: () => true,
    },
  );
  Object.assign(session.jar, parseSetCookieValues(res.headers["set-cookie"]));
  const data = res.data || {};
  const captchaKey =
    data.captchaKey ||
    (data.orderResponse && data.orderResponse.captchaKey) ||
    "";
  const complete =
    (data.orderResponse && data.orderResponse.orderComplete) ||
    data.orderComplete ||
    "";
  return {
    ok: res.status === 200 && String(complete).toUpperCase() === "COMPLETE",
    status: res.status,
    orderComplete: complete,
    orderId:
      (data.orderResponse && data.orderResponse.orderId) || data.orderId || "",
    needsCaptcha: !!captchaKey,
    captchaKey,
    errorCode: data.errorCode || "",
    message: data.message || "",
    raw: data,
  };
}

// End-to-end: mint session, preview, confirm, retry once with a solved
// captcha if the confirm demanded one. Returns { status, orderId?, error? }.
//   status = "claimed" | "already_owned" | "needs_captcha" | "captcha_failed"
//          | "session_failed" | "error"
async function autoClaimFreebie(accessToken, namespace, offerId, opts) {
  const solverFn = opts && opts.solveCaptcha; // (captchaKey) => Promise<token>
  let session;
  try {
    session = await createStoreSession(accessToken);
  } catch (err) {
    return { status: "session_failed", error: err.message };
  }
  const preview = await orderPreview(session, namespace, offerId);
  if (
    preview.errorCode &&
    /already.*own|entitle/i.test(preview.errorCode + " " + preview.message)
  ) {
    return { status: "already_owned" };
  }
  if (!preview.ok) {
    return {
      status: "error",
      error:
        "preview " + preview.status + " " + (preview.errorCode || preview.message),
    };
  }
  let confirm = await confirmOrder(
    session,
    namespace,
    offerId,
    preview.syncToken,
  );
  if (
    !confirm.ok &&
    /already.*own|entitle/i.test(confirm.errorCode + " " + confirm.message)
  ) {
    return { status: "already_owned" };
  }
  if (!confirm.ok && confirm.needsCaptcha) {
    if (!solverFn) return { status: "needs_captcha", captchaKey: confirm.captchaKey };
    let token;
    try {
      token = await solverFn(confirm.captchaKey);
    } catch (err) {
      return { status: "captcha_failed", error: err.message };
    }
    // Re-preview so the syncToken is fresh, then confirm with the token.
    const preview2 = await orderPreview(session, namespace, offerId);
    if (!preview2.ok) {
      return {
        status: "error",
        error:
          "preview-after-captcha " + preview2.status + " " +
          (preview2.errorCode || preview2.message),
      };
    }
    confirm = await confirmOrder(
      session,
      namespace,
      offerId,
      preview2.syncToken,
      { captchaToken: token },
    );
    if (
      !confirm.ok &&
      /already.*own|entitle/i.test(confirm.errorCode + " " + confirm.message)
    ) {
      return { status: "already_owned" };
    }
  }
  if (confirm.ok) {
    return { status: "claimed", orderId: confirm.orderId };
  }
  return {
    status: "error",
    error:
      "confirm " + confirm.status + " " +
      (confirm.errorCode || confirm.message || "unknown"),
  };
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
  // auto-claim path
  createStoreSession,
  orderPreview,
  confirmOrder,
  autoClaimFreebie,
};
