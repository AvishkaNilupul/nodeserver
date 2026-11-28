import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDirectorController, bankPayload, bankValidation, createMessagesView, renderMessages, renderAccountDirector, timelineRow, historyRows, accountSummary } from '../public/messages.js';
import { basePathFromModule } from '../public/controller-path.js';
import { createAccountsController } from '../public/accounts.js';
import { defaultBank, validateBank } from '../lib/bank.mjs';

const at = Date.parse('2026-11-26T04:00:00Z');
const bank = () => ({ entries: [{ id: 'hello', kind: 'greeting', category: 'greeting', lines: ['hello chat'], accountIds: ['primary', 'test', 'third'], enabled: true }], profiles: ['primary', 'test', 'third', 'fourth'].map(id => ({ id, chatMode: 'mentions', replySource: 'local' })) });
const snapshot = extra => ({ protocol: 1, ready: false, reason: 'Waiting for imported history.', updatedAt: new Date(at).toISOString(), csrfToken: 'fixture-ephemeral-csrf', revision: 1, bank: bank(), profiles: ['primary', 'test', 'third', 'fourth'].map(id => ({ id, account: `${id}_account`, chatMode: 'mentions', replySource: 'local', ready: false, reason: 'History pending.' })), plans: [], history: [], imports: [], nextBeforeId: null, lastMutation: null, ...extra });
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => structuredClone(value) });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const ctrl = (fetchImpl, extra = {}) => { let n = 0; return createDirectorController({ fetchImpl, now: () => at, requestId: () => `request-${++n}`, ...extra }); };
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = {}; this._text = ''; this._value = ''; this.valueWrites = 0; this.hidden = false; this.checked = false; this.disabled = false; this.replacements = 0; }
  set innerHTML(_) { throw Error('Dynamic HTML forbidden'); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(next) { this._value = next; this.valueWrites++; }
  get value() { return this._value; }
  get options() { return this.children; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; this.replacements++; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(key, action) { this.listeners[key] = action; }
}
function doc() { const nodes = new Map(); return { nodes, getElementById(id) { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement(tag) { return new Node(tag); } }; }
const visible = view => Object.values(view.nodes).map(node => node.textContent).join('\n');

test('bank payload explicitly whitelists canonical input and strips response/private metadata', () => {
  const input = bank(); input.revision = 42; input.private = 'never'; input.entries[0].textKey = 'fingerprint'; input.entries[0].token = 'never'; input.profiles[0].account = 'never';
  assert.deepEqual(bankPayload(input), bank()); assert.doesNotMatch(JSON.stringify(bankPayload(input)), /never|fingerprint|revision/);
  assert.equal(bankValidation(bank()), '');
  assert.equal(bankValidation(defaultBank()), ''); assert.deepEqual(validateBank(bankPayload(defaultBank())), validateBank(defaultBank()));
});

test('bank validation covers kind/category limits, exact exchanges, templates, commands and byte bounds', () => {
  for (const text of ['', ' spaced ', '/ban somebody', '.command', 'https://example.test', 'www.example.test', 'a\u0000b', 'a'.repeat(261), '{title}', '{anything}']) {
    const data = bank(); data.entries[0].lines = [text]; assert.ok(bankValidation(data), text);
  }
  const data = bank(); data.entries[0] = { id: 'scene', kind: 'exchange', category: 'exchange', lines: ['first', 'second'], accountIds: ['primary', 'test'], enabled: true };
  assert.equal(bankValidation(data), ''); data.entries[0].lines.push('third'); assert.ok(bankValidation(data));
  data.entries[0].lines = ['@someone first', 'second']; assert.match(bankValidation(data), /host adds the partner mention/);
  data.entries[0] = { id: 'topic', kind: 'topic', category: 'general', lines: ['what about {game}?'], accountIds: ['primary'], enabled: true }; assert.equal(bankValidation(data), '');
  data.entries[0].category = 'unrecognized'; assert.ok(bankValidation(data));
  data.entries[0] = { id: 'metadata', kind: 'reply', category: 'streamtitle', lines: ['the title says {title}'], accountIds: ['primary'], enabled: true }; assert.equal(bankValidation(data), '');
  data.entries[0].category = 'thanks'; assert.ok(bankValidation(data));
  const oversized = bank(); oversized.entries = Array.from({ length: 128 }, (_, i) => ({ ...oversized.entries[0], id: `entry${i}`, lines: Array.from({ length: 16 }, () => 'word '.repeat(50).trim()) })); assert.match(bankValidation(oversized), /too large/);
});

test('bank can save with closed browsers and pending imports, while stale host cannot save', async () => {
  let current = at; const c = ctrl(async () => response(snapshot()), { now: () => current });
  await c.refresh(); c.editEntry('hello', 'lines', 'new greeting'); assert.equal(c.canSave(), true);
  current += 10001; assert.equal(c.canSave(), false);
});

test('dirty forms, focused input identity and values survive polling and external revisions', async () => {
  let data = snapshot(); const c = ctrl(async () => response(data)), document = doc(); const view = createMessagesView(document, c);
  await c.refresh(); renderMessages(view, c.getState(), c, at);
  const input = view.entries.get('hello').lines; input.value = 'my unsaved words'; c.editEntry('hello', 'lines', input.value); renderMessages(view, c.getState(), c, at);
  const writes = input.valueWrites, replacements = view.nodes['bank-entries'].replacements;
  data = snapshot({ revision: 2 }); data.bank.entries[0].lines = ['saved elsewhere']; await c.refresh(); renderMessages(view, c.getState(), c, at);
  assert.equal(view.entries.get('hello').lines, input); assert.equal(input.value, 'my unsaved words'); assert.equal(input.valueWrites, writes); assert.equal(view.nodes['bank-entries'].replacements, replacements);
  assert.equal(c.getState().conflict, true); assert.equal(c.canSave(), false); assert.match(visible(view), /edits are preserved/);
  c.reloadBank(); assert.equal(c.getState().bank.entries[0].lines[0], 'saved elsewhere'); assert.equal(c.getState().dirty, false);
});

test('double-click save submits one exact CAS bank and confirmation comes from fresh host status', async () => {
  let data = snapshot(); const held = deferred(), posts = [];
  const c = ctrl(async (url, options) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push({ url, options, body }); await held.promise; data = snapshot({ bank: body.bank, revision: 2, lastMutation: { requestId: body.requestId, revision: 2 } }); return response({ ok: true }); }
    return response(data);
  });
  await c.refresh(); c.editEntry('hello', 'lines', 'reviewed bank text'); c.getState().bank.entries[0].privateExtra = 'never-forward';
  const first = c.saveBank(); assert.equal(await c.saveBank(), false); assert.equal(posts.length, 1); held.resolve(); assert.equal(await first, true);
  assert.deepEqual(Object.keys(posts[0].body), ['requestId', 'expectedRevision', 'bank']); assert.equal(posts[0].body.expectedRevision, 1); assert.equal(posts[0].url, '/api/director/bank');
  assert.equal(posts[0].options.headers['X-CSRF-Token'], 'fixture-ephemeral-csrf'); assert.doesNotMatch(JSON.stringify(posts[0].body), /never-forward/);
  assert.equal(c.getState().dirty, false); assert.equal(c.getState().baseRevision, 2); assert.match(c.getState().feedback, /No account was started/);
});

