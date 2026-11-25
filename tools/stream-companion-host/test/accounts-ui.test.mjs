import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAccountsController, createAccountsView, renderAccounts, accountFromPath, bridgeFresh } from '../public/accounts.js';

const at = Date.parse('2026-11-25T02:00:00Z');
const instance = extra => ({ id: 'primary', name: 'Main companion', available: true, checkedAt: new Date(at).toISOString(), account: 'example_account', authorized: true, connected: true, channel: 'example_channel', error: '', settings: { allowedChannel: 'example_channel', paused: false, autoReply: false, autoResume: false, chatMode: 'mentions', replySource: 'local' }, browser: { online: true, lastSeenAt: new Date(at).toISOString() }, watch: { enabled: false, status: 'paused', channel: 'example_channel', checkedAt: at, error: '' }, activity: { state: 'waiting', reason: 'No useful reply yet.', at }, streamContext: { channel: 'example_channel', title: 'A title', gameName: 'A category', isLive: true, streamId: '1234', checkedAt: at }, chat: { messages: [{ id: 'one', author: 'someone', text: 'hello', at }], digest: { messages: 1, people: 1, topics: ['topic'] } }, sent: [{ at, channel: 'example_channel', text: 'previous message', delivery: 'unknown', reason: 'Delivery not confirmed.' }], drops: { enabled: false, status: 'disabled', lastCheckAt: at, history: [] }, coordination: { available: true, paused: false, reason: 'Waiting for a turn.' }, permissions: { playbackAccess: true }, controls: { pending: null, recent: [] }, ...extra });
const snapshot = extra => ({ updatedAt: new Date(at).toISOString(), instances: [instance()], csrfToken: 'ephemeral-private-control-nonce', ...extra });
const reply = (data, ok = true) => ({ ok, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const command = (body, extra = {}) => ({ ...body, id: 'server-operation', state: 'queued', createdAt: at, expiresAt: at + 90000, ...extra });
function controller(fetchImpl, extra = {}) { let n = 0; return createAccountsController({ fetchImpl, now: () => at, requestId: () => `request-${++n}`, ...extra }); }

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; this.hidden = false; this.value = ''; this.valueWrites = 0; }
  set innerHTML(_) { throw Error('Dynamic HTML is forbidden'); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}
function view() { const nodes = new Map(); return createAccountsView({ getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: tag => new Node(tag) }); }
const visible = v => Object.values(v.nodes).map(node => node.textContent).join('\n');

test('account paths are fixed and markup uses external self-hosted assets with labelled controls', async () => {
  assert.equal(accountFromPath('/accounts/primary'), 'primary'); assert.equal(accountFromPath('/accounts/test/'), 'test');
  for (const path of ['/accounts', '/accounts/anything', '/accounts/primary/x', '/accounts/%74est']) assert.equal(accountFromPath(path), null);
  const html = await readFile(new URL('../public/account.html', import.meta.url), 'utf8');
  assert.match(html, /src="__COMPANION_BASE__\/accounts.js"/); assert.match(html, /href="__COMPANION_BASE__\/accounts.css"/);
  assert.ok(!/<script(?![^>]*\bsrc=)|\son\w+=|\sstyle=|https?:\/\//.test(html));
  for (const id of Object.keys(view().nodes)) assert.ok(html.includes(`id="${id}"`), `${id} exists`);
  assert.match(html, /for="message-text"/); assert.match(html, /Drafting never posts to chat/);
});

test('hostile public strings are rendered literally and hidden credentials never enter visible UI', () => {
  const hostile = '<img src=x onerror=steal()>', data = snapshot(), v = view();
  data.instances[0].account = hostile; data.instances[0].streamContext.title = hostile;
  data.instances[0].chat.messages[0].text = hostile; data.instances[0].chat.messages[0].author = hostile;
  data.instances[0].sent[0].reason = hostile; data.instances[0].controls.recent = [command({ action: 'constructor', requestId: 'opaque' }, { state: 'failed', error: hostile })];
  data.instances[0].unexpectedPrivateField = 'should-never-render';
  const state = { data, network: 'online', error: '', operations: {}, forms: {} };
  renderAccounts(v, state, { id: 'primary', now: at });
  assert.ok(visible(v).includes(hostile)); assert.ok(!visible(v).includes(data.csrfToken)); assert.ok(!visible(v).includes('should-never-render'));
  assert.ok(visible(v).includes('Control request')); assert.ok(visible(v).includes('Delivery unconfirmed')); assert.ok(!visible(v).includes('Delivery confirmed'));
});

test('chat, playback, bridge and playback permission remain independent checks', async () => {
  const data = snapshot(), c = controller(async () => reply(data)); await c.refresh(); const v = view();
  renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
  assert.ok(v.nodes['status-checks'].textContent.includes('Connected')); assert.ok(v.nodes['status-checks'].textContent.includes('Paused'));
  assert.ok(!v.nodes['status-checks'].textContent.includes('Playing')); assert.equal(v.nodes.start.disabled, false);
  data.instances[0].permissions.playbackAccess = false; await c.refresh();
  renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
  assert.equal(v.nodes.start.disabled, true); assert.match(v.nodes['account-reason'].textContent, /Playback access is missing/);
  assert.equal(v.nodes.stop.disabled, false);
});

test('a revoked disconnected chat cannot be masked by a stale participation reason or enabled session pill', () => {
  const error = 'Twitch revoked the chat subscription’s authorization (authorization_revoked). Reauthorize Twitch before reconnecting.';
  const data = snapshot({ instances: [instance({ connected: false, error,
    watch: { enabled: true, status: 'playing', checkedAt: at, channel: 'example_channel' },
    activity: { state: 'ready', reason: 'Old ready decision must not mask the chat error.', at: at - 60_000 } })] });
  const v = view(); renderAccounts(v, { data, network: 'online', error: '', operations: {}, forms: {} }, { id: 'primary', now: at });
  assert.equal(v.nodes['session-state'].textContent, 'Chat disconnected'); assert.equal(v.nodes['session-state'].attributes['data-tone'], 'warn');
  assert.match(v.nodes['account-reason'].textContent, /authorization_revoked/); assert.match(v.nodes.broadcast.textContent, /authorization_revoked/);
  assert.doesNotMatch(v.nodes.broadcast.textContent, /Old ready decision/); assert.match(v.nodes['status-checks'].textContent, /Playing/);
  assert.match(v.nodes['status-checks'].textContent, /Disconnected/);
  data.instances[0].settings.paused = true; renderAccounts(v, { data, network: 'online', error: '', operations: {}, forms: {} }, { id: 'primary', now: at });
  assert.equal(v.nodes['session-state'].textContent, 'Stopped');
});

test('failed or stale host status preserves last data, labels it and blocks commands without leaking errors', async () => {
  let fail = false; const c = controller(async () => { if (fail) throw Error('credential-like secret diagnostic'); return reply(snapshot()); });
  await c.refresh(); fail = true; await c.refresh(); const v = view(); renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
  assert.equal(c.getState().network, 'offline'); assert.ok(c.getState().data); assert.equal(v.nodes.start.disabled, true); assert.equal(v.nodes.stop.disabled, true);
  assert.match(v.nodes['network-status'].textContent, /unavailable/); assert.ok(!visible(v).includes('secret diagnostic'));
  assert.ok(v.nodes.broadcast.textContent.includes('Broadcast unverified')); assert.ok(!v.nodes.broadcast.textContent.includes('Live broadcast reported'));
  for (const time of [at - 10001, at + 5001]) { const stale = controller(async () => reply(snapshot({ updatedAt: new Date(time).toISOString() }))); await stale.refresh(); assert.equal(stale.canCommand('primary', 'stop'), false); }
});

test('closed and stale profiles cannot execute browser actions, while Stop can hold the helper', async () => {
  for (const browser of [{ online: false, lastSeenAt: null }, { online: true, lastSeenAt: new Date(at - 45001).toISOString() }]) {
    const c = controller(async () => reply(snapshot({ instances: [instance({ browser })] }))); await c.refresh();
    assert.equal(bridgeFresh(c.getState().data.instances[0], at), false);
    for (const action of ['start', 'watch', 'settings', 'draft', 'send', 'drops-enable', 'drops-disable', 'drops-check']) assert.equal(c.canCommand('primary', action), false, action);
    assert.equal(c.canCommand('primary', 'stop'), true);
    const v = view(); renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
    assert.match(v.nodes['account-reason'].textContent, browser.online ? /stale/ : /closed or its extension is unavailable/);
  }
});

test('a stopped companion permits Watch and safe Settings while holding drafts, sends and claims', async () => {
  const stopped = instance(); stopped.settings.paused = true; stopped.drops.enabled = true;
  const c = controller(async () => reply(snapshot({ instances: [stopped] }))); await c.refresh();
  for (const action of ['start', 'stop', 'watch', 'settings', 'drops-disable']) assert.equal(c.canCommand('primary', action), true, action);
  for (const action of ['draft', 'send', 'drops-enable', 'drops-check']) assert.equal(c.canCommand('primary', action), false, action);
  c.edit('primary', 'text', 'reviewed message'); const v = view();
  renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
  assert.equal(v.nodes.watch.disabled, false); assert.equal(v.nodes['save-settings'].disabled, false); assert.equal(v.nodes['drops-disable'].disabled, false);
  for (const id of ['draft', 'summary', 'send', 'drops-enable', 'drops-check']) assert.equal(v.nodes[id].disabled, true, id);
});

test('no first browser heartbeat or a stale bridge cannot display a green enabled session', async () => {
  for (const browser of [{ online: false, lastSeenAt: null }, { online: true, lastSeenAt: new Date(at - 45001).toISOString() }]) {
    const data = snapshot({ instances: [instance({ browser, connected: false })] });
    const c = controller(async () => reply(data)); await c.refresh(); const v = view();
    renderAccounts(v, c.getState(), { now: at });
    assert.ok(v.nodes['account-cards'].textContent.includes('Session unverified'));
    assert.ok(!v.nodes['account-cards'].textContent.includes('Session enabled'));
    renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
    assert.equal(v.nodes['session-state'].textContent, 'Session unverified');
    assert.equal(v.nodes['session-state'].attributes['data-tone'], 'warn');
    assert.equal(v.nodes.start.disabled, true); assert.equal(v.nodes.stop.disabled, false);
    assert.match(v.nodes['settings-current'].textContent, browser.lastSeenAt ? /^Last reported settings:/ : /^Settings unverified/);
  }
});

test('channel, settings and manual text edits survive fresh polling and an unavailable helper', async () => {
  let data = snapshot(); const c = controller(async () => reply(data)); await c.refresh();
  c.edit('primary', 'channel', 'chosen_stream'); c.edit('primary', 'chatMode', 'participate'); c.edit('primary', 'autoResume', true); c.edit('primary', 'text', 'still editing');
  data.instances[0].settings.allowedChannel = 'different_stream'; await c.refresh();
  assert.equal(c.form('primary').channel, 'chosen_stream'); assert.equal(c.form('primary').chatMode, 'participate'); assert.equal(c.form('primary').autoResume, true); assert.equal(c.form('primary').text, 'still editing');
  data = snapshot({ instances: [{ id: 'primary', available: false }] }); await c.refresh(); assert.equal(c.form('primary').channel, 'chosen_stream');
  const v = view(); renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
  assert.equal(v.nodes.channel.value, 'chosen_stream'); assert.equal(v.nodes['message-text'].value, 'still editing');
  const descriptor = Object.getOwnPropertyDescriptor(v.nodes['message-text'], 'value');
  Object.defineProperty(v.nodes['message-text'], 'value', { configurable: true, get: () => descriptor.value, set: () => { throw Error('Polling reset the input caret'); } });
  renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
});

test('double-click send sends exactly once and queued status stays locked until a terminal result', async () => {
  const held = deferred(), bodies = []; let pending = null, recent = [];
  const c = controller(async (url, options) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body); bodies.push({ body, options, url }); await held.promise; pending = command(body); return reply({ ok: true, command: pending }); }
    return reply(snapshot({ instances: [instance({ controls: { pending, recent } })] }));
  });
  await c.refresh(); const first = c.command('primary', 'send', { text: 'reviewed text', account: 'never-forward', token: 'never-forward' });
  assert.equal(await c.command('primary', 'send', { text: 'reviewed text' }), false); assert.equal(bodies.length, 1); assert.equal(c.canCommand('primary', 'stop'), true);
  held.resolve(); assert.equal(await first, true); assert.equal(c.canCommand('primary', 'send'), false);
  assert.deepEqual(bodies[0].body, { requestId: 'request-1', action: 'send', params: { text: 'reviewed text' } });
  assert.equal(bodies[0].url, '/api/accounts/primary/command'); assert.equal(bodies[0].options.headers['X-CSRF-Token'], 'ephemeral-private-control-nonce');
  recent = [{ ...pending, state: 'completed', result: { reason: 'Delivery unconfirmed.' } }]; pending = null; await c.refresh();
  assert.equal(c.canCommand('primary', 'send'), true); const v = view(); renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand });
  assert.equal(v.nodes['operation-state'].textContent, 'Completed'); assert.ok(!v.nodes['operation-detail'].textContent.includes('Delivery confirmed'));
});

