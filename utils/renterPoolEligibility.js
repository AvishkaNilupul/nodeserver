// Eligibility for auto-picking an account pool (AvailableAccount) row to hand
// to a renter. The operator wants "a full functional account which hasn't been
// used and everything perfect", and — critically — the pick must never disturb
// auto-farm, which redeploys from the same pool. So an account qualifies only
// when it is BOTH pristine (deployable + verified) AND completely unentangled
// from auto-farm / fulfilment.
//
// This is a PURE function: the route gathers the facts from the DB in bulk and
// passes them in, so the rule is unit-testable without a database (mirrors the
// utils/gameLabel.js pattern). Facts, per candidate:
//   status               AvailableAccount.status ("available" | "claimed")
//   clientSecret         the Twitch auth token (must be present to deploy)
//   hasPassword          AvailableAccount.hasPassword
//   passwordDecryptable  caller decrypted the stored password to a non-empty string
//   lastCheckStatus      last pool check ("ok" | "" | "token_invalid" | ...)
//   deployedOnBot        a BotAccount with this token has a non-empty configFile
//   hasSoldOrReservedDrops a BotAccount with this token carries sold/reserved/connected drops
//   sellable             a BotAccount with this token has a non-empty credPassword
//   inAssignedAccounts   its login sits in some AutoFarmTask.assignedAccounts
//   onActiveListing      its login is attached to an active MarketplaceListing
function reject(reason) {
  return { eligible: false, reason };
}

function poolAccountEligibility(f) {
  f = f || {};
  if (f.status !== "available") return reject("already claimed");
  if (!f.clientSecret) return reject("no Twitch token");
  if (!f.hasPassword || !f.passwordDecryptable) return reject("no usable password");
  if (f.lastCheckStatus !== "ok") {
    return reject("token not verified (" + (f.lastCheckStatus || "unchecked") + ")");
  }
  if (f.deployedOnBot) return reject("already on an operator bot");
  if (f.hasSoldOrReservedDrops) return reject("carries sold/reserved drops");
  if (f.sellable) return reject("in sellable stock");
  if (f.inAssignedAccounts) return reject("assigned to an auto-farm task");
  if (f.onActiveListing) return reject("on an active marketplace listing");
  return { eligible: true, reason: "" };
}

function isEligible(f) {
  return poolAccountEligibility(f).eligible;
}

// How many accounts to actually move: never more than asked, never past the
// renter's quota, never more than are eligible. Coerces junk to a safe 0.
function pickCount({ requested, quotaRemaining, eligibleTotal } = {}) {
  const r = Math.max(0, Math.floor(Number(requested) || 0));
  const q = Math.max(0, Math.floor(Number(quotaRemaining) || 0));
  const e = Math.max(0, Math.floor(Number(eligibleTotal) || 0));
  return Math.min(r, q, e);
}

module.exports = { poolAccountEligibility, isEligible, pickCount };
