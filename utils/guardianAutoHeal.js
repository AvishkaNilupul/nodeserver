// Auto-heal: close the loop between the guardian FINDING a problem and someone
// FIXING it.
//
// The guardian has always detected well and repaired nothing — every finding
// waited for a human to press the Integrity tab's Fix button, so the same
// handful of failure modes (a suspended account still on sale, one account
// listed twice) had to be cleared by hand, over and over, while a buyer could
// be burned in the meantime. This module runs at the end of every guardian pass
// and presses that button itself, for the findings where the right answer is
// not a judgement call.
//
// What keeps that safe:
//   * only HEALABLE_TYPES are ever touched. orphaned-reservation is
//     deliberately excluded — those reservations belong to real buyers, and
//     releasing one would hand a paid-for account back to the sellable pool.
//   * a finding must survive one pass (MIN_AGE_MS) before it is healed, so a
//     condition that autoResolveStale would have cleared by itself is never
//     "fixed" with marketplace surgery.
//   * MAX_PER_PASS bounds how much a single pass can change, and each finding
//     gets MAX_ATTEMPTS tries before it is parked as needs-human. Together they
//     stop a systemic outage (a marketplace 500ing every call) from turning
//     into hundreds of retries per hour.
//   * the fixes themselves are the ones the Fix button already used, so
//     healing takes the same code path a human would, warnings and all.
//
// Off switches, both read at call time so neither needs a redeploy:
//   AUTO_HEAL_DISABLED=1  do nothing at all.
//   AUTO_HEAL_DRY=1       log the plan, change nothing.
const AuditFinding = require("../models/AuditFinding");
const MarketplaceListing = require("../models/MarketplaceListing");
const { fixPlanFor, fixFinding } = require("./guardianFixes");

// Types whose remedy is mechanical. Everything else stays for a human.
const HEALABLE_TYPES = [
  "account-gone",
  "duplicate-account",
  "claim-mismatch",
  "redeemed-drops",
  "dead-token",
];

// Supply-side findings: the guardian's own auto-feed already retries these on
// every pass, so "healing" one would just repeat a call that is already being
// made and failing. They are not broken bookkeeping — they are a marketplace
// that will not answer, or a bundle with no farmed stock behind it — and no
// amount of retrying invents an account. What they DO need is triage: one that
// has been failing for hours is not the same as one raised a minute ago, and
// leaving both as plain "open" is what makes the tab look stuck.
const SUPPLY_TYPES = ["stock-unknown", "restock-failed"];

// How long a supply finding may keep failing before it is escalated to a human.
const STALE_MS = Number(process.env.AUTO_HEAL_STALE_MS || 6 * 60 * 60 * 1000);

const MAX_PER_PASS = Number(process.env.AUTO_HEAL_MAX_PER_PASS || 10);
const MAX_ATTEMPTS = Number(process.env.AUTO_HEAL_MAX_ATTEMPTS || 3);
// One guardian tick is 5 minutes; a finding must outlive one to be healed.
const MIN_AGE_MS = Number(process.env.AUTO_HEAL_MIN_AGE_MS || 5 * 60 * 1000);

function disabled() {
  return String(process.env.AUTO_HEAL_DISABLED || "") === "1";
}

function dryRun() {
  return String(process.env.AUTO_HEAL_DRY || "") === "1";
}

// Pure: is this finding eligible to be healed right now, and why not if it
// isn't. `now` is injected so the age rule is testable. Exported for tests.
function healEligibility(f, now = Date.now()) {
  if (!f) return { ok: false, reason: "no finding" };
  if (f.status !== "open") return { ok: false, reason: "not open" };
  if (!HEALABLE_TYPES.includes(f.type)) {
    return { ok: false, reason: "type " + f.type + " is not auto-healable" };
  }
  if (Number(f.healAttempts || 0) >= MAX_ATTEMPTS) {
    return { ok: false, reason: "exhausted " + MAX_ATTEMPTS + " attempts" };
  }
  const age = now - new Date(f.detectedAt || f.createdAt || now).getTime();
  if (age < MIN_AGE_MS) {
    return { ok: false, reason: "too fresh — may clear on its own" };
  }
  return { ok: true, reason: "" };
}

// Record a failed attempt. Once a finding has burned through its attempts it is
// parked as needs-human: still visible in the tab, no longer retried, and
// clearly distinct from a problem nobody has looked at yet.
async function noteFailure(f, message) {
  const attempts = Number(f.healAttempts || 0) + 1;
  const update = {
    healAttempts: attempts,
    healLastError: String(message || "").slice(0, 500),
    healLastAttemptAt: new Date(),
  };
  if (attempts >= MAX_ATTEMPTS) {
    update.status = "needs-human";
    update.resolution =
      "auto-heal gave up after " +
      attempts +
      " attempts: " +
      String(message || "").slice(0, 300);
  }
  await AuditFinding.updateOne({ _id: f._id }, { $set: update });
  return attempts >= MAX_ATTEMPTS;
}

// Pure: has a supply-side finding been failing long enough to stop looking
// routine? `now` is injected so the rule is testable. Exported for tests.
function isStaleSupplyFinding(f, now = Date.now()) {
  if (!f || f.status !== "open") return false;
  if (!SUPPLY_TYPES.includes(f.type)) return false;
  const age = now - new Date(f.detectedAt || f.createdAt || now).getTime();
  return age >= STALE_MS;
}