test('Stop preempts an in-flight Start and a late Start response cannot replace it', async () => {
  const held = deferred(), bodies = []; let pending = null;
  const c = controller(async (url, options) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body); bodies.push(body); if (body.action === 'start') { await held.promise; return reply({ ok: true, command: command(body) }); } pending = command(body); return reply({ ok: true, command: pending }); }
    return reply(snapshot({ instances: [instance({ controls: { pending, recent: [] } })] }));
  });
  await c.refresh(); const start = c.command('primary', 'start', { channel: 'Chosen_Streamer', chatMode: 'mentions', replySource: 'local', autoResume: false });
  assert.equal(c.canCommand('primary', 'stop'), true); assert.equal(await c.command('primary', 'settings', { chatMode: 'participate', replySource: 'local', autoResume: true }), false);
  assert.equal(await c.command('primary', 'stop'), true); held.resolve(); await start;
  assert.deepEqual(bodies.map(body => body.action), ['start', 'stop']); assert.equal(bodies[0].params.channel, 'chosen_streamer');
  assert.equal(c.getState().operations.primary.action, 'stop'); assert.equal(c.getState().operations.primary.command.state, 'queued');
});

test('ambiguous send outcome is not automatically retried and cannot unlock another send', async () => {
  let posts = 0; const c = controller(async (url, options) => { if (options.method === 'POST') { posts++; throw Error('private raw diagnostic'); } return reply(snapshot()); });
  await c.refresh(); assert.equal(await c.command('primary', 'send', { text: 'one message' }), false); await c.refresh();
  assert.equal(posts, 1); assert.equal(c.getState().operations.primary.command.state, 'unknown'); assert.equal(c.canCommand('primary', 'send'), false); assert.equal(c.canCommand('primary', 'stop'), true);
  assert.ok(!c.getState().error.includes('private')); assert.match(c.getState().error, /will not be sent again automatically/);
});

