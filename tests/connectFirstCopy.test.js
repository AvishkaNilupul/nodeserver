// Buyer-facing copy after Twitch's "link before claim" rule (2026-10-05,
// twitchdev/issues #1216): an account that is not connected to the game can
// no longer claim a drop.
//
//   - a RENT-FARM buyer must connect their own game account before our bot
//     can claim anything for them — every hand-over and every offer text has
//     to say so, first;
//   - a buyer of UNCLAIMED stock (the no-claim farm) finds the drops at the
//     top of the inventory, not under "Received", and must connect before
//     "Claim Now" works — and soon, Twitch keeps them ~7 days after the event;
//   - a buyer of CLAIMED stock still gets the old guide, byte for byte.
const test = require("node:test");
const assert = require("node:assert/strict");

const handover = require("../utils/farmHandover");
const paCopy = require("../utils/playerauctionsCopy");

const GAME = "Overwatch";
const LONG_GAME = "Tom Clancy's Rainbow Six Siege X";
const short = { login: "shortlogin", password: "pw12345678" };
const long = { login: "abcdefghijklmnopqrstuvwxy", password: "Zx9!abcdefghijkl" };

test("the shared connect-first wording names the game and the place to do it", () => {
  const full = handover.connectFirstText(GAME);
  assert.match(full, /CONNECT YOUR GAME ACCOUNT FIRST/);
  assert.match(full, /https:\/\/www\.twitch\.tv\/drops\/campaigns/);
  assert.match(full, /find Overwatch and press Connect/);
  assert.match(full, /YOUR OWN game account/);
  assert.match(full, /7 days after an event/);
  // An offer text carries no link at all — an off-site link is what a
  // marketplace's listing review strips or flags. The menu path instead.
  const offer = handover.connectFirstOffer(GAME);
  assert.match(offer, /CONNECT the received Twitch account/);
  assert.doesNotMatch(offer, /https?:\/\/|twitch\.tv|www\./);
  assert.match(offer, /Drops & Rewards > All Campaigns, find Overwatch and press Connect/);
  assert.match(handover.connectFirstOffer(GAME, { each: true }), /CONNECT each received Twitch account/);
  assert.match(handover.connectFirstShort(GAME), /^FIRST connect your own game account \(Overwatch\)/);
  // No game known: the sentence still reads.
  assert.match(handover.connectFirstText(""), /find your game and press Connect/);
  assert.doesNotMatch(handover.connectFirstShort(""), /\(\)/);
});

