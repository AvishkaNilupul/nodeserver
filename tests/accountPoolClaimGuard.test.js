/* global fetch */
// The account pool page's Claim / Unclaim buttons (routes/accountPoolRoutes.js).
//
// The pool row's claimedNote is the only record of which system owns a login,
// and both buttons wrote it unconditionally. Claim re-labelled a row another
// system had just claimed; Unclaim flipped ANY row back to available — a login
// a renter or rent-farm buyer still holds, a no-claim bot's account, held
// unclaimed stock, an auto-farm account on sale — straight into the next farm
// claim: one login, two homes. These pin the 2026-10-03 rules
// (docs/LIVE-FIXES-1003.md §A5.2 and the review that followed):
//   * claim takes only an available row (409 "Already claimed (<note>)");
//   * unclaim refuses, in plain words, while an owner still holds the row:
//       - "rented to …" with ANY renter row for the login/token (an ended
//         rent-farm window leaves the account with its buyer);
//       - "noclaim-farm:…" only while a no-claim bot's config still has the
//         token — ONE grep over every bot config; an orphan is released, and a
//         check that cannot answer refuses;
//       - held unclaimed stock;
//       - "auto-farm…" while the login is on a live listing or in an active task;
//   * otherwise it works as before.
// The page toasts `message` on any non-2xx, so the words ARE the UI.
//
// No database, no SSH: the router is mounted in a bare express app with a stub
// superadmin session; every model is an in-memory fake. The no-claim fleet's
// sh() runs the route's real script under the local /bin/sh against temporary
// bot directories, so the grep, the glob and the exit codes are the real ones.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const express = require("express");
const { shq } = require("../utils/botHosts");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pool-claim-guard-"));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function query(value) {
  const p = Promise.resolve(value);
  const q = {
    lean: () => Promise.resolve(value),
    limit: () => q,
    then: (a, b) => p.then(a, b),
    catch: (f) => p.catch(f),
  };
  return q;
}

function matchField(rowValue, want) {
  if (want && typeof want === "object" && Array.isArray(want.$in)) {
    return want.$in.includes(rowValue === undefined ? null : rowValue);
  }
  return rowValue === want;
}

// A no-claim bot directory: { "12": ["tok-a", …], … } -> BOTS_DIR on disk.
let botsDirs = 0;
function noclaimBots(byBot) {
  const dir = path.join(TMP, "bots-" + ++botsDirs);
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, secrets] of Object.entries(byBot)) {
    const cfgDir = path.join(dir, id, "Configuration");
    fs.mkdirSync(cfgDir, { recursive: true });
    const users = secrets.map((s, i) => ({ Login: "u" + id + "_" + i, ClientSecret: s, Enabled: i % 2 === 0 }));
    fs.writeFileSync(path.join(cfgDir, "config.json"), JSON.stringify({ TwitchSettings: { TwitchUsers: users } }, null, 2));
  }
  return dir;
}

