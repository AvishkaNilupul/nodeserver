// Region locks for Epic giveaways.
//
// Some giveaways are not sold in some countries (2026-10-29: "Sorry We're
// Closed" refused every RU account). The browser helper reports that as
// "region_unavailable" without submitting anything. A pair Epic refused is
// never retried, and every other account from the same country is locked out
// of that giveaway too, so the fleet stops opening checkouts Epic will refuse.
//
// The account's country comes from its saved details: creationCountry (the
// signup proxy IP, filled by utils/epicAccountLocation) first, then the
// country recorded on the account. Accounts with no country are only locked
// by their own refusal.
const { decrypt } = require("./secretBox");

const REFUSED = "region_unavailable";
const CODE = /^[A-Za-z]{2}$/;
const NONE = Object.freeze({ country: "", source: "" });

function accountCountry(acc, read = decrypt) {
  if (!acc || !acc.accountDetails) return NONE;
  try {
    const details = JSON.parse(read(acc.accountDetails) || "{}") || {};
    if (CODE.test(details.creationCountry || "")) {
      return {
        country: details.creationCountry.toUpperCase(),
        source: details.creationCountrySource || "creation",
      };
    }
    if (CODE.test(details.country || "")) {
      return { country: details.country.toUpperCase(), source: "recorded-account-country" };
    }
  } catch {
    /* unreadable details: treat as unknown country */
  }
  return NONE;
}

function refusedOffers(acc) {
  const log = Array.isArray(acc && acc.autoClaimLog) ? acc.autoClaimLog : [];
  return log.filter((e) => e && e.status === REFUSED && e.offerId).map((e) => e.offerId);
}

// offerId -> Set of countries where Epic refused that giveaway.
function blockedCountries(accounts, read = decrypt) {
  const map = new Map();
  for (const acc of accounts || []) {
    const offers = refusedOffers(acc);
    if (!offers.length) continue;
    const { country } = accountCountry(acc, read);
    if (!country) continue;
    for (const offerId of offers) {
      if (!map.has(offerId)) map.set(offerId, new Set());
      map.get(offerId).add(country);
    }
  }
  return map;
}

// null when the account may try this giveaway; otherwise
// { country, reason: "epic" (Epic refused this account) | "country" (Epic
// refused another account from the same country) }.
function regionBlock(acc, offer, blocked, read = decrypt) {
  if (!acc || !offer || !offer.offerId) return null;
  const { country } = accountCountry(acc, read);
  if (refusedOffers(acc).includes(offer.offerId)) return { country, reason: "epic" };
  const countries = blocked && blocked.get(offer.offerId);
  if (country && countries && countries.has(country)) return { country, reason: "country" };
  return null;
}

// Same map read straight from the database (only accounts with a refusal).
async function loadBlockedCountries(EpicAccount, read = decrypt) {
  const rows = await EpicAccount.find({ "autoClaimLog.status": REFUSED })
    .select("accountDetails autoClaimLog")
    .lean();
  return blockedCountries(rows, read);
}

// Record a refusal seen during a run so later accounts in the same run skip it.
function noteRefusal(blocked, acc, offerId, read = decrypt) {
  const { country } = accountCountry(acc, read);
  if (!blocked || !country || !offerId) return;
  if (!blocked.has(offerId)) blocked.set(offerId, new Set());
  blocked.get(offerId).add(country);
}

module.exports = {
  REFUSED,
  accountCountry,
  blockedCountries,
  loadBlockedCountries,
  noteRefusal,
  regionBlock,
};
