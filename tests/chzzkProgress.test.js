// Pins the 2026-10-23 "false done" fix: utils/chzzk/progress.js decides what
// is earned from challenges() AND claims(); the worker never marks a campaign
// done before CHZZK has credited it; the farm only trusts a VERIFIED mark.
// No network: the §14 fake (which, like real CHZZK, lists a campaign in
// challenges() only once a whole minute is credited) + MongoMemoryServer.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "chzzk-progress-test-cred-secret";

const { progressOf } = require("../utils/chzzk/progress");
const worker = require("../utils/chzzk/worker");
const { createFakeChzzk } = require("./helpers/chzzkFake");
const ChzzkAccount = require("../models/ChzzkAccount");
const { encrypt } = require("../utils/secretBox");
const { Farm } = require("../utils/chzzkFarm");

const BASE_NOW = Date.parse("2026-10-25T03:00:00Z");
const TIMINGS = {
  tickMs: 10, heartbeatMs: 10, statusMs: 20, challengesMs: 30,
  idlePollMs: 50, egressWaitMs: 20, precheckMs: 1000,
  streamBackoffMs: 400, campaignBackoffMs: 400,
  noCreditReads: 3, badStreamsPerCampaign: 3,
};

const reward = (rewardNo, minutes, extra = {}) => ({
  rewardNo, title: "R" + rewardNo, rewardType: "CODE_FIRST_COME", minutes, remaining: 100, ...extra,
});
const camp = (rewards, extra = {}) => ({ campaignNo: 7, title: "Seven", rewards, ...extra });
const ch = (rewardNo, accum, cond, status = "IN_PROGRESS") => ({
  campaignNo: 7, rewardNo, accumWatchMinutes: accum, conditionForMinutes: cond, challengeStatus: status,
});
const cl = (rewardNo) => ({ campaignNo: 7, rewardNo, fulfillmentState: "COMPLIED" });

// ------------------------------------------------------------ progressOf

test("progressOf: a campaign in neither list is not started, never done", () => {
  const p = progressOf(camp([reward(1, 15), reward(2, 180)]), [], []);
  assert.equal(p.done, false);
  assert.equal(p.listed, false);
  assert.equal(p.minutes, 0);
  assert.deepEqual(p.states, { 1: "not_started", 2: "not_started" });
  assert.equal(p.next, 15);
});

test("progressOf: claimed rewards finish; working ones keep the campaign open", () => {
  const p = progressOf(camp([reward(1, 15), reward(2, 30), reward(3, 45)]), [ch(3, 31, 45)], [cl(1), cl(2)]);
  assert.deepEqual(p.states, { 1: "claimed", 2: "claimed", 3: "working" });
  assert.equal(p.minutes, 31);
  assert.equal(p.done, false);
  assert.equal(p.next, 45);
  const all = progressOf(camp([reward(1, 15), reward(2, 30), reward(3, 45)]), [], [cl(1), cl(2), cl(3)]);
  assert.equal(all.done, true);
  assert.equal(all.minutes, 45, "an earned reward proves its minutes");
});

test("progressOf: lottery waiting for its draw, or past its minutes, counts as reached", () => {
  const lot = reward(1, 180, { rewardType: "CODE_LOTTERY", remaining: null });
  assert.equal(progressOf(camp([lot]), [ch(1, 180, 180, "DRAWING_WAITING")], []).done, true);
  assert.equal(progressOf(camp([lot]), [ch(1, 180, 180, "NOT_WON")], []).states[1], "reached");
  assert.equal(progressOf(camp([reward(1, 30)]), [ch(1, 30, 30)], []).states[1], "reached");
});

test("progressOf: gone from both lists counts only once the minutes are past it", () => {
  const c = camp([reward(1, 15), reward(2, 60)]);
  const early = progressOf(c, [ch(2, 10, 60)], []);
  assert.equal(early.states[1], "not_started", "10 min < 15: still to earn");
  const late = progressOf(c, [ch(2, 20, 60)], []);
  assert.equal(late.states[1], "passed", "20 min > 15 and no longer listed");
  const floor = progressOf(c, [], [], { floorMinutes: 61 });
  assert.equal(floor.done, true, "earlier real reads raise the floor");
});

