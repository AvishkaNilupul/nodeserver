/* global structuredClone */
// A listed unit that holds LESS than its listing promises comes off that
// listing (owner, 2026-09-28) — review items 3 + 4.
//
// Before: the check pass only acted on an account with NOTHING left, so when
// one wave of a bundle expired the unit kept selling under the full title (on
// 09-28 five live Rainbow Six Gameflip listings said 12×/11× Esports Pack while
// the account on sale held 9×); the chain published its next unit straight from
// the set with no look at the account; and the auto-rebundle raised titles to
// what MOST of a set's accounts held, reading "9×" as "1×" and every new R6
// wave as "the same event".
//
// Mongo/host/Twitch/marketplace-free: models, the fleet host, the Twitch
// inventory, the marketplace client and the log sinks are stubbed via
// Module._load; the REAL engine (runOnce -> expirySalePass -> handleShortUnit ->
// takeShortUnitOff, publishGameflipSuccessor, reconcileRowsPass) runs on top.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const mongoose = require("mongoose");
const { encrypt } = require("../utils/secretBox");
// The real rule for reading a failed delist, taken before any stub is in place.
const { delistOutcome } = require("../utils/marketplaces");

// --- a tiny stateful stand-in for a Mongoose model --------------------------
function get(doc, path) {
  return path.split(".").reduce((v, k) => {
    if (v == null) return undefined;
    if (Array.isArray(v)) return v.map((x) => (x == null ? undefined : x[k]));
    return v[k];
  }, doc);
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
      if (op === "$all") return v.every((x) => values.some((a) => eq(a, x)));
      if (op === "$size") return Array.isArray(actual) && actual.length === v;
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
  const writes = [];
  const sorts = [];
  const clone = (d) => (d == null ? d : structuredClone(d));
  const query = (fn) => {
    let p = null;
    let lim = Infinity;
    const run = () => (p = p || Promise.resolve().then(() => fn(lim)));
    const q = {
      sort: (spec) => {
        sorts.push(spec);
        return q;
      },
      select: () => q,
      lean: () => q,
      limit: (n) => {
        lim = n;
        return q;
      },
      then: (res, rej) => run().then(res, rej),
      catch: (rej) => run().catch(rej),
    };
    return q;
  };
  const setFields = (row, u) => Object.assign(row, (u && u.$set) || {});
  return {
    rows,
    writes,
    sorts,
    find: (q) => query((lim) => rows.filter((r) => matches(r, q)).slice(0, lim).map(clone)),
    findOne: (q) => query(() => clone(rows.find((r) => matches(r, q)) || null)),
    findById: (id) => query(() => clone(rows.find((r) => String(r._id) === String(id)) || null)),
    exists: async (q) => (rows.some((r) => matches(r, q)) ? { _id: "x" } : null),
    countDocuments: async (q) => rows.filter((r) => matches(r, q)).length,
    distinct: async (field, q) => [...new Set(rows.filter((r) => matches(r, q)).map((r) => r[field]))],
    create: async (doc) => {
      const row = { _id: "new-" + (rows.length + 1), ...structuredClone(doc) };
      rows.push(row);
      return row;
    },
    updateOne: (q, u, opts = {}) =>
      query(() => {
        writes.push({ q, u });
        const row = rows.find((r) => matches(r, q));
        if (row) {
          setFields(row, u);
          return { matchedCount: 1, modifiedCount: 1 };
        }
        if (opts.upsert) rows.push(setFields({ ...q }, u));
        return { matchedCount: 0, modifiedCount: 0 };
      }),
    updateMany: async () => ({ matchedCount: 0, modifiedCount: 0 }),
    bulkWrite: async () => ({ ok: 1 }),
  };
}

