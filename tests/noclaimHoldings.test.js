// No-claim holdings (utils/noclaimHoldings.js, contract §2 of
// docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md): the snapshot of what each no-claim
// farm account could sell right now, the free-account rules the claim layer
// filters on, and the Listings picker that reads it.
//
// No Mongo, no network: every model, listedLogins, settings and the auto-list
// engine are stubbed at require time through Module._load. Stubs are matched by
// the RESOLVED PATH of the request without going through the resolver, so the
// test runs whether or not the models that are new in this change exist yet.
process.env.CRED_SECRET ||= "test-secret";
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const path = require("path");
const realSettings = require("../utils/settings");

const ROOT = path.join(__dirname, "..");
const MOD_PATH = path.join(ROOT, "utils", "noclaimHoldings.js");
const HOUR = 3600 * 1000;

// ---------------------------------------------------------------------------
// Stub plumbing. The hook stays installed for the whole file because the
// module requires the engine LAZILY (inside functions), long after load.
// ---------------------------------------------------------------------------
let stubs = new Map();
const origLoad = Module._load;
Module._load = function (request, parent) {
  if (parent && parent.filename && request.startsWith(".")) {
    const abs = path
      .resolve(path.dirname(parent.filename), request)
      .replace(/\.js$/, "");
    if (stubs.has(abs)) return stubs.get(abs);
  }
  return origLoad.apply(this, arguments);
};
test.after(() => {
  Module._load = origLoad;
});

// Equality, $in and $nin — all the module's queries use.
function matches(doc, q) {
  for (const [k, cond] of Object.entries(q || {})) {
    const v = doc[k];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if (cond.$in && !cond.$in.map(String).includes(String(v))) return false;
      if (cond.$nin && cond.$nin.map(String).includes(String(v))) return false;
      continue;
    }
    if (v !== cond) return false;
  }
  return true;
}

// find() answers from canned rows (projection ignored: the module must strip
// what it must not keep); writes are recorded, never applied.
function fakeModel(rows = []) {
  const calls = { find: [], bulkWrite: [], updateMany: [], updateOne: [] };
  return {
    calls,
    rows,
    find(q, proj) {
      calls.find.push({ q, proj });
      return {
        lean: async () => rows.filter((r) => matches(r, q)).map((r) => ({ ...r })),
      };
    },
    async bulkWrite(ops, opts) {
      calls.bulkWrite.push({ ops, opts });
      return { ok: 1 };
    },
    async updateMany(q, u) {
      calls.updateMany.push({ q, u });
      return { modifiedCount: 0 };
    },
    async updateOne(q, u, opts) {
      calls.updateOne.push({ q, u, opts });
      const n = rows.some((r) => matches(r, q)) ? 1 : 0;
      return { matchedCount: n, modifiedCount: n };
    },
  };
}

function loadHoldings({
  holdings = [],
  pool = [],
  ledgers = [],
  active = [],
  cands = [],
  inventory = {}, // login lowercased -> { sellable, login } | Error
  shop = { maxAgeHours: 8 }, // null = settings without getNoclaimShopSettings
  poolPassword = (row) => (row && (row.password || row.credPasswordEnc) ? "pw" : ""),
  collect = null,
} = {}) {
  const Holding = fakeModel(holdings);
  const Pool = fakeModel(pool);
  const Ledger = fakeModel(ledgers);
  const reads = [];
  const listed = { calls: 0 };
  const engine = {
    collectNoClaimCandidates: collect || (async () => cands.map((c) => ({ ...c }))),
    async inventoryForCandidate(cand) {
      reads.push(cand.login);
      const r = inventory[String(cand.login).toLowerCase()];
      if (r instanceof Error) throw r;
      return r || { inv: {}, sellable: [], login: cand.login };
    },
  };
  if (poolPassword) engine.poolPassword = poolPassword;
  const settingsStub = { normGameName: realSettings.normGameName };
  if (shop) settingsStub.getNoclaimShopSettings = () => ({ ...shop });
  stubs = new Map([
    [path.join(ROOT, "models", "NoclaimHolding"), Holding],
    [path.join(ROOT, "models", "AvailableAccount"), Pool],
    [path.join(ROOT, "models", "UnclaimedAccount"), Ledger],
    [
      path.join(ROOT, "utils", "listedLogins"),
      {
        async loginsOnActiveListings() {
          listed.calls++;
          return new Set(active);
        },
      },
    ],
    [path.join(ROOT, "utils", "settings"), settingsStub],
    [path.join(ROOT, "utils", "unclaimedAutoList"), engine],
  ]);
  delete require.cache[MOD_PATH];
  const h = require("../utils/noclaimHoldings");
  delete require.cache[MOD_PATH];
  return { h, Holding, Pool, Ledger, engine, reads, listed };
}

