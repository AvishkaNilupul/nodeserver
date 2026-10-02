/* global fetch */
// Renter MANUAL ADD / Quick farm (POST /renters/:id/accounts/manual,
// routes/renterAdminRoutes.js) must not take a login another system holds.
//
// The route ends with an unconditional pool write re-labelling the login's row
// "rented to <renter>". A login whose pool row said another system owned it —
// a no-claim bot's account, held unclaimed stock, an auto-farm claim — was
// placed in the renter's (claiming) bot and silently taken from that owner: the
// no-claim stock gets claimed away, and the owner's guards lose sight of the
// login. Since 2026-10-03 (docs/LIVE-FIXES-1003.md §A5.3) the route reads the
// pool row first and refuses with 409 — before the renter is even looked up, so
// no stack is assigned and no config or pool row is written. A login already
// rented to someone still moves renter-to-renter, with that path's own checks.
//
// No database, no hosts: the router is mounted in a bare express app with a
// stub superadmin session; models, host I/O and config writers are fakes that
// record every write. They carry the pre-fix route all the way to its writes,
// so these tests fail on the old bytes for what it WROTE, not for a missing fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const express = require("express");

function query(value) {
  const p = Promise.resolve(value);
  return {
    lean: () => Promise.resolve(value && typeof value === "object" && !Array.isArray(value) ? plain(value) : value),
    then: (a, b) => p.then(a, b),
    catch: (f) => p.catch(f),
  };
}

function plain(doc) {
  const out = {};
  for (const [k, v] of Object.entries(doc)) if (typeof v !== "function") out[k] = v;
  return out;
}

// Anything the router requires that a test does not provide throws when CALLED
// (destructuring at load time is fine), so an unexpected dependency is loud.
function strict(name, impl = {}) {
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === "symbol" || prop === "then" || prop === "__esModule") return undefined;
      return () => {
        throw new Error("unexpected call: " + name + "." + String(prop));
      };
    },
  });
}

const LOCAL = { id: "local", label: "Server", transport: "local" };
const FUTURE = new Date(Date.now() + 30 * 86400000);

function renterDoc(id, extra = {}) {
  return {
    _id: id,
    username: id,
    usernameLower: id,
    status: "active",
    accessEnd: FUTURE,
    botHost: "local",
    botFile: "config_07.json",
    botStoppedAt: null,
    maxAccounts: 50,
    farmGames: [],
    ...extra,
  };
}

