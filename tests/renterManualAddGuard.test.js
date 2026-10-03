/* global fetch */
// Renter MANUAL ADD / Quick farm (POST /renters/:id/accounts/manual,
// routes/renterAdminRoutes.js) and the account pool row it re-labels.
//
// The route moves an account onto a renter's bot from wherever it farms — off
// an operator bot, out of auto-farm tasks, off another renter's bot — and ends
// by writing the login's pool row "rented to <renter>". Two things went wrong
// with that pool write (2026-10-03, docs/LIVE-FIXES-1003.md §A5.3 and the
// review that followed):
//   1. three owners cannot be handed over at all: a no-claim bot (nothing here
//      touches its config, so the login would farm in both, and a claiming
//      renter bot empties the no-claim stock), held unclaimed stock, and an
//      account already sold to a buyer ("spent — …", "sold — …", "burned — …").
//      Those are refused before anything is written; every other owner goes on
//      to the route's designed moves, exactly as before.
//   2. the write was an unconditional upsert by login, seconds of SSH after the
//      pool row was read. A farm claim landing in between was re-labelled
//      "rented to …" — its owner lost sight of a login it still farms. The
//      write is now conditional on the row still being what the guard approved
//      (absent, available, rented to someone, or exactly as read); otherwise
//      the row is left alone, the response carries a ⚠ note naming the new
//      owner, and a renter_add_conflict event is logged.
//
// No database, no hosts: the router is mounted in a bare express app with a
// stub superadmin session; models, host I/O and config writers are fakes that
// record every write. They carry the old route all the way to its writes, so
// these tests fail on old bytes for what it WROTE, not for a missing fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const express = require("express");
// The real stock-note rule (utils/poolStock is pure for isStockNote).
const poolStock = require("../utils/poolStock");

