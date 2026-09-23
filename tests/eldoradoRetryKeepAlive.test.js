// Behaviour tests for the 2026-09-23 Eldorado fixes, run against the REAL
// modules with every relative require stubbed (no DB, no network):
//
//  1. autoLister.retryMissingSecondaries retries Eldorado. Its share used to be
//     taken only in the round-robin of the FIRST publish, behind four other
//     markets, so an early-bird listing with 1-4 finished accounts never reached
//     Eldorado and nothing asked again. A share that SOLD OUT counts as missing
//     (Eldorado closes the offer and nothing refilled it); one the owner
//     delisted does not.
//  2. eldoradoFulfiller's keep-alive renews ACTIVE offers near their 21-day
//     expiry with pause + resume (verified live 2026-09-23: 09-27 -> 10-14, same
//     id/price/quantity/title). Paused offers are never touched.
//  3. marketResearch no longer references the removed FunPay rows (`fp`), whose
//     ReferenceError failed every research scan from 2026-09-20.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const UNDER_TEST = new Set(["utils/autoLister", "utils/eldoradoFulfiller"]);

// A Mongoose-query stand-in: awaitable directly or through .lean().
function q(value) {
  const p = Promise.resolve(value);
  return { lean: () => Promise.resolve(value), then: p.then.bind(p), catch: p.catch.bind(p) };
}
// Any module the tests do not configure: every property is a no-op async fn.
function autoStub() {
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : async () => undefined) });
}

const AF = { eldoradoAuto: true };
const calls = [];
const ML = {
  findOneImpl: () => null,
  created: [],
  findOne(filter) {
    return q(ML.findOneImpl(filter));
  },
  async create(doc) {
    ML.created.push(doc);
    return doc;
  },
};
const mp = {
  published: [],
  publishImpl: async () => ({ id: "eld-new", url: "https://eldorado/x" }),
  async eldoradoPublish(opts) {
    mp.published.push(opts);
    return mp.publishImpl(opts);
  },
  async ggselResolveCategoryId() {
    return "";
  },
  async zeusxResolveCategory() {
    return null;
  },
  keyStatus: () => ({ eldorado: { configured: true } }),
  // keep-alive state machine
  offers: new Map(),
  resumeFailures: new Map(),
  async eldoradoOffer(id) {
    const o = mp.offers.get(id);
    return o ? { id, offerTitle: "t-" + id, ...o } : null;
  },
  async eldoradoDelist(id) {
    calls.push(["pause", id]);
    const o = mp.offers.get(id);
    if (o && o.offerState === "Active") o.offerState = "Paused";
  },
  async eldoradoRelist(id) {
    calls.push(["resume", id]);
    const o = mp.offers.get(id);
    const left = mp.resumeFailures.get(id) || 0;
    if (left > 0) {
      mp.resumeFailures.set(id, left - 1);
      return;
    }
    if (o && o.offerState === "Paused") {
      o.offerState = "Active";
      o.expireDate = "2026-10-14T18:00:00";
    }
  },
  async eldoradoMyListings() {
    return {
      results: [...mp.offers.entries()].map(([id, o]) => ({ offer: { id, offerTitle: "t-" + id, ...o } })),
      totalPages: 1,
    };
  },
};
const holders = { rows: [], accs: [] };
const released = [];
const STUBS = {
  "models/MarketplaceListing": ML,
  "models/DropSet": { findById: (id) => q(STUBS.set && String(STUBS.set._id) === String(id) ? STUBS.set : null) },
  "models/DropLog": { aggregate: async () => holders.rows },
  "models/BotAccount": { find: () => q(holders.accs) },
  "utils/listedLogins": { loginsOnActiveListings: async () => new Set(), notListed: (a) => a },
  "utils/dropReservation": {
    reserveSetOnAccount: async () => true,
    releaseSetForAccounts: async (ids, setId) => released.push({ ids, setId }),
    releaseAccountsForTag: async () => {},
    AVAILABLE_DROP: {},
  },
  "utils/settings": {
    getAutoFarm: () => AF,
    isNoClaimGame: (g) => /overwatch|rainbow six|call of duty/i.test(String(g)),
    getAccountListingSettings: () => ({}),
  },
  "utils/marketplaces": mp,
  "utils/secretBox": { decrypt: (x) => (x ? "pw-" + x : "") },
  "utils/twitchAccountState": { isUnusableScanStatus: () => false },
  "utils/setImage": { buildSetGridImage: async () => "" },
  "utils/g2gGames": { brandForGame: () => null },
  "utils/telegram": { sendTelegram: async (t) => calls.push(["telegram", t]) },
  "utils/systemLog": { logEvent: async (e) => calls.push(["event", e]) },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.startsWith(".") && parent && parent.filename && parent.filename.startsWith(ROOT + path.sep)) {
    const key = path
      .relative(ROOT, path.resolve(path.dirname(parent.filename), request))
      .replace(/\.js$/, "")
      .split(path.sep)
      .join("/");
    if (!UNDER_TEST.has(key)) {
      if (!STUBS[key]) STUBS[key] = autoStub();
      return STUBS[key];
    }
  }
  return origLoad.apply(this, arguments);
};
const al = require(path.join(ROOT, "utils", "autoLister.js"));
const ef = require(path.join(ROOT, "utils", "eldoradoFulfiller.js"));
// The hook stays installed: both modules also require lazily at call time
// (systemLog, telegram), and those must get the stubs too.

