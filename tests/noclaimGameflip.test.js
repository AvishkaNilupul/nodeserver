// No-claim Shop listings on Gameflip (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md
// §8a): a DropSet whose stock is the no-claim farm publishes ONE auto-delivered
// no-claim account per live listing, relists through the same chain when it
// sells, and hands the account back when the listing is retired unsold.
//
// The invariant these tests exist for: a no-claim set NEVER reaches the Drop
// Archive claim (claimAccountForSet -> availableAccountsForSet ->
// reserveSetOnAccount). The archive holds only CLAIMED drops, which are
// worthless to a buyer promised unclaimed ones. And an archive set must behave
// exactly as it did before the no-claim lane existed.
//
// Mongo/marketplace-free: every module utils/gameflipFulfiller.js requires is
// stubbed through Module._load, like tests/manualSoldRemoval.test.js. The
// no-claim modules are required LAZILY (they are written separately and reach
// back into the fulfiller), so the hook stays installed for the whole file —
// node --test runs each file in its own process, so nothing leaks.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.CRED_SECRET ||= "test-secret";

const ROOT = path.join(__dirname, "..");
const OUT_OF_STOCK =
  "Out of stock — no free no-claim account holds this whole bundle";

/* ------------------------------ call log --------------------------------- */

let calls = [];
let errors = [];
let S = {};
let seq = 0;

const log = (name, ...args) => calls.push({ name, args });
const called = (name) => calls.filter((c) => c.name === name);
const firstIndex = (name) => calls.findIndex((c) => c.name === name);

// The fulfiller logs every failure it swallows; keep them for assertions
// instead of printing them.
const realConsoleError = console.error;
console.error = (...a) =>
  errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));

const ITEMS = [
  { itemKey: "msc name card|overwatch 2", name: "MSC Name Card", game: "Overwatch 2", qty: 1 },
  { itemKey: "loot box|overwatch 2", name: "Loot Box", game: "Overwatch 2", qty: 2 },
];
const ncSet = (extra = {}) => ({ _id: "set-nc", stockSource: "noclaim", items: ITEMS, ...extra });
const archiveSet = (extra = {}) => ({ _id: "set-a", stockSource: "", items: ITEMS, ...extra });
const NC_ACC = {
  ledgerId: "ledger-1",
  login: "nc_login",
  password: "nc-secret-pw",
  email: "",
  poolAccountId: "pool-1",
};

function reset(over = {}) {
  calls = [];
  errors = [];
  seq = 0;
  S = {
    sets: { "set-nc": ncSet(), "set-a": archiveSet() },
    noclaimAccounts: [{ ...NC_ACC }],
    archiveCandidates: [{ accountId: "acc-1" }],
    publishError: null,
    createError: null,
    attachError: null,
    releaseError: null,
    rowFieldsError: null,
    soldHookError: null,
    retireHook: null,
    findOneAndUpdate: null,
    activeRows: [],
    stalledRows: [],
    soldIds: [],
    liveIds: [],
    statusFor: {},
    // What relistNoclaimSuccessor's re-read sees for the row it replaces.
    listingStatus: "delisted",
    gridImage: "",
    ...over,
  };
}
reset();

/* -------------------------------- stubs ---------------------------------- */

const MarketplaceListing = {
  find(q) {
    log("MarketplaceListing.find", q);
    const rows =
      q.status === "active" ? S.activeRows : q.status === "sold" ? S.stalledRows : [];
    const chain = {
      sort: () => chain,
      limit: () => chain,
      lean: async () => rows.map((r) => ({ ...r })),
    };
    return chain;
  },
  findById(id) {
    log("MarketplaceListing.findById", id);
    return {
      lean: async () => (S.listingStatus === null ? null : { _id: id, status: S.listingStatus }),
    };
  },
  async findOneAndUpdate(q, u) {
    log("MarketplaceListing.findOneAndUpdate", q, u);
    if (typeof S.findOneAndUpdate === "function") return S.findOneAndUpdate(q, u);
    return { _id: q._id };
  },
  async updateOne(q, u) {
    log("MarketplaceListing.updateOne", q, u);
    return { modifiedCount: 1 };
  },
  async create(doc) {
    log("MarketplaceListing.create", doc);
    if (S.createError) throw S.createError;
    seq += 1;
    return { _id: "row-new-" + seq, ...doc };
  },
};

