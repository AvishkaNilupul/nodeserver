import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createClipController } from '../lib/clips.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture() {
  let time = 1_800_000, paused = true;
  const db = new DatabaseSync(':memory:'), calls = [], authCalls = [], messages = [];
  const patches = new Map(), clipStates = new Map(['primary', 'test'].map(id => [id, { ok: true, account: id === 'primary' ? 'main_companion' : 'second_companion', authorized: true, jobs: [] }]));
  const instance = id => ({ id, account: clipStates.get(id).account, available: true, authorized: true, connected: false, channel: 'aviskarex',
    settings: { paused: true, allowedChannel: 'aviskarex' }, browser: { online: true, lastSeenAt: new Date(time).toISOString() },
    watch: { enabled: true, channel: 'aviskarex', status: 'playing', checkedAt: time },
    streamContext: { channel: 'aviskarex', streamId: '123', isLive: true, checkedAt: time }, chat: { messages },
    coordination: { paused }, controls: { pending: null }, ...patches.get(id) });
  const accounts = {
    async snapshot() { return { instances: ['primary', 'test'].map(instance) }; },
    async clipStatus(id) { return structuredClone(clipStates.get(id)); },
    async clipCreate(id, body) {
      calls.push({ id, body });
      const job = { ...body, account: clipStates.get(id).account, createdAt: time, updatedAt: time, state: 'queued', clipId: '', url: '', error: '' };
      clipStates.get(id).jobs.push(job); return { ok: true, job };
    },
    async clipAuthorization(id, body) { authCalls.push({ id, body }); return { ok: true, verificationUrl: 'https://www.twitch.tv/activate', userCode: 'ABCD', pollAfterMs: 5000, privateToken: 'never-public' }; }
  };
  const options = { db, accounts, isPaused: () => paused, now: () => time, randomId: () => 'fixture-event' };
  let controller = createClipController(options);
  return { db, accounts, calls, authCalls, messages, patches, clipStates, options,
    get c() { return controller; }, set c(value) { controller = value; },
    get time() { return time; }, hold() { paused = true; }, advance(ms) { time += ms; }, resume() { paused = false; for (const id of ['primary', 'test']) patches.set(id, { connected: true, settings: { paused: false, allowedChannel: 'aviskarex' } }); },
    async cleanup() { await controller.close(); db.close(); } };
}
const request = (id = 'request-1', accountIds = ['primary', 'test']) => ({ requestId: id, channel: 'aviskarex', accountIds });

test('starts with explicit auto opt-in off and exposes safe account capabilities', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  assert.equal(f.c.snapshot().settings.enabled, false);
  await f.c.tick();
  assert.equal(f.calls.length, 0);
  assert.equal(f.c.snapshot().accounts[0].canAuthorize, true);
  assert.equal(f.c.snapshot().detector.state, 'off');
  assert.equal('csrfToken' in f.c.snapshot(), false);
});

test('validates exact setting and request shapes', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  for (const body of [{ enabled: true, channel: '../bad', accountIds: ['primary'] }, { enabled: true, channel: 'aviskarex', accountIds: ['primary', 'primary'] }, { enabled: false, channel: 'aviskarex', accountIds: [] }]) assert.throws(() => f.c.configure(body));
  assert.throws(() => f.c.create({ ...request(), streamId: '123' }));
  assert.equal(f.calls.length, 0);
});

test('manual both selection creates exactly once while central chat is held', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const result = await f.c.create(request());
  assert.equal(result.job.accountId, 'primary');
  assert.equal(result.job.state, 'queued');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.streamId, '123');
  assert.equal(f.calls[0].body.source, 'manual');
  assert.deepEqual((await f.c.create(request())).job, result.job);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.c.create({ ...request(), channel: 'otherchannel' }), { status: 409 });
});

test('selects an eligible creator before submission but never switches on restriction failure', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  f.clipStates.get('primary').authorized = false;
  assert.equal((await f.c.create(request())).job.accountId, 'test');
  f.advance(600_001); f.clipStates.get('primary').authorized = true;
  f.accounts.clipCreate = async (id, body) => { f.calls.push({ id, body }); throw Object.assign(Error('restricted'), { status: 403 }); };
  const result = await f.c.create(request('restriction'));
  assert.equal(result.job.state, 'failed');
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls.at(-1).id, 'primary');
});

