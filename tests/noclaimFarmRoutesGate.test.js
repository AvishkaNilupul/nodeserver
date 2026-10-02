/* global fetch */
// The no-claim console's two create-side routes (routes/noclaimFarmRoutes.js),
// as the 2026-10-03 review left them:
//
//   * the create form's pool count (GET /api/noclaim-farm/pool) must be the
//     count a create checks itself against — noclaimFleet.spendable, with its
//     password, committed-ledger and pristine-reserve rules. It counted every
//     ready row, so the form offered accounts the create then refused;
//   * the personal-bot route builds a container like any create, so it takes
//     the same cap + host-RAM gate; and it marks the bot personal BEFORE its
//     config exists. Marked after a launch that failed, it never was — leaving
//     a config-only bot with no marker, which the fleet allocator counts as a
//     stuck provision for that game and builds no other bot around.
//
// No database, no SSH: the router is mounted in a bare express app with a stub
// superadmin session, and everything it requires is a fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const express = require("express");

const ROUTES = require.resolve("../routes/noclaimFarmRoutes");

function fakeFleet(over = {}) {
  const calls = [];
  const rec = (name, ret) => async (...args) => {
    calls.push(name);
    return typeof ret === "function" ? ret(...args) : ret;
  };
  return {
    calls,
    BASE: "/b",
    BOTS_DIR: "/b/bots",
    IMAGE: "twitchbot-noclaim:latest",
    CONTAINER_PREFIX: "noclaim-bot-",
    MAX_PER_BOT: 70,
    pi: () => ({ id: "contabo" }),
    sh: rec("sh", ""),
    containerFor: (id) => "noclaim-bot-" + id,
    botDir: (id) => "/b/bots/" + id,
    configPath: (id) => "/b/bots/" + id + "/Configuration/config.json",
    markerPath: (id) => "/b/bots/" + id + "/.autostopped",
    operatorMarkerPath: (id) => "/b/bots/" + id + "/.operatoroff",
    readyPoolQuery: () => ({ status: "available" }), // what the old count used
    assertNoClaimGame: (g) => g,
    spendable: rec("spendable", { ready: 7, reserve: 2, spendable: 5, pristineHeld: 150 }),
    findSecretInConfigs: rec("findSecretInConfigs", []),
    newContainerGate: rec("newContainerGate", { ok: true, reason: "" }),
    provisionBusy: rec("provisionBusy", false),
    nextBotId: rec("nextBotId", "9"),
    setPersonal: rec("setPersonal", true),
    writeBotConfig: rec("writeBotConfig", undefined),
    launchProvision: rec("launchProvision", "9"),
    createBotFromAccounts: rec("createBotFromAccounts", "9"),
    ...over,
  };
}

async function serve(fleet) {
  const seen = { fenced: 0, events: [], spendableArgs: [] };
  const stubs = new Map([
    ["../utils/noclaimFleet", fleet],
    ["../utils/botHosts", { shq: (s) => "'" + String(s).replace(/'/g, "'\\''") + "'" }],
    ["../utils/settings", { getAutoFarm: () => ({ poolReserve: 20, noClaimGames: ["overwatch"] }) }],
    ["../utils/twitchInventory", { fetchInventory: async () => ({ drops: [], inProgress: [] }) }],
    ["../utils/socialPost", { buildSocialPost: () => "" }],
    ["../utils/setImage", { buildSetGridImage: async () => "" }],
    [
      "../models/AvailableAccount",
      {
        countDocuments: async () => 999, // the old count: every "ready" row
        updateOne: async () => {
          seen.fenced++;
          return {};
        },
      },
    ],
    ["../models/BotAccount", {}],
    ["../models/NoclaimSpentAccount", {}],
    ["../models/UnclaimedAccount", {}],
    ["../utils/secretBox", { decrypt: (s) => s }],
    ["../utils/poolUsageLog", { recordPoolUsage: async () => {} }],
    ["../utils/systemLog", { logEvent: (e) => seen.events.push(e), actorFromReq: () => "test" }],
    ["../utils/noclaimWatcher", {}],
    ["../utils/unclaimedAutoList", {}],
    [
      "../utils/accountLookup",
      {
        lookupAccountByUsername: async () => ({
          found: true,
          primarySource: "pool",
          sources: [{ source: "pool", id: "p1", login: "me", clientToken: "tok", twitchId: "123" }],
        }),
      },
    ],
  ]);
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /noclaimFarmRoutes\.js$/.test(parent.filename || "");
    if (from && stubs.has(request)) return stubs.get(request);
    return realLoad.call(this, request, parent, isMain);
  };
  let router;
  try {
    delete require.cache[ROUTES];
    router = require(ROUTES);
    delete require.cache[ROUTES];
  } finally {
    Module._load = realLoad;
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { admin: { id: "root", username: "root", role: "superadmin" } };
    next();
  });
  app.use(router);
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return {
    seen,
    get: (p) => call("GET", p),
    post: (p, b) => call("POST", p, b),
    close: () => new Promise((r) => server.close(r)),
  };
}

test("the create form's pool count is the count a create checks itself against", async () => {
  const args = [];
  const fleet = fakeFleet({
    spendable: async (game) => {
      args.push(game);
      return { ready: 7, reserve: 2, spendable: 5, pristineHeld: 150 };
    },
  });
  const s = await serve(fleet);
  try {
    const r = await s.get("/api/noclaim-farm/pool?game=Overwatch");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { success: true, ready: 7, reserve: 2, spendable: 5, pristineHeld: 150 });
    assert.deepEqual(args, ["Overwatch"]);
    await s.get("/api/noclaim-farm/pool");
    assert.deepEqual(args, ["Overwatch", ""]);
  } finally {
    await s.close();
  }
});

