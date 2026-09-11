// Two defects in utils/suppliedStock.js (docs/ACCOUNT-LISTINGS-FIXES-3.md).
//
// S4 ONE SHELF ADVERTISED IN FULL ON EVERY MARKET IT IS PUBLISHED TO. Every
//    claim-at-sale stock counter reported the whole free shelf and pushed that
//    number onto its own live offer, so a 50-account offer published to
//    Eldorado, PlayerAuctions, G2G and Z2U told the world 200 were for sale.
//    The first 50 sales were honoured; every sale after that found an empty
//    shelf with the buyer already paid. stockFor now returns THIS listing's
//    share, so no counter can forget to divide.
// S7 THE PANEL COULD NOT SEE WHAT WOULD ACTUALLY BE CLAIMED. offerStats groups
//    by status, so `available` counts conflict:"in-archive" rows the claim
//    layer refuses, and `conflicts` is summed over EVERY status including
//    "removed". The browser's `available − conflicts` fallback therefore
//    under-counts the moment the owner removes a conflicted row — the obvious
//    response to the "Also in the Drop Archive" warning — and a fully stocked
//    offer reads as empty forever.
//
// Real Mongo via mongodb-memory-server for anything that counts rows: the
// division is only honest if it sees the same listings the marketplace syncs
// see, and a stubbed model would only ever prove the stub. The rounding rule
// itself is pure and tested as such.
process.env.CRED_SECRET ||= "supplied-shelf-share-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const supplied = require("../utils/suppliedStock");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("suppliedshelfshare"));
  await SuppliedAccount.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// lowStockWarnAt 0 keeps Telegram out of the claim path entirely.
const deps = {
  settings: {
    getAccountListingSettings: () => ({
      enabled: true,
      autoDeliver: true,
      lowStockWarnAt: 0,
    }),
  },
  telegram: {
    sendTelegram: async () => {
      throw new Error("a test must never reach a live Telegram bot");
    },
  },
  systemLog: { logEvent: () => {} },
};

let seq = 0;

async function offerOf() {
  seq += 1;
  return AccountOffer.create({
    title: "Shared shelf " + seq,
    game: "Overwatch 2",
    status: "active",
  });
}

// A shelf pasted through the REAL ingest, so the tests measure what addAccounts
// actually writes rather than a hand-built row.
async function paste(offer, n) {
  const lines = [];
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    lines.push("shelfacct" + seq + ":pw-" + seq);
  }
  const res = await supplied.addAccounts(offer._id, lines.join("\n"), { deps });
  assert.equal(res.added, n, "the paste must land in full");
  return res;
}

async function listingOn(offer, marketplace, over = {}) {
  return MarketplaceListing.create({
    accountOffer: offer._id,
    marketplace,
    externalId: "ext-" + marketplace + "-" + (seq += 1),
    origin: "manual",
    status: "active",
    ...over,
  });
}

/* ---------------- S4: the shelf is divided, exactly once ----------------- */

test("S4: four markets on one shelf advertise the shelf, not four shelves", async () => {
  const offer = await offerOf();
  await paste(offer, 8);
  const rows = [
    await listingOn(offer, "eldorado"),
    await listingOn(offer, "playerauctions"),
    await listingOn(offer, "g2g"),
    await listingOn(offer, "z2u"),
  ];

  const shares = [];
  for (const row of rows) shares.push(await supplied.stockFor(row, { deps }));
  assert.deepEqual(shares, [2, 2, 2, 2]);

  // The money assertion: the world is never shown more than we hold.
  assert.equal(
    shares.reduce((a, b) => a + b, 0),
    8,
    "the shares must sum to the shelf, never past it",
  );
  // ...and the shelf itself is still readable, undivided, for the panel.
  assert.equal(await supplied.shelfFor(offer._id, { deps }), 8);
});

test("S4: the remainder is handed out, so a short shelf is not floored to 0", async () => {
  const offer = await offerOf();
  await paste(offer, 3);
  const rows = [
    await listingOn(offer, "eldorado"),
    await listingOn(offer, "g2g"),
    await listingOn(offer, "z2u"),
    await listingOn(offer, "ggsel"),
  ];

  const shares = [];
  for (const row of rows) shares.push(await supplied.stockFor(row, { deps }));
  // Plain flooring would give 0 to all four and take a stocked offer off sale
  // on every market at once (0 pauses Eldorado, hides PA, delists G2G).
  assert.equal(
    shares.reduce((a, b) => a + b, 0),
    3,
  );
  assert.equal(shares.filter((n) => n > 0).length, 3);
  assert.equal(Math.max(...shares), 1);
});

