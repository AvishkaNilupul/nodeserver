// Tests for the CHZZK cookie keep-alive (docs/CHZZK-COOKIE-KEEPALIVE.md):
// Set-Cookie parsing/merging, the client reading its Cookie header from a
// shared store, and the farm saving renewed jars with a compare-and-set.
// No network: a fake transport answers like CHZZK/Naver; Mongo is in memory.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "chzzk-keepalive-test-cred-secret";

const ChzzkAccount = require("../models/ChzzkAccount");
const { encrypt, decrypt } = require("../utils/secretBox");
const { parseSetCookie, mergeSetCookies } = require("../utils/chzzk/cookies");
const { createJarStore } = require("../utils/chzzk/jarStore");
const { makeClient } = require("../utils/chzzk/client");
const { Farm } = require("../utils/chzzkFarm");

const GAME_HOST = "comm-api.game.naver.com";
const NOW = Date.parse("2026-10-26T02:00:00Z");

// ------------------------------------------------------------ pure rules

test("parseSetCookie: value with '=', Domain, deletion by Max-Age / Expires / empty value", () => {
  const c = parseSetCookie("NID_SES=AAAB+x/y==; Domain=.naver.com; Path=/; Secure; HttpOnly", NOW);
  assert.deepEqual(c, { name: "NID_SES", value: "AAAB+x/y==", domain: "naver.com", deleted: false });
  assert.equal(parseSetCookie("A=1; Max-Age=0", NOW).deleted, true);
  assert.equal(parseSetCookie("A=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT", NOW).deleted, true);
  assert.equal(parseSetCookie("A=; Path=/", NOW).deleted, true);
  // Max-Age wins over a past Expires.
  assert.equal(parseSetCookie("A=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=3600", NOW).deleted, false);
  assert.equal(parseSetCookie("A=1", NOW).domain, "", "no Domain = host-only");
  assert.equal(parseSetCookie("=nameless", NOW), null);
  assert.equal(parseSetCookie(42, NOW), null);
});

const JAR = () => [
  { name: "NID_AUT", value: "aut-1", domain: "naver.com" },
  { name: "NID_SES", value: "ses-1", domain: "naver.com" },
  { name: "NNB", value: "nnb-1", domain: "naver.com" },
];

test("mergeSetCookies: renews by name, keeps the domain, never mutates the input", () => {
  const jar = JAR();
  const r = mergeSetCookies(jar, ["NID_SES=ses-2; Domain=.naver.com; Path=/"], GAME_HOST, NOW);
  assert.deepEqual(r.changed, ["NID_SES"]);
  assert.deepEqual(r.ignored, []);
  assert.equal(r.jar.find((c) => c.name === "NID_SES").value, "ses-2");
  assert.equal(r.jar.find((c) => c.name === "NID_SES").domain, "naver.com");
  assert.equal(jar[1].value, "ses-1", "input jar untouched");
  // Same value again: nothing changed.
  assert.deepEqual(mergeSetCookies(r.jar, "NID_SES=ses-2; Path=/", GAME_HOST, NOW).changed, []);
});

test("mergeSetCookies: only naver.com hosts and domains count", () => {
  assert.deepEqual(mergeSetCookies(JAR(), ["NID_SES=x"], "ipinfo.io", NOW).changed, []);
  assert.deepEqual(mergeSetCookies(JAR(), ["NID_SES=x"], "evilnaver.com", NOW).changed, []);
  assert.deepEqual(mergeSetCookies(JAR(), ["NID_SES=x; Domain=evil.com"], GAME_HOST, NOW).changed, []);
  const added = mergeSetCookies(JAR(), ["NEW=1"], GAME_HOST, NOW);
  assert.deepEqual(added.changed, ["NEW"]);
  assert.equal(added.jar.find((c) => c.name === "NEW").domain, GAME_HOST, "host-only cookie keeps its host");
});

test("mergeSetCookies: refuses to delete NID_AUT/NID_SES, drops ordinary cookies", () => {
  const r = mergeSetCookies(JAR(), ["NID_SES=; Max-Age=0", "NID_AUT=gone; Max-Age=0", "NNB=; Max-Age=0"], GAME_HOST, NOW);
  assert.deepEqual(r.ignored.sort(), ["NID_AUT", "NID_SES"]);
  assert.deepEqual(r.changed, ["NNB"]);
  assert.equal(r.jar.find((c) => c.name === "NID_SES").value, "ses-1");
  assert.equal(r.jar.find((c) => c.name === "NID_AUT").value, "aut-1");
  assert.equal(r.jar.some((c) => c.name === "NNB"), false);
});

