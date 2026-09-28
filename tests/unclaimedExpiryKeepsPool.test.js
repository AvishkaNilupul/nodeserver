/* global fetch, structuredClone */
// An expired no-claim account stays in its no-claim bot, so its pool row must
// stay claimed by the no-claim farm.
//
// expireAccount() used to call releaseToPool(), which marked the pool row
// "available" while the bot config still held the account. Every other system
// trusts the pool: on 2026-09-25 the auto-farm claimed 34 such accounts into a
// claiming Marvel Rivals bot, and 32 sat in two bots at once for 54 hours.
// releaseToPool() also freed ANY claimed row — including one the auto-farm had
// claimed — and the scan listed accounts whatever the pool said about them.
//
// Mongo/Pi/Twitch/marketplace-free: models, the bot-host transport, the Twitch
// inventory client and the log/alert sinks are stubbed via Module._load (the
// pattern of tests/noclaimPublishRoute.test.js), and the REAL engine runs on
// top — runOnce -> expirySalePass -> expireAccount, runOnce -> scanAndListPass,
// and releaseToPool. The Delist route is mounted in a throwaway express app
// behind a stub superadmin session.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const mongoose = require("mongoose");
const express = require("express");

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
  const values = Array.isArray(actual) ? actual : [actual];
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
  const writes = [];
  const clone = (d) => (d == null ? d : structuredClone(d));
  const query = (fn) => {
    let p = null;
    let lim = Infinity;
    const run = () => (p = p || Promise.resolve().then(() => fn(lim)));
    const q = {
      sort: () => q,
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
    find: (q) => query((lim) => rows.filter((r) => matches(r, q)).slice(0, lim).map(clone)),
    findOne: (q) => query(() => clone(rows.find((r) => matches(r, q)) || null)),
    findById: (id) => query(() => clone(rows.find((r) => String(r._id) === String(id)) || null)),
    exists: async (q) => (rows.some((r) => matches(r, q)) ? { _id: "x" } : null),
    countDocuments: async (q) => rows.filter((r) => matches(r, q)).length,
    distinct: async (field, q) => [...new Set(rows.filter((r) => matches(r, q)).map((r) => r[field]))],
    updateOne: (q, u) =>
      query(() => {
        writes.push({ q, u });
        const row = rows.find((r) => matches(r, q));
        if (!row) return { matchedCount: 0, modifiedCount: 0 };
        setFields(row, u);
        return { matchedCount: 1, modifiedCount: 1 };
      }),
    bulkWrite: async () => ({ ok: 1 }),
  };
}

// --- the engine on stubs ---------------------------------------------------
const BOTS = "/home/ubuntu/twitchbot-noclaim/bots/";
const cfgPath = (id) => BOTS + id + "/Configuration/config.json";
const GAME = "Rainbow Six Siege";
const OWNED = "noclaim-farm:" + GAME;

function botConfig(users, game = GAME) {
  return {
    FavouriteGames: [game],
    TwitchSettings: {
      TwitchUsers: users.map(([Login, ClientSecret]) => ({ Login, Id: "1", ClientSecret, Enabled: true })),
    },
  };
}

function ledgerRow(over = {}) {
  return {
    _id: "L1",
    source: "noclaim",
    status: "listed",
    login: "expiredacct",
    loginLower: "expiredacct",
    game: GAME,
    set: "S1",
    // Not gameflip: a listed Gameflip ledger with no live row triggers the
    // chain-repair publish, which is not what these tests are about.
    market: "digiseller",
    poolAccountId: "P1",
    botId: "17",
    container: "noclaim-bot-17",
    drops: [{ name: "Alpha Pack", game: GAME, campaign: "EWC 2026 DAY 1", itemKey: "alpha pack|rainbow six siege" }],
    listedAt: new Date(Date.now() - 2 * 86400000),
    lastCheckedAt: new Date(Date.now() - 20 * 60000),
    lotId: "",
    emptyReads: 0,
    firstEmptyAt: null,
    ...over,
  };
}

function poolRow(over = {}) {
  return {
    _id: "P1",
    status: "claimed",
    claimedNote: OWNED,
    clientSecret: "secret-1",
    soldGames: [],
    listed: true,
    manualSold: false,
    ...over,
  };
}

