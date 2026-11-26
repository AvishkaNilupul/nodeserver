import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { messageKey } from '../extension/message-policy.js';
import { LocalControl, commandInput } from '../lib/local-control.mjs';
import { createHelper } from '../server.mjs';
const START = 1800000000000, sessionId = 'worker-session-one';
const start = { channel: 'sample_channel', chatMode: 'participate', replySource: 'local', autoResume: true };
function fixture() {
  let time = START, disconnected = 0;
  const twitch = { status: () => ({ account: 'sample_account', authorized: true, connected: true, channel: 'sample_channel', messages: [], sent: [] }), disconnect: () => disconnected++ };
  const c = new LocalControl({ twitch, now: () => time, secrets: ['PAIR_PRIVATE', 'PROVIDER_PRIVATE', 'EXTENSION_PRIVATE'] });
  const bridge = (extra = {}) => c.bridge({ sessionId, controlGeneration: c.generation, ...extra });
  const command = (action, params = {}, requestId = randomUUID()) => c.command({ requestId, action, params });
  bridge();
  return { c, twitch, bridge, command, advance: ms => time += ms, disconnected: () => disconnected };
}
async function harness(t, overrides = {}) {
  let time = START, connected = false;
  const calls = [];
  const twitch = { status: () => ({ account: 'sample_account', authorized: true, connected, channel: connected ? 'sample_channel' : '', messages: [], sent: [] }),
    disconnect: () => { calls.push('disconnect'); connected = false; },
    connect: async () => { calls.push('connect'); connected = true; return { connecting: true }; },
    send: async () => { calls.push('send'); return { delivery: 'confirmed' }; }, ...overrides };
  const server = createHelper({ config: { extensionId: 'unit-test', pairingToken: 'PAIR_PRIVATE', apiKey: 'PROVIDER_PRIVATE' }, twitch, now: () => time });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = (path, input = {}, extra = {}) => new Promise((resolve, reject) => {
    if (path === '/api/twitch/send' && typeof input.text === 'string') {
      const binding = { generation: input.controlGeneration, sessionId: input.controlSessionId, settingsRevision: 0 };
      const plan = { planId: 'explicit-test-plan', authorityEpoch: 'test-authority', source: 'manual', account: input.account,
        channel: input.channel, text: input.text, kind: '', streamId: '', category: '', participationKey: '', replyId: '', replyAuthor: '',
        textKey: messageKey(input.text), exactKey: createHash('sha256').update(input.text).digest('hex'), binding };
      twitch.coordinator ||= {};
      twitch.coordinator.currentPlan = id => id === plan.planId ? plan : null;
      input = { ...input, settingsRevision: 0, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding };
    }
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { Host: '127.0.0.1:8797', Origin: 'chrome-extension://unit-test', Authorization: 'Bearer PAIR_PRIVATE', 'Content-Type': 'application/json', ...extra } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }); req.on('error', reject); req.end(JSON.stringify(input));
  });
  const bridge = async extra => (await request('/api/control/bridge', { sessionId, controlGeneration: server.control.generation, state: { settings: { revision: 0, allowedChannel: 'sample_channel', paused: false, autoReply: false } }, ...extra })).body;
  await bridge();
  return { server, twitch, request, bridge, calls, advance: ms => time += ms };
}

test('typed command parser refuses unknown actions, private settings, coercion and unreviewed messages', () => {
  for (const raw of [
    { action: 'arbitrary-worker-message', params: {} },
    { action: 'start', params: { ...start, account: 'other_account' } },
    { action: 'settings', params: { channel: 'another_channel', chatMode: 'mentions', replySource: 'local', autoResume: false } },
    { action: 'start', params: { ...start, autoResume: 'yes' } },
    { action: 'stop', params: { force: true } },
    { action: 'send', params: { text: '/ban someone' } },
    { action: 'send', params: { text: 'x'.repeat(301) } }
  ]) assert.throws(() => commandInput({ requestId: randomUUID(), ...raw }));
});

test('request IDs are idempotent for canonical typed parameters and conflict on changed intent', () => {
  const f = fixture(), requestId = randomUUID();
  const first = f.command('start', start, requestId).command;
  const again = f.command('start', { replySource: 'local', channel: 'sample_channel', autoResume: true, chatMode: 'participate' }, requestId).command;
  assert.equal(again.id, first.id); assert.equal(f.disconnected(), 1);
  assert.throws(() => f.command('stop', {}, requestId), { status: 409 });
});

