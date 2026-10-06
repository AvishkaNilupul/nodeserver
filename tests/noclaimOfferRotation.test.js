// No-claim Eldorado offer rotation (docs/NOCLAIM-OFFER-ROTATION-CONTRACT.md).
//
// The case it exists for, measured on prod 2026-10-01: R6's selling offer
// c847f2c2 sold "9× Esports Pack 26 stage 2". Those packs expired off every
// account, the stock sync paused the offer, and it sat paused 31 hours while
// 41 free accounts held 6× Esports Pack 26 Stage 2.1 + 2× OL' CLANKER. No Mongo,
// no network: every dependency is injected.
const test = require("node:test");
const assert = require("node:assert");

const rot = require("../utils/noclaimOfferRotation");

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-01T16:00:00Z");

const G = "Rainbow Six Siege";
const S21 = "esports pack 26 stage 2.1|rainbow six siege";
const S2 = "esports pack 26 stage 2|rainbow six siege";
const OLC = "ol' clanker|rainbow six siege";
const FROST = "2024 frost uniform|rainbow six siege";

const item = (itemKey, qty, campaign) => ({
  itemKey,
  name: itemKey.split("|")[0],
  game: G,
  campaign: campaign || "",
  image: "https://img/" + itemKey.split("|")[0].replace(/\W+/g, "-") + ".png",
  qty,
});

let seq = 0;
function holding(items, extra = {}) {
  seq++;
  return { loginLower: "acct" + seq, inConfig: true, items, ...extra };
}

// Prod's R6 shape on 2026-10-01 (59 free + fresh accounts).
function r6Holdings() {
  const out = [];
  for (let i = 0; i < 41; i++)
    out.push(holding([item(S21, 6, "R6S S2 2026 11"), item(OLC, 2, "R6S Wasteland circuit"), item(S2, 6, "R6S S2 2026 9"), item(FROST, 1)]));
  for (let i = 0; i < 2; i++)
    out.push(holding([item(S21, 6, "R6S S2 2026 11"), item(OLC, 1, "R6S Wasteland circuit"), item(S2, 6, "R6S S2 2026 9")]));
  for (let i = 0; i < 16; i++)
    out.push(holding([item(S21, 4, "R6S S2 2026 12"), item(OLC, 2, "R6S Wasteland circuit")]));
  // Committed to the Gameflip shelf, or read too long ago: never counted.
  for (let i = 0; i < 50; i++) out.push(holding([item(S21, 6, "R6S S2 2026 11"), item(OLC, 2)], { free: false }));
  for (let i = 0; i < 5; i++) out.push(holding([item(S21, 9, "R6S S2 2026 11")], { fresh: false }));
  return out;
}

const r6Campaigns = () =>
  rot.campaignRecency(
    [
      { name: "R6S S2 2026 12", status: "ACTIVE", active: true, endAt: new Date("2026-10-03T04:58:59Z") },
      { name: "R6S S2 2026 11", status: "EXPIRED", active: false, endAt: new Date("2026-09-30T04:58:59Z") },
      { name: "R6S S2 2026 9", status: "EXPIRED", active: false, endAt: new Date("2026-09-26T04:58:59Z") },
      { name: "R6S Wasteland circuit", status: "ACTIVE", active: true, endAt: new Date("2026-10-13T13:59:59Z") },
      { name: "R6S Wasteland circuit", status: "EXPIRED", active: false, endAt: new Date("2026-10-13T13:59:59Z") },
    ],
    NOW,
  );

const pickR6 = (holdings = r6Holdings(), campaigns = r6Campaigns()) =>
  rot.pickRotationBundle({
    holdings,
    isFree: (h) => h.free !== false,
    isFresh: (h) => h.fresh !== false,
    game: G,
    campaigns,
    now: NOW,
  });

/* ------------------------------- the picker ------------------------------ */