// Installs the stubs, loads a FRESH engine on them and hands back the fakes.
// `configs` maps a config path to a config object, or to the string
// "CORRUPT" for a file that does not parse. `inventory` maps a clientSecret to
// the Twitch inventory the stub returns for it.
function withEngine({ ledgers = [], pool = [], configs = {}, inventory = {} } = {}) {
  const Unclaimed = fakeModel(ledgers);
  const Pool = fakeModel(pool);
  const shell = [];
  const events = [];
  const usage = [];
  const mpCalls = [];
  const fetched = [];
  const hostsStub = {
    resolveHost: (id) => ({ id }),
    shq: (s) => "'" + String(s).replace(/'/g, "'\\''") + "'",
    async readFiles(_host, paths) {
      const out = {};
      for (const p of paths) {
        const c = configs[p];
        if (c === "CORRUPT") out[p] = { ok: true, text: "{ not json" };
        else if (c) out[p] = { ok: true, text: JSON.stringify(c) };
        else out[p] = { ok: false };
      }
      return out;
    },
    async runShell(_host, script, opts = {}) {
      shell.push(script);
      if (script.startsWith("ls -1d ")) return { stdout: Object.keys(configs).join("\n") };
      const read = /^\[ -f '([^']+)' \]/.exec(script);
      if (read) {
        const c = configs[read[1]];
        return { stdout: c && c !== "CORRUPT" ? JSON.stringify(c) : "" };
      }
      const write = /^cat > '([^']+)'/.exec(script);
      if (write) configs[write[1]] = JSON.parse(opts.input);
      return { stdout: "" };
    },
  };
  // Any marketplace call would be a bug in these scenarios: record it and fail
  // it rather than let it reach the network.
  const mpStub = new Proxy(
    {},
    {
      get: (_t, k) =>
        typeof k === "symbol" || k === "then"
          ? undefined
          : () => {
              mpCalls.push(String(k));
              return Promise.reject(new Error("unexpected marketplace call " + String(k)));
            },
    },
  );
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), Unclaimed],
    [require.resolve("../models/AvailableAccount"), Pool],
    [require.resolve("../models/MarketplaceListing"), fakeModel([])],
    [require.resolve("../models/NoclaimSpentAccount"), fakeModel([])],
    [require.resolve("../models/BotAccount"), fakeModel([])],
    [require.resolve("../models/DropSet"), fakeModel([])],
    [require.resolve("../models/TwitchCampaign"), fakeModel([])],
    [require.resolve("../utils/botHosts"), hostsStub],
    [
      require.resolve("../utils/twitchInventory"),
      {
        fetchInventory: async (secret) => {
          fetched.push(secret);
          return structuredClone(inventory[secret] || { twitchId: "1", login: "", drops: [], inProgress: [] });
        },
      },
    ],
    [require.resolve("../utils/marketplaces"), mpStub],
    [require.resolve("../utils/telegram"), { sendTelegram: async () => {} }],
    [require.resolve("../utils/systemLog"), { logEvent: (e) => events.push(e), actorFromReq: () => "test" }],
    [require.resolve("../utils/poolUsageLog"), { recordPoolUsage: async (ids, ev) => usage.push({ ids, ...ev }) }],
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
  // runOnce takes the cross-process run lock in Mongo; grant it to this process.
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
  return { engine, restore, Unclaimed, Pool, configs, shell, events, usage, mpCalls, fetched, errors };
}

const poolWentAvailable = (Pool) =>
  Pool.writes.some((w) => w.u && w.u.$set && w.u.$set.status === "available");
const configWrites = (shell) => shell.filter((s) => s.startsWith("cat > "));

// --- expiry ------------------------------------------------------------------

