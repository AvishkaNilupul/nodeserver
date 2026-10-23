// The fake CHZZK (tests/helpers/chzzkFake.js) is what the worker and farm
// tests stand on, so its own rules are pinned here: who gets credited, which
// error code each failure raises, and that the client keeps the §6 surface.
//
// No network: there is no https.request in sight. No timers: time is whatever
// the test's `now()` returns, and minutes are added one WATCH_CONTINUED beat
// at a time.

const test = require("node:test");
const assert = require("node:assert/strict");

const { createFakeChzzk } = require("./helpers/chzzkFake");
const { ChzzkError } = require("../utils/chzzk/errors");

// A single day's worth of KEL Finals: one campaign (15m FIRST_COME, 60m LOTTERY,
// a 5m IN_APP that must never be farmable), two OPEN lives + one CLOSE live.
const BASE_NOW = Date.parse("2026-10-25T03:00:00Z"); // 2026-10-25 12:00:00 KST
const KEL = {
  campaignNo: 99,
  title: "KEL Finals",
  categoryType: "GAME",
  categoryId: "cat-1",
  categoryValue: "Eternal Return",
  state: "PROMOTED",
  startDate: "2026-10-23 00:00:00",
  endDate: "2026-10-30 23:59:59",
  rewardList: [
    { rewardNo: 1, title: "15m code", rewardType: "CODE_FIRST_COME", conditionForMinutes: 15, codeRemainingCount: 22423 },
    { rewardNo: 2, title: "lottery", rewardType: "CODE_LOTTERY", conditionForMinutes: 60, codeRemainingCount: null },
    { rewardNo: 3, title: "sticker", rewardType: "IN_APP", conditionForMinutes: 5, codeRemainingCount: null },
  ],
};
const live = (channelId, channelName, liveId, viewers, status, openDate) => ({
  channelId, channelName, liveId, viewers, status, openDate,
  categoryType: "GAME", categoryId: "cat-1", dropsCampaignNo: 99,
});
function setup({ now, minutesPerBeat } = {}) {
  const clock = { ms: now == null ? BASE_NOW : now };
  const fake = createFakeChzzk({
    now: () => clock.ms,
    minutesPerBeat,
    campaigns: [KEL],
    lives: [
      live("popular", "Popular Streamer", 101, 5000, "OPEN", "2026-10-25 10:00:00"),
      live("small", "Small Streamer", 102, 50, "OPEN", "2026-10-25 11:30:00"),
      live("offline", "Offline", 103, 0, "CLOSE", "2026-10-24 10:00:00"),
    ],
  });
  return { fake, clock };
}

// Fire one WATCH_CONTINUED beat against a channel.
const beat = (client, channelId, type = "WATCH_CONTINUED") =>
  client.watchEvent({
    channelId,
    liveId: 101,
    type,
    sessionId: "s1",
    positionAt: 0,
    awt: "awt-x",
    liveTokens: [],
  });

// --------------------------------------------------------- surface + calls

const SURFACE = [
  "campaign", "categoriesLive", "challenges", "claims", "couponCode",
  "dropsLives", "egressCountry", "liveDetail", "liveStatus", "userStatus",
  "watchEvent",
];

test("clientFor returns the exact §6 method surface", () => {
  const client = setup().fake.clientFor("a1");
  assert.deepEqual(
    Object.keys(client).filter((k) => typeof client[k] === "function").sort(),
    SURFACE,
  );
});

test("fake.calls records every call in order with key/method/args", async () => {
  const { fake } = setup();
  const a = fake.clientFor("a1");
  const b = fake.clientFor("b2");
  await a.categoriesLive();
  await b.liveDetail("popular");
  await a.userStatus();
  assert.deepEqual(fake.calls, [
    { key: "a1", method: "categoriesLive", args: [undefined] },
    { key: "b2", method: "liveDetail", args: ["popular"] },
    { key: "a1", method: "userStatus", args: [] },
  ]);
});

// ------------------------------------------------------ user and discovery

test("userStatus returns loggedIn with a hash and nickname per key", async () => {
  const { fake } = setup();
  assert.deepEqual(await fake.clientFor("a1").userStatus(), {
    loggedIn: true, userIdHash: "hash-a1", nickname: "nick-a1", penalties: [],
  });
  assert.deepEqual(await fake.clientFor("b2").userStatus(), {
    loggedIn: true, userIdHash: "hash-b2", nickname: "nick-b2", penalties: [],
  });
});

