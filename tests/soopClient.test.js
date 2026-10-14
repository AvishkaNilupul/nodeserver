// SOOP client (contract §7). No network: a fake transport records every
// request and answers canned JSON, and a fake WebSocket stands in for the bridge.
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { SoopError } = require("../utils/soop/errors");
const { createGeoResolver } = require("../utils/soop/geo");
const { UA, parseCookieInput, splitCookieExports, makeClient, sharedGeo } = require("../utils/soopClient");

const TICKET = "ticket-SECRET-123";
const COOKIES = [
  { name: "AuthTicket", value: TICKET },
  { name: "_au", value: "aaaabbbbccccdddd" },
];
const COOKIE_HEADER = `AuthTicket=${TICKET}; _au=aaaabbbbccccdddd`;
const CH = { GWIP: "1.2.3.4", GWPT: "8001", BNO: "555", CATE: "00040019", FTK: "ftk", CTIP: "5.6.7.8", CTPT: "9001" };

// handler(url, opt, callNo) -> reply object (or throws)
function fakeTransport(handler = () => ({}), { wsOptions = () => ({}) } = {}) {
  const calls = [];
  return {
    calls,
    proxied: false,
    ready: true,
    describe: () => "direct",
    stats: () => ({}),
    wsOptions,
    async requestJson(url, opt = {}) {
      calls.push({ url, ...opt });
      return handler(url, opt, calls.length);
    },
  };
}

// Resolver stand-in: the country comes from the client's own lookup, the two
// numeric fields from the resolver, so the test can tell the sources apart.
function fakeGeo({ fail = false } = {}) {
  const geo = {
    calls: 0,
    async get(fetchCountry) {
      geo.calls++;
      if (fail) throw new SoopError("country unknown", { code: "EGRESS" });
      return { cc: await fetchCountry(), joinCc: "144", geoRc: "07" };
    },
  };
  return geo;
}

function fakeSocketClass() {
  class FakeWS extends EventEmitter {
    constructor(url, protocols, options) {
      super();
      Object.assign(this, { url, protocols, options, readyState: 0, sent: [], closeCalls: 0 });
      FakeWS.instances.push(this);
    }
    send(text) {
      this.sent.push(JSON.parse(text));
    }
    close() {
      this.closeCalls++;
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close");
    }
    open() {
      this.readyState = 1;
      this.emit("open");
    }
    receive(obj) {
      this.emit("message", Buffer.from(JSON.stringify(obj)));
    }
  }
  FakeWS.instances = [];
  return FakeWS;
}

const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};
const field = (joinLog, key) => {
  const m = new RegExp(`\u0006&\u0006${key}\u0006=\u0006([^\u0006\u0012]*)`).exec(joinLog);
  return m ? m[1] : undefined;
};
const client = (transport, extra = {}) =>
  makeClient(COOKIES, { id: "acc1", transport, geo: fakeGeo(), ...extra });
const privateReply = { CHANNEL: { IS_LOGIN: 1, LOGIN_ID: "acc1", LOGIN_NICK: "Nick", COUNTRY_CODE: "LK" } };

function bridge({ transport, geo = fakeGeo(), onEvent } = {}) {
  const WS = fakeSocketClass();
  const t = transport || fakeTransport(() => privateReply);
  const events = [];
  const c = makeClient(COOKIES, { transport: t, geo, WebSocketImpl: WS });
  const state = c.openBridge("streamer1", CH, {
    onEvent: onEvent || ((ev) => events.push(ev)),
  });
  return { WS, ws: WS.instances[0], state, events, transport: t, geo };
}

test("drops endpoints carry cookie, language and the drops site's origin / referer", async () => {
  const t = fakeTransport(() => ({ result: 1, data: [] }));
  await client(t).missions();
  const [req] = t.calls;
  assert.equal(req.url, "https://drops.sooplive.com/api/get_drops_mission_list.php");
  assert.equal(req.method, "GET");
  assert.equal(req.headers.cookie, COOKIE_HEADER);
  assert.equal(req.headers["user-agent"], UA);
  assert.equal(req.headers["accept-language"], "en-US,en;q=0.9");
  assert.equal(req.headers.origin, "https://drops.sooplive.com");
  assert.equal(req.headers.referer, "https://drops.sooplive.com/mission");
  // nothing rides beside `headers`, where the transport would ignore it
  assert.deepEqual(Object.keys(req).sort(), ["body", "headers", "method", "url"]);
});

