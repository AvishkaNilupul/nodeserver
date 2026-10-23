// CHZZK client (docs/CHZZK-FARM.md §6). No network: a fake transport records
// every request and answers canned {status, json, text}. The things these
// tests exist to prevent:
//  1. A LOGGED-IN CALL BLEEDING FROM AN ANONYMOUS CLIENT. userStatus,
//     challenges, claims and couponCode must throw AUTH without sending.
//  2. Mis-judging a reply. 401 and 403+30001 are AUTH; 204 is null (callers
//     interpret); a json.code != 200 is API with its own message.
//  3. The egress probe leaving CHZZK cookies or Front-Client-* on ipinfo.io.
//  4. Error text echoing a cookie value or a coupon code.
const test = require("node:test");
const assert = require("node:assert/strict");

const { ChzzkError } = require("../utils/chzzk/errors");
const { makeClient, API, GAME } = require("../utils/chzzk/client");

const COOKIES = [
  { name: "NID_AUT", value: "aut-SECRET-value", domain: ".naver.com" },
  { name: "NID_SES", value: "ses-SECRET-value", domain: ".naver.com" },
  { name: "ba.uuid", value: "device-abc-123", domain: ".naver.com" },
];
const COOKIE_HEADER =
  "NID_AUT=aut-SECRET-value; NID_SES=ses-SECRET-value; ba.uuid=device-abc-123";

// handler(url, opts, callNo) -> { status, json, text }
function fakeTransport(handler = () => ({ status: 200, json: { code: 200, content: null }, text: "" })) {
  const calls = [];
  return {
    calls,
    async request(url, opts = {}) {
      calls.push({ url, ...opts });
      return handler(url, opts, calls.length);
    },
  };
}
const okJson = (content) => ({ status: 200, json: { code: 200, content }, text: "" });
const reply = (fn) => fakeTransport(fn);
const makeLoggedIn = (t) => makeClient({ cookies: COOKIES, transport: t });
const makeAnon = (t) => makeClient({ transport: t });

// -------------------------------------------------------------------- headers

test("logged-in client sends UA, Accept, Origin, Referer, Front-Client, Device-Id and Cookie", async () => {
  const t = reply(() => okJson({ data: [] }));
  await makeLoggedIn(t).categoriesLive();
  const h = t.calls[0].headers;
  assert.match(h["user-agent"], /Chrome\/141/);
  assert.equal(h.accept, "application/json, text/plain, */*");
  assert.equal(h["accept-language"], "ko-KR,ko;q=0.9,en;q=0.8");
  assert.equal(h.origin, "https://chzzk.naver.com");
  assert.equal(h.referer, "https://chzzk.naver.com/");
  assert.equal(h["front-client-product-type"], "web");
  assert.equal(h["front-client-platform-type"], "PC");
  assert.equal(h["device-id"], "device-abc-123");
  assert.equal(h.cookie, COOKIE_HEADER);
});

test("deviceId arg wins over the cookies' ba.uuid", async () => {
  const t = reply(() => okJson({ data: [] }));
  await makeClient({ cookies: COOKIES, deviceId: "override-xyz", transport: t }).categoriesLive();
  assert.equal(t.calls[0].headers["device-id"], "override-xyz");
});

test("anonymous client sends no Cookie and no Device-Id, but keeps Front-Client", async () => {
  const t = reply(() => okJson({ data: [] }));
  await makeAnon(t).categoriesLive();
  const h = t.calls[0].headers;
  assert.equal("cookie" in h, false);
  assert.equal("device-id" in h, false);
  assert.equal(h["front-client-product-type"], "web");
  assert.equal(h["front-client-platform-type"], "PC");
});

test("live-scoped calls set referer to the live page for that channel", async () => {
  const t = reply(() => okJson({ liveId: 1 }));
  await makeLoggedIn(t).liveDetail("some-channel");
  assert.equal(t.calls[0].headers.referer, "https://chzzk.naver.com/live/some-channel");
  const t2 = reply(() => okJson({ status: "OPEN" }));
  await makeLoggedIn(t2).liveStatus("some-channel");
  assert.equal(t2.calls[0].headers.referer, "https://chzzk.naver.com/live/some-channel");
  const t3 = reply(() => okJson(null));
  await makeLoggedIn(t3).watchEvent({ channelId: "ch", liveId: 1, type: "WATCH_STARTED", sessionId: "s", positionAt: 0 });
  assert.equal(t3.calls[0].headers.referer, "https://chzzk.naver.com/live/ch");
});

// -------------------------------------------------------------------- judging

