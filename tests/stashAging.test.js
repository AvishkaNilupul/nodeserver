// Account aging turns a freshly-made stash account into one with some history
// behind it before it reaches the pool. Two things must hold no matter what:
// a set nobody opted in is never touched, and an account only matures when ALL
// three gates pass. These lock both down, plus the gap arithmetic the UI shows.
const test = require("node:test");
const assert = require("node:assert");

const { policyOf, isMature, maturityGaps } = require("../utils/stashAging");

const DAY = 86400000;
const daysAgo = (d) => new Date(Date.now() - d * DAY);

// A policy with easy-to-reason-about gates: 14 days, 10 sessions, 240 minutes.
const policy = () => policyOf({ aging: { enabled: true } });

// An account that clears every gate comfortably.
const ripe = () => ({
  createdAt: daysAgo(20),
  aging: { stage: "active", sessions: 12, watchMinutes: 300 },
});

// ---------------------------------------------------------------- opt-out

test("a set with no aging field at all is disabled", () => {
  // This is every set that existed before the feature shipped. If this ever
  // returns enabled:true, the runner starts working on accounts nobody
  // signed up.
  const p = policyOf({ name: "browser-automator" });
  assert.equal(p.enabled, false);
});

test("a set with an empty aging object is disabled", () => {
  assert.equal(policyOf({ aging: {} }).enabled, false);
});

test("dry run defaults ON, auto-graduate defaults OFF", () => {
  // Both defaults point the same way: switching aging on should not, by
  // itself, send a single request to Twitch or move a single account.
  const p = policyOf({ aging: { enabled: true } });
  assert.equal(p.dryRun, true);
  assert.equal(p.autoGraduate, false);
});

test("avoiding drop-enabled channels is the default", () => {
  assert.equal(policyOf({ aging: { enabled: true } }).avoidDropChannels, true);
});

test("an explicit false is preserved, not overwritten by the default", () => {
  const p = policyOf({ aging: { enabled: true, dryRun: false, avoidDropChannels: false } });
  assert.equal(p.dryRun, false);
  assert.equal(p.avoidDropChannels, false);
});

test("a zero is preserved rather than falling back to the default", () => {
  // ?? not || — followTarget 0 means "no follows", and must not silently
  // become 3.
  assert.equal(policyOf({ aging: { enabled: true, followTarget: 0 } }).followTarget, 0);
  assert.equal(policyOf({ aging: { enabled: true, minDays: 0 } }).minDays, 0);
});

// ------------------------------------------------------------ the gates

test("an account clearing every gate is mature", () => {
  assert.equal(isMature(ripe(), policy()), true);
});

test("old enough but too few sessions is not mature", () => {
  const a = ripe();
  a.aging.sessions = 9;
  assert.equal(isMature(a, policy()), false);
});

test("old enough and enough sessions but too few minutes is not mature", () => {
  const a = ripe();
  a.aging.watchMinutes = 239;
  assert.equal(isMature(a, policy()), false);
});

test("plenty of sessions and minutes but too young is not mature", () => {
  // The one that matters most: you cannot rush calendar age by farming
  // sessions at it. An account created yesterday is a day old however many
  // hours it watched.
  const a = ripe();
  a.createdAt = daysAgo(3);
  assert.equal(isMature(a, policy()), false);
});

test("an account that only sat there, never watching, is not mature", () => {
  const a = { createdAt: daysAgo(90), aging: { stage: "active", sessions: 0, watchMinutes: 0 } };
  assert.equal(isMature(a, policy()), false);
});

test("an account with no aging state at all is not mature", () => {
  assert.equal(isMature({ createdAt: daysAgo(90) }, policy()), false);
});

test("gates of zero mature immediately", () => {
  const p = policyOf({
    aging: { enabled: true, minDays: 0, minSessions: 0, minWatchMinutes: 0 },
  });
  assert.equal(isMature({ createdAt: new Date(), aging: {} }, p), true);
});

// -------------------------------------------------------------- the gaps

test("gaps report what each gate is still short of", () => {
  const a = { createdAt: daysAgo(4), aging: { sessions: 3, watchMinutes: 100 } };
  const g = maturityGaps(a, policy());
  assert.equal(g.days, 10); // 14 - 4
  assert.equal(g.sessions, 7); // 10 - 3
  assert.equal(g.minutes, 140); // 240 - 100
});

test("a satisfied gate reports zero, never a negative", () => {
  const g = maturityGaps(ripe(), policy());
  assert.equal(g.days, 0);
  assert.equal(g.sessions, 0);
  assert.equal(g.minutes, 0);
});

test("gaps and isMature agree: all-zero gaps means mature", () => {
  const a = { createdAt: daysAgo(14), aging: { sessions: 10, watchMinutes: 240 } };
  const g = maturityGaps(a, policy());
  assert.deepEqual(g, { days: 0, sessions: 0, minutes: 0 });
  assert.equal(isMature(a, policy()), true);
});
