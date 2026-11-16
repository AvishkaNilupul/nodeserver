'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { openVaultLedger } = require('../utils/z2u/vaultLedger');
const { prepareReservedBatch } = require('../utils/z2u/vaultPrepare');
const { SCALARS, ARRAYS } = require('../utils/z2u/offers');

const guard = () => ({ storageCategoryId: '20', gameId: '30', categoryId: '40', snapshotHash: 'a'.repeat(64), storageNameHash: 'b'.repeat(64),
  evidenceId: 'proof', pausedVerified: true, dedicatedStorageVerified: true, emptyStorageVerified: true });
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'z2u-prepare-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ledger = openVaultLedger(path.join(dir, 'journal.json'));
  const fields = { ...Object.fromEntries(SCALARS.map(name => [name, '1'])), ...Object.fromEntries(ARRAYS.map(name => [name, []])),
    list_pk: '10', list_title: 'Synthetic offer', list_description: 'Synthetic exact contents' };
  const expectedSnapshot = { verified: true, offerId: '10', gameId: '30', categoryId: '40', status: 'paused', statusCode: 4,
    title: fields.list_title, description: fields.list_description, fields, constraints: { ready: true, maxPurchaseQuantity: 1 } };
  const state = { snapshot: structuredClone(expectedSnapshot), uploaded: false, writes: 0, configWrites: 0, dedicatedReads: 0, pauses: 0,
    settings: { id: '10', is_auto_deliver: 2, storage_id: 0 } };
  const matched = () => ({ complete: true, total: 1, observed: 1, missing: [], ambiguous: [], matched: [{ unitIndex: 0, productId: '90',
    storageId: '20', gameId: '30', categoryId: '40', status: 1, usedTime: null, saleReference: null, unsoldVerified: true }] });
  const protocol = {
    readOfferSnapshot: async () => structuredClone(state.snapshot),
    readStorage: async () => ({ id: '20', gid: '30', category_id: '40', type: 1, is_repeat: 2, parent_id: 0, name: 'Synthetic new category' }),
    readOfferDelivery: async () => ({ ...state.settings }),
    reconcileUploadedUnits: async () => state.uploaded ? matched() : ({ complete: true, total: 0, observed: 0, matched: [], missing: [0], ambiguous: [] }),
    importUnits: async () => { state.writes++; state.uploaded = true; return { acknowledged: true }; },
    configureNativeDelivery: async () => {
      state.configWrites++; state.settings = { id: '10', storage_id: '20', is_auto_deliver: 1, outstock: 1, is_agiso: 0, buy_more: 1 };
      return { verified: true };
    },
    pauseOffer: async () => { state.pauses++; state.snapshot.status = 'paused'; state.snapshot.statusCode = 4; return { verified: true, status: 'paused' }; },
  };
  const options = { ledger, protocol, offerId: '10', storageId: '20', gameId: '30', categoryId: '40', expectedSnapshot,
    expectedStorageName: 'Synthetic new category', batchId: 'batch', attemptId: 'attempt', maxPurchaseQuantity: 1,
    units: [{ sourceId: 'source', account: 'synthetic-account', password: 'synthetic-password' }], parseDocument: () => {},
    verifyReservation: async ({ offerId, sourceIds }) => ({ verified: true, reservationId: 'source-reservation', offerId, sourceIds }),
    verifyDedicatedStorage: async input => { state.dedicatedReads++; return { ...input, verified: true }; } };
  return { ledger, options, protocol, state, matched };
}

