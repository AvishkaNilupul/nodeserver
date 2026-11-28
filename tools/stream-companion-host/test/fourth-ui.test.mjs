import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ACCOUNT_IDS, bankPayload, bankValidation, createDirectorController, createMessagesView, renderMessages, accountSummary } from '../public/messages.js';
import { createAccountsController, accountFromPath } from '../public/accounts.js';
import { createClipsController, createClipsView, renderClips } from '../public/clips.js';

const at = Date.parse('2026-11-26T07:00:00Z'), ids = ['primary', 'test', 'third', 'fourth'];
const bank = () => ({ entries: [
  { id: 'shared', kind: 'greeting', category: 'greeting', lines: ['hello chat'], accountIds: ['fourth', 'primary', 'test', 'third'], enabled: true },
  { id: 'selective', kind: 'reply', category: 'thanks', lines: ['you are welcome'], accountIds: ['test', 'third'], enabled: true }
], profiles: ids.map(id => ({ id, chatMode: id === 'fourth' ? 'mentions' : 'participate', replySource: 'local' })) });
const director = extra => ({ protocol: 1, updatedAt: new Date(at).toISOString(), ready: true, reason: '', revision: 6, csrfToken: 'fixture-csrf', bank: bank(),
  profiles: ids.map(id => ({ id, account: `${id}_account`, chatMode: id === 'fourth' ? 'mentions' : 'participate', replySource: 'local', ready: true, imports: { helper: true, browser: true } })),
  plans: [], history: [], nextBeforeId: null, imports: ids.map(accountId => ({ accountId, helper: true, browser: true, complete: true })), lastMutation: null, ...extra });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this._text = ''; this._value = ''; this.checked = false; this.hidden = false; }
  set innerHTML(_) { throw Error('Dynamic HTML forbidden'); }
  set textContent(text) { this._text = String(text); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(next) { this._value = next; }
  get value() { return this._value; }
  get options() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, fn) { this.listeners[key] = fn; }
}
function doc() { const nodes = new Map(); return { nodes, querySelector: () => null, addEventListener() {}, removeEventListener() {}, createElement: tag => new Node(tag), getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); } }; }

test('fourth bank UI accepts exactly four profiles and displays server assignments without expanding selective groups', async () => {
  assert.deepEqual(ACCOUNT_IDS, ids); assert.equal(bankValidation(bank()), '');
  for (const profileIds of [ids.slice(0, 3), [...ids, 'fifth'], ['primary', 'test', 'third', 'third']]) {
    const invalid = bank(); invalid.profiles = profileIds.map(id => ({ id, chatMode: 'mentions', replySource: 'local' })); assert.ok(bankValidation(invalid));
  }
  const data = director(), posts = [], c = createDirectorController({ now: () => at, fetchImpl: async (_path, options) => { if (options.method === 'POST') posts.push(options); return response(data); } });
  await c.refresh(); const view = createMessagesView(doc(), c); renderMessages(view, c.getState(), c, at);
  assert.equal(view.profiles.size, 4); assert.equal(view.entries.get('shared').accounts.fourth.checked, true); assert.equal(view.entries.get('selective').accounts.fourth.checked, false);
  assert.deepEqual(bankPayload(c.getState().bank), data.bank); assert.equal(c.getState().dirty, false); assert.equal(posts.length, 0);
  assert.match(accountSummary(data, 'fourth'), /Replies to mentions · Bank replies · 1 enabled message groups/);
});

test('fourth assignment ordering does not wedge read-only recovery after a lost save response', async () => {
  let data = director(), posts = 0;
  const c = createDirectorController({ now: () => at, requestId: () => 'fourth-save', fetchImpl: async (_path, options) => {
    if (options.method === 'POST') {
      posts++; const body = JSON.parse(options.body), canonical = body.bank;
      canonical.entries = canonical.entries.map(entry => ({ ...entry, accountIds: [...entry.accountIds].sort() }));
      data = director({ revision: 8, bank: canonical, lastMutation: { requestId: 'a-later-request', revision: 8 } }); throw Error('Response lost.');
    }
    return response(data);
  } });
  await c.refresh(); c.editEntry('shared', 'accountIds', ids); c.editEntry('shared', 'lines', 'edited shared greeting'); await c.saveBank(); await c.refresh();
  assert.equal(posts, 1); assert.equal(c.getState().mutation, null); assert.equal(c.getState().dirty, false); assert.match(c.getState().feedback, /matches your reviewed changes/);
});

