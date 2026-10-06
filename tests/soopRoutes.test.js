/* global fetch */
// Route-level tests for the SOOP farm API (docs/SOOP-FARM-CONTRACT.md §11),
// driven against the in-memory SOOP of tests/helpers/soopFake.js. No network.
//
// Three failures these exist to prevent:
//  1. A COOKIE LEAK. Account rows hold live AuthTicket cookies — the whole
//     account — and GET /api/soop/state is polled every few seconds. The
//     assertions are on the SERIALISED body, not on a field list, so any future
//     spread that forgets to strip `cookies` fails loudly.
//  2. A CODE LEAK. Reward codes are the product; only /inventory/reveal may
//     return one, and it must leave a trace of who asked.
//  3. AN OPEN PANEL. Every route can start farming or read inventory, so every
//     one must refuse an anonymous or non-superadmin caller.
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "soop-routes-test-cred-secret";
delete process.env.SOOP_PROXY_URL; // the transport is only described, never used

const SoopAccount = require("../models/SoopAccount");
const farm = require("../utils/soopFarm");
const { SoopError } = require("../utils/soop/errors");
const { sleep } = require("../utils/soopWorker");
const { decrypt } = require("../utils/secretBox");
const { createFakeSoop } = require("./helpers/soopFake");
const soopRoutes = require("../routes/soopRoutes");

// §11, row for row. [method, path, a request that passes validation]
const TABLE = [
  ["GET", "/api/soop/state"],
  ["GET", "/api/soop/campaigns"],
  ["POST", "/api/soop/accounts/import"],
  ["POST", "/api/soop/accounts/check"],
  ["POST", "/api/soop/accounts/update"],
  ["POST", "/api/soop/accounts/delete"],
  ["POST", "/api/soop/bots/create"],
  ["POST", "/api/soop/bots/update"],
  ["POST", "/api/soop/bots/stop"],
  ["POST", "/api/soop/bots/resume"],
  ["POST", "/api/soop/bots/delete"],
  ["POST", "/api/soop/games/rename"],
  ["POST", "/api/soop/translate"],
  ["GET", "/api/soop/inventory/summary"],
  ["GET", "/api/soop/inventory/account"],
  ["POST", "/api/soop/inventory/sync"],
  ["POST", "/api/soop/inventory/reveal"],
  ["POST", "/api/soop/inventory/claim"],
  ["GET", "/api/soop/inventory/export.csv"],
  ["GET", "/api/soop/activity"],
];
const CODE = "SOOP-CODE-SENTINEL-9XQ7";
const GHOST_ID = "0123456789abcdef01234567";

const world = createFakeSoop();
const servers = {};
const logged = [];
const realConsole = { log: console.log, warn: console.warn, error: console.error };
let mongod;
let tickets = [];

function harness(admin) {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use((req, _res, next) => {
    req.session = admin ? { admin } : {};
    next();
  });
  app.use(soopRoutes);
  const server = app.listen(0);
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function call(method, path, body, who = "root") {
  const res = await fetch(servers[who].url + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // the CSV export is not JSON
  }
  return { status: res.status, text, json, headers: res.headers };
}
const get = (path) => call("GET", "/api/soop" + path);
const post = (path, body = {}) => call("POST", "/api/soop" + path, body);

async function waitFor(fn, what, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) assert.fail("timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, 15));
  }
}

function refused(r, status, what) {
  assert.equal(r.status, status, `${what}: expected ${status}, got ${r.status} ${r.text.slice(0, 120)}`);
  assert.equal(r.json.success, false);
  assert.ok(r.json.message && typeof r.json.message === "string", `${what}: no readable message`);
  assert.equal(r.json.error, r.json.message);
}

