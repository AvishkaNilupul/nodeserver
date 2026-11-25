import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountsController, createAccountsView, renderAccounts } from '../public/accounts.js';

const START = Date.parse('2026-11-25T08:00:00Z'), BASE = '/admin/stream-companion';
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; this.value = ''; }
  set innerHTML(_) { throw Error('Dynamic HTML forbidden'); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
}
function fixture({ closed = ['primary'], cachedClosed = [], connect = true, browserResponse, before, sleep, detail = null, third = false } = {}) {
  let time = START, rid = 0, commandId = 0, paused = true, tick;
  const calls = [], messages = [], nodes = new Map();
  const view = createAccountsView({ getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: tag => new Node(tag) });
  const instances = ['primary', 'test', ...(third ? ['third'] : [])].map(id => ({ id, account: `${id}_account`, name: id === 'primary' ? 'Main companion' : 'Second companion',
    available: true, authorized: true, connected: false, settings: { paused: true, autoReply: false, autoResume: false, replySource: 'local', chatMode: 'mentions' },
    permissions: { playbackAccess: true }, browser: { online: !closed.includes(id), canOpen: true, lastSeenAt: new Date(time).toISOString() }, controls: { pending: null, recent: [] } }));
  const heartbeat = new Set(instances.filter(instance => instance.browser.online && !cachedClosed.includes(instance.id)).map(instance => instance.id));
  let controller;
  const fetchImpl = async (path, options) => {
    const call = { path, options, body: options.body ? JSON.parse(options.body) : undefined, at: time }; calls.push(call);
    await before?.(call, { instances, time, heartbeat });
    if (options.method === 'GET' && path.endsWith('/api/accounts')) {
      for (const instance of instances) {
        const command = instance.controls.pending;
        if (command?.action !== 'start' || !command.params?.channel) continue;
        command.state = 'completed'; command.result = { ok: true }; instance.controls.pending = null;
        instance.connected = true; instance.channel = command.params.channel;
        Object.assign(instance.settings, command.params, { allowedChannel: command.params.channel, paused: false, autoReply: true });
      }
      return response({ updatedAt: new Date(time).toISOString(), csrfToken: 'fixture-browser-csrf', instances });
    }
    if (options.method === 'GET' && path.endsWith('/api/status')) return response({ updatedAt: new Date(time).toISOString(), csrfToken: 'fixture-browser-csrf', paused });
    const opening = /\/api\/accounts\/(primary|test|third)\/browser$/.exec(path);
    if (opening) {
      assert.equal(options.method, 'POST'); assert.deepEqual(Object.keys(call.body), ['requestId']);
      assert.equal(options.headers['X-CSRF-Token'], 'fixture-browser-csrf');
      if (browserResponse) return browserResponse(call, { heartbeat });
      if (connect) heartbeat.add(opening[1]);
      return response({ ok: true, state: 'opening' });
    }
    if (path.endsWith('/api/control')) { paused = call.body.paused; return response({ ok: true, paused }); }
    const action = /\/api\/accounts\/(primary|test|third)\/command$/.exec(path);
    if (action) {
      const instance = instances.find(value => value.id === action[1]);
      const command = { ...call.body, id: `command-${++commandId}`, state: 'queued', createdAt: time, expiresAt: time + 90000 };
      instance.controls.pending = command; instance.controls.recent.unshift(command);
      return response({ ok: true, command });
    }
    throw Error('Unexpected fixture request');
  };
  controller = createAccountsController({ basePath: BASE, fetchImpl, now: () => time, requestId: () => `browser-request-${++rid}`,
    browserWaitMs: 100, browserGraceMs: 30, browserPollMs: 10,
    sleepImpl: async ms => {
      time += ms;
      await sleep?.({ time, instances, calls, heartbeat });
      for (const id of heartbeat) { const instance = instances.find(value => value.id === id); instance.browser.online = true; instance.browser.lastSeenAt = new Date(time).toISOString(); }
    }, setIntervalImpl: fn => { tick = fn; return 1; }, clearIntervalImpl: () => {},
    onState: state => { renderAccounts(view, state, { id: detail, now: time, canCommand: controller.canCommand }); messages.push(state.quick.message); }
  });
  return { controller, instances, calls, view, messages, heartbeat, tick: () => tick?.(), posts: () => calls.filter(call => call.options.method === 'POST'),
    opens: () => calls.filter(call => call.path.endsWith('/browser')), commands: () => calls.filter(call => call.path.endsWith('/command')) };
}