// The sweep logs one line per run; keep the test output readable.
async function quiet(fn) {
  const { log, error } = console;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

const pid = (n) => String(n).padStart(24, "0");
const ago = (ms) => new Date(Date.now() - ms);

function holding(login, over = {}) {
  return {
    loginLower: login.toLowerCase(),
    login,
    poolAccountId: pid(1),
    inConfig: true,
    items: [],
    readAt: ago(HOUR),
    readError: "",
    ...over,
  };
}

function poolRow(n, over = {}) {
  return {
    _id: pid(n),
    clientSecret: "secret-" + n,
    status: "claimed",
    manualSold: false,
    listed: false,
    soldGames: [],
    claimedNote: "",
    password: "enc:pw-" + n,
    credPasswordEnc: "",
    ...over,
  };
}

function item(key, name, game, qty = 1, over = {}) {
  return { itemKey: key, name, game, campaign: "", image: "", qty, ...over };
}

// A hand-built base for the pure rules.
const FREE_POOL = {
  status: "claimed",
  manualSold: false,
  listed: false,
  soldGames: [],
  claimedNote: "",
  hasPassword: true,
};
function baseWith({ pool = FREE_POOL, ledgers = {}, active = [], maxAgeMs = 8 * HOUR } = {}) {
  return {
    at: new Date(),
    maxAgeMs,
    holdings: [],
    ledgerByLogin: new Map(Object.entries(ledgers)),
    activeLogins: new Set(active),
    poolById: new Map(pool ? [[pid(1), pool]] : []),
  };
}

// ---------------------------------------------------------------------------
// foldSellable / normGame
// ---------------------------------------------------------------------------

test("foldSellable: one entry per copy folds into qty per item, first-seen order", () => {
  const { h } = loadHoldings();
  const out = h.foldSellable([
    { name: "Alpha Pack", game: "Overwatch 2", campaign: "S1", imageURL: "a.png", itemKey: "alpha pack|overwatch 2" },
    { name: "Beta Skin", game: "Overwatch 2", campaign: "S1", imageURL: "b.png", itemKey: "beta skin|overwatch 2" },
    { name: "alpha PACK", game: "OW", campaign: "S2", imageURL: "other.png", itemKey: "ALPHA PACK|OVERWATCH 2" },
    { name: "Alpha Pack", game: "Overwatch 2", campaign: "S1", imageURL: "a.png", itemKey: "alpha pack|overwatch 2" },
  ]);
  assert.deepStrictEqual(out, [
    { itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", game: "Overwatch 2", campaign: "S1", image: "a.png", qty: 3 },
    { itemKey: "beta skin|overwatch 2", name: "Beta Skin", game: "Overwatch 2", campaign: "S1", image: "b.png", qty: 1 },
  ]);
});

test("foldSellable: missing itemKey uses the name|game rule; blanks fill from later copies", () => {
  const { h } = loadHoldings();
  const out = h.foldSellable([
    { name: " Charm ", game: " Rainbow Six Siege ", campaign: "", imageURL: "" },
    { name: "Charm", game: "Rainbow Six Siege", campaign: "Y9S3", imageURL: "c.png" },
    null,
    "junk",
  ]);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].itemKey, "charm|rainbow six siege");
  assert.strictEqual(out[0].qty, 2);
  assert.strictEqual(out[0].name, " Charm "); // first-seen kept as-is
  assert.strictEqual(out[0].campaign, "Y9S3"); // blank filled by a later copy
  assert.strictEqual(out[0].image, "c.png");
  assert.deepStrictEqual(h.foldSellable(undefined), []);
});

test("foldSellable: folding an already-folded list is a no-op (qty is honoured)", () => {
  const { h } = loadHoldings();
  const once = h.foldSellable([
    { name: "A", game: "G", itemKey: "a|g" },
    { name: "A", game: "G", itemKey: "a|g" },
    { name: "B", game: "G", itemKey: "b|g" },
  ]);
  assert.deepStrictEqual(h.foldSellable(once), once);
});

test("normGame delegates to settings.normGameName", () => {
  const { h } = loadHoldings();
  assert.strictEqual(h.normGame("Tom Clancy's Rainbow-Six  Siege"), "tom clancy s rainbow six siege");
  assert.strictEqual(h.normGame(""), "");
});

// ---------------------------------------------------------------------------
// freeReason / isFresh (pure)
// ---------------------------------------------------------------------------

test("freeReason: a clean in-bot, claimed, passworded, unlisted account is free", () => {
  const { h } = loadHoldings();
  assert.strictEqual(h.freeReason(holding("alice"), baseWith(), "overwatch 2"), "");
});