/* ------------------------------ helpers ------------------------------ */

const ITEM = { itemKey: "k|apex legends", name: "Apex Pack", game: "Apex Legends", qty: 1 };
function reset() {
  calls.length = 0;
  ML.created.length = 0;
  mp.published.length = 0;
  released.length = 0;
  mp.offers.clear();
  mp.resumeFailures.clear();
  mp.publishImpl = async () => ({ id: "eld-new", url: "https://eldorado/x" });
  AF.eldoradoAuto = true;
  STUBS.set = { _id: "set1", items: [ITEM] };
  holders.rows = [{ _id: "id1", have: 1, items: [{ k: ITEM.itemKey, count: 1 }] }];
  holders.accs = [{ _id: "id1", login: "acc1", credPassword: "x", lastScanStatus: "ok" }];
}
function task(listingPatch = {}, game = "Apex Legends") {
  const t = {
    game,
    campaignName: "Apex Season",
    assignedAccounts: ["acc1"],
    listing: {
      externalId: "gf1",
      setId: "set1",
      postEvent: false,
      plati: { externalId: "p1" },
      ggsel: { externalId: "g1" },
      zeusx: { externalId: "z1" },
      g2g: { externalId: "x1" },
      eldorado: { externalId: "", error: "no spare account for this market yet" },
      ...listingPatch,
    },
    saved: 0,
    markModified() {},
    async save() {
      this.saved++;
    },
  };
  return t;
}
// gfRow for the retry + an optional Eldorado row for eldoradoShareMissing.
function rows(eldRow) {
  ML.findOneImpl = (f) => {
    if (f.marketplace === "gameflip")
      return { title: "Apex Legends Twitch Drops (1 Item)", description: "…message me here on Gameflip…", price: 1.5 };
    if (f.marketplace === "eldorado") return eldRow || null;
    return null;
  };
}
function eldRowDoc(fields) {
  return {
    status: "active",
    units: [],
    lastError: "",
    saved: 0,
    async save() {
      this.saved++;
    },
    ...fields,
  };
}

/* ------------------- 1. retryMissingSecondaries + Eldorado ------------------- */

test("a listing that never got an Eldorado share gets one on the retry", async () => {
  reset();
  rows(null);
  const t = task();
  const r = await al.retryMissingSecondaries(t);
  assert.deepStrictEqual(r, ["eldorado"]);
  assert.strictEqual(mp.published.length, 1);
  const pub = mp.published[0];
  assert.strictEqual(pub.game, "Apex Legends");
  assert.strictEqual(pub.quantity, 1);
  assert.strictEqual(pub.priceUsd, 1.5);
  assert.match(pub.description, /message me here on Eldorado/, "Eldorado copy, not the Gameflip row's");
  assert.doesNotMatch(pub.description, /on Gameflip/);
  assert.strictEqual(t.listing.eldorado.externalId, "eld-new");
  assert.strictEqual(t.listing.eldorado.error, "");
  const row = ML.created.find((d) => d.marketplace === "eldorado");
  assert.ok(row, "an Eldorado MarketplaceListing row is written");
  assert.strictEqual(row.origin, "auto");
  assert.deepStrictEqual(row.units.map((u) => u.login), ["acc1"]);
  assert.ok(t.saved >= 1);
});

