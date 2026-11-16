'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStorageFields, buildDeliveryFields, stockEvidence } = require('../utils/z2u/vaultProtocol');

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
