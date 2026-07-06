// Digiseller (Plati.market) auto-delivery.
//
// A Digiseller "unique fixed price" product can carry many text content lines
// that Digiseller hands to buyers automatically the moment they pay. For an
// auto-delivery listing we reserve up to N farmed accounts that hold the whole
// bundle, turn each into a delivery code (login + password + connect guide)
// and attach them as the product's content. Digiseller then fulfils each sale
// itself — the manual "Add stock" flow stays available for accounts that are
// not tracked on the server.
const BotAccount = require("../models/BotAccount");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const { decrypt } = require("./secretBox");

// Distinct from the Shop / Gameflip / GGSel tags so the same account can
// never be handed out twice across platforms.
const DS_CLAIM_TAG = "digiseller";
// Tag for accounts added by hand through the stock feeder — they are matched
// to server accounts by login and retired from every other pool too.
const DS_MANUAL_TAG = "digiseller-manual";

function digisellerDeliveryCode(login, password) {
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
          soldToUsername: DS_CLAIM_TAG,
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
      code: digisellerDeliveryCode(login, password),
    });
  }
  return claimed;
}

// Put reserved accounts back in the sellable pool (only ones still reserved
// for Digiseller — never touches accounts sold elsewhere).
async function releaseAccounts(accountIds) {
  const ids = (Array.isArray(accountIds) ? accountIds : [accountIds])
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  if (!ids.length) return;
  await BotAccount.updateMany(
    { _id: { $in: ids }, soldToUsername: DS_CLAIM_TAG },
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

// Manually-added stock lines ("user:pass") may correspond to server-tracked
// accounts; retire those from the sellable pool so they cannot also be sold
// on another platform or through the Shop. Unknown logins are ignored.
async function retireManualAccounts(accountLines) {
  const logins = (Array.isArray(accountLines) ? accountLines : [])
    .map((l) =>
      String(l || "")
        .split(/[:\s]/)[0]
        .trim(),
    )
    .filter(Boolean);
  if (!logins.length) return 0;
  const r = await BotAccount.updateMany(
    { login: { $in: logins }, soldAt: null },
    {
      $set: {
        soldAt: new Date(),
        soldToAdminId: "",
        soldToUsername: DS_MANUAL_TAG,
        soldSetId: "",
      },
    },
  ).catch(() => null);
  return (r && r.modifiedCount) || 0;
}

module.exports = {
  DS_CLAIM_TAG,
  DS_MANUAL_TAG,
  digisellerDeliveryCode,
  claimAccountsForSet,
  releaseAccounts,
  retireManualAccounts,
};
