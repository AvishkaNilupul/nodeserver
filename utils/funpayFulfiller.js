// FunPay auto-delivery.
//
// A FunPay offer with auto-delivery ("secrets") hands ONE line to each buyer
// the moment they pay. So, unlike GGSel/Plati where the whole multi-line
// delivery code is one product, a FunPay deliverable must be a single line —
// here `login:password`. The human connect guide can't live in `secrets`
// (FunPay would split each guide line into its own product), so it is sent as
// the offer's after-payment message instead (see funpayPaymentGuide).
//
// For an auto-delivery listing we reserve up to N farmed accounts that hold the
// whole bundle and attach each as one secret line. Reserving them also keeps
// the Shop / Gameflip / GGSel from ever handing out the same account — FunPay
// has no API, so it can't tell us when a sale happens, but the reservation
// still prevents double-selling across channels.
const BotAccount = require("../models/BotAccount");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const { decrypt } = require("./secretBox");
const {
  reserveSetOnAccount,
  releaseAccountsForTag,
} = require("./dropReservation");

// Distinct claim owner so a FunPay-reserved account is never also handed to a
// Shop buyer, a Gameflip listing, a GGSel offer or a Plati product.
const FP_CLAIM_TAG = "funpay";

// One buyer receives one of these lines. Kept to a single line on purpose.
function funpayDeliveryLine(login, password) {
  return login + ":" + password;
}

// Shown to every buyer as the offer's after-payment message (fields[payment_msg]).
function funpayPaymentGuide() {
  return (
    "Thanks for your purchase! You received a Twitch account as " +
    "login:password.\n\n" +
    "1. Log in to the received Twitch account, then go to " +
    "https://www.twitch.tv/drops/inventory and scroll to the bottom of the " +
    'page, to the "Received" section.\n\n' +
    '2. Click the purple "Connect" button below the item you want to add to ' +
    "your account.\n\n" +
    "3. Connect the account by following the instructions on the site where " +
    "the connection is made.\n\n" +
    "If you have any issue please contact the seller."
  );
}

// Atomically reserve up to `max` unsold accounts that each hold the whole
// bundle. Returns [{ accountId, login, line }]; skips accounts with no readable
// password (and releases them) so every returned line is deliverable.
async function claimAccountsForSet(set, max) {
  const want = Math.max(1, parseInt(max, 10) || 1);
  const candidates = await availableAccountsForSet(set);
  const claimed = [];
  for (const c of candidates) {
    if (claimed.length >= want) break;
    // Per-game reservation: commit only this set's drops on the account.
    const ok = await reserveSetOnAccount(c.accountId, set, {
      soldToUsername: FP_CLAIM_TAG,
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
      line: funpayDeliveryLine(login, password),
    });
  }
  return claimed;
}

// Put reserved drops back in the sellable pool (only ones still reserved for
// FunPay — never touches drops sold through the Shop or another marketplace).
async function releaseAccounts(accountIds) {
  await releaseAccountsForTag(accountIds, FP_CLAIM_TAG);
}

module.exports = {
  FP_CLAIM_TAG,
  funpayDeliveryLine,
  funpayPaymentGuide,
  claimAccountsForSet,
  releaseAccounts,
};