// .lean() hands back copies, as Mongo does — never the store's own objects.
function query(value) {
  const p = Promise.resolve(value);
  return {
    lean: () =>
      Promise.resolve(
        Array.isArray(value) ? value.map(plain) : value && typeof value === "object" ? plain(value) : value,
      ),
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

// Mongo-ish filter evaluation, enough for the route's pool queries.
function matches(row, filter) {
  return Object.entries(filter).every(([k, want]) => {
    if (k === "$or") return want.some((clause) => matches(row, clause));
    const have = row[k] === undefined ? null : row[k];
    if (want instanceof RegExp) return want.test(String(row[k] || ""));
    if (want && typeof want === "object" && Array.isArray(want.$in)) return want.$in.includes(have);
    return have === want;
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

// The route's loginMatcher() hands Mongo { $regex, $options }.
function regexOf(want) {
  return want instanceof RegExp ? want : new RegExp(want.$regex, want.$options || "");
}

function world({ pool = [], renters = [], renterAccounts = [], orders = [] } = {}) {
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
    events: [],
    orderLookups: [],
  };
  // onConfigWrite: what another system does to the pool while the config write
  // runs. failPoolWrite: the pool write itself errors.
  const hooks = { onConfigWrite: null, failPoolWrite: false };
  let inserted = 0;
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
      find(q) {
        return query(pool.filter((r) => matches(r, q)));
      },
      findOne(q) {
        return query(pool.find((r) => matches(r, q)) || null);
      },
      updateOne(filter, update, opts = {}) {
        calls.poolWrites.push({ filter, update, opts });
        if (hooks.failPoolWrite) return Promise.reject(new Error("write concern timed out"));
        const hit = pool.find((r) => matches(r, filter));
        if (hit) {
          if (update.$set) Object.assign(hit, update.$set);
          return Promise.resolve({ matchedCount: 1, modifiedCount: update.$set ? 1 : 0, upsertedCount: 0 });
        }
        if (opts.upsert) {
          const doc = { _id: "pool-new-" + ++inserted, usernameLower: filter.usernameLower, ...update.$set, ...update.$setOnInsert };
          pool.push(doc);
          return Promise.resolve({ matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id });
        }
        return Promise.resolve({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });
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
    ["../models/FarmServiceOrder", strict("FarmServiceOrder", {
      findOne(q) {
        calls.orderLookups.push(q);
        const clauses = q.$or || [q];
        const hit = orders.find((o) =>
          clauses.some((c) =>
            "accounts.poolId" in c
              ? (o.accounts || []).some((a) => c["accounts.poolId"].$in.includes(a.poolId))
              : (o.accounts || []).some((a) => regexOf(c["accounts.login"]).test(a.login || "")),
          ),
        );
        return query(hit ? { orderId: hit.orderId, market: hit.market, buyerUsername: hit.buyerUsername } : null);
      },
    })],
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
      // Quick farm's auto-assign: the picker always has a stack.
      chooseAvailableStack: () => ({ host: "local", file: "config_09.json" }),
      stackKey: (h, f) => h + "|" + f,
    })],
    ["./botConfigRoutes", strict("botConfigRoutes", {
      addRenterAccountsToConfig: async (host, file, accts, renterId, opts) => {
        calls.configWrites.push({ host: host.id, file, logins: accts.map((a) => a.Login), renter: String(renterId), opts });
        if (hooks.onConfigWrite) await hooks.onConfigWrite();
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
    ["../utils/poolStock", poolStock],
    ["../utils/secretBox", strict("secretBox", { encrypt: (s) => "enc:" + s, decrypt: (s) => s })],
    ["../utils/systemLog", strict("systemLog", { logEvent: (e) => calls.events.push(e) })],
  ]);
  return { calls, hooks, stubs, pool, renterById };
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

async function withServer(w, fn) {
  const s = await serve(w);
  try {
    await fn(s);
  } finally {
    await s.close();
  }
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

// ---------------------------------------------------------------------------
// 1. The owners this route cannot hand over
// ---------------------------------------------------------------------------

test("a no-claim bot's account is refused 409, naming its owner, with nothing written", async () => {
  const w = world({
    pool: [poolRow("NoClaim1", { status: "claimed", claimedNote: "noclaim-farm:Rainbow Six Siege" })],
    renters: [renterDoc("bob")],
  });
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "NoClaim1", token: "tok-nc1", games: ["Rust"] });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, {
      success: false,
      message:
        "The account pool says NoClaim1 belongs to another system (noclaim-farm:Rainbow Six Siege) — " +
        "release it there first. Nothing was changed.",
    });
    assertNothingWritten(w);
  });
});

test("held stock and accounts already sold to a buyer are refused too, with nothing written", async () => {
  const notes = [
    "unclaimed stock — 2 drop(s) (Overwatch 2) held out of the pool until sold",
    "spent — unclaimed auto-listed (sold on ggsel)",
    "spent — no-claim removed Overwatch 2",
    "sold — token reclaimed by buyer",
    "burned — credentials seen by a Gameflip buyer whose purchase was cancelled; never resell (x)",
  ];
  const w = world({
    pool: notes.map((n, i) => poolRow("deny" + i, { status: "claimed", claimedNote: n })),
    renters: [renterDoc("bob")],
  });
  await withServer(w, async (s) => {
    for (const [i, n] of notes.entries()) {
      const r = await s.add("bob", { username: "deny" + i, token: "tok-d" + i, games: ["Rust"] });
      assert.equal(r.status, 409, n);
      assert.equal(
        r.body.message,
        "The account pool says deny" + i + " belongs to another system (" + n + ") — release it there first. " +
          "Nothing was changed.",
      );
    }
    assertNothingWritten(w);
  });
});

test("Quick farm on a sold account is refused before a rental stack is assigned", async () => {
  const w = world({
    pool: [poolRow("sold1", { status: "claimed", claimedNote: "spent — no-claim removed Overwatch 2" })],
    renters: [renterDoc("carol", { botHost: "", botFile: "" })],
  });
  await withServer(w, async (s) => {
    const r = await s.add("carol", { username: "sold1", token: "tok-s1", quick: true, autoAssign: true, games: ["Rust"], farmDays: 7 });
    assert.equal(r.status, 409);
    assertNothingWritten(w);
    assert.equal(w.renterById.get("carol").botFile, "", "carol keeps no stack");
  });
});

test("the same token under another login is the same account — refused, naming that row", async () => {
  const w = world({
    pool: [poolRow("oldlogin", { status: "claimed", claimedNote: "noclaim-farm:Overwatch", clientSecret: "tok-same" })],
    renters: [renterDoc("bob")],
  });
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "newlogin", token: "tok-same", games: ["Rust"] });
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "The account pool says newlogin (same token as oldlogin) belongs to another system " +
        "(noclaim-farm:Overwatch) — release it there first. Nothing was changed.",
    );
    assertNothingWritten(w);
  });
});