test.before(async () => {
  // Logs are part of the leak surface: keep every line for the last test.
  for (const k of Object.keys(realConsole)) {
    console[k] = (...args) => {
      logged.push(args.map(String).join(" "));
      if (process.env.SOOP_TEST_LOGS) realConsole[k](...args);
    };
  }
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  farm.setClientFactory(world.clientFor);
  farm.autoInventory = false;
  farm.timings = { pollMs: 20, idleMs: 20, retryMs: 20, joinWaitMs: 200, backoffMs: [40] };
  farm.setClock({ sleep: (ms, signal) => sleep(Math.min(ms, 25), signal) });
  await farm.start();
  servers.root = harness({ id: "a1", username: "root-admin", role: "superadmin" });
  servers.anon = harness(null);
  servers.seller = harness({ id: "s1", username: "shop", role: "seller" });
});

test.after(async () => {
  await farm._reset();
  for (const s of Object.values(servers)) await new Promise((r) => s.server.close(r));
  await mongoose.disconnect();
  await mongod.stop();
  Object.assign(console, realConsole);
});

test("every path and method of the contract table is mounted, and nothing else", () => {
  const mounted = soopRoutes.stack
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route.methods).map((m) => `${m.toUpperCase()} ${l.route.path}`));
  assert.deepEqual([...mounted].sort(), TABLE.map(([m, p]) => `${m} ${p}`).sort());
});

test("every route answers 401 to an anonymous caller and 403 to a seller", async () => {
  for (const [method, path] of TABLE) {
    const body = method === "POST" ? {} : undefined;
    const anon = await call(method, path, body, "anon");
    assert.equal(anon.status, 401, `${method} ${path} anonymous`);
    assert.equal(anon.json.success, false);
    const seller = await call(method, path, body, "seller");
    assert.equal(seller.status, 403, `${method} ${path} seller`);
    assert.equal(seller.json.success, false);
  }
});

test("bad input is refused with 400 and a readable message", async () => {
  const many = Array.from({ length: 501 }, (_, i) => "acc" + i);
  const cases = [
    ["/accounts/import", {}],
    ["/accounts/import", { cookies: 123 }],
    ["/accounts/import", { cookies: "   " }],
    ["/accounts/import", { cookies: "x".repeat(2 * 1024 * 1024 + 1) }],
    ["/accounts/check", { ids: "acc1" }],
    ["/accounts/check", { ids: many }],
    ["/accounts/update", { sold: true }],
    ["/accounts/update", { id: "acc1" }],
    ["/accounts/update", { id: "acc1", sold: "yes" }],
    ["/accounts/delete", {}],
    ["/accounts/delete", { ids: "acc1" }],
    ["/accounts/delete", { ids: [1, 2] }],
    ["/accounts/delete", { ids: [] }],
    ["/bots/create", { mode: "auto", accountIds: "acc1" }],
    ["/bots/create", { mode: "auto", accountIds: [{ id: "acc1" }] }],
    ["/bots/create", { mode: "auto", accountIds: ["acc1"], codesOnly: "no" }],
    ["/bots/create", { mode: "auto", accountIds: [] }],
    ["/bots/update", { name: "x" }],
    ["/bots/update", { id: GHOST_ID, addIds: "acc1" }],
    ["/bots/stop", {}],
    ["/bots/resume", {}],
    ["/bots/delete", { id: { $ne: null } }],
    ["/games/rename", { name: "x" }],
    ["/games/rename", { gameNo: "12" }],
    ["/translate", { english: "x" }],
    ["/translate", { source: "원본" }],
    ["/inventory/sync", { ids: { all: true } }],
    ["/inventory/reveal", {}],
    ["/inventory/reveal", { itemId: "not-an-id" }],
    ["/inventory/claim", {}],
    ["/inventory/claim", { itemId: "not-an-id" }],
  ];
  for (const [path, body] of cases) {
    refused(await post(path, body), 400, `POST ${path} ${JSON.stringify(body).slice(0, 60)}`);
  }
  for (const path of ["/inventory/account", "/inventory/account?id=a&id=b", "/activity?level=loud", "/activity?limit=0"]) {
    refused(await get(path), 400, `GET ${path}`);
  }
});