test("progressOf: unknown statuses are reported, not counted; IN_APP and sold-out never count", () => {
  const p = progressOf(camp([reward(1, 15), reward(2, 30, { remaining: 0 }), { rewardNo: 3, rewardType: "IN_APP", minutes: 5 }]),
    [ch(1, 3, 15, "MYSTERY")], []);
  assert.deepEqual(p.unknown, [{ rewardNo: 1, status: "MYSTERY" }]);
  assert.equal(p.states[1], "working");
  assert.equal(p.total, 1, "sold-out unearned + IN_APP are out");
  const soldOutButOurs = progressOf(camp([reward(2, 30, { remaining: 0 })]), [], [cl(2)]);
  assert.equal(soldOutButOurs.done, true, "an earned reward still counts after the pool ran out");
});

// ------------------------------------------------------------ worker

function makeClock(start = BASE_NOW) {
  const s = { t: start };
  return { now: () => s.t, async sleep(ms, signal) { s.t += Math.max(1, Math.round(ms)); if (signal && signal.aborted) throw new worker.AbortError(); }, get t() { return s.t; } };
}
function makeStore(campaigns) {
  const marked = new Map();
  return {
    marked,
    async list() { return campaigns.map((c) => ({ ...c, rewards: c.rewards.map((r) => ({ ...r })) })); },
    async campaign(no) { const c = campaigns.find((x) => x.campaignNo === no); return c ? { ...c, rewards: c.rewards.map((r) => ({ ...r })) } : null; },
    markFarmed(acc, no, info) { marked.set(acc + "|" + no, info); },
    isDone(acc, no) { return marked.has(acc + "|" + no); },
  };
}
const storeCamp = (rewards) => ({
  campaignNo: 99, title: "KEL Finals", categoryType: "GAME", categoryId: "cat-1",
  enabled: true, needsLink: false, state: "PROMOTED",
  startAt: new Date(BASE_NOW - 86_400_000), endAt: new Date(BASE_NOW + 7 * 86_400_000), rewards,
});
const rawCamp = (rewardList) => ({
  campaignNo: 99, title: "KEL Finals", categoryType: "GAME", categoryId: "cat-1", categoryValue: "ER",
  state: "PROMOTED", startDate: "2026-10-23 00:00:00", endDate: "2026-10-30 23:59:59", rewardList,
});
const live = (channelId) => ({
  channelId, channelName: "ch-" + channelId, liveId: 1234, categoryType: "GAME", categoryId: "cat-1",
  dropsCampaignNo: 99, viewers: 100, status: "OPEN", openDate: "2026-10-25 10:00:00", liveTokens: ["t"],
});
const account = { _id: "acc1", nickname: "nick-acc1" };

test("worker: a campaign CHZZK has not credited yet is never marked done (the 2026-10-23 bug)", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 10,
    campaigns: [rawCamp([{ rewardNo: 1, title: "A", rewardType: "CODE_FIRST_COME", conditionForMinutes: 15, codeRemainingCount: 100 },
      { rewardNo: 2, title: "B", rewardType: "CODE_FIRST_COME", conditionForMinutes: 180, codeRemainingCount: 100 }])],
    lives: [live("A")],
  });
  fake.noCredit("A");
  const store = makeStore([storeCamp([reward(1, 15), reward(2, 180)])]);
  const logs = [];
  const ac = new AbortController();
  const res = await worker.runSession({
    account, client: fake.clientFor("acc1"), campaigns: store,
    pickStream: () => ({ channelId: "A", channelName: "ch-A" }),
    onEvent: (e) => { if (e.state === "idle") ac.abort(); },
    onLog: (e) => logs.push(e),
    signal: ac.signal, clock, timings: TIMINGS,
  });
  assert.equal(res.reason, "abort");
  assert.equal(store.marked.size, 0, "nothing was earned, so nothing is done");
  assert.ok(logs.some((l) => /did not credit/.test(l.msg)), "the reason for leaving is logged");
  assert.ok(logs.some((l) => /^Resting "KEL Finals"/.test(l.msg)), "the rest is logged once the strikes add up");
  assert.ok(logs.every((l) => !/FAKE-/.test(l.msg)), "no code in a log line");
});

test("worker: a campaign already earned on this login is skipped without watching", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 20,
    campaigns: [rawCamp([{ rewardNo: 1, title: "A", rewardType: "CODE_FIRST_COME", conditionForMinutes: 15, codeRemainingCount: 100 }])],
    lives: [live("A")],
  });
  // Earn it before the worker starts (as the probe did on the real account).
  await fake.clientFor("acc1").watchEvent({ channelId: "A", liveId: 1234, type: "WATCH_CONTINUED", sessionId: "s", positionAt: 1, awt: 30, liveTokens: [] });
  const before = fake.calls.length;
  const store = makeStore([storeCamp([reward(1, 15)])]);
  const logs = [];
  const ac = new AbortController();
  await worker.runSession({
    account, client: fake.clientFor("acc1"), campaigns: store,
    pickStream: () => ({ channelId: "A", channelName: "ch-A" }),
    onEvent: (e) => { if (e.state === "idle") ac.abort(); },
    onLog: (e) => logs.push(e),
    signal: ac.signal, clock, timings: TIMINGS,
  });
  const after = fake.calls.slice(before);
  assert.equal(after.filter((c) => c.method === "watchEvent").length, 0, "no heartbeat at all");
  assert.deepEqual(store.marked.get("acc1|99").states, { 1: "claimed" });
  assert.ok(logs.some((l) => /already earned/.test(l.msg)));
});

