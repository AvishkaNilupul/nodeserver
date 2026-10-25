// One sale per game per account (utils/soldGameGuard.js, docs/SOLD-GAME-GUARD.md).
//
// Prod 2026-09-29: Gameflip delivered an account for one MARVEL Contest of
// Champions set at 18:26Z; at 18:32Z the auto-lister listed the same account
// on ZeusX for ANOTHER MCOC set, whose drops still read as free because
// reservation is per drop and a SOLD row is not an active listing. The
// Gameflip buyer connected MCOC the next day, which took those drops too.
process.env.SESSION_SECRET ||= "sold-game-guard-test";
process.env.CRED_SECRET ||= "sold-game-guard-cred";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const { encrypt } = require("../utils/secretBox");
const guard = require("../utils/soldGameGuard");
const twins = require("../utils/accountTwins");
const {
  reserveSetOnAccount,
  releaseSetForAccounts,
} = require("../utils/dropReservation");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const autoLister = require("../utils/autoLister");

const MCOC = "MARVEL Contest of Champions";
const key = (name, game) => name.toLowerCase() + "|" + game.toLowerCase();

// ---- pure ------------------------------------------------------------------

test("gameKeyOfItemKey takes the game after the LAST '|', lowercased", () => {
  assert.equal(guard.gameKeyOfItemKey("drop 1 - nw4|marvel contest of champions"), "marvel contest of champions");
  assert.equal(guard.gameKeyOfItemKey("a | b|Overwatch "), "overwatch");
  assert.equal(guard.gameKeyOfItemKey("no game here"), "");
  assert.equal(guard.gameKeyOfItemKey(""), "");
});

test("setGameKeys reads itemKeys, and falls back to the item's game", () => {
  const games = guard.setGameKeys({
    items: [
      { itemKey: key("Creator Drop 1", MCOC) },
      { itemKey: key("Drop 2", MCOC) },
      { itemKey: "", game: " Overwatch " },
    ],
  });
  assert.deepEqual([...games].sort(), ["marvel contest of champions", "overwatch"]);
});

test("takenFromRows: same game is taken whatever the set, other games never are", () => {
  const games = new Set(["marvel contest of champions"]);
  const at = new Date("2026-09-29T18:26:00Z");
  const rows = [
    { account: "a1", itemKey: key("Creator Drop 1", MCOC), soldAt: at, soldSetId: "setA" },
    { account: "a2", itemKey: key("Skin", "Overwatch"), soldAt: at, soldSetId: "setX" },
    { account: "a3", itemKey: key("Drop 1", MCOC), soldAt: at, soldSetId: "setB" }, // the SAME set counts too
    { account: "a4", itemKey: key("Drop 1", MCOC), soldAt: null, soldSetId: "" }, // free, ignored
    { account: "a5", itemKey: "", game: MCOC, soldAt: at, soldSetId: "" }, // legacy row, game field
  ];
  assert.deepEqual([...guard.takenFromRows(rows, games)].sort(), ["a1", "a3", "a5"]);
});

test("takenFromRows ignores the caller's own stamp and maps twin rows to the asked record", () => {
  const games = new Set(["marvel contest of champions"]);
  const mine = new Date("2026-09-29T18:32:00.123Z");
  const rows = [
    { account: "a1", itemKey: key("Drop 1", MCOC), soldAt: new Date(mine.getTime()) },
    { account: "twin2", itemKey: key("Creator Drop 1", MCOC), soldAt: new Date("2026-09-29T18:26:00Z") },
  ];
  const ownerOf = new Map([["a1", ["a1"]], ["twin2", ["twin2", "twin1"]]]);
  assert.deepEqual(
    [...guard.takenFromRows(rows, games, { ownerOf, ignoreSoldAt: mine })].sort(),
    ["twin1", "twin2"],
  );
});