// A fleet host that holds every account in one running no-claim bot.
function fakeFleet(accounts) {
  const cfg = {
    FavouriteGames: ["Rainbow Six Siege"],
    TwitchSettings: {
      TwitchUsers: accounts.map(([Login, ClientSecret]) => ({ Login, Id: "1", ClientSecret, Enabled: true })),
    },
  };
  const BOTS = "/home/ubuntu/twitchbot-noclaim/bots";
  return {
    resolveHost: (id) => ({ id }),
    shq: (s) => "'" + String(s).replace(/'/g, "'\\''") + "'",
    async readFiles(_h, paths) {
      const out = {};
      for (const p of paths) out[p] = { ok: true, text: JSON.stringify(cfg) };
      return out;
    },
    async runShell(_h, script) {
      if (script.startsWith("ls -1d ")) return { stdout: BOTS + "/21/Configuration/config.json" };
      if (/^\[ -f '/.test(script)) return { stdout: JSON.stringify(cfg) };
      return { stdout: "" };
    },
  };
}

// Installs the stubs, loads a FRESH engine on them. `mp` overrides single
// marketplace calls; any other call is recorded and rejected.
function withEngine({ ledgers = [], pool = [], listings = [], sets = [], inventory = {}, mp = {}, autoFarm = {}, accounts = [] } = {}) {
  const m = {
    Unclaimed: fakeModel(ledgers),
    Pool: fakeModel(pool),
    Listing: fakeModel(listings),
    Sets: fakeModel(sets),
    Spent: fakeModel([]),
  };
  const events = [];
  const mpCalls = [];
  const fetched = [];
  const mpStub = new Proxy(
    {},
    {
      get: (_t, k) => {
        if (typeof k === "symbol" || k === "then") return undefined;
        if (k === "delistOutcome") return delistOutcome;
        return (...args) => {
          mpCalls.push(String(k) + (args[0] !== undefined && typeof args[0] !== "object" ? ":" + args[0] : ""));
          if (mp[k]) return mp[k](...args);
          return Promise.reject(new Error("unexpected marketplace call " + String(k)));
        };
      },
    },
  );
  const realSettings = require("../utils/settings");
  const settingsStub = new Proxy(realSettings, {
    get: (t, k) => {
      if (k === "getAutoFarm") return () => ({ ...t.getAutoFarm(), unclaimedAutoRebundle: false, ...autoFarm });
      if (k === "gameMarketsFor") {
        return (g) => {
          const gm = autoFarm.unclaimedGameMarkets;
          if (!gm) return null;
          const key = Object.keys(gm).find((x) => String(g || "").toLowerCase().includes(x));
          return key ? gm[key].filter((x) => ["gameflip", "digiseller", "ggsel"].includes(x)) : null;
        };
      }
      return t[k];
    },
  });
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), m.Unclaimed],
    [require.resolve("../models/AvailableAccount"), m.Pool],
    [require.resolve("../models/MarketplaceListing"), m.Listing],
    [require.resolve("../models/NoclaimSpentAccount"), m.Spent],
    [require.resolve("../models/BotAccount"), fakeModel([])],
    [require.resolve("../models/DropSet"), m.Sets],
    [require.resolve("../models/TwitchCampaign"), fakeModel([])],
    [require.resolve("../models/MarketResearch"), fakeModel([])],
    [require.resolve("../utils/botHosts"), fakeFleet(accounts)],
    [require.resolve("../utils/settings"), settingsStub],
    [
      require.resolve("../utils/twitchInventory"),
      {
        fetchInventory: async (secret) => {
          fetched.push(secret);
          const inv = inventory[secret];
          if (inv instanceof Error) throw inv;
          return structuredClone(inv || { twitchId: "1", login: "", drops: [], inProgress: [] });
        },
      },
    ],
    [require.resolve("../utils/marketplaces"), mpStub],
    [require.resolve("../utils/setImage"), { buildSetGridImage: async () => "", buildPromoCoverImage: async () => "" }],
    [require.resolve("../utils/telegram"), { sendTelegram: async () => {} }],
    [require.resolve("../utils/systemLog"), { logEvent: (e) => events.push(e), actorFromReq: () => "test" }],
    [require.resolve("../utils/poolUsageLog"), { recordPoolUsage: async () => {} }],
    [require.resolve("../utils/saleLearning"), { recordListingSale: async () => {} }],
    [require.resolve("../utils/unclaimedLots"), { checkLots: async () => ({ checked: 0 }) }],
  ]);
  const enginePath = require.resolve("../utils/unclaimedAutoList");
  const origLoad = Module._load;
  const origDb = mongoose.connection.db;
  const origError = console.error;
  const errors = [];
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
  mongoose.connection.db = {
    collection: () => ({
      updateOne: async () => ({}),
      findOneAndUpdate: async (_q, u) => ({ holder: u.$set.holder }),
      deleteOne: async () => ({}),
    }),
  };
  console.error = (...a) => errors.push(a.join(" "));
  delete require.cache[enginePath];
  const engine = require("../utils/unclaimedAutoList");
  const restore = () => {
    console.error = origError;
    mongoose.connection.db = origDb;
    Module._load = origLoad;
    delete require.cache[enginePath];
  };
  return { engine, restore, ...m, events, mpCalls, fetched, errors };
}