test("picks the newest wave at the copies most free accounts hold — prod's 2026-10-01 R6 case", () => {
  const p = pickR6();
  assert.ok(p.items, p.reason);
  assert.strictEqual(
    rot.itemsSignature(p.items),
    rot.itemsSignature([{ itemKey: S21, qty: 6 }, { itemKey: OLC, qty: 2 }]),
    "6× Stage 2.1 + 2× OL' CLANKER — what the owner chose by hand",
  );
  assert.strictEqual(p.pool, 59, "only free + fresh holdings count");
  assert.strictEqual(p.minCover, 30, "half the free accounts, at least 10");
  assert.strictEqual(p.covering, 41);
  assert.strictEqual(p.newestOnly, true);
  for (const it of p.items) {
    assert.ok(it.name && it.game === G && it.image, "items carry name, game and image for the set");
  }
});

test("items of a campaign that ended days ago stay out while newer ones exist", () => {
  const keys = pickR6().items.map((i) => i.itemKey);
  assert.ok(!keys.includes(S2), "wave 9's packs leave the accounts in days");
  assert.ok(!keys.includes(FROST), "an item with no known campaign is not 'newest'");
});

test("with no recent campaign at all it falls back to the items the farm holds", () => {
  const holdings = [];
  for (let i = 0; i < 30; i++) holdings.push(holding([item(S2, 6, "R6S S2 2026 9"), item(FROST, 1)]));
  for (let i = 0; i < 10; i++) holdings.push(holding([item(S2, 3, "R6S S2 2026 9")]));
  const p = pickR6(holdings, r6Campaigns());
  assert.ok(p.items, p.reason);
  assert.strictEqual(p.newestOnly, false);
  assert.strictEqual(
    rot.itemsSignature(p.items),
    rot.itemsSignature([{ itemKey: S2, qty: 6 }, { itemKey: FROST, qty: 1 }]),
  );
  assert.strictEqual(p.covering, 30);
});

test("fewer than 10 free accounts is no bundle at all", () => {
  const holdings = [];
  for (let i = 0; i < 9; i++) holdings.push(holding([item(S21, 6, "R6S S2 2026 12")]));
  const p = pickR6(holdings);
  assert.strictEqual(p.items, null);
  assert.match(p.reason, /only 9 free account/);
});

test("another game's drops on the same account never enter the bundle", () => {
  const holdings = [];
  for (let i = 0; i < 20; i++)
    holdings.push(
      holding([
        item(S21, 6, "R6S S2 2026 12"),
        { itemKey: "talon strong spray|overwatch", name: "Talon Strong Spray", game: "Overwatch", campaign: "OWCS", qty: 1 },
      ]),
    );
  const p = pickR6(holdings);
  assert.deepStrictEqual(p.items.map((i) => i.itemKey), [S21]);
});

test("an item fewer than minCover accounts reach is skipped, not shrunk to nothing", () => {
  const holdings = [];
  for (let i = 0; i < 20; i++) holdings.push(holding([item(S21, 6, "R6S S2 2026 12")]));
  for (let i = 0; i < 4; i++) holdings[i].items.push(item(OLC, 2, "R6S Wasteland circuit"));
  const p = pickR6(holdings);
  assert.deepStrictEqual(p.items.map((i) => [i.itemKey, i.qty]), [[S21, 6]]);
  assert.strictEqual(p.covering, 20);
});

/* --------------------------- small pure helpers -------------------------- */

test("itemsSignature is order-free, qty-aware and case-insensitive", () => {
  const a = rot.itemsSignature([{ itemKey: "A|G", qty: 2 }, { itemKey: "b|g", qty: 1 }]);
  const b = rot.itemsSignature([{ itemKey: "b|g" }, { itemKey: "a|g", qty: 2 }]);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, rot.itemsSignature([{ itemKey: "a|g", qty: 3 }, { itemKey: "b|g", qty: 1 }]));
});

test("campaignRecency: a re-issued campaign is active if either copy is, and keeps the latest end", () => {
  const m = r6Campaigns();
  assert.deepStrictEqual(m.get("r6s wasteland circuit"), {
    active: true,
    endAt: Date.parse("2026-10-13T13:59:59Z"),
  });
  assert.strictEqual(m.get("r6s s2 2026 11").active, false);
});

function pausedRow(extra = {}) {
  return {
    _id: "row1",
    marketplace: "eldorado",
    externalId: "c847f2c2-d389-470c-8ee1-08df1973bb44",
    noclaimStock: true,
    status: "active",
    autoPaused: true,
    lastError: rot.PAUSED_ERROR,
    set: "oldset",
    price: 1.81,
    updatedAt: new Date(NOW - 31 * HOUR),
    units: [{ login: "x", deliveredAt: new Date(NOW - 40 * HOUR) }],
    ...extra,
  };
}

