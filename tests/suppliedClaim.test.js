// The three ways owner-supplied stock turns into money we cannot get back.
//
// 1. TWO BUYERS, ONE ACCOUNT. A supplied account has no DropLog row and no
//    reservation, so the findOneAndUpdate({ _id, status: "available" }) inside
//    utils/suppliedStock.claimForListing IS the entire double-sell guard. If
//    two concurrent orders can both win that write, two buyers get the same
//    login and one of them is a refund plus a chargeback.
// 2. THE RETRY THAT BURNS THE SHELF. The claim is permanent, but the record
//    tying those rows to the order is written only AFTER the credential is
//    sent. A send that throws leaves the accounts spent and unattributed, so
//    the next tick claims brand new ones — utils/playerauctionsFulfiller.js:166
//    still has no resume block, and Eldorado order e69b19d3 retried 25 times
//    that way. Re-claiming under the same orderId must hand back the SAME
//    accounts and take nothing new.
// 3. A SHORT CLAIM READ AS A SUCCESS. Asking for 5 and getting 2 is not
//    four-fifths of a delivery, it is a part-delivered paid order. The returned
//    length is the only signal a caller has, so it must genuinely be short.
//
// Plus the two guards either side: a conflict:"in-archive" row (the login also
// exists as a BotAccount/AvailableAccount, so the archive claim path could sell
// the very same account) is never claimable, and a release puts back exactly
// the rows it was handed — never one already inside a platform's own vault.
//
// Real Mongo via mongodb-memory-server: the atomicity of that one write is the
// thing under test, and a stubbed model would only ever prove the stub.
process.env.CRED_SECRET ||= "supplied-claim-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const MarketplaceListing = require("../models/MarketplaceListing");
const { encrypt } = require("../utils/secretBox");
const supplied = require("../utils/suppliedStock");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("suppliedclaim"));
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// Injected so a test run can never reach a live Telegram bot or write audit
// rows, and so the low-stock warning (which is bounded but still I/O) stays out
// of the claim path being measured. lowStockWarnAt 0 disables the warning.
const telegramCalls = [];
const deps = {
  settings: {
    getAccountListingSettings: () => ({
      enabled: true,
      autoDeliver: true,
      lowStockWarnAt: 0,
    }),
  },
  telegram: {
    sendTelegram: async (text) => {
      telegramCalls.push(text);
    },
  },
  systemLog: { logEvent: () => {} },
};

let seq = 0;

// A fresh offer plus a shelf of accounts, one row at a time so createdAt (the
// claim's sort key) is unambiguous.
async function shelfOf(count, opts = {}) {
  seq += 1;
  const offer = await AccountOffer.create({
    title: "Supplied offer " + seq,
    game: "Overwatch 2",
    status: "active",
  });
  const logins = [];
  for (let i = 0; i < count; i += 1) {
    const login = "acct" + seq + "_" + i;
    await SuppliedAccount.create({
      offer: offer._id,
      login,
      password: encrypt("pw-" + login),
      clientSecret: encrypt("tok-" + login),
      email: encrypt(login + "@mail.test"),
      conflict: (opts.conflicts || []).includes(i) ? "in-archive" : "",
    });
    logins.push(login);
  }
  return { offer, logins };
}

const ids = (accounts) => accounts.map((a) => a.ledgerId);

/* ---------------------- 1. two buyers, one account ---------------------- */

test("concurrent claims never hand the same row to two orders", async () => {
  const { offer } = await shelfOf(5);

  // Four orders, each asking for three, against a shelf of five. Whatever the
  // interleaving, the union must be five distinct rows and never a repeat.
  const batches = await Promise.all(
    ["ord-a", "ord-b", "ord-c", "ord-d"].map((orderId) =>
      supplied.claimForListing(offer._id, 3, {
        orderId,
        market: "eldorado",
        deps,
      }),
    ),
  );

  const claimed = batches.flat();
  const unique = new Set(ids(claimed));
  assert.equal(unique.size, claimed.length, "no row was claimed twice");
  assert.equal(claimed.length, 5, "the whole shelf went out, and only once");

  // Every winner also owns its row exclusively in the DB, and the credentials
  // came back decrypted — never the literal "undefined" a spread Mongoose
  // sub-document produces.
  for (const account of claimed) {
    assert.equal(account.password, "pw-" + account.login);
    assert.equal(account.clientSecret, "tok-" + account.login);
    assert.match(account.raw, /^acct\d+_\d+:pw-/);
  }
  const owners = await SuppliedAccount.find(
    { offer: offer._id },
    { orderId: 1, status: 1 },
  ).lean();
  assert.deepEqual(
    owners.map((r) => r.status),
    ["sold", "sold", "sold", "sold", "sold"],
  );
  assert.equal(await supplied.stockFor(offer._id, { deps }), 0);
  assert.equal(telegramCalls.length, 0, "no live notification from a test");
});

/* --------------------- 2. a short claim stays short --------------------- */

