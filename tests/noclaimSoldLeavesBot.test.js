/* global fetch, structuredClone */
// A SOLD no-claim account leaves its bot and goes to the recycler (owner's rule,
// 2026-09-28); an unsold one whose event ended stays and farms the next event.
//
// Before: a sale through a by-game offer only flipped the ledger to "sold", the
// hand-sold tick deliberately left the account farming, a spend looked for the
// account only in the ledger's remembered bot (by login) with an unlocked
// in-place write, and "a buyer claimed a listed drop" never fired — 114 sold
// accounts were still in bots on 2026-09-28, and the bot page's "Copy unsold"
// offered sold ones.
//
// Mongo/host/Twitch/marketplace-free: models, the fleet host, the Twitch
// inventory and the log sinks are stubbed via Module._load; the REAL engine
// (runOnce -> scanAndListPass -> retireSoldFromBots, expirySalePass ->
// buyerClaimedListed -> spendAccount) and the REAL accounts route run on top.
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
    bulkWrite: async (ops) => {
      for (const op of ops) {
        const { filter, update } = op.updateOne;
        writes.push({ q: filter, u: update, bulk: true });
        const row = rows.find((r) => matches(r, filter));
        if (row) setFields(row, update);
      }
      return { ok: 1 };
    },
  };
}

// --- the fleet host --------------------------------------------------------
const BOTS = "/home/ubuntu/twitchbot-noclaim/bots";
const cfgPath = (id) => BOTS + "/" + id + "/Configuration/config.json";
const OW = "Overwatch";
function botConfig(accounts, game = OW) {
  return {
    FavouriteGames: [game],
    TwitchSettings: {
      TwitchUsers: accounts.map(([Login, ClientSecret]) => ({ Login, Id: "1", ClientSecret, Enabled: true })),
    },
  };
}

// A host that behaves like the real one for every command the engine sends:
// the config listing, batched reads, `[ -f ] && cat` reads, `cat > tmp && mv`
// writes, the .personal marker listing, running-aware restarts and stops.
function fakeFleet({ configs = {}, running = [], personal = [], unreadable = [] } = {}) {
  const state = { configs, running: new Set(running), personal: new Set(personal), unreadable: new Set(unreadable) };
  const log = { shell: [], writes: [], restarts: [], stops: [], markers: [] };
  const idOf = (p) => String(p).split("/")[5];
  const text = (id) => (state.unreadable.has(id) ? "{ not json" : JSON.stringify(state.configs[id]));
  const hosts = {
    resolveHost: (id) => ({ id }),
    shq: (s) => "'" + String(s).replace(/'/g, "'\\''") + "'",
    async readFiles(_host, paths) {
      const out = {};
      for (const p of paths) out[p] = state.configs[idOf(p)] ? { ok: true, text: text(idOf(p)) } : { ok: false };
      return out;
    },
    async runShell(_host, script, opts = {}) {
      log.shell.push(script);
      if (script.startsWith("ls -1d ")) {
        return { stdout: Object.keys(state.configs).map(cfgPath).join("\n") };
      }
      if (script.startsWith("for d in ")) return { stdout: [...state.personal].join("\n") };
      const read = /^\[ -f '([^']+)' \]/.exec(script);
      if (read) {
        const id = idOf(read[1]);
        return { stdout: state.configs[id] ? text(id) : "" };
      }
      const write = /^cat > '([^']+)'(?: && mv '[^']+' '([^']+)')?/.exec(script);
      if (write) {
        const id = idOf(write[2] || write[1]);
        state.configs[id] = JSON.parse(opts.input);
        log.writes.push(id);
        return { stdout: "" };
      }
      const inspect = /docker inspect -f '\{\{\.State\.Running\}\}' 'noclaim-bot-(\d+)'/.exec(script);
      if (inspect) {
        if (state.running.has(inspect[1])) {
          log.restarts.push(inspect[1]);
          return { stdout: "restarted" };
        }
        return { stdout: "" };
      }
      const touch = /^touch '[^']+\/(\d+)\/\.operatoroff'; docker stop 'noclaim-bot-(\d+)'/.exec(script);
      if (touch) {
        log.markers.push(touch[1]);
        log.stops.push(touch[2]);
        state.running.delete(touch[2]);
        return { stdout: "" };
      }
      return { stdout: "" };
    },
  };
  return { hosts, state, log };
}

