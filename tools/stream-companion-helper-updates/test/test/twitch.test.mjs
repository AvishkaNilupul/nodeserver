import { installDirectorFixture } from './director-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchChat, reconnectUrl, chatScopes } from '../lib/twitch.mjs';
import { validateReply } from '../extension/core.js';

const now = 1_800_000_000_000;
const credentials = { clientId: 'testclient1234', accessToken: 'secret-access', refreshToken: 'secret-refresh', account: 'companion_test', userId: '123' };
const identity = { client_id: credentials.clientId, login: credentials.account, user_id: credentials.userId, scopes: chatScopes };
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
class Socket {
  static all = [];
  constructor(url) { this.url = url; this.handlers = {}; this.closed = false; Socket.all.push(this); }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  emit(data) { this.handlers.message({ data: JSON.stringify(data) }); }
  close() { this.closed = true; this.handlers.close?.(); }
}
function harness(t, customFetch) {
  Socket.all = []; const calls = [], saved = [], timers = new Map(); let time = now, timerId = 0;
  const client = new TwitchChat({ credentials: { ...credentials }, WebSocketImpl: Socket, now: () => time,
    saveCredentials: async value => saved.push(structuredClone(value)), saveHistory: async value => saved.push(structuredClone(value)),
    setTimer: (fn, delay) => { const n = ++timerId; timers.set(n, { fn, delay }); return n; }, clearTimer: n => timers.delete(n),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (customFetch) { const result = await customFetch(url, options); if (result) return result; }
      if (url.endsWith('/validate')) return response(identity);
      if (url.includes('/users?')) return response({ data: [{ id: '456', login: 'friend_channel' }] });
      if (url.endsWith('/eventsub/subscriptions')) return response({ data: [{ status: 'enabled' }] }, 202);
      if (url.includes('/shared_chat/session?')) return response({ data: [] });
      if (url.endsWith('/chat/messages')) return response({ data: [{ is_sent: true, message_id: 'sent-1' }] });
      throw new Error('Unexpected test request');
    }
  });
  installDirectorFixture(client);
  t.after(() => client.disconnect());
  const emit = async (socket, type, payload, extra = {}) => { socket.emit({ metadata: { message_type: type, message_timestamp: new Date(time).toISOString(), ...extra }, payload }); await client.chain; };
  const connect = async () => { await client.connect('companion_test', 'friend_channel'); const socket = Socket.all.at(-1); await emit(socket, 'session_welcome', { session: { id: 'session1', keepalive_timeout_seconds: 10 } }); return socket; };
  return { client, calls, saved, timers, emit, connect, advance: ms => { time += ms; } };
}

async function exchangeHarness(t, { begin, provider } = {}) {
  const h = harness(t, provider); await h.connect();
  const offer = { id: 'exchange-turn', key: 'exchange:exchange-turn', account: 'companion_test', channel: 'friend_channel',
    streamId: '123456789', text: '@other_companion a short chat break.', notBefore: now - 1, expiresAt: now + 20_000 };
  const finishes = [], reserves = [];
  h.client.inspectChannel = async () => ({ streamContext: { isLive: true, streamId: offer.streamId }, sharedChat: false, chatSettings: {} });
  h.client.coordinator = { snapshot: () => ({ available: true, paused: false, accounts: ['companion_test', 'other_companion'], exchange: offer }),
    reserve: async intent => { reserves.push(intent); return { ok: true, reservationId: 'exchange-permit' }; },
    begin: async () => { await begin?.(h); return { ok: true }; }, finish: (...args) => finishes.push(args) };
  const input = { account: offer.account, channel: offer.channel, text: offer.text, participationKey: offer.key,
    kind: 'exchange', streamId: offer.streamId, exchangeId: offer.id };
  return { ...h, offer, input, finishes, reserves };
}

test('a helper exchange binds the exact offer and posts the plain partner mention without a fake reply parent', async t => {
  const h = await exchangeHarness(t);
  const result = await h.client.send(h.input);
  assert.equal(result.delivery, 'confirmed'); assert.equal(result.exchangeId, h.offer.id);
  assert.equal(h.reserves[0].exchangeId, h.offer.id); assert.equal(h.reserves[0].replyTo, '');
  const body = JSON.parse(h.calls.find(x => x.url.endsWith('/chat/messages')).options.body);
  assert.equal(body.message, h.offer.text); assert.match(body.message, /^@other_companion \S/);
  assert.equal(h.client.history.at(-1).text, body.message); assert.equal('reply_parent_message_id' in body, false);
  assert.deepEqual(h.finishes.map(row => row.slice(0, 2)), [['exchange-permit', 'confirmed']]);
});