test("live endpoints carry cookie, language and the player's origin / referer", async () => {
  const t = fakeTransport(() => ({ CHANNEL: { RESULT: 1, BNO: 555 } }));
  const ch = await client(t, { lang: "ja-JP" }).liveInfo("some bj", "555");
  assert.deepEqual(ch, { RESULT: 1, BNO: 555 });
  const [req] = t.calls;
  assert.equal(req.url, "https://live.sooplive.com/afreeca/player_live_api.php?bjid=some%20bj");
  assert.equal(req.method, "POST");
  assert.equal(req.headers.cookie, COOKIE_HEADER);
  assert.equal(req.headers["accept-language"], "ja-JP");
  assert.equal(req.headers.origin, "https://play.sooplive.com");
  assert.equal(req.headers.referer, "https://play.sooplive.com");
  assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(
    String(req.body),
    "bid=some+bj&bno=555&type=live&pwd=&player_type=html5&stream_type=common" +
      "&quality=HD&mode=landing&from_api=0&is_revive=false",
  );
});

test("liveInfo answers null when SOOP sends no CHANNEL", async () => {
  assert.equal(await client(fakeTransport(() => ({}))).liveInfo("bj"), null);
});

test("result -1 and a login message both throw AUTH; other failures throw API", async () => {
  const failing = (reply) => client(fakeTransport(() => reply));
  await assert.rejects(failing({ result: -1, message: "nope" }).missions(), { code: "AUTH" });
  await assert.rejects(failing({ result: 0, message: "로그인이 필요합니다." }).missions(), {
    name: "SoopError",
    code: "AUTH",
  });
  await assert.rejects(failing({ result: 0, message: "Please log in first" }).inventory("available"), {
    code: "AUTH",
  });
  await assert.rejects(failing({ result: 0, message: "서비스 점검 중" }).inventoryCounts(), {
    code: "API",
    message: "서비스 점검 중",
  });
  await assert.rejects(failing({ result: 0 }).campaigns(), { code: "API", message: /unavailable/ });
});

test("privateInfo reports a logged-out reply instead of throwing", async () => {
  const out = await client(fakeTransport(() => ({ CHANNEL: { IS_LOGIN: 0, COUNTRY_CODE: "JP" } }))).privateInfo();
  assert.deepEqual(out, { loggedIn: false, loginId: null, nick: null, country: "JP" });
  const empty = await client(fakeTransport(() => ({}))).privateInfo();
  assert.deepEqual(empty, { loggedIn: false, loginId: null, nick: null, country: null });
  const t = fakeTransport(() => privateReply);
  const me = await client(t).privateInfo();
  assert.deepEqual(me, { loggedIn: true, loginId: "acc1", nick: "Nick", country: "LK" });
  assert.equal(t.calls[0].url, "https://afevent2.sooplive.com/api/get_private_info.php");
  assert.equal(t.calls[0].headers.origin, "https://play.sooplive.com");
});

// SOOP's event list as the real server pages it (measured 2026-10-13):
// `prePageNo` rows starting at row (pageNo - 1) * prePageNo, and the size of
// the whole list. `count: false` leaves the size out.
function eventList(lists, { count = true } = {}) {
  return (url, opt) => {
    const { filter, pageNo, prePageNo } = JSON.parse(opt.body);
    const all = lists[filter] || [];
    const from = (pageNo - 1) * prePageNo;
    const data = all.slice(from, from + prePageNo).map((dropsIdx) => ({ dropsIdx, title: `T${dropsIdx}` }));
    return count ? { result: 1, totalCount: all.length, data } : { result: 1, data };
  };
}
const ids = (n, prefix = "d") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test("campaigns() asks for the list the way the site does and tags each row with the filter", async () => {
  const t = fakeTransport(eventList({ scheduled: ["d1", "d2", "d3"] }));
  const rows = await client(t).campaigns("scheduled");
  assert.deepEqual(rows, [
    { dropsIdx: "d1", title: "Td1", filter: "scheduled" },
    { dropsIdx: "d2", title: "Td2", filter: "scheduled" },
    { dropsIdx: "d3", title: "Td3", filter: "scheduled" },
  ]);
  assert.equal(t.calls.length, 1, "SOOP's count says the list is complete: no second request");
  assert.deepEqual(JSON.parse(t.calls[0].body), { filter: "scheduled", gameIdx: "all", pageNo: 1, prePageNo: 200 });
  const [req] = t.calls;
  assert.equal(req.url, "https://drops.sooplive.com/api/get_drops_event_list.php");
  assert.equal(req.method, "POST");
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers.origin, "https://drops.sooplive.com");
  assert.match(req.headers.referer, /^https:\/\/drops\.sooplive\.com\//);
});

