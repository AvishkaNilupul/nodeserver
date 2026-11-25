import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostCoordinator } from '../lib/host-coordinator.mjs';
import { messageKey } from '../extension/message-policy.js';
import { TwitchChat } from '../lib/twitch.mjs';

const now = 1_800_000_000_000;
const config = { url: 'http://127.0.0.1:8795', clientId: 'primary', account: 'companion_test', token: 'central-host-test-token-not-real-1234567890' };
const snapshot = { available: true, paused: false, reason: '', textKeys: [], topicStreams: [], replyIds: [], accounts: ['companion_test', 'other_companion'] };
const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const observation = (extra = {}) => ({ channel: 'friend_channel', paused: false, autoReply: true,
  playback: { enabled: true, channel: 'friend_channel', status: 'playing', checkedAt: now }, ...extra });
async function harness(t, fetchImpl, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'companion-host-client-')); const outboxFile = join(directory, 'completions.json');
  const client = new HostCoordinator({ config, outboxFile, now: () => now, fetchImpl, autoStart: false, ...extra });
  t.after(() => client.close()); t.after(() => rm(directory, { recursive: true, force: true }));
  return { client, outboxFile };
}

test('host offers are cached only for their own route, label, recipient and current due window', async t => {
  let time = now;
  const offer = { id: 'exchange-turn', key: 'exchange:exchange-turn', account: config.account, channel: 'friend_channel',
    streamId: '123456789', text: '[companion bot] @other_companion a short chat break.', notBefore: now + 1000, expiresAt: now + 2000 };
  let returned = offer;
  const h = await harness(t, async () => json({ ok: true, snapshot: { ...snapshot, exchange: returned } }), { now: () => time });
  const refresh = () => h.client.refresh({ channel: 'friend_channel', connected: true, observation: observation() });
  await refresh(); assert.equal(h.client.snapshot('friend_channel').exchange, undefined);
  time += 1000; assert.deepEqual(h.client.snapshot('friend_channel').exchange, offer);
  time += 1000; assert.equal(h.client.snapshot('friend_channel').exchange, undefined);
  time = now + 1000;
  for (const change of [{ account: 'other_companion' }, { channel: 'another_channel' }, { key: 'exchange:wrong' },
    { text: 'untagged offer' }, { text: '[companion bot] @unregistered hello' }]) {
    returned = { ...offer, ...change }; await refresh();
    assert.equal(h.client.snapshot('friend_channel').exchange, undefined);
    assert.equal(h.client.snapshot('friend_channel').available, true);
  }
});

test('only armed ready participation forwards sanitized exchange context and mode changes clear it', async t => {
  const calls = [];
  const h = await harness(t, async (_url, options) => { calls.push(JSON.parse(options.body)); return json({ ok: true, snapshot }); });
  const context = { streamId: '123456789', checkedAt: now - 60_000, lastHumanAt: now - 100_000, messages: ['never leave the helper'] };
  await h.client.refresh({ channel: 'friend_channel', connected: true,
    observation: observation({ chatMode: 'participate', exchangeContext: context }) });
  assert.deepEqual(calls.at(-1).exchangeContext, { streamId: context.streamId, checkedAt: context.checkedAt, lastHumanAt: context.lastHumanAt });
  assert.equal(JSON.stringify(calls.at(-1)).includes('never leave'), false);
  for (const extra of [{ chatMode: 'mentions' }, { paused: true }, { autoReply: false },
    { exchangeContext: { ...context, checkedAt: now - 120_001 } }, { exchangeContext: { ...context, lastHumanAt: now + 1 } },
    { playback: { enabled: true, channel: 'friend_channel', status: 'paused', checkedAt: now } }]) {
    await h.client.refresh({ observation: observation({ chatMode: 'participate', exchangeContext: context, ...extra }) });
    assert.equal(calls.at(-1).exchangeContext, null, JSON.stringify(extra));
  }
});

test('an exchange reserve binds its opaque turn ID while forwarding only a text fingerprint', async t => {
  const calls = [];
  const h = await harness(t, async (url, options) => { calls.push({ url, body: JSON.parse(options.body) });
    return json(url.endsWith('/sync') ? { ok: true, snapshot } : { ok: true, reservationId: 'exchange-permit', expiresAt: now + 20000 }); });
  await h.client.reserve({ account: config.account, channel: 'friend_channel', text: '[companion bot] @other_companion hello',
    streamId: '123456789', kind: 'exchange', exchangeId: 'opaque-turn-id' });
  const body = calls.find(x => x.url.endsWith('/reserve')).body;
  assert.equal(body.exchangeId, 'opaque-turn-id'); assert.equal(body.kind, 'exchange'); assert.equal(body.replyId, '');
  assert.equal('replyAt' in body, false); assert.equal('text' in body, false);
  assert.equal(body.textKey, messageKey('[companion bot] @other_companion hello'));
  for (const code of ['exchange_wait', 'exchange_quiet', 'exchange_spacing', 'exchange_priority']) assert.equal(h.client.hold(code, 'wait').retryable, true);
});