// A tiny pool / renter / farm-task / listing / no-claim world, every write recorded.
function world({
  pool = [],
  renterAccounts = [],
  tasks = [],
  listed = [],
  ledgers = [],
  botsDir = noclaimBots({}),
  shError = null,
} = {}) {
  const calls = { claimWrites: [], usage: [], renterLookups: [], taskLookups: [], ledgerLookups: [], sh: [] };
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
  const renterMatch = (q) => (r) =>
    (q.farmEndedAt !== null || r.farmEndedAt == null) &&
    (q.$or || []).some((c) =>
      "clientSecret" in c ? c.clientSecret === r.clientSecret : c.login.test(r.login),
    );
  const RenterAccount = {
    findOne(q) {
      calls.renterLookups.push(q);
      const hit = renterAccounts.find(renterMatch(q));
      return query(hit ? { _id: hit._id, farmEndedAt: hit.farmEndedAt || null } : null);
    },
    find(q) {
      calls.renterLookups.push(q);
      return query(renterAccounts.filter(renterMatch(q)).map((r) => ({ _id: r._id, farmEndedAt: r.farmEndedAt || null })));
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
  // The no-claim ledger (models/UnclaimedAccount): by pool id or login, minus
  // the statuses the query excludes.
  const UnclaimedAccount = {
    find(q) {
      calls.ledgerLookups.push(q);
      const skip = (q.status && q.status.$nin) || [];
      return query(
        ledgers
          .filter((l) => !skip.includes(l.status))
          .filter((l) =>
            (q.$or || []).some((c) =>
              "poolAccountId" in c ? l.poolAccountId === c.poolAccountId : l.loginLower === c.loginLower,
            ),
          )
          .map((l) => ({ status: l.status, soldAt: l.soldAt || null })),
      );
    },
  };
  // utils/noclaimFleet.sh: trimmed stdout, rejects on a non-zero exit.
  const fleet = {
    BOTS_DIR: botsDir,
    sh(script, opts = {}) {
      calls.sh.push({ script, opts });
      if (shError) return Promise.reject(shError);
      return new Promise((resolve, reject) => {
        execFile("/bin/sh", ["-c", script], { timeout: opts.timeout }, (err, stdout) =>
          err ? reject(err) : resolve(String(stdout || "").trim()),
        );
      });
    },
  };
  const stubs = new Map([
    ["../models/AvailableAccount", AvailableAccount],
    ["../models/RenterAccount", RenterAccount],
    ["../models/AutoFarmTask", AutoFarmTask],
    ["../models/UnclaimedAccount", UnclaimedAccount],
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
    ["../utils/listedLogins", { loginsOnActiveListings: async () => new Set(listed.map((l) => l.toLowerCase())) }],
    ["../utils/noclaimFleet", fleet],
    ["../utils/botHosts", { shq }],
  ]);
  return { pool, calls, hooks, stubs };
}

// The route requires the no-claim fleet lazily, at request time, so the stub
// hook stays installed until the server closes.
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
  } catch (e) {
    Module._load = realLoad;
    throw e;
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
    async post(p, body, headers = {}) {
      const res = await fetch(base + p, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
        body: JSON.stringify(body || {}),
      });
      return { status: res.status, body: await res.json() };
    },
    close: () =>
      new Promise((r) => server.close(r)).finally(() => {
        Module._load = realLoad;
      }),
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
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/a1/claim", { note: "assigned to a bot" });
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.equal(r.body.account.status, "claimed");
    assert.equal(r.body.account.claimedNote, "assigned to a bot");
    assert.equal(w.pool[0].status, "claimed");
    assert.deepEqual(w.calls.usage, [{ id: "a1", event: "claimed", actor: "manual", note: "assigned to a bot" }]);
    // The write itself is conditional on the row still being available.
    assert.deepEqual(w.calls.claimWrites[0].filter, { _id: "a1", status: "available" });
  });
});

test("claim: a row another system holds is refused 409 and keeps its owner's note", async () => {
  const w = world({ pool: [row("a2", { status: "claimed", claimedNote: "noclaim-farm:Rust" })] });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/a2/claim", { note: "assigned to a bot" });
    assert.equal(r.status, 409);
    assert.deepEqual(r.body, { success: false, message: "Already claimed (noclaim-farm:Rust)" });
    assert.equal(w.pool[0].claimedNote, "noclaim-farm:Rust", "the owner's note is untouched");
    assert.equal(w.calls.usage.length, 0, "no usage event for a claim that did not happen");
  });
});

test("claim: a claimed row with no note says so; an unknown id is still 404", async () => {
  const w = world({ pool: [row("a3", { status: "claimed", claimedNote: "" })] });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/a3/claim", {});
    assert.equal(r.status, 409);
    assert.equal(r.body.message, "Already claimed (no note)");
    assert.equal((await s.post("/account-pool/zz/claim", {})).status, 404);
  });
});

// ---------------------------------------------------------------------------
// Unclaim: a login already sold to a buyer goes back only through Recycle
// ---------------------------------------------------------------------------

