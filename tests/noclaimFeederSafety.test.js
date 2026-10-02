// The no-claim feeder must never put an account that sits in a bot config back
// in the pool, and must never spend pool accounts its own sellers will refuse
// (docs/LIVE-FIXES-1003.md A2, 2026-10-03).
//
// What these pin, and where the old bytes went wrong:
//   * defect 1 — the top-up rollback released `claimed.slice(added)`, which
//     after a skipped duplicate is the wrong rows, and released EVERYTHING on
//     any error after the config write (a restart timeout, an SSH reset) —
//     in-config accounts marked available, the 09-25 double-home;
//   * defect 2 — the claim query had no password rule and no committed-ledger
//     rule, so it spent accounts no no-claim seller can ever sell;
//   * defect 6 — a bot with a config and no container was left out of `have`,
//     so a provision that kept failing built a new bot every pass;
//   * defect 16 — nothing capped no-claim containers or checked host RAM;
//   * defect 13 — the farms ignored the pristine reserve rent-farm orders need.
//
// Everything is stubbed at Module._load (tests/operatorFarmStackRoom.test.js
// does the same): the pool and the ledger are in-memory rows behind a small
// Mongo matcher, and the bot host is a fake shell holding config files.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const FLEET_FILE = require.resolve("../utils/noclaimFleet");
const ALLOC_FILE = require.resolve("../utils/unclaimedAllocator");

// ---------------------------------------------------------------------------
// A small Mongo matcher — only the operators these two modules use.
// ---------------------------------------------------------------------------

const idStr = (v) => (v && typeof v === "object" && typeof v.toHexString === "function" ? v.toHexString() : v);

function eq(a, b) {
  if (a instanceof Date || b instanceof Date) return +a === +b;
  a = idStr(a);
  b = idStr(b);
  return a === b || (a == null && b == null);
}

// Array fields match when any element does (soldGames).
const anyOf = (value, fn) => (Array.isArray(value) ? value.some(fn) : fn(value));

function ordered(v, arg, f) {
  if (typeof v === "string" && typeof arg === "string") return f(v, arg);
  if (typeof v === "number" && typeof arg === "number") return f(v, arg);
  return false;
}

function isOps(c) {
  return (
    c && typeof c === "object" && !Array.isArray(c) && !(c instanceof RegExp) && !(c instanceof Date) &&
    Object.keys(c).length > 0 && Object.keys(c).every((k) => k.startsWith("$"))
  );
}

function matchCond(value, cond) {
  if (cond instanceof RegExp) return anyOf(value, (v) => typeof v === "string" && cond.test(v));
  if (!isOps(cond)) return anyOf(value, (v) => eq(v, cond));
  for (const [op, arg] of Object.entries(cond)) {
    if (op === "$in") {
      if (!anyOf(value, (v) => arg.some((a) => eq(v, a)))) return false;
    } else if (op === "$nin") {
      if (anyOf(value, (v) => arg.some((a) => eq(v, a)))) return false;
    } else if (op === "$ne") {
      if (anyOf(value, (v) => eq(v, arg))) return false;
    } else if (op === "$gt") {
      if (!anyOf(value, (v) => ordered(v, arg, (x, y) => x > y))) return false;
    } else if (op === "$regex") {
      const re = arg instanceof RegExp ? arg : new RegExp(arg, cond.$options || "");
      if (!anyOf(value, (v) => typeof v === "string" && re.test(v))) return false;
    } else if (op === "$options") {
      continue;
    } else if (op === "$not") {
      if (matchCond(value, arg)) return false;
    } else {
      throw new Error("fake matcher: unsupported operator " + op);
    }
  }
  return true;
}