test("Eldorado rent-farm hand-over: connect first, then keep it linked", () => {
  const farm = require("../utils/eldoradoFarmService");
  const msg = farm.farmDeliveryMessage([short], 365, GAME, {
    until: new Date("2027-10-10T00:00:00Z"),
  });
  const connect = msg.indexOf("CONNECT YOUR GAME ACCOUNT FIRST");
  const keep = msg.indexOf("KEEP THIS ACCOUNT LINKED");
  assert.ok(connect > 0, "says connect first");
  assert.ok(keep > connect, "and only then keep it linked");
  assert.ok(msg.indexOf(short.login) < connect, "the login comes before the step");
  assert.match(msg, /do not change the account's password/);
});

test("G2G rent-farm hand-over: connect first, and no claimed-bundle guide", () => {
  const farm = require("../utils/g2gFarmService");
  const msg = farm.farmMessage([short], { game: GAME, days: 30 }, {
    until: new Date("2026-11-09T00:00:00Z"),
  });
  assert.match(msg, /CONNECT YOUR GAME ACCOUNT FIRST/);
  assert.match(msg, new RegExp("Username: " + short.login));
  assert.match(msg, new RegExp("Password: " + short.password));
  // The bundle card sends a buyer to "Received → Connect"; a farm buyer has
  // nothing there until they connect.
  assert.doesNotMatch(msg, /"Received"/);
  assert.doesNotMatch(msg, /HOW TO CLAIM/);
});

test("PlayerAuctions rent-farm hand-over keeps the connect step inside 300 characters", () => {
  for (const acct of [short, long]) {
    for (const game of [GAME, LONG_GAME]) {
      const msg = paCopy.farmDeliveryMessage([acct], 730, game, new Date("2028-10-09T00:00:00Z"));
      assert.ok(msg.length <= paCopy.LIMIT, msg.length + " characters");
      assert.match(msg, /FIRST (connect|link)/, "connect step dropped for " + acct.login + " / " + game);
      assert.match(msg, new RegExp("Login: " + acct.login));
    }
  }
  for (const game of [GAME, LONG_GAME, ""]) {
    const ins = paCopy.farmInstruction(365, game);
    assert.ok(ins.length <= paCopy.INSTRUCTION_LIMIT, ins.length + " characters");
    assert.match(ins, /FIRST connect your own/);
    assert.match(ins, /press Connect/);
    // The whole instruction survives the cap — the last sentence is the
    // refund rule, and it must not be the one that is cut.
    assert.match(ins, /Events under 24h are not guaranteed\.$/);
  }
});

// The delivery code Gameflip carried until 2026-10-10 — the longest code it has
// ever accepted from us. Its cap is undocumented, and a refused code fails every
// top-up and renewal of the rent-farm buffer, so the new wording must fit
// inside the old one's length for every game, term and login.
function oldGameflipCode(login, password, days, game) {
  const term = days === 365 ? "1 year" : days + " days";
  return (
    "TWITCH DROPS AUTOMATIC FARMING — " + game + "\n\n" +
    "Username: " + login + "\nPassword: " + password + "\n\n" +
    "Your " + term + " of automatic farming starts now.\n\n" +
    "KEEP THIS ACCOUNT LINKED to your game account. Our farm watches every " +
    "drop event for " + game + " and claims the items automatically the moment " +
    "they unlock — you do not have to watch any streams. Items appear whenever " +
    game + " runs a Twitch Drops campaign during your " + term + ", so check " +
    "back and claim them whenever you like at " +
    "https://www.twitch.tv/drops/inventory\n\n" +
    "Please do not change the account's password or email — the automatic " +
    "farming stops if you do, and that is not covered by a refund.\n\n" +
    "Any problem at all, message me here on Gameflip first and I will sort it " +
    "out."
  );
}

test("Gameflip rent-farm: the offer and the delivered code both say connect first", () => {
  const svc = require("../utils/gameflipFarmService");
  const code = svc.bufferedDeliveryCode(short.login, short.password, 30, GAME);
  const connect = code.indexOf("FIRST CONNECT YOUR OWN GAME ACCOUNT (required)");
  assert.ok(connect > code.indexOf("Password: " + short.password), "right after the login");
  assert.ok(code.indexOf("Then keep it linked") > connect);
  assert.match(code, /https:\/\/www\.twitch\.tv\/drops\/campaigns, find Overwatch and press Connect/);
  assert.match(code, /Do not change the account's password or email/);
  const desc = svc.offerDescription(GAME, svc.TERMS[0]);
  assert.match(desc, /CONNECT the received Twitch account/);
  // The guarantee is the sentence a dispute quotes: it holds once connected.
  assert.match(desc, /and once you have connected your game account, all events during this period will be automatically collected/);
});

test("Gameflip rent-farm code is never longer than the one Gameflip already accepts", () => {
  const svc = require("../utils/gameflipFarmService");
  for (const game of ["X", "Rust", GAME, "EA Sports College Football 27", LONG_GAME]) {
    for (const days of [30, 120, 180, 365, 730]) {
      for (const a of [{ login: "u1", password: "p1" }, short, long]) {
        const was = oldGameflipCode(a.login, a.password, days, game).length;
        const now = svc.bufferedDeliveryCode(a.login, a.password, days, game).length;
        assert.ok(now <= was, game + " / " + days + "d: " + now + " > " + was);
      }
    }
  }
});

test("bulk rent-farm packs tell the buyer to connect EACH account", () => {
  const copy = require("../utils/bulkPacks/copy");
  const desc = copy.farmDescription({ game: GAME, days: 30, minQty: 10 });
  assert.match(desc, /CONNECT each received Twitch account/);
  assert.match(desc, /once you have connected your game account to it, all events/);
  assert.doesNotMatch(desc, /twitch\.tv/);
  assert.ok(desc.length <= 2000, desc.length + " characters");
});

test("unclaimed stock gets the connect-then-claim guide; claimed stock keeps the old one", () => {
  const eld = require("../utils/eldoradoFulfiller");
  const claimed = eld.eldoradoAccountsMessage([short], 1);
  const unclaimed = eld.eldoradoAccountsMessage([short], 1, { unclaimed: true });

  // Claimed: exactly what it always was.
  assert.equal(claimed, eld.eldoradoDeliveryCode(short.login, short.password));
  assert.match(claimed, /"Received" section/);
  assert.doesNotMatch(claimed, /Claim Now/);

  // Unclaimed: no "Received", Connect before Claim, and the deadline.
  assert.doesNotMatch(unclaimed, /"Received"/);
  const connect = unclaimed.indexOf('"Connect"');
  const claim = unclaimed.indexOf('"Claim Now"');
  assert.ok(connect > 0 && claim > connect, "Connect comes before Claim Now");
  assert.match(unclaimed, /YOUR OWN game account/);
  assert.match(unclaimed, /CLAIM TODAY/);
  assert.match(unclaimed, /about 7 days after their event ends/);
  assert.match(unclaimed, /clock is already running/);
  // A sold no-claim account leaves its bot, so the text must not promise more.
  assert.doesNotMatch(unclaimed, /keeps collecting/);
  assert.ok(unclaimed.startsWith("TWITCH DROP ACCOUNT\n\nUsername: " + short.login + "\nPassword: " + short.password));

  // Several accounts: one guide, after the credential blocks.
  const many = eld.eldoradoAccountsMessage([short, long], 2, { unclaimed: true });
  assert.equal(many.split("HOW TO CLAIM").length, 2, "one guide for the whole order");
  assert.ok(many.indexOf(long.login) < many.indexOf("HOW TO CLAIM"));
  assert.match(many, /"Claim Now"/);
  assert.match(eld.eldoradoAccountsMessage([short, long], 2), /"Received" section/);
});

test("G2G hands the same two guides out through its delivery code", () => {
  const g2g = require("../utils/g2gFulfiller");
  const eld = require("../utils/eldoradoFulfiller");
  assert.equal(
    g2g.g2gDeliveryCode(short.login, short.password),
    eld.eldoradoDeliveryCode(short.login, short.password),
  );
  const unclaimed = g2g.g2gDeliveryCode(short.login, short.password, { unclaimed: true });
  assert.match(unclaimed, /"Claim Now"/);
  assert.doesNotMatch(unclaimed, /"Received"/);
});

test("PlayerAuctions unclaimed copy fits both caps and keeps connect before claim", () => {
  for (const accounts of [[short], [long], [short, long, short], Array(12).fill(long)]) {
    const msgs = paCopy.deliveryMessages(accounts, { kind: "unclaimed" });
    for (const m of msgs) assert.ok(m.length <= paCopy.LIMIT, m.length + " characters");
    const all = msgs.join("\n");
    assert.match(all, /FIRST press Connect/);
    assert.ok(all.indexOf("Connect") < all.indexOf("Claim on each drop"));
    // The deadline rides along whenever there is room: always for one account,
    // and always when the credentials are split and the note has its own
    // message. In between, the 300 characters go to "connect first".
    if (accounts.length === 1 || msgs.length > 1) assert.match(all, /Claim today/);
    for (const a of accounts) assert.ok(all.includes(a.login));
  }
  // The claimed bundle message is untouched, and is still the default.
  assert.equal(
    paCopy.deliveryMessages([short], { kind: "bundle" })[0],
    paCopy.bundleDeliveryMessage([short]),
  );
  assert.equal(paCopy.deliveryMessages([short])[0], paCopy.bundleDeliveryMessage([short]));

  const ins = paCopy.bundleInstruction({ unclaimed: true });
  assert.ok(ins.length <= paCopy.INSTRUCTION_LIMIT, ins.length + " characters");
  assert.match(ins, /FIRST press Connect/);
  assert.match(ins, /Claim Now/);
  assert.match(ins, /7 days/);
  assert.doesNotMatch(ins, /"Received"/);
  assert.match(ins, /make it right\.$/, "the instruction is whole, not cut");
  assert.match(paCopy.bundleInstruction(), /Under "Received"/);
});