// 2026-10-13: the reader sent the page number as the page size too. SOOP
// answered with rows 0, 2-3 and 6-8 of its ten running campaigns; the Overwatch
// one sat at row 4, so the farm took it for delisted.
test("campaigns() returns every row of SOOP's list, in SOOP's order", async () => {
  for (const n of [1, 10, 62, 200]) {
    const all = ids(n);
    const t = fakeTransport(eventList({ progress: all }));
    const rows = await client(t).campaigns("progress");
    assert.deepEqual(rows.map((r) => r.dropsIdx), all, `${n} campaigns`);
    assert.equal(t.calls.length, 1, `${n} campaigns: one request`);
  }
});

test("campaigns() goes on to the next page until SOOP's count is reached", async () => {
  const all = ids(450);
  const t = fakeTransport(eventList({ progress: all }));
  const rows = await client(t).campaigns();
  assert.deepEqual(rows.map((r) => r.dropsIdx), all);
  assert.deepEqual(
    t.calls.map((c) => JSON.parse(c.body)),
    [1, 2, 3].map((pageNo) => ({ filter: "progress", gameIdx: "all", pageNo, prePageNo: 200 })),
  );
  // The count may arrive as a string, and a row listed on two pages (the list
  // moved between the reads) is one campaign: the count is of campaigns.
  const pages = [["a", "b"], ["b", "c"], ["x"]];
  const moved = fakeTransport((url, opt, n) => ({ result: 1, totalCount: "3", data: pages[n - 1].map((dropsIdx) => ({ dropsIdx })) }));
  assert.deepEqual((await client(moved).campaigns()).map((r) => r.dropsIdx), ["a", "b", "c"]);
  assert.equal(moved.calls.length, 2);
  // Two rows read are not two campaigns read: the second campaign is on the next page.
  const twice = [["a", "a"], ["b"]];
  const dup = fakeTransport((url, opt, n) => ({ result: 1, totalCount: 2, data: (twice[n - 1] || []).map((dropsIdx) => ({ dropsIdx })) }));
  assert.deepEqual((await client(dup).campaigns()).map((r) => r.dropsIdx), ["a", "b"]);
  assert.equal(dup.calls.length, 2);
});

// "Not in the list" is acted on as "SOOP delisted it", so a list that is known
// to be incomplete must never be handed back as if it were the list.
test("campaigns() refuses a read that falls short of SOOP's own count", async () => {
  const short = { code: "API", message: /came back short: \d+ of \d+/ };
  // the count says ten, the data is missing or is not a list
  for (const data of [null, {}, []]) {
    await assert.rejects(client(fakeTransport(() => ({ result: 1, totalCount: 10, data }))).campaigns(), short);
  }
  // five rows, then nothing, of ten
  const half = fakeTransport((url, opt, n) => ({ result: 1, totalCount: 10, data: n === 1 ? ids(5).map((dropsIdx) => ({ dropsIdx })) : [] }));
  await assert.rejects(client(half).campaigns(), { code: "API", message: /5 of 10/ });
  assert.equal(half.calls.length, 2);
  // a server that ignores the page number: the same 200 rows for ever, of 300
  const stuck = fakeTransport(() => ({ result: 1, totalCount: 300, data: ids(200).map((dropsIdx) => ({ dropsIdx })) }));
  await assert.rejects(client(stuck).campaigns(), { code: "API", message: /200 of 300/ });
  assert.equal(stuck.calls.length, 10, "it stops at the page cap");
  // the same campaign listed twice is not a short read: every row SOOP counts was handed over
  const twin = fakeTransport((url, opt, n) => ({ result: 1, totalCount: 3, data: n === 1 ? [{ dropsIdx: "a" }, { dropsIdx: "a" }, { dropsIdx: "b" }] : [] }));
  assert.deepEqual((await client(twin).campaigns()).map((r) => r.dropsIdx), ["a", "b"]);
  // …also when that only shows on the last page the cap allows (nine full pages, one row twice, then nothing)
  const nine = fakeTransport((url, opt, n) => ({
    result: 1,
    totalCount: 1800,
    data: n <= 9 ? ids(200, `p${n}-`).map((dropsIdx, i) => ({ dropsIdx: n === 9 && i === 199 ? "p1-0" : dropsIdx })) : [],
  }));
  assert.equal((await client(nine).campaigns()).length, 1799);
  assert.equal(nine.calls.length, 10);
  // a row that is not a row is passed over; it does not cost the list
  const junk = fakeTransport((url, opt, n) => ({ result: 1, totalCount: 3, data: n === 1 ? [{ dropsIdx: "a" }, null, { dropsIdx: "b" }] : [] }));
  assert.deepEqual((await client(junk).campaigns()).map((r) => r.dropsIdx), ["a", "b"]);
  // a row keeps the filter SOOP gave it; only an untagged row takes the list's name
  const own = fakeTransport(() => ({ result: 1, totalCount: 2, data: [{ dropsIdx: "a", filter: "scheduled" }, { dropsIdx: "b" }] }));
  assert.deepEqual((await client(own).campaigns("progress")).map((r) => r.filter), ["scheduled", "progress"]);
});

