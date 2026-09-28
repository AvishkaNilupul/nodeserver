/* global structuredClone */
// By-game no-claim offers (Eldorado / G2G / PlayerAuctions `unclaimedGame`) are
// RETIRED (owner, 2026-09-28: "move every offer to that path" — the set-based
// noclaimStock path). A by-game offer saw only ledgered accounts, never booked
// a sale's price, and needed a coverage gate of its own that once shipped on a
// stale database read.
//
// What is left may only FINISH an order a previous attempt already took
// accounts for. It never claims a new account — not even one whose live read
// covers the list — and a stock count of a by-game offer is 0.
//
// Mongo/Twitch-free: the ledger and the engine's live-read helpers are stubbed
// via Module._load; the REAL claim functions run.
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
  const calls = { find: [], writes: 0 };
  const query = (fn) => {
    const q = { sort: () => q, limit: () => q, lean: () => q, then: (a, b) => Promise.resolve().then(fn).then(a, b) };
    return q;
  };
  const write = async () => {
    calls.writes++;
    return null;
  };
  return {
    rows: data,
    calls,
    find: (q) => {
      calls.find.push(q);
      return query(() => data.filter((r) => matches(r, q)).map((r) => structuredClone(r)));
    },
    findOneAndUpdate: write,
    updateOne: write,
    updateMany: write,
    create: write,
  };
}

// Every account's live read covers the list — the old path would have shipped.
function load(file, { ledgers }) {
  const Ledger = fakeLedger(ledgers);
  const reads = [];
  const ual = {
    credentialForLedger: async (l) => ({ login: l.login, password: "pw-" + l.login }),
    manualSoldOwnerKeys: async () => new Set(),
    filterManualSoldLedgers: (x) => x,
    activeListingsForLogin: async () => [],
    candForLedger: async (l) => ({ login: l.login, clientSecret: "s-" + l.login }),
    inventoryForCandidate: async (c) => {
      reads.push(c.login);
      return { sellable: FULL.map(drop) };
    },
  };
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), Ledger],
    [require.resolve("../models/DropLog"), { find: () => ({ lean: async () => [] }) }],
    [require.resolve("../utils/unclaimedAutoList"), ual],
  ]);
  const path = require.resolve("../utils/" + file);
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
  delete require.cache[path];
  const mod = require("../utils/" + file);
  const restore = () => {
    Module._load = origLoad;
    delete require.cache[path];
  };
  return { mod, restore, Ledger, reads };
}

const OW = "Overwatch";
const drop = (name) => ({ name, game: OW, campaign: "OWCS", itemKey: name.toLowerCase() + "|overwatch" });
const FULL = ["Sun Tea Icon", "Esports Loot Box"];
const REQUIRED = FULL.map((name) => ({ name, qty: 1 }));
const ledger = (login, extra = {}) => ({
  _id: "L-" + login,
  source: "noclaim",
  status: "skipped",
  soldAt: null,
  login,
  loginLower: login,
  game: OW,
  drops: FULL.map(drop),
  lastCheckedAt: new Date(),
  ...extra,
});

for (const file of ["eldoradoFulfiller.js", "playerauctionsFulfiller.js"]) {
  test(file + ": a by-game claim never takes a new account — even one that covers the list", async () => {
    const h = load(file, { ledgers: [ledger("a")] });
    try {
      for (const dryRun of [true, false]) {
        const shortfall = {};
        const got = await h.mod.claimUnclaimedForGame(OW, 1, { orderId: "o1", dryRun, requiredDrops: REQUIRED, shortfall });
        assert.deepStrictEqual(got, [], "dryRun=" + dryRun + ": nothing to sell, and 0 stock");
        assert.match(shortfall.detail, /by-game offers are retired — move this offer to a no-claim set/);
      }
      assert.strictEqual(h.Ledger.rows[0].status, "skipped", "the free account stays free");
      assert.strictEqual(h.Ledger.calls.writes, 0, "no ledger write of any kind");
      assert.deepStrictEqual(h.reads, [], "no live read either — there is nothing to check");
    } finally {
      h.restore();
    }
  });
}

test("eldoradoFulfiller.js: an order a previous attempt already took accounts for gets the SAME accounts — never a top-up", async () => {
  const h = load("eldoradoFulfiller.js", {
    ledgers: [
      ledger("s1", { status: "sold", market: "eldorado", note: "eldorado order o1" }),
      ledger("g2g1", { status: "sold", market: "g2g", note: "g2g order o1" }),
      ledger("a"),
    ],
  });
  try {
    const shortfall = {};
    const got = await h.mod.claimUnclaimedForGame(OW, 2, { orderId: "o1", dryRun: false, shortfall });
    assert.deepStrictEqual(got.map((x) => x.login), ["s1"], "this market's order only");
    assert.match(shortfall.detail, /by-game offers are retired/, "the second account is not topped up");
    assert.strictEqual(h.Ledger.rows[2].status, "skipped");

    const g2g = await h.mod.claimUnclaimedForGame(OW, 1, { orderId: "o1", dryRun: false, shortfall: {}, market: "g2g" });
    assert.deepStrictEqual(g2g.map((x) => x.login), ["g2g1"], "G2G resumes through the same function");

    const full = {};
    const one = await h.mod.claimUnclaimedForGame(OW, 1, { orderId: "o1", dryRun: false, shortfall: full });
    assert.deepStrictEqual(one.map((x) => x.login), ["s1"]);
    assert.strictEqual(full.detail, undefined, "a fully resumed order has no shortfall");

    const before = h.Ledger.calls.find.length;
    assert.deepStrictEqual(await h.mod.claimUnclaimedForGame(OW, 1, { orderId: "o1", dryRun: true, shortfall: {} }), []);
    assert.strictEqual(h.Ledger.calls.find.length, before, "a dry run never even reads the resume");
    assert.strictEqual(h.Ledger.calls.writes, 0);
  } finally {
    h.restore();
  }
});
