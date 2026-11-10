const test = require('node:test'), assert = require('node:assert/strict');
const {makeLease, finished, restoreCap} = require('../scripts/epic-claim-batch-cap.cjs');
const snapshot = {success: true, batch: {id: 'one', state: 'running', total: 48}};
test('allowance covers exactly the requested batch above the original cap and expires', () => {
  const lease = makeLease(snapshot, {dailyCap: 20}, 'one', 0);
  assert.equal(lease.allowedCap, 68); assert.equal(finished(lease, snapshot, 1), false);
  assert.equal(finished(lease, snapshot, lease.expiresAt), true);
  for (const state of ['paused', 'complete', 'stopped', 'error', 'idle'])
    assert.equal(finished(lease, {batch: {...snapshot.batch, state}}, 1), true);
  assert.equal(finished(lease, {batch: {...snapshot.batch, id: 'another'}}, 1), true);
  assert.throws(() => makeLease(snapshot, {dailyCap: 20}, 'another'));
  assert.throws(() => makeLease(snapshot, {dailyCap: 0}, 'one'));
});
test('restoration patches only the cap and preserves later operator settings', async () => {
  const lease = makeLease(snapshot, {dailyCap: 20}, 'one'); let cap = 68, writes = [];
  const settings = {getEpicAutoClaim: () => ({dailyCap: cap}), async setEpicAutoClaim(patch) { writes.push(patch); cap = patch.dailyCap; }};
  assert.equal(await restoreCap(settings, lease), 'restored'); assert.deepEqual(writes, [{dailyCap: 20}]);
  cap = 35; assert.equal(await restoreCap(settings, lease), 'preserved-later-setting'); assert.equal(writes.length, 1);
});
