// Code shop settings (utils/codeShop/config.js, docs/code-shop/01-DATA.md).
//
// The settings decide whether the shop publishes, which markets it may touch
// and which buyer words it refuses, so the things that must hold are:
// - no document means DEFAULTS, which ship dark; an unreadable one before any
//   good read means SAFE_DEFAULTS (every switch that writes stock or talks to a
//   market off) — the scheduler reads this every tick and a DB blip must never
//   throw out of it;
// - GGSel is not used for codes (05-REVIEW-FIXES.md, R1): `markets.ggsel: true`
//   is refused, and a value stored before that reads as false;
// - a patch changes only what it names (deep merge; lists replace whole), and
//   two writers changing different settings never undo each other;
// - a bad patch is refused before anything is written (status 400), above all
//   a market other than eldorado/ggsel and a source word that is not a pattern.
//
// Real Mongo via mongodb-memory-server. The model is a local copy of the
// contract's shape under its own name, so this file never loads (or races)
// models/CodeShopConfig.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const { DEFAULTS, SAFE_DEFAULTS, GGSEL_REFUSED, createConfig, validatePatch, deepMerge } = require("../utils/codeShop/config");

const TestConfig =
  mongoose.models.TestCodeShopConfig ||
  mongoose.model(
    "TestCodeShopConfig",
    new mongoose.Schema(
      {
        key: { type: String, required: true, unique: true },
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
        updatedBy: { type: String, default: "" },
        updatedAt: { type: Date, default: null },
      },
      { collection: "test_codeshopconfigs" },
    ),
  );

let mem;
let clock = Date.parse("2026-10-15T00:00:00Z");
const now = () => clock;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopconfig"));
  await TestConfig.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await TestConfig.deleteMany({});
});

const fresh = (opts = {}) => createConfig({ model: TestConfig, now, ...opts });
const clone = (v) => deepMerge({}, v);

// --- get / set ---------------------------------------------------------------

test("no document: get() returns DEFAULTS, as a copy nobody can corrupt", async () => {
  const cfg = fresh();
  const a = await cfg.get();
  assert.deepEqual(a, DEFAULTS);
  assert.notEqual(a, DEFAULTS);
  assert.notEqual(a.games, DEFAULTS.games);
  assert.notEqual(a.sourceWords, DEFAULTS.sourceWords);

  // Ships dark.
  assert.equal(a.autoPublish, false);
  assert.equal(a.markets.ggsel, false);
  assert.equal(a.farmPriority.enabled, false);

  a.autoPublish = true;
  a.sourceWords.push("anything");
  assert.equal(DEFAULTS.autoPublish, false);
  assert.equal(DEFAULTS.sourceWords.includes("anything"), false);
  assert.ok(Object.isFrozen(DEFAULTS));
  assert.ok(Object.isFrozen(DEFAULTS.pricing.clearanceSteps[0]));
  assert.ok(Object.isFrozen(DEFAULTS.games["12"]));
});

test("createConfig() without a model loads nothing until first use", () => {
  assert.doesNotThrow(() => createConfig());
});

test("set() deep-merges: untouched settings keep their defaults, the DB holds only the change", async () => {
  const cfg = fresh();
  const after = await cfg.set({ digest: { hourUtc: 5 } }, { actor: "owner" });
  assert.deepEqual(after.digest, { enabled: true, hourUtc: 5, lastSentDay: "" });
  assert.deepEqual({ ...after, digest: DEFAULTS.digest }, clone(DEFAULTS));

  const again = await cfg.set({ digest: { lastSentDay: "2026-10-15" } });
  assert.deepEqual(again.digest, { enabled: true, hourUtc: 5, lastSentDay: "2026-10-15" });

  const doc = await TestConfig.findOne({ key: "main" }).lean();
  assert.deepEqual(doc.data, { digest: { hourUtc: 5, lastSentDay: "2026-10-15" } });
  assert.equal(doc.updatedBy, "");
  assert.equal(doc.updatedAt.getTime(), clock);
  assert.equal(await TestConfig.countDocuments(), 1);

  await cfg.set({ autoDraft: false }, { actor: "owner" });
  assert.equal((await TestConfig.findOne({ key: "main" }).lean()).updatedBy, "owner");
});