test('edits typed during a save survive its acknowledgement and use the acknowledged revision next', async () => {
  let data = snapshot(); const held = deferred();
  const c = ctrl(async (_url, options) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body); await held.promise; data = snapshot({ bank: body.bank, revision: 2, lastMutation: { requestId: body.requestId, revision: 2 } }); return response({ ok: true }); }
    return response(data);
  });
  await c.refresh(); c.editEntry('hello', 'lines', 'submitted edit'); const saving = c.saveBank(); c.editEntry('hello', 'lines', 'newer unsaved edit'); held.resolve(); await saving;
  assert.equal(c.getState().bank.entries[0].lines[0], 'newer unsaved edit'); assert.equal(c.getState().dirty, true); assert.equal(c.getState().baseRevision, 2); assert.equal(c.canSave(), true);
});

test('conflict retains local edits and never automatically repeats the mutation', async () => {
  let posts = 0; const c = ctrl(async (_url, options) => options.method === 'POST' ? (posts++, response({ error: 'revision conflict' }, 409)) : response(snapshot({ revision: posts ? 2 : 1 })));
  await c.refresh(); c.editEntry('hello', 'lines', 'keep me'); assert.equal(await c.saveBank(), false); await c.refresh();
  assert.equal(posts, 1); assert.equal(c.getState().bank.entries[0].lines[0], 'keep me'); assert.equal(c.getState().conflict, true); assert.equal(c.canSave(), false);
});

