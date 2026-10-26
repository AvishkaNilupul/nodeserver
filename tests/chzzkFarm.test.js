// Tests for utils/chzzkFarm.js (docs/CHZZK-FARM.md §10). No network: the farm
// drives an in-memory CHZZK (tests/helpers/chzzkFake.js) through injected
// `makeClient` + `transport` deps, and uses MongoMemoryServer for the models.
// Tests call the private methods directly rather than running start() + timers,
// so time stays deterministic.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.CRED_SECRET ||= "chzzk-farm-test-cred-secret";

const ChzzkAccount = require("../models/ChzzkAccount");
const ChzzkCampaign = require("../models/ChzzkCampaign");
const ChzzkReward = require("../models/ChzzkReward");
const { encrypt, decrypt } = require("../utils/secretBox");
const { createFakeChzzk } = require("./helpers/chzzkFake");
const { Farm } = require("../utils/chzzkFarm");

const MIN = 60 * 1000;

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([
    ChzzkAccount.init(),
    ChzzkCampaign.init(),
    ChzzkReward.init(),
  ]);
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

test.beforeEach(async () => {
  await Promise.all([
    ChzzkAccount.deleteMany({}),
    ChzzkCampaign.deleteMany({}),
    ChzzkReward.deleteMany({}),
  ]);
  delete process.env.CHZZK_FARM;
});

// ---------- stubs ----------

function activityStub() {
  const entries = [];
  return {
    add(e) { entries.push({ ...e }); },
    async list({ limit = 100, accountId } = {}) {
      let out = entries.slice();
      if (accountId) out = out.filter((x) => String(x.accountId) === String(accountId));
      return out.slice(-limit).reverse();
    },
    get entries() { return entries; },
    reset() { entries.length = 0; },
  };
}

function settingsStub(initial = {}) {
  let state = { ...initial };
  return {
    getAutoFarm: () => ({ ...state }),
    async setAutoFarm(patch) { state = { ...state, ...patch }; return { ...state }; },
    get value() { return { ...state }; },
  };
}

function telegramStub() {
  const sent = [];
  return {
    sendTelegram: async (text) => { sent.push(text); return true; },
    get sent() { return sent; },
    reset() { sent.length = 0; },
  };
}

function timerStub() {
  let seq = 0;
  const handles = new Map();
  return {
    set(fn, ms) { const h = ++seq; handles.set(h, { fn, ms, kind: "timeout" }); return h; },
    interval(fn, ms) { const h = ++seq; handles.set(h, { fn, ms, kind: "interval" }); return h; },
    clear(h) { handles.delete(h); },
    get handles() { return handles; },
  };
}

function fakeTransport(overrides = {}) {
  return {
    ready: true,
    describe: () => "test://proxy",
    request: async () => { throw new Error("transport.request must not run in tests"); },
    stats: () => ({ requests: 0, failures: 0, lastOkAt: 0, lastErrorAt: 0, lastError: "" }),
    ...overrides,
  };
}

function makeDispatcher(fake) {
  return ({ cookies }) => {
    if (!Array.isArray(cookies) || !cookies.length) return fake.anonymous();
    const nid = cookies.find((c) => c && c.name === "NID_AUT");
    const key = nid ? String(nid.value) : String(cookies[0].value || "");
    return fake.clientFor(key);
  };
}

// Build a Farm with sensible defaults for tests. The caller may override any dep.
function buildFarm(opts = {}) {
  const fake = opts.fake || createFakeChzzk({ campaigns: opts.campaigns || [], lives: opts.lives || [] });
  const activity = opts.activity || activityStub();
  const settings = opts.settings || settingsStub(opts.autoFarm || {});
  const telegram = opts.telegram || telegramStub();
  const timers = opts.timers || timerStub();
  const transport = opts.transport || fakeTransport(opts.transportOverrides);
  const makeClient = opts.makeClient || makeDispatcher(fake);
  const createCollector = opts.createCollector || (() => ({
    collect: async () => ({ read: 0, stored: 0, failed: 0 }),
    sweep: async () => [],
    reveal: async () => null,
    pending: () => 0,
  }));
  const farm = new Farm({
    activity,
    settings,
    telegram,
    timers,
    transport,
    transportFactory: () => transport,
    makeClient,
    createCollector,
    now: opts.now || (() => Date.now()),
  });
  // Many tests skip start(); set this up by hand so the farm can act.
  farm.transport = transport;
  return { farm, fake, activity, settings, telegram, timers, transport };
}