test("a personal bot takes the same container gate: refused, nothing is written or fenced", async () => {
  const fleet = fakeFleet({
    newContainerGate: async () => {
      fleet.calls.push("newContainerGate");
      return { ok: false, reason: "host contabo has 900 MB of RAM free, under the 1500 MB a new container needs" };
    },
  });
  const s = await serve(fleet);
  try {
    const r = await s.post("/api/noclaim-farm/personal-bots", { username: "me", game: "Overwatch" });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /900 MB/);
    for (const step of ["nextBotId", "setPersonal", "writeBotConfig", "launchProvision", "createBotFromAccounts"])
      assert.ok(!fleet.calls.includes(step), step + " must not run");
    assert.equal(s.seen.fenced, 0, "the pool row is not fenced for a bot that was never built");
  } finally {
    await s.close();
  }
});

test("a personal bot is marked personal before its config exists, so a failed launch blocks nothing", async () => {
  const launchFails = async () => {
    throw new Error("ssh: launch timed out");
  };
  const fleet = fakeFleet({
    launchProvision: async () => {
      fleet.calls.push("launchProvision");
      return launchFails();
    },
    // What the old route called: config write + launch in one, failing the same way.
    createBotFromAccounts: async () => {
      fleet.calls.push("createBotFromAccounts");
      return launchFails();
    },
  });
  const s = await serve(fleet);
  try {
    const r = await s.post("/api/noclaim-farm/personal-bots", { username: "me", game: "Overwatch" });
    const at = (step) => fleet.calls.indexOf(step);
    assert.ok(at("setPersonal") >= 0, "the bot is marked personal: " + fleet.calls.join(" > "));
    assert.ok(at("setPersonal") < at("writeBotConfig"), "marked before its config exists");
    assert.ok(at("writeBotConfig") < at("launchProvision"));
    assert.equal(r.status, 200);
    assert.match(r.body.provisionError, /launch timed out/);
    assert.match(r.body.message, /marked as yours/);
    const ev = s.seen.events.find((e) => e.action === "personal_bot_created");
    assert.match(ev.detail, /did not start/);
  } finally {
    await s.close();
  }
});

test("a personal bot that launches is gated, marked, written and launched in that order", async () => {
  const fleet = fakeFleet();
  const s = await serve(fleet);
  try {
    const r = await s.post("/api/noclaim-farm/personal-bots", { username: "me", game: "Overwatch" });
    assert.equal(r.status, 200);
    assert.equal(r.body.provisionError, undefined);
    assert.deepEqual(
      fleet.calls.filter((c) => c !== "sh"),
      ["findSecretInConfigs", "newContainerGate", "provisionBusy", "nextBotId", "setPersonal", "writeBotConfig", "launchProvision"],
    );
    assert.equal(s.seen.fenced, 1);
  } finally {
    await s.close();
  }
});
