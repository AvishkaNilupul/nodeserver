'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { SCALARS, ARRAYS } = require('../utils/z2u/offers');
const { adoptionDigest, accountDigest } = require('../utils/z2u/launch');
const { launchFromWorker } = require('../utils/z2u/workerLaunch');

function fixture() {
  const fields = Object.fromEntries([...SCALARS.map(key => [key, '1']), ...ARRAYS.map(key => [key, []])]);
  Object.assign(fields, { list_pk: '15', list_title: 'Synthetic one-account offer', list_description: 'Synthetic full promise' });
  const offer = { offerId: '15', storageId: '12', gameId: '13', categoryId: '14', setId: '111111111111111111111111', kind: 'account', maxPurchaseQuantity: 1,
    expectedSnapshot: { offerId: '15', gameId: '13', categoryId: '14', title: fields.list_title, description: fields.list_description, status: 'paused', fields } };
  const identity = { offerId: '15', storageId: '12', gameId: '13', categoryId: '14', setId: offer.setId, sourceId: 'source', batchId: 'batch', productId: '11', configDigest: adoptionDigest(offer) };
  const state = { health: { mode: 'protect', checkedAt: '2026-11-16T01:02:03.000Z', access: { sellerAccess: true, storageAccess: true },
    adoptedOfferDigests: { '15': identity.configDigest }, protectionChecks: [{ offerId: '15', protection: 'offer_hold', saleReconciliation: 'verified' }] },
    config: { version: 1, offers: [offer] }, calls: [], reservationPatch: {}, proofPatch: {} };
  const input = { stateDir: '/synthetic-private/z2u', client: {}, protocol: {}, ledger: {}, offer,
    now: () => '2026-11-16T02:00:00.000Z',
    read: async filename => { assert.equal(filename, '/synthetic-private/z2u/health.json'); return state.health; },
    readConfig: async () => state.config,
    stockAdapter: {
      readBatchState: async args => { state.calls.push(['read', args]); return { holdCount: 1, expiresAt: '2099-01-01T00:00:00.000Z' }; },
      reserveExactBatch: async args => { state.calls.push(['reserve', args]); return { status: 'reserved',
        units: [{ sourceId: 'source', account: 'synthetic-account', password: 'synthetic-password' }],
        verifyReservation: async proofArgs => { state.calls.push(['verify', proofArgs]); return { verified: true, offerId: '15', sourceIds: ['source'], expiresAt: '2099-01-01T00:00:00.000Z', ...state.proofPatch }; },
        ...state.reservationPatch }; },
    },
  };
  return { input, identity, state };
}

test('worker proof preserves persisted observation time and exact adopted config digest', async () => {
  const f = fixture();
  const proof = await launchFromWorker({ ...f.input, launch: options => options.verifyWorker(f.identity) });
  assert.deepEqual(proof, { verified: true, running: true, offerId: '15', configDigest: f.identity.configDigest, checkedAt: f.state.health.checkedAt });
  assert.notEqual(proof.checkedAt, f.input.now());
});

test('stale adoption, malformed access, duplicate guards and failed protection cannot authorize worker proof', async () => {
  for (const change of [f => { f.state.health.mode = 'observe'; }, f => { f.state.health.access.storageAccess = 'true'; },
    f => { f.state.health.adoptedOfferDigests['15'] = 'old'; }, f => { f.state.config.offers[0].expectedSnapshot.fields.list_unit_price = '2'; },
    f => { f.state.health.protectionChecks.push(f.state.health.protectionChecks[0]); }, f => { f.state.health.protectionChecks[0].protection = 'pause_unverified'; },
    f => { f.state.health.protectionChecks[0].protection = 'expiry_hold'; }, f => { f.state.health.protectionChecks[0].saleReconciliation = 'held'; }]) {
    const f = fixture(); change(f);
    await assert.rejects(launchFromWorker({ ...f.input, launch: options => options.verifyWorker(f.identity) }), { code: 'WORKER_UNVERIFIED' });
  }
});

test('source verifier recovers only the existing exact batch and returns a credential digest without credentials', async () => {
  const f = fixture();
  const proof = await launchFromWorker({ ...f.input, launch: options => options.verifySource(f.identity) });
  assert.deepEqual(f.state.calls.map(call => call[0]), ['read', 'reserve', 'verify']);
  assert.deepEqual(f.state.calls[1][1], { batchId: 'batch', offerId: '15', setId: f.identity.setId, count: 1, existingOnly: true });
  assert.equal(proof.credentialDigest, accountDigest('synthetic-account', 'synthetic-password'));
  assert.equal(proof.checkedAt, f.input.now());
  assert.equal(JSON.stringify(proof).includes('synthetic-password'), false);
  assert.equal(JSON.stringify(proof).includes('synthetic-account'), false);
});

test('missing prior batch or mismatched reservation cannot trigger a claim or launch proof', async () => {
  const missing = fixture();
  missing.input.stockAdapter.readBatchState = async () => { throw Object.assign(new Error('Missing'), { code: 'RESERVATION_MISMATCH' }); };
  await assert.rejects(launchFromWorker({ ...missing.input, launch: options => options.verifySource(missing.identity) }), { code: 'RESERVATION_MISMATCH' });
  assert.equal(missing.state.calls.length, 0);
  for (const patch of [{ verified: false }, { offerId: '99' }, { sourceIds: ['different'] }]) {
    const f = fixture(); f.state.proofPatch = patch;
    await assert.rejects(launchFromWorker({ ...f.input, launch: options => options.verifySource(f.identity) }), { code: 'SOURCE_UNVERIFIED' });
  }
});