test("a bulk import of two exports returns two results", async () => {
  const one = world.addAccount({ id: "acc1", nick: "One" });
  const two = world.addAccount({ id: "acc2", nick: "Two" });
  tickets = [one[0].value, two[0].value];
  const r = await post("/accounts/import", { cookies: JSON.stringify(one) + "\n" + JSON.stringify(two) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.success, true);
  assert.equal(r.json.results.length, 2);
  assert.deepEqual(
    r.json.results.map((x) => [x.ok, x.id, x.nick, x.country]),
    [[true, "acc1", "One", "LK"], [true, "acc2", "Two", "LK"]],
  );
  for (const t of tickets) assert.ok(!r.text.includes(t), "the import reply echoed a cookie value");

  const bad = await post("/accounts/import", { cookies: "this is not a cookie export" });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.results.length, 1);
  assert.equal(bad.json.results[0].ok, false);
  assert.ok(bad.json.results[0].error);
});

test("state never serialises a stored cookie", async () => {
  // The value really is stored (encrypted), so its absence below means something.
  const row = await SoopAccount.findOne({ loginId: "acc1" }).lean();
  assert.ok(!row.cookies.includes(tickets[0]), "the cookie is stored in clear text");
  assert.ok(decrypt(row.cookies).includes(tickets[0]));

  const r = await get("/state");
  assert.equal(r.status, 200);
  for (const t of tickets) assert.ok(!r.text.includes(t), "response leaked an AuthTicket value");
  assert.ok(!r.text.includes("fake-ticket-"));
  assert.equal(r.json.success, true);
  assert.deepEqual(r.json.accounts.map((a) => a.id), ["acc1", "acc2"]);
  assert.equal(r.json.accounts[0].cookies, undefined);
  assert.equal(r.json.accounts[0].status, "ok");
  assert.equal(r.json.totals.accounts, 2);
  assert.ok(r.json.egress && typeof r.json.egress.via === "string");
  assert.ok(r.json.metrics && typeof r.json.metrics.rssMB === "number");
});

test("a SOOP / egress failure is a 502 in plain English, anything else a bare 500", async () => {
  // A failed scan is not a failed request: the page still gets what is
  // remembered, with the reason in `scan` — in plain English, never raw.
  world.setEgress({ down: true });
  try {
    const r = await get("/campaigns?force=1");
    assert.equal(r.status, 200);
    assert.equal(r.json.scan.ok, false);
    assert.match(r.json.scan.error, /could not reach soop/i);
    assert.ok(!/EGRESS|fake egress/.test(r.text), "raw error text reached the caller");
  } finally {
    world.setEgress({ down: false });
  }

  const realView = farm.campaignsView;
  farm.campaignsView = async () => {
    throw new SoopError("fake egress is down", { code: "EGRESS" });
  };
  try {
    const r = await get("/campaigns");
    refused(r, 502, "a SOOP failure thrown at a route");
    assert.match(r.json.message, /could not reach soop/i);
    assert.ok(!/EGRESS|fake egress/.test(r.text), "raw error text reached the caller");
  } finally {
    farm.campaignsView = realView;
  }

  const real = farm.stateView;
  farm.stateView = async () => {
    throw new Error("boom: internal detail");
  };
  try {
    const r = await get("/state");
    refused(r, 500, "state with a crashing farm");
    assert.equal(r.json.message, "Server error");
    assert.ok(!r.text.includes("boom"));
    assert.ok(logged.some((l) => l.includes("soop state error:") && l.includes("boom")));
  } finally {
    farm.stateView = real;
  }
});