test('requires current live playback, permission and no pending command before any job', async t => {
  const cases = [
    f => f.clipStates.get('primary').authorized = false,
    f => f.patches.set('primary', { browser: { online: true, lastSeenAt: f.time - 45_001 } }),
    f => f.patches.set('primary', { watch: { enabled: true, channel: 'aviskarex', status: 'ad', checkedAt: f.time } }),
    f => f.patches.set('primary', { watch: { enabled: true, channel: 'aviskarex', status: 'playing', checkedAt: f.time - 15_001 } }),
    f => f.patches.set('primary', { streamContext: { channel: 'aviskarex', streamId: '123', isLive: true, checkedAt: f.time + 1 } }),
    f => f.patches.set('primary', { controls: { pending: { state: 'running' } } }),
    f => f.patches.set('primary', { settings: { allowedChannel: 'otherchannel', paused: true } })
  ];
  for (const patch of cases) {
    const f = fixture(); patch(f);
    await assert.rejects(f.c.create(request('gate', ['primary'])), { status: 409 });
    assert.equal(f.calls.length, 0); assert.equal(f.c.snapshot().jobs.length, 0); await f.cleanup();
  }
});

test('a durable journal failure prevents helper creation', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  f.db.exec("CREATE TRIGGER reject_clip BEFORE INSERT ON clip_jobs BEGIN SELECT RAISE(FAIL,'storage unavailable'); END");
  await assert.rejects(f.c.create(request()), /storage unavailable/);
  assert.equal(f.calls.length, 0);
});

test('unknown responses are never resent and reconcile from helper status only', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const original = f.accounts.clipCreate;
  f.accounts.clipCreate = async (...args) => { await original(...args); throw Error('response lost'); };
  const result = await f.c.create(request());
  assert.equal(result.job.state, 'unknown');
  await f.c.create(request()); assert.equal(f.calls.length, 1);
  f.clipStates.get('primary').jobs[0] = { ...f.clipStates.get('primary').jobs[0], state: 'confirmed', clipId: 'KnownClip', url: 'https://clips.twitch.tv/KnownClip' };
  await f.c.tick();
  assert.equal(f.c.snapshot().jobs[0].state, 'confirmed');
  assert.equal(f.c.snapshot().jobs[0].url, 'https://clips.twitch.tv/KnownClip');
  assert.equal(f.calls.length, 1);
});

test('restart preserves submission uncertainty and only reads status', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  await f.c.create(request());
  f.db.prepare("UPDATE clip_jobs SET state='submitting'").run();
  await f.c.close(); f.clipStates.get('primary').jobs = [];
  f.c = createClipController(f.options); await f.c.tick();
  assert.equal(f.c.snapshot().jobs[0].state, 'unknown');
  await f.c.create(request()); assert.equal(f.calls.length, 1);
});

test('both accounts and manual/automatic jobs share cooldown and hourly attempts', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const first = await f.c.create(request());
  const second = await f.c.create(request('second', ['test']));
  assert.equal(second.job.requestId, first.job.requestId); assert.equal(f.calls.length, 1);
  for (let i = 2; i <= 3; i++) { f.advance(600_001); f.clipStates.get('primary').jobs.at(-1).state = 'failed'; await f.c.create(request(`attempt-${i}`)); }
  f.advance(600_001); f.clipStates.get('primary').jobs.at(-1).state = 'failed';
  const fourth = await f.c.create(request('attempt-4'));
  assert.equal(f.calls.length, 3); assert.match(fourth.job.reason, /three clip attempts/);
});

test('configuration changes during preparation cancel without a helper call', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const pending = deferred(); f.accounts.snapshot = () => pending.promise;
  const creation = f.c.create(request()); await Promise.resolve();
  f.c.configure({ enabled: false, channel: 'otherchannel', accountIds: ['primary'] });
  pending.resolve({ instances: [] });
  await assert.rejects(creation, { status: 409 }); assert.equal(f.calls.length, 0);
});

test('close drains an already submitted task before the database may be closed', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const dispatched = deferred(), response = deferred(), original = f.accounts.clipCreate;
  f.accounts.clipCreate = async (...args) => { const result = await original(...args); dispatched.resolve(); await response.promise; return result; };
  const creation = f.c.create(request()); await dispatched.promise;
  let closed = false; const closing = f.c.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  response.resolve(); await creation; await closing;
  assert.equal(closed, true); assert.equal(f.c.snapshot().jobs[0].state, 'queued');
});

test('transient status failure removes stale permission and holds automatic creation', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  await f.c.tick(); assert.equal(f.c.snapshot().accounts[0].authorized, true);
  f.accounts.clipStatus = async () => { throw Error('offline'); }; await f.c.tick();
  assert.equal(f.c.snapshot().accounts[0].available, false);
  assert.equal(f.c.snapshot().accounts[0].authorized, false);
  await assert.rejects(f.c.create(request()), { status: 409 }); assert.equal(f.calls.length, 0);
});