// Installs the stubs, loads a FRESH engine on them.
function withEngine({ ledgers = [], pool = [], listings = [], bots = [], fleet, inventory = {}, autoFarm = {} } = {}) {
  const m = {
    Unclaimed: fakeModel(ledgers),
    Pool: fakeModel(pool),
    Listing: fakeModel(listings),
    Spent: fakeModel([]),
  };
  const events = [];
  const usage = [];
  const mpCalls = [];
  const fetched = [];
  const telegrams = [];
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
  const realSettings = require("../utils/settings");
  const settingsStub = new Proxy(realSettings, {
    get: (t, k) =>
      k === "getAutoFarm" ? () => ({ ...t.getAutoFarm(), ...autoFarm }) : t[k],
  });
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), m.Unclaimed],
    [require.resolve("../models/AvailableAccount"), m.Pool],
    [require.resolve("../models/MarketplaceListing"), m.Listing],
    [require.resolve("../models/NoclaimSpentAccount"), m.Spent],
    [require.resolve("../models/BotAccount"), fakeModel(bots)],
    [require.resolve("../models/DropSet"), fakeModel([])],
    [require.resolve("../models/TwitchCampaign"), fakeModel([])],
    [require.resolve("../utils/botHosts"), fleet.hosts],
    [require.resolve("../utils/settings"), settingsStub],
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
    [require.resolve("../utils/telegram"), { sendTelegram: async (t) => telegrams.push(t) }],
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
  return { engine, restore, ...m, fleet, events, usage, mpCalls, fetched, telegrams, errors };
}

const HOUR = 3600000;
const ago = (ms) => new Date(Date.now() - ms);
const OWNED = "noclaim-farm:Overwatch";
const pool = (id, secret, over = {}) => ({
  _id: id,
  clientSecret: secret,
  status: "claimed",
  claimedNote: OWNED,
  claimedAt: ago(30 * 24 * HOUR),
  soldGames: [],
  listed: false,
  manualSold: false,
  ...over,
});
const soldLedger = (id, poolId, login, over = {}) => ({
  _id: id,
  source: "noclaim",
  status: "sold",
  login,
  loginLower: login,
  game: OW,
  poolAccountId: poolId,
  market: "eldorado",
  soldMarket: "",
  soldAt: ago(2 * 24 * HOUR),
  soldPriceUsd: 0,
  manualListing: "",
  ...over,
});
const loginsOf = (fleet, id) =>
  ((fleet.state.configs[id] || {}).TwitchSettings || { TwitchUsers: [] }).TwitchUsers.map((u) => u.Login);

// --- 1. the rule -----------------------------------------------------------------

test("soldRetireReason: who leaves the bot, and when", () => {
  const { soldRetireReason } = require("../utils/unclaimedAutoList");
  const now = Date.now();
  const p = { claimedAt: ago(30 * 24 * HOUR), manualSold: false };
  assert.strictEqual(soldRetireReason(null, null, now), "");
  assert.strictEqual(soldRetireReason(p, null, now), "", "unsold stays");
  assert.strictEqual(soldRetireReason({ ...p, manualSold: true }, null, now), "sold by hand");
  assert.strictEqual(
    soldRetireReason(p, { status: "sold", market: "eldorado", soldAt: ago(2 * HOUR) }, now),
    "eldorado sale",
  );
  assert.strictEqual(
    soldRetireReason(p, { status: "sold", market: "eldorado", soldAt: ago(10 * 60000) }, now),
    "",
    "a claim-at-sale order is still settling for the first hour",
  );
  assert.strictEqual(
    soldRetireReason(p, { status: "sold", market: "eldorado", manualListing: "row-1", soldAt: ago(5 * HOUR) }, now),
    "",
    "an owner listing's unit waits for its delivery to be recorded",
  );
  assert.strictEqual(
    soldRetireReason(
      p,
      { status: "sold", market: "gameflip", manualListing: "row-1", manualDeliveredAt: ago(HOUR) },
      now,
    ),
    "gameflip sale",
  );
  assert.strictEqual(
    soldRetireReason(
      { ...p, claimedAt: ago(HOUR) },
      { status: "sold", market: "eldorado", soldAt: ago(3 * 24 * HOUR) },
      now,
    ),
    "",
    "recycled and claimed into a bot again after the sale — that sale is history",
  );
  assert.strictEqual(
    soldRetireReason(p, { status: "removed", market: "gameflip", soldAt: ago(3 * 24 * HOUR) }, now),
    "",
    "a removed ledger whose Sold tick was taken back is not sold",
  );
});

