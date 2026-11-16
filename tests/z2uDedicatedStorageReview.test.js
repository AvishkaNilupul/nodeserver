'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDocument } = require('../utils/z2u/runtime');
const { verifyDedicatedStorage } = require('../utils/z2u/dedicatedStorage');
const NOW = Date.parse('2026-11-16T12:00:00.000Z');

function fixture() {
  const offer = { offerId: '15', storageId: '12', gameId: '13', categoryId: '14' };
  const row = (offerId, status = 'expired', statusCode = 5) => ({ offerId, status, statusCode });
  const group = (offers, pages) => ({ valid: true, context: { gameId: '13', categoryId: '14' }, offers, pages });
  const groups = { 1: group([row('15', 'paused', 4)], [1, 2]), 2: group([row('16')], [1, 2]), 3: group([row('17')], [1, 3]) };
  const pagesRead = [], settings = { '15': { id: 15, storage_id: 0 }, '16': { id: 16, storage_id: 0 }, '17': { id: 17, storage_id: 0 } };
  const input = { offer, provenance: { version: 1, ...offer, name: 'Synthetic vault', createdAt: '2026-11-16T11:00:00.000Z' }, parseDocument, now: () => NOW,
    protocol: {
      readStorage: async () => ({ id: 12, gid: 13, category_id: 14, name: 'Synthetic vault', type: 1, is_repeat: 2, parent_id: 0 }),
      readStorageOptions: async () => '<option value="12" class="is_last" data-num="0" data-type="1">Synthetic vault</option>',
      readCategoriesPage: async () => '<div id="menus-table"><div id="node-12"><div><input class="checkone" data="12"></div><div>Stock 0</div><div>Used 0</div><div>Totals 0</div><div class="action-btn-group" data-id="12" data-gid="13" data-category_id="14" data-type="1"></div></div></div>',
      readStoragePage: async () => '<h1>Storage List (Totals:0)</h1><div id="productlist"></div>',
      readOfferGroup: async ({ page }) => { pagesRead.push(page); return groups[page]; },
      readOfferDelivery: async id => settings[id],
    } };
  return { input, groups, pagesRead, settings };
}

test('pagination gaps cannot hide another offer linked to the dedicated category', async () => {
  const f = fixture();
  f.groups[1].pages = [1, 3];
  f.settings['16'].storage_id = 12;
  await assert.rejects(verifyDedicatedStorage(f.input), { code: 'STORAGE_DEDICATION_UNVERIFIED' });
  assert.ok(f.pagesRead.includes(2));
});

test('empty advertised pages cannot count as a complete exclusivity scan', async () => {
  const f = fixture(); f.groups[2].offers = [];
  await assert.rejects(verifyDedicatedStorage(f.input), { code: 'STORAGE_DEDICATION_UNVERIFIED' });
});

test('expanding numbered pagination still respects the configured page bound', async () => {
  const f = fixture(); f.groups[1].pages = [1, 3]; f.input.maxPages = 2;
  await assert.rejects(verifyDedicatedStorage(f.input), { code: 'STORAGE_DEDICATION_UNVERIFIED' });
  assert.ok(f.pagesRead.length <= 2);
});

test('an invalid local clock cannot make provenance appear fresh', async () => {
  const f = fixture(); f.input.now = () => NaN;
  await assert.rejects(verifyDedicatedStorage(f.input), { code: 'STORAGE_DEDICATION_UNVERIFIED' });
  assert.equal(f.pagesRead.length, 0);
});