test("freeReason: config and pool rules, each with its own reason", () => {
  const { h } = loadHoldings();
  const r = (hold, pool, g = "overwatch 2") => h.freeReason(hold, baseWith({ pool }), g);
  assert.strictEqual(r(holding("a", { inConfig: false }), FREE_POOL), "not in a bot");
  assert.strictEqual(r(holding("a", { inConfig: undefined }), FREE_POOL), "not in a bot");
  assert.strictEqual(r(holding("a", { poolAccountId: "" }), FREE_POOL), "no pool row");
  assert.strictEqual(r(holding("a"), null), "no pool row");
  assert.strictEqual(r(holding("a"), { ...FREE_POOL, hasPassword: false }), "no password");
  assert.strictEqual(r(holding("a"), { ...FREE_POOL, manualSold: true }), "manual sold");
  assert.strictEqual(r(holding("a"), { ...FREE_POOL, claimedNote: "sold — gameflip" }), "spent");
  assert.strictEqual(r(holding("a"), { ...FREE_POOL, claimedNote: "Spent — unclaimed auto-listed (x)" }), "spent");
  assert.strictEqual(r(holding("a"), { ...FREE_POOL, claimedNote: "no-claim bot 7" }), "");
  assert.strictEqual(r(holding("a"), { ...FREE_POOL, status: "available" }), "pool not claimed");
});

test("freeReason: the console's Listed tick is never free, checked right after manual sold", () => {
  const { h } = loadHoldings();
  const r = (pool, ledgers = {}) => h.freeReason(holding("a"), baseWith({ pool, ledgers }), "overwatch 2");
  const ticked = { ...FREE_POOL, listed: true };
  assert.strictEqual(r(ticked), "ticked listed");
  // manual sold outranks it ...
  assert.strictEqual(r({ ...ticked, manualSold: true }), "manual sold");
  // ... and it outranks everything after it in the order.
  assert.strictEqual(r({ ...ticked, soldGames: ["overwatch 2"] }), "ticked listed");
  assert.strictEqual(r({ ...ticked, claimedNote: "spent — x" }), "ticked listed");
  assert.strictEqual(r({ ...ticked, status: "available" }), "ticked listed");
  assert.strictEqual(r(ticked, { a: { status: "listed" } }), "ticked listed");
  // listed:false (or absent on a legacy row) does not block.
  const { listed, ...legacy } = FREE_POOL;
  assert.strictEqual(listed, false);
  assert.strictEqual(r(legacy), "");
});

test("freeReason: soldGames blocks only the set's game, normalised, substring both ways", () => {
  const { h } = loadHoldings();
  const pool = { ...FREE_POOL, soldGames: ["overwatch 2"] };
  const r = (g) => h.freeReason(holding("a"), baseWith({ pool }), g);
  assert.strictEqual(r("overwatch 2"), "sold for this game");
  assert.strictEqual(r("Overwatch-2"), "sold for this game"); // raw label normalised
  assert.strictEqual(r("overwatch"), "sold for this game"); // "overwatch 2" contains it
  assert.strictEqual(r("rainbow six siege"), "");
  assert.strictEqual(r(""), ""); // no game given -> no per-game check
  assert.strictEqual(r(["rainbow six siege", "overwatch 2"]), "sold for this game");
  const broad = { ...FREE_POOL, soldGames: ["call of duty"] };
  assert.strictEqual(
    h.freeReason(holding("a"), baseWith({ pool: broad }), "call of duty warzone"),
    "sold for this game",
  );
  const blank = { ...FREE_POOL, soldGames: [""] };
  assert.strictEqual(h.freeReason(holding("a"), baseWith({ pool: blank }), "overwatch 2"), "");
});

test("freeReason: ledger statuses — committed blocks, FREE_STATUSES pass", () => {
  const { h } = loadHoldings();
  const r = (status) =>
    h.freeReason(holding("alice"), baseWith({ ledgers: { alice: { status } } }), "overwatch 2");
  assert.strictEqual(r("listed"), "on auto listing");
  assert.strictEqual(r("manual"), "on manual listing");
  assert.strictEqual(r("sold"), "sold");
  assert.strictEqual(r("removed"), "removed");
  for (const s of ["skipped", "released", "expired"]) assert.strictEqual(r(s), "", s);
});

test("freeReason: a login on any active listing is not free", () => {
  const { h } = loadHoldings();
  const b = baseWith({ active: ["alice"], ledgers: { alice: { status: "released" } } });
  assert.strictEqual(h.freeReason(holding("Alice"), b, "overwatch 2"), "on a listing");
});

test("freeReason: a renamed account is checked under its live login too", () => {
  const { h } = loadHoldings();
  const renamed = holding("oldname", { login: "NewName" });
  assert.strictEqual(
    h.freeReason(renamed, baseWith({ ledgers: { newname: { status: "listed" } } }), ""),
    "on auto listing",
  );
  assert.strictEqual(h.freeReason(renamed, baseWith({ active: ["newname"] }), ""), "on a listing");
  // A committed ledger under either name beats a free one under the other.
  const both = baseWith({
    ledgers: { oldname: { status: "released" }, newname: { status: "manual" } },
  });
  assert.strictEqual(h.freeReason(renamed, both, ""), "on manual listing");
});

