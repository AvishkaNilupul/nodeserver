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
const {
  reserveSetOnAccount,
  releaseAccountsForTag,
} = require("./dropReservation");

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
    // Per-game reservation: commit only this set's drops on the account.
    const ok = await reserveSetOnAccount(c.accountId, set, {
      soldToUsername: DS_CLAIM_TAG,
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
      code: digisellerDeliveryCode(login, password),
    });
  }
  return claimed;
}

// Put reserved drops back in the sellable pool (only ones still reserved for
// Digiseller — never touches drops sold elsewhere).
async function releaseAccounts(accountIds) {
  await releaseAccountsForTag(accountIds, DS_CLAIM_TAG);
}

// Manually-added stock lines ("user:pass") may correspond to server-tracked
// accounts; retire the listing's set's drops on those accounts so this game
// can't also be sold through the Shop or another platform. Unknown logins are
// ignored. Needs the listing's `set` (for the per-game itemKeys).
async function retireManualAccounts(accountLines, set) {
  const logins = (Array.isArray(accountLines) ? accountLines : [])
    .map((l) =>
      String(l || "")
        .split(/[:\s]/)[0]
        .trim(),
    )
    .filter(Boolean);
  if (!logins.length || !set || !(set.items || []).length) return 0;
  const accts = await BotAccount.find(
    { login: { $in: logins } },
    { _id: 1 },
  ).lean();
  let n = 0;
  for (const a of accts) {
    const ok = await reserveSetOnAccount(a._id, set, {
      soldToUsername: DS_MANUAL_TAG,
      soldSetId: String(set._id),
    });
    if (ok) n++;
  }
  return n;
}

module.exports = {
  DS_CLAIM_TAG,
  DS_MANUAL_TAG,
  digisellerDeliveryCode,
  claimAccountsForSet,
  releaseAccounts,
  retireManualAccounts,
};
