import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountsController, createAccountsView, renderAccounts } from '../public/accounts.js';

const at = Date.parse('2026-11-25T06:00:00Z');
const basePath = '/admin/stream-companion';
const response = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const account = id => ({ id, name: { primary: 'Main companion', test: 'Second companion', third: 'Third companion' }[id], account: `${id}_account`, available: true, authorized: true, connected: false,
  settings: { paused: true, autoReply: false, autoResume: id === 'test', chatMode: 'mentions', replySource: id === 'test' ? 'ai' : 'local' },
  browser: { online: true, lastSeenAt: new Date(at).toISOString() }, permissions: { playbackAccess: true }, controls: { pending: null, recent: [] } });
function fixture({ before, post, directory, onState, third = false, complete = true, sleep, controllerOptions = {} } = {}) {
  const instances = [account('primary'), account('test'), ...(third ? [account('third')] : [])], calls = []; let paused = true, count = 0, reads = 0, sleeps = 0;
  const finish = (id, state = 'completed', reason = 'Automatic chat is waiting for channel access.') => {
    const instance = instances.find(value => value.id === id), command = instance.controls.pending;
    assert.equal(command?.action, 'start');
    command.state = state; command.result = { ok: state === 'completed', reason }; instance.controls.pending = null;
    if (state === 'completed') {
      instance.connected = true; instance.channel = command.params.channel;
      Object.assign(instance.settings, command.params, { allowedChannel: command.params.channel, paused: false, autoReply: true });
      instance.activity = { state: 'waiting', reason, at };
    }
  };
  const fetchImpl = async (path, options) => {
    const body = options.body ? JSON.parse(options.body) : undefined, call = { path, options, body }; calls.push(call);
    if (before) await before(call, { instances, reads: ++reads, finish });
    if (path.endsWith('/api/channels') || /\/api\/channels\/[a-z0-9_]+$/.test(path)) return directory ? directory(call) : response({ updatedAt: new Date(at).toISOString(), channels: [{ login: 'aviskarex', displayName: 'aviskarex', isLive: false, checkedAt: at }, { login: 'live_channel', displayName: 'Live Channel', isLive: true, checkedAt: at }] });
    if (options.method === 'GET' && path.endsWith('/api/accounts')) {
      if (complete) for (const instance of instances) if (instance.controls.pending?.action === 'start' && instance.controls.pending.params?.channel && ['queued', 'running'].includes(instance.controls.pending.state)) finish(instance.id);
      return response({ updatedAt: new Date(at).toISOString(), csrfToken: 'test-csrf', instances });
    }
    if (options.method === 'GET' && path.endsWith('/api/status')) return response({ updatedAt: new Date(at).toISOString(), csrfToken: 'test-csrf', paused });
    if (path.endsWith('/api/control')) { paused = body.paused; return response({ ok: true, paused }); }
    const match = /\/api\/accounts\/(primary|test|third)\/command$/.exec(path);
    if (match && options.method === 'POST') {
      const command = { ...body, id: `command-${++count}`, state: 'queued', createdAt: at, expiresAt: at + 90000 };
      const custom = post ? await post(call, command) : undefined;
      if (custom) return custom;
      const instance = instances.find(i => i.id === match[1]); instance.controls.pending = command; instance.controls.recent.unshift(command);
      return response({ ok: true, command });
    }
    throw Error('Unexpected fixture request');
  };
  let rid = 0;
  const controller = createAccountsController({ basePath, fetchImpl, now: () => at, requestId: () => `request-${++rid}`, startWaitMs: 5000,
    sleepImpl: async ms => { sleeps++; await sleep?.(ms, { instances, finish, sleeps }); }, ...(onState ? { onState } : {}), ...controllerOptions });
  return { controller, calls, instances, finish, sleeps: () => sleeps, posts: () => calls.filter(c => c.options.method === 'POST') };
}

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; this.value = ''; this.hidden = false; this.replacements = 0; }
  set innerHTML(_) { throw Error('Dynamic HTML forbidden'); }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; this.replacements++; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}