test("isFresh: readAt within maxAgeMs, boundary inclusive, junk is stale", () => {
  const { h } = loadHoldings();
  const now = Date.parse("2026-09-11T12:00:00Z");
  const b = { maxAgeMs: 8 * HOUR };
  const at = (ms) => ({ readAt: new Date(now - ms) });
  assert.strictEqual(h.isFresh(at(HOUR), b, now), true);
  assert.strictEqual(h.isFresh(at(8 * HOUR), b, now), true);
  assert.strictEqual(h.isFresh(at(8 * HOUR + 1), b, now), false);
  assert.strictEqual(h.isFresh({ readAt: null }, b, now), false);
  assert.strictEqual(h.isFresh({ readAt: "not a date" }, b, now), false);
  assert.strictEqual(h.isFresh(at(HOUR), {}, now), false); // no window -> never fresh
  assert.strictEqual(h.isFresh({ readAt: new Date() }, b), true); // default clock
});

// ---------------------------------------------------------------------------
// snapshotBase
// ---------------------------------------------------------------------------

test("snapshotBase: pool join keeps only the rule fields — never a password", async () => {
  const { h, Pool } = loadHoldings({
    holdings: [
      holding("alice", { poolAccountId: pid(1) }),
      holding("bob", { poolAccountId: pid(2) }),
      holding("carl", { poolAccountId: pid(3) }),
    ],
    pool: [
      poolRow(1, { listed: true, soldGames: ["overwatch 2"] }),
      poolRow(2, { password: "", credPasswordEnc: "enc:x" }),
      poolRow(3, { password: "", credPasswordEnc: "" }),
    ],
  });
  const base = await h.snapshotBase();
  const q = Pool.calls.find[0];
  assert.deepStrictEqual(q.q, { _id: { $in: [pid(1), pid(2), pid(3)] } });
  for (const f of ["status", "manualSold", "listed", "soldGames", "claimedNote", "password", "credPasswordEnc"]) {
    assert.strictEqual(q.proj[f], 1, "projection carries " + f);
  }
  assert.strictEqual(q.proj.clientSecret, undefined);
  const p1 = base.poolById.get(pid(1));
  assert.deepStrictEqual(p1, {
    status: "claimed",
    manualSold: false,
    listed: true,
    soldGames: ["overwatch 2"],
    claimedNote: "",
    hasPassword: true,
  });
  assert.strictEqual(base.poolById.get(pid(2)).hasPassword, true); // credPasswordEnc
  assert.strictEqual(base.poolById.get(pid(3)).hasPassword, false);
  for (const v of base.poolById.values()) {
    assert.ok(!("password" in v) && !("credPasswordEnc" in v) && !("clientSecret" in v));
  }
  assert.strictEqual(h.freeReason(base.holdings[0], base, "rainbow six siege"), "ticked listed");
  assert.strictEqual(h.freeReason(base.holdings[2], base, ""), "no password");
});

test("snapshotBase: hasPassword uses the engine's poolPassword rule when exported", async () => {
  const seen = [];
  const { h } = loadHoldings({
    holdings: [holding("alice")],
    pool: [poolRow(1, { password: "enc:garbage" })],
    poolPassword: (row) => {
      seen.push(row.password);
      return ""; // undecryptable -> no usable password
    },
  });
  const base = await h.snapshotBase();
  assert.deepStrictEqual(seen, ["enc:garbage"]);
  assert.strictEqual(base.poolById.get(pid(1)).hasPassword, false);
});

test("snapshotBase: ledger query, strongest ledger wins, rename aliases both names", async () => {
  const { h, Ledger } = loadHoldings({
    holdings: [
      holding("alice", { poolAccountId: pid(1) }),
      holding("oldname", { login: "NewName", poolAccountId: pid(1) }),
    ],
    pool: [poolRow(1)],
    ledgers: [
      { _id: "L1", source: "noclaim", loginLower: "alice", status: "released", manualListing: "", set: null, market: "" },
      { _id: "L2", source: "noclaim", loginLower: "alice", status: "manual", manualListing: "row9", set: "S1", market: "ggsel" },
      { _id: "L3", source: "noclaim", loginLower: "newname", status: "listed", manualListing: "", set: "S2", market: "gameflip" },
      { _id: "L4", source: "webtoken", loginLower: "alice", status: "sold" },
    ],
    active: ["newname"],
  });
  const base = await h.snapshotBase();
  const q = Ledger.calls.find[0];
  assert.strictEqual(q.q.source, "noclaim");
  assert.deepStrictEqual([...q.q.loginLower.$in].sort(), ["alice", "newname", "oldname"]);
  assert.deepStrictEqual(q.proj, { loginLower: 1, status: 1, manualListing: 1, set: 1, market: 1 });
  assert.deepStrictEqual(base.ledgerByLogin.get("alice"), {
    _id: "L2",
    status: "manual",
    manualListing: "row9",
    set: "S1",
    market: "ggsel",
  });
  assert.strictEqual(base.ledgerByLogin.get("oldname").status, "listed");
  assert.ok(base.activeLogins.has("oldname") && base.activeLogins.has("newname"));
  assert.strictEqual(base.maxAgeMs, 8 * HOUR);
});

