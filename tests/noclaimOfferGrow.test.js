// No-claim Eldorado offer grow (docs/NOCLAIM-OFFER-ROTATION-CONTRACT.md §Grow).
//
// The case it exists for, measured on prod 2026-10-06: four Overwatch offers
// advertised "OWCS Stage 3 Asia Kickoff (6 Items)" while 271 of 367 accounts
// held those 6 plus 5× "100 Comp Points". The 6-item bundle was still in
// stock, so the rotation never looked at it. No Mongo, no network: every
// dependency is injected.
const test = require("node:test");
const assert = require("node:assert");

const grow = require("../utils/noclaimOfferGrow");
const rot = require("../utils/noclaimOfferRotation");

const HOUR = 3600 * 1000;
const NOW = Date.parse("2026-10-06T09:00:00Z");

const G = "Overwatch";
const OWCS = ["Sun Tea Icon", "Refreshing Spray", "Summer Sandcastle Spray", "Protein Drink Icon", "Talon Strong Spray", "Esports Loot Box"];
const key = (name) => name.toLowerCase() + "|overwatch";
const CP = key("100 Comp Points");
const OLD = key("BlizzCon Souvenir");

const item = (name, qty, campaign) => ({
  itemKey: key(name),
  name,
  game: G,
  campaign: campaign || "",
  image: "https://img/" + name.replace(/\W+/g, "-") + ".png",
  qty,
});
const owcsItems = () => OWCS.map((n) => item(n, 1, "OWCS Stage 3 Asia Kickoff"));
const comp = (qty = 5) => item("100 Comp Points", qty, "Reign of Talon S4: Drives");

let seq = 0;
function holding(items, extra = {}) {
  seq++;
  return { loginLower: "acct" + seq, inConfig: true, items, ...extra };
}

// Prod's Overwatch shape on 2026-10-06.
function owHoldings() {
  const out = [];
  for (let i = 0; i < 271; i++) out.push(holding([...owcsItems(), comp()]));
  for (let i = 0; i < 3; i++) out.push(holding([...owcsItems()])); // joined after the Comp Points campaign
  for (let i = 0; i < 20; i++) out.push(holding([item("Esports Loot Box", 1, "OWCS Stage 3 Asia Kickoff"), comp()]));
  for (let i = 0; i < 72; i++) out.push(holding([comp()])); // no OWCS yet: not this offer's stock
  // Sold, on another listing, or read too long ago: never counted.
  for (let i = 0; i < 30; i++) out.push(holding([...owcsItems(), comp()], { free: false }));
  for (let i = 0; i < 5; i++) out.push(holding([...owcsItems(), comp()], { fresh: false }));
  return out;
}

const CAMPAIGNS = [
  { name: "OWCS Stage 3 Asia Kickoff", status: "ACTIVE", active: true, endAt: new Date("2026-10-10T07:59:00Z") },
  { name: "Reign of Talon S4: Drives", status: "EXPIRED", active: false, endAt: new Date("2026-10-06T06:58:00Z") },
  { name: "BlizzCon 2026", status: "EXPIRED", active: false, endAt: new Date("2026-09-20T00:00:00Z") },
];
const owCampaigns = () => rot.campaignRecency(CAMPAIGNS, NOW);

const pick = (current = owcsItems(), holdings = owHoldings(), campaigns = owCampaigns()) =>
  grow.pickGrowBundle({
    holdings,
    isFree: (h) => h.free !== false,
    isFresh: (h) => h.fresh !== false,
    game: G,
    campaigns,
    current,
    now: NOW,
  });

/* ------------------------------- the picker ------------------------------ */

