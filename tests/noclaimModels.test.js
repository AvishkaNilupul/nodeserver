// No-claim Shop listings, models layer (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md
// §1). Every other agent codes against these fields, so this pins their shape:
// the enums, defaults and indexes, the rule that an existing row/set reads as
// NOT no-claim (so everything else stays byte-identical), and the
// getNoclaimShopSettings merge + clamp that a paid buyer's delivery is gated on.
//
// Mongo-free: documents are only constructed and validated (validateSync never
// touches a connection). Settings are read through a fresh copy of
// utils/settings.js whose `fs` is stubbed at require time with Module._load, so
// no settings.json is ever written — other suites may be reading the real one.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const path = require("path");
const mongoose = require("mongoose");

const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const NoclaimHolding = require("../models/NoclaimHolding");

// A fresh utils/settings.js that sees `fileJson` as its settings.json:
// undefined = the file is missing, a string = the raw file text (so a broken
// file can be simulated), anything else = JSON.stringify'd.
const SETTINGS_PATH = require.resolve("../utils/settings");
const SETTINGS_FILE = path.join(path.dirname(SETTINGS_PATH), "settings.json");
function loadSettingsWith(fileJson) {
  const realFs = require("fs");
  const fakeFs = {
    ...realFs,
    readFileSync(file, ...rest) {
      if (path.resolve(String(file)) !== SETTINGS_FILE) {
        return realFs.readFileSync(file, ...rest);
      }
      if (fileJson === undefined) {
        const e = new Error("ENOENT: no such file or directory");
        e.code = "ENOENT";
        throw e;
      }
      return typeof fileJson === "string" ? fileJson : JSON.stringify(fileJson);
    },
  };
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "fs" && parent && parent.filename === SETTINGS_PATH) {
      return fakeFs;
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[SETTINGS_PATH];
  try {
    return require("../utils/settings");
  } finally {
    Module._load = origLoad;
    delete require.cache[SETTINGS_PATH];
  }
}

const CONTRACT_DEFAULTS = {
  enabled: true,
  autoDeliver: true,
  sweep: true,
  sweepPerTick: 30,
  sweepEveryMin: 10,
  maxAgeHours: 8,
  refreshBudget: 120,
  topUp: true,
  healthPerPass: 20,
  passEveryMin: 10,
};

// ---------------------------------------------------------------------------
// §1a DropSet.stockSource
// ---------------------------------------------------------------------------

test("DropSet.stockSource: '' (the Drop Archive) unless a set says 'noclaim'", () => {
  const p = DropSet.schema.path("stockSource");
  assert.ok(p, "stockSource path missing");
  assert.strictEqual(p.instance, "String");
  assert.deepStrictEqual(p.options.enum, ["", "noclaim"]);
  assert.strictEqual(p.options.default, "");
  assert.strictEqual(p.options.index, true);

  // Every set written before the field existed reads as archive-backed.
  const legacy = new DropSet({ name: "Old bundle" });
  assert.strictEqual(legacy.stockSource, "");
  assert.strictEqual(legacy.validateSync(), undefined);

  const nc = new DropSet({
    name: "No-claim bundle",
    stockSource: "noclaim",
    listed: false,
    publicCatalog: false,
    custom: false,
    items: [{ itemKey: "cool skin|overwatch 2", name: "Cool Skin", qty: 2 }],
  });
  assert.strictEqual(nc.validateSync(), undefined);

  const bad = new DropSet({ name: "X", stockSource: "archive" });
  const err = bad.validateSync();
  assert.ok(err && err.errors.stockSource, "an unknown source must not validate");
});

// ---------------------------------------------------------------------------
// §1b MarketplaceListing.noclaimStock
// ---------------------------------------------------------------------------

test("MarketplaceListing.noclaimStock: false on every existing row, indexed", () => {
  const p = MarketplaceListing.schema.path("noclaimStock");
  assert.ok(p, "noclaimStock path missing");
  assert.strictEqual(p.instance, "Boolean");
  assert.strictEqual(p.options.default, false);
  assert.strictEqual(p.options.index, true);

  const legacy = new MarketplaceListing({
    marketplace: "gameflip",
    externalId: "gf-1",
    set: new mongoose.Types.ObjectId(),
  });
  assert.strictEqual(legacy.noclaimStock, false);
});

