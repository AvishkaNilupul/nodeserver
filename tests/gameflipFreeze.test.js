// The Gameflip freeze (owner, 2026-10-16): nothing may go on sale on Gameflip
// until Gameflip approves the Game Accounts category. Every path that lists
// there creates the listing through mp.gameflipPublish, so the gate lives at
// its top — and it must refuse BEFORE any API call, or a refused publish would
// still leave a draft (with credentials attached) on Gameflip.
//
// Each test loads a FRESH utils/marketplaces.js with axios and settings
// stubbed, so no real network or settings file is touched.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

function loadWithStubs(autoFarm) {
  const calls = [];
  const record = (method) => async (url) => {
    calls.push(method + " " + url);
    // Stop the publish at its first real call: these tests are about whether
    // Gameflip is reached at all, not about the rest of the publish dance.
    throw new Error("stub: " + method + " reached");
  };
  const stubAxios = {
    get: record("GET"),
    post: record("POST"),
    patch: record("PATCH"),
    put: record("PUT"),
    delete: record("DELETE"),
    create: () => stubAxios,
    defaults: { headers: {} },
    interceptors: { request: { use() {} }, response: { use() {} } },
  };
  const settingsObj = {
    marketplaces: { gameflip: { apiKey: "k", apiSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" } },
  };
  if (autoFarm !== undefined) settingsObj.autoFarm = autoFarm;
  const stubSettings = {
    loadSettings: () => settingsObj,
    saveSettings: () => {},
    getAutoFarm: () => ({}),
    getUnclaimedPricing: () => ({}),
  };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const fromMarketplaces = parent && /marketplaces\.js$/.test(parent.filename || "");
    if (request === "axios") return stubAxios;
    if (fromMarketplaces && request === "./settings") {
      return { ...realLoad.call(this, request, parent, isMain), ...stubSettings };
    }
    if (fromMarketplaces && request === "./secretBox") {
      return { ...realLoad.call(this, request, parent, isMain), decrypt: (v) => String(v || "") };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const path = require.resolve("../utils/marketplaces");
    delete require.cache[path];
    const mod = require("../utils/marketplaces");
    delete require.cache[path];
    return { mod, calls, settingsObj };
  } finally {
    Module._load = realLoad;
  }
}

const LISTING = { title: "Test bundle", description: "x", priceUsd: 1.5, imagePath: "" };

test("frozen: gameflipPublish refuses and never calls Gameflip", async () => {
  const { mod, calls } = loadWithStubs({ gameflipFrozen: true });
  await assert.rejects(mod.gameflipPublish(LISTING), /frozen until the Game Accounts approval/);
  assert.deepStrictEqual(calls, [], "a refused publish must not create even a draft");
});

test("frozen: an auto-delivery publish (credentials attached) is refused the same way", async () => {
  const { mod, calls } = loadWithStubs({ gameflipFrozen: true });
  await assert.rejects(
    mod.gameflipPublish({ ...LISTING, autoDeliverCode: "login: a\npassword: b" }),
    /frozen/,
  );
  assert.deepStrictEqual(calls, []);
});

test("not frozen: missing key, false or a non-true value still publish as before", async () => {
  for (const af of [undefined, {}, { gameflipFrozen: false }, { gameflipFrozen: "true" }]) {
    const { mod, calls } = loadWithStubs(af);
    await assert.rejects(mod.gameflipPublish(LISTING), (e) => !/frozen/.test(e.message));
    assert.ok(
      calls.some((c) => /^POST .*\/listing$/.test(c)),
      "with autoFarm " + JSON.stringify(af) + " the create call must still be made",
    );
  }
});

test("the switch is read on every call, so flipping it needs no restart", async () => {
  const { mod, calls, settingsObj } = loadWithStubs({ gameflipFrozen: true });
  assert.strictEqual(mod.gameflipFrozen(), true);
  await assert.rejects(mod.gameflipPublish(LISTING), /frozen/);
  settingsObj.autoFarm.gameflipFrozen = false;
  assert.strictEqual(mod.gameflipFrozen(), false);
  await assert.rejects(mod.gameflipPublish(LISTING), (e) => !/frozen/.test(e.message));
  assert.ok(calls.some((c) => /^POST /.test(c)));
});