test('a Mac connection refresh preserves unsaved bank changes and allows explicit Save after fresh status', async () => {
  const posts = []; let token = 'initial-token';
  const c = ctrl(async (_url, options) => {
    if (options.method === 'GET') return response(snapshot({ csrfToken: token }));
    posts.push(options.headers['X-CSRF-Token']); token = 'renewed-token';
    return response({ code: 'controller_refresh_required' }, 409);
  });
  await c.refresh(); c.editEntry('hello', 'lines', 'unsaved edit');
  assert.equal(await c.saveBank(), false);
  assert.deepEqual(posts, ['initial-token']); assert.equal(c.getState().data.csrfToken, 'renewed-token');
  assert.equal(c.getState().conflict, false); assert.equal(c.canSave(), true);
  assert.deepEqual(c.getState().bank.entries[0].lines, ['unsaved edit']);
});

test('a proven save overtaken by a second tab releases the save receipt while preserving newer local work', async () => {
  for (const editing of [false, true]) {
    let data = snapshot(); const held = deferred(), posts = [];
    const c = ctrl(async (_url, options) => {
      if (options.method === 'GET') return response(data);
      const input = JSON.parse(options.body); posts.push(input); await held.promise;
      data = snapshot({ revision: 3, lastMutation: { requestId: 'tab-two', revision: 3 } });
      data.bank.entries[0].lines = ['from tab two'];
      return response({ ok: true, requestId: input.requestId, revision: 2 });
    });
    await c.refresh(); c.editEntry('hello', 'lines', 'first edit'); const saving = c.saveBank();
    if (editing) c.editEntry('hello', 'lines', 'newer edit');
    held.resolve(); await saving;
    assert.equal(posts.length, 1); assert.equal(c.getState().mutation, null);
    assert.equal(c.getState().dirty, editing); assert.equal(c.getState().conflict, editing);
    assert.deepEqual(c.getState().bank.entries[0].lines, [editing ? 'newer edit' : 'from tab two']);
  }
});

test('lost save response reconciles the original request by host mutation identity without retry', async () => {
  let data = snapshot(), posts = 0;
  const c = ctrl(async (_url, options) => { if (options.method === 'POST') { posts++; const body = JSON.parse(options.body); data = snapshot({ bank: body.bank, revision: 2, lastMutation: { requestId: body.requestId, revision: 2 } }); throw Error('transport lost'); } return response(data); });
  await c.refresh(); c.editEntry('hello', 'lines', 'save once'); assert.equal(await c.saveBank(), false); await c.refresh();
  assert.equal(posts, 1); assert.equal(c.getState().mutation, null); assert.equal(c.getState().dirty, false); assert.equal(c.getState().error, '');
});

test('unresolved save stays unconfirmed across refresh and cannot be silently resent', async () => {
  let posts = 0; const c = ctrl(async (_url, options) => { if (options.method === 'POST') { posts++; throw Error('raw private diagnostic'); } return response(snapshot()); });
  await c.refresh(); c.editEntry('hello', 'lines', 'save once'); await c.saveBank(); await c.refresh(); assert.equal(await c.saveBank(), false);
  assert.equal(posts, 1); assert.equal(c.getState().mutation.unknown, true); assert.match(c.getState().error, /will not be sent again/); assert.doesNotMatch(c.getState().error, /private/);
});

test('a superseded mutation acknowledgement can reconcile identical desired saved content without claiming request success', async () => {
  let data = snapshot(), posts = 0;
  const c = ctrl(async (_url, options) => { if (options.method === 'POST') { posts++; const body = JSON.parse(options.body); data = snapshot({ bank: body.bank, revision: 3, lastMutation: { requestId: 'another-request', revision: 3 } }); throw Error('lost'); } return response(data); });
  await c.refresh(); c.editEntry('hello', 'lines', 'saved desired wording'); await c.saveBank();
  assert.equal(posts, 1); assert.equal(c.getState().mutation, null); assert.equal(c.getState().dirty, false); assert.match(c.getState().feedback, /matches your reviewed changes/); assert.doesNotMatch(c.getState().feedback, /Message bank saved/);
});

test('fresh saved-bank reload may abandon an unresolved local save without retrying or deciding its outcome', async () => {
  let data = snapshot(), posts = 0;
  const c = ctrl(async (_url, options) => { if (options.method === 'POST') { posts++; throw Error('lost'); } return response(data); });
  await c.refresh(); c.editEntry('hello', 'lines', 'unsaved local wording'); await c.saveBank(); data = snapshot({ revision: 3, lastMutation: { requestId: 'elsewhere', revision: 3 } }); await c.refresh();
  c.reloadBank(); assert.equal(posts, 1); assert.equal(c.getState().mutation, null); assert.equal(c.getState().dirty, false); assert.equal(c.getState().baseRevision, 3); assert.match(c.getState().feedback, /earlier request outcome is unconfirmed; nothing was retried/);
});