test('host pairing accepts only the fixed loopback destination and exact account binding', async t => {
  const h = await harness(t, async () => json({ ok: true, snapshot }));
  assert.throws(() => h.client.register('someone_else'), /does not match/);
  for (const url of ['https://example.com', 'http://localhost:8795', 'http://127.0.0.1:1234']) {
    assert.throws(() => new HostCoordinator({ config: { ...config, url }, outboxFile: h.outboxFile, autoStart: false }), /pairing/);
  }
});

test('a fresh disconnected Twitch client reports its synchronized empty-channel host status as available', async t => {
  const h = await harness(t, async () => json({ ok: true, snapshot }));
  const twitch = new TwitchChat({ credentials: { account: config.account }, coordinator: h.client });
  assert.equal(twitch.channel, undefined, 'this is the untouched constructor state, not a prior disconnect');
  await twitch.refreshCoordination();
  const state = twitch.status();
  assert.equal(state.channel, ''); assert.equal(state.connected, false); assert.equal(state.coordination.available, true);
  assert.equal(h.client.snapshot(undefined).available, true); assert.equal(h.client.snapshot('').available, true);
});

test('sync reports current ready playback and only own message fingerprints', async t => {
  const calls = [];
  const h = await harness(t, async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return json({ ok: true, snapshot }); });
  h.client.seed([{ account: config.account, channel: 'friend_channel', at: now - 1000, text: 'an original public greeting', delivery: 'confirmed' },
    { account: 'other_account', channel: 'friend_channel', at: now - 1000, text: 'not ours', delivery: 'confirmed' }]);
  await h.client.refresh({ channel: 'friend_channel', connected: true, observation: observation() });
  const call = calls.at(-1);
  assert.equal(call.body.ready, true); assert.equal(call.body.connected, true);
  assert.equal(call.body.seed.length, 1); assert.equal(call.body.seed[0].textKey, messageKey('an original public greeting'));
  assert.equal(JSON.stringify(call.body).includes('an original public greeting'), false);
  assert.equal(JSON.stringify(call.body).includes(config.token), false);
  assert.equal(call.options.headers['X-Companion-Id'], 'primary'); assert.equal(call.options.redirect, 'error');
  assert.equal(h.client.snapshot('friend_channel').available, true);
  assert.equal(h.client.snapshot('another_channel').available, false);
});

test('stale, disabled, mismatched, paused or absent playback never reports automatic readiness', async t => {
  const calls = []; const h = await harness(t, async (_url, options) => { calls.push(JSON.parse(options.body)); return json({ ok: true, snapshot }); });
  for (const bad of [null, observation({ paused: true }), observation({ autoReply: false }),
    observation({ playback: { enabled: true, channel: 'friend_channel', status: 'playing', checkedAt: now - 45001 } }),
    observation({ playback: { enabled: false, channel: 'friend_channel', status: 'playing', checkedAt: now } }),
    observation({ playback: { enabled: true, channel: 'other_channel', status: 'playing', checkedAt: now } }),
    observation({ playback: { enabled: true, channel: 'friend_channel', status: 'paused', checkedAt: now } })]) {
    await h.client.refresh({ channel: 'friend_channel', connected: true, observation: bad });
    assert.equal(calls.at(-1).ready, false);
  }
});

test('host outage is explicit non-submission and never falls back to the old database', async t => {
  const h = await harness(t, async () => { throw Error(`private transport detail ${config.token}`); });
  const result = await h.client.reserve({ account: config.account, channel: 'friend_channel', text: 'hello' });
  assert.equal(result.ok, false); assert.match(result.reason, /unavailable/);
  assert.equal(JSON.stringify(result).includes(config.token), false);
  assert.equal(h.client.snapshot('friend_channel').available, false);
});