test("foreignHeldFromRows: a unit is foreign-held only when ANOTHER tag holds its game", () => {
  const games = new Set(["nba 2k27"]);
  const at = new Date("2026-10-03T20:47:46Z");
  const nba = (n) => key("Item " + n, "NBA 2K27");
  const rows = [
    // u1: Eldorado unit; Gameflip delivered the game in August -> foreign
    { account: "u1", itemKey: nba(1), soldAt: at, soldSetId: "S", soldToUsername: "eldorado" },
    { account: "u1", itemKey: nba(2), soldAt: at, soldSetId: "OLD", soldToUsername: "gameflip" },
    // u2: only its own reservation -> fine
    { account: "u2", itemKey: nba(1), soldAt: at, soldSetId: "S", soldToUsername: "eldorado" },
    // u3: same tag under an older set id (rewritten row) -> not foreign
    { account: "u3", itemKey: nba(1), soldAt: at, soldSetId: "S", soldToUsername: "eldorado" },
    { account: "u3", itemKey: nba(2), soldAt: at, soldSetId: "S0", soldToUsername: "eldorado" },
    // u4: no row for S at all -> own tag unknown -> not judged
    { account: "u4", itemKey: nba(1), soldAt: at, soldSetId: "S0", soldToUsername: "eldorado" },
    { account: "u4", itemKey: nba(2), soldAt: at, soldSetId: "X", soldToUsername: "gameflip" },
    // u5: another market holds a DIFFERENT game -> fine
    { account: "u5", itemKey: nba(1), soldAt: at, soldSetId: "S", soldToUsername: "eldorado" },
    { account: "u5", itemKey: key("Skin", "Overwatch"), soldAt: at, soldSetId: "OW", soldToUsername: "gameflip" },
  ];
  assert.deepEqual([...guard.foreignHeldFromRows(rows, games, "S")], ["u1"]);
});

// ---- against a real database ------------------------------------------------

let mem;
test.before(async () => {
  mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("soldgameguard"));
});
test.after(async () => {
  await mongoose.disconnect();
  if (mem) await mem.stop();
});

async function reset() {
  await Promise.all([
    BotAccount.deleteMany({}),
    DropLog.deleteMany({}),
    DropSet.deleteMany({}),
    MarketplaceListing.deleteMany({}),
  ]);
  twins.__resetCache();
}

let benefit = 0;
async function account(login, drops) {
  const a = await BotAccount.create({
    login,
    clientSecret: "cs-" + login + "-" + benefit,
    credPassword: encrypt("pw-" + login),
    lastScanStatus: "ok",
  });
  for (const [name, game, copies] of drops) {
    for (let i = 0; i < (copies || 1); i++) {
      await DropLog.create({
        account: a._id,
        login,
        benefitId: "b" + ++benefit,
        name,
        game,
        itemKey: key(name, game),
        count: 1,
        connected: false,
        soldAt: null,
        awardedAt: new Date(),
      });
    }
  }
  return a;
}

async function dropSet(name, game, itemNames) {
  return DropSet.create({
    name,
    coverGame: game,
    items: itemNames.map((n) => ({ name: n, game, itemKey: key(n, game), qty: 1 })),
  });
}

const logins = (list) => list.map((x) => x.login).sort();

test("2026-09-29: an account sold for one MCOC set is no longer stock for another MCOC set", async () => {
  await reset();
  const setA = await dropSet("MCOC Creator Drops", MCOC, ["Creator Drop 1"]);
  const setB = await dropSet("MCOC Drops NW4", MCOC, ["Drop 1 - NW4"]);
  const soldAcc = await account("soldmcoc1", [
    ["Creator Drop 1", MCOC],
    ["Drop 1 - NW4", MCOC],
  ]);
  const clean = await account("cleanmcoc", [["Drop 1 - NW4", MCOC]]);

  // Before any sale both hold set B.
  assert.deepEqual(logins(await availableAccountsForSet(setB)), ["cleanmcoc", "soldmcoc1"]);

  // Gameflip sells set A on soldmcoc1.
  assert.equal(
    await reserveSetOnAccount(soldAcc._id, setA, { soldToUsername: "gameflip", soldSetId: String(setA._id) }),
    true,
  );

  // Set B's drops on it still read as free, but the account is not stock for B.
  assert.deepEqual(logins(await availableAccountsForSet(setB)), ["cleanmcoc"]);
  assert.equal(
    await reserveSetOnAccount(soldAcc._id, setB, { soldToUsername: "zeusx", soldSetId: String(setB._id) }),
    false,
    "the commit point refuses it too",
  );
  const bRow = await DropLog.findOne({ account: soldAcc._id, itemKey: key("Drop 1 - NW4", MCOC) }).lean();
  assert.equal(bRow.soldAt, null, "a refusal stamps nothing");

  // The auto-lister's own picker agrees.
  const picked = await autoLister.pickDeliveryAccounts(
    { assignedAccounts: ["soldmcoc1", "cleanmcoc"] },
    10,
    setB.items,
  );
  assert.deepEqual(logins(picked), ["cleanmcoc"]);

  // The clean account still sells.
  assert.equal(
    await reserveSetOnAccount(clean._id, setB, { soldToUsername: "zeusx", soldSetId: String(setB._id) }),
    true,
  );
});