test('native account session commands mirror fresh central preferences and preserve Stop while central status is absent', async () => {
  let profile = { id: 'primary', chatMode: 'participate', replySource: 'ai' }, posts = [];
  const account = { id: 'primary', available: true, authorized: true, connected: false, browser: { online: true, lastSeenAt: new Date(at).toISOString() }, settings: { paused: true, chatMode: 'mentions', replySource: 'local', autoResume: false }, controls: { pending: null, recent: [] } };
  const c = createAccountsController({ now: () => at, profileProvider: () => profile, requestId: () => 'session-request', fetchImpl: async (_url, options) => {
    if (options.method === 'POST') { const body = JSON.parse(options.body); posts.push(body); return response({ ok: true, command: { ...body, state: 'queued', createdAt: at, expiresAt: at + 90000 } }); }
    return response({ updatedAt: new Date(at).toISOString(), csrfToken: 'ephemeral', instances: [account] });
  } });
  await c.refresh(); assert.equal(c.form('primary').replySource, 'ai');
  assert.equal(await c.command('primary', 'settings', { chatMode: 'mentions', replySource: 'local', autoResume: true }), true); assert.deepEqual(posts[0].params, { chatMode: 'participate', replySource: 'ai', autoResume: true });
  profile = null; assert.equal(c.canCommand('primary', 'start'), false); assert.equal(c.canCommand('primary', 'stop'), true);
});

test('a status read predating save cannot supply the confirming revision', async () => {
  let gets = 0, data = snapshot(); const held = deferred();
  const c = ctrl(async (_url, options) => { if (options.method === 'POST') { const body = JSON.parse(options.body); data = snapshot({ bank: body.bank, revision: 2, lastMutation: { requestId: body.requestId, revision: 2 } }); return response({ ok: true }); } if (++gets === 2) return held.promise; return response(data); });
  await c.refresh(); c.editEntry('hello', 'lines', 'new text'); const old = c.refresh(), saving = c.saveBank(); held.resolve(response(snapshot())); await old; await saving;
  assert.equal(gets, 3); assert.equal(c.getState().baseRevision, 2); assert.equal(c.getState().dirty, false);
});

test('only host-proven cancellable plans can be cancelled; unknown cancel is not retried', async () => {
  const plans = [{ planId: 'waiting-plan', cancellable: true, state: 'offered' }, { planId: 'sending-plan', cancellable: false, state: 'submitting' }]; let posts = 0;
  const c = ctrl(async (_url, options) => { if (options.method === 'POST') { posts++; assert.deepEqual(JSON.parse(options.body), { requestId: 'request-1', planId: 'waiting-plan' }); throw Error('lost'); } return response(snapshot({ plans })); });
  await c.refresh(); assert.equal(await c.cancel('sending-plan'), false); assert.equal(await c.cancel('missing'), false); await c.cancel('waiting-plan'); await c.refresh(); assert.equal(await c.cancel('waiting-plan'), false); assert.equal(posts, 1);
});

test('history paging has fixed bounded path and ignores a late page after account filter changes', async () => {
  const held = deferred(), paths = [];
  const c = ctrl(async (url) => { paths.push(url); if (url.includes('/history/all/')) return held.promise;
    if (url.includes('/history/primary/0')) return response({ history: [{ id: 9, accountId: 'primary', at }], nextBeforeId: 9 });
    return response(snapshot({ nextBeforeId: 25 })); }, { basePath: '/admin/stream-companion' });
  await c.refresh(); const old = c.loadHistory(); c.choose('historyAccount', 'primary'); held.resolve(response({ history: [{ id: 20, accountId: 'test', at }], nextBeforeId: 10 })); await old;
  assert.equal(paths[1], '/admin/stream-companion/api/director/history/all/25'); assert.equal(c.getState().older.length, 0); assert.equal(c.getState().historyLoading, false);
  await c.refresh(); assert.equal(c.getState().nextBeforeId, 9, 'global polling cannot replace the selected account cursor');
  assert.deepEqual(historyRows(c.getState(), 'primary').map(row => row.id), [9]);
});

test('live history retains the boundary of an older page while the global head advances', async () => {
  const range = (high, low) => Array.from({ length: high - low + 1 }, (_, index) => ({ id: high - index, accountId: 'third', at: high - index }));
  let high = 100; const held = deferred();
  const c = ctrl(async url => url.includes('/history/') ? held.promise : response(snapshot({ history: range(high, high - 49), nextBeforeId: high - 49 })));
  await c.refresh(); const older = c.loadHistory();
  high++; await c.refresh();
  held.resolve(response({ history: range(50, 1), nextBeforeId: null })); await older;
  high++; await c.refresh();
  assert.deepEqual(historyRows(c.getState()).map(row => row.id), range(102, 1).map(row => row.id));
  high = 220; await c.refresh();
  assert.equal(c.getState().nextBeforeId, 171, 'a disjoint head can fetch the missed interval');
  assert.equal(historyRows(c.getState()).length, 50);
});

