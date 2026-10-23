// Pins §9 of docs/CHZZK-FARM.md — the per-account watch loop in
// utils/chzzk/worker.js — against the §14 fake. No network, no real timers:
// a deterministic clock advances time only on sleep(), and the campaigns
// store is a plain in-memory object (no Mongoose). Tests that need
// markFarmed to fire line the fake's `conditionForMinutes` up with the
// campaigns-store's `minutes`, so the fake earns the reward (moves it off
// challenges() → claims) and the worker's `earnedRewardNos` catches the
// transition. Tests that need the session to run forever leave the default
// high condMinutes so no reward ever earns.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const worker = require("../utils/chzzk/worker");
const { createFakeChzzk } = require("./helpers/chzzkFake");
const { ChzzkError } = require("../utils/chzzk/errors");

const BASE_NOW = Date.parse("2026-10-25T03:00:00Z"); // 2026-10-25 12:00:00 KST

// Beat every tick; status every 2nd tick; challenges every 3rd.
const TIMINGS = {
  tickMs: 10, heartbeatMs: 10, statusMs: 20, challengesMs: 30,
  idlePollMs: 50, egressWaitMs: 20,
  streamBackoffMs: 400, campaignBackoffMs: 400,
  noCreditReads: 3, badStreamsPerCampaign: 3,
};

// -------------------------------------------------------------- helpers

function makeClock(start = BASE_NOW) {
  const s = { t: start };
  return {
    now: () => s.t,
    async sleep(ms, signal) {
      s.t += Math.max(1, Math.round(ms));
      if (signal && signal.aborted) throw new worker.AbortError();
    },
    get t() { return s.t; },
  };
}

function cloneCamp(c) {
  return {
    ...c,
    startAt: c.startAt instanceof Date ? new Date(c.startAt.getTime()) : c.startAt,
    endAt: c.endAt instanceof Date ? new Date(c.endAt.getTime()) : c.endAt,
    rewards: (c.rewards || []).map((r) => ({ ...r })),
  };
}

function makeStore(campaigns = []) {
  const marked = new Set();
  return {
    marked,
    async list() { return campaigns.map(cloneCamp); },
    async campaign(no) {
      const c = campaigns.find((x) => x.campaignNo === no);
      return c ? cloneCamp(c) : null;
    },
    markFarmed(acc, no) { marked.add(acc + "|" + no); },
    isDone(acc, no) { return marked.has(acc + "|" + no); },
  };
}

function normCampaign({ campaignNo = 99, title = "KEL Finals", rewards = [] } = {}) {
  return {
    campaignNo, title,
    categoryType: "GAME", categoryId: "cat-1", categoryValue: "Eternal Return",
    enabled: true, needsLink: false, state: "PROMOTED",
    startAt: new Date(BASE_NOW - 86_400_000),
    endAt: new Date(BASE_NOW + 7 * 86_400_000),
    rewards: rewards.map((r) => ({ ...r })),
  };
}

function fakeCampRaw({ condMinutes = 10_000_000 } = {}) {
  return {
    campaignNo: 99, title: "KEL Finals",
    categoryType: "GAME", categoryId: "cat-1", categoryValue: "Eternal Return",
    state: "PROMOTED",
    startDate: "2026-10-23 00:00:00", endDate: "2026-10-30 23:59:59",
    rewardList: [{
      rewardNo: 1, title: "KEL15", rewardType: "CODE_LOTTERY",
      conditionForMinutes: condMinutes, codeRemainingCount: null,
    }],
  };
}

function fakeLive(channelId, { viewers = 1000, dropsCampaignNo = 99, extra = {} } = {}) {
  return {
    channelId, channelName: "ch-" + channelId,
    liveId: 1000 + channelId.charCodeAt(channelId.length - 1),
    categoryType: "GAME", categoryId: "cat-1", dropsCampaignNo,
    viewers, status: "OPEN", openDate: "2026-10-25 10:00:00",
    liveTokens: ["tok-" + channelId], ...extra,
  };
}

const dummyAccount = () => ({ _id: "acc1", id: "acc1", nickname: "nick-acc1" });

function countWatchEvent(fake, type) {
  return fake.calls.filter(
    (c) => c.method === "watchEvent" && c.args[0] && c.args[0].type === type,
  ).length;
}

// Rewards used in a few tests.
const lotteryReward = (minutes) => ({
  rewardNo: 1, title: "KEL15", rewardType: "CODE_LOTTERY", minutes, remaining: null,
});
const firstComeReward = (minutes) => ({
  rewardNo: 1, title: "KEL15", rewardType: "CODE_FIRST_COME", minutes, remaining: 100,
});

