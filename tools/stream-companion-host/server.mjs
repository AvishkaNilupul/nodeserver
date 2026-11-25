import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HostStore } from './lib/store.mjs';
import { createAccountManager } from './lib/accounts.mjs';
import { createChannelDirectory } from './lib/channels.mjs';

const equal = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); };
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const REMOTE_PREFIX = '/admin/stream-companion';
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['/accounts', '/accounts/primary', '/accounts/test'].map(path => [path, ['account.html', 'text/html; charset=utf-8']]),
  ['/accounts.js', ['accounts.js', 'text/javascript; charset=utf-8']], ['/accounts.css', ['accounts.css', 'text/css; charset=utf-8']],
  ['/controller-path.js', ['controller-path.js', 'text/javascript; charset=utf-8']]]);
const REMOTE_GET = new Set([...STATIC.keys(), '/api/status', '/api/accounts', '/api/channels']);
const CHANNEL_LOOKUP = /^\/api\/channels\/([a-z0-9_]{3,25})$/;
const REMOTE_POST = new Set(['/api/control', '/api/accounts/primary/command', '/api/accounts/test/command']);
const failure = (message, status) => Object.assign(new Error(message), { status });

export async function loadRemoteToken({ file = new URL('./private/remote.json', import.meta.url), readFileImpl = readFile } = {}) {
  let text;
  try { text = await readFileImpl(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw Error('Remote controller pairing is invalid.'); }
  try {
    if (Buffer.byteLength(text) > 4096) throw Error();
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1
      || typeof value.token !== 'string' || !TOKEN.test(value.token)) throw Error();
    return value.token;
  } catch { throw Error('Remote controller pairing is invalid.'); }
}
async function bodyJSON(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw failure('JSON required.', 415);
  let body = '';
  for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 65536) throw failure('Request too large.', 413); }
  let value; try { value = JSON.parse(body); } catch { throw failure('Invalid JSON.', 400); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('JSON object required.', 400);
  return value;
}

