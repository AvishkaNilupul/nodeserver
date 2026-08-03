// Whether a fully-sold-out account may be recycled back into farming.
//
// Normally auto-farm SPARES sold/connected accounts from recycling because the
// buyer holds their login:password (utils/autoFarmer.js unrecyclableLogins).
// This opt-in path reuses them anyway — but only once we can prove the account
// is spent, fully delivered, past a cooldown, and (checked separately, live)
// still ours. Buyers sometimes change the password, so nothing here is trusted
// without the caller's fresh rescan on top.
//
// PURE function: the sweep gathers the facts from the DB in bulk and passes
// them in, so the rule is unit-testable without a database (mirrors
// utils/gameLabel.js / utils/renterPoolEligibility.js). Facts per candidate:
//   claimedNote          AvailableAccount.claimedNote (exclude rentals / already-recycled)
//   availableDrops       count of still-sellable drops (dropReservation.AVAILABLE_DROP)
//   connectedDrops       count of connected (buyer-redeemed) drops
//   soldUnconnectedDrops count of soldAt!=null drops NOT yet connected (delivery pending)
//   onActiveListing      account is attached to a live marketplace listing
//   enabledInLiveTask    account is still enabled in a running farm bot
//   newestDeliveredAt    newest connected/sold drop time (Date|string|null) — for cooldown
//   cooldownDays         required cooldown in days
//   now                  optional "now" for deterministic tests
function reject(reason) {
  return { eligible: false, reason };
}

// A note we must never touch: an active rental.
function isRentalNote(n) {
  return /^rented to/i.test(String(n || "").trim());
}
// Already recycled once — don't loop on it.
function isRecycledNote(n) {
  return /^recycled/i.test(String(n || "").trim());
}

// True once `days` have fully elapsed since the newest delivery.
function cooldownPassed(newestDeliveredAt, days, now) {
  if (!newestDeliveredAt) return false;
  const t = new Date(newestDeliveredAt).getTime();
  if (!Number.isFinite(t)) return false;
  const n = now != null ? new Date(now).getTime() : Date.now();
  const ms = Math.max(0, Number(days) || 0) * 86400000;
  return n - t >= ms;
}

function recycleEligibility(f) {
  f = f || {};
  if (isRentalNote(f.claimedNote)) return reject("rented to a renter");
  if (isRecycledNote(f.claimedNote)) return reject("already recycled");
  if ((f.availableDrops || 0) > 0) {
    return reject("still has " + f.availableDrops + " drop(s) left to sell");
  }
  if ((f.connectedDrops || 0) <= 0) {
    return reject("no connected drops — never delivered to a buyer");
  }
  if ((f.soldUnconnectedDrops || 0) > 0) {
    return reject(
      "has " + f.soldUnconnectedDrops + " sold drop(s) the buyer hasn't connected yet",
    );
  }
  if (f.onActiveListing) return reject("on an active marketplace listing");
  if (f.enabledInLiveTask) return reject("still enabled in a live farm bot");
  if (!cooldownPassed(f.newestDeliveredAt, f.cooldownDays, f.now)) {
    return reject("within the " + (f.cooldownDays || 0) + "-day cooldown");
  }
  return { eligible: true, reason: "" };
}

module.exports = { recycleEligibility, cooldownPassed, isRentalNote, isRecycledNote };