// --- fixtures -----------------------------------------------------------------
const MIN = 60000;
const ago = (ms) => new Date(Date.now() - ms);
const R6 = "Rainbow Six Siege";
const PACK = "Esports Pack 26 stage 2";
const FROST = "2024 Frost Uniform";
const key = (n) => n.toLowerCase() + "|" + R6.toLowerCase();
const item = (name, qty) => ({ itemKey: key(name), name, game: R6, image: "", qty });
const set = (id, items) => ({ _id: id, name: id, note: "Unclaimed auto-list", items, price: 4.5, coverGame: R6 });
const SET12 = set("S12", [item(PACK, 12), item(FROST, 1)]);
const SET9 = set("S9", [item(PACK, 9), item(FROST, 1)]);

// Inventory in Twitch's shape: sellable = inProgress at 100% and unclaimed.
// `waves` = the R6 campaigns still held (three packs each).
function r6Inv(login, waves, extra = []) {
  const inProgress = [];
  for (const w of waves) {
    for (let i = 0; i < 3; i++) {
      inProgress.push({ name: PACK, game: R6, campaign: "R6S S2 2026 " + w, percent: 100, claimed: false });
    }
  }
  inProgress.push({ name: FROST, game: R6, campaign: "R6S Wasteland circuit", percent: 100, claimed: false });
  return { twitchId: "1", login, drops: [], inProgress: inProgress.concat(extra) };
}
// The same holdings as a ledger drops[] snapshot.
function snap(waves) {
  const out = [];
  for (const w of waves) {
    for (let i = 0; i < 3; i++) out.push({ name: PACK, game: R6, campaign: "R6S S2 2026 " + w, itemKey: key(PACK) });
  }
  out.push({ name: FROST, game: R6, campaign: "R6S Wasteland circuit", itemKey: key(FROST) });
  return out;
}
const poolRow = (id, secret) => ({
  _id: id,
  clientSecret: secret,
  status: "claimed",
  claimedNote: "noclaim-farm:Rainbow Six Siege",
  password: encrypt("pw-" + id),
  listed: true,
  manualSold: false,
});
const ledger = (id, login, setId, over = {}) => ({
  _id: id,
  source: "noclaim",
  status: "listed",
  login,
  loginLower: login,
  game: R6,
  set: setId,
  market: "gameflip",
  poolAccountId: "P-" + id,
  listedAt: ago(3 * 24 * 60 * MIN),
  lastCheckedAt: ago(30 * MIN),
  emptyReads: 0,
  firstEmptyAt: null,
  lotId: "",
  drops: snap([8, 9, 10, 11]),
  note: "",
  ...over,
});

// --- 1. the rule ------------------------------------------------------------------