const view = () => { const nodes = new Map(); return createAccountsView({ getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: tag => new Node(tag) }); };

test('real state rendering handles initial and reconciled outcomes throughout quick Start and Stop', async () => {
  for (const action of ['quickStart', 'quickStop']) {
    const v = view(); let f, initialRendered = false;
    f = fixture({ onState: state => {
      renderAccounts(v, state, { now: at, canCommand: f.controller.canCommand });
      if (state.quick.targetIds.length === 2 && state.quick.targetIds.every(id => state.quick.outcomes[id].state === 'not_requested')) {
        initialRendered = true;
        assert.match(v.nodes['quick-outcomes'].textContent, /Not requested/);
      }
    } });
    await f.controller.refresh(); f.controller.editQuick('selection', 'both');
    assert.equal(await f.controller[action](), true);
    assert.equal(initialRendered, true, `${action} renders before any operation exists`);
    assert.match(v.nodes['quick-outcomes'].textContent, /primary_account/);
    assert.match(v.nodes['quick-outcomes'].textContent, /test_account/);
    assert.match(v.nodes['quick-outcomes'].textContent, action === 'quickStart' ? /Completed/ : /Queued/);
    assert.equal(f.controller.getState().quick.busy, false);
  }
});

test('quick start uses only the chosen account and resumes shared coordination after its confirmed completion', async () => {
  const f = fixture(); await f.controller.refresh();
  assert.equal(f.controller.getState().quick.channel, 'aviskarex');
  assert.equal(await f.controller.quickStart(), true);
  assert.deepEqual(f.posts().map(c => c.path), [`${basePath}/api/accounts/primary/command`, `${basePath}/api/control`]);
  assert.deepEqual(f.posts()[0].body.params, { channel: 'aviskarex', chatMode: 'participate', replySource: 'local', autoResume: false });
  assert.deepEqual(f.posts()[1].body, { paused: false });
  assert.equal(f.controller.getState().operations.primary.command.state, 'completed');
  assert.match(f.controller.getState().quick.message, /completed Start/);
  assert.ok(f.calls.every(c => c.options.credentials === 'same-origin'));
  assert.ok(f.posts().every(c => c.options.headers['X-CSRF-Token'] === 'test-csrf'));
});

test('both-account choice freezes the selected channel and preserves each account source and recovery', async () => {
  const f = fixture(); await f.controller.refresh();
  f.controller.editQuick('selection', 'both'); f.controller.editQuick('channel', 'live_channel');
  const start = f.controller.quickStart(); f.controller.editQuick('channel', 'another_channel'); f.controller.editQuick('selection', 'primary');
  assert.equal(await f.controller.quickStart(), false, 'double click cannot dispatch another sequence');
  assert.equal(await start, true);
  assert.deepEqual(f.posts().map(c => c.path), [`${basePath}/api/accounts/primary/command`, `${basePath}/api/accounts/test/command`, `${basePath}/api/control`]);
  assert.equal(f.posts()[0].body.params.channel, 'live_channel'); assert.equal(f.posts()[1].body.params.channel, 'live_channel');
  assert.equal(f.posts()[1].body.params.replySource, 'ai'); assert.equal(f.posts()[1].body.params.autoResume, true);
});

test('all selected accounts pass preflight before any account or shared mutation', async () => {
  const f = fixture(); f.instances[1].browser.online = false; f.controller.editQuick('selection', 'both');
  assert.equal(await f.controller.quickStart(), false); assert.equal(f.posts().length, 0);
  assert.match(f.controller.getState().quick.error, /not ready/);
});

test('ambiguous first Start sends neither the second Start nor shared Resume and is not replayed', async () => {
  const f = fixture({ post: async () => { throw Error('private transport diagnostic'); } });
  f.controller.editQuick('selection', 'both'); assert.equal(await f.controller.quickStart(), false);
  await f.controller.refresh(); await f.controller.refresh();
  assert.equal(f.posts().length, 1); assert.equal(f.controller.getState().operations.primary.command.state, 'unknown');
  assert.equal(f.controller.getState().quick.outcomes.test.state, 'not_requested');
  assert.doesNotMatch(f.controller.getState().quick.error, /private transport diagnostic/);
});