test("'unclaimed stock was claimed — probably sold by hand' is refused like any sale", async () => {
  const note = "unclaimed stock was claimed — probably sold by hand; check before reusing";
  const w = world({ pool: [poolRow("handsold1", { status: "claimed", claimedNote: note })], renters: [renterDoc("bob")] });
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "handsold1", token: "tok-h1", games: ["Rust"] });
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "The account pool says handsold1 belongs to another system (" + note + ") — release it there first. " +
        "Nothing was changed.",
    );
    assertNothingWritten(w);
  });
});

test("a rent-farm buyer's account asks for confirmation even with no renter row left", async () => {
  // The Renters page Remove deleted the holder's row; the order still names the buyer.
  const w = world({
    pool: [poolRow("buyerlogin1", { status: "claimed", claimedNote: "rented to operator-selffarm until 2026-09-20" })],
    renters: [renterDoc("bob")],
    orders: [{ orderId: "e328ee9d-test", market: "eldorado", buyerUsername: "buyerX", accounts: [{ login: "BuyerLogin1", poolId: "pool-buyerlogin1" }] }],
  });
  await withServer(w, async (s) => {
    const ask = await s.add("bob", { username: "buyerlogin1", token: "tok-b1", games: ["Rust"] });
    assert.equal(ask.status, 409);
    assert.equal(ask.body.needsForce, true);
    assert.equal(
      ask.body.message,
      "This account belongs to a rent-farm buyer — confirm to add it here anyway: it was sold as a " +
        "rent-farm order (eldorado e328ee9d, buyer buyerX).",
    );
    assert.deepEqual(w.calls.configWrites, [], "nothing placed before the confirmation");
    assert.deepEqual(w.calls.poolWrites, []);

    const r = await s.add("bob", { username: "buyerlogin1", token: "tok-b1", games: ["Rust"], force: true });
    assert.equal(r.status, 200, "the confirmed add goes through");
    assert.equal(w.calls.configWrites.length, 1);
    assert.equal(w.pool[0].claimedNote, "rented to bob");
  });
});

test("the buyer's order is found by pool id too (the login was renamed)", async () => {
  const w = world({
    pool: [poolRow("oldname", { status: "claimed", claimedNote: "rented to operator-selffarm", clientSecret: "tok-r2" })],
    renters: [renterDoc("bob")],
    orders: [{ orderId: "pa:16458589", market: "playerauctions", accounts: [{ login: "oldname", poolId: "pool-oldname" }] }],
  });
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "newname", token: "tok-r2", games: ["Rust"] });
    assert.equal(r.status, 409);
    assert.equal(r.body.needsForce, true);
    assert.match(r.body.message, /: it was sold as a rent-farm order \(playerauctions pa:16458\)\.$/);
    assert.deepEqual(w.calls.configWrites, []);
  });
});

// ---------------------------------------------------------------------------
// Every other owner goes on to the route's designed moves
// ---------------------------------------------------------------------------