// ----------------------------------------------------------------- Test 1

test("idle when no farmable campaign; aborts cleanly after a few idle ticks", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({ now: () => clock.t, minutesPerBeat: 10 });
  const store = makeStore([]);
  const ac = new AbortController();
  const events = [];
  let idleCount = 0;

  const res = await worker.runSession({
    account: dummyAccount(),
    client: fake.clientFor("acc1"),
    campaigns: store,
    pickStream: () => ({ channelId: "x", channelName: "x" }),
    onEvent: (ev) => {
      events.push(ev);
      if (ev.state === "idle" && ++idleCount >= 3) ac.abort();
    },
    signal: ac.signal, clock, timings: TIMINGS,
  });

  assert.equal(res.reason, "abort");
  for (const e of events) assert.equal(e.state, "idle", "only idle events");
  assert.ok(idleCount >= 3, "at least three idle emits");
  const noisy = fake.calls.filter((c) =>
    c.method === "watchEvent" || c.method === "challenges" || c.method === "liveStatus",
  );
  assert.deepEqual(noisy, [], "no stream traffic while idle");
});

// ----------------------------------------------------------------- Test 2

test("happy path: WATCH_STARTED, growing accumWatchMinutes, markFarmed, exactly one WATCH_ENDED", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 10,
    campaigns: [fakeCampRaw({ condMinutes: 50 })],
    lives: [fakeLive("A", { viewers: 5000 })],
  });
  const store = makeStore([normCampaign({ rewards: [lotteryReward(50)] })]);
  const ac = new AbortController();
  const events = [];
  const progress = [];

  const res = await worker.runSession({
    account: dummyAccount(),
    client: fake.clientFor("acc1"),
    campaigns: store,
    pickStream: () => ({ channelId: "A", channelName: "ch-A" }),
    onEvent: (ev) => {
      events.push(ev);
      if (ev.state === "idle" && store.marked.has("acc1|99")) ac.abort();
    },
    onProgress: (p) => progress.push(p),
    signal: ac.signal, clock, timings: TIMINGS,
  });

  assert.equal(res.reason, "abort");
  assert.ok(store.marked.has("acc1|99"), "markFarmed(acc1, 99) called");
  assert.equal(countWatchEvent(fake, "WATCH_STARTED"), 1, "one WATCH_STARTED");
  assert.equal(countWatchEvent(fake, "WATCH_ENDED"), 1, "exactly one WATCH_ENDED per stream");
  assert.ok(countWatchEvent(fake, "WATCH_CONTINUED") >= 3, "several WATCH_CONTINUED beats");

  const watching = events.find((e) => e.state === "watching");
  assert.ok(watching, "a watching event was emitted");
  for (const k of ["state", "campaignNo", "title", "channelId", "channelName", "since", "minutes", "note"]) {
    assert.ok(k in watching, `onEvent payload has ${k}`);
  }
  assert.equal(watching.channelId, "A");
  assert.equal(watching.campaignNo, 99);
  assert.equal(watching.title, "KEL Finals");

  assert.ok(progress.length >= 1, "onProgress fired at least once");
  const p = progress[progress.length - 1];
  for (const k of ["campaignNo", "rewardNo", "minutes", "done"]) {
    assert.ok(k in p, `onProgress payload has ${k}`);
  }
  assert.equal(p.campaignNo, 99);
  assert.equal(p.rewardNo, 1);
  assert.equal(p.done, true);

  // Challenges show increasing accumWatchMinutes across reads.
  const minutesSeen = events.filter((e) => e.state === "watching").map((e) => e.minutes);
  assert.ok(minutesSeen[minutesSeen.length - 1] >= 50, "minutes reached the threshold");
});

// ----------------------------------------------------------------- Test 3

