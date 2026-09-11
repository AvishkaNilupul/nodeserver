// No-claim Shop listings (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §5): the
// auto-lister's side of the new ledger status "manual" — an account committed
// to an owner's hand-made no-claim listing. The auto-lister must skip it like
// "listed", keep the owner's listed flag while it exists, sell it like
// "listed", count it in the archive rollup, and hand a manual-sold tick over
// to utils/noclaimListings.js. Without opts.label, spendAccount's strings must
// stay byte-identical to the auto-lister's.
//
// No Mongo, no Pi, no Twitch, no network: every require the ENGINE makes for
// models, hosts, inventory, marketplaces, telegram and its lazily-loaded
// siblings is stubbed through Module._load, so this drives the real control
// flow in utils/unclaimedAutoList.js.
process.env.CRED_SECRET ||= "test-secret";

const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

const ENGINE = require.resolve("../utils/unclaimedAutoList");

// --- a tiny in-memory Mongo --------------------------------------------------

// Just enough of the query language for the filters the engine sends here:
// equality, $in, $ne, $or, RegExp. A missing field reads as null (Mongo's rule
// for `$in: [null]`). Anything else throws so a gap can never pass silently.
function valueAt(doc, key) {
  return key.split(".").reduce((v, k) => (v == null ? undefined : v[k]), doc);
}
function matchOne(have, want) {
  const h = have === undefined ? null : have;
  if (want instanceof RegExp) return want.test(String(h == null ? "" : h));
  if (want && typeof want === "object" && !Array.isArray(want) && !(want instanceof Date)) {
    return Object.entries(want).every(([op, v]) => {
      if (op === "$in") return v.some((x) => matchOne(h, x));
      if (op === "$ne") return !matchOne(h, v);
      throw new Error("fake model: unsupported operator " + op);
    });
  }
  if (want === null) return h === null;
  if (Array.isArray(h)) return h.some((x) => String(x) === String(want));
  return String(h) === String(want);
}
function matches(doc, q) {
  return Object.entries(q || {}).every(([k, v]) =>
    k === "$or" ? v.some((sub) => matches(doc, sub)) : matchOne(valueAt(doc, k), v),
  );
}

// A mongoose Query stand-in: awaitable, with the chain the engine uses.
function query(run) {
  const q = {
    lean: () => Promise.resolve().then(run),
    sort: () => q,
    limit: () => q,
    select: () => q,
    then: (ok, fail) => Promise.resolve().then(run).then(ok, fail),
  };
  return q;
}

// Minimal model: reads filter `rows` with the matcher; updateOne applies $set
// to the first match (a guarded write that misses changes nothing); create
// hands back the doc without persisting it.
function fakeModel(name, rows = []) {
  const calls = {
    find: [],
    findOne: [],
    exists: [],
    countDocuments: [],
    distinct: [],
    updateOne: [],
    bulkWrite: [],
    create: [],
  };
  const pick = (q) => rows.filter((r) => matches(r, q));
  return {
    rows,
    calls,
    find(q) {
      calls.find.push(q);
      return query(() => pick(q).map((r) => ({ ...r })));
    },
    findOne(q) {
      calls.findOne.push(q);
      return query(() => {
        const r = pick(q)[0];
        return r ? { ...r } : null;
      });
    },
    findById(id) {
      return query(() => {
        const r = rows.find((x) => String(x._id) === String(id));
        return r ? { ...r } : null;
      });
    },
    async exists(q) {
      calls.exists.push(q);
      const r = pick(q)[0];
      return r ? { _id: r._id } : null;
    },
    async countDocuments(q) {
      calls.countDocuments.push(q);
      return pick(q).length;
    },
    async distinct(field, q) {
      calls.distinct.push({ field, q });
      return [...new Set(pick(q).map((r) => r[field]))];
    },
    async updateOne(q, u, o) {
      calls.updateOne.push({ q, u, o });
      const r = pick(q)[0];
      if (r && u && u.$set) Object.assign(r, u.$set);
      return { matchedCount: r ? 1 : 0, modifiedCount: r ? 1 : 0 };
    },
    async bulkWrite(ops) {
      calls.bulkWrite.push(ops);
      return { ok: 1 };
    },
    async create(doc) {
      calls.create.push(doc);
      return { _id: name + "-" + calls.create.length, ...doc };
    },
  };
}

