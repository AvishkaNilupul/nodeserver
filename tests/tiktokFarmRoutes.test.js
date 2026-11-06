const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Run = require("../models/TikTokFarmRun");
const { createRouter } = require("../routes/tiktokFarmRoutes");

test("isolates TikTok runs, encrypted codes, and event discovery across accounts", async (t) => {
  process.env.CRED_SECRET = "test-only credential encryption secret";
  const key = "a distinct test-only machine worker key";
  let clock = Date.now();
  const mongo = await MongoMemoryServer.create();
  t.after(async () => { await mongoose.disconnect(); await mongo.stop(); });
  await mongoose.connect(mongo.getUri());
  await Run.init();

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-test-superadmin"] === "1") req.session = { admin: { role: "superadmin", tfa: true } };
    next();
  });
  app.use(createRouter({ workerKey: () => key, now: () => clock }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = { admin: { "x-test-superadmin": "1" }, worker: { authorization: "Bearer " + key } };

  async function request(route, body, role) {
    const response = await fetch(base + "/api/tiktok-farm/" + route, {
      method: body === undefined ? "GET" : "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...auth[role] },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  }

  assert.equal((await request("state")).status, 401);
  assert.equal((await request("worker/poll", { account: "tiktok-01" })).status, 401);
  assert.equal((await request("start", {}, "admin")).status, 400);
  const accounts = ["tiktok-01", "tiktok-02"];
  const batch = { accounts, campaign: "123", room: "456", task: "789" };
  assert.equal((await request("start", batch, "admin")).status, 409);
  const poll = (account) => request("worker/poll", { account }, "worker");
  await Promise.all(accounts.map(poll));
  const starts = await Promise.all([request("start", batch, "admin"), request("start", batch, "admin")]);
  assert.equal(starts.flatMap((item) => item.results).filter((item) => item.queued).length, 2);
  const wrongId = await request("worker/poll", { account: accounts[0], jobId: "1".repeat(24) }, "worker");
  assert.equal(wrongId.job, null);
  const [first, second] = (await Promise.all(accounts.map(poll))).map(({ job }) => job);
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.lease, second.lease);

  const update = (job, data) => request("worker/update", { id: job.id, lease: job.lease, seconds: 60, ...data }, "worker");
  assert.equal((await update({ ...first, lease: second.lease }, { phase: "claiming" })).status, 409);
  assert.equal((await update(first, { status: "completed", code: "TEST-CODE-123" })).status, 409);
  assert.equal((await update(first, { phase: "claiming" })).status, 200);
  assert.equal((await request("runs/" + first.id + "/stop", {}, "admin")).status, 409);
  assert.equal((await request("runs/" + second.id + "/stop", {}, "admin")).status, 200);
  assert.equal((await update(second, { phase: "watching" })).stop, true);
  assert.equal((await update(second, { phase: "claiming" })).status, 409);
  assert.equal((await update(second, { status: "cancelled" })).status, 200);
  assert.equal((await update(first, { status: "completed", code: "TEST-CODE-123" })).status, 200);
  assert.equal((await update(first, { status: "completed", code: "TEST-CODE-123" })).status, 200);

  const state = await request("state", undefined, "admin");
  assert.equal(state.codes.length, 1);
  assert.equal(JSON.stringify(state).includes("TEST-CODE-123"), false);
  assert.equal(JSON.stringify(state).includes(first.lease), false);
  assert.match((await Run.findById(first.id).select("+code").lean()).code, /^enc:v1:/);
  assert.equal((await request("codes/" + first.id)).status, 401);
  assert.equal((await request("codes/" + first.id, undefined, "admin")).code, "TEST-CODE-123");
  const retry = await request("start", batch, "admin");
  assert.deepEqual(retry.results.map(({ queued }) => queued), [false, true]);
  const renewed = (await poll("tiktok-02")).job;
  assert.equal((await update(renewed, { phase: "claiming" })).status, 200);
  clock += 61_000;
  assert.equal((await request("state", undefined, "admin")).runs.find((r) => r._id === renewed.id).state, "review");
  assert.equal((await update(renewed, { status: "completed", code: "TEST-CODE-456" })).status, 200);

  const scannerPoll = (account) => request("worker/poll", { account, scanCapable: true }, "worker");
  await Promise.all(accounts.map(scannerPoll));
  const scan = await request("scan", { accounts, auto: true }, "admin");
  assert.deepEqual(scan.results.map(({ scanning }) => scanning), [true, true]);
  const [firstScan, secondScan] = (await Promise.all(accounts.map(scannerPoll))).map((value) => value.scan);
  assert.notEqual(firstScan.id, secondScan.id);
  assert.equal(firstScan.room, batch.room);
  assert.equal((await scannerPoll(accounts[0])).scan, undefined);
  const event = (campaign, room, task, remaining) => ({ campaign, room, task, remaining,
    name: "Campaign " + campaign, anchor: "500", duration: 60 });
  const alreadyStored = event(batch.campaign, batch.room, batch.task, 0);
  const slower = event("124", "600", "200", 45);
  const faster = event("125", "700", "300", 20);
  const secondOnly = event("126", "800", "400", 10);
  const report = (account, id, events) => request("worker/catalog", { account, id, events }, "worker");
  assert.equal((await report(accounts[1], firstScan.id, [secondOnly])).status, 409);
  assert.equal((await report(accounts[0], firstScan.id, [{ ...faster, remaining: 61 }])).status, 400);
  assert.equal((await report(accounts[0], firstScan.id, [slower, faster, alreadyStored])).status, 200);
  assert.equal((await report(accounts[1], secondScan.id, [secondOnly, alreadyStored])).status, 200);
  assert.equal((await report(accounts[0], firstScan.id, [slower])).status, 409);
  const autoState = await request("state", undefined, "admin");
  assert.equal(autoState.accounts.find(({ account }) => account === accounts[0]).catalog.result.event, faster.name);
  const jobs = (await Promise.all(accounts.map(scannerPoll))).map(({ job }) => job);
  assert.deepEqual(jobs.map(({ campaign, room, anchor }) => ({ campaign, room, anchor })),
    [faster, secondOnly].map(({ campaign, room, anchor }) => ({ campaign, room, anchor })));
  const busy = await request("scan", { accounts, auto: true }, "admin");
  assert.deepEqual(busy.results.map(({ reason }) => reason), ["Worker busy", "Worker busy"]);
});
