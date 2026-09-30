// The coworker's ACT layer — capabilities it carries out ITSELF, server-side,
// without waiting for the operator to tap anything.
//
// Everything before this was propose-only: the coworker filed a recommendation
// and the operator's browser executed it. That is safe but slow, and it is not
// what an actual coworker does. This module is the other half: real autonomy,
// with the guardrails that make autonomy survivable rather than a liability.
//
// THE TIER MODEL (the whole safety story)
// Autonomy is not "may do anything". Each capability declares a tier:
//   * "auto"    — the coworker performs it immediately. Only for work that is
//                 REVERSIBLE, BOUNDED (a hard cap on blast radius) and AUDITED.
//   * "confirm" — the coworker may NEVER perform it. Attempting one returns a
//                 refusal telling it to file a proposal instead, which routes
//                 into the existing one-tap Approve & run flow. So the approval
//                 path we already built becomes the confirm tier, unchanged.
// Adding a capability is therefore an explicit, reviewed decision — a new entry
// here — never an emergent side effect of the model getting cleverer.
//
// WHY THE CAP MATTERS
// The brain is a small model on a third-party reseller and it does sometimes get
// confused. A confused model with unbounded write access is a bad day; a
// confused model that can, at worst, claim 5 pool accounts (which are returnable)
// and write an audit row is a Tuesday. Bounds are what make the difference.
//
// MASTER SWITCH: settings.coworkerAutonomy, default OFF. Until it is turned on
// this module executes nothing at all, so deploying it changes no behaviour.
const settings = require("./settings");
const { logEvent } = require("./systemLog");
const operatorFarm = require("./operatorFarm");
const { parseFarmDuration } = require("./farmDuration");

// ---------------------------------------------------------------------------
// Capability registry
// ---------------------------------------------------------------------------
const ACTS = {
  // "Grab me a fresh account from the pool and farm Apex Legends for 180 days."
  // Reversible: the pool accounts are CLAIMED, not consumed — removing them from
  // the holder renter returns them to the pool.
  farm_fresh_account: {
    tier: "auto",
    maxCount: 5,
    describe: (a) =>
      `start ${a.count || 1} pristine pool account(s) farming "${a.game}" for ${a.days} day(s)`,
    undo:
      "Reversible: the accounts are claimed, not consumed. Remove them from the " +
      "'operator-selffarm' renter to return them to the pool.",
    run: (a, ctx) =>
      operatorFarm.farmFreshAccounts({
        game: a.game,
        days: a.days,
        count: a.count || 1,
        actor: ctx.actor,
      }),
  },
};

function listActs() {
  return Object.entries(ACTS).map(([name, a]) => ({
    name,
    tier: a.tier,
    maxCount: a.maxCount || null,
    undo: a.undo || "",
  }));
}

// ---------------------------------------------------------------------------
// Duration resolution — shared by any act that takes a farming window.
// Accepts either an explicit `days` number or a natural `duration` string.
// An absurd window (e.g. "180 months" => ~15 years) is REFUSED rather than
// applied, so a phrasing slip cannot become a 15-year lease.
// ---------------------------------------------------------------------------
function resolveDays(args) {
  if (args.duration != null && String(args.duration).trim() !== "") {
    const p = parseFarmDuration(args.duration);
    if (!p.ok) return { ok: false, error: p.reason };
    if (p.warning) {
      return {
        ok: false,
        error:
          p.warning +
          " I have NOT done anything. Confirm the exact window with the operator, " +
          "then call again with an explicit `days`.",
      };
    }
    return { ok: true, days: p.days };
  }
  const d = Math.floor(Number(args.days));
  if (!Number.isFinite(d) || d <= 0) {
    return { ok: false, error: "A positive farming window is required (`days`, or `duration` like \"30 days\")." };
  }
  return { ok: true, days: d };
}

// ---------------------------------------------------------------------------
// The executor
// ---------------------------------------------------------------------------
// Never throws: every outcome is JSON the model can reason about, matching the
// runTool contract in utils/aiTools.js.
async function runAct(name, rawArgs = {}, { actor = "coworker" } = {}) {
  const act = ACTS[name];
  if (!act) return { ok: false, error: `unknown action: ${name}` };

  if (!settings.getCoworkerAutonomy().enabled) {
    return {
      ok: false,
      blocked: "autonomy_off",
      error:
        "Autonomous actions are switched OFF, so I did nothing. The operator can " +
        "enable them with setAutoFarm({ coworkerAutonomy: true }) or from the AI " +
        "Chat settings. Until then, describe the change or file a proposal instead.",
    };
  }

  if (act.tier !== "auto") {
    return {
      ok: false,
      blocked: "needs_confirmation",
      error:
        `"${name}" is a confirm-tier action — I must not run it myself. File a ` +
        `proposal so the operator can approve it with one tap.`,
    };
  }

  const args = { ...rawArgs };

  // Resolve + bound the window.
  const d = resolveDays(args);
  if (!d.ok) return { ok: false, error: d.error };
  args.days = d.days;

  // Bound the blast radius.
  const c = checkCount(act, args.count);
  if (!c.ok) return { ok: false, error: c.error };
  args.count = c.count;

  const summary = safeDescribe(act, args);
  logEvent({
    category: "coworker",
    action: "act_started",
    actor,
    subject: name,
    detail: summary,
  });

  try {
    const result = await act.run(args, { actor });
    logEvent({
      category: "coworker",
      action: "act_done",
      actor,
      subject: name,
      count: Array.isArray(result && result.added) ? result.added.length : 0,
      detail: summary,
    });
    return { ok: true, action: name, did: summary, undo: act.undo || "", result };
  } catch (err) {
    const message = String((err && err.message) || err).slice(0, 300);
    logEvent({
      category: "coworker",
      action: "act_failed",
      actor,
      subject: name,
      detail: summary + " — " + message,
    });
    return { ok: false, action: name, attempted: summary, error: message };
  }
}

// Blast-radius bound. Pure, so the cap that keeps a confused model harmless is
// directly unit-testable rather than buried in the executor.
function checkCount(act, rawCount) {
  // Distinguish OMITTED (default to 1) from an explicit 0 or junk (refuse).
  // `Number(x) || 1` would quietly turn an explicit count:0 into 1 — doing work
  // that was not asked for.
  const omitted =
    rawCount === undefined || rawCount === null || String(rawCount).trim() === "";
  const want = omitted ? 1 : Math.floor(Number(rawCount));
  if (!Number.isFinite(want) || want <= 0) {
    return { ok: false, error: "count must be a positive number." };
  }
  if (act.maxCount && want > act.maxCount) {
    return {
      ok: false,
      error:
        `I can do at most ${act.maxCount} per action (asked for ${want}). Run it in ` +
        `batches, or have the operator do a larger batch from the console.`,
    };
  }
  return { ok: true, count: want };
}

function safeDescribe(act, args) {
  try {
    return act.describe ? act.describe(args) : "";
  } catch {
    return "";
  }
}

module.exports = { runAct, listActs, resolveDays, checkCount, ACTS };