test("campaigns() without a count from SOOP ends at the first empty page", async () => {
  const all = ids(10);
  const t = fakeTransport(eventList({ scheduled: all }, { count: false }));
  const rows = await client(t).campaigns("scheduled");
  assert.deepEqual(rows.map((r) => r.dropsIdx), all);
  assert.deepEqual(t.calls.map((c) => JSON.parse(c.body).pageNo), [1, 2]);
  // Nothing listed is what SOOP sends for it (measured 2026-10-13): an empty
  // array and a count of "0". A reply with no list in it is not that.
  const none = fakeTransport(() => ({ result: 1, message: "SUCCESS", totalCount: "0", data: [] }));
  assert.deepEqual(await client(none).campaigns(), []);
  assert.equal(none.calls.length, 1);
  for (const data of [null, {}, undefined, "x"]) {
    const noList = fakeTransport(() => ({ result: 1, totalCount: "0", data }));
    await assert.rejects(client(noList).campaigns(), { code: "API", message: /came back short/ });
    assert.equal(noList.calls.length, 1);
  }
  // A page that carries no count does not undo the count of the page before it.
  const lost = fakeTransport((url, opt, n) => ({ result: 1, ...(n === 1 ? { totalCount: 300 } : {}), data: ids(n === 1 ? 200 : 100, `p${n}-`).map((dropsIdx) => ({ dropsIdx })) }));
  assert.equal((await client(lost).campaigns()).length, 300);
  assert.equal(lost.calls.length, 2, "the count of 300 still ends the read");
});

test("campaigns() defaults to progress and stops at the 10-page cap", async () => {
  // Full pages for ever and no count: the cap is what ends the read.
  const t = fakeTransport((url, opt, n) => ({ result: 1, data: ids(200, `p${n}-`).map((dropsIdx) => ({ dropsIdx })) }));
  const rows = await client(t).campaigns();
  assert.equal(t.calls.length, 10);
  assert.equal(rows.length, 2000);
  assert.equal(rows[0].filter, "progress");
});

test("campaignsAll() merges progress and scheduled without duplicates", async () => {
  const t = fakeTransport(eventList({ progress: ["a", "b"], scheduled: ["b", "c"] }));
  const rows = await client(t).campaignsAll();
  assert.deepEqual(rows.map((r) => r.dropsIdx), ["a", "b", "c"]);
  assert.equal(rows.find((r) => r.dropsIdx === "c").filter, "scheduled");
  assert.deepEqual(t.calls.map((c) => JSON.parse(c.body).filter), ["progress", "scheduled"], "one request a list");
});

test("campaignsAll() keeps one list when the other fails, names the one it could not read, and rethrows when both fail", async () => {
  const lists = eventList({ progress: ["a"], scheduled: ["s"] });
  const failing = (bad) =>
    fakeTransport((url, opt) => (JSON.parse(opt.body).filter === bad ? { result: 0, message: "busy" } : lists(url, opt)));
  const whole = await client(fakeTransport(lists)).campaignsAll();
  assert.deepEqual(whole.map((r) => r.dropsIdx), ["a", "s"]);
  assert.equal(whole.unread, undefined, "both lists were read");

  const noScheduled = await client(failing("scheduled")).campaignsAll();
  assert.deepEqual(noScheduled.map((r) => r.dropsIdx), ["a"]);
  assert.deepEqual(noScheduled.unread, ["scheduled"]);
  // The running list is the one that matters most: its campaigns are not in
  // the rows, and the result says why — it does not say they are gone.
  const noProgress = await client(failing("progress")).campaignsAll();
  assert.deepEqual(noProgress.map((r) => r.dropsIdx), ["s"]);
  assert.deepEqual(noProgress.unread, ["progress"]);
  assert.ok(Array.isArray(noProgress), "still a plain list of rows");
  assert.match(noProgress.unreadWhy, /^progress: busy$/, "and why, for the log");
  // A list that came back short of its own count was not read whole either:
  // it is named, and the rows it did hand over are not thrown away.
  const shortProgress = fakeTransport((url, opt) =>
    JSON.parse(opt.body).filter === "progress" ? { result: 1, totalCount: 4, data: [{ dropsIdx: "a" }] } : lists(url, opt),
  );
  const partial = await client(shortProgress).campaignsAll();
  assert.deepEqual(partial.map((r) => `${r.dropsIdx}:${r.filter}`), ["a:progress", "s:scheduled"]);
  assert.deepEqual(partial.unread, ["progress"]);
  assert.equal(partial.unreadWhy, "progress: 1 of 4 campaigns handed over");
  // Neither list handed over anything it could vouch for: nothing to act on, and both are named.
  const noLists = await client(fakeTransport(() => ({ result: 1, data: null }))).campaignsAll();
  assert.deepEqual([...noLists], []);
  assert.deepEqual(noLists.unread, ["progress", "scheduled"]);

  const dead = fakeTransport(() => ({ result: -1, message: "login" }));
  await assert.rejects(client(dead).campaignsAll(), { code: "AUTH" });
});

