// One-click fixes for guardian findings (the Integrity tab's "Fix" button).
//
// A finding tells a human WHAT would burn a buyer; this module is the HOW of
// putting it right without leaving the page:
//
//   replace (funpay)   swap a burned / dead account out of the offer's
//                      UNDELIVERED auto-delivery pool for a freshly claimed
//                      one. FunPay's own editor is the source of truth for
//                      which lines are still undelivered, so this also tells
//                      apart "burned line pulled before anyone bought it"
//                      from "line already delivered — this was a real sale,
//                      just restock".
//   reserve            re-reserve a listing's drops under its own claim tag
//                      (claim-mismatch where the drops are simply free). On
//                      FunPay a genuine conflict falls back to replace.
//   detach (qty)       stop tracking an account on a Plati/GGSel listing row
//                      whose unit the platform already delivered (the low-
//                      severity "likely a completed sale" findings).
//   refeed             run the auto-feed for one listing right now
//                      (restock-failed / stock-unknown).
//
// fixPlanFor() is the pure "is this finding fixable, and how" gate — the
// findings API uses it to label buttons, and fixFinding() re-derives it
// server-side before acting so a stale button can't do the wrong thing.
const AuditFinding = require("../models/AuditFinding");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const fpFulfiller = require("./funpayFulfiller");
const guardian = require("./marketplaceGuardian");
const mp = require("./marketplaces");
const accountState = require("./twitchAccountState");
const {
  reserveSetOnAccount,
  releaseSetForAccounts,
} = require("./dropReservation");

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function splitIds(s) {
  return String(s || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function isQtyListing(lst) {
  return (
    (lst.marketplace === "digiseller" || lst.marketplace === "ggsel") &&
    Number(lst.qtyTarget) > 0
  );
}

// Pure: which fix (if any) applies to a finding. `listing` is the joined
// MarketplaceListing row (or null when the finding has none / it was deleted).
// "needs-human" counts as actionable: the auto-healer exhausted its own
// attempts, but the remedy it was reaching for is still the right one and an
// operator may well succeed where it failed (the marketplace came back, stock
// arrived). Withholding the button there would leave the row with no way
// forward at all.
function fixPlanFor(f, listing) {
  if (!f || (f.status !== "open" && f.status !== "needs-human")) return null;
  const lst = listing || null;
  const active = !!(lst && lst.status === "active");
  switch (f.type) {
    case "redeemed-drops":
      if (!active || !f.accountId) return null;
      if (lst.marketplace === "funpay") {
        return {
          action: "replace",
          label: "Replace account",
          hint:
            "Pull this account's line out of the FunPay auto-delivery pool " +
            "(if a buyer hasn't taken it yet) and feed in a fresh account.",
        };
      }
      if (isQtyListing(lst)) {
        return {
          action: "detach",
          label: "Detach sold unit",
          hint:
            "The platform already delivered this unit — stop tracking the " +
            "account on this listing so the finding clears.",
        };
      }
      // Gameflip bakes the account's credentials into the live offer, so there
      // is no unit to detach and no pool line to pull: the offer itself is what
      // still promises spent drops. Taking it down and republishing from healthy
      // stock is the only way to stop the next buyer receiving an account whose
      // drops are already connected — and without this branch the finding had no
      // plan at all and sat open forever.
      if (lst.marketplace === "gameflip" && lst.autoDeliver) {
        return {
          action: "retire",
          label: "Relist from fresh stock",
          hint:
            "These drops are already redeemed, so this offer cannot deliver " +
            "them. Take it down and republish with an account that still holds " +
            "the set.",
        };
      }
      return null;
    case "dead-token":
      if (active && f.accountId && lst.marketplace === "funpay") {
        return {
          action: "replace",
          label: "Replace account",
          hint:
            "Pull this account's line out of the FunPay auto-delivery pool " +
            "and feed in a fresh account with a live token.",
        };
      }
      // Digiseller can drop a single delivery unit, but only one whose
      // content_id we captured at feed time — the API has no way to list a
      // product's existing content, so units fed before that bookkeeping
      // existed are unreachable and get no button (delisting is the only
      // remedy for those). GGSel is excluded entirely: it can LIST units but
      // every delete shape is rejected (404 / INVALID_OPERATION).
      if (active && f.accountId && lst.marketplace === "digiseller") {
        const unit = (lst.units || []).find(
          (u) => u && String(u.accountId) === String(f.accountId) && u.contentId,
        );
        if (unit) {
          return {
            action: "replace",
            label: "Replace unit",
            hint:
              "Delete this account's delivery unit from the Digiseller " +
              "product and let the auto-feed put a fresh one in its place.",
          };
        }
      }
      return null;
    case "account-gone":
      // The login is gone from Twitch, so every platform has the same remedy:
      // get it off the listing, whatever "off" means there (Gameflip delists and
      // republishes from healthy stock, Digiseller drops the delivery unit,
      // GGSel/FunPay hand it back to the auto-feed). The suspension sweep does
      // this by itself — the button exists for the cases where its surgery
      // could not finish, e.g. the marketplace was down at the time.
      if (active && (f.accountId || f.accountLogin)) {
        return {
          action: "retire",
          label: "Take off sale",
          hint:
            "Remove this deleted account from the listing and let a fresh one " +
            "take its place — on Gameflip the offer is relisted with a live " +
            "account, elsewhere the auto-feed refills the unit.",
        };
      }
      return null;
    case "duplicate-account":
      // The same account is sellable on 2+ live listings, so whoever buys
      // second gets credentials someone else already owns. There is no button
      // for this today, which is why every duplicate reaches a human. The
      // remedy is asymmetric on purpose: ONE listing keeps the account (the one
      // that actually reserved it, see pickDuplicateLoser) and the others give
      // it up, so the fix never takes the whole game off sale when a refill
      // exists. A finding with no accountId can't be acted on — the row-level
      // login match is ambiguous across platforms.
      if (f.accountId || f.accountLogin) {
        return {
          action: "dedupe",
          label: "Resolve duplicate",
          hint:
            "Keep the listing that reserved this account and pull it off the " +
            "others, refilling them from free stock. A listing left with " +
            "nothing to sell goes off sale.",
        };
      }
      return null;
    case "claim-mismatch":
      if (active && f.accountId) {
        return {
          action: "reserve",
          label: "Fix reservation",
          hint:
            "Re-reserve this game's drops for this listing. If another sale " +
            "really holds them, a FunPay account is replaced instead.",
        };
      }
      return null;
    case "restock-failed":
    case "stock-unknown":
      if (active && isQtyListing(lst)) {
        return {
          action: "refeed",
          label: "Retry restock",
          hint: "Run the auto-feed for this listing right now.",
        };
      }
      return null;
    default:
      return null;
  }
}

// Remove one account from a listing row's tracked id/login lists, optionally
// appending a replacement.
async function swapOnListing(listing, badId, badLogin, fresh) {
  const ids = splitIds(listing.accountId).filter(
    (x) => x !== String(badId || ""),
  );
  const badLower = String(badLogin || "").trim().toLowerCase();
  const logins = splitIds(listing.accountLogin).filter(
    (x) => !badLower || x.toLowerCase() !== badLower,
  );
  if (fresh) {
    ids.push(String(fresh.accountId));
    logins.push(fresh.login);
  }
  await MarketplaceListing.updateOne(
    { _id: listing._id },
    { $set: { accountId: ids.join(","), accountLogin: logins.join(", ") } },
  );
}

// Claim a replacement account for the set that is actually deliverable:
// skips candidates whose token is known-dead (a dead-for-dead swap would just
// re-raise the finding) and releases the ones we don't use.
async function claimFreshAccount(set, notAccountId) {
  const claimed = await fpFulfiller.claimAccountsForSet(set, 3);
  let fresh = null;
  const spare = [];
  for (const c of claimed) {
    if (fresh || String(c.accountId) === String(notAccountId || "")) {
      spare.push(c.accountId);
      continue;
    }
    const a = await BotAccount.findById(c.accountId, {
      lastScanStatus: 1,
    }).lean();
    if (a && accountState.isUnusableScanStatus(a.lastScanStatus)) {
      spare.push(c.accountId);
      continue;
    }
    fresh = c;
  }
  if (spare.length) await fpFulfiller.releaseAccounts(spare);
  return fresh;
}

// ------------------------------------------------------------------
// The fixes
// ------------------------------------------------------------------
// Digiseller: drop the one bad delivery unit, then let the auto-feed refill
// the gap. Ordering matters — the unit is removed from the PLATFORM first, so
// a failure there leaves our bookkeeping untouched and the fix simply retries.
// Only ever touches the single content_id recorded for this account.
async function fixReplaceDigisellerUnit(f, listing) {
  const unit = (listing.units || []).find(
    (u) => u && String(u.accountId) === String(f.accountId) && u.contentId,
  );
  if (!unit) {
    throw httpError(
      400,
      "No delivery unit was recorded for this account, so the single bad " +
        "unit cannot be targeted — Digiseller offers no way to list existing " +
        "content. Delist and republish this product instead.",
    );
  }
  await mp.digisellerRemoveContent(listing.externalId, unit.contentId);
  await MarketplaceListing.updateOne(
    { _id: listing._id },
    { $pull: { units: { contentId: String(unit.contentId) } } },
  );
  await swapOnListing(listing, f.accountId, f.accountLogin, null);
  let fed = 0;
  try {
    fed = await guardian.feedOne(String(listing._id));
  } catch {
    fed = 0;
  }
  return (
    "Removed " +
    (f.accountLogin || f.accountId) +
    "'s delivery unit from Digiseller " +
    listing.externalId +
    (fed > 0
      ? " and fed " + fed + " fresh account(s) in its place."
      : " — the auto-feed will refill it on the next pass.")
  );
}

async function fixReplace(f, listing) {
  if (listing.marketplace === "digiseller") {
    return fixReplaceDigisellerUnit(f, listing);
  }
  if (listing.marketplace !== "funpay") {
    throw httpError(400, "Replace is only supported for FunPay listings");
  }
  const set = await DropSet.findById(listing.set).lean();
  if (!set) throw httpError(400, "The listing's drop set no longer exists");
  const bad = await BotAccount.findById(f.accountId, {
    login: 1,
    credUsername: 1,
  }).lean();
  const badLogins = [
    ...new Set(
      [bad && bad.login, bad && bad.credUsername, f.accountLogin]
        .map((s) => String(s || "").trim())
        .filter(Boolean),
    ),
  ];
  if (!badLogins.length) {
    throw httpError(
      400,
      "Cannot identify the account's login to pull its delivery line",
    );
  }
  const badLabel = badLogins[0];
  const fresh = await claimFreshAccount(set, f.accountId);
  let upd;
  try {
    upd = await mp.funpayUpdateSecrets(listing.externalId, listing.externalNode, {
      removeLogins: badLogins,
      addLines: fresh ? [fresh.line] : [],
      activate: listing.status === "active",
    });
  } catch (e) {
    if (fresh) await fpFulfiller.releaseAccounts([fresh.accountId]);
    throw e;
  }
  if (!upd.removed && !fresh) {
    throw httpError(
      400,
      "Account " +
        badLabel +
        "'s line was already delivered to a buyer, and no unsold account " +
        "holds this bundle to restock with — nothing to change.",
    );
  }
  // Reservation bookkeeping on the bad account:
  //  - redeemed-drops with the line still in the pool: nobody bought it, so
  //    free this set's FunPay reservation (its connected drops stay
  //    unsellable on their own).
  //  - redeemed-drops already delivered: a real sale — the buyer owns those
  //    drops, keep the reservation.
  //  - dead-token: keep the reservation as a quarantine either way. Released,
  //    the account would go straight back into the sellable pool and could be
  //    re-claimed by any channel with a possibly-wrong password; a rescan
  //    that clears the token frees a human to release it from the pool page.
  if (f.type === "redeemed-drops" && upd.removed > 0) {
    await releaseSetForAccounts(
      [f.accountId],
      String(set._id),
      guardian.CLAIM_TAGS.funpay,
    );
  }
  await swapOnListing(listing, f.accountId, badLabel, fresh);
  let msg;
  if (upd.removed > 0 && fresh) {
    msg =
      "Replaced " +
      badLabel +
      " with " +
      fresh.login +
      " on FunPay " +
      listing.externalId +
      " — the burned line was pulled from the undelivered pool (now " +
      upd.pool +
      " line(s)).";
  } else if (!upd.removed && fresh) {
    msg =
      badLabel +
      "'s line was already delivered (a real sale) — restocked FunPay " +
      listing.externalId +
      " with " +
      fresh.login +
      " (pool now " +
      upd.pool +
      " line(s)).";
  } else {
    msg =
      "Pulled " +
      badLabel +
      "'s line from FunPay " +
      listing.externalId +
      "; no unsold account holds this bundle, so nothing replaced it" +
      (upd.pool === 0 ? " — the offer is now off sale (empty pool)." :
        " (pool now " + upd.pool + " line(s)).");
  }
  if (f.type === "dead-token") {
    msg +=
      " " +
      badLabel +
      " stays reserved as a quarantine — rescan it and release it from the " +
      "account pool if its password still works.";
  }
  return msg;
}

async function fixReserve(f, listing) {
  const set = await DropSet.findById(listing.set).lean();
  if (!set) throw httpError(400, "The listing's drop set no longer exists");
  const tag =
    guardian.CLAIM_TAGS[listing.marketplace] || listing.marketplace;
  // Clear any partial rows we already hold so the re-reserve is all-or-
  // nothing (reserveSetOnAccount only counts rows it stamped this instant).
  await releaseSetForAccounts([f.accountId], String(set._id), tag);
  const ok = await reserveSetOnAccount(f.accountId, set, {
    soldToUsername: tag,
    soldSetId: String(set._id),
  });
  if (ok) {
    return (
      "Re-reserved " +
      (f.accountLogin || f.accountId) +
      "'s drops for this " +
      listing.marketplace +
      " listing (tag " +
      tag +
      ")."
    );
  }
  if (listing.marketplace === "funpay") {
    return await fixReplace(f, listing);
  }
  throw httpError(
    409,
    "Could not re-reserve — another sale holds these drops, and a " +
      listing.marketplace +
      " code that is already on the platform can't be pulled back. Check " +
      "the conflicting listing, then resolve manually.",
  );
}

// Pure: of the live listings that all sell the same account, which one KEEPS it
// and which must give it up. Split out from fixDedupe so the tie-breaking is
// testable without a database.
//
// The keeper is the listing the account is genuinely committed to. In order:
//   1. it holds the account under its own claim tag (a real reservation beats
//      an incidental row reference),
//   2. it already delivered units the platform can't take back (digiseller /
//      ggsel rows carrying a recorded contentId) — pulling those is either
//      impossible or throws away a sold unit,
//   3. it is the oldest listing (stable, and the one most likely to have sales
//      history / a ranked URL worth keeping).
// Everything else is a loser and gives the account up. Exported for tests.
function pickDuplicateLoser(listings, { reservedListingId = "" } = {}) {
  const live = (listings || []).filter((l) => l && l.status === "active");
  if (live.length < 2) return { keep: live[0] || null, losers: [] };
  const score = (l) => {
    let s = 0;
    if (reservedListingId && String(l._id) === String(reservedListingId)) s += 100;
    if ((l.units || []).some((u) => u && u.contentId)) s += 10;
    return s;
  };
  const sorted = [...live].sort((a, b) => {
    const d = score(b) - score(a);
    if (d) return d;
    const at = new Date(a.createdAt || 0).getTime();
    const bt = new Date(b.createdAt || 0).getTime();
    if (at !== bt) return at - bt; // older first
    return String(a._id).localeCompare(String(b._id)); // deterministic
  });
  return { keep: sorted[0], losers: sorted.slice(1) };
}

// duplicate-account: the same account is on 2+ live listings, so a second buyer
// would be handed credentials that are already sold. Keep it on exactly one
// listing and pull it off the rest with the same per-marketplace surgery the
// suspension sweep uses; each stripped listing is then refilled from free stock,
// and only a listing left with nothing to sell goes off sale.
async function fixDedupe(f) {
  const { detachAccountFromListing } = require("./listingDetach");
  const accId = String(f.accountId || "");
  const login = String(f.accountLogin || "").trim();
  const or = [];
  if (accId) or.push({ accountId: new RegExp("(^|,)\\s*" + accId + "\\s*(,|$)") });
  if (login) {
    or.push({
      accountLogin: new RegExp(
        "(^|,)\\s*" + login.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*(,|$)",
        "i",
      ),
    });
  }
  if (!or.length) throw httpError(400, "Finding has no account to de-duplicate");
  const listings = await MarketplaceListing.find({ status: "active", $or: or }).lean();
  if (listings.length < 2) {
    // The duplicate cleared on its own between the sweep and this fix.
    return (
      "No duplicate remains — " +
      (login || accId) +
      " is on " +
      listings.length +
      " live listing(s) now."
    );
  }
  // Which listing actually reserved this account? Its claim tag is the strongest
  // signal of ownership, so that listing keeps the account.
  let reservedListingId = "";
  for (const l of listings) {
    const tag = guardian.CLAIM_TAGS[l.marketplace] || l.marketplace;
    const set = l.set ? await DropSet.findById(l.set).lean() : null;
    if (!set) continue;
    const keys = [...new Set((set.items || []).map((i) => i.itemKey).filter(Boolean))];
    if (!keys.length) continue;
    const held = await DropLog.countDocuments({
      account: accId || null,
      itemKey: { $in: keys },
      soldAt: { $ne: null },
      soldToUsername: tag,
    });
    if (held > 0) {
      reservedListingId = String(l._id);
      break;
    }
  }
  const { keep, losers } = pickDuplicateLoser(listings, { reservedListingId });
  if (!keep || !losers.length) {
    throw httpError(409, "Could not decide which listing should keep the account");
  }
  const notes = [];
  const warns = [];
  for (const loser of losers) {
    const res = await detachAccountFromListing(
      loser,
      { _id: accId, login },
      { reason: "sold on another listing", republish: true, hardRepublish: false },
    );
    if (res.detached.length) notes.push(...res.detached);
    if (res.warnings.length) warns.push(...res.warnings);
  }
  if (!notes.length) {
    throw httpError(
      409,
      warns.join(" ") ||
        "Could not pull the account off the duplicate listing(s) — resolve manually.",
    );
  }
  return (
    "Kept " +
    (login || accId) +
    " on " +
    keep.marketplace +
    " " +
    (keep.externalId || keep._id) +
    " and pulled it off " +
    losers.length +
    " duplicate listing(s): " +
    notes.join("; ") +
    (warns.length ? " — " + warns.join("; ") : "")
  );
}

async function fixDetach(f, listing) {  await swapOnListing(listing, f.accountId, f.accountLogin, null);
  return (
    "Detached " +
    (f.accountLogin || f.accountId) +
    " from " +
    listing.marketplace +
    " " +
    listing.externalId +
    " — the platform already delivered this unit, its reservation stays " +
    "with the buyer."
  );
}

// Retire a deleted (suspended) account from a live listing, using the same
// per-marketplace surgery the suspension sweep and the drop-archive "mark sold"
// flow perform. Partial success is reported rather than thrown: on Gameflip the
// offer can come down cleanly and still fail to republish when no unsold account
// holds the bundle, and taking it off sale is the part that protects the buyer.
async function fixRetire(f, listing) {
  const { detachAccountFromListing } = require("./listingDetach");
  // Two findings share this action and they are not the same situation. An
  // account-gone login no longer exists on Twitch, so the account is worthless
  // and a hard republish is right. A redeemed-drops account is perfectly alive —
  // only its drops for this set are spent — so it must not be written off as
  // suspended, and the reason is recorded honestly because it ends up in the
  // listing's audit trail.
  const spent = f.type === "redeemed-drops";
  const res = await detachAccountFromListing(
    listing,
    { _id: f.accountId, login: f.accountLogin },
    {
      reason: spent ? "drops already redeemed" : "suspended on Twitch",
      republish: true,
      hardRepublish: !spent,
    },
  );
  if (!res.detached.length) {
    throw httpError(
      409,
      res.warnings.join(" ") ||
        "Could not take the account off this listing — remove it on the " +
          "marketplace manually.",
    );
  }
  return (
    "Retired " +
    (f.accountLogin || f.accountId) +
    (spent ? " (drops already redeemed): " : " (gone from Twitch): ") +
    res.detached.join("; ") +
    (res.warnings.length ? " — " + res.warnings.join("; ") : "")
  );
}

async function fixRefeed(f, listing) {
  const fed = await guardian.feedOne(String(listing._id));
  if (fed > 0) {
    return (
      "Fed " +
      fed +
      " fresh account(s) to " +
      listing.marketplace +
      " " +
      listing.externalId +
      "."
    );
  }
  throw httpError(
    409,
    "The feed ran but added nothing — either the platform stock is already " +
      "at target, stock is unreadable, or no unsold account holds this " +
      "bundle. The finding refreshes on the next pass.",
  );
}

// ------------------------------------------------------------------
// Entry point
// ------------------------------------------------------------------
async function fixFinding(id) {
  const f = await AuditFinding.findById(id);
  if (!f) throw httpError(404, "Finding not found");
  if (f.status !== "open" && f.status !== "needs-human") {
    throw httpError(400, "Finding is not open — reopen it first");
  }
  const listing = f.listing
    ? await MarketplaceListing.findById(f.listing).lean()
    : null;
  const plan = fixPlanFor(f, listing);
  if (!plan) {
    throw httpError(
      400,
      "No automatic fix applies to this finding — resolve it manually",
    );
  }
  let message;
  if (plan.action === "replace") message = await fixReplace(f, listing);
  else if (plan.action === "reserve") message = await fixReserve(f, listing);
  else if (plan.action === "detach") message = await fixDetach(f, listing);
  else if (plan.action === "retire") message = await fixRetire(f, listing);
  else if (plan.action === "dedupe") message = await fixDedupe(f);
  else message = await fixRefeed(f, listing);

  f.status = "resolved";
  f.resolution = "auto-fixed: " + message;
  f.resolvedAt = new Date();
  await f.save();
  // Log the fix as an already-resolved activity row (same pattern as the
  // guardian's "restocked" entries) so the Resolved / activity log shows it.
  await AuditFinding.create({
    type: "fixed",
    severity: "info",
    marketplace: f.marketplace,
    listing: f.listing,
    accountId: f.accountId,
    accountLogin: f.accountLogin,
    dedupeKey: "fixed:" + f._id + ":" + Date.now(),
    status: "resolved",
    resolution: "auto-fixed",
    resolvedAt: new Date(),
    message,
  }).catch(() => {});
  return { message, action: plan.action };
}

module.exports = { fixPlanFor, fixFinding, pickDuplicateLoser };
