// Pure helpers shared by the PA Cookie Pusher service worker, its popup and its
// tests.
//
// Loaded three ways: importScripts() in the MV3 service worker (sets self.PAL),
// a <script> tag in the popup (sets globalThis.PAL), and require() in the node
// test (module.exports). Keep it dependency-free so all three work, and keep it
// browser-engine-agnostic so the same file runs under Chrome, Edge and Safari /
// Orion (iOS).
(function (factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof self !== "undefined") self.PAL = api;
  else if (typeof globalThis !== "undefined") globalThis.PAL = api;
})(function () {
  const REFRESH = "Production_refresh_token";
  const ACCESS = "Production_access_token";

  // Cloudflare sets these on ANY visit to playerauctions.com — signed in or
  // not — and both are httpOnly. That makes them the perfect no-login probe for
  // "can this browser's extension read httpOnly cookies at all?" (see probe()).
  const HTTPONLY_MARKERS = ["__cf_bm", "_cfuvid"];

  // Collapse a cookies list into a Cookie header (last value wins per name, the
  // way a browser flattens a jar).
  function jarFromCookies(list) {
    const byName = new Map();
    for (const c of list || []) byName.set(c.name, c.value);
    return {
      header: [...byName.entries()].map(([k, v]) => k + "=" + v).join("; "),
      refresh: byName.get(REFRESH) || "",
      access: byName.get(ACCESS) || "",
      ok: byName.has(ACCESS) && byName.has(REFRESH),
    };
  }

  // THE load-bearing rule. Push to prod iff the jar is a complete signed-in
  // session AND its refresh token differs from the one we last handed over.
  //
  // PlayerAuctions replaces Production_refresh_token only on a fresh human
  // login; a routine access-token refresh (every ~30 min) rotates
  // Production_access_token and the session id but leaves the refresh token
  // alone. So keying on the refresh token fires exactly once per login and
  // NEVER on the browser's own access refreshes — which is what keeps the
  // harvester from fighting prod for the one-session-per-account slot.
  function shouldInstall(jar, lastPushedRefresh) {
    return !!(jar && jar.ok && jar.refresh && jar.refresh !== lastPushedRefresh);
  }

  // Is a cookies.onChanged event the one worth waking for? Only a SET (not a
  // removal) of the refresh-token cookie on a playerauctions.com domain.
  function isRefreshTokenChange(info) {
    if (!info || info.removed) return false;
    const c = info.cookie || {};
    if (c.name !== REFRESH) return false;
    return /(^|\.)playerauctions\.com$/.test(c.domain || "");
  }

  // Classify what the extension can actually see, WITHOUT signing in. This is
  // the on-device feasibility verdict for iOS: Apple does not expose httpOnly
  // cookies to Safari web extensions, and the PA session tokens are httpOnly, so
  // on a blocked device the signed-in jar can never be read. Because __cf_bm /
  // _cfuvid are httpOnly and set on a plain visit, their visibility proves
  // httpOnly reading works here — with no login and no risk to the live session.
  function probe(list) {
    const arr = list || [];
    const names = arr.map((c) => c.name);
    const nameSet = new Set(names);
    // Prefer the explicit httpOnly flag when the engine reports it; fall back to
    // "did a known-httpOnly marker come through" for engines that omit the flag.
    const sawHttpOnlyFlag = arr.some((c) => c.httpOnly === true);
    const sawMarker = HTTPONLY_MARKERS.some((n) => nameSet.has(n));
    const signedIn = nameSet.has(ACCESS) && nameSet.has(REFRESH);
    return {
      total: arr.length,
      names,
      httpOnlyReadable: sawHttpOnlyFlag || sawMarker || signedIn,
      // We only trust a hard "blocked" verdict when SOME PA cookie was visible
      // but no httpOnly one — i.e. reading works, httpOnly is being filtered.
      httpOnlyBlocked: arr.length > 0 && !sawHttpOnlyFlag && !sawMarker && !signedIn,
      signedIn,
    };
  }

  // Read every playerauctions.com cookie, working around a known iOS 18 Safari
  // bug where cookies.getAll({domain}) returns [] until you query each cookie
  // store by storeId. Takes the engine's cookies API object so it stays pure and
  // testable. Falls back gracefully when getAllCookieStores is unavailable.
  async function gatherAll(cookiesApi) {
    const dedupe = (list) => {
      const seen = new Map();
      for (const c of list || []) seen.set(c.name + "\u0000" + (c.storeId || ""), c);
      return [...seen.values()];
    };
    let direct = [];
    try {
      direct = (await cookiesApi.getAll({ domain: "playerauctions.com" })) || [];
    } catch {
      direct = [];
    }
    if (direct.length) return dedupe(direct);
    // Empty: try the per-store workaround.
    let stores = [];
    try {
      stores = (await cookiesApi.getAllCookieStores()) || [];
    } catch {
      return [];
    }
    const out = [];
    for (const s of stores) {
      try {
        const list = (await cookiesApi.getAll({ domain: "playerauctions.com", storeId: s.id })) || [];
        for (const c of list) out.push({ ...c, storeId: c.storeId || s.id });
      } catch {
        /* skip a store we cannot read */
      }
    }
    return dedupe(out);
  }

  return {
    REFRESH,
    ACCESS,
    HTTPONLY_MARKERS,
    jarFromCookies,
    shouldInstall,
    isRefreshTokenChange,
    probe,
    gatherAll,
  };
});