test("judging: 401 anywhere -> AUTH", async () => {
  const t = reply(() => ({ status: 401, json: null, text: "" }));
  await assert.rejects(makeLoggedIn(t).campaign(1), (e) => e instanceof ChzzkError && e.code === "AUTH");
});

test("judging: 403 with json.code 30001 -> AUTH; other 403 -> API or HTTP", async () => {
  const auth = reply(() => ({ status: 403, json: { code: 30001, message: "login" }, text: "" }));
  await assert.rejects(makeLoggedIn(auth).campaign(1), { code: "AUTH" });

  const api = reply(() => ({ status: 403, json: { code: 42, message: "banned" }, text: "" }));
  await assert.rejects(makeLoggedIn(api).campaign(1), { code: "API", message: "banned" });

  const http = reply(() => ({ status: 403, json: null, text: "<html>denied</html>" }));
  await assert.rejects(makeLoggedIn(http).campaign(1), { code: "HTTP", status: 403 });
});

test("judging: 204 -> null (callers interpret); watchEvent turns it into true", async () => {
  const t = reply(() => ({ status: 204, json: null, text: "" }));
  const ok = await makeLoggedIn(t).watchEvent({
    channelId: "c", liveId: 1, type: "WATCH_CONTINUED", sessionId: "s", positionAt: 0,
  });
  assert.equal(ok, true);
});

test("judging: json code != 200 -> API with that message", async () => {
  const t = reply(() => ({ status: 200, json: { code: 404, message: "campaign not found" }, text: "" }));
  await assert.rejects(makeLoggedIn(t).campaign(99), { code: "API", message: "campaign not found" });
  // Missing message falls back to the code number.
  const t2 = reply(() => ({ status: 200, json: { code: 999 }, text: "" }));
  await assert.rejects(makeLoggedIn(t2).campaign(1), { code: "API", message: /code 999/ });
});

test("judging: no json AND status >= 400 -> HTTP; a 5xx below 400 is impossible", async () => {
  const t = reply(() => ({ status: 502, json: null, text: "<html>bad gateway</html>" }));
  const err = await makeLoggedIn(t).campaign(1).catch((e) => e);
  assert.ok(err instanceof ChzzkError);
  assert.equal(err.code, "HTTP");
  assert.equal(err.status, 502);
});

test("ChzzkError text never echoes cookie values or sensitive text", async () => {
  const t = reply(() => ({ status: 500, json: null, text: `oops ${COOKIE_HEADER}` }));
  const err = await makeLoggedIn(t).campaign(1).catch((e) => e);
  for (const secret of ["aut-SECRET-value", "ses-SECRET-value", "device-abc-123"]) {
    assert.ok(!err.message.includes(secret), err.message);
  }
});

// ---------------------------------------------------- logged-out short-circuit

test("anonymous: userStatus, challenges, claims, couponCode throw AUTH without sending", async () => {
  const t = reply(() => okJson({}));
  const c = makeAnon(t);
  await assert.rejects(() => c.userStatus(), { code: "AUTH", message: /Not logged in/ });
  await assert.rejects(() => c.challenges(), { code: "AUTH" });
  await assert.rejects(() => c.claims(), { code: "AUTH" });
  await assert.rejects(() => c.couponCode(1), { code: "AUTH" });
  assert.equal(t.calls.length, 0, "no request may leave the client on an anonymous shortcut");
});

test("anonymous: the public calls (categoriesLive/campaign/dropsLives/liveDetail/liveStatus/watchEvent/egressCountry) work", async () => {
  const data = () => okJson({ data: [] });
  const live = () => okJson({ status: "OPEN" });
  const steps = [
    ["categoriesLive", data],
    ["campaign", () => okJson({ campaignNo: 1 }), [1]],
    ["dropsLives", data, ["GAME", "cat", 1]],
    ["liveDetail", live, ["ch"]],
    ["liveStatus", live, ["ch"]],
    ["watchEvent", () => okJson(null), [{ channelId: "ch", liveId: 1, type: "WATCH_STARTED", sessionId: "s", positionAt: 0 }]],
  ];
  for (const [name, maker, args = []] of steps) {
    const t = reply(maker);
    await makeAnon(t)[name](...args);
    assert.equal(t.calls.length, 1, `${name} should send one request`);
  }
  const t = reply(() => ({ status: 200, json: { country: "JP" }, text: "" }));
  assert.equal(await makeAnon(t).egressCountry(), "JP");
});

// -------------------------------------------------------------------- userStatus