// --- fixtures ----------------------------------------------------------------

// The Pi's one no-claim bot: bot 3, farming "Test Game Zeta" (a game with no
// per-game settings, so markets / caps / floors are the engine defaults).
const BOT_CONFIG_PATH = "/home/avishka/twitchbot-noclaim/bots/3/Configuration/config.json";
function botConfig(logins) {
  const ids = { alpha: "1001", bravo: "1002" };
  return {
    FavouriteGames: ["Test Game Zeta"],
    TwitchSettings: {
      TwitchUsers: logins.map((l) => ({ Login: l, Id: ids[l], ClientSecret: "cs-" + l })),
    },
  };
}

// alpha's pool row. A plain (legacy, unencrypted) password reads as-is.
const poolAlpha = () => ({
  _id: "pool-alpha",
  clientSecret: "cs-alpha",
  password: "pw-alpha",
  status: "claimed",
  manualSold: false,
  soldGames: [],
});

// One sellable drop, ready (100%, unclaimed) — what a buyer would claim.
const READY_INV = {
  login: "alpha",
  inProgress: [
    {
      name: "Zeta Charm",
      game: "Test Game Zeta",
      campaign: "Zeta Wave 1",
      percent: 100,
      claimed: false,
    },
  ],
};

// alpha's no-claim ledger. No `set`, so spendAccount has no row to scrub.
function ledgerRow(status, extra = {}) {
  return {
    _id: "L1",
    source: "noclaim",
    login: "alpha",
    loginLower: "alpha",
    twitchId: "1001",
    game: "Test Game Zeta",
    botId: "3",
    container: "noclaim-bot-3",
    poolAccountId: "pool-alpha",
    market: "ggsel",
    status,
    ...extra,
  };
}

// --- the stubbed engine ------------------------------------------------------

// Only requires made BY THE ENGINE are intercepted (its siblings keep their
// real dependencies), against whichever test environment is current. Tests
// in a file run one at a time, so one `current` is enough.
let current = null;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (current && parent && parent.filename === ENGINE) {
    const stub = current.resolve(request, parent, isMain);
    if (stub !== undefined) return stub;
  }
  return origLoad.apply(this, arguments);
};
test.after(() => {
  Module._load = origLoad;
});

// The run lock lives in a raw collection: this one always grants it.
const fakeMongoose = {
  connection: {
    db: {
      collection: () => ({
        updateOne: async () => ({}),
        findOneAndUpdate: async () => ({ holder: String(process.pid) }),
        deleteOne: async () => ({}),
      }),
    },
  },
};