test("campaigns, a game rename and a translation override through HTTP", async () => {
  world.addCampaign({ dropsIdx: "7001", title: "라우트 테스트 7001", gameNo: "12", live: true });
  world.addCampaign({ dropsIdx: "7002", gameNo: "12", filter: "scheduled" });
  const first = await get("/campaigns?force=1");
  assert.equal(first.status, 200, first.text);
  const camp = first.json.campaigns.find((c) => c.dropsIdx === "7001");
  assert.ok(camp, "the live campaign is listed");
  assert.equal(camp.titleRaw, "라우트 테스트 7001");
  assert.deepEqual(camp.steps, [30, 60]);
  assert.deepEqual(camp.botIds, []);
  assert.equal(typeof camp.endAt, "string");
  assert.ok(first.json.games.some((g) => g.gameNo === "12"));
  assert.equal(first.json.scan.ok, true);

  assert.equal((await post("/games/rename", { gameNo: 12, name: "  Renamed game  " })).status, 200);
  assert.equal((await post("/translate", { source: camp.titleRaw, english: "Route test drops" })).status, 200);
  const after = await get("/campaigns");
  const fixed = after.json.campaigns.find((c) => c.dropsIdx === "7001");
  assert.equal(fixed.title, "Route test drops");
  assert.equal(fixed.gameName, "Renamed game");
  assert.equal(after.json.games.find((g) => g.gameNo === "12").name, "Renamed game");
});

test("a bot is created, edited, stopped, resumed and deleted through HTTP", async () => {
  const made = await post("/bots/create", {
    name: " Route bot ", mode: "campaign", dropsIdx: "7001", accountIds: ["acc1"], target: "all", codesOnly: false,
  });
  assert.equal(made.status, 200, made.text);
  const id = made.json.bot.id;
  assert.equal(made.json.bot.name, "Route bot");
  assert.equal(made.json.bot.active, true);
  await waitFor(() => world.bridges().some((b) => b.id === "acc1" && b.joined), "acc1 to join the stream");

  let state = (await get("/state")).json;
  const acc1 = state.accounts.find((a) => a.id === "acc1");
  assert.equal(acc1.botId, id);
  assert.equal(typeof acc1.session.state, "string");
  assert.equal(state.bots.find((b) => b.id === id).counts.total, 1);
  assert.deepEqual((await get("/campaigns")).json.campaigns.find((c) => c.dropsIdx === "7001").botIds, [id]);

  // An account farms in one active bot at a time.
  const twice = await post("/bots/create", { mode: "auto", accountIds: ["acc1"] });
  refused(twice, 400, "second bot for a busy account");
  assert.match(twice.json.message, /acc1 is already in the bot "Route bot"/);

  const edited = await post("/bots/update", { id, name: "Renamed bot", addIds: ["acc2"] });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.bot.name, "Renamed bot");
  assert.deepEqual(edited.json.bot.accountIds, ["acc1", "acc2"]);

  const stopped = await post("/bots/stop", { id });
  assert.deepEqual([stopped.status, stopped.json.stopped], [200, 1]);
  assert.deepEqual(world.bridges(), [], "a stopped bot holds no stream socket");
  state = (await get("/state")).json;
  assert.equal(state.bots.find((b) => b.id === id).active, false);
  assert.ok(state.accounts.every((a) => a.botId === null && a.session === null));

  assert.equal((await post("/bots/resume", { id })).status, 200);
  await waitFor(() => world.bridges().filter((b) => b.joined).length === 2, "both accounts to rejoin");
  state = (await get("/state")).json;
  assert.equal(state.bots.find((b) => b.id === id).active, true);
  assert.equal(state.totals.botsActive, 1);

  const all = await post("/bots/stop", { all: true });
  assert.deepEqual([all.status, all.json.stopped], [200, 1]);
  assert.equal((await post("/bots/resume", { id })).status, 200);

  assert.equal((await post("/bots/delete", { id })).status, 200);
  assert.deepEqual(world.bridges(), []);
  assert.deepEqual((await get("/state")).json.bots, []);

  for (const path of ["/bots/stop", "/bots/resume", "/bots/delete", "/bots/update"]) {
    refused(await post(path, { id }), 404, `${path} for a deleted bot`);
  }
});

