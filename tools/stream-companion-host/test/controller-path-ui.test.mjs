import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createController, createView, renderHost } from '../public/app.js';
import { createAccountsController, createAccountsView, renderAccounts, accountFromPath } from '../public/accounts.js';
import { REMOTE_BASE_PATH as basePath, controllerBasePath, basePathFromModule, controllerPath, configureControllerMount, bindControllerLifecycle } from '../public/controller-path.js';

const now = Date.parse('2026-11-25T07:00:00Z');
const host = () => ({ updatedAt: new Date(now).toISOString(), paused: true, host: { health: 'ready' }, clients: [], channels: [], events: [], csrfToken: 'private-session-csrf' });
const account = () => ({ updatedAt: new Date(now).toISOString(), csrfToken: 'private-session-csrf', instances: [{ id: 'primary', name: 'Main companion', available: true, authorized: true, connected: true, account: 'companion_account', channel: 'some_channel', settings: { allowedChannel: 'some_channel', paused: false, chatMode: 'mentions', replySource: 'local', autoResume: false }, browser: { online: true, lastSeenAt: new Date(now).toISOString() }, permissions: { playbackAccess: true }, watch: { status: 'playing', checkedAt: now }, controls: { pending: null, recent: [] } }] });
const response = data => ({ ok: true, status: 200, json: async () => structuredClone(data) });
const denied = status => ({ ok: false, status, json: () => { throw Error('Do not parse raw server diagnostics'); } });
const atNow = { now: () => now };
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; this.hidden = false; this.value = ''; }
  set innerHTML(_) { throw Error('Dynamic HTML forbidden'); }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}
function documentStub() { const nodes = new Map(); return { getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: tag => new Node(tag) }; }
const descend = node => [node, ...node.children.flatMap(descend)];
function events() {
  const listeners = new Map();
  return { hidden: false, addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); }, fire(name) { for (const fn of listeners.get(name) || []) fn(); } };
}
function intervals() {
  let id = 0; const running = new Map();
  return { running, setIntervalImpl(fn) { const key = id++; running.set(key, fn); return key; }, clearIntervalImpl(key) { running.delete(key); } };
}

test('HTTP module paths derive only the local root or fixed trusted mount', () => {
  for (const name of ['app', 'accounts', 'controller-path']) {
    assert.equal(basePathFromModule(`http://127.0.0.1:8795/${name}.js`), '');
    assert.equal(basePathFromModule(`https://server.example${basePath}/${name}.js`), basePath);
  }
  assert.equal(basePathFromModule('file:///test/public/app.js'), '');
  for (const value of ['/other', `${basePath}/`, '//other.test', `${basePath}/../other`]) assert.throws(() => controllerBasePath(value));
  assert.throws(() => basePathFromModule('https://server.example/not-the-controller/app.js'));
  for (const path of ['//other.test', '/accounts?token=private', '/accounts/../api', '/%2fapi', '/accounts\\test']) assert.throws(() => controllerPath(basePath, path));
  assert.equal(controllerPath('', '/api/accounts'), '/api/accounts'); assert.equal(controllerPath(basePath, '/api/accounts'), `${basePath}/api/accounts`);
});

test('account parsing and generated links stay beneath the selected mount', async () => {
  assert.equal(accountFromPath(`${basePath}/accounts/test`, basePath), 'test');
  assert.equal(accountFromPath(`${basePath}/accounts/primary`, basePath), 'primary');
  assert.equal(accountFromPath(`${basePath}/accounts/third`, basePath), 'third');
  assert.equal(accountFromPath(`${basePath}/accounts/fourth`, basePath), 'fourth');
  assert.equal(accountFromPath(`${basePath}/accounts/fifth`, basePath), null);
  for (const path of ['/accounts/test', '/admin/stream-companion-other/accounts/test', `${basePath}/accounts/%74est`, `${basePath}/accounts/test/anything`]) assert.equal(accountFromPath(path, basePath), null);
  const controller = createAccountsController({ ...atNow, basePath, fetchImpl: async () => response(account()) }); await controller.refresh();
  const v = createAccountsView(documentStub()); renderAccounts(v, controller.getState(), { now });
  const links = descend(v.nodes['account-cards']).filter(node => node.tagName === 'a').map(node => node.attributes.href);
  assert.deepEqual(links, [`${basePath}/accounts/primary`, `${basePath}/accounts/test`, `${basePath}/accounts/third`, `${basePath}/accounts/fourth`]);
});

