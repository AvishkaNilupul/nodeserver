/* global structuredClone */
// Auto-rebundle raises a title only to what the buyer would actually get
// (owner, 2026-09-28 — review item 4).
//
// Before: the target was the DOMINANT cohort of every listed ledger on the
// set+market, not the unit on sale (on 09-24 a 9× Rainbow Six Gameflip listing
// went to 12× because most of its set held 12 while the account on sale held 9);
// a set's "9×" was read as "1×"; GGSel offers were retitled although a unit the
// scan attaches later is only ever the set's smaller bundle.
//
// Mongo/Twitch/marketplace-free: models, the engine's live-read helpers and the
// marketplace client are stubbed via Module._load; the REAL audit module runs.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// Pure helpers of the real engine, taken before any stub is installed.
const realEngine = require("../utils/unclaimedAutoList");

function get(doc, path) {
  return path.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
}
function eq(a, b) {
  if (b instanceof RegExp) return typeof a === "string" && b.test(a);
  if (a == null || b == null) return a == b;
  return String(a) === String(b);
}
function matchValue(actual, cond) {
  const values = Array.isArray(actual) ? actual.flat() : [actual];
  if (cond && typeof cond === "object" && !(cond instanceof RegExp) && !(cond instanceof Date)) {
    return Object.entries(cond).every(([op, v]) => {
      if (op === "$in") return v.some((x) => values.some((a) => eq(a, x)));
      if (op === "$nin") return !v.some((x) => values.some((a) => eq(a, x)));
      if (op === "$ne") return !values.some((a) => eq(a, v));
      if (op === "$exists") return v ? values.some((a) => a !== undefined) : values.every((a) => a === undefined);
      throw new Error("fake model: unsupported operator " + op);
    });
  }
  return values.some((a) => eq(a, cond));
}
function matches(doc, q = {}) {
  return Object.entries(q).every(([k, cond]) =>
    k === "$or" ? cond.some((sub) => matches(doc, sub)) : matchValue(get(doc, k), cond),
  );
}
function fakeModel(docs = []) {
  const rows = docs.map((d) => structuredClone(d));
  const clone = (d) => (d == null ? d : structuredClone(d));
  const query = (fn) => {
    let p = null;
    const run = () => (p = p || Promise.resolve().then(fn));
    const q = {
      sort: () => q,
      select: () => q,
      lean: () => q,
      limit: () => q,
      then: (res, rej) => run().then(res, rej),
      catch: (rej) => run().catch(rej),
    };
    return q;
  };
  return {
    rows,
    find: (q) => query(() => rows.filter((r) => matches(r, q)).map(clone)),
    findOne: (q) => query(() => clone(rows.find((r) => matches(r, q)) || null)),
    findById: (id) => query(() => clone(rows.find((r) => String(r._id) === String(id)) || null)),
    countDocuments: async (q) => rows.filter((r) => matches(r, q)).length,
    updateOne: async (q, u) => {
      const row = rows.find((r) => matches(r, q));
      if (row) Object.assign(row, (u && u.$set) || {});
      return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
    },
  };
}

// Loads a FRESH audit module on stubs. `live` maps login -> the account's live
// sellable drops (an Error = unreadable).
function withAudit({ listings = [], ledgers = [], sets = [], live = {} } = {}) {
  const m = { Listing: fakeModel(listings), Ledger: fakeModel(ledgers), Sets: fakeModel(sets) };
  const mpCalls = [];
  const reads = [];
  const ual = {
    uniqueDrops: realEngine.uniqueDrops,
    listingTitle: realEngine.listingTitle,
    listingDescription: realEngine.listingDescription,
    pickListingGroup: realEngine.pickListingGroup,
    candForLedger: async (l) => ({ login: l.login, clientSecret: "s-" + l.login }),
    inventoryForCandidate: async (c) => {
      reads.push(c.login);
      const v = live[c.login];
      if (v instanceof Error) throw v;
      return { sellable: structuredClone(v || []) };
    },
  };
  const mp = {
    gameflipReprice: async (id, o) => mpCalls.push(["gameflipReprice", id, o.title]),
    ggselUpdateOffer: async (id, o) => mpCalls.push(["ggselUpdateOffer", id, o.title]),
    eldoradoUpdateOffer: async (id, o) => mpCalls.push(["eldoradoUpdateOffer", id, o.title]),
  };
  const stubs = new Map([
    [require.resolve("../models/MarketplaceListing"), m.Listing],
    [require.resolve("../models/UnclaimedAccount"), m.Ledger],
    [require.resolve("../models/DropSet"), m.Sets],
    [require.resolve("../models/BotAccount"), fakeModel([])],
    [require.resolve("../utils/unclaimedAutoList"), ual],
    [require.resolve("../utils/marketplaces"), mp],
  ]);
  const auditPath = require.resolve("../utils/unclaimedListingAudit");
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
  delete require.cache[auditPath];
  const audit = require("../utils/unclaimedListingAudit");
  const restore = () => {
    Module._load = origLoad;
    delete require.cache[auditPath];
  };
  return { audit, restore, ...m, mpCalls, reads };
}

