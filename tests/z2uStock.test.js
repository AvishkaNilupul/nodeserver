'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createZ2uStockAdapter } = require('../utils/z2u/stock');
const { openVaultLedger } = require('../utils/z2u/vaultLedger');

const SET = '111111111111111111111111';
const SOURCE = '222222222222222222222222';
const POOL = '333333333333333333333333';
const NOW = 1794787200000;
function fixture({ ledger } = {}) {
  const set = { _id: SET, stockSource: 'noclaim', items: [{ name: 'Skin', game: 'Rocket League', itemKey: 'skin|rocket league', qty: 2 }] };
  const batches = new Map();
  const rows = [];
  const pool = { _id: POOL, username: 'synthetic', clientSecret: 'synthetic-secret', status: 'claimed', claimedNote: 'noclaim-farm:Rocket League', soldGames: [], listed: true };
  const facts = { pool, ownerBlocked: false, bots: [], pools: [pool], siblings: [{ _id: SOURCE }], listings: [], skinHeld: false, archiveHeld: false, leased: false,
    candidates: [{ login: 'synthetic', clientSecret: 'synthetic-secret' }] };
  const live = { login: 'synthetic', inv: { login: 'synthetic', drops: [], inProgress: [] }, sellable: [{ itemKey: 'skin|rocket league' }, { itemKey: 'skin|rocket league' }] };
  let claims = 0, marked = 0;
  const state = { set, rows, batches, pool, facts, live, expires: NOW + 3 * 86400000, password: 'synthetic-password', policy: null, delivery: true };
  const stock = {
    deliveryEnabled: () => state.delivery,
    requiredFromSet: value => new Map(value.items.map(item => [item.itemKey, item.qty])),
    heldCounts: items => { const counts = new Map(); for (const item of items) counts.set(item.itemKey, (counts.get(item.itemKey) || 0) + 1); return counts; },
    wavesOfDrops: value => value,
    coverGoneAt: () => state.expires,
    async claimForSet(_set, _count, { listingId }) {
      claims++;
      rows.push({ _id: SOURCE, set: SET, source: 'noclaim', market: 'z2u', manualListing: listingId, status: 'manual', login: 'synthetic', loginLower: 'synthetic', poolAccountId: POOL });
    },
    async markSold(ids, options) { marked++; assert.deepEqual(ids, [SOURCE]); rows[0].status = 'sold'; rows[0].soldMarket = options.market; return 1; },
  };
  const deps = { stock, readSet: async () => set, readBatch: async id => batches.get(id),
    insertBatch: async batch => { if (batches.has(batch._id)) return false; batches.set(batch._id, structuredClone(batch)); return true; },
    saveBatch: async (id, fields) => Object.assign(batches.get(id), structuredClone(fields)),
    claimedRows: async anchor => rows.filter(row => row.manualListing === anchor).map(row => ({ ...row })),
    policyFor: async () => state.policy, context: async () => ({ base: {} }), facts: async () => facts,
    inventory: async () => live, credential: async () => ({ login: 'synthetic', password: state.password }),
  };
  const adapter = createZ2uStockAdapter({ ledger, adoptedOffers: [{ offerId: '10', setId: SET }], deps, now: () => NOW });
  const args = { batchId: 'batch-1', offerId: '10', setId: SET, count: 1 };
  return { state, deps, adapter, args, calls: () => ({ claims, marked }) };
}

test('source reservation uses the real allocator once and recovers identical source after restart', async () => {
  const f = fixture();
  const first = await f.adapter.reserveExactBatch(f.args);
  assert.equal(first.status, 'reserved');
  assert.deepEqual(first.units, [{ sourceId: SOURCE, account: 'synthetic', password: 'synthetic-password' }]);
  const receipt = await first.verifyReservation({ batchId: 'batch-1', offerId: '10', sourceIds: [SOURCE] });
  assert.equal(receipt.verified, true);
  const restarted = createZ2uStockAdapter({ adoptedOffers: [{ offerId: '10', setId: SET }], deps: f.deps, now: () => NOW });
  assert.equal((await restarted.reserveExactBatch(f.args)).status, 'reserved');
  assert.equal(f.calls().claims, 1);
  assert.equal(JSON.stringify([...f.state.batches.values()]).includes('synthetic-password'), false);
});

test('concurrent retries share the durable anchor and cannot dispatch another claim', async () => {
  const f = fixture();
  await Promise.all(Array.from({ length: 5 }, () => f.adapter.reserveExactBatch(f.args)));
  assert.equal(f.calls().claims, 1);
  assert.equal(f.state.rows.length, 1);
});

