/* global fetch */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const Account = require("../models/DiscordTestAccount");
const { createRouter } = require("../routes/discordFarmRoutes");
const { decrypt, isEncrypted } = require("../utils/secretBox");
process.env.CRED_SECRET = "discord-tests-only-secret";
const id = "507f1f77bcf86cd799439011";
const quest = { id: "123456789012345678", name: "Test quest", rewards: [{ type: 3, messages: { name: "Test cosmetic" } }],
  expiresAt: "2099-01-01T00:00:00Z",
  userStatus: { completed_at: "2026-10-25T00:00:00Z", traffic_metadata_sealed: "server-metadata" } };

test("quest reconciliation counts each claimed quest once", () => {
  const acc = new Account({ userId: "123456789012345678" });
  acc.recordQuestResult({ questId: "one", ok: false, error: "temporary" });
  assert.equal(acc.totals.questsCompleted, 0);
  acc.recordQuestResult({ questId: "one", ok: true, claimedAt: new Date(), rewardType: 3 });
  acc.recordQuestResult({ questId: "one", ok: true, claimedAt: new Date(), rewardType: 3 });
  acc.recordQuestResult({ questId: "two", claimedAt: new Date(), orbsClaimed: 50, rewardType: 4 });
  assert.equal(acc.questLog.length, 2);
  assert.equal(acc.questLog[0].attempts, 3);
  assert.equal(acc.questLog[0].error, undefined);
  assert.equal(acc.totals.questsCompleted, 2);
  assert.equal(acc.totals.cosmeticsClaimed, 1);
  assert.equal(acc.totals.orbsClaimed, 50);
});

test("save encrypts legacy credentials and remains readable", async () => {
  const acc = new Account({ userId: "123456789012345678", credentials: { token: "legacy-token", password: "legacy-password", inboxUrl: "https://example.test/private" } });
  await Account.schema.s.hooks.execPre("save", acc, []);
  for (const field of ["token", "password", "inboxUrl"]) assert.ok(isEncrypted(acc.credentials[field]));
  assert.equal(decrypt(acc.credentials.token), "legacy-token");
  const encrypted = acc.credentials.token;
  await Account.schema.s.hooks.execPre("save", acc, []);
  assert.equal(acc.credentials.token, encrypted);
});