test("the 6-item Overwatch offer grows to the 11 the accounts hold — prod's 2026-10-06 case", () => {
  const p = pick();
  assert.ok(p.items, p.reason);
  assert.strictEqual(p.pool, 366, "every free + fresh account holding Overwatch drops");
  assert.strictEqual(p.current, 274, "the ones that hold the current 6: the offer's stock");
  assert.strictEqual(p.minCover, 220, "four in five of the offer's own accounts");
  assert.strictEqual(p.covering, 271);
  assert.deepStrictEqual(p.added, [{ itemKey: CP, name: "100 Comp Points", from: 0, to: 5 }]);
  assert.strictEqual(p.items.reduce((n, i) => n + i.qty, 0), 11);
  assert.deepStrictEqual(
    p.items.slice(0, 6).map((i) => i.name),
    OWCS,
    "the old items stay, in their order",
  );
  for (const it of p.items) assert.ok(it.name && it.game === G && it.image && it.itemKey);
  assert.strictEqual(grow.addedLabel(p.added), "5× 100 Comp Points");
});

test("the grown bundle always contains the current one", () => {
  const p = pick();
  const now = new Map(p.items.map((i) => [i.itemKey, i.qty]));
  for (const it of owcsItems()) assert.ok(now.get(it.itemKey) >= 1);
});

test("nothing more on the accounts is no bundle", () => {
  const p = pick([...owcsItems(), comp()]);
  assert.strictEqual(p.items, null);
  assert.match(p.reason, /nothing more/);
});

test("an extra item fewer than four in five of the offer's accounts hold is not added", () => {
  const holdings = [];
  for (let i = 0; i < 30; i++) holdings.push(holding([...owcsItems()]));
  for (let i = 0; i < 23; i++) holdings[i].items.push(comp());
  assert.strictEqual(pick(owcsItems(), holdings).items, null);
  holdings[23].items.push(comp());
  const p = pick(owcsItems(), holdings);
  assert.ok(p.items, "24 of 30 is four in five");
  assert.strictEqual(p.covering, 24);
});

test("accounts that do not hold the offer's bundle never block it — prod's 2026-10-07 case", () => {
  // ~270 accounts held 6 OWCS + 5 Comp Points + the new season's 6 drops (17);
  // ~490 new accounts held the new season's drops only. Under the old bar (half
  // of the whole free farm) the offers stayed at "12 Items".
  const s5 = (n) => ["Heroes of Heart Avatar", "Heroes of Heart Spray", "Hollow Hearts Avatar", "Hollow Hearts Spray", "RoT Lootbox", "RoT Epic Lootbox"].slice(0, n).map((x) => item(x, 1, "Reign of Talon S5 Launch"));
  const live = rot.campaignRecency([...CAMPAIGNS, { name: "Reign of Talon S5 Launch", status: "ACTIVE", active: true, endAt: new Date(NOW + 20 * 24 * HOUR) }], NOW);
  const holdings = [];
  for (let i = 0; i < 250; i++) holdings.push(holding([...owcsItems(), comp(), ...s5(6)]));
  for (let i = 0; i < 20; i++) holdings.push(holding([...owcsItems(), comp(), ...s5(5)]));
  for (let i = 0; i < 490; i++) holdings.push(holding([...s5(6)]));
  const current = [...owcsItems(), comp(), ...s5(1)];
  const p = pick(current, holdings, live);
  assert.ok(p.items, p.reason);
  assert.strictEqual(p.pool, 760);
  assert.strictEqual(p.current, 270);
  assert.strictEqual(p.items.reduce((n, i) => n + i.qty, 0), 17);
  assert.strictEqual(p.covering, 250, "the 20 one drop short wait; nobody else was ever this offer's stock");
});

test("a step keeps at least four fifths of the stock, so it cannot halve pass after pass", () => {
  const live = rot.campaignRecency([{ name: "Reign of Talon S4: Drives", status: "ACTIVE", active: true, endAt: new Date(NOW + 48 * HOUR) }], NOW);
  const holdings = [];
  for (let i = 0; i < 50; i++) holdings.push(holding([comp(12)]));
  for (let i = 0; i < 40; i++) holdings.push(holding([comp(6)]));
  assert.strictEqual(pick([comp(6)], holdings, live).items, null, "12 is held by 50 of 90: not four in five, so it stays");
  for (let i = 0; i < 25; i++) holdings[50 + i].items = [comp(9)];
  const p = pick([comp(6)], holdings, live);
  assert.deepStrictEqual(p.items.map((i) => i.qty), [9], "75 of 90 hold 9 or more");
  assert.strictEqual(p.covering, 75);
  assert.strictEqual(pick(p.items, holdings, live).items, null, "12 is held by 50 of those 75");
});

