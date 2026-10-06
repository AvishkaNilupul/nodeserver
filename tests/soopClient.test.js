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

test("campaigns() pages until an empty page and tags each row with the filter", async () => {
  const t = fakeTransport((url, opt, n) => ({
    result: 1,
    data: n <= 3 ? [{ dropsIdx: `d${n}`, title: `T${n}` }] : [],
  }));
  const rows = await client(t).campaigns("scheduled");
  assert.deepEqual(rows, [
    { dropsIdx: "d1", title: "T1", filter: "scheduled" },
    { dropsIdx: "d2", title: "T2", filter: "scheduled" },
    { dropsIdx: "d3", title: "T3", filter: "scheduled" },
  ]);
  assert.equal(t.calls.length, 4);
  assert.deepEqual(
    t.calls.map((c) => JSON.parse(c.body)),
    [1, 2, 3, 4].map((p) => ({ filter: "scheduled", gameIdx: "all", prePageNo: p, pageNo: p })),
  );
  const [req] = t.calls;
  assert.equal(req.url, "https://drops.sooplive.com/api/get_drops_event_list.php");
  assert.equal(req.method, "POST");
  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.headers.origin, "https://drops.sooplive.com");
  assert.match(req.headers.referer, /^https:\/\/drops\.sooplive\.com\//);
});

test("campaigns() defaults to progress and stops at the 80-page cap", async () => {
  const t = fakeTransport((url, opt, n) => ({ result: 1, data: [{ dropsIdx: `d${n}` }] }));
  const rows = await client(t).campaigns();
  assert.equal(t.calls.length, 80);
  assert.equal(rows.length, 80);
  assert.equal(rows[0].filter, "progress");
});

test("campaignsAll() merges progress and scheduled without duplicates", async () => {
  const lists = { progress: ["a", "b"], scheduled: ["b", "c"] };
  const t = fakeTransport((url, opt) => {
    const { filter, pageNo } = JSON.parse(opt.body);
    const id = lists[filter][pageNo - 1];
    return { result: 1, data: id ? [{ dropsIdx: id }] : [] };
  });
  const rows = await client(t).campaignsAll();
  assert.deepEqual(rows.map((r) => r.dropsIdx), ["a", "b", "c"]);
  assert.equal(rows.find((r) => r.dropsIdx === "c").filter, "scheduled");
});

test("campaignsAll() keeps one list when the other fails and rethrows when both do", async () => {
  const half = fakeTransport((url, opt) => {
    const { filter, pageNo } = JSON.parse(opt.body);
    if (filter === "scheduled") return { result: 0, message: "busy" };
    return { result: 1, data: pageNo === 1 ? [{ dropsIdx: "a" }] : [] };
  });
  assert.deepEqual((await client(half).campaignsAll()).map((r) => r.dropsIdx), ["a"]);
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
    "campaigns campaignsAll categoryChannels id inventory inventoryCounts liveInfo missions openBridge privateInfo",
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