test("Quick farm on an auto-farm account proceeds: stack assigned, task detached, row rented", async () => {
  const w = world({
    pool: [poolRow("farmed7", { status: "claimed", claimedNote: "auto-farm: Rust (camp-3)" })],
    renters: [renterDoc("carol", { botHost: "", botFile: "" })],
  });
  await withServer(w, async (s) => {
    const r = await s.add("carol", {
      username: "farmed7",
      token: "tok-f7",
      quick: true,
      autoAssign: true,
      games: ["Rust"],
      farmDays: 7,
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.deepEqual(r.body.assignedStack, { host: "local", file: "config_09.json" });
    assert.equal(w.calls.renterSaves.length, 1, "the stack was assigned");
    assert.deepEqual(w.calls.configWrites.map((c) => [c.file, c.logins[0]]), [["config_09.json", "farmed7"]]);
    assert.equal(w.calls.taskPulls.length, 1, "pulled out of the auto-farm tasks");
    assert.equal(w.pool[0].status, "claimed");
    assert.equal(w.pool[0].claimedNote, "rented to carol");
    assert.equal(r.body.partial, false);
    assert.doesNotMatch(r.body.note, /⚠/);
  });
});

test("operator-bot, deploy, recycled, hand and note-less claims all proceed as before", async () => {
  const notes = [
    "deployed to twitchbotx5 [pi]",
    "auto-farm: deployed to twitchbot12 (contabo)",
    "in use by a bot (auto-marked)",
    "auto-farm backfill: Rust (camp-9)",
    "recycled after Rust",
    "assigned to a bot",
    "",
  ];
  const w = world({
    pool: notes.map((n, i) => poolRow("ok" + i, { status: "claimed", claimedNote: n })),
    renters: [renterDoc("bob")],
  });
  await withServer(w, async (s) => {
    for (const [i, n] of notes.entries()) {
      const r = await s.add("bob", { username: "ok" + i, token: "tok-o" + i, games: ["Rust"] });
      assert.equal(r.status, 200, JSON.stringify(n) + ": " + JSON.stringify(r.body));
      assert.equal(w.pool[i].claimedNote, "rented to bob", JSON.stringify(n));
    }
    assert.equal(w.calls.configWrites.length, notes.length);
    assert.equal(w.calls.events.length, 0, "no conflict");
  });
});

test("renter-to-renter: a login rented to someone else still moves (with that path's own confirm)", async () => {
  const w = world({
    pool: [poolRow("shared9", { status: "claimed", claimedNote: "rented to alice" })],
    renters: [renterDoc("bob"), renterDoc("alice")],
    renterAccounts: [
      { _id: "ra-9", renter: "alice", clientSecret: "tok-9", login: "shared9", configFile: "", host: "local", farmEndedAt: null, farmUntil: null },
    ],
  });
  await withServer(w, async (s) => {
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
    assert.equal(w.pool[0].claimedNote, "rented to bob");
  });
});

test("a 'Rented to' note in any case counts as a rental", async () => {
  const w = world({
    pool: [poolRow("caps1", { status: "claimed", claimedNote: "Rented to Bob until 2026-10-20" })],
    renters: [renterDoc("bob")],
  });
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "caps1", token: "tok-c1", games: ["Rust"] });
    assert.equal(r.status, 200);
    assert.equal(w.calls.configWrites.length, 1);
    assert.equal(w.pool[0].claimedNote, "rented to bob");
  });
});

test("an available pool row, or none at all, ends rented to the renter as before", async () => {
  const w = world({ pool: [poolRow("fresh1")], renters: [renterDoc("bob")] });
  await withServer(w, async (s) => {
    const a = await s.add("bob", { username: "fresh1", token: "tok-f1", password: "pw", games: ["Rust"] });
    assert.equal(a.status, 200);
    assert.equal(a.body.success, true);
    const b = await s.add("bob", { username: "notInPool", token: "tok-n", games: ["Rust"] });
    assert.equal(b.status, 200);
    assert.deepEqual(w.calls.configWrites.map((c) => c.logins[0]), ["fresh1", "notInPool"]);
    const byLogin = Object.fromEntries(w.pool.map((p) => [p.usernameLower, p]));
    assert.equal(byLogin.fresh1.status, "claimed");
    assert.equal(byLogin.fresh1.claimedNote, "rented to bob");
    assert.equal(byLogin.fresh1.password, "enc:pw");
    assert.equal(byLogin.notinpool.status, "claimed", "created by the upsert");
    assert.equal(byLogin.notinpool.claimedNote, "rented to bob");
    assert.equal(byLogin.notinpool.clientSecret, "tok-n");
    assert.deepEqual(w.calls.usage.map((u) => u.event), ["rented", "rented"]);
  });
});

// ---------------------------------------------------------------------------
// 2. The final pool write is conditional on what the guard approved
// ---------------------------------------------------------------------------

