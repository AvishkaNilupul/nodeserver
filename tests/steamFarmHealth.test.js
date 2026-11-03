const test = require('node:test');
const assert = require('node:assert/strict');
const { assess, summary } = require('../utils/steamFarmHealth');
const now = Date.parse('2026-11-03T04:00:00Z');
const row = { state: 'boosting', purpose: 'boost', workerState: 'playing', playing: 2, games: [730,1172470], licensed: [730,1172470], lastSeenAt: new Date(now), minutes: {} };
test('a fresh worker heartbeat does not invent verified minutes', () => {
  const h = assess(row, now); assert.equal(h.health, 'healthy'); assert.equal(h.timeVerified, false); assert.equal(h.minMinutes, null); assert.match(h.message, /awaiting/);
});
test('farm checks detect missing licenses and stale account reports', () => {
  assert.equal(assess({ ...row, licensed: [730] }, now).licensesReady, false);
  const h = assess({ ...row, lastSeenAt: new Date(now - 181000) }, now); assert.equal(h.health, 'attention'); assert.equal(h.loggedIn, false);
});
test('verified progress uses every selected game, including zero readings', () => {
  const h = assess({ ...row, minutes: { 730: 60000, 1172470: 0 }, targetHours: 1000 }, now); assert.equal(h.minMinutes, 0); assert.equal(h.progress, 0);
});
test('normal time settlement is distinct from failed/retrying login', () => {
  assert.match(assess({ ...row, workerState: 'paused', playing: 0 }, now).message, /Settling/);
  assert.equal(assess({ ...row, workerState: 'retrying', lastError: 'socket hang up' }, now).health, 'attention');
});
test('completed stock already listed is not counted as waiting for Eldorado', () => {
  const b = { ...row, state: 'ready', accountStage: 'listed' }; assert.equal(assess(b, now).health, 'listed'); assert.equal(summary([b], now).ready, 0); assert.equal(summary([b], now).listed, 1);
});