test('a GET started before a command is followed by a fresh read after acceptance', async () => {
  let gets = 0, pending = null; const held = deferred();
  const c = controller(async (url, options) => { if (options.method === 'POST') { pending = command(JSON.parse(options.body)); return reply({ ok: true, command: pending }); } if (++gets === 2) return held.promise; return reply(snapshot({ instances: [instance({ controls: { pending, recent: [] } })] })); });
  await c.refresh(); const old = c.refresh(), mutation = c.command('primary', 'watch'); held.resolve(reply(snapshot())); await old; await mutation;
  assert.equal(gets, 3); assert.equal(c.getState().data.instances[0].controls.pending.action, 'watch'); assert.equal(c.canCommand('primary', 'watch'), false);
});

test('delayed draft results never replace new edits and summaries stay separate from send text', async () => {
  let pending = null, recent = []; const c = controller(async (url, options) => { if (options.method === 'POST') { pending = command(JSON.parse(options.body)); return reply({ ok: true, command: pending }); } return reply(snapshot({ instances: [instance({ controls: { pending, recent } })] })); });
  await c.refresh(); c.edit('primary', 'text', 'before draft'); await c.command('primary', 'draft', { mode: 'reply' }); c.edit('primary', 'text', 'new manual edit');
  recent = [{ ...pending, state: 'completed', result: { text: 'late draft reply' } }]; pending = null; await c.refresh();
  assert.equal(c.form('primary').text, 'new manual edit'); assert.equal(c.form('primary').draftResult.text, 'late draft reply');
  await c.command('primary', 'draft', { mode: 'summary' }); const summary = 'A full summary. '.repeat(50); recent = [{ ...pending, state: 'completed', result: { text: summary } }, ...recent]; pending = null; await c.refresh();
  assert.equal(c.form('primary').text, 'new manual edit'); assert.equal(c.form('primary').draftResult.text, summary);
  const v = view(); renderAccounts(v, c.getState(), { id: 'primary', now: at, canCommand: c.canCommand }); assert.match(v.nodes['draft-result'].textContent, /Chat summary/); assert.ok(v.nodes['draft-result'].textContent.includes(summary));
});

