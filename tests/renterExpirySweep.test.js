// renterExpiry sweep changes (2026-10-01):
//   - a SUSPENDED renter whose stop failed (host offline at suspend time) is
//     retried by the sweep instead of being forgotten with botStoppedAt null;
//   - the rent-farm holder is never swept as a renter, whatever its lease says;
//   - a lapsed account window reloads its bot ONLY if that bot is running
//     (`docker restart` starts a stopped container — how a stopped, expired
//     renter used to come back to life).
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const calls = { stop: [], restartIfRunning: [], removed: [], settled: [], telegram: [], events: [], pendingSweeps: 0 };
// The per-account sweep's view of the hosts: file -> Set of secrets in it.
const hostFiles = { contabo: {} };
const failSettle = new Set(); // files whose reload throws
const owed = new Set(); // models PendingReload: files whose reload is still owed
// renterExpiry destructures these at load, so a test that must interleave a
// write uses a hook the fakes call, not a swapped function.
const hooks = { beforeDetach: null, beforeStop: null };
const fakeOps = {
  locateSecrets: async (host, secrets) => {
    const out = new Map();
    for (const [f, set] of Object.entries(hostFiles[host.id] || {})) {
      const hit = [...set].filter((x) => secrets.includes(x));
      if (hit.length) out.set(f, new Set(hit));
    }
    return out;
  },
  detachFromFile: async (host, file, secrets) => {
    if (hooks.beforeDetach) await hooks.beforeDetach();
    const set = (hostFiles[host.id] || {})[file];
    if (!set) return { removed: 0, remaining: null, games: new Map(), missing: true };
    let removed = 0;
    const games = new Map();
    for (const x of secrets) {
      if (set.delete(x)) {
        removed++;
        calls.removed.push(host.id + "/" + file + ":" + x);
        games.set(x, ["Overwatch"]);
      }
    }
    if (removed && set.size) owed.add(file);
    return { removed, remaining: set.size, games, missing: false, stopped: set.size === 0 };
  },
  settleAfterDetach: async (host, file, det) => {
    if (det.missing) return "missing";
    if (det.stopped) return "stopped";
    const isOwed = owed.has(file);
    if (!(det.removed > 0 || isOwed)) return "unchanged";
    if (failSettle.has(file)) {
      const e = new Error("Could not read container state on " + host.id);
      e.unreachable = true;
      throw e; // stays owed
    }
    owed.delete(file);
    calls.settled.push(host.id + "/" + file + (isOwed && !det.removed ? " (owed)" : "") + " removed=" + det.removed);
    return "restarted";
  },
  stopRenterFarming: async (renter, host) => {
    if (hooks.beforeStop) await hooks.beforeStop();
    calls.stop.push(renter.username);
    return {
      mode: "detached",
      removed: 2,
      files: [{ host: host.id, file: renter.botFile, removed: 2, remaining: 40, action: "restarted" }],
    };
  },
  restartIfRunning: async (host, file) => {
    calls.restartIfRunning.push(host.id + "/" + file);
    return false;
  },
  sweepPendingReloads: async () => {
    calls.pendingSweeps = (calls.pendingSweeps || 0) + 1;
    return { settled: 0, failed: 0, paged: 0 };
  },
};
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]renterExpiry\.js$/.test(parent.filename || "")) {
    if (request === "./renterBotOps") return fakeOps;
    if (request === "./telegram") return { sendTelegram: async (m) => calls.telegram.push(m) };
    if (request === "./systemLog") {
      return {
        logEvent: async (e) => {
          calls.events.push(e);
          // Real row, so advanceDigest's once-a-day dedupe can see it.
          await require("../models/SystemEvent").create({ ...e }).catch(() => {});
        },
      };
    }
    if (request === "./botHosts") {
      return {
        resolveHost: (v) =>
          v === "phone" ? null : { id: v || "local", label: v === "contabo" ? "Contabo VPS" : "Local" },
      };
    }
  }
  return realLoad.call(this, request, parent, isMain);
};

