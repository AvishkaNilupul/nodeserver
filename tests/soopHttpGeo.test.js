// SOOP farm v2: errors, transport and geo (docs/SOOP-FARM-CONTRACT.md §2-§4).
//
// The failures these exist to prevent:
//  1. GOING DIRECT. A proxy that is configured but unusable must refuse every
//     call. v1 fell back to a direct connection, which would have sent every
//     account from the US server IP.
//  2. A GUESSED COUNTRY. A failed country lookup must fail the caller and cache
//     nothing. v1 cached "JP" for the whole process and the account earned nothing.
//  3. PROXY CREDENTIALS in describe(), error text or stats.
//
// No network: https.request is replaced by a fake for the length of each test.
const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("events");

const {
  SoopError,
  LOGIN_RE,
  isAuthError,
  isEgressError,
} = require("../utils/soop/errors");
const { createTransport, getTransport } = require("../utils/soop/http");
const {
  ISO_NUMERIC,
  numericFor,
  creditStatus,
  createGeoResolver,
} = require("../utils/soop/geo");

const URL_OK = "https://api.example.test/path/x.php?a=1";

// Replaces https.request. `onRequest({ options, req, respond, body })` runs once
// the request has been end()ed; leaving it out models a server that never answers.
function stubHttps(t, onRequest) {
  const real = https.request;
  const calls = [];
  https.request = (options, onResponse) => {
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
  t.after(() => {
    https.request = real;
  });
  return calls;
}

const rejectsWith = (promise, code) =>
  assert.rejects(promise, (err) => {
    assert.ok(err instanceof SoopError, `expected a SoopError, got ${err}`);
    assert.equal(err.code, code);
    return true;
  });

// ---------------------------------------------------------------- errors

test("SoopError carries a code and a cause", () => {
  const cause = new Error("inner");
  const e = new SoopError("boom", { code: "API", cause });
  assert.ok(e instanceof Error);
  assert.equal(e.name, "SoopError");
  assert.equal(e.message, "boom");
  assert.equal(e.code, "API");
  assert.equal(e.cause, cause);
  assert.equal(new SoopError("bare").code, undefined);
});

test("LOGIN_RE and the error predicates", () => {
  for (const s of ["Please log in", "Login required", "sign in first", "로그인이 필요합니다"]) {
    assert.ok(LOGIN_RE.test(s), s);
  }
  assert.ok(!LOGIN_RE.test("campaign has ended"));

  const of = (code) => new SoopError("x", { code });
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

test("direct transport: no agent, JSON parsed, stats updated", async (t) => {
  const calls = stubHttps(t, ({ respond }) => respond(200, '{"result":1,"data":"é"}'));
  const tr = createTransport({ proxyUrl: "" });
  assert.equal(tr.proxied, false);
  assert.equal(tr.ready, true);
  assert.equal(tr.describe(), "direct");
  assert.deepEqual(tr.wsOptions(), {});
  assert.deepEqual(tr.stats(), {
    requests: 0,
    failures: 0,
    lastOkAt: null,
    lastErrorAt: null,
    lastError: null,
  });

  const json = await tr.requestJson(URL_OK, { headers: { Cookie: "a=b", skip: null } });
  assert.deepEqual(json, { result: 1, data: "é" });
  assert.equal(calls.length, 1);
  const { options } = calls[0];
  assert.equal(options.host, "api.example.test");
  assert.equal(options.port, 443);
  assert.equal(options.path, "/path/x.php?a=1");
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

test("proxied transport: the built agent is used for HTTP and the socket", async (t) => {
  const calls = stubHttps(t, ({ respond }) => respond(200, "{}"));
  const agent = { fake: "agent" };
  const seen = [];
  const tr = createTransport({
    proxyUrl: "socks5h://127.0.0.1:1080",
    agentFactory: (u) => {
      seen.push(u);
      return agent;
    },
  });
  assert.equal(tr.proxied, true);
  assert.equal(tr.ready, true);
  assert.deepEqual(seen, ["socks5h://127.0.0.1:1080"]);
  assert.equal(tr.describe(), "socks5h://127.0.0.1:1080");
  assert.equal(tr.wsOptions().agent, agent);

  await tr.requestJson(URL_OK);
  await tr.requestJson(URL_OK);
  assert.equal(calls[0].options.agent, agent);
  assert.equal(calls[1].options.agent, agent);
  assert.equal(seen.length, 1, "one agent per transport, not per request");
});

test("fails closed: proxy set but no agent -> EGRESS, never a direct call", async (t) => {
  const calls = stubHttps(t, ({ respond }) => respond(200, "{}"));
  const logged = t.mock.method(console, "error", () => {});
  const proxyUrl = "socks5h://soopuser:s3cr3t-pw@10.0.0.9:1080";

  const thrown = createTransport({
    proxyUrl,
    agentFactory: (u) => {
      throw new Error(`cannot build agent for ${u}`);
    },
  });
  const empty = createTransport({ proxyUrl, agentFactory: () => null });

  for (const tr of [thrown, empty]) {
    assert.equal(tr.proxied, true);
    assert.equal(tr.ready, false);
    await rejectsWith(tr.requestJson(URL_OK), "EGRESS");
    await rejectsWith(tr.requestJson(URL_OK, { method: "POST", body: "x=1" }), "EGRESS");
    assert.throws(() => tr.wsOptions(), (err) => err instanceof SoopError && err.code === "EGRESS");
    const s = tr.stats();
    assert.equal(s.requests, 2);
    assert.equal(s.failures, 2);
    assert.equal(s.lastOkAt, null);
    assert.equal(typeof s.lastErrorAt, "number");
    assert.match(s.lastError, /^EGRESS: /);
  }
  assert.equal(calls.length, 0, "https.request must never be called");

  // Neither the log line, the rejection nor the stats carry the proxy login.
  const err = await thrown.requestJson(URL_OK).catch((e) => e);
  const everything = [
    ...logged.mock.calls.map((c) => c.arguments.join(" ")),
    err.message,
    thrown.stats().lastError,
    thrown.describe(),
  ].join("\n");
  assert.ok(logged.mock.calls.length >= 2);
  assert.ok(!everything.includes("soopuser"), everything);
  assert.ok(!everything.includes("s3cr3t-pw"), everything);
});

test("the default agent factory builds a SOCKS agent without connecting", (t) => {
  const calls = stubHttps(t);
  const tr = createTransport({ proxyUrl: "socks5h://127.0.0.1:1" });
  assert.equal(tr.ready, true);
  assert.equal(typeof tr.wsOptions().agent, "object");
  assert.equal(calls.length, 0);
});

test("a non-JSON reply -> HTTP with the status and the first 160 characters", async (t) => {
  const html = `<html>${"x".repeat(400)}</html>`;
  stubHttps(t, ({ respond }) => respond(502, html));
  const tr = createTransport({ proxyUrl: "" });
  const err = await tr.requestJson(URL_OK).catch((e) => e);
  assert.ok(err instanceof SoopError);
  assert.equal(err.code, "HTTP");
  assert.equal(err.message, `${URL_OK} -> HTTP 502: ${html.slice(0, 160)}`);
  assert.equal(tr.stats().failures, 1);
  assert.match(tr.stats().lastError, /^HTTP: /);

  // An empty body is not JSON either.
  const tr2 = createTransport({ proxyUrl: "" });
  stubHttps(t, ({ respond }) => respond(204, ""));
  await rejectsWith(tr2.requestJson(URL_OK), "HTTP");
});

test("a JSON reply is returned whatever the status (the client reads `result`)", async (t) => {
  stubHttps(t, ({ respond }) => respond(403, '{"result":-1,"message":"login"}'));
  const tr = createTransport({ proxyUrl: "" });
  assert.deepEqual(await tr.requestJson(URL_OK), { result: -1, message: "login" });
  assert.equal(tr.stats().failures, 0);
});

test("no answer in time -> TIMEOUT, the request is destroyed and counted once", async (t) => {
  const calls = stubHttps(t); // never responds
  const tr = createTransport({ proxyUrl: "" });
  const err = await tr.requestJson(URL_OK, { timeoutMs: 15 }).catch((e) => e);
  assert.ok(err instanceof SoopError);
  assert.equal(err.code, "TIMEOUT");
  assert.equal(isEgressError(err), true);
  assert.equal(calls[0].req.destroyed, true);

  // Destroying a real request makes it emit "socket hang up" afterwards.
  calls[0].req.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
  const s = tr.stats();
  assert.equal(s.requests, 1);
  assert.equal(s.failures, 1);
  assert.match(s.lastError, /^TIMEOUT: /);
});

test("socket errors -> EGRESS, before or during the reply", async (t) => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1080"), {
    code: "ECONNREFUSED",
  });
  const calls = stubHttps(t, ({ req }) => req.emit("error", refused));
  const tr = createTransport({ proxyUrl: "socks5h://127.0.0.1:1080", agentFactory: () => ({}) });
  const err = await tr.requestJson(URL_OK).catch((e) => e);
  assert.ok(err instanceof SoopError);
  assert.equal(err.code, "EGRESS");
  assert.equal(err.cause, refused);
  assert.match(err.message, /ECONNREFUSED/);
  assert.equal(calls.length, 1);

  const reset = Object.assign(new Error("aborted"), { code: "ECONNRESET" });
  const tr2 = createTransport({ proxyUrl: "" });
  stubHttps(t, ({ respond }) => respond(200, '{"resu', { failWith: reset }));
  await rejectsWith(tr2.requestJson(URL_OK), "EGRESS");
  assert.equal(tr2.stats().failures, 1);
});

test("a request Node refuses to build -> HTTP, counted as a failure", async (t) => {
  const real = https.request;
  https.request = () => {
    throw new TypeError('Invalid character in header content ["cookie"]');
  };
  t.after(() => {
    https.request = real;
  });
  const tr = createTransport({ proxyUrl: "" });
  await rejectsWith(tr.requestJson(URL_OK), "HTTP");
  await rejectsWith(tr.requestJson("not a url"), "HTTP");
  assert.equal(tr.stats().failures, 2);
});

test("bodies: URLSearchParams, string and Buffer all get a content-length", async (t) => {
  const calls = stubHttps(t, ({ respond }) => respond(200, "{}"));
  const tr = createTransport({ proxyUrl: "" });

  const form = new URLSearchParams({ filter: "progress", name: "드롭스 a&b" });
  await tr.requestJson(URL_OK, { method: "POST", body: form });
  const flat = form.toString();
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers["content-length"], Buffer.byteLength(flat));
  assert.equal(
    calls[0].options.headers["content-type"],
    "application/x-www-form-urlencoded;charset=UTF-8",
  );
  assert.equal(calls[0].body().toString(), flat);

  // Bytes, not characters; and a caller's content-type (any case) is kept.
  const text = JSON.stringify({ title: "결승전" });
  await tr.requestJson(URL_OK, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": 1 },
    body: text,
  });
  assert.equal(calls[1].options.headers["content-length"], Buffer.byteLength(text));
  assert.notEqual(Buffer.byteLength(text), text.length);
  assert.equal(calls[1].options.headers["content-type"], "application/json");
  assert.equal("Content-Length" in calls[1].options.headers, false);
  assert.equal(calls[1].body().toString(), text);

  const custom = new URLSearchParams({ a: "1" });
  await tr.requestJson(URL_OK, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: custom,
  });
  assert.equal(calls[2].options.headers["content-type"], "application/x-www-form-urlencoded");

  const buf = Buffer.from([1, 2, 3, 4, 5]);
  await tr.requestJson(URL_OK, { method: "POST", body: buf });
  assert.equal(calls[3].options.headers["content-length"], 5);
  assert.deepEqual(calls[3].body(), buf);

  await tr.requestJson(URL_OK);
  assert.equal("content-length" in calls[4].options.headers, false);
});

