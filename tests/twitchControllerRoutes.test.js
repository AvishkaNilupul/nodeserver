const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const { existsSync, readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

const BASE = '/admin/stream-companion';
const ORIGIN = 'https://controller.example';
const REMOTE_TOKEN = 'gateway-remote-pairing-fixture-token-123456';
const UPSTREAM_TOKEN = 'fixture-private-upstream-csrf-token';
const settingsPath = require.resolve('../utils/settings');
const originalSettings = require.cache[settingsPath];
let requireTwoFa = false;
// Exercise the deployed auth middleware without loading settings, credentials,
// MongoDB or the production app/startup workers.
require.cache[settingsPath] = { id: settingsPath, filename: settingsPath, loaded: true,
  exports: { getRequire2fa: () => requireTwoFa } };
test.after(() => {
  if (originalSettings) require.cache[settingsPath] = originalSettings;
  else delete require.cache[settingsPath];
});

function respond(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return server.address().port;
}
async function close(server) {
  server.closeAllConnections?.();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}
function request(port, path, { method = 'GET', body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = raw === undefined ? body === undefined ? undefined : JSON.stringify(body) : raw;
    const req = http.request({ hostname: '127.0.0.1', port, path, method, agent: false,
      headers: { Accept: 'application/json', ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', x => chunks.push(x));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data; try { data = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, data });
      });
    });
    req.setTimeout(2000, () => req.destroy(new Error('Ephemeral test HTTP request timed out.')));
    req.on('error', reject); req.end(payload);
  });
}
async function fixture(t, options = {}) {
  const seen = []; let upstreamHandler = options.upstream;
  const upstream = options.upstreamServer || http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8'); let body; try { body = JSON.parse(text); } catch {}
    const record = { method: req.method, path: req.url, headers: { ...req.headers }, text, body }; seen.push(record);
    if (upstreamHandler) return upstreamHandler(record, res);
    if (req.url.endsWith('/api/status')) return respond(res, 200, { updatedAt: new Date().toISOString(), paused: true, csrfToken: UPSTREAM_TOKEN });
    if (req.url.endsWith('/api/clips')) return respond(res, 200, { ok: true, settings: { enabled: false, channel: 'aviskarex', accountIds: ['primary'] }, accounts: [], jobs: [], csrfToken: UPSTREAM_TOKEN });
    if (req.url.endsWith('/api/accounts')) return respond(res, 200, { updatedAt: new Date().toISOString(), instances: [], csrfToken: UPSTREAM_TOKEN });
    if (/\/api\/channels(?:\/[a-z0-9_]{3,25})?$/.test(req.url)) return respond(res, 200, { updatedAt: new Date().toISOString(), channels: [{ login: req.url.split('/').at(-1) === 'channels' ? 'aviskarex' : req.url.split('/').at(-1), isLive: true }], csrfToken: UPSTREAM_TOKEN });
    if (/\/api\/accounts\/(primary|test)\/browser$/.test(req.url)) return respond(res, 200, { ok: true, state: 'opening' });
    if (req.method === 'POST') return respond(res, 200, { ok: true, command: { id: 'fixture-command', state: 'queued' } });
    return respond(res, 200, '<!doctype html><html lang="en"><head><title>Fixture controller</title></head><body><main id="main">Fixture content</main></body></html>', { 'Content-Type': req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  const upstreamPort = await listen(upstream);
  const app = express();
  const controller = require('../routes/twitchControllerRoutes');
  app.use(BASE, controller.bodyParser);
  app.use(express.json({ limit: '100kb' }));
  app.use(session({ secret: 'ephemeral-test-session-secret-only', resave: false, saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'strict' } }));
  app.post('/__fixture/session', (req, res) => {
    req.session.admin = { id: randomUUID(), role: req.body.role || 'superadmin', tfa: req.body.tfa !== false };
    res.json({ ok: true });
  });
  app.use(BASE, controller.createRouter({ publicOrigin: ORIGIN, remoteToken: REMOTE_TOKEN, upstreamPort,
    timeoutMs: options.timeoutMs || 500, ...(options.router || {}) }));
  app.use((_req, res) => res.status(404).json({ error: 'Fixture route not found.' }));
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: 'Fixture request rejected.' }));
  const gateway = http.createServer(app), port = await listen(gateway);
  t.after(async () => { requireTwoFa = false; await close(gateway); await close(upstream); });
  async function client(role = 'superadmin', tfa = true) {
    const login = await request(port, '/__fixture/session', { method: 'POST', body: { role, tfa } });
    const cookie = login.headers['set-cookie'].map(x => x.split(';')[0]).join('; ');
    return {
      cookie,
      request(path, options = {}) { return request(port, BASE + path, { ...options,
        headers: { Cookie: cookie, Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', ...(options.headers || {}) } }); }
    };
  }
  return { port, upstream, upstreamPort, seen, client, setHandler(fn) { upstreamHandler = fn; } };
}
async function nonce(client, path = '/api/status') {
  const response = await client.request(path);
  assert.equal(response.status, 200, response.text);
  assert.equal(typeof response.data.csrfToken, 'string');
  assert.notEqual(response.data.csrfToken, UPSTREAM_TOKEN);
  return response.data.csrfToken;
}
function command(action, params = {}) { return { requestId: randomUUID(), action, params }; }
function post(client, path, body, csrf, headers = {}) {
  return client.request(path, { method: 'POST', body, headers: { 'X-CSRF-Token': csrf, ...headers } });
}

test('every page, asset and API uses the real superadmin and two-factor guards before reaching the Mac', async t => {
  const f = await fixture(t);
  for (const path of ['/accounts', '/accounts/fourth', '/accounts.js', '/api/status', '/api/accounts', '/api/channels', '/api/channels/aviskarex', '/api/accounts/primary/browser', '/api/accounts/fourth/browser', '/api/accounts/fourth/command', '/clips.js', '/clips.css', '/api/clips', '/api/clips/create', '/api/clips/settings', '/api/clips/authorization', '/messages', '/messages.js', '/messages.css', '/api/director', '/api/director/history/all/0', '/api/director/history/fourth/0', '/api/director/bank', '/api/director/cancel']) {
    assert.equal((await request(f.port, BASE + path)).status, 401);
    const normal = await f.client('admin'); assert.equal((await normal.request(path)).status, 403);
  }
  const html = await request(f.port, BASE + '/accounts', { headers: { Accept: 'text/html' } });
  assert.equal(html.status, 302); assert.match(html.headers.location, /^\/admin-login\.html\?next=/);
  requireTwoFa = true;
  const unenrolled = await f.client('superadmin', false);
  for (const path of ['/accounts', '/accounts.css', '/api/status']) {
    const response = await unenrolled.request(path); assert.equal(response.status, 403);
    assert.equal(response.data.code, 'enroll_2fa');
  }
  assert.equal(f.seen.length, 0);
  const enrolled = await f.client(); assert.equal((await enrolled.request('/api/status')).status, 200);
});

test('central messages use bounded fixed reads and exact single-forward bank/cancel mutations', async t => {
  const f = await fixture(t, { upstream: (req, res) => {
    if (req.method === 'POST') return respond(res, 200, { ok: true, revision: 2 });
    if (req.path.endsWith('.js')) return respond(res, 200, 'export const fixture = true;', { 'Content-Type': 'text/javascript' });
    if (req.path.endsWith('.css')) return respond(res, 200, 'body {}', { 'Content-Type': 'text/css' });
    if (req.path.includes('/api/director')) return respond(res, 200, { protocol: 1, ready: false, bank: {}, history: [], csrfToken: UPSTREAM_TOKEN });
    return respond(res, 200, '<!doctype html><html><head><title>Messages</title></head><body><main>Messages</main></body></html>');
  } }), c = await f.client(), csrf = await nonce(c, '/api/director');
  for (const path of ['/messages', '/messages.js', '/messages.css', '/api/director/history/all/0', '/api/director/history/primary/9007199254740991', '/api/director/history/test/23', '/api/director/history/third/5']) {
    const response = await c.request(path); assert.equal(response.status, 200, path);
    assert.equal(f.seen.at(-1).path, BASE + path);
    if (path.includes('/api/')) assert.equal(response.data.csrfToken, csrf);
  }
  const bank = { entries: [{ id: 'topic_general', kind: 'topic', category: 'general', lines: ['Enjoying {game}.'], accountIds: ['primary', 'third'], enabled: true }],
    profiles: ['primary', 'test', 'third', 'fourth'].map(id => ({ id, chatMode: 'mentions', replySource: 'local' })) };
  for (const [path, body] of [
    ['/api/director/bank', { requestId: 'bank-save-1', expectedRevision: 1, bank }],
    ['/api/director/cancel', { requestId: 'cancel-1', planId: 'plan-1' }]
  ]) {
    const before = f.seen.length;
    assert.equal((await c.request(path)).status, 405);
    assert.equal((await post(c, path, body, 'wrong')).status, 403);
    assert.equal((await post(c, path, body, csrf, { Origin: 'https://outside.example' })).status, 403);
    assert.equal(f.seen.length, before);
    assert.equal((await post(c, path, body, csrf)).status, 200);
    assert.equal(f.seen.length, before + 1);
    assert.deepEqual(f.seen.at(-1).body, body);
  }
  const before = f.seen.length;
  const save = changes => ({ requestId: 'invalid-save', expectedRevision: 1, bank: { ...bank, ...changes } });
  const entry = bank.entries[0];
  for (const body of [
    { ...save({}), expectedRevision: 0 }, { ...save({}), expectedRevision: 1.5 },
    { ...save({}), authorityEpoch: 'client-selected' }, save({ profiles: bank.profiles.slice(0, 2) }),
    save({ profiles: [bank.profiles[0], bank.profiles[0], bank.profiles[2]] }),
    save({ entries: [{ ...entry, accountIds: ['primary', 'primary'] }] }), save({ entries: [{ ...entry, kind: 'force' }] }),
    save({ entries: [{ ...entry, category: 'foreign' }] }), save({ entries: [{ ...entry, lines: ['hello\nthere'] }] }),
    save({ entries: [{ ...entry, lines: ['/ban somebody'] }] }), save({ entries: [{ ...entry, lines: ['https://outside.example'] }] }),
    save({ entries: [{ ...entry, lines: ['{arbitrary}'] }] }), save({ entries: [{ ...entry, lines: ['x'.repeat(261)] }] }),
    save({ entries: [{ ...entry, id: '' }] }), save({ entries: [{ ...entry, expiresAt: 1 }] }),
    save({ entries: Array.from({ length: 96 }, (_, i) => ({ ...entry, id: 'entry_' + i, lines: ['é'.repeat(260)] })) })
  ]) assert.equal((await post(c, '/api/director/bank', body, csrf)).status, 400, JSON.stringify(body).slice(0, 160));
  for (const body of [{ requestId: 'x', planId: '' }, { requestId: 'x', planId: 'p', retry: true }])
    assert.equal((await post(c, '/api/director/cancel', body, csrf)).status, 400);
  for (const path of ['/api/director/history/all/9007199254740992', '/api/director/history/foreign/0', '/api/director/history/all/-1', '/api/director/history/all/1.5',
    '/api/director/history/all/0?limit=1000', '/api/director/history/all/0/', '/api/director/history/all/%30', '/api/director/retry', '/internal/director/import'])
    assert.equal((await c.request(path)).status, 404, path);
  assert.equal(f.seen.length, before, 'rejected inputs cannot contact the Mac');
});

test('an interrupted central bank save remains unconfirmed and is never replayed', async t => {
  const f = await fixture(t), c = await f.client(), csrf = await nonce(c);
  f.setHandler((_req, res) => res.destroy());
  const response = await post(c, '/api/director/cancel', { requestId: 'cancel-once', planId: 'plan-once' }, csrf);
  assert.equal(response.status, 503); assert.equal(response.data.code, 'command_unconfirmed');
  assert.equal(f.seen.filter(x => x.method === 'POST').length, 1);
});

test('real Mac director bank edits survive the protected site gateway without activating profiles', async t => {
  const { HostStore } = await import(pathToFileURL(resolve(__dirname, '../tools/stream-companion-host/lib/store.mjs')));
  const { createHostServer } = await import(pathToFileURL(resolve(__dirname, '../tools/stream-companion-host/server.mjs')));
  const clients = ['primary', 'test', 'third'].map((id, index) => ({ id, account: `fixture_account_${index}`, token: `fixture-client-token-${id}-1234567890123456789` }));
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true }); t.after(() => store.close());
  const accounts = { snapshot: async () => ({ instances: [] }), command: async () => { throw Error('No account control is allowed in this bank test.'); } };
  const upstream = createHostServer({ store, clients, accounts, remoteToken: REMOTE_TOKEN, csrfToken: UPSTREAM_TOKEN });
  const f = await fixture(t, { upstreamServer: upstream }), c = await f.client();
  const before = await c.request('/api/director');
  assert.equal(before.status, 200); assert.equal(before.data.ready, false);
  assert.equal(before.data.imports.length, 3); assert.ok(before.data.imports.every(x => !x.complete));
  const bank = structuredClone(before.data.bank); bank.entries[0].lines = ['A revised greeting.'];
  const body = { requestId: 'real-bank-save', expectedRevision: before.data.revision, bank };
  const saved = await post(c, '/api/director/bank', body, before.data.csrfToken);
  assert.equal(saved.status, 200); assert.equal(saved.data.revision, before.data.revision + 1);
  const repeat = await post(c, '/api/director/bank', body, before.data.csrfToken);
  assert.equal(repeat.status, 200); assert.deepEqual(repeat.data, saved.data);
  const changed = await post(c, '/api/director/bank', { ...body, bank: { ...bank, entries: bank.entries.slice(1) } }, before.data.csrfToken);
  assert.equal(changed.status, 409);
  const stale = await post(c, '/api/director/bank', { ...body, requestId: 'stale-save' }, before.data.csrfToken);
  assert.equal(stale.status, 409);
  const after = await c.request('/api/director');
  assert.equal(after.data.revision, saved.data.revision);
  assert.deepEqual(after.data.bank.entries[0].lines, ['A revised greeting.']);
  assert.deepEqual(after.data.lastMutation, { requestId: body.requestId, revision: saved.data.revision });
  assert.deepEqual(after.data.plans, []); assert.deepEqual(after.data.history, []); assert.equal(after.data.ready, false);
  assert.doesNotMatch(after.text, /authorityEpoch|binding|controlSession|fixture-client-token|fixture-private-upstream/);
  for (const path of ['/messages', '/messages.js', '/messages.css']) assert.equal((await c.request(path)).status, 200);
  const history = await c.request('/api/director/history/third/0'); assert.equal(history.status, 200); assert.deepEqual(history.data.history, []);
});

test('each finite GET route reaches only its prefixed fixed upstream and pages include site navigation', async t => {
  const f = await fixture(t), c = await f.client();
  const routes = ['/', '/accounts', '/accounts/primary', '/accounts/test', '/app.js', '/style.css', '/accounts.js', '/accounts.css', '/controller-path.js', '/api/status', '/api/accounts', '/api/channels', '/api/channels/aviskarex'];
  for (const path of routes) assert.equal((await c.request(path)).status, 200, path);
  assert.deepEqual(f.seen.map(x => x.path), routes.map(x => BASE + x));
  assert.ok(f.seen.every(x => x.headers.host === '127.0.0.1:8795' && x.headers.authorization === `Bearer ${REMOTE_TOKEN}`));
  const page = await c.request('/accounts');
  assert.match(page.text, /<main id="main">Fixture content<\/main>/);
  assert.match(page.text, /class="nav"/);
  assert.match(page.text, /src="\/admin-nav\.js/);
});

test('the gateway gives each authenticated session its own nonce and never exposes the private upstream CSRF', async t => {
  const f = await fixture(t), a = await f.client(), b = await f.client();
  const aNonce = await nonce(a), bNonce = await nonce(b, '/api/accounts');
  assert.notEqual(aNonce, bNonce); assert.ok(aNonce.length >= 32);
  const again = await a.request('/api/accounts'); assert.equal(again.data.csrfToken, aNonce);
  assert.doesNotMatch(again.text, new RegExp(UPSTREAM_TOKEN));
  const before = f.seen.length;
  assert.equal((await post(b, '/api/control', { paused: true }, aNonce)).status, 403);
  assert.equal((await post(a, '/api/control', { paused: true }, bNonce)).status, 403);
  assert.equal(f.seen.length, before);
  assert.equal((await post(a, '/api/control', { paused: true }, aNonce)).status, 200);
  assert.equal(f.seen.at(-1).headers['x-csrf-token'], UPSTREAM_TOKEN);
  assert.notEqual(f.seen.at(-1).headers['x-csrf-token'], aNonce);
});

test('site navigation uses fresh document style nonces while preserving the controller policy and body', async t => {
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/admin/stream-companion/accounts.css"><script type="module" src="/admin/stream-companion/accounts.js"></script></head><body><main id="main"><button id="stop" disabled>Stop</button></main></body></html>';
  const f = await fixture(t, { upstream: (_req, res) => respond(res, 200, html, { 'Content-Security-Policy': csp }) });
  const c = await f.client(), nonces = new Set();
  for (const path of ['/', '/accounts', '/accounts/primary', '/accounts/test']) {
    const page = await c.request(path);
    assert.equal(page.status, 200);
    const policy = page.headers['content-security-policy'];
    const token = /style-src 'self' 'nonce-([A-Za-z0-9+/=_-]+)'/.exec(policy)?.[1];
    assert.ok(token, policy); assert.ok(!nonces.has(token)); nonces.add(token);
    assert.match(page.text, new RegExp('nonce="' + token.replace(/[+]/g, '\\+') + '"'));
    for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) assert.ok(policy.includes(directive));
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
    assert.match(page.text, /<main id="main"><button id="stop" disabled>Stop<\/button><\/main>/);
    assert.ok(page.text.indexOf('/admin-nav.css') > page.text.indexOf('/twitch-controller-shell.css'));
    assert.doesNotMatch(page.text, /<iframe|<base|\sonclick=|\sstyle=/i);
    assert.doesNotMatch(page.text, new RegExp(REMOTE_TOKEN + '|' + UPSTREAM_TOKEN));
  }
});

test('Origin, same-origin metadata and session nonce are all required before a mutation contacts upstream', async t => {
  const f = await fixture(t), c = await f.client(), token = await nonce(c), before = f.seen.length;
  const invalid = [
    { Origin: 'https://evil.example' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': '' }, { 'X-CSRF-Token': 'wrong' }, { 'X-CSRF-Token': '' }
  ];
  for (const headers of invalid) assert.equal((await post(c, '/api/control', { paused: true }, token, headers)).status, 403, JSON.stringify(headers));
  assert.equal(f.seen.length, before);
  const uninitialized = await f.client();
  assert.equal((await post(uninitialized, '/api/control', { paused: true }, token)).status, 403);
  assert.equal(f.seen.length, before);
});

test('status reads reject foreign origins and permit originless same-origin fetches', async t => {
  const f = await fixture(t), c = await f.client();
  assert.equal((await c.request('/api/status', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await c.request('/api/status', { headers: { Origin: '', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal(f.seen.length, 0);
  assert.equal((await c.request('/api/status', { headers: { Origin: '' } })).status, 200);
});

test('outside cookies, Authorization and arbitrary forwarding headers never reach the Mac', async t => {
  const f = await fixture(t), c = await f.client();
  await c.request('/api/status', { headers: { Cookie: `${c.cookie}; outside-secret=COOKIE_SENTINEL`, Authorization: 'Bearer BROWSER_AUTH_SENTINEL',
    'X-Forwarded-For': '198.51.100.77', 'X-Forwarded-Host': 'outside.example', 'X-Forwarded-Proto': 'http',
    'X-Remote-Token': 'UNTRUSTED_PAIRING_SENTINEL', 'X-Arbitrary': 'HEADER_SENTINEL' } });
  const forwarded = f.seen[0];
  assert.equal(forwarded.headers.authorization, `Bearer ${REMOTE_TOKEN}`);
  assert.equal(forwarded.headers.host, '127.0.0.1:8795'); assert.equal(forwarded.headers.origin, 'http://127.0.0.1:8795');
  assert.equal(forwarded.headers['sec-fetch-site'], 'same-origin');
  const text = JSON.stringify(forwarded);
  for (const secret of ['COOKIE_SENTINEL', 'BROWSER_AUTH_SENTINEL', '198.51.100.77', 'outside.example', 'UNTRUSTED_PAIRING_SENTINEL', 'HEADER_SENTINEL']) assert.ok(!text.includes(secret), secret);
  assert.equal(forwarded.headers.cookie, undefined);
});

test('raw route, traversal, query, extra slash, method and upgrade attempts are denied without proxying', async t => {
  const f = await fixture(t), c = await f.client();
  for (const path of ['/api/status?x=1', '//api/status', '/api//status', '/api/%73tatus', '/%2e%2e/api/status', '/api/%2fstatus', '/api/status/',
    '/health', '/internal/sync', '/private/remote.json', '/api/accounts/unknown/command', '/api/accounts/primary/command/foo',
    '/api/channels/ab', '/api/channels/aviskarex/extra', '/api/channels/aviskarex/', '/api/channels/%61viskarex', '/api/channels/aviskarex?x=1']) {
    const response = await c.request(path); assert.ok(response.status >= 400, `${path}: ${response.status}`);
  }
  for (const method of ['HEAD', 'PUT', 'DELETE', 'OPTIONS']) assert.ok((await c.request('/api/status', { method })).status >= 400, method);
  assert.ok((await c.request('/api/status', { headers: { Upgrade: 'websocket' } })).status >= 400);
  assert.equal(f.seen.length, 0);
});

test('live channel reads share session CSRF masking and cannot mutate account state', async t => {
  const f = await fixture(t), c = await f.client();
  const token = await nonce(c);
  for (const path of ['/api/channels', '/api/channels/live_friend']) {
    const response = await c.request(path);
    assert.equal(response.status, 200); assert.equal(response.data.csrfToken, token);
    assert.doesNotMatch(response.text, new RegExp(UPSTREAM_TOKEN + '|' + REMOTE_TOKEN));
    const before = f.seen.length;
    assert.equal((await c.request(path, { method: 'POST', body: {} })).status, 405);
    assert.equal(f.seen.length, before);
    assert.equal((await c.request(path, { headers: { Origin: 'https://foreign.example' } })).status, 403);
    assert.equal(f.seen.length, before);
  }
  assert.ok(f.seen.every(x => x.method === 'GET'));
});

test('browser opening is a bounded explicit CSRF mutation with no client-selected executable, profile or URL', async t => {
  const f = await fixture(t), c = await f.client(), token = await nonce(c);
  for (const id of ['primary', 'test']) {
    const path = `/api/accounts/${id}/browser`, before = f.seen.length;
    assert.equal((await c.request(path)).status, 405);
    assert.equal((await post(c, path, { requestId: 'open-fixed-profile' }, token, { Origin: 'https://outside.example' })).status, 403);
    assert.equal((await post(c, path, { requestId: 'open-fixed-profile' }, 'wrong')).status, 403);
    for (const body of [{}, { requestId: '../unsafe' }, { requestId: 'x', profile: 'Default' }, { requestId: 'x', url: 'https://outside.example' }, { requestId: 'x', args: ['--remote-debugging-port=9222'] }]) assert.equal((await post(c, path, body, token)).status, 400);
    assert.equal(f.seen.length, before);
    const result = await post(c, path, { requestId: 'open-fixed-profile' }, token);
    assert.equal(result.status, 200); assert.deepEqual(result.data, { ok: true, state: 'opening' });
    assert.deepEqual(f.seen.at(-1).body, { requestId: 'open-fixed-profile' });
    assert.equal(f.seen.at(-1).path, BASE + path);
    assert.equal(f.seen.at(-1).headers['x-csrf-token'], UPSTREAM_TOKEN);
  }
  for (const path of ['/api/accounts/foreign/browser', '/api/accounts/primary/browser/', '/api/accounts/primary/browser?x=1']) assert.equal((await post(c, path, { requestId: 'x' }, token)).status, 404);
});

test('only exact one-key boolean controls and typed account commands are forwarded unchanged once', async t => {
  const f = await fixture(t), c = await f.client(), token = await nonce(c);
  const valid = [
    ['/api/control', { paused: true }], ['/api/control', { exchangesEnabled: false }],
    ['/api/accounts/primary/command', command('start', { channel: 'sample_channel', chatMode: 'participate', replySource: 'ai', autoResume: true })],
    ['/api/accounts/test/command', command('stop')], ['/api/accounts/test/command', command('watch')],
    ['/api/accounts/primary/command', command('settings', { chatMode: 'mentions', replySource: 'local', autoResume: false })],
    ['/api/accounts/primary/command', command('draft', { mode: 'reply' })], ['/api/accounts/primary/command', command('draft', { mode: 'summary' })],
    ['/api/accounts/primary/command', command('send', { text: 'an explicitly reviewed fixture message' })],
    ['/api/accounts/test/command', command('drops-enable')], ['/api/accounts/test/command', command('drops-disable')], ['/api/accounts/test/command', command('drops-check')]
  ];
  for (const [path, body] of valid) {
    const before = f.seen.length, response = await post(c, path, body, token);
    assert.equal(response.status, 200, JSON.stringify(body)); assert.equal(f.seen.length, before + 1);
    assert.equal(f.seen.at(-1).path, BASE + path); assert.deepEqual(f.seen.at(-1).body, body);
    assert.equal(f.seen.at(-1).headers['x-csrf-token'], UPSTREAM_TOKEN);
  }
});

test('unknown/private/malformed commands and overlarge request bodies never reach upstream', async t => {
  const f = await fixture(t), c = await f.client(), token = await nonce(c), before = f.seen.length;
  for (const body of [{ paused: true, exchangesEnabled: true }, { paused: 'yes' }, { paused: false, arbitrary: true }, {}, { target: 'http://evil.example' }]) {
    assert.ok((await post(c, '/api/control', body, token)).status >= 400);
  }
  const invalid = [command('arbitrary-worker-message'), command('stop', { force: true }), command('send', { text: '/ban someone' }),
    command('send', { text: 'hello\nthere' }), command('send', { text: 'https://outside.example' }), command('send', { text: 'x'.repeat(301) }),
    command('start', { channel: 'sample_channel', chatMode: 'mentions', replySource: 'local', autoResume: false, account: 'another_account' }),
    { ...command('watch'), target: 'http://outside.example' }, { ...command('watch'), requestId: '' }];
  for (const body of invalid) assert.ok((await post(c, '/api/accounts/primary/command', body, token)).status >= 400, JSON.stringify(body));
  const large = await post(c, '/api/accounts/primary/command', { padding: 'x'.repeat(66000) }, token); assert.equal(large.status, 413);
  assert.equal(f.seen.length, before);
});

test('untrusted upstream cookies/debug headers are stripped while static content and CSP are preserved', async t => {
  const f = await fixture(t, { upstream: (_req, res) => respond(res, 200, 'body fixture', {
    'Set-Cookie': 'UPSTREAM_SECRET_COOKIE=secret; HttpOnly', 'X-Debug-Secret': 'HEADER_PRIVATE_SENTINEL',
    'Content-Security-Policy': "default-src 'self'; object-src 'none'", 'Content-Type': 'text/javascript' }) });
  const c = await f.client(), response = await c.request('/app.js');
  assert.equal(response.status, 200); assert.equal(response.text, 'body fixture');
  assert.equal(response.headers['x-debug-secret'], undefined);
  assert.ok(!(response.headers['set-cookie'] || []).some(x => x.includes('UPSTREAM_SECRET_COOKIE')));
  assert.match(response.headers['content-security-policy'], /object-src 'none'/);
});

test('upstream redirects and failed responses are never followed or exposed as raw provider diagnostics', async t => {
  const f = await fixture(t), c = await f.client();
  for (const status of [302, 401, 403, 500]) {
    f.setHandler((_req, res) => respond(res, status, { error: 'RAW_UPSTREAM_SECRET', csrfToken: UPSTREAM_TOKEN }, { Location: 'https://outside.example/SECRET_LOCATION' }));
    const before = f.seen.length, response = await c.request('/api/status');
    assert.equal(response.status, 503); assert.equal(f.seen.length, before + 1);
    assert.doesNotMatch(response.text, /RAW_UPSTREAM_SECRET|SECRET_LOCATION|fixture-private-upstream/);
    assert.equal(response.headers.location, undefined);
  }
});

test('invalid JSON and oversized data responses fail bounded and do not leak upstream payloads', async t => {
  const f = await fixture(t), c = await f.client();
  for (const body of ['RAW_INVALID_JSON_PRIVATE', JSON.stringify({ csrfToken: UPSTREAM_TOKEN, error: 'OVERSIZE_PRIVATE', padding: 'x'.repeat(262145) })]) {
    f.setHandler((_req, res) => respond(res, 200, body, { 'Content-Type': 'application/json' }));
    const response = await c.request('/api/status'); assert.equal(response.status, 503);
    assert.ok(response.text.length < 2000); assert.doesNotMatch(response.text, /RAW_INVALID_JSON_PRIVATE|OVERSIZE_PRIVATE|fixture-private-upstream/);
  }
});

test('a timed-out POST is submitted upstream exactly once and no reconnect can replay it', async t => {
  const f = await fixture(t, { timeoutMs: 50 }), c = await f.client(), token = await nonce(c);
  const held = [];
  f.setHandler((req, res) => { if (req.method === 'POST') held.push(res); else respond(res, 200, { csrfToken: UPSTREAM_TOKEN }); });
  const body = command('send', { text: 'a reviewed timeout fixture message' });
  const response = await post(c, '/api/accounts/primary/command', body, token);
  assert.equal(response.status, 503); assert.equal(f.seen.filter(x => x.method === 'POST').length, 1);
  assert.doesNotMatch(response.text, /\b(?:confirmed|rejected)\b|RAW_/i);
  await c.request('/api/status');
  assert.equal(f.seen.filter(x => x.method === 'POST').length, 1);
  for (const res of held) res.destroy();
});

test('tunnel outage returns a bounded offline navigation page and sanitized unavailable APIs', async t => {
  const f = await fixture(t), c = await f.client(); await close(f.upstream);
  const page = await c.request('/accounts', { headers: { Accept: 'text/html', Origin: '', 'Sec-Fetch-Site': 'none' } });
  assert.equal(page.status, 503); assert.match(page.text, /retry/i); assert.match(page.text, /\/superadmin\.html/);
  assert.ok(page.text.length < 10000); assert.doesNotMatch(page.text, /ECONNREFUSED|18795|8795|Bearer|stack|remoteToken/);
  assert.match(page.text, /class="nav"/); assert.match(page.text, /src="\/admin-nav\.js/);
  const api = await c.request('/api/accounts'); assert.equal(api.status, 503); assert.equal(api.data.ok, false);
  assert.doesNotMatch(api.text, /ECONNREFUSED|18795|8795|Bearer|stack|remoteToken/);
});


test('the request bound applies to original bytes including padded or chunked JSON', async t => {
  const f = await fixture(t), c = await f.client(), token = await nonce(c), before = f.seen.length;
  const raw = ' '.repeat(66000) + '{"paused":true}';
  const fixed = await c.request('/api/control', { method: 'POST', raw, headers: { 'X-CSRF-Token': token, 'Content-Length': Buffer.byteLength(raw) } });
  assert.equal(fixed.status, 413);
  const chunked = await c.request('/api/control', { method: 'POST', raw, headers: { 'X-CSRF-Token': token, 'Transfer-Encoding': 'chunked' } });
  assert.ok([400, 413].includes(chunked.status), chunked.text);
  assert.equal(f.seen.length, before, 'oversized semantic whitespace cannot be normalized into an allowed upstream action');
});


const hostSource = resolve(__dirname, '../tools/stream-companion-host/server.mjs');
test('real prefixed Mac host and production gateway complete authenticated page/status/control roundtrips without helper calls',
  { skip: Number(process.versions.node.split('.')[0]) < 22 || !existsSync(hostSource) }, async t => {
    const { createHostServer } = await import(pathToFileURL(hostSource).href);
    const commandCalls = [], browserCalls = []; let paused = true, pauseCalls = 0;
    const clients = [{ id: 'fixture-client', account: 'fixture_account', token: 'p'.repeat(48) }];
    const store = { client: () => ({ account: 'fixture_account' }), status: () => ({ updatedAt: new Date().toISOString(), paused }),
      setPaused(value) { pauseCalls++; paused = value; return { ok: true, paused }; },
      setExchangesEnabled(value) { return { ok: true, exchangesEnabled: value }; } };
    const accounts = { snapshot: async () => ({ updatedAt: new Date().toISOString(), instances: [{ id: 'primary', account: 'fixture_account', connected: false }] }),
      command: async (id, body) => { commandCalls.push({ id, body }); return { ok: true, command: { ...body, id: 'fixture-host-command', state: 'queued' } }; } };
    const channels = { snapshot: async () => ({ updatedAt: new Date().toISOString(), channels: [{ login: 'aviskarex', isLive: false }] }),
      lookup: async login => ({ login, isLive: true, checkedAt: Date.now() }) };
    const browserLauncher = { available: id => id === 'primary', open: async (id, requestId) => {
      browserCalls.push({ id, requestId }); return { ok: true, state: 'opening' }; } };
    const upstream = createHostServer({ store, clients, accounts, channels, browserLauncher, remoteToken: REMOTE_TOKEN, csrfToken: UPSTREAM_TOKEN });
    const f = await fixture(t, { upstreamServer: upstream }), c = await f.client();
    const page = await c.request('/accounts/primary'); assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /__COMPANION_BASE__/);
    assert.match(page.text, /\/admin\/stream-companion\/accounts\.css/);
    assert.match(page.text, /\/admin\/stream-companion\/accounts\.js/);
    const data = await c.request('/api/accounts'); assert.equal(data.status, 200);
    assert.equal(data.data.instances[0].account, 'fixture_account');
    assert.equal(data.data.instances[0].browser.canOpen, true);
    const csrf = data.data.csrfToken; assert.notEqual(csrf, UPSTREAM_TOKEN);
    assert.doesNotMatch(data.text, new RegExp(REMOTE_TOKEN + '|' + UPSTREAM_TOKEN));
    const directory = await c.request('/api/channels');
    assert.equal(directory.status, 200); assert.equal(directory.data.channels[0].login, 'aviskarex');
    assert.equal(directory.data.csrfToken, csrf);
    const lookup = await c.request('/api/channels/live_friend');
    assert.equal(lookup.status, 200); assert.equal(lookup.data.channels[0].login, 'live_friend');
    assert.equal(lookup.data.csrfToken, csrf);
    const opened = await post(c, '/api/accounts/primary/browser', { requestId: 'fixture-open-primary' }, csrf);
    assert.equal(opened.status, 200); assert.deepEqual(opened.data, { ok: true, state: 'opening' });
    assert.deepEqual(browserCalls, [{ id: 'primary', requestId: 'fixture-open-primary' }]);
    assert.deepEqual(commandCalls, []); assert.equal(paused, true, 'opening a browser cannot start chat or resume coordination');
    const body = command('settings', { chatMode: 'mentions', replySource: 'local', autoResume: false });
    assert.equal((await post(c, '/api/accounts/primary/command', body, csrf)).status, 200);
    assert.deepEqual(commandCalls, [{ id: 'primary', body }]);
    assert.equal((await post(c, '/api/control', { paused: true }, csrf)).status, 200);
    assert.equal(paused, true); assert.equal(pauseCalls, 1);
    assert.equal((await c.request('/internal/sync')).status, 404);
  });


test('production captures bounded controller bytes before its existing general JSON parser', () => {
  const source = readFileSync(resolve(__dirname, '../server.js'), 'utf8');
  const specific = /app\.use\(\s*["']\/admin\/stream-companion["']\s*,\s*twitchControllerRoutes\.bodyParser\s*\)/.exec(source);
  const general = /app\.use\(\s*express\.json\(/.exec(source);
  assert.ok(specific && general, 'both controller and general parsers must be mounted');
  assert.ok(specific.index < general.index, 'parent parser must not consume controller bytes first');
});

test('missing or invalid private deployment configuration stays authenticated and fails closed without contacting upstream', async t => {
  for (const router of [{ remoteToken: '' }, { remoteToken: 'short' }, { publicOrigin: 'http://controller.example' },
    { publicOrigin: 'https://controller.example/untrusted-path' }, { upstreamPort: 0 }]) {
    const f = await fixture(t, { router });
    assert.equal((await request(f.port, BASE + '/api/status')).status, 401);
    const c = await f.client(), response = await c.request('/api/status');
    assert.equal(response.status, 503); assert.equal(f.seen.length, 0);
    assert.doesNotMatch(response.text, /short|remoteToken|18795|8795/);
  }
});

test('a private host CSRF change requests refresh without replaying the original mutation or exposing its reason', async t => {
  const f = await fixture(t), c = await f.client(), browserNonce = await nonce(c);
  f.setHandler((_req, res) => respond(res, 403, { error: 'HOST_PRIVATE_DIAGNOSTIC', csrfToken: UPSTREAM_TOKEN }));
  const body = command('settings', { chatMode: 'mentions', replySource: 'local', autoResume: false });
  const rejected = await post(c, '/api/accounts/primary/command', body, browserNonce);
  assert.equal(rejected.status, 409); assert.equal(f.seen.filter(x => x.method === 'POST').length, 1);
  assert.doesNotMatch(rejected.text, /HOST_PRIVATE_DIAGNOSTIC|fixture-private-upstream/);
  const rotated = 'new-private-upstream-csrf-after-host-restart';
  f.setHandler((req, res) => respond(res, 200, req.method === 'GET' ? { csrfToken: rotated, instances: [] } : { ok: true }));
  assert.equal(await nonce(c, '/api/accounts'), browserNonce);
  assert.equal(f.seen.filter(x => x.method === 'POST').length, 1, 'status refresh cannot resend the mutation');
  const nextBody = command('stop');
  assert.equal((await post(c, '/api/accounts/primary/command', nextBody, browserNonce)).status, 200);
  assert.equal(f.seen.at(-1).headers['x-csrf-token'], rotated);
  assert.deepEqual(f.seen.at(-1).body, nextBody);
});


test('clips retain CSRF masking, exact creator selection, finite authorization and single-forward mutations', async t => {
  const f = await fixture(t), c = await f.client(), token = await nonce(c, '/api/clips');
  assert.equal(f.seen.at(-1).method, 'GET');
  const actions = [
    ['/api/clips/settings', { enabled: true, channel: 'aviskarex', accountIds: ['primary', 'test'] }],
    ['/api/clips/create', { requestId: 'moment-1', channel: 'aviskarex', accountIds: ['test'] }],
    ['/api/clips/authorization', { accountId: 'primary', action: 'start' }],
    ['/api/clips/authorization', { accountId: 'primary', action: 'poll' }]
  ];
  for (const [path, body] of actions) {
    const before = f.seen.length;
    assert.equal((await c.request(path)).status, 405);
    assert.equal((await post(c, path, body, 'wrong')).status, 403);
    assert.equal((await post(c, path, body, token, { Origin: 'https://outside.example' })).status, 403);
    assert.equal(f.seen.length, before);
    assert.equal((await post(c, path, body, token)).status, 200);
    assert.equal(f.seen.length, before + 1);
    assert.deepEqual(f.seen.at(-1).body, body);
    assert.equal(f.seen.at(-1).headers['x-csrf-token'], UPSTREAM_TOKEN);
  }
  const before = f.seen.length;
  for (const [path, body] of [
    ['/api/clips/settings', { enabled: true, channel: 'aviskarex', accountIds: ['primary', 'primary'] }],
    ['/api/clips/settings', { enabled: true, channel: 'aviskarex', accountIds: [] }],
    ['/api/clips/create', { requestId: 'x', channel: 'aviskarex', accountIds: ['foreign'] }],
    ['/api/clips/create', { requestId: 'x', channel: 'aviskarex', accountIds: ['primary'], streamId: '123' }],
    ['/api/clips/authorization', { accountId: 'primary', action: 'start', scopes: ['whatever'] }],
    ['/api/clips/authorization', { accountId: 'primary', action: 'approve' }]
  ]) assert.equal((await post(c, path, body, token)).status, 400);
  for (const path of ['/api/clips/create/', '/api/clips/create?x=1', '/api/clips/%63reate', '/api/clips/delete']) assert.equal((await post(c, path, {}, token)).status, 404);
  assert.equal(f.seen.length, before);
});

test('third companion routes and all finite creator subsets preserve protected boundaries', async t => {
  const f = await fixture(t), c = await f.client(), token = await nonce(c);
  assert.equal((await c.request('/accounts/third')).status, 200);
  for (const [path, body] of [
    ['/api/accounts/third/browser', { requestId: 'third-browser' }],
    ['/api/accounts/third/command', command('stop')],
    ['/api/clips/settings', { enabled: false, channel: 'aviskarex', accountIds: ['primary', 'test', 'third'] }],
    ['/api/clips/create', { requestId: 'third-moment', channel: 'aviskarex', accountIds: ['primary', 'third'] }],
    ['/api/clips/authorization', { accountId: 'third', action: 'start' }]
  ]) {
    const before = f.seen.length;
    assert.equal((await post(c, path, body, 'wrong')).status, 403);
    assert.equal(f.seen.length, before);
    assert.equal((await post(c, path, body, token)).status, 200);
    assert.deepEqual(f.seen.at(-1).body, body);
    assert.equal(f.seen.length, before + 1);
  }
  const before = f.seen.length;
  for (const ids of [['primary', 'test', 'third', 'fourth', 'fifth'], ['third', 'third'], ['fifth']]) assert.equal((await post(c, '/api/clips/settings', { enabled: true, channel: 'aviskarex', accountIds: ids }, token)).status, 400);
  assert.equal((await post(c, '/api/accounts/fifth/command', command('stop'), token)).status, 404);
  assert.equal(f.seen.length, before);
});

test('fourth companion routes and every exact four-account clip subset remain bounded and authenticated', async t => {
  const f = await fixture(t), c = await f.client(), csrf = await nonce(c);
  assert.equal((await c.request('/accounts/fourth')).status, 200);
  for (const [path, body] of [
    ['/api/accounts/fourth/browser', { requestId: 'fourth-browser' }],
    ['/api/accounts/fourth/command', command('stop')],
    ['/api/clips/authorization', { accountId: 'fourth', action: 'start' }]
  ]) {
    const before = f.seen.length;
    assert.equal((await post(c, path, body, 'wrong')).status, 403);
    assert.equal((await post(c, path, body, csrf, { Origin: 'https://outside.example' })).status, 403);
    assert.equal(f.seen.length, before);
    assert.equal((await post(c, path, body, csrf)).status, 200);
    assert.equal(f.seen.length, before + 1); assert.deepEqual(f.seen.at(-1).body, body);
  }
  const ids = ['primary', 'test', 'third', 'fourth'];
  for (let mask = 1; mask < 16; mask++) {
    const accountIds = ids.filter((_, index) => mask & (1 << index));
    const body = { enabled: false, channel: 'aviskarex', accountIds };
    const before = f.seen.length;
    assert.equal((await post(c, '/api/clips/settings', body, csrf)).status, 200);
    assert.equal(f.seen.length, before + 1); assert.deepEqual(f.seen.at(-1).body.accountIds, accountIds);
  }
  const oldThree = { enabled: false, channel: 'aviskarex', accountIds: ['primary', 'test', 'third'] };
  assert.equal((await post(c, '/api/clips/settings', oldThree, csrf)).status, 200);
  assert.deepEqual(f.seen.at(-1).body, oldThree, 'old three-account selections cannot expand into all four');
  f.setHandler((_req, res) => respond(res, 200, { history: [], nextBeforeId: null, csrfToken: UPSTREAM_TOKEN }));
  const history = await c.request('/api/director/history/fourth/0');
  assert.equal(history.status, 200); assert.equal(history.data.csrfToken, csrf);
  const before = f.seen.length;
  for (const path of ['/accounts/fifth', '/api/accounts/fifth/browser', '/api/accounts/fourth/command/extra', '/api/director/history/fifth/0', '/api/director/history/fourth/0?limit=1000'])
    assert.equal((await c.request(path)).status, 404, path);
  for (const accountIds of [['primary', 'test', 'third', 'fourth', 'fifth'], ['fourth', 'fourth'], ['fifth']])
    assert.equal((await post(c, '/api/clips/settings', { ...oldThree, accountIds }, csrf)).status, 400);
  const threeProfileBank = { entries: [{ id: 'greeting', kind: 'greeting', category: 'greeting', lines: ['hello'], accountIds: ['primary'], enabled: true }],
    profiles: ids.slice(0, 3).map(id => ({ id, chatMode: 'mentions', replySource: 'local' })) };
  assert.equal((await post(c, '/api/director/bank', { requestId: 'missing-fourth-profile', expectedRevision: 1, bank: threeProfileBank }, csrf)).status, 400);
  assert.equal(f.seen.length, before, 'unsupported identities and stale bank shapes cannot reach the Mac');
});