test('one non-Stop command is claimed once and never replayed after missing completion', () => {
  const f = fixture(); f.command('draft', { mode: 'reply' });
  assert.throws(() => f.command('watch'), { status: 409 });
  const claimed = f.bridge().command; assert.equal(claimed.state, 'running');
  assert.equal(f.bridge().command, undefined);
  f.advance(90001); assert.equal(f.bridge().command, undefined);
  assert.equal(f.c.status().controls.recent[0].state, 'expired');
});

test('Stop immediately disconnects, cancels a running Start and denies its late completion and old credentials', () => {
  const f = fixture(), first = f.command('start', start).command;
  f.bridge(); const old = { controlGeneration: first.generation, controlSessionId: sessionId };
  assert.doesNotThrow(() => f.c.guard(old));
  const stop = f.command('stop').command;
  assert.equal(f.disconnected(), 2); assert.equal(f.c.stopped, true);
  assert.throws(() => f.c.guard(old), { status: 409 });
  f.bridge({ completion: { id: first.id, generation: first.generation, state: 'completed', result: { ok: true } } });
  assert.equal(f.c.status().controls.recent.find(x => x.id === first.id).state, 'cancelled');
  assert.equal(f.c.status().settings.paused, true);
  assert.equal(f.c.status().controls.recent.find(x => x.id === stop.id).state, 'running');
});

test('an expired or failed Start disarms and requires a newer explicit Start', () => {
  for (const failure of ['expired', 'failed']) {
    const f = fixture(), first = f.command('start', start).command; f.bridge();
    if (failure === 'expired') { f.advance(90001); f.c.status(); }
    else f.bridge({ completion: { id: first.id, generation: first.generation, state: 'failed', error: 'No playback access.' } });
    assert.equal(f.c.stopped, true);
    f.bridge(); const next = f.command('start', start).command;
    assert.notEqual(next.generation, first.generation); assert.equal(f.c.stopped, false);
  }
});

test('Stop remains enforced after its queued cleanup expires with the browser closed', () => {
  const f = fixture(); f.advance(46000);
  assert.throws(() => f.command('watch'), { status: 503 });
  const stop = f.command('stop').command; assert.equal(stop.state, 'queued');
  f.advance(90001); assert.equal(f.c.status().controls.recent[0].state, 'expired');
  assert.equal(f.c.stopped, true); assert.equal(f.c.status().browser.online, false);
});

test('new browser sessions cannot replay running sends, and retired session polls cannot reclaim the bridge', () => {
  const f = fixture(), send = f.command('send', { text: 'a reviewed message' }).command;
  f.bridge(); const next = f.bridge({ sessionId: 'worker-session-two' });
  assert.equal(next.command, undefined);
  const prior = f.c.status().controls.recent.find(x => x.id === send.id);
  assert.equal(prior.state, 'cancelled'); assert.match(prior.error, /uncertain|not be replayed/);
  f.command('watch');
  assert.equal(f.bridge().command, undefined, 'retired session cannot take a new command');
  assert.equal(f.bridge({ sessionId: 'worker-session-two' }).command.action, 'watch');
});

test('stale browser state cannot overwrite a Stop hold or leak private nested data', () => {
  const f = fixture(); const before = f.c.generation; f.command('stop');
  f.bridge({ controlGeneration: before, state: { settings: { paused: false, autoReply: true, pairingToken: 'PAIR_PRIVATE' }, watch: { enabled: true } } });
  const state = f.c.status(); assert.equal(state.settings.paused, true); assert.equal(state.settings.autoReply, false);
  assert.equal(state.watch.enabled, false);
});

