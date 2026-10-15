// Code shop daily digest (utils/codeShop/digest.js, docs/code-shop/04-OPS.md).
//
// What matters:
// - digestText is pure and short: the always-there lines are always there, the
//   "needs you" lines only when non-zero, product lines stop at 5, and the
//   whole message never passes 25 lines whatever it is fed;
// - collectDigest counts what the owner would count: codes earned by when they
//   were stored, sales by soldAt (dead codes were still sales, replacements are
//   not), bundles on sale as distinct available units, expiring as those units
//   with a code ending within 3 days, and logins down as the farm panel's two
//   "cannot farm" statuses;
// - run sends once per UTC day from hourUtc on, force skips the gate, and
//   lastSentDay is written only after Telegram took the message. It never
//   throws.
//
// Real Mongo via mongodb-memory-server for collectDigest; config, events and
// Telegram are fakes. All names, prices and logins are made up.

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const CodeStock = require("../models/CodeStock");
const CodeProduct = require("../models/CodeProduct");
const SoopAccount = require("../models/SoopAccount");
const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
const { digestText, collectDigest, createDigest } = require("../utils/codeShop/digest");

const ObjectId = mongoose.Types.ObjectId;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const MODELS = { CodeStock, CodeProduct, SoopAccount };

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("codeshopdigest"));
  await Promise.all([CodeStock, CodeProduct, SoopAccount].map((m) => m.init()));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

test.beforeEach(async () => {
  await Promise.all([CodeStock, CodeProduct, SoopAccount].map((m) => m.deleteMany({})));
});

// --- fakes -------------------------------------------------------------------

function fakeConfig(patch = {}) {
  const c = {
    value: deepMerge(DEFAULTS, patch),
    sets: [],
    failSet: false,
    async get() {
      return c.value;
    },
    async set(p, opts) {
      if (c.failSet) throw new Error("config write failed");
      c.sets.push({ patch: p, opts });
      c.value = deepMerge(c.value, p);
      return c.value;
    },
  };
  return c;
}

function fakeEvents() {
  const logs = [];
  return { logs, log: async (e) => (logs.push(e), true) };
}

function fakeTelegram({ failures = 0 } = {}) {
  const t = {
    sent: [],
    calls: 0,
    failures,
    async send(message) {
      t.calls += 1;
      if (t.failures > 0) {
        t.failures -= 1;
        throw new Error("nothing was sent");
      }
      t.sent.push(message);
    },
  };
  return t;
}

function digestWith({ cfg = {}, telegram = fakeTelegram(), now = () => NOW, models = MODELS } = {}) {
  const config = fakeConfig(cfg);
  const events = fakeEvents();
  const digest = createDigest({ models, config, events, telegram, now });
  return { digest, config, events, telegram };
}

// --- digestText --------------------------------------------------------------

const FULL = {
  day: "2026-10-15",
  earned: [
    { game: "Overwatch 2", n: 8 },
    { game: "Delta Force", n: 4 },
  ],
  sold: {
    units: 3,
    usd: 4.5,
    byProduct: [
      { name: "Sun Tea set", units: 2, usd: 3 },
      { name: "Weapon pack", units: 1, usd: 1.5 },
    ],
  },
  onSale: { units: 10, products: 2 },
  expiring: [{ name: "Sun Tea set", units: 4, useBy: new Date(Date.UTC(2026, 9, 17, 14, 0)) }],
  drafts: 2,
  held: 1,
  loginsDown: 3,
  inStock: 25,
};

test("digestText: every line when everything is non-zero", () => {
  assert.deepEqual(digestText(FULL).split("\n"), [
    "Code shop - 2026-10-15",
    "Earned (24 h): 12 codes (Overwatch 2: 8, Delta Force: 4)",
    "Sold (24 h): 3 bundles, $4.50",
    "  - Sun Tea set: 2 bundles, $3.00",
    "  - Weapon pack: 1 bundle, $1.50",
    "On sale: 10 bundles in 2 products",
    "Expiring within 3 days: 4 bundles",
    "  - Sun Tea set: 4 bundles, first by 2026-10-17 14:00 UTC",
    "Drafts waiting for you: 2",
    "Held for checking: 1",
    "Farm logins down: 3",
    "Free codes not in any bundle: 25",
  ]);
});