test('reserve sends only hash intent and begin denial remains a not-submitted hold', async t => {
  const calls = [];
  const h = await harness(t, async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, body });
    if (url.endsWith('/sync')) return json({ ok: true, snapshot });
    if (url.endsWith('/reserve')) return json({ ok: true, reservationId: 'reserved-1', expiresAt: now + 20000, snapshot });
    return json({ ok: false, code: 'expired', reason: 'Turn expired.' });
  });
  const claim = await h.client.reserve({ account: config.account, channel: 'friend_channel', text: 'hello everyone', kind: 'conversation', streamId: '123456789', replyTo: 'fresh-target', replyAt: now - 1000 });
  assert.equal(claim.ok, true); const proposal = calls.find(x => x.url.endsWith('/reserve')).body;
  assert.equal(proposal.textKey, messageKey('hello everyone')); assert.equal('text' in proposal, false);
  assert.equal(proposal.replyId, 'fresh-target'); assert.equal(proposal.replyAt, now - 1000);
  assert.match(proposal.requestId, /^[a-zA-Z0-9-]+$/);
  assert.deepEqual(await h.client.begin(claim.reservationId), { ok: false, code: 'expired', retryable: true, reason: 'Turn expired.' });
});

test('shared hold codes distinguish retryable no-send turns from permanent covered opportunities', async t => {
  const h = await harness(t, async () => json({ ok: true, snapshot }));
  for (const code of ['busy', 'turn_wait', 'channel_cooldown', 'channel_budget', 'not_ready', 'paused', 'unavailable', 'channel_limit']) {
    assert.equal(h.client.hold(code, 'waiting').retryable, true, code);
  }
  for (const code of ['duplicate', 'answered', 'topic_taken', 'already_used', 'unknown', 'target_expired', 'companion_message']) {
    assert.equal(h.client.hold(code, 'covered').retryable, false, code);
  }
});

test('an unacknowledged no-send cancellation holds new proposals transiently until replay', async t => {
  const calls = []; const h = await harness(t, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    if (url.endsWith('/finish')) throw Error('finish temporarily unavailable');
    return json({ ok: true, snapshot });
  });
  await h.client.finish('unused-turn', 'cancelled');
  const result = await h.client.reserve({ account: config.account, channel: 'friend_channel', text: 'hello', replyTo: 'fresh-message', replyAt: now - 1000 });
  assert.equal(result.retryable, true); assert.equal(result.code, 'unavailable');
  assert.equal(calls.some(x => x.url.endsWith('/reserve')), false);
});

test('confirmed completion is durable across host outage/restart and its replay is idempotent', async t => {
  const first = await harness(t, async () => { throw Error('offline'); });
  await first.client.finish('reserved-1', 'confirmed');
  const pending = JSON.parse(await readFile(first.outboxFile, 'utf8'));
  assert.equal(pending.pending[0].delivery, 'confirmed'); assert.equal((await stat(first.outboxFile)).mode & 0o777, 0o600);
  first.client.close(); const calls = [];
  const restarted = new HostCoordinator({ config, outboxFile: first.outboxFile, now: () => now, autoStart: false,
    fetchImpl: async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return json({ ok: true, snapshot }); } });
  t.after(() => restarted.close()); await restarted.refresh({ channel: '', connected: false });
  assert.equal(calls.filter(x => x.url.endsWith('/finish')).length, 1);
  await restarted.finish('reserved-1', 'unknown'); await restarted.finish('reserved-1', 'confirmed');
  assert.equal(calls.filter(x => x.url.endsWith('/finish')).length, 1);
  assert.deepEqual(JSON.parse(await readFile(first.outboxFile, 'utf8')).pending, []);
});

test('known rejection or cancellation cannot be overwritten by a later unknown completion', async t => {
  const h = await harness(t, async () => { throw Error('offline'); });
  for (const outcome of ['rejected', 'cancelled']) {
    await h.client.finish(`reservation-${outcome}`, outcome);
    await h.client.finish(`reservation-${outcome}`, 'unknown');
  }
  const saved = JSON.parse(await readFile(h.outboxFile, 'utf8'));
  assert.deepEqual(saved.pending.map(x => x.delivery), ['rejected', 'cancelled']);
  assert.equal(saved.pending.find(x => x.delivery === 'cancelled').submitted, false);
});

test('durable own send history reconstructs a missing completion and avoids redundant replay', async t => {
  const calls = []; const h = await harness(t, async (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return json({ ok: true, snapshot }); });
  h.client.seed([{ account: config.account, channel: 'friend_channel', at: now - 1000, text: 'published message', delivery: 'confirmed', coordinationId: 'reserved-history' }]);
  await h.client.refresh({ channel: 'friend_channel', connected: true }); await h.client.refresh();
  assert.equal(calls.filter(x => x.url.endsWith('/finish')).length, 1);
  const seeded = calls.find(x => x.url.endsWith('/sync')).body.seed[0];
  assert.equal(seeded.coordinationId, 'reserved-history'); assert.equal(seeded.delivery, 'confirmed');
});