test('both controller factories use same-origin session credentials and prefixed exact APIs', async () => {
  for (const prefix of ['', basePath]) {
    let paused = true; const calls = [];
    const c = createController({ ...atNow, basePath: prefix, fetchImpl: async (path, options) => {
      calls.push({ path, options });
      if (options.method === 'POST') { paused = JSON.parse(options.body).paused; return response({ ok: true }); }
      return response({ ...host(), paused });
    } });
    await c.refresh(); await c.toggle();
    assert.ok(calls.every(call => call.options.credentials === 'same-origin'));
    assert.deepEqual([...new Set(calls.map(call => call.path))], [`${prefix}/api/status`, `${prefix}/api/control`]);
    assert.equal(calls.find(call => call.options.method === 'POST').options.headers['X-CSRF-Token'], 'private-session-csrf');
    const accountCalls = [];
    const a = createAccountsController({ ...atNow, basePath: prefix, requestId: () => 'opaque-request', fetchImpl: async (path, options) => {
      accountCalls.push({ path, options });
      if (options.method === 'POST') return response({ ok: true, command: { ...JSON.parse(options.body), state: 'queued', createdAt: now, expiresAt: now + 90000 } });
      return response(account());
    } });
    await a.refresh(); await a.command('primary', 'stop');
    assert.ok(accountCalls.every(call => call.options.credentials === 'same-origin'));
    assert.deepEqual([...new Set(accountCalls.map(call => call.path))], [`${prefix}/api/accounts`, `${prefix}/api/accounts/primary/command`]);
  }
});

test('401, 403 and Mac503 have different visible states while preserving old data and disabling controls', async () => {
  for (const [status, network, expected] of [[401, 'unauthenticated', 'Sign-in required'], [403, 'forbidden', 'Access or 2FA required'], [503, 'offline', 'Mac unavailable']]) {
    let fail = false;
    const c = createController({ ...atNow, basePath, fetchImpl: async () => fail ? denied(status) : response(host()) });
    const a = createAccountsController({ ...atNow, basePath, fetchImpl: async () => fail ? denied(status) : response(account()) });
    await c.refresh(); await a.refresh(); fail = true; await c.refresh(); await a.refresh();
    const hv = createView(documentStub()), av = createAccountsView(documentStub());
    renderHost(hv, c.getState(), now); renderAccounts(av, a.getState(), { id: 'primary', now, canCommand: a.canCommand });
    assert.equal(c.getState().network, network); assert.equal(a.getState().network, network); assert.ok(c.getState().data); assert.ok(a.getState().data);
    assert.equal(hv.nodes['host-status'].textContent, expected); assert.equal(av.nodes['network-status'].textContent, expected);
    assert.equal(hv.nodes['coordination-toggle'].disabled, true); assert.equal(av.nodes.stop.disabled, true);
    assert.equal(hv.nodes['access-actions'].hidden, status === 503); assert.equal(av.nodes['access-actions'].hidden, status === 503);
    const visible = [...Object.values(hv.nodes), ...Object.values(av.nodes)].map(node => node.textContent).join('');
    assert.ok(!visible.includes('private-session-csrf')); assert.ok(!visible.includes('raw server diagnostics'));
    assert.match(av.nodes['connection-notice'].textContent, status === 401 ? /Sign in/ : status === 403 ? /two-factor/ : /Mac.*unreachable/);
  }
});

