// GGSel auto-delivery.
//
// A GGSel offer can carry many "products" (content lines) that GGSel hands to
// buyers automatically the moment they pay. For an auto-delivery listing we
// reserve up to N farmed accounts that hold the whole bundle, turn each into a
// delivery code (login + password + connect guide) and attach them as the
// offer's products. GGSel then fulfils each sale itself — no manual chat
// hand-off and no relist chain (unlike Gameflip, whose listings have no
// quantity).
const BotAccount = require("../models/BotAccount");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const { decrypt } = require("./secretBox");
const {
  reserveSetOnAccount,
  releaseAccountsForTag,
} = require("./dropReservation");

// Distinct from the Gameflip tag so a Shop buyer, a Gameflip listing and a
// GGSel listing can never be handed the same account's drops for one game.
const GG_CLAIM_TAG = "ggsel";

function ggselDeliveryCode(login, password) {
  return (
    "TWITCH DROP ACCOUNT\n\n" +
    "Login: " +
    login +
    "\nPassword: " +
    password +
    "\n\n" +
    "1. Log in to the received Twitch account, then go to " +
    "https://www.twitch.tv/drops/inventory and scroll to the bottom of the " +
    'page, to the "Received" section.\n\n' +
    '2. Click on the purple "Connect" button, which is located below the ' +
    "item you want to add to your account.\n\n" +
    "3. Connect the account by following the instructions shown on the site " +
    "where the connection is made.\n\n" +
    "If you have any issue please contact the seller."
  );
}

// Atomically reserve up to `max` unsold accounts that each hold the whole
// bundle. Returns [{ accountId, login, code }]; skips accounts with no
// readable password (and releases them) so every returned code is deliverable.
async function claimAccountsForSet(set, max) {
  const want = Math.max(1, parseInt(max, 10) || 1);
  const candidates = await availableAccountsForSet(set);
  const claimed = [];
  for (const c of candidates) {
    if (claimed.length >= want) break;
    // Reserve only this set's drops on the account (per game), not the whole
    // account — its other games stay sellable.
    const ok = await reserveSetOnAccount(c.accountId, set, {
      soldToUsername: GG_CLAIM_TAG,
      soldSetId: String(set._id),
    });
    if (!ok) continue;
    const account = await BotAccount.findById(c.accountId, {
      login: 1,
      credUsername: 1,
      credPassword: 1,
    }).lean();
    const login = account ? account.login || account.credUsername || "" : "";
    const password = account ? decrypt(account.credPassword) : "";
    if (!password) {
      await releaseAccounts([c.accountId]);
      continue;
    }
    claimed.push({
      accountId: String(c.accountId),
      login,
      code: ggselDeliveryCode(login, password),
    });
  }
  return claimed;
}

// Put reserved drops back in the sellable pool (only ones still reserved for
// GGSel — never touches drops sold through the Shop or another marketplace).
async function releaseAccounts(accountIds) {
  await releaseAccountsForTag(accountIds, GG_CLAIM_TAG);
}

module.exports = {
  GG_CLAIM_TAG,
  ggselDeliveryCode,
  claimAccountsForSet,
  releaseAccounts,
};
