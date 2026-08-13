// Per-account device identity. Two properties carry the whole point: an
// account's device must never change (a device that rotates is worse than no
// device at all), and two accounts must not share one (that is the cohort
// problem this exists to fix). The diurnal window tests guard the other half —
// sessions landing at 4am as often as 8pm is what a machine does.
const test = require("node:test");
const assert = require("node:assert");

const id = require("../utils/twitchIdentity");

const A = "64f1a2b3c4d5e6f708192a3b";
const B = "64f1a2b3c4d5e6f708192a3c"; // differs in the last character only

// ------------------------------------------------------------- stability

test("an account's device id is stable across calls", () => {
  assert.equal(id.deviceIdFor(A), id.deviceIdFor(A));
  assert.equal(id.identityFor(A).deviceId, id.identityFor(A).deviceId);
});

test("an account's user agent is stable across calls", () => {
  assert.equal(id.userAgentFor(A), id.userAgentFor(A));
});

test("two accounts get different device ids", () => {
  assert.notEqual(id.deviceIdFor(A), id.deviceIdFor(B));
});

test("device id looks like the real thing: 32 lowercase hex", () => {
  assert.match(id.deviceIdFor(A), /^[0-9a-f]{32}$/);
});

// ------------------------------------------------------------- headers

test("headers carry device, UA, language and version", () => {
  const h = id.headersFor(A);
  assert.match(h["User-Agent"], /^Mozilla\/5\.0 \(Linux; Android/);
  assert.match(h["X-Device-Id"], /^[0-9a-f]{32}$/);
  assert.ok(h["Accept-Language"]);
  assert.ok(h["Client-Version"]);
});

test("the User-Agent is never the bare placeholder that was there before", () => {
  // "Mozilla/5.0" on its own is a string no real browser has ever sent, so it
  // is a worse signal than omitting the header.
  assert.notEqual(id.headersFor(A)["User-Agent"], "Mozilla/5.0");
});

test("headers never include Client-Id — the caller owns that", () => {
  // The tokens are bound to Twitch's Android client via device-auth; the web
  // client id fails the integrity check outright. An identity must not be able
  // to change it by accident.
  const h = id.headersFor(A, "sess");
  assert.ok(!("Client-Id" in h));
  assert.ok(!("Authorization" in h));
});

test("a session id is included only when one is supplied", () => {
  assert.ok(!("Client-Session-Id" in id.headersFor(A)));
  assert.equal(id.headersFor(A, "abc123")["Client-Session-Id"], "abc123");
});

test("session ids differ between sittings", () => {
  assert.notEqual(id.newSessionId(), id.newSessionId());
});

test("no seed means no identity headers at all", () => {
  assert.deepEqual(id.headersFor(""), {});
  assert.deepEqual(id.headersFor(null), {});
});

test("client version does NOT vary per account", () => {
  // Real populations run one or two app builds. A fleet where every account
  // reports a different version would be absurd — over-randomising is its own
  // tell. Across many seeds we expect a very small set of distinct values.
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(id.identityFor("seed-" + i).clientVersion);
  assert.ok(seen.size <= 3, "expected few client versions, saw " + seen.size);
});

test("user agents DO vary across accounts", () => {
  // Real users own different phones, so this variation is realistic.
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(id.userAgentFor("seed-" + i));
  assert.ok(seen.size > 5, "expected varied handsets, saw " + seen.size);
});

// -------------------------------------------------------- diurnal window

test("a waking window is stable and plausibly human-length", () => {
  const w = id.activeWindowFor(A);
  assert.deepEqual(w, id.activeWindowFor(A));
  assert.ok(w.hours >= 11 && w.hours <= 16, "hours=" + w.hours);
  assert.ok(w.startHour >= 0 && w.startHour < 24);
});

test("a time inside the window is left alone", () => {
  const win = { startHour: 8, hours: 12 }; // 08:00-20:00
  const at = new Date(Date.UTC(2026, 7, 14, 12, 0, 0));
  assert.equal(id.nextWithinWindow(at, win).getTime(), at.getTime());
  assert.equal(id.isWithinWindow(at, win), true);
});

test("a time outside the window is pushed into the next one", () => {
  const win = { startHour: 8, hours: 12 }; // 08:00-20:00
  const at = new Date(Date.UTC(2026, 7, 14, 3, 0, 0)); // 03:00 — asleep
  assert.equal(id.isWithinWindow(at, win), false);
  const moved = id.nextWithinWindow(at, win);
  assert.ok(moved.getTime() > at.getTime(), "should move forward");
  assert.equal(id.isWithinWindow(moved, win), true, "and land inside the window");
});

test("a window that wraps past midnight still works", () => {
  const win = { startHour: 20, hours: 12 }; // 20:00-08:00
  assert.equal(id.isWithinWindow(new Date(Date.UTC(2026, 7, 14, 22, 0)), win), true);
  assert.equal(id.isWithinWindow(new Date(Date.UTC(2026, 7, 14, 2, 0)), win), true);
  assert.equal(id.isWithinWindow(new Date(Date.UTC(2026, 7, 14, 12, 0)), win), false);
  const moved = id.nextWithinWindow(new Date(Date.UTC(2026, 7, 14, 12, 0)), win);
  assert.equal(id.isWithinWindow(moved, win), true);
});

test("windows spread across the clock so the FLEET is always active", () => {
  // Each account sleeps; the population as a whole does not. If every account
  // woke at the same hour we'd have swapped one pattern for another.
  const starts = new Set();
  for (let i = 0; i < 200; i++) starts.add(id.activeWindowFor("seed-" + i).startHour);
  assert.ok(starts.size > 12, "expected spread start hours, saw " + starts.size);
});

test("pushed times never land before the original", () => {
  // Guards the wrap arithmetic: a bug here would schedule sessions in the past
  // and the runner would fire them immediately, defeating the whole point.
  for (let h = 0; h < 24; h++) {
    for (const win of [{ startHour: 8, hours: 12 }, { startHour: 20, hours: 12 }, { startHour: 0, hours: 11 }]) {
      const at = new Date(Date.UTC(2026, 7, 14, h, 30, 0));
      const out = id.nextWithinWindow(at, win);
      assert.ok(out.getTime() >= at.getTime(), "h=" + h + " win=" + JSON.stringify(win));
    }
  }
});