test('unsolicited, malformed, altered and reply-targeted exchange inputs never reserve or send', async t => {
  const h = await exchangeHarness(t);
  for (const change of [{ exchangeId: undefined }, { exchangeId: 'different-turn' }, { participationKey: '' },
    { participationKey: 'exchange:different-turn' }, { kind: 'greeting' }, { replyTo: 'fabricated-parent' },
    { replyAuthor: 'other_companion' }, { text: '@other_companion different words' },
    { text: 'unmentioned public text' }, { streamId: '987654321' }]) {
    await assert.rejects(h.client.send({ ...h.input, ...change }), /exchange|participation/i, JSON.stringify(change));
  }
  const currentText = h.offer.text;
  h.offer.text = `[companion bot] ${currentText}`;
  await assert.rejects(h.client.send({ ...h.input, text: h.offer.text }), /no longer current/);
  h.offer.text = currentText;
  h.offer.notBefore = now + 1;
  await assert.rejects(h.client.send(h.input), /no longer current/);
  h.offer.notBefore = now - 1; h.offer.expiresAt = now;
  await assert.rejects(h.client.send(h.input), /no longer current/);
  assert.equal(h.reserves.length, 0); assert.equal(h.client.history.length, 0);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});

test('unavailable or paused exchange coordination returns explicit no-send suppression without a local budget', async t => {
  const h = await exchangeHarness(t), snapshot = h.client.coordinator.snapshot();
  for (const state of [{ ...snapshot, available: false }, { ...snapshot, paused: true }]) {
    h.client.coordinator.snapshot = () => state;
    const result = await h.client.send(h.input);
    assert.equal(result.suppressed, true); assert.equal(result.submitted, false); assert.equal(result.delivery, 'cancelled');
    assert.equal(result.retryable, true); assert.equal(h.client.history.length, 0);
  }
  assert.equal(h.reserves.length, 0); assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});

test('exchanges keep live inspection and all consumed participation attempts enforce ten-minute spacing', async t => {
  const h = await exchangeHarness(t);
  h.client.inspectChannel = async () => ({ streamContext: { isLive: true, streamId: h.offer.streamId }, sharedChat: false, chatSettings: { emoteOnly: true } });
  await assert.rejects(h.client.send(h.input), /no longer permits/);
  h.client.inspectChannel = async () => ({ streamContext: { isLive: true, streamId: h.offer.streamId }, sharedChat: false, chatSettings: {} });
  for (const delivery of ['pending', 'confirmed', 'unknown', 'rejected']) {
    h.client.history = [{ account: h.offer.account, channel: 'different_channel', at: now - 1,
      participationKey: 'previous-participation', text: 'an earlier attempt', delivery, submitted: delivery !== 'pending' }];
    await assert.rejects(h.client.send(h.input), /ten minutes/, delivery);
  }
  assert.equal(h.reserves.length, 0);
});

test('an exchange expiring during begin is certified cancelled before Twitch is called', async t => {
  const h = await exchangeHarness(t, { begin: h => h.advance(20_000) });
  const result = await h.client.send(h.input);
  assert.equal(result.suppressed, true); assert.equal(result.submitted, false); assert.equal(result.code, 'exchange_expired');
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
  assert.deepEqual(h.finishes.map(row => row.slice(0, 2)), [['exchange-permit', 'cancelled']]);
});

test('a human arriving during exchange begin takes priority and cancels the unused permit', async t => {
  const h = await exchangeHarness(t, { begin: h => { h.client.messages.push({ id: 'new-human', author: 'alice', text: 'hello everyone', at: now }); } });
  const result = await h.client.send(h.input);
  assert.equal(result.suppressed, true); assert.equal(result.submitted, false); assert.equal(result.code, 'exchange_quiet');
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
  assert.deepEqual(h.finishes.map(row => row.slice(0, 2)), [['exchange-permit', 'cancelled']]);
});

test('own, companion and known-bot traffic does not masquerade as fresh human activity at begin', async t => {
  const h = await exchangeHarness(t, { begin: h => { h.client.messages = ['companion_test', 'other_companion', 'nightbot', 'streamlabs', 'somebot'].map(author => ({ author, text: 'hello', at: now }));
    h.client.messages.push({ author: 'flagged_account', isBot: true, text: 'hello', at: now }); } });
  assert.equal((await h.client.send(h.input)).delivery, 'confirmed');
});

test('an uncertain exchange is retained as consumed and no second provider request is made', async t => {
  const h = await exchangeHarness(t, { provider: async url => { if (url.endsWith('/chat/messages')) throw Error('lost provider response'); } });
  await assert.rejects(h.client.send(h.input), /connection failed/);
  assert.equal(h.client.history.at(-1).delivery, 'unknown');
  await assert.rejects(h.client.send(h.input), /ten minutes|already submitted/);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 1);
  assert.deepEqual(h.finishes.map(row => row.slice(0, 2)), [['exchange-permit', 'unknown']]);
});

test('ordinary casual text is preserved and commands, links and multiline text are still rejected', () => {
  assert.equal(validateReply('hey, how’s your day going?'), 'hey, how’s your day going?');
  assert.equal(validateReply('x'.repeat(300)).length, 300);
  for (const raw of ['/ban alice', '.ban alice', 'hey\nhello', 'https://example.org', 'x'.repeat(301)]) assert.throws(() => validateReply(raw));
});