test("categoriesLive groups OPEN drops lives; next null; CLOSE lives drop out", async () => {
  const { fake } = setup();
  const page = await fake.clientFor("a1").categoriesLive();
  assert.equal(page.next, null);
  assert.deepEqual(page.rows, [{
    categoryType: "GAME", categoryId: "cat-1", categoryValue: "Eternal Return",
    openLiveCount: 2, dropsCampaignNos: [99],
  }]);
  fake.setLive("popular", { status: "CLOSE" });
  fake.setLive("small", { status: "CLOSE" });
  assert.deepEqual((await fake.clientFor("a1").categoriesLive()).rows, []);
});

test("campaign returns a fresh raw object; unknown throws API", async () => {
  const client = setup().fake.clientFor("a1");
  const c = await client.campaign(99);
  assert.equal(c.title, "KEL Finals");
  assert.equal(c.rewardList.length, 3);
  // Mutating the returned copy must not touch the world.
  c.rewardList[0].conditionForMinutes = 1;
  assert.equal((await client.campaign(99)).rewardList[0].conditionForMinutes, 15);
  await assert.rejects(client.campaign(123), (e) => e instanceof ChzzkError && e.code === "API");
});

test("dropsLives: OPEN lives of the campaign, viewers desc, liveRow shape", async () => {
  const { fake } = setup();
  const rows = await fake.clientFor("a1").dropsLives("GAME", "cat-1", 99);
  assert.deepEqual(rows.map((r) => [r.channelId, r.viewers]), [["popular", 5000], ["small", 50]]);
  assert.deepEqual(Object.keys(rows[0]).sort(), [
    "adult", "channelId", "channelName", "dropsCampaignNo", "liveId",
    "openAt", "paid", "viewers", "watchParty",
  ]);
  assert.equal(rows[0].paid, false);
  assert.equal(rows[0].watchParty, false);
  assert.equal(+rows[0].openAt, +new Date("2026-10-25T01:00:00.000Z"));
  const one = await fake.clientFor("a1").dropsLives("GAME", "cat-1", 99, { size: 1 });
  assert.deepEqual(one.map((r) => r.channelId), ["popular"]);
});

test("liveDetail / liveStatus mirror the live row; unknown is CLOSE", async () => {
  const client = setup().fake.clientFor("a1");
  const d = await client.liveDetail("popular");
  assert.deepEqual([d.status, d.dropsCampaignNo, d.channelName], ["OPEN", 99, "Popular Streamer"]);
  assert.equal(+d.openAt, +new Date("2026-10-25T01:00:00.000Z"));
  assert.deepEqual(await client.liveStatus("popular"), {
    status: "OPEN", dropsCampaignNo: 99, liveTokens: [], krOnly: false,
    blindType: null, adult: false, abroad: false,
  });
  assert.equal((await client.liveDetail("nobody")).status, "CLOSE");
  assert.equal((await client.liveStatus("nobody")).status, "CLOSE");
});

test("liveStatus reflects krOnly / blindType / liveTokens via setLive", async () => {
  const { fake } = setup();
  fake.setLive("popular", {
    krOnly: true,
    blindType: "ADULT",
    liveTokens: [{ nodeId: 1, token: "t" }],
  });
  const s = await fake.clientFor("a1").liveStatus("popular");
  assert.equal(s.krOnly, true);
  assert.equal(s.blindType, "ADULT");
  assert.deepEqual(s.liveTokens, [{ nodeId: 1, token: "t" }]);
});

// --------------------------------------------------- watchEvent + minutes

test("watchEvent WATCH_CONTINUED credits by minutesPerBeat on an OPEN in-window live", async () => {
  const { fake } = setup();
  const client = fake.clientFor("a1");
  await beat(client, "popular");
  assert.equal(fake.minutes("a1", 99), 0.5);
  await beat(client, "popular");
  await beat(client, "popular");
  assert.equal(fake.minutes("a1", 99), 1.5);
});

test("minutesPerBeat can be overridden; crediting is per key per campaign", async () => {
  const { fake } = setup({ minutesPerBeat: 2 });
  const a = fake.clientFor("a1");
  const b = fake.clientFor("b2");
  await beat(a, "popular");
  await beat(b, "popular");
  await beat(b, "small");
  assert.equal(fake.minutes("a1", 99), 2);
  assert.equal(fake.minutes("b2", 99), 4);
});