test('a second-account timeout preserves the first outcome and cannot Resume shared coordination', async () => {
  const f = fixture({ post: async call => { if (call.path.endsWith('/test/command')) throw Error('private second-account diagnostic'); } });
  f.controller.editQuick('selection', 'both'); assert.equal(await f.controller.quickStart(), false);
  assert.equal(f.posts().length, 2); assert.equal(f.controller.getState().quick.outcomes.primary.state, 'completed');
  assert.equal(f.controller.getState().quick.outcomes.test.state, 'unknown');
  assert.doesNotMatch(f.controller.getState().quick.error, /private second-account diagnostic/);
});

test('a failed accepted Start stops the sequence before another Start or shared Resume', async () => {
  for (const state of ['failed', 'cancelled', 'expired']) {
    const f = fixture({ post: async (_call, command) => response({ ok: true, command: { ...command, state } }) });
    f.controller.editQuick('selection', 'both'); assert.equal(await f.controller.quickStart(), false);
    assert.equal(f.posts().length, 1); assert.equal(f.controller.getState().quick.outcomes.primary.state, state);
  }
});

test('unselected unavailable, pending or armed intent cannot be unexpectedly resumed', async () => {
  for (const change of [i => { i.available = false; }, i => { i.controls.pending = { action: 'start', state: 'queued', expiresAt: at + 90000 }; }, i => { i.settings.paused = false; i.settings.autoReply = true; }]) {
    const f = fixture(); change(f.instances[1]); assert.equal(await f.controller.quickStart(), false); assert.equal(f.posts().length, 0);
  }
});

test('an unselected account becoming unknown during launch prevents the final Resume', async () => {
  let started = false;
  const f = fixture({ post: async () => { started = true; }, before: async (call, context) => { if (started && call.path.endsWith('/api/accounts')) context.instances[1].available = false; } });
  assert.equal(await f.controller.quickStart(), false);
  assert.equal(f.posts().length, 1); assert.ok(f.posts()[0].path.endsWith('/primary/command'));
  assert.match(f.controller.getState().quick.error, /other account changed/);
});

test('Stop selected cancels an in-flight sequence before later Starts or Resume', async () => {
  const held = deferred(), began = deferred();
  const f = fixture({ post: async (call, command) => { if (call.body.action === 'start') { began.resolve(); await held.promise; return response({ ok: true, command }); } } });
  f.controller.editQuick('selection', 'both'); const starting = f.controller.quickStart(); await began.promise;
  assert.equal(await f.controller.quickStop(), true); held.resolve(); assert.equal(await starting, false);
  assert.deepEqual(f.posts().map(c => c.body.action || 'resume'), ['start', 'stop', 'stop']);
  assert.equal(f.controller.getState().quick.action, 'stop'); assert.equal(f.controller.getState().quick.busy, false);
});

test('all three must complete their matching Starts before shared Resume, including a waiting chat session', async () => {
  const v = view(); let f;
  f = fixture({ third: true, complete: false, onState: state => renderAccounts(v, state, { now: at, canCommand: f.controller.canCommand }),
    sleep: async (_ms, { finish, sleeps }) => {
      assert.equal(f.posts().some(call => call.path.endsWith('/api/control')), false, 'queued or partial completion cannot Resume');
      if (sleeps === 1) { finish('primary'); finish('test'); }
      else if (sleeps === 2) finish('third', 'completed', 'Watching the stream. Chat is waiting for channel access.');
    } });
  await f.controller.refresh(); f.controller.editQuick('selection', 'all');
  assert.equal(await f.controller.quickStart(), true);
  assert.equal(f.sleeps(), 2);
  assert.deepEqual(f.posts().filter(call => call.body.action === 'start').map(call => call.path.split('/').at(-2)), ['primary', 'test', 'third']);
  assert.equal(f.posts().filter(call => call.path.endsWith('/api/control')).length, 1);
  assert.ok(Object.values(f.controller.getState().quick.outcomes).every(outcome => outcome.state === 'completed'));
  assert.match(v.nodes['account-cards'].textContent, /Chat connection/);
  assert.match(v.nodes['account-cards'].textContent, /Chat is waiting for channel access/);
  assert.match(v.nodes['quick-message'].textContent, /channel access/);
});