test("rowSkipReason: only what the stock sync paused, and not the instant it paused it", () => {
  assert.strictEqual(rot.rowSkipReason(pausedRow(), NOW), "");
  assert.match(rot.rowSkipReason(pausedRow({ autoPaused: false }), NOW), /not paused by the stock sync/);
  assert.match(rot.rowSkipReason(pausedRow({ lastError: "paused: bulk offer held" }), NOW), /another reason/);
  assert.match(rot.rowSkipReason(pausedRow({ status: "delisted" }), NOW), /row is delisted/);
  assert.match(rot.rowSkipReason(pausedRow({ marketplace: "playerauctions" }), NOW), /not an Eldorado/);
  assert.match(rot.rowSkipReason(pausedRow({ updatedAt: new Date(NOW - 10 * 60 * 1000) }), NOW), /under 30 min/);
});

/* ------------------------------- the pass -------------------------------- */

const OLD_SET = {
  _id: "oldset",
  name: "R6 — 9× Esports Pack 26 stage 2 · Eldorado",
  stockSource: "noclaim",
  coverGame: G,
  price: 1.81,
  items: [{ itemKey: S2, name: "Esports Pack 26 stage 2", game: G, qty: 9 }],
};

function matches(doc, q) {
  for (const [k, v] of Object.entries(q || {})) {
    if (v && typeof v === "object" && !(v instanceof Date)) continue; // operators: not needed here
    if (String(doc[k]) !== String(v)) return false;
  }
  return true;
}

function fakeDeps(o = {}) {
  const calls = [];
  const rows = new Map((o.rows || [pausedRow()]).map((r) => [String(r._id), { ...r }]));
  const sets = new Map([[String(OLD_SET._id), OLD_SET], ...(o.sets || []).map((s) => [String(s._id), s])]);
  const offers = new Map();
  for (const r of rows.values()) {
    offers.set(r.externalId, {
      offerState: "Paused",
      offerTitle: "Rainbow Six Siege Twitch Drops (9 Items) — 9× Esports Pack 26 stage 2",
      pricePerUnit: { amount: r.price, currency: "USD" },
      quantity: 12,
      ...((o.offers || {})[r.externalId] || {}),
    });
  }
  let created = 0;
  const stockFor = (set) => {
    if (!set) return { free: 0, covering: 0 };
    if (o.stock) return o.stock(set);
    return String(set._id) === "oldset" ? { free: 0, covering: 0 } : { free: 41, covering: 73 };
  };
  const d = {
    settings: { getAutoFarm: () => o.af || {} },
    MarketplaceListing: {
      find: (q) => ({ lean: async () => [...rows.values()].filter((r) => matches(r, q)) }),
      findById: (id) => ({ lean: async () => ({ ...rows.get(String(id)) }) }),
      updateOne: async (q, u) => {
        calls.push(["row", q, u]);
        const r = rows.get(String(q._id));
        if (!r || !matches(r, q)) return { modifiedCount: 0 };
        Object.assign(r, u.$set);
        return { modifiedCount: 1 };
      },
    },
    DropSet: {
      findById: (id) => ({ lean: async () => sets.get(String(id)) || null }),
      find: () => {
        const q = { sort: () => q, limit: () => q, lean: async () => o.existingSets || [] };
        return q;
      },
      create: async (doc) => {
        const s = { _id: "newset" + ++created, ...doc };
        sets.set(String(s._id), s);
        calls.push(["createSet", s]);
        return s;
      },
      deleteOne: async () => ({}),
    },
    TwitchCampaign: {
      find: () => ({
        lean: async () => [
          { name: "R6S S2 2026 12", status: "ACTIVE", active: true, endAt: new Date("2026-10-03T04:58:59Z") },
          { name: "R6S S2 2026 11", status: "EXPIRED", active: false, endAt: new Date("2026-09-30T04:58:59Z") },
          { name: "R6S S2 2026 9", status: "EXPIRED", active: false, endAt: new Date("2026-09-26T04:58:59Z") },
          { name: "R6S Wasteland circuit", status: "ACTIVE", active: true, endAt: new Date("2026-10-13T13:59:59Z") },
        ],
      }),
    },
    ncs: {
      stockForSet: async (set) => stockFor(set),
      stockForListing: async (row) => stockFor(sets.get(String(row.set))).free,
      requiredDropsForSet: (set) => set.items.map((i) => ({ name: i.name, qty: i.qty })),
    },
    nh: {
      snapshotBase: async () => ({ holdings: o.holdings || r6Holdings() }),
      freeReason: (h) => (h.free === false ? "on auto listing" : ""),
      isFresh: (h) => h.fresh !== false,
    },
    mp: {
      eldoradoOffer: async (ext) => {
        calls.push(["read", ext]);
        return offers.get(ext) ? { ...offers.get(ext) } : null;
      },
      eldoradoUpdateOffer: async (ext, patch) => {
        calls.push(["update", ext, patch]);
        const cur = offers.get(ext);
        cur.offerTitle = o.titleDoesNotTake ? cur.offerTitle : patch.title;
        return { ...cur };
      },
      eldoradoUploadImage: async (p) => {
        calls.push(["upload", p]);
        return { largeImage: "new-cover-Large.png" };
      },
      eldoradoRelist: async (ext) => {
        calls.push(["relist", ext]);
        offers.get(ext).offerState = "Active";
      },
      eldoradoSetQuantity: async (ext, q) => {
        calls.push(["quantity", ext, q]);
        offers.get(ext).quantity = q;
        return q;
      },
      eldoradoPaidOrders: async () => {
        calls.push(["paidOrders"]);
        return o.paid || [];
      },
    },
    text: async (set) => ({
      title: "Rainbow Six Siege Twitch Drops (8 Items) — " + rot.bundleLabel(set.items),
      description: "Includes:\n" + set.items.map((i) => "- " + i.qty + "× " + i.name).join("\n"),
    }),
    buildCover: async () => "/tmp/set-grid-test.png",
    unlink: (p) => calls.push(["unlink", p]),
    logEvent: (f) => calls.push(["event", f.action, f.subject]),
    sendTelegram: async (t) => calls.push(["telegram", t]),
  };
  return { d, calls, rows, offers, sets };
}

