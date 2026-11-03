/* global fetch */
// Steam accounts: the SSH import (tools/steam-signup/cloud-import.cjs) and the
// page API (routes/steamAccountRoutes.js) against mongodb-memory-server.
// Contract: docs/STEAM-ACCOUNTS.md.
process.env.SESSION_SECRET ||= "steam-accounts-test-secret";
process.env.CRED_SECRET ||= "steam-accounts-test-cred";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { encrypt, decrypt } = require("../utils/secretBox");
const SteamAccount = require("../models/SteamAccount");
const SteamBoost = require("../models/SteamBoost");
const { importAccount, validate } = require("../tools/steam-signup/cloud-import.cjs");
const router = require("../routes/steamAccountRoutes");

let mongod;
let server;
let base;
let role = "superadmin";

function payload(over = {}) {
  return {
    version: 1,
    account: {
      localId: "0d6c5f0e-1b1b-4c1e-9d55-2f0a9c1e7b11",
      accountName: "caoleduong8_22a1602e",
      password: "s3cret-Pass!7aA",
      email: "CaoLeDuong8@outlook.com",
      signupCountry: "US",
      requestedCountry: "US",
      proxyCountry: "US",
      proxyCity: "Dallas",
      signedUpAt: "2026-11-01T11:50:00.000Z",
      ...over,
    },
  };
}

async function call(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await SteamAccount.init();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = role ? { admin: { id: "t", role } } : {};
    next();
  });
  app.use(router);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = "http://127.0.0.1:" + server.address().port;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  role = "superadmin";
  await SteamAccount.deleteMany({});
  await SteamBoost.deleteMany({});
});

const importOne = (p = payload()) =>
  importAccount({ payload: p, collection: mongoose.connection.db.collection("steamaccounts"), encrypt });

test("validate rejects bad input before any database work", () => {
  assert.throws(() => validate({ version: 2, account: payload().account }));
  assert.throws(() => validate(payload({ localId: "x" })), /account id/);
  assert.throws(() => validate(payload({ accountName: "bad name" })), /account name/);
  assert.throws(() => validate(payload({ password: "" })), /Incomplete/);
  assert.throws(() => validate(payload({ email: "nope" })), /email/);
  assert.throws(() => validate(payload({ password: "enc:v1:abc" })), /Invalid field/);
  assert.throws(() => validate(payload({ proxyCity: "x".repeat(101) })), /Invalid field/);
  const ok = validate(payload({ signupCountry: "usa" }));
  assert.equal(ok.signupCountry, null, "a bad country code is dropped, not stored");
  assert.equal(ok.email, "caoleduong8@outlook.com");
});

test("import inserts once, encrypts the login, and never overwrites server edits", async () => {
  const first = await importOne();
  assert.equal(first.success, true);
  assert.equal(first.inserted, true);
  assert.match(first.cloudId, /^[a-f\d]{24}$/);

  const raw = await mongoose.connection.db.collection("steamaccounts").findOne({ localId: payload().account.localId });
  assert.ok(raw.password.startsWith("enc:"), "password stored encrypted");
  assert.ok(raw.email.startsWith("enc:"), "email stored encrypted");
  assert.equal(decrypt(raw.password), "s3cret-Pass!7aA");
  assert.equal(raw.stage, "stock");
  assert.equal(raw.storeCountry, null);

  // Owner edits on the server, then the Mac uploads the same account again.
  await SteamAccount.updateOne({ _id: raw._id }, { $set: { stage: "listed", games: [{ name: "Portal 2", appId: 620, priceUsd: 9.99 }] } });
  const again = await importOne(payload({ password: "changed-on-mac", proxyCity: "Elsewhere" }));
  assert.equal(again.inserted, false);
  assert.equal(again.cloudId, first.cloudId);
  const after = await SteamAccount.findById(raw._id).lean();
  assert.equal(after.stage, "listed");
  assert.equal(after.games.length, 1);
  assert.equal(decrypt(after.password), "s3cret-Pass!7aA", "a repeat upload never replaces the saved password");
  assert.equal(after.proxyCity, "Dallas");
  assert.equal(await SteamAccount.countDocuments(), 1);
});

test("list never includes the password or email, and counts stages", async () => {
  await importOne();
  await importOne(payload({ localId: "aaaaaaaa-0000-4000-8000-000000000002", accountName: "second_acc", email: "b@outlook.com" }));
  await SteamAccount.updateOne({ accountName: "second_acc" }, { $set: { games: [{ name: "Terraria", appId: 105600, priceUsd: 9.99 }] } });

  const r = await call("GET", "/api/steam/accounts");
  assert.equal(r.status, 200);
  assert.equal(r.body.accounts.length, 2);
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes("enc:"), "no ciphertext in the list");
  assert.ok(!text.includes("s3cret"), "no password in the list");
  assert.ok(!text.includes("outlook.com"), "no email in the list");
  assert.deepEqual(
    { total: r.body.summary.total, empty: r.body.summary.empty, loaded: r.body.summary.loaded, value: r.body.summary.stockValueUsd },
    { total: 2, empty: 1, loaded: 1, value: 9.99 },
  );
});

