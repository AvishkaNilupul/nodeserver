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
  if (/^rented to/i.test(note)) return reject("rented to a renter");
  if (/^recycled/i.test(note)) return reject("already recycled");
  if ((Number(facts.availableDrops) || 0) > 0) {
    return reject("still has " + Number(facts.availableDrops) + " drop(s) left to sell");
  }
  if ((Number(facts.deliveredDrops) || 0) < 1) return reject("no delivered drops");
  if ((Number(facts.soldUnconnectedDrops) || 0) > 0) {
    return reject(
      "has " + Number(facts.soldUnconnectedDrops) + " sold drop(s) awaiting delivery",
    );
  }
  if (facts.onActiveListing) return reject("on an active marketplace listing");
  if (facts.deployed) return reject("still deployed to a bot");

  const passed = cooldownPassedAt(
    facts.newestDeliveredAt,
    facts.cooldownDays,
    facts.now,
  );
  return {
    recyclable: passed,
    reason: passed ? "" : "within the " + (Number(facts.cooldownDays) || 0) + "-day cooldown",
    cooldownPassed: passed,
  };
}

module.exports = { spentAccountEligibility, cooldownPassed: cooldownPassedAt };