test('crash after committed claim recovers the same source; partial claims stay held without replacement', async () => {
  const f = fixture();
  const original = f.deps.stock.claimForSet;
  f.deps.stock.claimForSet = async (...args) => { await original(...args); throw new Error('synthetic secret from network'); };
  assert.equal((await f.adapter.reserveExactBatch(f.args)).status, 'reserved');
  const partial = fixture();
  const a = { ...partial.args, count: 2 };
  assert.equal((await partial.adapter.reserveExactBatch(a)).status, 'held');
  assert.equal((await partial.adapter.reserveExactBatch(a)).status, 'held');
  assert.equal(partial.calls().claims, 1);
});

test('crash before allocator leaves a durable empty hold rather than allocating on retry', async () => {
  const f = fixture();
  f.deps.stock.claimForSet = async () => { throw new Error('uncertain'); };
  assert.equal((await f.adapter.reserveExactBatch(f.args)).status, 'held');
  let retried = false;
  f.deps.stock.claimForSet = async () => { retried = true; };
  assert.equal((await f.adapter.reserveExactBatch(f.args)).status, 'held');
  assert.equal(retried, false);
});

test('immutable batch identity rejects another offer, set quantity or changed promise', async () => {
  const f = fixture();
  await f.adapter.reserveExactBatch(f.args);
  for (const changed of [{ offerId: '11' }, { count: 2 }]) {
    await assert.rejects(f.adapter.reserveExactBatch({ ...f.args, ...changed }), { code: changed.offerId ? 'OFFER_NOT_ADOPTED' : 'BATCH_CONFLICT' });
  }
  f.state.set.items[0].qty = 1;
  await assert.rejects(f.adapter.reserveExactBatch(f.args), { code: 'BATCH_CONFLICT' });
  assert.equal(f.calls().claims, 1);
});

test('whole inventory, ownership, duplicates, leases, connected and expiry fail closed', async t => {
  const cases = [
    ['short bundle', f => f.state.live.sellable.pop(), 'BUNDLE_MISMATCH'],
    ['extra bundle', f => f.state.live.sellable.push({ itemKey: 'other|rocket league' }), 'BUNDLE_MISMATCH'],
    ['connected unrelated game', f => f.state.live.inv.drops.push({ connected: true }), 'SOURCE_CONNECTED'],
    ['connected progress', f => f.state.live.inv.inProgress.push({ connected: true }), 'SOURCE_CONNECTED'],
    ['partial response', f => delete f.state.live.inv.drops, 'INVENTORY_UNVERIFIED'],
    ['renamed live identity', f => f.state.live.inv.login = 'renamed', 'INVENTORY_UNVERIFIED'],
    ['unknown expiry', f => f.state.expires = Infinity, 'EXPIRY_UNVERIFIED'],
    ['expired reward', f => f.state.expires = NOW, 'EXPIRY_UNVERIFIED'],
    ['sold another game', f => f.state.pool.soldGames.push('Other'), 'SOURCE_COMMITTED'],
    ['renter', f => f.state.facts.leased = true, 'SOURCE_COMMITTED'],
    ['skin account', f => f.state.facts.skinHeld = true, 'SOURCE_COMMITTED'],
    ['archive reservation', f => f.state.facts.archiveHeld = true, 'SOURCE_COMMITTED'],
    ['duplicate ledger', f => f.state.facts.siblings.push({ _id: '444444444444444444444444' }), 'DUPLICATE_IDENTITY'],
    ['duplicate pool', f => f.state.facts.pools.push({ _id: '444444444444444444444444' }), 'DUPLICATE_IDENTITY'],
    ['other token for login', f => f.state.facts.bots.push({ login: 'synthetic', clientSecret: 'other', container: 'noclaim-bot-1' }), 'SOURCE_COMMITTED'],
    ['reseller', f => f.state.facts.bots.push({ login: 'synthetic', clientSecret: 'synthetic-secret', container: 'noclaim-bot-1', resellerId: 'reseller' }), 'SOURCE_COMMITTED'],
    ['other listing', f => f.state.facts.listings.push({ marketplace: 'g2g', externalId: '10' }), 'SOURCE_COMMITTED'],
    ['another Z2U offer', f => f.state.facts.listings.push({ marketplace: 'z2u', externalId: '11' }), 'SOURCE_COMMITTED'],
    ['not in fleet', f => f.state.facts.candidates = [], 'OWNER_UNVERIFIED'],
    ['pool owned by renter', f => f.state.pool.claimedNote = 'renter:someone', 'OWNER_UNVERIFIED'],
  ];
  for (const [name, mutate, reason] of cases) await t.test(name, async () => {
    const f = fixture(); mutate(f);
    const result = await f.adapter.reserveExactBatch(f.args);
    assert.equal(result.status, 'held'); assert.equal(result.reason, reason); assert.deepEqual(result.units, []);
    assert.equal(f.state.rows[0].status, 'manual');
  });
});