const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const FarmServiceOrder = require("../models/FarmServiceOrder");
const SystemEvent = require("../models/SystemEvent");
const renterExpiry = require("../utils/renterExpiry");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("renter-expiry-sweep"));
});
test.after(async () => {
  Module._load = realLoad;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

async function reset() {
  for (const k of Object.keys(calls)) calls[k] = [];
  calls.pendingSweeps = 0;
  hooks.beforeDetach = null;
  hooks.beforeStop = null;
  require("../utils/renterAccountBusy")._reset();
  hostFiles.contabo = {};
  failSettle.clear();
  owed.clear();
  await Promise.all([
    Renter.deleteMany({}),
    RenterAccount.deleteMany({}),
    FarmServiceOrder.deleteMany({}),
    SystemEvent.deleteMany({}),
  ]);
}

function mk(username, fields) {
  return Renter.create({
    username,
    usernameLower: username.toLowerCase(),
    passwordHash: "x",
    botHost: "contabo",
    ...fields,
  });
}

test("a suspended renter whose stop never happened is stopped by the sweep", async () => {
  await reset();
  const r = await mk("susp", { botFile: "config_05.json", status: "suspended", botStoppedAt: null });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, ["susp"]);
  const after = await Renter.findById(r._id).lean();
  assert.ok(after.botStoppedAt, "stamped once done");
  assert.match(calls.telegram.join("\n"), /Renter suspended: susp — 2 account\(s\) pulled off config_05\.json on Contabo VPS\. Other accounts on config_05\.json keep farming\./);
  assert.ok(calls.events.some((e) => e.action === "suspend_stop_retried"));
  // Idempotent: the next sweep leaves it alone.
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, ["susp"]);
});

test("an expired lease is reported as a lease end", async () => {
  await reset();
  await mk("jhonkwiall", { botFile: "config_03.json", accessEnd: new Date(Date.now() - 60000) });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, ["jhonkwiall"]);
  assert.match(calls.telegram.join("\n"), /^⏰ Renter lease ended: jhonkwiall — /m);
  assert.ok(calls.events.some((e) => e.action === "lease_ended"));
});

test("REGRESSION: the rent-farm holder is never swept as a renter", async () => {
  await reset();
  await mk("operator-selffarm", { botFile: "config_54.json", accessEnd: new Date(Date.now() - 60000) });
  await mk("operator-selffarm-2", { botFile: "config_55.json", status: "active" });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, []);
});

test("an active renter with a live lease, or one already stopped, is not touched", async () => {
  await reset();
  await mk("live", { botFile: "config_05.json", accessEnd: new Date(Date.now() + 86400000) });
  await mk("done", { botFile: "config_04.json", accessEnd: new Date(Date.now() - 86400000), botStoppedAt: new Date() });
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, []);
});

async function lapsed(holder, login, fields = {}) {
  return RenterAccount.create({
    renter: holder._id,
    clientSecret: "cs-" + login,
    login,
    host: "contabo",
    configFile: "config_02.json",
    farmUntil: new Date(Date.now() - 1000),
    ...fields,
  });
}

test("a lapsed window is pulled, its bot reloaded, and ONE digest names the order", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await lapsed(holder, "buyer1");
  hostFiles.contabo["config_02.json"] = new Set(["cs-buyer1", "cs-other"]);
  await FarmServiceOrder.create({
    orderId: "e328ee9d-aaaa", market: "eldorado", buyerUsername: "JumpyPage-etjK",
    game: "Overwatch", days: 30, accounts: [{ login: "buyer1" }], state: "delivered",
  });

  await renterExpiry.sweepOnce();

  assert.deepEqual(calls.removed, ["contabo/config_02.json:cs-buyer1"]);
  assert.deepEqual(calls.settled, ["contabo/config_02.json removed=1"]);
  const row = await RenterAccount.findOne({ login: "buyer1" }).lean();
  assert.ok(row.farmEndedAt);
  assert.equal(row.configFile, "");
  assert.deepEqual(row.favouriteGames, ["Overwatch"], "its games are kept for a renewal");
  const msg = calls.telegram.find((m) => /farming window\(s\) ended/.test(m));
  assert.ok(msg, calls.telegram.join("\n"));
  assert.match(msg, /buyer1 — eldorado order e328ee9d \(JumpyPage-etjK\) — Overwatch 30d/);
});

test("REGRESSION: a stale pointer — the account is pulled from the file it is REALLY in", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await lapsed(holder, "moved", { configFile: "config_31.json" }); // the stack moved; file gone
  hostFiles.contabo["config_03.json"] = new Set(["cs-moved", "cs-x"]);

  await renterExpiry.sweepOnce();

  assert.deepEqual(calls.removed, ["contabo/config_03.json:cs-moved"]);
  assert.ok((await RenterAccount.findOne({ login: "moved" }).lean()).farmEndedAt);
});

