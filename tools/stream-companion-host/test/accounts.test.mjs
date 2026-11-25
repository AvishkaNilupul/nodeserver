import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountManager, validateCommand } from '../lib/accounts.mjs';

const NOW = 1800000000000;
const configs = { 'primary.json': { extensionId: 'a'.repeat(32), pairingToken: 'primary-secret-'.repeat(4), apiKey: 'primary-api-secret-value' },
  'test.json': { extensionId: 'b'.repeat(32), pairingToken: 'second-secret-'.repeat(4), apiKey: 'second-api-secret-value' } };
const sources = [{ id: 'primary', configPath: 'primary.json' }, { id: 'test', configPath: 'test.json' }];
const start = { requestId: 'owner-start-1', action: 'start', params: { channel: 'test_channel', chatMode: 'participate', replySource: 'local', autoResume: true } };
function status(account = 'first_account') {
  return { ok: true, account, authorized: true, connected: true, channel: 'test_channel', error: '',
    settings: { allowedChannel: 'test_channel', paused: false, autoReply: true, autoResume: true, chatMode: 'participate', replySource: 'local', pairingToken: configs['primary.json'].pairingToken },
    browser: { online: true, lastSeenAt: new Date(NOW).toISOString(), sessionId: 'private-session' },
    watch: { enabled: true, status: 'playing', channel: 'test_channel', checkedAt: NOW, error: '' },
    activity: { state: 'waiting', reason: 'Waiting for conversation.', at: NOW },
    streamContext: { channel: 'test_channel', title: 'Test stream', gameName: 'Test game', streamId: '12345', isLive: true, checkedAt: NOW },
    chat: { messages: [{ id: 'message-1', author: 'viewer_one', text: 'hello', at: NOW, channel: 'test_channel' }] },
    sent: [{ account, channel: 'test_channel', at: NOW - 1000, text: 'hi there', delivery: 'confirmed', kind: 'greeting' }],
    drops: { enabled: false, token: 'must-not-pass' }, permissions: { playbackAccess: true },
    coordination: { available: true, paused: false, reason: '', token: 'must-not-pass' }, controls: { pending: null, recent: [] } };
}
const job = (input = start) => ({ id: 'command-1', ...input, state: 'queued', createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 90000).toISOString(), generation: 'private-generation' });
function fixture(fetchHook, options = {}) {
  const calls = []; let time = NOW;
  const manager = createAccountManager({ sources, now: () => time, readFileImpl: async path => JSON.stringify(configs[String(path)]),
    fetchImpl: async (url, init) => {
      const parsed = new URL(url), index = parsed.port === '8792' ? 'primary.json' : 'test.json';
      calls.push({ url, init, body: JSON.parse(init.body) });
      assert.equal(init.headers.Authorization, `Bearer ${configs[index].pairingToken}`);
      assert.equal(init.headers.Origin, `chrome-extension://${configs[index].extensionId}`);
      assert.equal(init.redirect, 'error');
      return fetchHook ? fetchHook(parsed, init, calls) : Response.json(parsed.pathname.endsWith('/status') ? status(index === 'primary.json' ? 'first_account' : 'second_account') : { ok: true, command: job(JSON.parse(init.body)) });
    }, ...options });
  return { manager, calls, advance: n => { time += n; } };
}

test('account snapshots flatten both fixed sources, retain useful data, and omit credentials', async () => {
  const f = fixture(), snapshot = await f.manager.snapshot();
  assert.deepEqual(snapshot.instances.map(x => x.id), ['primary', 'test']);
  const first = snapshot.instances[0];
  assert.equal(first.available, true); assert.equal(first.browser.online, true); assert.equal(first.watch.status, 'playing');
  assert.equal(first.chat.digest.messages, 1); assert.equal(first.sent[0].delivery, 'confirmed'); assert.equal(first.streamContext.isLive, true);
  const text = JSON.stringify(snapshot);
  for (const value of Object.values(configs).flatMap(x => Object.values(x))) assert.equal(text.includes(value), false);
  for (const value of ['private-session', 'must-not-pass', 'pairingToken', 'sessionId']) assert.equal(text.includes(value), false);
});

test('stale browser and stream observations cannot be presented as current', async () => {
  const f = fixture(() => { const s = status(); s.browser.lastSeenAt = new Date(NOW - 45001).toISOString(); s.streamContext.checkedAt = NOW - 120001; return Response.json(s); });
  const snapshot = await f.manager.snapshot();
  assert.equal(snapshot.instances[0].browser.online, false); assert.equal(snapshot.instances[0].streamContext, null);
});