test('post-network ownership and credential bytes are checked again before import receipt', async () => {
  const f = fixture();
  const reserved = await f.adapter.reserveExactBatch(f.args);
  f.state.password = 'rotated';
  await assert.rejects(reserved.verifyReservation({ ...f.args, sourceIds: [SOURCE] }), { code: 'CREDENTIAL_CHANGED' });
  f.state.password = 'synthetic-password';
  f.deps.inventory = async () => { f.state.facts.leased = true; return f.state.live; };
  await assert.rejects(reserved.verifyReservation({ ...f.args, sourceIds: [SOURCE] }), { code: 'SOURCE_COMMITTED' });
});

test('policy, malformed IDs, scoped source and disabled delivery cannot allocate', async () => {
  const f = fixture();
  for (const value of [[10], {}, Number.MAX_SAFE_INTEGER + 1, '01']) {
    await assert.rejects(f.adapter.reserveExactBatch({ ...f.args, offerId: value }), { code: 'INVALID_ID' });
  }
  const unadopted = createZ2uStockAdapter({ deps: f.deps, now: () => NOW });
  await assert.rejects(unadopted.reserveExactBatch(f.args), { code: 'OFFER_NOT_ADOPTED' });
  f.state.set.accountScopeIds = [POOL];
  await assert.rejects(f.adapter.reserveExactBatch(f.args), { code: 'UNSUPPORTED_SOURCE' });
  f.state.set.accountScopeIds = []; f.state.delivery = false;
  await assert.rejects(f.adapter.reserveExactBatch(f.args), { code: 'DELIVERY_DISABLED' });
  f.state.delivery = true; f.state.set.items[0] = { itemKey: 'skin|overwatch 2', game: 'Overwatch 2', qty: 1 };
  await assert.rejects(f.adapter.reserveExactBatch(f.args), { code: 'GAME_RESTRICTED' });
  assert.equal(f.calls().claims, 0);
});

test('unknown exceptions are sanitized and never release a held source', async () => {
  const f = fixture();
  f.deps.inventory = async () => { throw new Error('password=synthetic-password'); };
  const result = await f.adapter.reserveExactBatch(f.args);
  assert.equal(result.reason, 'VERIFICATION_FAILED');
  assert.equal(JSON.stringify(result).includes('password'), false);
  assert.equal(f.state.rows[0].status, 'manual');
});

test('batch expiry is offer-bound metadata and unknown expiry never looks available', async () => {
  const f = fixture();
  const reserved = await f.adapter.reserveExactBatch(f.args);
  assert.deepEqual(await f.adapter.readBatchState(f.args), { status: 'reserved', expiresAt: reserved.expiresAt, holdCount: 1 });
  await assert.rejects(f.adapter.readBatchState({ ...f.args, offerId: '11' }), { code: 'RESERVATION_MISMATCH' });
  f.state.batches.get('batch-1').expiresAt = 'invalid';
  assert.equal((await f.adapter.readBatchState(f.args)).expiresAt, null);
  f.state.rows[0].status = 'sold';
  assert.equal((await f.adapter.readBatchState(f.args)).holdCount, 0);
});

test('sale bookkeeping requires persisted exact success proof and survives a journal restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'z2u-source-'));
  try {
    const file = path.join(dir, 'ledger.json');
    let ledger = await openVaultLedger(file);
    const f = fixture({ ledger });
    await f.adapter.reserveExactBatch(f.args);
    const proof = { batchId: 'batch-1', sourceId: SOURCE, offerId: '10', productId: '999', evidenceId: 'receipt', deliveryId: 'unit-delivery', saleReference: '123' };
    await assert.rejects(f.adapter.markDelivered(proof), { code: 'DELIVERY_UNVERIFIED' });
    await ledger.configureOffer('10', { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
    await ledger.reserveBatch({ offerId: '10', batchId: 'batch-1', sourceIds: [SOURCE] });
    await ledger.beginUpload('batch-1', 'attempt');
    await ledger.reconcile({ kind: 'delivered', sourceId: SOURCE, offerId: '10', storageId: '999', evidenceId: 'receipt', ownershipVerified: true, deliverySucceeded: true, deliveryId: 'unit-delivery', saleReference: 123 });
    ledger = await openVaultLedger(file);
    const resumed = createZ2uStockAdapter({ ledger, adoptedOffers: [{ offerId: '10', setId: SET }], deps: f.deps, now: () => NOW });
    assert.equal((await resumed.markDelivered(proof)).status, 'delivered');
    assert.equal((await resumed.markDelivered(proof)).status, 'delivered');
    await assert.rejects(resumed.markDelivered({ ...proof, saleReference: '124' }), { code: 'DELIVERY_UNVERIFIED' });
    await assert.rejects(ledger.reconcile({ kind: 'delivered', sourceId: SOURCE, offerId: '10', storageId: '999', evidenceId: 'receipt', ownershipVerified: true, deliverySucceeded: true, deliveryId: 'unit-delivery', saleReference: '124' }), { code: 'INVALID_TRANSITION' });
    assert.equal(f.calls().marked, 2);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