test('preparation is a distinct disabled state with no ordinary-upload or stocked bypass', async t => {
  const { ledger } = await setup(t);
  const request = { offerId: '10', batchId: 'batch', sourceIds: ['source'], guard: guard() };
  await ledger.reservePreparationBatch(request);
  let saved = await ledger.snapshot();
  assert.equal(saved.offers[0].automaticDeliveryEnabled, false);
  assert.equal(saved.batches[0].preparationOnly, true);
  await assert.rejects(ledger.beginUpload('batch', 'attempt'), { code: 'PREPARATION_REQUIRED' });
  await assert.rejects(ledger.beginPreparationUpload('batch', 'attempt', { ...guard(), emptyStorageVerified: false }), { code: 'PREPARATION_UNVERIFIED' });
  assert.equal((await ledger.beginPreparationUpload('batch', 'attempt', guard())).maySubmit, true);
  const evidence = { attemptId: 'attempt', complete: true, evidenceId: 'readback', automaticDeliveryEnabled: true, deactivateWhenEmpty: true,
    items: [{ sourceId: 'source', storageId: '90', ownershipVerified: true }] };
  await assert.rejects(ledger.confirmStocked('batch', evidence), { code: 'AUTOMATIC_DELIVERY_REQUIRED' });
  assert.equal((await ledger.snapshot()).units[0].storageId, '');
  await ledger.configureOffer('10', { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
  await ledger.confirmStocked('batch', evidence);
  assert.equal((await ledger.beginPreparationUpload('batch', 'attempt', { ...guard(), emptyStorageVerified: false })).maySubmit, false);
  await assert.rejects(ledger.reserveBatch({ offerId: '10', batchId: 'batch', sourceIds: ['source'] }), { code: 'PREPARATION_REQUIRED' });
  saved = await ledger.snapshot();
  assert.equal(saved.units[0].status, 'stocked');
});

test('preparation guards bind exact paused offer/category/snapshot and prohibit category sharing', async t => {
  const { ledger } = await setup(t);
  const request = { offerId: '10', batchId: 'batch', sourceIds: ['source'], guard: guard() };
  for (const changed of [{ pausedVerified: false }, { dedicatedStorageVerified: false }, { emptyStorageVerified: false }, { storageCategoryId: ['20'] }, { snapshotHash: 'invented' }]) {
    await assert.rejects(ledger.reservePreparationBatch({ ...request, guard: { ...guard(), ...changed } }));
  }
  await ledger.reservePreparationBatch(request);
  await assert.rejects(ledger.reservePreparationBatch({ ...request, guard: { ...guard(), storageNameHash: 'c'.repeat(64) } }), { code: 'BATCH_CONFLICT' });
  await assert.rejects(ledger.reservePreparationBatch({ ...request, batchId: 'another', sourceIds: ['another-source'] }), { code: 'PREPARATION_CONFLICT' });
  await assert.rejects(ledger.reservePreparationBatch({ ...request, batchId: 'another', offerId: '11', sourceIds: ['another-source'] }), { code: 'PREPARATION_CONFLICT' });
  await assert.rejects(ledger.beginPreparationUpload('batch', 'attempt', { ...guard(), categoryId: '41' }), { code: 'PREPARATION_UNVERIFIED' });
});

test('live disabled flag two bootstraps, then an enabled replay reconciles without another import or empty proof', async t => {
  const { options, state, ledger } = await setup(t);
  assert.equal((await prepareReservedBatch(options)).status, 'stocked');
  options.verifyDedicatedStorage = async () => { throw new Error('Must not ask nonempty category to prove empty again'); };
  assert.equal((await prepareReservedBatch(options)).status, 'stocked');
  assert.equal(state.writes, 1); assert.equal(state.configWrites, 1); assert.equal(state.dedicatedReads, 1);
  assert.equal((await ledger.snapshot()).offers[0].automaticDeliveryEnabled, true);
});

test('foreign/unknown delivery binding and dedicated-creation evidence fail before import', async t => {
  for (const change of [state => state.settings.id = '11', state => state.settings.storage_id = '21', state => state.settings.is_auto_deliver = 0]) {
    const { options, state } = await setup(t); change(state);
    await assert.rejects(prepareReservedBatch(options), { code: 'DELIVERY_UNVERIFIED' }); assert.equal(state.writes, 0);
  }
  const { options, state } = await setup(t);
  options.verifyDedicatedStorage = async input => ({ ...input, storageId: '21', verified: true });
  await assert.rejects(prepareReservedBatch(options), { code: 'STORAGE_UNVERIFIED' }); assert.equal(state.writes, 0);
});

test('partial, extra, duplicate and foreign readback cannot enable native delivery', async t => {
  for (const mutate of [remote => remote.total++, remote => remote.matched[0].productId = [90], remote => remote.matched[0].gameId = '31', remote => remote.matched[0].unsoldVerified = false, remote => remote.missing.push(0)]) {
    const { options, state, protocol, matched, ledger } = await setup(t);
    protocol.reconcileUploadedUnits = async () => {
      if (!state.uploaded) return { complete: true, total: 0, observed: 0, matched: [], missing: [0], ambiguous: [] };
      const remote = matched(); mutate(remote); return remote;
    };
    const result = await prepareReservedBatch(options);
    assert.equal(result.status, 'held'); assert.equal(state.writes, 1); assert.equal(state.configWrites, 0);
    assert.equal((await ledger.snapshot()).offers[0].automaticDeliveryEnabled, false);
    assert.equal((await prepareReservedBatch(options)).status, 'held'); assert.equal(state.writes, 1);
  }
});

test('lost configuration response can converge only from fresh settings and unchanged paused offer', async t => {
  const { options, state, protocol } = await setup(t);
  const configure = protocol.configureNativeDelivery;
  protocol.configureNativeDelivery = async () => { await configure(); throw new Error('Synthetic lost response'); };
  assert.equal((await prepareReservedBatch(options)).status, 'stocked');
  assert.equal(state.writes, 1); assert.equal(state.configWrites, 1);
});

test('source proof is renewed after a slow dedicated-category scan before any dispatch intent', async t => {
  const { options, state, ledger } = await setup(t);
  let changed = false, proofs = 0;
  options.verifyReservation = async ({ offerId, sourceIds }) => {
    proofs++;
    if (changed) throw new Error('Synthetic credentials changed while category scan was pending');
    return { verified: true, reservationId: 'reservation', offerId, sourceIds };
  };
  options.verifyDedicatedStorage = async input => { changed = true; return { ...input, verified: true }; };
  await assert.rejects(prepareReservedBatch(options), { code: 'RESERVATION_UNVERIFIED' });
  assert.equal(proofs, 2); assert.equal(state.writes, 0);
  assert.equal((await ledger.snapshot()).batches[0].attemptId, '');
});