test('one unavailable helper is isolated and the short snapshot cache avoids repeated reads', async () => {
  const f = fixture(url => { if (url.port === '8793') throw Error('not running'); return Response.json(status()); });
  const first = await f.manager.snapshot(); assert.equal(first.instances[0].available, true); assert.equal(first.instances[1].available, false);
  assert.equal(await f.manager.snapshot(), first); assert.equal(f.calls.length, 2);
  f.advance(1500); await f.manager.snapshot(); assert.equal(f.calls.length, 4);
});

test('strict actions cannot mutate identities, forward arbitrary messages, or target another service', async () => {
  const f = fixture();
  for (const input of [{ ...start, params: { ...start.params, account: 'other_account' } }, { ...start, action: 'authorize' },
    { ...start, url: 'https://example.com' }, { ...start, params: { ...start.params, channel: 'https://twitch.tv/test_channel' } },
    { requestId: 'manual', action: 'send', params: { text: '/ban someone' } }, { requestId: 'manual', action: 'send', params: { text: 'https://example.com' } }]) {
    await assert.rejects(f.manager.command('primary', input), error => error.status === 400);
  }
  await assert.rejects(f.manager.command('foreign', start), error => error.status === 404);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(validateCommand(start), start);
});

test('commands route once to the selected helper and return only the accepted job', async () => {
  const f = fixture(), result = await f.manager.command('test', start);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].url, 'http://127.0.0.1:8793/api/control/command');
  assert.deepEqual(f.calls[0].body, start); assert.equal(result.command.state, 'queued'); assert.equal(result.command.createdAt, NOW);
  assert.equal(JSON.stringify(result).includes('private-generation'), false);
});

test('both sources known secrets are redacted before truncating history or forwarding errors', async () => {
  let fail = false;
  const f = fixture(url => {
    if (fail) return Response.json({ error: `problem ${configs['test.json'].apiKey}` }, { status: 409 });
    const s = status(); s.sent[0].text = `hello ${configs['test.json'].apiKey} ${configs['primary.json'].pairingToken}`;
    s.error = 'Bearer sensitive-value'; return Response.json(s);
  });
  const snapshot = await f.manager.snapshot(), text = JSON.stringify(snapshot);
  assert.equal(text.includes('sensitive-value'), false); assert.equal(text.includes(configs['test.json'].apiKey), false);
  assert.match(snapshot.instances[0].sent[0].text, /redacted/);
  fail = true; await assert.rejects(f.manager.command('primary', start), error => error.status === 409 && !error.message.includes(configs['test.json'].apiKey));
});

test('oversized or malformed responses cannot populate an account page', async () => {
  for (const response of [() => new Response('x'.repeat(256001)), () => Response.json({ ok: true, authorized: true, connected: true, account: 'bad account', channel: 'test_channel' })]) {
    const f = fixture(response); assert.equal((await f.manager.snapshot()).instances.every(x => !x.available), true);
  }
});

test('a status read started before a command cannot replace the newer snapshot cache', async () => {
  let enter, release, reads = 0;
  const entered = new Promise(resolve => { enter = resolve; }), delayed = new Promise(resolve => { release = resolve; });
  const f = fixture(async url => {
    if (url.pathname.endsWith('/command')) return Response.json({ ok: true, command: job() });
    const s = status(); s.settings.paused = ++reads > 1;
    if (reads === 1) { enter(); await delayed; }
    return Response.json(s);
  }, { sources: [sources[0]] });
  const old = f.manager.snapshot(); await entered; await f.manager.command('primary', start);
  const fresh = await f.manager.snapshot(); assert.equal(fresh.instances[0].settings.paused, true);
  release(); await old;
  assert.equal(await f.manager.snapshot(), fresh);
});

test('helper pending arrays and ISO times normalize to the public single-operation shape', async () => {
  const f = fixture(() => { const s = status(); s.controls.pending = [job(), { ...job({ requestId: 'owner-stop-1', action: 'stop', params: {} }), id: 'stop-job' }];
    s.drops = { enabled: true, lastCheck: NOW, history: [{ at: NOW, name: 'Test drop', delivery: 'confirmed', reason: configs['test.json'].apiKey }] };
    return Response.json(s); });
  const s = (await f.manager.snapshot()).instances[0];
  assert.equal(s.controls.pending.action, 'stop'); assert.equal(s.controls.pending.createdAt, NOW);
  assert.equal(s.drops.lastCheckAt, NOW); assert.equal(s.drops.history[0].name, 'Test drop'); assert.match(s.drops.history[0].reason, /redacted/);
});