test("unitShortfall: count-aware against the set, or the row's own declared list", () => {
  const { unitShortfall } = require("../utils/unclaimedAutoList");
  const held9 = snap([8, 9, 10]);
  assert.deepStrictEqual(unitShortfall(SET12, null, held9), [
    { name: "esports pack 26 stage 2", need: 12, have: 9 },
  ]);
  assert.deepStrictEqual(unitShortfall(SET9, null, held9), [], "9× held covers a 9× set");
  assert.deepStrictEqual(
    unitShortfall(SET9, { requiredDrops: [{ name: PACK, qty: 12 }, { name: FROST, qty: 1 }] }, held9),
    [{ name: "esports pack 26 stage 2", need: 12, have: 9 }],
    "a rebundled row is held to its own declared list, not its smaller set",
  );
  assert.deepStrictEqual(unitShortfall(SET12, null, snap([8, 9, 10, 11])), []);
  assert.deepStrictEqual(unitShortfall(set("E", []), null, held9), [], "a set with no items promises nothing");
});

// --- 2. the check pass ------------------------------------------------------------

test("check pass: a waiting unit short of its set gets a strike, not a take-off", async () => {
  const h = withEngine({
    sets: [SET12],
    pool: [poolRow("P-W", "s-w")],
    ledgers: [ledger("W", "waitone", "S12")],
    inventory: { "s-w": r6Inv("waitone", [8, 9, 10]) },
  });
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.strictEqual(run.check.shortStrikes, 1, JSON.stringify(run.check));
    assert.strictEqual(run.check.shrunk, 0);
    const w = h.Unclaimed.rows[0];
    assert.strictEqual(w.status, "listed");
    assert.strictEqual(w.emptyReads, 1);
    assert.match(w.note, /^short of its listing: esports pack 26 stage 2 9\/12 — strike 1\/2/);
    assert.strictEqual(w.drops.length, 10, "the snapshot is refreshed to what it holds");
    assert.deepStrictEqual(h.mpCalls, [], "no marketplace touched");
    assert.deepStrictEqual(
      h.Unclaimed.sorts.find((s) => s && "emptyReads" in s),
      { emptyReads: -1, lastCheckedAt: 1, _id: 1 },
      "struck units are read first",
    );
  } finally {
    h.restore();
  }
});

test("check pass: a confirmed short waiting unit is parked held — bot, pool and marketplace untouched", async () => {
  const h = withEngine({
    sets: [SET12],
    pool: [poolRow("P-W", "s-w")],
    ledgers: [ledger("W", "waitone", "S12", { emptyReads: 1, firstEmptyAt: ago(25 * MIN) })],
    inventory: { "s-w": r6Inv("waitone", [8, 9, 10]) },
  });
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.strictEqual(run.check.shrunk, 1, JSON.stringify(run.check));
    const w = h.Unclaimed.rows[0];
    assert.strictEqual(w.status, "skipped", "held: the scan re-lists it with what it holds");
    assert.match(w.note, /^part of its bundle expired — off its listing, re-listing with what it holds \(esports pack 26 stage 2 9\/12\)/);
    assert.strictEqual(w.emptyReads, 0);
    const p = h.Pool.rows[0];
    assert.strictEqual(p.status, "claimed", "the pool row stays claimed — it keeps farming");
    assert.strictEqual(p.claimedNote, "noclaim-farm:Rainbow Six Siege");
    assert.strictEqual(p.listed, false, "its console box is un-ticked");
    assert.deepStrictEqual(h.mpCalls, []);
    assert.ok(h.events.some((e) => e.action === "shrunk" && e.count === 1));
  } finally {
    h.restore();
  }
});

test("check pass: a read that covers the listing clears the strikes", async () => {
  const h = withEngine({
    sets: [SET12],
    pool: [poolRow("P-W", "s-w")],
    ledgers: [ledger("W", "waitone", "S12", { emptyReads: 1, firstEmptyAt: ago(25 * MIN), note: "short of its listing: x" })],
    inventory: { "s-w": r6Inv("waitone", [8, 9, 10, 11]) },
  });
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.strictEqual(run.check.shrunk + run.check.shortStrikes, 0);
    const w = h.Unclaimed.rows[0];
    assert.strictEqual(w.status, "listed");
    assert.strictEqual(w.emptyReads, 0);
    assert.strictEqual(w.note, "");
  } finally {
    h.restore();
  }
});

