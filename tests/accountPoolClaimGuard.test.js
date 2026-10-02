/* global fetch */
// The account pool page's Claim / Unclaim buttons (routes/accountPoolRoutes.js).
//
// The pool row's claimedNote is the only record of which system owns a login,
// and both buttons wrote it unconditionally. Claim re-labelled a row another
// system had just claimed; Unclaim flipped ANY row back to available — a login
// a renter or rent-farm buyer still farms, a no-claim bot's account, held
// unclaimed stock — straight into the next farm claim: one login, two homes.
// These pin the 2026-10-03 rules (docs/LIVE-FIXES-1003.md §A5.2): claim takes
// only an available row (409 "Already claimed (<note>)"), unclaim refuses with
// a plain reason while a live owner holds the row, and otherwise works as
// before. The page toasts `message` on any non-2xx, so the words ARE the UI.
//
// No database: the router is mounted in a bare express app with a stub
// superadmin session, and every model it touches is an in-memory fake.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const express = require("express");

function query(value) {
  const p = Promise.resolve(value);
  return {
    lean: () => Promise.resolve(value),
    then: (a, b) => p.then(a, b),
    catch: (f) => p.catch(f),
  };
}

function matchField(rowValue, want) {
  if (want && typeof want === "object" && Array.isArray(want.$in)) {
    return want.$in.includes(rowValue === undefined ? null : rowValue);
  }
  return rowValue === want;
}

// A tiny pool / renter / farm-task world, with every write recorded.
function world({ pool = [], renterAccounts = [], tasks = [] } = {}) {
  const calls = { claimWrites: [], usage: [], renterLookups: [], taskLookups: [] };
  const hooks = { afterRead: null };
  const AvailableAccount = {
    findOneAndUpdate(filter, update) {
      calls.claimWrites.push({ filter, update });
      const row = pool.find((r) =>
        Object.entries(filter).every(([k, v]) =>
          k === "_id" ? String(r._id) === String(v) : matchField(r[k], v),
        ),
      );
      if (row) Object.assign(row, update.$set);
      return query(row ? { ...row } : null);
    },
    findById(id) {
      const row = pool.find((r) => String(r._id) === String(id));
      const snap = row ? { ...row } : null;
      if (hooks.afterRead) hooks.afterRead(row);
      return query(snap);
    },
    // The pre-2026-10-03 routes wrote through this, unconditionally. Kept so
    // the old bytes run their real path here (and fail these tests on what
    // they write, not on a missing fake).
    findByIdAndUpdate(id, update) {
      calls.claimWrites.push({ filter: { _id: id }, update });
      const row = pool.find((r) => String(r._id) === String(id));
      if (row) Object.assign(row, update.$set);
      return query(row ? { ...row } : null);
    },
  };
  const RenterAccount = {
    findOne(q) {
      calls.renterLookups.push(q);
      const hit = renterAccounts.find(
        (r) =>
          (q.farmEndedAt !== null || r.farmEndedAt == null) &&
          (q.$or || []).some((c) =>
            "clientSecret" in c ? c.clientSecret === r.clientSecret : c.login.test(r.login),
          ),
      );
      return query(hit ? { _id: hit._id } : null);
    },
  };
  const AutoFarmTask = {
    findOne(q) {
      calls.taskLookups.push(q);
      const hit = tasks.find(
        (t) => t.status === q.status && (t.assignedAccounts || []).some((u) => q.assignedAccounts.test(u)),
      );
      return query(hit ? { _id: hit._id, game: hit.game } : null);
    },
  };
  const stubs = new Map([
    ["../models/AvailableAccount", AvailableAccount],
    ["../models/RenterAccount", RenterAccount],
    ["../models/AutoFarmTask", AutoFarmTask],
    ["../models/PoolUsageEvent", {}],
    ["../models/BotAccount", {}],
    ["../models/DropLog", {}],
    ["../utils/accountPoolChecker", {}],
    ["../utils/dropScanner", {}],
    ["../utils/parseAccountList", { parseAccountList: () => ({ accounts: [], badLines: [] }) }],
    ["../utils/secretBox", { encrypt: (s) => s, decrypt: (s) => s }],
    ["../utils/twitchInventory", {}],
    ["../utils/poolUsageLog", { recordPoolUsage: async (id, ev) => calls.usage.push({ id: String(id), ...ev }) }],
    ["../utils/poolUsageWatcher", { usageSince: () => ({}), summarizeUsageRows: () => ({}) }],
    ["../utils/tokenReplace", {}],
    ["../utils/systemLog", { actorFromReq: () => "test", logEvent: () => {} }],
  ]);
  return { pool, calls, hooks, stubs };
}