const DropSet = {
  findById(id) {
    log("DropSet.findById", id);
    return { lean: async () => (S.sets[String(id)] ? { ...S.sets[String(id)] } : null) };
  },
};

const DropLog = {
  async aggregate(pipeline) {
    log("DropLog.aggregate", pipeline);
    return [];
  },
};

const BotAccount = {
  find(q) {
    log("BotAccount.find", q);
    const ids = (q && q._id && q._id.$in) || [];
    return { lean: async () => ids.map((id) => ({ _id: id })) };
  },
  async findById(id) {
    log("BotAccount.findById", id);
    return { _id: id, login: "archive_login", credPassword: "enc-archive-pw" };
  },
};

const AccountOffer = { findById: () => ({ lean: async () => null }) };

const shopRoutes = {
  async availableAccountsForSet(set) {
    log("availableAccountsForSet", set && set._id);
    return S.archiveCandidates.map((c) => ({ ...c }));
  },
};

const listedLogins = {
  async loginsOnActiveListings() {
    log("loginsOnActiveListings");
    return new Set();
  },
  notListed: (cands) => cands,
};

const dropReservation = {
  async reserveSetOnAccount(accountId, set) {
    log("reserveSetOnAccount", accountId, set && set._id);
    return true;
  },
  async releaseAccountsForTag(...a) {
    log("releaseAccountsForTag", ...a);
  },
  async releaseSetForAccounts(...a) {
    log("releaseSetForAccounts", ...a);
  },
};

const secretBox = { decrypt: (v) => (v === "enc-archive-pw" ? "archive-pw" : "") };
const autoLister = { buildTitle: () => "archive title", buildDescription: () => "archive description" };
const suppliedStock = {
  async deliveryEnabled() {
    return true;
  },
  async claimForListing() {
    return [];
  },
  async releaseClaim() {},
  async markFed() {},
  async markDelivered() {},
  async deliveryText() {
    return "";
  },
};
const setImage = {
  async buildSetGridImage(set) {
    log("buildSetGridImage", set && set._id);
    return S.gridImage;
  },
  async buildPromoCoverImage() {
    return "";
  },
};
const saleLearning = {
  async recordListingSale(x) {
    log("recordListingSale", x && x.listing && x.listing._id);
  },
};
const telegram = {
  async sendTelegram(text) {
    log("sendTelegram", text);
  },
};
const gfFarm = {
  async releaseBuffered() {
    log("releaseBuffered");
    return { released: true };
  },
  async onBufferedSale() {
    log("onBufferedSale");
    return {};
  },
  async topUpBuffer() {
    return {};
  },
};
const mp = {
  async gameflipPublish(opts) {
    log("gameflipPublish", opts);
    if (S.publishError) throw S.publishError;
    seq += 1;
    const id = "gf-new-" + seq;
    return { externalId: id, url: "https://gameflip.com/item/" + id };
  },
  async gameflipListingIdsByStatus(status) {
    log("gameflipListingIdsByStatus", status);
    return new Set(status === "sold" ? S.soldIds : S.liveIds);
  },
  async gameflipListingStatus(id) {
    log("gameflipListingStatus", id);
    const v = S.statusFor[id];
    if (v instanceof Error) throw v;
    return v || "onsale";
  },
};

// The no-claim claim layer, per the contract (§3). The pure rowFields mirrors
// the contract's definition; the claim refuses a set that is not no-claim, as
// the real one does ("Not a no-claim set → []").
const noclaimStockStub = {
  async claimForSet(set, want, opts) {
    log("claimForSet", set && set._id, want, opts);
    if (!set || set.stockSource !== "noclaim") return [];
    return S.noclaimAccounts.slice(0, want).map((a) => ({ ...a }));
  },
  async releaseClaim(ids, opts) {
    log("releaseClaim", ids, opts);
    if (S.releaseError) throw S.releaseError;
    return ids.length;
  },
  async attachListing(ids, listingId) {
    log("attachListing", ids, listingId);
    if (S.attachError) throw S.attachError;
    return ids.length;
  },
  rowFields(set, market, accounts) {
    log("rowFields", set && set._id, market, accounts.map((a) => a.login));
    if (S.rowFieldsError) throw S.rowFieldsError;
    return {
      set: set._id,
      noclaimStock: true,
      origin: "manual",
      accountId: "",
      accountLogin: market === "gameflip" && accounts.length === 1 ? accounts[0].login : "",
      requiredDrops: (set.items || []).map((i) => ({ name: i.name, qty: i.qty })),
      units: accounts.map((a) => ({
        contentId: String(a.contentId || ""),
        accountId: "",
        login: a.login,
        addedAt: new Date(),
        deliveredAt: null,
        orderId: "",
      })),
    };
  },
};