test("digestText: optional lines are left out at zero, the rest stay", () => {
  const lines = digestText({
    day: "2026-10-15",
    earned: [],
    sold: { units: 0, usd: 0, byProduct: [] },
    onSale: { units: 0, products: 0 },
    expiring: [],
    drafts: 0,
    held: 0,
    loginsDown: 0,
    inStock: 0,
  }).split("\n");
  assert.deepEqual(lines, [
    "Code shop - 2026-10-15",
    "Earned (24 h): 0 codes",
    "Sold (24 h): 0 bundles, $0.00",
    "On sale: 0 bundles in 0 products",
    "Free codes not in any bundle: 0",
  ]);
});

test("digestText: each optional line appears on its own", () => {
  const base = { day: "d", earned: [], sold: {}, onSale: {}, expiring: [], inStock: 1 };
  assert.match(digestText({ ...base, drafts: 1 }), /^Drafts waiting for you: 1$/m);
  assert.doesNotMatch(digestText({ ...base, drafts: 1 }), /Held|logins down|Expiring/);
  assert.match(digestText({ ...base, held: 4 }), /^Held for checking: 4$/m);
  assert.doesNotMatch(digestText({ ...base, held: 4 }), /Drafts|logins down|Expiring/);
  assert.match(digestText({ ...base, loginsDown: 2 }), /^Farm logins down: 2$/m);
  assert.doesNotMatch(digestText({ ...base, loginsDown: 2 }), /Drafts|Held|Expiring/);
  // An expiring entry with no units is no expiring line.
  assert.doesNotMatch(digestText({ ...base, expiring: [{ name: "x", units: 0, useBy: new Date() }] }), /Expiring/);
});

test("digestText: product lines stop at 5 and the message stays within 25 lines", () => {
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const d = {
    day: "2026-10-15",
    earned: many(20, (i) => ({ game: "Game " + i, n: 1 })),
    sold: { units: 20, usd: 20, byProduct: many(20, (i) => ({ name: "Product " + i, units: 1, usd: 1 })) },
    onSale: { units: 50, products: 20 },
    expiring: many(20, (i) => ({ name: "Product " + i, units: 1, useBy: new Date(NOW + i * HOUR) })),
    drafts: 9,
    held: 9,
    loginsDown: 9,
    inStock: 9,
  };
  const lines = digestText(d).split("\n");
  assert.ok(lines.length <= 25, `${lines.length} lines`);
  const soldAt = lines.findIndex((l) => l.startsWith("Sold (24 h)"));
  const onSaleAt = lines.findIndex((l) => l.startsWith("On sale"));
  const soldBlock = lines.slice(soldAt + 1, onSaleAt);
  assert.equal(soldBlock.filter((l) => l.startsWith("  - ")).length, 5);
  assert.equal(soldBlock[5], "  + 15 more");
  const expAt = lines.findIndex((l) => l.startsWith("Expiring"));
  assert.equal(lines.slice(expAt + 1).filter((l) => l.startsWith("  - ")).length, 5);
  // The earned line names at most five games.
  assert.match(lines[1], /^Earned \(24 h\): 20 codes \(Game 0: 1, .*Game 4: 1, \+15 more\)$/);
  // Every line the contract promises is still there at the end.
  assert.equal(lines[lines.length - 1], "Free codes not in any bundle: 9");
});

test("digestText: names cannot break a line", () => {
  const out = digestText({
    ...FULL,
    sold: { units: 1, usd: 1, byProduct: [{ name: "Two\nlines", units: 1, usd: 1 }] },
  });
  assert.match(out, /^ {2}- Two lines: 1 bundle, \$1\.00$/m);
});