test("jarStore: absorb reports names only, replace sets a new generation", () => {
  const seen = [];
  const store = createJarStore({ cookies: JAR(), generation: 5, onChange: (ch) => seen.push(ch), now: () => NOW });
  store.absorb(["NID_SES=ses-2"], GAME_HOST);
  assert.deepEqual(seen, [{ changed: ["NID_SES"], ignored: [] }]);
  assert.equal(store.cookies().find((c) => c.name === "NID_SES").value, "ses-2");
  store.absorb([], GAME_HOST);
  assert.equal(seen.length, 1, "an answer without Set-Cookie changes nothing");
  store.replace(JAR(), 9);
  assert.equal(store.generation, 9);
  assert.equal(store.cookies().find((c) => c.name === "NID_SES").value, "ses-1");
  // A copy comes out: editing it never edits the store.
  store.cookies()[0].value = "tampered";
  assert.equal(store.cookies()[0].value, "aut-1");
});

// ------------------------------------------------------------ client

// Answers like Naver: getUserStatus hands back a fresh NID_SES each call.
function naverTransport({ hash = "hash-A", nickname = "nick-A", sesPrefix = "ses-new-", loggedIn = true } = {}) {
  let n = 0;
  const calls = [];
  return {
    ready: true,
    describe: () => "test://proxy",
    stats: () => ({}),
    calls,
    async request(url, opts = {}) {
      calls.push({ url, cookie: (opts.headers || {}).cookie || "" });
      if (url.includes("getUserStatus")) {
        n += 1;
        return {
          status: 200,
          json: { code: 200, content: { loggedIn, userIdHash: hash, nickname, penalties: [] } },
          text: "",
          headers: { "set-cookie": [`NID_SES=${sesPrefix}${n}; Domain=.naver.com; Path=/; HttpOnly`] },
        };
      }
      if (url.includes("ipinfo.io")) {
        return { status: 200, json: { country: "FR" }, text: "", headers: { "set-cookie": ["NID_SES=from-ipinfo"] } };
      }
      if (url.includes("challenges")) {
        return { status: 200, json: { code: 200, content: { challengeList: [] } }, text: "", headers: {} };
      }
      if (url.includes("claims")) {
        return { status: 200, json: { code: 500, message: "boom" }, text: "", headers: { "set-cookie": ["NID_SES=on-error"] } };
      }
      return { status: 200, json: { code: 200, content: null }, text: "", headers: {} };
    },
  };
}

const sesIn = (cookieHeader) => (/NID_SES=([^;]*)/.exec(cookieHeader) || [])[1];

test("client: a Set-Cookie on any call updates that client's next Cookie header", async () => {
  const t = naverTransport();
  const client = makeClient({ cookies: JAR(), transport: t });
  await client.userStatus();
  await client.challenges();
  assert.equal(sesIn(t.calls[0].cookie), "ses-1");
  assert.equal(sesIn(t.calls[1].cookie), "ses-new-1", "the renewed NID_SES goes out next");
  // A renewed cookie on an answer that throws is still kept.
  await assert.rejects(client.claims(), /boom/);
  await client.challenges();
  assert.equal(sesIn(t.calls[3].cookie), "on-error");
});

test("client: clients sharing one store see each other's renewals; ipinfo never touches it", async () => {
  const t = naverTransport();
  const store = createJarStore({ cookies: JAR() });
  const worker = makeClient({ cookies: JAR(), jar: store, transport: t });
  const checker = makeClient({ cookies: JAR(), jar: store, transport: t });
  await checker.userStatus();
  await worker.challenges();
  assert.equal(sesIn(t.calls[1].cookie), "ses-new-1");
  assert.equal(await worker.egressCountry(), "FR");
  assert.equal(t.calls[2].cookie, "", "ipinfo gets no cookie");
  assert.equal(store.cookies().find((c) => c.name === "NID_SES").value, "ses-new-1", "ipinfo's Set-Cookie ignored");
});