test("snapshotBase: cached 30 s, shared in flight, invalidate() and force rebuild", async () => {
  const { h, Holding, listed } = loadHoldings({ holdings: [holding("alice")], pool: [poolRow(1)] });
  const [a, b] = await Promise.all([h.snapshotBase(), h.snapshotBase()]);
  assert.strictEqual(a, b);
  assert.strictEqual(await h.snapshotBase(), a);
  assert.strictEqual(Holding.calls.find.length, 1);
  assert.strictEqual(listed.calls, 1);
  h.invalidate();
  const c = await h.snapshotBase();
  assert.notStrictEqual(c, a);
  const d = await h.snapshotBase({ force: true });
  assert.notStrictEqual(d, c);
  assert.strictEqual(Holding.calls.find.length, 3);
});

test("snapshotBase: freshness window comes from settings, contract default without the accessor", async () => {
  const two = loadHoldings({ shop: { maxAgeHours: 2 } });
  assert.strictEqual((await two.h.snapshotBase()).maxAgeMs, 2 * HOUR);
  const none = loadHoldings({ shop: null });
  assert.strictEqual((await none.h.snapshotBase()).maxAgeMs, 8 * HOUR);
  assert.strictEqual((await none.h.summary()).settings.sweepPerTick, 30);
});

// ---------------------------------------------------------------------------
// Picker grouping
// ---------------------------------------------------------------------------

// A: free + fresh, 2× Alpha (OW) + Charm (R6)
// B: free but stale, 1× Alpha (lower-case game label)
// C: on an auto-listing (ledger listed; the engine also ticks the pool row)
// D: manual sold, holds Charm
// E: free + fresh, an item with no game
// F: free for Overwatch, but already sold for Rainbow Six
// G: no pool row at all
// H: committed to an owner-made listing (ledger manual)
function pickerFixture() {
  const OW = "Overwatch 2";
  const R6 = "Rainbow Six Siege";
  return {
    holdings: [
      holding("A", {
        poolAccountId: pid(1),
        items: [item("alpha|overwatch 2", "Alpha Pack", OW, 2, { image: "a.png" }), item("charm|rainbow six siege", "Charm", R6)],
      }),
      holding("B", { poolAccountId: pid(2), readAt: ago(9 * HOUR), items: [item("alpha|overwatch 2", "Alpha Pack", "overwatch 2")] }),
      holding("C", { poolAccountId: pid(3), items: [item("beta|overwatch 2", "Beta Skin", OW)] }),
      holding("D", { poolAccountId: pid(4), items: [item("charm|rainbow six siege", "Charm", R6)] }),
      holding("E", { poolAccountId: pid(5), items: [item("mystery|", "Mystery", "")] }),
      holding("F", {
        poolAccountId: pid(6),
        items: [item("alpha|overwatch 2", "Alpha Pack", OW), item("charm|rainbow six siege", "Charm", R6)],
      }),
      holding("G", { poolAccountId: pid(7), items: [item("gamma|overwatch 2", "Gamma", OW)] }),
      holding("H", { poolAccountId: pid(8), items: [item("zeta|overwatch 2", "Zeta Emote", OW)] }),
    ],
    pool: [
      poolRow(1),
      poolRow(2),
      poolRow(3, { listed: true }),
      poolRow(4, { manualSold: true }),
      poolRow(5),
      poolRow(6, { soldGames: ["rainbow six siege"] }),
      poolRow(8, { listed: true }),
    ],
    ledgers: [
      { _id: "LC", source: "noclaim", loginLower: "c", status: "listed" },
      { _id: "LH", source: "noclaim", loginLower: "h", status: "manual", manualListing: "row1" },
    ],
  };
}

test("pickerGames: grouped by the drops' game, nicest label, free/fresh per game", async () => {
  const { h } = loadHoldings(pickerFixture());
  const games = await h.pickerGames();
  assert.deepStrictEqual(games, [
    { game: "Overwatch 2", accounts: 6, free: 3, fresh: 2 }, // A,B,C,F,G,H; free A,B,F; fresh A,F
    { game: "Rainbow Six Siege", accounts: 3, free: 1, fresh: 1 }, // A,D,F; F sold for R6
    { game: "Other rewards", accounts: 1, free: 1, fresh: 1 },
  ]);
});