const noclaimListingsStub = {
  async onGameflipSold(row, opts) {
    log("onGameflipSold", row && row._id, opts);
    if (S.soldHookError) throw S.soldHookError;
    return { sold: 1 };
  },
  async onGameflipRetired(row, opts) {
    log("onGameflipRetired", row && row._id, opts);
    if (typeof S.retireHook === "function") return S.retireHook(row, opts);
    return { released: 1 };
  },
};

const stubs = new Map(
  [
    ["models/AccountOffer", AccountOffer],
    ["models/BotAccount", BotAccount],
    ["models/DropLog", DropLog],
    ["models/DropSet", DropSet],
    ["models/MarketplaceListing", MarketplaceListing],
    ["routes/shopRoutes", shopRoutes],
    ["utils/listedLogins", listedLogins],
    ["utils/marketplaces", mp],
    ["utils/gameflipFarmService", gfFarm],
    ["utils/secretBox", secretBox],
    ["utils/setImage", setImage],
    ["utils/saleLearning", saleLearning],
    ["utils/telegram", telegram],
    ["utils/dropReservation", dropReservation],
    ["utils/autoLister", autoLister],
    ["utils/suppliedStock", suppliedStock],
    ["utils/noclaimStock", noclaimStockStub],
    ["utils/noclaimListings", noclaimListingsStub],
  ].map(([rel, mod]) => [path.join(ROOT, rel), mod]),
);

// Matched on the resolved PATH, not through Module._resolveFilename: the two
// no-claim modules may not exist on disk yet, and resolving them would throw.
const loads = { noclaimStock: 0, noclaimListings: 0 };
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (typeof request === "string" && request.startsWith(".") && parent && parent.filename) {
    const abs = path.resolve(path.dirname(parent.filename), request).replace(/\.js$/, "");
    if (stubs.has(abs)) {
      const base = path.basename(abs);
      if (base in loads) loads[base] += 1;
      return stubs.get(abs);
    }
  }
  return origLoad.apply(this, arguments);
};

delete require.cache[require.resolve("../utils/gameflipFulfiller")];
const gf = require("../utils/gameflipFulfiller");
const loadsAtRequire = { ...loads };

test.after(() => {
  Module._load = origLoad;
  console.error = realConsoleError;
});

// Every trace of the archive claim, its text rewrite and its release.
function assertArchiveUntouched() {
  for (const n of [
    "availableAccountsForSet",
    "loginsOnActiveListings",
    "BotAccount.find",
    "BotAccount.findById",
    "reserveSetOnAccount",
    "DropLog.aggregate",
    "releaseSetForAccounts",
    "releaseAccountsForTag",
  ]) {
    assert.strictEqual(called(n).length, 0, n + " must never run for a no-claim set");
  }
}

function publishNc(over = {}) {
  return gf.publishAutoDelivery({
    set: ncSet(),
    title: "Overwatch 2 Twitch Drops (2 Items)",
    description: "set-built description",
    priceUsd: 5,
    imagePath: "/cover/grid.png",
    qtyRemaining: 2,
    origin: "manual",
    ...over,
  });
}

const ncRow = (over = {}) => ({
  _id: "row-1",
  marketplace: "gameflip",
  externalId: "gf-1",
  status: "active",
  set: "set-nc",
  title: "NC bundle",
  description: "nc description",
  price: 5,
  origin: "manual",
  autoDeliver: true,
  qtyRemaining: 2,
  noclaimStock: true,
  accountId: "",
  accountLogin: "nc_login",
  units: [{ login: "nc_login", contentId: "", deliveredAt: null }],
  ...over,
});
const archiveRow = (over = {}) => ({
  _id: "row-a",
  marketplace: "gameflip",
  externalId: "gf-a",
  status: "active",
  set: "set-a",
  title: "Archive bundle",
  description: "archive description",
  price: 4,
  origin: "auto",
  autoDeliver: true,
  qtyRemaining: 1,
  accountId: "acc-1",
  accountLogin: "archive_login",
  ...over,
});
const outOfStockAlerts = () =>
  called("sendTelegram")
    .map((c) => c.args[0])
    .filter((t) => /chain out of stock/.test(t));

