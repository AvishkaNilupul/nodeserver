// The five guards in utils/suppliedStock.js that were not guarding anything
// (docs/ACCOUNT-LISTINGS-FIXES.md F1a-F1e). Four of the five end in the same
// place: one account sold to two buyers, or an account the owner paid for that
// can never be sold at all.
//
// F1a A CREDENTIAL IN CLEARTEXT. `extra` is whatever the supplier put past
//     field 4 — a mail password, a recovery code, a second address — and it
//     was the one column written raw while password/token/email were
//     encrypted. Same class of secret, ciphertext in one column and plaintext
//     in the next.
// F1b A CASE-DIFFERENT LOGIN WALKING PAST THE DOUBLE-SELL GATE. BotAccount
//     .login is stored verbatim from the bot config, so a farm account spelled
//     "DropFarm_X91" was not flagged when the owner pasted "dropfarm_x91" —
//     the row became claimable supplied stock while the Drop Archive could
//     still sell the very same account.
// F1c A FAILED LOOKUP READ AS "NO CONFLICTS". Both archive reads ended in
//     .catch(() => []), and the flag is computed once at ingest and never
//     revisited, so a transient read failure made a whole paste permanently
//     claimable. It must fail closed.
// F1d THE PER-OFFER KILL SWITCH THAT DID NOTHING. deliveryEnabled existed and
//     claimForListing never called it, so an offer with autoDeliver:false
//     still handed its shelf to the next paid order —
//     utils/g2gFulfiller.js:220-222 tells its reader "the claim layer
//     enforces" it.
// F1e AN ACCOUNT STRANDED FOREVER. releaseClaim filtered on status:"sold",
//     but the credential-baked-in markets move a row to "fed" at publish time,
//     so gameflipFulfiller.releaseSuppliedUnits (utils/gameflipFulfiller.js:516)
//     matched zero rows every time a listing 404'd or was retired: stock the
//     owner paid for, out of the shelf for good.
//
// Real Mongo via mongodb-memory-server, like tests/suppliedClaim.test.js: the
// atomic status transition and the unique index ARE the double-sell guard, and
// a stubbed model would only ever prove the stub.
process.env.CRED_SECRET ||= "supplied-guards-test-cred-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const AccountOffer = require("../models/AccountOffer");
const SuppliedAccount = require("../models/SuppliedAccount");
const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const { isEncrypted, decrypt } = require("../utils/secretBox");
const supplied = require("../utils/suppliedStock");

let mem;

test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("suppliedguards"));
  await SuppliedAccount.init();
});

test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

// The global half of the delivery gate, injected so a test can flip it without
// touching the real settings file. lowStockWarnAt 0 keeps Telegram out of the
// claim path entirely.
const settingsState = { enabled: true, autoDeliver: true, lowStockWarnAt: 0 };
const deps = {
  settings: { getAccountListingSettings: () => ({ ...settingsState }) },
  telegram: {
    sendTelegram: async () => {
      throw new Error("a test must never reach a live Telegram bot");
    },
  },
  systemLog: { logEvent: () => {} },
};

let seq = 0;

async function offerOf(over = {}) {
  seq += 1;
  return AccountOffer.create({
    title: "Guarded offer " + seq,
    game: "Overwatch 2",
    status: "active",
    ...over,
  });
}

// A shelf pasted through the REAL ingest, so every test below measures what
// addAccounts actually writes rather than a hand-built row.
async function paste(offer, lines, opts = {}) {
  return supplied.addAccounts(offer._id, lines.join("\n"), {
    deps,
    ...opts,
  });
}

const ids = (accounts) => accounts.map((a) => a.ledgerId);

/* ------------- F1a: `extra` is a credential, so it is encrypted ----------- */

test("F1a: extra is ciphertext at rest and plaintext at delivery", async () => {
  const offer = await offerOf({
    deliveryTemplate: "L={login}\nE={extra}\nRAW={line}",
  });
  const line = "extrauser:pw-1:tok-1:box@mail.test:mailpw-8842";
  const res = await paste(offer, [line]);
  assert.equal(res.added, 1);

  const row = await SuppliedAccount.findOne({ offer: offer._id }).lean();
  assert.ok(
    isEncrypted(row.extra),
    "the supplier's mail password must not sit in the DB as plaintext",
  );
  assert.notEqual(row.extra, "mailpw-8842");
  assert.equal(decrypt(row.extra), "mailpw-8842");

  // ...and the buyer still gets the value, through both read paths.
  const claimed = await supplied.claimForListing(offer._id, 1, {
    orderId: "ord-extra",
    market: "z2u",
    deps,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].extra, "mailpw-8842");
  assert.equal(
    claimed[0].raw,
    line,
    "what the owner pasted is what {line} renders back",
  );
  const text = supplied.deliveryText(row, offer);
  assert.equal(text, "L=extrauser\nE=mailpw-8842\nRAW=" + line);
  assert.ok(!text.includes("enc:v1:"), "shipping ciphertext is not delivery");
});

