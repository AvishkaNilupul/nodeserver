'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openVaultLedger } = require('../utils/z2u/vaultLedger');
const { importReservedBatch, reconcileImportedBatch } = require('../utils/z2u/vaultImport');

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'z2u-import-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'ledger.json');
  const ledger = openVaultLedger(file);
  let writes = 0;
  const settings = { id: '10', storage_id: '20', is_auto_deliver: '1', outstock: '1', is_agiso: '0', buy_more: '5' };
  const protocol = {
    readOfferDelivery: async () => ({ ...settings }),
    importUnits: async payload => {
      writes++;
      assert.equal(payload.storageId, '20');
      assert.ok(!Object.hasOwn(payload.units[0], 'sourceId'));
      const snapshot = await ledger.snapshot();
      assert.ok(snapshot.units.every(unit => unit.status === 'uploading'));
      return { acknowledged: true, verified: false, data: { unsafe: 'SECRET_ACK' } };
    },
  };
  const options = { ledger, protocol, offerId: '10', storageId: '20', batchId: 'batch', attemptId: 'attempt', kind: 'code', maxPurchaseQuantity: 5,
    units: [{ sourceId: 'source-1', code: 'SECRET_CODE_1' }, { sourceId: 'source-2', code: 'SECRET_CODE_2' }],
    verifyReservation: async ({ offerId, sourceIds }) => ({ verified: true, reservationId: 'reservation', offerId, sourceIds }) };
  return { ledger, file, options, settings, protocol, writes: () => writes };
}
const evidence = items => ({ evidenceId: 'readback', automaticDeliveryEnabled: true, deactivateWhenEmpty: true,
  items: items.map(n => ({ sourceId: `source-${n}`, storageId: `remote-product-${n}`, ownershipVerified: true })) });

test('records intent before upload, keeps acknowledgment unverified, never serializes credentials', async t => {
  const { options, ledger, file, writes } = await setup(t);
  const result = await importReservedBatch(options);
  assert.equal(result.status, 'awaiting_reconciliation');
  assert.equal(result.verified, false); assert.equal(writes(), 1);
  assert.ok((await ledger.snapshot()).units.every(unit => unit.status === 'upload_uncertain'));
  assert.ok(!(await fs.readFile(file, 'utf8')).includes('SECRET'));
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  const replay = await importReservedBatch(options);
  assert.equal(replay.status, 'reconciliation_required'); assert.equal(writes(), 1);
});

test('two concurrent orchestrators dispatch only once', async t => {
  const { options, writes } = await setup(t);
  const results = await Promise.all([importReservedBatch(options), importReservedBatch(options)]);
  assert.equal(writes(), 1);
  assert.deepEqual(results.map(r => r.status).sort(), ['awaiting_reconciliation', 'reconciliation_required']);
});

test('upstream reservation proof must cover precisely this offer and sources', async t => {
  const { options, ledger, writes } = await setup(t);
  for (const receipt of [null, { verified: true, reservationId: 'reservation', offerId: '10', sourceIds: ['source-1'] }, { verified: true, reservationId: 'reservation', offerId: 'other', sourceIds: ['source-1', 'source-2'] }]) {
    await assert.rejects(importReservedBatch({ ...options, verifyReservation: async () => receipt }), { code: 'RESERVATION_UNVERIFIED' });
  }
  assert.equal(writes(), 0); assert.equal((await ledger.snapshot()).units.length, 0);
});