test("pickerItems: archive-shaped rows, FREE+FRESH accounts, committed + stale split out", async () => {
  const { h } = loadHoldings(pickerFixture());
  const items = await h.pickerItems();
  assert.deepStrictEqual(
    items.map((r) => r.itemKey),
    ["alpha|overwatch 2", "charm|rainbow six siege", "mystery|", "beta|overwatch 2", "zeta|overwatch 2"],
  );
  const byKey = new Map(items.map((r) => [r.itemKey, r]));
  assert.deepStrictEqual(byKey.get("alpha|overwatch 2"), {
    itemKey: "alpha|overwatch 2",
    name: "Alpha Pack",
    game: "Overwatch 2",
    image: "a.png",
    accounts: 2, // A (2×) + F (1×); B is stale
    minPerAcct: 1,
    maxPerAcct: 2,
    totalCount: 3,
    onAuto: 0,
    onManual: 0,
    stale: 1,
  });
  const charm = byKey.get("charm|rainbow six siege");
  assert.strictEqual(charm.accounts, 1); // D manual sold, F sold for R6
  assert.strictEqual(charm.totalCount, 1);
  const mystery = byKey.get("mystery|");
  assert.strictEqual(mystery.game, "");
  assert.strictEqual(mystery.accounts, 1);
  const beta = byKey.get("beta|overwatch 2");
  assert.deepStrictEqual(
    [beta.accounts, beta.stale, beta.onAuto, beta.onManual, beta.minPerAcct, beta.maxPerAcct],
    [0, 0, 1, 0, 0, 0],
  );
  assert.strictEqual(byKey.get("zeta|overwatch 2").onManual, 1);
  assert.ok(!byKey.has("gamma|overwatch 2"), "an item nobody can sell or holds committed is omitted");
});

test("pickerItems: game filter (normalised, 'Other rewards') and name search", async () => {
  const { h } = loadHoldings(pickerFixture());
  const keys = async (q) => (await h.pickerItems(q)).map((r) => r.itemKey);
  const ow = ["alpha|overwatch 2", "beta|overwatch 2", "zeta|overwatch 2"];
  assert.deepStrictEqual(await keys({ game: "Overwatch 2" }), ow);
  assert.deepStrictEqual(await keys({ game: "overwatch-2" }), ow);
  assert.deepStrictEqual(await keys({ game: "Other rewards" }), ["mystery|"]);
  assert.deepStrictEqual(await keys({ search: "CHARM" }), ["charm|rainbow six siege"]);
  assert.deepStrictEqual(await keys({ game: "Overwatch 2", search: "charm" }), []);
});

test("pickerItems: capped at 2000 rows", async () => {
  const many = [];
  for (let i = 0; i < 2005; i++) many.push(item("it" + i + "|g", "Item " + i, "G"));
  const { h } = loadHoldings({ holdings: [holding("alice", { items: many })], pool: [poolRow(1)] });
  assert.strictEqual((await h.pickerItems()).length, 2000);
});

// ---------------------------------------------------------------------------
// Sweep + recordRead + summary
// ---------------------------------------------------------------------------

function sweepFixture() {
  const cand = (login, secret, game, botId) => ({
    source: "noclaim",
    login,
    twitchId: "id-" + login,
    clientSecret: secret,
    game,
    botId,
    container: "noclaim-bot-" + botId,
  });
  return {
    cands: [
      cand("Alice", "s1", "Overwatch 2", "3"), // read 10h ago -> due
      cand("bob", "s2", "Rainbow Six Siege", "3"), // no row yet -> never read
      cand("carol", "s3", "Overwatch 2", "4"), // read 1h ago -> fresh, skipped
      cand("dave", "s4", "Overwatch 2", "4"), // failing, read 20h ago
      cand("erin", "s5", "Overwatch 2", "4"), // failing, never read
      cand("ALICE", "s1-dup", "Overwatch 2", "5"), // same login twice -> first wins
      cand("", "s6", "Overwatch 2", "5"), // no login -> cannot be keyed
    ],
    holdings: [
      holding("Alice", { readAt: ago(10 * HOUR) }),
      holding("carol", { readAt: ago(HOUR) }),
      holding("dave", {
        readAt: ago(20 * HOUR),
        readError: "token dead",
        items: [item("charm|rainbow six siege", "Charm", "Rainbow Six Siege")],
      }),
      holding("erin", { readAt: null, readError: "401" }),
      holding("zed", {}), // no longer in any config
    ],
    pool: [poolRow(1, { clientSecret: "s1" }), poolRow(2, { clientSecret: "s2" }), poolRow(4, { clientSecret: "s4" })],
    inventory: {
      alice: {
        sellable: [
          { name: "Alpha Pack", game: "Overwatch 2", campaign: "", imageURL: "", itemKey: "alpha pack|overwatch 2" },
          { name: "Alpha Pack", game: "Overwatch 2", campaign: "", imageURL: "", itemKey: "alpha pack|overwatch 2" },
        ],
        login: "alice",
      },
      bob: { sellable: [], login: "bob_renamed" },
      erin: new Error("token dead"),
    },
  };
}