test("F1a: a row pasted before the fix still renders its cleartext extra", async () => {
  // decrypt() returns a non-prefixed value unchanged, which is the whole reason
  // this migration needs no backfill. Every row already on prod is this shape.
  const offer = await offerOf({ deliveryTemplate: "{extra}" });
  await SuppliedAccount.create({
    offer: offer._id,
    login: "legacyrow",
    password: "pw-legacy",
    extra: "legacy-recovery-code",
  });
  const claimed = await supplied.claimForListing(offer._id, 1, {
    orderId: "ord-legacy",
    market: "ggsel",
    deps,
  });
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].extra, "legacy-recovery-code");
  const row = await SuppliedAccount.findById(claimed[0].ledgerId).lean();
  assert.equal(supplied.deliveryText(row, offer), "legacy-recovery-code");
});

/* ------- F1b: the in-archive gate must not care how a login is spelled ---- */

test("F1b: a case-different farm login is still flagged in-archive", async () => {
  // Exactly the shape that walked past the gate: the bot config spells it one
  // way, the owner pastes it another. The Drop Archive can sell this account,
  // so it is not ours to promise.
  await BotAccount.create({
    clientSecret: "cs-dropfarm-x91",
    login: "DropFarm_X91",
  });
  await AvailableAccount.create({
    username: "PoolAcct_A2",
    usernameLower: "poolacct_a2",
  });

  const offer = await offerOf();
  const res = await paste(offer, [
    "dropfarm_x91:pw-a", // lowercased spelling of a BotAccount
    "POOLACCT_A2:pw-b", // uppercased spelling of a pool account
    "cleanacct1:pw-c", // in neither collection
  ]);
  assert.equal(res.added, 3, "a conflicted row is inserted, not dropped");
  assert.deepEqual(res.conflicts, ["dropfarm_x91", "POOLACCT_A2"]);

  const rows = await SuppliedAccount.find({ offer: offer._id })
    .sort({ createdAt: 1, _id: 1 })
    .lean();
  assert.deepEqual(
    rows.map((r) => r.conflict),
    ["in-archive", "in-archive", ""],
  );

  // The money assertion: a flagged row is not claimable stock. Without it the
  // same login is sold once here and once off the archive.
  assert.equal(await supplied.stockFor(offer._id, { deps }), 1);
  const claimed = await supplied.claimForListing(offer._id, 3, {
    orderId: "ord-case",
    market: "eldorado",
    deps,
  });
  assert.deepEqual(
    claimed.map((a) => a.login),
    ["cleanacct1"],
    "only the account nothing else can sell went out",
  );
  const held = await SuppliedAccount.find(
    { offer: offer._id, conflict: "in-archive" },
    { status: 1 },
  ).lean();
  assert.deepEqual(
    held.map((r) => r.status),
    ["available", "available"],
    "a conflicted row is skipped, never consumed",
  );
});

test("F1b: an exactly-spelled farm login is still flagged (no regression)", async () => {
  await BotAccount.create({ clientSecret: "cs-exact", login: "exactspell" });
  const offer = await offerOf();
  const res = await paste(offer, ["exactspell:pw", "otheracct1:pw"]);
  assert.deepEqual(res.conflicts, ["exactspell"]);
  assert.equal(await supplied.stockFor(offer._id, { deps }), 1);
});

test("F1b: a pasted login is escaped, so '.' cannot match any character", async () => {
  // The case-insensitive sweep is a RegExp per login. Unescaped, "acct.x9"
  // would match the unrelated "acctxx9" and hold clean stock off sale forever —
  // the owner would clear the flag by hand, which is the click that defeats the
  // guard on the paste where the overlap is real.
  await BotAccount.create({ clientSecret: "cs-dot", login: "acctxx9" });
  const offer = await offerOf();
  const res = await paste(offer, ["acct.x9:pw"]);
  assert.deepEqual(res.conflicts, [], "a different login is not a conflict");
  assert.equal(await supplied.stockFor(offer._id, { deps }), 1);
});