test("another GAME on the same account still sells (per-game model, 2026-07-21)", async () => {
  await reset();
  const mcocA = await dropSet("MCOC A", MCOC, ["Creator Drop 1"]);
  const ow = await dropSet("OW Skin", "Overwatch", ["Skin"]);
  const acc = await account("everything1", [
    ["Creator Drop 1", MCOC],
    ["Skin", "Overwatch"],
  ]);
  assert.equal(await reserveSetOnAccount(acc._id, mcocA, { soldToUsername: "gameflip" }), true);
  assert.deepEqual(logins(await availableAccountsForSet(ow)), ["everything1"]);
  assert.equal(await reserveSetOnAccount(acc._id, ow, { soldToUsername: "eldorado" }), true);
});

// Regression pin, not new behaviour: a reservation stamps EVERY free copy of
// the set's items, so a fat account's spare copy never reads as stock.
test("a spare copy of the SAME set is not a second sale", async () => {
  await reset();
  const setB = await dropSet("MCOC B", MCOC, ["Drop 1 - NW4"]);
  const fat = await account("fatmcoc", [["Drop 1 - NW4", MCOC, 2]]);
  assert.equal(await reserveSetOnAccount(fat._id, setB, { soldToUsername: "gameflip" }), true);
  assert.deepEqual(logins(await availableAccountsForSet(setB)), [], "its second copy is not stock");
  assert.equal(await reserveSetOnAccount(fat._id, setB, { soldToUsername: "g2g" }), false);
});

test("releasing the reservation (refund, unsold delist) gives the game back", async () => {
  await reset();
  const setA = await dropSet("MCOC A", MCOC, ["Creator Drop 1"]);
  const setB = await dropSet("MCOC B", MCOC, ["Drop 1 - NW4"]);
  const acc = await account("refunded", [
    ["Creator Drop 1", MCOC],
    ["Drop 1 - NW4", MCOC],
  ]);
  assert.equal(await reserveSetOnAccount(acc._id, setA, { soldToUsername: "gameflip" }), true);
  assert.deepEqual(logins(await availableAccountsForSet(setB)), []);
  await releaseSetForAccounts([acc._id], String(setA._id), "gameflip");
  assert.deepEqual(logins(await availableAccountsForSet(setB)), ["refunded"]);
});

test("a legacy commitment with no set id or a hand sale counts", async () => {
  await reset();
  const setB = await dropSet("MCOC B", MCOC, ["Drop 1 - NW4"]);
  const acc = await account("handsold", [
    ["Creator Drop 1", MCOC],
    ["Drop 1 - NW4", MCOC],
  ]);
  await DropLog.updateOne(
    { account: acc._id, itemKey: key("Creator Drop 1", MCOC) },
    { $set: { soldAt: new Date(), soldToUsername: "manual", soldSetId: "" } },
  );
  assert.deepEqual(logins(await availableAccountsForSet(setB)), []);
});

test("twins: a sale through one record blocks the game on the other record", async () => {
  await reset();
  const setA = await dropSet("MCOC A", MCOC, ["Creator Drop 1"]);
  const setB = await dropSet("MCOC B", MCOC, ["Drop 1 - NW4"]);
  const rec1 = await account("TwinLogin", [["Creator Drop 1", MCOC]]);
  const rec2 = await account("twinlogin", [["Drop 1 - NW4", MCOC]]);
  assert.equal(await reserveSetOnAccount(rec1._id, setA, { soldToUsername: "gameflip" }), true);
  twins.__resetCache();
  assert.deepEqual(logins(await availableAccountsForSet(setB)), []);
  assert.equal(await reserveSetOnAccount(rec2._id, setB, { soldToUsername: "zeusx" }), false);
});

test("alreadyCommitted (guardian re-reserve, recorded delivery, hand-listed) skips the guard", async () => {
  await reset();
  const setA = await dropSet("MCOC A", MCOC, ["Creator Drop 1"]);
  const setB = await dropSet("MCOC B", MCOC, ["Drop 1 - NW4"]);
  const acc = await account("relisted", [
    ["Creator Drop 1", MCOC],
    ["Drop 1 - NW4", MCOC],
  ]);
  assert.equal(await reserveSetOnAccount(acc._id, setA, { soldToUsername: "gameflip" }), true);
  assert.equal(
    await reserveSetOnAccount(acc._id, setB, { soldToUsername: "zeusx", alreadyCommitted: true }),
    true,
  );
});

