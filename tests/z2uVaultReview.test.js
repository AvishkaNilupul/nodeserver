'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { openVaultLedger } = require('../utils/z2u/vaultLedger');
const config = { automaticDeliveryEnabled: true, deactivateWhenEmpty: true };

async function prepare(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'z2u-review-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ledger.json');
  const ledger = openVaultLedger(file);
  await ledger.configureOffer('offer', config);
  await ledger.reserveBatch({ offerId: 'offer', batchId: 'batch', sourceIds: ['source'] });
  return { ledger, file };
}

test('racing upload callers authorize exactly one remote submission', async t => {
  const { file } = await prepare(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => openVaultLedger(file).beginUpload('batch', 'attempt')));
  assert.equal(results.filter(result => result.maySubmit).length, 1);
  assert.equal(results.filter(result => !result.maySubmit).length, 7);
});

test('an error after the atomic rename cannot authorize resend on reopen', async t => {
  const { ledger, file } = await prepare(t);
  const original = fs.rename;
  fs.rename = async (...args) => {
    await original(...args);
    if (args[1] === file) throw new Error('simulated failure after durable replacement');
  };
  try { await assert.rejects(ledger.beginUpload('batch', 'attempt'), /after durable replacement/); }
  finally { fs.rename = original; }
  const reopened = openVaultLedger(file);
  assert.equal((await reopened.snapshot()).units[0].status, 'uploading');
  assert.equal((await reopened.beginUpload('batch', 'attempt')).maySubmit, false);
  await assert.rejects(reopened.beginUpload('batch', 'new-attempt'), { code: 'RECONCILIATION_REQUIRED' });
});

test('racing contradictory terminal evidence cannot flip delivery into released stock', async t => {
  const { ledger, file } = await prepare(t);
  await ledger.beginUpload('batch', 'attempt');
  const identity = { sourceId: 'source', offerId: 'offer', storageId: 'storage', evidenceId: 'read', ownershipVerified: true };
  await ledger.reconcile({ ...identity, kind: 'delivered', deliveryId: 'delivery-unit', deliverySucceeded: true });
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => openVaultLedger(file).reconcile({ ...identity, kind: 'deleted_unsold', deletionVerified: true, unsoldVerified: true, completeRead: true })));
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.code === 'INVALID_TRANSITION'));
  assert.equal((await ledger.snapshot()).units[0].status, 'delivered');
});