test('shutdown before or during source checks prevents continuing toward activation', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort();
  let launches = 0;
  await assert.rejects(launchFromWorker({ ...f.input, signal: controller.signal, launch: async () => { launches++; return {}; } }), { code: 'ABORTED' });
  assert.equal(launches, 0);
  const g = fixture(), during = new AbortController();
  g.input.stockAdapter.readBatchState = async () => { during.abort(); return { holdCount: 1, expiresAt: '2099-01-01T00:00:00.000Z' }; };
  await assert.rejects(launchFromWorker({ ...g.input, signal: during.signal, launch: options => options.verifySource(g.identity) }), { code: 'ABORTED' });
  assert.equal(g.state.calls.length, 0);
});

async function cliHarness(args) {
  const f = fixture(), connections = [], launches = [], writes = [], stocks = [], privateReads = [], provenance = [];
  let closed = 0, released = 0;
  const ledger = { inspectLock: async () => null };
  const modules = {
    'node:path': path,
    '../utils/z2u/privateStore': { readPrivate: async filename => { privateReads.push(filename); return {}; }, writePrivate: async (filename, value) => writes.push({ filename, value }), acquireRuntimeLock: async () => async () => { released++; } },
    '../utils/z2u/session': {}, '../utils/z2u/client': {},
    '../utils/z2u/engine': { stockOffer: async options => { stocks.push(options); if (options.prepare) await options.verifyDedicatedStorage(); return { status: 'stocked', verified: true }; } },
    '../utils/z2u/dedicatedStorage': { verifyDedicatedStorage: async options => { provenance.push(options); return { verified: true }; } },
    '../utils/z2u/runtime': {
      loadConfig: async () => f.state.config,
      connect: async () => { const connection = { client: {}, protocol: {} }; connections.push(connection); return connection; },
      runCheck: async () => ({ healthy: true }),
      monitor: async ({ cycle, onStatus }) => { await onStatus(await cycle({})); await onStatus(await cycle({})); },
    },
    '../utils/z2u/vaultLedger': { openVaultLedger: () => ledger },
    '../utils/z2u/stock': { createZ2uStockAdapter: () => f.input.stockAdapter },
    '../utils/z2u/workerLaunch': { launchFromWorker: async options => { launches.push(options); return { verified: true }; } },
    dotenv: { config() {} }, mongoose: { connect: async () => {}, disconnect: async () => { closed++; } },
  };
  const module = { exports: {} };
  const context = { module, exports: module.exports, __dirname: path.resolve(__dirname, '../scripts'),
    require: name => { if (!(name in modules)) throw new Error('Unexpected dependency: ' + name); return modules[name]; },
    process: { env: { MONGO_URI: 'synthetic-no-network' }, argv: [], once() {}, removeListener() {} },
    console: { log() {}, error() {} }, AbortController,
  };
  const source = await fs.readFile(path.resolve(__dirname, '../scripts/z2u-runtime.js'), 'utf8');
  vm.runInNewContext(source, context);
  await module.exports.main(args);
  return { connections, launches, writes, stocks, privateReads, provenance, closed, released };
}

test('actual CLI main never launches without explicit startup flag, then launches once using its existing connection', async () => {
  const passive = await cliHarness(['run', '--state-dir', '/synthetic-private/z2u']);
  assert.equal(passive.launches.length, 0);
  assert.equal(passive.writes.length, 0);
  assert.equal(passive.released, 1);
  const explicit = await cliHarness(['run', '--state-dir', '/synthetic-private/z2u', '--launch-offer', '15']);
  assert.equal(explicit.launches.length, 1);
  assert.equal(explicit.launches[0].client, explicit.connections[0].client);
  assert.equal(explicit.launches[0].protocol, explicit.connections[0].protocol);
  assert.equal(explicit.writes.length, 1);
  assert.equal(explicit.closed, 1);
  assert.equal(explicit.released, 1);
  await assert.rejects(cliHarness(['check', '--state-dir', '/synthetic-private/z2u', '--launch-offer', '15']), /INVALID_ARGUMENTS/);
});

test('CLI prepare-stock routes preparation with private category provenance and never invokes launch', async () => {
  const result = await cliHarness(['prepare-stock', '--state-dir', '/synthetic-private/z2u', '--offer', '15', '--count', '1', '--batch', 'synthetic-batch']);
  assert.equal(result.stocks.length, 1);
  assert.equal(result.stocks[0].prepare, true);
  assert.equal(result.stocks[0].count, 1);
  assert.equal(result.provenance.length, 1);
  assert.equal(result.provenance[0].protocol, result.connections[0].protocol);
  assert.deepEqual(result.privateReads, ['/synthetic-private/z2u/storage-provenance.json']);
  assert.equal(result.launches.length, 0);
  assert.equal(result.closed, 1);
  assert.equal(result.released, 1);
  const normal = await cliHarness(['stock', '--state-dir', '/synthetic-private/z2u', '--offer', '15', '--count', '1', '--batch', 'synthetic-batch']);
  assert.equal(normal.stocks[0].prepare, false);
  assert.equal(normal.provenance.length, 0);
  assert.equal(normal.launches.length, 0);
});