function world({ pool = [], renters = [], renterAccounts = [] } = {}) {
  const calls = {
    renterLookups: [],
    renterSaves: [],
    busyMarks: [],
    stackReads: 0,
    configWrites: [],
    poolWrites: [],
    renterRowDeletes: [],
    taskPulls: [],
    usage: [],
  };
  const renterById = new Map(
    renters.map((r) => {
      const doc = {
        ...r,
        async save() {
          calls.renterSaves.push({ id: this._id, botFile: this.botFile, botHost: this.botHost });
        },
      };
      return [String(r._id), doc];
    }),
  );
  const matchesRenterAccount = (q, r) =>
    (q.renter === undefined || String(q.renter) === String(r.renter)) &&
    (q.$or || []).some((c) =>
      "clientSecret" in c ? c.clientSecret === r.clientSecret : c.login.test(r.login || ""),
    );

  const stubs = new Map([
    ["../models/AvailableAccount", strict("AvailableAccount", {
      findOne(q) {
        const row = pool.find((r) => r.usernameLower === q.usernameLower) || null;
        return query(row);
      },
      updateOne(filter, update, opts) {
        calls.poolWrites.push({ filter, update, opts });
        return Promise.resolve({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
      },
    })],
    ["../models/Renter", strict("Renter", {
      findById(id) {
        calls.renterLookups.push(String(id));
        return query(renterById.get(String(id)) || null);
      },
      find: () => query([]),
    })],
    ["../models/RenterAccount", strict("RenterAccount", {
      countDocuments: async () => 0,
      findOne: (q) => query(renterAccounts.find((r) => matchesRenterAccount(q, r)) || null),
      find: () => query([]),
      deleteOne: async (q) => {
        calls.renterRowDeletes.push(q);
        return { deletedCount: 1 };
      },
      updateOne: () => Promise.resolve({}),
    })],
    ["../models/BotAccount", strict("BotAccount", { findOne: () => query(null) })],
    ["../models/MarketplaceListing", strict("MarketplaceListing", {
      find: () => query([]),
      findOne: () => query(null),
    })],
    ["../models/FarmServiceOrder", strict("FarmServiceOrder", { findOne: () => query(null) })],
    ["../models/AutoFarmTask", strict("AutoFarmTask", {
      updateMany: (q, u) => {
        calls.taskPulls.push({ q, u });
        return Promise.resolve({});
      },
    })],
    ["../utils/renters", strict("renters", {
      // Same rules as utils/renters.js (not loaded: it needs bcrypt + the Renter model).
      normGames: (v) =>
        (Array.isArray(v) ? v : String(v || "").split(","))
          .map((g) => String(g).trim())
          .filter(Boolean),
      isBlocked: (r) =>
        !r || r.status === "suspended" || !!(r.accessEnd && new Date(r.accessEnd) <= new Date()),
      isOperatorHolder: (r) =>
        !!r && String(r.usernameLower || r.username || "").toLowerCase() === "operator-selffarm",
      OPERATOR_HOLDER_USERNAME: "operator-selffarm",
    })],
    ["../utils/renterAccountBusy", strict("renterAccountBusy", {
      tryAcquire: (keys) => {
        calls.busyMarks.push(keys.map(String));
        return () => {};
      },
    })],
    ["../utils/botHosts", strict("botHosts", {
      resolveHost: (id) => (!id || id === "local" ? LOCAL : null),
      listHosts: () => [LOCAL],
      dockerPs: async () => ({}),
    })],
    ["../utils/renterBotStacks", strict("renterBotStacks", {
      listStacks: async () => {
        calls.stackReads += 1;
        return [];
      },
      // Quick farm's auto-assign: the picker always has a stack for the old bytes.
      chooseAvailableStack: () => ({ host: "local", file: "config_09.json" }),
      stackKey: (h, f) => h + "|" + f,
    })],
    ["./botConfigRoutes", strict("botConfigRoutes", {
      addRenterAccountsToConfig: async (host, file, accts, renterId, opts) => {
        calls.configWrites.push({ host: host.id, file, logins: accts.map((a) => a.Login), renter: String(renterId), opts });
      },
      containerForFile: (file) => "twitchbot-" + file,
      restartConfigContainer: async () => {},
      getConfigGames: async () => [],
      validFile: () => true,
    })],
    ["../utils/renterBotOps", strict("renterBotOps", {
      startRenterFarming: async () => {},
      detachFromFile: async () => ({ removed: 0 }),
      settleAfterDetach: async () => {},
    })],
    ["../utils/listingDetach", strict("listingDetach", {
      detachAccountFromListing: async () => ({ detached: [], warnings: [] }),
    })],
    ["../utils/poolUsageLog", strict("poolUsageLog", {
      recordPoolUsage: async (id, ev) => calls.usage.push({ id: String(id), ...ev }),
    })],
    ["../utils/secretBox", strict("secretBox", { encrypt: (s) => "enc:" + s, decrypt: (s) => s })],
    ["../utils/systemLog", strict("systemLog", { logEvent: () => {} })],
  ]);
  return { calls, stubs, renterById };
}

async function serve(w) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /renterAdminRoutes\.js$/.test(parent.filename || "");
    if (from && w.stubs.has(request)) return w.stubs.get(request);
    // Every other local module of the router is inert here; the real auth
    // middleware is kept so the stub session is what grants access.
    if (from && request.startsWith(".") && request !== "../middleware/auth") return strict(request);
    return realLoad.call(this, request, parent, isMain);
  };
  let router;
  try {
    const p = require.resolve("../routes/renterAdminRoutes");
    delete require.cache[p];
    router = require("../routes/renterAdminRoutes");
    delete require.cache[p];
  } finally {
    Module._load = realLoad;
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { admin: { id: "root", username: "root", role: "superadmin" } };
    next();
  });
  app.use(router);
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    async add(renterId, body) {
      const res = await fetch(base + "/renters/" + renterId + "/accounts/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

function poolRow(login, extra = {}) {
  return { _id: "pool-" + login, username: login, usernameLower: login.toLowerCase(), status: "available", claimedNote: "", ...extra };
}

function assertNothingWritten(w) {
  assert.deepEqual(w.calls.renterLookups, [], "refused before the renter is even looked up");
  assert.deepEqual(w.calls.busyMarks, [], "no busy mark taken");
  assert.equal(w.calls.stackReads, 0, "no rental stack picked");
  assert.deepEqual(w.calls.renterSaves, [], "no stack assigned to the renter");
  assert.deepEqual(w.calls.configWrites, [], "no bot config written");
  assert.deepEqual(w.calls.poolWrites, [], "the pool row is not re-labelled");
  assert.deepEqual(w.calls.renterRowDeletes, [], "no renter row moved");
  assert.deepEqual(w.calls.taskPulls, [], "no auto-farm task touched");
  assert.deepEqual(w.calls.usage, [], "no pool usage recorded");
}

test("a no-claim bot's account is refused 409, naming its owner, with nothing written", async () => {
  const w = world({
    pool: [poolRow("NoClaim1", { status: "claimed", claimedNote: "noclaim-farm:Rainbow Six Siege" })],
    renters: [renterDoc("bob")],
  });
  const s = await serve(w);
  try {
    const r = await s.add("bob", { username: "NoClaim1", token: "tok-nc1", games: ["Rust"] });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, {
      success: false,
      message:
        "The account pool says NoClaim1 belongs to another system (noclaim-farm:Rainbow Six Siege) — " +
        "release it there first. Nothing was changed.",
    });
    assertNothingWritten(w);
  } finally {
    await s.close();
  }
});

test("Quick farm on an auto-farm login is refused before a rental stack is assigned", async () => {
  const w = world({
    pool: [poolRow("farmed7", { status: "claimed", claimedNote: "auto-farm: Rust (camp-3)" })],
    renters: [renterDoc("carol", { botHost: "", botFile: "" })],
  });
  const s = await serve(w);
  try {
    const r = await s.add("carol", {
      username: "farmed7",
      token: "tok-f7",
      quick: true,
      autoAssign: true,
      games: ["Rust"],
      farmDays: 7,
    });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /^The account pool says farmed7 belongs to another system \(auto-farm: Rust \(camp-3\)\)/);
    assertNothingWritten(w);
    assert.equal(w.renterById.get("carol").botFile, "", "carol keeps no stack");
  } finally {
    await s.close();
  }
});

