const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { Worker, createApi } = require('../workers/steam-boost/worker.cjs');
class Fake extends EventEmitter {
  constructor(o) { super(); this.o = o; this.licensed = new Set(); this.running = false; }
  start() { this.running = true; }
  async stop() { this.running = false; this.stopped = true; }
  status() { return { state: 'playing', playing: [730] }; }
}
test('worker drops removed/generation-changed assignments before acknowledging logout', async () => {
  let clock = 1000000, assignments = { accounts: [{ id: 'a', gen: 1, games: [730] }] }; const posts = [];
  const worker = new Worker({ now: () => clock, makeBooster: o => new Fake(o), api: async (path, body) => { if (path === 'assignments') return assignments; posts.push({ path, body }); return {}; } });
  await worker.cycle(); const first = worker.sessions.get('a').booster;
  assignments = { accounts: [], stopping: [{ id: 'a', gen: 1 }] }; clock += 30000;
  await worker.cycle(); assert.equal(first.stopped, true); assert.equal(worker.sessions.size, 0);
  assert.ok(posts.some(p => p.body.accounts?.some(a => a.stopped && a.gen === 1)));
});
test('worker logs off after losing assignment authority for three minutes', async () => {
  let clock = 1000000, fail = false;
  const worker = new Worker({ now: () => clock, makeBooster: o => new Fake(o), api: async path => { if (fail) throw Error('offline'); return path === 'assignments' ? { accounts: [{ id: 'a', gen: 1, games: [730] }] } : {}; } });
  await worker.cycle(); const first = worker.sessions.get('a').booster; fail = true; clock += 180001;
  await assert.rejects(worker.reconcile()); assert.equal(first.stopped, true); assert.equal(worker.sessions.size, 0);
});
test('worker credentials and token operations carry assignment generation', async () => {
  const calls = [];
  const worker = new Worker({ now: () => 1000000, makeBooster: o => new Fake(o), api: async (path, body) => { calls.push({ path, body }); return { password: 'pw', refreshToken: '' }; } });
  await worker.startOne({ id: 'a', gen: 7, games: [730] }); const b = worker.sessions.get('a').booster;
  await b.o.tokens.get('a'); await b.o.tokens.set('a', 'token'); await b.o.tokens.clear('a');
  assert.deepEqual(calls.map(c => c.body.gen), [7,7,7]); assert.equal(b.o.account.password, 'pw');
});
test('API client refuses a public endpoint for worker secrets', () => {
  assert.throws(() => createApi({ base: 'http://example.com/', token: 'a'.repeat(32) }), /loopback/);
});

test('first verification window starts after login and leaves twenty uninterrupted minutes', async () => {
  let clock = 1000000;
  class Playing extends Fake {
    start() { this.running = true; }
    login() { this.steamID = 's'; this.ready = true; this.emit('state', 'playing'); }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    async refreshPlaytime() { return {}; }
  }
  const worker = new Worker({ now: () => clock, makeBooster: o => new Playing(o), api: async () => ({}) });
  await worker.startOne({ id: 'a', gen: 1, games: [730], purpose: 'game' });
  clock += 120000; const b = worker.sessions.get('a').booster; b.login();
  clock += 19 * 60000; await worker.report(); assert.equal(b.paused, undefined);
  clock += 60000; await worker.report(); assert.equal(b.paused, true);
  clock += 90000; await worker.report(); assert.equal(b.paused, false);
});
