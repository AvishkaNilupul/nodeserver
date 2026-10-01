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
  poolEligible: 1000,
  telegrams: [],
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
    if (world.publishFailsFor && world.publishFailsFor.test(args.title || "")) {
      throw new Error("Gameflip publish failed: title rejected");
    }
    const id = "gf-new-" + (world.published.length + 1);
    const login = (/Username: (\S+)/.exec(args.autoDeliverCode || "") || [])[1];
    const ra = login
      ? await require("../models/RenterAccount").findOne({ login }).lean()
      : null;
    world.published.push({ id, ...args, farmUntilAtPublish: ra && ra.farmUntil });
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
          if (world.freshImpl) return world.freshImpl(args);
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
    if (request === "../routes/renterAdminRoutes") {
      return { gatherPoolEligibility: async () => ({ eligible: new Array(world.poolEligible).fill({}) }) };
    }
    if (request === "./telegram") return { sendTelegram: async (m) => { world.telegrams.push(m); } };
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
    poolEligible: 1000,
    telegrams: [],
    freshImpl: null,
    publishFailsFor: null,
  });
  svc._reset();
  svc._resetBadOfferAlerts();
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
  assert.match(world.published[0].autoDeliverCode, /\n\nOffer ref: R[A-F0-9]{8}$/, "fixed per-row ref — Gameflip refuses a duplicate");
  assert.ok(
    world.published[0].farmUntilAtPublish > new Date(Date.now() + 360 * 86400000),
    "the placeholder window was pushed out BEFORE the listing could sell",
  );
  assert.match(world.published[0].title, /Rust Twitch Drops Automatic Farming 180 Days/);
  const fresh = await MarketplaceListing.findOne({ externalId: "gf-new-1" }).lean();
  assert.equal(fresh.status, "active");
  assert.equal(fresh.rentFarmPoolId, String(pool._id), "the new row now owns the account");
  assert.equal(fresh.rentFarmDays, 180);
  const old = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(old.rentFarmPoolId, "", "the old row no longer points at it");
  assert.equal(old.rentFarmRenewingAt, null, "lease released");
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
  assert.equal(old.rentFarmPoolId, String(pool._id), "the row never stopped owning it");
  assert.equal(old.rentFarmRenewingAt, null, "lease released");
  assert.equal(old.rentFarmRenewFailures, 1);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "claimed");
  assert.equal(world.removedFromConfig.length, 0);
  assert.equal(world.fresh.length, 0, "its slot is NOT refilled with a fresh account");
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
  world.af.gfBufferDryRun = undefined; // the DEFAULT (dry) must not keep it parked either
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
  assert.equal(old.rentFarmPoolId, String(pool._id), "still owns the account");
  assert.equal(old.rentFarmRenewingAt, null);
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
  assert.equal(old.rentFarmPoolId, String(pool._id), "the row still owns the account…");
  assert.ok(old.rentFarmRenewingAt, "…under a lease, so nothing releases it");
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "claimed");
  assert.equal(world.removedFromConfig.length, 0, "not pulled off its bot");
  assert.ok(world.alerts.some((a) => /LIVE AND SELLABLE with no row/.test(a.reason)));
  assert.match(world.alerts.find((a) => /LIVE AND SELLABLE/.test(a.reason)).reason, /^pool \S+ \/ shelf1:/, "pool id and login lead the page");
});