// Seed a credible account doc with encrypted cookies for a given jar.
async function seedAccount({ key, status = "ok", nickname, extra = {} }) {
  const jar = [
    { name: "NID_AUT", value: key, domain: ".naver.com" },
    { name: "NID_SES", value: "ses-" + key, domain: ".naver.com" },
  ];
  const doc = await ChzzkAccount.create({
    userIdHash: "hash-" + key,
    nickname: nickname || "nick-" + key,
    cookies: encrypt(JSON.stringify(jar)),
    deviceId: "",
    status,
    ...extra,
  });
  return { doc, jar };
}

// ---------- 1. Switch ----------

test("_readSwitch: default on, CHZZK_FARM=0 off, setSwitch persists and flips cache", async () => {
  // Default: no chzzkFarm key → true.
  {
    const { farm } = buildFarm();
    assert.equal(farm._readSwitch(), true);
  }
  // CHZZK_FARM=0 beats any cache.
  {
    const { farm } = buildFarm({ autoFarm: { chzzkFarm: true } });
    assert.equal(farm._readSwitch(), true);
    process.env.CHZZK_FARM = "0";
    assert.equal(farm._readSwitch(), false);
    delete process.env.CHZZK_FARM;
  }
  // setSwitch(false) persists via settings and flips the cache.
  {
    const settings = settingsStub({ chzzkFarm: true });
    const { farm } = buildFarm({ settings });
    assert.equal(farm._readSwitch(), true);
    await farm.setSwitch(false, "owner");
    assert.equal(settings.value.chzzkFarm, false, "persisted to settings");
    assert.equal(farm._readSwitch(), false, "cache flipped");
  }
});

// ---------- 2. Egress ----------

test("_checkEgress: JP ok, US not credited, transport not ready; activity on transitions only", async () => {
  const { farm, fake, activity } = buildFarm();
  // Initial state is ok:false — the first OK call is a transition.
  await farm._checkEgress();
  assert.equal(farm.state.egress.ok, true);
  assert.equal(farm.state.egress.country, "JP");
  assert.equal(farm.state.egress.via, "test://proxy");
  const egressEntries1 = activity.entries.filter((e) => e.kind === "egress");
  assert.equal(egressEntries1.length, 1, "first OK logs a transition");
  assert.match(egressEntries1[0].msg, /ok \(JP via test:\/\/proxy\)/);

  // Still JP — no new transition.
  await farm._checkEgress();
  assert.equal(activity.entries.filter((e) => e.kind === "egress").length, 1);

  // Flip to US → ok:false with "country US not credited". FR is now in the
  // default allowed set (measured 2026-10-23 — Contabo FR credits CHZZK).
  fake.country = "US";
  await farm._checkEgress();
  assert.equal(farm.state.egress.ok, false);
  assert.match(farm.state.egress.error, /country US not credited/);
  assert.equal(activity.entries.filter((e) => e.kind === "egress").length, 2);

  // Transport not ready: still not-OK → no new transition.
  farm.transport = fakeTransport({ ready: false });
  await farm._checkEgress();
  assert.equal(farm.state.egress.ok, false);
  assert.match(farm.state.egress.error, /transport not ready/);
  assert.equal(activity.entries.filter((e) => e.kind === "egress").length, 2);

  // Flip back to ready + JP → another OK transition.
  farm.transport = fakeTransport();
  fake.country = "JP";
  await farm._checkEgress();
  assert.equal(farm.state.egress.ok, true);
  assert.equal(activity.entries.filter((e) => e.kind === "egress").length, 3);
});

