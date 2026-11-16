'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { SCALARS, ARRAYS } = require('../utils/z2u/offers');
const { parseDocument } = require('../utils/z2u/runtime');
const { openVaultLedger } = require('../utils/z2u/vaultLedger');
const { prepareReservedBatch } = require('../utils/z2u/vaultPrepare');
const run = promisify(execFile);

function snapshot() {
  const fields = Object.fromEntries([...SCALARS.map(name => [name, '1']), ...ARRAYS.map(name => [name, []])]);
  Object.assign(fields, { list_pk: '15', list_title: 'Synthetic paused one-account offer', list_description: 'Synthetic complete promise' });
  return { verified: true, offerId: '15', gameId: '13', categoryId: '14', status: 'paused', statusCode: 4,
    title: fields.list_title, description: fields.list_description, fields, constraints: { ready: true, maxPurchaseQuantity: 1 } };
}
const empty = () => ({ complete: true, total: 0, observed: 0, matched: [], missing: [0], ambiguous: [] });
const mapped = () => ({ complete: true, total: 1, observed: 1, missing: [], ambiguous: [], matched: [{ unitIndex: 0,
  productId: '11', storageId: '12', gameId: '13', categoryId: '14', status: 1, usedTime: null, saleReference: null, unsoldVerified: true }] });
const native = enabled => ({ id: 15, storage_id: enabled ? 12 : 0, is_auto_deliver: enabled ? 1 : 2, outstock: 1, is_agiso: 0, buy_more: 1 });

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'z2u-vault-prepare-review-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ledger.json'), ledger = openVaultLedger(file);
  const state = { imported: false, enabled: false, imports: 0, configs: 0, pauses: 0, status: 'paused',
    storage: { id: 12, gid: 13, category_id: 14, name: 'Synthetic dedicated vault', type: 1, is_repeat: 2 } };
  const expectedSnapshot = snapshot();
  const protocol = {
    readOfferSnapshot: async () => ({ ...structuredClone(expectedSnapshot), status: state.status, statusCode: state.status === 'paused' ? 4 : 1 }),
    readStorage: async () => state.storage,
    reconcileUploadedUnits: async () => state.imported ? mapped() : empty(),
    importUnits: async () => { state.imports++; state.imported = true; return { acknowledged: true }; },
    configureNativeDelivery: async () => { state.configs++; state.enabled = true; return { verified: true }; },
    readOfferDelivery: async () => native(state.enabled),
    pauseOffer: async () => { state.pauses++; state.status = 'paused'; return { verified: true }; },
  };
  const input = { ledger, protocol, offerId: '15', storageId: '12', gameId: '13', categoryId: '14', expectedSnapshot,
    expectedStorageName: state.storage.name, batchId: 'batch', attemptId: 'attempt', kind: 'account',
    units: [{ sourceId: 'source', account: 'synthetic-account', password: 'fixture-only' }], maxPurchaseQuantity: 1, parseDocument,
    verifyDedicatedStorage: async identity => ({ ...identity, verified: true }),
    verifyReservation: async ({ offerId, batchId, sourceIds }) => ({ verified: true, reservationId: batchId, offerId, sourceIds }) };
  return { file, ledger, state, input };
}

test('preparation never claims automatic delivery before native configuration and fresh readback', async t => {
  const f = await fixture(t);
  const configure = f.input.protocol.configureNativeDelivery;
  f.input.protocol.configureNativeDelivery = async options => {
    const before = await f.ledger.snapshot();
    assert.equal(before.offers[0].automaticDeliveryEnabled, false);
    assert.notEqual(before.units[0].status, 'stocked');
    return configure(options);
  };
  const result = await prepareReservedBatch(f.input);
  assert.equal(result.verified, true);
  assert.equal(result.status, 'stocked');
  const saved = await f.ledger.snapshot();
  assert.equal(saved.offers[0].automaticDeliveryEnabled, true);
  assert.equal(saved.units[0].status, 'stocked');
  assert.equal(saved.units[0].storageId, '11');
  assert.equal(f.state.imports, 1);
  assert.equal(JSON.stringify(saved).includes('fixture-only'), false);
});

test('acknowledged configuration with disabled readback never upgrades held stock or automatic flags', async t => {
  const f = await fixture(t);
  f.input.protocol.configureNativeDelivery = async () => { f.state.configs++; return { verified: true }; };
  const result = await prepareReservedBatch(f.input);
  assert.notEqual(result.verified, true);
  const saved = await f.ledger.snapshot();
  assert.equal(saved.offers[0].automaticDeliveryEnabled, false);
  assert.notEqual(saved.units[0].status, 'stocked');
  assert.equal(f.state.imports, 1);
  assert.equal(f.state.configs, 1);
});

