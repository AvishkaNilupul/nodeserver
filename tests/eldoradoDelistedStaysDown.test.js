// A delisted Eldorado listing must stay off sale (2026-09-30).
//
// Offer 00ec3522 (Overwatch, OWCS MSC Day 1, claims from the Drop Archive) sold
// its only unit on 2026-09-07, which CLOSED it on Eldorado, and its row was set
// "delisted" that afternoon. On 2026-09-28 the 15-minute stock sync, whose
// autoClaimSet clause had no status filter, saw one claimable account and
// pushed "0 -> 1": the quantity write re-opened the closed offer. At 22:25 UTC
// the keep-alive, which never looked at our rows, renewed it to 2026-10-19.
// Offer 48a19c2e went round the other half of the loop: delisted while the
// sync had it paused (autoPaused), then RESUMED every time its set gained an
// account.
//
// Run against the REAL eldoradoFulfiller with every relative require stubbed
// (no DB, no network). ML.find applies the real Mongo filter to in-memory rows,
// so these tests pin what the query selects, not how it is spelled.
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const Module = require("node:module");

const ROOT = path.join(__dirname, "..");
const UNDER_TEST = new Set(["utils/eldoradoFulfiller"]);

// A Mongoose-query stand-in: awaitable directly or through .lean().
function q(value) {
  const p = Promise.resolve(value);
  return { lean: () => p, then: p.then.bind(p), catch: p.catch.bind(p) };
}
function autoStub() {
  return new Proxy({}, { get: (t, k) => (k in t ? t[k] : async () => undefined) });
}

// Just enough of Mongo's matcher for the filters under test: equality, $or,
// $in, $nin, $ne, where a missing field reads as null.
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return cond.some((f) => matches(doc, f));
    const v = doc[k] === undefined ? null : doc[k];
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("$in" in cond) return cond.$in.includes(v);
      if ("$nin" in cond) return !cond.$nin.includes(v);
      if ("$ne" in cond) return v !== cond.$ne;
    }
    return v === cond;
  });
}

const calls = [];
const ML = {
  rows: [],
  findError: null,
  find(filter) {
    if (ML.findError) {
      const p = Promise.reject(ML.findError);
      p.catch(() => {});
      return { lean: () => p, then: p.then.bind(p), catch: p.catch.bind(p) };
    }
    return q(ML.rows.filter((r) => matches(r, filter)));
  },
  findOne(filter) {
    return q(ML.rows.find((r) => matches(r, filter)) || null);
  },
};
const mp = {
  offers: new Map(),
  keyStatus: () => ({ eldorado: { configured: true } }),
  async eldoradoOffer(id) {
    calls.push(["read", id]);
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
    if (o && o.offerState === "Paused") {
      o.offerState = "Active";
      o.expireDate = "2026-10-19T18:00:00";
    }
  },
  // What Eldorado did to 00ec3522: a restock re-opens a CLOSED (sold-out) offer.
  async eldoradoSetQuantity(id, n) {
    calls.push(["quantity", id, n]);
    const o = mp.offers.get(id);
    if (o) {
      o.quantity = n;
      if (o.offerState === "Closed" && n > 0) o.offerState = "Active";
    }
  },
  async eldoradoMyListings() {
    return {
      results: [...mp.offers.entries()].map(([id, o]) => ({ offer: { id, offerTitle: "t-" + id, ...o } })),
      totalPages: 1,
    };
  },
};
const stockBySet = new Map();
const STUBS = {
  "models/MarketplaceListing": ML,
  "models/DropSet": { findById: (id) => q({ _id: id, name: "set-" + id, items: [] }) },
  "routes/shopRoutes": {
    availableAccountsForSet: async (set) =>
      Array.from({ length: stockBySet.get(String(set._id)) || 0 }, (_, i) => ({ accountId: "a" + i })),
  },
  "utils/listedLogins": { loginsOnActiveListings: async () => new Set(), notListed: (a) => a },
  "utils/settings": {
    getAutoFarm: () => ({ eldoradoAutoDeliver: true }),
    getAccountListingSettings: () => ({}),
  },
  "utils/marketplaces": mp,
  "utils/secretBox": { decrypt: (x) => x || "" },
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
const ef = require(path.join(ROOT, "utils", "eldoradoFulfiller.js"));
// The hook stays installed: the fulfiller requires lazily at call time too.

/* ------------------------------ helpers ------------------------------ */

function reset() {
  calls.length = 0;
  ML.rows = [];
  ML.findError = null;
  mp.offers.clear();
  stockBySet.clear();
}
// A Drop Archive bundle row, the shape scripts/eldorado-bundle-listings.js writes.
function archiveRow(externalId, fields = {}) {
  const row = {
    _id: "row-" + externalId,
    marketplace: "eldorado",
    externalId,
    title: "t-" + externalId,
    origin: "manual",
    autoClaimSet: true,
    set: "set-" + externalId,
    status: "active",
    autoPaused: false,
    unclaimedGame: "",
    accountOffer: null,
    noclaimStock: false,
    lastError: "",
    saves: 0,
    ...fields,
  };
  row.save = async function () {
    this.saves++;
  };
  return row;
}
const touched = (id) => calls.filter((c) => c[1] === id);
const NOW = Date.parse("2026-09-28T22:25:50Z");
// The keep-alive paces itself (1.5 s between offers, 2 s between resume
// retries). Collapse those waits for the call under test only.
async function fast(fn) {
  const real = global.setTimeout;
  global.setTimeout = (cb, _ms, ...a) => real(cb, 0, ...a);
  try {
    return await fn();
  } finally {
    global.setTimeout = real;
  }
}
const renew = (opts) => fast(() => ef.renewExpiringOffers({ now: NOW, ...opts }));
const quietly = async (fn) => {
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = log;
  }
};