const MIN = 60000;
const ago = (ms) => new Date(Date.now() - ms);
const R6 = "Rainbow Six Siege";
const PACK = "Esports Pack 26 stage 2";
const drop = (name, campaign) => ({ name, game: R6, campaign, itemKey: name.toLowerCase() + "|" + R6.toLowerCase() });
const packs = (waves) => waves.flatMap((w) => [0, 1, 2].map(() => drop(PACK, "R6S S2 2026 " + w)));
const ledger = (login, over = {}) => ({
  _id: "L-" + login,
  source: "noclaim",
  status: "listed",
  login,
  loginLower: login,
  game: R6,
  set: "S",
  market: "gameflip",
  lastCheckedAt: ago(10 * MIN),
  emptyReads: 0,
  drops: packs([9, 10, 11]),
  ...over,
});
const gfRow = (over = {}) => ({
  _id: "R",
  origin: "unclaimed",
  marketplace: "gameflip",
  status: "active",
  set: "S",
  externalId: "gf-1",
  accountLogin: "live",
  price: 4.5,
  title: "old",
  requiredDrops: [],
  units: [],
  ...over,
});
const SET = { _id: "S", items: [{ name: PACK, game: R6, qty: 9 }], coverGame: R6 };

test("deliverableHeld: a Gameflip row is judged by the account on sale, not its set's majority", async () => {
  const h = withAudit({
    listings: [gfRow()],
    sets: [SET],
    ledgers: [
      ledger("live"),
      ledger("w1", { drops: packs([8, 9, 10, 11]) }),
      ledger("w2", { drops: packs([8, 9, 10, 11]) }),
    ],
  });
  try {
    const r = await h.audit.heldUniqueForListing(h.Listing.rows[0]);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.held.reduce((a, d) => a + d.qty, 0), 9, "the live unit's 9×, not the majority's 12×");
    const report = await h.audit.listingDriftReport();
    assert.strictEqual(report[0].verdict, "ok", JSON.stringify(report[0]));
  } finally {
    h.restore();
  }
});

test("deliverableHeld: a stale, struck or missing unit is no evidence — nothing to rebundle", async () => {
  for (const [label, over] of [
    ["stale", { lastCheckedAt: ago(3 * 60 * MIN) }],
    ["struck", { emptyReads: 1 }],
    ["missing", { status: "skipped" }],
  ]) {
    const h = withAudit({ listings: [gfRow()], sets: [SET], ledgers: [ledger("live", over)] });
    try {
      const r = await h.audit.heldUniqueForListing(h.Listing.rows[0]);
      assert.deepStrictEqual(r.held, [], label);
    } finally {
      h.restore();
    }
  }
});

test("deliverableHeld: a quantity row gives only what EVERY undelivered unit holds", async () => {
  const row = gfRow({
    marketplace: "ggsel",
    accountLogin: "",
    units: [{ login: "a" }, { login: "b" }, { login: "c", deliveredAt: ago(MIN) }],
  });
  const h = withAudit({
    listings: [row],
    sets: [SET],
    ledgers: [
      ledger("a", { market: "ggsel", drops: packs([9, 10, 11]).concat(drop("Frost", "W")) }),
      ledger("b", { market: "ggsel", drops: packs([10, 11]) }),
    ],
  });
  try {
    const r = await h.audit.heldUniqueForListing(h.Listing.rows[0]);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.held.reduce((a, d) => a + d.qty, 0), 6);
    assert.ok(!r.held.some((d) => d.name === "Frost"));
  } finally {
    h.restore();
  }
});

// A same-campaign growth the rules allow: advertised 1× from wave 11, the unit
// on sale now holds all three of wave 11's packs.
function growthFixture(live) {
  const wave11 = packs([11]);
  return withAudit({
    listings: [
      gfRow({ requiredDrops: [{ name: PACK, qty: 1 }] }),
      gfRow({ _id: "G", marketplace: "ggsel", externalId: "103", accountLogin: "", units: [{ login: "g1" }], requiredDrops: [{ name: PACK, qty: 1 }] }),
    ],
    sets: [SET],
    ledgers: [ledger("live", { drops: wave11 }), ledger("g1", { market: "ggsel", drops: wave11 })],
    live: { live },
  });
}

test("auto-rebundle: Gameflip is raised after a live read agrees; GGSel is never auto-edited", async () => {
  const h = growthFixture(packs([11]));
  try {
    const report = await h.audit.rebundleAll({ dryRun: false, auto: true, pauseMs: 0 });
    const gf = report.find((r) => r.marketplace === "gameflip");
    const gg = report.find((r) => r.marketplace === "ggsel");
    assert.strictEqual(gf.applied, true, JSON.stringify(gf));
    assert.strictEqual(gg.applied, false);
    assert.match(gg.note, /not in scope/);
    assert.deepStrictEqual(h.mpCalls.map((c) => c[0]), ["gameflipReprice"]);
    assert.match(h.mpCalls[0][2], /3× Esports Pack 26 stage 2/);
    assert.deepStrictEqual(h.reads, ["live"], "one live read of the account on sale");
    assert.deepStrictEqual(h.Listing.rows[0].requiredDrops, [{ name: PACK, qty: 3 }]);
  } finally {
    h.restore();
  }
});

test("auto-rebundle: no edit when the live read disagrees with the snapshot, or fails", async () => {
  for (const live of [packs([11]).slice(0, 1), new Error("gql timeout")]) {
    const h = growthFixture(live);
    try {
      const report = await h.audit.rebundleAll({ dryRun: false, auto: true, pauseMs: 0 });
      const gf = report.find((r) => r.marketplace === "gameflip");
      assert.strictEqual(gf.applied, false, JSON.stringify(gf));
      assert.match(gf.note, /did not confirm it live/);
      assert.deepStrictEqual(h.mpCalls, []);
    } finally {
      h.restore();
    }
  }
});

test("advertisedItems: a set without a declared list keeps its copies", async () => {
  const h = withAudit({ listings: [gfRow()], sets: [SET] });
  try {
    const a = await h.audit.advertisedItems(h.Listing.rows[0]);
    assert.deepStrictEqual(a.items, [{ name: PACK, qty: 9 }]);
  } finally {
    h.restore();
  }
});