function loadEngine(opts = {}) {
  const env = {
    models: {
      UnclaimedAccount: fakeModel("UnclaimedAccount", opts.ledgers || []),
      AvailableAccount: fakeModel("AvailableAccount", opts.pool || []),
      MarketplaceListing: fakeModel("MarketplaceListing", []),
      DropSet: fakeModel("DropSet", []),
      BotAccount: fakeModel("BotAccount", []),
      MarketResearch: fakeModel("MarketResearch", []),
      NoclaimSpentAccount: fakeModel("NoclaimSpentAccount", []),
      TwitchCampaign: fakeModel("TwitchCampaign", []),
    },
    config: opts.config || botConfig(["alpha"]),
    inventory: READY_INV,
    onInventory: null,
    events: [],
    telegrams: [],
    usage: [],
    shell: [],
    inventoryReads: [],
    // Lazily-required ./noclaimListings: what the engine asked for, the calls
    // it made, and what the stub answers (an Error here = the require throws).
    requested: [],
    removeCalls: [],
    removeResult: { units: 0, rows: 0, errors: [] },
    removeThrows: null,
    noclaimListings: null,
  };
  env.noclaimListings = {
    async removeForPoolAccount(poolAccountId, o) {
      env.removeCalls.push([poolAccountId, o]);
      if (env.removeThrows) throw env.removeThrows;
      return env.removeResult;
    },
  };
  const hosts = {
    resolveHost: () => ({ id: "pi" }),
    shq: (s) => "'" + String(s) + "'",
    async runShell(host, script, o = {}) {
      env.shell.push({ script, input: o.input });
      if (script.startsWith("ls -1d ")) return { stdout: BOT_CONFIG_PATH + "\n" };
      if (script.startsWith("[ -f ")) return { stdout: JSON.stringify(env.config) };
      return { stdout: "" }; // config write, docker restart / stop
    },
    async readFiles(host, paths) {
      const out = {};
      for (const p of paths) out[p] = { ok: true, text: JSON.stringify(env.config) };
      return out;
    },
  };
  env.mp = { ggselResolveCategoryId: async () => "", ...(opts.mp || {}) };
  const m = env.models;
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), m.UnclaimedAccount],
    [require.resolve("../models/AvailableAccount"), m.AvailableAccount],
    [require.resolve("../models/MarketplaceListing"), m.MarketplaceListing],
    [require.resolve("../models/DropSet"), m.DropSet],
    [require.resolve("../models/BotAccount"), m.BotAccount],
    [require.resolve("../models/MarketResearch"), m.MarketResearch],
    [require.resolve("../models/NoclaimSpentAccount"), m.NoclaimSpentAccount],
    [require.resolve("../models/TwitchCampaign"), m.TwitchCampaign],
    [
      require.resolve("../utils/systemLog"),
      { logEvent: (e) => env.events.push(e), actorFromReq: () => "test" },
    ],
    [require.resolve("../utils/telegram"), { sendTelegram: async (t) => env.telegrams.push(t) }],
    [
      require.resolve("../utils/poolUsageLog"),
      { recordPoolUsage: async (ids, entry) => env.usage.push({ ids, entry }) },
    ],
    [require.resolve("../utils/botHosts"), hosts],
    [
      require.resolve("../utils/twitchInventory"),
      {
        async fetchInventory(clientSecret) {
          env.inventoryReads.push(clientSecret);
          if (env.onInventory) env.onInventory(clientSecret);
          return JSON.parse(JSON.stringify(env.inventory));
        },
      },
    ],
    // Only what a scan pass reaches before a publish; any other call throws
    // (a test that drives a publish passes its own calls in opts.mp).
    [require.resolve("../utils/marketplaces"), env.mp],
    [require.resolve("../utils/setImage"), { buildSetGridImage: async () => "" }],
    // v3 siblings absent: v2 behaviour (no catalog, fallback pricing, no lots).
    [require.resolve("../utils/unclaimedBundles"), {}],
    [require.resolve("../utils/unclaimedLots"), {}],
  ]);
  current = {
    resolve(request, parent, isMain) {
      if (request === "./noclaimListings") {
        env.requested.push(request);
        if (env.noclaimListings instanceof Error) throw env.noclaimListings;
        return env.noclaimListings;
      }
      if (request === "mongoose") return fakeMongoose;
      let file;
      try {
        file = Module._resolveFilename(request, parent, isMain);
      } catch {
        return undefined;
      }
      return stubs.get(file);
    },
  };
  delete require.cache[ENGINE];
  env.engine = require("../utils/unclaimedAutoList");
  return env;
}

// One scan pass through the public entry point (no expiry/sale pass).
async function runScan(env) {
  const r = await env.engine.runOnce({ check: false });
  assert.ok(r && r.scan, "the scan pass ran: " + JSON.stringify(r));
  return r.scan;
}