/* ------------------------- syncBundleStock ------------------------- */

test("00ec3522: the stock sync never restocks a DELISTED row's closed offer", async () => {
  reset();
  // Sold out on 09-07 (Eldorado closed it), row delisted the same day, not paused by us.
  ML.rows = [archiveRow("00ec3522", { status: "delisted" })];
  mp.offers.set("00ec3522", { offerState: "Closed", quantity: 0, expireDate: "2026-09-27T18:00:00" });
  stockBySet.set("set-00ec3522", 1); // 09-28: one account came to hold the set

  const changes = await ef.syncBundleStock();

  assert.deepStrictEqual(touched("00ec3522"), [], "a delisted row gets no read, no quantity push, no resume");
  assert.deepStrictEqual(changes, []);
  assert.strictEqual(mp.offers.get("00ec3522").offerState, "Closed", "the offer stays off sale");
});

test("48a19c2e: a row delisted while the sync had it paused is never resumed", async () => {
  reset();
  ML.rows = [archiveRow("48a19c2e", { status: "delisted", autoPaused: true, lastError: "paused: no claimable stock" })];
  mp.offers.set("48a19c2e", { offerState: "Paused", quantity: 1 });
  stockBySet.set("set-48a19c2e", 1);

  await ef.syncBundleStock();

  assert.deepStrictEqual(touched("48a19c2e"), []);
  assert.strictEqual(mp.offers.get("48a19c2e").offerState, "Paused");
  assert.strictEqual(ML.rows[0].autoPaused, true, "the row is left exactly as it was");
  assert.strictEqual(ML.rows[0].saves, 0);
});

test("sold and removed archive rows are left alone too", async () => {
  reset();
  ML.rows = [archiveRow("sold1", { status: "sold" }), archiveRow("gone1", { status: "removed" })];
  mp.offers.set("sold1", { offerState: "Closed", quantity: 0 });
  mp.offers.set("gone1", { offerState: "Paused", quantity: 3 });
  stockBySet.set("set-sold1", 4);
  stockBySet.set("set-gone1", 4);

  await ef.syncBundleStock();

  assert.deepStrictEqual(calls, []);
});