test("more copies of an item the offer already sells raise its count", () => {
  const holdings = [];
  for (let i = 0; i < 30; i++) holdings.push(holding([comp(9)]));
  for (let i = 0; i < 6; i++) holdings.push(holding([comp(6)]));
  const live = rot.campaignRecency([{ name: "Reign of Talon S4: Drives", status: "ACTIVE", active: true, endAt: new Date(NOW + 48 * HOUR) }], NOW);
  const p = pick([comp(6)], holdings, live);
  assert.ok(p.items, p.reason);
  assert.deepStrictEqual(p.items.map((i) => [i.itemKey, i.qty]), [[CP, 9]]);
  assert.deepStrictEqual(p.added, [{ itemKey: CP, name: "100 Comp Points", from: 6, to: 9 }]);
  assert.strictEqual(grow.addedLabel(p.added), "9× 100 Comp Points (was 6×)");
});

test("items of a campaign that ended long ago stay out while newer ones exist", () => {
  const holdings = [];
  for (let i = 0; i < 20; i++) holdings.push(holding([...owcsItems(), comp(), item("BlizzCon Souvenir", 1, "BlizzCon 2026")]));
  const p = pick(owcsItems(), holdings);
  assert.ok(p.items, p.reason);
  assert.ok(!p.items.some((i) => i.itemKey === OLD), "it is about to leave the accounts");
  assert.ok(p.items.some((i) => i.itemKey === CP));
});

test("fewer than 10 free accounts behind the offer is no bundle", () => {
  const holdings = [];
  for (let i = 0; i < 9; i++) holdings.push(holding([...owcsItems(), comp()]));
  const p = pick(owcsItems(), holdings);
  assert.strictEqual(p.items, null);
  assert.match(p.reason, /only 9 free account/);
});

test("another game's drops on the same account never enter the bundle", () => {
  const holdings = [];
  for (let i = 0; i < 20; i++)
    holdings.push(holding([...owcsItems(), { itemKey: "esports pack|rainbow six siege", name: "Esports Pack", game: "Rainbow Six Siege", campaign: "OWCS Stage 3 Asia Kickoff", qty: 3 }]));
  assert.strictEqual(pick(owcsItems(), holdings).items, null);
});

test("rowSkipReason: only offers that are on sale", () => {
  const row = { marketplace: "eldorado", noclaimStock: true, status: "active", autoPaused: false, set: "s" };
  assert.strictEqual(grow.rowSkipReason(row), "");
  assert.match(grow.rowSkipReason({ ...row, autoPaused: true }), /paused by the stock sync/);
  assert.match(grow.rowSkipReason({ ...row, status: "delisted" }), /row is delisted/);
  assert.match(grow.rowSkipReason({ ...row, marketplace: "g2g" }), /not an Eldorado/);
  assert.match(grow.rowSkipReason({ ...row, noclaimStock: false }), /not a no-claim/);
});

/* ------------------------------- the pass -------------------------------- */

const OLD_SET = {
  _id: "oldset",
  name: "OWCS Stage 3 Asia Kickoff — COMPLETE (6 items) · Eldorado",
  stockSource: "noclaim",
  coverGame: G,
  price: 1,
  items: owcsItems().map((i) => ({ itemKey: i.itemKey, name: i.name, game: i.game, image: i.image, qty: i.qty })),
};

