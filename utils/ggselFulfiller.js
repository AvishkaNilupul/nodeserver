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

// Distinct from the Gameflip tag so a Shop buyer, a Gameflip listing and a
// GGSel listing can never be handed the same account.
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
    const account = await BotAccount.findOneAndUpdate(
      { _id: c.accountId, soldAt: null },
      {
        $set: {
          soldAt: new Date(),
          soldToAdminId: "",
          soldToUsername: GG_CLAIM_TAG,
          soldSetId: String(set._id),
        },
      },
      { new: true },
    );
    if (!account) continue;
    const login = account.login || account.credUsername || "";
    const password = decrypt(account.credPassword);
    if (!password) {
      await releaseAccounts([account._id]);
      continue;
    }
    claimed.push({
      accountId: String(account._id),
      login,
      code: ggselDeliveryCode(login, password),
    });
  }
  return claimed;
}

// Put reserved accounts back in the sellable pool (only ones still reserved
// for GGSel — never touches accounts sold through the Shop or Gameflip).
async function releaseAccounts(accountIds) {
  const ids = (Array.isArray(accountIds) ? accountIds : [accountIds])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (!ids.length) return;
  await BotAccount.updateMany(
    { _id: { $in: ids }, soldToUsername: GG_CLAIM_TAG },
    {
      $set: {
        soldAt: null,
        soldToAdminId: "",
        soldToUsername: "",
        soldSetId: "",
      },
    },
  ).catch(() => {});
}

module.exports = {
  GG_CLAIM_TAG,
  ggselDeliveryCode,
  claimAccountsForSet,
  releaseAccounts,
};