test("unclaim: a spent / sold / burned row is refused and pointed at Recycle on the Spent accounts page", async () => {
  const notes = [
    "spent — unclaimed auto-listed (sold on ggsel)",
    "spent — no-claim removed Overwatch 2",
    "sold — token reclaimed by buyer",
    "burned — credentials seen by a Gameflip buyer whose purchase was cancelled; never resell (x)",
  ];
  const w = world({ pool: notes.map((n, i) => row("s" + i, { status: "claimed", claimedNote: n })) });
  await withServer(w, async (s) => {
    for (const [i, n] of notes.entries()) {
      const r = await s.post("/account-pool/s" + i + "/unclaim");
      assert.equal(r.status, 409, n);
      assert.equal(
        r.body.message,
        "It was sold to a buyer (" + n + ") — a manual unclaim would put the buyer's login back into " +
          "the farms' pool. Use Recycle on the Spent accounts page instead: it keeps the games it was " +
          "sold for, so it is never farmed for them again.",
      );
    }
    assert.deepEqual(w.pool.map((r) => r.status), ["claimed", "claimed", "claimed", "claimed"]);
    assert.equal(w.calls.claimWrites.length, 0, "nothing written");
    assert.equal(w.calls.usage.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Unclaim: "rented to …" — any renter row holds it
// ---------------------------------------------------------------------------

test("unclaim: refused while a renter's bot still holds a rented row (matched by token)", async () => {
  const w = world({
    pool: [row("b1", { status: "claimed", claimedNote: "rented to operator-selffarm until 2026-11-01" })],
    renterAccounts: [{ _id: "ra1", clientSecret: "tok-b1", login: "someone_else", farmEndedAt: null }],
  });
  await withServer(w, async (s) => {
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
  });
});

test("unclaim: a rented row is held by login too, case-insensitively", async () => {
  const w = world({
    pool: [row("b2", { status: "claimed", claimedNote: "rented to bob", clientSecret: "" })],
    renterAccounts: [{ _id: "ra2", clientSecret: "other-token", login: "USER_B2", farmEndedAt: null }],
  });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/b2/unclaim");
    assert.equal(r.status, 409);
    assert.match(r.body.message, /^It is rented to bob and still on a renter's bot/);
  });
});

test("unclaim: an ENDED rent-farm window still holds it — the buyer owns the account", async () => {
  const w = world({
    pool: [row("b3", { status: "claimed", claimedNote: "rented to operator-selffarm" })],
    renterAccounts: [{ _id: "ra3", clientSecret: "tok-b3", login: "user_b3", farmEndedAt: new Date("2026-09-30") }],
  });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/b3/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "It is rented to operator-selffarm. That farming window has ended, but the renter or rent-farm " +
        "buyer still owns the account — remove it from the renter (Renters page) only if it is yours to reuse.",
    );
    assert.equal(w.pool[0].status, "claimed");
    assert.equal(w.calls.usage.length, 0);
    for (const q of w.calls.renterLookups) assert.equal("farmEndedAt" in q, false, "any renter row counts");
  });
});

test("unclaim: a rented row no renter has on record any more is released as before", async () => {
  const w = world({ pool: [row("b4", { status: "claimed", claimedNote: "rented to bob" })] });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/b4/unclaim");
    assert.equal(r.status, 200);
    assert.equal(w.pool[0].status, "available");
    assert.equal(w.pool[0].claimedNote, "");
    assert.deepEqual(w.calls.usage, [{ id: "b4", event: "released", actor: "manual" }]);
  });
});

// ---------------------------------------------------------------------------
// Unclaim: "noclaim-farm:…" — held only while a bot's config has the token
// ---------------------------------------------------------------------------

test("unclaim: a no-claim row a bot still holds is refused, naming the bot — ONE grep, ≤ 20 s", async () => {
  const botsDir = noclaimBots({ 12: ["tok-x", "tok-c1"], 14: ["tok-y"] });
  const w = world({ pool: [row("c1", { status: "claimed", claimedNote: "noclaim-farm:Rainbow Six Siege" })], botsDir });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/c1/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "No-claim bot 12 still has it (noclaim-farm:Rainbow Six Siege) — release it from bot 12 on the " +
        "No-claim page first.",
    );
    assert.equal(w.pool[0].status, "claimed");
    assert.equal(w.calls.usage.length, 0);
    assert.equal(w.calls.sh.length, 1, "one command for every bot");
    const { script, opts } = w.calls.sh[0];
    assert.ok(opts.timeout > 0 && opts.timeout <= 20000, "timeout " + opts.timeout);
    assert.match(script, /grep -lF -- 'tok-c1' "\$@"/);
    assert.ok(script.includes(shq(botsDir)), "searches BOTS_DIR");
    assert.ok(script.includes("/*/Configuration/config.json"), "every bot's config");
  });
});

test("unclaim: held by two bots names both, and a disabled entry counts", async () => {
  // noclaimBots() writes every second entry Enabled:false — tok-c2 is one.
  const botsDir = noclaimBots({ 3: ["tok-z", "tok-c2"], 21: ["tok-q", "tok-c2"] });
  const w = world({ pool: [row("c2", { status: "claimed", claimedNote: "noclaim-farm:Overwatch 2" })], botsDir });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/c2/unclaim");
    assert.equal(r.status, 409);
    assert.match(r.body.message, /^No-claim bots (3, 21|21, 3) still have it \(noclaim-farm:Overwatch 2\) — release it from bots /);
  });
});