function liveRow(extra = {}) {
  return {
    _id: "row1",
    marketplace: "eldorado",
    externalId: "9cec2c78-main",
    noclaimStock: true,
    status: "active",
    autoPaused: false,
    set: "oldset",
    price: 1,
    title: "Overwatch Twitch Drops — OWCS Stage 3 Asia Kickoff COMPLETE BUNDLE (6 Items)",
    note: "no-claim auto-delivery: an account is claimed when an order lands (80 advertised)",
    rebundledAt: null,
    ...extra,
  };
}

function matches(doc, q) {
  for (const [k, v] of Object.entries(q || {})) {
    if (v && typeof v === "object" && !(v instanceof Date)) continue; // operators: not needed here
    if (String(doc[k]) !== String(v)) return false;
  }
  return true;
}

function fakeDeps(o = {}) {
  const calls = [];
  const rows = new Map((o.rows || [liveRow()]).map((r) => [String(r._id), { ...r }]));
  const sets = new Map([[String(OLD_SET._id), OLD_SET], ...(o.sets || []).map((s) => [String(s._id), s])]);
  const offers = new Map();
  for (const r of rows.values()) {
    offers.set(r.externalId, {
      offerState: "Active",
      offerTitle: r.title,
      pricePerUnit: { amount: r.price, currency: "USD" },
      quantity: 20,
      ...((o.offers || {})[r.externalId] || {}),
    });
  }
  let created = 0;
  const flaky = { title: o.titleDoesNotTake === true };
  const d = {
    settings: { getAutoFarm: () => o.af || {} },
    MarketplaceListing: {
      find: (q) => ({ lean: async () => [...rows.values()].filter((r) => matches(r, q)).map((r) => ({ ...r })) }),
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
    TwitchCampaign: { find: () => ({ lean: async () => CAMPAIGNS }) },
    ncs: {
      stockForSet: async (set) => {
        calls.push(["stockForSet", set]);
        return o.stock ? o.stock(set) : { free: 268, covering: 271 };
      },
      stockForListing: async (row) => {
        const sharers = [...rows.values()].filter((r) => String(r.set) === String(row.set)).length;
        return Math.floor(80 / sharers);
      },
      requiredDropsForSet: (set) => set.items.map((i) => ({ name: i.name, qty: i.qty })),
    },
    nh: {
      snapshotBase: async () => ({ holdings: o.holdings || owHoldings() }),
      freeReason: (h) => (h.free === false ? "on auto listing" : ""),
      isFresh: (h) => h.fresh !== false,
    },
    mp: {
      eldoradoOffer: async (ext) => {
        calls.push(["read", ext]);
        if (o.unreadable) throw new Error("HTTP 502");
        return offers.get(ext) ? { ...offers.get(ext) } : null;
      },
      eldoradoUpdateOffer: async (ext, patch) => {
        calls.push(["update", ext, patch]);
        const cur = offers.get(ext);
        if (!flaky.title) cur.offerTitle = patch.title.slice(0, 160);
        return { ...cur };
      },
      eldoradoUploadImage: async (p) => {
        calls.push(["upload", p]);
        return { largeImage: "new-cover-Large.png" };
      },
      eldoradoRelist: async (ext) => calls.push(["relist", ext]),
      eldoradoDelist: async (ext) => calls.push(["delist", ext]),
      eldoradoSetQuantity: async (ext, q) => {
        calls.push(["quantity", ext, q]);
        offers.get(ext).quantity = q;
        return q;
      },
      eldoradoPaidOrders: async () => {
        calls.push(["paidOrders"]);
        return [];
      },
    },
    text: async (set) => ({
      title: "Overwatch Twitch Drops — COMPLETE BUNDLE (" + set.items.reduce((n, i) => n + (i.qty || 1), 0) + " Items)",
      description: "Includes:\n" + set.items.map((i) => "- " + i.qty + "× " + i.name).join("\n"),
    }),
    buildCover: async () => "/tmp/set-grid-test.png",
    unlink: (p) => calls.push(["unlink", p]),
    logEvent: (f) => calls.push(["event", f.action, f.subject]),
    sendTelegram: async (t) => calls.push(["telegram", t]),
  };
  return { d, calls, rows, offers, sets, flaky };
}

const kinds = (calls) => calls.map((c) => c[0]);
const marketWrites = (calls) => calls.filter((c) => ["update", "upload", "relist", "delist", "quantity"].includes(c[0]));

test("a selling offer moves to the bigger set first, then its text follows — and it is never paused", async () => {
  const f = fakeDeps();
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 1, JSON.stringify(out));
  const k = kinds(f.calls);
  assert.ok(k.indexOf("row") < k.indexOf("update"), "the row moves BEFORE the offer text changes");
  assert.ok(k.indexOf("update") < k.indexOf("quantity"));
  assert.ok(!k.includes("delist") && !k.includes("relist"), "the offer stays on sale throughout");
  assert.ok(!k.includes("paidOrders"), "a waiting buyer only ever gets more");

  const upd = f.calls.find((c) => c[0] === "update")[2];
  assert.strictEqual(upd.priceUsd, undefined, "the price is never sent");
  assert.strictEqual(upd.quantity, undefined);
  assert.deepStrictEqual(upd.mainOfferImage, { largeImage: "new-cover-Large.png" });
  assert.match(upd.title, /11 Items/);

  const created = f.calls.find((c) => c[0] === "createSet")[1];
  assert.strictEqual(created.stockSource, "noclaim");
  assert.strictEqual(created.listed, false);
  assert.strictEqual(created.publicCatalog, false);
  assert.strictEqual(created.price, 1, "the set carries the offer's price");
  assert.match(created.name, /auto-grown/);
  assert.match(created.note, /now also hold 5× 100 Comp Points/);
  assert.strictEqual(created.items.reduce((n, i) => n + i.qty, 0), 11);

  const row = f.rows.get("row1");
  assert.strictEqual(String(row.set), String(created._id));
  assert.strictEqual(row.autoPaused, false);
  assert.strictEqual(row.price, 1);
  assert.strictEqual(row.qtyTarget, 80);
  assert.deepStrictEqual(row.requiredDrops, created.items.map((i) => ({ name: i.name, qty: i.qty })));
  assert.match(row.title, /11 Items/);
  assert.ok(!grow.textPending(row), "the marker is gone once the text landed");
  assert.match(row.note, /grown 2026-10-06 09:00Z from set oldset to newset1/);
  assert.strictEqual(new Date(row.rebundledAt).getTime(), NOW);
  assert.strictEqual(f.offers.get(row.externalId).offerState, "Active");
  assert.strictEqual(f.offers.get(row.externalId).quantity, 80);

  assert.ok(k.includes("unlink"), "the temp cover is removed");
  assert.deepStrictEqual(f.calls.find((c) => c[0] === "event").slice(1), ["offer_grown", "eldorado " + row.externalId]);
  assert.match(f.calls.find((c) => c[0] === "telegram")[1], /added: 5× 100 Comp Points/);
  assert.ok(out.log.some((l) => /grew eldorado 9cec2c78-main/.test(l)));
});