test("client: an anonymous client never sends or keeps cookies", async () => {
  const t = naverTransport();
  const anon = makeClient({ cookies: null, transport: t });
  await anon.campaign(1);
  assert.equal(t.calls[0].cookie, "");
});

// ------------------------------------------------------------ farm

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ChzzkAccount.init();
});
test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
test.beforeEach(async () => { await ChzzkAccount.deleteMany({}); });

function activityStub() {
  const entries = [];
  return { add(e) { entries.push({ ...e }); }, async list() { return entries.slice().reverse(); }, entries };
}

function buildFarm({ transport, now = () => NOW, timings, Account, runSession } = {}) {
  const activity = activityStub();
  const farm = new Farm({
    ...(Account ? { Account } : {}),
    ...(runSession ? { runSession } : {}),
    activity,
    settings: { getAutoFarm: () => ({}), async setAutoFarm() {} },
    telegram: { sendTelegram: async () => true },
    timers: { set: () => 0, interval: () => 0, clear: () => {} },
    transport,
    transportFactory: () => transport,
    makeClient,
    createCollector: () => ({ collect: async () => ({}), sweep: async () => [], reveal: async () => null, pending: () => 0 }),
    now,
    timings,
  });
  farm.transport = transport;
  farm.state.egress = { via: "test", country: "FR", ok: true, at: NOW, error: "" };
  return { farm, activity };
}

async function seed({ key = "A", status = "ok", cookieAt = new Date(NOW - 3600_000), extra = {} } = {}) {
  const jar = [
    { name: "NID_AUT", value: `aut-${key}`, domain: "naver.com" },
    { name: "NID_SES", value: `ses-${key}-0`, domain: "naver.com" },
  ];
  const doc = await ChzzkAccount.create({
    userIdHash: `hash-${key}`, nickname: `nick-${key}`, status,
    cookies: encrypt(JSON.stringify(jar)), cookieAt, ...extra,
  });
  return doc.toObject();
}

async function settled(farm) {
  for (let i = 0; i < 5; i++) {
    await Promise.all([...farm._jarSaves.values()]);
    await new Promise((r) => setImmediate(r));
  }
}

const rowJar = async (id) => JSON.parse(decrypt((await ChzzkAccount.findById(id).lean()).cookies));
const sesOf = (jar) => jar.find((c) => c.name === "NID_SES").value;

test("farm: a login check saves the renewed NID_SES encrypted; activity names no value", async () => {
  const t = naverTransport();
  const { farm, activity } = buildFarm({ transport: t });
  const doc = await seed();
  await farm._checkOne(doc);
  await settled(farm);
  const row = await ChzzkAccount.findById(doc._id).lean();
  assert.equal(sesOf(await rowJar(doc._id)), "ses-new-1");
  assert.equal(row.cookieRenewals, 1);
  assert.equal(+row.cookieRenewedAt, NOW);
  assert.equal(+row.cookieAt, +doc.cookieAt, "cookieAt stays the import time");
  assert.equal(row.cookies.includes("ses-new-1"), false, "stored encrypted");
  const line = activity.entries.find((e) => e.kind === "cookie");
  assert.match(line.msg, /renewed the login cookie \(NID_SES\) on "nick-A"/);
  assert.equal(JSON.stringify(activity.entries).includes("ses-new"), false, "no cookie value in activity");
});

test("farm: the running worker's client sends the cookie the login check renewed", async () => {
  const t = naverTransport();
  const { farm } = buildFarm({ transport: t });
  const doc = await seed();
  const workerClient = farm._clientFor(doc);   // what _spawnWorker hands the worker
  await farm._checkOne(doc);                    // the keep-warm / login check
  await workerClient.challenges();
  assert.equal(sesIn(t.calls.at(-1).cookie), "ses-new-1");
});