test('page restoration restarts only GET polling and never repeats an unconfirmed account send', async () => {
  const timers = intervals(), window = events(), document = events(), calls = [];
  const c = createAccountsController({ ...atNow, ...timers, basePath, requestId: () => 'send-once', fetchImpl: async (path, options) => {
    calls.push({ path, options }); if (options.method === 'POST') throw Error('ambiguous timeout'); return response(account());
  } });
  const unbind = bindControllerLifecycle(c, { window, document });
  c.start(); await c.refresh(); await c.command('primary', 'send', { text: 'reviewed message' });
  for (let cycle = 0; cycle < 2; cycle++) {
    window.fire('pagehide'); assert.equal(timers.running.size, 0);
    window.fire('pageshow'); await c.refresh(); assert.equal(timers.running.size, 1);
    document.fire('visibilitychange'); await c.refresh();
  }
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1);
  assert.equal(c.getState().operations.primary.command.state, 'unknown'); assert.equal(c.canCommand('primary', 'send'), false);
  assert.ok(calls.filter(call => call.options.method === 'GET').length >= 4);
  c.stop(); unbind(); window.fire('pageshow'); assert.equal(timers.running.size, 0);
});

test('coordination page restoration refreshes without replaying a timed-out mutation', async () => {
  const timers = intervals(), window = events(), document = events(); let posts = 0, gets = 0;
  const c = createController({ ...atNow, ...timers, basePath, fetchImpl: async (path, options) => {
    if (options.method === 'POST') { posts++; throw Error('unconfirmed transport'); } gets++; return response(host());
  } });
  bindControllerLifecycle(c, { window, document }); c.start(); await c.refresh(); await c.toggle();
  window.fire('pagehide'); assert.equal(timers.running.size, 0); window.fire('pageshow'); await c.refresh();
  assert.equal(timers.running.size, 1); assert.equal(posts, 1); assert.ok(gets >= 3); assert.ok(c.getState().controlError); c.stop();
});

test('authentication failures during POST do not clear uncertain outcomes or retry after restored sign-in', async () => {
  for (const status of [401, 403]) {
    let posts = 0;
    const c = createAccountsController({ ...atNow, basePath, requestId: () => 'auth-crossing-send', fetchImpl: async (path, options) => {
      if (options.method === 'POST') { posts++; return denied(status); } return response(account());
    } });
    await c.refresh(); assert.equal(await c.command('primary', 'send', { text: 'reviewed message' }), false);
    await c.refresh(); assert.equal(posts, 1); assert.equal(c.getState().operations.primary.command.state, 'unknown'); assert.equal(c.canCommand('primary', 'send'), false);
    assert.match(c.getState().error, status === 401 ? /session has ended/ : /access is blocked/);
  }
});

test('HTML uses trusted mount placeholders and Back to server is shown only in remote mode', async () => {
  for (const name of ['account.html', 'index.html']) {
    const html = await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
    assert.ok(html.includes('__COMPANION_BASE__/')); assert.match(html, /id="back-to-server" href="\/superadmin.html" hidden/);
    assert.ok(!/<base\b|\son\w+=|\sstyle=|<script(?![^>]*\bsrc=)/.test(html));
    for (const prefix of ['', basePath]) {
      const rendered = html.replaceAll('__COMPANION_BASE__', prefix);
      assert.ok(!rendered.includes('__COMPANION_BASE__'));
      const assets = [...rendered.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]);
      assert.ok(assets.length >= 2); assert.ok(assets.every(path => path.startsWith(`${prefix}/`)));
    }
  }
  const doc = documentStub(), back = doc.getElementById('back-to-server');
  configureControllerMount(doc, ''); assert.equal(back.hidden, true); configureControllerMount(doc, basePath); assert.equal(back.hidden, false);
  const css = await readFile(new URL('../public/accounts.css', import.meta.url), 'utf8');
  assert.match(css, /input, select, textarea\s*\{\s*font-size:\s*16px;/);
});
