/* global fetch */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const express = require("express");
const session = require("express-session");
const { normalizeQuest, canClaim, codeReward, createRewardReader } = require("../utils/discordFarm/questRewards");
const Account = require("../models/DiscordTestAccount");
const Code = require("../models/DiscordRewardCode");
const { createRouter } = require("../routes/discordFarmRoutes");
const { isEncrypted } = require("../utils/secretBox");
process.env.CRED_SECRET = "discord-rewards-tests-only";
const userId = "123456789012345678", questId = "234567890123456789";
const at = "2026-10-01T00:00:00Z";
const raw = { id: questId, config: { messages: { quest_name: "Test quest", game_title: "Test game" },
  expires_at: "2026-10-02T00:00:00Z", rewards_config: { rewards_expire_at: "2099-01-01T00:00:00Z",
    rewards: [{ type: 1, messages: { name: "Test key" }, redemption_link: "https://example.test/redeem" }] } },
  user_status: { completed_at: at } };

test("completion and claiming have separate deadlines; history uses different reward fields", () => {
  const q = normalizeQuest(raw);
  assert.ok(canClaim(q));
  assert.equal(canClaim({ ...q, claimExpiresAt: null }), false);
  assert.equal(canClaim({ ...q, userStatus: { ...q.userStatus, claimed_at: at } }), false);
  const history = normalizeQuest({ ...raw, config: { rewards: [{ type: 1, name: "Archived key" }] } });
  assert.equal(codeReward(history).messages.name, "Archived key");
  assert.equal(codeReward({ rewards: [{ type: 4 }] }), null);
  assert.equal(codeReward({ ...q, config: { rewards_config: { assignment_method: 2 } }, userStatus: { claimed_tier: 1 } }), null);
});

test("catalog merges ended history and retains richer current metadata", async () => {
  const reader = createRewardReader(async (_host, opts) => ({ status: 200, data: { quests: opts.path.endsWith("claimed")
    ? [{ ...raw, user_status: { claimed_at: at } }, { ...raw, id: "expired", user_status: { claimed_at: at } }]
    : [raw] } }));
  const quests = await reader.catalog({}, { history: true });
  assert.equal(quests.length, 2);
  assert.equal(quests.find((q) => q.id === questId).userStatus.claimed_at, at);
  assert.equal(quests.find((q) => q.id === questId).claimExpiresAt, "2099-01-01T00:00:00Z");
});

test("reward code reads reject malformed and unrelated responses", async () => {
  for (const data of [{}, { quest_id: "other", code: "secret" }, { quest_id: questId, code: "", claimed_at: at, user_id: userId, platform: 0 }]) {
    const reader = createRewardReader(async () => ({ status: 200, data }));
    await assert.rejects(reader.rewardCode({}, questId), /Invalid Discord reward code/);
  }
});

test("code vault reconciles browser claims, encrypts keys, and enforces stock uniqueness", async (t) => {
  const mem = await MongoMemoryServer.create();
  let server;
  try {
    await mongoose.connect(mem.getUri());
    await Promise.all([Account.init(), Code.init()]);
    const account = await Account.create({ userId, credentials: { token: "private-session-token" } });
    let claimed = true, rewardFailure = false, mismatch = false, emptySuccess = false;
    const quest = () => ({ ...normalizeQuest(raw), userStatus: { completed_at: at, ...(claimed ? { claimed_at: at } : {}) } });
    const app = express(); app.use(express.json());
    app.use(session({ secret: "test-only", resave: false, saveUninitialized: true }));
    app.use((req, _res, next) => { req.session.admin = { role: req.headers["x-role"] || "superadmin" }; next(); });
    app.use(createRouter({ catalog: async () => [quest()], rewardCode: async () => {
      if (rewardFailure) throw new Error("private credential details");
      return { quest_id: questId, user_id: mismatch ? "999999999999999999" : userId, code: "TEST-REWARD-KEY", platform: 0, claimed_at: at };
    }, request: async () => ({ status: 200, data: emptySuccess ? { errors: [{ message: "failed" }] } : { claimed_at: at } }) }));
    server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const base = "http://127.0.0.1:" + server.address().port + "/admin/discord-farm";
    async function call(path, body, role) {
      const r = await fetch(base + path, { headers: { "Content-Type": "application/json", Accept: "application/json", ...(role ? { "x-role": role } : {}) },
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
      return { status: r.status, data: await r.json(), cache: r.headers.get("cache-control") };
    }
    await t.test("repeat sync stores one encrypted code and one claim", async () => {
      for (let n = 0; n < 2; n++) {
        const r = await call("/sync/" + account.id, {});
        assert.equal(r.status, 200); assert.equal(r.data.stored.length, 1);
      }
      assert.equal(await Code.countDocuments({}), 1);
      const stored = await Code.findOne({}).select("+code").lean();
      assert.ok(isEncrypted(stored.code));
      assert.equal(stored.expiresAt, null);
      const updated = await Account.findById(account.id);
      assert.equal(updated.questLog.length, 1); assert.equal(updated.totals.questsCompleted, 1);
      assert.equal(updated.questLog[0].attempts, 1);
    });
    await t.test("metadata hides keys; superadmin can explicitly retrieve one", async () => {
      const r = await call("/codes");
      assert.equal(r.cache, "no-store");
      assert.equal(r.data.codes.length, 1);
      assert.ok(!JSON.stringify(r.data).includes("TEST-REWARD-KEY"));
      assert.ok(!JSON.stringify(r.data).includes("enc:v1"));
      const id = r.data.codes[0]._id;
      assert.equal((await call("/codes/" + id)).data.code, "TEST-REWARD-KEY");
      assert.equal((await call("/codes/" + id, undefined, "admin")).status, 403);
      assert.equal((await call("/codes/bad")).status, 400);
    });
    await t.test("the same issued code cannot become stock for another account", async () => {
      const first = await Code.findOne({}).select("+code +codeHash").lean();
      const copy = { ...first, _id: new mongoose.Types.ObjectId(), accountId: new mongoose.Types.ObjectId() };
      await assert.rejects(Code.collection.insertOne(copy), (error) => error.code === 11000);
    });
    await t.test("mismatched ownership and partial collection errors are visible and do not alter stock", async () => {
      mismatch = true;
      let r = await call("/sync/" + account.id, {});
      assert.equal(r.data.errors.length, 1); assert.equal(r.data.stored.length, 0);
      mismatch = false; rewardFailure = true;
      r = await call("/sync/" + account.id, {});
      assert.equal(r.data.errors.length, 1);
      assert.ok(!JSON.stringify(r.data).includes("private credential"));
      assert.equal(await Code.countDocuments({}), 1);
    });
    await t.test("a successful claim survives a temporary code retrieval failure", async () => {
      const r = await call(`/trigger-captcha/${account.id}/${questId}`, {});
      assert.equal(r.status, 200); assert.equal(r.data.codeStored, false);
      assert.match(r.data.codeError, /Sync rewards/);
      assert.equal((await Account.findById(account.id)).totals.questsCompleted, 1);
    });
    await t.test("HTTP 200 without claimed_at cannot create a successful claim", async () => {
      claimed = false; emptySuccess = true;
      await Account.updateOne({ _id: account._id }, { $set: { questLog: [], "totals.questsCompleted": 0 } });
      assert.equal((await call(`/trigger-captcha/${account.id}/${questId}`, {})).status, 502);
      assert.equal((await Account.findById(account.id)).totals.questsCompleted, 0);
    });
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    await mongoose.disconnect(); await mem.stop();
  }
});
