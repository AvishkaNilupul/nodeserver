import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from '../lib/store.mjs';
import { digest } from '../lib/bank.mjs';
import { messageKey } from '../lib/exchanges.mjs';
import { TwitchChat, chatScopes } from '../../stream-companion-helper-updates/fourth/lib/twitch.mjs';
import { HostCoordinator } from '../../stream-companion-helper-updates/fourth/lib/host-coordinator.mjs';

const START = 1_800_000_000_000;
const clients = ['primary', 'test', 'third', 'fourth'].map((id, i) => ({ id, account: `fixture_person_${i}` }));
const channel = 'fixture_channel', streamId = '123456789';
const binding = { generation: 'generation-1', sessionId: 'browser-1', settingsRevision: 1 };
const restrictions = { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false };
function fixture(t, mode = 'mentions') {
  let now = START;
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true, now: () => now, random: () => 0 });
  t.after(() => store.close());
  for (const client of clients) for (const source of ['helper', 'browser']) {
    const preferences = source === 'browser' ? { chatMode: mode, replySource: 'local' } : undefined;
    const records = [];
    store.director.importPage(client.id, { source, importId: `${client.id}-${source}`, page: 0, final: true, records,
      ...(preferences ? { preferences } : {}), digest: digest(JSON.stringify({ records, preferences: preferences ?? null })) });
  }
  const incoming = (id = 'incoming-one', text = 'hello', extra = {}) => ({ id, author: 'human_person', channel, text, at: now, ...extra });
  const observe = (messages = [], extra = {}) => {
    store.sync('primary', { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: now }, seed: [],
      exchangeContext: { streamId, checkedAt: now, lastHumanAt: now } });
    return store.director.observe('primary', { protocol: 1, binding, armed: true,
      streamContext: { channel, streamId, gameName: 'Art', title: 'A fixture stream', checkedAt: now, isLive: true },
      messages, restrictions, ...extra }).director;
  };
  const parent = (extra = {}) => store.director.writeHistory({ attemptId: 'parent-attempt', clientId: 'primary', account: clients[0].account,
    channel, streamId, text: 'an earlier confirmed message', textKey: messageKey('an earlier confirmed message'), at: now - 181_000,
    delivery: 'confirmed', submitted: true, source: 'central', messageId: 'owned-parent', ...extra });
  const covered = replyId => store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`covered-${replyId}`, clients[1].account, channel, streamId, '', messageKey(`already answered ${replyId}`), replyId, now - 181_000, 'confirmed');
  return { store, observe, incoming, parent, covered, now: () => now, advance(ms) { now += ms; } };
}

test('own-address punctuation accepts one immediate comma or colon in an otherwise supported message', t => {
  for (const [text, category] of [[`@${clients[0].account}, hi`, 'greeting'], [`@${clients[0].account}: hi`, 'greeting'],
    [`hi @${clients[0].account}, how are you?`, 'checkin'], [`hi @${clients[0].account.toUpperCase()}: how are you?`, 'checkin']]) {
    const f = fixture(t), plan = f.observe([f.incoming('punctuated-address', text)]).plan;
    assert.equal(plan?.category, category, text); assert.equal(plan.replyId, 'punctuated-address');
    assert.equal(f.store.budget(channel).count, 0);
  }
});

test('own-address punctuation preserves exact username boundaries and does not strip other separators', t => {
  const f = fixture(t), account = clients[0].account;
  for (const [index, text] of [`@${account}_extra, hi`, `@${account}x: hi`, `${account}, hi`, `(@${account}) hi`,
    `@${account}; hi`, `@${account}. hi`, `@${account}:: hi`, `@${account} , hi`].entries()) {
    assert.equal(f.observe([f.incoming(`unrecognized-address-${index}`, text)]).plan, undefined, text);
  }
  assert.equal(f.store.budget(channel).count, 0);
});