test('control snapshot is bounded and copies public fields while redacting provider diagnostics and secrets', () => {
  const f = fixture();
  f.twitch.status = () => ({ account: 'sample_account', authorized: true, connected: true, channel: 'sample_channel',
    accessToken: 'RAW_PRIVATE', credentials: { apiKey: 'PROVIDER_PRIVATE' }, error: 'Bearer abcdefghijklmnop PAIR_PRIVATE /Users/name/private/config.json',
    messages: Array.from({ length: 200 }, (_, i) => ({ id: String(i), author: 'public_author', text: 'public chat PROVIDER_PRIVATE', at: START, refreshToken: 'RAW_PRIVATE' })),
    sent: Array.from({ length: 100 }, () => ({ text: 'hello PAIR_PRIVATE', at: START, delivery: 'confirmed', accessToken: 'RAW_PRIVATE' })),
    coordination: { available: true, reason: 'oauth:secretvalue', pairingToken: 'PAIR_PRIVATE', accounts: ['sample_account'] } });
  f.bridge({ state: { settings: { allowedChannel: 'sample_channel', autoReply: true, pairingToken: 'PAIR_PRIVATE', clientId: 'RAW_PRIVATE' },
    watch: { enabled: true, status: 'playing', channel: 'sample_channel', checkedAt: START, error: 'apiKey: PROVIDER_PRIVATE', tabId: 123 },
    streamContext: { isLive: true, streamId: '123', title: 'Public title', credentials: 'RAW_PRIVATE' },
    drops: { enabled: true, tabId: 123, history: [{ name: 'Public reward', delivery: 'confirmed', key: 'PRIVATE_INTERNAL_KEY' }] }, permissions: { playbackAccess: true } } });
  const state = f.c.status(), json = JSON.stringify(state);
  for (const forbidden of ['PAIR_PRIVATE', 'PROVIDER_PRIVATE', 'RAW_PRIVATE', 'PRIVATE_INTERNAL_KEY', 'accessToken', 'refreshToken', 'pairingToken', 'clientId', 'tabId', '/Users/name']) assert.ok(!json.includes(forbidden), forbidden);
  assert.equal(state.chat.messages.length, 60); assert.equal(state.sent.length, 50);
  assert.equal(state.chat.digest.messages, 60); assert.equal(state.drops.history[0].name, 'Public reward');
  assert.equal(state.permissions.playbackAccess, true);
});

test('new control APIs retain original paired Host, Origin and bearer restrictions', async t => {
  const h = await harness(t);
  for (const path of ['/api/control/status', '/api/control/command', '/api/control/bridge']) {
    for (const [headers, status] of [[{ Host: 'evil.example' }, 403], [{ Origin: 'http://127.0.0.1:8795' }, 403], [{ Authorization: 'Bearer wrong' }, 401]]) {
      assert.equal((await h.request(path, {}, headers)).status, status);
    }
  }
});

test('real HTTP Start flow has generation-bound disarm/connect and Stop blocks stale connect/send', async t => {
  const h = await harness(t);
  const response = await h.request('/api/control/command', { requestId: randomUUID(), action: 'start', params: start });
  assert.equal(response.status, 200); const cmd = response.body.command;
  assert.equal((await h.bridge()).command.id, cmd.id);
  const bound = { controlGeneration: cmd.generation, controlSessionId: sessionId };
  assert.equal((await h.request('/api/twitch/disconnect', { ...bound, disarmOnly: true })).status, 200);
  assert.equal((await h.request('/api/twitch/connect', { ...bound, account: 'sample_account', channel: 'sample_channel' })).status, 200);
  const stopped = await h.request('/api/control/command', { requestId: randomUUID(), action: 'stop', params: {} });
  assert.equal(stopped.status, 200);
  assert.equal((await h.request('/api/twitch/connect', { ...bound, account: 'sample_account', channel: 'sample_channel' })).status, 409);
  assert.equal((await h.request('/api/twitch/send', { ...bound, text: 'old message' })).status, 409);
  assert.equal(h.calls.filter(x => x === 'send').length, 0);
  assert.equal((await h.request('/api/control/status')).body.connected, false);
});