test("describe() never shows proxy credentials", (t) => {
  t.mock.method(console, "error", () => {});
  const agentFactory = () => ({});
  const cases = [
    ["socks5h://soopuser:s3cr3t-pw@127.0.0.1:1080", "socks5h://127.0.0.1:1080"],
    ["socks5://soopuser:p%40ss%3Aword@tunnel.example.test:9050/", "socks5://tunnel.example.test:9050"],
    ["socks5h://tokenonly@10.1.2.3:1080", "socks5h://10.1.2.3:1080"],
    ["socks5h://127.0.0.1:1080", "socks5h://127.0.0.1:1080"],
    ["soopuser:s3cr3t-pw@@not a url", "proxy"],
  ];
  for (const [proxyUrl, want] of cases) {
    const got = createTransport({ proxyUrl, agentFactory }).describe();
    assert.equal(got, want);
    for (const secret of ["soopuser", "s3cr3t-pw", "p%40ss", "p@ss", "tokenonly"]) {
      assert.ok(!got.includes(secret), `${got} leaks ${secret}`);
    }
  }
});

test("a proxy URL with no scheme is refused without quoting any of it", async (t) => {
  const calls = stubHttps(t, ({ respond }) => respond(200, "{}"));
  const logged = t.mock.method(console, "error", () => {});
  // new URL() reads this as scheme "soopuser:", so a library error names the login.
  const proxyUrl = "soopuser:s3cr3t-pw@10.0.0.9:1080";
  const tr = createTransport({
    proxyUrl,
    agentFactory: () => {
      throw new TypeError("A valid proxy server protocol must be specified - found: soopuser:");
    },
  });
  assert.equal(tr.ready, false);
  assert.equal(tr.describe(), "proxy");
  const err = await tr.requestJson(URL_OK).catch((e) => e);
  assert.equal(err.code, "EGRESS");
  const everything = [
    ...logged.mock.calls.map((c) => c.arguments.join(" ")),
    err.message,
    tr.stats().lastError,
  ].join("\n");
  assert.ok(!everything.includes("soopuser"), everything);
  assert.ok(!everything.includes("s3cr3t-pw"), everything);
  assert.equal(calls.length, 0);
});