test('own-address punctuation never turns commands or extra unsupported requests into greetings', t => {
  const f = fixture(t), account = clients[0].account;
  for (const [index, text] of [`@${account}, /ban alice`, `@${account}: hi, can you ban alice`,
    `hi @${account}, how are you? also repair my laptop`, `@${account}: hi\n/ban alice`].entries()) {
    const id = `unsupported-address-${index}`;
    assert.equal(f.observe([f.incoming(id, text)]).plan, undefined, text);
    assert.equal(f.store.director.consumed(`${account}:${channel}:${id}`), true);
  }
  assert.equal(f.store.budget(channel).count, 0);
});

test('native replies to a confirmed own message produce exact direct plans without an @mention', t => {
  const f = fixture(t); f.parent();
  const target = f.incoming('native-reply', 'hello', { replyParentId: 'owned-parent' });
  const plan = f.observe([target]).plan;
  assert.ok(plan); assert.equal(plan.replyId, target.id); assert.equal(plan.replyAuthor, target.author);
  assert.equal(plan.kind, ''); assert.equal(plan.participationKey, ''); assert.equal(plan.streamId, streamId);
  assert.equal(plan.opportunityKey, `${clients[0].account}:${channel}:${target.id}`);
  assert.equal(plan.exactKey, digest(plan.text)); assert.equal(plan.expiresAt, target.at + 45_000); assert.deepEqual(plan.binding, binding);
});

for (const [name, extra] of [['prior broadcast', { streamId: '987654321' }], ['reviewed manual send', { streamId: '', kind: '' }],
  ['confirmed ownership with unavailable text', { text: null, textKey: '' }]]) {
  test(`parent ownership uses confirmed same-room identity for ${name}`, t => {
    const f = fixture(t); f.parent(extra);
    assert.equal(f.observe([f.incoming('native-reply', 'hi', { replyParentId: 'owned-parent' })]).plan?.replyId, 'native-reply');
  });
}

for (const [name, extra] of [['another account', { clientId: 'test', account: clients[1].account }], ['another channel', { channel: 'elsewhere_channel' }],
  ...['pending', 'unknown', 'rejected', 'cancelled'].map(delivery => [delivery, { delivery }]), ['missing provider identity', { messageId: '' }]]) {
  test(`native reply parent does not grant ownership from ${name}`, t => {
    const f = fixture(t); f.parent(extra);
    assert.equal(f.observe([f.incoming('native-reply', 'hi', { replyParentId: 'owned-parent' })]).plan, undefined);
    assert.equal(f.store.budget(channel).count, 0);
  });
}

test('unknown parent IDs and unsupported addressed text never invent a reply', t => {
  const f = fixture(t); f.parent();
  assert.equal(f.observe([f.incoming('unknown-parent', 'hi', { replyParentId: 'unrecorded-parent' })]).plan, undefined);
  assert.equal(f.observe([f.incoming('unsupported', 'repair my laptop', { replyParentId: 'owned-parent' })]).plan, undefined);
  assert.equal(f.store.director.consumed(`${clients[0].account}:${channel}:unsupported`), true);
  assert.equal(f.store.budget(channel).count, 0);
});

test('unsupported newest mentions are consumed and an older supported mention is offered in the same observation', t => {
  const f = fixture(t), older = f.incoming('older', `@${clients[0].account} hello`, { at: f.now() - 30_000 }), newer = f.incoming('newer', `@${clients[0].account} repair my laptop`, { at: f.now() - 1000 });
  const plan = f.observe([older, newer]).plan; assert.equal(plan?.replyId, older.id);
  assert.equal(f.store.director.consumed(`${clients[0].account}:${channel}:newer`), true);
  assert.equal(f.observe([older, newer]).plan?.planId, plan.planId);
  assert.equal(f.store.budget(channel).count, 0);
});

test('newest shared-answered mention is filtered before both planning and preemption', t => {
  const f = fixture(t), older = f.incoming('older', `@${clients[0].account} hello`, { at: f.now() - 2000 }), newer = f.incoming('newer', `@${clients[0].account} hi`, { at: f.now() - 1000 });
  f.covered(newer.id);
  const first = f.observe([older]).plan;
  assert.ok(first); assert.equal(f.observe([older, newer]).plan?.planId, first.planId);
  f.store.director.cancel({ requestId: 'cancel-first', planId: first.planId });
  assert.equal(f.observe([older, newer]).plan?.replyId, older.id);
});