test("userStatus: GET the game user endpoint, map { loggedIn, hash, nick, penalties }", async () => {
  const t = reply(() => okJson({
    loggedIn: true, userIdHash: "hash1", nickname: "Nick", penalties: [],
  }));
  const out = await makeLoggedIn(t).userStatus();
  assert.deepEqual(out, { loggedIn: true, userIdHash: "hash1", nickname: "Nick", penalties: [] });
  assert.equal(t.calls[0].url, `${GAME}/nng_main/v1/user/getUserStatus`);
  assert.equal(t.calls[0].method, "GET");
});

test("userStatus: a loggedIn:false reply becomes an AUTH error (the user call is the login check)", async () => {
  const t = reply(() => okJson({ loggedIn: false }));
  await assert.rejects(makeLoggedIn(t).userStatus(), { code: "AUTH", message: /Not logged in/ });
});

test("userStatus: a non-array penalties field becomes []", async () => {
  const t = reply(() => okJson({ loggedIn: true, userIdHash: "h", nickname: "n" }));
  const out = await makeLoggedIn(t).userStatus();
  assert.deepEqual(out.penalties, []);
});

// --------------------------------------------------------------- categoriesLive

test("categoriesLive: builds url?size=50, maps rows, carries the next cursor through", async () => {
  const content = {
    data: [
      {
        categoryType: "GAME", categoryId: "cat1", categoryValue: "Eternal Return",
        openLiveCount: "42", dropsCampaignNos: [99, 100, 0, "x"], extra: "ignored",
      },
      null, // junk rows are dropped
      "nope",
    ],
    page: { next: { concurrentUserCount: 100, categoryId: "cat1" } },
  };
  const t = reply(() => okJson(content));
  const out = await makeLoggedIn(t).categoriesLive();
  assert.deepEqual(out.rows, [{
    categoryType: "GAME", categoryId: "cat1", categoryValue: "Eternal Return",
    openLiveCount: 42, dropsCampaignNos: [99, 100],
  }]);
  assert.deepEqual(out.next, { concurrentUserCount: 100, categoryId: "cat1" });
  const url = new URL(t.calls[0].url);
  assert.equal(url.origin + url.pathname, `${API}/service/v1/categories/live`);
  assert.equal(url.searchParams.get("size"), "50");
});

test("categoriesLive: a next cursor is sent as query fields; no page.next -> null", async () => {
  const t = reply(() => okJson({ data: [] }));
  await makeLoggedIn(t).categoriesLive({ concurrentUserCount: 50, categoryId: "foo", skip: null, blank: "" });
  const url = new URL(t.calls[0].url);
  assert.equal(url.searchParams.get("concurrentUserCount"), "50");
  assert.equal(url.searchParams.get("categoryId"), "foo");
  assert.equal(url.searchParams.has("skip"), false);
  assert.equal(url.searchParams.has("blank"), false);

  const t2 = reply(() => okJson({ data: [], page: {} }));
  assert.equal((await makeLoggedIn(t2).categoriesLive()).next, null);
  const t3 = reply(() => okJson({ data: [] }));
  assert.equal((await makeLoggedIn(t3).categoriesLive()).next, null);
});

// -------------------------------------------------------------------- campaign

test("campaign(no): GET v2/drops/campaigns/{no} and returns the raw content", async () => {
  const content = { campaignNo: 7, title: "T", rewardList: [] };
  const t = reply(() => okJson(content));
  const out = await makeLoggedIn(t).campaign(7);
  assert.equal(out, content);
  assert.equal(t.calls[0].url, `${API}/service/v2/drops/campaigns/7`);
  assert.equal(t.calls[0].method, "GET");
});

// ------------------------------------------------------------------ dropsLives

test("dropsLives: builds the categorised url, size default 20, maps to liveRow()", async () => {
  const content = {
    data: [
      {
        liveId: 100, channelId: "chid", channelName: "Streamer",
        concurrentUserCount: 2500, adult: false,
        openDate: "2026-10-23 10:00:00", dropsCampaignNo: 99,
      },
      null,
    ],
  };
  const t = reply(() => okJson(content));
  const out = await makeLoggedIn(t).dropsLives("GAME", "cat1", 99);
  assert.equal(out.length, 1);
  assert.equal(out[0].channelId, "chid");
  assert.equal(out[0].viewers, 2500);
  assert.equal(out[0].dropsCampaignNo, 99);
  assert.ok(out[0].openAt instanceof Date);

  const url = new URL(t.calls[0].url);
  assert.equal(url.origin + url.pathname, `${API}/service/v1/categories/GAME/cat1/drops-lives`);
  assert.equal(url.searchParams.get("campaignNo"), "99");
  assert.equal(url.searchParams.get("size"), "20");
  assert.equal(url.searchParams.get("sortType"), "POPULAR");
});