test("MarketplaceListing: a no-claim row validates with its set, and still REQUIRES it", () => {
  // The rowFields shape (contract §3) on a vault market.
  const row = {
    marketplace: "ggsel",
    externalId: "123456",
    noclaimStock: true,
    origin: "manual",
    accountId: "",
    accountLogin: "",
    requiredDrops: [{ name: "Cool Skin", qty: 2 }],
    units: [
      { contentId: "", accountId: "", login: "alpha", deliveredAt: null, orderId: "" },
    ],
  };
  const ok = new MarketplaceListing({ ...row, set: new mongoose.Types.ObjectId() });
  assert.strictEqual(ok.validateSync(), undefined);
  assert.strictEqual(ok.noclaimStock, true);

  // A no-claim row keeps its set (UI linkage + delete guard). Losing it must be
  // a validation error, not a row that silently falls into another stock mode.
  const err = new MarketplaceListing(row).validateSync();
  assert.ok(err && err.errors.set, "a no-claim row without its set must not validate");
});

// ---------------------------------------------------------------------------
// §1c UnclaimedAccount: "manual" status + manual-listing fields
// ---------------------------------------------------------------------------

test("UnclaimedAccount.status: 'manual' joins the lifecycle, the default is unchanged", () => {
  const p = UnclaimedAccount.schema.path("status");
  assert.deepStrictEqual(p.options.enum, [
    "listed",
    "sold",
    "expired",
    "released",
    "skipped",
    "removed",
    "manual",
  ]);
  assert.strictEqual(p.options.default, "skipped");

  // The manual claim CREATES ledgers (contract §3 step 3), and create()
  // validates — so "manual" has to be a real enum member, not just a $set.
  const doc = new UnclaimedAccount({
    source: "noclaim",
    login: "Alpha",
    loginLower: "alpha",
    status: "manual",
    market: "ggsel",
    manualListing: "",
    manualPriorStatus: "",
    manualAt: new Date(),
  });
  assert.strictEqual(doc.validateSync(), undefined);

  const bad = new UnclaimedAccount({ source: "noclaim", status: "vaulted" });
  const err = bad.validateSync();
  assert.ok(err && err.errors.status, "an unknown status must not validate");
});

test("UnclaimedAccount: every status a manual release restores is a valid status", () => {
  const statuses = UnclaimedAccount.schema.path("status").options.enum;
  for (const s of ["skipped", "released", "expired"]) {
    assert.ok(statuses.includes(s), `FREE status ${s} missing from the enum`);
  }
});

test("UnclaimedAccount: every no-claim listing market is a valid ledger market", () => {
  // The claim writes `market` = the listing's marketplace (vault and
  // claim-at-sale alike), so each supported one must pass the enum.
  const markets = UnclaimedAccount.schema.path("market").options.enum;
  for (const m of ["gameflip", "ggsel", "digiseller", "eldorado", "playerauctions", "g2g"]) {
    assert.ok(markets.includes(m), `market ${m} missing from the ledger enum`);
  }
});

test("UnclaimedAccount: manual-listing fields exist with release-safe defaults", () => {
  const S = UnclaimedAccount.schema;
  const expect = {
    manualListing: { instance: "String", default: "", index: true },
    manualPriorStatus: { instance: "String", default: "" },
    manualAt: { instance: "Date", default: null },
    manualSpentAt: { instance: "Date", default: null },
  };
  for (const [name, want] of Object.entries(expect)) {
    const p = S.path(name);
    assert.ok(p, `${name} path missing`);
    assert.strictEqual(p.instance, want.instance, `${name} type`);
    assert.strictEqual(p.options.default, want.default, `${name} default`);
    if (want.index) assert.strictEqual(p.options.index, true, `${name} index`);
  }

  // An auto-lister ledger (every row before this change) reads as "never
  // manually claimed" and "manual layer did not create me".
  const doc = new UnclaimedAccount({ source: "noclaim", status: "listed" });
  assert.strictEqual(doc.manualListing, "");
  assert.strictEqual(doc.manualPriorStatus, "");
  assert.strictEqual(doc.manualAt, null);
  assert.strictEqual(doc.manualSpentAt, null);
});

// ---------------------------------------------------------------------------
// §1d NoclaimHolding
// ---------------------------------------------------------------------------

test("NoclaimHolding: one row per account, keyed by a required unique loginLower", () => {
  assert.strictEqual(NoclaimHolding.modelName, "NoclaimHolding");
  const S = NoclaimHolding.schema;
  const ll = S.path("loginLower");
  assert.strictEqual(ll.instance, "String");
  assert.strictEqual(ll.options.required, true);
  assert.strictEqual(ll.options.unique, true);
  assert.strictEqual(S.options.timestamps, true);

  const err = new NoclaimHolding({}).validateSync();
  assert.ok(err && err.errors.loginLower, "loginLower must be required");
});

