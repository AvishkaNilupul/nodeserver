import http from 'node:http';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { composeRequest, generate } from './lib/composer.mjs';
import { TwitchChat } from './lib/twitch.mjs';
import { HostCoordinator } from './lib/host-coordinator.mjs';
import { LocalControl } from './lib/local-control.mjs';
import { ViewerClips } from './lib/clips.mjs';

const equal = (a, b) => { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
const respond = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };

export async function savePrivate(url, value) {
  const temporary = new URL(`${url.href}.tmp`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, url);
}

export function createHelper({ config, twitch = new TwitchChat(), generateImpl = generate, now = Date.now, control: suppliedControl, intentFile, clipFile, clips: suppliedClips } = {}) {
  const expectedOrigin = `chrome-extension://${config.extensionId}`;
  let modelBusy = false, calls = [], serial = Promise.resolve(), generation = 0;
  const locked = fn => {
    const expected = generation;
    const run = () => { if (expected !== generation) throw new Error('Operation cancelled by disconnect.'); return fn(); };
    const result = serial.then(run, run); serial = result.catch(() => {}); return result;
  };
  const control = suppliedControl || new LocalControl({ twitch, now, intentFile, secrets: [config.pairingToken, config.apiKey, config.extensionId],
    onIntent: () => { generation++; } });
  const clips = suppliedClips || new ViewerClips({ twitch, control, now, file: clipFile });
  const server = http.createServer(async (req, res) => {
    if (req.headers.host !== '127.0.0.1:8793') return respond(res, 403, { error: 'Invalid host.' });
    if (req.url === '/health' && req.method === 'GET') return respond(res, 200, { ok: true, version: '0.12.0', transport: 'twitch-api', configured: !!config.apiKey, extensionId: config.extensionId });
    if (req.headers.origin !== expectedOrigin) return respond(res, 403, { error: 'This origin is not paired.' });
    res.setHeader('Access-Control-Allow-Origin', expectedOrigin); res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST'); res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type'); return respond(res, 204, {});
    }
    if (!equal(req.headers.authorization || '', `Bearer ${config.pairingToken}`)) return respond(res, 401, { error: 'Invalid local pairing token.' });
    if (req.method !== 'POST') return respond(res, 404, { error: 'Not found.' });
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return respond(res, 415, { error: 'JSON required.' });
    try {
      let body = '';
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 60_000) { const e = new Error('Request too large.'); e.status = 413; throw e; } }
      let input; try { input = JSON.parse(body); } catch { const e = new Error('Invalid JSON.'); e.status = 400; throw e; }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return respond(res, 400, { error: 'JSON object required.' });
      if (req.url === '/api/clips/status') {
        if (Object.keys(input).length) return respond(res, 400, { error: 'Clip status takes no settings.' });
        return respond(res, 200, clips.status());
      }
      if (req.url === '/api/clips/create') return respond(res, 200, clips.create(input));
      if (req.url === '/api/clips/authorization') return respond(res, 200, await clips.authorization(input));
      if (req.url === '/api/control/status') return respond(res, 200, control.status());
      if (req.url === '/api/control/command') return respond(res, 200, control.command(input));
      if (req.url === '/api/control/bridge') return respond(res, 200, control.bridge(input));
      if (req.url === '/api/twitch/status') { await twitch.refreshCoordination?.(input.observation); return respond(res, 200, twitch.status()); }
      // Pause must interrupt slow authorization/connection work, not wait for it.
      if (req.url === '/api/twitch/disconnect') {
        const result = control.disconnect(input);
        if (result.disarmOnly) { generation++; twitch.disconnect(); }
        return respond(res, 200, result);
      }
      const actions = {
        '/api/twitch/authorize': () => twitch.startAuthorization(input.clientId, input.account),
        '/api/twitch/authorization': () => twitch.pollAuthorization(),
        '/api/twitch/connect': async () => {
          let intent;
          if (input.explicitStart === true) intent = control.nativeStart(input);
          else control.guard(input, { action: 'start' });
          const permitted = intent ? { ...input, controlGeneration: intent.generation } : input;
          let result;
          try {
            result = await twitch.connect(input.account, input.channel); control.guard(permitted, { action: 'start' });
            if (intent) control.nativeConnected(intent.generation);
          } catch (e) { if (intent) control.nativeFailed(intent.generation); twitch.disconnect(); throw e; }
          return { ...result, ...(intent ? { intent: control.intent() } : {}) };
        },
        '/api/twitch/channel': () => twitch.inspectChannel(input.account, input.channel),
        '/api/twitch/send': () => { control.guard(input, { action: 'send' }); return twitch.send({ ...input, beforeSubmit: () => control.guard(input, { action: 'send' }) }); }
      };
      if (Object.hasOwn(actions, req.url)) return respond(res, 200, await locked(actions[req.url]));
      if (req.url !== '/api/compose') return respond(res, 404, { error: 'Not found.' });
      calls = calls.filter(at => at > Date.now() - 3_600_000);
      if (modelBusy || calls.length >= 30) return respond(res, 429, { error: 'The helper is busy or the hourly model budget is exhausted.' });
      let composeInput; try { composeInput = composeRequest(input); } catch (e) { e.status = 400; throw e; }
      if (!config.apiKey) return respond(res, 503, { error: 'Configure the model provider in private/config.json.' });
      modelBusy = true; calls.push(Date.now());
      try { return respond(res, 200, await generateImpl(composeInput, config)); }
      finally { modelBusy = false; }
    } catch (e) { respond(res, e.status || 502, { error: req.url.startsWith('/api/control/') || req.url.startsWith('/api/clips/') ? control.diagnostic(e.message) : e.message }); }
  });
  server.control = control; server.clips = clips;
  server.requestTimeout = 45_000; server.headersTimeout = 10_000;
  server.on('close', () => { clips.close(); twitch.disconnect(); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(await readFile(new URL('./private/config.json', import.meta.url), 'utf8').catch(() => { throw new Error('Run npm run setup first.'); }));
  const credentialsUrl = new URL('./private/twitch-oauth.json', import.meta.url);
  const historyUrl = new URL('./private/twitch-send-history.json', import.meta.url);
  async function readOptional(url, fallback) { try { return JSON.parse(await readFile(url, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; } }
  const credentials = await readOptional(credentialsUrl, {}), history = await readOptional(historyUrl, []);
  const hostConfig = JSON.parse(await readFile(new URL('./private/host.json', import.meta.url), 'utf8').catch(() => { throw new Error('Run the central host setup before starting this helper.'); }));
  let twitch;
  const coordinator = new HostCoordinator({ config: hostConfig,
    outboxFile: new URL('./private/host-completions.json', import.meta.url),
    getConnection: () => ({ channel: twitch?.channel || '', connected: twitch?.connected === true }) });
  coordinator.register(credentials.account); coordinator.seed(history);
  twitch = new TwitchChat({ credentials, history, coordinator, saveCredentials: value => savePrivate(credentialsUrl, value), saveHistory: value => savePrivate(historyUrl, value) });
  void coordinator.refresh().catch(() => {});
  const server = createHelper({ config, twitch, intentFile: new URL('./private/control-intent.json', import.meta.url), clipFile: new URL('./private/clip-jobs.json', import.meta.url) });
  server.once('close', () => coordinator.close());
  server.listen(8793, '127.0.0.1', () => console.log('Stream Companion 0.12.0 listening on 127.0.0.1:8793 (Twitch API; chat disconnected)'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { twitch.disconnect(); server.close(); });
}
