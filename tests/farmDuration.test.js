// Coverage for the farming-window duration parser (utils/farmDuration.js).
// The parser exists so an LLM coworker can turn "farm apex for 3 months" into
// the `farmDays` number the renter endpoints take — without guessing units and
// without silently applying an absurd window.
const test = require("node:test");
const assert = require("node:assert");

const { parseFarmDuration, MAX_SANE_DAYS } = require("../utils/farmDuration");

test("parses explicit day durations", () => {
  assert.strictEqual(parseFarmDuration("180 days").days, 180);
  assert.strictEqual(parseFarmDuration("30d").days, 30);
  assert.strictEqual(parseFarmDuration("1 day").days, 1);
});

test("a bare number means DAYS (the unit every renter endpoint uses)", () => {
  const r = parseFarmDuration("180");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.days, 180);
  assert.strictEqual(r.unit, "days");
});

test("parses weeks, months and years", () => {
  assert.strictEqual(parseFarmDuration("2 weeks").days, 14);
  assert.strictEqual(parseFarmDuration("3 months").days, 90);
  assert.strictEqual(parseFarmDuration("6 months").days, 180);
  assert.strictEqual(parseFarmDuration("1 year").days, 365);
  assert.strictEqual(parseFarmDuration("6mo").days, 180);
});

test("'180 months' parses faithfully but is FLAGGED, not silently applied", () => {
  // The operator's own phrasing. 180 months is ~15 years — almost certainly a
  // slip for "180 days". We must not clamp silently (that would do something
  // they never asked for) and must not provision it blind either.
  const r = parseFarmDuration("180 months");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.days, 5400);
  assert.ok(r.warning, "an absurd window must carry a warning");
  assert.match(r.warning, /180 days/); // suggests the likely intent
});

test("a normal window carries no warning", () => {
  assert.strictEqual(parseFarmDuration("180 days").warning, "");
  assert.strictEqual(parseFarmDuration("12 months").warning, "");
});

test("the sanity threshold is the boundary, not an off-by-one", () => {
  assert.strictEqual(parseFarmDuration(`${MAX_SANE_DAYS} days`).warning, "");
  assert.ok(parseFarmDuration(`${MAX_SANE_DAYS + 1} days`).warning);
});

test("minutes/hours are REJECTED as watch-time, not treated as a window", () => {
  // The likeliest dangerous confusion: drop watch-time (minutes) vs the farming
  // window (days). Guessing here would create a 180-day lease from "180 minutes".
  for (const s of ["180 minutes", "180 min", "3 hours", "90m"]) {
    const r = parseFarmDuration(s);
    assert.strictEqual(r.ok, false, `${s} must not parse to a window`);
    assert.match(r.reason, /watch-time/);
  }
});

test("rejects junk, empty and non-positive input", () => {
  for (const s of ["", "   ", null, undefined, "soon", "abc days", "-5 days", "0 days"]) {
    assert.strictEqual(parseFarmDuration(s).ok, false, `${JSON.stringify(s)} must be rejected`);
  }
});

test("rejects an unknown unit rather than defaulting", () => {
  const r = parseFarmDuration("5 fortnights");
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /unknown duration unit/);
});