// ---------- 3. Import ----------

test("importAccounts: happy path upserts encrypted cookies and logs no plaintext", async () => {
  const { farm, activity } = buildFarm();
  const jar = [
    { name: "NID_AUT", value: "token-A", domain: ".naver.com" },
    { name: "NID_SES", value: "session-A", domain: ".naver.com" },
  ];
  const text = JSON.stringify(jar);
  const r = await farm.importAccounts(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, true);
  assert.equal(r[0].created, true);
  assert.equal(r[0].nickname, "nick-token-A");
  assert.equal(r[0].userIdHash8, "hash-tok");

  const doc = await ChzzkAccount.findOne({ userIdHash: "hash-token-A" }).lean();
  assert.ok(doc, "row stored");
  assert.ok(doc.cookies && !doc.cookies.includes("token-A"), "cookies not stored in plaintext");
  // parseImport strips the leading "." from domains, so compare on name+value.
  const decrypted = JSON.parse(decrypt(doc.cookies));
  assert.equal(decrypted.length, 2);
  assert.deepEqual(
    decrypted.map((c) => ({ name: c.name, value: c.value })),
    jar.map((c) => ({ name: c.name, value: c.value })),
    "decrypt round-trips cookies",
  );
  assert.equal(doc.status, "ok");
  assert.equal(doc.nickname, "nick-token-A");

  const importEntries = activity.entries.filter((e) => e.kind === "import");
  assert.equal(importEntries.length, 1);
  // The fake's clientKey == NID_AUT value, which it also echoes into the
  // nickname, so an "AUTH value in msg" check would false-positive on the
  // nickname itself (not a leak in production). The opaque NID_SES value is
  // never echoed by anything, so if THAT ever shows up in a log, it's a leak.
  for (const e of activity.entries) {
    assert.ok(!String(e.msg || "").includes("session-A"), "activity msg leaks cookie");
    assert.ok(!JSON.stringify(e.data || "").includes("session-A"), "activity data leaks cookie");
  }
});

test("importAccounts: second import of the same jar does not duplicate", async () => {
  const { farm } = buildFarm();
  const jar = [
    { name: "NID_AUT", value: "token-dup", domain: ".naver.com" },
    { name: "NID_SES", value: "session-dup", domain: ".naver.com" },
  ];
  const text = JSON.stringify(jar);
  await farm.importAccounts(text);
  const r2 = await farm.importAccounts(text);
  assert.equal(r2[0].ok, true);
  assert.equal(r2[0].created, false);
  assert.equal(await ChzzkAccount.countDocuments({}), 1, "no duplicate row");
});

test("importAccounts: invalid jar (no NID_AUT/NID_SES) returns ok:false", async () => {
  const { farm } = buildFarm();
  const bad = JSON.stringify([{ name: "other", value: "x", domain: ".naver.com" }]);
  const r = await farm.importAccounts(bad);
  assert.ok(r.some((row) => row.ok === false), "a result with ok:false");
  const row = r.find((x) => x.ok === false);
  assert.match(row.error, /NID_AUT\/NID_SES/);
});

test("importAccounts: logged-out jar returns {ok:false, error:'Jar is logged out'}", async () => {
  const { farm, fake } = buildFarm();
  const jar = [
    { name: "NID_AUT", value: "token-out", domain: ".naver.com" },
    { name: "NID_SES", value: "session-out", domain: ".naver.com" },
  ];
  fake.logout("token-out");
  const r = await farm.importAccounts(JSON.stringify(jar));
  assert.equal(r.length, 1);
  assert.equal(r[0].ok, false);
  assert.equal(r[0].error, "Jar is logged out");
  assert.equal(await ChzzkAccount.countDocuments({}), 0, "no row for a dead jar");
});