// Run with console.error captured (the engine logs every caught failure).
async function quiet(fn) {
  const orig = console.error;
  const lines = [];
  console.error = (...a) => lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.error = orig;
  }
}

const manualLedger = () =>
  ledgerRow("manual", { _id: "L-manual", manualListing: "row-9" });

// --- 1-3. scanAndListPass ----------------------------------------------------

test("scan: an account on an owner's no-claim listing is never even inventory-read", async () => {
  const env = loadEngine({ pool: [poolAlpha()], ledgers: [manualLedger()] });
  const scan = await runScan(env);

  const snapshot = env.models.UnclaimedAccount.calls.find.find(
    (q) => q.status && q.status.$in && q.status.$in.includes("sold"),
  );
  assert.ok(snapshot, "the pass takes its committed-ledger snapshot");
  for (const s of ["listed", "sold", "removed", "manual"]) {
    assert.ok(snapshot.status.$in.includes(s), s + " must be a skip status");
  }
  assert.strictEqual(env.inventoryReads.length, 0, "no Twitch read for a committed account");
  assert.strictEqual(scan.candidates, 0);
  assert.strictEqual(scan.listed, 0);
});

test("scan: a ledger that turns manual mid-pass stops the account before any set work", async () => {
  const env = loadEngine({ pool: [poolAlpha()] });
  // The owner's listing claims alpha while this pass reads its inventory —
  // after the pass's snapshot, before the per-account ledger re-read.
  env.onInventory = () => env.models.UnclaimedAccount.rows.push(manualLedger());
  const scan = await runScan(env);

  assert.strictEqual(env.inventoryReads.length, 1, "alpha was a candidate");
  assert.strictEqual(scan.listed, 0);
  assert.deepStrictEqual(scan.skipped, [], "a manual ledger is a quiet skip, not an error");
  assert.strictEqual(env.models.MarketResearch.calls.findOne.length, 0, "no pricing work");
  assert.strictEqual(env.models.DropSet.calls.find.length, 0, "no set lookup");
  assert.strictEqual(env.models.DropSet.calls.create.length, 0, "no set created");
});

test("scan: the under-lock re-check refuses a login an owner's listing just took", async () => {
  const env = loadEngine({ pool: [poolAlpha()] });
  // Claimed by the manual layer while this pass was pricing the set, i.e.
  // after the per-account check — only the re-check under the lock sees it.
  env.models.MarketResearch.findOne = () => {
    env.models.UnclaimedAccount.rows.push(manualLedger());
    return query(() => null);
  };
  const scan = await runScan(env);

  assert.deepStrictEqual(scan.skipped, [
    { login: "alpha", error: "already listed elsewhere — skipped" },
  ]);
  assert.strictEqual(scan.listed, 0);
  const probe = env.models.UnclaimedAccount.calls.exists.find((q) => q.loginLower === "alpha");
  assert.deepStrictEqual(probe, { loginLower: "alpha", status: { $in: ["listed", "manual"] } });
  assert.strictEqual(env.models.UnclaimedAccount.calls.updateOne.length, 0, "never ledgered");
});

// --- 4. markOwnerUnlisted ----------------------------------------------------

test("markOwnerUnlisted: a manual ledger still holds the account, so the flag stays", async () => {
  const env = loadEngine({
    ledgers: [manualLedger()],
    pool: [{ ...poolAlpha(), listed: true }],
  });
  await env.engine.markOwnerUnlisted(ledgerRow("expired")); // the ledger that just left
  assert.deepStrictEqual(env.models.UnclaimedAccount.calls.exists, [
    { poolAccountId: "pool-alpha", status: { $in: ["listed", "manual"] } },
  ]);
  assert.strictEqual(env.models.AvailableAccount.calls.updateOne.length, 0);
});

