'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { stockOffer, reconcileOffer } = require('../utils/z2u/engine');
const { openVaultLedger } = require('../utils/z2u/vaultLedger');
const { SCALARS, ARRAYS } = require('../utils/z2u/offers');

function adopted() {
  const fields = Object.fromEntries(SCALARS.map(name => [name, 'synthetic']));
  Object.assign(fields, { list_pk: '15', list_max_num: '5', list_less_num: '1', list_stock_num: '1' });
  for (const name of ARRAYS) fields[name] = [];
  return { offerId: '15', storageId: '12', gameId: '13', categoryId: '14', kind: 'account',
    setId: '111111111111111111111111', maxPurchaseQuantity: 5,
    expectedSnapshot: { verified: true, offerId: '15', gameId: '13', categoryId: '14',
      title: 'Synthetic offer', description: 'Synthetic description', status: 'on_sale', fields,
      constraints: { ready: true, maxPurchaseQuantity: 5 } } };
}
const settings = () => ({ id: 15, storage_id: 12, is_auto_deliver: 1, outstock: 1, is_agiso: 0, buy_more: 5 });
const unsold = () => ({ id: 11, storage_id: 12, gid: 13, category_id: 14, status: 1,
  delete_time: 0, wd_order: '', buy_user_id: 0, buy_order: 0, used_time: null });
const consumed = () => ({ ...unsold(), status: 2, buy_user_id: 99, buy_order: 'Z101', used_time: '2026-11-16 12:00:00' });
const receipt = () => ({ verified: true, deliverySucceeded: true, receiptId: 'synthetic-receipt',
  offerId: '15', productId: '11', storageId: '12', gameId: '13', categoryId: '14', saleReference: 'Z101' });
const readback = () => ({ complete: true, total: 1, observed: 1, missing: [], ambiguous: [],
  matched: [{ unitIndex: 0, productId: '11', storageId: '12', gameId: '13', categoryId: '14',
    unsoldVerified: true, status: 1, usedTime: null, saleReference: null }] });

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'z2u-engine-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = openVaultLedger(path.join(directory, 'ledger.json'));
  const offer = adopted(), calls = { reserve: 0, import: 0, release: 0, manual: 0, product: 0, pause: 0, sale: [] };
  let actual = structuredClone(offer.expectedSnapshot);
  const reservation = { status: 'reserved', expiresAt: '2026-12-01T00:00:00.000Z',
    units: [{ sourceId: 'source', account: 'synthetic-account', password: 'fixture-only' }],
    verifyReservation: async ({ offerId, batchId, sourceIds }) => ({ verified: true, reservationId: batchId, offerId, sourceIds }) };
  const stockAdapter = {
    reserveExactBatch: async () => { calls.reserve++; return reservation; },
    markDelivered: async value => { calls.sale.push(value); return { status: 'delivered' }; },
    readBatchState: async () => ({ status: 'reserved', expiresAt: '2099-12-01T00:00:00.000Z', holdCount: 1 }),
    release: async () => { calls.release++; throw new Error('Forbidden release'); },
    manualDeliver: async () => { calls.manual++; throw new Error('Forbidden manual delivery'); },
  };
  const protocol = {
    readOfferSnapshot: async () => structuredClone(actual), readOfferDelivery: async () => settings(),
    importUnits: async () => { calls.import++; return { acknowledged: true }; },
    reconcileUploadedUnits: async () => readback(),
    readProduct: async () => { calls.product++; return unsold(); },
    pauseOffer: async () => { calls.pause++; return { verified: true }; },
    manualDeliver: stockAdapter.manualDeliver, release: stockAdapter.release,
  };
  const input = { ledger, offer, stockAdapter, protocol, count: 1, batchId: 'batch', attemptId: 'attempt' };
  return { ...input, calls, reservation, setActual: next => { actual = next; } };
}

test('stock requires an exact adopted snapshot before making any source reservation', async t => {
  const f = await fixture(t);
  f.setActual({ ...f.offer.expectedSnapshot, description: 'Changed promise' });
  await assert.rejects(stockOffer(f), { code: 'OFFER_UNVERIFIED' });
  assert.equal(f.calls.reserve, 0);
  assert.equal(f.calls.import, 0);
  for (const count of [0, 6, 1.5]) await assert.rejects(stockOffer({ ...f, count }), { code: 'INVALID_STOCK_REQUEST' });
});

test('incomplete upstream reservation stays held without upload or manual fallback', async t => {
  const f = await fixture(t);
  f.reservation.units = [];
  assert.equal((await stockOffer(f)).status, 'held');
  assert.equal((await f.ledger.snapshot()).units.length, 0);
  assert.deepEqual([f.calls.import, f.calls.release, f.calls.manual], [0, 0, 0]);
});

test('changed snapshot after allocation stops before import while sources remain held upstream', async t => {
  const f = await fixture(t);
  f.stockAdapter.reserveExactBatch = async () => {
    f.calls.reserve++;
    f.setActual({ ...f.offer.expectedSnapshot, description: 'Changed during allocation' });
    return f.reservation;
  };
  await assert.rejects(stockOffer(f), { code: 'RESERVATION_UNVERIFIED' });
  assert.deepEqual([f.calls.import, f.calls.release, f.calls.manual], [0, 0, 0]);
});

