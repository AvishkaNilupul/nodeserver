// The zero-click harvester's decision logic (tools/pa-cookie-pusher/logic.js).
//
// The one rule that keeps the harvester from killing the live session: push
// ONCE per human login (the refresh token changing), never on the browser's own
// access-token refreshes. If this ever regresses, the harvester and prod start
// refreshing the same session in parallel and PlayerAuctions revokes it — the
// exact failure this whole design exists to avoid.
const test = require("node:test");
const assert = require("node:assert");

const PAL = require("../tools/pa-cookie-pusher/logic.js");

const cookie = (name, value, domain = ".playerauctions.com") => ({ name, value, domain });

test("jarFromCookies builds a header and flags a complete signed-in jar", () => {
  const jar = PAL.jarFromCookies([
    cookie("Production_access_token", "a1"),
    cookie("Production_refresh_token", "r1"),
    cookie("sid", "s1"),
  ]);
  assert.equal(jar.ok, true);
  assert.equal(jar.refresh, "r1");
  assert.equal(jar.access, "a1");
  assert.match(jar.header, /Production_access_token=a1/);
  assert.match(jar.header, /Production_refresh_token=r1/);
  assert.match(jar.header, /sid=s1/);
});

test("jarFromCookies is not ok without both tokens", () => {
  assert.equal(PAL.jarFromCookies([cookie("Production_access_token", "a1")]).ok, false);
  assert.equal(PAL.jarFromCookies([cookie("Production_refresh_token", "r1")]).ok, false);
  assert.equal(PAL.jarFromCookies([]).ok, false);
});

test("shouldInstall: a fresh login (new refresh token) pushes once", () => {
  const jar = PAL.jarFromCookies([
    cookie("Production_access_token", "a1"),
    cookie("Production_refresh_token", "r1"),
  ]);
  // First sight of this login: push.
  assert.equal(PAL.shouldInstall(jar, ""), true);
  // Same refresh token already handed to prod: do NOT push again.
  assert.equal(PAL.shouldInstall(jar, "r1"), false);
});

test("shouldInstall: an access-token-only refresh does NOT push", () => {
  // Same login, the browser just rotated its 30-min access token. The refresh
  // token is unchanged, so prod must be left alone.
  const afterAccessRefresh = PAL.jarFromCookies([
    cookie("Production_access_token", "a2-rotated"),
    cookie("Production_refresh_token", "r1"),
  ]);
  assert.equal(PAL.shouldInstall(afterAccessRefresh, "r1"), false);
});

test("shouldInstall: a new login after one already pushed pushes again", () => {
  const relogin = PAL.jarFromCookies([
    cookie("Production_access_token", "a9"),
    cookie("Production_refresh_token", "r2-new-login"),
  ]);
  assert.equal(PAL.shouldInstall(relogin, "r1"), true);
});

test("shouldInstall: an incomplete jar never pushes", () => {
  const halfJar = PAL.jarFromCookies([cookie("Production_access_token", "a1")]);
  assert.equal(PAL.shouldInstall(halfJar, ""), false);
});

test("isRefreshTokenChange: only a refresh-token SET on a PA domain counts", () => {
  const ok = { removed: false, cookie: cookie("Production_refresh_token", "r1") };
  assert.equal(PAL.isRefreshTokenChange(ok), true);

  // A removal (logout) is not a login.
  assert.equal(PAL.isRefreshTokenChange({ removed: true, cookie: cookie("Production_refresh_token", "r1") }), false);
  // The access token changing is not the trigger.
  assert.equal(PAL.isRefreshTokenChange({ removed: false, cookie: cookie("Production_access_token", "a1") }), false);
  // A refresh-token-shaped cookie on some other domain is not ours.
  assert.equal(
    PAL.isRefreshTokenChange({ removed: false, cookie: cookie("Production_refresh_token", "r1", ".evil.com") }),
    false,
  );
});

// ---------------------------------------------------------------------------
// probe(): the on-device feasibility verdict for iPhone. Apple hides httpOnly
// cookies from Safari web extensions, and the PA session tokens are httpOnly, so
// the check keys on whether ANY httpOnly cookie comes through.
// ---------------------------------------------------------------------------

test("probe: a signed-in jar is readable (ready)", () => {
  const p = PAL.probe([
    cookie("Production_access_token", "a1"),
    cookie("Production_refresh_token", "r1"),
    cookie("sid", "s1"),
  ]);
  assert.equal(p.signedIn, true);
  assert.equal(p.httpOnlyReadable, true);
  assert.equal(p.httpOnlyBlocked, false);
});

test("probe: httpOnly markers alone prove readability without a login", () => {
  // Not signed in, but the Cloudflare httpOnly cookies came through — so this
  // engine does expose httpOnly cookies and the real flow will work.
  const p = PAL.probe([cookie("__cf_bm", "x"), cookie("_cfuvid", "y")]);
  assert.equal(p.signedIn, false);
  assert.equal(p.httpOnlyReadable, true);
  assert.equal(p.httpOnlyBlocked, false);
});

test("probe: the explicit httpOnly flag is honoured when the engine sets it", () => {
  const c = { name: "whatever", value: "v", domain: ".playerauctions.com", httpOnly: true };
  const p = PAL.probe([c]);
  assert.equal(p.httpOnlyReadable, true);
});

test("probe: cookies visible but none httpOnly => BLOCKED (iOS filtering)", () => {
  const p = PAL.probe([cookie("display_cookie_popup", "1"), cookie("iseu", "0")]);
  assert.equal(p.signedIn, false);
  assert.equal(p.httpOnlyReadable, false);
  assert.equal(p.httpOnlyBlocked, true);
});

test("probe: nothing visible is 'unknown', not 'blocked'", () => {
  const p = PAL.probe([]);
  assert.equal(p.total, 0);
  assert.equal(p.httpOnlyBlocked, false);
});

// ---------------------------------------------------------------------------
// gatherAll(): works around the iOS 18 getAll({domain}) === [] bug by falling
// back to per-store queries.
// ---------------------------------------------------------------------------

test("gatherAll: uses the direct result when getAll returns cookies", async () => {
  const api = {
    getAll: async () => [cookie("Production_refresh_token", "r1")],
    getAllCookieStores: async () => {
      throw new Error("should not be called");
    },
  };
  const list = await PAL.gatherAll(api);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, "Production_refresh_token");
});

test("gatherAll: falls back to per-store queries when direct getAll is empty", async () => {
  const perStore = {
    "0": [cookie("Production_access_token", "a1")],
    "1": [cookie("Production_refresh_token", "r1")],
  };
  const api = {
    getAll: async ({ storeId }) => (storeId == null ? [] : perStore[storeId] || []),
    getAllCookieStores: async () => [{ id: "0" }, { id: "1" }],
  };
  const jar = PAL.jarFromCookies(await PAL.gatherAll(api));
  assert.equal(jar.ok, true);
  assert.equal(jar.access, "a1");
  assert.equal(jar.refresh, "r1");
});

test("gatherAll: a thrown getAll degrades to [] without crashing", async () => {
  const api = {
    getAll: async () => {
      throw new Error("boom");
    },
    getAllCookieStores: async () => {
      throw new Error("also boom");
    },
  };
  const list = await PAL.gatherAll(api);
  assert.deepEqual(list, []);
});