// The live unit of a rebundled row: its set is 9×, its title was raised to
// 12×, the account holds 9× — it covers the set but not what the buyer reads.
function liveFixture({ status = "onsale", delist = async () => {}, waitingInv } = {}) {
  const row = {
    _id: "R1",
    origin: "unclaimed",
    marketplace: "gameflip",
    status: "active",
    set: "S9",
    externalId: "gf-1",
    accountLogin: "liveone",
    price: 4.5,
    title: "Rainbow Six Siege Twitch Drops (13 Items) — 12× Esports Pack 26 stage 2 + 2024 Frost Uniform",
    requiredDrops: [{ name: PACK, qty: 12 }, { name: FROST, qty: 1 }],
    units: [],
    lotSize: 0,
    createdAt: ago(3 * 24 * 60 * MIN),
  };
  return withEngine({
    sets: [SET9],
    listings: [row],
    pool: [poolRow("P-L", "s-l"), poolRow("P-N", "s-n")],
    ledgers: [
      ledger("L", "liveone", "S9", { emptyReads: 1, firstEmptyAt: ago(25 * MIN), drops: snap([8, 9, 10]) }),
      ledger("N", "nextone", "S9", { drops: snap([9, 10, 11]), lastCheckedAt: ago(5 * MIN), listedAt: ago(2 * 24 * 60 * MIN) }),
    ],
    inventory: { "s-l": r6Inv("liveone", [8, 9, 10]), "s-n": waitingInv || r6Inv("nextone", [9, 10, 11]) },
    mp: {
      gameflipListingStatus: async () => status,
      gameflipDelist: delist,
      gameflipPublish: async () => ({ externalId: "gf-2", url: "" }),
      gameflipListingIdsByStatus: async () => new Set(),
    },
  });
}

test("check pass: a live unit short of its title comes down, and a unit that holds the set replaces it", async () => {
  const h = liveFixture();
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.strictEqual(run.check.shrunk, 1, JSON.stringify(run.check));
    assert.ok(h.mpCalls.includes("gameflipListingStatus:gf-1"), "asked Gameflip first whether it just sold");
    assert.ok(h.mpCalls.includes("gameflipDelist:gf-1"));
    assert.strictEqual(h.Listing.rows.find((r) => r._id === "R1").status, "delisted");
    assert.strictEqual(h.Unclaimed.rows.find((l) => l._id === "L").status, "skipped");
    const next = h.Listing.rows.find((r) => r.externalId === "gf-2");
    assert.ok(next, "the next unit was published");
    assert.strictEqual(next.accountLogin, "nextone");
    assert.match(next.title, /9× Esports Pack 26 stage 2/, "under the set's own (true) title");
    assert.ok(h.fetched.includes("s-n"), "the successor was read live before it went on sale");
  } finally {
    h.restore();
  }
});

test("check pass: a live unit whose Gameflip listing is not plainly on sale is left for the sale path", async () => {
  const h = liveFixture({ status: "sold" });
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.strictEqual(run.check.shrinkWaiting, 1, JSON.stringify(run.check));
    assert.ok(!h.mpCalls.includes("gameflipDelist:gf-1"), "never delisted");
    assert.strictEqual(h.Listing.rows.find((r) => r._id === "R1").status, "active");
    assert.strictEqual(h.Unclaimed.rows.find((l) => l._id === "L").status, "listed");
  } finally {
    h.restore();
  }
});

