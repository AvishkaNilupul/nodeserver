const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../extension/epic-claim-helper-android/compat.js'), 'utf8');
function setup() {
  let listener, now = 30000;
  const state = {}, updates = [];
  const tabs = new Map([[7, {id: 7, active: false, url: 'http://127.0.0.1:8123/phone'}]]);
  const browser = {runtime: {onMessage: {addListener(fn) { listener = fn; }}},
    storage: {session: {async get(k) { return {[k]: state[k]}; }, async set(v) { Object.assign(state, v); }},
      local: {async get() { return {}; }}},
    tabs: {query() { throw Error('No current window on Android'); }, create() { throw Error('Must not create a tab'); },
      async get(id) { if (!tabs.has(id)) throw Error('Gone'); return tabs.get(id); },
      async update(id, props) { updates.push({id, ...props}); return {id, ...props}; }, onUpdated: {}}};
  const context = {browser, URL, Date: {now: () => now}};
  vm.runInNewContext(source, context);
  return {ext: context.ext, state, updates, tabs, advance(ms) { now += ms; },
    beat(id = 7, frameId = 0, url = tabs.get(id)?.url) { listener({type: 'phone-visible'}, {tab: {id, url}, url, frameId}); }};
}
test('visible shortcut tab is reused even when Firefox has no active window', async () => {
  const f = setup(); f.beat(); await f.ext.tabs.create({url: 'about:blank', active: true});
  assert.deepEqual(f.updates, [{id: 7, url: 'about:blank', active: true}]);
  assert.equal(f.state['epicclaim.android.reusedTab'], 7);
});
test('missing/stale/closed/non-helper/iframe senders cannot select a checkout tab', async () => {
  const f = setup();
  await assert.rejects(f.ext.tabs.create({}), /Open the Epic Claims/);
  f.beat(7, 1); await assert.rejects(f.ext.tabs.create({}), /Open the Epic Claims/);
  f.beat(7, 0, 'https://example.invalid/'); await assert.rejects(f.ext.tabs.create({}), /Open the Epic Claims/);
  f.beat(); f.advance(20001); await assert.rejects(f.ext.tabs.create({}), /Open the Epic Claims/);
  f.beat(); f.tabs.delete(7); await assert.rejects(f.ext.tabs.create({}), /Gone/);
  f.tabs.set(7, {id: 7, url: 'https://example.invalid/'}); await assert.rejects(f.ext.tabs.create({}), /Open the Epic Claims/);
  assert.equal(f.updates.length, 0);
});
test('a new visible tab replaces the previous sender even within heartbeat throttling', async () => {
  const f = setup(); f.beat();
  f.tabs.set(8, {id: 8, url: 'https://store.epicgames.com/purchase'}); f.advance(100); f.beat(8);
  await f.ext.tabs.create({url: 'about:blank'}); assert.equal(f.updates[0].id, 8);
});