const kinds = (calls) => calls.map((c) => c[0]);
const marketWrites = (calls) => calls.filter((c) => ["update", "upload", "relist", "quantity"].includes(c[0]));

test("a stale selling offer is rewritten while paused, then moved, then resumed — in that order", async () => {
  const f = fakeDeps();
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 1, JSON.stringify(out));
  const k = kinds(f.calls);
  const at = (name) => k.indexOf(name);
  assert.ok(at("update") < at("row"), "offer text changes BEFORE the row moves");
  assert.ok(at("row") < at("relist"), "the offer goes back on sale only after the row moved");
  assert.ok(at("relist") < at("quantity"));

  const upd = f.calls.find((c) => c[0] === "update")[2];
  assert.strictEqual(upd.priceUsd, undefined, "the price is never sent");
  assert.strictEqual(upd.quantity, undefined, "quantity is the sync's job");
  assert.deepStrictEqual(upd.mainOfferImage, { largeImage: "new-cover-Large.png" });

  const created = f.calls.find((c) => c[0] === "createSet")[1];
  assert.strictEqual(created.stockSource, "noclaim");
  assert.strictEqual(created.listed, false);
  assert.strictEqual(created.publicCatalog, false);
  assert.strictEqual(created.price, 1.81, "the set carries the offer's price");
  assert.strictEqual(
    rot.itemsSignature(created.items),
    rot.itemsSignature([{ itemKey: S21, qty: 6 }, { itemKey: OLC, qty: 2 }]),
  );

  const row = f.rows.get("row1");
  assert.strictEqual(String(row.set), String(created._id));
  assert.strictEqual(row.autoPaused, false);
  assert.strictEqual(row.lastError, "");
  assert.strictEqual(row.qtyTarget, 41);
  assert.deepStrictEqual(row.requiredDrops, created.items.map((i) => ({ name: i.name, qty: i.qty })));
  assert.match(row.title, /8 Items/);
  assert.strictEqual(f.offers.get(row.externalId).offerState, "Active");
  assert.strictEqual(f.offers.get(row.externalId).quantity, 41);

  assert.ok(k.includes("unlink"), "the temp cover is removed");
  assert.deepStrictEqual(f.calls.find((c) => c[0] === "event").slice(1), ["offer_rotated", "eldorado " + row.externalId]);
  assert.ok(k.includes("telegram"));
  assert.ok(out.log.some((l) => /rotated eldorado c847f2c2/.test(l)));
});