test("check pass: a delist Gameflip refuses as already sold is booked as the sale it is", async () => {
  const h = liveFixture({
    delist: async () => {
      throw new Error("Gameflip delist: {\"status\":\"FAILURE\",\"error\":{\"message\":\"listing (sold)\"}}");
    },
  });
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.strictEqual(run.check.sold, 1, JSON.stringify(run.check) + " " + JSON.stringify(h.errors));
    assert.strictEqual(run.check.shrunk, 0);
    const l = h.Unclaimed.rows.find((x) => x._id === "L");
    assert.strictEqual(l.status, "sold", "spent, never parked for re-listing");
    assert.strictEqual(h.Listing.rows.find((r) => r._id === "R1").status, "sold");
  } finally {
    h.restore();
  }
});

test("check pass: GGSel/Plati units and the off switch only note a shortfall", async () => {
  for (const variant of ["ggsel", "switch"]) {
    const h = withEngine({
      sets: [SET12],
      pool: [poolRow("P-W", "s-w")],
      ledgers: [
        ledger("W", "waitone", "S12", {
          market: variant === "ggsel" ? "ggsel" : "gameflip",
          emptyReads: 1,
          firstEmptyAt: ago(25 * MIN),
        }),
      ],
      inventory: { "s-w": r6Inv("waitone", [8, 9, 10]) },
      autoFarm: variant === "switch" ? { unclaimedShrinkListings: false } : {},
    });
    try {
      const run = await h.engine.runOnce({ scan: false });
      assert.strictEqual(run.check.shortHeld, 1, variant + " " + JSON.stringify(run.check));
      const w = h.Unclaimed.rows[0];
      assert.strictEqual(w.status, "listed", variant);
      assert.strictEqual(w.emptyReads, 0, variant + ": no strikes pile up");
      assert.match(w.note, variant === "ggsel" ? /left as is \(ggsel paused\)/ : /take-off switched off/);
      assert.deepStrictEqual(h.mpCalls, [], variant);
    } finally {
      h.restore();
    }
  }
});

// --- 3. the chain's next unit ---------------------------------------------------------

test("successor: skips struck, short, sold and unreadable units; publishes only a live-verified one", async () => {
  const bad = new Error("gql timeout");
  const h = withEngine({
    sets: [SET12],
    pool: ["A", "B", "C", "D", "E", "F"].map((x) => poolRow("P-" + x, "s-" + x.toLowerCase())),
    ledgers: [
      ledger("A", "struck", "S12", { emptyReads: 1, listedAt: ago(9 * 60 * MIN) }),
      ledger("B", "snapshort", "S12", { drops: snap([8, 9, 10]), listedAt: ago(8 * 60 * MIN) }),
      ledger("C", "justsold", "S12", { listedAt: ago(7 * 60 * MIN) }),
      ledger("D", "unreadable", "S12", { listedAt: ago(6 * 60 * MIN) }),
      ledger("E", "liveshort", "S12", { listedAt: ago(5 * 60 * MIN) }),
      ledger("F", "good", "S12", { listedAt: ago(4 * 60 * MIN) }),
    ],
    listings: [
      { _id: "RS", origin: "unclaimed", marketplace: "gameflip", status: "sold", set: "S12", accountLogin: "justsold", createdAt: ago(60 * MIN) },
    ],
    inventory: {
      "s-a": r6Inv("struck", [8, 9, 10, 11]),
      "s-b": r6Inv("snapshort", [8, 9, 10, 11]),
      "s-d": bad,
      "s-e": r6Inv("liveshort", [9, 10, 11]),
      "s-f": r6Inv("good", [8, 9, 10, 11]),
    },
    mp: { gameflipPublish: async () => ({ externalId: "gf-9", url: "" }) },
  });
  try {
    const r = await h.engine.publishGameflipSuccessor("S12", "");
    assert.strictEqual(r.published, true, JSON.stringify(r));
    assert.strictEqual(r.login, "good");
    assert.deepStrictEqual(h.fetched, ["s-d", "s-e", "s-f"], "only unfiltered units are read, in queue order");
    const e = h.Unclaimed.rows.find((l) => l._id === "E");
    assert.strictEqual(e.emptyReads, 1, "a live-short unit gets a strike");
    assert.match(e.note, /not published as the next unit/);
    assert.strictEqual(h.Unclaimed.rows.find((l) => l._id === "D").emptyReads, 0, "an unreadable one changes nothing");
  } finally {
    h.restore();
  }
});

