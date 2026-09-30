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

const calls = { stop: [], restartIfRunning: [], removed: [], settled: [], telegram: [], events: [] };
// The per-account sweep's view of the hosts: file -> Set of secrets in it.
const hostFiles = { contabo: {} };
const failSettle = new Set(); // files whose reload throws
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
    const set = (hostFiles[host.id] || {})[file];
    if (!set) return { removed: 0, remaining: null, games: new Map(), missing: true };
    let removed = 0;
    for (const x of secrets) if (set.delete(x)) { removed++; calls.removed.push(host.id + "/" + file + ":" + x); }
    return { removed, remaining: set.size, games: new Map(), missing: false };
  },
  settleAfterDetach: async (host, file, det, opts) => {
    if (failSettle.has(file)) {
      const e = new Error("Could not read container state on " + host.id);
      e.unreachable = true;
      throw e;
    }
    calls.settled.push(host.id + "/" + file + (opts && opts.reloadOwed ? " (owed)" : "") + " removed=" + det.removed);
    return det.remaining === 0 ? "stopped" : "restarted";
  },
  stopRenterFarming: async (renter, host) => {
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
  hostFiles.contabo = {};
  failSettle.clear();
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
  assert.deepEqual(calls.settled, ["contabo/config_02.json (owed) removed=1"]);
  const row = await RenterAccount.findOne({ login: "buyer1" }).lean();
  assert.ok(row.farmEndedAt);
  assert.equal(row.configFile, "");
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