test("dropsLives: size overridden through options", async () => {
  const t = reply(() => okJson({ data: [] }));
  await makeLoggedIn(t).dropsLives("GAME", "cat", 1, { size: 5 });
  assert.equal(new URL(t.calls[0].url).searchParams.get("size"), "5");
});

// ----------------------------------------------------------------- liveDetail

test("liveDetail: parses the opening wall clock as KST and keeps the rest flat", async () => {
  const content = {
    liveId: 42, openDate: "2026-10-23 10:00:00", status: "OPEN",
    dropsCampaignNo: 99, channelName: "Streamer",
  };
  const t = reply(() => okJson(content));
  const out = await makeLoggedIn(t).liveDetail("ch1");
  assert.deepEqual(out, {
    liveId: 42,
    openAt: new Date("2026-10-23T01:00:00.000Z"),
    status: "OPEN",
    dropsCampaignNo: 99,
    channelName: "Streamer",
  });
  assert.equal(t.calls[0].url, `${API}/service/v3/channels/ch1/live-detail`);
});

test("liveDetail: a nested channel object fills in a missing channelName", async () => {
  const t = reply(() => okJson({ liveId: 1, channel: { channelName: "fallback" } }));
  const out = await makeLoggedIn(t).liveDetail("ch1");
  assert.equal(out.channelName, "fallback");
  assert.equal(out.openAt, null, "bad openDate -> null");
});

// ----------------------------------------------------------------- liveStatus

test("liveStatus: returns status / dropsCampaignNo / tokens / krOnly / blindType / adult / abroad", async () => {
  const content = {
    status: "OPEN", dropsCampaignNo: 99,
    liveTokens: ["t1", "t2"],
    krOnly: true, blindType: null, adult: false, abroad: false,
  };
  const t = reply(() => okJson(content));
  const out = await makeLoggedIn(t).liveStatus("ch1");
  assert.deepEqual(out, {
    status: "OPEN", dropsCampaignNo: 99,
    liveTokens: ["t1", "t2"],
    krOnly: true, blindType: null, adult: false, abroad: false,
  });
  assert.equal(t.calls[0].url, `${API}/polling/v3.1/channels/ch1/live-status`);
});

test("liveStatus: blindType strings are kept; non-array tokens become []", async () => {
  const t = reply(() => okJson({ blindType: "ADULT", liveTokens: null }));
  const out = await makeLoggedIn(t).liveStatus("ch1");
  assert.equal(out.blindType, "ADULT");
  assert.deepEqual(out.liveTokens, []);
});

// ----------------------------------------------------------------- watchEvent

test("watchEvent: POST with scene:25, body shape, 200+code200 -> true", async () => {
  const t = reply(() => okJson({ heartbeat: "ok" }));
  const ok = await makeLoggedIn(t).watchEvent({
    channelId: "ch1", liveId: 42, type: "WATCH_STARTED",
    sessionId: "sess-1", positionAt: 0, awt: null, liveTokens: ["tk1"],
  });
  assert.equal(ok, true);
  const req = t.calls[0];
  assert.equal(req.url, `${API}/polling/v1/watch-event/live`);
  assert.equal(req.method, "POST");
  assert.equal(req.headers.scene, "25");
  assert.equal(req.headers["content-type"], "application/json");
  assert.deepEqual(req.body, {
    channelId: "ch1",
    liveId: 42,
    payload: { watchEventType: "WATCH_STARTED", sessionId: "sess-1", duration: 30, positionAt: 0 },
    liveTokens: ["tk1"],
    autoPlay: false,
    radioMode: false,
  });
});

test("watchEvent: awt is included only when truthy; non-array liveTokens default to []", async () => {
  const t = reply(() => okJson(null));
  await makeLoggedIn(t).watchEvent({
    channelId: "ch", liveId: 1, type: "WATCH_CONTINUED", sessionId: "s",
    positionAt: 60, awt: "awt-token", liveTokens: null,
  });
  const req = t.calls[0];
  assert.equal(req.body.payload.awt, "awt-token");
  assert.deepEqual(req.body.liveTokens, []);
});

test("watchEvent: 401 -> AUTH; a code!=200 body is API", async () => {
  const t = reply(() => ({ status: 401, json: null, text: "" }));
  await assert.rejects(
    makeLoggedIn(t).watchEvent({ channelId: "ch", liveId: 1, type: "WATCH_STARTED", sessionId: "s", positionAt: 0 }),
    { code: "AUTH" },
  );
  const t2 = reply(() => ({ status: 200, json: { code: 42, message: "no credit" }, text: "" }));
  await assert.rejects(
    makeLoggedIn(t2).watchEvent({ channelId: "ch", liveId: 1, type: "WATCH_STARTED", sessionId: "s", positionAt: 0 }),
    { code: "API", message: "no credit" },
  );
});