// ---------- 4. checkAccounts ----------

test("checkAccounts: AUTH flips to not_logged_in (unusableSince stamped once); ok clears only unusableSince", async () => {
  const { farm, fake } = buildFarm();

  // A: not_logged_in with stale fields → successful check should clear both.
  const { doc: docA } = await seedAccount({
    key: "A",
    status: "not_logged_in",
    extra: {
      unusableSince: new Date(Date.now() - 30 * MIN),
      unusableAlertAt: new Date(Date.now() - 10 * MIN),
      lastError: "old-auth",
    },
  });
  // B: ok, but logged out at the fake → should flip and set unusableSince.
  const { doc: docB } = await seedAccount({ key: "B", status: "ok" });
  fake.logout("B");

  await farm.checkAccounts([String(docA._id), String(docB._id)]);
  const a1 = await ChzzkAccount.findById(docA._id).lean();
  const b1 = await ChzzkAccount.findById(docB._id).lean();
  assert.equal(a1.status, "ok", "A re-check passes");
  assert.equal(a1.unusableSince, null);
  // _checkOne deliberately leaves unusableAlertAt alone when flipping to ok —
  // _alertPass is the only clear path (and sends "accepted again" first).
  assert.ok(a1.unusableAlertAt instanceof Date, "alert stamp preserved for the recovery branch");
  assert.equal(b1.status, "not_logged_in", "B flipped");
  assert.ok(b1.lastError && b1.lastError.length > 0);
  assert.ok(b1.unusableSince instanceof Date, "unusableSince stamped");
  const stampedAt = b1.unusableSince.getTime();

  // Second check: still logged out. The stamp must stay — not re-dated.
  await farm.checkAccounts([String(docB._id)]);
  const b2 = await ChzzkAccount.findById(docB._id).lean();
  assert.equal(b2.status, "not_logged_in");
  assert.equal(b2.unusableSince.getTime(), stampedAt, "unusableSince stamped once");
});

// ---------- 5. deleteAccounts ----------

test("deleteAccounts: codeless rewards go, hasCode:true rewards stay", async () => {
  const { farm } = buildFarm();
  const { doc: a1 } = await seedAccount({ key: "D1" });
  const { doc: a2 } = await seedAccount({ key: "D2" });
  await ChzzkReward.create({
    accountId: String(a1._id), userIdHash: "hash-D1",
    campaignNo: 1, rewardNo: 10, hasCode: true, state: "stored",
    codeEnc: encrypt("SECRET-CODE"),
  });
  await ChzzkReward.create({
    accountId: String(a1._id), userIdHash: "hash-D1",
    campaignNo: 1, rewardNo: 11, hasCode: false, state: "earned",
  });
  await ChzzkReward.create({
    accountId: String(a2._id), userIdHash: "hash-D2",
    campaignNo: 2, rewardNo: 20, hasCode: false, state: "earned",
  });

  const result = await farm.deleteAccounts([String(a1._id), String(a2._id)]);
  assert.deepEqual(result, { deleted: 2, keptCodes: 1, keptSold: 0 });

  assert.equal(await ChzzkAccount.countDocuments({}), 0, "accounts gone");
  assert.equal(
    await ChzzkReward.countDocuments({ hasCode: { $ne: true } }),
    0,
    "codeless rewards gone",
  );
  const kept = await ChzzkReward.findOne({ rewardNo: 10 }).lean();
  assert.ok(kept, "hasCode:true reward kept");
  assert.equal(kept.hasCode, true);
  // and the codeEnc on that row is untouched
  assert.equal(decrypt(kept.codeEnc), "SECRET-CODE");
});

// ---------- 6. refreshCampaigns ----------