test("games: a partial entry keeps the entry's other fields, new games add, default games stay", async () => {
  const cfg = fresh();
  const after = await cfg.set({
    games: {
      "12": { sell: false },
      "300": { sell: true, marketGame: "Some Game", displayName: "Some Game" },
    },
  });
  assert.deepEqual(after.games["12"], { sell: false, marketGame: "Overwatch", displayName: "Overwatch 2" });
  assert.deepEqual(after.games["200"], DEFAULTS.games["200"]);
  assert.deepEqual(after.games["300"], { sell: true, marketGame: "Some Game", displayName: "Some Game" });

  const later = await cfg.set({ games: { "300": { displayName: "Renamed" } } });
  assert.deepEqual(later.games["300"], { sell: true, marketGame: "Some Game", displayName: "Renamed" });
  assert.equal(later.games["12"].sell, false);
});

test("lists are replaced whole, never merged", async () => {
  const cfg = fresh();
  let c = await cfg.set({ sourceWords: ["foo"] });
  assert.deepEqual(c.sourceWords, ["foo"]);

  c = await cfg.set({ pricing: { clearanceSteps: [{ days: 2, cutPct: 10 }] } });
  assert.deepEqual(c.pricing.clearanceSteps, [{ days: 2, cutPct: 10 }]);
  assert.equal(c.pricing.cooldownHours, DEFAULTS.pricing.cooldownHours);

  // A later sibling change keeps the replaced list as it is.
  c = await cfg.set({ pricing: { cooldownHours: 1 } });
  assert.deepEqual(c.pricing.clearanceSteps, [{ days: 2, cutPct: 10 }]);
  assert.equal(c.pricing.cooldownHours, 1);
  assert.equal(c.pricing.undercutUsd, DEFAULTS.pricing.undercutUsd);

  c = await cfg.set({ sourceWords: [], farmPriority: { botIds: ["b1", "b2"] } });
  assert.deepEqual(c.sourceWords, []);
  assert.deepEqual(c.farmPriority.botIds, ["b1", "b2"]);
  c = await cfg.set({ farmPriority: { botIds: ["b3"] } });
  assert.deepEqual(c.farmPriority.botIds, ["b3"]);
});

test("farmPriority.lastChangeAt: epoch ms, Date or date text is stored as a Date; null clears it", async () => {
  const cfg = fresh();
  let c = await cfg.set({ farmPriority: { lastChangeAt: clock } });
  assert.ok(c.farmPriority.lastChangeAt instanceof Date);
  assert.equal(c.farmPriority.lastChangeAt.getTime(), clock);
  assert.equal(c.farmPriority.minHoursBetween, DEFAULTS.farmPriority.minHoursBetween);

  c = await cfg.set({ farmPriority: { lastChangeAt: "2026-10-14T12:00:00Z" } });
  assert.equal(c.farmPriority.lastChangeAt.getTime(), Date.parse("2026-10-14T12:00:00Z"));

  c = await cfg.set({ farmPriority: { lastChangeAt: new Date(clock + 1) } });
  assert.equal(c.farmPriority.lastChangeAt.getTime(), clock + 1);

  c = await cfg.set({ farmPriority: { lastChangeAt: null } });
  assert.equal(c.farmPriority.lastChangeAt, null);
});

test("concurrent writers on different settings never undo each other (first write included)", async () => {
  const a = fresh();
  const b = fresh();
  await Promise.all([
    a.set({ autoDraft: false }),
    b.set({ digest: { lastSentDay: "2026-10-15" } }),
    a.set({ farmPriority: { lastChangeAt: clock } }),
    b.set({ markets: { eldorado: false } }),
  ]);
  const c = await fresh().get();
  assert.equal(c.autoDraft, false);
  assert.equal(c.digest.lastSentDay, "2026-10-15");
  assert.equal(c.digest.hourUtc, DEFAULTS.digest.hourUtc);
  assert.equal(c.farmPriority.lastChangeAt.getTime(), clock);
  assert.deepEqual(c.markets, { eldorado: false, ggsel: false, playerauctions: false });
  assert.equal(await TestConfig.countDocuments(), 1);
});

