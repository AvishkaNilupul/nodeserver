const test = require("node:test");
const assert = require("node:assert/strict");
const sift = require("sift").default || require("sift");

const settings = require("../utils/settings");
const dr = require("../utils/dropReservation");

const DAY = 86400000;
const ago = (d) => new Date(Date.now() - d * DAY);

function withSetting(value, fn) {
  const orig = settings.getAutoFarm;
  settings.getAutoFarm = () => ({ ...orig(), dropSellableMaxAgeDays: value });
  dr._resetSellableAgeCache();
  try {
    return fn();
  } finally {
    settings.getAutoFarm = orig;
    dr._resetSellableAgeCache();
  }
}

test("AVAILABLE_DROP spreads an age cutoff of 170 days by default", () => {
  dr._resetSellableAgeCache();
  const m = { ...dr.AVAILABLE_DROP };
  assert.deepEqual(Object.keys(m).sort(), ["awardedAt", "connected", "name", "soldAt"]);
  const cutoff = m.awardedAt.$not.$lt.getTime();
  assert.ok(Math.abs(cutoff - (Date.now() - 170 * DAY)) < 5000);
});

test("the filter keeps fresh and undated drops and drops expired ones", () => {
  dr._resetSellableAgeCache();
  const match = sift({ ...dr.AVAILABLE_DROP });
  assert.equal(match({ connected: false, soldAt: null, awardedAt: ago(10) }), true);
  assert.equal(match({ connected: false, soldAt: null, awardedAt: ago(169) }), true);
  assert.equal(match({ connected: false, soldAt: null, awardedAt: ago(171) }), false);
  assert.equal(match({ connected: false, soldAt: null, awardedAt: ago(183) }), false);
  // unknown age is never silently removed
  assert.equal(match({ connected: false, soldAt: null, awardedAt: null }), true);
  assert.equal(match({ connected: false, soldAt: null }), true);
  // the old conditions still hold
  assert.equal(match({ connected: true, soldAt: null, awardedAt: ago(1) }), false);
  assert.equal(match({ connected: false, soldAt: new Date(), awardedAt: ago(1) }), false);
});

test("notExpiredMatch and isExpiredDrop agree with AVAILABLE_DROP", () => {
  dr._resetSellableAgeCache();
  const m = sift(dr.notExpiredMatch());
  for (const d of [1, 100, 169, 171, 200]) {
    const row = { awardedAt: ago(d) };
    assert.equal(m(row), !dr.isExpiredDrop(row), "age " + d);
  }
  assert.equal(dr.isExpiredDrop({}), false);
});

test("the setting is honoured and clamped to 30..175", () => {
  withSetting(120, () => assert.equal(dr.sellableMaxAgeDays(), 120));
  withSetting(400, () => assert.equal(dr.sellableMaxAgeDays(), 175));
  withSetting(5, () => assert.equal(dr.sellableMaxAgeDays(), 30));
  withSetting("junk", () => assert.equal(dr.sellableMaxAgeDays(), 170));
  withSetting(120, () => {
    assert.equal(dr.isExpiredDrop({ awardedAt: ago(121) }), true);
    assert.equal(dr.isExpiredDrop({ awardedAt: ago(119) }), false);
  });
});

test("every spread takes the cutoff at that moment, not at load time", () => {
  dr._resetSellableAgeCache();
  const a = { ...dr.AVAILABLE_DROP }.awardedAt.$not.$lt;
  const realNow = Date.now;
  Date.now = () => realNow() + 2 * DAY;
  try {
    const b = { ...dr.AVAILABLE_DROP }.awardedAt.$not.$lt;
    assert.ok(b.getTime() - a.getTime() > DAY);
  } finally {
    Date.now = realNow;
  }
});

test("AVAILABLE_DROP cannot be mutated by a caller", () => {
  assert.throws(() => {
    "use strict";
    dr.AVAILABLE_DROP.soldAt = 1;
  });
});

test("a drop Twitch renamed to Expired is never sellable, whatever its age", () => {
  dr._resetSellableAgeCache();
  const match = sift({ ...dr.AVAILABLE_DROP });
  assert.equal(match({ connected: false, soldAt: null, awardedAt: ago(14), name: "Nike Ja Expired" }), false);
  assert.equal(match({ connected: false, soldAt: null, awardedAt: ago(14), name: "Nike Ja 4" }), true);
  assert.equal(dr.isExpiredDrop({ awardedAt: ago(1), name: "Nike Ja Expired" }), true);
  assert.equal(sift(dr.notExpiredMatch())({ awardedAt: ago(1), name: "x expired" }), false);
});
