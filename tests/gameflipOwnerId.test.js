// Our own Gameflip owner id, and why an empty one is expensive rather than
// merely missing.
//
// marketResearch uses this id to drop OUR OWN rows from "the lowest live price
// for this game" (`markets.gameflip.lowestOther`). With no id there is nothing
// to exclude, so `lowestOther` collapses onto `lowest` — and every pricer that
// anchors on the cheapest rival starts anchoring on our own listing and
// undercutting it, scan after scan. That is the self-undercut spiral that once
// pinned every unclaimed row to the $0.75 floor.
//
// Measured on prod 2026-09-08: gameflipOwnerId() returned "" while
// gameflipTest() connected happily and gameflipListingIdsByStatus() returned
// 200 ids from the SAME /account/me/profile document. The cause was scoping —
// /account/me and its /account/me/profile fallback shared one try block, so the
// first endpoint throwing skipped the fallback entirely and fell to the outer
// catch. `lowestOther === lowest` on 6 of 8 sampled games.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

// Load a FRESH copy of utils/marketplaces.js with axios and settings stubbed,
// so the hour-long owner cache and the real network are both out of the way.
function loadWithStubs({ responses, keys = { apiKey: "k", apiSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" } }) {
  const calls = [];
  const stubAxios = {
    get: async (url) => {
      calls.push(url);
      const key = Object.keys(responses).find((k) => url.endsWith(k));
      const r = key ? responses[key] : undefined;
      if (r === undefined) throw new Error("404 not found: " + url);
      if (r instanceof Error) throw r;
      return r;
    },
    post: async () => ({ data: {} }),
    patch: async () => ({ data: {} }),
    put: async () => ({ data: {} }),
    create: () => stubAxios,
    defaults: { headers: {} },
    interceptors: { request: { use() {} }, response: { use() {} } },
  };
  const stubSettings = {
    loadSettings: () => ({ marketplaces: { gameflip: keys } }),
    saveSettings: () => {},
    getAutoFarm: () => ({}),
    getUnclaimedPricing: () => ({}),
  };
  const realResolve = Module._resolveFilename;
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const fromMarketplaces = parent && /marketplaces\.js$/.test(parent.filename || "");
    if (request === "axios") return stubAxios;
    if (fromMarketplaces && request === "./settings") {
      return { ...realLoad.call(this, request, parent, isMain), ...stubSettings };
    }
    // Stored keys are encrypted at rest, so getKeys() runs every field through
    // decrypt(). The stub settings hold plaintext, so decryption is the identity
    // here — this test is about endpoint scoping, not the secret box.
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
    return { mod, calls };
  } finally {
    Module._load = realLoad;
    Module._resolveFilename = realResolve;
  }
}

const PROFILE_WITH_OWNER = { data: { data: { owner: "owner-abc-123", display_name: "AvishkaREX" } } };

test("REGRESSION: /account/me throwing must not skip the profile fallback", async () => {
  // Exactly the live shape: /account/me errors, /account/me/profile is fine.
  const { mod } = loadWithStubs({
    responses: {
      "/account/me": new Error("Request failed with status code 404"),
      "/account/me/profile": PROFILE_WITH_OWNER,
    },
  });
  const id = await mod.gameflipOwnerId();
  assert.strictEqual(
    id,
    "owner-abc-123",
    "an empty owner id silently turns our own listing into 'the cheapest rival'",
  );
});

test("the profile endpoint is tried FIRST, since it is the one known to carry owner", async () => {
  const { mod, calls } = loadWithStubs({
    responses: {
      "/account/me": { data: { data: { owner: "from-account-me" } } },
      "/account/me/profile": PROFILE_WITH_OWNER,
    },
  });
  assert.strictEqual(await mod.gameflipOwnerId(), "owner-abc-123");
  assert.match(calls[0], /\/account\/me\/profile$/);
  assert.strictEqual(calls.length, 1, "a hit on the first endpoint must not call the second");
});

test("falls through to /account/me when the profile carries no owner", async () => {
  const { mod, calls } = loadWithStubs({
    responses: {
      "/account/me/profile": { data: { data: { display_name: "AvishkaREX" } } },
      "/account/me": { data: { data: { owner: "from-account-me" } } },
    },
  });
  assert.strictEqual(await mod.gameflipOwnerId(), "from-account-me");
  assert.strictEqual(calls.length, 2);
});

test("both endpoints failing returns \"\" and never throws", async () => {
  // Callers fall back to the unfiltered lowest rather than fail a whole scan,
  // so this must stay a quiet empty string.
  const { mod } = loadWithStubs({
    responses: {
      "/account/me": new Error("network down"),
      "/account/me/profile": new Error("network down"),
    },
  });
  assert.strictEqual(await mod.gameflipOwnerId(), "");
});

test("unconfigured keys return \"\" rather than throwing", async () => {
  const { mod } = loadWithStubs({ responses: {}, keys: {} });
  assert.strictEqual(await mod.gameflipOwnerId(), "");
});

test("a found id is cached, so a scan does not re-ask per game", async () => {
  const { mod, calls } = loadWithStubs({
    responses: { "/account/me/profile": PROFILE_WITH_OWNER },
  });
  assert.strictEqual(await mod.gameflipOwnerId(), "owner-abc-123");
  const after = calls.length;
  assert.strictEqual(await mod.gameflipOwnerId(), "owner-abc-123");
  assert.strictEqual(calls.length, after, "second call must be served from cache");
});