test("a farm claim that lands during the config write is NOT re-labelled — ⚠ note + conflict event", async () => {
  const w = world({ pool: [poolRow("fresh9", { clientSecret: "tok-fresh9" })], renters: [renterDoc("bob")] });
  // While the route writes the renter's bot config over SSH, the no-claim
  // feeder takes the (still available) row.
  w.hooks.onConfigWrite = async () => {
    Object.assign(w.pool[0], { status: "claimed", claimedNote: "noclaim-farm:Overwatch 2 (bot 14)" });
  };
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "fresh9", token: "tok-fresh9", games: ["Rust"] });
    assert.equal(r.status, 200, "the account is on bob's bot — the add itself stands");
    assert.equal(r.body.partial, true);
    assert.match(
      r.body.note,
      /⚠ The account pool row changed while this ran — it now says noclaim-farm:Overwatch 2 \(bot 14\)\. It was left as it is, so that owner may still hold fresh9 too: take it off one of them\./,
    );
    assert.equal(w.pool[0].status, "claimed");
    assert.equal(w.pool[0].claimedNote, "noclaim-farm:Overwatch 2 (bot 14)", "the new owner's note is kept");
    assert.equal(w.calls.usage.length, 0, "no 'rented' usage for a row it did not take");
    assert.equal(w.calls.events.length, 1);
    const e = w.calls.events[0];
    assert.equal(e.category, "renter");
    assert.equal(e.action, "renter_add_conflict");
    assert.equal(e.severity, "warn");
    assert.equal(e.subject, "fresh9", "named by login, never by token");
    assert.match(e.detail, /read available, now claimed "noclaim-farm:Overwatch 2 \(bot 14\)"/);
    assert.deepEqual(e.meta.now, { status: "claimed", note: "noclaim-farm:Overwatch 2 (bot 14)" });
    assert.doesNotMatch(JSON.stringify(e), /tok-fresh9/);
  });
});

test("a row the guard read as an auto-farm claim is not overwritten once it became held stock", async () => {
  const stock = "unclaimed stock — 1 drop(s) (Rust) held out of the pool until sold";
  const w = world({
    pool: [poolRow("moved3", { status: "claimed", claimedNote: "auto-farm: Rust (camp-3)" })],
    renters: [renterDoc("bob")],
  });
  w.hooks.onConfigWrite = async () => {
    w.pool[0].claimedNote = stock;
  };
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "moved3", token: "tok-m3", games: ["Rust"] });
    assert.equal(r.status, 200);
    assert.equal(w.pool[0].claimedNote, stock);
    assert.match(r.body.note, /⚠ The account pool row changed while this ran — it now says unclaimed stock — 1 drop/);
    assert.equal(w.calls.events[0].action, "renter_add_conflict");
  });
});

test("a row another system CREATED meanwhile is not overwritten either", async () => {
  const w = world({ renters: [renterDoc("bob")] });
  w.hooks.onConfigWrite = async () => {
    w.pool.push(poolRow("late1", { status: "claimed", claimedNote: "noclaim-farm:Rust" }));
  };
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "late1", token: "tok-l1", games: ["Rust"] });
    assert.equal(r.status, 200);
    assert.equal(w.pool.length, 1);
    assert.equal(w.pool[0].claimedNote, "noclaim-farm:Rust");
    assert.equal(w.calls.events.length, 1);
    assert.match(w.calls.events[0].detail, /read no row, now claimed "noclaim-farm:Rust"/);
  });
});

test("a row deleted meanwhile is simply created rented — absent is approved", async () => {
  const w = world({ pool: [poolRow("gone2", { status: "claimed", claimedNote: "assigned to a bot" })], renters: [renterDoc("bob")] });
  w.hooks.onConfigWrite = async () => {
    w.pool.splice(0, 1);
  };
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "gone2", token: "tok-g2", games: ["Rust"] });
    assert.equal(r.status, 200);
    assert.equal(w.pool.length, 1);
    assert.equal(w.pool[0].claimedNote, "rented to bob");
    assert.equal(w.calls.events.length, 0);
    assert.doesNotMatch(r.body.note, /⚠/);
  });
});

test("a pool write that fails is reported, not swallowed", async () => {
  const w = world({ pool: [poolRow("err1")], renters: [renterDoc("bob")] });
  w.hooks.failPoolWrite = true;
  await withServer(w, async (s) => {
    const r = await s.add("bob", { username: "err1", token: "tok-e1", games: ["Rust"] });
    assert.equal(r.status, 200, "the account is placed; only its pool row is behind");
    assert.equal(r.body.partial, true);
    assert.match(
      r.body.note,
      /⚠ Added, but the account pool row could not be marked rented \(write concern timed out\) — mark it on the Account pool page, or a farm may claim it\./,
    );
    assert.equal(w.pool[0].status, "available");
  });
});