test("memo: a change made elsewhere shows after memoMs, at once after forget() or fresh", async () => {
  const cfg = fresh();
  assert.equal((await cfg.get()).autoPublish, false);

  await TestConfig.updateOne({ key: "main" }, { $set: { "data.autoPublish": true } }, { upsert: true });
  assert.equal((await cfg.get()).autoPublish, false, "memoised");
  clock += 29999;
  assert.equal((await cfg.get()).autoPublish, false, "still inside memoMs");
  clock += 2;
  assert.equal((await cfg.get()).autoPublish, true, "memo expired");

  await TestConfig.updateOne({ key: "main" }, { $set: { "data.autoPublish": false } });
  assert.equal((await cfg.get()).autoPublish, true, "memoised again");
  assert.equal((await cfg.get({ fresh: true })).autoPublish, false, "fresh skips the memo");

  await TestConfig.updateOne({ key: "main" }, { $set: { "data.autoPublish": true } });
  assert.equal((await cfg.get()).autoPublish, false, "fresh re-memoised");
  cfg.forget();
  assert.equal((await cfg.get()).autoPublish, true, "forget() drops the memo");
});

test("memoMs is honoured as given", async () => {
  const cfg = fresh({ memoMs: 1000 });
  await cfg.get();
  await TestConfig.updateOne({ key: "main" }, { $set: { "data.expiryGuard": false } }, { upsert: true });
  assert.equal((await cfg.get()).expiryGuard, true);
  clock += 1000;
  assert.equal((await cfg.get()).expiryGuard, false);

  const noMemo = fresh({ memoMs: 0 });
  assert.equal((await noMemo.get()).expiryGuard, false);
  await TestConfig.updateOne({ key: "main" }, { $set: { "data.expiryGuard": true } });
  assert.equal((await noMemo.get()).expiryGuard, true);
});

test("set() clears the memo and returns the new effective config", async () => {
  const cfg = fresh();
  assert.equal((await cfg.get()).autoDraft, true);
  const returned = await cfg.set({ autoDraft: false });
  assert.equal(returned.autoDraft, false);
  assert.equal((await cfg.get()).autoDraft, false);
});

test("a DB error never throws: SAFE_DEFAULTS when nothing was read yet", async (t) => {
  const errors = t.mock.method(console, "error", () => {});

  const throwsSync = createConfig({ model: { findOne() { throw new Error("db down"); } }, now });
  assert.deepEqual(await throwsSync.get(), SAFE_DEFAULTS);

  const rejects = createConfig({
    model: { findOne: () => ({ lean: () => Promise.reject(new Error("db down")) }) },
    now,
  });
  const c = await rejects.get();
  assert.deepEqual(c, SAFE_DEFAULTS);
  assert.notEqual(c, SAFE_DEFAULTS, "a copy");
  assert.notEqual(c.markets, SAFE_DEFAULTS.markets);
  assert.deepEqual(await rejects.get({ fresh: true }), SAFE_DEFAULTS);
  assert.ok(errors.mock.callCount() >= 1);
  assert.match(errors.mock.calls[0].arguments[0], /safe defaults/);
});

test("SAFE_DEFAULTS: every switch that writes stock or talks to a market is off; expiryGuard stays on", () => {
  assert.equal(SAFE_DEFAULTS.autoBuildUnits, false);
  assert.equal(SAFE_DEFAULTS.autoDraft, false);
  assert.equal(SAFE_DEFAULTS.autoPublish, false);
  assert.deepEqual(SAFE_DEFAULTS.markets, { eldorado: false, ggsel: false, playerauctions: false });
  assert.equal(SAFE_DEFAULTS.farmPriority.enabled, false);
  assert.equal(SAFE_DEFAULTS.digest.enabled, false);
  assert.equal(SAFE_DEFAULTS.claimAlert.enabled, false);
  assert.equal(SAFE_DEFAULTS.competitorScan.enabled, false);
  assert.equal(SAFE_DEFAULTS.expiryGuard, true);
  // Everything else is the ordinary default.
  assert.equal(SAFE_DEFAULTS.expiryLeadHours, DEFAULTS.expiryLeadHours);
  assert.deepEqual(SAFE_DEFAULTS.games, DEFAULTS.games);
  assert.deepEqual(SAFE_DEFAULTS.sourceWords, DEFAULTS.sourceWords);
  assert.deepEqual(SAFE_DEFAULTS.pricing, DEFAULTS.pricing);
  assert.ok(Object.isFrozen(SAFE_DEFAULTS));
  assert.ok(Object.isFrozen(SAFE_DEFAULTS.markets));
  // The good-read defaults are unchanged by R8.
  assert.equal(DEFAULTS.autoBuildUnits, true);
  assert.equal(DEFAULTS.markets.eldorado, true);
});