test("refreshCampaigns: upserts two rows (one needsLink), source:scan, idempotent", async () => {
  const camps = [
    {
      campaignNo: 101,
      title: "Linked Campaign",
      categoryType: "GAME", categoryId: "cat-A", categoryValue: "GameA",
      state: "PROMOTED",
      startDate: "2026-10-20 00:00:00", endDate: "2026-11-30 23:59:59",
      accountLinkUrl: "https://naver.example/link",
      description: "guide A",
      rewardList: [
        { rewardNo: 1001, title: "15m", rewardType: "CODE_FIRST_COME", conditionForMinutes: 15, codeRemainingCount: 500 },
      ],
    },
    {
      campaignNo: 202,
      title: "Open Campaign",
      categoryType: "GAME", categoryId: "cat-B", categoryValue: "GameB",
      state: "PROMOTED",
      startDate: "2026-10-20 00:00:00", endDate: "2026-11-30 23:59:59",
      rewardList: [
        { rewardNo: 2001, title: "60m", rewardType: "CODE_LOTTERY", conditionForMinutes: 60, codeRemainingCount: null },
      ],
    },
  ];
  const lives = [
    { channelId: "ch1", channelName: "C1", liveId: 11, viewers: 100, status: "OPEN",
      openDate: "2026-10-23 10:00:00", categoryType: "GAME", categoryId: "cat-A", dropsCampaignNo: 101 },
    { channelId: "ch2", channelName: "C2", liveId: 22, viewers: 200, status: "OPEN",
      openDate: "2026-10-23 10:00:00", categoryType: "GAME", categoryId: "cat-B", dropsCampaignNo: 202 },
  ];
  const fake = createFakeChzzk({ campaigns: camps, lives });
  const { farm } = buildFarm({ fake });
  farm.state.egress = { via: "x", country: "JP", ok: true, at: Date.now(), error: "" };

  const r = await farm.refreshCampaigns();
  assert.equal(r.found, 2);
  assert.equal(r.updated, 2);

  const rows = await ChzzkCampaign.find({}).sort({ campaignNo: 1 }).lean();
  assert.equal(rows.length, 2);
  const a = rows.find((x) => x.campaignNo === 101);
  const b = rows.find((x) => x.campaignNo === 202);
  assert.equal(a.enabled, true);
  assert.equal(a.source, "scan");
  assert.equal(a.needsLink, true, "accountLinkUrl → needsLink:true");
  assert.equal(b.needsLink, false, "no link → needsLink:false");
  assert.equal(a.title, "Linked Campaign");
  assert.equal(a.rewards.length, 1);
  assert.equal(a.rewards[0].rewardNo, 1001);
  assert.equal(a.rewards[0].minutes, 15);
  assert.equal(b.rewards[0].rewardType, "CODE_LOTTERY");

  // Idempotent: a second refresh keeps the row count at 2.
  const r2 = await farm.refreshCampaigns();
  assert.equal(r2.found, 2);
  assert.equal(r2.updated, 2);
  assert.equal(await ChzzkCampaign.countDocuments({}), 2);
});

// ---------- 7. addCampaign ----------

test("addCampaign: unknown → ok:false; known → ok:true, source:manual", async () => {
  const camps = [{
    campaignNo: 500,
    title: "Added-by-hand",
    categoryType: "GAME", categoryId: "cat-M", categoryValue: "GameM",
    state: "PROMOTED",
    startDate: "2026-10-20 00:00:00", endDate: "2026-11-30 23:59:59",
    rewardList: [
      { rewardNo: 5001, title: "10m", rewardType: "CODE_FIRST_COME", conditionForMinutes: 10, codeRemainingCount: 100 },
    ],
  }];
  const fake = createFakeChzzk({ campaigns: camps });
  const { farm } = buildFarm({ fake });
  farm.state.egress = { via: "x", country: "JP", ok: true, at: Date.now(), error: "" };

  const bad = await farm.addCampaign(999);
  assert.equal(bad.ok, false);
  assert.ok(bad.error, "has error text");

  const good = await farm.addCampaign(500);
  assert.equal(good.ok, true);
  assert.ok(good.campaign);
  assert.equal(good.campaign.campaignNo, 500);
  const row = await ChzzkCampaign.findOne({ campaignNo: 500 }).lean();
  assert.ok(row, "row stored");
  assert.equal(row.source, "manual");
  assert.equal(row.enabled, true);
});