test("WATCH_STARTED and WATCH_ENDED do NOT credit minutes", async () => {
  const { fake } = setup();
  const client = fake.clientFor("a1");
  await beat(client, "popular", "WATCH_STARTED");
  await beat(client, "popular", "WATCH_ENDED");
  assert.equal(fake.minutes("a1", 99), 0);
});

test("a CLOSE live, an unknown channel and an out-of-window campaign do not credit", async () => {
  const { fake, clock } = setup();
  const client = fake.clientFor("a1");
  await beat(client, "offline"); // status CLOSE
  await beat(client, "nobody"); // unknown
  assert.equal(fake.minutes("a1", 99), 0);
  // Jump the clock past the campaign's endDate.
  clock.ms = Date.parse("2026-11-01T00:00:00Z");
  await beat(client, "popular");
  assert.equal(fake.minutes("a1", 99), 0);
});

test("fake.noCredit stops crediting a specific channel", async () => {
  const { fake } = setup();
  const client = fake.clientFor("a1");
  fake.noCredit("popular");
  await beat(client, "popular");
  assert.equal(fake.minutes("a1", 99), 0);
  await beat(client, "small"); // other channel still credits
  assert.equal(fake.minutes("a1", 99), 0.5);
});

test("setLive status CLOSE stops crediting; dropsCampaignNo swap redirects", async () => {
  const { fake } = setup();
  const client = fake.clientFor("a1");
  await beat(client, "popular");
  fake.setLive("popular", { status: "CLOSE" });
  await beat(client, "popular");
  assert.equal(fake.minutes("a1", 99), 0.5);
  // Add a second campaign, swap the live to it, and credit lands there.
  fake.addCampaign({
    ...KEL, campaignNo: 123, title: "Other", categoryId: "cat-2",
    rewardList: [{ rewardNo: 7, title: "x", rewardType: "CODE_FIRST_COME", conditionForMinutes: 10, codeRemainingCount: 100 }],
  });
  fake.setLive("popular", { status: "OPEN", dropsCampaignNo: 123 });
  await beat(client, "popular");
  assert.equal(fake.minutes("a1", 123), 0.5);
});

// ----------------------------------------------------- challenges + claims

test("challenges lists IN_PROGRESS CODE_* rewards for campaigns the key has sent events for", async () => {
  const { fake } = setup({ minutesPerBeat: 10 });
  const client = fake.clientFor("a1");
  // No events yet: empty list even if the campaign is live.
  assert.deepEqual(await client.challenges(), []);
  await beat(client, "popular"); // one event -> 10m, 15m reward not yet reached
  const list = await client.challenges();
  assert.equal(list.length, 2); // the two CODE_* rewards, the IN_APP one is skipped
  const code = list.find((r) => r.rewardNo === 1);
  assert.deepEqual(code, {
    rewardNo: 1,
    campaignNo: 99,
    title: "15m code",
    rewardType: "CODE_FIRST_COME",
    conditionForMinutes: 15,
    accumWatchMinutes: 10, // floor(10)
    challengeStatus: "IN_PROGRESS",
    codeRemainingCount: 22423,
  });
  assert.equal(list.find((r) => r.rewardNo === 2).codeRemainingCount, null);
});

test("challenges drops a reward once minutes cross its conditionForMinutes", async () => {
  const { fake } = setup({ minutesPerBeat: 10 });
  const client = fake.clientFor("a1");
  await beat(client, "popular"); // 10m
  await beat(client, "popular"); // 20m -> crosses 15m reward
  const list = await client.challenges();
  assert.deepEqual(
    list.map((r) => r.rewardNo).sort(),
    [2], // reward 1 is now in claims, not in challenges
  );
});

test("claims lists reached CODE_* rewards with KST createdDate and nested campaign.title", async () => {
  const { fake, clock } = setup({ minutesPerBeat: 10 });
  const client = fake.clientFor("a1");
  // First beat lands at BASE_NOW. The crossing happens on the SECOND beat
  // (10 -> 20 crosses 15), so createdDate is the clock then.
  await beat(client, "popular");
  clock.ms = Date.parse("2026-10-25T04:00:00Z"); // 2026-10-25 13:00:00 KST
  await beat(client, "popular");
  const list = await client.claims();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    rewardNo: 1,
    campaignNo: 99,
    title: "15m code",
    rewardType: "CODE_FIRST_COME",
    fulfillmentState: "COMPLIED",
    createdDate: "2026-10-25 13:00:00",
    codeEndDate: "2026-11-30 23:59:59",
    categoryId: "cat-1",
    campaign: { title: "KEL Finals" },
  });
});

