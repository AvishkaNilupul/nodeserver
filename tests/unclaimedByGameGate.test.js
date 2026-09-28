/* global structuredClone */
// A by-game no-claim offer (Eldorado / G2G / PlayerAuctions `unclaimedGame`)
// hands over an account only on a LIVE read, and never without an item list
// (owner, 2026-09-28 — review item 6).
//
// Before: when the live inventory read failed, the gate fell back to the
// database snapshot and shipped on it (the snapshot that missed an expired wave
// on order 99d443eb), and an offer with no requiredDrops shipped any account of
// the game.
//
// Mongo/Twitch-free: the ledger, DropLog and the engine's live-read helpers are
// stubbed via Module._load; the REAL claim functions and coverage gate run.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

function matches(doc, q = {}) {
  return Object.entries(q).every(([k, cond]) => {
    const v = doc[k];
    if (cond instanceof RegExp) return typeof v === "string" && cond.test(v);
    if (cond && typeof cond === "object" && "$in" in cond) return cond.$in.includes(v);
    if (cond === null) return v == null;
    return String(v) === String(cond);
  });
}
function fakeLedger(rows) {
  const data = rows.map((r) => structuredClone(r));
  const query = (fn) => {
    const q = { sort: () => q, limit: () => q, lean: () => q, then: (a, b) => Promise.resolve().then(fn).then(a, b) };
    return q;
  };
  return {
    rows: data,
    find: (q) => query(() => data.filter((r) => matches(r, q)).map((r) => structuredClone(r))),
    findOneAndUpdate: async (q, u) => {
      const row = data.find((r) => matches(r, q));
      if (!row) return null;
      Object.assign(row, u.$set || {});
      return structuredClone(row);
    },
  };
}

// `live`: login -> sellable drops, or an Error for an unreadable account.
function load(file, { ledgers, live }) {
  const Ledger = fakeLedger(ledgers);
  const ual = {
    credentialForLedger: async (l) => ({ login: l.login, password: "pw-" + l.login }),
    manualSoldOwnerKeys: async () => new Set(),
    filterManualSoldLedgers: (x) => x,
    activeListingsForLogin: async () => [],
    candForLedger: async (l) => ({ login: l.login, clientSecret: "s-" + l.login }),
    inventoryForCandidate: async (c) => {
      const v = live[c.login];
      if (v instanceof Error) throw v;
      return { sellable: structuredClone(v || []) };
    },
  };
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), Ledger],
    [require.resolve("../models/DropLog"), { find: () => ({ lean: async () => [] }) }],
    [require.resolve("../utils/unclaimedAutoList"), ual],
  ]);
  const paths = [require.resolve("../utils/" + file), require.resolve("../utils/unclaimedCoverage")];
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    let resolved;
    try {
      resolved = Module._resolveFilename(request, parent, isMain);
    } catch {
      return origLoad.apply(this, arguments);
    }
    if (stubs.has(resolved)) return stubs.get(resolved);
    return origLoad.apply(this, arguments);
  };
  for (const p of paths) delete require.cache[p];
  const mod = require("../utils/" + file);
  const restore = () => {
    Module._load = origLoad;
    for (const p of paths) delete require.cache[p];
  };
  return { mod, restore, Ledger };
}

const OW = "Overwatch";
const drop = (name) => ({ name, game: OW, campaign: "OWCS", itemKey: name.toLowerCase() + "|overwatch" });
const ledger = (login, names) => ({
  _id: "L-" + login,
  source: "noclaim",
  status: "skipped",
  soldAt: null,
  login,
  loginLower: login,
  game: OW,
  drops: names.map(drop),
  lastCheckedAt: new Date(),
});
const REQUIRED = [{ name: "Sun Tea Icon", qty: 1 }, { name: "Esports Loot Box", qty: 1 }];
const FULL = ["Sun Tea Icon", "Esports Loot Box"];

for (const file of ["eldoradoFulfiller.js", "playerauctionsFulfiller.js"]) {
  test(file + ": an offer with no item list never delivers, and says why", async () => {
    const h = load(file, { ledgers: [ledger("a", FULL)], live: { a: FULL.map(drop) } });
    try {
      for (const dryRun of [true, false]) {
        const shortfall = {};
        const got = await h.mod.claimUnclaimedForGame(OW, 1, { orderId: "o1", dryRun, requiredDrops: [], shortfall });
        assert.deepStrictEqual(got, [], "dryRun=" + dryRun);
        assert.match(shortfall.detail, /declares no item list/);
      }
      assert.strictEqual(h.Ledger.rows[0].status, "skipped", "nothing claimed");
    } finally {
      h.restore();
    }
  });

  test(file + ": a failed live read holds the order, while stock counting may still lean on the ledger", async () => {
    const h = load(file, { ledgers: [ledger("a", FULL)], live: { a: new Error("pi timeout") } });
    try {
      const counted = await h.mod.claimUnclaimedForGame(OW, 1, { dryRun: true, requiredDrops: REQUIRED, shortfall: {} });
      assert.strictEqual(counted.length, 1, "a Pi hiccup does not zero the offer's stock");
      const shortfall = {};
      const shipped = await h.mod.claimUnclaimedForGame(OW, 1, { orderId: "o1", dryRun: false, requiredDrops: REQUIRED, shortfall });
      assert.deepStrictEqual(shipped, [], "nothing ships on the database snapshot");
      assert.strictEqual(h.Ledger.rows[0].status, "skipped");
      assert.match(shortfall.detail, /could not be read live — held/);
    } finally {
      h.restore();
    }
  });

  test(file + ": a live read that covers the list ships the account", async () => {
    const h = load(file, { ledgers: [ledger("a", FULL)], live: { a: FULL.map(drop) } });
    try {
      const shipped = await h.mod.claimUnclaimedForGame(OW, 1, { orderId: "o1", dryRun: false, requiredDrops: REQUIRED, shortfall: {} });
      assert.deepStrictEqual(shipped.map((x) => x.login), ["a"]);
      assert.strictEqual(h.Ledger.rows[0].status, "sold");
    } finally {
      h.restore();
    }
  });
}
