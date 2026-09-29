// Bulk packs — A1: utils/bulkPacks/config.js, settings.getBulkPacks (CONTRACT §6),
// models/BulkOffer.js and hook H1 (MarketplaceListing.bulkOfferId).
//
// Settings are always handed in as objects (or the reader is swapped for the
// length of one test), so nothing here depends on — or ever writes — the real
// utils/settings.json. The last test proves the file was not touched.

// A test must never reach the network: refuse to download a mongod binary.
process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const settings = require("../utils/settings");
const config = require("../utils/bulkPacks/config");
const BulkOffer = require("../models/BulkOffer");
const MarketplaceListing = require("../models/MarketplaceListing");

const ROOT = path.join(__dirname, "..");
const SETTINGS_FILE = path.join(ROOT, "utils", "settings.json");
const settingsFileState = () => {
  try {
    const st = fs.statSync(SETTINGS_FILE);
    return st.size + ":" + st.mtimeMs;
  } catch {
    return "absent";
  }
};
const SETTINGS_BEFORE = settingsFileState();

const DEFAULT_TIERS = [
  { minQty: 5, discountPct: 5 },
  { minQty: 10, discountPct: 10 },
];
const DEFAULT_FARM_PRICES = {
  eldorado: { 120: 3, 180: 4, 365: 7 },
  g2g: { 120: 3, 180: 4, 365: 7 },
};
const DEFAULT_BP = {
  enabled: false,
  markets: ["eldorado", "g2g", "gameflip"],
  tiers: DEFAULT_TIERS,
  reserveSingles: 5,
  unitsPerOffer: 20,
  farmPrices: DEFAULT_FARM_PRICES,
  farmDurations: [120, 180, 365],
  farmReserveSlots: 20,
  farmReservePristine: 20,
  farmMaxQty: 20,
  loopMinutes: 5,
  farmSyncMinutes: 15,
};

const bp = (af) => settings.getBulkPacks(af);
const keyOf = (index) => JSON.stringify(index.key);

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("bulk-packs-config-test"));
  await BulkOffer.init();
  await MarketplaceListing.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

// ---------------------------------------------------------------------------
// config.js constants
// ---------------------------------------------------------------------------

test("config constants are exactly the contract's", () => {
  assert.deepEqual(config.SUPPORTED_MARKETS, ["eldorado", "g2g", "gameflip"]);
  assert.deepEqual(config.BLOCKED_MARKETS, ["digiseller", "plati", "ggsel"]);
  assert.deepEqual(config.SOURCE_MARKETS, {
    dropset: ["eldorado", "g2g", "gameflip"],
    noclaim: ["eldorado", "g2g"],
    farm: ["eldorado", "g2g"],
  });
  assert.deepEqual(config.KIND_OF_SOURCE, {
    dropset: "accounts",
    noclaim: "accounts",
    farm: "farming",
  });
  assert.deepEqual(config.MARKET_FLOORS, {
    eldorado: 0.5,
    g2g: 1,
    gameflip: 0.75,
  });
  assert.deepEqual(config.TITLE_MAX, {
    eldorado: 160,
    g2g: 128,
    gameflip: 120,
  });
  assert.deepEqual(config.DESC_MAX, {
    eldorado: 2000,
    g2g: 5000,
    gameflip: 5000,
  });
  assert.deepEqual(config.OPEN_STATES, ["sending", "live", "paused"]);
  assert.deepEqual(config.CLOSED_STATES, [
    "sold_out",
    "sold",
    "withdrawn",
    "expired",
    "error",
  ]);
  // No supported market is blocked, and no blocked market carries any source.
  for (const m of config.BLOCKED_MARKETS) {
    assert.ok(!config.SUPPORTED_MARKETS.includes(m), m);
    for (const list of Object.values(config.SOURCE_MARKETS))
      assert.ok(!list.includes(m), m);
  }
});

test("config constants are frozen, nested lists included", () => {
  for (const name of [
    "SUPPORTED_MARKETS",
    "BLOCKED_MARKETS",
    "SOURCE_MARKETS",
    "KIND_OF_SOURCE",
    "MARKET_FLOORS",
    "TITLE_MAX",
    "DESC_MAX",
    "OPEN_STATES",
    "CLOSED_STATES",
  ]) {
    assert.ok(Object.isFrozen(config[name]), name);
  }
  for (const list of Object.values(config.SOURCE_MARKETS))
    assert.ok(Object.isFrozen(list));
  assert.throws(() => config.SOURCE_MARKETS.dropset.push("zeusx"), TypeError);
  assert.throws(() => {
    "use strict";
    config.MARKET_FLOORS.eldorado = 0;
  }, TypeError);
  assert.equal(config.MARKET_FLOORS.eldorado, 0.5);
});

test("FARM_TITLE_RE is the farm services' own title test", () => {
  // Compared against the source text so this test does not load the whole
  // farm-service stack just to read one regex.
  const src = fs.readFileSync(
    path.join(ROOT, "utils", "eldoradoFarmService.js"),
    "utf8",
  );
  const m = src.match(/const FARM_TITLE = \/(.+)\/([a-z]*);/);
  assert.ok(m, "FARM_TITLE not found in utils/eldoradoFarmService.js");
  assert.equal(config.FARM_TITLE_RE.source, m[1]);
  assert.equal(config.FARM_TITLE_RE.flags, m[2]);
  const re = config.FARM_TITLE_RE;
  assert.ok(
    re.test("Rust Twitch Drops Automatic Farming 120 Days — Bulk 5+ Accounts"),
  );
  assert.ok(re.test("automatic   farming"));
  assert.ok(!re.test("Rust Twitch Drops bundle — BULK 5+ accounts (5% off)"));
  assert.ok(!re.test("AutomaticFarming"));
  // Stateless: no g/y flag, so repeated tests never alternate.
  assert.ok(re.test("Automatic Farming") && re.test("Automatic Farming"));
});