test("GGSel: a value stored before R1 reads as off; set() refuses to switch it on and writes nothing", async () => {
  await TestConfig.create({ key: "main", data: { markets: { ggsel: true }, autoDraft: false } });
  const cfg = fresh();
  const c = await cfg.get();
  assert.deepEqual(c.markets, { eldorado: true, ggsel: false, playerauctions: false });
  assert.equal(c.autoDraft, false, "the rest of the stored settings still count");

  await assert.rejects(cfg.set({ markets: { ggsel: true } }), (err) => {
    assert.equal(err.status, 400);
    assert.deepEqual(err.errors, ["markets.ggsel: " + GGSEL_REFUSED]);
    return true;
  });
  const after = await cfg.set({ markets: { ggsel: false } });
  assert.deepEqual(after.markets, { eldorado: true, ggsel: false, playerauctions: false });
  // A broken stored `markets` still reads as the defaults with GGSel off.
  await TestConfig.updateOne({ key: "main" }, { $set: { "data.markets": "eldorado" } });
  cfg.forget();
  assert.deepEqual((await cfg.get()).markets, { eldorado: true, ggsel: false, playerauctions: false });
});

test("a DB error never throws: the last good config is kept (after memo expiry and forget())", async (t) => {
  t.mock.method(console, "error", () => {});
  let broken = false;
  const flaky = {
    findOne: (...args) => {
      if (broken) throw new Error("db down");
      return TestConfig.findOne(...args);
    },
    findOneAndUpdate: (...args) => TestConfig.findOneAndUpdate(...args),
  };
  const cfg = createConfig({ model: flaky, now });
  await cfg.set({ autoPublish: true, expiryLeadHours: 48 });
  cfg.forget();
  assert.equal((await cfg.get()).autoPublish, true);

  broken = true;
  clock += 60000;
  let c = await cfg.get();
  assert.equal(c.autoPublish, true);
  assert.equal(c.expiryLeadHours, 48);

  cfg.forget();
  c = await cfg.get({ fresh: true });
  assert.equal(c.autoPublish, true, "forget() keeps the last good fallback");

  broken = false;
  await TestConfig.updateOne({ key: "main" }, { $set: { "data.autoPublish": false } });
  assert.equal((await cfg.get()).autoPublish, false, "recovers once the DB answers again");
});

test("set() throws status 400 on a bad patch and writes nothing", async () => {
  const cfg = fresh();
  for (const bad of [
    { nope: 1 },
    { markets: { gameflip: true } },
    { games: { abc: { sell: true } } },
    { sourceWords: ["("] },
    { digest: { hourUtc: 24 } },
    null,
  ]) {
    await assert.rejects(cfg.set(bad, { actor: "owner" }), (err) => {
      assert.equal(err.status, 400);
      assert.ok(Array.isArray(err.errors) && err.errors.length > 0);
      return true;
    });
  }
  assert.equal(await TestConfig.countDocuments(), 0);
});

test("a write error from the DB is thrown by set() (it is not a 400)", async () => {
  const cfg = createConfig({
    model: { findOneAndUpdate: () => ({ lean: () => Promise.reject(new Error("db down")) }) },
    now,
  });
  await assert.rejects(cfg.set({ autoDraft: false }), (err) => err.message === "db down" && err.status === undefined);
});

// --- validatePatch -----------------------------------------------------------

function errorsOf(patch) {
  const r = validatePatch(patch);
  assert.equal(r.ok, r.errors.length === 0);
  return r.errors;
}

function assertBad(patch, pathHint) {
  const errs = errorsOf(patch);
  assert.ok(errs.length > 0, "expected a refusal for " + JSON.stringify(patch));
  if (pathHint) assert.ok(errs.some((e) => e.startsWith(pathHint)), `expected an error on ${pathHint}, got ${errs.join(" | ")}`);
}

function assertOk(patch) {
  assert.deepEqual(errorsOf(patch), [], "expected " + JSON.stringify(patch) + " to pass");
}

test("validatePatch: the empty patch and the whole DEFAULTS pass", () => {
  assertOk({});
  assertOk(clone(DEFAULTS));
  assertOk(DEFAULTS);
});

test("validatePatch: the patch itself must be an object", () => {
  for (const bad of [null, undefined, [], "x", 5, true, new Date()]) assertBad(bad);
});