test("socket error text that echoes the proxy URL is scrubbed", async (t) => {
  const proxyUrl = "socks5h://soopuser:p%40ss%3Aword@127.0.0.1:1080";
  stubHttps(t, ({ req }) =>
    req.emit("error", new Error(`Socks5 Authentication failed for ${proxyUrl} (p@ss:word)`)),
  );
  const tr = createTransport({ proxyUrl, agentFactory: () => ({}) });
  const err = await tr.requestJson(URL_OK).catch((e) => e);
  assert.equal(err.code, "EGRESS");
  for (const text of [err.message, tr.stats().lastError]) {
    assert.ok(!text.includes("soopuser"), text);
    assert.ok(!text.includes("p%40ss"), text);
    assert.ok(!text.includes("p@ss:word"), text);
  }
});

test("getTransport() is one lazy process singleton built from the environment", (t) => {
  const saved = process.env.SOOP_PROXY_URL;
  delete process.env.SOOP_PROXY_URL;
  t.after(() => {
    if (saved !== undefined) process.env.SOOP_PROXY_URL = saved;
  });
  const a = getTransport();
  assert.equal(a, getTransport());
  assert.equal(a.proxied, false);
  assert.equal(a.describe(), "direct");
});

// ------------------------------------------------------------------- geo

test("ISO_NUMERIC, numericFor and creditStatus", () => {
  const entries = Object.entries(ISO_NUMERIC);
  assert.ok(entries.length >= 80, `only ${entries.length} countries`);
  for (const [cc, n] of entries) {
    assert.match(cc, /^[A-Z]{2}$/);
    assert.match(n, /^\d{3}$/);
  }
  assert.equal(new Set(entries.map(([, n]) => n)).size, entries.length);
  assert.equal(ISO_NUMERIC.JP, "392");
  assert.equal(ISO_NUMERIC.KR, "410");
  assert.equal(ISO_NUMERIC.LK, "144");
  assert.equal(ISO_NUMERIC.US, "840");
  assert.equal(ISO_NUMERIC.AR, "032");

  assert.equal(numericFor("JP"), "392");
  assert.equal(numericFor(" lk "), "144");
  assert.equal(numericFor("ZZ"), null);
  assert.equal(numericFor(""), null);
  assert.equal(numericFor(null), null);
  assert.equal(numericFor("toString"), null);

  assert.equal(creditStatus("JP"), "yes");
  assert.equal(creditStatus("lk"), "yes");
  assert.equal(creditStatus("US"), "no");
  assert.equal(creditStatus("KR"), "unknown");
  assert.equal(creditStatus(null), "unknown");
  assert.equal(creditStatus("constructor"), "unknown");
});