test("a short claim returns fewer than asked and invents nothing", async () => {
  const { offer } = await shelfOf(2);
  const want = 5;

  const dry = await supplied.claimForListing(offer._id, want, {
    orderId: "ord-dry",
    market: "g2g",
    dryRun: true,
    deps,
  });
  assert.equal(dry.length, 2, "a dry run reports the real ceiling");
  assert.equal(
    await supplied.stockFor(offer._id, { deps }),
    2,
    "a dry run writes nothing",
  );

  const claimed = await supplied.claimForListing(offer._id, want, {
    orderId: "ord-short",
    market: "g2g",
    deps,
  });
  assert.equal(claimed.length, 2);
  assert.notEqual(
    claimed.length,
    want,
    "the caller's only success test is length === want, so it must fail here",
  );
  assert.equal(new Set(ids(claimed)).size, 2, "no row padded out the batch");
  assert.equal(await supplied.stockFor(offer._id, { deps }), 0);
});

/* ------------- 3. the retry that burned 25 accounts (e69b19d3) ----------- */

test("REGRESSION: a repeated orderId resumes and claims nothing new", async () => {
  const { offer } = await shelfOf(4);

  const first = await supplied.claimForListing(offer._id, 2, {
    orderId: "e69b19d3",
    market: "eldorado",
    deps,
  });
  assert.equal(first.length, 2);
  assert.equal(await supplied.stockFor(offer._id, { deps }), 2);

  // The send threw. Nothing was written to the listing, so the caller's
  // "already handled" guard finds no unit and asks again — 25 times, on the
  // real order. Every retry must be the same two accounts.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const again = await supplied.claimForListing(offer._id, 2, {
      orderId: "e69b19d3",
      market: "eldorado",
      deps,
    });
    assert.deepEqual(ids(again), ids(first), "attempt " + attempt);
    assert.deepEqual(
      again.map((a) => a.password),
      first.map((a) => a.password),
      "a resumed retry re-sends the same credentials, not blanks",
    );
  }

  assert.equal(
    await supplied.stockFor(offer._id, { deps }),
    2,
    "26 attempts burned two accounts, not fifty-two",
  );
  assert.equal(
    await SuppliedAccount.countDocuments({
      offer: offer._id,
      orderId: "e69b19d3",
    }),
    2,
  );

  // Resume is per-order, not a global short-circuit: a different order still
  // gets the rest of the shelf.
  const other = await supplied.claimForListing(offer._id, 2, {
    orderId: "some-other-order",
    market: "eldorado",
    deps,
  });
  assert.equal(other.length, 2);
  assert.equal(
    ids(other).filter((id) => ids(first).includes(id)).length,
    0,
    "the second order got different rows",
  );
});

/* ------------------ 4. the in-archive double-sell guard ----------------- */

test("conflict:'in-archive' rows are never claimable until cleared", async () => {
  // Rows 0 and 2 also exist in the Drop Archive, so the archive claim path
  // could sell them as well.
  const { offer, logins } = await shelfOf(3, { conflicts: [0, 2] });

  assert.equal(
    await supplied.stockFor(offer._id, { deps }),
    1,
    "conflicted rows are real stock but not ours to promise",
  );
  const claimed = await supplied.claimForListing(offer._id, 3, {
    orderId: "ord-conflict",
    market: "ggsel",
    deps,
  });
  assert.deepEqual(
    claimed.map((a) => a.login),
    [logins[1]],
    "only the clean row went out",
  );

  const held = await SuppliedAccount.find(
    { offer: offer._id, conflict: "in-archive" },
    { status: 1 },
  ).lean();
  assert.deepEqual(
    held.map((r) => r.status),
    ["available", "available"],
    "a conflicted row is skipped, not consumed",
  );

  // "Allow anyway" clears the flag and the row becomes claimable.
  await SuppliedAccount.updateOne(
    { offer: offer._id, login: logins[0] },
    { $set: { conflict: "" } },
  );
  const after = await supplied.claimForListing(offer._id, 3, {
    orderId: "ord-conflict-2",
    market: "ggsel",
    deps,
  });
  assert.deepEqual(after.map((a) => a.login), [logins[0]]);
});

/* --------------------- 5. release puts back exactly ---------------------- */

test("releaseClaim returns exactly the rows given and nothing else", async () => {
  const { offer } = await shelfOf(3);
  const claimed = await supplied.claimForListing(offer._id, 3, {
    orderId: "ord-rel",
    market: "z2u",
    deps,
  });
  assert.equal(claimed.length, 3);

  const wrongOrder = await supplied.releaseClaim([claimed[0].ledgerId], {
    orderId: "not-this-order",
    deps,
  });
  assert.equal(wrongOrder, 0, "another order's release cannot free our rows");

  const freed = await supplied.releaseClaim([claimed[0].ledgerId], {
    orderId: "ord-rel",
    deps,
  });
  assert.equal(freed, 1);

  const rows = await SuppliedAccount.find({ offer: offer._id })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  const back = rows.find((r) => String(r._id) === claimed[0].ledgerId);
  assert.equal(back.status, "available");
  assert.equal(back.orderId, "", "a freed row carries no stale order");
  assert.equal(back.market, "");
  assert.equal(back.soldAt, null);
  assert.equal(back.listing, null);

  const untouched = rows.filter((r) => String(r._id) !== claimed[0].ledgerId);
  assert.deepEqual(
    untouched.map((r) => r.status),
    ["sold", "sold"],
    "the two rows we did NOT name are still spent",
  );
  assert.deepEqual(
    untouched.map((r) => r.orderId),
    ["ord-rel", "ord-rel"],
  );
  assert.equal(await supplied.stockFor(offer._id, { deps }), 1);

  // Releasing the same row twice is a no-op rather than double-crediting.
  assert.equal(
    await supplied.releaseClaim([claimed[0].ledgerId], {
      orderId: "ord-rel",
      deps,
    }),
    0,
  );
});

