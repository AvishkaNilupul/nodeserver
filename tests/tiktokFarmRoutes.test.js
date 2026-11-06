const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Run = require("../models/TikTokFarmRun");
const Schedule = require("../models/TikTokFarmSchedule");
const { createRouter } = require("../routes/tiktokFarmRoutes");

test("isolates TikTok runs, encrypted codes, and event discovery across accounts", async (t) => {
  process.env.CRED_SECRET = "test-only credential encryption secret";
  const key = "a distinct test-only machine worker key";
  const setupKey = "a separate test-only setup worker key";
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
  const routerOptions = { workerKey: () => key, setupKey: () => setupKey, now: () => clock };
  app.use("/restarted", createRouter(routerOptions));
  app.use(createRouter(routerOptions));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port;
  const auth = { admin: { "x-test-superadmin": "1" }, worker: { authorization: "Bearer " + key },
    setup: { authorization: "Bearer " + setupKey } };

  async function request(route, body, role, instance = "") {
    const response = await fetch(base + instance + "/api/tiktok-farm/" + route, {
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
  const loginPath = "accounts/tiktok-04/credentials";
  const login = { username: "sample-login@example.test", password: "test only password" };
  assert.equal((await request(loginPath, { credential: login }, "worker")).status, 401);
  assert.equal((await request(loginPath, { credential: login }, "admin")).status, 200);
  const record = await Schedule.findOne({ account: "tiktok-04" }).select("+credentials").lean();
  assert.match(record.credentials, /^enc:v1:/);
  const accountState = await request("state", undefined, "admin");
  assert(accountState.accounts.find((row) => row.account === "tiktok-04").credentialsSavedAt);
  assert(!JSON.stringify(accountState).includes(login.username));
  assert(!JSON.stringify(accountState).includes(login.password));
  assert.deepEqual(await request(loginPath, undefined, "admin"), { status: 200, ...login });
  const newSlot = "tiktok-05";
  const setupPath = "accounts/" + newSlot + "/setup";
  assert.equal((await request("accounts/tiktok-01/setup", { credential: login }, "admin")).status, 400);
  assert.equal((await request(setupPath, { credential: login }, "admin")).status, 202);
  assert.equal((await request(setupPath, { credential: login }, "admin")).status, 409);
  assert.equal((await request("worker/setup/poll", {}, "worker")).status, 401);
  const localJob = (await request("worker/setup/poll", {}, "setup")).job;
  assert.equal(localJob.account, newSlot);
  assert.deepEqual(localJob.credential, login);
  const progress = (job, state, reason) => request("worker/setup/update", {
    account: job.account, lease: job.lease, serial: "emulator-5570", state, reason,
    ...(state === "ready" && { handle: "@fixture.user" }),
  }, "setup");
  assert.equal((await progress(localJob, "attention", "verification-required")).status, 200);
  assert.equal((await progress(localJob, "ready")).status, 409);
  const setupState = await request("state", undefined, "admin");
  const onboarding = setupState.accounts.find(({ account }) => account === newSlot).setup;
  assert.equal(onboarding.state, "attention");
  assert.deepEqual(onboarding.log.map(({ state }) => state), ["queued", "booting", "attention"]);
  assert(!JSON.stringify(setupState).includes(localJob.lease));
  assert(!JSON.stringify(setupState).includes(login.password));
  assert.equal((await request(setupPath + "/resume", {}, "admin")).status, 202);
  const resumedSetup = (await request("worker/setup/poll", {}, "setup")).job;
  assert.notEqual(resumedSetup.lease, localJob.lease);
  assert.equal((await progress(resumedSetup, "registering")).status, 200);
  assert.equal((await progress(resumedSetup, "ready")).status, 200);
  const readyAccount = (await request("state", undefined, "admin")).accounts.find(({ account }) => account === newSlot);
  assert(readyAccount.automation.enabled);
  assert.equal(readyAccount.setup.state, "ready");
  assert.equal(readyAccount.setup.handle, "@fixture.user");
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
  const report = (account, id, events, extra) => request("worker/catalog", { account, id, events, ...extra }, "worker");
  assert.equal((await report(accounts[1], firstScan.id, [secondOnly])).status, 409);
  assert.equal((await report(accounts[0], firstScan.id, [{ ...faster, remaining: 61 }])).status, 400);
  const upcoming = [{ campaign: "130", name: "Upcoming only", game: "Rocket League", startsAt: clock + 600_000 }];
  const campaigns = [{ campaign: "129", name: "Ends soon", game: "Fixture game",
    endsAt: clock + 3600_000, status: "no-live-room", otherTasks: true, watchSeconds: [3600] }];
  const longWatch = { ...event("131", "810", "410", 3600), duration: 3600 };
  assert.equal((await report(accounts[0], firstScan.id, [], { upcoming: [{ ...upcoming[0], startsAt: -1 }] })).status, 400);
  assert.equal((await report(accounts[0], firstScan.id, [], {
    campaigns: [{ ...campaigns[0], status: "unknown" }],
  })).status, 400);
  assert.equal((await report(accounts[0], firstScan.id, [slower, faster, alreadyStored, longWatch], {
    upcoming, campaigns, partial: true, apiRoute: "phone",
  })).status, 200);
  assert.equal((await report(accounts[1], secondScan.id, [secondOnly, alreadyStored])).status, 200);
  assert.equal((await report(accounts[0], firstScan.id, [slower])).status, 409);
  const autoState = await request("state", undefined, "admin");
  const firstState = autoState.accounts.find(({ account }) => account === accounts[0]);
  assert.equal(firstState.catalog.result.event, faster.name);
  assert.equal(firstState.apiRoute, "phone");
  assert.deepEqual(firstState.upcoming, upcoming);
  assert.deepEqual(firstState.catalog.campaigns, campaigns);
  assert.equal(firstState.catalog.partial, true);
  assert(firstState.catalog.events.some(({ duration }) => duration === 3600));
  const jobs = (await Promise.all(accounts.map(scannerPoll))).map(({ job }) => job);
  assert.deepEqual(jobs.map(({ campaign, room, anchor }) => ({ campaign, room, anchor })),
    [faster, secondOnly].map(({ campaign, room, anchor }) => ({ campaign, room, anchor })));
  const busy = await request("scan", { accounts, auto: true }, "admin");
  assert.deepEqual(busy.results.map(({ reason }) => reason), ["Worker busy", "Worker busy"]);

  const scheduled = "tiktok-03";
  const toggle = (enabled, instance, role = "admin") =>
    request("automation", { accounts: [scheduled], enabled }, role, instance);
  const background = (route, body, role = "worker") => request(route, body, role, "/restarted");
  const tick = () => background("worker/poll", { account: scheduled, scanCapable: true });
  assert.equal((await toggle(true, "", "worker")).status, 401);
  assert.equal((await toggle(true, "")).results[0].reason, "Scanner unavailable");
  await scannerPoll(scheduled);
  assert.equal((await toggle(true, "")).results[0].enabled, true);
  const offline = (await background("state", undefined, "admin")).accounts.find(({ account }) => account === scheduled);
  assert.equal(offline.automation.enabled, true);
  assert.equal(offline.online, false);
  const backgroundScans = (await Promise.all([tick(), tick()])).map((result) => result.scan).filter(Boolean);
  assert.equal(backgroundScans.length, 1);
  assert.equal(backgroundScans[0].room, batch.room);
  const catalogReport = (scan, events) => background("worker/catalog", { account: scheduled, id: scan.id, events });
  const expiresSoon = { ...faster, endsAt: clock + 120_000 };
  const cannotFinish = { ...secondOnly, endsAt: clock + 5_000 };
  assert.equal((await catalogReport(backgroundScans[0], [slower, expiresSoon, cannotFinish])).status, 200);
  const backgroundJob = (await tick()).job;
  assert.equal(backgroundJob.task, faster.task);
  assert.equal(backgroundJob.automatic, true);
  assert.equal((await update(backgroundJob, { status: "failed", phase: "capture-timeout", seconds: 0 })).status, 200);
  const timedOut = await Run.findById(backgroundJob.id).lean();
  assert.equal(timedOut.phase, "capture-timeout");
  assert.equal(timedOut.active, false);
  assert.equal((await tick()).scan, undefined);
  clock += 10 * 60_000;
  const nextScan = (await tick()).scan;
  assert.equal((await catalogReport(nextScan, [faster, slower])).status, 200);
  const queued = await Run.findOne({ account: scheduled, state: "queued" }).lean();
  assert.equal(queued.task, slower.task);
  assert.equal((await background("runs/" + queued._id + "/stop", {}, "admin")).status, 200);
  clock += 10 * 60_000;
  const interrupted = (await tick()).scan;
  assert.equal((await toggle(false, "/restarted")).results[0].enabled, false);
  assert.equal((await catalogReport(interrupted, [faster, slower])).status, 409);
  clock += 10 * 60_000;
  assert.equal((await tick()).scan, undefined);

  assert.equal((await toggle(true, "/restarted")).results[0].enabled, true);
  const failScan = (scan) => background("worker/catalog", {
    account: scheduled, id: scan.id, events: [], error: "scan-failed",
  });
  assert.equal((await failScan((await tick()).scan)).status, 200);
  const retryAt = await Schedule.findOne({ account: scheduled }).select("nextScanAt").lean();
  assert.equal(+retryAt.nextScanAt, clock + 2 * 60_000);
  clock += 2 * 60_000;
  assert.equal((await failScan((await tick()).scan)).status, 200);
  const backoff = await Schedule.findOne({ account: scheduled }).select("nextScanAt").lean();
  assert.equal(+backoff.nextScanAt, clock + 10 * 60_000);
});
