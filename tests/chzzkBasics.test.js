// CHZZK basics: errors, transport, cookies and normalize
// (docs/CHZZK-FARM.md §2-§5).
//
// No network: https.request is replaced with a fake through the `request`
// option on createTransport. The failures these tests exist to prevent:
//  1. GOING DIRECT. A proxy configured but unusable must refuse every call —
//     v1 of SOOP fell back direct and would have sent every account from the
//     server IP.
//  2. COOKIE VALUES or proxy credentials leaking into error text or logs.
//  3. KST timestamps read in the server's zone (nine hours off).

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const {
  ChzzkError,
  isAuthError,
  isEgressError,
} = require("../utils/chzzk/errors");
const { createTransport, getTransport } = require("../utils/chzzk/http");
const {
  parseImport,
  toHeader,
  deviceIdOf,
  sameLogin,
  REQUIRED,
} = require("../utils/chzzk/cookies");
const {
  kst,
  CODE_TYPES,
  campaignFromApi,
  isFarmableReward,
  isCampaignFarmable,
  liveRow,
} = require("../utils/chzzk/normalize");

const URL_OK = "https://api.chzzk.naver.test/path?a=1";

// Replaces https.request. onRequest({ options, req, respond, body }) runs
// once the request has been end()ed; leaving it out models a server that
// never answers.
function fakeHttps(onRequest) {
  const calls = [];
  const request = (options, onResponse) => {
    const req = new EventEmitter();
    const written = [];
    req.destroyed = false;
    req.write = (chunk) => written.push(Buffer.from(chunk));
    req.destroy = () => {
      req.destroyed = true;
    };
    const respond = (status, text, { failWith } = {}) => {
      const res = new EventEmitter();
      res.statusCode = status;
      onResponse(res);
      if (text) res.emit("data", Buffer.from(text));
      if (failWith) res.emit("error", failWith);
      else res.emit("end");
    };
    const call = { options, req, respond, body: () => Buffer.concat(written) };
    req.end = () => {
      if (onRequest) setImmediate(() => onRequest(call));
    };
    calls.push(call);
    return req;
  };
  return { request, calls };
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof ChzzkError, `expected a ChzzkError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });

// ---------------------------------------------------------------- errors

test("ChzzkError carries a code, a status and a cause", () => {
  const cause = new Error("inner");
  const e = new ChzzkError("boom", { code: "API", status: 400, cause });
  assert.ok(e instanceof Error);
  assert.equal(e.name, "ChzzkError");
  assert.equal(e.message, "boom");
  assert.equal(e.code, "API");
  assert.equal(e.status, 400);
  assert.equal(e.cause, cause);
  assert.equal(new ChzzkError("bare").code, undefined);
});

test("isAuthError / isEgressError branch on the code", () => {
  const of = (code) => new ChzzkError("x", { code });
  assert.equal(isAuthError(of("AUTH")), true);
  assert.equal(isAuthError(of("EGRESS")), false);
  assert.equal(isEgressError(of("EGRESS")), true);
  assert.equal(isEgressError(of("TIMEOUT")), true);
  assert.equal(isEgressError(of("HTTP")), false);
  assert.equal(isEgressError(of("AUTH")), false);
  assert.equal(isAuthError(null), false);
  assert.equal(isEgressError(undefined), false);
});

// ------------------------------------------------------------- transport

test("no egress configured: describe 'none', every call rejects EGRESS", async () => {
  const tr = createTransport({ proxyUrl: "", direct: false });
  assert.equal(tr.proxied, false);
  assert.equal(tr.ready, false);
  assert.equal(tr.describe(), "none");
  const err = await tr.request(URL_OK).catch((e) => e);
  assert.ok(err instanceof ChzzkError);
  assert.equal(err.code, "EGRESS");
  assert.match(err.message, /No egress configured/);
  assert.match(err.message, /CHZZK_PROXY_URL/);
  assert.match(err.message, /CHZZK_DIRECT=1/);
  const s = tr.stats();
  assert.equal(s.requests, 1);
  assert.equal(s.failures, 1);
  assert.equal(s.lastOkAt, null);
  assert.match(s.lastError, /^EGRESS: /);
});

test("direct transport: no agent, parses JSON, returns {status,json,text}", async () => {
  const { request, calls } = fakeHttps(({ respond }) =>
    respond(200, '{"result":1,"data":"é"}'),
  );
  const tr = createTransport({ proxyUrl: "", direct: true, request });
  assert.equal(tr.proxied, false);
  assert.equal(tr.ready, true);
  assert.equal(tr.describe(), "direct");

  const out = await tr.request(URL_OK, {
    headers: { Cookie: "a=b", skip: null },
  });
  assert.equal(out.status, 200);
  assert.deepEqual(out.json, { result: 1, data: "é" });
  assert.equal(out.text, '{"result":1,"data":"é"}');

  assert.equal(calls.length, 1);
  const { options } = calls[0];
  assert.equal(options.host, "api.chzzk.naver.test");
  assert.equal(options.port, 443);
  assert.equal(options.path, "/path?a=1");
  assert.equal(options.method, "GET");
  assert.equal("agent" in options, false);
  assert.deepEqual(options.headers, { cookie: "a=b" });
  assert.equal(calls[0].body().length, 0);

  const s = tr.stats();
  assert.equal(s.requests, 1);
  assert.equal(s.failures, 0);
  assert.equal(typeof s.lastOkAt, "number");
  assert.equal(s.lastError, null);
});

test("proxied transport: the built agent is attached to every request", async () => {
  const { request, calls } = fakeHttps(({ respond }) => respond(200, "{}"));
  const agent = { fake: "agent" };
  const seen = [];
  const tr = createTransport({
    proxyUrl: "socks5h://127.0.0.1:1080",
    agentFactory: (u) => {
      seen.push(u);
      return agent;
    },
    request,
  });
  assert.equal(tr.proxied, true);
  assert.equal(tr.ready, true);
  assert.deepEqual(seen, ["socks5h://127.0.0.1:1080"]);
  assert.equal(tr.describe(), "socks5h://127.0.0.1:1080");

  await tr.request(URL_OK);
  await tr.request(URL_OK);
  assert.equal(calls[0].options.agent, agent);
  assert.equal(calls[1].options.agent, agent);
  assert.equal(seen.length, 1, "one agent per transport, not per request");
});

test("fails closed: proxy set but no agent -> EGRESS, never a direct call", async (t) => {
  const { request, calls } = fakeHttps(({ respond }) => respond(200, "{}"));
  const logged = t.mock.method(console, "error", () => {});
  const proxyUrl = "socks5h://chzzkuser:s3cr3t-pw@10.0.0.9:1080";

  const thrown = createTransport({
    proxyUrl,
    agentFactory: (u) => {
      throw new Error(`cannot build agent for ${u}`);
    },
    request,
  });
  const empty = createTransport({
    proxyUrl,
    agentFactory: () => null,
    request,
  });

  for (const tr of [thrown, empty]) {
    assert.equal(tr.proxied, true);
    assert.equal(tr.ready, false);
    await rejectsWith(tr.request(URL_OK), "EGRESS");
    await rejectsWith(
      tr.request(URL_OK, { method: "POST", body: { k: 1 } }),
      "EGRESS",
    );
    const s = tr.stats();
    assert.equal(s.requests, 2);
    assert.equal(s.failures, 2);
    assert.equal(s.lastOkAt, null);
    assert.match(s.lastError, /^EGRESS: /);
  }
  assert.equal(calls.length, 0, "no request may leave the process");

  const err = await thrown.request(URL_OK).catch((e) => e);
  const everything = [
    ...logged.mock.calls.map((c) => c.arguments.join(" ")),
    err.message,
    thrown.stats().lastError,
    thrown.describe(),
  ].join("\n");
  assert.ok(logged.mock.calls.length >= 2);
  assert.ok(!everything.includes("chzzkuser"), everything);
  assert.ok(!everything.includes("s3cr3t-pw"), everything);
});

test("empty body: status returned, json null, not a failure", async () => {
  const { request } = fakeHttps(({ respond }) => respond(204, ""));
  const tr = createTransport({ direct: true, request });
  const out = await tr.request(URL_OK);
  assert.equal(out.status, 204);
  assert.equal(out.json, null);
  assert.equal(out.text, "");
  assert.equal(tr.stats().failures, 0);
});

test("non-JSON reply: status + text returned, json null, not a failure", async () => {
  const html = `<html>${"x".repeat(400)}</html>`;
  const { request } = fakeHttps(({ respond }) => respond(502, html));
  const tr = createTransport({ direct: true, request });
  const out = await tr.request(URL_OK);
  assert.equal(out.status, 502);
  assert.equal(out.json, null);
  assert.equal(out.text, html);
  assert.equal(tr.stats().failures, 0);
});

test("object body -> JSON; string/Buffer sent as-is; caller content-type kept", async () => {
  const { request, calls } = fakeHttps(({ respond }) => respond(200, "{}"));
  const tr = createTransport({ direct: true, request });

  await tr.request(URL_OK, { method: "POST", body: { title: "결승전" } });
  const asJson = JSON.stringify({ title: "결승전" });
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-type"], "application/json");
  assert.equal(
    calls[0].options.headers["content-length"],
    Buffer.byteLength(asJson),
  );
  assert.equal(calls[0].body().toString(), asJson);
  // 결승전 is multi-byte; content-length is bytes, not characters.
  assert.notEqual(Buffer.byteLength(asJson), asJson.length);

  await tr.request(URL_OK, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "Content-Length": 1 },
    body: "hello",
  });
  assert.equal(calls[1].options.headers["content-type"], "text/plain");
  assert.equal(calls[1].options.headers["content-length"], 5);
  assert.equal("Content-Length" in calls[1].options.headers, false);
  assert.equal(calls[1].body().toString(), "hello");

  const buf = Buffer.from([1, 2, 3]);
  await tr.request(URL_OK, { method: "POST", body: buf });
  assert.equal(calls[2].options.headers["content-length"], 3);
  assert.deepEqual(calls[2].body(), buf);

  await tr.request(URL_OK);
  assert.equal("content-length" in calls[3].options.headers, false);
});

test("socket error -> EGRESS; timeout -> TIMEOUT and the request is destroyed", async () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });
  const { request, calls } = fakeHttps(({ req }) => req.emit("error", refused));
  const tr = createTransport({ direct: true, request });
  const err = await tr.request(URL_OK).catch((e) => e);
  assert.ok(err instanceof ChzzkError);
  assert.equal(err.code, "EGRESS");
  assert.equal(err.cause, refused);
  assert.match(err.message, /ECONNREFUSED/);
  assert.equal(calls.length, 1);

  const silent = fakeHttps(); // never answers
  const tr2 = createTransport({ direct: true, request: silent.request });
  const terr = await tr2.request(URL_OK, { timeoutMs: 15 }).catch((e) => e);
  assert.equal(terr.code, "TIMEOUT");
  assert.equal(isEgressError(terr), true);
  assert.equal(silent.calls[0].req.destroyed, true);
  const s = tr2.stats();
  assert.equal(s.requests, 1);
  assert.equal(s.failures, 1);
  assert.match(s.lastError, /^TIMEOUT: /);
});

test("proxy URL error text that echoes credentials is scrubbed", async (t) => {
  const proxyUrl = "socks5h://chzzkuser:p%40ss%3Aword@127.0.0.1:1080";
  const { request } = fakeHttps(({ req }) =>
    req.emit(
      "error",
      new Error(`Socks5 Authentication failed for ${proxyUrl} (p@ss:word)`),
    ),
  );
  t.mock.method(console, "error", () => {});
  const tr = createTransport({
    proxyUrl,
    agentFactory: () => ({}),
    request,
  });
  const err = await tr.request(URL_OK).catch((e) => e);
  assert.equal(err.code, "EGRESS");
  const haystack = [err.message, tr.stats().lastError].join("\n");
  for (const secret of ["chzzkuser", "p%40ss", "p@ss:word"]) {
    assert.ok(!haystack.includes(secret), haystack);
  }
});

test("describe() never shows proxy credentials", (t) => {
  t.mock.method(console, "error", () => {});
  const agentFactory = () => ({});
  const cases = [
    ["socks5h://chzzkuser:s3cr3t-pw@127.0.0.1:1080", "socks5h://127.0.0.1:1080"],
    [
      "socks5://user:p%40ss%3Aword@tunnel.example.test:9050/",
      "socks5://tunnel.example.test:9050",
    ],
    ["socks5h://tokenonly@10.1.2.3:1080", "socks5h://10.1.2.3:1080"],
    ["socks5h://127.0.0.1:1080", "socks5h://127.0.0.1:1080"],
  ];
  for (const [proxyUrl, want] of cases) {
    const got = createTransport({ proxyUrl, agentFactory }).describe();
    assert.equal(got, want);
    for (const secret of ["chzzkuser", "s3cr3t-pw", "p%40ss", "p@ss", "tokenonly"]) {
      assert.ok(!got.includes(secret), `${got} leaks ${secret}`);
    }
  }
});

test("getTransport() is a lazy singleton", (t) => {
  t.mock.method(console, "error", () => {});
  const a = getTransport();
  const b = getTransport();
  assert.equal(a, b);
  assert.equal(typeof a.describe(), "string");
  assert.equal(typeof a.ready, "boolean");
  assert.equal(typeof a.stats, "function");
  assert.equal(typeof a.request, "function");
});

// --------------------------------------------------------------- cookies

test("REQUIRED is NID_AUT and NID_SES", () => {
  assert.deepEqual(REQUIRED, ["NID_AUT", "NID_SES"]);
});

test("parseImport: a single Cookie-Editor JSON array keeps naver cookies only", () => {
  const text = JSON.stringify([
    { name: "NID_AUT", value: "aaa", domain: ".naver.com" },
    { name: "NID_SES", value: "sss", domain: ".naver.com" },
    { name: "junk", value: "x", domain: ".other.com" },
    { name: "ba.uuid", value: "device-1", domain: ".naver.com" },
    { name: "nocrumb", value: "y", domain: "sub.naver.com" },
  ]);
  const { jars, errors } = parseImport(text);
  assert.deepEqual(errors, []);
  assert.equal(jars.length, 1);
  const names = jars[0].map((c) => c.name);
  assert.deepEqual(names, ["NID_AUT", "NID_SES", "ba.uuid", "nocrumb"]);
  assert.equal(deviceIdOf(jars[0]), "device-1");
});

test("parseImport: back-to-back JSON arrays, newlines between", () => {
  const jarA = [
    { name: "NID_AUT", value: "aaa", domain: ".naver.com" },
    { name: "NID_SES", value: "sss", domain: ".naver.com" },
  ];
  const jarB = [
    { name: "NID_AUT", value: "bbb", domain: ".naver.com" },
    { name: "NID_SES", value: "ttt", domain: ".naver.com" },
  ];
  const text = `${JSON.stringify(jarA)}\n\n${JSON.stringify(jarB)}`;
  const { jars, errors } = parseImport(text);
  assert.deepEqual(errors, []);
  assert.equal(jars.length, 2);
  assert.equal(jars[0][0].value, "aaa");
  assert.equal(jars[1][0].value, "bbb");
});

test("parseImport: a JSON array of arrays", () => {
  const text = JSON.stringify([
    [
      { name: "NID_AUT", value: "aaa", domain: ".naver.com" },
      { name: "NID_SES", value: "sss", domain: ".naver.com" },
    ],
    [
      { name: "NID_AUT", value: "bbb", domain: ".naver.com" },
      { name: "NID_SES", value: "ttt", domain: ".naver.com" },
    ],
  ]);
  const { jars, errors } = parseImport(text);
  assert.deepEqual(errors, []);
  assert.equal(jars.length, 2);
});

test("parseImport: {cookies:[...]} wrapper", () => {
  const text = JSON.stringify({
    cookies: [
      { name: "NID_AUT", value: "aaa", domain: ".naver.com" },
      { name: "NID_SES", value: "sss", domain: ".naver.com" },
    ],
  });
  const { jars, errors } = parseImport(text);
  assert.deepEqual(errors, []);
  assert.equal(jars.length, 1);
});

test("parseImport: object keyed by anything whose values are arrays or {cookies}", () => {
  const text = JSON.stringify({
    acc1: [
      { name: "NID_AUT", value: "aaa", domain: ".naver.com" },
      { name: "NID_SES", value: "sss", domain: ".naver.com" },
    ],
    acc2: {
      cookies: [
        { name: "NID_AUT", value: "bbb", domain: ".naver.com" },
        { name: "NID_SES", value: "ttt", domain: ".naver.com" },
      ],
    },
  });
  const { jars, errors } = parseImport(text);
  assert.deepEqual(errors, []);
  assert.equal(jars.length, 2);
});

test("parseImport: raw Cookie-header lines, one jar per line", () => {
  const text =
    "NID_AUT=aaa; NID_SES=sss; ba.uuid=dev1\n" +
    "   \n" +
    "NID_AUT=bbb; NID_SES=ttt";
  const { jars, errors } = parseImport(text);
  assert.deepEqual(errors, []);
  assert.equal(jars.length, 2);
  assert.equal(jars[0][0].name, "NID_AUT");
  assert.equal(jars[0][0].value, "aaa");
  assert.equal(jars[0][0].domain, "");
  assert.equal(deviceIdOf(jars[0]), "dev1");
  assert.equal(deviceIdOf(jars[1]), "");
});

test("parseImport: a jar missing NID_AUT or NID_SES is dropped with an error naming it", () => {
  const text = JSON.stringify([
    [
      { name: "NID_AUT", value: "aaa", domain: ".naver.com" },
      { name: "NID_SES", value: "sss", domain: ".naver.com" },
    ],
    [{ name: "NID_AUT", value: "logged-out-1", domain: ".naver.com" }],
    [{ name: "NID_SES", value: "logged-out-2", domain: ".naver.com" }],
  ]);
  const { jars, errors } = parseImport(text);
  assert.equal(jars.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^Jar 2 has no NID_AUT\/NID_SES/);
  assert.match(errors[1], /^Jar 3 has no NID_AUT\/NID_SES/);
  // Values never echoed back out.
  for (const e of errors) {
    assert.ok(!e.includes("logged-out-1"), e);
    assert.ok(!e.includes("logged-out-2"), e);
  }
});

test("parseImport: non-string / empty / garbage -> jars []", () => {
  for (const text of ["", "   ", null, undefined, 123, "not a cookie at all"]) {
    const { jars, errors } = parseImport(text);
    assert.ok(Array.isArray(jars));
    assert.ok(Array.isArray(errors));
    assert.equal(jars.length, 0);
  }
});

test("toHeader: name=value joined by '; ', input order kept", () => {
  const jar = [
    { name: "NID_AUT", value: "aaa", domain: ".naver.com" },
    { name: "NID_SES", value: "sss", domain: ".naver.com" },
    { name: "ba.uuid", value: "dev1", domain: ".naver.com" },
  ];
  assert.equal(toHeader(jar), "NID_AUT=aaa; NID_SES=sss; ba.uuid=dev1");
  assert.equal(toHeader(null), "");
  assert.equal(toHeader([]), "");
});

test("sameLogin: both jars have the same NID_AUT value", () => {
  const a = [{ name: "NID_AUT", value: "same" }, { name: "NID_SES", value: "x" }];
  const b = [{ name: "NID_AUT", value: "same" }, { name: "NID_SES", value: "y" }];
  const c = [{ name: "NID_AUT", value: "other" }];
  const d = [{ name: "NID_SES", value: "no auth here" }];
  assert.equal(sameLogin(a, b), true);
  assert.equal(sameLogin(a, c), false);
  assert.equal(sameLogin(a, d), false);
  assert.equal(sameLogin(d, d), false);
  assert.equal(sameLogin(null, null), false);
});

// --------------------------------------------------------------- normalize

test("kst parses KST wall-clock to UTC; rejects impossible dates", () => {
  assert.equal(
    +kst("2026-10-23 00:00:00"),
    +new Date("2026-10-22T15:00:00.000Z"),
  );
  assert.equal(
    +kst("2026-10-23T00:00:00"),
    +new Date("2026-10-22T15:00:00.000Z"),
  );
  assert.equal(+kst("2026-10-23"), +new Date("2026-10-22T15:00:00.000Z"));
  assert.equal(kst("2026-02-31 00:00:00"), null);
  assert.equal(kst("0000-00-00 00:00:00"), null);
  assert.equal(kst("not a date"), null);
  assert.equal(kst(null), null);
  assert.equal(kst(undefined), null);
  assert.equal(kst(123), null);
  // Date in: a fresh independent Date is returned.
  const d = new Date("2026-01-01T00:00:00Z");
  const out = kst(d);
  assert.equal(+out, +d);
  assert.notEqual(out, d);
  assert.equal(kst(new Date("x")), null);
});

test("CODE_TYPES: the two reward types that count as farmable codes", () => {
  assert.deepEqual(CODE_TYPES, ["CODE_FIRST_COME", "CODE_LOTTERY"]);
});

test("campaignFromApi maps raw CHZZK fields and clips the guide to 2000 chars", () => {
  const camp = campaignFromApi({
    campaignNo: 99,
    title: "KEL Finals",
    categoryType: "GAME",
    categoryId: "cat-1",
    categoryValue: "Eternal Return",
    imageUrl: "https://img/x.png",
    state: "PROMOTED",
    startDate: "2026-10-23 00:00:00",
    endDate: "2026-10-30 23:59:59",
    accountLinkUrl: null,
    description: "x".repeat(2500),
    rewardList: [
      {
        rewardNo: 1,
        title: "15m code",
        rewardType: "CODE_FIRST_COME",
        conditionForMinutes: 15,
        codeRemainingCount: 22423,
        imageUrl: null,
      },
      {
        rewardNo: 2,
        title: "lottery",
        rewardType: "CODE_LOTTERY",
        conditionForMinutes: 60,
        codeRemainingCount: null,
      },
    ],
  });
  assert.equal(camp.campaignNo, 99);
  assert.equal(camp.title, "KEL Finals");
  assert.equal(camp.state, "PROMOTED");
  assert.equal(camp.categoryType, "GAME");
  assert.equal(camp.categoryId, "cat-1");
  assert.equal(camp.categoryValue, "Eternal Return");
  assert.equal(camp.imageUrl, "https://img/x.png");
  assert.equal(+camp.startAt, +new Date("2026-10-22T15:00:00.000Z"));
  assert.equal(+camp.endAt, +new Date("2026-10-30T14:59:59.000Z"));
  assert.equal(camp.needsLink, false);
  assert.equal(camp.guide.length, 2000);
  assert.equal(camp.rewards.length, 2);
  assert.deepEqual(camp.rewards[0], {
    rewardNo: 1,
    title: "15m code",
    rewardType: "CODE_FIRST_COME",
    minutes: 15,
    remaining: 22423,
    imageUrl: null,
  });
  assert.equal(camp.rewards[1].remaining, null);
});

test("campaignFromApi: needsLink is true for any of accountLinkUrl / providerId / externalProvider", () => {
  assert.equal(campaignFromApi({ accountLinkUrl: "http://x" }).needsLink, true);
  assert.equal(campaignFromApi({ providerId: "abc" }).needsLink, true);
  assert.equal(campaignFromApi({ externalProvider: "x" }).needsLink, true);
  assert.equal(campaignFromApi({}).needsLink, false);
  assert.equal(campaignFromApi({ accountLinkUrl: "" }).needsLink, false);
});

test("isFarmableReward: FIRST_COME when remaining !== 0; LOTTERY always; else no", () => {
  assert.equal(
    isFarmableReward({ rewardType: "CODE_FIRST_COME", remaining: 5 }),
    true,
  );
  assert.equal(
    isFarmableReward({ rewardType: "CODE_FIRST_COME", remaining: null }),
    true,
  );
  assert.equal(
    isFarmableReward({ rewardType: "CODE_FIRST_COME", remaining: 0 }),
    false,
  );
  assert.equal(
    isFarmableReward({ rewardType: "CODE_LOTTERY", remaining: 0 }),
    true,
  );
  assert.equal(isFarmableReward({ rewardType: "IN_APP" }), false);
  assert.equal(isFarmableReward(null), false);
});

test("isCampaignFarmable checks every condition", () => {
  const t = new Date("2026-10-25T00:00:00.000Z").getTime();
  const base = {
    enabled: true,
    needsLink: false,
    state: "PROMOTED",
    startAt: new Date("2026-10-23T00:00:00.000Z"),
    endAt: new Date("2026-10-30T00:00:00.000Z"),
    rewards: [{ rewardType: "CODE_LOTTERY" }],
  };
  assert.equal(isCampaignFarmable(base, t), true);
  assert.equal(isCampaignFarmable({ ...base, enabled: false }, t), false);
  assert.equal(isCampaignFarmable({ ...base, needsLink: true }, t), false);
  assert.equal(isCampaignFarmable({ ...base, state: "TERMINATED" }, t), false);
  assert.equal(
    isCampaignFarmable(
      { ...base, rewards: [{ rewardType: "IN_APP" }] },
      t,
    ),
    false,
  );
  // Before start.
  assert.equal(
    isCampaignFarmable(base, new Date("2026-10-22T23:59:59.000Z").getTime()),
    false,
  );
  // At endAt the window is closed (half-open).
  assert.equal(
    isCampaignFarmable(base, new Date("2026-10-30T00:00:00.000Z").getTime()),
    false,
  );
  // Missing startAt / endAt is not farmable.
  assert.equal(isCampaignFarmable({ ...base, startAt: null }, t), false);
  assert.equal(isCampaignFarmable({ ...base, endAt: null }, t), false);
  // A camp with no `enabled` field at all is not farmable.
  const noFlag = { ...base };
  delete noFlag.enabled;
  assert.equal(isCampaignFarmable(noFlag, t), false);
});

test("liveRow: paid, watchParty, dropsCampaignNo and nested channel fallback", () => {
  const row = liveRow({
    liveId: 101,
    channelId: "ch1",
    channelName: "Streamer",
    concurrentUserCount: 1234,
    adult: false,
    paidProductId: null,
    watchPartyPaidProductId: null,
    watchPartyNo: null,
    openDate: "2026-10-23 10:00:00",
    dropsCampaignNo: 99,
  });
  assert.deepEqual(row, {
    liveId: 101,
    channelId: "ch1",
    channelName: "Streamer",
    viewers: 1234,
    adult: false,
    paid: false,
    watchParty: false,
    openAt: new Date("2026-10-23T01:00:00.000Z"),
    dropsCampaignNo: 99,
  });

  assert.equal(liveRow({ paidProductId: "x" }).paid, true);
  assert.equal(liveRow({ watchPartyPaidProductId: "x" }).paid, true);
  assert.equal(liveRow({ watchPartyNo: 7 }).watchParty, true);
  assert.equal(liveRow({ adult: true }).adult, true);
  // Nested channel object as a fallback (some live-list rows carry it there).
  const nested = liveRow({
    channel: { channelId: "nested-id", channelName: "nested-name" },
  });
  assert.equal(nested.channelId, "nested-id");
  assert.equal(nested.channelName, "nested-name");
});
