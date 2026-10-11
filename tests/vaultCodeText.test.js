// The delivery code a buyer gets on GGSel and Gameflip (login, password and the
// steps to take).
//
// Two things are pinned here:
//   - the claimed-drops code is, byte for byte, what it has always been.
//     Gameflip refuses a code it has already seen, and that refusal is the last
//     guard against listing one login twice — the guard IS the text;
//   - the UNCLAIMED variant (an auto-farm account sold for drops that are
//     finished but not claimed) tells the buyer to connect first and then
//     claim, and is never longer than the claimed one: Gameflip's limit on a
//     code is undocumented, and the claimed text is the longest it is known to
//     accept.
process.env.CRED_SECRET ||= "test-secret";
const test = require("node:test");
const assert = require("node:assert");

const { ggselDeliveryCode } = require("../utils/ggselFulfiller");
const { gameflipDeliveryCode } = require("../utils/gameflipFulfiller");
const mp = require("../utils/marketplaces");
const { CLAIMED_CODE_STEPS, UNCLAIMED_CODE_STEPS } = require("../utils/farmHandover");

const CLAIMED_BODY =
  "1. Log in to the received Twitch account, then go to " +
  "https://www.twitch.tv/drops/inventory and scroll to the bottom of the " +
  'page, to the "Received" section.\n\n' +
  '2. Click on the purple "Connect" button, which is located below the ' +
  "item you want to add to your account.\n\n" +
  "3. Connect the account by following the instructions shown on the site " +
  "where the connection is made.\n\n";

test("the claimed-drops code is byte for byte what it always was, on both markets", () => {
  assert.strictEqual(CLAIMED_CODE_STEPS, CLAIMED_BODY);
  const head = "TWITCH DROP ACCOUNT\n\nLogin: some_login\nPassword: p@ss w0rd\n\n";
  assert.strictEqual(
    ggselDeliveryCode("some_login", "p@ss w0rd"),
    head + CLAIMED_BODY + "If you have any issue please contact the seller.",
  );
  assert.strictEqual(
    gameflipDeliveryCode("some_login", "p@ss w0rd"),
    head + CLAIMED_BODY + "If you have any issue please message me here on Gameflip.",
  );
  // No options, empty options, a false flag: all the same code.
  for (const opts of [undefined, {}, { unclaimed: false }, null]) {
    assert.strictEqual(gameflipDeliveryCode("a", "b", opts), gameflipDeliveryCode("a", "b"));
    assert.strictEqual(ggselDeliveryCode("a", "b", opts), ggselDeliveryCode("a", "b"));
  }
});

test("the unclaimed code: connect FIRST, then claim, today — and never longer than the claimed one", () => {
  assert.ok(UNCLAIMED_CODE_STEPS.length <= CLAIMED_CODE_STEPS.length, UNCLAIMED_CODE_STEPS.length + " > " + CLAIMED_CODE_STEPS.length);
  for (const [login, pw] of [["a", "b"], ["some_long_login_name_25chr", "x".repeat(40)]]) {
    for (const build of [ggselDeliveryCode, gameflipDeliveryCode]) {
      const claimed = build(login, pw);
      const unclaimed = build(login, pw, { unclaimed: true });
      assert.ok(unclaimed.length <= claimed.length);
      assert.notStrictEqual(unclaimed, claimed);
      assert.ok(unclaimed.startsWith("TWITCH DROP ACCOUNT\n\nLogin: " + login + "\nPassword: " + pw + "\n\n"));
    }
  }
  const code = gameflipDeliveryCode("farmer", "pw", { unclaimed: true });
  // The order of the steps is the whole point.
  const connect = code.indexOf("Connect");
  const claim = code.indexOf("Claim Now");
  assert.ok(connect > 0 && claim > connect, "connect comes before claim");
  assert.match(code, /YOUR OWN game account/);
  assert.match(code, /only releases a drop to a connected account/);
  assert.match(code, /Do it today/);
  assert.match(code, /a week after the event/);
  // Nothing about the "Received" section: an unclaimed drop is not there.
  assert.doesNotMatch(code, /Received/);
  assert.match(code, /message me here on Gameflip\.$/);
  assert.match(ggselDeliveryCode("farmer", "pw", { unclaimed: true }), /contact the seller\.$/);
});

test("GGSel still reads the login back out of either code", () => {
  assert.strictEqual(mp.ggselCodeLogin(ggselDeliveryCode("MyLogin", "pw")), "mylogin");
  assert.strictEqual(mp.ggselCodeLogin(ggselDeliveryCode("MyLogin", "pw", { unclaimed: true })), "mylogin");
});

test("only an auto-farm account's unit gets the unclaimed code — a no-claim account's is untouched", () => {
  const fs = require("fs");
  const ncl = fs.readFileSync(require.resolve("../utils/noclaimListings.js"), "utf8");
  // Every GGSel code the no-claim layer builds decides by the account's farm.
  const calls = ncl.match(/ggselDeliveryCode\([^;]*?\)\)?,/g) || [];
  assert.strictEqual(calls.length, 3, "feed, publish and rebuild");
  for (const c of calls) assert.match(c, /unclaimed: .*farm === "autofarm"/, c);
  const gf = fs.readFileSync(require.resolve("../utils/gameflipFulfiller.js"), "utf8");
  assert.match(gf, /gameflipDeliveryCode\(login, acc\.password, \{ unclaimed: acc\.farm === "autofarm" \}\)/);
  // The claimed auto-lister's own Gameflip publish passes nothing.
  assert.match(gf, /autoDeliverCode: gameflipDeliveryCode\(login, password\),/);
  // And the claim layer says which farm an account it hands out belongs to.
  const ncs = fs.readFileSync(require.resolve("../utils/noclaimStock.js"), "utf8");
  assert.strictEqual((ncs.match(/claimedAccount\([^\n]*\.farm\)\)/g) || []).length, 3);
});