test('a fresh completed reply draft fills an untouched composer without sending it', async () => {
  let recent = [], posts = 0; const c = controller(async (url, options) => { if (options.method === 'POST') { posts++; const done = command(JSON.parse(options.body), { state: 'completed', result: { text: 'ready for review' } }); recent = [done]; return reply({ ok: true, command: done }); } return reply(snapshot({ instances: [instance({ controls: { pending: null, recent } })] })); });
  await c.refresh(); await c.command('primary', 'draft', { mode: 'reply' }); assert.equal(c.form('primary').text, 'ready for review'); await c.refresh(); assert.equal(posts, 1);
});

test('invalid commands, unknown IDs, blank messages and unsafe channel URLs never issue a POST', async () => {
  let posts = 0; const c = controller(async (url, options) => { if (options.method === 'POST') posts++; return reply(snapshot()); }); await c.refresh();
  for (const [id, action, params] of [['unknown','stop',{}], ['primary','anything',{}], ['primary','send',{ text:' ' }], ['primary','send',{ text:'a'.repeat(301) }], ['primary','start',{ channel:'https://twitch.tv/a',chatMode:'mentions',replySource:'local',autoResume:false }], ['primary','settings',{ account:'other' }]]) assert.equal(await c.command(id, action, params), false);
  assert.equal(posts, 0);
});