test("credentials come back decrypted on request, and only for a superadmin", async () => {
  const { cloudId } = await importOne();
  const r = await call("GET", `/api/steam/accounts/${cloudId}/credentials`);
  assert.equal(r.status, 200);
  assert.deepEqual(
    { accountName: r.body.accountName, password: r.body.password, email: r.body.email },
    { accountName: "caoleduong8_22a1602e", password: "s3cret-Pass!7aA", email: "caoleduong8@outlook.com" },
  );

  role = "admin";
  assert.equal((await call("GET", `/api/steam/accounts/${cloudId}/credentials`)).status, 403);
  assert.equal((await call("GET", "/api/steam/accounts")).status, 403);
  role = null;
  assert.equal((await call("GET", "/api/steam/accounts")).status, 401);
  assert.equal((await call("PATCH", `/api/steam/accounts/${cloudId}`, { notes: "x" })).status, 401);
});

test("edits: games, region, Steam ID, stage with soldAt", async () => {
  const { cloudId } = await importOne();
  const path = `/api/steam/accounts/${cloudId}`;

  let r = await call("PATCH", path, {
    storeCountry: "tr",
    steamId64: "76561199000000001",
    notes: "Turkish store checked",
    games: [
      { name: "  Portal   2 ", appId: "620", priceUsd: "9.99" },
      { name: "Hand-added game", appId: null, priceUsd: "" },
    ],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account.storeCountry, "TR");
  assert.equal(r.body.account.steamId64, "76561199000000001");
  assert.equal(r.body.account.gameCount, 2);
  assert.equal(r.body.account.games[0].name, "Portal 2");
  assert.equal(r.body.account.games[0].appId, 620);
  assert.equal(r.body.account.valueUsd, 9.99);
  assert.equal(r.body.account.loaded, true);

  r = await call("PATCH", path, { stage: "sold", soldNote: "Eldorado order 1" });
  assert.equal(r.body.account.stage, "sold");
  assert.ok(r.body.account.soldAt, "soldAt stamped");
  const soldAt = r.body.account.soldAt;
  r = await call("PATCH", path, { stage: "sold", notes: "still sold" });
  assert.equal(r.body.account.soldAt, soldAt, "saving again keeps the first sale time");
  r = await call("PATCH", path, { stage: "stock" });
  assert.equal(r.body.account.soldAt, null, "moving back clears the sale time");

  r = await call("PATCH", path, { storeCountry: null, steamId64: "" });
  assert.equal(r.body.account.storeCountry, null);
  assert.equal(r.body.account.steamId64, "");
});

test("edits are validated and cannot touch the login", async () => {
  const { cloudId } = await importOne();
  const path = `/api/steam/accounts/${cloudId}`;
  const bad = [
    [{ storeCountry: "Turkey" }, /two-letter/],
    [{ steamId64: "12345" }, /17-digit/],
    [{ stage: "deleted" }, /Unknown stage/],
    [{ games: "Portal" }, /list/],
    [{ games: [{ name: "" }] }, /name/],
    [{ games: [{ name: "A", appId: 1.5 }] }, /whole number/],
    [{ games: [{ name: "A", priceUsd: -1 }] }, /price/],
    [{ games: [{ name: "Portal 2", appId: 620 }, { name: "Portal Two", appId: 620 }] }, /twice/],
    [{ notes: "x".repeat(2001) }, /2000/],
    [{ password: "new", accountName: "hijack", email: "x@y.z" }, /Nothing to save/],
  ];
  for (const [body, msg] of bad) {
    const r = await call("PATCH", path, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.message, msg);
  }
  assert.equal((await call("PATCH", "/api/steam/accounts/not-an-id", { notes: "x" })).status, 400);
  assert.equal((await call("PATCH", "/api/steam/accounts/" + new mongoose.Types.ObjectId(), { notes: "x" })).status, 404);

  const creds = await call("GET", `${path}/credentials`);
  assert.equal(creds.body.accountName, "caoleduong8_22a1602e");
  assert.equal(creds.body.password, "s3cret-Pass!7aA");
});

test("Mac uploader sends the account on stdin and checks the server's answer", async () => {
  const { EventEmitter } = require("node:events");
  const { createSteamSshUploader, steamPayload } = require("../tools/steam-signup/cloud-sync.cjs");
  const account = {
    id: "0d6c5f0e-1b1b-4c1e-9d55-2f0a9c1e7b11", username: "caoleduong8_22a1602e", password: "pw", email: "x@outlook.com",
    country: "US", requestedCountry: "US", creationLocation: { country: "US", city: "Dallas", ip: "203.0.113.9" },
    contact: { phone: "+1 555", address: "fictional" }, completedAt: "2026-11-01T11:50:00.000Z",
  };
  const sent = steamPayload(account);
  assert.equal(sent.account.localId, account.id);
  assert.equal(sent.account.accountName, account.username);
  assert.equal(sent.account.proxyCity, "Dallas");
  assert.ok(!JSON.stringify(sent).includes("203.0.113.9"), "the proxy IP stays on the Mac");
  assert.ok(!JSON.stringify(sent).includes("fictional"), "sample contact details stay on the Mac");
  assert.doesNotThrow(() => validate(sent), "what the Mac sends is what the server accepts");

  function fakeSpawn(reply, code = 0) {
    const calls = [];
    const spawnProcess = (cmd, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      let input = "";
      child.stdin = { on() {}, end(text) { input = text; setImmediate(() => { child.stdout.emit("data", JSON.stringify(reply)); child.emit("close", code); }); } };
      child.kill = () => {};
      calls.push({ cmd, args, get input() { return input; } });
      return child;
    };
    return { spawnProcess, calls };
  }
  let fake = fakeSpawn({ success: true, localId: account.id, cloudId: "a".repeat(24) });
  const result = await createSteamSshUploader({ host: "deploy@server.example", remoteRoot: "/srv/app", spawnProcess: fake.spawnProcess })(account);
  assert.equal(result.cloudId, "a".repeat(24));
  assert.equal(fake.calls[0].cmd, "ssh");
  assert.match(fake.calls[0].args.at(-1), /^cd '\/srv\/app' && node tools\/steam-signup\/cloud-import\.cjs$/);
  assert.ok(fake.calls[0].args.includes("deploy@server.example"));
  assert.throws(() => createSteamSshUploader({ remoteRoot: "/srv/app" }), /host/);
  assert.throws(() => createSteamSshUploader({ host: "a@b", remoteRoot: "rel; rm" }), /remote path/);
  assert.ok(!fake.calls[0].args.join(" ").includes("pw"), "the password is never on the command line");
  assert.equal(JSON.parse(fake.calls[0].input).account.password, "pw");

  fake = fakeSpawn({ success: true, localId: "someone-else", cloudId: "a".repeat(24) });
  await assert.rejects(createSteamSshUploader({ host: "deploy@server.example", remoteRoot: "/srv/app", spawnProcess: fake.spawnProcess })(account), /unavailable/);
  fake = fakeSpawn({ success: false }, 1);
  await assert.rejects(createSteamSshUploader({ host: "deploy@server.example", remoteRoot: "/srv/app", spawnProcess: fake.spawnProcess })(account), /unavailable/);
});

test("Mac upload queue: uploads once, backs off on failure, recovers after a restart", async () => {
  const { CloudSync } = require("../tools/steam-signup/cloud-sync.cjs");
  let saves = 0;
  let clock = 1_000_000;
  const vault = { data: { accounts: [{ id: "a1" }, { id: "a2", cloud: { state: "uploading", attempts: 1 } }] }, save: () => saves++ };
  let fail = true;
  const uploaded = [];
  const sync = new CloudSync({
    vault,
    now: () => clock,
    upload: async (a) => {
      if (fail) throw new Error("down");
      uploaded.push(a.id);
      return { cloudId: "c-" + a.id };
    },
  });
  sync.start();
  sync.stop();
  assert.equal(vault.data.accounts[1].cloud.state, "pending", "a stuck upload goes back in the queue");
  await sync.runDue();
  assert.equal(vault.data.accounts[0].cloud.state, "pending");
  assert.match(vault.data.accounts[0].cloud.lastError, /queued for retry/);
  assert.ok(vault.data.accounts[0].cloud.nextAttemptAt > clock, "waits before the next try");

  fail = false;
  await sync.runDue();
  assert.deepEqual(uploaded, [], "nothing retried before its time");
  clock += 31 * 60 * 1000;
  await sync.runDue();
  assert.deepEqual(uploaded.sort(), ["a1", "a2"]);
  assert.equal(vault.data.accounts[0].cloud.state, "uploaded");
  assert.equal(vault.data.accounts[0].cloud.cloudId, "c-a1");

  sync.enqueue(vault.data.accounts[0], { force: true });
  await sync.runDue();
  assert.deepEqual(uploaded.sort(), ["a1", "a2"], "an uploaded account is never sent again");
  assert.ok(saves > 0);
});


test("licensed farm accounts are shown with games without exposing worker tokens", async () => {
  await importOne();
  const a = await SteamAccount.findOne();
  await SteamAccount.updateOne({ _id: a._id }, { $set: { stage: "boosting", boostedAt: new Date() } });
  await SteamBoost.create({ steamAccountId: a._id, state: "boosting", purpose: "game", games: [730], licensed: [730], refreshToken: encrypt("private-worker-token"), lastSeenAt: new Date() });
  const r = await call("GET", "/api/steam/accounts");
  assert.equal(r.status, 200);
  assert.equal(r.body.accounts[0].loaded, true);
  assert.equal(r.body.accounts[0].games[0].name, "Counter-Strike 2");
  assert.equal(r.body.summary.empty, 0);
  assert.equal(r.body.summary.availableEmpty, 0);
  assert.equal(r.body.summary.preparing, 1);
  assert.equal(r.body.summary.loaded, 1);
  assert.ok(!JSON.stringify(r.body).includes("private-worker-token"));
  assert.ok(!JSON.stringify(r.body).includes("refreshToken"));
});
