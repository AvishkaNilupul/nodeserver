/* global fetch, structuredClone */
// A hand sale MARKS the accounts sold before their logins are handed out
// (owner, 2026-09-28 — review item 5).
//
// Before: "Export held creds" and the bot page's "Copy unsold" reserved
// nothing, so the Eldorado shop offer or the auto-lister could sell the same
// accounts minutes later (19 accounts went to two buyers on 2026-09-18), and
// the export re-exported accounts already sold by hand.
//
// Mongo/host-free: models and the fleet host are stubbed via Module._load; the
// REAL engine helper (handSellAccounts) and the REAL routes run on top.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const express = require("express");
const { encrypt } = require("../utils/secretBox");

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
  const apply = (row, u) => {
    Object.assign(row, (u && u.$set) || {});
    for (const [k, v] of Object.entries((u && u.$addToSet) || {})) {
      const cur = Array.isArray(row[k]) ? row[k] : [];
      if (!cur.includes(v)) cur.push(v);
      row[k] = cur;
    }
  };
  return {
    rows,
    find: (q) => query(() => rows.filter((r) => matches(r, q)).map(clone)),
    findOne: (q) => query(() => clone(rows.find((r) => matches(r, q)) || null)),
    findById: (id) => query(() => clone(rows.find((r) => String(r._id) === String(id)) || null)),
    exists: async (q) => (rows.some((r) => matches(r, q)) ? { _id: "x" } : null),
    countDocuments: async (q) => rows.filter((r) => matches(r, q)).length,
    create: async (doc) => {
      const row = { _id: "new-" + (rows.length + 1), ...structuredClone(doc) };
      rows.push(row);
      return row;
    },
    deleteOne: async (q) => {
      const i = rows.findIndex((r) => matches(r, q));
      if (i >= 0) rows.splice(i, 1);
      return { deletedCount: i >= 0 ? 1 : 0 };
    },
    updateOne: (q, u) =>
      query(() => {
        const row = rows.find((r) => matches(r, q));
        if (row) apply(row, u);
        return { matchedCount: row ? 1 : 0, modifiedCount: row ? 1 : 0 };
      }),
  };
}

const OW = "Overwatch";
const poolRow = (id, secret, over = {}) => ({
  _id: id,
  clientSecret: secret,
  status: "claimed",
  claimedNote: "noclaim-farm:Overwatch",
  password: encrypt("pw-" + id),
  manualSold: false,
  listed: false,
  soldGames: [],
  ...over,
});
const heldLedger = (id, poolId, login, over = {}) => ({
  _id: id,
  source: "noclaim",
  status: "skipped",
  login,
  loginLower: login,
  game: OW,
  poolAccountId: poolId,
  drops: [{ name: "a" }, { name: "b" }],
  lastCheckedAt: new Date(),
  ...over,
});

// Loads a FRESH engine + the two routes on stubs; `fleetCfg` is bot 14's config.
function withStubs({ pool = [], ledgers = [], listings = [], fleetCfg = null } = {}) {
  const m = { Pool: fakeModel(pool), Ledger: fakeModel(ledgers), Listing: fakeModel(listings) };
  const events = [];
  const hosts = {
    resolveHost: (id) => ({ id }),
    shq: (s) => "'" + String(s).replace(/'/g, "'\\''") + "'",
    async readFiles() {
      return {};
    },
    async runShell(_h, script) {
      if (/^\[ -f '/.test(script)) return { stdout: fleetCfg ? JSON.stringify(fleetCfg) : "" };
      return { stdout: "" };
    },
  };
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), m.Ledger],
    [require.resolve("../models/AvailableAccount"), m.Pool],
    [require.resolve("../models/MarketplaceListing"), m.Listing],
    [require.resolve("../utils/botHosts"), hosts],
    [require.resolve("../utils/systemLog"), { logEvent: (e) => events.push(e), actorFromReq: () => "owner" }],
  ]);
  const paths = [
    require.resolve("../utils/unclaimedAutoList"),
    require.resolve("../utils/listedLogins"),
    require.resolve("../routes/unclaimedAutoRoutes"),
    require.resolve("../routes/noclaimFarmRoutes"),
    // Holds the host it was loaded with — reload it on this test's host.
    require.resolve("../utils/noclaimFleet"),
  ];
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
  const engine = require("../utils/unclaimedAutoList");
  const restore = () => {
    Module._load = origLoad;
    for (const p of paths) delete require.cache[p];
  };
  return { engine, restore, ...m, events };
}

