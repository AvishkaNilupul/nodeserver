/* global fetch */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Receipt = require("../models/TwitchRewardReceipt");
const Account = require("../models/TwitchRewardAccount");
const SystemEvent = require("../models/SystemEvent");
const { GTA_GIVEAWAY, GTA_ID } = require("../utils/twitchRewardCampaigns");
const { randomBytes } = require("node:crypto");
const router = require("../routes/twitchRewardRoutes");
const settings = require("../utils/settings");

let database, server, base, feedMock;
const fixture = {
  id: "test-campaign",
  name: "Test campaign",
  status: "ACTIVE",
  startsAt: "2020-01-01T00:00:00Z",
  endsAt: "2099-01-01T00:00:00Z",
  rewards: [{ name: "Watch badge" }],
};

test.before(async () => {
  database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
  await Promise.all([Receipt.init(), Account.init()]);
  feedMock = test.mock.method(axios, "get", async () => ({
    data: { refreshedAt: new Date().toISOString(), campaigns: [fixture] },
  }));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-test-role"])
      req.session = {
        admin: {
          id: req.headers["x-test-admin"] || "one",
          role: req.headers["x-test-role"],
          tfa: req.headers["x-test-tfa"] !== "no",
        },
      };
    next();
  });
  app.use(require("../middleware/auditRequest"));
  app.use(router);
  server = await new Promise((resolve) => {
    const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
  });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  feedMock?.mock.restore();
  await mongoose.disconnect();
  if (database) await database.stop();
});