/* ================= 1. publishing a no-claim set ========================== */

test("the no-claim modules are required lazily, never at load time", () => {
  assert.deepStrictEqual(loadsAtRequire, { noclaimStock: 0, noclaimListings: 0 });
  assert.strictEqual(typeof gf.relistNoclaimSuccessor, "function");
});

test("a no-claim set claims ONE no-claim account and never reaches the archive claim", async () => {
  reset();
  await publishNc();
  assertArchiveUntouched();
  const claims = called("claimForSet");
  assert.strictEqual(claims.length, 1);
  assert.deepStrictEqual(claims[0].args, ["set-nc", 1, { market: "gameflip", mode: "fed" }]);
  const pub = called("gameflipPublish");
  assert.strictEqual(pub.length, 1);
  const opts = pub[0].args[0];
  assert.strictEqual(opts.autoDeliverCode, gf.gameflipDeliveryCode("nc_login", "nc-secret-pw"));
  // The caller's set-built text, never an archive rewrite: the advertised
  // bundle is exactly the set.
  assert.strictEqual(opts.title, "Overwatch 2 Twitch Drops (2 Items)");
  assert.strictEqual(opts.description, "set-built description");
  assert.strictEqual(opts.imagePath, "/cover/grid.png");
  assert.strictEqual(opts.priceUsd, 5);
  assert.ok(firstIndex("claimForSet") < firstIndex("gameflipPublish"));
});

test("the explicit noclaim flag routes out even when the set lost its stockSource", async () => {
  reset();
  await assert.rejects(publishNc({ set: archiveSet(), noclaim: true }), { message: OUT_OF_STOCK });
  assertArchiveUntouched();
  assert.strictEqual(called("claimForSet").length, 1, "the no-claim layer decides, and refuses");
  assert.strictEqual(called("gameflipPublish").length, 0);
  assert.strictEqual(called("MarketplaceListing.create").length, 0);
});

test("the row carries the archive lane's fields plus the no-claim invariants", async () => {
  reset();
  const doc = await publishNc({ origin: "auto" });
  const creates = called("MarketplaceListing.create");
  assert.strictEqual(creates.length, 1);
  const row = creates[0].args[0];
  assert.strictEqual(row.marketplace, "gameflip");
  assert.strictEqual(row.externalId, doc.externalId);
  assert.strictEqual(row.url, "https://gameflip.com/item/" + doc.externalId);
  assert.strictEqual(row.status, "active");
  assert.strictEqual(row.autoDeliver, true);
  assert.strictEqual(row.qtyRemaining, 2);
  assert.strictEqual(row.price, 5);
  assert.strictEqual(row.title, "Overwatch 2 Twitch Drops (2 Items)");
  assert.strictEqual(row.note, "no-claim auto-delivery — nc_login");
  assert.strictEqual(row.noclaimStock, true);
  assert.strictEqual(String(row.set), "set-nc");
  assert.strictEqual(row.accountId, "", "a no-claim row never names an archive account");
  assert.strictEqual(row.accountLogin, "nc_login");
  // rowFields is spread LAST: an owner's no-claim listing is never repriced,
  // whatever origin the caller passed.
  assert.strictEqual(row.origin, "manual");
  assert.deepStrictEqual(row.units.map((u) => u.login), ["nc_login"]);
  assert.ok(!("unclaimedGame" in row) && !("autoClaimSet" in row));
  assert.ok(!JSON.stringify(row).includes("nc-secret-pw"), "credentials never land on the row");
  const attach = called("attachListing");
  assert.strictEqual(attach.length, 1);
  assert.deepStrictEqual(attach[0].args, [["ledger-1"], doc._id]);
  assert.ok(firstIndex("MarketplaceListing.create") < firstIndex("attachListing"));
});

test("the set's price floor still applies to a no-claim set", async () => {
  reset();
  await publishNc({ set: ncSet({ minPriceUsd: 7 }), priceUsd: 5 });
  assert.strictEqual(called("gameflipPublish")[0].args[0].priceUsd, 7);
  assert.strictEqual(called("MarketplaceListing.create")[0].args[0].price, 7);
});