// --- 2. the retire pass ---------------------------------------------------------------

function fleetFixture(over = {}) {
  return fakeFleet({
    configs: {
      14: botConfig([["eldsold", "s-eld"], ["waiting", "s-wait"], ["double", "s-dbl"], ["unsold", "s-free"]]),
      15: botConfig([["handsold", "s-hand"], ["rented", "s-rent"], ["double", "s-dbl"], ["recycled", "s-rec"]]),
      16: botConfig([["lastone", "s-last"]]),
      38: botConfig([["mine", "s-mine"]]),
    },
    running: ["14"],
    personal: ["38"],
    ...over,
  });
}
function engineFixture(fleet, over = {}) {
  return withEngine({
    fleet,
    pool: [
      pool("P-eld", "s-eld"),
      pool("P-wait", "s-wait"),
      pool("P-dbl", "s-dbl", { manualSold: true }),
      pool("P-free", "s-free"),
      pool("P-hand", "s-hand", { manualSold: true }),
      pool("P-rent", "s-rent", { manualSold: true, claimedNote: "rented to bulkseller" }),
      pool("P-rec", "s-rec", { claimedAt: ago(HOUR) }),
      pool("P-last", "s-last", { manualSold: true, soldGames: ["rainbow six siege"] }),
      pool("P-mine", "s-mine", { manualSold: true, claimedNote: "unclaimed stock — 10 drops" }),
    ],
    ledgers: [
      soldLedger("L-eld", "P-eld", "eldsold"),
      soldLedger("L-wait", "P-wait", "waiting", { soldAt: ago(10 * 60000) }),
      soldLedger("L-rec", "P-rec", "recycled", { soldAt: ago(3 * 24 * HOUR) }),
    ],
    listings: [
      {
        _id: "R-eld",
        marketplace: "eldorado",
        status: "active",
        price: 1.21,
        units: [{ contentId: "L-eld", login: "eldsold", deliveredAt: ago(2 * 24 * HOUR) }],
      },
    ],
    ...over,
  });
}

