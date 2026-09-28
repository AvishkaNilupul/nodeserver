/* global fetch, structuredClone */
// "Release bot" returns only the no-claim farm's own FREE accounts to the pool,
// and refuses while the bot holds accounts on sale, sold or rented (owner,
// 2026-09-28 — review item 7).
//
// Before: it set EVERY account in the config "available" — listed ones, sold
// ones, and rows another system had claimed — and every other system trusts
// the pool.
//
// Mongo/host-free: models and the fleet host are stubbed via Module._load; the
// REAL route runs behind a stub superadmin session.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const express = require("express");

function matchValue(v, cond) {
  if (cond && typeof cond === "object" && !(cond instanceof Date)) {
    if ("$in" in cond) return cond.$in.some((x) => String(x) === String(v));
    throw new Error("fake: unsupported " + JSON.stringify(cond));
  }
  return String(v) === String(cond);
}
function fakeModel(docs = []) {
  const rows = docs.map((d) => structuredClone(d));
  const hit = (r, q) => Object.entries(q).every(([k, c]) => matchValue(r[k], c));
  const query = (fn) => {
    const q = { lean: () => q, sort: () => q, limit: () => q, then: (a, b) => Promise.resolve().then(fn).then(a, b) };
    return q;
  };
  return {
    rows,
    find: (q) => query(() => rows.filter((r) => hit(r, q)).map((r) => structuredClone(r))),
    findOne: (q) => query(() => structuredClone(rows.find((r) => hit(r, q)) || null)),
    updateMany: async (q, u) => {
      let n = 0;
      for (const r of rows) if (hit(r, q)) (Object.assign(r, u.$set || {}), n++);
      return { modifiedCount: n };
    },
  };
}

const OW = "Overwatch";
const DAY = 864e5;
const ago = (ms) => new Date(Date.now() - ms);
const pool = (id, secret, over = {}) => ({
  _id: id,
  clientSecret: secret,
  status: "claimed",
  claimedNote: "noclaim-farm:Overwatch",
  claimedAt: ago(20 * DAY),
  manualSold: false,
  listed: false,
  ...over,
});

async function release({ accounts, pools, ledgers = [], personal = false }) {
  const cfg = {
    FavouriteGames: [OW],
    TwitchSettings: { TwitchUsers: accounts.map(([Login, ClientSecret]) => ({ Login, ClientSecret, Id: "1" })) },
  };
  const shell = [];
  const hosts = {
    resolveHost: (id) => ({ id }),
    shq: (s) => "'" + String(s).replace(/'/g, "'\\''") + "'",
    async readFiles() {
      return {};
    },
    async runShell(_h, script) {
      shell.push(script);
      if (/\.personal' \] && echo yes/.test(script)) return { stdout: personal ? "yes" : "no" };
      if (/^\[ -f '/.test(script)) return { stdout: JSON.stringify(cfg) };
      return { stdout: "" };
    },
  };
  const Pool = fakeModel(pools);
  const Ledger = fakeModel(ledgers);
  const usage = [];
  const stubs = new Map([
    [require.resolve("../models/AvailableAccount"), Pool],
    [require.resolve("../models/UnclaimedAccount"), Ledger],
    [require.resolve("../utils/botHosts"), hosts],
    [require.resolve("../utils/poolUsageLog"), { recordPoolUsage: async (ids, ev) => usage.push({ ids, ...ev }) }],
    [require.resolve("../utils/systemLog"), { logEvent: () => {}, actorFromReq: () => "owner" }],
  ]);
  const paths = [require.resolve("../routes/noclaimFarmRoutes"), require.resolve("../utils/noclaimFleet")];
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
    await new Promise((r) => server.once("listening", r));
    const res = await fetch("http://127.0.0.1:" + server.address().port + "/api/noclaim-farm/bots/14/release", { method: "POST" });
    const body = await res.json();
    return { status: res.status, body, Pool, shell, usage, removed: shell.some((s) => /docker rm -f/.test(s)) };
  } finally {
    if (server) await new Promise((r) => server.close(r));
    Module._load = origLoad;
    for (const p of paths) delete require.cache[p];
  }
}

test("release: refused while the bot holds an account on sale or sold — nothing moves", async () => {
  for (const [label, pools, ledgers] of [
    ["listed ledger", [pool("P1", "s1")], [{ _id: "L1", poolAccountId: "P1", status: "listed" }]],
    ["owner listing", [pool("P1", "s1")], [{ _id: "L1", poolAccountId: "P1", status: "manual" }]],
    ["Listed tick", [pool("P1", "s1", { listed: true })], []],
    ["Sold tick", [pool("P1", "s1", { manualSold: true })], []],
    ["sold ledger", [pool("P1", "s1")], [{ _id: "L1", poolAccountId: "P1", status: "sold", soldAt: ago(DAY) }]],
    ["spent note", [pool("P1", "s1", { claimedNote: "spent — eldorado sale" })], []],
    ["rented", [pool("P1", "s1", { claimedNote: "rented to bulkseller" })], []],
  ]) {
    const r = await release({ accounts: [["a", "s1"], ["b", "s2"]], pools: pools.concat(pool("P2", "s2")), ledgers });
    assert.strictEqual(r.status, 409, label + " " + JSON.stringify(r.body));
    assert.match(r.body.message, /nothing was released/, label);
    assert.ok(r.Pool.rows.every((p) => p.status === "claimed"), label + ": no pool row moved");
    assert.strictEqual(r.removed, false, label + ": the bot and its config stay");
  }
});

test("release: only the farm's own free accounts go back; another system's rows are left alone", async () => {
  const r = await release({
    accounts: [["mine", "s1"], ["theirs", "s2"], ["recycled", "s3"]],
    pools: [
      pool("P1", "s1"),
      pool("P2", "s2", { claimedNote: "deployed to twitchbotx19 [local]" }),
      pool("P3", "s3", { claimedAt: ago(2 * DAY) }),
    ],
    // P3 was sold for another game long ago, recycled, and claimed into this bot
    // after that sale — history, not a blocker.
    ledgers: [{ _id: "L3", poolAccountId: "P3", status: "sold", soldAt: ago(10 * DAY) }],
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.deepStrictEqual({ released: r.body.released, left: r.body.left }, { released: 2, left: 1 });
  const by = Object.fromEntries(r.Pool.rows.map((p) => [p._id, p.status]));
  assert.deepStrictEqual(by, { P1: "available", P2: "claimed", P3: "available" });
  assert.strictEqual(r.Pool.rows.find((p) => p._id === "P2").claimedNote, "deployed to twitchbotx19 [local]");
  assert.ok(r.removed, "the bot is removed");
});

test("release: a personal bot's fenced account goes back unfenced", async () => {
  const r = await release({
    accounts: [["mine", "s1"]],
    pools: [pool("P1", "s1", { manualSold: true, claimedNote: "unclaimed stock — 10 drop(s)" })],
    personal: true,
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.released, 1);
  assert.deepStrictEqual(
    { status: r.Pool.rows[0].status, manualSold: r.Pool.rows[0].manualSold },
    { status: "available", manualSold: false },
  );
});