// ---------- 8. setCampaignEnabled + campaignsView ----------

test("setCampaignEnabled(false): campaignsView marks enabled:false, farmable:false", async () => {
  const { farm } = buildFarm();
  farm.state.egress = { via: "x", country: "JP", ok: true, at: Date.now(), error: "" };
  const now = Date.now();
  await ChzzkCampaign.create({
    campaignNo: 42,
    title: "Live Campaign",
    categoryType: "GAME", categoryId: "c1", categoryValue: "G",
    state: "PROMOTED",
    startAt: new Date(now - 60 * MIN),
    endAt: new Date(now + 24 * 60 * MIN),
    needsLink: false,
    enabled: true,
    source: "scan",
    rewards: [{ rewardNo: 1, title: "r", rewardType: "CODE_FIRST_COME", minutes: 15, remaining: 100 }],
  });

  const v1 = await farm.campaignsView();
  const row1 = v1.campaigns.find((c) => c.campaignNo === 42);
  assert.ok(row1);
  assert.equal(row1.enabled, true);
  assert.equal(row1.farmable, true);

  const ok = await farm.setCampaignEnabled(42, false);
  assert.equal(ok, true);

  const v2 = await farm.campaignsView();
  const row2 = v2.campaigns.find((c) => c.campaignNo === 42);
  assert.equal(row2.enabled, false);
  assert.equal(row2.farmable, false);
});

// ---------- 9. collectNow ----------

test("collectNow calls injected createCollector's sweep with the id list", async () => {
  const sweepCalls = [];
  const fakeCollector = {
    collect: async () => ({ read: 0, stored: 0, failed: 0 }),
    sweep: async (ids) => { sweepCalls.push(ids.slice()); return []; },
    reveal: async () => null,
    pending: () => 0,
  };
  const { farm } = buildFarm({ createCollector: () => fakeCollector });
  farm.collector = fakeCollector; // skip start()

  const r = await farm.collectNow(["id-1", "id-2"]);
  assert.deepEqual(r, { queued: 2 });
  // sweep is fired without await; let the microtask run.
  await new Promise((res) => setImmediate(res));
  assert.equal(sweepCalls.length, 1);
  assert.deepEqual(sweepCalls[0], ["id-1", "id-2"]);
});

// ---------- 10. revealCode ----------

test("revealCode proxies to collector.reveal and returns null for an unknown id", async () => {
  const revealCalls = [];
  const fakeCollector = {
    collect: async () => ({ read: 0, stored: 0, failed: 0 }),
    sweep: async () => [],
    reveal: async (id, who) => {
      revealCalls.push({ id, who });
      if (id === "known") return { code: "C-VALUE", row: { id: "known" } };
      return null;
    },
    pending: () => 0,
  };
  const { farm } = buildFarm({ createCollector: () => fakeCollector });
  farm.collector = fakeCollector;

  const unknown = await farm.revealCode("unknown", "actor");
  assert.equal(unknown, null);
  const known = await farm.revealCode("known", "actor");
  assert.ok(known && known.code === "C-VALUE");
  assert.equal(revealCalls.length, 2);
  assert.equal(revealCalls[0].who, "actor");
});

// ---------- 11. _alertPass ----------