test("farm: a failed cookie save retries even when Naver repeats the same cookie", async () => {
  const t = naverTransport();
  const inner = t.request;
  t.request = async (...args) => {
    const res = await inner(...args);
    if (String(args[0]).includes("getUserStatus")) {
      res.headers["set-cookie"] = ["NID_SES=stable-renewal; Domain=.naver.com"];
    }
    return res;
  };
  let fail = true;
  let attempts = 0;
  const Account = new Proxy(ChzzkAccount, {
    get(target, key) {
      if (key === "updateOne") return async (filter, update, ...rest) => {
        if (update.$inc && update.$inc.cookieRenewals) {
          attempts++;
          if (fail) throw new Error("temporary database outage");
        }
        return target.updateOne(filter, update, ...rest);
      };
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const { farm } = buildFarm({ transport: t, Account });
  const doc = await seed();
  await farm._checkOne(doc); await settled(farm);
  assert.equal(farm._jarRetries.size, 1);
  await farm._checkOne(doc); await settled(farm);
  assert.equal(attempts, 1, "an unchanged cookie does not trigger another save");
  fail = false;
  const calls = t.calls.length;
  await farm._retryJarSaves(); await settled(farm);
  assert.equal(t.calls.length, calls, "retry makes no network request");
  assert.equal(sesOf(await rowJar(doc._id)), "stable-renewal");
  assert.equal(attempts, 2);
  assert.equal(farm._jarRetries.size, 0);
});

test("farm: a re-import by a side process is never overwritten by the renewed old jar", async () => {
  const t = naverTransport();
  const { farm } = buildFarm({ transport: t });
  const doc = await seed();
  const workerClient = farm._clientFor(doc);
  // A side process imports a NEW jar for this login (new cookieAt).
  const imported = [
    { name: "NID_AUT", value: "aut-A2", domain: "naver.com" },
    { name: "NID_SES", value: "ses-A2", domain: "naver.com" },
  ];
  const importedAt = new Date(NOW - 60_000);
  await ChzzkAccount.updateOne({ _id: doc._id }, { $set: { cookies: encrypt(JSON.stringify(imported)), cookieAt: importedAt } });
  // The worker's (old) store renews and tries to save.
  await workerClient.userStatus();
  await settled(farm);
  assert.equal(sesOf(await rowJar(doc._id)), "ses-A2", "the import stays");
  const row = await ChzzkAccount.findById(doc._id).lean();
  assert.equal(row.cookieRenewals || 0, 0);
  // ...and the store switched to the imported jar for every client.
  await workerClient.challenges();
  assert.equal(sesIn(t.calls.at(-1).cookie), "ses-A2");
  assert.equal(farm.jars.get(String(doc._id)).generation, +importedAt);
});

test("farm: a row read before a renewal never rolls the store back", async () => {
  const t = naverTransport();
  const { farm } = buildFarm({ transport: t });
  const doc = await seed();
  await farm._checkOne(doc);
  await settled(farm);
  // `doc` is stale now (still holds ses-A-0); a new client from it must not reset the store.
  const c = farm._clientFor(doc);
  await c.challenges();
  assert.equal(sesIn(t.calls.at(-1).cookie), "ses-new-1");
});

test("farm: import keeps the jar as it stands AFTER getUserStatus and resets renewals", async () => {
  const t = naverTransport({ hash: "hash-A" });
  const { farm } = buildFarm({ transport: t });
  const old = await seed({ extra: { cookieRenewals: 7, cookieRenewedAt: new Date(NOW - 1000) } });
  const liveClient = farm._clientFor(old);
  const paste = JSON.stringify([
    { name: "NID_AUT", value: "aut-pasted", domain: ".naver.com", session: true },
    { name: "NID_SES", value: "ses-pasted", domain: ".naver.com", session: true },
  ]);
  const [res] = await farm.importAccounts(paste);
  assert.equal(res.ok, true);
  assert.equal(res.created, false);
  const jar = await rowJar(old._id);
  assert.equal(sesOf(jar), "ses-new-1", "renewed by the import's own check");
  assert.equal(jar.find((c) => c.name === "NID_AUT").value, "aut-pasted");
  const row = await ChzzkAccount.findById(old._id).lean();
  assert.equal(row.cookieRenewals, 0);
  assert.equal(row.cookieRenewedAt, null);
  // A running worker of that login switched to the import at once.
  await liveClient.challenges();
  assert.match(t.calls.at(-1).cookie, /NID_AUT=aut-pasted/);
});

test("farm: keep-warm checks live logins only, and sends nothing while egress is down", async () => {
  const t = naverTransport();
  const { farm } = buildFarm({ transport: t });
  await seed({ key: "A", status: "ok" });
  await seed({ key: "B", status: "untested" });
  await seed({ key: "C", status: "ok", extra: { sold: true } });
  await seed({ key: "D", status: "not_logged_in" });
  farm.state.egress.ok = false;
  assert.deepEqual(await farm._keepWarm(), { checked: 0, skipped: "egress" });
  assert.equal(t.calls.length, 0, "fails closed");
  farm.state.egress.ok = true;
  assert.deepEqual(await farm._keepWarm(), { checked: 2 });
  const sent = t.calls.map((c) => /NID_AUT=([^;]*)/.exec(c.cookie)[1]).sort();
  assert.deepEqual(sent, ["aut-A", "aut-B"], "sold and logged-out logins are not touched");
  await settled(farm);
});

test("farm: one 'renewed' line per login per 6 h; the row still saves every renewal", async () => {
  let now = NOW;
  const t = naverTransport();
  const { farm, activity } = buildFarm({ transport: t, now: () => now });
  const doc = await seed();
  await farm._checkOne(doc); await settled(farm);
  now += 30 * 60_000;
  await farm._checkOne(doc); await settled(farm);
  assert.equal(activity.entries.filter((e) => e.kind === "cookie").length, 1);
  assert.equal((await ChzzkAccount.findById(doc._id).lean()).cookieRenewals, 2);
  assert.equal(sesOf(await rowJar(doc._id)), "ses-new-2");
  now += 6 * 60 * 60_000;
  await farm._checkOne(doc); await settled(farm);
  assert.equal(activity.entries.filter((e) => e.kind === "cookie").length, 2);
});

test("farm: back-to-back renewals land in order — the row ends on the newest", async () => {
  const t = naverTransport();
  const { farm } = buildFarm({ transport: t });
  const doc = await seed();
  const c = farm._clientFor(doc);
  await Promise.all([c.userStatus(), c.userStatus(), c.userStatus()]);
  await settled(farm);
  assert.equal(sesOf(await rowJar(doc._id)), "ses-new-3");
});

test("farm: Naver clearing NID_SES keeps the old value and warns", async () => {
  const t = naverTransport();
  t.request = async (url, opts = {}) => {
    t.calls.push({ url, cookie: (opts.headers || {}).cookie || "" });
    return { status: 200, json: { code: 200, content: { challengeList: [] } }, text: "", headers: { "set-cookie": ["NID_SES=; Max-Age=0; Domain=.naver.com"] } };
  };
  const { farm, activity } = buildFarm({ transport: t });
  const doc = await seed();
  const c = farm._clientFor(doc);
  await c.challenges();
  await c.challenges();
  await settled(farm);
  assert.equal(sesIn(t.calls[1].cookie), "ses-A-0");
  assert.equal(sesOf(await rowJar(doc._id)), "ses-A-0");
  assert.ok(activity.entries.some((e) => e.level === "warn" && /asked to clear NID_SES/.test(e.msg)));
});

test("farm: deleting a login forgets its store", async () => {
  const t = naverTransport();
  const { farm } = buildFarm({ transport: t });
  const doc = await seed();
  farm._clientFor(doc);
  assert.equal(farm.jars.has(String(doc._id)), true);
  await farm.deleteAccounts([String(doc._id)]);
  assert.equal(farm.jars.has(String(doc._id)), false);
});

// ------------------------------------------------- review follow-ups (10-26)

const { createTransport } = require("../utils/chzzk/http");
const { EventEmitter } = require("node:events");

test("http: the real transport hands back the answer's headers, set-cookie included", async () => {
  const request = (options, onRes) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.destroy = () => {};
    req.end = () => setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = { "set-cookie": ["NID_SES=fresh; Domain=.naver.com"], "content-type": "application/json" };
      onRes(res);
      res.emit("data", Buffer.from('{"code":200,"content":{}}'));
      res.emit("end");
    });
    return req;
  };
  const t = createTransport({ proxyUrl: "", direct: true, request });
  const r = await t.request("https://comm-api.game.naver.com/nng_main/v1/user/getUserStatus");
  assert.equal(r.status, 200);
  assert.deepEqual(r.headers["set-cookie"], ["NID_SES=fresh; Domain=.naver.com"]);
});