test("out of stock throws the contract's message and publishes nothing", async () => {
  reset({ noclaimAccounts: [] });
  await assert.rejects(publishNc(), (e) => {
    assert.strictEqual(e.message, OUT_OF_STOCK);
    assert.ok(gf.isOutOfStockError(e.message), "a stalled chain must still be escalated");
    return true;
  });
  assertArchiveUntouched();
  assert.strictEqual(called("gameflipPublish").length, 0);
  assert.strictEqual(called("MarketplaceListing.create").length, 0);
  assert.strictEqual(called("releaseClaim").length, 0, "nothing was claimed, so nothing to release");
});

test("a failed publish releases the claim and rethrows the publish error", async () => {
  const boom = new Error("Gameflip create: Too many attempts");
  reset({ publishError: boom });
  await assert.rejects(publishNc(), (e) => e === boom);
  const rel = called("releaseClaim");
  assert.strictEqual(rel.length, 1);
  assert.deepStrictEqual(rel[0].args, [["ledger-1"], { reason: "gameflip publish failed" }]);
  assert.strictEqual(called("MarketplaceListing.create").length, 0);
  assert.strictEqual(called("attachListing").length, 0);
  assertArchiveUntouched();
});

test("a release that fails is loud and never masks the publish error", async () => {
  const boom = new Error("Gameflip create: Too many attempts");
  reset({ publishError: boom, releaseError: new Error("atlas hiccup") });
  await assert.rejects(publishNc(), (e) => e === boom);
  assert.ok(errors.some((l) => /could not hand nc_login back/.test(l)), errors.join("\n"));
});

test("an account with no readable password is handed back, never published", async () => {
  reset({ noclaimAccounts: [{ ...NC_ACC, password: "" }] });
  await assert.rejects(publishNc(), /no readable password/);
  assert.deepStrictEqual(called("releaseClaim")[0].args[0], ["ledger-1"]);
  assert.strictEqual(called("gameflipPublish").length, 0);
});

test("the row's fields are built before the publish, so a bad build releases instead of stranding a live listing", async () => {
  reset({ rowFieldsError: new Error("bad set shape") });
  await assert.rejects(publishNc(), /bad set shape/);
  assert.strictEqual(called("gameflipPublish").length, 0);
  assert.strictEqual(called("releaseClaim").length, 1);
});

test("a row that cannot be written after a live publish keeps the account claimed", async () => {
  reset({ createError: new Error("validation failed") });
  await assert.rejects(publishNc(), /validation failed/);
  assert.strictEqual(called("gameflipPublish").length, 1);
  assert.strictEqual(
    called("releaseClaim").length,
    0,
    "the credentials are live on Gameflip — releasing would sell the account twice",
  );
  assert.ok(errors.some((l) => /IS LIVE/.test(l)), errors.join("\n"));
});

test("a failed attach does not turn a live publish into a reported failure", async () => {
  reset({ attachError: new Error("atlas hiccup") });
  const doc = await publishNc();
  assert.ok(doc && doc.externalId);
  assert.strictEqual(called("releaseClaim").length, 0);
  assert.ok(errors.some((l) => /could not attach/.test(l)), errors.join("\n"));
});

/* ================= 2. archive sets are unchanged ========================= */

test("an archive set still takes the archive lane and never loads the no-claim modules", async () => {
  // stockSource "" and a set from before the field existed.
  for (const set of [archiveSet(), { _id: "set-a", items: ITEMS }]) {
    reset();
    const before = { ...loads };
    await gf.publishAutoDelivery({
      set,
      title: "t",
      description: "d",
      priceUsd: 4,
      imagePath: "",
      qtyRemaining: 1,
      origin: "auto",
    });
    assert.deepStrictEqual(loads, before, "the archive lane must not even load the no-claim modules");
    assert.strictEqual(called("claimForSet").length, 0);
    assert.strictEqual(called("availableAccountsForSet").length, 1);
    assert.strictEqual(called("reserveSetOnAccount").length, 1);
    assert.strictEqual(called("DropLog.aggregate").length, 1, "the archive text rewrite still runs");
    assert.strictEqual(
      called("gameflipPublish")[0].args[0].autoDeliverCode,
      gf.gameflipDeliveryCode("archive_login", "archive-pw"),
    );
    const row = called("MarketplaceListing.create")[0].args[0];
    assert.strictEqual(row.accountId, "acc-1");
    assert.strictEqual(row.accountLogin, "archive_login");
    assert.strictEqual(row.note, "auto-delivery: archive_login");
    assert.strictEqual(row.origin, "auto");
    assert.ok(!("noclaimStock" in row) && !("units" in row));
    assert.strictEqual(called("attachListing").length, 0);
  }
});