test('unexpected activation during configuration is contained and cannot become stocked', async t => {
  const f = await fixture(t);
  f.input.protocol.configureNativeDelivery = async () => { f.state.configs++; f.state.enabled = true; f.state.status = 'on_sale'; return { verified: true }; };
  const result = await prepareReservedBatch(f.input);
  assert.notEqual(result.verified, true);
  assert.equal(f.state.pauses, 1);
  assert.equal(f.state.status, 'paused');
  assert.notEqual((await f.ledger.snapshot()).units[0].status, 'stocked');
  assert.equal(f.state.imports, 1);
});

test('local journal failure cannot suppress native containment after unexpected activation', async t => {
  const f = await fixture(t);
  const disable = f.ledger.disableOffer;
  f.ledger.disableOffer = async offerId => { if (f.state.imported) throw new Error('Synthetic disk failure'); return disable(offerId); };
  f.input.protocol.configureNativeDelivery = async () => { f.state.enabled = true; f.state.status = 'on_sale'; return { verified: true }; };
  // Skip the optional pre-configuration disable attempt so the injected write
  // failure specifically occurs while handling the unexpected activation.
  f.input.protocol.readOfferDelivery = async () => native(f.state.imported);
  f.input.protocol.reconcileUploadedUnits = async () => {
    if (f.state.imported) f.state.status = 'on_sale';
    return f.state.imported ? mapped() : empty();
  };
  const result = await prepareReservedBatch(f.input);
  assert.notEqual(result.verified, true);
  assert.equal(f.state.pauses, 1);
  assert.equal(f.state.status, 'paused');
  assert.notEqual((await f.ledger.snapshot()).units[0].status, 'stocked');
});

test('missing or mismatched dedicated-category provenance blocks upload before intent', async t => {
  for (const callback of [undefined, async () => ({ verified: true }), async identity => ({ ...identity, verified: false }),
    async identity => ({ ...identity, verified: true, storageId: '99' })]) {
    const f = await fixture(t); f.input.verifyDedicatedStorage = callback;
    await assert.rejects(prepareReservedBatch(f.input));
    assert.equal(f.state.imports, 0);
    assert.ok(!(await f.ledger.snapshot()).batches.some(batch => batch.attemptId));
  }
});

test('wrong storage ownership, name or repeatability and nonempty initial categories block import', async t => {
  for (const patch of [{ name: 'Another vault' }, { gid: 99 }, { category_id: 99 }, { id: 99 }, { type: 2 }, { is_repeat: 1 }]) {
    const f = await fixture(t); Object.assign(f.state.storage, patch);
    await assert.rejects(prepareReservedBatch(f.input));
    assert.equal(f.state.imports, 0);
    assert.equal(f.state.configs, 0);
  }
  const f = await fixture(t); f.input.protocol.reconcileUploadedUnits = async () => mapped();
  await assert.rejects(prepareReservedBatch(f.input));
  assert.equal(f.state.imports, 0);
});

test('process exit inside native import leaves a non-resendable preparation intent and replay reconciles', async t => {
  const f = await fixture(t);
  const source = `
const { openVaultLedger } = require(process.argv[1]);
const { prepareReservedBatch } = require(process.argv[2]);
const input = JSON.parse(process.argv[4]);
input.ledger = openVaultLedger(process.argv[3]);
input.parseDocument = () => ({});
input.verifyReservation = async ({ offerId, batchId, sourceIds }) => ({ verified: true, reservationId: batchId, offerId, sourceIds });
input.verifyDedicatedStorage = async identity => ({ ...identity, verified: true });
input.protocol = {
 readOfferSnapshot: async () => input.expectedSnapshot,
 readStorage: async () => ({ id: 12, gid: 13, category_id: 14, name: input.expectedStorageName, type: 1, is_repeat: 2 }),
 reconcileUploadedUnits: async () => ({ complete: true, total: 0, observed: 0, matched: [], missing: [0], ambiguous: [] }),
 importUnits: async () => process.exit(17),
 configureNativeDelivery: async () => process.exit(98), readOfferDelivery: async () => ({ id: '15', is_auto_deliver: 2, storage_id: 0 }), pauseOffer: async () => ({ verified: true }),
};
prepareReservedBatch(input).then(() => process.exit(97), () => process.exit(99));
`;
  const { ledger, protocol, parseDocument, verifyReservation, ...serializable } = f.input;
  await assert.rejects(run(process.execPath, ['-e', source, require.resolve('../utils/z2u/vaultLedger'), require.resolve('../utils/z2u/vaultPrepare'), f.file, JSON.stringify(serializable)]), { code: 17 });
  const interrupted = await f.ledger.snapshot();
  assert.equal(interrupted.batches[0].attemptId, 'attempt');
  assert.notEqual(interrupted.units[0].status, 'stocked');
  assert.equal(interrupted.offers[0].automaticDeliveryEnabled, false);
  f.state.imported = true;
  const result = await prepareReservedBatch(f.input);
  assert.equal(result.verified, true);
  assert.equal(result.status, 'stocked');
  assert.equal(f.state.imports, 0);
  assert.equal(f.state.configs, 1);
  assert.equal((await f.ledger.snapshot()).units[0].storageId, '11');
});
