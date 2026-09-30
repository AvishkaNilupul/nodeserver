// Gameflip buffered rent-farm offers that EXPIRE unsold are relisted with the
// SAME account (2026-10-01).
//
// Gameflip lists everything for 30 days. The 87 buffered offers published
// 2026-09-09..11 all expire 10-09..11. Before this, each expiry pulled the
// account off its stack (a restart), deleted its ledger row, returned it to the
// pool — where, after a month on a claiming stack, it no longer counts as
// pristine (82 of the 87 held claimed drops on 09-30) — and the next pass
// claimed a FRESH pristine account for the replacement (another restart). So
// every month the unsold shelf burned ~87 pristine accounts and ~170 restarts of
// stacks full of paying buyers, for about 10 Gameflip sales.
//
// These run the real gameflipFarmService against mongodb-memory-server with the
// marketplace, capacity and host calls faked.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

process.env.SESSION_SECRET ||= "gf-buffer-renewal-test";
process.env.CRED_SECRET ||= "gf-buffer-renewal-cred";

const world = {
  af: {},
  free: 300,
  published: [],
  delisted: [],
  publishFails: null,
  delistFails: false,
  alerts: [],
  events: [],
  fresh: [],
  removedFromConfig: [],
};

const fakeMp = {
  keyStatus: () => ({ gameflip: { configured: true } }),
  gameflipPublish: async (args) => {
    if (world.publishFails) throw new Error(world.publishFails);
    const id = "gf-new-" + (world.published.length + 1);
    world.published.push({ id, ...args });
    return { externalId: id, url: "https://gameflip.com/item/" + id };
  },
  gameflipDelist: async (id) => {
    if (world.delistFails) throw new Error("gameflip 500");
    world.delisted.push(id);
  },
};

const fakeHosts = {
  resolveHost: (v) => ({ id: v || "local", label: v || "local" }),
  dockerPs: async () => ({ twitchbotx54: { state: "running" } }),
};

const fakeCfg = {
  containerForFile: (f) => "twitchbotx" + parseInt(String(f).replace(/\D/g, ""), 10),
  removeAccountFromConfig: async (host, file, who) => {
    world.removedFromConfig.push(host.id + "/" + file + ":" + who.login);
    return 1;
  },
  restartConfigContainer: async () => ({ restarted: true }),
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && /utils[\\/]gameflipFarmService\.js$/.test(parent.filename || "")) {
    if (request === "./marketplaces") return fakeMp;
    if (request === "./botHosts") return fakeHosts;
    if (request === "../routes/botConfigRoutes") return fakeCfg;
    if (request === "./rentFarmCapacity") {
      return { snapshot: async () => ({ totalFree: world.free, totalCapacity: 620, readable: 14, offlineHosts: [] }) };
    }
    if (request === "./operatorFarm") {
      return {
        OPERATOR_USERNAME: "operator-selffarm",
        farmFreshAccounts: async (args) => {
          world.fresh.push(args);
          const e = new Error("No eligible pristine pool accounts right now");
          e.status = 409;
          throw e;
        },
      };
    }
    if (request === "./settings") return { getAutoFarm: () => world.af };
    if (request === "./setImage") return { buildPromoCoverImage: async () => "" };
    if (request === "./farmServiceAlert") {
      return {
        alertFarmFailure: async (a) => world.alerts.push(a),
        shortfallMessage: () => "short",
      };
    }
    if (request === "./systemLog") return { logEvent: async (e) => world.events.push(e) };
    if (request === "./poolUsageLog") return { recordPoolUsage: async () => {} };
  }
  return realLoad.call(this, request, parent, isMain);
};

