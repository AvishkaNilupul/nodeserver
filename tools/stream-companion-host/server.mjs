import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual, randomBytes, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { HostStore } from './lib/store.mjs';
import { createAccountManager, validateCommand } from './lib/accounts.mjs';
import { createChannelDirectory } from './lib/channels.mjs';
import { createBrowserLauncher, loadBrowserProfiles } from './lib/browser-launcher.mjs';
import { createClipController } from './lib/clips.mjs';
import { createStatusLogger } from './lib/status-log.mjs';
import { createOperatorDrafts } from './lib/operator-drafts.mjs';
import { generateOperatorDraft } from './lib/operator-model.mjs';

const equal = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); };
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const REMOTE_PREFIX = '/admin/stream-companion';
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/messages', ['messages.html', 'text/html; charset=utf-8']], ['/messages.js', ['messages.js', 'text/javascript; charset=utf-8']], ['/messages.css', ['messages.css', 'text/css; charset=utf-8']],
  ...['/accounts', '/accounts/primary', '/accounts/test', '/accounts/third', '/accounts/fourth'].map(path => [path, ['account.html', 'text/html; charset=utf-8']]),
  ['/accounts.js', ['accounts.js', 'text/javascript; charset=utf-8']], ['/accounts.css', ['accounts.css', 'text/css; charset=utf-8']],
  ['/controller-path.js', ['controller-path.js', 'text/javascript; charset=utf-8']],
  ['/clips.js', ['clips.js', 'text/javascript; charset=utf-8']], ['/clips.css', ['clips.css', 'text/css; charset=utf-8']]]);
const REMOTE_GET = new Set([...STATIC.keys(), '/api/status', '/api/accounts', '/api/channels', '/api/clips', '/api/director']);
const DIRECTOR_HISTORY = /^\/api\/director\/history\/(all|primary|test|third|fourth)\/([0-9]{1,16})$/;
const CHANNEL_LOOKUP = /^\/api\/channels\/([a-z0-9_]{3,25})$/;
const REMOTE_POST = new Set(['/api/control', '/api/accounts/primary/command', '/api/accounts/test/command', '/api/accounts/third/command', '/api/accounts/fourth/command',
  '/api/director/bank', '/api/director/cancel',
  '/api/accounts/primary/browser', '/api/accounts/test/browser', '/api/accounts/third/browser', '/api/accounts/fourth/browser', '/api/clips/create', '/api/clips/settings', '/api/clips/authorization']);
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

