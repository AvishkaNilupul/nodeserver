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

test('clip adapter accepts only fixed paired routes and sanitized matching jobs', async () => {
  const clip = { requestId: 'clip-1', account: 'first_account', channel: 'test_channel', streamId: '12345', source: 'manual',
    createdAt: NOW, updatedAt: NOW, state: 'confirmed', clipId: 'ExampleClipId', url: 'https://clips.twitch.tv/ExampleClipId', error: '' };
  const f = fixture((url, init) => {
    if (url.pathname === '/api/clips/status') return Response.json({ ok: true, account: 'first_account', authorized: true, jobs: [{ ...clip, error: configs['test.json'].apiKey, accessToken: 'must-not-pass' }] });
    if (url.pathname === '/api/clips/create') return Response.json({ ok: true, job: clip });
    return Response.json({ ok: true, pending: true, verificationUrl: 'https://www.twitch.tv/activate', userCode: 'ABC-DEF', pollAfterMs: 5000, accessToken: 'must-not-pass' });
  });
  const s = await f.manager.clipStatus('primary'); assert.equal(s.authorized, true); assert.equal(s.jobs[0].url, clip.url);
  assert.match(s.jobs[0].error, /redacted/); assert.doesNotMatch(JSON.stringify(s), /must-not-pass/);
  const input = { requestId: 'clip-1', channel: 'test_channel', streamId: '12345', source: 'manual' };
  assert.equal((await f.manager.clipCreate('primary', input)).job.requestId, input.requestId);
  assert.deepEqual(f.calls.at(-1).body, input);
  const auth = await f.manager.clipAuthorization('test', { action: 'start' });
  assert.equal(auth.userCode, 'ABC-DEF'); assert.doesNotMatch(JSON.stringify(auth), /must-not-pass/);
  const before = f.calls.length;
  await assert.rejects(f.manager.clipCreate('primary', { ...input, url: 'https://outside.example' }));
  await assert.rejects(f.manager.clipAuthorization('foreign', { action: 'start' }));
  await assert.rejects(f.manager.clipAuthorization('primary', { action: 'start', scopes: ['other'] }));
  assert.equal(f.calls.length, before);
});

test('clip adapter rejects mismatched creates, invalid status and foreign grant URLs', async () => {
  const f = fixture(url => Response.json(url.pathname.endsWith('/authorization')
    ? { ok: true, verificationUrl: 'https://outside.example/activate', userCode: 'ABC-DEF' }
    : url.pathname.endsWith('/create') ? { ok: true, job: { requestId: 'other-request' } }
    : { ok: true, account: 'bad account', authorized: true, jobs: [] }));
  await assert.rejects(f.manager.clipStatus('primary'), /invalid clip status/);
  await assert.rejects(f.manager.clipCreate('primary', { requestId: 'clip-1', channel: 'test_channel', streamId: '12345', source: 'manual' }), /did not confirm/);
  await assert.rejects(f.manager.clipAuthorization('primary', { action: 'start' }), /invalid authorization/);
});

test('third uses only its fixed paired helper and all three private values are redacted', async () => {
  const configs3 = { ...configs, 'third.json': { extensionId: 'c'.repeat(32), pairingToken: 'third-pairing-secret-value', apiKey: 'third-private-api-value' } };
  const calls = [], thirdSource = { id: 'third', configPath: 'third.json' };
  const manager = createAccountManager({ sources: [...sources, thirdSource], now: () => NOW,
    readFileImpl: async path => JSON.stringify(configs3[String(path)]), fetchImpl: async (url, init) => {
      const parsed = new URL(url), config = parsed.port === '8796' ? configs3['third.json'] : parsed.port === '8793' ? configs3['test.json'] : configs3['primary.json'];
      assert.equal(init.headers.Authorization, `Bearer ${config.pairingToken}`);
      assert.equal(init.headers.Origin, `chrome-extension://${config.extensionId}`); calls.push({ url, input: JSON.parse(init.body) });
      if (parsed.pathname.endsWith('/command')) return Response.json({ ok: true, command: job(JSON.parse(init.body)) });
      const value = status(parsed.port === '8796' ? 'third_account' : parsed.port === '8793' ? 'second_account' : 'first_account');
      value.error = Object.values(configs3).flatMap(x => Object.values(x)).join(' ');
      return Response.json(value);
    } });
  const result = await manager.snapshot(); assert.deepEqual(result.instances.map(x => x.id), ['primary', 'test', 'third']);
  assert.equal(result.instances[2].account, 'third_account');
  for (const value of Object.values(configs3).flatMap(x => Object.values(x))) assert.equal(JSON.stringify(result).includes(value), false);
  const command3 = { ...start, requestId: 'third-start-fixture' }; await manager.command('third', command3);
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:8796/api/control/command'); assert.deepEqual(calls.at(-1).input, command3);
  assert.throws(() => createAccountManager({ sources: [{ ...thirdSource, port: 8793 }] }), /Unsupported account source/);
  assert.throws(() => createAccountManager({ sources: [{ id: 'fourth', configPath: 'third.json', port: 8796 }] }), /Unsupported account source/);
});

test('Twitch device links preserve only documented activation parameters bound to the same user code', async () => {
  const code = 'ABCD1234';
  for (const verificationUrl of ['https://www.twitch.tv/activate', `https://www.twitch.tv/activate?device-code=${code}`, `https://www.twitch.tv/activate?public=true&device-code=${code}`]) {
    const f = fixture(() => Response.json({ ok: true, pending: true, verificationUrl, userCode: code }));
    assert.equal((await f.manager.clipAuthorization('primary', { action: 'poll' })).verificationUrl, verificationUrl);
  }
  for (const verificationUrl of ['https://www.twitch.tv:443/activate', 'https://www.twitch.tv/activate#', `https://www.twitch.tv/activate?device-code=DIFFERENT`, `https://www.twitch.tv/activate?device-code=${code}&device-code=${code}`, `https://www.twitch.tv/activate?public=false&device-code=${code}`, `https://www.twitch.tv/activate?redirect_uri=https://outside.example&device-code=${code}`, `https://www.twitch.tv/activate?device-code=${code}#fragment`, `https://www.twitch.tv:8443/activate?device-code=${code}`, `https://www.twitch.tv@outside.example/activate?device-code=${code}`]) {
    const f = fixture(() => Response.json({ ok: true, pending: true, verificationUrl, userCode: code }));
    await assert.rejects(f.manager.clipAuthorization('primary', { action: 'poll' }), /invalid authorization details/);
  }
});