test("markOwnerUnlisted: no listed or manual ledger left clears the flag", async () => {
  const env = loadEngine({
    ledgers: [ledgerRow("sold")],
    pool: [{ ...poolAlpha(), listed: true }],
  });
  await env.engine.markOwnerUnlisted(ledgerRow("sold"));
  const writes = env.models.AvailableAccount.calls.updateOne;
  assert.strictEqual(writes.length, 1);
  assert.deepStrictEqual(writes[0].q, { _id: "pool-alpha", listed: { $ne: false } });
  assert.deepStrictEqual(writes[0].u, { $set: { listed: false } });
  assert.strictEqual(env.models.AvailableAccount.rows[0].listed, false);
});

// --- 5. spendAccount ---------------------------------------------------------

test("spendAccount: without a label every string is the auto-lister's, byte for byte", async () => {
  const env = loadEngine({
    config: botConfig(["alpha", "bravo"]),
    pool: [poolAlpha()],
    ledgers: [ledgerRow("listed")],
  });
  await env.engine.spendAccount(ledgerRow("listed"), "buyer claimed");

  // The account really left the bot before its pool row was stamped.
  const write = env.shell.find((s) => s.script.startsWith("cat > "));
  const kept = JSON.parse(write.input).TwitchSettings.TwitchUsers.map((u) => u.Login);
  assert.deepStrictEqual(kept, ["bravo"]);

  const stamp = env.models.AvailableAccount.calls.bulkWrite[0][0].updateOne;
  assert.deepStrictEqual(stamp.filter, { _id: "pool-alpha", status: "claimed" });
  assert.strictEqual(stamp.update.$set.claimedNote, "spent — unclaimed auto-listed (buyer claimed)");
  assert.strictEqual(env.usage[0].entry.note, "spent — unclaimed auto-listed (buyer claimed)");
  assert.strictEqual(
    env.models.NoclaimSpentAccount.calls.updateOne[0].u.$set.soldWhy,
    "unclaimed auto-list: buyer claimed",
  );
  assert.deepStrictEqual(env.telegrams, [
    "💰 SOLD (unclaimed auto-list)\n\nalpha\nGame: Test Game Zeta\nSource: noclaim\nReason: buyer claimed",
  ]);
  assert.strictEqual(env.models.UnclaimedAccount.rows[0].status, "sold");
});

test("spendAccount: opts.label names the owner's listing, and a manual ledger is sold", async () => {
  const env = loadEngine({
    config: botConfig(["alpha", "bravo"]),
    pool: [poolAlpha()],
    ledgers: [ledgerRow("manual", { manualListing: "row-9" })],
  });
  await env.engine.spendAccount(ledgerRow("manual", { manualListing: "row-9" }), "gameflip sale", {
    label: "manual no-claim listing",
    removeFromProduct: false,
    priceUsd: 2.5,
    market: "gameflip",
  });

  const stamp = env.models.AvailableAccount.calls.bulkWrite[0][0].updateOne;
  assert.strictEqual(stamp.update.$set.claimedNote, "spent — manual no-claim listing (gameflip sale)");
  assert.strictEqual(env.usage[0].entry.note, "spent — manual no-claim listing (gameflip sale)");
  assert.strictEqual(
    env.models.NoclaimSpentAccount.calls.updateOne[0].u.$set.soldWhy,
    "manual no-claim listing: gameflip sale",
  );
  assert.deepStrictEqual(env.telegrams, [
    "💰 SOLD (manual no-claim listing)\n\nalpha\nGame: Test Game Zeta\nSource: noclaim\nReason: gameflip sale",
  ]);

  const flip = env.models.UnclaimedAccount.calls.updateOne.find(
    (w) => w.u.$set && w.u.$set.status === "sold",
  );
  assert.deepStrictEqual(flip.q, { _id: "L1", status: { $in: ["listed", "manual"] } });
  const ledger = env.models.UnclaimedAccount.rows[0];
  assert.strictEqual(ledger.status, "sold");
  assert.strictEqual(ledger.soldPriceUsd, 2.5);
  assert.strictEqual(ledger.soldMarket, "gameflip");
  // Its last committed ledger is gone, so the owner's listed flag is cleared.
  assert.strictEqual(env.models.AvailableAccount.rows[0].listed, false);
});