export function createHostServer({ store, clients, accounts = createAccountManager(), channels = createChannelDirectory(), port = 8795, csrfToken = randomBytes(32).toString('base64url'), readFileImpl = readFile, remoteToken } = {}) {
  if (!store || !Array.isArray(clients) || !clients.length) throw Error('Host store and clients required.');
  for (const c of clients) if (typeof c.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(c.token) || store.client(c.id).account !== c.account) throw Error('Invalid coordination client pairing.');
  if (new Set(clients.map(c => c.token)).size !== clients.length) throw Error('Coordination clients require separate tokens.');
  if (remoteToken !== undefined && (typeof remoteToken !== 'string' || !TOKEN.test(remoteToken)
    || clients.some(c => equal(c.token, remoteToken)))) throw Error('Remote controller pairing must be valid and separate.');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const send = (res, status, value, contentType = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
    res.end(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value));
  };
  const sameOrigin = req => {
    const origin = req.headers.origin, site = req.headers['sec-fetch-site'];
    return (origin === undefined || origin === `http://${req.headers.host}`) && (site === undefined || site === 'same-origin') && (origin !== undefined || site === 'same-origin');
  };
  const server = http.createServer(async (req, res) => {
    const hostCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === 'host').length;
    const acceptedHosts = port === 0 ? new Set([`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`]) : hosts;
    if (!LOOPBACK.has(req.socket.remoteAddress) || hostCount !== 1 || !acceptedHosts.has(req.headers.host)) return send(res, 403, { error: 'Local coordination host required.' });
    const rawPath = String(req.url || '');
    const remote = rawPath === REMOTE_PREFIX || rawPath.startsWith(`${REMOTE_PREFIX}/`);
    let path = rawPath;
    try {
      if (remote) {
        if (remoteToken === undefined) return send(res, 404, { error: 'Not found.' });
        if (!equal(req.headers.authorization, `Bearer ${remoteToken}`)) return send(res, 403, { error: 'Remote controller pairing required.' });
        // Match the literal request target. Decoding or normalizing here could
        // turn an unlisted remote URL into a privileged local/internal route.
        path = rawPath.slice(REMOTE_PREFIX.length);
        if (!REMOTE_GET.has(path) && !CHANNEL_LOOKUP.test(path) && !REMOTE_POST.has(path)) return send(res, 404, { error: 'Not found.' });
        if (req.headers.upgrade !== undefined || /\bupgrade\b/i.test(String(req.headers.connection || ''))
          || !(req.method === 'GET' && (REMOTE_GET.has(path) || CHANNEL_LOOKUP.test(path)) || req.method === 'POST' && REMOTE_POST.has(path))) {
          return send(res, 405, { error: 'Unsupported controller method.' });
        }
      }
      if (path === '/health' && req.method === 'GET') return send(res, 200, { ok: true, version: '1.0.0' });
      if (path.startsWith('/internal/')) {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required.' });
        if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-dest'] !== undefined || req.headers['sec-fetch-user'] !== undefined) return send(res, 403, { error: 'Internal client required.' });
        const client = clients.find(c => c.id === req.headers['x-companion-id']);
        if (!client || !equal(req.headers.authorization, `Bearer ${client.token}`)) return send(res, 403, { error: 'Invalid coordination pairing.' });
        const routes = { '/internal/sync': 'sync', '/internal/reserve': 'reserve', '/internal/begin': 'begin', '/internal/finish': 'finish' };
        if (!Object.hasOwn(routes, path)) return send(res, 404, { error: 'Not found.' });
        const body = await bodyJSON(req);
        if (body.account !== undefined && body.account !== client.account) return send(res, 403, { error: 'Account does not match this client.' });
        return send(res, 200, store[routes[path]](client.id, body));
      }
      if (path === '/api/status') {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required.' });
        if (!sameOrigin(req)) return send(res, 403, { error: 'Open the local host page to view status.' });
        return send(res, 200, { ...store.status(), csrfToken });
      }
      if (path === '/api/accounts') {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required.' });
        if (!sameOrigin(req)) return send(res, 403, { error: 'Open the local account pages to view status.' });
        return send(res, 200, { ...await accounts.snapshot(), csrfToken });
      }
      const channelLookup = CHANNEL_LOOKUP.exec(path);
      if (path === '/api/channels' || channelLookup) {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required.' });
        if (!sameOrigin(req)) return send(res, 403, { error: 'Open the account pages to choose a channel.' });
        const value = channelLookup
          ? { updatedAt: new Date().toISOString(), channels: [await channels.lookup(channelLookup[1])] }
          : await channels.snapshot();
        return send(res, 200, { ...value, csrfToken });
      }
      const accountCommand = /^\/api\/accounts\/(primary|test)\/command$/.exec(path);
      if (accountCommand) {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required.' });
        if (!sameOrigin(req) || !equal(req.headers['x-csrf-token'], csrfToken)) return send(res, 403, { error: 'Use the local account controls.' });
        return send(res, 200, await accounts.command(accountCommand[1], await bodyJSON(req)));
      }
      if (path === '/api/control') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required.' });
        if (!sameOrigin(req) || !equal(req.headers['x-csrf-token'], csrfToken)) return send(res, 403, { error: 'Use the local host controls.' });
        const body = await bodyJSON(req), keys = Object.keys(body);
        if (keys.length !== 1 || !['paused', 'exchangesEnabled'].includes(keys[0]) || typeof body[keys[0]] !== 'boolean') {
          throw failure('Choose exactly one supported boolean control.', 400);
        }
        return send(res, 200, keys[0] === 'paused' ? store.setPaused(body.paused) : store.setExchangesEnabled(body.exchangesEnabled));
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'GET required.' });
      const asset = STATIC.get(path); if (!asset) return send(res, 404, { error: 'Not found.' });
      try {
        const content = await readFileImpl(new URL(`./public/${asset[0]}`, import.meta.url));
        return send(res, 200, asset[1].startsWith('text/html')
          ? String(content).replaceAll('__COMPANION_BASE__', remote ? REMOTE_PREFIX : '') : content, asset[1]);
      }
      catch { return send(res, 404, { error: 'Host asset unavailable.' }); }
    } catch (error) { return send(res, Number.isInteger(error.status) ? error.status : 503, { error: error.status ? error.message : 'The coordination host is temporarily unavailable.' }); }
  });
  server.requestTimeout = 10000; server.headersTimeout = 5000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 32;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(new URL('./private/config.json', import.meta.url), 'utf8'));
  const store = new HostStore({ clients: config.clients });
  const remoteToken = await loadRemoteToken();
  const server = createHostServer({ store, clients: config.clients, remoteToken });
  server.once('close', () => store.close());
  server.listen(8795, '127.0.0.1', () => console.log('Stream Companion Host 1.0.0 listening on http://127.0.0.1:8795'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