test("S4: only ACTIVE listings take a share, and a lone listing takes it all", async () => {
  const offer = await offerOf();
  await paste(offer, 5);
  const live = await listingOn(offer, "eldorado");
  await listingOn(offer, "g2g", { status: "delisted" });
  await listingOn(offer, "z2u", { status: "sold" });

  assert.equal(
    await supplied.stockFor(live, { deps }),
    5,
    "a delisted row is not selling, so it must not hold stock back",
  );
});

// A ZeusX account-listing offer holds the one account it was published with and
// never claims again (automatic delivery, no relist), and an EpicNPC post is a
// hand-delivered thread with nothing claimed at all. Taking a share each, ten
// single-account ZeusX offers would cut an Eldorado offer to a sliver of the
// accounts actually left on the shelf.
test("S4: ZeusX and EpicNPC rows never draw on the shelf, so take no share", async () => {
  const offer = await offerOf();
  await paste(offer, 6);
  const eld = await listingOn(offer, "eldorado");
  const g2g = await listingOn(offer, "g2g");
  for (let i = 0; i < 4; i += 1) await listingOn(offer, "zeusx");
  await listingOn(offer, "epicnpc");

  const shares = [
    await supplied.stockFor(eld, { deps }),
    await supplied.stockFor(g2g, { deps }),
  ];
  assert.deepEqual(shares, [3, 3], "the two claiming markets split the shelf");
  assert.equal(shares[0] + shares[1], 6, "and never past it");
});

test("S4: another offer's listings never divide this shelf", async () => {
  const mine = await offerOf();
  const theirs = await offerOf();
  await paste(mine, 4);
  await paste(theirs, 4);
  const row = await listingOn(mine, "eldorado");
  await listingOn(theirs, "g2g");
  await listingOn(theirs, "z2u");

  assert.equal(await supplied.stockFor(row, { deps }), 4);
});

test("S4: a bare offer id still reads the whole shelf", async () => {
  const offer = await offerOf();
  await paste(offer, 6);
  await listingOn(offer, "eldorado");
  await listingOn(offer, "g2g");

  // warnLowStock and the panel ask about the SHELF running out, not about one
  // market's slice of it, and both hand this function an offer id.
  assert.equal(await supplied.stockFor(offer._id, { deps }), 6);
  assert.equal(await supplied.shelfFor(offer._id, { deps }), 6);
});

test("S4: the split holds after a sale, and claiming is still first-come", async () => {
  const offer = await offerOf();
  await paste(offer, 4);
  const a = await listingOn(offer, "eldorado");
  const b = await listingOn(offer, "g2g");
  assert.equal(await supplied.stockFor(a, { deps }), 2);

  // One market selling BOTH of its share plus one of the other's is correct
  // behaviour: the shelf is first-come-first-served at claim time, so a paid
  // order is never refused beside stock we are holding. Only what is
  // ADVERTISED is divided.
  const claimed = await supplied.claimForListing(a, 3, {
    orderId: "ord-share-1",
    market: "eldorado",
    deps,
  });
  assert.equal(claimed.length, 3, "claimForListing must not be rationed");
  assert.equal(await supplied.shelfFor(offer._id, { deps }), 1);
  assert.equal(await supplied.stockFor(a, { deps }), 1);
  assert.equal(await supplied.stockFor(b, { deps }), 0);
});

test("S4: an empty shelf reports 0 without reading the listings at all", async () => {
  const offer = await offerOf();
  const row = await listingOn(offer, "eldorado");
  // 0 is 0 however it is divided, and this path runs on every stock sync.
  assert.equal(
    await supplied.stockFor(row, {
      deps: {
        ...deps,
        MarketplaceListing: {
          find() {
            throw new Error("an empty shelf must not cost a listing read");
          },
        },
      },
    }),
    0,
  );
});