test("a price ladder on one set moves together: one new set, one cover, every rung keeps its price", async () => {
  const rungs = [
    liveRow(),
    liveRow({ _id: "row2", externalId: "16797f1f-2usd", price: 2, title: "All 6 Items | Instant Auto-Delivery" }),
    liveRow({ _id: "row3", externalId: "6f611ee9-4usd", price: 4, title: "Full Set, 6 Unclaimed Items" }),
    liveRow({ _id: "row4", externalId: "d15783f2-5usd", price: 5, title: "COMPLETE (6 Items) | Auto Delivery" }),
  ];
  const f = fakeDeps({ rows: rungs });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 4, JSON.stringify(out));
  assert.strictEqual(f.calls.filter((c) => c[0] === "createSet").length, 1);
  assert.strictEqual(f.calls.filter((c) => c[0] === "upload").length, 1);
  const k = kinds(f.calls);
  assert.ok(k.lastIndexOf("row", k.indexOf("update")) >= 3, "all four rows moved before the first text edit");
  const newSet = String(f.rows.get("row1").set);
  for (const id of ["row1", "row2", "row3", "row4"]) {
    assert.strictEqual(String(f.rows.get(id).set), newSet);
    assert.match(f.rows.get(id).title, /11 Items/);
  }
  assert.deepStrictEqual(out.grown.map((x) => x.price), [1, 2, 4, 5]);
  assert.deepStrictEqual(out.grown.map((x) => x.stock), [20, 20, 20, 20], "the 80 cap is split across the four");
});