test("retire pass: sold accounts leave their bots and go to the recycler; nothing else moves", async () => {
  const fleet = fleetFixture();
  const h = engineFixture(fleet);
  try {
    const run = await h.engine.runOnce({ check: false });
    const r = run.scan.retire;
    assert.deepStrictEqual(
      { retired: r.retired, waiting: r.waiting, skippedPersonal: r.skippedPersonal, skippedRented: r.skippedRented, bots: r.bots },
      { retired: 4, waiting: 1, skippedPersonal: 1, skippedRented: 1, bots: 3 },
      JSON.stringify(r),
    );
    assert.deepStrictEqual(r.errors, []);

    // Out of every bot they were in — including both homes of a double-homed one.
    assert.deepStrictEqual(loginsOf(fleet, "14"), ["waiting", "unsold"]);
    assert.deepStrictEqual(loginsOf(fleet, "15"), ["rented", "recycled"]);
    assert.deepStrictEqual(loginsOf(fleet, "16"), []);
    assert.deepStrictEqual(loginsOf(fleet, "38"), ["mine"], "a personal bot is never touched");

    // One edit per bot; only the running bot restarts; the emptied bot is parked
    // for good (.operatoroff) so the watcher cannot start an empty config.
    assert.deepStrictEqual(fleet.log.writes.sort(), ["14", "15", "16"]);
    assert.deepStrictEqual(fleet.log.restarts, ["14"]);
    assert.deepStrictEqual(fleet.log.markers, ["16"]);
    assert.deepStrictEqual(fleet.log.stops, ["16"]);

    // Handed to the recycler: a "spent — …" note and the sold game.
    const p = (id) => h.Pool.rows.find((x) => x._id === id);
    assert.strictEqual(p("P-eld").claimedNote, "spent — eldorado sale (taken out of no-claim bot 14)");
    assert.deepStrictEqual(p("P-eld").soldGames, ["overwatch"]);
    assert.strictEqual(p("P-hand").claimedNote, "spent — sold by hand (taken out of no-claim bot 15)");
    assert.strictEqual(p("P-dbl").claimedNote, "spent — sold by hand (taken out of no-claim bot 14, 15)");
    assert.deepStrictEqual(p("P-last").soldGames, ["rainbow six siege", "overwatch"], "keeps what it had");
    for (const id of ["P-wait", "P-free", "P-rent", "P-rec", "P-mine"]) {
      assert.ok(!/^spent — /.test(p(id).claimedNote), id + " must not be handed to the recycler");
    }
    assert.strictEqual(p("P-rent").claimedNote, "rented to bulkseller");
    assert.strictEqual(
      h.usage.filter((u) => u.event === "spent").length,
      4,
      "one spent usage event per retired account",
    );

    // The by-game sale finally has its price (from the offer that delivered it).
    const eld = h.Unclaimed.rows.find((x) => x._id === "L-eld");
    assert.strictEqual(eld.soldPriceUsd, 1.21);
    assert.strictEqual(eld.soldMarket, "eldorado");
    assert.match(eld.note, /handed to the recycler/);
    assert.strictEqual(h.Unclaimed.rows.find((x) => x._id === "L-wait").status, "sold");

    // The no-claim page's spent view shows them.
    assert.deepStrictEqual(
      h.Spent.rows.map((x) => x.loginLower).sort(),
      ["double", "eldsold", "handsold", "lastone"],
    );
    const ev = h.events.find((e) => e.action === "sold_retired");
    assert.ok(ev && ev.count === 4, "one summary event");
    assert.deepStrictEqual(h.telegrams, [], "no per-account alert for old sales");
    assert.deepStrictEqual(h.mpCalls, []);
  } finally {
    h.restore();
  }
});

test("retire pass: a second run finds nothing left to do", async () => {
  const fleet = fleetFixture();
  const h = engineFixture(fleet);
  try {
    await h.engine.runOnce({ check: false });
    const writes = fleet.log.writes.length;
    const run2 = await h.engine.runOnce({ check: false });
    assert.strictEqual(run2.scan.retire.retired, 0);
    assert.strictEqual(fleet.log.writes.length, writes, "no further config edits");
  } finally {
    h.restore();
  }
});

test("retire pass: an unreadable config means nothing is taken out this pass (fail closed)", async () => {
  const fleet = fleetFixture({ unreadable: ["15"] });
  const h = engineFixture(fleet);
  try {
    const run = await h.engine.runOnce({ check: false });
    assert.strictEqual(run.scan.retire.retired, 0);
    assert.match(run.scan.retire.errors.join(" "), /unreadable/);
    assert.deepStrictEqual(fleet.log.writes, []);
    assert.ok(h.Pool.rows.every((x) => !/^spent — /.test(x.claimedNote)));
  } finally {
    h.restore();
  }
});

test("retire pass: the kill switch unclaimedRetireSold=false turns it off", async () => {
  const fleet = fleetFixture();
  const h = engineFixture(fleet, { autoFarm: { unclaimedRetireSold: false } });
  try {
    const run = await h.engine.runOnce({ check: false });
    assert.strictEqual(run.scan.retire.off, true);
    assert.deepStrictEqual(fleet.log.writes, []);
  } finally {
    h.restore();
  }
});