test("REGRESSION: a reload that fails leaves the window pending (not 'pulled off'), retried, and pages once", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await lapsed(holder, "stuck1");
  hostFiles.contabo["config_02.json"] = new Set(["cs-stuck1", "cs-other"]);
  failSettle.add("config_02.json");

  for (let i = 0; i < renterExpiry.STUCK_ALERT_ATTEMPTS + 2; i++) await renterExpiry.sweepOnce();

  const row = await RenterAccount.findOne({ login: "stuck1" }).lean();
  assert.equal(row.farmEndedAt, null, "never reported ended while the bot may still run it");
  assert.equal(row.expiryAttempts, renterExpiry.STUCK_ALERT_ATTEMPTS + 2);
  assert.match(row.expiryLastError, /config_02\.json: Could not read container state/);
  const pages = calls.telegram.filter((m) => /could NOT be pulled/.test(m));
  assert.equal(pages.length, 1, "one page, not one per tick");
  assert.ok(!calls.telegram.some((m) => /window\(s\) ended/.test(m)));

  // The host recovers: the owed reload happens and the window ends.
  failSettle.clear();
  await renterExpiry.sweepOnce();
  const after = await RenterAccount.findOne({ login: "stuck1" }).lean();
  assert.ok(after.farmEndedAt);
  assert.ok(calls.settled.includes("contabo/config_02.json (owed) removed=0"), calls.settled.join(" | "));
});

test("a failure in ONE file does not hold back an account that was in another", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await lapsed(holder, "okacct", { configFile: "config_02.json" });
  await lapsed(holder, "badacct", { configFile: "config_05.json" });
  hostFiles.contabo["config_02.json"] = new Set(["cs-okacct", "cs-a"]);
  hostFiles.contabo["config_05.json"] = new Set(["cs-badacct", "cs-b"]);
  failSettle.add("config_05.json");

  await renterExpiry.sweepOnce();

  assert.ok((await RenterAccount.findOne({ login: "okacct" }).lean()).farmEndedAt);
  assert.equal((await RenterAccount.findOne({ login: "badacct" }).lean()).farmEndedAt, null);
});

test("an unknown host is not reported as pulled off — it stays pending with the reason", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await lapsed(holder, "ghost", { host: "phone" });
  await renterExpiry.sweepAccounts(new Date());
  const row = await RenterAccount.findOne({ login: "ghost" }).lean();
  assert.equal(row.farmEndedAt, null);
  assert.match(row.expiryLastError, /unknown bot host 'phone'/);
});

test("an account found on NO config of its host ends (there is nothing left to pull)", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await lapsed(holder, "gone", { configFile: "config_31.json" });
  await renterExpiry.sweepAccounts(new Date());
  assert.ok((await RenterAccount.findOne({ login: "gone" }).lean()).farmEndedAt);
});

test("the 3-day heads-up goes out once per JST day, after 09:00 JST", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  await RenterAccount.create({
    renter: holder._id, clientSecret: "cs-soon", login: "soon", host: "contabo",
    configFile: "config_02.json", farmUntil: new Date(Date.UTC(2026, 9, 29, 12)),
  });
  await RenterAccount.create({
    renter: holder._id, clientSecret: "cs-later", login: "later", host: "contabo",
    configFile: "config_02.json", farmUntil: new Date(Date.UTC(2026, 10, 30)),
  });
  await FarmServiceOrder.create({
    orderId: "abc12345-x", market: "eldorado", game: "Rainbow Six Siege", days: 30,
    accounts: [{ login: "soon" }], state: "delivered",
  });

  // 2026-10-28 08:00 JST = 2026-10-27 23:00Z — before the hour: nothing.
  assert.equal(await renterExpiry.advanceDigest(new Date(Date.UTC(2026, 9, 27, 23))), false);
  // 10:00 JST: sent, lists only the window inside 3 days.
  assert.equal(await renterExpiry.advanceDigest(new Date(Date.UTC(2026, 9, 28, 1))), true);
  const msg = calls.telegram.find((m) => /end in the next 3 days/.test(m));
  assert.ok(msg);
  assert.match(msg, /2026-10-29 soon — eldorado order abc12345 — Rainbow Six Siege 30d/);
  assert.doesNotMatch(msg, /later/);
  // Same JST day again: no resend.
  assert.equal(await renterExpiry.advanceDigest(new Date(Date.UTC(2026, 9, 28, 5))), false);
  assert.equal(calls.telegram.filter((m) => /end in the next 3 days/.test(m)).length, 1);
});

test("describeStop says which bot was emptied and stopped", () => {
  const s = renterExpiry.describeStop(
    { removed: 1, files: [{ file: "config_22.json", removed: 1, remaining: 0, action: "stopped" }] },
    { id: "local", label: "Local" },
  );
  assert.equal(s, "1 account(s) pulled off config_22.json on Local. Now empty and stopped: config_22.json.");
});

// ---- round 3 (second review) ------------------------------------------------

