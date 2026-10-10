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
const { loginsOnActiveListings, notListed } = require("./listedLogins");
const { decrypt } = require("./secretBox");
const {
  reserveSetOnAccount,
  releaseSetForAccounts,
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
  // Never an account already attached to another live listing, on ANY
  // marketplace: the buyer gets the whole account, so a second listing's
  // promised drops would ship with it (utils/listedLogins.js). The Gameflip
  // claimer always did this; the stock-product claimers did not, and the
  // guardian's restocks through them were still creating cross-set
  // collisions on 2026-09-03.
  const candidates = notListed(
    await availableAccountsForSet(set),
    await loginsOnActiveListings(),
  );
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
      await releaseAccounts([c.accountId], set._id);
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

// Put ONE set's GGSel-reserved drops on these accounts back in the sellable
// pool. Never tag-wide: GGSel keeps no record of its own for us, so a "ggsel"
// reservation on a set a buyer already bought IS the only thing stopping that
// account being sold again — and one account is sold once per game, so the
// same account routinely carries several "ggsel" sets. Releasing every "ggsel"
// drop on it (as this did until 2026-10-01) re-opened the sold ones whenever a
// publish failed, a feed failed or a listing was delisted. Without a set id
// nothing is released: a stranded reservation costs one unit of stock, a
// wrongly freed one sells an account twice.
async function releaseAccounts(accountIds, setId) {
  if (!setId) {
    console.error(
      "ggsel releaseAccounts: no set id given — nothing released (fail closed)",
    );
    return;
  }
  await releaseSetForAccounts(accountIds, String(setId), GG_CLAIM_TAG);
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
}

// After a delisted offer's vault was emptied (mp.ggselEmptyVault), hand back
// exactly the accounts GGSel proved never sold: their code was in stock and is
// archived now. A login with a SOLD code on the offer is the buyer's — kept. A
// code still in stock stays reserved (it can still sell if the offer is ever
// re-activated). A login the listing row never recorded is not ours to
// release. Only THIS row's set is released, and only its "ggsel" drops.
async function releaseProvenUnsold(row, vault) {
  const out = { released: [], keptSold: [], keptLeft: [], notOnRow: [] };
  if (!row || !row.set || !vault) return out;
  const low = (l) => String(l || "").trim().toLowerCase();
  const sold = new Set((vault.sold || []).map((p) => low(p.login)).filter(Boolean));
  const left = new Set((vault.left || []).map((p) => low(p.login)).filter(Boolean));
  const onRow = new Set(
    String(row.accountLogin || "")
      .split(/[,\s]+/)
      .map(low)
      .filter(Boolean),
  );
  for (const u of row.units || []) if (u && u.login) onRow.add(low(u.login));
  const free = [];
  for (const login of new Set((vault.archived || []).map((p) => low(p.login)))) {
    if (!login) continue;
    if (sold.has(login)) out.keptSold.push(login);
    else if (left.has(login)) out.keptLeft.push(login);
    else if (!onRow.has(login)) out.notOnRow.push(login);
    else free.push(login);
  }
  if (!free.length) return out;
  // Every record of the login (one Twitch account can have two BotAccount
  // records, utils/accountTwins.js): the reservation may sit on either.
  const accounts = await BotAccount.find(
    { login: { $in: free.map((l) => new RegExp("^" + escapeRe(l) + "$", "i")) } },
    { _id: 1, login: 1 },
  ).lean();
  const ids = accounts.map((a) => String(a._id));
  if (ids.length) await releaseAccounts(ids, row.set);
  out.released = [...new Set(accounts.map((a) => low(a.login)))];
  return out;
}

module.exports = {
  GG_CLAIM_TAG,
  ggselDeliveryCode,
  claimAccountsForSet,
  releaseAccounts,
  releaseProvenUnsold,
};
