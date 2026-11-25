import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHelper } from '../server.mjs';
import { ChatSendHolds } from '../lib/chat-holds.mjs';

const ACCOUNT = 'fixture_companion', CHANNEL = 'live_channel', PORT = 8793;
async function fixture(t) {
  let connected = true, channel = CHANNEL, prepare;
  const holds = new ChatSendHolds(); holds.hold(ACCOUNT, CHANNEL);
  let modelCalls = 0;
  const twitch = { status: () => ({ authorized: true, account: ACCOUNT, channel, connected }), disconnect: () => { connected = false; channel = ''; },
    sendHold: (account = ACCOUNT, target = channel) => holds.status(account, target), clearSendHold: (account, target) => holds.clear(account, target),
    connect: async (account, target, { beforeConnect = () => {} } = {}) => { if (account !== ACCOUNT) throw Error('Wrong account.'); await prepare?.(); beforeConnect(); connected = true; channel = target; return { connecting: true }; } };
  const server = createHelper({ config: { extensionId: 'fixture-extension', pairingToken: 'fixture-token', apiKey: 'fixture-model' }, twitch,
    generateImpl: async () => { modelCalls++; return {}; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const control = server.control, state = () => ({ settings: { allowedChannel: CHANNEL, paused: false, autoReply: true }, watch: { enabled: true, channel: CHANNEL, status: 'playing', checkedAt: Date.now() }, permissions: { playbackAccess: true } });
  const bridge = () => control.bridge({ sessionId: 'fixture-session', controlGeneration: control.generation, state: state() }); bridge(); bridge();
  const input = extra => ({ account: ACCOUNT, channel: CHANNEL, controlSessionId: 'fixture-session', controlGeneration: control.generation, ...extra });
  const request = (path, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { Host: `127.0.0.1:${PORT}`, Origin: 'chrome-extension://fixture-extension', Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', value => text += value); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }); req.on('error', reject); req.end(JSON.stringify(body));
  });
  const start = () => { const job = control.command({ requestId: `start-${control.generation}`, action: 'start', params: { channel: CHANNEL, chatMode: 'participate', replySource: 'local', autoResume: true } }).command; bridge(); bridge(); return job; };
  return { holds, twitch, control, request, input, start, bridge, modelCalls: () => modelCalls, prepare: fn => { prepare = fn; } };
}

test('a valid running owner Start clears only its selected account/channel hold after the generation guard', async t => {
  const f = await fixture(t); f.holds.hold(ACCOUNT, 'other_channel'); const job = f.start();
  const result = await f.request('/api/twitch/connect', f.input({ controlCommandId: job.id }));
  assert.equal(result.status, 200); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, false); assert.equal(f.holds.status(ACCOUNT, 'other_channel').held, true);
});

test('ordinary recovery Connect preserves the hold; explicit native Connect may clear it', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/twitch/connect', f.input())).status, 200); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, true);
  assert.equal((await f.request('/api/twitch/connect', f.input({ explicitStart: true }))).status, 200); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, false);
});

test('Stop invalidates a pending owner Start before its clear callback and does not unblock sending', async t => {
  const f = await fixture(t); const job = f.start(); let release;
  f.prepare(() => new Promise(resolve => { release = resolve; }));
  const connecting = f.request('/api/twitch/connect', f.input({ controlCommandId: job.id }));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  f.control.command({ requestId: 'stop-during-start', action: 'stop', params: {} }); release();
  assert.equal((await connecting).status, 409); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, true); assert.equal(f.control.stopped, true);
});

test('failed hold clearing still permits read/watch connection while all sending remains held', async t => {
  const f = await fixture(t); f.holds.file = 'fixture-file'; f.holds.write = () => { throw Error('Storage unavailable.'); };
  const job = f.start(); const result = await f.request('/api/twitch/connect', f.input({ controlCommandId: job.id }));
  assert.equal(result.status, 200); assert.equal(f.twitch.status().connected, true); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, true);
  f.bridge(); assert.match(f.control.status().activity.reason, /safety state/);
});

test('a held helper rejects model generation before any provider call and reports waiting without stopping playback', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/compose', { account: ACCOUNT, channel: CHANNEL, mode: 'reply' })).status, 409); assert.equal(f.modelCalls(), 0);
  const status = f.control.status(); assert.equal(status.activity.state, 'waiting'); assert.match(status.activity.reason, /follower requirement/); assert.equal(status.watch.status, 'playing'); assert.equal(status.connected, true);
});