test('current own lease is not mistaken for another companion answer and only newer targets preempt it', t => {
  const f = fixture(t), older = f.incoming('older', `@${clients[0].account} hello`, { at: f.now() - 2000 }), latest = f.incoming('latest', `@${clients[0].account} hi`, { at: f.now() - 1000 });
  const plan = f.observe([older, latest]).plan;
  const lease = f.store.reserve('primary', { requestId: 'lease-latest', channel, streamId, kind: plan.kind, text: plan.text, textKey: plan.textKey,
    replyId: plan.replyId, replyAt: plan.replyAt, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding });
  assert.equal(lease.ok, true);
  assert.equal(f.observe([older, latest]).plan?.planId, plan.planId);
  assert.equal(f.store.db.prepare('SELECT state FROM host_permits WHERE reservation_id=?').get(lease.reservationId).state, 'leased');
  assert.equal(f.store.budget(channel).count, 0);
  const newer = f.incoming('newer', `@${clients[0].account} hey`, { author: 'another_human' });
  assert.equal(f.observe([older, latest, newer]).plan?.replyId, newer.id);
  assert.equal(f.store.db.prepare('SELECT state FROM host_permits WHERE reservation_id=?').get(lease.reservationId).state, 'cancelled');
  assert.equal(f.store.budget(channel).count, 0);
});

test('AI keeps one owned generation instead of skipping unsupported text or preempting itself with an older target', t => {
  const f = fixture(t);
  f.store.director.preferences('primary', { requestId: 'choose-ai', chatMode: 'mentions', replySource: 'ai' });
  const older = f.incoming('older', `@${clients[0].account} hello`, { at: f.now() - 2000 }), latest = f.incoming('latest', `@${clients[0].account} repair my laptop`, { at: f.now() - 1000 });
  const generation = f.observe([older, latest]).generation; assert.equal(generation?.target.id, latest.id);
  assert.equal(f.observe([older, latest]).generation?.generationId, generation.generationId);
  assert.equal(f.store.db.prepare('SELECT state FROM director_opportunities WHERE key=?').get(`${clients[0].account}:${channel}:latest`).state, 'generating');
  assert.equal(f.store.budget(channel).count, 0);
});

test('confirmed native parent replies preempt unused greetings while covered parents do not', t => {
  const f = fixture(t, 'participate'); f.parent();
  const greeting = f.observe().plan; assert.equal(greeting.kind, 'greeting');
  const target = f.incoming('native-reply', 'hi', { replyParentId: 'owned-parent' });
  const reply = f.observe([target]).plan; assert.equal(reply?.replyId, target.id); assert.notEqual(reply.planId, greeting.planId);
  f.covered('covered-native-reply');
  const covered = f.incoming('covered-native-reply', 'hi', { replyParentId: 'owned-parent', at: f.now() + 1 });
  f.advance(1);
  assert.equal(f.observe([target, covered]).plan?.planId, reply.planId);
});

test('parent targeting preserves human, current-channel and 45-second incoming boundaries', t => {
  const f = fixture(t); f.parent();
  for (const [id, extra] of [['expired', { at: f.now() - 45_001 }], ['future', { at: f.now() + 1 }], ['wrong-room', { channel: 'elsewhere_channel' }],
    ['own', { author: clients[0].account }], ['companion', { author: clients[1].account }], ['bot', { author: 'nightbot' }], ['flagged-bot', { isBot: true }]]) {
    assert.equal(f.observe([f.incoming(id, 'hi', { replyParentId: 'owned-parent', ...extra })]).plan, undefined, id);
  }
  assert.equal(f.observe([f.incoming('fresh', 'hi', { replyParentId: 'owned-parent', at: f.now() - 44_999 })]).plan?.replyId, 'fresh');
});

