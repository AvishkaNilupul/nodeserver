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
    if (req.url.endsWith('/api/accounts')) return respond(res, 200, { updatedAt: new Date().toISOString(), instances: [], csrfToken: UPSTREAM_TOKEN });
    if (req.method === 'POST') return respond(res, 200, { ok: true, command: { id: 'fixture-command', state: 'queued' } });
    return respond(res, 200, '<!doctype html><title>Fixture controller</title>', { 'Content-Type': req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.css') ? 'text/css' : 'text/html' });
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
  for (const path of ['/accounts', '/accounts.js', '/api/status', '/api/accounts']) {
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

test('each finite GET route reaches only its prefixed fixed upstream and keeps response source intact', async t => {
  const f = await fixture(t), c = await f.client();
  const routes = ['/', '/accounts', '/accounts/primary', '/accounts/test', '/app.js', '/style.css', '/accounts.js', '/accounts.css', '/controller-path.js', '/api/status', '/api/accounts'];
  for (const path of routes) assert.equal((await c.request(path)).status, 200, path);
  assert.deepEqual(f.seen.map(x => x.path), routes.map(x => BASE + x));
  assert.ok(f.seen.every(x => x.headers.host === '127.0.0.1:8795' && x.headers.authorization === `Bearer ${REMOTE_TOKEN}`));
  assert.equal((await c.request('/accounts')).text, '<!doctype html><title>Fixture controller</title>');
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
    '/health', '/internal/sync', '/private/remote.json', '/api/accounts/unknown/command', '/api/accounts/primary/command/foo']) {
    const response = await c.request(path); assert.ok(response.status >= 400, `${path}: ${response.status}`);
  }
  for (const method of ['HEAD', 'PUT', 'DELETE', 'OPTIONS']) assert.ok((await c.request('/api/status', { method })).status >= 400, method);
  assert.ok((await c.request('/api/status', { headers: { Upgrade: 'websocket' } })).status >= 400);
  assert.equal(f.seen.length, 0);
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


const hostSource = resolve(__dirname, '../../stream-companion-host/server.mjs');
test('real prefixed Mac host and production gateway complete authenticated page/status/control roundtrips without helper calls',
  { skip: Number(process.versions.node.split('.')[0]) < 22 || !existsSync(hostSource) }, async t => {
    const { createHostServer } = await import(pathToFileURL(hostSource).href);
    const commandCalls = []; let paused = true, pauseCalls = 0;
    const clients = [{ id: 'fixture-client', account: 'fixture_account', token: 'p'.repeat(48) }];
    const store = { client: () => ({ account: 'fixture_account' }), status: () => ({ updatedAt: new Date().toISOString(), paused }),
      setPaused(value) { pauseCalls++; paused = value; return { ok: true, paused }; },
      setExchangesEnabled(value) { return { ok: true, exchangesEnabled: value }; } };
    const accounts = { snapshot: async () => ({ updatedAt: new Date().toISOString(), instances: [{ id: 'primary', account: 'fixture_account', connected: false }] }),
      command: async (id, body) => { commandCalls.push({ id, body }); return { ok: true, command: { ...body, id: 'fixture-host-command', state: 'queued' } }; } };
    const upstream = createHostServer({ store, clients, accounts, remoteToken: REMOTE_TOKEN, csrfToken: UPSTREAM_TOKEN });
    const f = await fixture(t, { upstreamServer: upstream }), c = await f.client();
    const page = await c.request('/accounts/primary'); assert.equal(page.status, 200);
    assert.doesNotMatch(page.text, /__COMPANION_BASE__/);
    assert.match(page.text, /\/admin\/stream-companion\/accounts\.css/);
    assert.match(page.text, /\/admin\/stream-companion\/accounts\.js/);
    const data = await c.request('/api/accounts'); assert.equal(data.status, 200);
    assert.equal(data.data.instances[0].account, 'fixture_account');
    const csrf = data.data.csrfToken; assert.notEqual(csrf, UPSTREAM_TOKEN);
    assert.doesNotMatch(data.text, new RegExp(REMOTE_TOKEN + '|' + UPSTREAM_TOKEN));
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