test('a delayed third-account failure after all Starts were accepted cannot Resume or retry', async () => {
  const f = fixture({ third: true, complete: false, sleep: async (_ms, { finish }) => {
    finish('primary'); finish('test'); finish('third', 'failed', 'Channel access could not be confirmed.');
  } });
  await f.controller.refresh(); f.controller.editQuick('selection', 'all');
  assert.equal(await f.controller.quickStart(), false);
  assert.equal(f.controller.getState().quick.outcomes.third.state, 'failed');
  assert.match(f.controller.getState().quick.error, /did not complete Start successfully/);
  await f.controller.refresh(); await f.controller.refresh();
  assert.equal(f.posts().length, 3, 'only the three original Starts were posted');
  assert.equal(f.posts().some(call => call.path.endsWith('/api/control')), false);
});

test('pending Starts time out with their last reported outcomes and no shared Resume or retry', async () => {
  let waited = 0;
  const f = fixture({ complete: false, controllerOptions: { startWaitMs: 2500 }, sleep: async ms => { waited += ms; } });
  assert.equal(await f.controller.quickStart(), false);
  assert.equal(waited, 2500); assert.equal(f.sleeps(), 3);
  assert.equal(f.controller.getState().quick.outcomes.primary.state, 'queued');
  assert.equal(f.controller.getState().operations.primary.command.state, 'queued');
  assert.equal(f.controller.getState().quick.busy, false);
  assert.match(f.controller.getState().quick.error, /did not finish in time/);
  await f.controller.refresh();
  assert.equal(f.posts().length, 1);
});

test('a completed POST without the matching status record is insufficient for shared Resume', async () => {
  const f = fixture({ complete: false, post: async (_call, command) => response({ ok: true, command: { ...command, state: 'completed', result: { ok: true } } }) });
  assert.equal(await f.controller.quickStart(), false);
  assert.match(f.controller.getState().quick.error, /did not finish in time/);
  assert.equal(f.posts().length, 1);
});

test('queued and running commands cannot remain eligible after their original expiry', async () => {
  for (const state of ['queued', 'running']) {
    const f = fixture({ complete: false, sleep: async (_ms, { instances }) => {
      Object.assign(instances[0].controls.pending, { state, expiresAt: at - 1 });
    } });
    assert.equal(await f.controller.quickStart(), false);
    assert.match(f.controller.getState().quick.error, /expired before completion/);
    assert.equal(f.sleeps(), 1); assert.equal(f.posts().length, 1);
  }
});

test('a completed outcome remains valid when its original pending-command expiry has passed', async () => {
  const f = fixture({ complete: false, sleep: async (_ms, { instances, finish }) => {
    finish('primary'); instances[0].controls.recent[0].expiresAt = at - 1;
  } });
  assert.equal(await f.controller.quickStart(), true);
  assert.equal(f.posts().filter(call => call.path.endsWith('/api/control')).length, 1);
});

test('an unknown status read during completion waiting holds Resume and hides private diagnostics', async () => {
  let unavailable = false;
  const f = fixture({ complete: false, sleep: async () => { unavailable = true; }, before: async call => {
    if (unavailable && call.path.endsWith('/api/accounts')) throw Error('private status failure');
  } });
  assert.equal(await f.controller.quickStart(), false);
  assert.match(f.controller.getState().quick.error, /status is not current/);
  assert.doesNotMatch(f.controller.getState().quick.error, /private status failure/);
  assert.equal(f.posts().length, 1);
});

