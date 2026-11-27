import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TwitchChat, chatScopes } from '../lib/twitch.mjs';
import { DirectorAdapter } from '../lib/director-adapter.mjs';
import { directorOffer } from '../extension/director.js';
import { messageKey } from '../extension/message-policy.js';

const START = 1_800_000_000_000, account = 'fixture_companion', channel = 'fixture_channel', streamId = '123456789';
const binding = { generation: 'control-generation', sessionId: 'browser-session', settingsRevision: 1 };
const input = { controlGeneration: binding.generation, controlSessionId: binding.sessionId, settingsRevision: 1 };
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function fixture(t, provider) {
  let time = START;
  const calls = [], sockets = [], history = [];
  class Socket {
    constructor(url) { this.url = url; this.handlers = {}; sockets.push(this); }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    emit(value) { this.handlers.message({ data: JSON.stringify(value) }); }
    close() { this.handlers.close?.(); }
  }
  const credentials = { clientId: 'syntheticclient123', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', account, userId: '123' };
  const client = new TwitchChat({ credentials, WebSocketImpl: Socket, now: () => time, setTimer: () => 1, clearTimer() {}, transport: { invalidate() {} },
    saveHistory: async value => history.push(structuredClone(value)), fetchImpl: async (url, options) => {
      calls.push({ url, options }); const supplied = await provider?.(url, options); if (supplied) return supplied;
      if (url.endsWith('/validate')) return response({ client_id: credentials.clientId, login: account, user_id: '123', scopes: chatScopes });
      if (url.includes('/users?')) return response({ data: [{ id: '456', login: channel }] });
      if (url.endsWith('/eventsub/subscriptions')) return response({ data: [{ status: 'enabled' }] }, 202);
      if (url.includes('/shared_chat/session?')) return response({ data: [] });
      if (url.endsWith('/chat/messages')) return response({ data: [{ is_sent: true, message_id: 'outgoing-one' }] });
      assert.fail('Unexpected synthetic provider request');
    } });
  t.after(() => client.disconnect());
  const emit = async (socket, type, payload, extra = {}, at = time) => { socket.emit({ metadata: { message_type: type, message_timestamp: new Date(at).toISOString(), ...extra }, payload }); await client.chain; };
  const connect = async (waitFeed = true) => { await client.connect(account, channel); const socket = sockets.at(-1);
    await emit(socket, 'session_welcome', { session: { id: 'native-session', keepalive_timeout_seconds: 10 } });
    if (waitFeed) await client.eventFeedTask; return socket; };
  const event = (message_id, extra = {}) => ({ broadcaster_user_id: '456', broadcaster_user_login: channel, message_id, ...extra });
  const notice = (socket, id = 'notice-one', extra = {}, at = time) => emit(socket, 'notification', { event: event(id, { notice_type: 'sub', sub: {}, ...extra }) }, { subscription_type: 'channel.chat.notification' }, at);
  const cheer = (socket, id = 'cheer-one', extra = {}, at = time) => emit(socket, 'notification', { event: event(id, { chatter_user_login: 'fixture_viewer', message: { text: 'hello' }, cheer: { bits: 100 }, ...extra }) }, { subscription_type: 'channel.chat.message' }, at);
  const subscriptions = () => calls.filter(x => x.url.endsWith('/eventsub/subscriptions')).map(x => JSON.parse(x.options.body));
  return { client, calls, sockets, history, emit, connect, event, notice, cheer, subscriptions, now: () => time, advance(ms) { time += ms; } };
}
function plan(h, event) {
  const text = 'nice, a little extra support for the stream';
  return { planId: 'event-plan', authorityEpoch: 'central-authority', clientId: 'primary', account, channel, streamId, kind: 'event', category: event.type,
    event: { ...event }, text, textKey: messageKey(text), exactKey: createHash('sha256').update(text).digest('hex'), source: 'automatic',
    participationKey: `event:${channel}:${event.id}`, opportunityKey: `event:${channel}:${event.id}`, replyId: '', replyAuthor: '', replyAt: 0,
    bankRevision: 9, profileRevision: 9, notBefore: h.now(), expiresAt: event.at + 45_000, binding };
}
function executor(h, offer, onBegin) {
  const finishes = [];
  h.client.coordinator = { currentPlan: id => id === offer.planId ? offer : null,
    snapshot: () => ({ available: true, paused: false, accounts: [account] }), reserve: async () => ({ ok: true, reservationId: 'event-permit' }),
    begin: async () => { await onBegin?.(); return { ok: true }; }, finish: async (...args) => finishes.push(args) };
  h.client.inspectChannel = async () => ({ streamContext: { isLive: true, streamId }, sharedChat: false, chatSettings: {} });
  const send = extra => h.client.send({ account, channel, text: offer.text, kind: offer.kind, category: offer.category, streamId,
    participationKey: offer.participationKey, planId: offer.planId, authorityEpoch: offer.authorityEpoch, binding, ...extra });
  return { send, finishes };
}

test('a fresh native session requests exactly the two finite existing-grant chat subscriptions', async t => {
  const h = fixture(t); await h.connect();
  assert.deepEqual(h.subscriptions().map(x => x.type), ['channel.chat.message', 'channel.chat.notification']);
  for (const subscription of h.subscriptions()) assert.deepEqual({ ...subscription, type: 'checked' }, { type: 'checked', version: '1',
    condition: { broadcaster_user_id: '456', user_id: '123' }, transport: { method: 'websocket', session_id: 'native-session' } });
  assert.equal(h.client.connected, true); assert.deepEqual(h.client.status().eventFeed, { status: 'enabled' });
});

test('native bits and anonymous textless subscription notices retain exact facts alongside ordinary chat', async t => {
  const h = fixture(t), socket = await h.connect(); await h.cheer(socket, 'bits-one', {}, h.now() - 2000);
  await h.notice(socket, 'sub-one', { chatter_is_anonymous: true, chatter_user_login: 'PRIVATE_NAME', message: { text: '' } }, h.now() - 1000);
  assert.deepEqual(h.client.status().events, [{ id: 'bits:bits-one', channel, type: 'bits', at: h.now() - 2000 }, { id: 'notice:sub-one', channel, type: 'sub', at: h.now() - 1000 }]);
  assert.equal(h.client.status().messages[0].text, 'hello');
  assert.equal(JSON.stringify(h.client.status().events).includes('PRIVATE'), false);
});

test('bulk child-parent and duplicate deliveries coalesce using provider group identity and original times', async t => {
  const h = fixture(t), socket = await h.connect();
  await h.notice(socket, 'child-one', { notice_type: 'sub_gift', sub_gift: { community_gift_id: 'group-one' } }, h.now() - 2000);
  await h.notice(socket, 'batch-one', { notice_type: 'community_sub_gift', community_sub_gift: { id: 'group-one' } }, h.now() - 1000);
  await h.notice(socket, 'child-two', { notice_type: 'sub_gift', sub_gift: { community_gift_id: 'group-one' } });
  await h.notice(socket, 'batch-one', { notice_type: 'community_sub_gift', community_sub_gift: { id: 'group-one' } });
  assert.deepEqual(h.client.status().events, [{ id: 'gift:group-one', channel, type: 'gift_batch', at: h.now() - 1000 }]);
});

test('wrong-room/shared/plain-text/malformed and unsupported notices produce no native events', async t => {
  const h = fixture(t), socket = await h.connect();
  await h.cheer(socket, 'wrong', { broadcaster_user_id: '999' }); await h.cheer(socket, 'shared', { source_broadcaster_user_id: '999' });
  await h.cheer(socket, 'words', { cheer: null, message: { text: 'Cheer100' } }); await h.cheer(socket, 'invalid', { cheer: { bits: '100' } });
  await h.notice(socket, 'raid', { notice_type: 'raid', raid: {} }); await h.notice(socket, 'bad', { sub: null });
  assert.deepEqual(h.client.status().events, []); assert.equal(h.client.connected, true); assert.equal(h.client.error, '');
});

test('optional notification refusal cannot disconnect normal chat or disable native bits', async t => {
  const h = fixture(t, async (url, options) => url.endsWith('/eventsub/subscriptions') && JSON.parse(options.body).type === 'channel.chat.notification' ? response({ error: 'PRIVATE_PROVIDER_TEXT' }, 403) : null);
  const socket = await h.connect(); await h.cheer(socket);
  assert.equal(h.client.connected, true); assert.equal(h.client.error, ''); assert.deepEqual(h.client.status().eventFeed, { status: 'unavailable' });
  assert.equal(h.client.status().events[0].type, 'bits'); assert.equal(h.subscriptions().length, 2);
  assert.equal(JSON.stringify(h.client.status()).includes('PRIVATE_PROVIDER_TEXT'), false);
});

test('optional lost response is never retried on the same socket and only its revocation is nonfatal', async t => {
  const h = fixture(t, async (url, options) => { if (url.endsWith('/eventsub/subscriptions') && JSON.parse(options.body).type === 'channel.chat.notification') throw Error('PRIVATE_PROVIDER_TEXT'); });
  const socket = await h.connect(); await h.emit(socket, 'session_keepalive', {}); await h.emit(socket, 'session_welcome', { session: { id: 'native-session' } });
  assert.equal(h.subscriptions().length, 2); assert.equal(h.client.connected, true);
  await h.emit(socket, 'revocation', { subscription: { type: 'channel.chat.notification', status: 'authorization_revoked' } });
  assert.equal(h.client.connected, true); assert.deepEqual(h.client.status().eventFeed, { status: 'unavailable' }); await h.cheer(socket);
  assert.equal(h.client.status().events[0].type, 'bits');
});

test('a verified notice arriving before optional HTTP confirmation is retained, while revocation wins over a delayed success', async t => {
  let resolve;
  const h = fixture(t, (url, options) => url.endsWith('/eventsub/subscriptions') && JSON.parse(options.body).type === 'channel.chat.notification'
    ? new Promise(done => { resolve = done; }) : null);
  const socket = await h.connect(false), pending = h.client.eventFeedTask;
  await h.notice(socket); await h.cheer(socket);
  assert.equal(h.client.status().events.length, 2);
  await h.emit(socket, 'revocation', { subscription: { type: 'channel.chat.notification', status: 'authorization_revoked' } });
  assert.deepEqual(h.client.status().events.map(x => x.type), ['bits']);
  resolve(response({ data: [{ status: 'enabled' }] }, 202)); await pending;
  assert.equal(h.client.connected, true); assert.deepEqual(h.client.status().eventFeed, { status: 'unavailable' });
  await h.notice(socket, 'late-revoked-notice'); assert.deepEqual(h.client.status().events.map(x => x.type), ['bits']);
});

test('base chat refusal never starts the optional subscription', async t => {
  const h = fixture(t, async url => url.endsWith('/eventsub/subscriptions') ? response({ message: 'PRIVATE_PROVIDER_TEXT' }, 403) : null);
  await h.connect(); assert.equal(h.client.connected, false); assert.equal(h.subscriptions().length, 1);
  assert.equal(h.subscriptions()[0].type, 'channel.chat.message'); assert.deepEqual(h.client.status().eventFeed, { status: 'unavailable' });
  assert.doesNotMatch(h.client.status().error, /PRIVATE_PROVIDER_TEXT/);
});

test('Stop fences delayed notification enablement and clears old native events', async t => {
  let resolve;
  const h = fixture(t, (url, options) => url.endsWith('/eventsub/subscriptions') && JSON.parse(options.body).type === 'channel.chat.notification'
    ? new Promise(done => { resolve = done; }) : null);
  const socket = await h.connect(false); const pending = h.client.eventFeedTask;
  assert.equal(h.client.connected, true); assert.equal(typeof resolve, 'function'); await h.cheer(socket);
  h.client.disconnect(); resolve(response({ data: [{ status: 'enabled' }] }, 202)); await pending;
  assert.equal(h.client.connected, false); assert.deepEqual(h.client.status().events, []); assert.deepEqual(h.client.status().eventFeed, { status: 'unavailable' });
});

test('trusted socket handover keeps the event feed and performs no new subscription POSTs', async t => {
  const h = fixture(t), old = await h.connect(); await h.cheer(old);
  await h.emit(old, 'session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv?reconnect_token=synthetic' } });
  await h.emit(h.sockets.at(-1), 'session_welcome', { session: { id: 'transferred-session' } });
  assert.equal(h.subscriptions().length, 2); assert.equal(h.client.connected, true); assert.equal(h.client.status().eventFeed.status, 'enabled');
  assert.equal(h.client.status().events.length, 1);
});