test("3 bad streams in a row -> campaign backs off and worker goes idle", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 10,
    campaigns: [fakeCampRaw()],
    lives: [
      fakeLive("A", { extra: { status: "CLOSE" } }),      // not OPEN
      fakeLive("B", { dropsCampaignNo: 7 }),              // mismatch
      fakeLive("C", { extra: { krOnly: true } }),         // kr-only
    ],
  });
  const store = makeStore([normCampaign({ rewards: [lotteryReward(50)] })]);
  const ac = new AbortController();
  const picks = ["A", "B", "C", "A", "B", "C"];
  let i = 0;
  const events = [];

  const res = await worker.runSession({
    account: dummyAccount(),
    client: fake.clientFor("acc1"),
    campaigns: store,
    pickStream: () => {
      const ch = picks[i++ % picks.length];
      return { channelId: ch, channelName: "ch-" + ch };
    },
    onEvent: (ev) => {
      events.push(ev);
      if (ev.state === "idle") ac.abort();
    },
    signal: ac.signal, clock, timings: TIMINGS,
  });

  assert.equal(res.reason, "abort");
  assert.equal(store.marked.size, 0, "no campaign marked farmed");
  // After 3 strikes the campaign is backed off, so pickCampaign returns null
  // and the worker emits idle — proven by reaching the abort guard above.
  assert.ok(events.some((e) => e.state === "idle"), "worker reached idle after backoff");
  // Each strike was from a bad liveStatus — no WATCH_STARTED on a bad stream.
  // (The worker short-circuits before emitting watching or starting a beat.)
  assert.equal(countWatchEvent(fake, "WATCH_STARTED"), 0, "no beats on bad streams");
  // Prevent unused-import lints.
  void ChzzkError;
});

// ----------------------------------------------------------------- Test 4

test("not crediting after 3 flat challenges reads -> stream bad + campaign bumped", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 10,
    campaigns: [fakeCampRaw()],
    lives: [fakeLive("A", { viewers: 5000 })],
  });
  fake.noCredit("A"); // WATCH_CONTINUED on A never credits minutes

  // Alt streams close so the backoff strikes fast after we leave A.
  fake.addLive(fakeLive("A2", { viewers: 400, extra: { status: "CLOSE" } }));
  fake.addLive(fakeLive("A3", { viewers: 300, extra: { status: "CLOSE" } }));
  fake.addLive(fakeLive("A4", { viewers: 200, extra: { status: "CLOSE" } }));

  const store = makeStore([normCampaign({ rewards: [lotteryReward(50)] })]);
  const ac = new AbortController();
  const picks = ["A", "A2", "A3", "A4"];
  let i = 0;

  const res = await worker.runSession({
    account: dummyAccount(),
    client: fake.clientFor("acc1"),
    campaigns: store,
    pickStream: () => {
      const ch = picks[i++ % picks.length];
      return { channelId: ch, channelName: "ch-" + ch };
    },
    onEvent: (ev) => { if (ev.state === "idle") ac.abort(); },
    signal: ac.signal, clock, timings: TIMINGS,
  });

  assert.equal(res.reason, "abort");

  const endedChannels = fake.calls
    .filter((c) => c.method === "watchEvent" && c.args[0] && c.args[0].type === "WATCH_ENDED")
    .map((c) => c.args[0].channelId);
  assert.ok(endedChannels.includes("A"), "WATCH_ENDED sent on the no-credit stream");

  assert.equal(fake.minutes("acc1", 99), 0, "no minutes credited on A");

  const challengeCalls = fake.calls.filter((c) => c.method === "challenges" && c.key === "acc1");
  assert.ok(challengeCalls.length >= 3, "at least 3 challenges reads before leaving");
});

// ----------------------------------------------------------------- Test 5

test("AUTH from heartbeat ends session with reason:auth and still attempts WATCH_ENDED", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 10,
    campaigns: [fakeCampRaw()],
    lives: [fakeLive("A", { viewers: 5000 })],
  });
  const store = makeStore([normCampaign({ rewards: [lotteryReward(50)] })]);

  // Wrap: 2nd watchEvent (first WATCH_CONTINUED) throws AUTH; 1st succeeds.
  const base = fake.clientFor("acc1");
  let n = 0;
  const client = {
    ...base,
    async watchEvent(args) {
      n++;
      if (n === 2) throw new ChzzkError("Not logged in", { code: "AUTH" });
      return base.watchEvent(args);
    },
  };

  const res = await worker.runSession({
    account: dummyAccount(),
    client, campaigns: store,
    pickStream: () => ({ channelId: "A", channelName: "ch-A" }),
    clock, timings: TIMINGS,
  });

  assert.equal(res.reason, "auth", "runSession returns reason:auth");
  assert.equal(countWatchEvent(fake, "WATCH_STARTED"), 1);
  assert.equal(countWatchEvent(fake, "WATCH_ENDED"), 1, "WATCH_ENDED attempted after AUTH");
});

// ----------------------------------------------------------------- Test 6