test("validatePatch: unknown keys are refused at any depth", () => {
  assertBad({ nope: true }, "nope");
  assertBad({ digest: { enabled: true, sendAt: 3 } }, "digest.sendAt");
  assertBad({ pricing: { clearanceSteps: [{ days: 1, cutPct: 5, note: "x" }] } }, "pricing.clearanceSteps[0].note");
  assertBad({ farmPriority: { botIds: [], extra: 1 } }, "farmPriority.extra");
  assertBad({ games: { "12": { sell: true, price: 1 } } }, "games.12.price");
  // Prototype keys from a JSON body.
  assertBad(JSON.parse('{"__proto__": {"autoPublish": true}}'), "__proto__");
  assertBad({ constructor: { x: 1 } }, "constructor");
  assertBad({ toString: "x" }, "toString");
  assert.equal({}.autoPublish, undefined);
});

test("validatePatch: booleans stay booleans", () => {
  for (const v of ["true", 1, 0, null, {}]) {
    assertBad({ autoPublish: v }, "autoPublish");
    assertBad({ claimAlert: { enabled: v } }, "claimAlert.enabled");
  }
  assertOk({ autoPublish: true, autoBuildUnits: false, drafts: { leftovers: false } });
});

test("validatePatch: numbers are finite and >= 0", () => {
  for (const v of [-1, NaN, Infinity, -Infinity, "36", null, true]) {
    assertBad({ expiryLeadHours: v }, "expiryLeadHours");
    assertBad({ pricing: { undercutUsd: v } }, "pricing.undercutUsd");
  }
  assertOk({ expiryLeadHours: 0, ready: { graceHours: 0.5 }, pricing: { undercutUsd: 0.05, cooldownHours: 0 } });
});

test("validatePatch: hourUtc 0-23 (whole hours), expiryLeadHours 0-720, cutPct 0-90", () => {
  assertOk({ digest: { hourUtc: 0 } });
  assertOk({ digest: { hourUtc: 23 } });
  assertBad({ digest: { hourUtc: 24 } }, "digest.hourUtc");
  assertBad({ digest: { hourUtc: -1 } }, "digest.hourUtc");
  assertBad({ digest: { hourUtc: 3.5 } }, "digest.hourUtc");

  assertOk({ expiryLeadHours: 720 });
  assertBad({ expiryLeadHours: 720.5 }, "expiryLeadHours");
  assertBad({ expiryLeadHours: 721 }, "expiryLeadHours");

  assertOk({ pricing: { clearanceSteps: [{ days: 1, cutPct: 90 }, { days: 0, cutPct: 0 }] } });
  assertBad({ pricing: { clearanceSteps: [{ days: 1, cutPct: 91 }] } }, "pricing.clearanceSteps[0].cutPct");
  assertBad({ pricing: { clearanceSteps: [{ days: -1, cutPct: 10 }] } }, "pricing.clearanceSteps[0].days");
});

test("validatePatch: the PlayerAuctions price is never under its $5 minimum (and at most 500)", () => {
  assert.equal(DEFAULTS.pricing.playerauctionsUsd, 5, "the default is the minimum");
  assertOk({ pricing: { playerauctionsUsd: 5 } });
  assertOk({ pricing: { playerauctionsUsd: 7.5 } });
  assertOk({ pricing: { playerauctionsUsd: 500 } });
  assertBad({ pricing: { playerauctionsUsd: 4.99 } }, "pricing.playerauctionsUsd");
  assertBad({ pricing: { playerauctionsUsd: 1 } }, "pricing.playerauctionsUsd");
  assertBad({ pricing: { playerauctionsUsd: 501 } }, "pricing.playerauctionsUsd");
  assertBad({ pricing: { playerauctionsUsd: "5" } }, "pricing.playerauctionsUsd");
  assert.match(errorsOf({ pricing: { playerauctionsUsd: 1 } })[0], /between 5 and 500/);
  assert.equal(DEFAULTS.markets.playerauctions, false, "PlayerAuctions ships switched off");
});