test("admin claim workflow", async (t) => {
  const acc = new Account({ _id: id, userId: "123456789012345678", credentials: { token: "test-token" }, probes: [] });
  let saves = 0, requests = [], failList = false, failClaim = false, claimWithoutCaptcha = false;
  let pendingMode = false, enrolled = false, completedConfig;
  acc.save = async () => { saves++; };
  const fakeModel = {
    find: () => ({ lean: async () => [acc.toObject()] }),
    findById: async () => acc,
  };
  const store = new session.MemoryStore();
  const app = express(); app.use(express.json());
  app.use(session({ store, secret: "test-session-secret", resave: false, saveUninitialized: true }));
  app.use((req, res, next) => { req.session.admin = req.headers["x-role"] ? { role: req.headers["x-role"] } : null; next(); });
  app.use(createRouter({ Model: fakeModel,
    list: async () => {
      if (failList) throw new Error("private transport details");
      if (pendingMode) return [{ ...quest, userStatus: null, taskConfig: enrolled ? { tasks: { WATCH_VIDEO_ON_MOBILE: { target: 20 }, PLAY_ON_DESKTOP: { target: 30 } } } : null }];
      return [quest];
    },
    enroll: async () => { enrolled = true; },
    complete: async (session, questId, config) => { completedConfig = config; return { completed_at: "2026-10-26T00:00:00Z" }; },
    request: async (host, opts) => {
      requests.push(opts);
      if (claimWithoutCaptcha || opts.headers["X-Captcha-Key"]) {
        if (failClaim) return { status: 400, data: { captcha_key: ["private"] } };
        return { status: 200, data: { claimed_at: "2026-10-26T00:00:00Z" } };
      }
      return { status: 400, data: { captcha_sitekey: "site-key", captcha_rqdata: "rq-data", captcha_rqtoken: "request-token", captcha_session_id: "challenge-session" } };
    },
  }));
  const server = await new Promise((resolve, reject) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); s.on("error", reject); });
  const base = "http://127.0.0.1:" + server.address().port + "/admin/discord-farm";
  let cookie;
  const call = async (path, body, role = "superadmin") => {
    const r = await fetch(base + path, { headers: { Accept: "application/json", "Content-Type": "application/json", ...(role ? { "x-role": role } : {}), ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    if (r.headers.get("set-cookie")) cookie = r.headers.get("set-cookie").split(";")[0];
    return { status: r.status, data: await r.json(), cache: r.headers.get("cache-control") };
  };
  try {
    await t.test("anonymous and ordinary admins cannot read accounts", async () => {
      assert.equal((await call("/accounts", undefined, "")).status, 401);
      assert.equal((await call("/accounts", undefined, "admin")).status, 403);
    });
    await t.test("summaries never return credentials", async () => {
      const r = await call("/accounts");
      assert.equal(r.status, 200); assert.equal(r.cache, "no-store");
      assert.ok(!JSON.stringify(r.data).includes("test-token"));
    });
    await t.test("invalid ids and token types fail before network work", async () => {
      assert.equal((await call("/claim/bad/123", {})).status, 400);
      assert.equal((await call("/ingest", { token: {} })).status, 400);
      assert.equal(requests.length, 0);
    });
    await t.test("queue reports lookup errors even with no rows", async () => {
      failList = true;
      const r = await call("/queue");
      assert.deepEqual(r.data.queue, []); assert.equal(r.data.errors.length, 1);
      assert.ok(!JSON.stringify(r.data).includes("private transport"));
      failList = false;
    });
    await t.test("pending quests discover task config after enrollment and dispatch only video", async () => {
      pendingMode = true;
      const result = await call(`/complete-pending/${id}`, {});
      assert.equal(result.status, 200);
      assert.equal(result.data.completed[0].status, "completed");
      assert.ok(enrolled);
      assert.deepEqual(Object.keys(completedConfig.tasks), ["WATCH_VIDEO_ON_MOBILE"]);
      pendingMode = false;
    });
    await t.test("claim requires a challenge from this session", async () => {
      assert.equal((await call(`/claim/${id}/${quest.id}`, { captchaKey: "solved" })).status, 409);
    });
    await t.test("challenge binds metadata, request token, account and quest", async () => {
      const triggered = await call(`/trigger-captcha/${id}/${quest.id}`, {});
      assert.equal(triggered.data.sitekey, "site-key");
      assert.equal(triggered.data.trafficMetadataSealed, undefined);
      assert.equal((await call(`/claim/${id}/999`, { captchaKey: "solved" })).status, 409);
      const claimed = await call(`/claim/${id}/${quest.id}`, { captchaKey: "solved", trafficMetadataSealed: "tampered", captchaRqtoken: "tampered" });
      assert.equal(claimed.status, 200);
      const sent = requests.at(-1);
      assert.equal(sent.headers["X-Captcha-Rqtoken"], "request-token");
      assert.equal(sent.headers["X-Captcha-Session-Id"], "challenge-session");
      assert.equal(sent.body.traffic_metadata_sealed, "server-metadata");
      assert.equal(acc.totals.cosmeticsClaimed, 1);
      assert.equal((await call(`/claim/${id}/${quest.id}`, { captchaKey: "solved" })).status, 409);
    });
    await t.test("rejected solves are consumed and do not increment totals", async () => {
      await call(`/trigger-captcha/${id}/${quest.id}`, {}); failClaim = true;
      const r = await call(`/claim/${id}/${quest.id}`, { captchaKey: "bad-solve" });
      assert.equal(r.status, 502); assert.equal(r.data.httpStatus, 400);
      assert.equal(acc.totals.questsCompleted, 1);
      assert.equal((await call(`/claim/${id}/${quest.id}`, { captchaKey: "bad-solve" })).status, 409);
      failClaim = false;
    });
    await t.test("expired challenges require a fresh trigger", async () => {
      await call(`/trigger-captcha/${id}/${quest.id}`, {});
      await new Promise((resolve, reject) => store.all((err, sessions) => {
        if (err) return reject(err);
        const [sid, data] = Object.entries(sessions).find(([, value]) => value.discordClaim);
        data.discordClaim.at = Date.now() - 6 * 60 * 1000;
        store.set(sid, data, resolve);
      }));
      assert.equal((await call(`/claim/${id}/${quest.id}`, { captchaKey: "solved" })).status, 409);
    });
    await t.test("success at trigger persists without double counting", async () => {
      claimWithoutCaptcha = true;
      const before = saves;
      const r = await call(`/trigger-captcha/${id}/${quest.id}`, {});
      assert.equal(r.data.alreadyClaimed, true); assert.equal(saves, before + 1);
      assert.equal(acc.questLog.length, 1); assert.equal(acc.totals.cosmeticsClaimed, 1);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

test("standalone farmer retries with the challenge request token", async () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const sent = [];
  const sandbox = { module: { exports: {} }, Buffer, setTimeout,
    require: (name) => {
      assert.equal(name, "./discordHttp");
      return { buildSuperProperties: () => "properties", discordRequest: async (host, opts) => {
        sent.push(opts);
        return sent.length === 1
          ? { status: 400, data: { captcha_sitekey: "site", captcha_rqdata: "data", captcha_rqtoken: "bound-token", captcha_session_id: "bound-session" } }
          : { status: 200, data: { claimed_at: "2026-10-26T00:00:00Z" } };
      } };
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../utils/discordFarm/discordQuestFarmer"), "utf8"), sandbox);
  const logs = [];
  await sandbox.module.exports.claimReward({ token: "session" }, "123", async () => "secret-solve", { log: (line) => logs.push(line) });
  assert.equal(sent[1].headers["X-Captcha-Rqtoken"], "bound-token");
  assert.equal(sent[1].headers["X-Captcha-Session-Id"], "bound-session");
  assert.equal(sent[1].headers["X-Captcha-Key"], "secret-solve");
  assert.ok(!logs.join("\n").includes("secret-solve"));
});

test("panel script compiles and does not embed data in event handlers", () => {
  const fs = require("node:fs"), vm = require("node:vm");
  const html = fs.readFileSync(require("node:path").join(__dirname, "../public/discord-farm.html"), "utf8");
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new vm.Script(script));
  assert.ok(!script.includes('onclick="'));
});