test('account detail polls its own latest history even when all 50 global rows belong to another profile', async () => {
  const paths = [], document = doc();
  let delivery = 'pending', offline = false;
  const c = ctrl(async url => {
    paths.push(url);
    if (!url.includes('/history/')) return response(snapshot({ history: Array.from({ length: 50 }, (_, i) => ({ id: 100 - i, accountId: 'test', at })) }));
    if (offline) throw new Error('unreachable');
    return response({ history: [{ id: 3, accountId: 'fourth', at, text: 'older account message', delivery }], nextBeforeId: null });
  }, { historyAccount: 'fourth', basePath: '/admin/stream-companion' });
  await c.refresh(); renderAccountDirector(document, c.getState(), 'fourth', at);
  assert.deepEqual(paths, ['/admin/stream-companion/api/director', '/admin/stream-companion/api/director/history/fourth/0']);
  assert.match(document.getElementById('delivery-history').textContent, /older account message/);
  delivery = 'confirmed'; await c.refresh(); renderAccountDirector(document, c.getState(), 'fourth', at);
  assert.match(document.getElementById('delivery-history').textContent, /Delivery confirmed/);
  offline = true; await c.refresh(); renderAccountDirector(document, c.getState(), 'fourth', at);
  assert.match(document.getElementById('central-message-notice').textContent, /history could not be refreshed/);
  assert.match(document.getElementById('delivery-history').textContent, /older account message/);
});

test('timeline preserves uncertain delivery and imported text-unavailable provenance without fake confirmation', () => {
  const document = doc(), unknown = timelineRow(document, { accountId: 'primary', channel: 'some_channel', source: 'legacy', delivery: 'unknown', text: null, textAvailable: false, at });
  assert.match(unknown.textContent, /Delivery uncertain · no retry/); assert.match(unknown.textContent, /Text unavailable/); assert.match(unknown.textContent, /Imported history/); assert.doesNotMatch(unknown.textContent, /Delivery confirmed/);
  const hostile = '<img src=x onerror=steal()>', row = timelineRow(document, { text: hostile, account: hostile, reason: hostile, delivery: 'pending', at }); assert.ok(row.textContent.includes(hostile)); assert.doesNotMatch(row.textContent, /Delivery confirmed/);
});

test('account details and shared history use identical central rows with newest outcomes winning', () => {
  const document = doc(), data = snapshot({ history: [{ id: 1, accountId: 'primary', account: 'primary_account', text: 'central history', textAvailable: true, delivery: 'unknown', source: 'legacy', at }, { id: 2, accountId: 'test', text: 'other account', delivery: 'confirmed', at }] });
  const state = { data, network: 'online', older: [{ id: 1, accountId: 'primary', text: 'outdated copy', delivery: 'pending', at }], basePath: '' };
  renderAccountDirector(document, state, 'primary', at); assert.equal(historyRows(state, 'primary').length, 1); assert.match(document.getElementById('delivery-history').textContent, /central history/); assert.doesNotMatch(document.getElementById('delivery-history').textContent, /other account|outdated copy|Delivery confirmed/);
  assert.match(accountSummary(data, 'primary'), /Bank replies · 1 enabled message groups/);
});

test('Messages uses protected mount assets, usable labels and external scripts without new posting controls', async () => {
  const html = await readFile(new URL('../public/messages.html', import.meta.url), 'utf8');
  assert.equal(basePathFromModule('https://example.test/admin/stream-companion/messages.js'), '/admin/stream-companion'); assert.equal(basePathFromModule('http://127.0.0.1:8795/messages.js'), '');
  const c = ctrl(async () => response(snapshot())), view = createMessagesView(doc(), c);
  for (const id of Object.keys(view.nodes)) assert.ok(html.includes(`id="${id}"`), id);
  assert.ok(!/<script(?![^>]*\bsrc=)|\son\w+=|\sstyle=|https?:\/\//.test(html)); assert.match(html, /Saving never starts an account/); assert.doesNotMatch(html, /Send now|Retry message|Clear history|force-send/);
  await c.refresh(); renderMessages(view, c.getState(), c, at); assert.match(visible(view), /Waiting for imported history/); assert.doesNotMatch(visible(view), /fixture-ephemeral-csrf/);
});
