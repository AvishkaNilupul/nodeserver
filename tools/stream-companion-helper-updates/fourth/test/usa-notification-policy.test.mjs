import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFetch, MAX_REQUEST } from '../extension/usa-policy.js';
import { createUsTransport } from '../lib/usa-transport.mjs';

const endpoint = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const app = 'syntheticclient123';
const headers = [['Authorization', 'Bearer synthetic-user-token'], ['Client-Id', app], ['Content-Type', 'application/json']];
const subscription = (extra = {}) => ({ type: 'channel.chat.notification', version: '1',
  condition: { broadcaster_user_id: '123', user_id: '456' }, transport: { method: 'websocket', session_id: 'synthetic-session' }, ...extra });
const options = (body = subscription(), extra = {}) => ({ method: 'POST', headers, body: JSON.stringify(body), ...extra });

for (const type of ['channel.chat.message', 'channel.chat.notification']) {
  test(`existing exact viewer WebSocket request permits ${type} version1`, () => {
    const input = options(subscription({ type }));
    const result = validateFetch(endpoint, input);
    assert.equal(result.url, endpoint); assert.equal(result.method, 'POST'); assert.equal(result.body, input.body);
    assert.deepEqual(result.headers, [['authorization', 'Bearer synthetic-user-token'], ['client-id', app], ['content-type', 'application/json']]);
  });
}

test('notification addition never permits other EventSub subscriptions', () => {
  for (const type of ['channel.cheer', 'channel.subscribe', 'channel.subscription.gift', 'channel.raid', 'stream.online',
    'channel.chat.notification.extra', 'Channel.Chat.Notification', '', null]) {
    assert.throws(() => validateFetch(endpoint, options(subscription({ type }))), String(type));
  }
});

test('only exact string version1 with both numeric user conditions is accepted', () => {
  for (const version of ['2', 1, '', null]) assert.throws(() => validateFetch(endpoint, options(subscription({ version }))));
  for (const condition of [{ broadcaster_id: '123', user_id: '456' }, { broadcaster_user_id: '123' },
    { broadcaster_user_id: '123', user_id: '456', moderator_user_id: '789' },
    { broadcaster_user_id: '123', user_id: 456 }, { broadcaster_user_id: '123', user_id: 'viewer_login' },
    { broadcaster_user_id: '123', user_id: '456\n' }, { broadcaster_user_id: '9'.repeat(33), user_id: '456' }]) {
    assert.throws(() => validateFetch(endpoint, options(subscription({ condition }))));
  }
});

test('notification transport cannot become webhook, conduit or an extra callback authority', () => {
  for (const transport of [{ method: 'webhook', callback: 'https://other.example/hook', secret: 'synthetic-secret' },
    { method: 'conduit', conduit_id: 'synthetic-conduit' }, { method: 'websocket' },
    { method: 'websocket', session_id: '' }, { method: 'websocket', session_id: 'x'.repeat(201) },
    { method: 'websocket', session_id: 'synthetic-session', callback: 'https://other.example/hook' }]) {
    assert.throws(() => validateFetch(endpoint, options(subscription({ transport }))));
  }
});

test('notification still requires the fixed endpoint, POST and bounded authenticated headers', () => {
  for (const url of [endpoint + '?type=channel.chat.notification', endpoint.replace('api.twitch.tv', 'other.example'),
    endpoint.replace('api.twitch.tv', 'user:password@api.twitch.tv'), endpoint + '#fragment', endpoint.replace('https:', 'http:')]) {
    assert.throws(() => validateFetch(url, options()));
  }
  for (const extra of [{ method: 'GET' }, { method: 'DELETE' }, { headers: headers.slice(1) },
    { headers: [...headers, ['Cookie', 'synthetic-cookie']] }, { headers: [...headers, ['authorization', 'Bearer duplicate']] }]) {
    assert.throws(() => validateFetch(endpoint, options(subscription(), extra)));
  }
});

test('request size and exact body keys remain unchanged for notification subscriptions', () => {
  for (const extra of [{ is_batching_enabled: true }, { cost: 0 }, { callback: 'https://other.example/hook' }]) {
    assert.throws(() => validateFetch(endpoint, options(subscription(extra))));
  }
  assert.throws(() => validateFetch(endpoint, options(subscription(), { body: 'x'.repeat(MAX_REQUEST + 1) })));
});

test('viewer notification support grants no additional OAuth scope or secret-bearing form field', () => {
  const request = (scopes, extra = {}) => ({ method: 'POST', headers: [['Content-Type', 'application/x-www-form-urlencoded']],
    body: new URLSearchParams({ client_id: app, scopes, ...extra }).toString() });
  const device = 'https://id.twitch.tv/oauth2/device';
  for (const scopes of ['user:read:chat user:write:chat', 'user:read:chat user:write:chat clips:edit']) validateFetch(device, request(scopes));
  for (const scope of ['bits:read', 'channel:read:subscriptions', 'user:bot', 'channel:bot']) {
    assert.throws(() => validateFetch(device, request(`user:read:chat user:write:chat ${scope}`)));
  }
  assert.throws(() => validateFetch(device, request('user:read:chat user:write:chat', { client_secret: 'synthetic-secret' })));
});

test('actual helper relay holds notification work without USA proof, then completes one exact local job', async t => {
  const now = 1_800_000_000_000;
  const relay = createUsTransport({ now: () => now }); t.after(() => relay.close());
  const sessionId = 'synthetic-browser-session-0001';
  const initial = relay.poll({ sessionId, proof: null }), epoch = initial.epoch;
  const responsePromise = relay.fetch(endpoint, options());
  const held = relay.poll({ sessionId, epoch, proof: null });
  assert.equal(held.job, null); assert.equal(held.needsProof, true);
  const proof = { ip: '203.0.113.1', loc: 'US', checkedAt: now };
  const { job } = relay.poll({ sessionId, epoch, proof });
  assert.equal(job.kind, 'fetch'); assert.equal(job.url, endpoint); assert.equal(job.method, 'POST');
  assert.deepEqual(JSON.parse(job.body), subscription());
  assert.equal(relay.poll({ sessionId, epoch, proof }).job, null, 'Issued notification work is not redelivered.');
  relay.begin({ sessionId, epoch, id: job.id, proof });
  relay.complete({ sessionId, epoch, id: job.id, result: { ok: true, status: 202,
    headers: [['content-type', 'application/json']], body: JSON.stringify({ data: [{ status: 'enabled' }] }) } });
  assert.deepEqual(await (await responsePromise).json(), { data: [{ status: 'enabled' }] });
  assert.equal(relay.status().pending, 0);
});