test("an archive publish failure still releases the archive reservation, never a no-claim claim", async () => {
  reset({ publishError: new Error("Gameflip create: 429") });
  await assert.rejects(
    gf.publishAutoDelivery({ set: archiveSet(), title: "t", description: "d", priceUsd: 4 }),
    /429/,
  );
  assert.deepStrictEqual(called("releaseSetForAccounts")[0].args, [["acc-1"], "set-a", "gameflip"]);
  assert.strictEqual(called("releaseClaim").length, 0);
});

/* ================= 3. the watcher's sold path ============================ */

test("a sold no-claim row: the sold hook runs before sale learning and before the relist", async () => {
  reset({ activeRows: [ncRow()], soldIds: ["gf-1"] });
  const out = await gf.syncOnce();
  assert.deepStrictEqual(out, { checked: 1, sold: 1, relisted: 1 });
  const hook = called("onGameflipSold");
  assert.strictEqual(hook.length, 1);
  assert.deepStrictEqual(hook[0].args, ["row-1", { priceUsd: 5 }]);
  const iSoldClaim = calls.findIndex(
    (c) => c.name === "MarketplaceListing.findOneAndUpdate" && c.args[1].$set.status === "sold",
  );
  const iHook = firstIndex("onGameflipSold");
  assert.ok(iSoldClaim >= 0 && iSoldClaim < iHook, "only after the atomic sold claim");
  assert.ok(iHook < firstIndex("recordListingSale"), "before sale learning");
  assert.ok(iHook < firstIndex("claimForSet"), "before the relist claims the next account");
  assert.ok(iHook < firstIndex("gameflipPublish"));
  // The successor comes from the no-claim farm and inherits the flag.
  assertArchiveUntouched();
  const row = called("MarketplaceListing.create")[0].args[0];
  assert.strictEqual(row.noclaimStock, true);
  assert.strictEqual(row.qtyRemaining, 1);
  assert.strictEqual(row.title, "NC bundle");
});

test("a sold hook that throws never ends the chain", async () => {
  reset({ activeRows: [ncRow()], soldIds: ["gf-1"], soldHookError: new Error("atlas hiccup") });
  const out = await gf.syncOnce();
  assert.strictEqual(out.relisted, 1);
  assert.ok(errors.some((l) => /could not mark its account sold/.test(l)), errors.join("\n"));
});

test("a sold no-claim row relists from the no-claim farm even if its set lost the flag", async () => {
  reset({ activeRows: [ncRow()], soldIds: ["gf-1"] });
  S.sets["set-nc"] = ncSet({ stockSource: "" });
  const out = await gf.syncOnce();
  assertArchiveUntouched();
  assert.strictEqual(called("claimForSet").length, 1);
  // The claim layer refuses a set that is not no-claim, so the chain records
  // an out-of-stock failure for the retry lane instead of shipping archive
  // stock.
  assert.strictEqual(out.relisted, 0);
  assert.ok(
    called("MarketplaceListing.updateOne").some((c) =>
      /^auto-relist failed: Out of stock/.test((c.args[1].$set || {}).lastError || ""),
    ),
  );
});

test("the stalled-relist lane retries a no-claim chain from the no-claim farm too", async () => {
  reset({
    stalledRows: [
      ncRow({ status: "sold", lastError: "auto-relist failed: Gameflip create: 429", relistRetryAt: null }),
    ],
  });
  S.sets["set-nc"] = ncSet({ stockSource: "" });
  await gf.syncOnce();
  assertArchiveUntouched();
  assert.strictEqual(called("claimForSet").length, 1, "the row's own flag routes the retry");
});

test("an archive row's sale never calls the no-claim hooks", async () => {
  reset({ activeRows: [archiveRow()], soldIds: ["gf-a"] });
  const before = { ...loads };
  const out = await gf.syncOnce();
  assert.deepStrictEqual(out, { checked: 1, sold: 1, relisted: 1 });
  assert.deepStrictEqual(loads, before);
  assert.strictEqual(called("onGameflipSold").length, 0);
  assert.strictEqual(called("claimForSet").length, 0);
  assert.strictEqual(called("availableAccountsForSet").length, 1);
});