async function serve(w) {
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const from = parent && /accountPoolRoutes\.js$/.test(parent.filename || "");
    if (from && w.stubs.has(request)) return w.stubs.get(request);
    return realLoad.call(this, request, parent, isMain);
  };
  let router;
  try {
    const p = require.resolve("../routes/accountPoolRoutes");
    delete require.cache[p];
    router = require("../routes/accountPoolRoutes");
    delete require.cache[p];
  } finally {
    Module._load = realLoad;
  }
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (req.get("x-test-anon") !== "1") {
      req.session = { admin: { id: "root", username: "root", role: "superadmin" } };
    }
    next();
  });
  app.use(router);
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = "http://127.0.0.1:" + server.address().port;
  return {
    async post(path, body, headers = {}) {
      const res = await fetch(base + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify(body || {}),
      });
      return { status: res.status, body: await res.json() };
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

function row(id, extra = {}) {
  return {
    _id: id,
    username: "User_" + id,
    usernameLower: "user_" + id,
    clientSecret: "tok-" + id,
    status: "available",
    claimedNote: "",
    claimedAt: null,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

test("claim: an available row is claimed with the note, as before", async () => {
  const w = world({ pool: [row("a1")] });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/a1/claim", { note: "assigned to a bot" });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.account.status, "claimed");
    assert.equal(r.body.account.claimedNote, "assigned to a bot");
    assert.equal(w.pool[0].status, "claimed");
    assert.deepEqual(w.calls.usage, [{ id: "a1", event: "claimed", actor: "manual", note: "assigned to a bot" }]);
    // The write itself is conditional on the row still being available.
    assert.deepEqual(w.calls.claimWrites[0].filter, { _id: "a1", status: "available" });
  } finally {
    await s.close();
  }
});

test("claim: a row another system holds is refused 409 and keeps its owner's note", async () => {
  const w = world({ pool: [row("a2", { status: "claimed", claimedNote: "noclaim-farm:Rust" })] });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/a2/claim", { note: "assigned to a bot" });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { success: false, message: "Already claimed (noclaim-farm:Rust)" });
    assert.equal(w.pool[0].claimedNote, "noclaim-farm:Rust", "the owner's note is untouched");
    assert.equal(w.calls.usage.length, 0, "no usage event for a claim that did not happen");
  } finally {
    await s.close();
  }
});

test("claim: a claimed row with no note says so; an unknown id is still 404", async () => {
  const w = world({ pool: [row("a3", { status: "claimed", claimedNote: "" })] });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/a3/claim", {});
    assert.equal(r.status, 409);
    assert.equal(r.body.message, "Already claimed (no note)");
    const missing = await s.post("/account-pool/zz/claim", {});
    assert.equal(missing.status, 404);
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// Unclaim refusals: a live owner holds the row
// ---------------------------------------------------------------------------

test("unclaim: refused while a renter's bot still holds a rented row (matched by token)", async () => {
  const w = world({
    pool: [row("b1", { status: "claimed", claimedNote: "rented to operator-selffarm until 2026-11-01" })],
    renterAccounts: [{ _id: "ra1", clientSecret: "tok-b1", login: "someone_else", farmEndedAt: null }],
  });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/b1/unclaim");
    assert.equal(r.status, 409);
    assert.equal(r.body.success, false);
    assert.equal(
      r.body.message,
      "It is rented to operator-selffarm until 2026-11-01 and still on a renter's bot — " +
        "take it off the renter first (Renters page).",
    );
    assert.equal(w.pool[0].status, "claimed", "nothing released");
    assert.equal(w.calls.claimWrites.length, 0, "nothing written");
    assert.equal(w.calls.usage.length, 0);
    assert.deepEqual(w.calls.renterLookups[0].farmEndedAt, null, "only a LIVE renter row holds it");
  } finally {
    await s.close();
  }
});

test("unclaim: a rented row is held by login too, case-insensitively", async () => {
  const w = world({
    pool: [row("b2", { status: "claimed", claimedNote: "rented to bob", clientSecret: "" })],
    renterAccounts: [{ _id: "ra2", clientSecret: "other-token", login: "USER_B2", farmEndedAt: null }],
  });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/b2/unclaim");
    assert.equal(r.status, 409);
    assert.match(r.body.message, /^It is rented to bob and still on a renter's bot/);
  } finally {
    await s.close();
  }
});

test("unclaim: a rented row whose window has lapsed (off every renter bot) is released as before", async () => {
  const w = world({
    pool: [row("b3", { status: "claimed", claimedNote: "rented to bob" })],
    renterAccounts: [{ _id: "ra3", clientSecret: "tok-b3", login: "user_b3", farmEndedAt: new Date("2026-09-30") }],
  });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/b3/unclaim");
    assert.equal(r.status, 200);
    assert.equal(w.pool[0].status, "available");
    assert.equal(w.pool[0].claimedNote, "");
    assert.deepEqual(w.calls.usage, [{ id: "b3", event: "released", actor: "manual" }]);
  } finally {
    await s.close();
  }
});

test("unclaim: refused for a no-claim bot's account — it must leave its bot first", async () => {
  const w = world({ pool: [row("c1", { status: "claimed", claimedNote: "noclaim-farm:Rainbow Six Siege" })] });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/c1/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "The No-claim farm holds it (noclaim-farm:Rainbow Six Siege) — release it from the No-claim " +
        "farm page so it leaves its bot first.",
    );
    assert.equal(w.pool[0].status, "claimed");
    assert.equal(w.calls.usage.length, 0);
  } finally {
    await s.close();
  }
});