test("_alertPass sends batch once, no re-send next pass; recovery sends 'accepted again'", async () => {
  const { farm, telegram } = buildFarm();
  const sixMinAgo = new Date(Date.now() - 6 * MIN);
  const { doc } = await seedAccount({
    key: "X",
    status: "not_logged_in",
    nickname: "Alice",
    extra: { unusableSince: sixMinAgo, lastError: "AUTH" },
  });

  // First pass: send the batch message and stamp unusableAlertAt.
  await farm._alertPass();
  assert.equal(telegram.sent.length, 1, "one Telegram call");
  assert.match(telegram.sent[0], /CHZZK logins down \(1\): Alice/);
  const after1 = await ChzzkAccount.findById(doc._id).lean();
  assert.ok(after1.unusableAlertAt instanceof Date, "stamped");

  // Second pass with nothing changed: within alertRetryMs (3 min), no re-send.
  await farm._alertPass();
  assert.equal(telegram.sent.length, 1, "no re-send");

  // Flip to ok but KEEP unusableAlertAt so the recovery branch has work.
  await ChzzkAccount.updateOne(
    { _id: doc._id },
    { $set: { status: "ok" } },
  );
  await farm._alertPass();
  assert.equal(telegram.sent.length, 2);
  assert.match(telegram.sent[1], /accepted again \(1\)/);
  const after2 = await ChzzkAccount.findById(doc._id).lean();
  assert.equal(after2.unusableSince, null);
  assert.equal(after2.unusableAlertAt, null);
});

// ---------- 12. stateView ----------

test("stateView returns the §10 shape with 8-char userIdHash", async () => {
  const settings = settingsStub({ chzzkFarm: true });
  const { farm } = buildFarm({ settings });
  farm.state.egress = { via: "test://proxy", country: "JP", ok: true, at: Date.now(), error: "" };

  const { doc: ok } = await seedAccount({ key: "OK-ONE" });
  const { doc: dead } = await seedAccount({ key: "DEAD-ONE", status: "not_logged_in" });
  await ChzzkCampaign.create({ campaignNo: 99, title: "x" });
  await ChzzkReward.create({
    accountId: String(ok._id), userIdHash: "hash-OK-ONE",
    campaignNo: 99, rewardNo: 1,
    hasCode: true, state: "stored", codeEnc: encrypt("CODE"),
  });

  const sv = await farm.stateView();
  assert.equal(sv.switch.on, true);
  assert.equal(sv.egress.ok, true);
  assert.equal(sv.egress.country, "JP");
  assert.equal(sv.totals.accounts, 2);
  assert.equal(sv.totals.ok, 1);
  assert.equal(sv.totals.loggedOut, 1);
  assert.equal(sv.totals.codes, 1);
  assert.equal(sv.totals.campaigns, 1);
  assert.equal(sv.accounts.length, 2);

  for (const a of sv.accounts) {
    assert.equal(a.userIdHash.length, 8, "truncated to 8 chars");
    assert.ok(a.userIdHash === "hash-OK-" || a.userIdHash === "hash-DEA", "slice(0,8)");
    assert.ok(!a.userIdHash.includes("ONE"), "full hash never exposed");
  }
  const okRow = sv.accounts.find((a) => String(a.id) === String(ok._id));
  assert.equal(okRow.codes, 1, "coded rewards counted on the account");
  assert.equal(okRow.status, "ok");
});

// ---------- 13. start/stop ----------

test("start is idempotent; stop aborts in-flight workers", async () => {
  const timers = timerStub();
  const { farm } = buildFarm({ timers });
  farm.start();
  const n1 = timers.handles.size;
  // Egress, discovery, login, keepwarm, cookie-save, codes, alert, supervisor.
  assert.equal(n1, 8);
  farm.start();
  assert.equal(timers.handles.size, n1, "second start() is a no-op");

  // Seed a worker and verify stop aborts it.
  const controller = new AbortController();
  let aborted = false;
  controller.signal.addEventListener("abort", () => { aborted = true; });
  farm.workers.set("w1", { controller, promise: Promise.resolve(), since: Date.now() });

  await farm.stop();
  assert.equal(aborted, true, "worker aborted on stop");
  assert.equal(farm.workers.size, 0);
  assert.equal(timers.handles.size, 0, "all timer handles cleared");
});