test("playerauctionsGames: Overwatch only by default; a list of game numbers; marketsForGame drops PlayerAuctions for any other game", () => {
  const { paAllowsGame, marketsForGame } = require("../utils/codeShop/config");
  assert.deepEqual(DEFAULTS.playerauctionsGames, ["12"]);
  assertOk({ playerauctionsGames: ["12", "200"] });
  assertOk({ playerauctionsGames: [] });
  assertBad({ playerauctionsGames: ["Overwatch"] }, "playerauctionsGames[0]");
  assertBad({ playerauctionsGames: "12" }, "playerauctionsGames");
  assert.equal(paAllowsGame(DEFAULTS, "12"), true);
  assert.equal(paAllowsGame(DEFAULTS, 12), true);
  assert.equal(paAllowsGame(DEFAULTS, "200"), false, "Delta Force stays off PlayerAuctions");
  assert.equal(paAllowsGame(DEFAULTS, null), false);
  assert.deepEqual(marketsForGame(["eldorado", "playerauctions"], "12", DEFAULTS), ["eldorado", "playerauctions"]);
  assert.deepEqual(marketsForGame(["eldorado", "playerauctions"], "200", DEFAULTS), ["eldorado"]);
  assert.deepEqual(marketsForGame(null, "12", DEFAULTS), []);
});

test("validatePatch: clearance steps are a list of complete { days, cutPct }", () => {
  assertBad({ pricing: { clearanceSteps: { days: 1, cutPct: 5 } } }, "pricing.clearanceSteps");
  assertBad({ pricing: { clearanceSteps: [5] } }, "pricing.clearanceSteps[0]");
  assertBad({ pricing: { clearanceSteps: [null] } }, "pricing.clearanceSteps[0]");
  assertBad({ pricing: { clearanceSteps: [{ days: 3 }] } }, "pricing.clearanceSteps[0].cutPct");
  assertBad({ pricing: { clearanceSteps: [{ cutPct: 3 }] } }, "pricing.clearanceSteps[0].days");
  assertOk({ pricing: { clearanceSteps: [] } });
});

test("validatePatch: markets may only be eldorado, ggsel and playerauctions, as booleans; GGSel only off", () => {
  assertOk({ markets: { eldorado: true } });
  assertOk({ markets: { eldorado: false, ggsel: false } });
  // PlayerAuctions is a code shop market since 2026-10-18 (06-PLAYERAUCTIONS-PLAN.md C1).
  assertOk({ markets: { playerauctions: true } });
  assertOk({ markets: { playerauctions: false } });
  assertBad({ markets: { playerauctions: "on" } }, "markets.playerauctions");
  const ggsel = errorsOf({ markets: { ggsel: true } });
  assert.deepEqual(ggsel, ["markets.ggsel: " + GGSEL_REFUSED]);
  assert.match(GGSEL_REFUSED, /^GGSel is not used for codes yet: it never reports which code it sold, so a code could be sold twice$/);
  assertBad({ markets: { eldorado: true, ggsel: true } }, "markets.ggsel");
  assertBad({ markets: { ggsel: "true" } }, "markets.ggsel");
  for (const m of ["gameflip", "plati", "digiseller", "g2g", "PlayerAuctions", "Eldorado"]) {
    const errs = errorsOf({ markets: { [m]: true } });
    assert.equal(errs.length, 1);
    assert.match(errs[0], new RegExp("^markets\\." + m + ": only eldorado, ggsel, playerauctions"));
  }
  assertBad({ markets: ["eldorado"] }, "markets");
  assertBad({ markets: "eldorado" }, "markets");
  assertBad({ markets: { eldorado: "yes" } }, "markets.eldorado");
});

test("validatePatch: games keys are game numbers; entries are { sell, marketGame, displayName }", () => {
  assertOk({ games: { "300": { sell: true, marketGame: "X", displayName: "X" } } });
  assertOk({ games: { "12": { sell: false } } });
  assertOk({ games: {} });
  for (const key of ["abc", "12a", "-1", "1.5", " 12", "", "__proto__"]) {
    assertBad({ games: { [key]: { sell: true } } }, "games." + key);
  }
  assertBad({ games: { "12": null } }, "games.12");
  assertBad({ games: { "12": true } }, "games.12");
  assertBad({ games: { "12": { sell: "yes" } } }, "games.12.sell");
  assertBad({ games: { "12": { marketGame: 5 } } }, "games.12.marketGame");
  assertBad({ games: { "12": { displayName: null } } }, "games.12.displayName");
  assertBad({ games: [] }, "games");
  assertBad({ games: null }, "games");
});