test("expiry takes the unit off sale but keeps the pool row claimed by the no-claim farm", async () => {
  // One empty read already on record, 30 minutes ago: this empty read confirms
  // the expiry (unclaimedExpiryConfirmPasses = 2).
  const h = withEngine({
    ledgers: [ledgerRow({ emptyReads: 1, firstEmptyAt: new Date(Date.now() - 30 * 60000) })],
    pool: [poolRow()],
    configs: { [cfgPath("17")]: botConfig([["expiredacct", "secret-1"], ["keeper", "secret-2"]]) },
    inventory: { "secret-1": { twitchId: "1", login: "expiredacct", drops: [], inProgress: [] } },
  });
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.ok(run && run.check, "the check pass ran");
    assert.strictEqual(run.check.expired, 1);
    assert.strictEqual(run.check.released, 0, "expiry never returns an account to the pool");

    const ledger = h.Unclaimed.rows[0];
    assert.strictEqual(ledger.status, "expired");
    assert.strictEqual(ledger.releasedAt, null);
    assert.match(ledger.note, /still farming in its no-claim bot/);

    const pool = h.Pool.rows[0];
    assert.strictEqual(poolWentAvailable(h.Pool), false, "pool row must never go available while a bot holds it");
    assert.strictEqual(pool.status, "claimed");
    assert.strictEqual(pool.claimedNote, OWNED, "the no-claim farm still owns it");
    assert.strictEqual(pool.listed, false, "the owner 'listed' tick is cleared — it is off sale");
    assert.deepStrictEqual(h.usage.filter((u) => u.event === "released"), []);

    // The account stays in its bot: nothing rewrites the config.
    assert.deepStrictEqual(configWrites(h.shell), []);
    assert.deepStrictEqual(
      h.configs[cfgPath("17")].TwitchSettings.TwitchUsers.map((u) => u.Login),
      ["expiredacct", "keeper"],
    );
    const ev = h.events.find((e) => e.action === "expired");
    assert.ok(ev, "expiry is logged");
    assert.match(ev.detail, /kept in its no-claim bot, pool row unchanged/);
    assert.deepStrictEqual(h.mpCalls, []);
    assert.deepStrictEqual(h.errors.filter((e) => /expiry pass error/.test(e)), []);
  } finally {
    h.restore();
  }
});

test("a single empty read is still only a strike, not an expiry", async () => {
  const h = withEngine({
    ledgers: [ledgerRow()],
    pool: [poolRow()],
    configs: { [cfgPath("17")]: botConfig([["expiredacct", "secret-1"]]) },
  });
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.strictEqual(run.check.expired, 0);
    assert.strictEqual(run.check.emptyStrikes, 1);
    assert.strictEqual(h.Unclaimed.rows[0].status, "listed");
    assert.strictEqual(h.Pool.rows[0].status, "claimed");
  } finally {
    h.restore();
  }
});

// --- releaseToPool -------------------------------------------------------------

const EXPIRED = { status: "expired" };

test("releaseToPool refuses while a no-claim bot still holds the account", async () => {
  const h = withEngine({
    ledgers: [ledgerRow(EXPIRED)],
    pool: [poolRow()],
    configs: { [cfgPath("17")]: botConfig([["expiredacct", "secret-1"]]) },
  });
  try {
    assert.strictEqual(await h.engine.releaseToPool(h.Unclaimed.rows[0]), false);
    assert.strictEqual(poolWentAvailable(h.Pool), false);
    assert.strictEqual(h.Pool.rows[0].claimedNote, OWNED);
    assert.deepStrictEqual(h.usage, []);
  } finally {
    h.restore();
  }
});

test("releaseToPool refuses to free a pool row another system claimed (the 2026-09-25 case)", async () => {
  // The auto-farm claimed the account for Marvel Rivals; a stale no-claim
  // ledger for it expiring must not hand it back to the pool under the
  // auto-farm's feet — even when no no-claim bot holds it any more.
  const h = withEngine({
    ledgers: [ledgerRow(EXPIRED)],
    pool: [poolRow({ claimedNote: "auto-farm: Marvel Rivals (52e2bff5)" })],
    configs: { [cfgPath("18")]: botConfig([["someoneelse", "secret-9"]]) },
  });
  try {
    assert.strictEqual(await h.engine.releaseToPool(h.Unclaimed.rows[0]), false);
    assert.strictEqual(poolWentAvailable(h.Pool), false);
    assert.strictEqual(h.Pool.rows[0].status, "claimed");
    assert.strictEqual(h.Pool.rows[0].claimedNote, "auto-farm: Marvel Rivals (52e2bff5)");
  } finally {
    h.restore();
  }
});

test("releaseToPool fails closed when any bot config cannot be read", async () => {
  const h = withEngine({
    ledgers: [ledgerRow(EXPIRED)],
    pool: [poolRow()],
    configs: {
      [cfgPath("18")]: botConfig([["someoneelse", "secret-9"]]),
      [cfgPath("19")]: "CORRUPT", // might be the one that holds it
    },
  });
  try {
    assert.strictEqual(await h.engine.releaseToPool(h.Unclaimed.rows[0]), false);
    assert.strictEqual(poolWentAvailable(h.Pool), false);
  } finally {
    h.restore();
  }
});