test("mergeSetCookies: a clear line then a new value for the same name is a renewal, not a refusal", () => {
  const r = mergeSetCookies(JAR(), ["NID_SES=; Max-Age=0", "NID_SES=ses-9; Domain=.naver.com"], GAME_HOST, NOW);
  assert.deepEqual(r.changed, ["NID_SES"]);
  assert.deepEqual(r.ignored, []);
  assert.equal(r.jar.find((c) => c.name === "NID_SES").value, "ses-9");
});

test("jarStore: an answer to a request sent before replace() is dropped", () => {
  const store = createJarStore({ cookies: JAR(), generation: 1 });
  const sentGen = store.generation;
  store.replace(JAR().map((c) => (c.name === "NID_SES" ? { ...c, value: "imported" } : c)), 2);
  const r = store.absorb(["NID_SES=old-session-renewed"], GAME_HOST, sentGen);
  assert.equal(r.stale, true);
  assert.equal(store.cookies().find((c) => c.name === "NID_SES").value, "imported");
});

// A transport whose FIRST getUserStatus waits for release(); later ones answer at once.
function gatedTransport({ firstStatus = 200, firstSes = "old-session-renewed" } = {}) {
  const base = naverTransport();
  let release;
  const gate = new Promise((r) => { release = r; });
  let first = true;
  const inner = base.request;
  base.request = async (url, opts = {}) => {
    if (url.includes("getUserStatus") && first) {
      first = false;
      base.calls.push({ url, cookie: (opts.headers || {}).cookie || "" });
      await gate;
      if (firstStatus === 401) return { status: 401, json: null, text: "", headers: { "set-cookie": [`NID_SES=${firstSes}; Domain=.naver.com`] } };
      return {
        status: 200,
        json: { code: 200, content: { loggedIn: true, userIdHash: "hash-A", nickname: "nick-A", penalties: [] } },
        text: "",
        headers: { "set-cookie": [`NID_SES=${firstSes}; Domain=.naver.com`] },
      };
    }
    return inner(url, opts);
  };
  return { t: base, release: () => release() };
}