// --- collectDigest -------------------------------------------------------------

let seq = 0;
function row(fields = {}) {
  seq += 1;
  return {
    loginId: "login-" + (seq % 4),
    itemKey: "item-" + seq,
    gameNo: "12",
    gameName: "Overwatch",
    createdAt: new Date(NOW - 5 * DAY),
    ...fields,
  };
}

test("collectDigest counts realistic ledger rows", async () => {
  const p1 = await CodeProduct.create({ name: "Sun Tea set", status: "active", gameNo: "12" });
  const p2 = await CodeProduct.create({ name: "Weapon pack", status: "active", gameNo: "200" });
  const p3 = await CodeProduct.create({ name: "Old set", status: "retired", gameNo: "12" });
  await CodeProduct.create({ name: "Draft one", status: "draft" });
  await CodeProduct.create({ name: "Draft two", status: "draft", edited: true });
  await CodeProduct.create({ name: "Draft dropped by the planner", status: "draft", stale: true });

  const [u1, u2, u3, u4, u5, u6, u7] = Array.from({ length: 7 }, () => new ObjectId());
  await CodeStock.insertMany([
    // earned within 24 h (by createdAt): 3 Overwatch, 2 Delta Force; one old row
    row({ state: "in_stock", createdAt: new Date(NOW - 2 * HOUR) }),
    row({ state: "in_stock", createdAt: new Date(NOW - 23 * HOUR) }),
    row({ state: "in_unit", unit: u3, product: p1._id, unitStatus: "available", createdAt: new Date(NOW - HOUR), useBy: new Date(NOW + 2 * DAY) }),
    row({ gameNo: "200", gameName: "DF", state: "in_stock", createdAt: new Date(NOW - 3 * HOUR) }),
    row({ gameNo: "200", gameName: "DF", state: "held", problem: "duplicate code", createdAt: new Date(NOW - 4 * HOUR) }),
    row({ state: "in_stock", createdAt: new Date(NOW - 25 * HOUR) }),

    // sold within 24 h: unit u1 (2 codes) on p1, unit u2 (1 dead code) on p2
    row({ state: "sold", unit: u1, product: p1._id, soldAt: new Date(NOW - 2 * HOUR), saleUsd: 0.75, market: "eldorado" }),
    row({ state: "sold", unit: u1, product: p1._id, soldAt: new Date(NOW - 2 * HOUR), saleUsd: 0.75, market: "eldorado" }),
    row({ gameNo: "200", state: "dead", unit: u2, product: p2._id, soldAt: new Date(NOW - 5 * HOUR), saleUsd: 1.2, market: "eldorado" }),
    // sold 30 h ago: not in the last 24 h
    row({ state: "sold", unit: u7, product: p3._id, soldAt: new Date(NOW - 30 * HOUR), saleUsd: 9, market: "eldorado" }),
    // a replacement code given after a dead one is not a sale
    row({ state: "sold", soldAt: new Date(NOW - HOUR), market: "replacement", saleUsd: 0 }),

    // on sale: u3 (2 codes, one ending in 2 days), u4 (2 codes, one ending exactly
    // 3 days out: still inside) on p1; u5 on p2 (5 days out)
    row({ state: "in_unit", unit: u3, product: p1._id, unitStatus: "available", useBy: new Date(NOW + 6 * DAY) }),
    row({ state: "in_unit", unit: u4, product: p1._id, unitStatus: "available", useBy: new Date(NOW + 3 * DAY) }),
    row({ state: "in_unit", unit: u4, product: p1._id, unitStatus: "available", useBy: new Date(NOW + 9 * DAY) }),
    row({ gameNo: "200", state: "in_unit", unit: u5, product: p2._id, unitStatus: "available", useBy: new Date(NOW + 5 * DAY) }),
    // in a platform vault, not on sale by us
    row({ state: "in_unit", unit: u6, product: p2._id, unitStatus: "fed", useBy: new Date(NOW + DAY) }),

    // held + free
    row({ state: "held", problem: "missing unit" }),
    row({ state: "in_stock" }),
    row({ state: "expiring" }),
    row({ state: "expired" }),
  ]);

  await SoopAccount.insertMany([
    { loginId: "acc-ok", status: "ok" },
    { loginId: "acc-dead", status: "not_logged_in" },
    { loginId: "acc-refused", status: "drops_rejected" },
    { loginId: "acc-untested", status: "untested" },
    { loginId: "acc-sold-dead", status: "not_logged_in", sold: true },
  ]);

  const config = fakeConfig();
  const d = await collectDigest({ models: MODELS, config }, NOW);

  assert.equal(d.day, "2026-10-15");
  // display names come from config.games
  assert.deepEqual(d.earned, [
    { game: "Overwatch 2", n: 3 },
    { game: "Delta Force", n: 2 },
  ]);
  assert.equal(d.sold.units, 2);
  assert.equal(d.sold.usd, 2.7);
  assert.deepEqual(d.sold.byProduct, [
    { name: "Sun Tea set", units: 1, usd: 1.5 },
    { name: "Weapon pack", units: 1, usd: 1.2 },
  ]);
  assert.deepEqual(d.onSale, { units: 3, products: 2 });
  assert.deepEqual(d.expiring, [{ name: "Sun Tea set", units: 2, useBy: new Date(NOW + 2 * DAY) }]);
  assert.equal(d.drafts, 2);
  assert.equal(d.held, 2);
  assert.equal(d.loginsDown, 2);
  assert.equal(d.inStock, 5);

  // and it reads as a digest
  const lines = digestText(d).split("\n");
  assert.ok(lines.includes("Sold (24 h): 2 bundles, $2.70"));
  assert.ok(lines.includes("On sale: 3 bundles in 2 products"));
  assert.ok(lines.includes("Expiring within 3 days: 2 bundles"));
  assert.ok(lines.includes("Farm logins down: 2"));
});