test('Stop all cancels completion waiting and late successful outcomes cannot Resume', async () => {
  const began = deferred(), release = deferred();
  const f = fixture({ third: true, complete: false, sleep: async () => { began.resolve(); await release.promise; } });
  await f.controller.refresh(); f.controller.editQuick('selection', 'all');
  const starting = f.controller.quickStart(); await began.promise;
  const starts = f.instances.map(instance => instance.controls.pending);
  assert.equal(await f.controller.quickStop(), true);
  for (const command of starts) { command.state = 'completed'; command.result = { ok: true }; }
  release.resolve(); assert.equal(await starting, false);
  assert.deepEqual(f.posts().map(call => call.body.action), ['start', 'start', 'start', 'stop', 'stop', 'stop']);
  assert.equal(f.controller.getState().quick.action, 'stop'); assert.equal(f.controller.getState().quick.busy, false);
});

test('an unselected account arming during completion waiting prevents shared Resume', async () => {
  const f = fixture({ complete: false, sleep: async (_ms, { instances, finish }) => {
    finish('primary'); Object.assign(instances[1].settings, { paused: false, autoReply: true });
  } });
  assert.equal(await f.controller.quickStart(), false);
  assert.match(f.controller.getState().quick.error, /other account changed/);
  assert.equal(f.posts().length, 1);
});

test('completion must retain the original command identity, channel and selected session', async () => {
  for (const change of [
    instance => { instance.controls.recent[0].id = 'different-command'; },
    instance => { instance.controls.recent[0].params.channel = 'other_channel'; },
    instance => { instance.controls.recent[0].params.replySource = 'ai'; },
    instance => { instance.controls.recent[0].params = {}; },
    instance => { instance.settings.paused = true; instance.settings.autoReply = false; },
    instance => { instance.settings.replySource = 'ai'; },
    instance => { instance.settings.autoResume = true; },
    instance => { instance.settings.chatMode = 'mentions'; },
    instance => { instance.browser.lastSeenAt = new Date(at - 46000).toISOString(); }
  ]) {
    const f = fixture({ complete: false, sleep: async (_ms, { instances, finish }) => { finish('primary'); change(instances[0]); } });
    assert.equal(await f.controller.quickStart(), false);
    assert.equal(f.posts().length, 1);
    assert.match(f.controller.getState().quick.error, /not resumed/);
  }
});

test('channel refresh and lookup preserve choices and edits without issuing mutations', async () => {
  const f = fixture(); await f.controller.refresh(); await f.controller.channels();
  f.controller.editQuick('selection', 'test'); f.controller.editQuick('channel', 'live_channel'); f.controller.editQuick('lookup', 'some_channel');
  await f.controller.refresh(); await f.controller.channels();
  const q = f.controller.getState().quick; assert.equal(q.selection, 'test'); assert.equal(q.channel, 'live_channel'); assert.equal(q.lookup, 'some_channel');
  assert.equal(await f.controller.channels('invalid/channel'), false); assert.equal(f.posts().length, 0);
});

test('directory failures never arm accounts; unknown differs from offline and polling does not rebuild the channel selector', async () => {
  const f = fixture(); await f.controller.refresh(); const v = view();
  renderAccounts(v, f.controller.getState(), { now: at, canCommand: f.controller.canCommand });
  assert.match(v.nodes['quick-channel-status'].textContent, /unknown/);
  await f.controller.channels(); renderAccounts(v, f.controller.getState(), { now: at, canCommand: f.controller.canCommand });
  assert.match(v.nodes['quick-channel-status'].textContent, /Offline/);
  const replacements = v.nodes['quick-channel'].replacements;
  await f.controller.refresh(); renderAccounts(v, f.controller.getState(), { now: at, canCommand: f.controller.canCommand });
  assert.equal(v.nodes['quick-channel'].replacements, replacements); assert.equal(f.posts().length, 0);
  const fail = fixture({ directory: async () => { throw Error('private directory diagnostic'); } }); await fail.controller.channels();
  assert.equal(fail.posts().length, 0); assert.match(fail.controller.getState().quick.error, /could not be refreshed/);
  renderAccounts(v, f.controller.getState(), { now: at + 121000, canCommand: f.controller.canCommand });
  assert.match(v.nodes['quick-channel-status'].textContent, /unknown/);
  assert.ok(v.nodes['quick-channel'].children.every(option => option.textContent.endsWith('Unknown')));
});