test("geo: env overrides each field; a pinned country needs no lookup", async () => {
  let lookups = 0;
  const fetchCountry = async () => {
    lookups += 1;
    return "LK";
  };

  const plain = createGeoResolver({ env: {} });
  assert.deepEqual(await plain.get(fetchCountry), { cc: "LK", joinCc: "144", geoRc: "13" });

  const pinned = createGeoResolver({ env: { SOOP_GEO_CC: "JP" } });
  lookups = 0;
  assert.deepEqual(await pinned.get(fetchCountry), { cc: "JP", joinCc: "392", geoRc: "13" });
  assert.equal(lookups, 0);
  assert.equal(pinned.peek().cc, "JP");
  // Pinned also means a broken lookup cannot fail the session.
  assert.equal((await pinned.get(async () => { throw new Error("down"); })).cc, "JP");

  const all = createGeoResolver({
    env: { SOOP_GEO_CC: "KR", SOOP_JOIN_CC: "999", SOOP_GEO_RC: "27" },
  });
  assert.deepEqual(await all.get(fetchCountry), { cc: "KR", joinCc: "999", geoRc: "27" });

  const joinOnly = createGeoResolver({ env: { SOOP_JOIN_CC: "392", SOOP_GEO_RC: "11" } });
  assert.deepEqual(await joinOnly.get(fetchCountry), { cc: "LK", joinCc: "392", geoRc: "11" });

  // A country with no numeric code falls back to the v1 join value.
  const unknown = createGeoResolver({ env: {} });
  assert.deepEqual(await unknown.get(async () => "zz"), { cc: "ZZ", joinCc: "392", geoRc: "13" });
});