test("releaseToPool fails closed when the config listing comes back empty", async () => {
  // `ls … || true` turns a failed listing into no output; the fleet is never
  // empty, so "no configs" must not read as "no bot holds it".
  const h = withEngine({ ledgers: [ledgerRow(EXPIRED)], pool: [poolRow()], configs: {} });
  try {
    assert.strictEqual(await h.engine.releaseToPool(h.Unclaimed.rows[0]), false);
    assert.strictEqual(poolWentAvailable(h.Pool), false);
  } finally {
    h.restore();
  }
});

test("releaseToPool refuses an account that is still on sale, or sold", async () => {
  for (const status of ["listed", "manual", "sold", "removed"]) {
    const h = withEngine({
      ledgers: [ledgerRow({ status })],
      pool: [poolRow()],
      configs: { [cfgPath("18")]: botConfig([["someoneelse", "secret-9"]]) },
    });
    try {
      assert.strictEqual(await h.engine.releaseToPool(h.Unclaimed.rows[0]), false, status);
      assert.strictEqual(poolWentAvailable(h.Pool), false, status);
    } finally {
      h.restore();
    }
  }
});

test("releaseToPool refuses a hand-sold (manualSold) account", async () => {
  const h = withEngine({
    ledgers: [ledgerRow(EXPIRED)],
    pool: [poolRow({ manualSold: true })],
    configs: { [cfgPath("18")]: botConfig([["someoneelse", "secret-9"]]) },
  });
  try {
    assert.strictEqual(await h.engine.releaseToPool(h.Unclaimed.rows[0]), false);
    assert.strictEqual(poolWentAvailable(h.Pool), false);
  } finally {
    h.restore();
  }
});

test("releaseToPool frees the row once no bot holds the account and the farm owns it", async () => {
  const h = withEngine({
    ledgers: [ledgerRow(EXPIRED)],
    pool: [poolRow()],
    configs: { [cfgPath("18")]: botConfig([["someoneelse", "secret-9"]]) },
  });
  try {
    assert.strictEqual(await h.engine.releaseToPool(h.Unclaimed.rows[0]), true);
    const pool = h.Pool.rows[0];
    assert.strictEqual(pool.status, "available");
    assert.strictEqual(pool.claimedAt, null);
    assert.match(pool.claimedNote, /^released — left the no-claim farm/);
    const ledger = h.Unclaimed.rows[0];
    assert.strictEqual(ledger.status, "expired", "sold by nothing once it has left every bot");
    assert.ok(ledger.releasedAt instanceof Date);
    assert.deepStrictEqual(h.usage.map((u) => u.event), ["released"]);
  } finally {
    h.restore();
  }
});

// --- the scan only lists the no-claim farm's own accounts --------------------

test("poolOwnerBlock: only a row the no-claim farm claimed is sellable", () => {
  const { poolOwnerBlock } = require("../utils/unclaimedAutoList");
  assert.strictEqual(poolOwnerBlock({ status: "claimed", claimedNote: "noclaim-farm:Overwatch" }), "");
  assert.strictEqual(poolOwnerBlock({ status: "claimed", claimedNote: "NoClaim-Farm:overwatch" }), "");
  assert.strictEqual(poolOwnerBlock(null), "no pool row");
  assert.strictEqual(poolOwnerBlock({ status: "available", claimedNote: "" }), "pool row is available");
  assert.match(poolOwnerBlock({ status: "claimed", claimedNote: "auto-farm: EA Sports FC 27 (4c30)" }), /^pool says: auto-farm/);
  assert.match(poolOwnerBlock({ status: "claimed", claimedNote: "rented to bulkseller" }), /^pool says: rented to/);
  assert.match(poolOwnerBlock({ status: "claimed", claimedNote: "" }), /\(no note\)/);
});