test("a no-claim chain's out-of-stock alert names the no-claim farm, not the farmer", async () => {
  reset({ activeRows: [ncRow({ relistAttempts: 2 })], soldIds: ["gf-1"], noclaimAccounts: [] });
  await gf.syncOnce();
  const alerts = outOfStockAlerts();
  assert.strictEqual(alerts.length, 1);
  assert.match(alerts[0], /no free no-claim account holds this bundle/);
  assert.doesNotMatch(alerts[0], /until the farmer produces one/);
});

test("an archive chain's out-of-stock alert is unchanged", async () => {
  reset({ activeRows: [archiveRow({ relistAttempts: 2 })], soldIds: ["gf-a"], archiveCandidates: [] });
  await gf.syncOnce();
  const alerts = outOfStockAlerts();
  assert.strictEqual(alerts.length, 1);
  assert.match(
    alerts[0],
    /no unsold account holds the whole bundle — the chain is paused until the farmer produces one\./,
  );
  assert.doesNotMatch(alerts[0], /no-claim/);
});

/* ================= 4. the watcher's retire paths ========================= */

for (const [label, status, reason] of [
  ["404", Object.assign(new Error("not found"), { status: 404 }), "listing 404 on Gameflip"],
  ["expired", "expired", 'gameflip reports "expired"'],
  ["cancelled", "cancelled", 'gameflip reports "cancelled"'],
]) {
  test("a retired (" + label + ") no-claim row hands its account back", async () => {
    // In neither bulk sweep, so it gets its own status call.
    reset({ activeRows: [ncRow()], statusFor: { "gf-1": status } });
    await gf.syncOnce();
    const iRetire = calls.findIndex(
      (c) => c.name === "MarketplaceListing.findOneAndUpdate" && c.args[1].$set.status === "removed",
    );
    assert.ok(iRetire >= 0, "the row is retired first");
    const hook = called("onGameflipRetired");
    assert.strictEqual(hook.length, 1);
    assert.deepStrictEqual(hook[0].args, ["row-1", { reason }]);
    assert.ok(iRetire < firstIndex("onGameflipRetired"), "retire FIRST, release second");
    assert.strictEqual(called("releaseSetForAccounts").length, 0, "no archive reservation to free");
    assert.strictEqual(called("onGameflipSold").length, 0);
    assert.strictEqual(called("gameflipPublish").length, 0, "the watcher does not replace a retired unit");
  });
}

test("a retire that loses the race hands nothing back", async () => {
  reset({ activeRows: [ncRow()], statusFor: { "gf-1": "expired" }, findOneAndUpdate: () => null });
  await gf.syncOnce();
  assert.strictEqual(called("onGameflipRetired").length, 0);
});

test("a retire hook that throws never abandons the rest of the pass", async () => {
  reset({
    activeRows: [ncRow(), ncRow({ _id: "row-2", externalId: "gf-2" })],
    statusFor: { "gf-1": "expired", "gf-2": "expired" },
    retireHook: (row) => {
      if (row._id === "row-1") throw new Error("atlas hiccup");
      return { released: 1 };
    },
  });
  const out = await gf.syncOnce();
  assert.strictEqual(out.checked, 2);
  assert.deepStrictEqual(called("onGameflipRetired").map((c) => c.args[0]), ["row-1", "row-2"]);
  assert.ok(errors.some((l) => /could not hand its account back/.test(l)), errors.join("\n"));
});

test("a transient status error retires nothing and hands nothing back", async () => {
  reset({ activeRows: [ncRow()], statusFor: { "gf-1": Object.assign(new Error("429"), { status: 429 }) } });
  await gf.syncOnce();
  assert.strictEqual(called("onGameflipRetired").length, 0);
  assert.strictEqual(called("MarketplaceListing.findOneAndUpdate").length, 0);
});

test("an archive row's retire path is unchanged", async () => {
  reset({ activeRows: [archiveRow()], statusFor: { "gf-a": "expired" } });
  await gf.syncOnce();
  assert.deepStrictEqual(called("releaseSetForAccounts")[0].args, [["acc-1"], "set-a", "gameflip"]);
  assert.strictEqual(called("onGameflipRetired").length, 0);
});

/* ================= 5. relistNoclaimSuccessor ============================= */