test("spendAccount: a ledger that is already sold keeps the sale record it has", async () => {
  // noclaimStock.markSold flips claim-at-sale ledgers straight to "sold";
  // spendPending then runs the bookkeeping, which must not rewrite the sale.
  const sold = ledgerRow("sold", { note: "eldorado order E-1", soldMarket: "eldorado" });
  const env = loadEngine({ pool: [poolAlpha()], ledgers: [sold] });
  await env.engine.spendAccount({ ...sold }, "manual listing sale", {
    label: "manual no-claim listing",
    removeFromProduct: false,
  });
  const ledger = env.models.UnclaimedAccount.rows[0];
  assert.strictEqual(ledger.note, "eldorado order E-1");
  assert.strictEqual(ledger.soldMarket, "eldorado");
});

// --- 6. archive rollup -------------------------------------------------------

test("archive rollup: a manual account counts under manual, never NaN", () => {
  const env = loadEngine();
  const zeta = { name: "Zeta Charm", itemKey: "zeta charm|test game zeta" };
  const other = { name: "Other Thing", itemKey: "other thing|other game" };
  const rows = [
    { _id: "a1", source: "noclaim", game: "Test Game Zeta", status: "manual", drops: [zeta] },
    { _id: "a2", source: "noclaim", game: "Test Game Zeta", status: "listed", drops: [zeta] },
    { _id: "a3", source: "noclaim", game: "Other Game", status: "sold", drops: [other] },
  ];
  const finite = (byStatus) => {
    for (const [k, v] of Object.entries(byStatus)) assert.ok(Number.isFinite(v), k + " = " + v);
  };

  const items = env.engine.groupArchiveByItem(rows, true);
  const zi = items.find((i) => i.itemKey === zeta.itemKey);
  assert.strictEqual(zi.byStatus.manual, 1);
  assert.strictEqual(zi.byStatus.listed, 1);
  // Every rollup starts from the zero map, which now carries manual: 0.
  assert.strictEqual(items.find((i) => i.itemKey === other.itemKey).byStatus.manual, 0);
  items.forEach((i) => finite(i.byStatus));

  const games = env.engine.groupArchiveByGame(rows, true);
  assert.strictEqual(games.find((g) => g.game === "Test Game Zeta").byStatus.manual, 1);
  assert.strictEqual(games.find((g) => g.game === "Other Game").byStatus.manual, 0);
  games.forEach((g) => finite(g.byStatus));

  // Committed stock is not the held/available bucket.
  assert.deepStrictEqual(env.engine.archiveStatusFilter("held"), {
    status: { $in: ["listed", "skipped"] },
  });
});

// --- 7. removeManualSoldOwner ------------------------------------------------

test("removeManualSoldOwner: hands the owner's manual units to noclaimListings", async () => {
  const env = loadEngine({
    ledgers: [ledgerRow("listed", { _id: "L1" }), manualLedger()],
  });
  env.removeResult = { units: 2, rows: 1, errors: ["ggsel rebuild failed"] };
  const out = await env.engine.removeManualSoldOwner({
    poolAccountId: { toString: () => "pool-alpha" }, // an ObjectId goes in as a string
    actor: "drops-archive mark-sold",
  });

  assert.deepStrictEqual(env.requested, ["./noclaimListings"]);
  assert.deepStrictEqual(env.removeCalls, [["pool-alpha", { actor: "drops-archive mark-sold" }]]);
  assert.deepStrictEqual(out, {
    ledgers: 1,
    removed: 1,
    errors: ["ggsel rebuild failed"],
    manualUnits: 2,
  });
  // The auto-list half parks only its own listed ledger; the manual one is
  // the listings layer's to settle.
  const status = Object.fromEntries(env.models.UnclaimedAccount.rows.map((r) => [r._id, r.status]));
  assert.deepStrictEqual(status, { L1: "removed", "L-manual": "manual" });
});