test("validatePatch: sourceWords must each be a valid, non-empty pattern", () => {
  assertOk({ sourceWords: ["foo", "\\bbar\\b", "official [^.\\n]*event"] });
  assertOk({ sourceWords: [] });
  assertBad({ sourceWords: ["("] }, "sourceWords[0]");
  assertBad({ sourceWords: ["ok", "[unclosed"] }, "sourceWords[1]");
  assertBad({ sourceWords: ["a{2,1}"] }, "sourceWords[0]");
  assertBad({ sourceWords: [""] }, "sourceWords[0]");
  assertBad({ sourceWords: [5] }, "sourceWords[0]");
  assertBad({ sourceWords: "soop" }, "sourceWords");
  assertBad({ sourceWords: null }, "sourceWords");
});

test("validatePatch: id lists hold non-empty text", () => {
  assertOk({ ownEldoradoUserIds: ["user-1"], farmPriority: { botIds: ["bot-1", "bot-2"] } });
  assertBad({ ownEldoradoUserIds: [123] }, "ownEldoradoUserIds[0]");
  assertBad({ ownEldoradoUserIds: [""] }, "ownEldoradoUserIds[0]");
  assertBad({ ownEldoradoUserIds: "user-1" }, "ownEldoradoUserIds");
  assertBad({ farmPriority: { botIds: [null] } }, "farmPriority.botIds[0]");
});

test("validatePatch: text settings stay text; lastChangeAt is a date or null", () => {
  assertOk({ digest: { lastSentDay: "2026-10-15" } });
  assertBad({ digest: { lastSentDay: 5 } }, "digest.lastSentDay");
  assertBad({ digest: { lastSentDay: null } }, "digest.lastSentDay");

  for (const v of [null, new Date(), 0, Date.now(), "2026-10-15T00:00:00Z"]) assertOk({ farmPriority: { lastChangeAt: v } });
  for (const v of ["not a date", "", true, -1, NaN, new Date("x"), {}]) {
    assertBad({ farmPriority: { lastChangeAt: v } }, "farmPriority.lastChangeAt");
  }
});

test("validatePatch: every problem is reported, not only the first", () => {
  const errs = errorsOf({ nope: 1, autoPublish: "x", markets: { gameflip: true }, digest: { hourUtc: 99 } });
  assert.equal(errs.length, 4);
});

// --- deepMerge ---------------------------------------------------------------

test("deepMerge: objects merge, lists and scalars replace, inputs stay untouched", () => {
  const base = { a: [1, 2], b: { c: 1, d: 2, e: { f: 1 } }, g: "x", h: null };
  const patch = { a: [3], b: { c: 5, e: { z: 2 } }, h: { now: 1 } };
  const baseCopy = JSON.parse(JSON.stringify(base));
  const patchCopy = JSON.parse(JSON.stringify(patch));

  const out = deepMerge(base, patch);
  assert.deepEqual(out, { a: [3], b: { c: 5, d: 2, e: { f: 1, z: 2 } }, g: "x", h: { now: 1 } });
  assert.deepEqual(base, baseCopy);
  assert.deepEqual(patch, patchCopy);
  assert.notEqual(out.a, patch.a);
  assert.notEqual(out.b, base.b);
  assert.notEqual(out.h, patch.h);
});

test("deepMerge: an object replaces a scalar and vice versa; undefined is no change; null replaces", () => {
  assert.deepEqual(deepMerge({ a: 1 }, { a: { b: 2 } }), { a: { b: 2 } });
  assert.deepEqual(deepMerge({ a: { b: 2 } }, { a: 1 }), { a: 1 });
  assert.deepEqual(deepMerge({ a: 1, b: 2 }, { a: undefined }), { a: 1, b: 2 });
  assert.deepEqual(deepMerge({ a: { b: 2 } }, { a: null }), { a: null });
  assert.deepEqual(deepMerge({ a: [1] }, { a: [] }), { a: [] });
});

test("deepMerge: Dates are copied, missing inputs are empty", () => {
  const d = new Date("2026-10-15T00:00:00Z");
  const out = deepMerge({ when: null }, { when: d });
  assert.ok(out.when instanceof Date);
  assert.equal(out.when.getTime(), d.getTime());
  assert.notEqual(out.when, d);

  assert.deepEqual(deepMerge(undefined, undefined), {});
  assert.deepEqual(deepMerge(null, { a: 1 }), { a: 1 });
  assert.deepEqual(deepMerge({ a: 1 }, null), { a: 1 });
  assert.deepEqual(deepMerge(DEFAULTS, {}), DEFAULTS);
});

test("deepMerge: prototype keys never reach Object.prototype", () => {
  const out = deepMerge({}, JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "ok": 1}'));
  assert.deepEqual(out, { ok: 1 });
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
});
