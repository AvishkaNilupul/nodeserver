const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../extension/epic-claim-helper-android/phone/phone-awake.js'), 'utf8');
const flush = () => new Promise(setImmediate);
function fixture(request) {
  const events = {}, timers = [];
  const context = {navigator: {wakeLock: {request}}, document: {visibilityState: 'visible',
    addEventListener(name, fn) { events[name] = fn; }},
  addEventListener(name, fn) { events[name] = fn; }, setInterval(fn) { timers.push(fn); }};
  vm.runInNewContext(source, context);
  return {context, events, tick: () => timers[0]()};
}
test('one screen lock covers idle waits, releases on hide and reacquires on return/OS release', async () => {
  const locks = [];
  const f = fixture(async type => {
    assert.equal(type, 'screen');
    const lock = {released: 0, addEventListener(_, fn) { this.onrelease = fn; },
      async release() { this.released++; this.onrelease?.(); }};
    locks.push(lock); return lock;
  });
  await flush(); await f.tick(); assert.equal(locks.length, 1);
  f.context.document.visibilityState = 'hidden'; f.events.visibilitychange();
  assert.equal(locks[0].released, 1); await f.tick(); assert.equal(locks.length, 1);
  f.context.document.visibilityState = 'visible'; f.events.visibilitychange(); await flush();
  assert.equal(locks.length, 2); locks[1].onrelease(); await f.tick(); assert.equal(locks.length, 3);
  f.events.pagehide(); await f.tick(); assert.equal(locks[2].released, 1); assert.equal(locks.length, 3);
  f.events.pageshow(); await flush(); assert.equal(locks.length, 4);
});
test('delayed acquisition cannot retain a lock after leaving; concurrent ticks do not duplicate requests', async () => {
  let resolve, calls = 0, releases = 0;
  const f = fixture(() => { calls++; return new Promise(r => { resolve = r; }); });
  await f.tick(); assert.equal(calls, 1); f.events.pagehide();
  resolve({release: async () => { releases++; }}); await flush();
  assert.equal(releases, 1); await f.tick(); assert.equal(calls, 1);
});
test('OS refusal is handled and retried; unsupported browsers do not throw', async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw Error('Low battery'); });
  await flush(); await f.tick(); assert.equal(calls, 2);
  delete f.context.navigator.wakeLock; await f.tick(); assert.equal(calls, 2);
});