test("missions() returns normalised missions", async () => {
  const t = fakeTransport(() => ({
    result: 1,
    data: [{ dropsIdx: 77, itemList: [{ itemName: "Skin", giveTerm: "60", viewTime: "12" }] }],
  }));
  const [m] = await client(t).missions();
  assert.equal(m.dropsIdx, "77");
  assert.equal(m.minutes, 12);
  assert.equal(m.items[0].minutes, 60);
});

test("inventoryCounts() returns numbers and inventory() pages to totalCount", async () => {
  const counts = fakeTransport(() => ({ result: 1, data: { available: "3", acquired: 2 } }));
  assert.deepEqual(await client(counts).inventoryCounts(), { available: 3, acquired: 2, expired: 0 });
  assert.equal(counts.calls[0].headers.referer, "https://drops.sooplive.com/inventory");

  const page = (n) => Array.from({ length: n }, (_, i) => ({ itemName: `i${i}` }));
  const t = fakeTransport((url, opt, n) => ({ result: 1, totalCount: "25", data: n === 1 ? page(20) : page(5) }));
  const rows = await client(t).inventory("available");
  assert.equal(rows.length, 25);
  assert.equal(t.calls.length, 2);
  assert.deepEqual(JSON.parse(t.calls[1].body), { pageNo: 2, prePageNo: 20, division: "available" });
  assert.equal(t.calls[1].url, "https://drops.sooplive.com/api/get_drops_list.php");
  assert.equal(t.calls[1].headers.origin, "https://drops.sooplive.com");
});

test("categoryChannels() returns the top channel ids up to the limit", async () => {
  const t = fakeTransport(() => ({
    broad: [{ user_id: "a" }, { user_id: "b" }, { user_id: "a" }, {}, { user_id: "c" }],
  }));
  assert.deepEqual(await client(t).categoryChannels("0004 19", 2), ["a", "b"]);
  assert.match(t.calls[0].url, /selectType=cate&selectValue=0004%2019&orderType=view_cnt&pageNo=1$/);
  assert.deepEqual(await client(t).categoryChannels("1"), ["a", "b", "c"]);
  assert.deepEqual(await client(fakeTransport(() => ({}))).categoryChannels("1"), []);
});

test("parseCookieInput accepts a JSON export, a name:value object and a raw header", () => {
  const want = [
    { name: "AuthTicket", value: "x=1" },
    { name: "_au", value: "u" },
  ];
  assert.deepEqual(
    parseCookieInput('[{"name":"AuthTicket","value":"x=1","domain":".sooplive.com"},{"name":"_au","value":"u"}]'),
    want,
  );
  assert.deepEqual(parseCookieInput('{"AuthTicket":"x=1","_au":"u"}'), want);
  assert.deepEqual(parseCookieInput(" AuthTicket=x=1; _au=u\n"), want);
  assert.throws(() => parseCookieInput("  "), /empty cookie input/);
  // a parse failure must not echo the pasted text back
  assert.throws(
    () => parseCookieInput('[{"name":"AuthTicket","value":"SECRETVALUE"'),
    (e) => !/SECRETVALUE|AuthTicket/.test(e.message),
  );
});

test("splitCookieExports splits concatenated JSON arrays", () => {
  const a = '[{"name":"AuthTicket","value":"one]["},{"name":"_au","value":"u1"}]';
  const b = '[\n  {"name":"AuthTicket","value":"two \\" ]"}\n]';
  assert.deepEqual(splitCookieExports(`${a}${b}`), [a, b]);
  assert.deepEqual(splitCookieExports(`${a}\n,\n\n${b}\n`), [a, b]);
  for (const part of splitCookieExports(`${a}\n${b}`)) {
    assert.equal(parseCookieInput(part)[0].name, "AuthTicket");
  }
});