test('a closed selected profile opens once, then a new heartbeat allows its Start and shared Resume', async () => {
  const f = fixture(); await f.controller.refresh();
  assert.equal(f.controller.canCommand('primary', 'start'), true);
  for (const action of ['watch', 'settings', 'draft', 'send', 'drops-check']) assert.equal(f.controller.canCommand('primary', action), false);
  assert.equal(await f.controller.quickStart(), true);
  assert.deepEqual(f.posts().map(call => call.path), [`${BASE}/api/accounts/primary/browser`, `${BASE}/api/accounts/primary/command`, `${BASE}/api/control`]);
  assert.equal(f.commands()[0].body.action, 'start');
  assert.ok(f.messages.some(message => /Opening the main/.test(message)));
  assert.equal(Object.keys(f.controller.getState().browserPreparations).length, 0);
  assert.ok(f.calls.every(call => call.options.credentials === 'same-origin'));
});

test('both closed profiles connect before either selected Start can be posted', async () => {
  const f = fixture({ closed: ['primary', 'test'], before: (call, { instances }) => {
    if (call.path.endsWith('/command') && call.body.action === 'start') assert.ok(instances.every(instance => instance.browser.online && Date.parse(instance.browser.lastSeenAt) > START));
  } });
  await f.controller.refresh(); f.controller.editQuick('selection', 'both');
  assert.equal(await f.controller.quickStart(), true);
  assert.deepEqual(f.posts().map(call => call.path), [`${BASE}/api/accounts/primary/browser`, `${BASE}/api/accounts/test/browser`, `${BASE}/api/accounts/primary/command`, `${BASE}/api/accounts/test/command`, `${BASE}/api/control`]);
});

test('immediate profile closure cannot use a cached green heartbeat to skip reopening', async () => {
  const f = fixture({ closed: [], cachedClosed: ['primary'] }); await f.controller.refresh();
  assert.equal(f.controller.getState().data.instances[0].browser.online, true);
  assert.equal(await f.controller.quickStart(), true);
  assert.equal(f.opens().length, 1); assert.ok(f.opens()[0].at >= START + 30);
  assert.ok(f.commands()[0].at > f.opens()[0].at, 'Start waits for heartbeat after the opening acknowledgement');
});

test('healthy launch-capable profiles prove a newer heartbeat without opening another window', async () => {
  const f = fixture({ closed: [] }); await f.controller.refresh();
  assert.equal(await f.controller.quickStart(), true); assert.equal(f.opens().length, 0);
  assert.ok(f.commands()[0].at > START);
});

test('spawn acknowledgement without a browser heartbeat times out without Start or Resume or retries', async () => {
  const f = fixture({ connect: false }); await f.controller.refresh();
  assert.equal(await f.controller.quickStart(), false);
  assert.equal(f.opens().length, 1); assert.equal(f.commands().length, 0);
  assert.equal(f.posts().length, 1); assert.match(f.controller.getState().quick.error, /did not connect in time/);
  await f.controller.refresh(); await f.controller.refresh(); assert.equal(f.opens().length, 1);
});

test('failed or ambiguous browser opening stops the sequence and keeps private diagnostics out of UI', async () => {
  for (const browserResponse of [() => response({ error: 'private-diagnostic' }, 503), () => { throw Error('private-diagnostic'); }, () => response({ ok: true, state: 'unknown' })]) {
    const f = fixture({ browserResponse }); await f.controller.refresh();
    assert.equal(await f.controller.quickStart(), false); assert.equal(f.posts().length, 1); assert.equal(f.commands().length, 0);
    assert.doesNotMatch(f.controller.getState().quick.error, /private-diagnostic/);
  }
});

test('all selected access gates are checked before any profile opening request', async () => {
  for (const change of [instance => { instance.available = false; }, instance => { instance.authorized = false; }, instance => { instance.permissions.playbackAccess = false; instance.browser.online = true; }, instance => { instance.controls.pending = { action: 'start', state: 'queued' }; }]) {
    const f = fixture({ closed: ['primary', 'test'] }); change(f.instances[1]); f.controller.editQuick('selection', 'both');
    assert.equal(await f.controller.quickStart(), false); assert.equal(f.posts().length, 0);
  }
});