test('Stop interrupts slow connection and its late resolve cannot reconnect the helper', async t => {
  let release, connected = false;
  const h = await harness(t, { status: () => ({ account: 'sample_account', connected }), disconnect: () => connected = false,
    connect: () => new Promise(resolve => { release = () => { connected = true; resolve({ connecting: true }); }; }) });
  const bound = { controlGeneration: h.server.control.generation, controlSessionId: sessionId };
  const pending = h.request('/api/twitch/connect', { ...bound, account: 'sample_account', channel: 'sample_channel' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const stop = await h.request('/api/control/command', { requestId: randomUUID(), action: 'stop', params: {} }); assert.equal(stop.status, 200);
  release(); assert.equal((await pending).status, 409); assert.equal(connected, false);
});

test('explicit native Connect requires current fresh session, rotates hold and cannot win against newer Stop', async t => {
  const h = await harness(t); await h.request('/api/twitch/disconnect');
  const current = await h.bridge(), bound = { controlGeneration: current.intent.generation, controlSessionId: sessionId };
  assert.equal((await h.request('/api/twitch/connect', { ...bound, explicitStart: true, account: 'wrong_account', channel: 'sample_channel' })).status, 403);
  assert.equal((await h.request('/api/twitch/connect', { ...bound, explicitStart: true, account: 'sample_account', channel: 'sample_channel', controlSessionId: 'old-worker' })).status, 409);
  const connected = await h.request('/api/twitch/connect', { ...bound, explicitStart: true, account: 'sample_account', channel: 'sample_channel' });
  assert.equal(connected.status, 200); assert.notEqual(connected.body.intent.generation, bound.controlGeneration);
  assert.equal(connected.body.intent.stopped, false);
  await h.request('/api/twitch/disconnect');
  assert.equal((await h.request('/api/twitch/connect', { ...bound, explicitStart: true, account: 'sample_account', channel: 'sample_channel' })).status, 409);
  assert.equal((await h.request('/api/control/status')).body.connected, false);
});


test('control HTTP failures redact private provider diagnostics even when snapshot collection throws', async t => {
  const h = await harness(t, { status: () => { throw new Error('upstream PROVIDER_PRIVATE Bearer private-value /Users/name/private/config.json'); } });
  const result = await h.request('/api/control/status');
  assert.equal(result.status, 502);
  assert.doesNotMatch(JSON.stringify(result.body), /PROVIDER_PRIVATE|private-value|\/Users\/name/);
});

test('hosted send ID binds exact text and expires at the final provider boundary after async begin', async t => {
  const { TwitchChat } = await import('../lib/twitch.mjs');
  let time = START, providerCalls = 0, h;
  const finishes = [];
  const twitch = new TwitchChat({ credentials: { account: 'sample_account', userId: '123' }, now: () => time });
  twitch.connected = true; twitch.channel = 'sample_channel'; twitch.broadcasterId = '456'; twitch.ensureIdentity = async () => {};
  twitch.saveHistory = async history => { if (history.at(-1)?.delivery === 'cancelled') throw new Error('fixture history storage failed'); };
  twitch.api = async path => { if (path.startsWith('shared_chat/')) return { data: [] }; providerCalls++; return { data: [{ is_sent: true, message_id: 'never' }] }; };
  twitch.coordinator = { reserve: async () => ({ ok: true, reservationId: 'local-manual-permit' }),
    begin: async () => { time += 90001; h.advance(90001); return { ok: true }; }, finish: (...args) => finishes.push(args) };
  h = await harness(t, { status: () => twitch.status(), disconnect: () => twitch.disconnect(), send: input => twitch.send(input), coordinator: twitch.coordinator });
  // status() needs only the regular coordination snapshot, with no raw host data.
  twitch.coordinator.snapshot = () => ({ available: true, accounts: ['sample_account'] });
  const queued = await h.request('/api/control/command', { requestId: randomUUID(), action: 'send', params: { text: 'exact reviewed text' } });
  const cmd = (await h.bridge()).command; assert.equal(cmd.id, queued.body.command.id);
  const bound = { account: 'sample_account', channel: 'sample_channel', controlGeneration: cmd.generation, controlSessionId: sessionId, controlCommandId: cmd.id };
  assert.equal((await h.request('/api/twitch/send', { ...bound, text: 'changed reviewed text' })).status, 409);
  const result = await h.request('/api/twitch/send', { ...bound, text: 'exact reviewed text', beforeSubmit: 'untrusted JSON cannot replace the callback' });
  assert.equal(result.status, 200); assert.equal(result.body.delivery, 'cancelled'); assert.equal(result.body.submitted, false);
  assert.equal(providerCalls, 0); assert.deepEqual(finishes, [['local-manual-permit', 'cancelled']]);
  assert.equal(twitch.history.at(-1).delivery, 'cancelled'); assert.equal(twitch.history.at(-1).submitted, false);
});

test('a held companion accepts safe view/preferences cleanup but rejects draft/send/claim operations immediately', () => {
  for (const action of ['draft', 'send', 'drops-enable', 'drops-check']) {
    const f = fixture(); f.command('stop');
    const params = action === 'draft' ? { mode: 'reply' } : action === 'send' ? { text: 'reviewed message' } : {};
    assert.throws(() => f.command(action, params), { status: 409 });
  }
  for (const [action, params] of [['watch', {}], ['settings', { chatMode: 'mentions', replySource: 'local', autoResume: true }], ['drops-disable', {}]]) {
    const f = fixture(); f.command('stop');
    assert.equal(f.command(action, params).command.state, 'queued');
    assert.equal(f.c.stopped, true);
  }
});