test("unclaim: a token that is not plain text is never grepped for — refused, nothing changed", async () => {
  // A config stores the token JSON-escaped, so `"` or `\` would never match
  // byte for byte and the check would wrongly answer "no bot has it".
  const w = world({ pool: [row("c7", { status: "claimed", claimedNote: "noclaim-farm:Rust", clientSecret: 'tok"q\\x' })] });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/c7/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "Could not check the no-claim bots, nothing changed (this row's token is not a plain Twitch token).",
    );
    assert.equal(w.calls.sh.length, 0);
    assert.equal(w.pool[0].status, "claimed");
  });
});

test("unclaim: a no-claim ORPHAN (in no bot's config) is released as normal", async () => {
  const botsDir = noclaimBots({ 12: ["tok-x"], 14: ["tok-y"] });
  const w = world({ pool: [row("c3", { status: "claimed", claimedNote: "noclaim-farm:Overwatch 2 (bot 12)" })], botsDir });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/c3/unclaim");
    assert.equal(r.status, 200);
    assert.equal(w.pool[0].status, "available");
    assert.equal(w.pool[0].claimedNote, "");
    assert.deepEqual(w.calls.usage, [{ id: "c3", event: "released", actor: "manual" }]);
  });
});

// An orphan goes back only where the No-claim page's own Release would let it
// (noclaimFarmRoutes.releasePlan). No bot holds any of these — the refusals
// come from the database, before any SSH.
test("unclaim: a no-claim orphan on sale (ledger listed / manual, or ticked Listed) is refused", async () => {
  const cases = [
    [{ ledgers: [{ poolAccountId: "o1", loginLower: "user_o1", status: "listed" }] }, {}, "its ledger says listed"],
    [{ ledgers: [{ poolAccountId: "o1", loginLower: "user_o1", status: "manual" }] }, {}, "its ledger says manual"],
    // Matched by login too: a ledger written against an older pool row.
    [{ ledgers: [{ poolAccountId: "old-row", loginLower: "user_o1", status: "listed" }] }, {}, "its ledger says listed"],
    [{}, { listed: true }, "ticked Listed"],
  ];
  for (const [worldOpts, rowOpts, why] of cases) {
    const w = world({
      pool: [row("o1", { status: "claimed", claimedNote: "noclaim-farm:Overwatch 2", ...rowOpts })],
      ...worldOpts,
    });
    await withServer(w, async (s) => {
      const r = await s.post("/account-pool/o1/unclaim");
      assert.equal(r.status, 409, why);
      assert.equal(
        r.body.message,
        "It is on sale through the no-claim farm (" + why + ") — delist or sell it on the No-claim page " +
          "first; nothing changed.",
      );
      assert.equal(w.pool[0].status, "claimed", why);
      assert.equal(w.calls.sh.length, 0, "no SSH for a refusal the database already answers");
    });
  }
});

test("unclaim: a no-claim orphan on a live marketplace listing is refused", async () => {
  const w = world({
    pool: [row("o2", { status: "claimed", claimedNote: "noclaim-farm:Overwatch 2" })],
    listed: ["USER_O2"],
  });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/o2/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "It is on a live marketplace listing a buyer can still buy — take it off that listing first.",
    );
    assert.equal(w.calls.sh.length, 0);
  });
});

test("unclaim: a no-claim orphan sold (ledger sold or removed, or ticked Sold) goes back only through Recycle", async () => {
  const claimedAt = new Date("2026-09-20T00:00:00Z");
  const cases = [
    [{ ledgers: [{ poolAccountId: "o3", status: "sold", soldAt: new Date("2026-09-25T00:00:00Z") }] }, {}, "its no-claim ledger says sold"],
    [{ ledgers: [{ poolAccountId: "o3", status: "removed" }] }, {}, "its no-claim ledger says removed — sold by hand"],
    [{}, { manualSold: true }, "ticked Sold on the No-claim page"],
  ];
  for (const [worldOpts, rowOpts, why] of cases) {
    const w = world({
      pool: [row("o3", { status: "claimed", claimedNote: "noclaim-farm:Rust", claimedAt, ...rowOpts })],
      ...worldOpts,
    });
    await withServer(w, async (s) => {
      const r = await s.post("/account-pool/o3/unclaim");
      assert.equal(r.status, 409, why);
      assert.equal(
        r.body.message,
        "It was sold to a buyer (" + why + ") — a manual unclaim would put the buyer's login back into " +
          "the farms' pool. Use Recycle on the Spent accounts page instead: it keeps the games it was " +
          "sold for, so it is never farmed for them again.",
      );
      assert.equal(w.pool[0].status, "claimed", why);
    });
  }
});