test("a title that did not take leaves the row on the bigger set, marked, and the next pass finishes it", async () => {
  const f = fakeDeps({ titleDoesNotTake: true });
  const first = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(first.grown.length, 0);
  assert.match(first.errors[0].error, /title did not take/);
  const row = f.rows.get("row1");
  assert.strictEqual(String(row.set), "newset1", "delivery already hands out the bigger bundle");
  assert.ok(grow.textPending(row));
  assert.match(row.title, /6 Items/, "the row still says what Eldorado still says");

  f.flaky.title = false;
  f.calls.length = 0;
  const second = await grow.growPass({ deps: f.d, now: NOW + 15 * 60 * 1000 });
  assert.strictEqual(second.repaired.length, 1, JSON.stringify(second));
  assert.ok(!kinds(f.calls).includes("createSet"), "no second set");
  assert.ok(!grow.textPending(f.rows.get("row1")));
  assert.match(f.rows.get("row1").title, /11 Items/);
  assert.match(f.offers.get(row.externalId).offerTitle, /11 Items/);
  assert.ok(second.log.some((l) => /text caught up/.test(l)));
});

test("the kill switch stops everything", async () => {
  const f = fakeDeps({ af: { noclaimGrowOffers: false } });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.match(out.skipped, /switched off/);
  assert.deepStrictEqual(f.calls, []);
});

test("an offer the stock sync paused, and a bulk row with no pack size, are not this pass's", async () => {
  const f = fakeDeps({
    rows: [liveRow({ autoPaused: true }), liveRow({ _id: "row2", externalId: "d645cdf0-pack", bulkOfferId: "b1" })],
  });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 0);
  assert.deepStrictEqual(f.calls, []);
});

/* ------------------------------ pack rows ------------------------------- */

function packDeps(o = {}) {
  const offers = new Map([["b1", { _id: "b1", source: "noclaim", state: "live", open: true, minQty: 5, discountPct: 5, market: "eldorado", ...(o.offer || {}) }]]);
  const calls = [];
  return {
    calls,
    offers,
    pack: {
      BulkOffer: {
        findById: (id) => ({ lean: async () => (offers.get(String(id)) ? { ...offers.get(String(id)) } : null) }),
        updateOne: async (q, u) => {
          calls.push(["bulkOffer", q, u]);
          Object.assign(offers.get(String(q._id)), u.$set);
          return { modifiedCount: 1 };
        },
      },
      copy: require("../utils/bulkPacks/copy"),
      packMath: require("../utils/bulkPacks/packMath"),
      lock: o.busy
        ? { tryWithOfferLock: async () => ({ ran: false }) }
        : { tryWithOfferLock: async (_id, fn) => ({ ran: true, value: await fn() }) },
      buildPackCover: async (_set, opts) => {
        calls.push(["packCover", opts]);
        return "/tmp/pack-cover-test.png";
      },
    },
  };
}
const packRow = (extra = {}) =>
  liveRow({
    _id: "rowP",
    externalId: "d645cdf0-pack",
    price: 4.75,
    bulkOfferId: "b1",
    bulkPackSize: 5,
    title: "Overwatch Twitch Drops — OWCS Stage 3 Asia Kickoff COMPLETE BUNDLE (6 Items) — PACK OF 5 ACCOUNTS (-5%)",
    ...extra,
  });