test("sweepOnce: upserts every config account, flags the missing, reads oldest-first within budget", async () => {
  const { h, Holding, reads } = loadHoldings(sweepFixture());
  const r = await quiet(() => h.sweepOnce({ budget: 3, reason: "test" }));
  assert.deepStrictEqual(
    { configs: r.configs, accounts: r.accounts, picked: r.picked, read: r.read, failed: r.failed },
    { configs: 3, accounts: 5, picked: 3, read: 2, failed: 1 },
  );
  assert.ok(Number.isFinite(r.tookMs));
  assert.strictEqual(r.skipped, undefined);

  // 3. base upsert — one op per distinct login, login only on insert.
  const { ops, opts } = Holding.calls.bulkWrite[0];
  assert.deepStrictEqual(opts, { ordered: false });
  assert.deepStrictEqual(
    ops.map((o) => o.updateOne.filter.loginLower),
    ["alice", "bob", "carol", "dave", "erin"],
  );
  const alice = ops[0].updateOne;
  assert.strictEqual(alice.upsert, true);
  assert.deepStrictEqual(alice.update.$setOnInsert, { login: "Alice" });
  const { seenAt, ...set } = alice.update.$set;
  assert.ok(seenAt instanceof Date);
  assert.deepStrictEqual(set, {
    twitchId: "id-Alice",
    poolAccountId: pid(1),
    botId: "3",
    container: "noclaim-bot-3",
    game: "Overwatch 2",
    inConfig: true,
  });
  assert.strictEqual(ops[2].updateOne.update.$set.poolAccountId, ""); // carol: no pool row
  assert.deepStrictEqual(Holding.calls.updateMany[0], {
    q: { loginLower: { $nin: ["alice", "bob", "carol", "dave", "erin"] }, inConfig: true },
    u: { $set: { inConfig: false } },
  });

  // 4. never-read healthy first, then oldest healthy, failing rows last.
  assert.deepStrictEqual([...reads].sort(), ["Alice", "bob", "erin"]);

  // 5. writes: success replaces items (+ live login), failure records why only.
  const writes = new Map(Holding.calls.updateOne.map((w) => [w.q.loginLower, w]));
  assert.deepStrictEqual([...writes.keys()].sort(), ["alice", "bob", "erin"]);
  const aw = writes.get("alice");
  assert.strictEqual(aw.opts, undefined, "never an upsert");
  assert.deepStrictEqual(aw.u.$set.items, [
    { itemKey: "alpha pack|overwatch 2", name: "Alpha Pack", game: "Overwatch 2", campaign: "", image: "", qty: 2 },
  ]);
  assert.strictEqual(aw.u.$set.sellableCount, 2);
  assert.strictEqual(aw.u.$set.readError, "");
  assert.ok(aw.u.$set.readAt instanceof Date);
  assert.strictEqual(aw.u.$set.login, "alice");
  assert.strictEqual(writes.get("bob").u.$set.login, "bob_renamed");
  assert.deepStrictEqual(writes.get("bob").u.$set.items, []);
  assert.deepStrictEqual(writes.get("erin").u, { $set: { readError: "token dead" } });

  const s = await h.summary();
  assert.strictEqual(s.lastSweep.reason, "test");
  assert.strictEqual(s.lastSweep.read, 2);
  assert.strictEqual(s.sweeping, false);
});

test("sweepOnce: a game refresh reads that game's bots and known holders, never fresh rows", async () => {
  const { h, reads } = loadHoldings(sweepFixture());
  const r = await quiet(() => h.sweepOnce({ budget: 10, game: "Rainbow Six", reason: "refresh" }));
  // bob farms R6; dave's bot farms Overwatch but his snapshot holds an R6 item.
  assert.deepStrictEqual([...reads].sort(), ["bob", "dave"]);
  assert.strictEqual(r.picked, 2);
});

test("sweepOnce: budget 0 still refreshes the config view but reads nothing", async () => {
  const { h, Holding, reads } = loadHoldings(sweepFixture());
  const r = await quiet(() => h.sweepOnce({ budget: 0 }));
  assert.strictEqual(r.picked, 0);
  assert.deepStrictEqual(reads, []);
  assert.strictEqual(Holding.calls.bulkWrite.length, 1);
  assert.strictEqual(Holding.calls.updateMany.length, 1);
});

test("sweepOnce: one sweep at a time — a second call answers skipped:running", async () => {
  let release;
  const gate = new Promise((res) => (release = res));
  const { h } = loadHoldings({
    collect: async () => {
      await gate;
      return [];
    },
  });
  const first = quiet(() => h.sweepOnce({ budget: 1 }));
  assert.strictEqual(h.isSweeping(), true);
  assert.deepStrictEqual(await h.sweepOnce({ budget: 1 }), { skipped: "running" });
  release();
  const r = await first;
  assert.strictEqual(r.accounts, 0);
  assert.strictEqual(h.isSweeping(), false);
});