test("the scan never reads or lists an account the pool says another system owns", async () => {
  const h = withEngine({
    pool: [
      poolRow({ _id: "PA", clientSecret: "s-ours", listed: false }),
      poolRow({ _id: "PB", clientSecret: "s-free", status: "available", claimedNote: "", listed: false }),
      poolRow({ _id: "PC", clientSecret: "s-autofarm", claimedNote: "auto-farm: EA Sports FC 27 (4c30)", listed: false }),
    ],
    configs: {
      [cfgPath("13")]: botConfig(
        [
          ["ouracct", "s-ours"],
          ["freeacct", "s-free"],
          ["autofarmacct", "s-autofarm"],
        ],
        "Overwatch",
      ),
    },
  });
  try {
    const run = await h.engine.runOnce({ check: false });
    const scan = run.scan;
    assert.ok(scan, "the scan pass ran");
    // Only the farm's own account costs a Twitch read; the other two are
    // skipped before any read, and reported.
    assert.deepStrictEqual(h.fetched, ["s-ours"]);
    assert.strictEqual(scan.notOwned, 2);
    assert.deepStrictEqual(
      scan.notOwnedSample.map((x) => x.login + " — " + x.why),
      ["freeacct — pool row is available", "autofarmacct — pool says: auto-farm: EA Sports FC 27 (4c30)"],
    );
    assert.strictEqual(scan.listed, 0);
    assert.deepStrictEqual(h.mpCalls, []);
    assert.strictEqual(poolWentAvailable(h.Pool), false);
  } finally {
    h.restore();
  }
});

// --- the operator's Delist -----------------------------------------------------

async function withDelistRoute(ledger, engineStub, fn) {
  const Unclaimed = fakeModel([ledger]);
  const events = [];
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), Unclaimed],
    [require.resolve("../utils/unclaimedAutoList"), engineStub],
    [require.resolve("../utils/systemLog"), { logEvent: (e) => events.push(e), actorFromReq: () => "root" }],
  ]);
  const routerPath = require.resolve("../routes/unclaimedAutoRoutes");
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
  delete require.cache[routerPath];
  let server;
  try {
    const app = express();
    app.use(express.json());
    // Stub session: exactly what requireSuperadmin reads.
    app.use((req, _res, next) => {
      req.session = { admin: { id: "root", username: "root", role: "superadmin", tfa: true } };
      next();
    });
    app.use(require("../routes/unclaimedAutoRoutes"));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const base = "http://127.0.0.1:" + server.address().port;
    const post = async (body) => {
      const res = await fetch(base + "/api/unclaimed-auto/delist/" + ledger._id, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    };
    await fn({ post, events });
  } finally {
    if (server) await new Promise((r) => server.close(r));
    Module._load = origLoad;
    delete require.cache[routerPath];
  }
}

function engineSpy({ release = false } = {}) {
  const calls = [];
  return {
    calls,
    expireAccount: async (l) => {
      calls.push(["expire", l.status]);
      return true;
    },
    releaseToPool: async (l) => {
      calls.push(["release", l.login]);
      return release;
    },
  };
}

const LEDGER_ID = "65f0a1b2c3d4e5f6a7b8c9d0";

test("Delist takes a listed account off sale and does not ask for a pool return", async () => {
  const spy = engineSpy();
  await withDelistRoute(ledgerRow({ _id: LEDGER_ID }), spy, async ({ post, events }) => {
    const r = await post({});
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.deepStrictEqual(r.json, { success: true, expired: true, released: false });
    assert.deepStrictEqual(spy.calls, [["expire", "listed"]]);
    assert.strictEqual(events[0].action, "manual_delist");
    assert.strictEqual(events[0].detail, "operator removed digiseller unit");
  });
});

test("Delist with release asks the guarded releaseToPool and reports a refusal", async () => {
  const spy = engineSpy({ release: false });
  await withDelistRoute(ledgerRow({ _id: LEDGER_ID }), spy, async ({ post, events }) => {
    const r = await post({ release: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.released, false);
    assert.deepStrictEqual(spy.calls, [["expire", "listed"], ["release", "expiredacct"]]);
    assert.match(events[0].detail, /pool return refused/);
  });
});

test("Delist refuses an account that is not listed (a stale page must not free a sold one)", async () => {
  for (const status of ["sold", "removed", "expired", "manual"]) {
    const spy = engineSpy({ release: true });
    await withDelistRoute(ledgerRow({ _id: LEDGER_ID, status }), spy, async ({ post, events }) => {
      const r = await post({ release: true });
      assert.strictEqual(r.status, 409, status);
      assert.match(r.json.message, new RegExp("not listed \\(" + status + "\\)"));
      assert.deepStrictEqual(spy.calls, [], status + ": nothing touched");
      assert.deepStrictEqual(events, []);
    });
  }
});