test("REGRESSION: a failed reload of a file found only by SCANNING is not forgotten on the next tick", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  // The ledger says config_02; the account really sits in config_03 too.
  await lapsed(holder, "twice", { configFile: "config_02.json" });
  hostFiles.contabo["config_02.json"] = new Set(["cs-x"]);
  hostFiles.contabo["config_03.json"] = new Set(["cs-twice", "cs-y"]);
  failSettle.add("config_03.json");

  await renterExpiry.sweepOnce(); // pulled from config_03, its reload failed
  let row = await RenterAccount.findOne({ login: "twice" }).lean();
  assert.equal(row.farmEndedAt, null);
  assert.deepEqual(row.expiryOwedFiles, ["config_03.json"]);

  // Tick 2: the account is no longer FOUND in config_03 — but config_03's bot
  // still has it loaded. Before, this tick stamped it ended ("pulled off").
  await renterExpiry.sweepOnce();
  row = await RenterAccount.findOne({ login: "twice" }).lean();
  assert.equal(row.farmEndedAt, null, "not ended while config_03 still owes its reload");
  assert.ok(!calls.telegram.some((m) => /window\(s\) ended/.test(m)));

  failSettle.clear();
  await renterExpiry.sweepOnce();
  row = await RenterAccount.findOne({ login: "twice" }).lean();
  assert.ok(row.farmEndedAt, "ended once the owed reload happened");
  assert.equal(row.expiryOwedFiles, undefined);
  assert.ok(calls.settled.includes("contabo/config_03.json (owed) removed=0"), calls.settled.join(" | "));
});

test("a row another operation has marked busy is left to the next tick", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  const a = await lapsed(holder, "busy1");
  hostFiles.contabo["config_02.json"] = new Set(["cs-busy1", "cs-z"]);
  const release = require("../utils/renterAccountBusy").tryAcquire([a._id]);
  try {
    const out = await renterExpiry.sweepAccounts(new Date());
    assert.equal(out.busy, 1);
    assert.deepEqual(calls.removed, [], "not pulled while busy");
  } finally {
    release();
  }
  await renterExpiry.sweepAccounts(new Date());
  assert.deepEqual(calls.removed, ["contabo/config_02.json:cs-busy1"]);
});

test("REGRESSION: a window re-armed WHILE it is being pulled is never stamped ended over the extension", async () => {
  await reset();
  const holder = await mk("operator-selffarm", { botFile: "config_54.json" });
  const a = await lapsed(holder, "raced");
  hostFiles.contabo["config_02.json"] = new Set(["cs-raced", "cs-z"]);
  hooks.beforeDetach = async () => {
    // A writer that does not take the busy mark re-arms it mid-pull.
    await RenterAccount.updateOne({ _id: a._id }, { $set: { farmUntil: new Date(Date.now() + 30 * 86400000) } });
  };
  await renterExpiry.sweepOnce();
  const row = await RenterAccount.findById(a._id).lean();
  assert.equal(row.farmEndedAt, null, "the extension stands");
  assert.equal(row.configFile, "", "and the row says it is on no bot, so Farm days re-places it");
  assert.ok(calls.telegram.some((m) => /changed WHILE their lapsed term was being pulled/.test(m)));
});

test("every tick retries the reloads still owed", async () => {
  await reset();
  await renterExpiry.sweepOnce();
  await renterExpiry.sweepOnce();
  assert.equal(calls.pendingSweeps, 2);
});

test("a renter an operator action has marked busy is not stopped this tick", async () => {
  await reset();
  const r = await mk("wasd", { botFile: "config_03.json", accessEnd: new Date(Date.now() - 60000) });
  const release = require("../utils/renterAccountBusy").tryAcquire(["renter:" + String(r._id)]);
  try {
    await renterExpiry.sweepOnce();
    assert.deepEqual(calls.stop, []);
  } finally {
    release();
  }
  await renterExpiry.sweepOnce();
  assert.deepEqual(calls.stop, ["wasd"]);
});

test("REGRESSION: a lease renewed WHILE its lease-end stop runs is not stamped stopped", async () => {
  await reset();
  const r = await mk("renewme", { botFile: "config_03.json", accessEnd: new Date(Date.now() - 60000) });
  hooks.beforeStop = async () => {
    await Renter.updateOne({ _id: r._id }, { $set: { accessEnd: new Date(Date.now() + 30 * 86400000) } });
  };
  await renterExpiry.sweepOnce();
  const after = await Renter.findById(r._id).lean();
  assert.equal(after.botStoppedAt, null, "the renewal stands");
  assert.ok(calls.telegram.some((m) => /renewed or unsuspended WHILE its lease ended stop ran/.test(m)));
});
