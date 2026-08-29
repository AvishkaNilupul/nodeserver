// Pure eligibility rule for the manual spent-account review tab. The route
// gathers all facts in bulk; keeping this function DB-free makes every guard
// easy to test and keeps the write path fail-closed.
function cooldownPassedAt(newestDeliveredAt, cooldownDays, now) {
  if (!newestDeliveredAt) return false;
  const delivered = new Date(newestDeliveredAt).getTime();
  const current = new Date(now == null ? Date.now() : now).getTime();
  if (!Number.isFinite(delivered) || !Number.isFinite(current)) return false;
  const days = Math.max(0, Number(cooldownDays) || 0);
  return current - delivered >= days * 86400000;
}

function spentAccountEligibility(facts = {}) {
  const reject = (reason) => ({
    recyclable: false,
    reason,
    cooldownPassed: false,
  });
  const note = String(facts.claimedNote || "").trim();
  // Accounts pulled out of the standalone no-claim bots (sold/connected) have
  // no DropLog delivery history — the spent signal IS the pool-row stamp the
  // no-claim remove writes. For those, "delivered" is implied, the cooldown is
  // anchored to the removal, and any DropLog "available" rows are stale
  // pre-delivery snapshots (the account is connected/sold, so the drops are on
  // the buyer's side), so they become recyclable immediately instead of being
  // rejected forever on "no delivered drops" / "still has N drops left to
  // sell" / "within the 14-day cooldown". Every other guard still applies
  // (rented, recycled, on listing, deployed, sold-but-undelivered drops).
  const noClaimSpent = !!facts.noClaimSpent;
  if (/^rented to/i.test(note)) return reject("rented to a renter");
  if (/^recycled/i.test(note)) return reject("already recycled");
  if ((Number(facts.availableDrops) || 0) > 0 && !noClaimSpent) {
    return reject("still has " + Number(facts.availableDrops) + " drop(s) left to sell");
  }
  if ((Number(facts.deliveredDrops) || 0) < 1 && !noClaimSpent) {
    return reject("no delivered drops");
  }
  if ((Number(facts.soldUnconnectedDrops) || 0) > 0) {
    return reject(
      "has " + Number(facts.soldUnconnectedDrops) + " sold drop(s) awaiting delivery",
    );
  }
  if (facts.onActiveListing) return reject("on an active marketplace listing");
  if (facts.deployed) return reject("still deployed to a bot");

  const passed = noClaimSpent
    ? true
    : cooldownPassedAt(facts.newestDeliveredAt, facts.cooldownDays, facts.now);
  return {
    recyclable: passed,
    reason: passed ? "" : "within the " + (Number(facts.cooldownDays) || 0) + "-day cooldown",
    cooldownPassed: passed,
  };
}

module.exports = { spentAccountEligibility, cooldownPassed: cooldownPassedAt };