test("splitCookieExports splits AuthTicket lines, alone or mixed with JSON", () => {
  assert.deepEqual(splitCookieExports("AuthTicket=one\n\nAuthTicket=two; _au=u2\r\n  AuthTicket=three  "), [
    "AuthTicket=one",
    "AuthTicket=two; _au=u2",
    "AuthTicket=three",
  ]);
  const json = '[{"name":"AuthTicket","value":"j"}]';
  assert.deepEqual(splitCookieExports(`AuthTicket=one\n${json}\nAuthTicket=two`), [
    "AuthTicket=one",
    json,
    "AuthTicket=two",
  ]);
  // a bracket inside a header value does not start a JSON export
  assert.deepEqual(splitCookieExports("AuthTicket=a[b]\nAuthTicket=c"), ["AuthTicket=a[b]", "AuthTicket=c"]);
});

test("splitCookieExports returns a single export as one entry", () => {
  const json = '[{"name":"AuthTicket","value":"j"},{"name":"_au","value":"u"}]';
  assert.deepEqual(splitCookieExports(json), [json]);
  assert.deepEqual(splitCookieExports("AuthTicket=one; _au=u"), ["AuthTicket=one; _au=u"]);
  // a header pasted one cookie per line is still one account
  assert.deepEqual(splitCookieExports("_au=u\nAuthTicket=one\nfoo=bar"), ["_au=u\nAuthTicket=one\nfoo=bar"]);
  // nothing recognisable: hand it back whole so the caller reports one bad entry
  assert.deepEqual(splitCookieExports("garbage"), ["garbage"]);
  assert.deepEqual(splitCookieExports("  \n"), []);
});

test("makeClient refuses a cookie set without AuthTicket and never exposes cookies", () => {
  const t = fakeTransport();
  assert.throws(() => makeClient([{ name: "_au", value: "u" }], { transport: t, geo: fakeGeo() }), {
    code: "AUTH",
    message: /no AuthTicket/,
  });
  assert.throws(() => makeClient(null, { transport: t, geo: fakeGeo() }), { code: "AUTH" });
  const c = client(t);
  assert.equal(c.id, "acc1");
  assert.equal(
    Object.keys(c).sort().join(" "),
    "campaigns campaignsAll categoryChannels id inventory inventoryCounts liveInfo missions openBridge privateInfo useInfo",
  );
  assert.ok(!JSON.stringify(c).includes(TICKET));
  assert.equal(makeClient(COOKIES, { transport: t, geo: fakeGeo() }).id, null);
});

test("sharedGeo returns one resolver per process", () => {
  assert.equal(sharedGeo(), sharedGeo());
  assert.equal(typeof sharedGeo().get, "function");
});

test("openBridge joins with the resolver's country and completes the handshake", async () => {
  const agent = { fake: "agent" };
  const transport = fakeTransport(() => privateReply, { wsOptions: () => ({ agent }) });
  const { WS, ws, state, events, geo } = bridge({ transport });
  assert.equal(WS.instances.length, 1);
  assert.equal(ws.url, "wss://bridge.sooplive.com/Websocket");
  assert.deepEqual(ws.protocols, ["bridge"]);
  assert.deepEqual(ws.options.headers, { "user-agent": UA, origin: "https://play.sooplive.com" });
  assert.equal(ws.options.agent, agent);
  assert.deepEqual([state.joined, state.closed, state.error], [false, false, null]);
  assert.equal(ws.sent.length, 0);

  ws.open();
  await settle();
  assert.equal(geo.calls, 1);
  assert.equal(ws.sent.length, 1);
  const gw = ws.sent[0];
  assert.equal(gw.SVC, "INIT_GW");
  assert.equal(gw.RESULT, 0);
  const { guid, JOINLOG, ...rest } = gw.DATA;
  assert.match(guid, /^[0-9A-F]{32}$/);
  // prettier-ignore
  assert.deepEqual(rest, {
    gate_ip: "1.2.3.4", gate_port: 8001, broadno: 555, category: "00040019", fanticket: "ftk",
    cookie: TICKET, cli_type: 44, cc_cli_type: 19, QUALITY: "ori", BJID: "streamer1",
    addinfo: "ad_lang\u0011en\u0012is_auto\u00110\u0012", update_info: 0,
  });
  // country from SOOP's own answer (via the resolver), numerics from the resolver
  assert.equal(field(JOINLOG, "geo_cc"), "LK");
  assert.equal(field(JOINLOG, "join_cc"), "144");
  assert.equal(field(JOINLOG, "geo_rc"), "07");
  // the verified-live JOINLOG, byte for byte
  const S = "\u0006";
  const pair = (k, v) => `${S}&${S}${k}${S}=${S}${v}`;
  const pairs = (text) => text.split(" ").map((p) => pair(...p.split("="))).join("");
  const head =
    "log\u0011" +
    pairs(
      "uuid=aaaabbbbccccdddd geo_cc=LK geo_rc=07 acpt_lang=en_US svc_lang=en_US is_iframeapi=false " +
        "content_lang=ko_KR join_cc=144 os=mac is_streamer=false is_rejoin=false is_auto=false " +
        "is_support_adaptive=true uuid_3rd=aaaabbbbccccdddd subscribe=0 player_mode=landing sub_view_type=non_sub",
    );
  const tail =
    "\u0012liveualog\u0011" + pairs("is_clearmode=false lowlatency=0 is_streamer=false os=mac") + "\u0012";
  assert.equal(JOINLOG, head + tail);

  ws.receive({ SVC: "FLASH_LOGIN", RESULT: 0, DATA: {} });
  ws.emit("message", Buffer.from("not json"));
  assert.equal(ws.sent.length, 1);
  ws.receive({ SVC: "CERTTICKETEX", RESULT: 0, DATA: { pcTicket: "tk", pcAppendDat: "ad" } });
  assert.equal(ws.sent.length, 2);
  const broad = ws.sent[1];
  assert.equal(broad.SVC, "INIT_BROAD");
  const { JOINLOG: broadLog, ...broadRest } = broad.DATA;
  // prettier-ignore
  assert.deepEqual(broadRest, {
    center_ip: "5.6.7.8", center_port: 9001, passwd: "", cli_type: 44, cc_cli_type: 19,
    QUALITY: "ori", guid, gw_ticket: "tk", append_data: "ad",
  });
  assert.equal(broadLog, head + pair("path1", "etc") + pair("is_embed", "false") + tail);

  assert.equal(state.joined, false);
  ws.receive({ SVC: "JOINCH_COMMON", RESULT: 0, DATA: {} });
  assert.equal(state.joined, true);
  ws.receive({ SVC: "CLOSEBROAD", RESULT: 0, DATA: {} });
  assert.deepEqual(events, ["open", "joined", "server-close:CLOSEBROAD"]);

  state.stop();
  assert.equal(state.closed, true);
  assert.equal(state.error, null);
  assert.equal(events.at(-1), "closed");
});