test("NoclaimHolding: a new row reads as 'in a config, never read'", () => {
  const h = new NoclaimHolding({ loginLower: "alpha" });
  assert.strictEqual(h.validateSync(), undefined);
  for (const f of ["login", "twitchId", "poolAccountId", "botId", "container", "game", "readError"]) {
    assert.strictEqual(h[f], "", `${f} default`);
  }
  assert.strictEqual(h.items.length, 0);
  assert.strictEqual(h.sellableCount, 0);
  assert.strictEqual(h.readAt, null);
  assert.strictEqual(h.seenAt, null);
  assert.strictEqual(h.inConfig, true);

  const S = NoclaimHolding.schema;
  for (const f of ["poolAccountId", "readAt", "inConfig"]) {
    assert.strictEqual(S.path(f).options.index, true, `${f} must be indexed`);
  }
});

test("NoclaimHolding.items: folded entries without _id, qty defaults to 1", () => {
  const h = new NoclaimHolding({
    loginLower: "alpha",
    items: [
      {
        itemKey: "cool skin|overwatch 2",
        name: "Cool Skin",
        game: "Overwatch 2",
        campaign: "Season 1",
        image: "https://example.test/skin.png",
      },
      { itemKey: "loot box|overwatch 2", name: "Loot Box", game: "Overwatch 2", qty: 3 },
    ],
    sellableCount: 4,
  });
  assert.strictEqual(h.validateSync(), undefined);
  const items = h.toObject().items;
  assert.strictEqual(items.length, 2);
  assert.strictEqual(items[0]._id, undefined, "item entries must not carry an _id");
  assert.strictEqual(items[0].qty, 1);
  assert.strictEqual(items[0].campaign, "Season 1");
  assert.strictEqual(items[1].qty, 3);
  assert.deepStrictEqual(
    Object.keys(NoclaimHolding.schema.path("items").schema.paths).sort(),
    ["campaign", "game", "image", "itemKey", "name", "qty"],
  );
});

test("NoclaimHolding has nowhere to put a credential", () => {
  const leaky = Object.keys(NoclaimHolding.schema.paths).filter((p) =>
    /pass|secret|token|cred|email|cookie/i.test(p),
  );
  assert.deepStrictEqual(leaky, []);

  // Strict mode drops one handed in by mistake instead of persisting it.
  const h = new NoclaimHolding({
    loginLower: "alpha",
    password: "hunter2",
    clientSecret: "abc",
  }).toObject();
  assert.strictEqual(h.password, undefined);
  assert.strictEqual(h.clientSecret, undefined);
});

// ---------------------------------------------------------------------------
// §1e settings.getNoclaimShopSettings
// ---------------------------------------------------------------------------

test("settings: NOCLAIM_SHOP_DEFAULTS is the contract's block, exported and in DEFAULTS", () => {
  const s = loadSettingsWith(undefined);
  assert.deepStrictEqual(s.NOCLAIM_SHOP_DEFAULTS, CONTRACT_DEFAULTS);
  assert.strictEqual(typeof s.getNoclaimShopSettings, "function");
  // Top-level block, beside accountListings — not inside autoFarm.
  assert.deepStrictEqual(s.loadSettings().noclaimShop, CONTRACT_DEFAULTS);
  assert.strictEqual(s.getAutoFarm().noclaimShop, undefined);
});

test("settings: no settings.json (or a broken one) reads as the defaults", () => {
  assert.deepStrictEqual(loadSettingsWith(undefined).getNoclaimShopSettings(), CONTRACT_DEFAULTS);
  assert.deepStrictEqual(loadSettingsWith("{not json").getNoclaimShopSettings(), CONTRACT_DEFAULTS);
  assert.deepStrictEqual(loadSettingsWith({}).getNoclaimShopSettings(), CONTRACT_DEFAULTS);
  // A block that is not an object at all degrades the same way.
  assert.deepStrictEqual(
    loadSettingsWith({ noclaimShop: "off" }).getNoclaimShopSettings(),
    CONTRACT_DEFAULTS,
  );
  assert.deepStrictEqual(
    loadSettingsWith({ noclaimShop: null }).getNoclaimShopSettings(),
    CONTRACT_DEFAULTS,
  );
});