// ------------------------------------------------------- challenges / claims

test("challenges: requires login, GET v2 challenges, returns content.challengeList || []", async () => {
  const t = reply(() => okJson({ challengeList: [{ rewardNo: 1 }, { rewardNo: 2 }] }));
  const out = await makeLoggedIn(t).challenges();
  assert.equal(out.length, 2);
  assert.equal(out[0].rewardNo, 1);
  assert.equal(t.calls[0].url, `${API}/commercial/v2/drops/rewards/challenges`);

  const t2 = reply(() => okJson({}));
  assert.deepEqual(await makeLoggedIn(t2).challenges(), []);
});

test("claims: requires login, GET v2 claims, returns content.claimList || []", async () => {
  const t = reply(() => okJson({ claimList: [{ rewardNo: 1, fulfillmentState: "COMPLIED" }] }));
  const out = await makeLoggedIn(t).claims();
  assert.equal(out.length, 1);
  assert.equal(t.calls[0].url, `${API}/commercial/v2/drops/rewards/claims`);

  const t2 = reply(() => okJson({}));
  assert.deepEqual(await makeLoggedIn(t2).claims(), []);
});

// --------------------------------------------------------------- couponCode

test("couponCode: requires login, GET v1 coupon-code, returns { codeNo, code }", async () => {
  const t = reply(() => okJson({ codeNo: "99", code: "ABC-DEF-GHI" }));
  const out = await makeLoggedIn(t).couponCode(123);
  assert.deepEqual(out, { codeNo: "99", code: "ABC-DEF-GHI" });
  assert.equal(t.calls[0].url, `${API}/commercial/v1/drops/rewards/123/coupon-code`);
});

test("couponCode: a thrown HTTP error does not echo the code anywhere", async () => {
  const t = reply(() => ({ status: 500, json: null, text: "oops the code was SECRET-CODE-X" }));
  const err = await makeLoggedIn(t).couponCode(1).catch((e) => e);
  assert.ok(err instanceof ChzzkError);
  assert.ok(!err.message.includes("SECRET-CODE-X"), err.message);
});

// -------------------------------------------------------------- egressCountry

test("egressCountry: GET ipinfo through the transport, no CHZZK headers, no cookies", async () => {
  const t = reply(() => ({ status: 200, json: { country: "JP", ip: "1.2.3.4" }, text: "" }));
  const out = await makeLoggedIn(t).egressCountry();
  assert.equal(out, "JP");
  const req = t.calls[0];
  assert.equal(req.url, "https://ipinfo.io/json");
  assert.equal("cookie" in req.headers, false);
  assert.equal("device-id" in req.headers, false);
  assert.equal("front-client-product-type" in req.headers, false);
  assert.equal("front-client-platform-type" in req.headers, false);
  assert.equal("origin" in req.headers, false);
  assert.equal("referer" in req.headers, false);
  assert.match(req.headers["user-agent"], /Chrome\/141/);
});

test("egressCountry: returns '' on non-200, on a reply without a country, and when the transport throws", async () => {
  const t500 = reply(() => ({ status: 500, json: null, text: "" }));
  assert.equal(await makeLoggedIn(t500).egressCountry(), "");

  const tEmpty = reply(() => ({ status: 200, json: { ip: "1.2.3.4" }, text: "{}" }));
  assert.equal(await makeLoggedIn(tEmpty).egressCountry(), "");

  const thrown = {
    calls: [],
    async request() {
      throw new ChzzkError("egress down", { code: "EGRESS" });
    },
  };
  assert.equal(await makeLoggedIn(thrown).egressCountry(), "");
  // Even on an anonymous client the probe works and never throws.
  assert.equal(await makeAnon(tEmpty).egressCountry(), "");
});

// ------------------------------------------------------------- client surface

test("makeClient exposes exactly the §6 method names", () => {
  const c = makeClient({ transport: reply() });
  assert.deepEqual(Object.keys(c).sort(), [
    "campaign",
    "categoriesLive",
    "challenges",
    "claims",
    "couponCode",
    "dropsLives",
    "egressCountry",
    "liveDetail",
    "liveStatus",
    "userStatus",
    "watchEvent",
  ]);
});

test("makeClient without arguments does not crash (defaults to the shared transport)", () => {
  // Just checks the factory runs; the shared transport will refuse any call
  // when no egress is configured, which other code paths cover.
  const c = makeClient();
  assert.equal(typeof c.userStatus, "function");
});
