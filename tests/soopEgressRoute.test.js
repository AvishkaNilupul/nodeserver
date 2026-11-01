// SOOP per-login egress: SOOP_PROXY_ALT_URL + SOOP_PROXY_ALT_LOGINS move the
// named logins to a second tunnel (a canary), everyone else stays on
// SOOP_PROXY_URL.
//
// The failures these exist to prevent:
//  1. A login that was NOT named leaving through the canary tunnel (or the
//     other way round) — checked end to end through the farm's own client
//     factory, down to the agent handed to https.request.
//  2. The alternate being switched on by half a configuration (logins without
//     a URL), or shared state between the two egresses (one geo cache).
//
// No network: https.request is replaced by a fake that answers every call.
process.env.SOOP_PROXY_URL = "socks5h://127.0.0.1:1080";
process.env.SOOP_PROXY_ALT_URL = "socks5h://127.0.0.1:1085";
process.env.SOOP_PROXY_ALT_LOGINS = " Canary1, canary2\ncanary3 ";

const test = require("node:test");
const assert = require("node:assert/strict");
const https = require("https");
const { EventEmitter } = require("events");

const { createEgressRouter, parseLogins } = require("../utils/soop/egressRoute");
const farm = require("../utils/soopFarm");

const COOKIES = [
  { name: "AuthTicket", value: "t" },
  { name: "UserTicket", value: "u" },
];

// Answers every request with a logged-in private_info and records the agent.
function captureAgents(t) {
  const real = https.request;
  const agents = [];
  https.request = (options, onResponse) => {
    agents.push(options.agent);
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () =>
      setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        onResponse(res);
        res.emit("data", Buffer.from(JSON.stringify({ CHANNEL: { IS_LOGIN: 1, LOGIN_ID: "x", COUNTRY_CODE: "JP" } })));
        res.emit("end");
      });
    return req;
  };
  t.after(() => {
    https.request = real;
  });
  return agents;
}

const portOf = (agent) => agent && agent.proxy && Number(agent.proxy.port);

test("parseLogins: commas, spaces, new lines; case-insensitive; empty is empty", () => {
  assert.deepEqual([...parseLogins(" A, b\nc;;d ")], ["a", "b", "c", "d"]);
  assert.equal(parseLogins("").size, 0);
  assert.equal(parseLogins(undefined).size, 0);
});

test("router: nothing configured -> every login keeps the farm's egress", () => {
  const r = createEgressRouter({ env: {} });
  assert.deepEqual(r.optionsFor("anyone"), {});
  assert.equal(r.describe(), null);
});

test("router: logins without a URL are ignored (no half configuration)", () => {
  let built = 0;
  const r = createEgressRouter({
    env: { SOOP_PROXY_ALT_LOGINS: "a,b" },
    transportFactory: () => (built += 1),
  });
  assert.deepEqual(r.optionsFor("a"), {});
  assert.equal(r.describe(), null);
  assert.equal(built, 0);
});

test("router: named logins share one alternate transport and geo; others get nothing", () => {
  const made = [];
  const r = createEgressRouter({
    env: { SOOP_PROXY_ALT_URL: "socks5h://127.0.0.1:1085", SOOP_PROXY_ALT_LOGINS: "a, B" },
    transportFactory: (o) => {
      made.push(o.proxyUrl);
      return { describe: () => "socks5h://127.0.0.1:1085", ready: true, stats: () => ({ requests: 0 }) };
    },
    geoFactory: () => ({ peek: () => null }),
  });
  const a = r.optionsFor("A ");
  const b = r.optionsFor("b");
  assert.ok(a.transport && a.geo);
  assert.equal(a, b, "one transport for every alternate login");
  assert.deepEqual(r.optionsFor("c"), {});
  assert.deepEqual(r.optionsFor(null), {});
  assert.deepEqual(r.optionsFor("import"), {});
  assert.deepEqual(made, ["socks5h://127.0.0.1:1085"]);
  assert.deepEqual(r.describe(), {
    via: "socks5h://127.0.0.1:1085",
    ready: true,
    country: null,
    logins: ["a", "b"],
    stats: { requests: 0 },
  });
});

test("farm: a named login's calls leave through the canary port, the rest through the main one", async (t) => {
  const agents = captureAgents(t);
  await farm.clientFactory(COOKIES, { id: "canary2" }).privateInfo();
  await farm.clientFactory(COOKIES, { id: "CANARY1" }).privateInfo();
  await farm.clientFactory(COOKIES, { id: "regular" }).privateInfo();
  await farm.clientFactory(COOKIES, { id: "import" }).privateInfo();
  assert.deepEqual(agents.map(portOf), [1085, 1085, 1080, 1080]);
});

test("farm: the status names the alternate egress and its logins, never more", () => {
  const alt = farm.egressRouter.describe();
  assert.equal(alt.via, "socks5h://127.0.0.1:1085");
  assert.equal(alt.ready, true);
  assert.deepEqual(alt.logins, ["canary1", "canary2", "canary3"]);
});