test('snapshot and both clip status reads run concurrently within one timeout window', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const barrier = deferred(), started = [], originalSnapshot = f.accounts.snapshot, originalStatus = f.accounts.clipStatus;
  f.accounts.snapshot = async () => { started.push('snapshot'); await barrier.promise; return originalSnapshot(); };
  f.accounts.clipStatus = async id => { started.push(id); await barrier.promise; return originalStatus(id); };
  const ticking = f.c.tick(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started, ['snapshot', 'primary', 'test']);
  barrier.resolve(); await ticking;
});

test('authorization start requires held disconnected account and exposes public fields only', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  const result = await f.c.authorize({ accountId: 'primary', action: 'start' });
  assert.equal(result.userCode, 'ABCD'); assert.equal('privateToken' in result, false);
  f.resume(); await assert.rejects(f.c.authorize({ accountId: 'primary', action: 'start' }), { status: 409 });
  assert.equal(f.authCalls.length, 1);
});

test('automatic detector warms up, excludes both companions, and creates one genuine burst', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  f.resume(); f.c.configure({ enabled: true, channel: 'aviskarex', accountIds: ['primary', 'test'] });
  await f.c.tick(); assert.equal(f.c.snapshot().detector.state, 'warming');
  f.advance(90_000);
  for (let i = 0; i < 8; i++) f.messages.push({ id: `companion-${i}`, author: i % 2 ? 'main_companion' : 'second_companion', text: 'omg', at: f.time - i * 500, channel: 'aviskarex' });
  await f.c.tick(); assert.equal(f.calls.length, 0);
  for (let i = 0; i < 8; i++) f.messages.push({ id: `viewer-${i}`, author: `viewer_${i % 4}`, text: ['wow', 'PogChamp', 'omg', 'what a moment'][i % 4], at: f.time - i * 500, channel: 'aviskarex' });
  await f.c.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.source, 'automatic');
  assert.equal(f.c.snapshot().jobs[0].reason, 'Chat reaction detected');
  await f.c.tick(); assert.equal(f.calls.length, 1);
});

test('held coordination and playback interruptions reset observation instead of replaying backlog', async t => {
  const f = fixture(); t.after(() => f.cleanup());
  f.c.configure({ enabled: true, channel: 'aviskarex', accountIds: ['primary'] });
  await f.c.tick(); assert.equal(f.c.snapshot().detector.state, 'held');
  f.resume(); await f.c.tick(); f.advance(90_000);
  f.patches.set('primary', { connected: false, settings: { paused: true, allowedChannel: 'aviskarex' } }); await f.c.tick();
  f.resume(); await f.c.tick(); assert.equal(f.c.snapshot().detector.state, 'warming');
  assert.equal(f.calls.length, 0);
});

test('automatic final permit is single-use, bound to creator and invalidated by off, restart or pause', async t => {
  async function prepared() {
    const f = fixture(); t.after(() => f.cleanup()); f.resume();
    f.c.configure({ enabled: true, channel: 'aviskarex', accountIds: ['primary', 'test'] });
    await f.c.tick(); f.advance(90_000);
    for (let i = 0; i < 8; i++) f.messages.push({ id: `viewer-${i}`, author: `viewer_${i % 4}`, text: 'wow', at: f.time - i * 500, channel: 'aviskarex' });
    await f.c.tick(); return f;
  }
  const success = await prepared(), requestId = success.c.snapshot().jobs[0].requestId;
  assert.equal(success.c.permit('test', { requestId }).ok, false, 'other account cannot consume a permit');
  assert.equal(success.c.permit('primary', { requestId }).ok, true);
  assert.equal(success.c.permit('primary', { requestId }).ok, false, 'same permit cannot replay');
  const off = await prepared(), offId = off.c.snapshot().jobs[0].requestId;
  off.c.configure({ enabled: false, channel: 'aviskarex', accountIds: ['primary'] });
  off.c.configure({ enabled: true, channel: 'aviskarex', accountIds: ['primary', 'test'] });
  assert.equal(off.c.permit('primary', { requestId: offId }).ok, false, 're-enabling cannot revive old preparation');
  const restart = await prepared(), restartId = restart.c.snapshot().jobs[0].requestId;
  await restart.c.close(); restart.c = createClipController(restart.options); await restart.c.tick();
  assert.equal(restart.c.permit('primary', { requestId: restartId }).ok, false);
  const held = await prepared(), heldId = held.c.snapshot().jobs[0].requestId; held.hold();
  assert.equal(held.c.permit('primary', { requestId: heldId }).ok, false);
  const stale = await prepared(), staleId = stale.c.snapshot().jobs[0].requestId; stale.advance(60_001);
  assert.equal(stale.c.permit('primary', { requestId: staleId }).ok, false);
  assert.throws(() => stale.c.permit('primary', { requestId: staleId, source: 'manual' }));
});
