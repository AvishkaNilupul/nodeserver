// Parse a human farming duration ("180 days", "3 months", "2 weeks", "6mo") into
// the `farmDays` number the renter Quick-farm / from-pool paths already take.
//
// WHY THIS EXISTS: the operator asks in natural language ("farm apex legends for
// 180 months"), and an LLM coworker turning that into a number must not guess.
// Two properties matter:
//   1. Units are explicit. A bare number means DAYS (the unit every existing
//      renter endpoint uses — `farmDays`), never minutes or months.
//   2. An absurd result is FLAGGED, not silently applied. "180 months" is 5400
//      days (~15 years) — almost certainly a slip for "180 days". We still parse
//      it faithfully but set `warning`, so the caller (the coworker) confirms
//      instead of provisioning a 15-year lease. Clamping silently would be
//      worse: it would do something the operator never asked for.
//
// Pure + dependency-free so it is unit-testable without a DB or network.

// Twitch drop watch-time is measured in MINUTES; a farming window is measured in
// DAYS. They are different concepts and mixing them is the likeliest mistake, so
// minutes are recognised only to be REJECTED with a clear reason.
const UNITS = {
  day: 1, days: 1, d: 1,
  week: 7, weeks: 7, w: 7,
  month: 30, months: 30, mo: 30, mon: 30, mons: 30,
  year: 365, years: 365, y: 365, yr: 365, yrs: 365,
};
const MINUTE_UNITS = new Set(["minute", "minutes", "min", "mins", "m", "hour", "hours", "h", "hr", "hrs"]);

// Beyond this a farming window is almost certainly a misunderstanding.
const MAX_SANE_DAYS = 730; // 2 years

function parseFarmDuration(input) {
  const raw = String(input == null ? "" : input).trim().toLowerCase();
  if (!raw) return { ok: false, reason: "no duration given" };

  // "180 days", "180days", "180 d", or a bare "180".
  const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)$/);
  if (!m) return { ok: false, reason: `could not read a duration from "${input}"` };

  const value = Number(m[1]);
  const unit = m[2] || "day"; // bare number => days
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, reason: "duration must be a positive number" };
  }

  if (MINUTE_UNITS.has(unit)) {
    return {
      ok: false,
      reason:
        `"${input}" looks like watch-time, not a farming window. A farming ` +
        `window is how long the account keeps farming (days); Twitch drop ` +
        `watch-time (minutes/hours) is a property of the drop, not something ` +
        `set here. Say e.g. "180 days" if you meant the window.`,
    };
  }

  const perUnit = UNITS[unit];
  if (!perUnit) return { ok: false, reason: `unknown duration unit "${unit}"` };

  const days = Math.round(value * perUnit);
  if (days <= 0) return { ok: false, reason: "duration rounds to zero days" };

  const out = { ok: true, days, value, unit: canonicalUnit(unit), warning: "" };
  if (days > MAX_SANE_DAYS) {
    const years = (days / 365).toFixed(1);
    out.warning =
      `${value} ${canonicalUnit(unit)} = ${days} days (~${years} years), which is ` +
      `far longer than a normal farming window. If you meant ${value} days, say ` +
      `"${value} days". Confirm before applying.`;
  }
  return out;
}

function canonicalUnit(u) {
  const n = UNITS[u];
  if (n === 1) return "days";
  if (n === 7) return "weeks";
  if (n === 30) return "months";
  if (n === 365) return "years";
  return u;
}

module.exports = { parseFarmDuration, MAX_SANE_DAYS };