test('director observation uses only authoritative native events and ignores browser-supplied copies', async t => {
  const h = fixture(t), socket = await h.connect(); await h.cheer(socket);
  h.client.coordinator = { snapshot: () => ({ accounts: [account] }), refresh: async () => {} };
  h.client.inspectChannel = async () => ({ streamContext: { channel, streamId, isLive: true, checkedAt: h.now() }, chatSettings: {}, sharedChat: false });
  const control = { stopped: false, browserState: { settings: { revision: 1, paused: false, autoReply: true, chatMode: 'participate' },
    watch: { enabled: true, channel, status: 'playing', checkedAt: h.now() } }, guard() {} };
  const adapter = new DirectorAdapter({ twitch: h.client, control, config: {}, now: h.now });
  const observed = await adapter.observation({ ...input, events: [{ id: 'bits:browser-forgery', channel, type: 'bits', at: h.now() }] });
  assert.deepEqual(observed.events, h.client.status().events); assert.equal(observed.events[0].id, 'bits:cheer-one');
});

test('event offers require exact bounded native tuples and cannot become fake message replies', async t => {
  const h = fixture(t), socket = await h.connect(); await h.cheer(socket); const event = h.client.status().events[0], offered = plan(h, event);
  const options = { account, channel, binding, authorityEpoch: offered.authorityEpoch, now: h.now() };
  const accepted = directorOffer(offered, options); assert.ok(accepted); offered.event.at--;
  assert.equal(accepted.event.at, event.at, 'cached event metadata is copied'); offered.event.at++;
  for (const change of [{ event: undefined }, { event: { ...event, at: h.now() - 45_001 } }, { event: { ...event, extra: 'PRIVATE_TEXT' } },
    { event: { ...event, channel: 'wrong_channel' } }, { replyId: 'fabricated-parent', replyAuthor: 'fixture_viewer', replyAt: h.now() },
    { category: 'sub' }, { participationKey: 'invented-key' }]) assert.equal(directorOffer({ ...offered, ...change }, options), null);
});