test("couponCode: earned returns FAKE-<key>-<rewardNo>; not earned throws API", async () => {
  const { fake } = setup({ minutesPerBeat: 20 });
  const client = fake.clientFor("a1");
  await beat(client, "popular"); // 20m -> crosses 15m reward (1)
  const code = await client.couponCode(1);
  assert.deepEqual(code, { codeNo: "1", code: "FAKE-a1-1" });
  await assert.rejects(
    client.couponCode(2),
    (e) => e instanceof ChzzkError && e.code === "API",
  );
  // Another key does not share the earn.
  const other = fake.clientFor("b2");
  await assert.rejects(
    other.couponCode(1),
    (e) => e instanceof ChzzkError && e.code === "API",
  );
});

// ---------------------------------------------------- auth / anon / failures

const authCalls = (c) => [
  () => c.userStatus(),
  () => c.watchEvent({ channelId: "popular", type: "WATCH_CONTINUED" }),
  () => c.challenges(),
  () => c.claims(),
  () => c.couponCode(1),
];
const isAuth = (e) => e instanceof ChzzkError && e.code === "AUTH";

test("logout: logged-in calls throw AUTH; public calls still work", async () => {
  const { fake } = setup();
  const client = fake.clientFor("a1");
  fake.logout("a1");
  for (const call of authCalls(client)) await assert.rejects(call(), isAuth);
  // Public calls still answer.
  assert.equal((await client.categoriesLive()).rows.length, 1);
  assert.equal((await client.liveDetail("popular")).status, "OPEN");
});

test("anonymous: public calls work; logged-in calls throw AUTH", async () => {
  const { fake } = setup();
  const anon = fake.anonymous();
  // Public: works.
  assert.equal((await anon.categoriesLive()).rows.length, 1);
  assert.equal((await anon.campaign(99)).campaignNo, 99);
  assert.equal((await anon.liveDetail("popular")).status, "OPEN");
  assert.equal((await anon.liveStatus("popular")).status, "OPEN");
  assert.equal(await anon.egressCountry(), "JP");
  assert.equal((await anon.dropsLives("GAME", "cat-1", 99)).length, 2);
  // Logged-in: AUTH.
  for (const call of authCalls(anon)) await assert.rejects(call(), isAuth);
  // Anonymous calls record a null key.
  assert.equal(fake.calls[0].key, null);
});

test("failNext throws N times for the method, FIFO across callers, then recovers", async () => {
  const { fake } = setup();
  const a = fake.clientFor("a1");
  const b = fake.clientFor("b2");
  fake.failNext("challenges", "EGRESS", 2);
  fake.failNext("challenges", "TIMEOUT", 1);
  await assert.rejects(a.challenges(), (e) => e instanceof ChzzkError && e.code === "EGRESS");
  await assert.rejects(b.challenges(), (e) => e instanceof ChzzkError && e.code === "EGRESS");
  await assert.rejects(a.challenges(), (e) => e instanceof ChzzkError && e.code === "TIMEOUT");
  // Queue empty: back to normal (no events yet, so empty).
  assert.deepEqual(await a.challenges(), []);
});

test("failNext records the call before throwing (so the harness can see it)", async () => {
  const { fake } = setup();
  const client = fake.clientFor("a1");
  fake.failNext("liveStatus", "HTTP", 1);
  await assert.rejects(client.liveStatus("popular"), (e) => e.code === "HTTP");
  assert.deepEqual(fake.calls, [
    { key: "a1", method: "liveStatus", args: ["popular"] },
  ]);
});

test("egressCountry reads fake.country, which is settable", async () => {
  const { fake } = setup();
  assert.equal(await fake.clientFor("a1").egressCountry(), "JP");
  fake.country = "US";
  assert.equal(await fake.clientFor("a1").egressCountry(), "US");
  fake.country = "";
  assert.equal(await fake.clientFor("a1").egressCountry(), "");
});