test("race: a same-game commit landing between the check and the stamp makes us back out", async () => {
  await reset();
  const setA = await dropSet("MCOC A", MCOC, ["Creator Drop 1"]);
  const setB = await dropSet("MCOC B", MCOC, ["Drop 1 - NW4"]);
  const acc = await account("racer", [
    ["Creator Drop 1", MCOC],
    ["Drop 1 - NW4", MCOC],
  ]);
  const real = guard.sameGameTakenAccounts;
  let calls = 0;
  guard.sameGameTakenAccounts = async (ids, set, opts) => {
    calls++;
    if (calls === 1) {
      // A concurrent Eldorado claim commits set A right after our check.
      await DropLog.updateOne(
        { account: acc._id, itemKey: key("Creator Drop 1", MCOC) },
        { $set: { soldAt: new Date(Date.now() - 1000), soldToUsername: "eldorado", soldSetId: String(setA._id) } },
      );
      return new Set();
    }
    return real(ids, set, opts);
  };
  let ok;
  try {
    ok = await reserveSetOnAccount(acc._id, setB, { soldToUsername: "zeusx", soldSetId: String(setB._id) });
  } finally {
    guard.sameGameTakenAccounts = real;
  }
  assert.equal(ok, false);
  assert.equal(calls, 2, "checked before AND after stamping");
  const b = await DropLog.findOne({ account: acc._id, itemKey: key("Drop 1 - NW4", MCOC) }).lean();
  assert.equal(b.soldAt, null, "our stamp was rolled back");
  const a = await DropLog.findOne({ account: acc._id, itemKey: key("Creator Drop 1", MCOC) }).lean();
  assert.equal(a.soldToUsername, "eldorado", "the other claim's reservation is untouched");
});

test("an unreadable post-stamp check undoes the stamp and reports the error", async () => {
  await reset();
  const setB = await dropSet("MCOC B", MCOC, ["Drop 1 - NW4"]);
  const acc = await account("dbhiccup", [["Drop 1 - NW4", MCOC]]);
  const real = guard.sameGameTakenAccounts;
  let calls = 0;
  guard.sameGameTakenAccounts = async (ids, set, opts) => {
    calls++;
    if (calls === 2) throw new Error("db hiccup");
    return real(ids, set, opts);
  };
  try {
    await assert.rejects(
      reserveSetOnAccount(acc._id, setB, { soldToUsername: "zeusx" }),
      /db hiccup/,
    );
  } finally {
    guard.sameGameTakenAccounts = real;
  }
  const b = await DropLog.findOne({ account: acc._id }).lean();
  assert.equal(b.soldAt, null);
});

test("liveUnits: a pre-reserved unit whose game another market already sold is not handed over", async () => {
  await reset();
  const { liveUnits } = require("../utils/dropReservation");
  const NBA = "NBA 2K27";
  const gfSet = await dropSet("NBA 2K27 Gameflip", NBA, ["Nike Ja 4 MyCOURT"]);
  const eldSet = await dropSet("NBA 2K27 Eldorado", NBA, ["MyTEAM Pack"]);
  const sold = await account("soldnba1", [
    ["Nike Ja 4 MyCOURT", NBA],
    ["MyTEAM Pack", NBA],
  ]);
  const clean = await account("cleannba", [["MyTEAM Pack", NBA]]);
  // August: Gameflip delivers the account for its set.
  assert.equal(await reserveSetOnAccount(sold._id, gfSet, { soldToUsername: "gameflip" }), true);
  // October: the auto-lister's Eldorado share pre-reserved both accounts. (The
  // guard now refuses the first one at publish; the row below is the shape
  // prod already holds, so it is written directly.)
  await DropLog.updateMany(
    { itemKey: key("MyTEAM Pack", NBA) },
    { $set: { soldAt: new Date(), soldToUsername: "eldorado", soldSetId: String(eldSet._id) } },
  );
  const units = [
    { accountId: String(sold._id), login: "soldnba1" },
    { accountId: String(clean._id), login: "cleannba" },
  ];
  assert.deepEqual(logins(await liveUnits(units, eldSet._id)), ["cleannba"]);
});