test('an exact event sends once and an uncertain provider result remains consumed without retry', async t => {
  const h = fixture(t, async url => { if (url.endsWith('/chat/messages')) throw Error('lost synthetic response'); });
  const socket = await h.connect(); await h.cheer(socket); const offered = plan(h, h.client.status().events[0]), e = executor(h, offered);
  await assert.rejects(e.send(), /connection failed/); assert.equal(h.client.history.at(-1).delivery, 'unknown');
  await assert.rejects(e.send(), /already submitted|cooldown|ten minutes/);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 1);
});

test('native event expiry during begin or final local validation certifies no provider send', async t => {
  for (const boundary of ['begin', 'final']) {
    const h = fixture(t), socket = await h.connect(); await h.cheer(socket); const offered = plan(h, h.client.status().events[0]);
    const e = executor(h, offered, boundary === 'begin' ? () => h.advance(45_001) : undefined);
    const result = await e.send(boundary === 'final' ? { beforeSubmit: () => h.advance(45_001) } : {});
    assert.equal(result.delivery, 'cancelled'); assert.equal(result.submitted, false);
    assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
    assert.equal(e.finishes.at(-1)[1], 'cancelled');
  }
});

test('replacing a cached plan event during final validation cannot redirect an already prepared event send', async t => {
  const h = fixture(t), socket = await h.connect(); await h.cheer(socket); const offered = plan(h, h.client.status().events[0]), e = executor(h, offered);
  const result = await e.send({ beforeSubmit: async () => {
    await h.cheer(socket, 'different-event');
    offered.event = h.client.status().events.find(event => event.id === 'bits:different-event');
    offered.participationKey = offered.opportunityKey = `event:${channel}:${offered.event.id}`;
  } });
  assert.equal(result.delivery, 'cancelled'); assert.equal(result.submitted, false);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});