test("ACTIVE archive rows keep all three behaviours: resync, pause at zero, resume own pause", async () => {
  reset();
  ML.rows = [
    archiveRow("live"),
    archiveRow("dry"),
    // Our own pause keeps status "active" — the status filter must not hide it.
    archiveRow("ours", { autoPaused: true, lastError: "paused: no claimable stock" }),
    // A deliberate pause (autoPaused false) is never overridden.
    archiveRow("owner", {}),
  ];
  mp.offers.set("live", { offerState: "Active", quantity: 3 });
  mp.offers.set("dry", { offerState: "Active", quantity: 2 });
  mp.offers.set("ours", { offerState: "Paused", quantity: 1 });
  mp.offers.set("owner", { offerState: "Paused", quantity: 5 });
  stockBySet.set("set-live", 5);
  stockBySet.set("set-dry", 0);
  stockBySet.set("set-ours", 2);
  stockBySet.set("set-owner", 5);

  await ef.syncBundleStock();

  assert.ok(calls.some((c) => c[0] === "quantity" && c[1] === "live" && c[2] === 5), "live resynced 3 -> 5");
  assert.ok(calls.some((c) => c[0] === "pause" && c[1] === "dry"), "dry paused");
  assert.strictEqual(ML.rows[1].autoPaused, true);
  assert.ok(calls.some((c) => c[0] === "resume" && c[1] === "ours"), "own pause resumed");
  assert.strictEqual(ML.rows[2].autoPaused, false);
  assert.ok(!calls.some((c) => c[0] === "resume" && c[1] === "owner"), "a deliberate pause stays");
});

test("the other three stock sources still sync only their active rows", async () => {
  reset();
  STUBS["utils/noclaimStock"] = { stockForListing: async () => 7 };
  STUBS["utils/suppliedStock"] = { stockFor: async () => 4 };
  ML.rows = [
    archiveRow("nc", { autoClaimSet: false, noclaimStock: true }),
    archiveRow("nc-off", { autoClaimSet: false, noclaimStock: true, status: "delisted" }),
    archiveRow("ao", { autoClaimSet: false, accountOffer: "offer-1" }),
    archiveRow("ao-off", { autoClaimSet: false, accountOffer: "offer-2", status: "delisted" }),
  ];
  for (const id of ["nc", "nc-off", "ao", "ao-off"]) mp.offers.set(id, { offerState: "Active", quantity: 1 });

  await ef.syncBundleStock();

  assert.ok(calls.some((c) => c[0] === "quantity" && c[1] === "nc" && c[2] === 7));
  assert.ok(calls.some((c) => c[0] === "quantity" && c[1] === "ao" && c[2] === 4));
  assert.deepStrictEqual(touched("nc-off"), []);
  assert.deepStrictEqual(touched("ao-off"), []);
});

/* ---------------------------- keep-alive ---------------------------- */

test("00ec3522: the keep-alive does not renew a live offer whose row is delisted", async () => {
  reset();
  ML.rows = [archiveRow("00ec3522", { status: "delisted" })];
  mp.offers.set("00ec3522", { offerState: "Active", quantity: 1, expireDate: "2026-09-27T18:00:00" });

  const r = await renew();

  assert.strictEqual(r.due, 1);
  assert.strictEqual(r.renewed.length, 0);
  assert.strictEqual(r.skipped.length, 1);
  assert.strictEqual(r.skipped[0].rowStatus, "delisted");
  assert.match(r.skipped[0].skipped, /delisted.*left to expire/);
  assert.strictEqual(r.skipped[0].title, "t-00ec3522");
  assert.ok(!calls.some((c) => c[0] === "pause" || c[0] === "resume"), "no pause, no resume");
  assert.strictEqual(mp.offers.get("00ec3522").expireDate, "2026-09-27T18:00:00", "expiry not extended");
});