/* ------- F1c: a failed lookup is not permission to sell the account ------ */

// A model whose read rejects — an Atlas blip, a stepdown, a timeout.
function failingModel(what) {
  return {
    find: () => ({
      lean: () => Promise.reject(new Error(what + " read timed out")),
    }),
  };
}

test("F1c: a failed archive lookup refuses the paste, it does not clear it", async () => {
  for (const [name, broken] of [
    ["BotAccount", { BotAccount: failingModel("BotAccount") }],
    ["AvailableAccount", { AvailableAccount: failingModel("pool") }],
  ]) {
    const offer = await offerOf();
    const err = await supplied
      .addAccounts(offer._id, "unchecked1:pw\nunchecked2:pw", {
        deps: { ...deps, ...broken },
      })
      .then(
        () => null,
        (e) => e,
      );
    assert.ok(err, name + ": the failure must surface, not be swallowed");
    assert.equal(err.code, "ARCHIVE_CHECK_FAILED");
    assert.match(err.message, /Drop Archive/);

    // The point of failing closed: nothing was inserted, so nothing became
    // claimable stock the archive could also sell. The flag is written once at
    // ingest and never recomputed, so an optimistic insert here would be
    // permanent.
    assert.equal(
      await SuppliedAccount.countDocuments({ offer: offer._id }),
      0,
      name + ": an unchecked paste must leave no row behind",
    );
    assert.equal(await supplied.stockFor(offer._id, { deps }), 0);

    // And it is a refusal, not a ban: the same paste lands once the read works.
    const ok = await paste(offer, ["unchecked1:pw", "unchecked2:pw"]);
    assert.equal(ok.added, 2, name + ": re-pasting after the blip works");
  }
});

/* ---------- F1d: the offer's own auto-deliver switch is enforced --------- */

test("F1d: claimForListing returns [] when the offer's delivery is off", async () => {
  const offer = await offerOf({ autoDeliver: false });
  await paste(offer, ["paused1:pw", "paused2:pw", "paused3:pw"]);

  const claimed = await supplied.claimForListing(offer._id, 2, {
    orderId: "ord-paused",
    market: "g2g",
    deps,
  });
  assert.deepEqual(claimed, [], "a paused offer hands over nothing");
  const rows = await SuppliedAccount.find({ offer: offer._id }).lean();
  assert.deepEqual(
    rows.map((r) => r.status),
    ["available", "available", "available"],
    "and it spends nothing either",
  );

  // A dry run still reports the shelf: five stock counters read through it and
  // 0 takes a live offer off sale (eldorado pause, PA hide, G2G delist, Z2U
  // off_line), so a PAUSE must not look like an empty shelf.
  const dry = await supplied.claimForListing(offer._id, 2, {
    dryRun: true,
    deps,
  });
  assert.equal(dry.length, 2);
  assert.equal(await supplied.stockFor(offer._id, { deps }), 3);

  // Switch it back on and the same call sells.
  await AccountOffer.updateOne(
    { _id: offer._id },
    { $set: { autoDeliver: true } },
  );
  const after = await supplied.claimForListing(offer._id, 2, {
    orderId: "ord-paused",
    market: "g2g",
    deps,
  });
  assert.equal(after.length, 2);
});

test("F1d: the global kill switch stops every offer's claims", async () => {
  const offer = await offerOf(); // autoDeliver defaults to true
  await paste(offer, ["global1:pw", "global2:pw"]);

  for (const off of [{ autoDeliver: false }, { enabled: false }]) {
    Object.assign(settingsState, { enabled: true, autoDeliver: true }, off);
    assert.deepEqual(
      await supplied.claimForListing(offer._id, 1, {
        orderId: "ord-global",
        market: "zeusx",
        deps,
      }),
      [],
      JSON.stringify(off) + " must stop the claim",
    );
    assert.equal(
      (await supplied.claimForListing(offer._id, 1, { dryRun: true, deps }))
        .length,
      1,
      "the panel can still see the shelf while delivery is paused",
    );
  }
  Object.assign(settingsState, { enabled: true, autoDeliver: true });
  assert.equal(
    (
      await supplied.claimForListing(offer._id, 1, {
        orderId: "ord-global",
        market: "zeusx",
        deps,
      })
    ).length,
    1,
    "an ordinary offer under an enabled switch is unchanged",
  );
});