test("EGRESS from heartbeat: worker waits, campaign stays unbumped, then continues normally", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 10,
    campaigns: [fakeCampRaw()],
    lives: [fakeLive("A", { viewers: 5000 })],
  });
  const store = makeStore([normCampaign({ rewards: [lotteryReward(50)] })]);

  const base = fake.clientFor("acc1");
  let n = 0;
  const client = {
    ...base,
    async watchEvent(args) {
      n++;
      if (n === 2) throw new ChzzkError("tunnel down", { code: "EGRESS" });
      return base.watchEvent(args);
    },
  };

  const ac = new AbortController();
  let aborted = false;

  const res = await worker.runSession({
    account: dummyAccount(),
    client, campaigns: store,
    pickStream: () => ({ channelId: "A", channelName: "ch-A" }),
    onEvent: (ev) => {
      if (!aborted && ev.state === "watching" && ev.minutes >= 40) {
        aborted = true; ac.abort();
      }
    },
    signal: ac.signal, clock, timings: TIMINGS,
  });

  assert.notEqual(res.reason, "auth");
  // Campaign strike never fired: minutes DID keep growing past 40 (or markFarmed
  // landed) — either outcome proves the worker didn't abandon the campaign.
  // We also assert we got past the failed beat with real continued beats.
  assert.ok(n >= 4, "WATCH_CONTINUED beats resumed after the egress failure");
});

// ----------------------------------------------------------------- Test 7

test("abort via signal mid-stream returns reason:abort, attempts WATCH_ENDED, no further calls", async () => {
  const clock = makeClock();
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 10,
    campaigns: [fakeCampRaw()],
    lives: [fakeLive("A", { viewers: 5000 })],
  });
  const store = makeStore([normCampaign({ rewards: [lotteryReward(50)] })]);
  const ac = new AbortController();
  let armed = false;

  const res = await worker.runSession({
    account: dummyAccount(),
    client: fake.clientFor("acc1"),
    campaigns: store,
    pickStream: () => ({ channelId: "A", channelName: "ch-A" }),
    onEvent: (ev) => {
      if (!armed && ev.state === "watching") { armed = true; ac.abort(); }
    },
    signal: ac.signal, clock, timings: TIMINGS,
  });

  assert.equal(res.reason, "abort");

  const watchEventCalls = fake.calls.filter((c) => c.method === "watchEvent");
  const lastWe = watchEventCalls[watchEventCalls.length - 1];
  assert.ok(lastWe, "at least one watchEvent happened");
  assert.equal(lastWe.args[0].type, "WATCH_ENDED", "last watchEvent is WATCH_ENDED");

  const idx = fake.calls.lastIndexOf(lastWe);
  const after = fake.calls.slice(idx + 1);
  const noisy = after.filter((c) =>
    c.method === "watchEvent" || c.method === "liveStatus" ||
    c.method === "challenges" || c.method === "claims" || c.method === "couponCode",
  );
  assert.deepEqual(noisy, [], "no further stream traffic after abort");
  assert.equal(store.marked.size, 0, "no markFarmed on abort");
});

// ----------------------------------------------------------------- Test 8

test("onEarned fires when every farmable reward has left the challenges list", async () => {
  const clock = makeClock();
  // Fake earns the only reward on beat 1 (cond=10, perBeat=15); from the
  // worker's view that's §9's "reward leaving the list" signal.
  const fake = createFakeChzzk({
    now: () => clock.t, minutesPerBeat: 15,
    campaigns: [{
      campaignNo: 99, title: "KEL Finals",
      categoryType: "GAME", categoryId: "cat-1", categoryValue: "Eternal Return",
      state: "PROMOTED",
      startDate: "2026-10-23 00:00:00", endDate: "2026-10-30 23:59:59",
      rewardList: [{
        rewardNo: 1, title: "KEL15", rewardType: "CODE_FIRST_COME",
        conditionForMinutes: 10, codeRemainingCount: 100,
      }],
    }],
    lives: [fakeLive("A", { viewers: 5000 })],
  });

  const store = makeStore([normCampaign({ rewards: [firstComeReward(10)] })]);
  const ac = new AbortController();
  const earnedCalls = [];
  let aborted = false;

  const res = await worker.runSession({
    account: dummyAccount(),
    client: fake.clientFor("acc1"),
    campaigns: store,
    pickStream: () => ({ channelId: "A", channelName: "ch-A" }),
    onEarned: (acc) => {
      earnedCalls.push(acc);
      if (!aborted) { aborted = true; ac.abort(); }
    },
    signal: ac.signal, clock, timings: TIMINGS,
  });

  assert.ok(res.reason === "abort" || res.reason === "end", "run ended cleanly");
  assert.ok(earnedCalls.length >= 1, "onEarned fired at least once");
  assert.equal(earnedCalls[0]._id, "acc1", "onEarned called with the account");
});