test("retire pass: another system's pool note is never overwritten; a stale Bots-page note is", async () => {
  const fleet = fakeFleet({
    configs: { 20: botConfig([["farmedtoo", "s-af"], ["legacy", "s-leg"], ["keep", "s-keep"]]) },
  });
  const h = withEngine({
    fleet,
    pool: [
      // Hand-sold, but the auto-farm has since deployed it too (a double home).
      pool("P-af", "s-af", { manualSold: true, claimedNote: "auto-farm: Marvel Rivals (52e2bff5)" }),
      // Hand-sold; its note is the Bots page's from before the 08-26 migration.
      pool("P-leg", "s-leg", { manualSold: true, claimedNote: "deployed to twitchbotx19 [local]" }),
      pool("P-keep", "s-keep"),
    ],
    // The auto-farm's copy is a managed deploy (BotAccount.configFile).
    bots: [{ _id: "B-af", clientSecret: "s-af", configFile: "config_53.json", enabled: true }],
  });
  try {
    const run = await h.engine.runOnce({ check: false });
    const r = run.scan.retire;
    assert.strictEqual(r.retired, 2, JSON.stringify(r));
    assert.strictEqual(r.foreignOwner, 1);
    assert.deepStrictEqual(loginsOf(fleet, "20"), ["keep"], "both leave the no-claim bot");
    const p = (id) => h.Pool.rows.find((x) => x._id === id);
    assert.strictEqual(p("P-af").claimedNote, "auto-farm: Marvel Rivals (52e2bff5)", "the auto-farm's record stays");
    assert.deepStrictEqual(p("P-af").soldGames, ["overwatch"], "but the sold game is still recorded");
    assert.strictEqual(p("P-leg").claimedNote, "spent — sold by hand (taken out of no-claim bot 20)");
  } finally {
    h.restore();
  }
});

test("retire pass: only personal-bot accounts to consider costs no fleet read", async () => {
  const fleet = fakeFleet({ configs: { 38: botConfig([["mine", "s-mine"]]) }, personal: ["38"] });
  const h = withEngine({
    fleet,
    pool: [pool("P-mine", "s-mine", { manualSold: true })],
  });
  try {
    const run = await h.engine.runOnce({ check: false });
    assert.strictEqual(run.scan.retire.skippedPersonal, 1);
    assert.strictEqual(
      fleet.log.shell.filter((s) => s.startsWith("ls -1d ")).length,
      1,
      "only the scan's own config read",
    );
    assert.deepStrictEqual(fleet.log.writes, []);
  } finally {
    h.restore();
  }
});

// --- 3. a spend finds the account where it really is --------------------------------

test("spendAccount: takes the account out of the bot it is really in (the ledger's botId is stale)", async () => {
  const fleet = fakeFleet({
    configs: { 14: botConfig([["keeper", "s-keep"]]), 15: botConfig([["buyerone", "s-buy"], ["other", "s-o"]]) },
    running: [],
  });
  const h = withEngine({
    fleet,
    pool: [pool("P-buy", "s-buy")],
    ledgers: [{ ...soldLedger("L-buy", "P-buy", "buyerone"), status: "listed", market: "gameflip", botId: "14", container: "noclaim-bot-14" }],
  });
  try {
    await h.engine.spendAccount(h.Unclaimed.rows[0], "gameflip sale", { removeFromProduct: false });
    assert.deepStrictEqual(loginsOf(fleet, "15"), ["other"], "removed from bot 15 where it lives");
    assert.deepStrictEqual(loginsOf(fleet, "14"), ["keeper"], "the stale bot is untouched");
    assert.deepStrictEqual(fleet.log.restarts, [], "a parked bot is not woken");
    const p = h.Pool.rows[0];
    assert.strictEqual(p.claimedNote, "spent — unclaimed auto-listed (gameflip sale)");
    assert.strictEqual(h.Spent.rows[0].botId, "15");
  } finally {
    h.restore();
  }
});