test('shared duplicate suppression never reaches Twitch or consumes the helper send history', async t => {
  const h = harness(t); await h.connect();
  h.client.coordinator = { snapshot: () => ({ accounts: [] }), reserve: () => ({ ok: false, reason: 'Already contributed in this channel.' }) };
  const result = await h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello' });
  assert.equal(result.suppressed, true); assert.equal(result.submitted, false); assert.equal(result.delivery, 'cancelled');
  assert.equal(h.client.history.length, 0);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});

test('known Twitch rejection releases shared reservation while uncertain delivery retains it', async t => {
  let uncertain = false; const finishes = [];
  const h = harness(t, async url => {
    if (url.endsWith('/chat/messages')) {
      if (uncertain) throw Error('network result unavailable');
      return response({ data: [{ is_sent: false, drop_reason: { code: 'automod_held' } }] });
    }
  });
  await h.connect();
  h.client.coordinator = { snapshot: () => ({ accounts: [] }), reserve: () => ({ ok: true, reservationId: 'reserved' }), finish: (...args) => finishes.push(args) };
  assert.equal((await h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello' })).delivery, 'rejected');
  assert.deepEqual(finishes.map(row => row.slice(0, 2)), [['reserved', 'rejected']]);
  h.advance(180001); uncertain = true;
  await assert.rejects(h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'another greeting' }), /connection failed/);
  assert.deepEqual(finishes.at(-1).slice(0, 2), ['reserved', 'unknown']);
  assert.equal(finishes.at(-1)[2].at, h.client.history.at(-1).at);
});

test('a known companion cannot trigger an automatic reply loop', async t => {
  const h = harness(t); await h.connect();
  h.client.messages = [{ id: 'another-companion', author: 'second_account', text: '@companion_test hello', at: now }];
  h.client.coordinator = { snapshot: () => ({ accounts: ['second_account'] }), reserve: () => { throw Error('Must not reserve a companion reply'); } };
  const result = await h.client.send({ account: 'companion_test', channel: 'friend_channel', replyTo: 'another-companion', text: 'hello' });
  assert.equal(result.suppressed, true); assert.equal(h.client.history.length, 0);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});

test('disconnect before the Twitch request releases a shared reservation', async t => {
  const h = harness(t); await h.connect(); const finished = [];
  h.client.coordinator = { reserve: () => ({ ok: true, reservationId: 'reserved' }),
    finish: (...args) => finished.push(args) };
  h.client.saveHistory = async history => { if (history.at(-1)?.delivery === 'pending') h.client.disconnect(); };
  await assert.rejects(h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello' }), /disconnected/);
  assert.deepEqual(finished, [['reserved', 'cancelled']]);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});

test('lost begin response cancels unused permission and does not consume a helper send allowance', async t => {
  const h = harness(t); await h.connect(); const finished = []; let begins = 0;
  h.client.coordinator = { reserve: async () => ({ ok: true, reservationId: `permit-${begins}` }),
    begin: async () => { if (++begins === 1) throw Error('host begin response lost'); return { ok: true }; },
    finish: async (...args) => finished.push(args) };
  const held = await h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello everyone' });
  assert.equal(held.suppressed, true); assert.equal(held.submitted, false);
  assert.equal(held.retryable, true); assert.equal(held.code, 'unavailable');
  assert.equal(h.client.history[0].delivery, 'cancelled'); assert.equal(h.client.history[0].submitted, false);
  assert.ok(h.saved.some(x => Array.isArray(x) && x.some(y => y.coordinationId === 'permit-0' && y.delivery === 'pending')));
  assert.deepEqual(finished[0], ['permit-0', 'cancelled']);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
  const sent = await h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'a different greeting' });
  assert.equal(sent.delivery, 'confirmed');
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 1);
});

test('a host completion outage cannot relabel known confirmed Twitch delivery', async t => {
  const h = harness(t); await h.connect();
  h.client.coordinator = { reserve: async () => ({ ok: true, reservationId: 'confirmed-permit' }), begin: async () => ({ ok: true }),
    finish: async () => { throw Error('completion storage/network unavailable'); } };
  const result = await h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello' });
  assert.equal(result.delivery, 'confirmed'); assert.equal(result.submitted, true);
  assert.equal(h.client.history[0].delivery, 'confirmed'); assert.equal(h.client.history[0].coordinationId, 'confirmed-permit');
});

test('reply freshness is rechecked after central permission before the provider request', async t => {
  const h = harness(t); await h.connect(); const finished = [];
  h.client.messages = [{ id: 'near-expiry', author: 'alice', text: '@companion_test hello', at: now - 44000 }];
  h.client.coordinator = { snapshot: () => ({ accounts: [] }), reserve: async () => ({ ok: true, reservationId: 'stale-permit' }),
    begin: async () => { h.advance(2000); return { ok: true }; }, finish: async (...args) => finished.push(args) };
  const result = await h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello', replyTo: 'near-expiry' });
  assert.equal(result.suppressed, true); assert.match(result.reason, /expired/);
  assert.deepEqual(finished, [['stale-permit', 'cancelled']]);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});