async function withServer(h, fn) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { admin: { id: "root", username: "root", role: "superadmin", tfa: true } };
    next();
  });
  app.use(require("../routes/unclaimedAutoRoutes"));
  app.use(require("../routes/noclaimFarmRoutes"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  try {
    return await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const post = (base, path, body) =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("handSellAccounts: a free held account is marked sold on the ledger AND the pool before anything else", async () => {
  const h = withStubs({ pool: [poolRow("P1", "s1")], ledgers: [heldLedger("L1", "P1", "free1")] });
  try {
    const [r] = await h.engine.handSellAccounts([{ login: "free1", poolAccountId: "P1" }], { game: OW, actor: "owner" });
    assert.deepStrictEqual({ sold: r.sold, why: r.why }, { sold: true, why: "" });
    const l = h.Ledger.rows[0];
    assert.strictEqual(l.status, "sold");
    assert.strictEqual(l.soldMarket, "manual");
    assert.match(l.note, /^sold by hand/);
    const p = h.Pool.rows[0];
    assert.strictEqual(p.manualSold, true, "the Sold tick fences the Eldorado shop and the lister");
    assert.deepStrictEqual(p.soldGames, ["overwatch"]);
    assert.strictEqual(p.status, "claimed", "never back to the pool — the retire pass takes it out of its bot");
    assert.ok(h.events.some((e) => e.action === "hand_sold" && e.count === 1));
    assert.strictEqual(h.engine.soldRetireReason(p, l), "sold by hand", "the next scan retires it");
  } finally {
    h.restore();
  }
});

test("handSellAccounts: an account another channel holds is never sold, and a lost race is undone", async () => {
  const h = withStubs({
    pool: [
      poolRow("P1", "s1"),
      poolRow("P2", "s2"),
      poolRow("P3", "s3", { listed: true }),
      poolRow("P4", "s4"),
    ],
    ledgers: [
      heldLedger("L1", "P1", "onauto", { status: "listed", market: "gameflip" }),
      heldLedger("L2", "P2", "onshop", { status: "manual" }),
      heldLedger("L3", "P3", "ticked"),
    ],
    listings: [{ _id: "R1", status: "active", marketplace: "eldorado", accountLogin: "", units: [{ login: "onoffer" }] }],
  });
  try {
    const out = await h.engine.handSellAccounts(
      [
        { login: "onauto", poolAccountId: "P1" },
        { login: "onshop", poolAccountId: "P2" },
        { login: "ticked", poolAccountId: "P3" },
        { login: "onoffer", poolAccountId: "P4" },
      ],
      { game: OW },
    );
    assert.deepStrictEqual(out.map((r) => [r.login, r.sold, r.why]), [
      ["onauto", false, "ledger listed"],
      ["onshop", false, "ledger manual"],
      ["ticked", false, "pool row not free (sold, listed or not claimed)"],
      ["onoffer", false, "on a listing"],
    ]);
    assert.strictEqual(h.Ledger.rows.find((l) => l._id === "L3").status, "skipped", "the ledger claim was undone");
    assert.ok(h.Pool.rows.every((p) => p.manualSold === false));
  } finally {
    h.restore();
  }
});

test("handSellAccounts: an account with no ledger gets a sold row of its own", async () => {
  const h = withStubs({ pool: [poolRow("P9", "s9")] });
  try {
    const [r] = await h.engine.handSellAccounts([{ login: "Unledgered", poolAccountId: "P9", botId: "14" }], { game: OW });
    assert.strictEqual(r.sold, true, r.why);
    assert.strictEqual(h.Ledger.rows.length, 1);
    assert.deepStrictEqual(
      { status: h.Ledger.rows[0].status, loginLower: h.Ledger.rows[0].loginLower, botId: h.Ledger.rows[0].botId },
      { status: "sold", loginLower: "unledgered", botId: "14" },
    );
  } finally {
    h.restore();
  }
});

test("Unclaimed farms hand sale: only free held accounts count, and each exported one is sold", async () => {
  const h = withStubs({
    pool: [
      poolRow("P1", "s1"),
      poolRow("P2", "s2"),
      poolRow("P3", "s3", { manualSold: true }),
      poolRow("P4", "s4", { soldGames: ["overwatch"] }),
      poolRow("P5", "s5", { claimedNote: "spent — eldorado sale" }),
      poolRow("P6", "s6"),
    ],
    ledgers: [
      heldLedger("L1", "P1", "one"),
      heldLedger("L2", "P2", "two", { drops: [{ name: "a" }] }),
      heldLedger("L3", "P3", "handsold"),
      heldLedger("L4", "P4", "soldgame"),
      heldLedger("L5", "P5", "spent"),
      heldLedger("L6", "P6", "onlisting"),
    ],
    listings: [{ _id: "R1", status: "active", marketplace: "gameflip", accountLogin: "onlisting", units: [] }],
  });
  try {
    await withServer(h, async (base) => {
      const dry = await (await post(base, "/api/unclaimed-auto/export-creds", { game: OW, dryRun: true })).json();
      assert.strictEqual(dry.free, 2, JSON.stringify(dry));
      assert.ok(h.Ledger.rows.every((l) => l.status === "skipped"), "a dry run changes nothing");

      const bad = await post(base, "/api/unclaimed-auto/export-creds", { game: OW });
      assert.strictEqual(bad.status, 400, "a sale needs a count");

      const res = await post(base, "/api/unclaimed-auto/export-creds", { game: OW, count: 1 });
      assert.strictEqual(res.status, 200);
      const text = await res.text();
      assert.strictEqual(text, "one:pw-P1\n", "the fullest account first");
      assert.strictEqual(res.headers.get("x-exported-count"), "1");
      assert.strictEqual(h.Ledger.rows.find((l) => l._id === "L1").status, "sold");
      assert.strictEqual(h.Pool.rows.find((p) => p._id === "P1").manualSold, true);
      assert.strictEqual(h.Ledger.rows.find((l) => l._id === "L2").status, "skipped", "only as many as asked");

      const again = await (await post(base, "/api/unclaimed-auto/export-creds", { game: OW, dryRun: true })).json();
      assert.strictEqual(again.free, 1, "a sold account is never offered again");
    });
  } finally {
    h.restore();
  }
});

test("bot page hand sale: marks the bot's free accounts sold and returns their logins", async () => {
  const cfg = {
    FavouriteGames: [OW],
    TwitchSettings: {
      TwitchUsers: [
        { Login: "first", ClientSecret: "s1", Id: "1" },
        { Login: "listed", ClientSecret: "s2", Id: "2" },
        { Login: "second", ClientSecret: "s3", Id: "3" },
        { Login: "third", ClientSecret: "s4", Id: "4" },
      ],
    },
  };
  const h = withStubs({
    fleetCfg: cfg,
    pool: [poolRow("P1", "s1"), poolRow("P2", "s2"), poolRow("P3", "s3"), poolRow("P4", "s4")],
    ledgers: [heldLedger("L2", "P2", "listed", { status: "listed", market: "gameflip" })],
  });
  try {
    await withServer(h, async (base) => {
      const r = await (await post(base, "/api/noclaim-farm/bots/14/hand-sell", { count: 2, format: "lpc" })).json();
      assert.strictEqual(r.success, true, JSON.stringify(r));
      assert.deepStrictEqual(r.lines, ["first:pw-P1:s1", "second:pw-P3:s3"]);
      assert.strictEqual(r.skipped.taken, 1, "the listed one was refused");
      const sold = h.Pool.rows.filter((p) => p.manualSold).map((p) => p._id);
      assert.deepStrictEqual(sold, ["P1", "P3"]);
      const created = h.Ledger.rows.filter((l) => l.status === "sold").map((l) => [l.loginLower, l.botId]);
      assert.deepStrictEqual(created, [["first", "14"], ["second", "14"]]);
      const none = await post(base, "/api/noclaim-farm/bots/14/hand-sell", {});
      assert.strictEqual(none.status, 400);
    });
  } finally {
    h.restore();
  }
});