test("a live no-claim pack moves with its set: pack title, pack cover, quantity in packs", async () => {
  const f = fakeDeps({ rows: [liveRow(), packRow()] });
  const p = packDeps();
  f.d.pack = p.pack;
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 2, JSON.stringify(out));
  const row = f.rows.get("rowP");
  assert.strictEqual(String(row.set), "newset1", "the pack sells the same bigger set");
  assert.match(row.title, /\(11 Items\) — PACK OF 5 ACCOUNTS \(-5%\)$/);
  assert.match(row.description, /PACK OF 5 ACCOUNTS — each purchase is a pack of 5/);
  assert.match(row.description, /5× 100 Comp Points/);
  assert.strictEqual(row.price, 4.75);
  assert.deepStrictEqual(p.calls.find((c) => c[0] === "packCover")[1], { packSize: 5, discountPct: 5, showTotal: true });
  assert.strictEqual(f.calls.filter((c) => c[0] === "upload").length, 2, "the set cover and the pack cover");
  // 80 advertised is split across the two rows: 40 accounts each = 8 packs of 5.
  assert.strictEqual(f.offers.get("d645cdf0-pack").quantity, 8);
  assert.strictEqual(row.qtyTarget, 8);
  assert.strictEqual(f.offers.get("9cec2c78-main").quantity, 40);
  const offer = p.offers.get("b1");
  assert.strictEqual(String(offer.set), "newset1");
  assert.strictEqual(offer.title, row.title);
  assert.ok(!/PACK OF/.test(f.rows.get("row1").title), "the single offer keeps the plain title");
});

test("a pack left behind joins the set its single offers already moved to", async () => {
  // Prod on 2026-10-06: the four single offers grew at 08:53Z, the pack stayed on the old set.
  const big = { _id: "bigset", stockSource: "noclaim", coverGame: G, price: 1, name: "grown", items: [...owcsItems(), comp()] };
  const f = fakeDeps({
    sets: [big],
    existingSets: [big],
    rows: [liveRow({ set: "bigset", rebundledAt: new Date(NOW - HOUR) }), packRow()],
  });
  const p = packDeps();
  f.d.pack = p.pack;
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 1, JSON.stringify(out));
  assert.strictEqual(out.grown[0].externalId, "d645cdf0-pack");
  assert.strictEqual(String(f.rows.get("rowP").set), "bigset", "the existing set is reused, not copied");
  assert.ok(!kinds(f.calls).includes("createSet"));
  assert.match(f.rows.get("rowP").title, /11 Items.*PACK OF 5 ACCOUNTS/);
});

test("a pack that is not a live no-claim pack is left exactly as it is", async () => {
  for (const offer of [{ state: "paused" }, { source: "dropset" }, { open: false }]) {
    const f = fakeDeps({ rows: [packRow()] });
    f.d.pack = packDeps({ offer }).pack;
    const out = await grow.growPass({ deps: f.d, now: NOW });
    assert.strictEqual(out.grown.length, 0);
    assert.deepStrictEqual(f.calls, [], JSON.stringify(offer));
  }
  // A title and pack size that disagree is the bulk system's to refuse.
  const f = fakeDeps({ rows: [packRow({ bulkPackSize: 10 })] });
  f.d.pack = packDeps().pack;
  await grow.growPass({ deps: f.d, now: NOW });
  assert.deepStrictEqual(f.calls, []);
});

test("a busy bulk offer leaves the pack's text for the next pass, on the bigger set", async () => {
  const f = fakeDeps({ rows: [liveRow(), packRow()] });
  f.d.pack = packDeps({ busy: true }).pack;
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 1);
  assert.strictEqual(String(f.rows.get("rowP").set), "newset1");
  assert.ok(grow.textPending(f.rows.get("rowP")));
  assert.match(f.rows.get("rowP").title, /6 Items/);
});