/* ------------- 6. markFed: inside a platform vault, never back ----------- */

test("markFed marks the vault hand-off and a fed row can never be released", async () => {
  const { offer } = await shelfOf(2);
  // Built and validated, not saved: the row's post("save") hook fires a
  // fire-and-forget SystemEvent write that would still be in flight at
  // teardown. validate() is what proves the point anyway — `set` is required
  // for archive-backed rows only, so an offer-backed row must pass without one.
  const listing = new MarketplaceListing({
    accountOffer: offer._id,
    marketplace: "digiseller",
    externalId: "ds-supplied-1",
    status: "active",
    origin: "manual",
  });
  await listing.validate();
  assert.equal(supplied.isSuppliedRow(listing), true);
  assert.equal(listing.set, undefined, "an offer-backed row carries no set");

  const claimed = await supplied.claimForListing(listing, 2, {
    orderId: "",
    market: "digiseller",
    deps,
  });
  assert.equal(claimed.length, 2);
  const stamped = await SuppliedAccount.findById(claimed[0].ledgerId).lean();
  assert.equal(
    String(stamped.listing),
    String(listing._id),
    "a claim through a listing row records which listing spent it",
  );

  const fed = await supplied.markFed(ids(claimed), {
    listing,
    market: "digiseller",
    contentIds: ["content-1", "content-2"],
    deps,
  });
  assert.equal(fed, 2);

  const rows = await SuppliedAccount.find({ offer: offer._id })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  assert.deepEqual(
    rows.map((r) => r.status),
    ["fed", "fed"],
  );
  assert.deepEqual(
    rows.map((r) => r.contentId),
    ["content-1", "content-2"],
    "Digiseller has no endpoint to list a product's content later, so an id " +
      "not captured here is unreachable forever",
  );
  assert.ok(rows[0].fedAt instanceof Date);

  // CHANGED BY F1e — this used to assert releaseClaim(fed) === 0, which is the
  // defect, not the contract. The credential-baked-in markets move a row to
  // "fed" at PUBLISH time, so every id gameflipFulfiller.releaseSuppliedUnits
  // (utils/gameflipFulfiller.js:516) hands back when a listing 404s or is
  // retired is already "fed": under the old filter it matched nothing, returned
  // 0, logged nothing, and the account was stranded out of sellable stock for
  // good. A fed row is released; only deliveredAt refuses (test 7 below).
  assert.equal(
    await supplied.releaseClaim(ids(claimed), { deps }),
    2,
    "a retired listing's fed rows come back to the shelf",
  );
  assert.equal(await supplied.stockFor(offer._id, { deps }), 2);
  const backOnShelf = await SuppliedAccount.find({ offer: offer._id }).lean();
  for (const r of backOnShelf) {
    assert.equal(r.status, "available");
    assert.equal(r.fedAt, null);
    assert.equal(
      r.contentId,
      "",
      "a released row keeps no id pointing at a deleted vault unit",
    );
  }
});

/* ---------------- 7. markDelivered closes the row for good --------------- */

test("markDelivered stamps delivery and keeps the original soldAt", async () => {
  const { offer } = await shelfOf(2);
  const claimed = await supplied.claimForListing(offer._id, 1, {
    orderId: "ord-deliver",
    market: "playerauctions",
    deps,
  });
  assert.equal(claimed.length, 1);
  const before = await SuppliedAccount.findById(claimed[0].ledgerId).lean();

  const n = await supplied.markDelivered(ids(claimed), {
    orderId: "ord-deliver",
    market: "playerauctions",
    deps,
  });
  assert.equal(n, 1);

  const after = await SuppliedAccount.findById(claimed[0].ledgerId).lean();
  assert.equal(after.status, "sold");
  assert.ok(after.deliveredAt instanceof Date);
  assert.equal(
    after.soldAt.getTime(),
    before.soldAt.getTime(),
    "soldAt is when the row left the shelf; a resumed delivery must not move it",
  );
  assert.equal(after.orderId, "ord-deliver");
  assert.equal(after.market, "playerauctions");

  assert.equal(
    await supplied.releaseClaim(ids(claimed), {
      orderId: "ord-deliver",
      deps,
    }),
    0,
    "a delivered account cannot be put back on sale",
  );
  assert.equal(
    await supplied.stockFor(offer._id, { deps }),
    1,
    "the untouched row is still the only stock left",
  );
});