test("account update, check and delete", async () => {
  const sold = await post("/accounts/update", { id: "acc2", sold: true, note: "  sold on Monday  " });
  assert.equal(sold.status, 200, sold.text);
  const acc2 = (await get("/state")).json.accounts.find((a) => a.id === "acc2");
  assert.deepEqual([acc2.sold, acc2.note], [true, "sold on Monday"]);
  refused(await post("/accounts/update", { id: "ghost", sold: true }), 404, "update of an unknown account");

  const checked = await post("/accounts/check", { ids: [] }); // empty = every account not sold
  assert.deepEqual([checked.status, checked.json.total], [200, 1]);

  const three = world.addAccount({ id: "acc3" });
  tickets.push(three[0].value);
  assert.equal((await post("/accounts/import", { cookies: JSON.stringify(three) })).json.results[0].id, "acc3");
  const gone = await post("/accounts/delete", { ids: ["acc3", "ghost"] });
  assert.deepEqual([gone.status, gone.json.deleted], [200, 1]);
  assert.deepEqual((await get("/state")).json.accounts.map((a) => a.id), ["acc1", "acc2"]);
});

test("a reward code only ever leaves through /inventory/reveal, which is recorded", async () => {
  world.addInventory("acc1", { itemName: "Sentinel skin", itemCode: CODE }, "available");
  world.addInventory("acc2", { itemName: "Sold account item", itemCode: "NEVER-SYNCED" }, "available");
  const sync = await post("/inventory/sync", { ids: [] }); // empty = every account not sold -> acc1 only
  assert.deepEqual([sync.status, sync.json.total], [200, 1]);

  const summary = await waitFor(async () => {
    const r = await get("/inventory/summary");
    return !r.json.sync.running && r.json.totals.available === 1 ? r : null;
  }, "the inventory sync to finish");
  assert.equal(summary.json.games[0].items[0].name, "Sentinel skin");
  assert.deepEqual(summary.json.games[0].items[0].accountIds, ["acc1"]);

  const account = await get("/inventory/account?id=acc1");
  assert.equal(account.status, 200);
  assert.equal(account.json.items.length, 1);
  const item = account.json.items[0];
  assert.equal(item.hasCode, true);
  assert.equal(item.code, undefined);
  assert.equal(item.codeEnc, undefined);

  const csv = await get("/inventory/export.csv");
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-type"), /^text\/csv/);
  assert.match(csv.headers.get("content-disposition"), /^attachment; filename="soop-inventory\.csv"$/);
  assert.match(csv.text, /^loginId,game,item,kind,division,expiresAt,hasCode\n/);
  assert.match(csv.text, /\nacc1,.*Sentinel skin.*,yes\n/);

  for (const r of [summary, account, csv]) assert.ok(!r.text.includes(CODE), "a read route leaked the code");

  const reveal = await post("/inventory/reveal", { itemId: item.id });
  assert.equal(reveal.status, 200, reveal.text);
  assert.equal(reveal.json.code, CODE);
  refused(await post("/inventory/reveal", { itemId: GHOST_ID }), 404, "reveal of an unknown item");

  const log = await get("/activity?limit=500");
  const entries = log.json.entries.filter((e) => e.kind === "reveal");
  assert.equal(entries.length, 1, "exactly the successful reveal is recorded");
  assert.ok(entries[0].msg.includes("root-admin") && entries[0].msg.includes(item.id));
  assert.ok(!log.text.includes(CODE), "the activity log holds the code");
});

test("the activity log can be filtered", async () => {
  const some = await get("/activity?limit=3");
  assert.equal(some.status, 200);
  assert.equal(some.json.entries.length, 3);
  const mine = await get("/activity?accountId=acc1&level=info");
  assert.ok(mine.json.entries.length > 0);
  assert.ok(mine.json.entries.every((e) => e.accountId === "acc1" && e.level === "info"));
});

test("no read route and no log line carries a cookie value or a reward code", async () => {
  const secrets = [...tickets, CODE];
  for (const [method, path] of TABLE.filter(([m]) => m === "GET")) {
    const r = await call(method, path + (path.endsWith("/account") ? "?id=acc1" : ""));
    assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 120)}`);
    for (const s of secrets) assert.ok(!r.text.includes(s), `${path} leaked a secret`);
  }
  for (const line of logged) {
    for (const s of secrets) assert.ok(!line.includes(s), "a log line carries a secret");
  }
});