test('snapshot is refreshed after slow reservation verification before native import', async t => {
  const f = await fixture(t);
  const verify = f.reservation.verifyReservation;
  f.reservation.verifyReservation = async input => {
    const result = await verify(input);
    f.setActual({ ...f.offer.expectedSnapshot, description: 'Changed during inventory read' });
    return result;
  };
  await assert.rejects(stockOffer(f), { code: 'RESERVATION_UNVERIFIED' });
  assert.deepEqual([f.calls.import, f.calls.release, f.calls.manual], [0, 0, 0]);
});

test('upload failure preserves original attempt on replay and never resends or frees sources', async t => {
  const f = await fixture(t);
  f.protocol.importUnits = async () => { f.calls.import++; throw new Error('PRIVATE upstream response'); };
  f.protocol.reconcileUploadedUnits = async () => { throw new Error('PRIVATE readback'); };
  const first = await stockOffer(f);
  assert.equal(first.status, 'reconciliation_required');
  assert.equal(first.attemptId, 'attempt');
  assert.equal((await f.ledger.snapshot()).units[0].status, 'upload_uncertain');
  const replay = await stockOffer({ ...f, attemptId: 'new-attempt-must-not-replace-intent' });
  assert.equal(replay.attemptId, 'attempt');
  assert.equal(replay.dispatched, false);
  assert.equal(JSON.stringify([first, replay]).includes('PRIVATE'), false);
  assert.deepEqual([f.calls.import, f.calls.release, f.calls.manual], [1, 0, 0]);
  assert.equal((await f.ledger.snapshot()).units[0].status, 'upload_uncertain');
});

test('native verified readback establishes the exact product mapping', async t => {
  const f = await fixture(t);
  const result = await stockOffer(f);
  assert.equal(result.status, 'stocked');
  assert.equal(result.verified, true);
  const unit = (await f.ledger.snapshot()).units[0];
  assert.deepEqual([unit.sourceId, unit.offerId, unit.storageId, unit.status], ['source', '15', '11', 'stocked']);
  assert.equal(f.calls.import, 1);
  const reconcile = await reconcileOffer(f);
  assert.equal(reconcile.ready, true);
  assert.equal(reconcile.counts.unsold, 1);
});

test('changed or unreadable listing does not suppress committed sale reconciliation', async t => {
  const f = await fixture(t);
  await stockOffer(f);
  f.protocol.readProduct = async () => { f.calls.product++; return consumed(); };
  f.setActual({ ...f.offer.expectedSnapshot, status: 'paused', description: 'Changed after sale' });
  const result = await reconcileOffer({ ...f, verifyDeliveryReceipt: async () => receipt() });
  assert.equal(result.ready, false);
  assert.equal(result.counts.delivered, 1);
  assert.equal(f.calls.sale[0].saleReference, 'Z101');
  f.protocol.readOfferSnapshot = async () => { throw new Error('PRIVATE offer unavailable'); };
  const replay = await reconcileOffer(f);
  assert.equal(replay.counts.delivered, 1);
  assert.equal(f.calls.sale.length, 2);
  assert.equal(f.calls.product, 1);
  assert.equal(f.calls.sale[1].saleReference, 'Z101');
});

test('crash after delivery journal commit replays allocator sale projection from persisted evidence', async t => {
  const f = await fixture(t);
  await stockOffer(f);
  f.protocol.readProduct = async () => { f.calls.product++; return consumed(); };
  f.stockAdapter.markDelivered = async value => { f.calls.sale.push(value); throw new Error('Synthetic projection failure'); };
  await assert.rejects(reconcileOffer({ ...f, verifyDeliveryReceipt: async () => receipt() }), /projection failure/);
  assert.equal((await f.ledger.snapshot()).units[0].status, 'delivered');
  f.stockAdapter.markDelivered = async value => { f.calls.sale.push(value); return { status: 'delivered' }; };
  const result = await reconcileOffer(f);
  assert.equal(result.counts.delivered, 1);
  assert.deepEqual(f.calls.sale[1], f.calls.sale[0]);
  assert.equal(f.calls.product, 1);
  assert.equal(f.calls.sale[1].saleReference, 'Z101');
});

test('consumption without a successful receipt remains held with no manual fallback', async t => {
  const f = await fixture(t);
  await stockOffer(f);
  f.protocol.readProduct = async () => consumed();
  const result = await reconcileOffer(f);
  assert.equal(result.ready, false);
  assert.equal(result.saleReconciliation, 'held');
  assert.equal(result.counts.consumed_pending_confirmation, 1);
  assert.equal((await f.ledger.snapshot()).units[0].status, 'stocked');
  assert.deepEqual([f.calls.sale.length, f.calls.release, f.calls.manual], [0, 0, 0]);
});