test("unclaim: any other committed ledger status holds an orphan too", async () => {
  const w = world({
    pool: [row("o4", { status: "claimed", claimedNote: "noclaim-farm:Rust" })],
    ledgers: [{ poolAccountId: "o4", status: "pending-review" }],
  });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/o4/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "Its no-claim ledger says pending-review, which the no-claim sellers treat as taken — nothing changed.",
    );
  });
});

test("unclaim: an orphan whose ledgers are free, or whose sale is history, is released", async () => {
  const claimedAt = new Date("2026-09-28T00:00:00Z");
  const botsDir = noclaimBots({ 12: ["tok-x"] });
  const w = world({
    pool: [row("o5", { status: "claimed", claimedNote: "noclaim-farm:Rust", claimedAt })],
    ledgers: [
      { poolAccountId: "o5", status: "expired" },
      { poolAccountId: "o5", status: "released" },
      { loginLower: "user_o5", status: "skipped" },
      // Sold BEFORE this claim: the account was recycled and re-deployed since.
      { poolAccountId: "o5", status: "sold", soldAt: new Date("2026-09-10T00:00:00Z") },
    ],
    botsDir,
  });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/o5/unclaim");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(w.pool[0].status, "available");
    assert.equal(w.calls.sh.length, 1, "and only then are the bots asked");
    const q = w.calls.ledgerLookups[0];
    assert.deepEqual(q.status, { $nin: ["skipped", "released", "expired"] });
    assert.deepEqual(q.$or, [{ poolAccountId: "o5" }, { loginLower: "user_o5" }]);
  });
});

test("unclaim: no no-claim bot configs at all means no bot holds it", async () => {
  const w = world({ pool: [row("c4", { status: "claimed", claimedNote: "noclaim-farm:Rust" })], botsDir: noclaimBots({}) });
  await withServer(w, async (s) => {
    assert.equal((await s.post("/account-pool/c4/unclaim")).status, 200);
    assert.equal(w.pool[0].status, "available");
  });
});

test("unclaim: a no-claim check that cannot answer refuses — nothing changed", async () => {
  const unreachable = Object.assign(new Error("Raspberry Pi is unreachable over SSH."), { status: 503 });
  const missingDir = path.join(TMP, "no-such-bots-dir");
  const broken = noclaimBots({ 10: ["tok-x"] });
  // A config grep cannot read (here a dangling link): grep exits 2.
  fs.mkdirSync(path.join(broken, "16", "Configuration"), { recursive: true });
  fs.symlinkSync(path.join(TMP, "gone.json"), path.join(broken, "16", "Configuration", "config.json"));
  const cases = [
    [{ shError: unreachable }, "Raspberry Pi is unreachable over SSH."],
    [{ botsDir: missingDir }, "the no-claim bot directory is missing"],
    [{ botsDir: broken }, "grep exit 2"],
  ];
  for (const [opts, why] of cases) {
    const w = world({ pool: [row("c5", { status: "claimed", claimedNote: "noclaim-farm:Rust" })], ...opts });
    await withServer(w, async (s) => {
      const r = await s.post("/account-pool/c5/unclaim");
      assert.equal(r.status, 409, why);
      assert.equal(r.body.message, "Could not check the no-claim bots, nothing changed (" + why + ").");
      assert.equal(w.pool[0].status, "claimed", why);
      assert.equal(w.calls.claimWrites.length, 0, why);
    });
  }
});

test("unclaim: a no-claim row with no token cannot be looked up, so it is refused without a check", async () => {
  const w = world({ pool: [row("c6", { status: "claimed", claimedNote: "noclaim-farm:Rust", clientSecret: "" })] });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/c6/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "Could not check the no-claim bots, nothing changed (this row has no token to look for).",
    );
    assert.equal(w.calls.sh.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Unclaim: held stock, auto-farm
// ---------------------------------------------------------------------------

test("unclaim: refused for held unclaimed stock", async () => {
  const note = "unclaimed stock — 3 drop(s) (Overwatch 2) held out of the pool until sold";
  const w = world({ pool: [row("d1", { status: "claimed", claimedNote: note })] });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/d1/unclaim");
    assert.equal(r.status, 409);
    assert.match(r.body.message, /^It is held as stock: it carries farmed drops nobody has claimed yet\./);
    assert.match(r.body.message, /puts it back by itself once that stock is sold or expires\.$/);
    assert.equal(w.pool[0].claimedNote, note);
  });
});