test("worker: a credited campaign finishes only when CHZZK lists every reward as earned", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 5,
    campaigns: [rawCamp([{ rewardNo: 1, title: "A", rewardType: "CODE_FIRST_COME", conditionForMinutes: 15, codeRemainingCount: 100 },
      { rewardNo: 2, title: "B", rewardType: "CODE_FIRST_COME", conditionForMinutes: 40, codeRemainingCount: 100 }])],
    lives: [live("A")],
  });
  const store = makeStore([storeCamp([reward(1, 15), reward(2, 40)])]);
  const events = [];
  let earned = 0;
  const ac = new AbortController();
  await worker.runSession({
    account, client: fake.clientFor("acc1"), campaigns: store,
    pickStream: () => ({ channelId: "A", channelName: "ch-A" }),
    onEvent: (e) => { events.push(e); if (e.state === "idle") ac.abort(); },
    onEarned: () => { earned++; },
    signal: ac.signal, clock, timings: TIMINGS,
  });
  assert.ok(store.marked.has("acc1|99"));
  assert.ok(fake.minutes("acc1", 99) >= 40, "watched until the last reward");
  assert.ok(earned >= 1, "the collector was asked for codes");
  const w = events.filter((e) => e.state === "watching");
  assert.ok(w.some((e) => e.needed === 40), "the next reward's minutes are shown");
  assert.ok(w.every((e) => "credited" in e && "watched" in e));
});

// ------------------------------------------------------------ farm

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ChzzkAccount.init();
});
test.after(async () => { await mongoose.disconnect(); await mongod.stop(); });

function farmWith(capture) {
  const activity = { entries: [], add(e) { this.entries.push(e); }, async list() { return []; } };
  const farm = new Farm({
    activity,
    settings: { getAutoFarm: () => ({}), async setAutoFarm() {} },
    telegram: { sendTelegram: async () => true },
    timers: { set: () => 0, interval: () => 0, clear() {} },
    transport: { ready: true, describe: () => "test" },
    makeClient: () => ({}),
    createCollector: () => ({ collect: async () => ({}), sweep: async () => [], reveal: async () => null, pending: () => 0 }),
    runSession: (opts) => { capture.opts = opts; return new Promise(() => {}); },
  });
  return { farm, activity };
}

test("farm: only a verified done mark is trusted; markFarmed writes one; logs land on the account", async () => {
  const acc = await ChzzkAccount.create({
    userIdHash: "h1", nickname: "n1", cookies: encrypt("[]"), status: "ok",
    progress: { 1954: { minutes: 180, done: true }, 1987: { minutes: 45, done: true, verified: true } },
  });
  const cap = {};
  const { farm, activity } = farmWith(cap);
  farm._spawnWorker(acc.toObject());
  const store = cap.opts.campaigns;
  assert.equal(store.isDone(acc._id, 1954), false, "v1 mark without verified is re-checked");
  assert.equal(store.isDone(acc._id, 1987), true);

  store.markFarmed(String(acc._id), 1954, { minutes: 185, states: { 5089: "claimed" } });
  cap.opts.onProgress({ campaignNo: 1981, minutes: 2, states: { 5133: "working" }, done: false, next: 30 });
  cap.opts.onLog({ level: "warn", kind: "watch", campaignNo: 1981, msg: "Left x after 9 min" });
  await new Promise((r) => setTimeout(r, 50));
  const row = await ChzzkAccount.findById(acc._id).lean();
  assert.equal(row.progress[1954].verified, true);
  assert.equal(row.progress[1954].minutes, 185);
  assert.equal(row.progress[1981].next, 30);
  assert.equal(row.progress[1981].done, false);
  assert.equal(row.progress[1987].verified, true, "other campaigns untouched");
  assert.equal(store.isDone(acc._id, 1954), true);
  const e = activity.entries.find((x) => x.kind === "watch");
  assert.equal(e.accountId, String(acc._id));
  assert.equal(e.campaignNo, 1981);
});
