'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const modulePath = require.resolve('../utils/z2u/vaultLedger');
const { openVaultLedger } = require(modulePath);
const config = { automaticDeliveryEnabled: true, deactivateWhenEmpty: true };
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'z2u-ledger-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ledger.json');
  return { file, ledger: openVaultLedger(file) };
}
async function prepared(t, sourceIds = ['source-1']) {
  const f = await fixture(t);
  await f.ledger.configureOffer('offer-1', config);
  await f.ledger.reserveBatch({ offerId: 'offer-1', batchId: 'batch-1', sourceIds });
  return f;
}
const evidence = (extra = {}) => ({ sourceId: 'source-1', offerId: 'offer-1', storageId: 'storage-1', evidenceId: 'read-1', ownershipVerified: true, ...extra });

test('automatic delivery is mandatory before reservation and confirmation', async t => {
  const { ledger } = await fixture(t);
  await assert.rejects(ledger.configureOffer('offer-1', { automaticDeliveryEnabled: true }), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
  await assert.rejects(ledger.reserveBatch({ offerId: 'offer-1', batchId: 'batch-1', sourceIds: ['source-1'] }), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
  await ledger.configureOffer('offer-1', config);
  await ledger.reserveBatch({ offerId: 'offer-1', batchId: 'batch-1', sourceIds: ['source-1'] });
  await ledger.beginUpload('batch-1', 'attempt-1');
  await assert.rejects(ledger.reconcile(evidence({ kind: 'stocked', automaticDeliveryEnabled: true })), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
});

test('complete lifecycle preserves source/storage identity and prevents terminal rollback', async t => {
  const { ledger, file } = await prepared(t);
  assert.equal((await ledger.beginUpload('batch-1', 'attempt-1')).maySubmit, true);
  await ledger.confirmStocked('batch-1', { attemptId: 'attempt-1', ...config, complete: true, evidenceId: 'read-1', items: [{ sourceId: 'source-1', storageId: 'storage-1', ownershipVerified: true }] });
  await ledger.reconcile(evidence({ kind: 'delivered', deliverySucceeded: true, deliveryId: 'delivery-unit-1' }));
  const reopened = openVaultLedger(file);
  assert.equal((await reopened.snapshot()).units[0].status, 'delivered');
  await assert.rejects(reopened.reconcile(evidence({ kind: 'deleted_unsold', deletionVerified: true, unsoldVerified: true, completeRead: true })), { code: 'INVALID_TRANSITION' });
  await assert.rejects(reopened.reconcile(evidence({ kind: 'stocked', ...config })), { code: 'INVALID_TRANSITION' });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('ambiguous upload is held and retries never authorize a second submission', async t => {
  const { ledger, file } = await prepared(t);
  await ledger.beginUpload('batch-1', 'attempt-1');
  await ledger.markUploadUncertain('batch-1', 'attempt-1');
  const reopened = openVaultLedger(file);
  assert.equal((await reopened.beginUpload('batch-1', 'attempt-1')).maySubmit, false);
  await assert.rejects(reopened.beginUpload('batch-1', 'attempt-2'), { code: 'RECONCILIATION_REQUIRED' });
  for (const kind of ['missing', 'timeout', 'error']) await assert.rejects(reopened.reconcile(evidence({ kind })), { code: 'INVALID_EVIDENCE' });
  assert.equal((await reopened.snapshot()).units[0].status, 'upload_uncertain');
  await reopened.reconcile(evidence({ kind: 'stocked', ...config }));
  assert.equal((await reopened.snapshot()).units[0].status, 'stocked');
});

test('only complete verified unsold deletion releases a matching unit', async t => {
  const { ledger } = await prepared(t);
  await ledger.beginUpload('batch-1', 'attempt-1');
  await ledger.reconcile(evidence({ kind: 'stocked', ...config }));
  const deletion = evidence({ kind: 'deleted_unsold', deletionVerified: true, unsoldVerified: true, completeRead: true });
  for (const missing of ['deletionVerified', 'unsoldVerified', 'completeRead', 'ownershipVerified']) {
    await assert.rejects(ledger.reconcile({ ...deletion, [missing]: false }));
  }
  await assert.rejects(ledger.reconcile({ ...deletion, offerId: 'offer-2' }), { code: 'OWNERSHIP_MISMATCH' });
  await assert.rejects(ledger.reconcile({ ...deletion, storageId: 'storage-2' }), { code: 'OWNERSHIP_MISMATCH' });
  await ledger.reconcile(deletion);
  assert.equal((await ledger.snapshot()).units[0].status, 'released');
  await assert.rejects(ledger.reserveBatch({ offerId: 'offer-1', batchId: 'batch-2', sourceIds: ['source-1'] }), { code: 'DUPLICATE_SOURCE' });
});

test('partial/duplicate storage mapping rolls back the entire transaction', async t => {
  const { ledger } = await prepared(t, ['source-1', 'source-2']);
  await ledger.beginUpload('batch-1', 'attempt-1');
  const confirmation = { attemptId: 'attempt-1', ...config, complete: true, evidenceId: 'read-1' };
  await assert.rejects(ledger.confirmStocked('batch-1', { ...confirmation, items: [{ sourceId: 'source-1', storageId: 'storage-1', ownershipVerified: true }] }), { code: 'INCOMPLETE_EVIDENCE' });
  const before = await ledger.snapshot();
  await assert.rejects(ledger.confirmStocked('batch-1', { ...confirmation, items: ['source-1', 'source-2'].map(sourceId => ({ sourceId, storageId: 'same-storage', ownershipVerified: true })) }), { code: 'DUPLICATE_STORAGE' });
  assert.deepEqual(await ledger.snapshot(), before);
});

test('concurrent processes cannot reserve the same source twice', async t => {
  const { ledger, file } = await fixture(t);
  await ledger.configureOffer('offer-1', config);
  const source = `const {openVaultLedger}=require(process.argv[1]); const l=openVaultLedger(process.argv[2]); l.reserveBatch({offerId:'offer-1',batchId:process.argv[3],sourceIds:['source-race']}).then(()=>process.stdout.write('ok'),e=>process.stdout.write(e.code));`;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => run(process.execPath, ['-e', source, modulePath, file, 'batch-' + i])));
  assert.equal(results.filter(r => r.stdout === 'ok').length, 1);
  assert.equal(results.filter(r => r.stdout === 'DUPLICATE_SOURCE').length, 7);
  assert.equal((await ledger.snapshot()).units.length, 1);
});

test('process exit after upload intent persists a non-resendable attempt', async t => {
  const { file } = await fixture(t);
  const source = `const {openVaultLedger}=require(process.argv[1]); (async()=>{const l=openVaultLedger(process.argv[2]); await l.configureOffer('offer-1',{automaticDeliveryEnabled:true,deactivateWhenEmpty:true}); await l.reserveBatch({offerId:'offer-1',batchId:'batch-1',sourceIds:['source-1']}); await l.beginUpload('batch-1','attempt-1'); process.exit(17);})().catch(()=>process.exit(99));`;
  await assert.rejects(run(process.execPath, ['-e', source, modulePath, file]), error => error.code === 17);
  const reopened = openVaultLedger(file);
  assert.equal((await reopened.snapshot()).units[0].status, 'uploading');
  assert.equal((await reopened.beginUpload('batch-1', 'attempt-1')).maySubmit, false);
});

test('dead lock requires explicit exact-identity recovery; live owner cannot be stolen', async t => {
  const { file } = await fixture(t);
  const lockSource = `const fs=require('fs'),os=require('os');fs.writeFileSync(process.argv[1]+'.lock',JSON.stringify({version:1,pid:process.pid,host:os.hostname(),token:'dead-lock-token'}),{mode:0o600});`;
  await run(process.execPath, ['-e', lockSource, file]);
  const ledger = openVaultLedger(file, { lockTimeoutMs: 0 });
  await assert.rejects(ledger.snapshot(), { code: 'LEDGER_LOCKED' });
  await assert.rejects(ledger.recoverDeadLock('wrong-token'), { code: 'LOCK_CHANGED' });
  assert.equal((await ledger.inspectLock()).token, 'dead-lock-token');
  await ledger.recoverDeadLock('dead-lock-token');
  assert.equal((await ledger.snapshot()).units.length, 0);
  await fs.writeFile(file + '.lock', JSON.stringify({ version: 1, pid: process.pid, host: os.hostname(), token: 'live-lock-token' }), { mode: 0o600 });
  await assert.rejects(ledger.recoverDeadLock('live-lock-token'), { code: 'OWNER_ALIVE' });
});

test('corrupt, world-readable and symlinked ledgers fail closed', async t => {
  const { file, ledger } = await fixture(t);
  await fs.writeFile(file, '{invalid', { mode: 0o600 });
  await assert.rejects(ledger.configureOffer('offer-1', config), SyntaxError);
  assert.equal(await fs.readFile(file, 'utf8'), '{invalid');
  await fs.chmod(file, 0o644);
  await assert.rejects(ledger.snapshot(), { code: 'UNSAFE_FILE' });
  await fs.unlink(file);
  const target = file + '.target';
  await fs.writeFile(target, '{invalid', { mode: 0o600 }); await fs.symlink(target, file);
  await assert.rejects(ledger.snapshot());
  assert.equal(await fs.readFile(target, 'utf8'), '{invalid');
});

test('idempotent reservation preserves batch identity and upload attempts are globally unique', async t => {
  const { ledger } = await prepared(t);
  assert.equal((await ledger.reserveBatch({ offerId: 'offer-1', batchId: 'batch-1', sourceIds: ['source-1'] })).replay, true);
  await assert.rejects(ledger.reserveBatch({ offerId: 'offer-1', batchId: 'batch-1', sourceIds: ['source-2'] }), { code: 'BATCH_CONFLICT' });
  await ledger.reserveBatch({ offerId: 'offer-1', batchId: 'batch-2', sourceIds: ['source-2'] });
  await ledger.beginUpload('batch-1', 'attempt-1');
  await assert.rejects(ledger.beginUpload('batch-2', 'attempt-1'), { code: 'DUPLICATE_ATTEMPT' });
  assert.equal((await ledger.snapshot()).units.find(u => u.sourceId === 'source-2').status, 'reserved');
});

test('successful delivery evidence can resolve uncertain uploads but cannot be assigned twice', async t => {
  const { ledger } = await prepared(t, ['source-1', 'source-2']);
  await ledger.beginUpload('batch-1', 'attempt-1');
  await ledger.markUploadUncertain('batch-1', 'attempt-1');
  const delivery = evidence({ kind: 'delivered', deliverySucceeded: true, deliveryId: 'delivery-unit-1' });
  await ledger.reconcile(delivery); await ledger.reconcile(delivery);
  await assert.rejects(ledger.reconcile({ ...delivery, sourceId: 'source-2', storageId: 'storage-2' }), { code: 'DUPLICATE_DELIVERY' });
  const units = (await ledger.snapshot()).units;
  assert.equal(units[0].status, 'delivered');
  assert.equal(units[1].status, 'upload_uncertain');
  assert.equal(units[1].storageId, '');
});