test("isRenewing: fresh expired rows are renewing, overdue or failing ones are stranded", () => {
  const now = Date.now();
  const base = { status: "removed", rentFarmExpiredAt: new Date(now - 60000) };
  assert.equal(svc.isRenewing(base, now), true);
  assert.equal(svc.isRenewing({ ...base, rentFarmRenewingAt: new Date(now - 60000) }, now), true, "in flight");
  assert.equal(svc.isRenewing({ ...base, rentFarmRenewingAt: new Date(now - svc.RENEW_LEASE_MS - 1) }, now), false, "cut off");
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
  assert.match(src.slice(at - 900, at), /renew =\s*status === "expired" && !!row\.rentFarm && !!row\.rentFarmPoolId &&\s*gfFarm\.renewsOnExpiry\(\);/);
  assert.match(src.slice(at - 900, at), /let renew = false;\s*try \{/, "a settings read failing must not stop the watcher");
  assert.match(seg, /\.\.\.\(renew \? \{ rentFarmExpiredAt: new Date\(\) \} : \{\}\)/);
  assert.match(seg, /if \(!renew\) \{[\s\S]{0,120}await releaseBufferedRow\(/);
  assert.match(seg, /burned: status === "cancelled"/, "a refunded buyer's credentials are burned");
});

test("REGRESSION: in dry run a parked account is returned, never left holding its slot", async () => {
  await reset();
  world.af.gfBufferDryRun = true;
  const { pool } = await parked();
  const out = await svc.topUpBuffer({ dryRun: true });
  assert.equal(out.reclaimed, 1);
  assert.equal(world.published.length, 0);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("REGRESSION: a failed catalogue read never releases parked accounts", async () => {
  await reset();
  world.af.gfRentFarmGames = []; // falls back to AutoFarmTask, which is empty here
  const { pool, listing } = await parked();
  const out = await svc.topUpBuffer({ dryRun: false });
  assert.equal(out.reclaimed, 0);
  assert.equal((await MarketplaceListing.findById(listing._id).lean()).rentFarmPoolId, String(pool._id));
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "claimed");
});

test("REGRESSION: Gameflip saying this renewal's code 'already exists' HOLDS the account (an earlier attempt may be live)", async () => {
  await reset();
  await othersLive(180);
  const { pool, listing } = await parked();
  world.publishFails = "Gameflip publish failed: code for digital goods already exists";
  const out = await svc.topUpBuffer({ dryRun: false });
  assert.equal(out.reclaimed, 0, "never released");
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "claimed");
  const row = await MarketplaceListing.findById(listing._id).lean();
  assert.ok(row.rentFarmRenewingAt, "lease kept");
  assert.equal(row.rentFarmPoolId, String(pool._id));
  assert.ok(world.alerts.some((a) => /already has a listing with this renewal's code/.test(a.reason)));
  // And the next pass neither retries nor releases it.
  world.publishFails = null;
  await svc.topUpBuffer({ dryRun: false });
  assert.equal(world.published.length, 0);
});

test("REGRESSION: a renewal cut off mid-publish is never retried automatically — it pages once and holds", async () => {
  await reset();
  await othersLive(180);
  const { pool, listing } = await parked({
    row: { rentFarmRenewingAt: new Date(Date.now() - svc.RENEW_LEASE_MS - 60000) },
  });
  await svc.topUpBuffer({ dryRun: false });
  await svc.topUpBuffer({ dryRun: false });
  assert.equal(world.published.length, 0, "no second listing with the same credentials");
  assert.equal(world.fresh.length, 0, "and no fresh account for its slot");
  const pages = world.alerts.filter((a) => /cut off mid-publish/.test(a.reason));
  assert.equal(pages.length, 1);
  assert.match(pages[0].reason, /check Gameflip for ANY listing, live or sold/);
  assert.match(pages[0].reason, /Do not clear anything by hand/);
  const row = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(row.rentFarmPoolId, String(pool._id));
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "claimed");
});

test("a leased row is refused by releaseBuffered (its new listing may be live)", async () => {
  await reset();
  const { listing } = await parked({ row: { rentFarmRenewingAt: new Date() } });
  const row = await MarketplaceListing.findById(listing._id).lean();
  const r = await svc.releaseBuffered(row, { reason: "test" });
  assert.equal(r.released, false);
});

// ---- 2026-10-01, third round (second adversarial review of the renewal) ----

test("REGRESSION: every retry of one expired row carries the SAME code (Gameflip then refuses a second live copy)", async () => {
  await reset();
  await othersLive(180);
  const { listing } = await parked();
  world.publishFails = "gameflip 503";
  const attempts = [];
  const realPublish = fakeMp.gameflipPublish;
  fakeMp.gameflipPublish = async (args) => {
    attempts.push(args.autoDeliverCode);
    return realPublish(args);
  };
  try {
    await svc.topUpBuffer({ dryRun: false }); // fails (503)
    world.publishFails = null;
    await svc.topUpBuffer({ dryRun: false }); // succeeds
  } finally {
    fakeMp.gameflipPublish = realPublish;
  }
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1], "identical code on the retry");
  assert.match(attempts[0], new RegExp("Offer ref: R" + String(listing._id).slice(-8).toUpperCase() + "$"));
});

test("a cut-off renewal whose new row WAS recorded is finished automatically (no page)", async () => {
  await reset();
  const { pool, listing } = await parked({
    row: { rentFarmRenewingAt: new Date(Date.now() - svc.RENEW_LEASE_MS - 60000) },
  });
  // The renewal got as far as recording its row, then the process died.
  const renewed = new MarketplaceListing({
    marketplace: "gameflip", externalId: "gf-renewed-9", status: "active", rentFarm: true,
    rentFarmGame: "Rust", rentFarmDays: 180, rentFarmPoolId: String(pool._id), accountLogin: "shelf1",
  });
  await renewed.save({ validateBeforeSave: false });
  await svc.topUpBuffer({ dryRun: false });
  const old = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(old.rentFarmPoolId, "");
  assert.equal(old.rentFarmRenewingAt, null);
  assert.match(old.lastError, /handover finished by reconcile/);
  assert.equal(world.alerts.filter((a) => /cut off/.test(a.reason)).length, 0);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "claimed", "still the new row's account");
});

test("REGRESSION: parked rows never starve the release of a delisted row", async () => {
  await reset();
  // An empty catalogue (a failed read) keeps parked rows parked — six of them,
  // older than the delisted row, more than one pass's window of five.
  world.af.gfRentFarmGames = [];
  for (let i = 0; i < 6; i++) await parked({ login: "p" + i, days: 120 });
  const { pool } = await parked({ login: "dl1", row: { status: "delisted", rentFarmExpiredAt: null } });
  const out = await svc.topUpBuffer({ dryRun: false });
  assert.equal(out.reclaimed, 1);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("an expired row that was later DELISTED by hand is released, not parked forever", async () => {
  await reset();
  const { pool } = await parked({ row: { status: "delisted" } });
  const out = await svc.topUpBuffer({ dryRun: false });
  assert.equal(out.reclaimed, 1);
  assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
});

test("a failed read of the parked renewals stops the pass (no fresh account for their slots)", async () => {
  await reset();
  const realFind = MarketplaceListing.find;
  MarketplaceListing.find = function (q, ...rest) {
    if (q && q.rentFarmExpiredAt && q.rentFarmExpiredAt.$ne === null) throw new Error("Atlas timeout");
    return realFind.call(this, q, ...rest);
  };
  let out;
  try {
    out = await svc.topUpBuffer({ dryRun: false });
  } finally {
    MarketplaceListing.find = realFind;
  }
  assert.match(out.stopped, /could not read parked renewals/);
  assert.equal(world.fresh.length, 0);
});

test("REGRESSION: a cancelled (refunded) buffered listing's account is BURNED, never returned to the pool", async () => {
  await reset();
  const { pool, listing } = await parked({ row: { rentFarmExpiredAt: null } });
  const row = await MarketplaceListing.findById(listing._id).lean();
  const r = await svc.releaseBuffered(row, { reason: 'gameflip reports "cancelled"', burned: true });
  assert.equal(r.released, true);
  const p = await AvailableAccount.findById(pool._id).lean();
  assert.equal(p.status, "claimed", "never back to available");
  assert.match(p.claimedNote, /^burned — credentials seen by a Gameflip buyer/);
  assert.deepEqual(world.removedFromConfig, ["contabo/config_02.json:shelf1"], "off the bot");
  assert.equal(await RenterAccount.countDocuments({ clientSecret: "cs-shelf1" }), 0);
});

test("bufferState reports a cut-off renewal as HELD (needs a human), not as stranded", async () => {
  await reset();
  await parked({ row: { rentFarmRenewingAt: new Date(Date.now() - svc.RENEW_LEASE_MS - 60000) } });
  const st = await svc.bufferState();
  assert.equal(st.held.length, 1);
  assert.equal(st.held[0].login, "shelf1");
  assert.equal(st.stranded.length, 0);
});

// ---------------------------------------------------------------------------
// Fix 13 (Gameflip robustness)
// ---------------------------------------------------------------------------
const FarmServiceOrder = require("../models/FarmServiceOrder");

async function soldHalfway({ login = "sold1", days = 30, claimedMinsAgo = 60 } = {}) {
  const pool = await AvailableAccount.create({
    username: login, usernameLower: login, clientSecret: "cs-" + login, password: encrypt("pw-" + login),
    hasPassword: true, status: "claimed", claimedNote: "rented to operator-selffarm",
  });
  await RenterAccount.create({
    renter: holder._id, clientSecret: "cs-" + login, login, host: "contabo", configFile: "config_02.json",
    enabled: true, farmUntil: new Date(Date.now() + 300 * 86400000),
  });
  const listing = new MarketplaceListing({
    marketplace: "gameflip", externalId: "gf-sold-" + login, title: "Rust Twitch Drops Automatic Farming " + days + " Days",
    status: "sold", rentFarm: true, rentFarmGame: "Rust", rentFarmDays: days, rentFarmPoolId: String(pool._id),
    rentFarmSaleClaimedAt: new Date(Date.now() - claimedMinsAgo * 60000), accountLogin: login,
  });
  await listing.save({ validateBeforeSave: false });
  return { pool, listing };
}

test("REGRESSION: a sale that died half-way is FINISHED by the retry sweep (window stamped, order recorded, pointer cleared)", async () => {
  await reset();
  await FarmServiceOrder.deleteMany({});
  const { listing } = await soldHalfway();
  const out = await svc.retryUnfinishedSales();
  assert.equal(out.finished, 1, JSON.stringify(out));
  const row = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(row.rentFarmPoolId, "", "the sale is complete");
  const order = await FarmServiceOrder.findOne({ orderId: "gf:gf-sold-sold1" }).lean();
  assert.ok(order);
  const acct = await RenterAccount.findOne({ login: "sold1" }).lean();
  assert.ok(acct.farmUntil < new Date(Date.now() + 31 * 86400000), "the 30-day window, not the 365-day placeholder");
});

test("a retry never pushes a recorded window later (the order row already holds it)", async () => {
  await reset();
  await FarmServiceOrder.deleteMany({});
  const recorded = new Date(Date.now() + 10 * 86400000);
  await soldHalfway({ login: "sold2" });
  await FarmServiceOrder.create({
    orderId: "gf:gf-sold-sold2", market: "gameflip", game: "Rust", days: 30, state: "delivered",
    accounts: [{ login: "sold2", farmUntil: recorded }],
  });
  await svc.retryUnfinishedSales();
  const acct = await RenterAccount.findOne({ login: "sold2" }).lean();
  assert.ok(acct.farmUntil > new Date(Date.now() + 200 * 86400000), "not restamped (the recorded window stands)");
});

test("a sale still inside its claim lease is left alone; one that cannot finish stops being retried", async () => {
  await reset();
  await FarmServiceOrder.deleteMany({});
  await soldHalfway({ login: "fresh1", claimedMinsAgo: 1 });
  let out = await svc.retryUnfinishedSales();
  assert.equal(out.retried, 0, "the first pass is still working on it");
  // A sale that cannot finish (its ledger row is gone) is retried at most SALE_RETRY_MAX times.
  await reset();
  const { listing } = await soldHalfway({ login: "broken1" });
  await RenterAccount.deleteMany({ login: "broken1" });
  for (let i = 0; i < svc.SALE_RETRY_MAX + 3; i++) {
    await MarketplaceListing.updateOne({ _id: listing._id }, { $set: { rentFarmSaleClaimedAt: new Date(Date.now() - 3600000) } });
    await svc.retryUnfinishedSales();
  }
  const row = await MarketplaceListing.findById(listing._id).lean();
  assert.equal(row.rentFarmSaleAttempts, svc.SALE_RETRY_MAX);
  assert.equal(world.alerts.filter((a) => /no RenterAccount holds token/.test(a.reason)).length, 2, "paged on the first and the last attempt only");
});

test("REGRESSION: the buffer never takes the last pristine accounts (pool reserve)", async () => {
  await reset();
  world.poolEligible = 50; // == the default reserve
  const out = await svc.topUpBuffer({ dryRun: false });
  assert.match(out.stopped, /pool reserve reached — 50 pristine account\(s\) left, 50 kept/);
  assert.equal(world.fresh.length, 0, "no pristine account claimed");
  assert.equal(world.alerts.filter((a) => a.orderId === "buffer:pool-reserve").length, 1);
  assert.equal(world.alerts.find((a) => a.orderId === "buffer:pool-reserve").kind, "buffer", "never worded as a lost order");
  await svc.topUpBuffer({ dryRun: false });
  assert.equal(world.alerts.filter((a) => a.orderId === "buffer:pool-reserve").length, 1, "latched");
});

test("REGRESSION: a LIVE offer whose account was hand-sold is paged (once a day), never silently kept on sale", async () => {
  await reset();
  const pool = await AvailableAccount.create({
    username: "live1", usernameLower: "live1", clientSecret: "cs-live1", password: encrypt("pw"), hasPassword: true,
    status: "claimed", claimedNote: "rented to operator-selffarm", manualSold: true,
  });
  await RenterAccount.create({ renter: holder._id, clientSecret: "cs-live1", login: "live1", host: "contabo", configFile: "config_02.json", enabled: true });
  const row = new MarketplaceListing({
    marketplace: "gameflip", externalId: "gf-live-bad", status: "active", rentFarm: true, rentFarmGame: "Rust",
    rentFarmDays: 180, rentFarmPoolId: String(pool._id), accountLogin: "live1",
  });
  await row.save({ validateBeforeSave: false });
  const r1 = await svc.alertBadLiveOffers();
  assert.equal(r1.paged, 1, JSON.stringify(r1));
  assert.match(world.telegrams[0], /gf-live-bad — Rust 180d — live1: the pool account was sold by hand/);
  const r2 = await svc.alertBadLiveOffers();
  assert.equal(r2.paged, 0, "not again today");
  assert.deepEqual(world.delisted, [], "never delisted by itself");
});

test("a sale whose account is on NO bot is recorded AND paged (Farm days puts it back)", async () => {
  await reset();
  await FarmServiceOrder.deleteMany({});
  const { listing } = await soldHalfway({ login: "offbot1" });
  await RenterAccount.updateOne({ login: "offbot1" }, { $set: { configFile: "" } });
  await svc.retryUnfinishedSales();
  assert.ok(await FarmServiceOrder.findOne({ orderId: "gf:gf-sold-offbot1" }).lean(), "recorded");
  assert.ok(world.alerts.some((a) => /is on NO bot config/.test(a.reason) && (a.logins || []).includes("offbot1")));
  assert.equal((await MarketplaceListing.findById(listing._id).lean()).rentFarmPoolId, "");
});

test("REGRESSION: a (game, term) whose publish failed waits before it is tried again — other keys go first", async () => {
  await reset();
  let n = 0;
  world.freshImpl = async () => {
    n += 1;
    const login = "fresh" + n;
    const pool = await AvailableAccount.create({
      username: login, usernameLower: login, clientSecret: "cs-" + login, password: encrypt("pw-" + login),
      hasPassword: true, status: "claimed", claimedNote: "rented to operator-selffarm",
    });
    await RenterAccount.create({ renter: holder._id, clientSecret: "cs-" + login, login, host: "contabo", configFile: "config_54.json", enabled: true });
    return { added: [{ login, poolId: String(pool._id) }], farmUntil: new Date(Date.now() + 365 * 86400000) };
  };
  world.publishFailsFor = /120 Days/;
  const out1 = await svc.topUpBuffer({ dryRun: false });
  assert.equal(out1.published, 2, "the other two terms went up");
  const claimsAfter1 = world.fresh.length;
  const out2 = await svc.topUpBuffer({ dryRun: false });
  assert.equal(out2.published, 0);
  assert.equal(world.fresh.length, claimsAfter1, "the failing key was NOT retried at once (no account claimed, no restarts)");
});

// B10 (2026-10-01): a game with no Twitch Drops campaign in DARK_GAME_DAYS gets
// no new offer and no renewal; its live offers stay up. Unknown campaign
// history (empty / unreadable) treats nothing as dark.
const TwitchCampaign = require("../models/TwitchCampaign");
const dayMs = 86400000;
async function campaign(game, endAt, extra = {}) {
  await TwitchCampaign.create({
    campaignId: "c-" + game + "-" + Math.random().toString(36).slice(2),
    game,
    endAt,
    ...extra,
  });
}

test("B10: a game with no Twitch campaign in 45 days is dark — its expired offer goes back to the pool and nothing new is published for it", async () => {
  await reset();
  await TwitchCampaign.deleteMany({});
  try {
    world.af.gfRentFarmGames = ["Rust", "Escape from Tarkov"];
    await campaign("Rust", new Date(Date.now() - 10 * dayMs));
    await campaign("Escape from Tarkov", new Date(Date.now() - 60 * dayMs));

    const cat = await svc.desiredCatalogue();
    assert.deepEqual(cat.dark, ["Escape from Tarkov"]);
    assert.equal(cat.campaignsUnknown, false);
    assert.deepEqual([...cat.games].sort(), ["Escape from Tarkov", "Rust"], "the catalogue still names it (the tracker shows it)");
    assert.ok(cat.wanted.every((w) => w.game === "Rust"), "no wanted slot for the dark game");
    assert.equal(cat.wanted.length, 3);

    // Its expired offer is not renewed; Rust's missing slots are published.
    const { pool } = await parked({
      login: "eft1",
      days: 180,
      row: { rentFarmGame: "Escape from Tarkov", title: "Escape from Tarkov Twitch Drops Automatic Farming 180 Days" },
    });
    let n = 0;
    world.freshImpl = async () => {
      n += 1;
      const login = "fresh" + n;
      const p = await AvailableAccount.create({
        username: login, usernameLower: login, clientSecret: "cs-" + login, password: encrypt("pw-" + login),
        hasPassword: true, status: "claimed", claimedNote: "rented to operator-selffarm",
      });
      await RenterAccount.create({ renter: holder._id, clientSecret: "cs-" + login, login, host: "contabo", configFile: "config_54.json", enabled: true });
      return { added: [{ login, poolId: String(p._id) }], farmUntil: new Date(Date.now() + 365 * dayMs) };
    };
    const out = await svc.topUpBuffer({ dryRun: false });
    assert.equal(out.renewed, 0);
    assert.equal(out.reclaimed, 1);
    assert.equal((await AvailableAccount.findById(pool._id).lean()).status, "available");
    assert.ok(
      world.events.some((e) => /eft1 returned to the pool — .*Escape from Tarkov has had no Twitch Drops campaign in 45 days/.test(e.detail || "")),
      "the release says why",
    );
    assert.ok(world.published.length > 0, "Rust's slots still publish");
    assert.ok(world.published.every((p) => !/Tarkov/.test(p.title || "")), "nothing published for the dark game");

    const st = await svc.bufferState();
    assert.deepEqual(st.dark, ["Escape from Tarkov"]);
    assert.ok(st.notes.some((x) => /no Twitch Drops campaign in 45 days/.test(x) && /Escape from Tarkov/.test(x)));
    assert.ok(st.missing.every((m) => m.game === "Rust"), "a dark game is not reported as missing");
  } finally {
    await TwitchCampaign.deleteMany({});
  }
});

test("B10: a running campaign, one that ended inside the window, or a null-endAt one seen lately keeps a game in; an empty history darkens nothing", async () => {
  await reset();
  await TwitchCampaign.deleteMany({});
  try {
    world.af.gfRentFarmGames = ["Rust", "Overwatch", "Warframe", "Halo Infinite"];
    // Empty history: unknown, nothing dark.
    let cat = await svc.desiredCatalogue();
    assert.deepEqual(cat.dark, []);
    assert.equal(cat.campaignsUnknown, true);
    assert.equal(cat.wanted.length, 12);

    await campaign("rust", new Date(Date.now() + 5 * dayMs)); // running, other case
    await campaign("Overwatch", new Date(Date.now() - 44 * dayMs)); // ended inside the window
    await campaign("Warframe", null, { lastSeenAt: new Date(Date.now() - 2 * dayMs) }); // no end date, seen lately
    await campaign("Halo Infinite", new Date(Date.now() - 46 * dayMs)); // ended just outside
    cat = await svc.desiredCatalogue();
    assert.deepEqual(cat.dark, ["Halo Infinite"]);
    assert.equal(cat.wanted.length, 9);
  } finally {
    await TwitchCampaign.deleteMany({});
  }
});

test("B10: buyer-facing copy no longer promises drops every day — it says drops come with the game's campaigns", () => {
  const term = svc.TERMS.find((t) => t.days === 180);
  const desc = svc.offerDescription("Rust", term);
  assert.doesNotMatch(desc, /every day/);
  assert.match(desc, /farms every Twitch Drops campaign Rust runs during your 180 days/);
  const code = svc.bufferedDeliveryCode("u1", "p1", 180, "Rust");
  assert.doesNotMatch(code, /keep appearing/);
  assert.match(code, /Items appear whenever Rust runs a Twitch Drops campaign during your 180 days/);
});