test("successor: at most three live reads per call, and nothing short is ever published", async () => {
  const ids = ["A", "B", "C", "D", "E"];
  const h = withEngine({
    sets: [SET12],
    pool: ids.map((x) => poolRow("P-" + x, "s-" + x.toLowerCase())),
    ledgers: ids.map((x, i) => ledger(x, "u" + x.toLowerCase(), "S12", { listedAt: ago((10 - i) * 60 * MIN) })),
    inventory: Object.fromEntries(ids.map((x) => ["s-" + x.toLowerCase(), r6Inv("u" + x, [9, 10, 11])])),
    mp: { gameflipPublish: async () => ({ externalId: "gf-9", url: "" }) },
  });
  try {
    const r = await h.engine.publishGameflipSuccessor("S12", "");
    assert.strictEqual(r.published, false);
    assert.strictEqual(h.fetched.length, 3);
    assert.ok(!h.mpCalls.some((c) => c.startsWith("gameflipPublish")));
    // Struck now, so the next repair spends no reads on them.
    h.fetched.length = 0;
    const r2 = await h.engine.publishGameflipSuccessor("S12", "");
    assert.strictEqual(r2.published, false);
    assert.strictEqual(h.fetched.length, 2, "only the two not yet read");
  } finally {
    h.restore();
  }
});

// --- 4. GGSel taken off a game ---------------------------------------------------------

test("reconcile: a GGSel offer paused by hand for a game GGSel was taken off is closed, its accounts held", async () => {
  const row = {
    _id: "G1",
    origin: "unclaimed",
    marketplace: "ggsel",
    status: "active",
    set: "S12",
    externalId: "103163984",
    accountLogin: "ga, gb",
    units: [{ login: "ga" }, { login: "gb" }],
    lotSize: 0,
    createdAt: ago(5 * 24 * 60 * MIN),
  };
  const mk = (markets) =>
    withEngine({
      sets: [SET12],
      listings: [structuredClone(row)],
      pool: [poolRow("P-GA", "s-ga"), poolRow("P-GB", "s-gb")],
      ledgers: [
        ledger("GA", "ga", "S12", { market: "ggsel", lastCheckedAt: new Date() }),
        ledger("GB", "gb", "S12", { market: "ggsel", lastCheckedAt: new Date() }),
      ],
      mp: {
        ggselOfferStatus: async () => "paused",
        batchActivate: async () => ({}),
        ggselFinalizeStock: async () => ({ activationStuck: false }),
        gameflipListingIdsByStatus: async () => new Set(),
      },
      autoFarm: { unclaimedGameMarkets: { "rainbow six": markets } },
    });
  const off = mk(["gameflip"]);
  try {
    const r = await off.engine.reconcileRowsPass({ force: true });
    assert.strictEqual(r.marketOff, 1, JSON.stringify(r));
    assert.strictEqual(r.marketOffHeld, 2);
    assert.strictEqual(off.Listing.rows[0].status, "delisted");
    assert.match(off.Listing.rows[0].lastError, /clear them before re-activating/);
    assert.deepStrictEqual(off.Unclaimed.rows.map((l) => l.status), ["skipped", "skipped"]);
    assert.ok(!off.mpCalls.some((c) => c.startsWith("ggselFinalizeStock")), "never switched back on");
  } finally {
    off.restore();
  }
  const on = mk(["gameflip", "ggsel"]);
  try {
    const r = await on.engine.reconcileRowsPass({ force: true });
    assert.strictEqual(r.marketOff || 0, 0, "GGSel still a market for the game: the old heal applies");
    assert.strictEqual(on.Listing.rows[0].status, "active");
    assert.deepStrictEqual(on.Unclaimed.rows.map((l) => l.status), ["listed", "listed"]);
  } finally {
    on.restore();
  }
});