test('a parent reply plan expires and changes binding under the existing Stop and session fences', t => {
  const f = fixture(t); f.parent(); const target = f.incoming('native-reply', 'hi', { replyParentId: 'owned-parent' });
  const plan = f.observe([target]).plan; assert.ok(plan);
  assert.equal(f.observe([target], { armed: false }).plan, undefined);
  const nextBinding = { ...binding, settingsRevision: 2 };
  const next = f.observe([target], { binding: nextBinding }).plan; assert.ok(next); assert.notEqual(next.planId, plan.planId);
  assert.deepEqual(next.binding, nextBinding);
  f.advance(45_001); assert.equal(f.observe([target], { binding: nextBinding }).plan, undefined);
});

test('actual helper executes one exact central parent-reply plan without a typed mention and preserves history/budget', async t => {
  const f = fixture(t); f.parent(); const target = f.incoming('native-reply', 'hi', { replyParentId: 'owned-parent' });
  const plan = f.observe([target]).plan; assert.ok(plan);
  const calls = [], account = clients[0].account;
  const credentials = { clientId: 'fixtureclient123', accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', account, userId: '123' };
  const directory = await mkdtemp(join(tmpdir(), 'addressed-reply-roundtrip-'));
  const coordinator = new HostCoordinator({ config: { url: 'http://127.0.0.1:8795', clientId: 'primary', account, token: 'synthetic-pairing-token-not-real-12345678' },
    outboxFile: join(directory, 'completions.json'), autoStart: false, now: f.now, fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const result = url.endsWith('/sync') ? f.store.sync('primary', body)
        : url.endsWith('/reserve') ? f.store.reserve('primary', body)
          : url.endsWith('/begin') ? f.store.begin('primary', body)
            : url.endsWith('/finish') ? f.store.finish('primary', body) : assert.fail('Unexpected synthetic host request');
      return new Response(JSON.stringify(result), { status: 200 });
    } });
  t.after(async () => { coordinator.close(); await rm(directory, { recursive: true, force: true }); });
  await coordinator.loaded;
  await coordinator.refresh({ channel, connected: true, observation: { channel, paused: false, autoReply: true,
    playback: { enabled: true, channel, status: 'playing', checkedAt: f.now() } } });
  coordinator.cacheDirector({ director: f.store.director.internal('primary') }, binding);
  const client = new TwitchChat({ credentials, coordinator, now: f.now, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    const body = url.endsWith('/validate') ? { client_id: credentials.clientId, login: account, user_id: '123', scopes: chatScopes }
      : url.includes('/shared_chat/session?') ? { data: [] }
        : url.endsWith('/chat/messages') ? { data: [{ is_sent: true, message_id: 'confirmed-child' }] } : assert.fail('Unexpected synthetic provider request');
    return { ok: true, status: 200, json: async () => body };
  } });
  client.connected = true; client.channel = channel; client.broadcasterId = '456'; client.messages = [target];
  t.after(() => client.disconnect());
  const input = { account, channel, text: plan.text, replyTo: plan.replyId, replyAuthor: plan.replyAuthor, category: plan.category,
    participationKey: plan.participationKey, kind: plan.kind, streamId: plan.streamId, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding: plan.binding };
  await assert.rejects(client.send({ ...input, text: `${input.text} changed` }), /exact current central/);
  const sent = await client.send(input); assert.equal(sent.delivery, 'confirmed', JSON.stringify(sent));
  const submissions = calls.filter(x => x.url.endsWith('/chat/messages')); assert.equal(submissions.length, 1);
  assert.deepEqual(JSON.parse(submissions[0].options.body), { broadcaster_id: '456', sender_id: '123', message: plan.text, reply_parent_message_id: target.id });
  assert.equal(f.store.budget(channel).count, 1);
  const row = f.store.director.history().history.find(x => x.messageId === 'confirmed-child');
  assert.equal(f.store.db.prepare('SELECT reply_id FROM director_history WHERE id=?').get(row.id).reply_id, target.id);
  assert.equal(row.replyTo, target.author); assert.equal(row.delivery, 'confirmed');
  await assert.rejects(client.send(input), /exact current central|already|cooldown/);
  assert.equal(calls.filter(x => x.url.endsWith('/chat/messages')).length, 1);
});