test("contention is not staleness: a free account that still holds the bundle leaves it alone", async () => {
  for (const stock of [{ free: 3, covering: 25 }, { free: 0, stale: 4, covering: 25 }]) {
    const f = fakeDeps({ stock: () => stock });
    const out = await rot.rotationPass({ deps: f.d, now: NOW });
    assert.strictEqual(out.rotated.length, 0);
    assert.strictEqual(out.stale, 0);
    assert.deepStrictEqual(marketWrites(f.calls), []);
    assert.ok(!kinds(f.calls).includes("read"));
  }
});

test("contention is not staleness: every account that could sell is taken, so there is no bundle to move to", async () => {
  const holdings = r6Holdings().map((h) => ({ ...h, free: false }));
  const f = fakeDeps({ holdings, stock: () => ({ free: 0, covering: 25 }) });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 0);
  assert.deepStrictEqual(marketWrites(f.calls), []);
  assert.match(out.skipped[0].why, /only 0 free account/);
});

test("a bundle only sold or reserved accounts still hold is stale: the free farm moved on", async () => {
  // An offer grown to a bigger bundle ends here when the extra drops expire.
  const f = fakeDeps({
    stock: (set) => (String(set._id) === "oldset" ? { free: 0, stale: 0, covering: 25 } : { free: 41, covering: 73 }),
  });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 1, JSON.stringify(out));
  assert.strictEqual(out.stale, 1);
  assert.strictEqual(f.offers.get(f.rows.get("row1").externalId).offerState, "Active");
});

test("an offer with no sale in 7 days stays paused (R6's two offers dead since 09-22)", async () => {
  const f = fakeDeps({ rows: [pausedRow({ units: [{ deliveredAt: new Date(NOW - 9 * DAY) }] })] });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 0);
  assert.deepStrictEqual(marketWrites(f.calls), []);
  assert.match(out.skipped[0].why, /no sale in 7 days/);
  assert.ok(out.log.some((l) => /no sale in 7 days/.test(l)));
});

test("a paid order waiting on the offer blocks the rotation", async () => {
  const f = fakeDeps({ paid: [{ id: "o1", offerId: "c847f2c2-d389-470c-8ee1-08df1973bb44" }] });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 0);
  assert.deepStrictEqual(marketWrites(f.calls), []);
  assert.match(out.skipped[0].why, /paid order/);
  assert.strictEqual(String(f.rows.get("row1").set), "oldset");
});

test("an offer someone resumed on Eldorado is not touched", async () => {
  const f = fakeDeps({ offers: { "c847f2c2-d389-470c-8ee1-08df1973bb44": { offerState: "Active" } } });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 0);
  assert.deepStrictEqual(marketWrites(f.calls), [], "no edit and no cover upload for nobody");
  assert.ok(!kinds(f.calls).includes("createSet"), "no set made for nobody");
  assert.ok(!kinds(f.calls).includes("row"));
  assert.match(out.skipped[0].why, /Active on Eldorado/);
});

test("a title that did not take leaves the row on its old set and the offer paused", async () => {
  const f = fakeDeps({ titleDoesNotTake: true });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 0);
  assert.strictEqual(out.errors.length, 1);
  assert.match(out.errors[0].error, /title did not take/);
  assert.ok(!kinds(f.calls).includes("row"));
  assert.ok(!kinds(f.calls).includes("relist"));
  assert.strictEqual(String(f.rows.get("row1").set), "oldset");
});

test("the kill switch stops everything", async () => {
  const f = fakeDeps({ af: { noclaimRotateOffers: false } });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.match(out.skipped, /switched off/);
  assert.deepStrictEqual(f.calls, []);
});

test("an owner's own pause is never a candidate", async () => {
  const f = fakeDeps({ rows: [pausedRow({ autoPaused: false })] });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 0);
  assert.deepStrictEqual(f.calls, []);
});