test('disconnect after central begin still cancels before any provider send', async t => {
  const h = harness(t); await h.connect(); const finished = [];
  h.client.coordinator = { reserve: async () => ({ ok: true, reservationId: 'pause-permit' }),
    begin: async () => { h.client.disconnect(); return { ok: true }; }, finish: async (...args) => finished.push(args) };
  await assert.rejects(h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello' }), /disconnected/);
  assert.deepEqual(finished, [['pause-permit', 'cancelled']]);
  assert.equal(h.calls.filter(x => x.url.endsWith('/chat/messages')).length, 0);
});

test('device authorization uses only chat scopes, waits between polls, and does not expose tokens', async t => {
  const h = harness(t, async (url, options) => {
    if (url.endsWith('/device')) { const body = new URLSearchParams(options.body); assert.equal(body.get('scopes'), chatScopes.join(' ')); return response({ device_code: 'private-device', user_code: 'ABCDEFGH', expires_in: 1800, interval: 5, verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=ABCDEFGH' }); }
    if (url.endsWith('/token')) return response({ access_token: 'new-access', refresh_token: 'new-refresh' });
  });
  const result = await h.client.startAuthorization('testclient1234', 'companion_test');
  assert.equal(result.userCode, 'ABCDEFGH'); assert.ok(!JSON.stringify(result).includes('private-device'));
  assert.equal((await h.client.pollAuthorization()).pending, true);
  assert.equal(h.calls.filter(c => c.url.endsWith('/token')).length, 0);
  h.advance(5000); assert.equal((await h.client.pollAuthorization()).authorized, true);
  assert.equal(h.saved[0].accessToken, 'new-access');
  const publicState = JSON.stringify(h.client.status());
  for (const secret of ['new-access', 'new-refresh', 'private-device']) assert.ok(!publicState.includes(secret));
});

test('authorization rejects the wrong signed-in account before storing its tokens', async t => {
  const h = harness(t, async url => {
    if (url.endsWith('/device')) return response({ device_code: 'device', user_code: 'code', expires_in: 1800, verification_uri: 'https://www.twitch.tv/activate' });
    if (url.endsWith('/token')) return response({ access_token: 'wrong-access', refresh_token: 'wrong-refresh' });
    if (url.endsWith('/validate')) return response({ ...identity, login: 'other_account' });
  });
  await h.client.startAuthorization('testclient1234', 'companion_test'); h.advance(5000);
  await assert.rejects(h.client.pollAuthorization(), /do not match/); assert.equal(h.saved.length, 0);
});

test('authorization pending, slowdown, and expiry never make a polling loop', async t => {
  let polls = 0;
  const h = harness(t, async url => {
    if (url.endsWith('/device')) return response({ device_code: 'device', user_code: 'code', expires_in: 30, interval: 5, verification_uri: 'https://www.twitch.tv/activate' });
    if (url.endsWith('/token')) return response({ message: ++polls === 1 ? 'authorization_pending' : 'slow_down' }, 400);
  });
  await h.client.startAuthorization('testclient1234', 'companion_test'); h.advance(5000);
  assert.equal((await h.client.pollAuthorization()).pending, true); h.advance(5000);
  assert.equal((await h.client.pollAuthorization()).pollAfterMs, 10000);
  await h.client.pollAuthorization(); assert.equal(polls, 2); h.advance(30000);
  await assert.rejects(h.client.pollAuthorization(), /expired/);
});

test('official EventSub subscription receives and deduplicates bounded chat without opening a player', async t => {
  const h = harness(t); const socket = await h.connect();
  const body = JSON.parse(h.calls.find(c => c.url.endsWith('/eventsub/subscriptions')).options.body);
  assert.deepEqual(body, { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: '456', user_id: '123' }, transport: { method: 'websocket', session_id: 'session1' } });
  assert.equal(h.client.status().connected, true);
  const payload = { event: { broadcaster_user_id: '456', chatter_user_login: 'alice', message_id: 'message1', message: { text: '@companion_test hi Kappa' } } };
  await h.emit(socket, 'notification', payload, { subscription_type: 'channel.chat.message' });
  await h.emit(socket, 'notification', payload, { subscription_type: 'channel.chat.message' });
  await h.emit(socket, 'notification', { event: { ...payload.event, broadcaster_user_id: '789' } }, { subscription_type: 'channel.chat.message' });
  assert.equal(h.client.status().messages.length, 1);
  assert.equal(h.client.status().messages[0].text, '@companion_test hi Kappa');
  assert.ok(h.calls.every(c => /^(https:\/\/(id|api)\.twitch\.tv)/.test(c.url)));
  h.advance(901000); assert.equal(h.client.status().messages.length, 0);
});

test('API confirms sends with a message ID, correct sender, and explicit reply target', async t => {
  const h = harness(t); const socket = await h.connect();
  await h.emit(socket, 'notification', { event: { broadcaster_user_id: '456', chatter_user_login: 'alice', message_id: 'incoming', message: { text: '@companion_test hello' } } }, { subscription_type: 'channel.chat.message' });
  const result = await h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello', replyTo: 'incoming' });
  assert.equal(result.delivery, 'confirmed'); assert.equal(result.messageId, 'sent-1');
  const request = h.calls.find(c => c.url.endsWith('/chat/messages'));
  assert.deepEqual(JSON.parse(request.options.body), { broadcaster_id: '456', sender_id: '123', message: 'hello', reply_parent_message_id: 'incoming' });
  await assert.rejects(h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'another hello' }), /cooldown/);
});

test('API rejection is distinct from success and a lost send response is never retried', async t => {
  let sending = 0;
  const h = harness(t, async url => {
    if (url.endsWith('/chat/messages')) { sending++; if (sending === 1) return response({ data: [{ is_sent: false, drop_reason: { code: 'automod_held' } }] }); throw new Error('lost response'); }
  });
  await h.connect();
  assert.equal((await h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello' })).delivery, 'rejected');
  h.advance(181000);
  await assert.rejects(h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hey' }), /connection failed/);
  assert.equal(h.client.history.at(-1).delivery, 'unknown');
  await assert.rejects(h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hey' }), /cooldown/);
  assert.equal(sending, 2);
});

test('a persisted pending send survives restart and blocks duplicate submissions', async t => {
  const h = harness(t); await h.connect(); h.client.history = [{ at: now - 1000, text: '[bot] hello', delivery: 'pending' }];
  await assert.rejects(h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello' }), /cooldown/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/chat/messages')).length, 0);
});

test('shared chat, mismatched targets, and stale replies cannot send', async t => {
  const h = harness(t, async url => url.includes('/shared_chat/session?') ? response({ data: [{ session_id: 'shared-session' }] }) : null);
  await h.connect();
  for (const args of [{ account: 'someone_else', channel: 'friend_channel' }, { account: 'companion_test', channel: 'another_channel' }, { account: 'companion_test', channel: 'friend_channel', replyTo: 'stale' }, { account: 'companion_test', channel: 'friend_channel' }]) await assert.rejects(h.client.send({ ...args, text: 'hello' }));
  assert.equal(h.calls.filter(c => c.url.endsWith('/chat/messages')).length, 0);
});

test('disconnect during connection setup prevents a late socket from opening', async t => {
  let release;
  const h = harness(t, async url => url.includes('/users?') ? new Promise(resolve => { release = () => resolve(response({ data: [{ id: '456', login: 'friend_channel' }] })); }) : null);
  const connecting = h.client.connect('companion_test', 'friend_channel');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.client.disconnect(); release(); await connecting;
  assert.equal(Socket.all.length, 0); assert.equal(h.client.connected, false);
});

test('official root reconnect URLs preserve opaque queries and reject alternate authority or normalization', () => {
  for (const raw of ['wss://eventsub.wss.twitch.tv', 'wss://eventsub.wss.twitch.tv?...',
    'wss://eventsub.wss.twitch.tv?session_id=opaque&token=abc%2Bdef&x=1',
    'wss://eventsub.wss.twitch.tv/?session_id=opaque', 'wss://eventsub.wss.twitch.tv/ws?reconnect=opaque',
    'wss://eventsub.wss.twitch.tv/?' + 'x'.repeat(2047)]) {
    assert.equal(reconnectUrl(raw), new URL(raw).href);
  }
  for (const raw of ['ws://eventsub.wss.twitch.tv/', 'https://eventsub.wss.twitch.tv/',
    'wss://eventsub.wss.twitch.tv.evil.example/', 'wss://other.example/', 'wss://user:pass@eventsub.wss.twitch.tv/',
    'wss://eventsub.wss.twitch.tv:444/', 'wss://eventsub.wss.twitch.tv/#fragment', 'wss://eventsub.wss.twitch.tv/#',
    'wss://eventsub.wss.twitch.tv/ws/', 'wss://eventsub.wss.twitch.tv/elsewhere', 'wss://eventsub.wss.twitch.tv/a/../ws',
    ' wss://eventsub.wss.twitch.tv/', 'wss://eventsub.wss.twitch.tv/\n', 'wss://eventsub.wss.twitch.tv/\\',
    'wss://eventsub.wss.twitch.tv/?x=[]', 'wss://eventsub.wss.twitch.tv/?' + 'x'.repeat(2048), null, {}]) {
    assert.throws(() => reconnectUrl(raw));
  }
});

test('documented root reconnect transfers once, ignores retired frames and never replays a confirmed send', async t => {
  const h = harness(t); const old = await h.connect();
  const input = { account: 'companion_test', channel: 'friend_channel', text: 'a distinct pre-transfer reply' };
  assert.equal((await h.client.send(input)).delivery, 'confirmed');
  const generation = h.client.generation;
  const raw = 'wss://eventsub.wss.twitch.tv?session_id=opaque&token=abc%2Bdef&x=1';
  const reconnect = { session: { reconnect_url: raw } };
  await h.emit(old, 'session_reconnect', reconnect); await h.emit(old, 'session_reconnect', reconnect);
  assert.equal(Socket.all.length, 2);
  const next = Socket.all.at(-1); assert.equal(next.url, new URL(raw).href);
  assert.equal(old.closed, false); assert.equal(h.client.connected, true);
  await h.emit(next, 'session_welcome', { session: { id: 'transferred-root', keepalive_timeout_seconds: 10 } });
  assert.equal(old.closed, true); assert.equal(h.client.connected, true);
  old.handlers.close(); // A late native close from the retired connection is inert.
  await h.emit(old, 'notification', { event: { broadcaster_user_id: '456', message_id: 'retired-message',
    chatter_user_login: 'viewer', message: { text: 'a retired frame' } } }, { subscription_type: 'channel.chat.message' });
  await h.emit(old, 'session_reconnect', reconnect);
  assert.equal(h.client.messages.some(message => message.id === 'retired-message'), false);
  assert.equal(h.client.generation, generation); assert.equal(h.client.error, '');
  assert.equal(h.client.connected, true); assert.equal(Socket.all.length, 2);
  assert.deepEqual(h.calls.filter(call => call.url.endsWith('/eventsub/subscriptions')).map(call => JSON.parse(call.options.body).type), ['channel.chat.message', 'channel.chat.notification']);
  assert.equal(h.calls.filter(call => call.url.endsWith('/chat/messages')).length, 1);
  await assert.rejects(h.client.send(input));
  assert.equal(h.calls.filter(call => call.url.endsWith('/chat/messages')).length, 1);
  assert.equal(h.client.history.length, 1); assert.equal(h.client.history[0].delivery, 'confirmed');
});

test('EventSub reconnect transfers the session once, validates its host, and revocation closes it', async t => {
  const h = harness(t); const old = await h.connect();
  await h.emit(old, 'session_reconnect', { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=abc' } });
  const next = Socket.all.at(-1); assert.notEqual(next, old); assert.equal(old.closed, false);
  await h.emit(next, 'session_welcome', { session: { id: 'transferred' } });
  assert.equal(old.closed, true); assert.equal(h.client.connected, true);
  assert.deepEqual(h.calls.filter(c => c.url.endsWith('/eventsub/subscriptions')).map(c => JSON.parse(c.options.body).type), ['channel.chat.message', 'channel.chat.notification']);
  await h.emit(next, 'revocation', {}); assert.equal(h.client.connected, false); assert.equal(next.closed, true);
  for (const url of ['wss://evil.example/ws', 'https://eventsub.wss.twitch.tv/ws', 'wss://user@eventsub.wss.twitch.tv/ws', 'wss://eventsub.wss.twitch.tv/elsewhere']) assert.throws(() => reconnectUrl(url));
});

test('missing keepalive disconnects and hourly token validation is scheduled', async t => {
  const h = harness(t); await h.connect();
  assert.ok([...h.timers.values()].some(x => x.delay === 3500000));
  const heartbeat = [...h.timers.values()].find(x => x.delay === 15000);
  heartbeat.fn(); assert.equal(h.client.connected, false); assert.match(h.client.error, /timed out/);
});

test('public-client token refresh persists the rotated token without a client secret', async t => {
  let validates = 0;
  const h = harness(t, async (url, options) => {
    if (url.endsWith('/validate')) return ++validates === 1 ? response({}, 401) : response(identity);
    if (url.endsWith('/token')) {
      const body = new URLSearchParams(options.body); assert.equal(body.get('grant_type'), 'refresh_token'); assert.equal(body.has('client_secret'), false);
      return response({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
    }
  });
  await h.connect(); assert.equal(h.saved[0].refreshToken, 'rotated-refresh'); assert.equal(validates, 2);
});

test('Pause during persisted send intent cancels the network submission', async t => {
  const h = harness(t); await h.connect();
  let release;
  h.client.saveHistory = async () => { if (!release) await new Promise(resolve => { release = resolve; }); };
  const sending = h.client.send({ account: 'companion_test', channel: 'friend_channel', text: 'hello' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.client.disconnect(); release();
  await assert.rejects(sending, /disconnected before submission/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/chat/messages')).length, 0);
  assert.equal(h.client.history[0].delivery, 'cancelled');
});

test('connection recovery distinguishes network outages from revoked authorization', async t => {
  const h = harness(t, async url => url.endsWith('/validate') ? response({}, 503) : null);
  await assert.rejects(h.connect()); assert.equal(h.client.status().recoverable, true);
  h.client.fetch = async () => response({}, 401);
  await assert.rejects(h.connect()); assert.equal(h.client.status().recoverable, false);
});

test('duplicate EventSub reconnect notices create just one replacement socket', async t => {
  const h = harness(t); const old = await h.connect();
  const payload = { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=abc' } };
  await h.emit(old, 'session_reconnect', payload); await h.emit(old, 'session_reconnect', payload);
  assert.equal(Socket.all.length, 2);
});

test('Pause cancels in-flight authorization before credentials can be saved', async t => {
  let release;
  const h = harness(t, async url => {
    if (url.endsWith('/device')) return response({ device_code: 'device', user_code: 'code', expires_in: 30, verification_uri: 'https://www.twitch.tv/activate' });
    if (url.endsWith('/token')) return new Promise(resolve => { release = () => resolve(response({ access_token: 'new', refresh_token: 'new-refresh' })); });
  });
  await h.client.startAuthorization('testclient1234', 'companion_test'); h.advance(5000);
  const pending = h.client.pollAuthorization();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.client.disconnect(); release(); await assert.rejects(pending, /cancelled/);
  assert.equal(h.saved.length, 0);
});

test('channel inspection returns fresh bounded metadata and gates restricted destinations', async t => {
  let restricted = false;
  const h = harness(t, async url => {
    if (url.includes('/streams?')) return response({ data: [{ id: '987654321', user_id: '456', user_login: 'friend_channel', title: 'A live stream', game_name: 'Minecraft' }] });
    if (url.includes('/chat/settings?')) return response({ data: [{ broadcaster_id: '456', follower_mode: restricted, subscriber_mode: false, emote_mode: false, slow_mode: false }] });
  });
  let info = await h.client.inspectChannel('companion_test', 'friend_channel');
  assert.equal(info.canReply, true); assert.equal(info.streamContext.streamId, '987654321'); assert.equal(info.streamContext.gameName, 'Minecraft'); assert.equal(info.streamContext.checkedAt, now);
  const count = h.calls.length; await h.client.inspectChannel('companion_test', 'friend_channel'); assert.equal(h.calls.length, count, 'one-minute metadata cache');
  h.advance(61000); restricted = true;
  info = await h.client.inspectChannel('companion_test', 'friend_channel');
  assert.equal(info.canReply, true); assert.equal(info.chatSettings.followersOnly, true); assert.equal(info.reason, '');
  assert.ok(!JSON.stringify(info).includes('secret-access'));
});

test('channel inspection rejects incomplete chat state and cancellation', async t => {
  let release;
  const h = harness(t, async url => {
    if (url.includes('/streams?')) return new Promise(resolve => { release = () => resolve(response({ data: [] })); });
    if (url.includes('/chat/settings?')) return response({ data: [] });
  });
  let checking = h.client.inspectChannel('companion_test', 'friend_channel');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release(); await assert.rejects(checking, /did not confirm/);
  release = null; checking = h.client.inspectChannel('companion_test', 'friend_channel');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.client.disconnect(); release(); await assert.rejects(checking, /cancelled/);
});


test('standalone participation persists intent and sends without a reply parent', async t => {
  let live = true;
  const h = harness(t, async url => {
    if (url.includes('/streams?')) return response({ data: live ? [{ id: '987654321', user_id: '456', user_login: 'friend_channel', title: 'A stream', game_name: 'Minecraft' }] : [] });
    if (url.includes('/chat/settings?')) return response({ data: [{ broadcaster_id: '456', follower_mode: true, subscriber_mode: false, emote_mode: false, slow_mode: false }] });
  });
  await h.connect();
  const intent = { account: 'companion_test', channel: 'friend_channel', text: 'hey chat', kind: 'greeting', category: 'greeting', streamId: '987654321', participationKey: 'companion_test:friend_channel:987654321:greeting' };
  const result = await h.client.send(intent);
  assert.equal(result.delivery, 'confirmed'); assert.equal(result.kind, 'greeting'); assert.equal(result.category, 'greeting');
  const call = h.calls.find(c => c.url.endsWith('/chat/messages'));
  assert.equal(JSON.parse(call.options.body).reply_parent_message_id, undefined);
  assert.ok(h.saved.some(x => Array.isArray(x) && x.some(y => y.participationKey === intent.participationKey && y.delivery === 'pending')));
  h.advance(610000);
  await assert.rejects(h.client.send({ ...intent, text: 'a different greeting' }), /already submitted/);
  live = false; h.advance(61000);
  await assert.rejects(h.client.send({ ...intent, kind: 'topic', participationKey: 'topic', text: 'how is the game going?' }), /no longer permits/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/chat/messages')).length, 1);
});

test('EventSub reply-parent identity survives status normalization', async t => {
  const h = harness(t); const socket = await h.connect();
  await h.emit(socket, 'notification', { event: { broadcaster_user_id: '456', message_id: 'thread-reply', chatter_user_login: 'alice', message: { text: 'hello' }, reply: { parent_message_id: 'someone-elses-message' } } }, { subscription_type: 'channel.chat.message' });
  assert.equal(h.client.status().messages[0].replyParentId, 'someone-elses-message');
});

test('EventSub revocation preserves only its known safe reason and never automatically reconnects', async t => {
  for (const [status, expected] of [['chat_user_banned', /removed this account.*chat_user_banned/],
    ['authorization_revoked', /authorization.*authorization_revoked/], ['user_removed', /user.*user_removed/], ['version_removed', /version.*version_removed/]]) {
    const h = harness(t), socket = await h.connect();
    await h.emit(socket, 'revocation', { subscription: { status, condition: { secret: 'RAW_PRIVATE_PAYLOAD' }, transport: { session_id: 'RAW_PRIVATE_SESSION' } } });
    const state = h.client.status();
    assert.equal(state.connected, false); assert.equal(state.recoverable, false); assert.equal(socket.closed, true);
    assert.match(state.error, expected); assert.doesNotMatch(JSON.stringify(state), /RAW_PRIVATE_PAYLOAD|RAW_PRIVATE_SESSION|secret-access/);
    assert.deepEqual(h.calls.filter(c => c.url.endsWith('/eventsub/subscriptions')).map(c => JSON.parse(c.options.body).type), ['channel.chat.message', 'channel.chat.notification']);
    assert.equal(h.calls.filter(c => c.url.endsWith('/chat/messages')).length, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('missing or unrecognized revocation status stays nonrecoverable without echoing arbitrary data', async t => {
  for (const status of [undefined, 'constructor', 'Bearer RAW_PRIVATE_REASON', { token: 'RAW_PRIVATE_REASON' }]) {
    const h = harness(t), socket = await h.connect();
    await h.emit(socket, 'revocation', { subscription: { status } });
    assert.match(h.client.status().error, /unknown_reason/);
    assert.doesNotMatch(h.client.status().error, /RAW_PRIVATE_REASON|Bearer|constructor/);
    assert.equal(h.client.status().recoverable, false); assert.equal(socket.closed, true);
  }
});

test('channel subscription HTTP403 remains a safe channel-access refusal rather than a generic OAuth instruction', async t => {
  const h = harness(t, async url => url.endsWith('/eventsub/subscriptions')
    ? response({ message: 'RAW_PRIVATE_RESPONSE Bearer secret-access', status: 403 }, 403) : null);
  const socket = await h.connect(), state = h.client.status();
  assert.equal(state.connected, false); assert.equal(state.recoverable, false); assert.equal(socket.closed, true);
  assert.match(state.error, /channel.*subscription.*HTTP 403/);
  assert.match(state.error, /permission or channel access was denied/);
  assert.doesNotMatch(state.error, /RAW_PRIVATE_RESPONSE|secret-access|Connect chat again|Reauthorize/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/eventsub/subscriptions')).length, 1);
  assert.equal(h.calls.filter(c => c.url.endsWith('/chat/messages')).length, 0);
});

test('transient subscription HTTP503 keeps its existing recoverable classification', async t => {
  const h = harness(t, async url => url.endsWith('/eventsub/subscriptions') ? response({}, 503) : null);
  await h.connect();
  assert.equal(h.client.status().connected, false); assert.equal(h.client.status().recoverable, true);
  assert.equal(h.client.status().error, 'Twitch chat connection interrupted.');
});

test('recoverable chat reconnect restores bounded same-room messages after confirmation and rejects replays', async t => {
  const h = harness(t);
  const socket = await h.connect();
  const notify = (ws, messageId, parent = '') => h.emit(ws, 'notification', { event: {
    broadcaster_user_id: '456', message_id: messageId, chatter_user_login: 'viewer', message: { text: 'chat check' },
    ...(parent ? { reply: { parent_message_id: parent } } : {})
  } }, { subscription_type: 'channel.chat.message' });
  await notify(socket, 'expired');
  h.advance(15 * 60_000 + 1);
  await notify(socket, 'parent');
  await notify(socket, 'child', 'parent');
  socket.close();
  assert.deepEqual(h.client.status().messages, []);
  const options = { recoverHistory: true };
  await h.client.connect('companion_test', 'friend_channel', options);
  assert.deepEqual(h.client.status().messages, []);
  // Failure of a first recovery attempt must not lose the earlier receive window.
  Socket.all.at(-1).close();
  await h.client.connect('companion_test', 'friend_channel', options);
  const replacement = Socket.all.at(-1);
  await h.emit(replacement, 'session_welcome', { session: { id: 'recovery', keepalive_timeout_seconds: 10 } });
  await notify(replacement, 'child', 'parent');
  await notify(replacement, 'after');
  const entries = h.client.status({ includeRecovered: true }).messages;
  assert.deepEqual(h.client.status().messages.map(m => m.id), ['child', 'after']);
  assert.deepEqual(entries.map(m => m.id), ['parent', 'child', 'after']);
  assert.equal(entries[1].replyParentId, 'parent');
});

test('explicit stop, a new Start, revocation and room changes drop interrupted chat', async t => {
  let login = 'friend_channel', broadcasterId = '456';
  const h = harness(t, async url => url.includes('/users?') ? response({ data: [{ id: broadcasterId, login }] }) : null);
  const options = { recoverHistory: true };
  for (const change of ['stop', 'new start', 'revocation', 'different room', 'reassigned login', 'expired messages']) {
    login = 'friend_channel'; broadcasterId = '456';
    const socket = await h.connect();
    await h.emit(socket, 'notification', { event: { broadcaster_user_id: '456', message_id: 'old',
      chatter_user_login: 'viewer', message: { text: 'old' } } }, { subscription_type: 'channel.chat.message' });
    socket.close();
    if (change === 'stop') h.client.disconnect();
    if (change === 'revocation') h.client.fail('Authorization revoked.');
    if (change === 'different room') login = 'different_room';
    if (change === 'reassigned login') broadcasterId = '777';
    if (change === 'expired messages') h.advance(15 * 60_000 + 1);
    await h.client.connect('companion_test', login, change === 'new start' ? {} : options);
    await h.emit(Socket.all.at(-1), 'session_welcome', { session: { id: change } });
    assert.deepEqual(h.client.status({ includeRecovered: true }).messages, [], change);
    h.client.disconnect();
  }
});