test("a SOLD-OUT Eldorado share is retired and replaced with a fresh one", async () => {
  reset();
  const old = eldRowDoc({ units: [{ login: "a", deliveredAt: new Date() }, { login: "b", deliveredAt: new Date() }] });
  rows(old);
  const t = task({ eldorado: { externalId: "eld-old", qty: 2, error: "" } });
  const r = await al.retryMissingSecondaries(t);
  assert.deepStrictEqual(r, ["eldorado"]);
  assert.strictEqual(old.status, "sold");
  assert.ok(old.saved >= 1);
  assert.ok(calls.some(([k, id]) => k === "pause" && id === "eld-old"), "the old offer is taken off sale");
  assert.strictEqual(t.listing.eldorado.externalId, "eld-new");
});

test("a share the owner delisted is NOT republished", async () => {
  reset();
  rows(eldRowDoc({ status: "delisted", units: [{ login: "a", deliveredAt: new Date() }] }));
  const t = task({ eldorado: { externalId: "eld-old", qty: 1, error: "" } });
  assert.strictEqual(await al.retryMissingSecondaries(t), null);
  assert.strictEqual(mp.published.length, 0);
});

test("a live share that still has stock is left alone", async () => {
  reset();
  const live = eldRowDoc({ units: [{ login: "a", deliveredAt: new Date() }, { login: "b", deliveredAt: null }] });
  rows(live);
  const t = task({ eldorado: { externalId: "eld-live", qty: 2, error: "" } });
  assert.strictEqual(await al.retryMissingSecondaries(t), null);
  assert.strictEqual(mp.published.length, 0);
  assert.strictEqual(live.status, "active");
});

test("a no-claim game never takes an auto-farm Eldorado share", async () => {
  reset();
  rows(null);
  const t = task({}, "Overwatch");
  assert.strictEqual(await al.retryMissingSecondaries(t), null);
  assert.strictEqual(mp.published.length, 0);
});

test("eldoradoAuto off: the retry leaves Eldorado alone", async () => {
  reset();
  AF.eldoradoAuto = false;
  rows(null);
  assert.strictEqual(await al.retryMissingSecondaries(task()), null);
  assert.strictEqual(mp.published.length, 0);
});

// Keep LAST in this group: it arms the module-level cooldown.
test("Eldorado's category-cap refusal is recorded, the reservation released, and the retry backs off", async () => {
  reset();
  rows(null);
  mp.publishImpl = async () => {
    throw new Error("Eldorado create failed (HTTP 400): Maximum of 100 active offers is allowed.");
  };
  const t = task();
  assert.strictEqual(await al.retryMissingSecondaries(t), null);
  assert.match(t.listing.eldorado.error, /Maximum of 100 active offers/);
  assert.strictEqual(t.listing.eldorado.externalId, "");
  assert.strictEqual(released.length, 1, "the accounts reserved for the failed publish are released");
  // Inside the cooldown the retry does not ask Eldorado again.
  mp.publishImpl = async () => ({ id: "eld-new", url: "u" });
  mp.published.length = 0;
  assert.strictEqual(await al.retryMissingSecondaries(task()), null);
  assert.strictEqual(mp.published.length, 0);
});

/* ------------------------------ 2. keep-alive ------------------------------ */

test("eldoradoExpiryMs reads Eldorado's zone-less timestamp as UTC", () => {
  assert.strictEqual(ef.eldoradoExpiryMs("2026-09-27T18:00:00"), Date.UTC(2026, 8, 27, 18));
  assert.strictEqual(ef.eldoradoExpiryMs("2026-09-27T18:00:00Z"), Date.UTC(2026, 8, 27, 18));
  assert.ok(Number.isNaN(ef.eldoradoExpiryMs("")));
});