test('closed profiles with unknown cached playback access can open, then fresh permission allows Start', async () => {
  const f = fixture({ sleep: ({ instances }) => { instances[0].permissions.playbackAccess = true; } });
  f.instances[0].permissions.playbackAccess = false;
  await f.controller.refresh();
  assert.equal(f.controller.canCommand('primary', 'start'), true);
  assert.equal(f.view.nodes['quick-start'].disabled, false, 'actual rendering enables browser preparation');
  assert.equal(await f.controller.quickStart(), true);
  assert.equal(f.opens().length, 1); assert.deepEqual(f.commands().map(call => call.body.action), ['start']);
  assert.ok(f.commands()[0].at > f.opens()[0].at);
});

test('a newly connected profile reporting denied playback access never receives Start', async () => {
  const f = fixture(); f.instances[0].permissions.playbackAccess = false;
  await f.controller.refresh();
  assert.equal(f.view.nodes['quick-start'].disabled, false, 'unknown offline permission permits opening only');
  assert.equal(await f.controller.quickStart(), false);
  assert.equal(f.opens().length, 1); assert.equal(f.commands().length, 0);
  assert.equal(f.posts().filter(call => call.path.endsWith('/api/control')).length, 0);
  assert.equal(f.view.nodes['quick-start'].disabled, true, 'fresh denied permission blocks another Start');
  assert.match(f.controller.getState().quick.error, /playback access is still unavailable/);
  const denied = fixture({ closed: [] }); denied.instances[0].permissions.playbackAccess = false;
  await denied.controller.refresh();
  assert.equal(denied.controller.canCommand('primary', 'start'), false);
  assert.equal(denied.view.nodes['quick-start'].disabled, true);
  assert.equal(await denied.controller.quickStart(), false); assert.equal(denied.posts().length, 0);
  const revoked = fixture({ sleep: ({ instances }) => { instances[0].permissions.playbackAccess = false; } });
  await revoked.controller.refresh();
  assert.equal(await revoked.controller.quickStart(), false); assert.equal(revoked.opens().length, 1); assert.equal(revoked.commands().length, 0);
  assert.match(revoked.controller.getState().quick.error, /no longer ready/);
});

test('cold startup waits through the first handshake heartbeat until playback permission is reported', async () => {
  let heartbeatCount = 0;
  const f = fixture({ sleep: ({ instances }) => { if (++heartbeatCount >= 2) instances[0].permissions.playbackAccess = true; } });
  f.instances[0].permissions.playbackAccess = false;
  await f.controller.refresh();
  assert.equal(await f.controller.quickStart(), true);
  assert.equal(f.opens().length, 1); assert.equal(f.commands().length, 1);
  assert.ok(f.commands()[0].at >= START + 20, 'first online heartbeat with false permission cannot Start');
});

test('Quick Stop cancels browser waiting before any Start or Resume can follow', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ closed: ['primary', 'test'], sleep: async () => { entered.resolve(); await release.promise; } });
  await f.controller.refresh(); f.controller.editQuick('selection', 'both');
  const starting = f.controller.quickStart(); await entered.promise;
  assert.equal(await f.controller.quickStop(), true); release.resolve(); assert.equal(await starting, false);
  assert.deepEqual(f.commands().map(call => call.body.action), ['stop', 'stop']);
  assert.equal(f.posts().filter(call => call.path.endsWith('/api/control')).length, 0);
  assert.equal(f.controller.getState().quick.action, 'stop'); assert.equal(f.controller.getState().quick.busy, false);
});

test('individual Start auto-opens its profile and individual Stop cancels an in-flight preparation', async () => {
  const params = { channel: 'aviskarex', chatMode: 'participate', replySource: 'local', autoResume: false };
  const ready = fixture({ detail: 'primary' }); await ready.controller.refresh();
  assert.equal(await ready.controller.command('primary', 'start', params), true);
  assert.equal(ready.opens().length, 1); assert.deepEqual(ready.commands().map(call => call.body.action), ['start']);
  const entered = deferred(), release = deferred();
  const stopped = fixture({ detail: 'primary', sleep: async () => { entered.resolve(); await release.promise; } }); await stopped.controller.refresh();
  const starting = stopped.controller.command('primary', 'start', params); await entered.promise;
  assert.equal(await stopped.controller.command('primary', 'start', params), false, 'double click is held by preparation lock');
  assert.equal(await stopped.controller.command('primary', 'stop'), true); release.resolve(); assert.equal(await starting, false);
  assert.equal(stopped.opens().length, 1); assert.deepEqual(stopped.commands().map(call => call.body.action), ['stop']);
});