test('delivery history is newest first for numeric or ISO times regardless of source ordering', () => {
  const records = [
    { at: at - 1000, text: 'newer numeric attempt', delivery: 'unknown' },
    { at: at - 9000, text: 'oldest attempt', delivery: 'rejected' },
    { at: new Date(at).toISOString(), text: 'newest ISO attempt', delivery: 'confirmed' }
  ];
  for (const sent of [records, [...records].reverse()]) {
    const v = view(), data = snapshot({ instances: [instance({ sent })] });
    renderAccounts(v, { data, network: 'online', error: '', operations: {}, forms: {} }, { id: 'primary', now: at });
    assert.match(v.nodes['delivery-history'].children[0].textContent, /newest ISO attempt/);
    assert.match(v.nodes['delivery-history'].children[1].textContent, /newer numeric attempt/);
    assert.match(v.nodes['delivery-history'].children[2].textContent, /oldest attempt/);
  }
  assert.equal(records[0].text, 'newer numeric attempt', 'rendering does not reorder the source snapshot');
});

test('the third profile has a fixed path, separate card and separate detail identity', async () => {
  for (const basePath of ['', '/admin/stream-companion']) assert.equal(accountFromPath(`${basePath}/accounts/third`, basePath), 'third');
  assert.equal(accountFromPath('/accounts/third/extra'), null); assert.equal(accountFromPath('/accounts/%74hird'), null);
  const third = instance({ id: 'third', name: 'Third companion', account: 'third_account' });
  const c = controller(async () => reply(snapshot({ instances: [instance(), instance({ id: 'test', name: 'Second companion', account: 'second_account' }), third] })));
  await c.refresh(); const v = view(); renderAccounts(v, c.getState(), { now: at, canCommand: c.canCommand });
  assert.equal(v.nodes['account-cards'].children.length, 3); assert.match(v.nodes['account-cards'].textContent, /Third companion/);
  const links = v.nodes['account-cards'].children.map(card => card.children.at(-1).attributes.href);
  assert.deepEqual(links, ['/accounts/primary', '/accounts/test', '/accounts/third']);
  renderAccounts(v, c.getState(), { id: 'third', now: at, canCommand: c.canCommand });
  assert.equal(v.nodes['page-eyebrow'].textContent, 'Third profile'); assert.equal(v.nodes['page-title'].textContent, 'Third companion');
  assert.match(v.nodes['page-description'].textContent, /third_account/);
  assert.equal(v.nodes['accounts-overview'].hidden, true); assert.equal(v.nodes['account-detail'].hidden, false);
});