function request(
  path,
  { role = "superadmin", admin = "one", tfa = "yes", body, method } = {},
) {
  return fetch(base + path, {
    method: method || (body ? "PUT" : "GET"),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-test-role": role,
      "x-test-admin": admin,
      "x-test-tfa": tfa,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const viewerPath = "/api/twitch-rewards/viewers/Example_View/receipts";
const confirmed = {
  campaignId: fixture.id,
  reward: "Watch badge",
  confirmed: true,
};

test("the existing two-factor gate also covers the rewards page, catalog, and viewer records", async (t) => {
  t.mock.method(settings, "getRequire2fa", () => true);
  for (const path of [
    "/twitch-rewards.html",
    "/api/twitch-rewards/campaigns",
    "/api/twitch-rewards/accounts",
    "/api/twitch-rewards/viewers/example/code/reveal",
    viewerPath,
  ]) {
    assert.equal((await request(path, { tfa: "no" })).status, 403);
  }
});

test("new page, feed and receipt routes all require a superadmin", async () => {
  for (const path of [
    "/twitch-rewards.html",
    "/api/twitch-rewards/campaigns",
    "/api/twitch-rewards/accounts",
    "/api/twitch-rewards/viewers/example/code/reveal",
    viewerPath,
  ]) {
    assert.equal((await request(path, { role: "" })).status, 401);
    assert.equal((await request(path, { role: "seller" })).status, 403);
  }
  const page = await request("/twitch-rewards.html");
  assert.match(await page.text(), /My Twitch inventory/);
  assert.match(page.headers.get("cache-control"), /no-store/);
  assert.equal(
    (await (await request("/api/twitch-rewards/campaigns")).json()).campaigns[0]
      .id,
    fixture.id,
  );
});

test("confirmations are idempotent, scoped by viewer and admin, and reversible", async () => {
  const writes = await Promise.all([
    request(viewerPath, { body: confirmed }),
    request(viewerPath, { body: confirmed }),
  ]);
  assert.ok(writes.every((r) => r.status === 200));
  const result = await (await request(viewerPath.toLowerCase())).json();
  assert.equal(result.viewer, "example_view");
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].reward, "Watch badge");
  assert.deepEqual(
    (await (await request(viewerPath, { admin: "two" })).json()).receipts,
    [],
  );
  assert.deepEqual(
    (await (await request(viewerPath.replace("Example_View", "second"))).json())
      .receipts,
    [],
  );
  assert.equal(
    (await request(viewerPath, { body: { ...confirmed, confirmed: false } }))
      .status,
    200,
  );
  assert.equal(await Receipt.countDocuments(), 0);
});

test("receipt input only accepts a listed award and a valid viewer", async () => {
  assert.equal(
    (await request(viewerPath.replace("Example_View", "bad%20login"))).status,
    400,
  );
  assert.equal(
    (await request(viewerPath, { body: { ...confirmed, confirmed: "yes" } }))
      .status,
    400,
  );
  assert.equal(
    (
      await request(viewerPath, {
        body: { ...confirmed, reward: "arbitrary code" },
      })
    ).status,
    400,
  );
  assert.equal(await Receipt.countDocuments(), 0);
});

const accountsUrl = "/api/twitch-rewards/accounts";
const accountPath = (name) => "/api/twitch-rewards/viewers/" + name;
const gameKey = { campaignId: GTA_GIVEAWAY.id, reward: GTA_GIVEAWAY.name };

test("500 distinct viewers, including historic receipt-only viewers, produce scoped and paginated totals", async () => {
  const admin = "roster";
  const names = Array.from(
    { length: 500 },
    (_, i) => "fixture_" + String(i).padStart(3, "0"),
  );
  await Account.insertMany(
    names.slice(0, 401).map((viewer) => ({ adminId: admin, viewer })),
  );
  await Receipt.insertMany(
    names.slice(250).map((viewer) => ({
      adminId: admin,
      viewer,
      campaignId: fixture.id,
      reward: "Watch badge",
    })),
  );
  const initial = await (await request(accountsUrl, { admin })).json();
  assert.deepEqual(initial.totals, {
    tracked: 500,
    farmed: 250,
    rewards: 250,
    codes: 0,
    redeemed: 0,
  });
  assert.equal(initial.rows.length, 25);
  assert.equal(initial.matched, 500);
  assert.ok(initial.rows.every((row) => Date.parse(row.lastSeen)));
  const filtered = await (
    await request(accountsUrl + "?filter=farmed&q=FIXTURE_4&page=4", { admin })
  ).json();
  assert.deepEqual(filtered.totals, initial.totals);
  assert.equal(filtered.matched, 100);
  assert.equal(filtered.rows.length, 25);
  assert.ok(
    filtered.rows.every(
      (row) => row.viewer.startsWith("fixture_4") && row.rewards === 1,
    ),
  );
  const newName = accountPath("FiXtUrE_499");
  const retried = await Promise.all([
    request(newName, { admin, body: {} }),
    request(newName, { admin, body: {} }),
  ]);
  assert.ok(retried.every((r) => r.ok));
  assert.equal(
    await Account.countDocuments({ adminId: admin, viewer: "fixture_499" }),
    1,
  );
  assert.deepEqual(
    (await (await request(accountsUrl, { admin })).json()).totals,
    initial.totals,
  );
  assert.equal(
    (await (await request(accountsUrl, { admin: "other-roster" })).json())
      .totals.tracked,
    0,
  );
  assert.equal(
    (await request(accountsUrl + "?page=-1", { admin })).status,
    400,
  );
  assert.equal((await request(accountsUrl + "?q=.*", { admin })).status, 400);
  assert.equal(
    (await request(accountPath("fixture_499"), { admin, method: "DELETE" }))
      .status,
    409,
  );
  assert.equal(
    (await request(accountPath("fixture_000"), { admin, method: "DELETE" }))
      .status,
    200,
  );
  assert.equal(
    (await (await request(accountsUrl, { admin })).json()).totals.tracked,
    499,
  );
});

test("issued codes are encrypted, counted once, scoped, and safely correctable", async () => {
  const previous = process.env.CRED_SECRET;
  process.env.CRED_SECRET = randomBytes(32).toString("hex");
  try {
    const admin = "code-owner";
    const login = "code_viewer";
    const path = accountPath(login);
    const issued = "TEST-" + randomBytes(10).toString("hex");
    const data = {
      ...gameKey,
      secretCode: issued,
      platform: "PS5",
      region: "Japan",
    };
    const call = (suffix, method, body, operator = admin) =>
      request(path + suffix, { method, body, admin: operator });
    const rows = async () =>
      (await (await call("/receipts", "GET")).json()).receipts;
    const totals = async () =>
      (await (await request(accountsUrl, { admin })).json()).totals;
    const claims = await Promise.all(
      Array.from({ length: 4 }, () => call("/code", "PUT", data)),
    );
    assert.ok(claims.every((r) => r.ok));
    const [row] = await rows();
    assert.equal(row.platform, "PS5");
    assert.equal(row.region, "Japan");
    assert.equal(row.codeCipher, undefined);
    assert.equal(row.codeFingerprint, undefined);
    assert.equal(JSON.stringify(row).includes(issued), false);
    const raw = await Receipt.collection.findOne({
      adminId: admin,
      viewer: login,
    });
    assert.ok(raw.codeCipher.startsWith("enc:v1:"));
    assert.equal(JSON.stringify(raw).includes(issued), false);
    assert.equal(
      (
        await request(accountPath("second_viewer") + "/code", {
          admin,
          body: {
            ...data,
            secretCode: issued.toLowerCase().replaceAll("-", ""),
          },
        })
      ).status,
      409,
    );
    assert.equal(
      (await call("/code", "PUT", { ...data, secretCode: issued + "2" }))
        .status,
      409,
    );
    assert.equal(
      (await call("/receipts", "PUT", { ...gameKey, confirmed: false })).status,
      409,
    );
    const key = { ...gameKey, version: row.codeVersion };
    const reveal = await call("/code/reveal", "POST", key);
    assert.match(reveal.headers.get("cache-control"), /no-store/);
    assert.deepEqual(await reveal.json(), { code: issued });
    assert.equal(
      (await call("/code/reveal", "POST", key, "different-owner")).status,
      404,
    );
    assert.equal(
      (await call("/code", "DELETE", key, "different-owner")).status,
      404,
    );
    assert.equal(
      (await call("/code", "PATCH", { ...key, redeemed: true })).status,
      200,
    );
    const redeemedAt = (await rows())[0].codeRedeemedAt;
    assert.equal(
      (await call("/code", "PATCH", { ...key, redeemed: true })).status,
      200,
    );
    assert.equal((await rows())[0].codeRedeemedAt, redeemedAt);
    assert.deepEqual(await totals(), {
      tracked: 1,
      farmed: 1,
      rewards: 1,
      codes: 1,
      redeemed: 1,
    });
    assert.equal(
      (await (await request(accountsUrl + "?filter=codes", { admin })).json())
        .matched,
      1,
    );
    assert.equal(
      (await call("/code", "PATCH", { ...key, redeemed: false })).status,
      200,
    );
    assert.equal((await totals()).redeemed, 0);
    assert.equal((await call("/code", "DELETE", key)).status, 200);
    assert.deepEqual(await totals(), {
      tracked: 1,
      farmed: 1,
      rewards: 1,
      codes: 0,
      redeemed: 0,
    });
    assert.equal(
      (await call("/code", "PUT", { ...data, secretCode: issued + "3" }))
        .status,
      200,
    );
    assert.equal((await call("/code", "DELETE", key)).status, 404);
    assert.equal((await call("/code/reveal", "POST", key)).status, 404);
    assert.equal(
      (await call("/code", "PUT", { ...data, secretCode: "enc:v1:broken" }))
        .status,
      400,
    );
    assert.equal(
      (await call("/code", "PUT", { ...data, campaignId: GTA_ID })).status,
      400,
    );
    assert.equal(
      (
        await call("/code", "PUT", {
          ...data,
          ...confirmed,
          secretCode: issued + "4",
        })
      ).status,
      409,
    );
    assert.equal((await call("/receipts", "PUT", confirmed)).status, 200);
    assert.equal(
      (
        await call("/code", "PUT", {
          ...data,
          ...confirmed,
          secretCode: issued + "4",
        })
      ).status,
      200,
    );
    const auditRows = await SystemEvent.find({
      route: path + "/code",
      method: "PUT",
    }).lean();
    assert.ok(auditRows.length > 0);
    assert.ok(
      auditRows.every((event) => event.meta.secretCode === "[redacted]"),
    );
    assert.equal(JSON.stringify(auditRows).includes(issued), false);
    assert.deepEqual(await totals(), {
      tracked: 1,
      farmed: 1,
      rewards: 2,
      codes: 2,
      redeemed: 0,
    });
  } finally {
    if (previous === undefined) delete process.env.CRED_SECRET;
    else process.env.CRED_SECRET = previous;
  }
});

test("dedicated reward farm endpoints are scoped, guarded and keep ordinary drop claims off", async (t) => {
  t.mock.method(settings, "getRequire2fa", () => true);
  const FarmBot = require("../models/TwitchRewardFarmBot");
  const farm = require("../utils/twitchRewardFarm");
  const row = await FarmBot.create({ adminId: "farm-owner", poolAccountId: new mongoose.Types.ObjectId(), viewer: "synthetic_farm", twitchId: "123", desired: "stopped" });
  const own = await request("/api/twitch-rewards/farm", { admin: "farm-owner" });
  assert.equal(own.status, 200);
  const data = await own.json();
  assert.equal(data.bots.length, 1);
  assert.equal(data.bots[0].poolAccountId, undefined);
  const other = await request("/api/twitch-rewards/farm", { admin: "other" });
  assert.equal((await other.json()).bots.length, 0);
  assert.equal((await request("/api/twitch-rewards/farm", { role: "admin" })).status, 403);
  assert.equal((await request("/api/twitch-rewards/farm", { tfa: "no" })).status, 403);
  const bad = await request("/api/twitch-rewards/farm/invalid/start", { method: "POST", body: {} });
  assert.equal(bad.status, 400);
  const cfg = farm.workerConfig({ username: "fixture", twitchId: "123", clientSecret: "fixture-only" });
  assert.equal(cfg.TwitchSettings.ClaimDrops, false);
  assert.equal(cfg.TwitchSettings.RewardCampaignsOnly, true);
  assert.equal(cfg.TwitchSettings.CollectRewardCodes, true);
  assert.equal(cfg.WebhookURL, "");
  assert.deepEqual(farm.parseActivity("Token: never display this\nReward watch active; Twitch has not reported a timed progress counter."), {
    activity: "Reward watch active; Twitch has not reported a timed progress counter.", currentMinutes: null, requiredMinutes: null });
  assert.equal(farm.parseActivity("Reward watch progress reported by Twitch: 2/60 minutes (not a game-code count).").currentMinutes, 2);
  const q = farm.claimQuery(["fenced"], { protect: "reserve" }, { logins: ["listed"], poolIds: [String(row.poolAccountId)] });
  assert.deepEqual(q.$and[0].clientSecret.$nin, ["fenced"]);
  assert.deepEqual(q.$and[0].usernameLower.$nin, ["listed"]);
  assert.equal(q.$and[0]["soldGames.0"].$exists, false);
  await FarmBot.deleteOne({ _id: row._id });
});

test("worker code import is encrypted, identity-checked, idempotent and visible in existing account totals", async (t) => {
  const oldSecret = process.env.CRED_SECRET;
  process.env.CRED_SECRET = randomBytes(32).toString("hex");
  t.after(() => { if (oldSecret === undefined) delete process.env.CRED_SECRET; else process.env.CRED_SECRET = oldSecret; });
  const farm = require("../utils/twitchRewardFarm");
  const bot = { adminId: "import-owner", viewer: "fixture_import", twitchId: "123" };
  const receipt = { AccountId: "123", Login: "fixture_import", Code: "SYNTHETIC-REWARD-KEY", CampaignName: "GTA VI Ultimate Edition giveaway" };
  await assert.rejects(farm.importCode(bot, { ...receipt, AccountId: "456" }), /mismatch/);
  await assert.rejects(farm.importCode(bot, { ...receipt, CampaignName: "Different game" }), /another campaign/);
  await farm.importCode(bot, receipt);
  await farm.importCode(bot, receipt);
  const rows = await Receipt.find({ adminId: bot.adminId }).select("+codeCipher +codeFingerprint").lean();
  assert.equal(rows.length, 1);
  assert.ok(rows[0].codeCipher.startsWith("enc:v1:"));
  assert.ok(!JSON.stringify(rows).includes(receipt.Code));
  await assert.rejects(farm.importCode(bot, { ...receipt, Code: "DIFFERENT-REWARD-KEY" }), /conflicts/);
  const r = await request("/api/twitch-rewards/accounts", { admin: bot.adminId });
  const data = await r.json();
  assert.equal(data.totals.codes, 1);
  assert.equal(data.totals.farmed, 1);
});

test("dedicated bot creation reserves atomically, writes a private reward-only config, and stop keeps ownership", async (t) => {
  const farm = require("../utils/twitchRewardFarm");
  const hosts = require("../utils/botHosts");
  const fences = require("../utils/fleetIntegrity");
  const fleet = require("../utils/noclaimFleet");
  const guard = require("../utils/pristineReserve");
  const Pool = require("../models/AvailableAccount");
  const FarmBot = require("../models/TwitchRewardFarmBot");
  t.mock.method(hosts, "resolveHost", () => ({ id: "fixture", transport: "ssh" }));
  let written;
  t.mock.method(hosts, "runShell", async (_host, script, options) => {
    if (options?.input) written = JSON.parse(options.input);
    return { stdout: script.includes("echo ABSENT") ? "ABSENT" : "" };
  });
  t.mock.method(fences, "claimFence", async () => ({ exclude: [] }));
  t.mock.method(fleet, "committedLedgers", async () => ({ logins: [], poolIds: [] }));
  t.mock.method(guard, "farmClaimFilter", async () => ({}));
  const nativeFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", (url, options) => String(url).startsWith("https://id.twitch.tv/")
    ? Promise.resolve({ ok: true, json: async () => ({ user_id: "123456", login: "fixture_reserved" }) })
    : nativeFetch(url, options));
  const account = await Pool.create({ username: "fixture_reserved", usernameLower: "fixture_reserved", twitchId: "123456",
    clientSecret: "synthetic-only", status: "available", lastCheckStatus: "ok", dropCount: 0, unclaimedDropCount: 0 });
  const id = await farm.create("fixture_owner");
  const claimed = await Pool.findById(account._id).lean();
  assert.equal(claimed.status, "claimed");
  assert.equal(claimed.claimedNote, "twitch-reward-farm:" + id);
  assert.equal(written.TwitchSettings.ClaimDrops, false);
  assert.equal(written.TwitchSettings.RewardCampaignsOnly, true);
  await farm.action("fixture_owner", id, "start");
  await farm.action("fixture_owner", id, "stop");
  assert.equal((await Pool.findById(account._id).lean()).status, "claimed");
  await assert.rejects(farm.action("another_owner", id, "start"), /not found/);
  await Pool.deleteOne({ _id: account._id });
  await FarmBot.deleteOne({ _id: id });
});