test("a geo failure sets error 'geo', closes the socket and never joins", async () => {
  const { ws, state, events } = bridge({ geo: fakeGeo({ fail: true }) });
  ws.open();
  await settle();
  assert.equal(state.error, "geo");
  assert.equal(state.closed, true);
  assert.equal(state.joined, false);
  assert.equal(ws.closeCalls, 1);
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(events, ["open", "error:geo", "closed"]);
  // a late ticket from the server must not be answered either
  ws.readyState = 1;
  ws.receive({ SVC: "CERTTICKETEX", DATA: { pcTicket: "tk" } });
  assert.deepEqual(ws.sent, []);
});

test("a wsOptions() throw gives error 'egress' and opens no socket", () => {
  const transport = fakeTransport(() => privateReply, {
    wsOptions: () => {
      throw new SoopError("proxy down", { code: "EGRESS" });
    },
  });
  const { WS, state } = bridge({ transport });
  assert.equal(WS.instances.length, 0);
  assert.equal(state.error, "egress");
  assert.equal(state.closed, true);
  assert.equal(state.joined, false);
  assert.doesNotThrow(() => state.stop());
  assert.equal(transport.calls.length, 0);
});

test("stopping before the country is known sends nothing", async () => {
  const { ws, state } = bridge();
  ws.close = () => {}; // a socket that still looks open after stop()
  ws.open();
  state.stop();
  await settle();
  assert.equal(ws.readyState, 1);
  assert.deepEqual(ws.sent, []);
});

test("with the real geo resolver the claim follows SOOP's own country answer", async () => {
  const env = {}; // no SOOP_GEO_* overrides
  const ok = bridge({ geo: createGeoResolver({ env }) });
  ok.ws.open();
  await settle();
  const log = ok.ws.sent[0].DATA.JOINLOG;
  assert.equal(field(log, "geo_cc"), "LK");
  assert.equal(field(log, "join_cc"), "144");
  assert.equal(field(log, "geo_rc"), "13");
  assert.equal(ok.transport.calls[0].url, "https://afevent2.sooplive.com/api/get_private_info.php");
  ok.state.stop();

  // SOOP names no country: the resolver refuses, so the bridge must not join
  const blind = bridge({
    transport: fakeTransport(() => ({ CHANNEL: { IS_LOGIN: 1 } })),
    geo: createGeoResolver({ env }),
  });
  blind.ws.open();
  await settle();
  assert.equal(blind.state.error, "geo");
  assert.equal(blind.state.closed, true);
  assert.deepEqual(blind.ws.sent, []);
});