test("config.js loads nothing at top level (the model requires it)", () => {
  const out = execFileSync(
    process.execPath,
    [
      "-e",
      'require("./utils/bulkPacks/config"); process.stdout.write(JSON.stringify(Object.keys(require.cache)));',
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  const loaded = JSON.parse(out).map((p) => path.relative(ROOT, p));
  assert.deepEqual(loaded, [path.join("utils", "bulkPacks", "config.js")]);
});

// ---------------------------------------------------------------------------
// settings.getBulkPacks (CONTRACT §6)
// ---------------------------------------------------------------------------

test("getBulkPacks: shipped defaults, exactly the contract's keys", () => {
  assert.deepEqual(bp({}), DEFAULT_BP);
  assert.deepEqual(Object.keys(bp({})).sort(), Object.keys(DEFAULT_BP).sort());
});

test("bulk packs ship DARK: AUTO_FARM_DEFAULTS has bulkPacksEnabled:false and every §6 key", () => {
  // Asserted on the shipped source, never on the live settings file.
  const src = fs.readFileSync(path.join(ROOT, "utils", "settings.js"), "utf8");
  const start = src.indexOf("const AUTO_FARM_DEFAULTS = {");
  const block = src.slice(start, src.indexOf("\n};\n", start));
  assert.ok(start >= 0 && block.length > 0);
  assert.match(block, /\n\s*bulkPacksEnabled: false,/);
  for (const key of [
    "bulkPacksMarkets",
    "bulkPackTiers",
    "bulkPackReserveSingles",
    "bulkPackUnitsPerOffer",
    "bulkFarmPrices",
    "bulkFarmDurations",
    "bulkFarmReserveSlots",
    "bulkFarmReservePristine",
    "bulkFarmMaxQty",
    "bulkPacksLoopMinutes",
    "bulkFarmSyncMinutes",
  ]) {
    assert.match(block, new RegExp("\\n\\s*" + key + ":"), key);
  }
  assert.equal(bp({}).enabled, false);
});

test("getBulkPacks: enabled only for a real boolean true", () => {
  assert.equal(bp({ bulkPacksEnabled: true }).enabled, true);
  for (const v of [false, "true", 1, "1", null, undefined, {}, []]) {
    assert.equal(bp({ bulkPacksEnabled: v }).enabled, false, JSON.stringify(v));
  }
});

test("getBulkPacks: markets are a subset, order kept, deduped; empty stays empty", () => {
  const mk = (v) => bp({ bulkPacksMarkets: v }).markets;
  assert.deepEqual(mk(undefined), ["eldorado", "g2g", "gameflip"]);
  assert.deepEqual(mk(null), ["eldorado", "g2g", "gameflip"]);
  assert.deepEqual(
    mk([
      "gameflip",
      "zeusx",
      "eldorado",
      "ggsel",
      "digiseller",
      "plati",
      "playerauctions",
      "gameflip",
    ]),
    ["gameflip", "eldorado"],
  );
  assert.deepEqual(mk([" G2G ", "Eldorado"]), ["g2g", "eldorado"]);
  assert.deepEqual(mk([null, 1, {}, "g2g"]), ["g2g"]);
  // Nothing usable means NO market, never the default list.
  assert.deepEqual(mk([]), []);
  assert.deepEqual(mk(["ggsel", "plati", "digiseller"]), []);
  assert.deepEqual(mk("eldorado"), []);
  assert.deepEqual(mk({ eldorado: true }), []);
});

test("getBulkPacks: settings.js mirrors config's market lists", () => {
  assert.deepEqual(
    bp({
      bulkPacksMarkets: [
        "zeusx",
        ...config.SUPPORTED_MARKETS,
        ...config.BLOCKED_MARKETS,
      ],
    }).markets,
    [...config.SUPPORTED_MARKETS],
  );
  assert.deepEqual(Object.keys(bp({}).farmPrices), [
    ...config.SOURCE_MARKETS.farm,
  ]);
});

test("getBulkPacks: tiers are validated, deduped, sorted and capped at 4", () => {
  const tiers = (v) => bp({ bulkPackTiers: v }).tiers;
  assert.deepEqual(
    tiers([
      { minQty: 20, discountPct: 15 },
      { minQty: 3, discountPct: 2 },
      { minQty: 20, discountPct: 30 }, // duplicate minQty: the first valid entry wins
      { minQty: 10, discountPct: 10 },
      { minQty: 50, discountPct: 20 }, // fifth after sorting: dropped
      { minQty: 5, discountPct: 5 },
    ]),
    [
      { minQty: 3, discountPct: 2 },
      { minQty: 5, discountPct: 5 },
      { minQty: 10, discountPct: 10 },
      { minQty: 20, discountPct: 15 },
    ],
  );
  // Out-of-range entries are DROPPED, never clamped into a discount nobody set.
  assert.deepEqual(
    tiers([
      { minQty: 1, discountPct: 5 },
      { minQty: 101, discountPct: 5 },
      { minQty: 5.5, discountPct: 5 },
      { minQty: "abc", discountPct: 5 },
      { minQty: true, discountPct: 5 },
      { minQty: null, discountPct: 5 },
      { minQty: 6, discountPct: -1 },
      { minQty: 7, discountPct: 61 },
      { minQty: 8, discountPct: "x" },
      { minQty: 9 },
      null,
      "5",
      7,
      { minQty: "12", discountPct: "7.5" },
      { minQty: 2, discountPct: 0 },
      { minQty: 100, discountPct: 60 },
    ]),
    [
      { minQty: 2, discountPct: 0 },
      { minQty: 12, discountPct: 7.5 },
      { minQty: 100, discountPct: 60 },
    ],
  );
  // An invalid entry does not shadow a later valid one with the same minQty.
  assert.deepEqual(
    tiers([
      { minQty: 5, discountPct: 99 },
      { minQty: 5, discountPct: 5 },
    ]),
    [{ minQty: 5, discountPct: 5 }],
  );
  // Only the two fields survive.
  assert.deepEqual(tiers([{ minQty: 5, discountPct: 5, extra: 1 }]), [
    { minQty: 5, discountPct: 5 },
  ]);
  // Nothing valid -> the default tiers.
  for (const v of [
    undefined,
    null,
    [],
    "abc",
    {},
    [{ minQty: 1, discountPct: 5 }],
  ]) {
    assert.deepEqual(tiers(v), DEFAULT_TIERS, JSON.stringify(v));
  }
});

test("getBulkPacks: every count is an integer clamped into its range", () => {
  const COUNTS = [
    // [autoFarm key, bp field, lo, hi, default]
    ["bulkPackReserveSingles", "reserveSingles", 0, 100, 5],
    ["bulkPackUnitsPerOffer", "unitsPerOffer", 1, 80, 20],
    ["bulkFarmReserveSlots", "farmReserveSlots", 0, 500, 20],
    ["bulkFarmReservePristine", "farmReservePristine", 0, 500, 20],
    ["bulkFarmMaxQty", "farmMaxQty", 1, 100, 20],
    ["bulkPacksLoopMinutes", "loopMinutes", 2, 60, 5],
    ["bulkFarmSyncMinutes", "farmSyncMinutes", 5, 120, 15],
  ];
  for (const [key, field, lo, hi, dflt] of COUNTS) {
    const v = (x) => bp({ [key]: x })[field];
    assert.equal(v(dflt), dflt, key);
    assert.equal(v(lo), lo, key);
    assert.equal(v(hi), hi, key);
    assert.equal(v(lo - 1), lo, key + " below range");
    assert.equal(v(-1000), lo, key + " far below range");
    assert.equal(v(hi + 1), hi, key + " above range");
    assert.equal(v(1e9), hi, key + " far above range");
    assert.equal(v(lo + 1.9), lo + 1, key + " is floored");
    assert.equal(v(String(lo + 1)), lo + 1, key + " numeric string");
    for (const bad of [
      undefined,
      null,
      "",
      "  ",
      "abc",
      NaN,
      Infinity,
      -Infinity,
      true,
      false,
      [],
      {},
    ]) {
      assert.equal(v(bad), dflt, key + " <- " + String(bad));
    }
  }
});

test("getBulkPacks: farm prices keep eldorado/g2g, valid days and prices > 0 only", () => {
  const fp = (v) => bp({ bulkFarmPrices: v }).farmPrices;
  assert.deepEqual(fp(undefined), DEFAULT_FARM_PRICES);
  assert.deepEqual(fp(null), DEFAULT_FARM_PRICES);
  for (const v of ["abc", 5, [], {}]) {
    assert.deepEqual(fp(v), { eldorado: {}, g2g: {} }, JSON.stringify(v));
  }
  assert.deepEqual(
    fp({
      eldorado: {
        120: 3.5,
        "0120": 9, // same term as "120", which comes first
        180: "4.25",
        0: 1,
        731: 1,
        abc: 1,
        12.5: 1,
        "-5": 1,
        365: 0,
        90: -2,
        30: "x",
        60: null,
        730: 99,
        1: 0.01,
      },
      g2g: "not a table",
      gameflip: { 120: 3 },
      plati: { 120: 3 },
    }),
    { eldorado: { 120: 3.5, 180: 4.25, 730: 99, 1: 0.01 }, g2g: {} },
  );
  assert.deepEqual(fp({ eldorado: { "0120": 3 } }), {
    eldorado: { 120: 3 },
    g2g: {},
  });
});

test("getBulkPacks: farm durations are integers 1..730, deduped and sorted", () => {
  const fd = (v) => bp({ bulkFarmDurations: v }).farmDurations;
  assert.deepEqual(fd(undefined), [120, 180, 365]);
  assert.deepEqual(fd(null), [120, 180, 365]);
  assert.deepEqual(
    fd([365, 120, "180", 120, 0, 731, 12.5, -1, "abc", null, true, 1, 730]),
    [1, 120, 180, 365, 730],
  );
  // Nothing usable means no farming term at all (a farm Send is refused).
  assert.deepEqual(fd([]), []);
  assert.deepEqual(fd("120"), []);
  assert.deepEqual(fd({}), []);
});

test("getBulkPacks: the result is a fresh copy every call", () => {
  const a = bp({});
  a.markets.push("ggsel");
  a.tiers[0].discountPct = 99;
  a.tiers.push({ minQty: 50, discountPct: 50 });
  a.farmPrices.eldorado["120"] = 999;
  a.farmDurations.push(9999);
  assert.deepEqual(bp({}), DEFAULT_BP);
  const af = { bulkPackTiers: [{ minQty: 7, discountPct: 3 }] };
  bp(af).tiers[0].minQty = 70;
  assert.deepEqual(af.bulkPackTiers, [{ minQty: 7, discountPct: 3 }]);
});

test("getBulkPacks() with no argument returns a normalised object (read-only)", () => {
  // Reads whatever settings.json holds (possibly nothing); only the SHAPE is
  // asserted, which holds for any operator config.
  const b = settings.getBulkPacks();
  assert.equal(typeof b.enabled, "boolean");
  assert.ok(b.markets.every((m) => config.SUPPORTED_MARKETS.includes(m)));
  assert.ok(b.tiers.length >= 1 && b.tiers.length <= 4);
  for (const t of b.tiers) {
    assert.ok(Number.isInteger(t.minQty) && t.minQty >= 2 && t.minQty <= 100);
    assert.ok(t.discountPct >= 0 && t.discountPct <= 60);
  }
  assert.ok(
    Number.isInteger(b.loopMinutes) &&
      b.loopMinutes >= 2 &&
      b.loopMinutes <= 60,
  );
  assert.deepEqual(Object.keys(b).sort(), Object.keys(DEFAULT_BP).sort());
});

// ---------------------------------------------------------------------------
// slotKey / isMarketAllowed / tierFor
// ---------------------------------------------------------------------------

test("slotKey: the contract's exact string for account and farming slots", () => {
  const setId = new mongoose.Types.ObjectId();
  const acct = config.slotKey({
    kind: "accounts",
    source: "dropset",
    setId,
    market: "eldorado",
    minQty: 5,
  });
  assert.equal(acct, "accounts|dropset|" + String(setId) + "|eldorado|5");
  // An ObjectId and its hex string are the same slot; game/days are ignored
  // when there is a set.
  assert.equal(
    config.slotKey({
      kind: "accounts",
      source: "dropset",
      setId: String(setId),
      game: "Rust",
      days: 120,
      market: "eldorado",
      minQty: "5",
    }),
    acct,
  );
  assert.equal(
    config.slotKey({
      kind: "farming",
      source: "farm",
      game: "Rust",
      days: 120,
      market: "g2g",
      minQty: 10,
    }),
    "farming|farm|Rust@120|g2g|10",
  );
  // A caller that leaves out `kind` still lands on the same slot.
  assert.equal(
    config.slotKey({ source: "dropset", setId, market: "eldorado", minQty: 5 }),
    acct,
  );
  assert.equal(
    config.slotKey({
      source: "farm",
      game: "Rust",
      days: 120,
      market: "g2g",
      minQty: 10,
    }),
    "farming|farm|Rust@120|g2g|10",
  );
  assert.equal(
    config.slotKey({ source: "noclaim", setId, market: "g2g", minQty: 5 }),
    "accounts|noclaim|" + String(setId) + "|g2g|5",
  );
});

test("slotKey: every dimension separates slots", () => {
  const setId = new mongoose.Types.ObjectId();
  const base = {
    kind: "accounts",
    source: "dropset",
    setId,
    market: "eldorado",
    minQty: 5,
  };
  const keys = new Set([
    config.slotKey(base),
    config.slotKey({ ...base, minQty: 10 }),
    config.slotKey({ ...base, market: "g2g" }),
    config.slotKey({ ...base, source: "noclaim" }),
    config.slotKey({ ...base, setId: new mongoose.Types.ObjectId() }),
    config.slotKey({
      kind: "farming",
      source: "farm",
      game: "Rust",
      days: 120,
      market: "eldorado",
      minQty: 5,
    }),
    config.slotKey({
      kind: "farming",
      source: "farm",
      game: "Rust",
      days: 180,
      market: "eldorado",
      minQty: 5,
    }),
    config.slotKey({
      kind: "farming",
      source: "farm",
      game: "Dota 2",
      days: 120,
      market: "eldorado",
      minQty: 5,
    }),
  ]);
  assert.equal(keys.size, 8);
  assert.doesNotThrow(() => config.slotKey());
});

test("isMarketAllowed: supported, not blocked, and switched on", () => {
  const all = bp({});
  for (const m of ["eldorado", "g2g", "gameflip"])
    assert.equal(config.isMarketAllowed(m, all), true, m);
  const g2gOnly = bp({ bulkPacksMarkets: ["g2g"] });
  assert.equal(config.isMarketAllowed("g2g", g2gOnly), true);
  assert.equal(config.isMarketAllowed("eldorado", g2gOnly), false);
  assert.equal(config.isMarketAllowed("gameflip", g2gOnly), false);
  // A hand-built bp listing blocked/unsupported markets still cannot open them.
  const forged = {
    markets: [
      "ggsel",
      "digiseller",
      "plati",
      "playerauctions",
      "zeusx",
      "GGSel",
    ],
  };
  for (const m of forged.markets)
    assert.equal(config.isMarketAllowed(m, forged), false, m);
  assert.equal(
    config.isMarketAllowed("Eldorado", { markets: ["Eldorado", "eldorado"] }),
    false,
  );
  assert.equal(config.isMarketAllowed("eldorado", undefined), false);
  assert.equal(config.isMarketAllowed("eldorado", {}), false);
  assert.equal(config.isMarketAllowed(undefined, all), false);
});

test("tierFor: exact configured tier or null", () => {
  const b = bp({});
  assert.deepEqual(config.tierFor(b, 5), { minQty: 5, discountPct: 5 });
  assert.deepEqual(config.tierFor(b, "10"), { minQty: 10, discountPct: 10 });
  for (const q of [7, 5.5, 0, null, undefined, true, "", "abc", [5]]) {
    assert.equal(config.tierFor(b, q), null, JSON.stringify(q));
  }
  assert.equal(config.tierFor(undefined, 5), null);
  assert.equal(config.tierFor({ tiers: "x" }, 5), null);
  // A copy: mutating it cannot change the settings object.
  config.tierFor(b, 5).discountPct = 60;
  assert.equal(b.tiers[0].discountPct, 5);
});

// ---------------------------------------------------------------------------
// deliveryGate (CONTRACT I4) and currentGate
// ---------------------------------------------------------------------------

const LIVE = {
  eldoradoAutoDeliver: true,
  eldoradoDeliverDryRun: false,
  g2gAutoDeliver: true,
  g2gDeliverDryRun: false,
};
const SHOP_ON = { enabled: true, autoDeliver: true };
const gate = (market, source, af = LIVE, noclaimShop = SHOP_ON) =>
  config.deliveryGate({ market, source, af, noclaimShop });
const assertClosed = (g, re, label) => {
  assert.equal(g.ok, false, label);
  assert.equal(typeof g.reason, "string", label);
  assert.ok(g.reason.length > 0, label);
  if (re) assert.match(g.reason, re, label);
};

test("deliveryGate: every supported source/market pair opens when delivery is live", () => {
  for (const [source, markets] of Object.entries(config.SOURCE_MARKETS)) {
    for (const m of markets)
      assert.deepEqual(
        gate(m, source),
        { ok: true, reason: "" },
        source + "@" + m,
      );
  }
});

test("deliveryGate: eldorado needs auto-deliver on AND dry-run strictly off", () => {
  for (const source of ["dropset", "noclaim", "farm"]) {
    for (const v of [false, undefined, "true", 1]) {
      assertClosed(
        gate("eldorado", source, { ...LIVE, eldoradoAutoDeliver: v }),
        /eldoradoAutoDeliver/,
        source + " " + v,
      );
    }
    for (const v of [true, undefined, "false", 0, null]) {
      assertClosed(
        gate("eldorado", source, { ...LIVE, eldoradoDeliverDryRun: v }),
        /eldoradoDeliverDryRun/,
        source + " " + v,
      );
    }
  }
  // Eldorado's flags do not touch the other markets.
  const eldoradoOff = {
    ...LIVE,
    eldoradoAutoDeliver: false,
    eldoradoDeliverDryRun: true,
  };
  assert.equal(gate("g2g", "dropset", eldoradoOff).ok, true);
  assert.equal(gate("gameflip", "dropset", eldoradoOff).ok, true);
});

test("deliveryGate: g2g needs auto-deliver on AND dry-run strictly off", () => {
  for (const source of ["dropset", "noclaim", "farm"]) {
    for (const v of [false, undefined, "true", 1]) {
      assertClosed(
        gate("g2g", source, { ...LIVE, g2gAutoDeliver: v }),
        /g2gAutoDeliver/,
        source + " " + v,
      );
    }
    for (const v of [true, undefined, "false", 0, null]) {
      assertClosed(
        gate("g2g", source, { ...LIVE, g2gDeliverDryRun: v }),
        /g2gDeliverDryRun/,
        source + " " + v,
      );
    }
  }
  const g2gOff = { ...LIVE, g2gAutoDeliver: false, g2gDeliverDryRun: true };
  assert.equal(gate("eldorado", "dropset", g2gOff).ok, true);
});

test("deliveryGate: gameflip is native for dropset and never carries noclaim/farm", () => {
  assert.deepEqual(gate("gameflip", "dropset", {}), { ok: true, reason: "" });
  assert.equal(
    gate("gameflip", "dropset", {
      eldoradoAutoDeliver: false,
      eldoradoDeliverDryRun: true,
      g2gAutoDeliver: false,
      g2gDeliverDryRun: true,
    }).ok,
    true,
  );
  assertClosed(gate("gameflip", "noclaim"), /does not carry/);
  assertClosed(gate("gameflip", "farm"), /does not carry/);
});

test("deliveryGate: noclaim additionally needs the No-claim Shop on and delivering", () => {
  for (const m of ["eldorado", "g2g"]) {
    assertClosed(
      gate(m, "noclaim", LIVE, { enabled: false, autoDeliver: true }),
      /noclaimShop\.enabled/,
      m,
    );
    assertClosed(
      gate(m, "noclaim", LIVE, { enabled: true, autoDeliver: false }),
      /noclaimShop\.autoDeliver/,
      m,
    );
    assertClosed(
      gate(m, "noclaim", LIVE, { enabled: "true", autoDeliver: "true" }),
      null,
      m,
    );
    assertClosed(gate(m, "noclaim", LIVE, null), /No-claim Shop/, m);
    // (called directly: the helper's default parameter would replace undefined)
    assertClosed(
      config.deliveryGate({ market: m, source: "noclaim", af: LIVE }),
      /No-claim Shop/,
      m,
    );
    // The shop's switches mean nothing to the other sources.
    assert.equal(
      gate(m, "dropset", LIVE, { enabled: false, autoDeliver: false }).ok,
      true,
      m,
    );
    assert.equal(gate(m, "farm", LIVE, null).ok, true, m);
  }
});

test("deliveryGate: blocked markets are refused whatever the settings say", () => {
  const everything = {
    ...LIVE,
    platiEnabled: true,
    ggselEnabled: true,
    bulkPacksMarkets: ["ggsel", "digiseller", "plati"],
  };
  for (const m of ["digiseller", "plati", "ggsel", "GGSel", " Plati "]) {
    for (const source of ["dropset", "noclaim", "farm", "bogus"]) {
      assertClosed(gate(m, source, everything), /blocked/, m + "/" + source);
    }
  }
});

test("deliveryGate: unsupported markets and unknown sources are refused", () => {
  for (const m of [
    "playerauctions",
    "zeusx",
    "Eldorado",
    "",
    undefined,
    null,
    42,
  ]) {
    assertClosed(gate(m, "dropset"), /not a bulk-pack market/, String(m));
  }
  for (const s of [
    "bogus",
    undefined,
    null,
    "constructor",
    "__proto__",
    "toString",
  ]) {
    assertClosed(gate("eldorado", s), /unknown bulk-pack source/, String(s));
  }
  assertClosed(config.deliveryGate(), null, "no arguments");
  assertClosed(config.deliveryGate({}), null, "empty arguments");
});

test("deliveryGate: missing settings, or a market switched off for bulk packs, keep it shut", () => {
  // Called directly: the helper's default parameter would replace undefined.
  for (const af of [null, undefined, "x"]) {
    for (const market of ["eldorado", "g2g", "gameflip"]) {
      assertClosed(
        config.deliveryGate({ market, source: "dropset", af }),
        /unavailable/,
        market + " " + String(af),
      );
    }
  }
  const g2gOnly = { ...LIVE, bulkPacksMarkets: ["g2g"] };
  assertClosed(gate("eldorado", "dropset", g2gOnly), /bulkPacksMarkets/);
  assertClosed(gate("gameflip", "dropset", g2gOnly), /bulkPacksMarkets/);
  assert.equal(gate("g2g", "dropset", g2gOnly).ok, true);
  assertClosed(
    gate("g2g", "dropset", { ...LIVE, bulkPacksMarkets: [] }),
    /bulkPacksMarkets/,
  );
});

test("currentGate reads the live settings through __setDeps", () => {
  let noclaimReads = 0;
  config.__setDeps({
    settings: {
      getAutoFarm: () => ({ ...LIVE, eldoradoDeliverDryRun: true }),
      getNoclaimShopSettings: () => {
        noclaimReads += 1;
        return { enabled: true, autoDeliver: false };
      },
    },
  });
  try {
    assertClosed(config.currentGate("eldorado", "dropset"), /dry-run/);
    assert.deepEqual(config.currentGate("g2g", "dropset"), {
      ok: true,
      reason: "",
    });
    assert.deepEqual(config.currentGate("gameflip", "dropset"), {
      ok: true,
      reason: "",
    });
    assertClosed(
      config.currentGate("g2g", "noclaim"),
      /noclaimShop\.autoDeliver/,
    );
    assert.ok(
      noclaimReads >= 1,
      "the noclaim gate must read the No-claim Shop settings",
    );
    assertClosed(config.currentGate("ggsel", "dropset"), /blocked/);
  } finally {
    config.__resetDeps();
  }
});

test("currentGate follows a swapped settings.getAutoFarm (farmSizingIntegration pattern)", () => {
  const realAf = settings.getAutoFarm;
  const realShop = settings.getNoclaimShopSettings;
  settings.getAutoFarm = () => ({ ...LIVE });
  settings.getNoclaimShopSettings = () => ({ ...SHOP_ON });
  try {
    assert.deepEqual(config.currentGate("eldorado", "noclaim"), {
      ok: true,
      reason: "",
    });
    settings.getAutoFarm = () => ({ ...LIVE, g2gAutoDeliver: false });
    assertClosed(config.currentGate("g2g", "farm"), /g2gAutoDeliver/);
  } finally {
    settings.getAutoFarm = realAf;
    settings.getNoclaimShopSettings = realShop;
  }
});

test("currentGate never throws: a failed settings read is a closed gate", () => {
  config.__setDeps({
    settings: {
      getAutoFarm: () => {
        throw new Error("disk on fire");
      },
      getNoclaimShopSettings: () => {
        throw new Error("also on fire");
      },
    },
  });
  try {
    assertClosed(config.currentGate("eldorado", "dropset"), /disk on fire/);
    assertClosed(config.currentGate("gameflip", "dropset"), /disk on fire/);
    // A blocked market keeps its own reason.
    assertClosed(config.currentGate("ggsel", "dropset"), /blocked/);
  } finally {
    config.__resetDeps();
  }
  // A settings object without the readers is a closed gate, not a TypeError.
  config.__setDeps({ settings: {} });
  try {
    assertClosed(config.currentGate("eldorado", "dropset"), /unavailable/);
    assertClosed(config.currentGate("g2g", "noclaim"), /unavailable/);
  } finally {
    config.__resetDeps();
  }
});

// ---------------------------------------------------------------------------
// models/BulkOffer.js
// ---------------------------------------------------------------------------

let seq = 0;
const offer = (over = {}) => {
  seq += 1;
  return {
    kind: "accounts",
    source: "dropset",
    market: "eldorado",
    set: new mongoose.Types.ObjectId(),
    minQty: 5,
    slotKey: "test-slot-" + seq,
    ...over,
  };
};

test("BulkOffer statics come from config", () => {
  assert.equal(BulkOffer.OPEN_STATES, config.OPEN_STATES);
  assert.equal(BulkOffer.CLOSED_STATES, config.CLOSED_STATES);
  for (const s of config.OPEN_STATES)
    assert.equal(BulkOffer.isOpenState(s), true, s);
  for (const s of [...config.CLOSED_STATES, undefined, null, "", "bogus"]) {
    assert.equal(BulkOffer.isOpenState(s), false, String(s));
  }
  assert.deepEqual(BulkOffer.schema.path("state").enumValues, [
    ...config.OPEN_STATES,
    ...config.CLOSED_STATES,
  ]);
  assert.deepEqual(BulkOffer.schema.path("market").enumValues, [
    ...config.SUPPORTED_MARKETS,
  ]);
  assert.deepEqual(BulkOffer.schema.path("kind").enumValues, [
    "accounts",
    "farming",
  ]);
  assert.deepEqual(BulkOffer.schema.path("source").enumValues, [
    "dropset",
    "noclaim",
    "farm",
  ]);
});

test("BulkOffer indexes: partial unique slotKey plus the contract's others", async () => {
  const idx = await BulkOffer.collection.indexes();
  const slot = idx.find((i) => keyOf(i) === JSON.stringify({ slotKey: 1 }));
  assert.ok(slot, "slotKey index missing");
  assert.equal(slot.unique, true);
  assert.deepEqual(slot.partialFilterExpression, { open: true });
  for (const key of [
    { open: 1, kind: 1 },
    { market: 1, state: 1 },
    { kind: 1 },
    { market: 1 },
    { set: 1 },
    { externalId: 1 },
    { state: 1 },
  ]) {
    assert.ok(
      idx.some((i) => keyOf(i) === JSON.stringify(key)),
      JSON.stringify(key),
    );
  }
});

test("BulkOffer defaults", async () => {
  const doc = await BulkOffer.create(
    offer({
      reserved: [{ accountId: "acc-1", login: "login1" }],
      history: [{ action: "sent", detail: "x", actor: "owner" }],
    }),
  );
  const o = await BulkOffer.findById(doc._id).lean();
  assert.equal(o.state, "sending");
  assert.equal(o.open, true);
  assert.equal(o.closedAt, null);
  for (const f of [
    "setName",
    "game",
    "anchorBasis",
    "title",
    "description",
    "externalId",
    "url",
    "lastError",
    "createdBy",
  ]) {
    assert.equal(o[f], "", f);
  }
  for (const f of [
    "days",
    "discountPct",
    "anchorPrice",
    "unitPrice",
    "packPrice",
    "advertisedQty",
    "unitsDelivered",
    "ordersCount",
    "revenueUsd",
  ]) {
    assert.equal(o[f], 0, f);
  }
  for (const f of ["listing", "lastOrderAt", "lastSyncAt", "lastCheckAt"])
    assert.equal(o[f], null, f);
  assert.equal(o.autoPaused, false);
  assert.equal(o.lowStock, false);
  assert.ok(o.createdAt instanceof Date && o.updatedAt instanceof Date);
  // reserved[] / history[] entries carry no _id and get their defaults.
  assert.deepEqual(Object.keys(o.reserved[0]).sort(), [
    "accountId",
    "at",
    "changedAt",
    "keepReserved",
    "login",
    "orderId",
    "reason",
    "state",
  ]);
  assert.equal(o.reserved[0].state, "on_offer");
  assert.equal(o.reserved[0].orderId, "");
  assert.equal(o.reserved[0].changedAt, null);
  assert.equal(o.reserved[0].keepReserved, false);
  assert.ok(o.reserved[0].at instanceof Date);
  assert.equal(o.history[0]._id, undefined);
  assert.ok(o.history[0].at instanceof Date);
  const farm = await BulkOffer.create(
    offer({
      kind: "farming",
      source: "farm",
      set: undefined,
      game: "Rust",
      days: 120,
    }),
  );
  assert.equal(farm.set, null);
});

test("BulkOffer refuses unknown enums and missing required fields", async () => {
  const bad = [
    { market: "ggsel" },
    { market: "digiseller" },
    { market: "plati" },
    { market: "playerauctions" },
    { market: "zeusx" },
    { kind: "bundle" },
    { source: "pool" },
    { state: "closed" },
    { reserved: [{ accountId: "a", state: "sold" }] },
  ];
  for (const over of bad) {
    await assert.rejects(
      new BulkOffer(offer(over)).validate(),
      { name: "ValidationError" },
      JSON.stringify(over),
    );
  }
  for (const field of ["kind", "source", "market", "minQty", "slotKey"]) {
    const o = offer();
    delete o[field];
    await assert.rejects(
      new BulkOffer(o).validate(),
      (e) => e.name === "ValidationError" && !!e.errors[field],
      field,
    );
  }
});

test("BulkOffer: one OPEN offer per slot, any number once closed (CONTRACT I6)", async () => {
  const setId = new mongoose.Types.ObjectId();
  const key = config.slotKey({
    kind: "accounts",
    source: "dropset",
    setId,
    market: "eldorado",
    minQty: 5,
  });
  const dup = (e) => e && e.code === 11000;

  const a = await BulkOffer.create(offer({ set: setId, slotKey: key }));
  await assert.rejects(
    BulkOffer.create(offer({ set: setId, slotKey: key })),
    dup,
  );
  // live and paused are still open states: still blocked.
  await BulkOffer.updateOne(
    { _id: a._id },
    { $set: { state: "live", open: true } },
  );
  await assert.rejects(
    BulkOffer.create(offer({ set: setId, slotKey: key, state: "live" })),
    dup,
  );
  await BulkOffer.updateOne(
    { _id: a._id },
    { $set: { state: "paused", open: true } },
  );
  await assert.rejects(
    BulkOffer.create(offer({ set: setId, slotKey: key, state: "paused" })),
    dup,
  );
  // A different slot is independent.
  const key10 = config.slotKey({
    kind: "accounts",
    source: "dropset",
    setId,
    market: "eldorado",
    minQty: 10,
  });
  assert.notEqual(key10, key);
  await BulkOffer.create(offer({ set: setId, slotKey: key10, minQty: 10 }));

  // Close A (explicit writer fields) -> the slot can be re-sent.
  await BulkOffer.updateOne(
    { _id: a._id },
    { $set: { state: "withdrawn", open: false, closedAt: new Date() } },
  );
  const b = await BulkOffer.create(offer({ set: setId, slotKey: key }));
  await assert.rejects(
    BulkOffer.create(offer({ set: setId, slotKey: key })),
    dup,
  );

  // Close B through a document save.
  b.state = "sold_out";
  await b.save();
  assert.equal(b.open, false);
  assert.ok(b.closedAt instanceof Date);
  const c = await BulkOffer.create(offer({ set: setId, slotKey: key }));
  assert.ok(c._id);

  assert.equal(await BulkOffer.countDocuments({ slotKey: key }), 3);
  assert.equal(await BulkOffer.countDocuments({ slotKey: key, open: true }), 1);
});

test("BulkOffer save: `open` is derived from state, closedAt stamped on close", async () => {
  const live = await BulkOffer.create(offer({ state: "live", open: false }));
  assert.equal(live.open, true);
  assert.equal(live.closedAt, null);

  const err = await BulkOffer.create(
    offer({ state: "error", slotKey: "shared-closed" }),
  );
  assert.equal(err.open, false);
  assert.ok(err.closedAt instanceof Date);
  // Two closed offers may share a slot.
  const err2 = await BulkOffer.create(
    offer({ state: "error", open: true, slotKey: "shared-closed" }),
  );
  assert.equal(err2.open, false);

  // An explicit closedAt is kept.
  const fixed = new Date("2026-09-30T00:00:00Z");
  const w = await BulkOffer.create(
    offer({ state: "withdrawn", closedAt: fixed }),
  );
  assert.equal(w.closedAt.getTime(), fixed.getTime());
});

test("BulkOffer updates: open/closedAt filled in, explicit values kept, bad states refused", async () => {
  const a = await BulkOffer.create(offer());
  await BulkOffer.updateOne({ _id: a._id }, { $set: { state: "live" } });
  let o = await BulkOffer.findById(a._id).lean();
  assert.equal(o.open, true);
  assert.equal(o.closedAt, null);

  await BulkOffer.updateOne({ _id: a._id }, { $set: { state: "expired" } });
  o = await BulkOffer.findById(a._id).lean();
  assert.equal(o.state, "expired");
  assert.equal(o.open, false);
  assert.ok(o.closedAt instanceof Date);

  // Explicit writer values win.
  const b = await BulkOffer.create(offer());
  const fixed = new Date("2026-09-29T12:00:00Z");
  await BulkOffer.updateOne(
    { _id: b._id },
    { $set: { state: "withdrawn", open: false, closedAt: fixed } },
  );
  o = await BulkOffer.findById(b._id).lean();
  assert.equal(o.closedAt.getTime(), fixed.getTime());

  // findOneAndUpdate, including the bare (non-$set) update form.
  const c = await BulkOffer.create(offer());
  const after = await BulkOffer.findOneAndUpdate(
    { _id: c._id },
    { state: "sold" },
    { returnDocument: "after" },
  ).lean();
  assert.equal(after.state, "sold");
  assert.equal(after.open, false);
  assert.ok(after.closedAt instanceof Date);

  // updateMany closes every matched offer consistently.
  const d1 = await BulkOffer.create(offer({ createdBy: "bulk-many" }));
  const d2 = await BulkOffer.create(
    offer({ createdBy: "bulk-many", state: "paused" }),
  );
  await BulkOffer.updateMany(
    { createdBy: "bulk-many" },
    { $set: { state: "withdrawn" } },
  );
  for (const id of [d1._id, d2._id]) {
    o = await BulkOffer.findById(id).lean();
    assert.equal(o.open, false);
    assert.ok(o.closedAt instanceof Date);
  }

  // An invalid state never lands (updates do not run enum validators).
  const e = await BulkOffer.create(offer());
  await assert.rejects(
    BulkOffer.updateOne({ _id: e._id }, { $set: { state: "closed" } }),
    /not a valid state/,
  );
  await assert.rejects(
    BulkOffer.findOneAndUpdate({ _id: e._id }, { state: "gone" }),
    /not a valid state/,
  );
  o = await BulkOffer.findById(e._id).lean();
  assert.equal(o.state, "sending");
  assert.equal(o.open, true);
  // An undefined state is a no-op write, not a refusal.
  await assert.doesNotReject(
    BulkOffer.updateOne(
      { _id: e._id },
      { $set: { state: undefined, lastError: "x" } },
    ),
  );
  o = await BulkOffer.findById(e._id).lean();
  assert.equal(o.state, "sending");
  assert.equal(o.lastError, "x");
  // Updates that do not write `state` are untouched.
  await BulkOffer.updateOne({ _id: e._id }, { $set: { lowStock: true } });
  o = await BulkOffer.findById(e._id).lean();
  assert.equal(o.open, true);
  assert.equal(o.closedAt, null);
});

test("BulkOffer history keeps the last 60 entries, on save and on $push", async () => {
  const entries = (n, tag) =>
    Array.from({ length: n }, (_, i) => ({ action: tag + i }));
  const a = await BulkOffer.create(offer({ history: entries(59, "h") }));
  for (let i = 0; i < 3; i++) {
    await BulkOffer.updateOne(
      { _id: a._id },
      { $push: { history: { action: "new" + i, actor: "loop" } } },
    );
  }
  let o = await BulkOffer.findById(a._id).lean();
  assert.equal(o.history.length, 60);
  assert.equal(o.history[0].action, "h2");
  assert.equal(o.history[59].action, "new2");
  assert.equal(o.history[59].actor, "loop");

  // $each without $slice gets one; an explicit $slice is respected.
  await BulkOffer.updateOne(
    { _id: a._id },
    { $push: { history: { $each: entries(5, "e") } } },
  );
  o = await BulkOffer.findById(a._id).lean();
  assert.equal(o.history.length, 60);
  assert.equal(o.history[59].action, "e4");
  await BulkOffer.updateOne(
    { _id: a._id },
    { $push: { history: { $each: [{ action: "last" }], $slice: -5 } } },
  );
  o = await BulkOffer.findById(a._id).lean();
  assert.equal(o.history.length, 5);

  // Document path.
  const b = await BulkOffer.create(offer({ history: entries(70, "d") }));
  assert.equal(b.history.length, 60);
  assert.equal(b.history[0].action, "d10");
  b.history.push({ action: "d70" });
  await b.save();
  o = await BulkOffer.findById(b._id).lean();
  assert.equal(o.history.length, 60);
  assert.equal(o.history[0].action, "d11");
  assert.equal(o.history[59].action, "d70");
});

// ---------------------------------------------------------------------------
// Hook H1: MarketplaceListing.bulkOfferId
// ---------------------------------------------------------------------------

test("H1: MarketplaceListing declares bulkOfferId (ObjectId -> BulkOffer, default null, indexed)", async () => {
  const p = MarketplaceListing.schema.path("bulkOfferId");
  assert.ok(p, "bulkOfferId path missing");
  assert.equal(p.instance, "ObjectId");
  assert.equal(p.options.ref, "BulkOffer");
  assert.equal(p.options.default, null);
  assert.equal(p.options.index, true);
  // No enum changes: bulk rows are origin "manual".
  assert.deepEqual(MarketplaceListing.schema.path("origin").enumValues, [
    "auto",
    "manual",
    "unclaimed",
  ]);
  const idx = await MarketplaceListing.collection.indexes();
  assert.ok(
    idx.some((i) => keyOf(i) === JSON.stringify({ bulkOfferId: 1 })),
    "bulkOfferId index missing",
  );
});

test("H1: MarketplaceListing accepts and stores bulkOfferId; {bulkOfferId:null} matches every other row", async () => {
  const offerId = new mongoose.Types.ObjectId();
  const bulkRow = await MarketplaceListing.create({
    set: new mongoose.Types.ObjectId(),
    marketplace: "eldorado",
    externalId: "bulk-ext-1",
    origin: "manual",
    bulkOfferId: offerId,
    units: [{ accountId: "acc-1", login: "login1" }],
  });
  const plainRow = await MarketplaceListing.create({
    set: new mongoose.Types.ObjectId(),
    marketplace: "g2g",
    externalId: "plain-ext-1",
  });
  let back = await MarketplaceListing.findById(bulkRow._id).lean();
  assert.equal(String(back.bulkOfferId), String(offerId));
  assert.equal(back.origin, "manual");
  back = await MarketplaceListing.findById(plainRow._id).lean();
  assert.equal(back.bulkOfferId, null);

  // A row written before the field existed has no key at all; the hooks'
  // `bulkOfferId: null` filter must still treat it as an ordinary row.
  await MarketplaceListing.collection.insertOne({
    marketplace: "gameflip",
    externalId: "legacy-ext-1",
    status: "active",
  });
  const ordinary = await MarketplaceListing.find(
    {
      externalId: { $in: ["bulk-ext-1", "plain-ext-1", "legacy-ext-1"] },
      bulkOfferId: null,
    },
    { externalId: 1 },
  ).lean();
  assert.deepEqual(ordinary.map((r) => r.externalId).sort(), [
    "legacy-ext-1",
    "plain-ext-1",
  ]);

  // A hex string is cast on write and on query.
  await MarketplaceListing.updateOne(
    { _id: plainRow._id },
    { $set: { bulkOfferId: String(offerId) } },
  );
  const mine = await MarketplaceListing.find(
    { bulkOfferId: String(offerId) },
    { externalId: 1 },
  ).lean();
  assert.deepEqual(mine.map((r) => r.externalId).sort(), [
    "bulk-ext-1",
    "plain-ext-1",
  ]);

  // The model's post-save audit is fire-and-forget; let both rows land so the
  // teardown does not cut them off mid-write.
  const SystemEvent = require("../models/SystemEvent");
  const audited = () =>
    SystemEvent.countDocuments({
      category: "listings",
      "meta.externalId": { $in: ["bulk-ext-1", "plain-ext-1"] },
    });
  for (let i = 0; i < 100 && (await audited()) < 2; i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await audited(), 2);
});

// ---------------------------------------------------------------------------

test("the real utils/settings.json was never written", () => {
  assert.equal(settingsFileState(), SETTINGS_BEFORE);
});