test("collectDigest on an empty database: zeros, no throw", async () => {
  const d = await collectDigest({ models: MODELS, config: fakeConfig() }, NOW);
  assert.deepEqual(d, {
    day: "2026-10-15",
    earned: [],
    sold: { units: 0, usd: 0, byProduct: [] },
    onSale: { units: 0, products: 0 },
    expiring: [],
    drafts: 0,
    held: 0,
    loginsDown: 0,
    inStock: 0,
  });
});

test("collectDigest: a game the config does not name keeps its farm name", async () => {
  await CodeStock.insertMany([row({ gameNo: "999", gameName: "Some Game", createdAt: new Date(NOW - HOUR) })]);
  const d = await collectDigest({ models: MODELS, config: fakeConfig() }, NOW);
  assert.deepEqual(d.earned, [{ game: "Some Game", n: 1 }]);
});

// --- run ---------------------------------------------------------------------

const at = (h, m = 0, day = 15) => Date.UTC(2026, 9, day, h, m, 0);

test("run waits for hourUtc, sends once that day, and writes lastSentDay after the send", async () => {
  let clock = at(2, 59);
  const { digest, config, telegram } = digestWith({ now: () => clock });

  assert.deepEqual(await digest.run(), { sent: false });
  assert.equal(telegram.calls, 0);

  clock = at(3, 0);
  const r = await digest.run();
  assert.equal(r.sent, true);
  assert.equal(telegram.sent.length, 1);
  assert.equal(r.text, telegram.sent[0]);
  assert.match(r.text, /^Code shop - 2026-10-15\n/);
  assert.deepEqual(config.sets, [{ patch: { digest: { lastSentDay: "2026-10-15" } }, opts: { actor: "digest" } }]);

  clock = at(18, 0);
  assert.deepEqual(await digest.run(), { sent: false });
  assert.equal(telegram.sent.length, 1);

  // next day, before the hour: nothing; at the hour: sent again
  clock = at(1, 0, 16);
  assert.deepEqual(await digest.run(), { sent: false });
  clock = at(4, 0, 16);
  assert.equal((await digest.run()).sent, true);
  assert.equal(telegram.sent.length, 2);
  assert.equal(config.value.digest.lastSentDay, "2026-10-16");
});