test("unclaim: refused while an ACTIVE auto-farm task has the login — no promise it comes back", async () => {
  const w = world({
    pool: [row("e1", { status: "claimed", claimedNote: "auto-farm backfill: Rust (camp-9)" })],
    tasks: [
      { _id: "t-old", status: "completed", game: "Rust", assignedAccounts: ["User_e1"] },
      { _id: "t1", status: "active", game: "Rust", assignedAccounts: ["someone", "USER_E1"] },
    ],
  });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/e1/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "The auto-farm is farming it for Rust right now — it stays claimed while that task is active.",
    );
    assert.equal(w.pool[0].status, "claimed");
  });
});

test("unclaim: refused while an auto-farm login is on a live listing (any case), task over or not", async () => {
  const w = world({
    pool: [row("e2", { status: "claimed", claimedNote: "auto-farm: Rust (camp-1)" })],
    tasks: [{ _id: "t2", status: "completed", game: "Rust", assignedAccounts: ["User_e2"] }],
    listed: ["someone", "USER_E2"],
  });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/e2/unclaim");
    assert.equal(r.status, 409);
    assert.equal(
      r.body.message,
      "It is on a live marketplace listing a buyer can still buy — take it off that listing first.",
    );
    assert.equal(w.pool[0].status, "claimed");
    assert.equal(w.calls.usage.length, 0);
  });
});

test("unclaim: an auto-farm row whose task is over and which is on no listing is released as before", async () => {
  const w = world({
    pool: [row("e3", { status: "claimed", claimedNote: "auto-farm: Rust (camp-1)" })],
    tasks: [{ _id: "t3", status: "completed", game: "Rust", assignedAccounts: ["User_e3"] }],
    listed: ["someone_else"],
  });
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/e3/unclaim");
    assert.equal(r.status, 200);
    assert.equal(r.body.account.status, "available");
    assert.equal(w.pool[0].status, "available");
  });
});

// ---------------------------------------------------------------------------
// Unclaim as before
// ---------------------------------------------------------------------------

test("unclaim: a hand claim (or no note) is released as before", async () => {
  const w = world({
    pool: [
      row("f1", { status: "claimed", claimedNote: "assigned to a bot" }),
      row("f2", { status: "claimed", claimedNote: "" }),
    ],
  });
  await withServer(w, async (s) => {
    assert.equal((await s.post("/account-pool/f1/unclaim")).status, 200);
    assert.equal((await s.post("/account-pool/f2/unclaim")).status, 200);
    assert.deepEqual(w.pool.map((r) => r.status), ["available", "available"]);
    assert.equal(w.calls.usage.length, 2);
    assert.equal((await s.post("/account-pool/nope/unclaim")).status, 404);
    assert.equal(w.calls.sh.length, 0, "no no-claim check for other notes");
  });
});

test("unclaim: a row that changes hands between the check and the write is not released", async () => {
  const w = world({ pool: [row("g1", { status: "claimed", claimedNote: "assigned to a bot" })] });
  // A renter add re-labels the row right after the route read it.
  w.hooks.afterRead = (r) => {
    if (r) r.claimedNote = "rented to bob";
  };
  await withServer(w, async (s) => {
    const r = await s.post("/account-pool/g1/unclaim");
    assert.equal(r.status, 409);
    assert.equal(r.body.message, "It changed a moment ago — refresh and try again.");
    assert.equal(w.pool[0].status, "claimed");
    assert.equal(w.pool[0].claimedNote, "rented to bob");
    assert.equal(w.calls.usage.length, 0);
  });
});

test("both buttons still require a superadmin session", async () => {
  const w = world({ pool: [row("h1", { status: "claimed", claimedNote: "x" })] });
  await withServer(w, async (s) => {
    assert.equal((await s.post("/account-pool/h1/unclaim", {}, { "x-test-anon": "1" })).status, 401);
    assert.equal((await s.post("/account-pool/h1/claim", {}, { "x-test-anon": "1" })).status, 401);
    assert.equal(w.pool[0].claimedNote, "x");
  });
});