test("a socket error is reported and a throwing listener cannot break the bridge", async () => {
  const seen = [];
  const { ws, state } = bridge({
    onEvent: (ev) => {
      seen.push(ev);
      throw new Error("listener bug");
    },
  });
  ws.open();
  await settle();
  assert.equal(ws.sent[0].SVC, "INIT_GW");
  ws.emit("error", new Error("socket hang up"));
  assert.equal(state.error, "socket");
  ws.receive({ SVC: "CERTTICKETEX" }); // no DATA: must not throw
  assert.equal(ws.sent[1].SVC, "INIT_BROAD");
  assert.deepEqual(seen, ["open", "error:socket hang up"]);
  state.stop();
});

// Swaps the global interval functions for recorders until the test ends.
function fakeIntervals(t) {
  const real = { setInterval: global.setInterval, clearInterval: global.clearInterval };
  const timers = [];
  global.setInterval = (fn, ms) => timers[timers.push({ fn, ms, cleared: false }) - 1];
  global.clearInterval = (timer) => {
    if (timer) timer.cleared = true;
  };
  t.after(() => Object.assign(global, real));
  return timers;
}

test("stop() twice does not throw and clears the keepalive timer", async (t) => {
  const timers = fakeIntervals(t);
  const { ws, state } = bridge();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 20000);
  ws.open();
  await settle();
  timers[0].fn();
  assert.deepEqual(ws.sent.at(-1), { SVC: "KEEPALIVE", RESULT: 0, DATA: {} });
  assert.equal(timers[0].cleared, false);

  // a close() that throws must stay inside stop()
  ws.close = () => {
    ws.closeCalls++;
    throw new Error("already dead");
  };
  assert.doesNotThrow(() => state.stop());
  assert.doesNotThrow(() => state.stop());
  assert.equal(timers[0].cleared, true);
  assert.equal(ws.closeCalls, 2);
});

test("the keepalive timer is also cleared when the server closes the socket", (t) => {
  const timers = fakeIntervals(t);
  const { ws, state } = bridge();
  ws.readyState = 3;
  ws.emit("close");
  assert.equal(state.closed, true);
  assert.equal(timers[0].cleared, true);
  timers[0].fn(); // a late tick on a closed socket sends nothing
  assert.deepEqual(ws.sent, []);
});

test("useInfo posts the item id to the drops site and returns SOOP's data, or says why not", async () => {
  const calls = [];
  const replies = [
    { result: 1, data: { itemCode: "ABCD-EFGH", itemType: "1", itemName: "Sun Tea Icon" } },
    { result: -1, message: "로그인 후 가능 합니다." },
    { result: 0, message: "Invalid item." },
  ];
  const transport = {
    proxied: false, ready: true, describe: () => "direct", wsOptions: () => ({}), stats: () => ({}),
    requestJson: async (url, opt) => { calls.push({ url, opt }); return replies.shift(); },
  };
  const client = makeClient([{ name: "AuthTicket", value: "t" }], { transport, geo: { get: async () => ({}) } });
  const data = await client.useInfo("12345");
  assert.equal(data.itemCode, "ABCD-EFGH");
  assert.equal(calls[0].url, "https://drops.sooplive.com/api/get_drops_use_info.php");
  assert.equal(calls[0].opt.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].opt.body), { itemCodeIdx: "12345" });
  assert.equal(calls[0].opt.headers.origin, "https://drops.sooplive.com");
  await assert.rejects(() => client.useInfo("12345"), { code: "AUTH" });
  await assert.rejects(() => client.useInfo("12345"), { code: "API", message: "Invalid item." });
});

test("categoryChannels only returns streams that carry drops, when SOOP says which do", async () => {
  const replies = [
    { broad: [{ user_id: "big", is_drops: 0 }, { user_id: "small", is_drops: 1 }, { user_id: "str", is_drops: "1" }] },
    { broad: [{ user_id: "big", is_drops: 0 }] },
    { broad: [{ user_id: "legacy1" }, { user_id: "legacy2" }] },
  ];
  const transport = {
    proxied: false, ready: true, describe: () => "direct", wsOptions: () => ({}), stats: () => ({}),
    requestJson: async () => replies.shift(),
  };
  const client = makeClient([{ name: "AuthTicket", value: "t" }], { transport, geo: { get: async () => ({}) } });
  assert.deepEqual(await client.categoryChannels("00360141"), ["small", "str"], "the biggest stream is skipped when it has no drops");
  assert.deepEqual(await client.categoryChannels("00360141"), [], "no drops-enabled stream means nothing to join");
  assert.deepEqual(await client.categoryChannels("00360141"), ["legacy1", "legacy2"], "a reply without the flag is not filtered");
});