test("F1d: a resume mid-pause hands back nothing, then the same rows", async () => {
  const offer = await offerOf();
  await paste(offer, ["resume1:pw", "resume2:pw", "resume3:pw"]);
  const first = await supplied.claimForListing(offer._id, 1, {
    orderId: "ord-resume",
    market: "eldorado",
    deps,
  });
  assert.equal(first.length, 1);

  // The owner pauses the offer while the send is still being retried. The
  // retry must get nothing — not a second account off the shelf.
  await AccountOffer.updateOne(
    { _id: offer._id },
    { $set: { autoDeliver: false } },
  );
  assert.deepEqual(
    await supplied.claimForListing(offer._id, 1, {
      orderId: "ord-resume",
      market: "eldorado",
      deps,
    }),
    [],
  );
  assert.equal(await supplied.stockFor(offer._id, { deps }), 2);

  // Unpaused, the resume hands back the SAME row it already spent.
  await AccountOffer.updateOne(
    { _id: offer._id },
    { $set: { autoDeliver: true } },
  );
  const again = await supplied.claimForListing(offer._id, 1, {
    orderId: "ord-resume",
    market: "eldorado",
    deps,
  });
  assert.deepEqual(ids(again), ids(first));
  assert.equal(await supplied.stockFor(offer._id, { deps }), 2);
});

/* --------- F1e: a retired listing's accounts come back to the shelf ------- */

test("F1e: releaseClaim frees a fed row, and the vault stamps go with it", async () => {
  const offer = await offerOf();
  await paste(offer, ["fedrow1:pw", "fedrow2:pw"]);
  const claimed = await supplied.claimForListing(offer._id, 2, {
    orderId: "gf-order-1",
    market: "gameflip",
    deps,
  });
  assert.equal(claimed.length, 2);
  await supplied.markFed(ids(claimed), {
    market: "gameflip",
    contentIds: ["gf-content-1", "gf-content-2"],
    deps,
  });

  // Exactly what utils/gameflipFulfiller.js:516 does when a listing 404s or is
  // retired: the ids come out of units[].contentId and the rows are always
  // "fed". Under the old status:"sold" filter this returned 0 and the accounts
  // were stranded out of sellable stock forever.
  const freed = await supplied.releaseClaim(ids(claimed), {
    orderId: "gf-order-1",
    deps,
  });
  assert.equal(freed, 2);
  assert.equal(await supplied.stockFor(offer._id, { deps }), 2);

  const rows = await SuppliedAccount.find({ offer: offer._id }).lean();
  for (const r of rows) {
    assert.equal(r.status, "available");
    assert.equal(r.fedAt, null);
    assert.equal(r.soldAt, null);
    assert.equal(r.orderId, "");
    assert.equal(r.market, "");
    assert.equal(r.listing, null);
    assert.equal(
      r.contentId,
      "",
      "a stale contentId would go on naming a deleted vault unit",
    );
  }
  // And the freed rows really are sellable again, credentials intact.
  const resold = await supplied.claimForListing(offer._id, 2, {
    orderId: "gf-order-2",
    market: "gameflip",
    deps,
  });
  assert.equal(resold.length, 2);
  assert.deepEqual(
    resold.map((a) => a.password).sort(),
    ["pw", "pw"],
    "a released row keeps its credential",
  );
});

test("F1e: a delivered row is never released, whatever its status says", async () => {
  const offer = await offerOf();
  await paste(offer, ["gone1:pw", "gone2:pw"]);

  // Path one: claimed and delivered.
  const sold = await supplied.claimForListing(offer._id, 1, {
    orderId: "ord-sent-1",
    market: "playerauctions",
    deps,
  });
  await supplied.markDelivered(ids(sold), {
    orderId: "ord-sent-1",
    market: "playerauctions",
    deps,
  });

  // Path two: fed to a vault first, then confirmed delivered — the row is
  // "sold" with a deliveredAt, and it must be just as untouchable.
  const fed = await supplied.claimForListing(offer._id, 1, {
    orderId: "ord-sent-2",
    market: "digiseller",
    deps,
  });
  await supplied.markFed(ids(fed), { market: "digiseller", deps });
  await supplied.markDelivered(ids(fed), {
    orderId: "ord-sent-2",
    market: "digiseller",
    deps,
  });

  assert.equal(
    await supplied.releaseClaim(ids(sold).concat(ids(fed)), { deps }),
    0,
    "a credential that reached a buyer can never be sellable again",
  );
  assert.equal(await supplied.stockFor(offer._id, { deps }), 0);
  const rows = await SuppliedAccount.find({ offer: offer._id }).lean();
  assert.deepEqual(
    rows.map((r) => r.status),
    ["sold", "sold"],
  );
});