test('remote disabled or unreadable delivery invalidates previous enabled configuration', async t => {
  const { options, ledger, settings, protocol, writes } = await setup(t);
  await ledger.configureOffer('10', { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
  await ledger.reserveBatch({ offerId: '10', batchId: 'old-batch', sourceIds: ['old-source'] });
  settings.outstock = '0';
  await assert.rejects(importReservedBatch(options), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
  await assert.rejects(ledger.beginUpload('old-batch', 'old-attempt'), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
  await ledger.configureOffer('10', { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
  protocol.readOfferDelivery = async () => { throw new Error('SECRET_READ'); };
  await assert.rejects(importReservedBatch(options), error => error.code === 'DELIVERY_UNVERIFIED' && !error.message.includes('SECRET'));
  assert.equal(writes(), 0);
  assert.equal((await ledger.snapshot()).offers[0].automaticDeliveryEnabled, false);
});

test('wrong storage binding, third-party delivery, and unknown purchase maximum block import', async t => {
  const { options, settings, writes } = await setup(t);
  for (const [key, value] of [['storage_id', '21'], ['is_agiso', '1'], ['buy_more', '0']]) {
    const previous = settings[key]; settings[key] = value;
    await assert.rejects(importReservedBatch(options), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
    settings[key] = previous;
  }
  assert.equal(writes(), 0);
});

test('dispatch exceptions stay reserved across restart and never return raw errors', async t => {
  const { options, protocol, ledger, file } = await setup(t);
  let attempts = 0;
  protocol.importUnits = async () => { attempts++; throw new Error('SECRET_TRANSPORT'); };
  const result = await importReservedBatch(options);
  assert.equal(result.status, 'upload_uncertain'); assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok((await ledger.snapshot()).units.every(unit => unit.status === 'upload_uncertain'));
  const replay = await importReservedBatch({ ...options, ledger: openVaultLedger(file) });
  assert.equal(replay.dispatched, false); assert.equal(attempts, 1);
});

test('explicit partial readback holds missing stock and complete correspondence marks stocked', async t => {
  const { options, ledger } = await setup(t);
  await importReservedBatch(options);
  const context = { ledger, batchId: 'batch', attemptId: 'attempt' };
  const partial = await reconcileImportedBatch({ ...context, evidence: { ...evidence([1]), complete: false } });
  assert.equal(partial.status, 'partial'); assert.equal(partial.stocked, 1); assert.equal(partial.held, 1);
  const full = await reconcileImportedBatch({ ...context, evidence: { ...evidence([1, 2]), complete: true } });
  assert.equal(full.status, 'stocked'); assert.equal(full.verified, true); assert.equal(full.held, 0);
});

test('unverified/foreign readback cannot mark another source stocked', async t => {
  const { options, ledger } = await setup(t);
  await importReservedBatch(options);
  const context = { ledger, batchId: 'batch', attemptId: 'attempt' };
  for (const items of [[{ sourceId: 'source-1', storageId: '20' }], [{ sourceId: 'foreign-source', storageId: 'remote-product', ownershipVerified: true }]]) {
    await assert.rejects(reconcileImportedBatch({ ...context, evidence: { ...evidence([]), items, complete: false } }), { code: 'OWNERSHIP_MISMATCH' });
  }
  assert.ok((await ledger.snapshot()).units.every(unit => unit.status === 'upload_uncertain'));
});

function completeReadback() {
  return { complete: true, total: 2, observed: 2, missing: [], ambiguous: [], matched: [0, 1].map(unitIndex => ({
    unitIndex, productId: String(101 + unitIndex), storageId: '20', gameId: '30', categoryId: '40',
    status: 1, usedTime: null, saleReference: '0', unsoldVerified: true,
  })) };
}
function withReadback(options, protocol, readback = completeReadback()) {
  protocol.reconcileUploadedUnits = async input => {
    assert.ok(input.units.every(unit => /^z2u-[a-f0-9]{32}$/.test(unit.remark)));
    return readback;
  };
  return { ...options, gameId: '30', categoryId: '40', parseDocument: () => ({}) };
}

test('protocol readback maps product IDs, not category IDs, into the durable ledger', async t => {
  const { options, protocol, ledger } = await setup(t);
  const result = await importReservedBatch(withReadback(options, protocol));
  assert.equal(result.status, 'stocked'); assert.equal(result.verified, true);
  assert.deepEqual((await ledger.snapshot()).units.map(unit => unit.storageId), ['101', '102']);
});

test('ambiguous dispatch can resolve from verified remote evidence without resend', async t => {
  const { options, protocol, ledger } = await setup(t);
  let writes = 0;
  protocol.importUnits = async () => { writes++; throw new Error('applied but connection closed'); };
  const configured = withReadback(options, protocol);
  assert.equal((await importReservedBatch(configured)).status, 'stocked');
  assert.equal((await importReservedBatch(configured)).dispatched, false);
  assert.equal(writes, 1);
  assert.ok((await ledger.snapshot()).units.every(unit => unit.status === 'stocked'));
});

test('foreign, duplicate, sold, missing-field or incomplete readback never marks stock ready', async t => {
  const { options, protocol, ledger } = await setup(t);
  const configured = withReadback(options, protocol);
  const cases = [
    data => { data.matched[0].gameId = '31'; },
    data => { data.matched[0].storageId = '21'; },
    data => { data.matched[1].productId = '101'; },
    data => { data.matched[1].unitIndex = 0; },
    data => { data.matched[0].status = 2; },
    data => { data.matched[0].usedTime = '2026-11-16'; },
    data => { delete data.matched[0].unsoldVerified; },
    data => { data.complete = false; },
    data => { data.missing = [0]; },
    data => { data.total = 3; },
  ];
  for (const alter of cases) {
    const readback = completeReadback(); alter(readback);
    protocol.reconcileUploadedUnits = async () => readback;
    const result = await importReservedBatch(configured);
    assert.equal(result.verified, false);
    assert.ok((await ledger.snapshot()).units.every(unit => unit.status === 'upload_uncertain'));
  }
});

test('auto-delivery turned off during inventory verification prevents stocked confirmation', async t => {
  const { options, protocol, ledger, settings } = await setup(t);
  const configured = withReadback(options, protocol);
  protocol.reconcileUploadedUnits = async () => { settings.is_auto_deliver = '0'; return completeReadback(); };
  const result = await importReservedBatch(configured);
  assert.equal(result.reason, 'delivery_disabled');
  assert.ok((await ledger.snapshot()).units.every(unit => unit.status === 'upload_uncertain'));
  assert.equal((await ledger.snapshot()).offers[0].automaticDeliveryEnabled, false);
});

test('verified listing maximum is mandatory and must fit the native delivery cutoff', async t => {
  const { options, settings, writes } = await setup(t);
  for (const maxPurchaseQuantity of [undefined, 0, -1, 1.5, '5', [5], Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(importReservedBatch({ ...options, maxPurchaseQuantity }), { code: 'INVALID_QUANTITY' });
  }
  settings.buy_more = '4';
  await assert.rejects(importReservedBatch(options), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
  assert.equal(writes(), 0);
  settings.buy_more = '6';
  assert.equal((await importReservedBatch(options)).status, 'awaiting_reconciliation');
  assert.equal(writes(), 1);
});

test('native identifiers reject coercible containers and unsafe numbers before reads or writes', async t => {
  const { options, protocol, writes } = await setup(t);
  let reads = 0;
  protocol.readOfferDelivery = async () => { reads++; throw new Error('unexpected'); };
  for (const invalid of [[10], { toString: () => '10' }, Number.MAX_SAFE_INTEGER + 1, '010', '1e2', ' 10', true, 0]) {
    for (const key of ['offerId', 'storageId']) {
      await assert.rejects(importReservedBatch({ ...options, [key]: invalid }), { code: 'INVALID_ID' });
    }
  }
  assert.equal(reads, 0); assert.equal(writes(), 0);
});

test('canonical large decimal string IDs remain exact', async t => {
  const { options, protocol, settings } = await setup(t);
  settings.id = '9007199254740993';
  protocol.importUnits = async () => ({ acknowledged: true, verified: false });
  const result = await importReservedBatch({ ...options, offerId: settings.id });
  assert.equal(result.status, 'awaiting_reconciliation');
});

test('coercible or unsafe readback identifiers cannot be laundered into ownership matches', async t => {
  const { options, protocol, ledger } = await setup(t);
  const configured = withReadback(options, protocol);
  for (const [key, value] of [['storageId', ['20']], ['gameId', ['30']], ['categoryId', { toString: () => '40' }], ['productId', ['101']], ['productId', Number.MAX_SAFE_INTEGER + 1]]) {
    const data = completeReadback(); data.matched[0][key] = value;
    protocol.reconcileUploadedUnits = async () => data;
    const result = await importReservedBatch(configured);
    assert.equal(result.reason, 'identity_mismatch'); assert.equal(result.verified, false);
  }
  assert.ok((await ledger.snapshot()).units.every(unit => unit.status === 'upload_uncertain'));
});

test('coercible native flags, cutoff and offer identifiers fail delivery readiness', async t => {
  const { options, settings, writes } = await setup(t);
  for (const [key, value] of [['id', ['10']], ['storage_id', ['20']], ['buy_more', ['5']], ['is_auto_deliver', ['1']], ['outstock', ['1']], ['is_agiso', ['0']]]) {
    const previous = settings[key]; settings[key] = value;
    await assert.rejects(importReservedBatch(options), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
    settings[key] = previous;
  }
  assert.equal(writes(), 0);
});
