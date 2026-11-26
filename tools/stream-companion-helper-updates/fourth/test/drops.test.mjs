import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { inventoryPage } from '../extension/drops-page.js';
import { DropClaims, INVENTORY_URL } from '../extension/drops.js';

function page(t, { account = 'qumaris_2489', body = '', url = INVENTORY_URL, allow = true } = {}) {
  const dom = new JSDOM(`<h6>${account}</h6><a href="https://dashboard.twitch.tv/u/${account}/home">Creator Dashboard</a><h2>Drops &amp; Rewards</h2><h4>Drops</h4>${body}<h5>Claimed</h5><section id="claimed"></section><h4>Rewards</h4><section id="offers"></section>`, { url });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  const values = { document: dom.window.document, window: dom.window, location: dom.window.location, Node: dom.window.Node, getComputedStyle: dom.window.getComputedStyle.bind(dom.window), chrome: { runtime: { sendMessage: async () => ({ ok: allow }) } }, setTimeout: fn => setImmediate(fn) };
  const original = new Map();
  for (const [key, value] of Object.entries(values)) { original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, writable: true, configurable: true }); }
  t.after(() => { dom.window.close(); for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  return dom.window.document;
}
const reward = '<article id="reward"><img src="https://static-cdn.jtvnw.net/reward-one.png" alt="Earned outfit"><p>100% complete</p><button>Claim Now</button></article>';
const inspect = () => inventoryPage({ account: 'qumaris_2489' });

test('empty inventory is a successful no-op after verifying the account', async t => {
  page(t, { body: '<p>There are no items in your inventory yet.</p>' });
  assert.deepEqual(await inspect(), { account: 'qumaris_2489', ready: [], empty: true });
});
test('account-menu closing animation does not falsely block an inventory check', async t => {
  const d = page(t);
  const menu = d.createElement('div'); menu.setAttribute('role', 'dialog'); menu.hidden = true;
  menu.append(d.querySelector('h6'), d.querySelector('a')); d.body.append(menu);
  const avatar = d.createElement('button'); avatar.setAttribute('data-a-target', 'user-menu-toggle'); d.body.prepend(avatar);
  let clicks = 0;
  avatar.onclick = () => { clicks++; if (clicks === 1) menu.hidden = false; else setImmediate(() => { menu.hidden = true; }); };
  assert.equal((await inspect()).account, 'qumaris_2489');
  assert.equal(clicks, 2); assert.equal(menu.hidden, true);
});
test('inventory actions reject another account, another page and blocking dialogs', async t => {
  const d = page(t, { body: reward, account: 'somebody_else' });
  let clicks = 0; d.querySelector('button').onclick = () => clicks++;
  assert.match((await inspect()).error, /expected @qumaris_2489/);
  d.querySelector('h6').textContent = 'qumaris_2489'; d.querySelector('a').href = 'https://dashboard.twitch.tv/u/qumaris_2489/home';
  d.body.insertAdjacentHTML('beforeend', '<div role="dialog">Connect game account</div>');
  assert.match((await inspect()).error, /dialog/); assert.equal(clicks, 0);
  d.defaultView.history.pushState(null, '', '/some_channel');
  assert.match((await inspect()).error, /normal Twitch Drops inventory/);
});
test('only enabled earned-drop buttons before Claimed are candidates', async t => {
  const d = page(t, { body: reward + '<article><img src="https://example.org/locked.png" alt="Locked"><button disabled>Claim Now</button></article>' });
  d.querySelector('#offers').innerHTML = '<article><img src="https://example.org/offer.png" alt="Brand offer"><button>Claim Now</button></article>';
  const result = await inspect(); assert.equal(result.ready.length, 1); assert.equal(result.ready[0].name, 'Earned outfit');
});
test('claim is confirmed only when the reward appears in Claimed', async t => {
  const d = page(t, { body: reward }); const ready = (await inspect()).ready[0];
  let clicks = 0; d.querySelector('button').onclick = () => { clicks++; d.querySelector('#claimed').append(d.querySelector('#reward')); d.querySelector('button').remove(); };
  assert.equal((await inventoryPage({ mode: 'claim', account: 'qumaris_2489', key: ready.key, permit: 'permit' })).delivery, 'confirmed');
  assert.equal(clicks, 1);
});
test('a disappearing claim button alone is uncertain, never confirmed', async t => {
  const d = page(t, { body: reward }); const ready = (await inspect()).ready[0];
  d.querySelector('button').onclick = () => d.querySelector('button').remove();
  assert.equal((await inventoryPage({ mode: 'claim', account: 'qumaris_2489', key: ready.key, permit: 'permit' })).delivery, 'unknown');
});
test('an older claimed reward with the same artwork cannot confirm a new claim', async t => {
  const d = page(t, { body: reward });
  d.querySelector('#claimed').innerHTML = '<img src="https://static-cdn.jtvnw.net/reward-one.png" alt="Previously earned outfit">';
  const ready = (await inspect()).ready[0];
  d.querySelector('button').onclick = () => d.querySelector('button').remove();
  assert.equal((await inventoryPage({ mode: 'claim', account: 'qumaris_2489', key: ready.key, permit: 'permit' })).delivery, 'unknown');
});
test('account verification accepts display-name capitalization', async t => {
  const d = page(t); d.querySelector('h6').textContent = 'Qumaris_2489';
  assert.equal((await inspect()).account, 'qumaris_2489');
});
test('revoked permission to click and ambiguous reward cards cannot submit', async t => {
  const d = page(t, { body: reward, allow: false }); const ready = (await inspect()).ready[0];
  let clicks = 0; d.querySelector('button').onclick = () => clicks++;
  assert.equal((await inventoryPage({ mode: 'claim', account: 'qumaris_2489', key: ready.key, permit: 'permit' })).delivery, 'cancelled');
  assert.equal(clicks, 0);
  d.querySelector('#reward').insertAdjacentHTML('beforeend', '<img src="https://example.org/ambiguous.png" alt="Another reward">');
  assert.equal((await inspect()).ready.length, 0);
});

function controller() {
  const data = { drops: { enabled: true, account: 'qumaris_2489', tabId: 42, history: [] } };
  const settings = { account: 'qumaris_2489', paused: false };
  const calls = []; let executeOverride, grant = true, tabUrl = INVENTORY_URL, nextTab = 42;
  const api = {
    runtime: { id: 'extension-test' },
    storage: { local: { async get() { return structuredClone(data); }, async set(value) { Object.assign(data, structuredClone(value)); } } },
    permissions: { async contains() { return grant; } },
    tabs: {
      async create() { calls.push('create'); return { id: ++nextTab }; },
      async get(id) { return { id, url: id === 42 ? tabUrl : INVENTORY_URL, status: 'complete', active: false, index: 0, windowId: 1 }; },
      async remove(id) { calls.push(`remove:${id}`); },
      async update(id) { calls.push(`activate:${id}`); }
    },
    scripting: { async executeScript(request) {
      calls.push(request.args[0].mode);
      if (executeOverride) return executeOverride(request);
      if (request.args[0].mode === 'inspect') return [{ documentId: 'doc1', result: { account: 'qumaris_2489', ready: [{ key: 'reward-key', name: 'Outfit' }] } }];
      return [{ documentId: 'doc1', result: { delivery: 'confirmed' } }];
    } }
  };
  const instance = new DropClaims(api, async () => structuredClone(settings));
  return { instance, api, data, settings, calls, override: fn => { executeOverride = fn; }, revoke: () => { grant = false; }, navigate: url => { tabUrl = url; } };
}
test('claim intent persists before clicking and confirmed rewards are never repeated', async () => {
  const h = controller(); h.override(async r => {
    if (r.args[0].mode === 'inspect') return [{ documentId: 'doc1', result: { account: 'qumaris_2489', ready: [{ key: 'reward-key', name: 'Outfit' }] } }];
    assert.equal(h.data.drops.history[0].delivery, 'pending');
    return [{ result: { delivery: 'confirmed' } }];
  });
  await h.instance.run(); await h.instance.run();
  assert.equal(h.calls.filter(x => x === 'claim').length, 1);
  assert.equal(h.data.drops.history[0].delivery, 'confirmed');
});
test('unknown claims stop the routine and are not retried after re-enabling', async () => {
  const h = controller(); h.override(async r => [{ documentId: 'doc1', result: r.args[0].mode === 'inspect' ? { account: 'qumaris_2489', ready: [{ key: 'reward-key', name: 'Outfit' }] } : { delivery: 'unknown', reason: 'No confirmation.' } }]);
  await h.instance.run(); assert.equal(h.data.drops.enabled, false);
  await h.instance.enable(); await h.instance.run();
  assert.equal(h.calls.filter(x => x === 'claim').length, 1);
});
test('Pause during inventory inspection prevents a later claim', async () => {
  const h = controller(); let finish;
  h.override(() => new Promise(resolve => { finish = resolve; }));
  const work = h.instance.run(); while (!finish) await new Promise(resolve => setImmediate(resolve));
  await h.instance.stop(); finish([{ documentId: 'doc1', result: { account: 'qumaris_2489', ready: [{ key: 'x', name: 'x' }] } }]); await work;
  assert.equal(h.data.drops.enabled, false); assert.equal(h.calls.includes('claim'), false);
});
test('claim permits are single-use and bound to tab, document, origin and account', async () => {
  const h = controller();
  h.instance.permit = { id: 'once', key: 'key', account: 'qumaris_2489', epoch: 0, tabId: 42, documentId: 'doc1', expiresAt: Date.now() + 5000, used: false };
  const message = { permit: 'once', key: 'key', account: 'qumaris_2489' }, sender = { id: 'extension-test', frameId: 0, tab: { id: 42 }, documentId: 'doc1', url: INVENTORY_URL };
  for (const bad of [{ ...sender, documentId: 'old-doc' }, { ...sender, tab: { id: 1 } }, { ...sender, frameId: 2 }, { ...sender, url: 'https://www.twitch.tv/leonbratt' }]) assert.equal((await h.instance.authorize(message, bad)).ok, false);
  assert.equal((await h.instance.authorize(message, sender)).ok, true);
  assert.equal((await h.instance.authorize(message, sender)).ok, false);
});
test('removed access and user navigation stop claiming without modifying other tabs', async () => {
  const h = controller(); h.navigate('https://www.twitch.tv/leonbratt');
  await h.instance.run({ reload: true }); assert.equal(h.data.drops.enabled, false); assert.deepEqual(h.calls, []);
  h.revoke(); await assert.rejects(h.instance.enable(), /optional Twitch/); assert.deepEqual(h.calls, []);
});
test('refresh validates a fresh background inventory before replacing only its owned tab', async () => {
  const h = controller();
  h.override(async r => {
    assert.equal(r.target.tabId, 43);
    if (r.args[0].mode === 'inspect') {
      assert.equal(h.calls.includes('remove:42'), false);
      return [{ documentId: 'fresh', result: { account: 'qumaris_2489', ready: [] } }];
    }
    throw new Error('No claims expected');
  });
  await h.instance.run({ reload: true });
  assert.equal(h.data.drops.tabId, 43); assert.equal(h.data.drops.enabled, true);
  assert.deepEqual(h.calls, ['create', 'inspect', 'remove:42']);
});
test('Pause or user navigation during refresh preserves the original tab and removes only the replacement', async () => {
  for (const reason of ['pause', 'navigate']) {
    const h = controller();
    h.override(async () => {
      if (reason === 'pause') await h.instance.stop(); else h.navigate('https://www.twitch.tv/some_channel');
      return [{ documentId: 'fresh', result: { account: 'qumaris_2489', ready: [] } }];
    });
    await h.instance.run({ reload: true });
    assert.equal(h.data.drops.enabled, false);
    assert.equal(h.calls.includes('remove:42'), false);
    assert.equal(h.calls.includes('remove:43'), true);
  }
});