test("S4: a failed sharer read throws rather than advertising the shelf", async () => {
  const offer = await offerOf();
  await paste(offer, 5);
  const row = await listingOn(offer, "eldorado");
  await assert.rejects(
    supplied.stockFor(row, {
      deps: {
        ...deps,
        MarketplaceListing: {
          find() {
            throw new Error("stepdown");
          },
        },
      },
    }),
    /stepdown/,
    "falling back to the whole shelf is the over-advertising direction",
  );
});

/* ------------------ S4: the rounding rule itself (pure) ------------------ */

test("S4: shareOfShelf never lets the shares sum past the shelf", () => {
  const { shareOfShelf } = supplied;
  for (const free of [0, 1, 3, 7, 50, 199]) {
    for (const n of [1, 2, 3, 4, 7, 10]) {
      const ids = [];
      for (let i = 0; i < n; i += 1) ids.push("id-" + String(100 + i));
      const total = ids.reduce((a, id) => a + shareOfShelf(free, id, ids), 0);
      assert.equal(total, free, free + " across " + n + " listings");
    }
  }
});

test("S4: a listing keeps its rank between syncs", () => {
  const { shareOfShelf } = supplied;
  const ids = ["id-c", "id-a", "id-b"];
  // 7 across 3: the spare goes to the two lowest ids and STAYS there, so two
  // markets do not swap an account back and forth on every pass.
  assert.equal(shareOfShelf(7, "id-a", ids), 3);
  assert.equal(shareOfShelf(7, "id-b", ids), 2);
  assert.equal(shareOfShelf(7, "id-c", ids), 2);
  assert.equal(shareOfShelf(7, "id-a", ["id-b", "id-c", "id-a"]), 3);
});

test("S4: a row with no id yet counts itself as one more sharer", () => {
  const { shareOfShelf } = supplied;
  // A publish counting stock before its MarketplaceListing is saved cannot be
  // given a rank among rows it is not part of. Taking the smallest share is the
  // direction that cannot oversell.
  assert.equal(shareOfShelf(9, "", ["id-a", "id-b"]), 3);
  assert.equal(shareOfShelf(9, null, []), 9);
  assert.equal(shareOfShelf(2, "", ["id-a", "id-b"]), 0);
});

/* --------------- S7: the panel can see what would be claimed ------------- */

test("S7: offerStats reports claimable and heldBack, split out of available", async () => {
  const offer = await offerOf();
  await paste(offer, 3);
  // Two rows the Drop Archive can also sell, one of which the owner has since
  // removed — the exact shape that broke `available − conflicts`.
  const rows = await SuppliedAccount.find({ offer: offer._id })
    .sort({ _id: 1 })
    .lean();
  await SuppliedAccount.updateOne(
    { _id: rows[0]._id },
    { $set: { conflict: "in-archive" } },
  );
  await SuppliedAccount.updateOne(
    { _id: rows[1]._id },
    { $set: { conflict: "in-archive", status: "removed" } },
  );

  const stats = await supplied.offerStats(offer._id, { deps });
  assert.equal(stats.available, 2, "available still counts the held-back row");
  assert.equal(stats.removed, 1);
  assert.equal(stats.claimable, 1);
  assert.equal(stats.heldBack, 1);
  assert.equal(stats.total, 3);
  // The browser's old fallback: 2 − 2 = 0 on a shelf with an account on it.
  assert.equal(stats.conflicts, 2);

  // claimable is the SAME predicate the claim layer counts and claims, so the
  // panel and a sale can never disagree.
  assert.equal(await supplied.shelfFor(offer._id, { deps }), stats.claimable);
  const claimed = await supplied.claimForListing(offer._id, 5, {
    orderId: "ord-stats-1",
    market: "eldorado",
    deps,
  });
  assert.equal(claimed.length, stats.claimable);
});

test("S7: a clean shelf reports claimable === available and no held-back rows", async () => {
  const offer = await offerOf();
  await paste(offer, 4);
  const stats = await supplied.offerStats(offer._id, { deps });
  assert.equal(stats.claimable, 4);
  assert.equal(stats.heldBack, 0);
  assert.equal(stats.available, 4);
});

test("S7: an offer with no accounts reports both figures as 0, not undefined", async () => {
  const offer = await offerOf();
  const stats = await supplied.offerStats(offer._id, { deps });
  assert.equal(stats.claimable, 0);
  assert.equal(stats.heldBack, 0);
  assert.equal(stats.total, 0);
});
