/* global fetch */
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const axios = require("axios");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const Receipt = require("../models/TwitchRewardReceipt");
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
  await Receipt.init();
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
  { role = "superadmin", admin = "one", tfa = "yes", body } = {},
) {
  return fetch(base + path, {
    method: body ? "PUT" : "GET",
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
    viewerPath,
  ]) {
    assert.equal((await request(path, { tfa: "no" })).status, 403);
  }
});

test("new page, feed and receipt routes all require a superadmin", async () => {
  for (const path of [
    "/twitch-rewards.html",
    "/api/twitch-rewards/campaigns",
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