test("the keep-alive still renews offers with no row (rent-farm, hand-made) and active rows", async () => {
  reset();
  ML.rows = [
    archiveRow("mine"),
    // A stale duplicate beside a live row: any active row keeps the offer alive.
    archiveRow("dup", { status: "delisted" }),
    { ...archiveRow("dup"), _id: "row-dup-2" },
  ];
  for (const id of ["farm", "mine", "dup"]) {
    mp.offers.set(id, { offerState: "Active", quantity: 1000, expireDate: "2026-09-30T18:00:00" });
  }

  const r = await renew();

  assert.deepStrictEqual(r.renewed.map((x) => x.offerId).sort(), ["dup", "farm", "mine"]);
  assert.deepStrictEqual(r.skipped, []);
  for (const id of ["farm", "mine", "dup"]) {
    assert.strictEqual(mp.offers.get(id).expireDate, "2026-10-19T18:00:00");
  }
});

test("a failed row lookup skips the renewal this pass, quietly", async () => {
  reset();
  ML.findError = new Error("connection reset");
  mp.offers.set("farm", { offerState: "Active", quantity: 1000, expireDate: "2026-09-30T18:00:00" });

  const r = await renew();

  assert.strictEqual(r.renewed.length, 0);
  assert.strictEqual(r.failed.length, 0, "not a failure: nothing to page about");
  assert.match(r.skipped[0].skipped, /lookup failed.*connection reset/);
  assert.ok(!calls.some((c) => c[0] === "pause" || c[0] === "resume" || c[0] === "read"));
});

test("a dry run applies the same row gate", async () => {
  reset();
  ML.rows = [archiveRow("off", { status: "delisted" }), archiveRow("on")];
  mp.offers.set("off", { offerState: "Active", quantity: 1, expireDate: "2026-09-30T18:00:00" });
  mp.offers.set("on", { offerState: "Active", quantity: 1, expireDate: "2026-09-30T18:00:00" });

  const r = await renew({ dryRun: true });

  assert.deepStrictEqual(r.wouldRenew.map((x) => x.offerId), ["on"]);
  assert.deepStrictEqual(r.skipped.map((x) => x.offerId), ["off"]);
  assert.ok(!calls.some((c) => c[0] === "pause" || c[0] === "resume"));
});

test("the report names each offer left to lapse, and does not page", async () => {
  reset();
  ML.rows = [archiveRow("00ec3522", { status: "delisted" })];
  mp.offers.set("00ec3522", { offerState: "Active", quantity: 1, expireDate: "2026-09-27T18:00:00" });

  const { lines } = await quietly(async () => ef.reportKeepAlive(await renew()));

  assert.ok(
    lines.some((l) => /not renewing 00ec3522 t-00ec3522 — our listing row is delisted/.test(l)),
    "log names the offer: " + JSON.stringify(lines),
  );
  const ev = calls.find((c) => c[0] === "event");
  assert.ok(ev, "a SystemEvent is written");
  assert.match(JSON.stringify(ev[1].meta.skipped), /00ec3522.*delisted/);
  assert.ok(!calls.some((c) => c[0] === "telegram"));
});

test("end to end, 2026-09-28: sync then keep-alive leave the delisted offer closed and unrenewed", async () => {
  reset();
  ML.rows = [archiveRow("00ec3522", { status: "delisted" })];
  mp.offers.set("00ec3522", { offerState: "Closed", quantity: 0, expireDate: "2026-09-27T18:00:00" });
  stockBySet.set("set-00ec3522", 1);

  await ef.syncBundleStock(); // ~16:37 UTC: stock returns
  const r = await renew(); // 22:25 UTC pass

  const o = mp.offers.get("00ec3522");
  assert.strictEqual(o.offerState, "Closed");
  assert.strictEqual(o.quantity, 0);
  assert.strictEqual(o.expireDate, "2026-09-27T18:00:00");
  assert.strictEqual(r.due, 0, "a closed offer is not even due");
});