function matches(doc, q) {
  for (const [k, c] of Object.entries(q || {})) {
    if (k === "$and") {
      if (!c.every((s) => matches(doc, s))) return false;
    } else if (k === "$or") {
      if (!c.some((s) => matches(doc, s))) return false;
    } else if (k === "$nor") {
      if (c.some((s) => matches(doc, s))) return false;
    } else if (k.startsWith("$")) {
      throw new Error("fake matcher: unsupported top-level " + k);
    } else if (!matchCond(doc[k], c)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const BASE = "/home/ubuntu/twitchbot-noclaim";
const cfgPath = (id) => `${BASE}/bots/${id}/Configuration/config.json`;
const norm = (g) => String(g || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// A pool row. `rank` orders the claim (newest lastCheckAt is claimed first).
function acct(id, rank, over = {}) {
  return {
    _id: id,
    username: id,
    usernameLower: id.toLowerCase(),
    clientSecret: "sec-" + id,
    password: "enc:" + id,
    hasPassword: true,
    status: "available",
    lastCheckStatus: "ok",
    lastCheckAt: new Date(Date.UTC(2026, 9, 1) + rank * 1000),
    manualSold: false,
    soldGames: [],
    dropCount: 5, // farmed before — not pristine unless a test says so
    unclaimedDropCount: 0,
    claimedNote: "",
    ...over,
  };
}

function botConfig(secrets, game = "Overwatch") {
  return {
    TwitchSettings: {
      TwitchUsers: secrets.map((s, i) => ({ Login: "u" + i, Id: String(100 + i), ClientSecret: s, Enabled: true, FavouriteGames: [game] })),
      OnlyFavouriteGames: true,
      OnlyConnectedAccounts: false,
      ClaimDrops: false,
    },
    FavouriteGames: [game],
  };
}

function poolModel(rows) {
  const docs = rows.map((r) => ({ ...r }));
  const calls = { claim: [], count: [], update: [] };
  return {
    docs,
    calls,
    get: (id) => docs.find((d) => d._id === id),
    async countDocuments(q) {
      calls.count.push(q);
      return docs.filter((d) => matches(d, q)).length;
    },
    async findOneAndUpdate(q, u, opts) {
      calls.claim.push(q);
      const hits = docs.filter((d) => matches(d, q));
      if (opts && opts.sort && opts.sort.lastCheckAt === -1) hits.sort((a, b) => +b.lastCheckAt - +a.lastCheckAt);
      if (!hits.length) return null;
      Object.assign(hits[0], u.$set);
      return { ...hits[0] };
    },
    find(q) {
      const out = docs.filter((d) => matches(d, q)).map((d) => ({ _id: d._id }));
      return { lean: async () => out };
    },
    async updateMany(q, u) {
      calls.update.push(q);
      let n = 0;
      for (const d of docs) {
        if (matches(d, q)) {
          Object.assign(d, u.$set);
          n++;
        }
      }
      return { modifiedCount: n };
    },
  };
}

const ledgerModel = (rows) => ({
  async distinct(field, q) {
    return [...new Set(rows.filter((r) => matches(r, q)).map((r) => r[field]))];
  },
});

// The pristine reserve (utils/pristineReserve.js, §2 of the contract), stateful
// like the real one: noteClaimed() lowers the cached pristine count.
function pristineFake({ reserve = 0, pristine = 0 } = {}) {
  const PRISTINE_CONDITIONS = {
    lastCheckStatus: "ok",
    hasPassword: true,
    dropCount: { $not: { $gt: 0 } },
    unclaimedDropCount: { $not: { $gt: 0 } },
  };
  const st = { reserve, pristine, filters: 0, noted: [] };
  const guard = () => {
    if (st.reserve <= 0) return { reserve: 0, pristine: st.pristine, headroom: Infinity, protect: 0 };
    return { reserve: st.reserve, pristine: st.pristine, headroom: st.pristine - st.reserve, protect: Math.min(st.pristine, st.reserve) };
  };
  const isPristine = (d) => matches(d, PRISTINE_CONDITIONS);
  return {
    st,
    PRISTINE_CONDITIONS,
    isPristine,
    farmGuard: async () => guard(),
    farmClaimFilter: async () => {
      st.filters++;
      return guard().headroom > 0 ? {} : { $nor: [PRISTINE_CONDITIONS] };
    },
    noteClaimed: (doc) => {
      st.noted.push(doc._id);
      if (isPristine(doc)) st.pristine--;
    },
    _resetForTests() {},
  };
}

function fakeSettings(af = {}) {
  const autoFarm = { poolReserve: 0, noClaimGames: ["overwatch", "rainbow six", "call of duty"], noclaimMaxBots: 40, ...af };
  return {
    getAutoFarm: () => autoFarm,
    normGameName: norm,
    isNoClaimGame: (g) => autoFarm.noClaimGames.some((k) => norm(g).includes(norm(k))),
    getFarmSizing: () => ({
      autoSize: true,
      intervalMin: 60,
      maxPerRun: 60,
      coverageDays: 28,
      safetyStock: 6,
      maxPerGame: 250,
      coverageDaysFor: () => 28,
      safetyStockFor: () => 6,
    }),
    gameCapFor: () => 0,
    getUnclaimedPricing: () => ({ gameCaps: {} }),
    setAutoFarm: async () => ({}),
  };
}

// The bot host. `failWrite(path)` -> "before" (nothing lands) | "after" (lands,
// then the call fails) | null; `failReread(path)` -> the re-read throws.
function fakeHost(opts = {}) {
  const o = {
    configs: {},
    ids: [],
    containers: [],
    fleetOut: "",
    failWrite: () => null,
    failReread: () => false,
    failRestart: false,
    launchFails: false,
    ...opts,
  };
  const files = new Map(Object.entries(o.configs).map(([id, c]) => [cfgPath(id), JSON.stringify(c, null, 2)]));
  const scripts = [];
  const hosts = {
    resolveHost: (id) => ({ id, transport: "ssh" }),
    shq,
    byteLength: (t) => Buffer.byteLength(String(t)),
    guardedWriteScript: (dest) => "GUARDED_WRITE " + dest,
    async runShell(host, script, { input } = {}) {
      scripts.push(script);
      let m;
      if ((m = script.match(/^GUARDED_WRITE (.+)$/))) {
        const mode = o.failWrite(m[1]);
        if (mode === "before") throw new Error("ssh: write timed out");
        files.set(m[1], String(input));
        if (mode === "after") throw new Error("ssh: connection reset after the write");
        return { stdout: "" };
      }
      if ((m = script.match(/^cat '([^']+)'$/))) {
        if (!files.has(m[1])) throw new Error("cat: no such file");
        return { stdout: files.get(m[1]) };
      }
      if (script.includes("__INFLIGHT__")) {
        const p = script.match(/if \[ -f '([^']+)' \]/)[1];
        if (o.failReread(p)) throw new Error("ssh: host unreachable");
        return { stdout: files.has(p) ? "__CFG__\n" + files.get(p) : "__NOCFG__" };
      }
      if (script.includes("docker restart")) {
        if (o.failRestart) throw new Error("ssh: restart timed out");
        return { stdout: "" };
      }
      if (script.includes("echo busy")) return { stdout: "free" };
      if (script.startsWith("ls -1")) return { stdout: o.ids.join("\n") };
      if (script.includes('echo "RC=$?"')) return { stdout: "RC=0\n" + o.containers.join("\n") };
      if (script.includes("setsid")) {
        if (o.launchFails) throw new Error("ssh: launch timed out");
        return { stdout: "" };
      }
      if (script.includes("PS_START")) return { stdout: o.fleetOut };
      throw new Error("fake host: unexpected script: " + script.slice(0, 100));
    },
  };
  return { hosts, files, scripts };
}

const config = (env, id) => JSON.parse(env.host.files.get(cfgPath(id)));
const secretsIn = (env, id) => config(env, id).TwitchSettings.TwitchUsers.map((u) => u.ClientSecret);

// ---------------------------------------------------------------------------
// Loading the modules with their dependencies stubbed
// ---------------------------------------------------------------------------

function install(map) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const file = (parent && parent.filename) || "";
    for (const [suffix, stubs] of map) {
      if (file.endsWith(suffix) && Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
    }
    return realLoad.call(this, request, parent, isMain);
  };
  return () => {
    Module._load = realLoad;
  };
}

function fresh(file) {
  delete require.cache[file];
  const mod = require(file);
  delete require.cache[file];
  return mod;
}

function fleetEnv({ pool = [], ledgers = [], host = {}, af = {}, pristine = {}, ram = null } = {}) {
  const env = { events: [], usage: [], telegrams: [], ramCalls: [] };
  env.pool = poolModel(pool);
  env.host = fakeHost(host);
  env.pristine = pristineFake(pristine);
  env.settings = fakeSettings(af);
  env.ram = ram || { ok: true, availableMb: 4000, minFreeMb: 1500, reason: "" };
  env.stubs = {
    "./botHosts": env.host.hosts,
    "./settings": env.settings,
    "../models/AvailableAccount": env.pool,
    "../models/UnclaimedAccount": ledgerModel(ledgers),
    "./poolUsageLog": { recordPoolUsage: async (ids, e) => env.usage.push([ids, e]) },
    "./systemLog": { logEvent: (e) => env.events.push(e) },
    "./pristineReserve": env.pristine,
    "./hostCapacity": {
      newContainerAllowed: async (id) => {
        env.ramCalls.push(id);
        return env.ram;
      },
      memAvailableMb: async () => null,
      lastReading: () => null,
      _resetForTests() {},
    },
  };
  return env;
}

async function withFleet(opts, fn) {
  const env = fleetEnv(opts);
  const restore = install([["/utils/noclaimFleet.js", env.stubs]]);
  try {
    env.fleet = fresh(FLEET_FILE);
    return await fn(env);
  } finally {
    restore();
  }
}

const KEYS = ["overwatch", "rainbow six", "call of duty"];
function fakeDemand(rows) {
  return {
    unclaimedDemandSnapshot: async () => rows.map((r) => ({ ...r })),
    bucketFor: (label) => {
      const n = norm(label);
      let best = "";
      for (const k of KEYS) if (n.includes(k) && k.length > best.length) best = k;
      return best;
    },
  };
}

function allocStubs(env, { af, rows = [], campaigns = [] } = {}) {
  return {
    "./settings": env.settings || fakeSettings(af),
    "./farmDemand": fakeDemand(rows),
    "./systemLog": { logEvent: (e) => env.events.push(e) },
    "./telegram": { sendTelegram: (t) => env.telegrams.push(t) },
    "./botHosts": { shq },
    "../models/TwitchCampaign": { find: () => ({ lean: async () => campaigns }) },
  };
}

// The allocator against a FAKE fleet (plan/apply decisions only).
async function withAllocator({ fleet, af, rows, campaigns }, fn) {
  const env = { events: [], telegrams: [], fleet };
  const stubs = allocStubs(env, { af, rows, campaigns });
  stubs["./noclaimFleet"] = fleet;
  const restore = install([["/utils/unclaimedAllocator.js", stubs]]);
  try {
    env.alloc = fresh(ALLOC_FILE);
    return await fn(env);
  } finally {
    restore();
  }
}

// The REAL allocator driving the REAL fleet, over the fake pool and host.
async function withBoth(opts, fn) {
  const env = fleetEnv(opts);
  const stubs = allocStubs(env, {});
  const restore = install([
    ["/utils/noclaimFleet.js", env.stubs],
    ["/utils/unclaimedAllocator.js", stubs],
  ]);
  try {
    env.fleet = fresh(FLEET_FILE);
    stubs["./noclaimFleet"] = env.fleet;
    env.alloc = fresh(ALLOC_FILE);
    return await fn(env);
  } finally {
    restore();
  }
}

// A plan row as plan() builds it, for driving apply() directly.
function planGame(over = {}) {
  return {
    key: "overwatch",
    label: "Overwatch",
    grant: 0,
    fleetNeed: 0,
    sales: { perWeek: 1 },
    shelf: { cap: 70, explicit: false, need: 0, suggested: 70 },
    fleet: { roomBots: [], botGame: "Overwatch", room: 0 },
    stuck: [],
    ...over,
  };
}
const planOf = (games, over = {}) => ({
  fleetKnown: true,
  provisioning: false,
  containers: { count: 5, max: 40 },
  policy: { coverageDays: 28 },
  games,
  ...over,
});

// A fake fleet for the allocator's decision tests.
function fleetFake(over = {}) {
  const calls = { claim: [], topUp: [], release: [], create: [], gate: [] };
  let n = 0;
  return {
    calls,
    MAX_PER_BOT: 70,
    BOTS_DIR: BASE + "/bots",
    containerFor: (id) => "noclaim-bot-" + id,
    maxBots: () => 40,
    readFleet: async () => ({ provisioning: false, imageBuilt: true, bots: [], containers: 0, psOk: true }),
    sh: async () => "",
    spendable: async () => ({ ready: 500, reserve: 0, spendable: 500 }),
    newContainerGate: async (o) => {
      calls.gate.push(o);
      return { ok: true, reason: "" };
    },
    claimForGame: async (game, count) => {
      calls.claim.push([game, count]);
      return Array.from({ length: count }, () => {
        n++;
        return { _id: "c" + n, username: "user" + n, clientSecret: "s" + n };
      });
    },
    topUpBot: async (id, docs) => {
      calls.topUp.push([id, docs.map((d) => d._id)]);
      return { added: docs.length, total: docs.length, presentIds: docs.map((d) => d._id), absentIds: [] };
    },
    release: async (docs) => {
      calls.release.push(docs.map((d) => d._id));
      return docs.length;
    },
    createBot: async (o) => {
      calls.create.push(o);
      return { id: "99", claimed: o.count, game: o.game };
    },
    ...over,
  };
}

function demandRow(key, label, target) {
  return {
    key,
    label,
    target,
    targetParts: { shelf: 0, other: target, safety: 0 },
    sales: { perWeek: 5, shelfPerWeek: 0, otherPerWeek: 5, count: 5, undated: 0, priced: 5 },
    policy: { coverageDays: 28 },
    onHand: 0,
    stock: { inFlight: 0 },
    weight: 1,
    daysOfCover: null,
  };
}

// ---------------------------------------------------------------------------
// Defect 2 — only claim what the no-claim sellers will sell
// ---------------------------------------------------------------------------

test("password-less and committed-ledger rows are never claimed, and spendable counts only claimable rows", async () => {
  const pool = [
    acct("pw", 10),
    acct("encpw", 9, { password: "", credPasswordEnc: "enc:x" }), // the sellers' second field
    acct("nopw", 8, { password: "", hasPassword: false }),
    acct("soldguy", 7),
    acct("listedguy", 6),
    acct("manualguy", 5),
    acct("removedguy", 4),
    acct("expiredguy", 3),
    acct("skippedguy", 2),
    acct("releasedguy", 1),
  ];
  const ledgers = [
    { source: "noclaim", loginLower: "soldguy", status: "sold", game: "Rainbow Six Siege" }, // ANY game
    { source: "noclaim", loginLower: "listedguy", status: "listed", game: "Overwatch" },
    { source: "noclaim", loginLower: "manualguy", status: "manual", game: "Overwatch" },
    { source: "noclaim", loginLower: "removedguy", status: "removed", game: "Overwatch" },
    { source: "noclaim", loginLower: "expiredguy", status: "expired", game: "Overwatch" },
    { source: "noclaim", loginLower: "skippedguy", status: "skipped", game: "Overwatch" },
    { source: "noclaim", loginLower: "releasedguy", status: "released", game: "Overwatch" },
  ];
  await withFleet({ pool, ledgers }, async ({ fleet, pool: p }) => {
    const supply = await fleet.spendable("Overwatch");
    assert.equal(supply.ready, 5, "pw, encpw, expired, skipped, released are the only claimable rows");
    const claimed = await fleet.claimForGame("Overwatch", 10);
    assert.deepEqual(
      claimed.map((d) => d._id).sort(),
      ["encpw", "expiredguy", "pw", "releasedguy", "skippedguy"],
    );
    for (const id of ["nopw", "soldguy", "listedguy", "manualguy", "removedguy"])
      assert.equal(p.get(id).status, "available", id + " must stay in the pool");
  });
});

test("the password clause survives Mongoose casting (credPasswordEnc is not in the schema)", async () => {
  // strictQuery would strip an unknown path, turning the $or into match-all.
  const Real = require("../models/AvailableAccount");
  await withFleet({}, async ({ fleet }) => {
    const q = Real.findOne({ $and: [fleet.readyPoolQuery("Overwatch", { excludeLogins: ["x"] }), {}] });
    q.cast(Real);
    const filter = JSON.stringify(q.getFilter());
    assert.match(filter, /"credPasswordEnc":\{"\$gt":""\}/);
    assert.match(filter, /"password":\{"\$gt":""\}/);
    assert.match(filter, /"usernameLower":\{"\$nin":\["x"\]\}/);
  });
});

// ---------------------------------------------------------------------------
// Defect 13 — the pristine reserve
// ---------------------------------------------------------------------------

test("the pristine filter is AND-ed into every claim, and a burst stops at the reserve", async () => {
  const fresh3 = (id, rank) => acct(id, rank, { dropCount: 0, unclaimedDropCount: 0 });
  const pool = [fresh3("p1", 10), fresh3("p2", 9), fresh3("p3", 8), acct("used", 1)];
  // 3 pristine, reserve 2: ONE pristine row may go, then the clause closes.
  await withFleet({ pool, pristine: { reserve: 2, pristine: 3 } }, async (env) => {
    const claimed = await env.fleet.claimForGame("Overwatch", 4);
    assert.deepEqual(claimed.map((d) => d._id), ["p1", "used"]);
    assert.equal(env.pool.get("p2").status, "available");
    assert.equal(env.pool.get("p3").status, "available");
    // Every claim query is { $and: [ready query, pristine clause] }, re-read per claim.
    for (const q of env.pool.calls.claim) assert.ok(Array.isArray(q.$and) && q.$and.length === 2, "clause AND-ed in");
    assert.deepEqual(env.pool.calls.claim[0].$and[1], {});
    assert.ok(env.pool.calls.claim[1].$and[1].$nor, "closed after the reserve was reached");
    assert.deepEqual(env.pristine.st.noted, ["p1", "used"], "noteClaimed after every claim");
  });
});

test("spendable leaves the reserve's share out while the clause is open, and is exact once it is closed", async () => {
  const pr = (id, rank) => acct(id, rank, { dropCount: 0 });
  const pool = [pr("p1", 4), pr("p2", 3), pr("p3", 2), acct("used", 1)];
  await withFleet({ pool, pristine: { reserve: 2, pristine: 3 } }, async ({ fleet }) => {
    const s = await fleet.spendable("");
    assert.equal(s.pristineHeld, 2);
    assert.equal(s.ready, 2, "1 used + 1 pristine of headroom");
  });
  await withFleet({ pool, pristine: { reserve: 5, pristine: 3 } }, async ({ fleet }) => {
    const s = await fleet.spendable("");
    assert.equal(s.pristineHeld, 0);
    assert.equal(s.ready, 1, "below the reserve: only the farmed row");
  });
});

// ---------------------------------------------------------------------------
// Defect 1 — release() and topUpBot's answer
// ---------------------------------------------------------------------------

test("release() ignores a row another system re-claimed, and still frees its own", async () => {
  const pool = [
    acct("mine", 4, { status: "claimed", claimedNote: "noclaim-farm:Overwatch" }),
    acct("renter", 3, { status: "claimed", claimedNote: "rented to bob (Marvel Rivals)" }),
    acct("autofarm", 2, { status: "claimed", claimedNote: "auto-farm: Albion Online" }),
    acct("operator", 1, { status: "claimed", claimedNote: "claimed by hand" }),
  ];
  await withFleet({ pool }, async ({ fleet, pool: p }) => {
    const n = await fleet.release(pool);
    assert.equal(n, 1);
    assert.equal(p.get("mine").status, "available");
    for (const id of ["renter", "autofarm", "operator"]) {
      assert.equal(p.get(id).status, "claimed", id + " belongs to another system");
      assert.notEqual(p.get(id).claimedNote, "", id + " keeps its owner note");
    }
  });
});

test("topUpBot names which docs the config holds — an already-present secret and a twin stay present", async () => {
  const docs = [
    acct("dup", 4, { clientSecret: "old" }), // already in bot 5
    acct("new1", 3),
    acct("twin", 2, { clientSecret: "sec-new1" }), // same token as new1
    acct("blank", 1, { clientSecret: "" }),
  ];
  await withFleet({ host: { configs: { 5: botConfig(["old", "other"]) } } }, async (env) => {
    const res = await env.fleet.topUpBot("5", docs, "Overwatch");
    assert.equal(res.added, 1);
    assert.equal(res.total, 3);
    assert.deepEqual(res.presentIds, ["dup", "new1", "twin"]);
    assert.deepEqual(res.absentIds, ["blank"]);
    assert.deepEqual(secretsIn(env, "5"), ["old", "other", "sec-new1"]);
  });
});

// ---------------------------------------------------------------------------
// Defect 1 end to end — the real allocator driving the real fleet
// ---------------------------------------------------------------------------

const topUpPlan = (want, roomBots) =>
  planOf([planGame({ grant: want, fleetNeed: want, fleet: { roomBots, botGame: "Overwatch", room: 70 } })], {
    containers: { count: 40, max: 40 }, // no create: these tests are about the top-up
  });

test("a duplicate already in the bot is kept claimed — and so is the account that was added", async () => {
  // "dupe" is in bot 5's config but `available` in the pool (a 09-25 victim);
  // it is claimed first. The old code released claimed.slice(added) = the row
  // it had just ADDED, leaving it in the config and in the pool.
  const pool = [acct("dupe", 10, { clientSecret: "in-bot" }), acct("fresh", 9)];
  await withBoth({ pool, host: { configs: { 5: botConfig(["in-bot"]) } } }, async (env) => {
    const out = await env.alloc.apply({ plan: topUpPlan(2, [{ id: "5", game: "Overwatch", room: 10 }]) });
    assert.equal(env.pool.get("fresh").status, "claimed", "the added account is in the config");
    assert.equal(env.pool.get("dupe").status, "claimed", "the duplicate is in the config too");
    assert.deepEqual(secretsIn(env, "5"), ["in-bot", "sec-fresh"]);
    assert.equal(out.toppedUp, 1);
    // Never released in between. (The old code released "fresh", and its create
    // step then claimed it AGAIN into a second bot: one login in two configs.)
    assert.deepEqual(env.usage.filter(([, e]) => e.event === "released"), []);
    assert.deepEqual([...env.host.files.keys()], [cfgPath("5")], "no other config holds it");
  });
});

test("a restart that fails after the write keeps every row claimed", async () => {
  const pool = [acct("a", 10), acct("b", 9)];
  await withBoth(
    { pool, host: { configs: { 5: botConfig(["x"]) }, failRestart: true } },
    async (env) => {
      const out = await env.alloc.apply({ plan: topUpPlan(2, [{ id: "5", game: "Overwatch", room: 10 }]) });
      assert.deepEqual(secretsIn(env, "5"), ["x", "sec-a", "sec-b"]);
      assert.equal(env.pool.get("a").status, "claimed");
      assert.equal(env.pool.get("b").status, "claimed");
      assert.equal(out.toppedUp, 2);
      assert.ok(out.errors.some((e) => /restart failed/.test(e)), out.errors.join(" | "));
    },
  );
});

test("a write that fails with a readable config releases only what the config does not hold", async () => {
  for (const mode of ["before", "after"]) {
    const pool = [acct("dupe", 10, { clientSecret: "in-bot" }), acct("fresh", 9)];
    await withBoth(
      { pool, host: { configs: { 5: botConfig(["in-bot"]) }, failWrite: () => mode } },
      async (env) => {
        const out = await env.alloc.apply({ plan: topUpPlan(2, [{ id: "5", game: "Overwatch", room: 10 }]) });
        assert.equal(env.pool.get("dupe").status, "claimed", `${mode}: the duplicate is in the config`);
        if (mode === "before") {
          assert.equal(env.pool.get("fresh").status, "available", "never landed: it goes back");
          assert.equal(out.toppedUp, 0);
        } else {
          assert.equal(env.pool.get("fresh").status, "claimed", "landed despite the error: it stays");
          assert.equal(out.toppedUp, 1);
        }
        assert.ok(out.errors.some((e) => /write failed/.test(e)), out.errors.join(" | "));
      },
    );
  }
});

test("a write whose outcome cannot be read back releases nothing, logs it, and the next game still runs", async () => {
  const pool = [acct("a", 10), acct("b", 9), acct("c", 8)];
  const bot5 = (p) => p.includes("/bots/5/");
  await withBoth(
    {
      pool,
      host: {
        configs: { 5: botConfig(["x"]), 6: botConfig(["y"], "Rainbow Six Siege") },
        failWrite: (p) => (bot5(p) ? "after" : null),
        failReread: bot5,
      },
    },
    async (env) => {
      const plan = planOf([
        planGame({ grant: 2, fleetNeed: 2, fleet: { roomBots: [{ id: "5", game: "Overwatch", room: 10 }], room: 10 } }),
        planGame({
          key: "rainbow six",
          label: "Rainbow Six",
          grant: 1,
          fleetNeed: 1,
          fleet: { roomBots: [{ id: "6", game: "Rainbow Six Siege", room: 10 }], room: 10 },
        }),
      ]);
      const out = await env.alloc.apply({ plan });
      assert.equal(env.pool.get("a").status, "claimed", "may be in bot 5: never released");
      assert.equal(env.pool.get("b").status, "claimed", "may be in bot 5: never released");
      const ev = env.events.find((e) => e.action === "topup_state_unknown");
      assert.ok(ev, "a topup_state_unknown event names the bot and logins");
      assert.equal(ev.subject, "noclaim-bot-5");
      assert.deepEqual(ev.meta.logins, ["a", "b"]);
      assert.equal(out.results[0].createdBot, null, "no create for a game whose host state is unknown");
      // The next game was still topped up.
      assert.equal(out.results[1].toppedUp, 1);
      assert.equal(env.pool.get("c").status, "claimed");
      assert.deepEqual(secretsIn(env, "6"), ["y", "sec-c"]);
    },
  );
});

test("the allocator releases only absentIds (the old slice released the wrong rows)", async () => {
  // c1 was already in the bot, c2 was added, c3 did not make it in. The old
  // code released claimed.slice(added) = [c2, c3]: c2 is in the config.
  const fleet = fleetFake({
    topUpBot: async (id, docs) => ({
      added: 1,
      total: 9,
      presentIds: [docs[0]._id, docs[1]._id],
      absentIds: [docs[2]._id],
    }),
    newContainerGate: async () => ({ ok: false, reason: "test: no create" }),
  });
  await withAllocator({ fleet }, async ({ alloc }) => {
    await alloc.apply({
      plan: planOf([planGame({ grant: 3, fleetNeed: 3, fleet: { roomBots: [{ id: "5", game: "Overwatch", room: 3 }] } })]),
    });
    assert.deepEqual(fleet.calls.release, [["c3"]], "only the row the config does not hold");
  });
});

// ---------------------------------------------------------------------------
// Defect 6 — stuck provisions
// ---------------------------------------------------------------------------

const R6 = [demandRow("rainbow six", "Rainbow Six", 150)];
const R6_LIVE = [{ game: "Tom Clancy's Rainbow Six Siege" }];

test("a bot with no container is counted, never fed, and no second bot is built", async () => {
  // Bot 3 is full and farming; bot 12's provision never produced a container.
  const fleet = fleetFake({
    readFleet: async () => ({
      provisioning: false,
      imageBuilt: true,
      psOk: true,
      containers: 1,
      bots: [
        { id: "3", game: "Rainbow Six Siege", accounts: 70, containerState: "running", running: true },
        { id: "12", game: "Rainbow Six Siege", accounts: 60, containerState: "none", running: false },
      ],
    }),
  });
  await withAllocator({ fleet, rows: R6, campaigns: R6_LIVE }, async (env) => {
    const p = await env.alloc.plan();
    const g = p.games[0];
    assert.equal(g.fleet.assigned, 130, "the stuck bot's 60 accounts are counted");
    assert.equal(g.fleetNeed, 20);
    assert.deepEqual(g.stuck, ["12"]);
    assert.equal(g.fleet.parked, false);
    assert.match(g.createBlocked, /bot 12 has no container/);
    assert.equal(g.grant, 0, "no room and no create: nothing to spend a grant on");
    assert.ok(g.notes.some((n) => /no container/.test(n)));

    await env.alloc.apply({ plan: p });
    await env.alloc.apply({ plan: p });
    assert.equal(fleet.calls.create.length, 0);
    assert.equal(fleet.calls.claim.length, 0, "never fed");
    assert.equal(env.events.filter((e) => e.action === "provision_stuck").length, 1, "once per bot per process");
    assert.equal(env.telegrams.length, 1);
    assert.match(env.telegrams[0], /bot 12/);

    // A plan handed in with a grant still never creates for that game.
    const out = await env.alloc.apply({
      plan: planOf([planGame({ key: "rainbow six", label: "Rainbow Six", grant: 30, fleetNeed: 30, stuck: ["12"] })]),
    });
    assert.equal(fleet.calls.create.length, 0);
    assert.match(out.results[0].createBlocked, /bot 12 has no container/);
    assert.deepEqual(out.errors, []);
  });
});

test("an operator's markers win over a missing container: that game is parked, not stuck", async () => {
  // CoD bot 10 (2026-09-20): no container, .operatoroff. Bot 11: no container, personal.
  const fleet = fleetFake({
    readFleet: async () => ({
      provisioning: false,
      imageBuilt: true,
      psOk: true,
      containers: 0,
      bots: [
        { id: "10", game: "Call of Duty: Black Ops 7", accounts: 47, containerState: "none", running: false },
        { id: "11", game: "Call of Duty: Black Ops 7", accounts: 1, containerState: "none", running: false },
      ],
    }),
    sh: async () => "10 off\n11 personal",
  });
  const rows = [demandRow("call of duty", "Call of Duty", 60)];
  await withAllocator({ fleet, rows, campaigns: [{ game: "Call of Duty: Black Ops 7" }] }, async (env) => {
    const p = await env.alloc.plan();
    const g = p.games[0];
    assert.equal(g.fleet.parked, true);
    assert.deepEqual(g.stuck, []);
    assert.equal(g.fleetNeed, 0);
    await env.alloc.apply({ plan: p });
    assert.equal(env.telegrams.length, 0);
    assert.equal(fleet.calls.create.length, 0);
  });
});

test("a failed docker ps makes the fleet unknown instead of making every bot look stuck", async () => {
  const fleet = fleetFake({
    readFleet: async () => ({
      provisioning: false,
      imageBuilt: true,
      psOk: false,
      containers: null,
      bots: [{ id: "3", game: "Rainbow Six Siege", accounts: 70, containerState: "none", running: false }],
    }),
  });
  await withAllocator({ fleet, rows: R6, campaigns: R6_LIVE }, async (env) => {
    const p = await env.alloc.plan();
    assert.equal(p.fleetKnown, false);
    assert.match(p.fleetError, /docker ps/);
    const out = await env.alloc.apply({ plan: p });
    assert.ok(out.skipped);
    assert.equal(env.telegrams.length, 0);
  });
});

test("readFleet reports docker's exit status and the container count", async () => {
  const out = (rc) =>
    [
      "prov=no",
      "img=yes",
      "PS_START",
      ...(rc === 0 ? ["noclaim-bot-3|running|Up 2 hours", "noclaim-bot-4|exited|Exited (0) 1 hour ago"] : []),
      "PS_RC=" + rc,
      "PS_END",
      "BOTS_START",
      "3|Overwatch|50",
      "4|Overwatch|20",
      "5|Overwatch|10",
      "BOTS_END",
    ].join("\n");
  await withFleet({ host: { fleetOut: out(0) } }, async ({ fleet }) => {
    const f = await fleet.readFleet();
    assert.equal(f.psOk, true);
    assert.equal(f.containers, 2);
    assert.deepEqual(f.bots.map((b) => b.containerState), ["running", "exited", "none"]);
  });
  await withFleet({ host: { fleetOut: out(1) } }, async ({ fleet }) => {
    const f = await fleet.readFleet();
    assert.equal(f.psOk, false);
    assert.equal(f.containers, null);
  });
});

test("the provision chain skips git when the image is there, and stops before docker run when it cannot build", async () => {
  // The real launch: createBotFromAccounts' detached script is captured from
  // the fake host and run here by /bin/sh (minus setsid/&), with fake
  // `docker`/`git` on PATH that log their calls and the host's BASE swapped
  // for a temp dir.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noclaim-prov-"));
  try {
    const bin = path.join(dir, "bin");
    const base = path.join(dir, "base");
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(base, "src", ".git"), { recursive: true });
    const logFile = path.join(dir, "calls.log");
    // `docker image inspect` answers from IMAGE_PRESENT; `git fetch` fails
    // when GIT_FAIL is set.
    fs.writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\necho "docker $*" >> "${logFile}"\n` +
        `if [ "$1 $2" = "image inspect" ]; then [ -n "$IMAGE_PRESENT" ] && exit 0; exit 1; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\necho "git $*" >> "${logFile}"\n[ "$1" = fetch ] && [ -n "$GIT_FAIL" ] && exit 1\nexit 0\n`,
      { mode: 0o755 },
    );
    const launched = await withFleet({}, async (env) => {
      await env.fleet.createBotFromAccounts("7", [acct("a", 1), acct("b", 2), acct("c", 3)], "Overwatch");
      return env.host.scripts.find((s) => s.includes("setsid"));
    });
    const m = launched.match(/setsid sh -c ('(?:[^']|'\\'')*') >\/dev\/null/);
    assert.ok(m, "the provision is launched through setsid sh -c");
    const wrapped = m[1].slice(1, -1).split("'\\''").join("'").split(BASE).join(base);
    const run = (env) => {
      fs.writeFileSync(logFile, "");
      fs.writeFileSync(path.join(base, ".provisioning"), "");
      execFileSync("sh", ["-c", wrapped], {
        env: { ...process.env, PATH: bin + ":" + process.env.PATH, ...env },
        stdio: "pipe",
      });
      assert.equal(fs.existsSync(path.join(base, ".provisioning")), false, "the lock is always removed");
      return fs.readFileSync(logFile, "utf8");
    };

    const present = run({ IMAGE_PRESENT: "1", GIT_FAIL: "1" });
    assert.doesNotMatch(present, /^git /m, "no git at all when the image exists");
    assert.match(present, /^docker run -d --name noclaim-bot-7 /m);

    const broken = run({ GIT_FAIL: "1" });
    assert.match(broken, /^git fetch/m);
    assert.doesNotMatch(broken, /^docker (build|run)/m, "no image and no fork: no container");

    const build = run({});
    assert.match(build, /^docker build/m);
    assert.match(build, /^docker run -d/m);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// createBot — gates, and never releasing what a config holds
// ---------------------------------------------------------------------------

const fivePool = () => [acct("a", 5), acct("b", 4), acct("c", 3), acct("d", 2), acct("e", 1)];

test("createBot refuses at the container cap and on low host RAM, before claiming anything", async () => {
  await withFleet(
    { pool: fivePool(), af: { noclaimMaxBots: 2 }, host: { containers: ["noclaim-bot-1", "noclaim-bot-2"], ids: ["1", "2"] } },
    async (env) => {
      await assert.rejects(env.fleet.createBot({ game: "Overwatch", count: 3 }), (e) => e.status === 409 && /cap is 2/.test(e.message));
      assert.equal(env.pool.calls.claim.length, 0);
    },
  );
  await withFleet(
    { pool: fivePool(), ram: { ok: false, availableMb: 900, minFreeMb: 1500, reason: "low" }, host: { ids: ["1"] } },
    async (env) => {
      await assert.rejects(env.fleet.createBot({ game: "Overwatch", count: 3 }), (e) => e.status === 409 && /900 MB/.test(e.message));
      assert.equal(env.pool.calls.claim.length, 0);
      assert.deepEqual(env.ramCalls, ["contabo"]);
    },
  );
  // noclaimMaxBots 0 = off; a garbage value keeps the default cap.
  await withFleet({ af: { noclaimMaxBots: 0 } }, async ({ fleet }) => assert.equal(fleet.maxBots(), 0));
  await withFleet({ af: { noclaimMaxBots: "lots" } }, async ({ fleet }) => assert.equal(fleet.maxBots(), 40));
});

test("createBot: a launch that fails after the config landed returns provisionError and releases nothing", async () => {
  await withFleet({ pool: fivePool(), host: { ids: ["1", "2"], launchFails: true } }, async (env) => {
    const out = await env.fleet.createBot({ game: "Overwatch", count: 3 });
    assert.equal(out.id, "3");
    assert.equal(out.claimed, 3);
    assert.match(out.provisionError, /launch timed out/);
    assert.deepEqual(secretsIn(env, "3"), ["sec-a", "sec-b", "sec-c"]);
    for (const id of ["a", "b", "c"]) assert.equal(env.pool.get(id).status, "claimed");
  });
});

test("createBot: a failed config write is probed — not there: released; unreadable: kept + event; there: kept", async () => {
  // Not there.
  await withFleet({ pool: fivePool(), host: { ids: ["1"], failWrite: () => "before" } }, async (env) => {
    await assert.rejects(env.fleet.createBot({ game: "Overwatch", count: 2 }), (e) => !e.unknownState);
    assert.equal(env.pool.get("a").status, "available");
    assert.equal(env.pool.get("b").status, "available");
  });
  // Unreadable.
  await withFleet(
    { pool: fivePool(), host: { ids: ["1"], failWrite: () => "after", failReread: () => true } },
    async (env) => {
      await assert.rejects(env.fleet.createBot({ game: "Overwatch", count: 2 }), (e) => e.unknownState === true);
      assert.equal(env.pool.get("a").status, "claimed");
      assert.equal(env.pool.get("b").status, "claimed");
      const ev = env.events.find((e) => e.action === "topup_state_unknown");
      assert.ok(ev);
      assert.deepEqual(ev.meta.logins, ["a", "b"]);
    },
  );
  // Landed despite the error: launched, kept.
  await withFleet({ pool: fivePool(), host: { ids: ["1"], failWrite: () => "after" } }, async (env) => {
    const out = await env.fleet.createBot({ game: "Overwatch", count: 2 });
    assert.equal(out.claimed, 2);
    assert.equal(out.provisionError, undefined);
    assert.equal(env.pool.get("a").status, "claimed");
    assert.ok(env.host.scripts.some((s) => s.includes("setsid")), "the provision was launched");
  });
});

// ---------------------------------------------------------------------------
// The allocator's create gates, and what it does with a provisionError
// ---------------------------------------------------------------------------

test("the allocator asks the cap and RAM gate first and records why, instead of erroring", async () => {
  const fleet = fleetFake({
    newContainerGate: async (o) => {
      fleet.calls.gate.push(o);
      return { ok: false, reason: "host contabo has 900 MB of RAM free, under the 1500 MB a new container needs" };
    },
  });
  await withAllocator({ fleet }, async ({ alloc }) => {
    const out = await alloc.apply({ plan: planOf([planGame({ grant: 30, fleetNeed: 30 })]) });
    assert.equal(fleet.calls.create.length, 0);
    assert.match(out.results[0].createBlocked, /900 MB/);
    assert.deepEqual(out.errors, []);
    assert.deepEqual(fleet.calls.gate, [{ containers: 5 }], "the plan's own container count is reused");
    assert.equal(out.createsBlocked.length, 1);
  });
  const open = fleetFake();
  await withAllocator({ fleet: open }, async ({ alloc }) => {
    await alloc.apply({ plan: planOf([planGame({ grant: 30, fleetNeed: 30 })]) });
    assert.equal(open.calls.create.length, 1);
  });
});

test("plan() marks the container cap, and a capped game asks only for the room it has", async () => {
  const fleet = fleetFake({
    readFleet: async () => ({
      provisioning: false,
      imageBuilt: true,
      psOk: true,
      containers: 40,
      bots: [{ id: "3", game: "Rainbow Six Siege", accounts: 60, containerState: "running", running: true }],
    }),
  });
  await withAllocator({ fleet, rows: R6, campaigns: R6_LIVE }, async (env) => {
    const p = await env.alloc.plan();
    const g = p.games[0];
    assert.deepEqual(p.containers, { count: 40, max: 40 });
    assert.match(g.createBlocked, /container cap reached/);
    assert.equal(g.fleetNeed, 90);
    assert.equal(g.grant, 10, "only bot 3's 10 free seats can be filled");
  });
});

test("a provisionError from createBot is reported, counted as the pass's create, and releases nothing", async () => {
  const fleet = fleetFake({
    createBot: async (o) => ({ id: "13", claimed: o.count, game: o.game, provisionError: "ssh: launch timed out" }),
  });
  await withAllocator({ fleet }, async ({ alloc }) => {
    const out = await alloc.apply({ plan: planOf([planGame({ grant: 20, fleetNeed: 20 })]) });
    assert.equal(out.created, 1);
    assert.equal(out.results[0].createdBot.id, "13");
    assert.ok(out.errors.some((e) => /did not launch/.test(e)));
    assert.deepEqual(fleet.calls.release, []);
  });
});

// ---------------------------------------------------------------------------
// Health hook (contract §3)
// ---------------------------------------------------------------------------

test("status() always carries lastRun and intervalMin, and never throws", async () => {
  await withAllocator({ fleet: fleetFake() }, async ({ alloc }) => {
    const s = alloc.status();
    assert.equal(s.lastRun, null);
    assert.equal(s.intervalMin, 60);
  });
  const env = { events: [], telegrams: [] };
  const stubs = allocStubs(env, {});
  stubs["./settings"] = { ...fakeSettings(), getFarmSizing: () => { throw new Error("settings.json torn"); } };
  stubs["./noclaimFleet"] = fleetFake();
  const restore = install([["/utils/unclaimedAllocator.js", stubs]]);
  try {
    const alloc = fresh(ALLOC_FILE);
    const s = alloc.status();
    assert.equal(s.intervalMin, 60);
    assert.equal(s.lastRun, null);
  } finally {
    restore();
  }
});