const PASTE = JSON.stringify([
  { name: "NID_AUT", value: "aut-NEW", domain: ".naver.com", session: true },
  { name: "NID_SES", value: "ses-NEW", domain: ".naver.com", session: true },
]);

test("farm: a check sent before a re-import cannot put the old session's NID_SES into the new jar", async () => {
  const { t, release } = gatedTransport();
  const { farm } = buildFarm({ transport: t });
  const doc = await seed();
  const inFlight = farm._checkOne(doc);            // old jar, answer held back
  const [res] = await farm.importAccounts(PASTE);  // re-import while it is in flight
  assert.equal(res.ok, true);
  release();
  await inFlight;
  await settled(farm);
  const jar = await rowJar(doc._id);
  assert.equal(jar.find((c) => c.name === "NID_AUT").value, "aut-NEW");
  assert.equal(sesOf(jar), "ses-new-1", "the import's own renewal stays; the old answer is dropped");
  assert.equal(sesIn(farm.jars.get(String(doc._id)).cookies().map((c) => `${c.name}=${c.value}`).join("; ")), "ses-new-1");
});

test("farm: a 401 for the old cookie that lands after a re-import does not flag the new login", async () => {
  const { t, release } = gatedTransport({ firstStatus: 401 });
  const { farm } = buildFarm({ transport: t });
  const doc = await seed();
  const inFlight = farm._checkOne(doc);
  await farm.importAccounts(PASTE);
  release();
  await inFlight;
  const row = await ChzzkAccount.findById(doc._id).lean();
  assert.equal(row.status, "ok");
  assert.equal(row.unusableSince, null);
  // Without a re-import the same 401 does flag it.
  const { t: t2, release: rel2 } = gatedTransport({ firstStatus: 401 });
  const { farm: farm2 } = buildFarm({ transport: t2 });
  const doc2 = await seed({ key: "B" });
  const p2 = farm2._checkOne(doc2);
  rel2();
  await p2;
  assert.equal((await ChzzkAccount.findById(doc2._id).lean()).status, "not_logged_in");
});