test('fourth account module boot polls central settings while held and publishes the matching native profile', async t => {
  const saved = new Map(['document', 'location', 'fetch', 'setInterval', 'clearInterval', 'addEventListener', 'removeEventListener'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(() => { for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  const document = doc(), calls = [], data = director({ updatedAt: new Date().toISOString() });
  Object.assign(globalThis, { document, location: { pathname: '/accounts/fourth' }, fetch: async (path, options) => {
    calls.push({ path, options });
    return response(path === '/api/director/history/fourth/0' ? { history: [], nextBeforeId: null } : data);
  },
    setInterval: () => 1, clearInterval() {}, addEventListener() {}, removeEventListener() {} });
  const module = await import(new URL(`../public/messages.js?fourth-bootstrap-${Date.now()}`, import.meta.url));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(accountFromPath('/accounts/fourth'), 'fourth'); assert.equal(accountFromPath('/admin/stream-companion/accounts/fourth', '/admin/stream-companion'), 'fourth');
  assert.equal(module.savedDirectorProfile('fourth').id, 'fourth');
  assert.deepEqual(calls.map(call => [call.path, call.options.method]), [['/api/director', 'GET'], ['/api/director/history/fourth/0', 'GET']]);
  assert.match(document.getElementById('central-message-settings').textContent, /Replies to mentions/);
});

test('fourth missing browser import and filtered history remain explicit without issuing mutations', async () => {
  const data = director({ ready: false, reason: 'Waiting for every companion history migration.', history: [{ id: 7, accountId: 'primary', account: 'primary_account', text: 'primary history', textAvailable: true, delivery: 'confirmed', at }] });
  data.profiles[3].ready = false; data.profiles[3].reason = 'History migration is incomplete.'; data.profiles[3].imports.browser = false;
  const calls = [], c = createDirectorController({ now: () => at, fetchImpl: async (path, options) => {
    calls.push({ path, options }); return response(path.includes('/history/') ? { history: [{ id: 5, accountId: 'fourth', account: 'fourth_account', text: null, textAvailable: false, delivery: 'unknown', source: 'legacy', at: at - 1000 }], nextBeforeId: null } : data);
  } });
  await c.refresh(); const view = createMessagesView(doc(), c); renderMessages(view, c.getState(), c, at);
  assert.match(view.profiles.get('fourth').detail.textContent, /Saved messages: received\. Browser history: waiting/);
  assert.match(view.nodes['director-readiness'].textContent, /Waiting for every companion history/);
  c.choose('historyAccount', 'fourth'); await new Promise(resolve => setImmediate(resolve)); renderMessages(view, c.getState(), c, at);
  assert.equal(calls.at(-1).path, '/api/director/history/fourth/0'); assert.ok(calls.every(call => call.options.method === 'GET'));
  assert.match(view.nodes['director-history'].textContent, /fourth_account/); assert.match(view.nodes['director-history'].textContent, /Delivery uncertain · no retry/); assert.doesNotMatch(view.nodes['director-history'].textContent, /primary history|Delivery confirmed/);
});

function quickFixture({ missing, patch = {}, post } = {}) {
  const instances = ids.filter(id => id !== missing).map(id => ({ id, name: `${id} companion`, account: `${id}_account`, available: true, authorized: true, connected: false,
    settings: { paused: true, autoReply: false, autoResume: false, chatMode: 'mentions', replySource: 'local' }, browser: { online: true, lastSeenAt: new Date(at).toISOString() }, permissions: { playbackAccess: true }, controls: { pending: null, recent: [] }, ...(id === 'fourth' ? patch : {}) }));
  const calls = []; let request = 0;
  const c = createAccountsController({ now: () => at, requestId: () => `fourth-request-${++request}`, profileProvider: id => ({ id, chatMode: 'mentions', replySource: 'local' }), fetchImpl: async (path, options) => {
    const body = options.body && JSON.parse(options.body); calls.push({ path, options, body });
    if (path === '/api/accounts') {
      for (const instance of instances) if (instance.controls.pending?.action === 'start' && instance.controls.pending.params?.channel) {
        const pending = instance.controls.pending; pending.state = 'completed'; pending.result = { ok: true }; instance.controls.pending = null;
        instance.connected = true; instance.channel = pending.params.channel; Object.assign(instance.settings, pending.params, { allowedChannel: pending.params.channel, paused: false, autoReply: true });
      }
      return response({ updatedAt: new Date(at).toISOString(), csrfToken: 'fixture-csrf', instances });
    }
    if (path === '/api/status') return response({ updatedAt: new Date(at).toISOString(), csrfToken: 'fixture-csrf', paused: true });
    if (path === '/api/control') return response({ ok: true, paused: body.paused });
    const match = /^\/api\/accounts\/(primary|test|third|fourth)\/command$/.exec(path);
    if (match) { const command = { ...body, id: `operation-${request}`, state: 'queued', createdAt: at, expiresAt: at + 90000 }; await post?.(match[1], command); const instance = instances.find(instance => instance.id === match[1]); instance.controls.pending = command; instance.controls.recent.unshift(command); return response({ ok: true, command }); }
    throw Error('Unexpected fixture request.');
  } });
  return { c, instances, calls, posts: () => calls.filter(call => call.options.method === 'POST') };
}

test('fourth-only Quick Start and original Both keep exact account boundaries', async () => {
  for (const [selection, expected] of [['fourth', ['fourth']], ['both', ['primary', 'test']], ['all', ids]]) {
    const f = quickFixture(); await f.c.refresh(); f.c.editQuick('selection', selection); assert.equal(await f.c.quickStart(), true);
    assert.deepEqual(f.posts().filter(call => call.body.action === 'start').map(call => call.path.split('/').at(-2)), expected);
    assert.deepEqual(f.c.getState().quick.targetIds, expected);
    for (const instance of f.instances.filter(instance => !expected.includes(instance.id))) { assert.equal(instance.settings.paused, true); assert.equal(instance.settings.autoReply, false); }
  }
});

test('missing, unavailable, active or starting unselected fourth blocks original Both without any mutations', async () => {
  for (const options of [{ missing: 'fourth' }, { patch: { available: false } }, { patch: { settings: { paused: false, autoReply: true } } }, { patch: { controls: { pending: { action: 'start', state: 'running', expiresAt: at + 90000 }, recent: [] } } }]) {
    const f = quickFixture(options); await f.c.refresh(); f.c.editQuick('selection', 'both'); assert.equal(await f.c.quickStart(), false, JSON.stringify(options)); assert.equal(f.posts().length, 0);
  }
});

const subsets = { primary: ['primary'], test: ['test'], third: ['third'], fourth: ['fourth'], both: ['primary', 'test'], 'primary-third': ['primary', 'third'], 'test-third': ['test', 'third'],
  'primary-fourth': ['primary', 'fourth'], 'test-fourth': ['test', 'fourth'], 'third-fourth': ['third', 'fourth'], 'original-three': ['primary', 'test', 'third'],
  'primary-test-fourth': ['primary', 'test', 'fourth'], 'primary-third-fourth': ['primary', 'third', 'fourth'], 'test-third-fourth': ['test', 'third', 'fourth'], all: ids };
test('all 15 saved clip subsets roundtrip exactly without auto enable, grants or creation', async () => {
  const covered = new Set();
  for (const [selection, accountIds] of Object.entries(subsets)) {
    covered.add([...accountIds].sort().join(',')); const calls = [];
    const data = { ok: true, updatedAt: new Date(at).toISOString(), csrfToken: 'x'.repeat(43), settings: { enabled: false, channel: 'aviskarex', accountIds: [...accountIds].reverse() }, accounts: ids.map(id => ({ id, available: true, authorized: false, canAuthorize: true })), jobs: [] };
    const c = createClipsController({ now: () => at, fetchImpl: async (path, options) => { calls.push({ path, options, body: options.body && JSON.parse(options.body) }); return response(options.method === 'GET' ? data : { ok: true }); } });
    await c.refresh(); assert.equal(c.getState().form.selection, selection); assert.equal(c.getState().form.enabled, false); assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);
    const document = doc(), view = createClipsView(document); renderClips(view, c.getState(), { now: at }); assert.equal(view.nodes['clips-enabled'].checked, false);
    assert.equal(await c.save(), true); const posts = calls.filter(call => call.options.method === 'POST'); assert.equal(posts.length, 1); assert.ok(posts[0].path.endsWith('/settings')); assert.equal(posts[0].body.enabled, false);
    assert.deepEqual(new Set(posts[0].body.accountIds), new Set(accountIds));
    if (selection === 'original-three') assert.equal(posts[0].body.accountIds.includes('fourth'), false);
  }
  assert.equal(covered.size, 15);
});

test('fourth clip permission remains a separate explicit request and cannot enable existing clip settings', async () => {
  const calls = [], data = { ok: true, updatedAt: new Date(at).toISOString(), csrfToken: 'x'.repeat(43), settings: { enabled: false, channel: 'aviskarex', accountIds: ['primary', 'test', 'third'] }, accounts: ids.map(id => ({ id, account: `${id}_account`, available: true, authorized: false, canAuthorize: true })), jobs: [] };
  const c = createClipsController({ now: () => at, setTimeoutImpl: () => 1, clearTimeoutImpl() {}, fetchImpl: async (path, options) => {
    calls.push({ path, options, body: options.body && JSON.parse(options.body) }); return response(options.method === 'GET' ? data : { ok: true, pending: true, userCode: 'FOURTH99', verificationUrl: 'https://www.twitch.tv/activate', pollAfterMs: 5000 });
  } });
  await c.refresh(); assert.equal(calls.filter(call => call.options.method === 'POST').length, 0); assert.equal(c.canAuthorize('fourth'), true);
  assert.equal(await c.authorize('fourth'), true); const posts = calls.filter(call => call.options.method === 'POST');
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].body, { accountId: 'fourth', action: 'start' }); assert.ok(posts[0].path.endsWith('/authorization'));
  assert.equal(c.getState().form.selection, 'original-three'); assert.equal(c.getState().form.enabled, false);
  const view = createClipsView(doc()); renderClips(view, c.getState(), { now: at });
  assert.match(view.nodes['clips-auth-fourth'].textContent, /fourth_account/); assert.equal(view.nodes['clips-auth-primary'].textContent, ''); c.stop();
});

test('fourth markup and phone grids keep all native controls and filters addressable', async () => {
  const [accounts, messages, css, messageCss, clipCss] = await Promise.all(['account.html', 'messages.html', 'accounts.css', 'messages.css', 'clips.css'].map(name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')));
  for (const id of ['quick-account-fourth', 'quick-fourth-label', 'clips-name-fourth', 'clips-permission-fourth', 'clips-enable-fourth', 'clips-auth-fourth', 'clips-check-fourth']) assert.ok(accounts.includes(`id="${id}"`), id);
  assert.match(accounts, /All four/); assert.match(accounts, /value="original-three">Original three/); assert.equal((messages.match(/value="fourth">Fourth account/g) || []).length, 2);
  assert.match(css, /account-grid \{ grid-template-columns: repeat\(2/); assert.match(css, /max-width: 700px/); assert.match(messageCss, /director-profiles\{display:grid;grid-template-columns:repeat\(2/); assert.match(clipCss, /clips-permissions\{grid-template-columns:repeat\(2/);
});