test("successor: units whose last read failed go to the back, so dead tokens cannot block the chain", async () => {
  const ids = ["A", "B", "C", "D"];
  const h = withEngine({
    sets: [SET12],
    pool: ids.map((x) => poolRow("P-" + x, "s-" + x.toLowerCase())),
    ledgers: ids.map((x, i) =>
      ledger(x, "u" + x.toLowerCase(), "S12", {
        listedAt: ago((10 - i) * 60 * MIN),
        note: x === "D" ? "" : "check failed: token rejected",
      }),
    ),
    inventory: {
      "s-a": new Error("token rejected"),
      "s-b": new Error("token rejected"),
      "s-c": new Error("token rejected"),
      "s-d": r6Inv("ud", [8, 9, 10, 11]),
    },
    mp: { gameflipPublish: async () => ({ externalId: "gf-9", url: "" }) },
  });
  try {
    const r = await h.engine.publishGameflipSuccessor("S12", "");
    assert.strictEqual(r.published, true, JSON.stringify(r));
    assert.strictEqual(r.login, "ud");
    assert.deepStrictEqual(h.fetched, ["s-d"], "the healthy unit is tried first");
  } finally {
    h.restore();
  }
});

// --- 5. the scan's reads and the Gameflip queue ------------------------------------

test("scanBatch: open games are read in full; a capped game gets a few rotating reads", () => {
  const { scanBatch, CAPPED_SCAN_READS } = require("../utils/unclaimedAutoList");
  const cands = (game, n) => Array.from({ length: n }, (_, i) => ({ game, login: game[0] + i }));
  const listed = new Map([["overwatch", 50]]);
  const settings = require("../utils/settings");
  const origCap = settings.gameCapFor;
  settings.gameCapFor = (g) => (/overwatch/.test(String(g)) ? 50 : 0);
  try {
    const ordered = cands("Rainbow Six Siege", 3).concat(cands("Overwatch", 12));
    const first = scanBatch(ordered, listed);
    assert.strictEqual(first.length, 3 + CAPPED_SCAN_READS);
    assert.deepStrictEqual(first.slice(0, 3).map((c) => c.login), ["R0", "R1", "R2"], "open games first, in full");
    const second = scanBatch(ordered, listed);
    const owFirst = first.slice(3).map((c) => c.login);
    const owSecond = second.slice(3).map((c) => c.login);
    assert.notDeepStrictEqual(owSecond, owFirst, "the capped lane rotates from pass to pass");
    assert.ok(owSecond.every((l) => !owFirst.includes(l)));
  } finally {
    settings.gameCapFor = origCap;
  }
});

test("scan: a bundle with a full Gameflip queue leaves the account free", async () => {
  const waitingLedgers = ["A", "B", "C", "D", "E"].map((x) => ledger(x, "q" + x.toLowerCase(), "S12"));
  const h = withEngine({
    sets: [SET12],
    accounts: [["newbie", "s-new"]],
    pool: [poolRow("P-new", "s-new")],
    ledgers: [ledger("L", "liveone", "S12")].concat(waitingLedgers),
    listings: [
      { _id: "R1", origin: "unclaimed", marketplace: "gameflip", status: "active", set: "S12", accountLogin: "liveone", lotSize: 0, units: [] },
    ],
    inventory: { "s-new": r6Inv("newbie", [8, 9, 10, 11]) },
    autoFarm: { unclaimedGameMarkets: { "rainbow six": ["gameflip"] } },
  });
  try {
    const run = await h.engine.runOnce({ check: false });
    assert.strictEqual(run.scan.listed, 0, JSON.stringify(run.scan));
    assert.ok(
      run.scan.skipped.some((x) => x.login === "newbie" && /queue for this bundle is full/.test(x.error)),
      JSON.stringify(run.scan.skipped),
    );
    assert.ok(!h.Unclaimed.rows.some((l) => l.loginLower === "newbie"), "no ledger — it stays free");
  } finally {
    h.restore();
  }
});