test("unclaim: refused for held unclaimed stock", async () => {
  const note = "unclaimed stock — 3 drop(s) (Overwatch 2) held out of the pool until sold";
  const w = world({ pool: [row("c2", { status: "claimed", claimedNote: note })] });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/c2/unclaim");
    assert.equal(r.status, 409);
    assert.match(r.body.message, /^It is held as stock: it carries farmed drops nobody has claimed yet\./);
    assert.match(r.body.message, /puts it back by itself once that stock is sold or expires\.$/);
    assert.equal(w.pool[0].claimedNote, note);
  } finally {
    await s.close();
  }
});

test("unclaim: refused while an ACTIVE auto-farm task has the login (any case)", async () => {
  const w = world({
    pool: [row("c3", { status: "claimed", claimedNote: "auto-farm backfill: Rust (camp-9)" })],
    tasks: [
      { _id: "t-old", status: "completed", game: "Rust", assignedAccounts: ["User_c3"] },
      { _id: "t1", status: "active", game: "Rust", assignedAccounts: ["someone", "USER_C3"] },
    ],
  });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/c3/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "The auto-farm is farming it for Rust — it comes back to the pool by itself when that task ends.",
    );
    assert.equal(w.pool[0].status, "claimed");
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// Unclaim as before: nobody live holds it
// ---------------------------------------------------------------------------

test("unclaim: an auto-farm row whose task is over is released as before", async () => {
  const w = world({
    pool: [row("d1", { status: "claimed", claimedNote: "auto-farm: Rust (camp-1)" })],
    tasks: [{ _id: "t2", status: "completed", game: "Rust", assignedAccounts: ["User_d1"] }],
  });
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/d1/unclaim");
    assert.equal(r.status, 200);
    assert.equal(r.body.account.status, "available");
    assert.equal(w.pool[0].status, "available");
  } finally {
    await s.close();
  }
});

test("unclaim: a hand claim (or no note) is released as before", async () => {
  const w = world({
    pool: [
      row("d2", { status: "claimed", claimedNote: "assigned to a bot" }),
      row("d3", { status: "claimed", claimedNote: "" }),
    ],
  });
  const s = await serve(w);
  try {
    assert.equal((await s.post("/account-pool/d2/unclaim")).status, 200);
    assert.equal((await s.post("/account-pool/d3/unclaim")).status, 200);
    assert.deepEqual(w.pool.map((r) => r.status), ["available", "available"]);
    assert.equal(w.calls.usage.length, 2);
    assert.equal((await s.post("/account-pool/nope/unclaim")).status, 404);
  } finally {
    await s.close();
  }
});

test("unclaim: a row that changes hands between the check and the write is not released", async () => {
  const w = world({ pool: [row("e1", { status: "claimed", claimedNote: "assigned to a bot" })] });
  // A renter add re-labels the row right after the route read it.
  w.hooks.afterRead = (r) => {
    if (r) r.claimedNote = "rented to bob";
  };
  const s = await serve(w);
  try {
    const r = await s.post("/account-pool/e1/unclaim");
    assert.equal(r.status, 409);
    assert.equal(r.body.message, "It changed a moment ago — refresh and try again.");
    assert.equal(w.pool[0].status, "claimed");
    assert.equal(w.pool[0].claimedNote, "rented to bob");
    assert.equal(w.calls.usage.length, 0);
  } finally {
    await s.close();
  }
});

test("both buttons still require a superadmin session", async () => {
  const w = world({ pool: [row("f1", { status: "claimed", claimedNote: "x" })] });
  const s = await serve(w);
  try {
    assert.equal((await s.post("/account-pool/f1/unclaim", {}, { "x-test-anon": "1" })).status, 401);
    assert.equal((await s.post("/account-pool/f1/claim", {}, { "x-test-anon": "1" })).status, 401);
    assert.equal(w.pool[0].claimedNote, "x");
  } finally {
    await s.close();
  }
});