// Escalate supply findings the auto-feed has been failing to clear for hours.
// Nothing is "fixed" here — the point is to stop a standing shortage from
// sitting in the same bucket as a problem the healer is actively working on, so
// the operator can see at a glance which rows actually want their hands.
async function triageSupplyFindings(now = Date.now()) {
  const rows = await AuditFinding.find({
    status: "open",
    type: { $in: SUPPLY_TYPES },
  })
    .limit(200)
    .lean();
  const escalated = [];
  for (const f of rows) {
    if (!isStaleSupplyFinding(f, now)) continue;
    const hours = Math.round(
      (now - new Date(f.detectedAt || f.createdAt || now).getTime()) / 3600000,
    );
    await AuditFinding.updateOne(
      { _id: f._id },
      {
        $set: {
          status: "needs-human",
          resolution:
            "auto-heal: the auto-feed has been retrying this for " +
            hours +
            "h without success — it needs stock or a platform fix, not another retry.",
          healLastError: String(f.message || "").slice(0, 500),
          healLastAttemptAt: new Date(),
        },
      },
    );
    escalated.push(
      "[" + f.type + " " + (f.marketplace || "-") + "] stuck " + hours + "h",
    );
  }
  return escalated;
}

// Heal what can be healed. Returns a summary the guardian folds into its pass
// result (and, when anything happened, its Telegram digest).
async function healOpenFindings() {
  if (disabled()) return { healed: 0, failed: 0, skipped: 0, parked: 0, notes: [] };
  const dry = dryRun();
  const now = Date.now();
  const open = await AuditFinding.find({
    status: "open",
    type: { $in: HEALABLE_TYPES },
  })
    .sort({ severity: 1, detectedAt: 1 })
    .limit(200)
    .lean();

  let healed = 0;
  let failed = 0;
  let skipped = 0;
  let parked = 0;
  const notes = [];

  for (const f of open) {
    if (healed + failed >= MAX_PER_PASS) {
      skipped += 1;
      continue;
    }
    const elig = healEligibility(f, now);
    if (!elig.ok) {
      skipped += 1;
      continue;
    }
    // Re-derive the plan against the CURRENT listing, exactly as the Fix button
    // does, so a finding whose listing was delisted or refilled since detection
    // is not acted on with stale assumptions.
    const listing = f.listing
      ? await MarketplaceListing.findById(f.listing).lean()
      : null;
    const plan = fixPlanFor(f, listing);
    if (!plan) {
      // Nothing mechanical applies right now. Usually transient — the listing
      // was delisted or refilled since detection — so no attempt is burned and
      // a later pass may find it fixable again.
      //
      // But a HEALABLE_TYPE that never produces a plan is a hole in the fix
      // table, not a transient state, and silently skipping it every five
      // minutes is exactly what makes the tab look stuck with an error nobody
      // fixes. After STALE_MS of being claimed-but-unfixable, say so out loud
      // and hand it over.
      const age = now - new Date(f.detectedAt || f.createdAt || now).getTime();
      if (age >= STALE_MS && !dry) {
        await AuditFinding.updateOne(
          { _id: f._id },
          {
            $set: {
              status: "needs-human",
              resolution:
                "auto-heal: this finding's type is auto-healable but no fix " +
                "applies to its listing (" +
                ((listing && listing.marketplace) || "listing missing") +
                "), and it has stood for " +
                Math.round(age / 3600000) +
                "h — it needs a human or a new fix path.",
              healLastError: "no fix plan applies",
              healLastAttemptAt: new Date(),
            },
          },
        );
        parked += 1;
        notes.push(
          "NEEDS-HUMAN [" +
            f.type +
            " " +
            (f.marketplace || "-") +
            "] no fix path after " +
            Math.round(age / 3600000) +
            "h",
        );
        continue;
      }
      skipped += 1;
      continue;
    }
    const label =
      "[" + f.type + " " + (f.marketplace || "-") + "/" + (f.accountLogin || "?") + "]";
    if (dry) {
      notes.push("WOULD " + plan.action + " " + label);
      skipped += 1;
      continue;
    }
    try {
      const r = await fixFinding(String(f._id));
      healed += 1;
      notes.push(r.action + " " + label + ": " + r.message);
    } catch (e) {
      failed += 1;
      const gaveUp = await noteFailure(f, e.message);
      if (gaveUp) parked += 1;
      notes.push("FAILED " + label + ": " + (e.message || e));
    }
  }

  // Supply-side findings are not healed, only triaged — see SUPPLY_TYPES. A dry
  // run must not reclassify anything either, so it only reports.
  let escalated = [];
  if (dry) {
    const rows = await AuditFinding.find({
      status: "open",
      type: { $in: SUPPLY_TYPES },
    })
      .limit(200)
      .lean();
    const stale = rows.filter((f) => isStaleSupplyFinding(f, now));
    escalated = stale.map((f) => "WOULD escalate [" + f.type + "]");
  } else {
    escalated = await triageSupplyFindings(now);
  }
  for (const note of escalated) notes.push("NEEDS-HUMAN " + note);

  return {
    healed,
    failed,
    skipped,
    parked,
    escalated: escalated.length,
    dry,
    notes,
  };
}

module.exports = {
  healOpenFindings,
  healEligibility,
  isStaleSupplyFinding,
  triageSupplyFindings,
  HEALABLE_TYPES,
  SUPPLY_TYPES,
  MAX_PER_PASS,
  MAX_ATTEMPTS,
};