test("removeManualSoldOwner: no manual ledger never loads noclaimListings", async () => {
  const env = loadEngine({ ledgers: [ledgerRow("listed")] });
  const out = await env.engine.removeManualSoldOwner({ poolAccountId: "pool-alpha" });
  assert.deepStrictEqual(out, { ledgers: 1, removed: 1, errors: [], manualUnits: 0 });
  assert.deepStrictEqual(env.requested, []);
  assert.deepStrictEqual(env.removeCalls, []);
});

test("removeManualSoldOwner: a missing noclaimListings module is caught, not thrown", async () => {
  const env = loadEngine({ ledgers: [ledgerRow("listed", { _id: "L1" }), manualLedger()] });
  const missing = new Error("Cannot find module './noclaimListings'\nRequire stack:\n- " + ENGINE);
  missing.code = "MODULE_NOT_FOUND";
  env.noclaimListings = missing;
  const { value: out } = await quiet(() =>
    env.engine.removeManualSoldOwner({ poolAccountId: "pool-alpha" }),
  );
  assert.deepStrictEqual(env.requested, ["./noclaimListings"]);
  assert.strictEqual(out.removed, 1, "the auto-list half still ran");
  assert.strictEqual(out.manualUnits, 0);
  assert.deepStrictEqual(out.errors, ["Cannot find module './noclaimListings'"]);
});

test("removeManualSoldOwner: a failing removeForPoolAccount is reported, not thrown", async () => {
  const env = loadEngine({ ledgers: [manualLedger()] });
  env.removeThrows = new Error("atlas hiccup");
  const { value: out } = await quiet(() =>
    env.engine.removeManualSoldOwner({ poolAccountId: "pool-alpha" }),
  );
  assert.deepStrictEqual(out, { ledgers: 0, removed: 0, errors: ["atlas hiccup"], manualUnits: 0 });
});

test("removeManualSoldOwner: no owner id keeps the legacy shape and probes nothing", async () => {
  const env = loadEngine({ ledgers: [manualLedger()] });
  const out = await env.engine.removeManualSoldOwner({});
  assert.deepStrictEqual(out, { ledgers: 0, removed: 0, errors: [] });
  assert.strictEqual(env.models.UnclaimedAccount.calls.exists.length, 0);
  assert.deepStrictEqual(env.requested, []);
});

// --- 8. poolPassword export --------------------------------------------------

test("poolPassword is exported: password first, then credPasswordEnc", () => {
  const { encrypt } = require("../utils/secretBox");
  const { poolPassword } = loadEngine().engine;
  assert.strictEqual(typeof poolPassword, "function");
  assert.strictEqual(poolPassword({ password: encrypt("pw-one") }), "pw-one");
  assert.strictEqual(
    poolPassword({ password: "", credPasswordEnc: encrypt("plain:pw-two") }),
    "pw-two",
  );
  assert.strictEqual(
    poolPassword({ password: encrypt("pw-one"), credPasswordEnc: encrypt("plain:pw-two") }),
    "pw-one",
  );
  assert.strictEqual(poolPassword({}), "");
  assert.strictEqual(poolPassword(null), "");
});


// --- ledgerAccount: a manual claim that lands mid-publish ----------------------