test("settings: a partial block keeps every unwritten key at its default (deep merge)", () => {
  // loadSettings merges only shallowly: without the accessor's merge this
  // one-key edit would read autoDeliver back as undefined = delivery OFF.
  const s = loadSettingsWith({ noclaimShop: { sweep: false } });
  assert.deepStrictEqual(s.getNoclaimShopSettings(), { ...CONTRACT_DEFAULTS, sweep: false });

  const off = loadSettingsWith({ noclaimShop: { enabled: false, autoDeliver: 0, topUp: false } });
  const got = off.getNoclaimShopSettings();
  assert.strictEqual(got.enabled, false);
  assert.strictEqual(got.autoDeliver, false);
  assert.strictEqual(got.topUp, false);
  assert.strictEqual(got.sweep, true);
  assert.strictEqual(got.sweepPerTick, 30);

  // null on a switch = unset = the default, never OFF.
  const nul = loadSettingsWith({ noclaimShop: { enabled: null, autoDeliver: null } });
  assert.strictEqual(nul.getNoclaimShopSettings().enabled, true);
  assert.strictEqual(nul.getNoclaimShopSettings().autoDeliver, true);
});

test("settings: an autoFarm write can never reach the no-claim switches", () => {
  const s = loadSettingsWith({
    autoFarm: { noclaimShop: { enabled: false, autoDeliver: false }, enabled: false },
  });
  assert.deepStrictEqual(s.getNoclaimShopSettings(), CONTRACT_DEFAULTS);
});

test("settings: every number is clamped into the contract's range", () => {
  const hi = loadSettingsWith({
    noclaimShop: {
      sweepPerTick: 999,
      sweepEveryMin: 1000,
      maxAgeHours: 100,
      refreshBudget: 5000,
      healthPerPass: 101,
      passEveryMin: 121,
    },
  }).getNoclaimShopSettings();
  assert.strictEqual(hi.sweepPerTick, 200);
  assert.strictEqual(hi.sweepEveryMin, 240);
  assert.strictEqual(hi.maxAgeHours, 72);
  assert.strictEqual(hi.refreshBudget, 400);
  assert.strictEqual(hi.healthPerPass, 100);
  assert.strictEqual(hi.passEveryMin, 120);

  const lo = loadSettingsWith({
    noclaimShop: {
      sweepPerTick: 0,
      sweepEveryMin: 0,
      maxAgeHours: 0,
      refreshBudget: -5,
      healthPerPass: -1,
      passEveryMin: 1,
    },
  }).getNoclaimShopSettings();
  assert.strictEqual(lo.sweepPerTick, 1);
  assert.strictEqual(lo.sweepEveryMin, 2);
  assert.strictEqual(lo.maxAgeHours, 1);
  assert.strictEqual(lo.refreshBudget, 1);
  assert.strictEqual(lo.healthPerPass, 0);
  assert.strictEqual(lo.passEveryMin, 2);

  // 0 is inside healthPerPass's range: it turns the unit re-checks off.
  const zero = loadSettingsWith({ noclaimShop: { healthPerPass: 0 } });
  assert.strictEqual(zero.getNoclaimShopSettings().healthPerPass, 0);
});

test("settings: fractions floor, numeric strings count, junk degrades to the default", () => {
  const got = loadSettingsWith({
    noclaimShop: {
      sweepPerTick: 12.9,
      sweepEveryMin: "15",
      maxAgeHours: "abc",
      refreshBudget: null,
      healthPerPass: "",
      passEveryMin: "Infinity",
    },
  }).getNoclaimShopSettings();
  assert.strictEqual(got.sweepPerTick, 12);
  assert.strictEqual(got.sweepEveryMin, 15);
  assert.strictEqual(got.maxAgeHours, 8, "non-numeric -> default");
  assert.strictEqual(got.refreshBudget, 120, "null -> default, not clamped 0");
  assert.strictEqual(got.healthPerPass, 20, "blank -> default, not 0 (checks off)");
  assert.strictEqual(got.passEveryMin, 10, "non-finite -> default");
});

test("settings: each call is a fresh object — a caller's edit never leaks into the defaults", () => {
  const s = loadSettingsWith(undefined);
  const a = s.getNoclaimShopSettings();
  a.enabled = false;
  a.sweepPerTick = 1;
  assert.strictEqual(s.getNoclaimShopSettings().enabled, true);
  assert.strictEqual(s.getNoclaimShopSettings().sweepPerTick, 30);
  assert.strictEqual(s.NOCLAIM_SHOP_DEFAULTS.enabled, true);
});