const { encrypt } = require("../utils/secretBox");
const AvailableAccount = require("../models/AvailableAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const svc = require("../utils/gameflipFarmService");

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("gf-buffer-renewal"));
});
test.after(async () => {
  Module._load = realLoad;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

let holder;
async function reset() {
  Object.assign(world, {
    af: { gameflipRentFarm: true, gfBufferDryRun: false, gfRentFarmGames: ["Rust"], gfRentSlotReserve: 40 },
    free: 300,
    published: [],
    delisted: [],
    publishFails: null,
    delistFails: false,
    alerts: [],
    events: [],
    fresh: [],
    removedFromConfig: [],
  });
  svc._reset();
  await Promise.all([
    AvailableAccount.deleteMany({}),
    MarketplaceListing.deleteMany({}),
    Renter.deleteMany({}),
    RenterAccount.deleteMany({}),
  ]);
  holder = await Renter.create({
    username: "operator-selffarm",
    usernameLower: "operator-selffarm",
    passwordHash: "x",
    botHost: "contabo",
    botFile: "config_54.json",
  });
}

// One parked account + its expired offer. `acct` overrides the ledger row.
async function parked({ login = "shelf1", days = 180, acct = {}, row = {} } = {}) {
  const pool = await AvailableAccount.create({
    username: login,
    usernameLower: login.toLowerCase(),
    clientSecret: "cs-" + login,
    password: encrypt("pw-" + login),
    hasPassword: true,
    status: "claimed",
    claimedNote: "rented to operator-selffarm",
  });
  await RenterAccount.create({
    renter: holder._id,
    clientSecret: "cs-" + login,
    login,
    host: "contabo",
    configFile: "config_02.json",
    enabled: true,
    farmUntil: new Date(Date.now() + 300 * 86400000),
    ...acct,
  });
  const listing = new MarketplaceListing({
    marketplace: "gameflip",
    externalId: "gf-old-" + login,
    title: "Rust Twitch Drops Automatic Farming " + days + " Days",
    status: "removed",
    rentFarm: true,
    rentFarmGame: "Rust",
    rentFarmDays: days,
    rentFarmPoolId: String(pool._id),
    rentFarmExpiredAt: new Date(),
    accountLogin: login,
    ...row,
  });
  await listing.save({ validateBeforeSave: false });
  return { pool, listing };
}

// Mark the other two Rust terms live so only the parked one's slot is missing.
async function othersLive(except) {
  for (const d of [120, 180, 365].filter((x) => x !== except)) {
    const r = new MarketplaceListing({
      marketplace: "gameflip",
      externalId: "gf-live-" + d,
      status: "active",
      rentFarm: true,
      rentFarmGame: "Rust",
      rentFarmDays: d,
      rentFarmPoolId: "p" + d,
    });
    await r.save({ validateBeforeSave: false });
  }
}

test("REGRESSION: an offer that expired unsold is relisted with the SAME account — no fresh account, no bot change", async () => {
  await reset();
  await othersLive(180);
  const { pool, listing } = await parked({ days: 180 });

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.equal(out.renewed, 1);
  assert.equal(world.fresh.length, 0, "no pristine account claimed");
  assert.equal(world.removedFromConfig.length, 0, "the account never left its bot");
  assert.equal(world.published.length, 1);
  assert.match(world.published[0].autoDeliverCode, /Username: shelf1\nPassword: pw-shelf1/);
  assert.match(world.published[0].title, /Rust Twitch Drops Automatic Farming 180 Days/);
  const fresh = await MarketplaceListing.findOne({ externalId: "gf-new-1" }).lean();
  assert.equal(fresh.status, "active");
  assert.equal(fresh.rentFarmPoolId, String(pool._id), "the new row now owns the account");
  assert.equal(fresh.rentFarmDays, 180);
  const old = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(old.rentFarmPoolId, "", "the old row no longer points at it");
  assert.match(old.lastError, /renewed as gf-new-1/);
  const p = await AvailableAccount.findById(pool._id).lean();
  assert.equal(p.status, "claimed");
  const ra = await RenterAccount.findOne({ clientSecret: "cs-shelf1" }).lean();
  assert.ok(ra.farmUntil > new Date(Date.now() + 360 * 86400000), "placeholder window pushed out again");
  assert.ok(world.events.some((e) => e.action === "gameflip_buffer_renewed"));
});

test("a dead-token account is returned to the pool, not put back on sale", async () => {
  await reset();
  await othersLive(180);
  const { pool } = await parked({ acct: { lastScanStatus: "token_invalid" } });

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.equal(out.renewed, 0);
  assert.equal(world.published.filter((x) => /shelf1/.test(x.autoDeliverCode)).length, 0);
  assert.equal(out.reclaimed, 1);
  assert.deepEqual(world.removedFromConfig, ["contabo/config_02.json:shelf1"]);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("a failed publish keeps the account parked for the next pass and counts the failure", async () => {
  await reset();
  await othersLive(180);
  const { pool, listing } = await parked();
  world.publishFails = "gameflip 503";

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.equal(out.renewed, 0);
  assert.equal(out.reclaimed, 0);
  const old = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(old.rentFarmPoolId, String(pool._id), "pointer put back");
  assert.equal(old.rentFarmRenewFailures, 1);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "claimed");
  assert.equal(world.removedFromConfig.length, 0);
});

test("a Gameflip rate limit stops the pass instead of hammering it", async () => {
  await reset();
  await parked({ login: "a1", days: 120 });
  await parked({ login: "a2", days: 180 });
  world.publishFails = "429 Too many attempts";

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.match(out.stopped, /renewal hit a Gameflip limit/);
  assert.equal(world.fresh.length, 0, "no fresh publish attempted after the limit");
});

test("after repeated renewal failures the account goes back to the pool", async () => {
  await reset();
  await othersLive(180);
  const { pool } = await parked({ row: { rentFarmRenewFailures: svc.RENEW_MAX_FAILURES } });

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.equal(out.reclaimed, 1);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("an expired offer whose game left the catalogue goes back to the pool", async () => {
  await reset();
  world.af.gfRentFarmGames = ["Overwatch"];
  const { pool } = await parked();

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.equal(out.renewed, 0);
  assert.equal(out.reclaimed, 1);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("below the reserve floor an expired offer gives its slot back instead of renewing", async () => {
  await reset();
  await othersLive(180);
  world.free = 12;
  const { pool } = await parked();

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.equal(out.renewed, 0);
  assert.equal(out.reclaimed, 1);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("REGRESSION: a full buffer no longer skips returning an account stuck on a delisted offer", async () => {
  await reset();
  for (const d of [120, 180, 365]) {
    const r = new MarketplaceListing({
      marketplace: "gameflip", externalId: "gf-live-" + d, status: "active",
      rentFarm: true, rentFarmGame: "Rust", rentFarmDays: d, rentFarmPoolId: "p" + d,
    });
    await r.save({ validateBeforeSave: false });
  }
  const { pool } = await parked({ row: { status: "delisted", rentFarmExpiredAt: null } });

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.equal(out.stopped, "buffer is full");
  assert.equal(out.reclaimed, 1, "the stranded account was returned before the 'full' return");
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("with the buffer OFF, a stranded account is still returned (and nothing is published)", async () => {
  await reset();
  world.af.gameflipRentFarm = false;
  const { pool } = await parked();

  const out = await svc.topUpBuffer({ dryRun: false });

  assert.equal(out.stopped, "gameflipRentFarm off");
  assert.equal(out.reclaimed, 1);
  assert.equal(world.published.length, 0);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("a renewed listing that cannot be recorded is delisted and the account stays parked", async () => {
  await reset();
  await othersLive(180);
  const { pool, listing } = await parked();
  const realSave = MarketplaceListing.prototype.save;
  MarketplaceListing.prototype.save = async function (...a) {
    if (this.externalId === "gf-new-1") throw new Error("Atlas: write rejected");
    return realSave.apply(this, a);
  };
  try {
    await svc.topUpBuffer({ dryRun: false });
  } finally {
    MarketplaceListing.prototype.save = realSave;
  }
  assert.deepEqual(world.delisted, ["gf-new-1"]);
  const old = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(old.rentFarmPoolId, String(pool._id), "pointer back after the delist");
  assert.equal(old.rentFarmRenewFailures, 1);
});

test("REGRESSION: a renewed listing that is LIVE with no row keeps the account claimed and pages", async () => {
  await reset();
  await othersLive(180);
  const { pool, listing } = await parked();
  world.delistFails = true;
  const realSave = MarketplaceListing.prototype.save;
  MarketplaceListing.prototype.save = async function (...a) {
    if (this.externalId === "gf-new-1") throw new Error("Atlas: write rejected");
    return realSave.apply(this, a);
  };
  try {
    await svc.topUpBuffer({ dryRun: false });
    // A second pass must NOT hand the account back while that listing sells it.
    await svc.topUpBuffer({ dryRun: false });
  } finally {
    MarketplaceListing.prototype.save = realSave;
  }
  const old = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(old.rentFarmPoolId, "", "no pointer left for a reclaim to follow");
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "claimed");
  assert.ok(world.alerts.some((a) => /STILL LIVE AND SELLABLE/.test(a.reason)));
});

test("isRenewing: fresh expired rows are renewing, overdue or failing ones are stranded", () => {
  const now = Date.now();
  const base = { status: "removed", rentFarmExpiredAt: new Date(now - 60000) };
  assert.equal(svc.isRenewing(base, now), true);
  assert.equal(svc.isRenewing({ ...base, rentFarmExpiredAt: new Date(now - 7 * 3600000) }, now), false);
  assert.equal(svc.isRenewing({ ...base, rentFarmRenewFailures: svc.RENEW_MAX_FAILURES }, now), false);
  assert.equal(svc.isRenewing({ status: "delisted", rentFarmExpiredAt: new Date(now) }, now), false);
});

test("renewsOnExpiry only while the buffer is on and not in dry run", async () => {
  await reset();
  assert.equal(svc.renewsOnExpiry(), true);
  world.af.gfBufferDryRun = true;
  assert.equal(svc.renewsOnExpiry(), false);
  world.af = { gameflipRentFarm: false, gfBufferDryRun: false };
  assert.equal(svc.renewsOnExpiry(), false);
});

test("the watcher keeps an expired buffered account only for a renewal, and never on 'cancelled'", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "gameflipFulfiller.js"), "utf8");
  const at = src.indexOf('if (status === "expired" || status === "cancelled") {');
  assert.ok(at > 0);
  const seg = src.slice(at, at + 2600);
  assert.match(src.slice(at - 900, at), /const renew =\s*status === "expired" && !!row\.rentFarm && !!row\.rentFarmPoolId &&\s*gfFarm\.renewsOnExpiry\(\);/);
  assert.match(seg, /\.\.\.\(renew \? \{ rentFarmExpiredAt: new Date\(\) \} : \{\}\)/);
  assert.match(seg, /if \(!renew\) \{\s*await releaseBufferedRow\(/);
});