test("spendAccount: no pool stamp when the account cannot be proven out of every bot", async () => {
  const fleet = fakeFleet({
    configs: { 15: botConfig([["buyerone", "s-buy"]]), 16: botConfig([["x", "s-x"]]) },
    unreadable: ["16"],
  });
  const h = withEngine({
    fleet,
    pool: [pool("P-buy", "s-buy")],
    ledgers: [{ ...soldLedger("L-buy", "P-buy", "buyerone"), status: "listed", market: "gameflip" }],
  });
  try {
    await h.engine.spendAccount(h.Unclaimed.rows[0], "gameflip sale", { removeFromProduct: false });
    assert.strictEqual(h.Pool.rows[0].claimedNote, OWNED, "stays claimed, unstamped — the pass retries");
    assert.strictEqual(h.Unclaimed.rows[0].status, "sold", "the sale itself is still recorded");
  } finally {
    h.restore();
  }
});

// --- 4. a buyer's claim on a listed drop ------------------------------------------------

test("buyerClaimedListed: a sale needs BOTH a lost listed copy and a matching claim", () => {
  const { buyerClaimedListed } = require("../utils/unclaimedAutoList");
  const listedAt = ago(2 * 24 * HOUR);
  const ledger = {
    listedAt,
    drops: [
      { name: "Esports Loot Box", campaign: "BlizzCon Day 1" },
      { name: "Esports Loot Box", campaign: "BlizzCon Day 2" },
      { name: "Boba Buddy Icon", campaign: "BlizzCon Day 1" },
    ],
  };
  const held = (names) => names.map((name) => ({ name }));
  const claimedIn = (name, campaign) => ({ name, campaign, claimed: true, percent: 100 });

  assert.strictEqual(
    buyerClaimedListed(ledger, { inProgress: [claimedIn("Boba Buddy Icon", "BlizzCon Day 1")], drops: [] },
      held(["Esports Loot Box", "Esports Loot Box"])).claimed,
    true,
    "claimed inside a running campaign",
  );
  assert.strictEqual(
    buyerClaimedListed(ledger, { inProgress: [], drops: [{ name: "Boba Buddy Icon", awardedAt: ago(HOUR) }] },
      held(["Esports Loot Box", "Esports Loot Box"])).claimed,
    true,
    "a full-campaign claim is only visible as a reward",
  );
  assert.strictEqual(
    buyerClaimedListed(ledger, { inProgress: [claimedIn("Esports Loot Box", "BlizzCon Day 2")], drops: [] },
      held(["Esports Loot Box", "Boba Buddy Icon"])).claimed,
    true,
    "count-aware: one of the two listed loot boxes is gone and claimed",
  );
  assert.strictEqual(
    buyerClaimedListed(ledger, { inProgress: [], drops: [{ name: "Esports Loot Box", awardedAt: ago(HOUR) }] },
      held(["Esports Loot Box", "Esports Loot Box", "Boba Buddy Icon"])).claimed,
    false,
    "same-name claim while every listed copy is still unclaimed (prod, 2026-09-11)",
  );
  assert.strictEqual(
    buyerClaimedListed(ledger, { inProgress: [], drops: [] }, held(["Esports Loot Box"])).claimed,
    false,
    "copies gone with no claim = an expired wave, not a sale",
  );
  assert.strictEqual(
    buyerClaimedListed(ledger, { inProgress: [], drops: [{ name: "Boba Buddy Icon", awardedAt: ago(9 * 24 * HOUR) }] },
      held(["Esports Loot Box", "Esports Loot Box"])).claimed,
    false,
    "a reward claimed before the listing proves nothing",
  );
  assert.strictEqual(
    buyerClaimedListed(ledger, { inProgress: [claimedIn("Boba Buddy Icon", "Some Other Event")], drops: [] },
      held(["Esports Loot Box", "Esports Loot Box"])).claimed,
    false,
    "a claim in a different campaign is not this listed copy",
  );
});