test("relistNoclaimSuccessor replaces the unit and moves the queue to the replacement", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noclaim-gf-"));
  const img = path.join(dir, "grid.png");
  fs.writeFileSync(img, "png");
  try {
    reset({ gridImage: img });
    const old = ncRow({ status: "delisted", qtyRemaining: 3, price: 6 });
    const doc = await gf.relistNoclaimSuccessor(old);
    assert.ok(doc && doc.externalId);
    assertArchiveUntouched();
    assert.deepStrictEqual(called("buildSetGridImage")[0].args, ["set-nc"]);
    assert.deepStrictEqual(called("claimForSet")[0].args, ["set-nc", 1, { market: "gameflip", mode: "fed" }]);
    const pub = called("gameflipPublish")[0].args[0];
    assert.strictEqual(pub.imagePath, img);
    assert.strictEqual(pub.title, "NC bundle");
    assert.strictEqual(pub.description, "nc description");
    assert.strictEqual(pub.priceUsd, 6);
    const row = called("MarketplaceListing.create")[0].args[0];
    assert.strictEqual(row.qtyRemaining, 3, "the replacement carries the whole queue");
    assert.strictEqual(row.noclaimStock, true);
    assert.strictEqual(row.origin, "manual");
    const zero = called("MarketplaceListing.updateOne");
    assert.strictEqual(zero.length, 1);
    assert.deepStrictEqual(zero[0].args, [{ _id: "row-1" }, { $set: { qtyRemaining: 0 } }]);
    assert.ok(
      firstIndex("MarketplaceListing.create") < calls.indexOf(zero[0]),
      "the old row gives its queue up only once the replacement exists",
    );
    assert.strictEqual(fs.existsSync(img), false, "the cover temp file is cleaned up");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("relistNoclaimSuccessor: a row with no queue gets a replacement with none", async () => {
  reset();
  await gf.relistNoclaimSuccessor(ncRow({ qtyRemaining: undefined }));
  assert.strictEqual(called("MarketplaceListing.create")[0].args[0].qtyRemaining, 0);
});

test("relistNoclaimSuccessor: out of stock returns null, never throws, and the old row keeps its debt", async () => {
  reset({ noclaimAccounts: [] });
  const out = await gf.relistNoclaimSuccessor(ncRow());
  assert.strictEqual(out, null);
  assert.strictEqual(called("gameflipPublish").length, 0);
  assert.strictEqual(called("MarketplaceListing.updateOne").length, 0);
  assert.ok(errors.some((l) => /out of stock, the chain ends here/.test(l)), errors.join("\n"));
});

test("relistNoclaimSuccessor: a failed publish releases the claim and returns null", async () => {
  reset({ publishError: new Error("Gameflip create: Too many attempts") });
  const out = await gf.relistNoclaimSuccessor(ncRow());
  assert.strictEqual(out, null);
  assert.strictEqual(called("releaseClaim").length, 1);
  assert.strictEqual(called("MarketplaceListing.updateOne").length, 0);
});

test("relistNoclaimSuccessor: a set that is gone returns null without claiming", async () => {
  reset();
  delete S.sets["set-nc"];
  assert.strictEqual(await gf.relistNoclaimSuccessor(ncRow()), null);
  assert.strictEqual(called("claimForSet").length, 0);
  assert.strictEqual(called("gameflipPublish").length, 0);
});

test("relistNoclaimSuccessor refuses while the old listing is still active", async () => {
  // delistRowVerified leaves a row "active" when the platform would not
  // confirm the delist: replacing it would put two units up for one owed.
  reset({ listingStatus: "active" });
  assert.strictEqual(await gf.relistNoclaimSuccessor(ncRow()), null);
  assert.strictEqual(called("claimForSet").length, 0);
  assert.strictEqual(called("gameflipPublish").length, 0);
});

test("relistNoclaimSuccessor never reaches the archive, even for a set without the flag", async () => {
  reset();
  S.sets["set-nc"] = ncSet({ stockSource: "" });
  assert.strictEqual(await gf.relistNoclaimSuccessor(ncRow()), null);
  assertArchiveUntouched();
  assert.strictEqual(called("claimForSet").length, 1);
});

test("relistNoclaimSuccessor with nothing to work with does nothing", async () => {
  reset();
  assert.strictEqual(await gf.relistNoclaimSuccessor(null), null);
  assert.strictEqual(await gf.relistNoclaimSuccessor({}), null);
  assert.strictEqual(calls.length, 0);
});