test("held stock and an unexplained claim are refused too", async () => {
  const w = world({
    pool: [
      poolRow("stocky", { status: "claimed", claimedNote: "unclaimed stock — 2 drop(s) (Overwatch 2) held out of the pool until sold" }),
      poolRow("bare", { status: "claimed", claimedNote: "" }),
    ],
    renters: [renterDoc("bob")],
  });
  const s = await serve(w);
  try {
    const a = await s.add("bob", { username: "stocky", token: "tok-s", games: ["Rust"] });
    assert.equal(a.status, 409);
    assert.match(a.body.message, /\(unclaimed stock — 2 drop\(s\)/);
    const b = await s.add("bob", { username: "bare", token: "tok-b", games: ["Rust"] });
    assert.equal(b.status, 409);
    assert.match(b.body.message, /belongs to another system \(claimed, no note\)/);
    assertNothingWritten(w);
  } finally {
    await s.close();
  }
});

test("renter-to-renter: a login rented to someone else still moves (with that path's own confirm)", async () => {
  const w = world({
    pool: [poolRow("shared9", { status: "claimed", claimedNote: "rented to alice" })],
    renters: [renterDoc("bob"), renterDoc("alice")],
    renterAccounts: [
      { _id: "ra-9", renter: "alice", clientSecret: "tok-9", login: "shared9", configFile: "", host: "local", farmEndedAt: null, farmUntil: null },
    ],
  });
  const s = await serve(w);
  try {
    // Alice's lease is live, so the move asks first — the existing confirm.
    const ask = await s.add("bob", { username: "shared9", token: "tok-9", games: ["Rust"] });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.needsForce, true);
    assert.match(ask.body.message, /it farms for renter alice, whose lease is active/);
    assert.deepEqual(w.calls.configWrites, []);

    const r = await s.add("bob", { username: "shared9", token: "tok-9", games: ["Rust"], force: true });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.moved, true);
    assert.deepEqual(w.calls.configWrites, [
      { host: "local", file: "config_07.json", logins: ["shared9"], renter: "bob", opts: {} },
    ]);
    assert.deepEqual(w.calls.renterRowDeletes, [{ _id: "ra-9", renter: "alice" }]);
    assert.equal(w.calls.poolWrites.length, 1);
    assert.equal(w.calls.poolWrites[0].update.$set.claimedNote, "rented to bob");
  } finally {
    await s.close();
  }
});

test("a 'Rented to' note in any case counts as a rental", async () => {
  const w = world({
    pool: [poolRow("caps1", { status: "claimed", claimedNote: "Rented to Bob until 2026-10-20" })],
    renters: [renterDoc("bob")],
  });
  const s = await serve(w);
  try {
    const r = await s.add("bob", { username: "caps1", token: "tok-c1", games: ["Rust"] });
    assert.equal(r.status, 200);
    assert.equal(w.calls.configWrites.length, 1);
  } finally {
    await s.close();
  }
});

test("an available pool row, or none at all, is added exactly as before", async () => {
  const w = world({
    pool: [poolRow("fresh1")],
    renters: [renterDoc("bob")],
  });
  const s = await serve(w);
  try {
    const a = await s.add("bob", { username: "fresh1", token: "tok-f1", password: "pw", games: ["Rust"] });
    assert.equal(a.status, 200);
    assert.equal(a.body.success, true);
    const b = await s.add("bob", { username: "notInPool", token: "tok-n", games: ["Rust"] });
    assert.equal(b.status, 200);
    assert.deepEqual(w.calls.configWrites.map((c) => c.logins[0]), ["fresh1", "notInPool"]);
    assert.deepEqual(
      w.calls.poolWrites.map((p) => [p.filter.usernameLower, p.update.$set.claimedNote, p.opts.upsert]),
      [
        ["fresh1", "rented to bob", true],
        ["notinpool", "rented to bob", true],
      ],
    );
  } finally {
    await s.close();
  }
});
