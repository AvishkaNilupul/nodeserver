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
function fixPlanFor(f, listing) {
  if (!f || f.status !== "open") return null;
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

async function fixDetach(f, listing) {
  await swapOnListing(listing, f.accountId, f.accountLogin, null);
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
  const res = await detachAccountFromListing(
    listing,
    { _id: f.accountId, login: f.accountLogin },
    { reason: "suspended on Twitch", republish: true, hardRepublish: true },
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
    " (gone from Twitch): " +
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
  if (f.status !== "open") {
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

module.exports = { fixPlanFor, fixFinding };