test("scan: an owner's claim landing mid-publish makes the pass take its fresh unit back", async () => {
  const published = [];
  const delisted = [];
  const env = loadEngine({
    pool: [poolAlpha()],
    mp: {
      async gameflipPublish(o) {
        published.push(o.title);
        // The owner's no-claim listing claims alpha while Gameflip is
        // accepting this pass's listing: after the under-lock re-check, before
        // ledgerAccount records the unit.
        env.models.UnclaimedAccount.rows.push(manualLedger());
        return { externalId: "gf-race-1", url: "" };
      },
      async gameflipDelist(id) {
        delisted.push(id);
        return { ok: true };
      },
      delistOutcome: () => "",
      async digisellerPublish() {
        throw new Error("not in this test");
      },
    },
  });
  // Keep the created row so the take-back can find it by id, as Mongo would.
  const ML = env.models.MarketplaceListing;
  ML.create = async (doc) => {
    const row = { _id: "row-race-1", ...doc };
    ML.rows.push(row);
    return row;
  };
  const { value: scan } = await quiet(() => runScan(env));

  assert.deepStrictEqual(published.length, 1, "the pass did publish a Gameflip unit");
  assert.deepStrictEqual(delisted, ["gf-race-1"], "and took exactly that unit back down");
  const row = ML.rows.find((r) => r._id === "row-race-1");
  assert.strictEqual(row.status, "delisted");
  const ledger = env.models.UnclaimedAccount.rows.find((l) => l._id === "L-manual");
  assert.strictEqual(ledger.status, "manual", "the owner's commitment is never overwritten");
  assert.ok(
    env.events.some((e) => /refused auto attach/.test(String(e.detail || ""))),
    "the refusal is logged",
  );
  assert.ok(scan);
});


// A sale (claim-at-sale order) or a manual-sold tick that lands mid-publish is
// refused the same way, and a lost compare-and-set on the write too.
for (const [label, mutate] of [
  ["a claim-at-sale sale", (rows) => rows.push(ledgerRow("sold", { _id: "L-sold" }))],
  ["a manual-sold tick", (rows) => rows.push(ledgerRow("removed", { _id: "L-removed" }))],
]) {
  test("scan: " + label + " landing mid-publish is never overwritten with listed", async () => {
    const delisted = [];
    const env = loadEngine({
      pool: [poolAlpha()],
      mp: {
        async gameflipPublish() {
          mutate(env.models.UnclaimedAccount.rows);
          return { externalId: "gf-race-2", url: "" };
        },
        async gameflipDelist(id) {
          delisted.push(id);
          return { ok: true };
        },
        delistOutcome: () => "",
        async digisellerPublish() {
          throw new Error("not in this test");
        },
      },
    });
    const ML = env.models.MarketplaceListing;
    ML.create = async (doc) => {
      const row = { _id: "row-race-2", ...doc };
      ML.rows.push(row);
      return row;
    };
    let writes = 0;
    env.models.UnclaimedAccount.findOneAndUpdate = async () => {
      writes++;
      return null;
    };
    await quiet(() => runScan(env));
    assert.deepStrictEqual(delisted, ["gf-race-2"], "the fresh unit is taken back");
    assert.strictEqual(writes, 0, "the committed ledger is never written");
  });
}

test("ledgerAccount: a compare-and-set lost to a racing claim is refused and undone", async () => {
  const delisted = [];
  const env = loadEngine({
    pool: [poolAlpha()],
    ledgers: [ledgerRow("skipped", { _id: "L-skip" })],
    mp: {
      async gameflipPublish() {
        return { externalId: "gf-race-3", url: "" };
      },
      async gameflipDelist(id) {
        delisted.push(id);
        return { ok: true };
      },
      delistOutcome: () => "",
      async digisellerPublish() {
        throw new Error("not in this test");
      },
    },
  });
  const ML = env.models.MarketplaceListing;
  ML.create = async (doc) => {
    const row = { _id: "row-race-3", ...doc };
    ML.rows.push(row);
    return row;
  };
  const filters = [];
  // The claim wins the few milliseconds between ledgerAccount's read and its
  // write: the status-guarded update matches nothing.
  env.models.UnclaimedAccount.findOneAndUpdate = async (filter, update, opts) => {
    filters.push({ filter, upsert: opts && opts.upsert });
    return null;
  };
  await quiet(() => runScan(env));
  assert.strictEqual(filters.length, 1);
  assert.deepStrictEqual(filters[0].filter, { _id: "L-skip", status: "skipped" });
  assert.strictEqual(filters[0].upsert, false, "an existing ledger is never upserted");
  assert.deepStrictEqual(delisted, ["gf-race-3"]);
});