test("offersDueForRenewal: ACTIVE offers inside the window, soonest first — never paused ones", () => {
  const now = Date.UTC(2026, 8, 24, 0);
  const due = ef.offersDueForRenewal(
    [
      { id: "far", offerState: "Active", expireDate: "2026-10-14T18:00:00" },
      { id: "b", offerState: "Active", expireDate: "2026-09-28T18:00:00" },
      { id: "paused", offerState: "Paused", expireDate: "2026-09-27T18:00:00" },
      { id: "closed", offerState: "Closed", expireDate: "2026-09-27T18:00:00" },
      { id: "a", offerState: "Active", expireDate: "2026-09-27T18:00:00" },
      { id: "past", offerState: "Active", expireDate: "2026-09-20T18:00:00" },
      { id: "nodate", offerState: "Active", expireDate: "" },
    ],
    now,
  );
  assert.deepStrictEqual(due.map((o) => o.id), ["past", "a", "b"]);
});

test("renewOffer: pause then resume, and the expiry moves", async () => {
  reset();
  ML.findOneImpl = () => null;
  mp.offers.set("o1", { offerState: "Active", expireDate: "2026-09-27T18:00:00" });
  const r = await ef.renewOffer("o1");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.to, "2026-10-14T18:00:00");
  assert.deepStrictEqual(calls.filter(([k]) => k === "pause" || k === "resume"), [["pause", "o1"], ["resume", "o1"]]);
  assert.strictEqual(mp.offers.get("o1").offerState, "Active");
});

test("renewOffer: an offer that is not Active is skipped untouched", async () => {
  reset();
  ML.findOneImpl = () => null;
  mp.offers.set("o2", { offerState: "Paused", expireDate: "2026-09-27T18:00:00" });
  const r = await ef.renewOffer("o2");
  assert.strictEqual(r.skipped, "not active");
  assert.strictEqual(calls.length, 0);
});

test("renewOffer: if the stock sync pauses it meanwhile, it stays paused", async () => {
  reset();
  let flag = false;
  ML.findOneImpl = (f) => (f.marketplace === "eldorado" ? { autoPaused: flag } : null);
  mp.offers.set("o3", { offerState: "Active", expireDate: "2026-09-27T18:00:00" });
  const pause = mp.eldoradoDelist;
  mp.eldoradoDelist = async (id) => {
    await pause(id);
    flag = true; // the stock sync found no stock in the same second
  };
  try {
    const r = await ef.renewOffer("o3");
    assert.match(r.skipped, /stock sync/);
    assert.ok(!calls.some(([k]) => k === "resume"), "must not resume an offer with nothing to sell");
    assert.strictEqual(mp.offers.get("o3").offerState, "Paused");
  } finally {
    mp.eldoradoDelist = pause;
  }
});

test("renewOffer: a stale autoPaused flag on a LIVE offer does not strand it paused", async () => {
  reset();
  ML.findOneImpl = (f) => (f.marketplace === "eldorado" ? { autoPaused: true } : null);
  mp.offers.set("o4", { offerState: "Active", expireDate: "2026-09-27T18:00:00" });
  const r = await ef.renewOffer("o4");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(mp.offers.get("o4").offerState, "Active");
});

test("renewOffer: a resume that fails is retried", async () => {
  reset();
  ML.findOneImpl = () => null;
  mp.offers.set("o5", { offerState: "Active", expireDate: "2026-09-27T18:00:00" });
  mp.resumeFailures.set("o5", 1);
  const r = await ef.renewOffer("o5");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.filter(([k]) => k === "resume").length, 2);
});

test("renewOffer: an offer left paused is reported as failed with its state", async () => {
  reset();
  ML.findOneImpl = () => null;
  mp.offers.set("o6", { offerState: "Active", expireDate: "2026-09-27T18:00:00" });
  mp.resumeFailures.set("o6", 99);
  const r = await ef.renewOffer("o6");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.state, "Paused");
  assert.strictEqual(calls.filter(([k]) => k === "resume").length, 3);
});