test('a pending channel lookup blocks Start and unexpected shared diagnostics stay private', async () => {
  const held = deferred(), f = fixture({ directory: async () => held.promise });
  await f.controller.refresh(); const loading = f.controller.channels('another_channel');
  assert.equal(await f.controller.quickStart(), false); assert.equal(f.posts().length, 0);
  held.resolve(response({ updatedAt: new Date(at).toISOString(), channels: [{ login: 'another_channel', isLive: null, checkedAt: at }] }));
  assert.equal(await loading, true); assert.equal(f.controller.getState().quick.channel, 'another_channel');
  const privateFailure = fixture({ before: call => { if (call.path.endsWith('/api/status')) throw Error('secret diagnostic must stay private'); } });
  assert.equal(await privateFailure.controller.quickStart(), false); assert.equal(privateFailure.posts().length, 0);
  assert.doesNotMatch(privateFailure.controller.getState().quick.error, /secret diagnostic/);
});


test('third and all quick choices target exactly their finite profiles while both keeps the original pair', async () => {
  for (const [selection, expected] of [['third', ['third']], ['all', ['primary', 'test', 'third']], ['both', ['primary', 'test']]]) {
    const f = fixture({ third: true }); await f.controller.refresh(); f.controller.editQuick('selection', selection);
    assert.equal(await f.controller.quickStart(), true);
    assert.deepEqual(f.posts().filter(call => call.body.action === 'start').map(call => call.path.split('/').at(-2)), expected);
    assert.equal(f.posts().filter(call => call.path.endsWith('/api/control')).length, 1);
    assert.deepEqual(f.controller.getState().quick.targetIds, expected);
  }
});

test('an unselected third profile must be held and known before resuming the original pair', async () => {
  for (const patch of [{ available: false }, { settings: { paused: false, autoReply: true } },
    { controls: { pending: { action: 'start', state: 'running', expiresAt: at + 90000 }, recent: [] } }]) {
    const f = fixture({ third: true }); Object.assign(f.instances[2], patch);
    f.controller.editQuick('selection', 'both');
    assert.equal(await f.controller.quickStart(), false); assert.equal(f.posts().length, 0);
    assert.match(f.controller.getState().quick.error, /other account/);
  }
});

test('an unavailable selected third prevents every all-three Start', async () => {
  const f = fixture({ third: true }); f.instances[2].available = false;
  f.controller.editQuick('selection', 'all'); assert.equal(await f.controller.quickStart(), false);
  assert.equal(f.posts().length, 0);
});

test('Stop all cancels a third-profile sequence before later Starts or shared Resume', async () => {
  const release = deferred(); let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const f = fixture({ third: true, post: async call => {
    if (call.body.action === 'start' && call.path.endsWith('/primary/command')) { enteredResolve(); await release.promise; }
  } });
  await f.controller.refresh(); f.controller.editQuick('selection', 'all');
  const start = f.controller.quickStart(); await entered;
  const stopped = f.controller.quickStop(); release.resolve(); await stopped; assert.equal(await start, false);
  assert.deepEqual(f.posts().filter(call => call.body.action === 'stop').map(call => call.path.split('/').at(-2)), ['primary', 'test', 'third']);
  assert.equal(f.posts().some(call => call.body.action === 'start' && call.path.endsWith('/third/command')), false);
  assert.equal(f.posts().some(call => call.path.endsWith('/api/control')), false);
});