export function createHostServer({ store, clients, accounts = createAccountManager(), channels = createChannelDirectory(), browserLauncher = createBrowserLauncher(), clips, generateDraft, port = 8795, csrfToken = randomBytes(32).toString('base64url'), readFileImpl = readFile, remoteToken } = {}) {
  if (!store || !Array.isArray(clients) || !clients.length) throw Error('Host store and clients required.');
  for (const c of clients) if (typeof c.token !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(c.token) || store.client(c.id).account !== c.account) throw Error('Invalid coordination client pairing.');
  if (new Set(clients.map(c => c.token)).size !== clients.length) throw Error('Coordination clients require separate tokens.');
  if (remoteToken !== undefined && (typeof remoteToken !== 'string' || !TOKEN.test(remoteToken)
    || clients.some(c => equal(c.token, remoteToken)))) throw Error('Remote controller pairing must be valid and separate.');
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const accountSnapshot = async options => {
    const value = await accounts.snapshot(options);
    if (!store.director) return value;
    const instances = value.instances.map(instance => {
      const sent = store.director.history(instance.id).history;
      const obs = generateDraft && instance.connected && store.director.observation(instance.id);
      if (!obs || obs.channel !== instance.channel || obs.context?.streamId !== instance.streamContext?.streamId
        || store.client(instance.id).account !== instance.account) return { ...instance, sent };
      // Older helpers omit the native parent from their public status. Match the
      // same source message before copying metadata from the current observation.
      const observed = new Map(obs.messages.map(message => [message.id, message]));
      const messages = instance.chat.messages.map(message => {
        const native = observed.get(message.id);
        if (!native || message.channel !== obs.channel || native.author !== message.author || native.at !== message.at) return message;
        return { ...message, ...(native.isBot ? { isBot: true } : {}),
          ...(/^[a-zA-Z0-9:_-]{1,160}$/.test(native.replyParentId || '') ? { replyParentId: native.replyParentId } : {}) };
      });
      return { ...instance, chat: { ...instance.chat, messages }, sent };
    });
    return { ...value, instances };
  };
  const operatorDrafts = generateDraft && createOperatorDrafts({ snapshot: accountSnapshot, generate: generateDraft, companionLogins: clients.map(c => c.account) });
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
        if (!REMOTE_GET.has(path) && !CHANNEL_LOOKUP.test(path) && !DIRECTOR_HISTORY.test(path) && !REMOTE_POST.has(path)) return send(res, 404, { error: 'Not found.' });
        if (req.headers.upgrade !== undefined || /\bupgrade\b/i.test(String(req.headers.connection || ''))
          || !(req.method === 'GET' && (REMOTE_GET.has(path) || CHANNEL_LOOKUP.test(path) || DIRECTOR_HISTORY.test(path)) || req.method === 'POST' && REMOTE_POST.has(path))) {
          return send(res, 405, { error: 'Unsupported controller method.' });
        }
      }
      if (path === '/health' && req.method === 'GET') return send(res, 200, { ok: true, version: '1.0.0' });
      if (path.startsWith('/internal/')) {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required.' });
        if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined || req.headers['sec-fetch-dest'] !== undefined || req.headers['sec-fetch-user'] !== undefined) return send(res, 403, { error: 'Internal client required.' });
        const client = clients.find(c => c.id === req.headers['x-companion-id']);
        if (!client || !equal(req.headers.authorization, `Bearer ${client.token}`)) return send(res, 403, { error: 'Invalid coordination pairing.' });
        const directorMethods = { '/internal/director/import': 'importPage', '/internal/director/observe': 'observe', '/internal/director/manual': 'manual',
          '/internal/director/draft': 'draft', '/internal/director/generated': 'generated', '/internal/director/preferences': 'preferences' };
        if (Object.hasOwn(directorMethods, path)) {
          if (!store.director) throw failure('Central message authority is unavailable.', 503);
          return send(res, 200, store.director[directorMethods[path]](client.id, await bodyJSON(req)));
        }
        if (path === '/internal/clips/permit') {
          if (!clips) throw failure('Clip controls are unavailable.', 503);
          return send(res, 200, clips.permit(client.id, await bodyJSON(req)));
        }
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
      const historyPage = DIRECTOR_HISTORY.exec(path);
      if (path === '/api/director' || historyPage) {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required.' });
        if (!sameOrigin(req)) return send(res, 403, { error: 'Open the controller to view messages.' });
        if (!store.director) throw failure('Central message authority is unavailable.', 503);
        if (historyPage) store.transaction(() => store.expire());
        return send(res, 200, { ...(historyPage ? store.director.history(historyPage[1], Number(historyPage[2])) : store.director.status()), csrfToken });
      }
      if (path === '/api/director/bank' || path === '/api/director/cancel') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required.' });
        if (!sameOrigin(req) || !equal(req.headers['x-csrf-token'], csrfToken)) return send(res, 403, { error: 'Use the controller message controls.' });
        if (!store.director) throw failure('Central message authority is unavailable.', 503);
        return send(res, 200, path.endsWith('/bank') ? store.director.saveBank(await bodyJSON(req)) : store.director.cancel(await bodyJSON(req)));
      }
      if (path === '/api/accounts') {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required.' });
        if (!sameOrigin(req)) return send(res, 403, { error: 'Open the local account pages to view status.' });
        const value = await accountSnapshot();
        return send(res, 200, { ...value, instances: value.instances.map(instance => ({ ...(operatorDrafts ? operatorDrafts.decorate(instance, value.instances) : instance),
          browser: { ...instance.browser, canOpen: browserLauncher.available(instance.id) === true } })), csrfToken });
      }
      if (path === '/api/clips') {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET required.' });
        if (!sameOrigin(req)) return send(res, 403, { error: 'Open the controller to view clips.' });
        if (!clips) throw failure('Clip controls are unavailable.', 503);
        return send(res, 200, { ...clips.snapshot(), csrfToken });
      }
      const clipAction = /^\/api\/clips\/(create|settings|authorization)$/.exec(path);
      if (clipAction) {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required.' });
        if (!sameOrigin(req) || !equal(req.headers['x-csrf-token'], csrfToken)) return send(res, 403, { error: 'Use the controller clip controls.' });
        if (!clips) throw failure('Clip controls are unavailable.', 503);
        const action = { create: 'create', settings: 'configure', authorization: 'authorize' }[clipAction[1]];
        return send(res, 200, await clips[action](await bodyJSON(req)));
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
      const browserOpen = /^\/api\/accounts\/(primary|test|third|fourth)\/browser$/.exec(path);
      if (browserOpen) {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required.' });
        if (!sameOrigin(req) || !equal(req.headers['x-csrf-token'], csrfToken)) return send(res, 403, { error: 'Use the account controls to open a browser.' });
        const body = await bodyJSON(req);
        if (Object.keys(body).length !== 1 || typeof body.requestId !== 'string'
          || !/^[A-Za-z0-9:_-]{1,160}$/.test(body.requestId)) throw failure('Invalid browser request.', 400);
        return send(res, 200, await browserLauncher.open(browserOpen[1], body.requestId));
      }
      const accountCommand = /^\/api\/accounts\/(primary|test|third|fourth)\/command$/.exec(path);
      if (accountCommand) {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST required.' });
        if (!sameOrigin(req) || !equal(req.headers['x-csrf-token'], csrfToken)) return send(res, 403, { error: 'Use the local account controls.' });
        const body = await bodyJSON(req), id = accountCommand[1];
        if (operatorDrafts && body.action === 'draft' && body.params?.mode === 'reply') {
          try { return send(res, 200, await operatorDrafts.request(id, body)); }
          catch (e) {
            if (e.code === 'no_conversation') return send(res, 409, { code: e.code, error: e.message });
            throw e;
          }
        }
        if (body.action === 'send' && typeof body.requestId === 'string' && body.requestId.startsWith('review-send:')) {
          // The gateway forwards opaque IDs. The review reference survives an
          // edit of the text without extending the helper's typed Send command.
          const reviewId = /^review-send:[a-z0-9_-]{1,40}:([a-z0-9_:-]{1,100})$/i.exec(body.requestId)?.[1];
          const command = validateCommand(body);
          const value = await accountSnapshot({ fresh: true });
          const instance = value.instances.find(i => i.id === id);
          try {
            const claim = reviewId && instance && operatorDrafts?.claimSend(instance, value.instances, reviewId, command);
            if (!claim) return send(res, 409, { code: 'review_expired', error: 'The viewer conversation changed. Request a fresh draft before sending.' });
            claim.outcome ??= Promise.resolve().then(() => accounts.command(id, command));
            return send(res, 200, await claim.outcome);
          } catch (e) {
            if (e.code === 'review_used') return send(res, 409, { code: e.code, error: e.message });
            throw e;
          }
        }
        const result = await accounts.command(id, body);
        if (operatorDrafts && ['start', 'stop', 'watch'].includes(body.action)) operatorDrafts.invalidate(id);
        if (store.director && ['start', 'settings'].includes(body.action)) {
          store.director.preferences(accountCommand[1], { requestId: `profile:${createHash('sha256').update(JSON.stringify([accountCommand[1], body.requestId])).digest('hex')}`, chatMode: body.params.chatMode, replySource: body.params.replySource });
        }
        return send(res, 200, result);
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
  server.once('close', () => operatorDrafts?.stop());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(new URL('./private/config.json', import.meta.url), 'utf8'));
  const store = new HostStore({ clients: config.clients, directorEnabled: true });
  const remoteToken = await loadRemoteToken();
  let browserProfiles;
  try { browserProfiles = await loadBrowserProfiles(); }
  catch { console.warn('Automatic browser opening is unavailable. Existing companion controls remain available.'); }
  const browserLauncher = createBrowserLauncher({ profiles: browserProfiles });
  const statusLog = createStatusLogger();
  const accounts = createAccountManager({ onSnapshot: value => statusLog.observe(value) });
  const clips = createClipController({ db: store.db, accounts, isPaused: () => store.paused });
  const server = createHostServer({ store, clients: config.clients, remoteToken, browserLauncher, accounts, clips,
    generateDraft: process.platform === 'darwin' ? generateOperatorDraft : undefined });
  server.once('close', async () => { await clips.close(); statusLog.lifecycle('stopped'); store.close(); });
  server.listen(8795, '127.0.0.1', () => { statusLog.lifecycle('started'); clips.start(); console.log('Stream Companion Host 1.0.0 listening on http://127.0.0.1:8795'); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