test('delivered-only history cannot prove current sellable stock readiness', async t => {
  const f = await fixture(t);
  await stockOffer(f);
  f.protocol.readProduct = async () => consumed();
  const result = await reconcileOffer({ ...f, verifyDeliveryReceipt: async () => receipt() });
  assert.equal(result.counts.delivered, 1);
  assert.equal(result.counts.unsold, 0);
  assert.equal(result.ready, false);
});

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

test('known expiry beyond the safety buffer keeps mapped unsold stock ready', async t => {
  const f = await fixture(t);
  await stockOffer(f);
  f.stockAdapter.readBatchState = async input => {
    assert.deepEqual(input, { batchId: 'batch', offerId: '15' });
    return { expiresAt: new Date(NOW + 7 * HOUR).toISOString(), holdCount: 1 };
  };
  const result = await reconcileOffer({ ...f, now: () => NOW });
  assert.equal(result.ready, true);
  assert.equal(result.protection, 'verified');
  assert.equal(f.calls.pause, 0);
});

test('near, missing, or malformed expiry and missing reservation holds pause before product reads', async t => {
  const cases = [
    ['inside buffer', { expiresAt: new Date(NOW + 5 * HOUR).toISOString(), holdCount: 1 }],
    ['exact buffer', { expiresAt: new Date(NOW + 6 * HOUR).toISOString(), holdCount: 1 }],
    ['expired', { expiresAt: new Date(NOW - HOUR).toISOString(), holdCount: 1 }],
    ['missing expiry', { holdCount: 1 }],
    ['malformed expiry', { expiresAt: 'unknown', holdCount: 1 }],
    ['missing hold', { expiresAt: '2099-12-01T00:00:00.000Z', holdCount: 0 }],
    ['missing hold count', { expiresAt: '2099-12-01T00:00:00.000Z' }],
    ['coercible hold count', { expiresAt: '2099-12-01T00:00:00.000Z', holdCount: '1' }],
    ['boolean hold count', { expiresAt: '2099-12-01T00:00:00.000Z', holdCount: true }],
  ];
  for (const [name, source] of cases) await t.test(name, async t => {
    const f = await fixture(t);
    await stockOffer(f);
    const order = [];
    f.stockAdapter.readBatchState = async () => { order.push('expiry'); return source; };
    f.protocol.pauseOffer = async () => { order.push('pause'); f.calls.pause++; return { verified: true }; };
    f.protocol.readProduct = async () => { order.push('product'); return unsold(); };
    const result = await reconcileOffer({ ...f, now: () => NOW });
    assert.equal(result.ready, false);
    assert.equal(result.protection, 'expiry_hold');
    assert.deepEqual(order, ['expiry', 'pause', 'product']);
    assert.equal((await f.ledger.snapshot()).units[0].status, 'stocked');
    assert.deepEqual([f.calls.pause, f.calls.release, f.calls.manual], [1, 0, 0]);
  });
});

test('unavailable expiry adapter or invalid safety buffer cannot silently permit continued sales', async t => {
  const f = await fixture(t);
  await stockOffer(f);
  delete f.stockAdapter.readBatchState;
  const missing = await reconcileOffer({ ...f, now: () => NOW });
  assert.equal(missing.ready, false);
  assert.equal(missing.protection, 'expiry_hold');
  f.stockAdapter.readBatchState = async () => ({ expiresAt: '2099-12-01T00:00:00.000Z', holdCount: 1 });
  const short = await reconcileOffer({ ...f, now: () => NOW, expiryBufferMs: 0 });
  assert.equal(short.ready, false);
  assert.equal(short.protection, 'expiry_hold');
});

test('failed or unverified pause holds stock, never retries the mutation in the same pass', async t => {
  for (const throwError of [false, true]) await t.test(String(throwError), async t => {
    const f = await fixture(t);
    await stockOffer(f);
    f.stockAdapter.readBatchState = async () => ({ expiresAt: new Date(NOW).toISOString(), holdCount: 1 });
    f.protocol.pauseOffer = async () => {
      f.calls.pause++;
      if (throwError) throw new Error('PRIVATE uncertain pause');
      return { verified: false };
    };
    const result = await reconcileOffer({ ...f, now: () => NOW });
    assert.equal(result.ready, false);
    assert.equal(result.protection, 'pause_unverified');
    assert.equal(result.counts.unsold, 1);
    assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
    assert.equal((await f.ledger.snapshot()).units[0].status, 'stocked');
    assert.deepEqual([f.calls.pause, f.calls.release, f.calls.manual], [1, 0, 0]);
  });
});

test('listing drift requests protection while still reconciling a confirmed delivery', async t => {
  const f = await fixture(t);
  await stockOffer(f);
  f.setActual({ ...f.offer.expectedSnapshot, description: 'Changed after import' });
  f.protocol.readProduct = async () => { assert.equal(f.calls.pause, 1); return consumed(); };
  const result = await reconcileOffer({ ...f, now: () => NOW, verifyDeliveryReceipt: async () => receipt() });
  assert.equal(result.ready, false);
  assert.equal(result.protection, 'offer_hold');
  assert.equal(result.counts.delivered, 1);
  assert.equal(f.calls.sale[0].saleReference, 'Z101');
  assert.equal((await f.ledger.snapshot()).units[0].status, 'delivered');
});