test("farm: saves run one after another — a slow first save never lands after a newer one", async () => {
  const t = naverTransport();
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  let saves = 0;
  const Account = new Proxy(ChzzkAccount, {
    get(target, key) {
      if (key === "updateOne") {
        return async (filter, update, ...rest) => {
          if (update && update.$inc && update.$inc.cookieRenewals) {
            saves += 1;
            if (saves === 1) await firstGate;   // the first save's write is slow
          }
          return target.updateOne(filter, update, ...rest);
        };
      }
      const v = target[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const { farm } = buildFarm({ transport: t, Account });
  const doc = await seed();
  const c = farm._clientFor(doc);
  await c.userStatus();                          // ses-new-1 -> save #1 starts, held
  await new Promise((r) => setImmediate(r));
  await c.userStatus();                          // ses-new-2 -> save #2 queued
  await new Promise((r) => setImmediate(r));
  releaseFirst();
  await settled(farm);
  assert.equal(sesOf(await rowJar(doc._id)), "ses-new-2");
  assert.equal((await ChzzkAccount.findById(doc._id).lean()).cookieRenewals, 2);
});

// A runSession stand-in: resolves with `outcome` when told to, or "abort" on abort.
function fakeSession() {
  let finish;
  const sessions = [];
  const runSession = ({ signal }) => new Promise((resolve) => {
    finish = (reason) => resolve({ reason });
    sessions.push({ signal });
    signal.addEventListener("abort", () => resolve({ reason: "abort" }));
  });
  return { runSession, finish: (r) => finish(r), sessions };
}

test("farm: a worker's logged-out answer after a side-process re-import does not flag the new cookie", async () => {
  const t = naverTransport();
  const s1 = fakeSession();
  const { farm, activity } = buildFarm({ transport: t, runSession: s1.runSession });
  const doc = await seed();
  farm._spawnWorker(doc);
  // A side process imports a new jar: new cookieAt, status ok.
  await ChzzkAccount.updateOne({ _id: doc._id }, { $set: { cookieAt: new Date(NOW - 1000), status: "ok" } });
  s1.finish("auth");
  await farm.workers.get(String(doc._id)).promise;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await ChzzkAccount.findById(doc._id).lean()).status, "ok");
  assert.ok(activity.entries.some((e) => /imported again, so it starts over/.test(e.msg)));
  // No re-import: the worker's AUTH flags the login, with an activity line.
  const s2 = fakeSession();
  const { farm: farm2, activity: act2 } = buildFarm({ transport: t, runSession: s2.runSession });
  const doc2 = await seed({ key: "B" });
  farm2._spawnWorker(doc2);
  s2.finish("auth");
  await farm2.workers.get(String(doc2._id)).promise;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await ChzzkAccount.findById(doc2._id).lean()).status, "not_logged_in");
  assert.ok(act2.entries.some((e) => /CHZZK says this login is logged out/.test(e.msg)));
});

test("farm: re-importing a login with a running worker restarts that worker", async () => {
  const t = naverTransport({ hash: "hash-A" });
  const s = fakeSession();
  const { farm } = buildFarm({ transport: t, runSession: s.runSession });
  const doc = await seed();
  farm._spawnWorker(doc);
  const id = String(doc._id);
  assert.equal(farm.workers.has(id), true);
  await farm.importAccounts(PASTE);
  assert.equal(farm.workers.has(id), false, "told to stop");
  assert.equal(s.sessions[0].signal.aborted, true);
  await farm.stopping.get(id);
  // The aborted worker's end never writes a status.
  assert.equal((await ChzzkAccount.findById(doc._id).lean()).status, "ok");
});

test("farm: the 'asked to clear' warning is written at most once per login per 6 h", async () => {
  const t = naverTransport();
  t.request = async (url, opts = {}) => {
    t.calls.push({ url, cookie: (opts.headers || {}).cookie || "" });
    return { status: 200, json: { code: 200, content: { challengeList: [] } }, text: "", headers: { "set-cookie": ["NID_SES=; Max-Age=0; Domain=.naver.com"] } };
  };
  const { farm, activity } = buildFarm({ transport: t });
  const doc = await seed();
  const c = farm._clientFor(doc);
  for (let i = 0; i < 5; i++) await c.challenges();
  assert.equal(activity.entries.filter((e) => /asked to clear/.test(e.msg)).length, 1);
});