test("run respects lastSentDay already set today; force sends anyway", async () => {
  const { digest, config, telegram } = digestWith({ cfg: { digest: { lastSentDay: "2026-10-15" } } });
  assert.deepEqual(await digest.run(), { sent: false });
  assert.equal(telegram.calls, 0);
  const r = await digest.run({ force: true });
  assert.equal(r.sent, true);
  assert.equal(telegram.sent.length, 1);
  assert.equal(config.sets.length, 1);
});

test("force overrides the hour and the off switch", async () => {
  const { digest, telegram } = digestWith({ cfg: { digest: { enabled: false, hourUtc: 23 } } });
  assert.deepEqual(await digest.run(), { sent: false });
  assert.equal((await digest.run({ force: true })).sent, true);
  assert.equal(telegram.sent.length, 1);
});

test("disabled: nothing is sent and nothing written", async () => {
  const { digest, config, telegram } = digestWith({ cfg: { digest: { enabled: false } } });
  assert.deepEqual(await digest.run(), { sent: false });
  assert.equal(telegram.calls, 0);
  assert.equal(config.sets.length, 0);
});

test("a failed send leaves lastSentDay alone, logs a warning, and the next run retries", async () => {
  const telegram = fakeTelegram({ failures: 1 });
  const { digest, config, events } = digestWith({ telegram });

  const r = await digest.run();
  assert.equal(r.sent, false);
  assert.match(r.text, /^Code shop - /);
  assert.equal(config.sets.length, 0);
  assert.equal(config.value.digest.lastSentDay, "");
  const warn = events.logs.find((e) => e.level === "warn" && e.kind === "digest");
  assert.ok(warn);
  assert.match(warn.msg, /nothing was sent/);

  assert.equal((await digest.run()).sent, true);
  assert.equal(telegram.sent.length, 1);
  assert.equal(config.value.digest.lastSentDay, "2026-10-15");
});

test("no Telegram sender: not sent, not marked", async () => {
  const config = fakeConfig();
  const digest = createDigest({ models: MODELS, config, events: fakeEvents(), now: () => NOW });
  assert.equal((await digest.run()).sent, false);
  assert.equal(config.sets.length, 0);
});

test("a database error never throws out of run and sends nothing", async () => {
  const broken = {
    ...MODELS,
    CodeStock: {
      find: () => {
        throw new Error("db down");
      },
      countDocuments: async () => {
        throw new Error("db down");
      },
    },
  };
  const { digest, config, events, telegram } = digestWith({ models: broken });
  assert.deepEqual(await digest.run(), { sent: false });
  assert.equal(telegram.calls, 0);
  assert.equal(config.sets.length, 0);
  assert.ok(events.logs.some((e) => e.level === "error" && /db down/.test(e.msg)));
});

test("a failed lastSentDay write after a good send still reports sent, without throwing", async () => {
  const { digest, config, events, telegram } = digestWith();
  config.failSet = true;
  const r = await digest.run();
  assert.equal(r.sent, true);
  assert.equal(telegram.sent.length, 1);
  assert.ok(events.logs.some((e) => e.level === "warn" && /day was not saved/.test(e.msg)));
});

test("a config that throws on get falls back to the defaults (sends from 03:00 UTC)", async () => {
  const telegram = fakeTelegram();
  const config = {
    get: async () => {
      throw new Error("boom");
    },
    set: async () => ({}),
  };
  const digest = createDigest({ models: MODELS, config, events: fakeEvents(), telegram, now: () => at(2) });
  assert.deepEqual(await digest.run(), { sent: false });
  const later = createDigest({ models: MODELS, config, events: fakeEvents(), telegram, now: () => at(3) });
  assert.equal((await later.run()).sent, true);
});