test("a price ladder on one set moves together: one new set, one cover upload, every rung keeps its price", async () => {
  const rungs = [
    pausedRow(),
    pausedRow({ _id: "row2", externalId: "16797f1f-ladder-2", price: 2, units: [] }),
    pausedRow({ _id: "row3", externalId: "6f611ee9-ladder-4", price: 4, units: [] }),
  ];
  const f = fakeDeps({ rows: rungs });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 3, JSON.stringify(out));
  assert.strictEqual(f.calls.filter((c) => c[0] === "createSet").length, 1);
  assert.strictEqual(f.calls.filter((c) => c[0] === "upload").length, 1);
  const newSet = String(f.rows.get("row1").set);
  for (const id of ["row1", "row2", "row3"]) assert.strictEqual(String(f.rows.get(id).set), newSet);
  assert.deepStrictEqual(out.rotated.map((x) => x.price), [1.81, 2, 4]);
});

test("an existing set with exactly the new items is reused, not duplicated", async () => {
  const existing = {
    _id: "rotated-before",
    stockSource: "noclaim",
    coverGame: G,
    name: "earlier rotation",
    items: [item(OLC, 2), item(S21, 6)],
  };
  const f = fakeDeps({ existingSets: [existing], sets: [existing] });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 1, JSON.stringify(out));
  assert.ok(!kinds(f.calls).includes("createSet"));
  assert.strictEqual(String(f.rows.get("row1").set), "rotated-before");
  assert.strictEqual(out.rotated[0].newSet, false);
});

test("a skip is logged once, not on every 15-minute pass", async () => {
  const rows = [pausedRow({ units: [{ deliveredAt: new Date(NOW - 9 * DAY) }] })];
  const first = await rot.rotationPass({ deps: fakeDeps({ rows }).d, now: NOW });
  const second = await rot.rotationPass({ deps: fakeDeps({ rows }).d, now: NOW + 15 * 60 * 1000 });
  assert.ok(first.log.length >= 1);
  assert.deepStrictEqual(second.log, []);
});

test("a live no-claim pack on the stale set rotates with it: pack title, quantity in whole packs", async () => {
  const offers = new Map([["b1", { _id: "b1", source: "noclaim", state: "live", open: true, minQty: 5, discountPct: 5 }]]);
  const pack = {
    BulkOffer: {
      findById: (id) => ({ lean: async () => ({ ...offers.get(String(id)) }) }),
      updateOne: async (q, u) => Object.assign(offers.get(String(q._id)), u.$set),
    },
    copy: require("../utils/bulkPacks/copy"),
    packMath: require("../utils/bulkPacks/packMath"),
    lock: { tryWithOfferLock: async (_id, fn) => ({ ran: true, value: await fn() }) },
    buildPackCover: async () => "/tmp/pack-cover-test.png",
  };
  const rows = [
    pausedRow(),
    pausedRow({
      _id: "rowP",
      externalId: "pack-offer-1",
      price: 8.5,
      units: [],
      bulkOfferId: "b1",
      bulkPackSize: 5,
      title: "Rainbow Six Siege Twitch Drops (9 Items) — PACK OF 5 ACCOUNTS (-5%)",
    }),
  ];
  const f = fakeDeps({ rows });
  f.d.pack = pack;
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 2, JSON.stringify(out));
  const p = f.rows.get("rowP");
  assert.strictEqual(String(p.set), String(f.rows.get("row1").set));
  assert.match(p.title, /8 Items.*— PACK OF 5 ACCOUNTS \(-5%\)$/);
  assert.strictEqual(p.price, 8.5);
  assert.strictEqual(p.qtyTarget, 8, "41 free accounts = 8 whole packs of 5");
  assert.strictEqual(f.offers.get("pack-offer-1").quantity, 8);
  assert.strictEqual(f.offers.get("pack-offer-1").offerState, "Active");
  assert.strictEqual(String(offers.get("b1").set), String(p.set));
  assert.ok(!/PACK OF/.test(f.rows.get("row1").title));
});

test("a bulk row that is not a live no-claim pack is never rotated", async () => {
  const f = fakeDeps({ rows: [pausedRow({ bulkOfferId: "b1" })] });
  const out = await rot.rotationPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.rotated.length, 0);
  assert.deepStrictEqual(f.calls, []);
});
