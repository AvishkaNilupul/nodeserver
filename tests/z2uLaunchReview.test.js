'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { SCALARS, ARRAYS } = require('../utils/z2u/offers');
const { parseDocument } = require('../utils/z2u/runtime');
const { accountDigest, activateOneUnitOffer } = require('../utils/z2u/launch');
const NOW = Date.parse('2026-11-16T12:00:00.000Z');

async function fixture(t) {
  const stateDir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'z2u-launch-review-'));
  await fs.chmod(stateDir, 0o700);
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const fields = Object.fromEntries([...SCALARS.map(key => [key, '1']), ...ARRAYS.map(key => [key, []])]);
  Object.assign(fields, { list_pk: '15', list_title: 'Synthetic one-unit offer', list_description: 'Synthetic complete promise' });
  const offer = { offerId: '15', storageId: '12', gameId: '13', categoryId: '14', setId: '111111111111111111111111', kind: 'account', maxPurchaseQuantity: 1,
    expectedSnapshot: { offerId: '15', gameId: '13', categoryId: '14', title: fields.list_title, description: fields.list_description, status: 'paused', fields } };
  const state = { status: 'paused', writes: 0, pauses: 0, sourceReads: 0, productReads: 0, workerPatch: {}, sourcePatch: {}, fieldsPatch: {}, settingsPatch: {}, productPatch: {} };
  const identity = () => ({ verified: true, offerId: '15', gameId: '13', categoryId: '14', status: state.status, statusCode: state.status === 'paused' ? 4 : 1 });
  const input = {
    offer, stateDir, parseDocument, now: () => NOW,
    ledger: { snapshot: async () => ({ offers: [{ offerId: '15', automaticDeliveryEnabled: true, deactivateWhenEmpty: true }],
      units: [{ offerId: '15', sourceId: 'source', batchId: 'batch', storageId: '11', status: 'stocked' }] }) },
    client: { mutate: async () => { state.writes++; state.status = 'on_sale'; return { acknowledged: true }; } },
    protocol: {
      readOfferSnapshot: async () => ({ ...structuredClone(offer.expectedSnapshot), ...identity(), fields: { ...structuredClone(fields), ...state.fieldsPatch }, constraints: { ready: true } }),
      readOfferState: async () => identity(),
      readOfferDelivery: async () => ({ id: 15, storage_id: 12, is_auto_deliver: 1, outstock: 1, is_agiso: 0, buy_more: 1, ...state.settingsPatch }),
      readStorage: async () => ({ id: 12, gid: 13, category_id: 14, type: 1, is_repeat: 2 }),
      readStoragePage: async () => '<h1>Storage List (Totals:1)</h1><div id="productlist"><input class="checkone" data="11"></div>',
      readProduct: async () => { state.productReads++; return { id: 11, storage_id: 12, gid: 13, category_id: 14,
        status: 1, delete_time: 0, wd_order: '', buy_user_id: 0, buy_order: 0, used_time: null, account: 'synthetic', password: 'fixture-only', ...state.productPatch }; },
      pauseOffer: async () => { state.pauses++; state.status = 'paused'; return { verified: true, status: 'paused' }; },
    },
    verifySource: async proofIdentity => { state.sourceReads++; return { verified: true, ...proofIdentity,
      credentialDigest: accountDigest('synthetic', 'fixture-only'), checkedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 3 * 86400000).toISOString(), ...state.sourcePatch }; },
    verifyWorker: async ({ offerId, configDigest }) => ({ verified: true, running: true, offerId, configDigest, checkedAt: new Date(NOW).toISOString(), ...state.workerPatch }),
  };
  return { input, state, intentFile: path.join(stateDir, 'launch-intents', '15.json'), launch: () => activateOneUnitOffer(input) };
}

test('unexpected activation during either preflight state read is paused without dispatching activation', async t => {
  for (const stage of ['snapshot', 'final-state']) await t.test(stage, async t => {
    const f = await fixture(t);
    if (stage === 'snapshot') f.state.status = 'on_sale';
    else {
      const read = f.input.protocol.readOfferState;
      f.input.protocol.readOfferState = async () => { f.state.status = 'on_sale'; return read(); };
    }
    await assert.rejects(f.launch());
    assert.equal(f.state.writes, 0);
    assert.equal(f.state.pauses, 1);
    assert.equal(f.state.status, 'paused');
    await assert.rejects(fs.stat(f.intentFile), { code: 'ENOENT' });
  });
});

test('source ownership and credential drift during remote checks fails a fresh final verification', async t => {
  for (const patch of [{ verified: false }, { sourceId: 'changed-source' }, { credentialDigest: accountDigest('changed', 'credential') }]) await t.test(Object.keys(patch)[0], async t => {
    const f = await fixture(t);
    const read = f.input.protocol.readProduct;
    f.input.protocol.readProduct = async () => { const product = await read(); f.state.sourcePatch = patch; return product; };
    await assert.rejects(f.launch(), { code: 'LAUNCH_UNVERIFIED' });
    assert.ok(f.state.sourceReads >= 2);
    assert.equal(f.state.writes, 0);
    await assert.rejects(fs.stat(f.intentFile), { code: 'ENOENT' });
  });
});

test('worker heartbeat requires typed positive state and exact current adoption identity', async t => {
  for (const patch of [{ verified: 'true' }, { verified: 1 }, { running: 'true' }, { running: 1 }, { offerId: 15 },
    { configDigest: ['synthetic'] }, { checkedAt: new Date(NOW + 6000).toISOString() }]) {
    const f = await fixture(t); f.state.workerPatch = patch;
    await assert.rejects(f.launch(), { code: 'LAUNCH_UNVERIFIED' });
    assert.equal(f.state.writes, 0);
    await assert.rejects(fs.stat(f.intentFile), { code: 'ENOENT' });
  }
});

test('content and native-delivery drift during final slow source verification blocks activation', async t => {
  for (const changed of ['fields', 'delivery', 'native-credentials', 'native-consumption']) await t.test(changed, async t => {
    const f = await fixture(t);
    const verify = f.input.verifySource;
    f.input.verifySource = async identity => {
      const proof = await verify(identity);
      if (f.state.sourceReads === 2) {
        if (changed === 'fields') f.state.fieldsPatch.list_unit_price = '99';
        else if (changed === 'delivery') f.state.settingsPatch.is_auto_deliver = 0;
        else if (changed === 'native-credentials') f.state.productPatch.password = 'changed-after-read';
        else f.state.productPatch = { status: 2, buy_order: 123, buy_user_id: 99, used_time: '2026-11-16 12:00:00' };
      }
      return proof;
    };
    await assert.rejects(f.launch(), { code: 'LAUNCH_UNVERIFIED' });
    assert.equal(f.state.writes, 0);
    await assert.rejects(fs.stat(f.intentFile), { code: 'ENOENT' });
  });
});

test('partial persisted intent from a pre-dispatch crash permanently blocks replay', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.dirname(f.intentFile), { mode: 0o700 });
  await fs.writeFile(f.intentFile, '{partial-intent', { mode: 0o600 });
  await assert.rejects(f.launch(), { code: 'ACTIVATION_ALREADY_ATTEMPTED' });
  assert.equal(f.state.sourceReads, 0);
  assert.equal(f.state.writes, 0);
  assert.equal(await fs.readFile(f.intentFile, 'utf8'), '{partial-intent');
});