test("renewExpiringOffers: dry run lists what is due and touches nothing", async () => {
  reset();
  ML.findOneImpl = () => null;
  mp.offers.set("soon", { offerState: "Active", expireDate: "2026-09-27T18:00:00" });
  mp.offers.set("later", { offerState: "Active", expireDate: "2026-10-20T18:00:00" });
  mp.offers.set("paused", { offerState: "Paused", expireDate: "2026-09-27T18:00:00" });
  const r = await ef.renewExpiringOffers({ dryRun: true, now: Date.UTC(2026, 8, 24, 0) });
  assert.strictEqual(r.scanned, 3);
  assert.deepStrictEqual(r.wouldRenew.map((o) => o.offerId), ["soon"]);
  assert.strictEqual(calls.length, 0);
});

test("renewExpiringOffers: renews only the due ACTIVE offers", async () => {
  reset();
  ML.findOneImpl = () => null;
  mp.offers.set("soon", { offerState: "Active", expireDate: "2026-09-27T18:00:00" });
  mp.offers.set("later", { offerState: "Active", expireDate: "2026-10-20T18:00:00" });
  mp.offers.set("paused", { offerState: "Paused", expireDate: "2026-09-27T18:00:00" });
  const r = await ef.renewExpiringOffers({ now: Date.UTC(2026, 8, 24, 0) });
  assert.strictEqual(r.due, 1);
  assert.deepStrictEqual(r.renewed.map((x) => x.offerId), ["soon"]);
  assert.strictEqual(r.failed.length, 0);
  assert.strictEqual(mp.offers.get("paused").offerState, "Paused");
  assert.strictEqual(mp.offers.get("later").expireDate, "2026-10-20T18:00:00");
});

test("reportKeepAlive states real counts, and pages only when something failed", async () => {
  reset();
  ML.findOneImpl = () => null;
  mp.offers.set("ok1", { offerState: "Active", expireDate: "2026-09-27T18:00:00" });
  const r = await ef.renewExpiringOffers({ now: Date.UTC(2026, 8, 24, 0) });
  await ef.reportKeepAlive(r);
  const ev = calls.find(([k]) => k === "event");
  assert.ok(ev, "a SystemEvent is written for the pass");
  // r.due is a COUNT — the first prod pass logged "renewed 75/undefined".
  assert.match(ev[1].detail, /^renewed 1\/1 Eldorado offer/);
  assert.doesNotMatch(ev[1].detail, /undefined/);
  assert.ok(!calls.some(([k]) => k === "telegram"), "a clean pass pages nobody");

  calls.length = 0;
  await ef.reportKeepAlive({
    scanned: 3,
    due: 2,
    renewed: [{ offerId: "a", ok: true }],
    skipped: [],
    failed: [{ offerId: "b", title: "Stuck offer", state: "Paused", ok: false }],
  });
  const tg = calls.find(([k]) => k === "telegram");
  assert.ok(tg, "a failure pages the owner");
  assert.match(tg[1], /left 1 offer\(s\) PAUSED/);
  assert.match(tg[1], /Stuck offer/);
  const ev2 = calls.find(([k]) => k === "event");
  assert.strictEqual(ev2[1].severity, "warn");
  assert.match(ev2[1].detail, /^renewed 1\/2 .*failed 1/);
});

test("the keep-alive is started with the fulfiller and has a kill switch", () => {
  const src = fs.readFileSync(path.join(ROOT, "utils", "eldoradoFulfiller.js"), "utf8");
  const start = src.slice(src.indexOf("function start()"));
  assert.match(start, /keepAliveTick/);
  assert.match(start, /af\.eldoradoKeepAlive !== false/);
});

/* ---------------------------- 3. market research ---------------------------- */

test("market research no longer spreads the removed FunPay rows", () => {
  const src = fs.readFileSync(path.join(ROOT, "utils", "marketResearch.js"), "utf8");
  assert.doesNotMatch(src, /\.\.\.fp\b/);
  assert.match(src, /medianPrice\(\[\.\.\.gfActiveRel, \.\.\.ggRel, \.\.\.plRel\]\)/);
});