test("geo: a failed or empty lookup throws EGRESS and caches nothing", async () => {
  const geo = createGeoResolver({ env: {} });
  const boom = new Error("tunnel down");
  let calls = 0;

  const err = await geo
    .get(async () => {
      calls += 1;
      throw boom;
    })
    .catch((e) => e);
  assert.ok(err instanceof SoopError);
  assert.equal(err.code, "EGRESS");
  assert.equal(err.cause, boom);
  assert.equal(geo.peek(), null);

  for (const empty of [null, undefined, "", "   ", "JPN", 392, {}]) {
    await rejectsWith(
      geo.get(async () => {
        calls += 1;
        return empty;
      }),
      "EGRESS",
    );
    assert.equal(geo.peek(), null, `cached after ${JSON.stringify(empty)}`);
  }
  // A lookup that throws synchronously is still a failed lookup.
  await rejectsWith(geo.get(() => { throw new Error("sync"); }), "EGRESS");
  assert.equal(calls, 8, "every call retried the lookup");

  // No fallback was remembered: the next call looks again and can succeed.
  assert.deepEqual(await geo.get(async () => "LK"), { cc: "LK", joinCc: "144", geoRc: "13" });
  assert.equal(geo.peek().cc, "LK");
});

test("geo: a success is cached for ttlMs, then looked up again", async () => {
  let t = 1_000_000;
  let lookups = 0;
  const answers = ["JP", "LK"];
  const fetchCountry = async () => answers[lookups++];
  const geo = createGeoResolver({ ttlMs: 1000, env: {}, now: () => t });

  assert.equal(geo.peek(), null);
  assert.equal((await geo.get(fetchCountry)).cc, "JP");
  assert.deepEqual(geo.peek(), { cc: "JP", joinCc: "392", geoRc: "13", at: 1_000_000 });

  t += 999;
  const again = await geo.get(fetchCountry);
  assert.equal(again.cc, "JP");
  assert.equal(lookups, 1);
  // Callers get their own object; changing it cannot poison the cache.
  again.cc = "US";
  assert.equal((await geo.get(fetchCountry)).cc, "JP");

  t += 1;
  assert.deepEqual(await geo.get(fetchCountry), { cc: "LK", joinCc: "144", geoRc: "13" });
  assert.equal(lookups, 2);
  assert.equal(geo.peek().at, 1_001_000);

  // An expired entry that cannot be refreshed fails; it is not served stale.
  t += 5000;
  await rejectsWith(geo.get(async () => null), "EGRESS");
});

test("geo: concurrent get() calls share one lookup", async () => {
  const geo = createGeoResolver({ env: {} });
  let lookups = 0;
  let release;
  const gate = new Promise((r) => (release = r));
  const fetchCountry = async () => {
    lookups += 1;
    await gate;
    return "JP";
  };
  const pending = [geo.get(fetchCountry), geo.get(fetchCountry), geo.get(fetchCountry)];
  release();
  const results = await Promise.all(pending);
  assert.equal(lookups, 1);
  assert.deepEqual(results.map((r) => r.cc), ["JP", "JP", "JP"]);

  // A shared failure rejects every waiter, and the one after starts afresh.
  const geo2 = createGeoResolver({ env: {} });
  let fails = 0;
  const bad = async () => {
    fails += 1;
    await new Promise((r) => setImmediate(r));
    throw new Error("down");
  };
  const settled = await Promise.allSettled([geo2.get(bad), geo2.get(bad)]);
  assert.deepEqual(settled.map((s) => s.status), ["rejected", "rejected"]);
  assert.ok(settled.every((s) => s.reason.code === "EGRESS"));
  assert.equal(fails, 1);
  assert.equal((await geo2.get(async () => "LK")).cc, "LK");
});

test("geo: invalidate() forgets the country, and a lookup already in flight", async () => {
  const geo = createGeoResolver({ env: {} });
  let lookups = 0;
  const jp = async () => {
    lookups += 1;
    return "JP";
  };
  await geo.get(jp);
  geo.invalidate();
  assert.equal(geo.peek(), null);
  await geo.get(jp);
  assert.equal(lookups, 2);

  // The egress moved while a lookup was running: its answer is stale.
  geo.invalidate();
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = geo.get(async () => {
    await gate;
    return "US";
  });
  geo.invalidate();
  release();
  assert.equal((await slow).cc, "US");
  assert.equal(geo.peek(), null);
  assert.equal((await geo.get(async () => "LK")).cc, "LK");
});