test("sweepOnce: an unreachable Pi skips without touching the snapshot", async () => {
  const { h, Holding } = loadHoldings({
    collect: async () => {
      throw new Error("Raspberry Pi is unreachable over SSH.");
    },
  });
  const r = await quiet(() => h.sweepOnce({ budget: 5 }));
  assert.strictEqual(r.skipped, "pi unreachable");
  assert.strictEqual(r.error, "Raspberry Pi is unreachable over SSH.");
  assert.strictEqual(Holding.calls.bulkWrite.length, 0);
  assert.strictEqual(Holding.calls.updateMany.length, 0);
  assert.strictEqual(h.isSweeping(), false);
});

test("sweepOnce: a database error resolves (never rejects) and frees the flag", async () => {
  const fx = sweepFixture();
  const { h, Pool } = loadHoldings(fx);
  Pool.find = () => ({
    lean: async () => {
      throw new Error("atlas down");
    },
  });
  const r = await quiet(() => h.sweepOnce({ budget: 5 }));
  assert.strictEqual(r.skipped, "error");
  assert.strictEqual(r.error, "atlas down");
  assert.strictEqual(h.isSweeping(), false);
});

test("recordRead: a claim's read updates its row (no upsert) and drops the cache", async () => {
  const { h, Holding } = loadHoldings({ holdings: [holding("alice")], pool: [poolRow(1)] });
  const before = await h.snapshotBase();
  const ok = await h.recordRead("ALICE", {
    sellable: [{ name: "Alpha", game: "G", itemKey: "alpha|g" }],
    login: "alice",
  });
  assert.strictEqual(ok, true);
  const w = Holding.calls.updateOne[0];
  assert.deepStrictEqual(w.q, { loginLower: "alice" });
  assert.strictEqual(w.opts, undefined);
  assert.strictEqual(w.u.$set.sellableCount, 1);
  assert.notStrictEqual(await h.snapshotBase(), before);

  await h.recordRead("alice", { error: new Error("gql 500") });
  assert.deepStrictEqual(Holding.calls.updateOne[1].u, { $set: { readError: "gql 500" } });
  // Nothing read and no error -> no write (never wipe items by accident).
  assert.strictEqual(await h.recordRead("alice", {}), false);
  assert.strictEqual(Holding.calls.updateOne.length, 2);
  // No such row -> false, and still no upsert.
  assert.strictEqual(await h.recordRead("ghost", { sellable: [] }), false);
});

test("recordRead: a failing write is logged, never thrown", async () => {
  const { h, Holding } = loadHoldings();
  Holding.updateOne = async () => {
    throw new Error("atlas down");
  };
  const ok = await quiet(() => h.recordRead("alice", { sellable: [] }));
  assert.strictEqual(ok, false);
});

test("summary: counts over in-config rows only", async () => {
  const { h } = loadHoldings({
    holdings: [
      holding("a", { readAt: ago(HOUR) }),
      holding("b", { readAt: ago(10 * HOUR), readError: "gql 500" }),
      holding("c", { readAt: null }),
      holding("d", { inConfig: false, readAt: ago(HOUR) }),
    ],
  });
  const s = await h.summary();
  assert.deepStrictEqual(
    [s.accounts, s.read, s.fresh, s.stale, s.neverRead, s.failed],
    [3, 2, 1, 1, 1, 1],
  );
  assert.ok(s.oldestReadAt instanceof Date && s.newestReadAt instanceof Date);
  assert.ok(s.oldestReadAt < s.newestReadAt);
  assert.strictEqual(s.sweeping, false);
  assert.strictEqual(s.lastSweep, null);
  assert.strictEqual(s.settings.maxAgeHours, 8);
});

// ---------------------------------------------------------------------------
// Demand-driven sweep: the background timer reads through the Pi only while the
// snapshot is wanted — recent picker use, or a live no-claim listing.
// ---------------------------------------------------------------------------
test("sweepWanted: nothing wanted until the picker is used or a no-claim listing is live", async () => {
  let live = false;
  const { h } = loadHoldings();
  stubs.set(path.join(ROOT, "models", "MarketplaceListing"), {
    async exists(q) {
      assert.deepStrictEqual(q, { noclaimStock: true, status: "active" });
      return live ? { _id: "x" } : null;
    },
  });
  assert.strictEqual(await h.sweepWanted(), false, "fresh process, no listing: stay quiet");
  live = true;
  assert.strictEqual(await h.sweepWanted(), true, "a live no-claim listing keeps the snapshot fresh");
  live = false;
  h.noteInterest();
  assert.strictEqual(await h.sweepWanted(), true, "the picker was just used");
});

test("sweepWanted: a failed listing probe reads as not wanted (never an extra Pi sweep)", async () => {
  const { h } = loadHoldings();
  stubs.set(path.join(ROOT, "models", "MarketplaceListing"), {
    async exists() {
      throw new Error("db down");
    },
  });
  assert.strictEqual(await h.sweepWanted(), false);
});
