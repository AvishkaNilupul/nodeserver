'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Exercise the actual production-baseline allocator, not a duplicate of it.
function allocatorFixture() {
  const set = { _id: '111111111111111111111111', stockSource: 'noclaim', items: [{ name: 'Reward', game: 'Example', itemKey: 'reward|example', qty: 2 }] };
  const unit = { name: 'Reward', game: 'Example', itemKey: 'reward|example', campaign: 'Synthetic campaign' };
  const holder = { login: 'synthetic', loginLower: 'synthetic', poolAccountId: '222222222222222222222222', items: [{ ...unit, qty: 2 }], inConfig: true, readAt: new Date() };
  const state = { live: [{ ...unit }, { ...unit }], holder, expiry: Date.now() + 3 * 86400000, reads: 0, writes: 0 };
  const pool = { status: 'claimed', clientSecret: 'synthetic-secret', password: 'encrypted', claimedNote: 'noclaim-farm:Example' };
  const Unclaimed = { find: () => ({ lean: async () => [] }), updateOne: async () => { state.writes++; return { modifiedCount: 1 }; } };
  const stockDependencies = {
    '../models/UnclaimedAccount': Unclaimed,
    '../models/AvailableAccount': { findById: () => ({ lean: async () => pool }), updateOne: async () => ({ modifiedCount: 1 }) },
    '../models/MarketplaceListing': {}, '../models/DropSet': {},
    './settings': { getNoclaimShopSettings: () => ({ enabled: true, autoDeliver: true }), normGameName: value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '') },
    './systemLog': { logEvent: () => {} }, './suppliedStock': { shareOfShelf: () => 1 },
    './noclaimHoldings': { snapshotBase: async () => ({ holdings: [holder], expiry: { on: true }, ledgerByLogin: new Map() }),
      freeReason: () => '', isFresh: () => true, recordRead: async () => {}, invalidate: () => {}, waveGoneAt: () => state.expiry },
    './unclaimedAutoList': { credentialForLedger: async () => ({ login: 'synthetic', password: 'synthetic-password' }),
      inventoryForCandidate: async () => { state.reads++; return { login: 'synthetic', sellable: state.live }; }, activeListingsForLogin: async () => [] },
  };
  const module = { exports: {} };
  const source = fs.readFileSync(path.join(__dirname, '../utils/noclaimStock.js'), 'utf8');
  new Function('require', 'module', 'exports', source)(name => {
    if (!(name in stockDependencies)) throw new Error('Unexpected dependency: ' + name);
    return stockDependencies[name];
  }, module, module.exports);
  return { allocator: module.exports, set, state, Unclaimed };
}

test('Z2U stays excluded from legacy lifecycle lists and accepts only dedicated fed claims', async () => {
  const f = allocatorFixture();
  assert.equal(f.allocator.VAULT_MARKETS.includes('z2u'), false);
  assert.equal(f.allocator.SUPPORTED_MARKETS.includes('z2u'), false);
  assert.deepEqual(await f.allocator.claimForSet(f.set, 1, { market: 'z2u', mode: 'sold' }), []);
  const claims = await f.allocator.claimForSet(f.set, 1, { market: 'z2u', mode: 'fed', listingId: 'anchor', dryRun: true });
  assert.equal(claims.length, 1); assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0);
});

test('Z2U exact snapshot filter does not spend a read or commit on supersets/autofarm', async () => {
  for (const change of [f => f.state.holder.items[0].qty++, f => f.state.holder.items.push({ itemKey: 'other|example', qty: 1 }), f => f.state.holder.farm = 'autofarm']) {
    const f = allocatorFixture(); change(f);
    assert.equal((await f.allocator.claimForSet(f.set, 1, { market: 'z2u', mode: 'fed', listingId: 'anchor' })).length, 0);
    assert.equal(f.state.reads, 0); assert.equal(f.state.writes, 0);
  }
});

test('Z2U live exactness and known life reject before source commit; other markets retain behavior', async () => {
  for (const change of [f => f.state.live.push({ itemKey: 'extra|example' }), f => f.state.live.push({ ...f.state.live[0] }), f => f.state.expiry = Infinity, f => f.state.expiry = Date.now() + 3600000]) {
    const f = allocatorFixture(); change(f);
    assert.equal((await f.allocator.claimForSet(f.set, 1, { market: 'z2u', mode: 'fed', listingId: 'anchor' })).length, 0);
    assert.equal(f.state.reads, 1); assert.equal(f.state.writes, 0);
    assert.equal((await f.allocator.claimForSet(f.set, 1, { market: 'ggsel', mode: 'fed', listingId: 'anchor', dryRun: true })).length, 1);
  }
});

test('sale CAS pins the batch owner when a reservation is released/reclaimed during evidence projection', async () => {
  const f = allocatorFixture();
  let seenQuery, seenUpdate, seenOptions;
  const row = { _id: '333333333333333333333333', status: 'manual', manualAt: new Date(), manualListing: 'z2u:old', market: 'z2u' };
  f.Unclaimed.find = query => { seenQuery = query; return { lean: async () => [row] }; };
  f.Unclaimed.updateOne = async (query, update, options) => { seenUpdate = query; seenOptions = options; return { matchedCount: query.manualListing === 'z2u:new' ? 1 : 0 }; };
  assert.equal(await f.allocator.markSold([row._id], { market: 'z2u', orderId: '123', expectedManualListing: 'z2u:old' }), 0);
  assert.equal(seenQuery.manualListing, 'z2u:old');
  assert.equal(seenUpdate.manualListing, 'z2u:old');
  assert.equal(seenUpdate.market, 'z2u');
  assert.equal(seenUpdate.status, 'manual');
  assert.deepEqual(seenOptions, { writeConcern: { w: 'majority', j: true } });
});

test('Z2U source commitment requests journal durability for both reused and newly created rows', async () => {
  for (const existing of [false, true]) {
    const f = allocatorFixture();
    let options;
    if (existing) {
      f.Unclaimed.find = () => ({ lean: async () => [{ _id: '333333333333333333333333', status: 'skipped' }] });
      f.Unclaimed.updateOne = async (_query, _update, opts) => { options = opts; return { modifiedCount: 1 }; };
    } else {
      f.Unclaimed.create = async (rows, opts) => { options = opts; assert.equal(Array.isArray(rows), true); return [{ ...rows[0], _id: '333333333333333333333333' }]; };
      f.Unclaimed.countDocuments = async () => 1;
    }
    const result = await f.allocator.claimForSet(f.set, 1, { market: 'z2u', mode: 'fed', listingId: 'anchor' });
    assert.equal(result.length, 1);
    assert.deepEqual(options, { writeConcern: { w: 'majority', j: true } });
  }
});