test("expiry pass: a buyer's claim now spends the account — out of its bot, to the recycler", async () => {
  const fleet = fakeFleet({ configs: { 14: botConfig([["buyerclaimed", "s-bc"], ["keeper", "s-k"]]) }, running: ["14"] });
  const ledger = {
    ...soldLedger("L-bc", "P-bc", "buyerclaimed"),
    status: "listed",
    market: "digiseller",
    listedAt: ago(2 * 24 * HOUR),
    lastCheckedAt: ago(20 * 60000),
    botId: "14",
    container: "noclaim-bot-14",
    drops: [{ name: "Boba Buddy Icon", game: OW, campaign: "BlizzCon Day 1", itemKey: "boba buddy icon|overwatch" }],
    emptyReads: 0,
    firstEmptyAt: null,
    lotId: "",
  };
  const h = withEngine({
    fleet,
    pool: [pool("P-bc", "s-bc", { listed: true })],
    ledgers: [ledger],
    inventory: {
      "s-bc": {
        twitchId: "1",
        login: "buyerclaimed",
        drops: [],
        inProgress: [{ name: "Boba Buddy Icon", game: OW, campaign: "BlizzCon Day 1", percent: 100, claimed: true }],
      },
    },
  });
  try {
    const run = await h.engine.runOnce({ scan: false });
    assert.strictEqual(run.check.sold, 1);
    assert.strictEqual(run.check.expired, 0);
    assert.strictEqual(h.Unclaimed.rows[0].status, "sold");
    assert.deepStrictEqual(loginsOf(fleet, "14"), ["keeper"]);
    assert.deepStrictEqual(fleet.log.restarts, ["14"], "running bot restarted so it stops farming it");
    assert.strictEqual(h.Pool.rows[0].claimedNote, "spent — unclaimed auto-listed (buyer claimed a listed drop)");
    assert.strictEqual(h.Pool.rows[0].status, "claimed", "never back to the pool");
  } finally {
    h.restore();
  }
});

// --- 5. the bot page never offers a sold account as unsold ------------------------------

test("bot accounts route: a marketplace sale or a live listing marks the account not-for-sale", async () => {
  const fleet = fakeFleet({
    configs: { 14: botConfig([["eldsold", "s-eld"], ["onsale", "s-on"], ["free", "s-free"], ["spentone", "s-sp"]]) },
  });
  const Pool = fakeModel([
    pool("P-eld", "s-eld"),
    pool("P-on", "s-on", { listed: false }),
    pool("P-free", "s-free"),
    pool("P-sp", "s-sp", { claimedNote: "spent — no-claim removed Overwatch" }),
  ]);
  const Unclaimed = fakeModel([
    soldLedger("L-eld", "P-eld", "eldsold"),
    { ...soldLedger("L-on", "P-on", "onsale"), status: "listed", market: "gameflip" },
  ]);
  const stubs = new Map([
    [require.resolve("../models/UnclaimedAccount"), Unclaimed],
    [require.resolve("../models/AvailableAccount"), Pool],
    [require.resolve("../utils/botHosts"), fleet.hosts],
    [require.resolve("../utils/systemLog"), { logEvent: () => {}, actorFromReq: () => "test" }],
  ]);
  const routerPath = require.resolve("../routes/noclaimFarmRoutes");
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
    app.use((req, _res, next) => {
      req.session = { admin: { id: "root", username: "root", role: "superadmin", tfa: true } };
      next();
    });
    app.use(require("../routes/noclaimFarmRoutes"));
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const res = await fetch("http://127.0.0.1:" + server.address().port + "/api/noclaim-farm/bots/14/accounts");
    const j = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(j));
    const by = Object.fromEntries(j.accounts.map((a) => [a.login, a.notForSale]));
    assert.deepStrictEqual(by, {
      eldsold: "sold on eldorado",
      onsale: "on an auto-listing (gameflip)",
      free: "",
      spentone: "spent",
    });
  } finally {
    if (server) await new Promise((r) => server.close(r));
    Module._load = origLoad;
    delete require.cache[routerPath];
  }
});