test('a direct Stop cancels Quick Start preparation and leaves accurate cancellation feedback', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ sleep: async () => { entered.resolve(); await release.promise; } }); await f.controller.refresh();
  const starting = f.controller.quickStart(); await entered.promise;
  assert.equal(await f.controller.command('primary', 'stop'), true);
  release.resolve(); assert.equal(await starting, false);
  assert.match(f.controller.getState().quick.message, /cancelled/);
  assert.equal(f.controller.getState().quick.busy, false);
  assert.deepEqual(f.commands().map(call => call.body.action), ['stop']);
});

test('Stop remains usable to cancel browser startup when the host status becomes unavailable', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ sleep: async () => { entered.resolve(); await release.promise; } }); await f.controller.refresh();
  const starting = f.controller.quickStart(); await entered.promise;
  f.controller.getState().network = 'offline';
  renderAccounts(f.view, f.controller.getState(), { now: START, canCommand: f.controller.canCommand });
  assert.equal(f.view.nodes['quick-stop'].disabled, false);
  assert.equal(await f.controller.quickStop(), false, 'local cancellation is not a confirmed server Stop');
  release.resolve(); assert.equal(await starting, false);
  assert.match(f.controller.getState().quick.error, /startup was cancelled/);
  assert.equal(f.commands().length, 0);
});

test('status reads, lifecycle polling and closed unsupported profiles cannot open browsers', async () => {
  const f = fixture(); await f.controller.refresh(); f.controller.start(); await f.controller.refresh(); f.tick(); await f.controller.refresh(); f.controller.stop();
  assert.equal(f.posts().length, 0);
  f.instances[0].browser.canOpen = false; await f.controller.refresh();
  assert.equal(f.controller.canCommand('primary', 'start'), false);
  assert.equal(await f.controller.quickStart(), false); assert.equal(f.posts().length, 0);
});


test('a closed third profile opens only its fixed browser and supports individual Start', async () => {
  const f = fixture({ third: true, closed: ['third'], detail: 'third' }); await f.controller.refresh();
  assert.equal(f.controller.canCommand('third', 'start'), true);
  assert.equal(await f.controller.command('third', 'start', { channel: 'aviskarex', chatMode: 'mentions', replySource: 'local', autoResume: false }), true);
  assert.deepEqual(f.opens().map(call => call.path), [`${BASE}/api/accounts/third/browser`]);
  assert.deepEqual(f.commands().map(call => call.path), [`${BASE}/api/accounts/third/command`]);
  assert.match(f.view.nodes['page-eyebrow'].textContent, /Third profile/);
  assert.equal(Object.keys(f.controller.getState().browserPreparations).length, 0);
});

test('all three closed browsers prove readiness before any selected Start', async () => {
  const f = fixture({ third: true, closed: ['primary', 'test', 'third'], before: (call, { instances }) => {
    if (call.body?.action === 'start') assert.ok(instances.every(instance => instance.browser.online && Date.parse(instance.browser.lastSeenAt) > START));
  } });
  await f.controller.refresh(); f.controller.editQuick('selection', 'all');
  assert.equal(await f.controller.quickStart(), true);
  assert.deepEqual(f.opens().map(call => call.path), ['primary', 'test', 'third'].map(id => `${BASE}/api/accounts/${id}/browser`));
  assert.deepEqual(f.commands().map(call => call.path), ['primary', 'test', 'third'].map(id => `${BASE}/api/accounts/${id}/command`));
});

test('Stop during third browser preparation cancels its later Start and Resume', async () => {
  let f, stopped = false;
  f = fixture({ third: true, closed: ['third'], connect: false, sleep: async () => {
    if (!stopped) { stopped = true; assert.equal(await f.controller.command('third', 'stop'), true); }
  } });
  await f.controller.refresh(); f.controller.editQuick('selection', 'third');
  assert.equal(await f.controller.quickStart(), false);
  assert.deepEqual(f.commands().map(call => call.body.action), ['stop']);
  assert.equal(f.posts().some(call => call.path.endsWith('/api/control')), false);
  assert.equal(Object.keys(f.controller.getState().browserPreparations).length, 0);
});