test("a set that grew less than 6 hours ago is left alone", async () => {
  const f = fakeDeps({ rows: [liveRow({ rebundledAt: new Date(NOW - 2 * HOUR) })] });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 0);
  assert.deepStrictEqual(marketWrites(f.calls), []);
  const later = fakeDeps({ rows: [liveRow({ rebundledAt: new Date(NOW - 7 * HOUR) })] });
  assert.strictEqual((await grow.growPass({ deps: later.d, now: NOW })).grown.length, 1);
});

test("a set never grows into the bundle another live offer already sells", async () => {
  const big = { _id: "bigset", stockSource: "noclaim", coverGame: G, price: 3, items: [...owcsItems(), comp()] };
  const f = fakeDeps({
    sets: [big],
    rows: [liveRow(), liveRow({ _id: "row9", externalId: "big-offer", set: "bigset", price: 3 })],
  });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 0);
  assert.deepStrictEqual(marketWrites(f.calls), []);
  assert.strictEqual(String(f.rows.get("row1").set), "oldset");
  assert.match(out.skipped[0].why, /another offer already sells/);
});

test("the stock counter has the last word on the bigger bundle", async () => {
  const f = fakeDeps({ stock: () => ({ free: 4, covering: 4 }) });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 0);
  assert.deepStrictEqual(marketWrites(f.calls), []);
  assert.ok(!kinds(f.calls).includes("row"));
  assert.match(out.skipped[0].why, /only 4 free account/);
});

test("Eldorado not answering moves nothing", async () => {
  const f = fakeDeps({ unreadable: true });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 0);
  assert.ok(!kinds(f.calls).includes("row"));
  assert.ok(!kinds(f.calls).includes("createSet"));
  assert.strictEqual(String(f.rows.get("row1").set), "oldset");
});

test("an offer the owner paused gets the new text but is not resumed", async () => {
  const f = fakeDeps({ offers: { "9cec2c78-main": { offerState: "Paused" } } });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 1, JSON.stringify(out));
  const k = kinds(f.calls);
  assert.ok(k.includes("update"));
  assert.ok(!k.includes("relist") && !k.includes("quantity"));
});

test("an edit that knocks the offer off sale is undone, and never repeated", async () => {
  const f = fakeDeps();
  const realUpdate = f.d.mp.eldoradoUpdateOffer;
  f.d.mp.eldoradoUpdateOffer = async (ext, patch) => ({ ...(await realUpdate(ext, patch)), offerState: "Paused" });
  const out = await grow.growPass({ deps: f.d, now: NOW });
  assert.strictEqual(out.grown.length, 1, JSON.stringify(out));
  assert.ok(kinds(f.calls).includes("relist"));
  assert.ok(!grow.textPending(f.rows.get("row1")), "the text landed, so the next pass has nothing to redo");
});

test("a dry run reads no offer, writes nothing and says what it would do", async () => {
  const f = fakeDeps({ rows: [liveRow(), liveRow({ _id: "row2", externalId: "16797f1f-2usd", price: 2 })] });
  const out = await grow.growPass({ deps: f.d, now: NOW, dryRun: true });
  assert.deepStrictEqual(f.calls.filter((c) => c[0] !== "stockForSet"), []);
  assert.strictEqual(out.plan.length, 1);
  const p = out.plan[0];
  assert.strictEqual(p.game, G);
  assert.strictEqual(p.items, 11);
  assert.strictEqual(p.added, "5× 100 Comp Points");
  assert.match(p.to, /11 Items/);
  assert.deepStrictEqual(p.offers.map((x) => x.price), [1, 2]);
  assert.strictEqual(String(f.rows.get("row1").set), "oldset");
});

test("nothing more to sell is silent, pass after pass", async () => {
  const holdings = [];
  for (let i = 0; i < 40; i++) holdings.push(holding([...owcsItems()]));
  const out = await grow.growPass({ deps: fakeDeps({ holdings }).d, now: NOW });
  assert.deepStrictEqual(out.grown, []);
  assert.deepStrictEqual(out.skipped, []);
  assert.deepStrictEqual(out.log, []);
});
