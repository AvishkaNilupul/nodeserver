'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStorageFields, buildDeliveryFields, stockEvidence, createVaultProtocol } = require('../utils/z2u/vaultProtocol');

test('unsafe numeric IDs and array IDs cannot silently address a different offer or category', () => {
  for (const offerId of [Number.MAX_SAFE_INTEGER + 1, [123]]) {
    assert.throws(() => buildDeliveryFields({ offerId, storageId: '12', maxPurchaseQuantity: 1 }));
  }
  assert.throws(() => buildStorageFields({ gameId: Number.MAX_SAFE_INTEGER + 1, categoryId: '1', name: 'Synthetic', kind: 'code' }));
  assert.equal(buildDeliveryFields({ offerId: '9007199254740993', storageId: '12', maxPurchaseQuantity: 1 }).id, '9007199254740993');
});

test('boolean or composite status fields cannot be coerced into verified unsold evidence', () => {
  const product = { delete_time: 0, wd_order: '', buy_user_id: 0, buy_order: 0, used_time: null };
  for (const status of [true, [1], '1e0', '01']) assert.equal(stockEvidence({ ...product, status }).unsoldVerified, false);
  assert.equal(stockEvidence({ ...product, status: 1 }).unsoldVerified, true);
  assert.equal(stockEvidence({ ...product, status: '1' }).unsoldVerified, true);
});

test('storage auto-delivery note respects the observed 200-character server limit', () => {
  const input = { gameId: '13', categoryId: '14', name: 'Synthetic storage', kind: 'account' };
  assert.equal(buildStorageFields({ ...input, deliveryNote: 'x'.repeat(200) }).delivery_note.length, 200);
  assert.throws(() => buildStorageFields({ ...input, deliveryNote: 'x'.repeat(201) }), TypeError);
  assert.equal(buildStorageFields({ ...input, deliveryNote: '' }).delivery_note, '');
});

test('sending limit exceeds purchase maximum while verified listing maximum remains unchanged', async () => {
  const options = { offerId: '15', storageId: '12', maxPurchaseQuantity: 1 };
  let written;
  const protocol = createVaultProtocol({
    readPage: async () => { throw new Error('Unexpected page read'); },
    mutate: async (_route, makeBody) => { written = Object.fromEntries(makeBody()); options.maxPurchaseQuantity = 99; return { acknowledged: true }; },
    readJson: async () => written,
  });
  const result = await protocol.configureNativeDelivery(options);
  assert.equal(written.buy_more, '2');
  assert.equal(result.maxPurchaseQuantity, 1);
  assert.equal(result.verified, true);
  assert.equal(Object.hasOwn(written, 'list_max_num'), false);
  assert.equal(Object.hasOwn(written, 'list_stock_num'), false);
});

test('sending-limit increment rejects overflow and cannot accept stale lower readback', async () => {
  const base = { offerId: '15', storageId: '12' };
  for (const value of [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '1', true, 1.5]) {
    assert.throws(() => buildDeliveryFields({ ...base, maxPurchaseQuantity: value }), TypeError);
  }
  assert.equal(buildDeliveryFields({ ...base, maxPurchaseQuantity: Number.MAX_SAFE_INTEGER - 1 }).buy_more, String(Number.MAX_SAFE_INTEGER));
  const fields = buildDeliveryFields({ ...base, maxPurchaseQuantity: 1 });
  let writes = 0;
  const protocol = createVaultProtocol({ readPage: async () => { throw new Error('Unexpected page read'); }, mutate: async () => { writes++; return { acknowledged: true }; }, readJson: async () => ({ ...fields, buy_more: '1' }) });
  await assert.rejects(protocol.configureNativeDelivery({ ...base, maxPurchaseQuantity: 1 }), { code: 'WRITE_UNCERTAIN', uncertain: true });
  assert.equal(writes, 1);
});
