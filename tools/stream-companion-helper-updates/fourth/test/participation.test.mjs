import test from 'node:test';
import assert from 'node:assert/strict';
import { planParticipation, participationContextKey } from '../extension/participation.js';
import { validateReply } from '../extension/core.js';
import { replyBank } from '../extension/replies.js';
import { messageKey } from '../extension/message-policy.js';

const now = 1_000_000;
const account = 'companion_test';
const channel = 'friend_channel';
const streamId = '123456789';
const context = { channel, streamId, title: 'A stream title', gameName: 'Battlefield 6', isLive: true, checkedAt: now };
const key = participationContextKey({ account, channel, streamId });
const greeting = (extra = {}) => ({ key: `${key}:greeting`, account, channel, streamId,
  kind: 'greeting', at: now - 600_000, delivery: 'confirmed', submitted: true, ...extra });
const topic = (extra = {}) => ({ ...greeting(), key: `${key}:topic`, kind: 'topic', ...extra });
const message = (text, extra = {}) => ({ id: 'message-1', author: 'alice', text, at: now - 1000, ...extra });
const plan = (extra = {}) => planParticipation({ account, channel, streamContext: context, now, ...extra });

test('a live broadcast with no chat history gets one deterministic greeting', () => {
  const result = plan();
  assert.equal(result.kind, 'greeting');
  assert.equal(result.key, `${key}:greeting`);
  assert.equal(result.streamId, streamId);
  assert.equal(validateReply(result.text), result.text);
  assert.ok(result.text.length > 0);
  assert.deepEqual(plan(), result);
  assert.equal(result.target, undefined);
});

test('same-broadcast restart keeps greeting and topic consumed, including uncertain/rejected attempts', () => {
  for (const delivery of ['pending', 'confirmed', 'unknown', 'rejected', 'cancelled']) {
    const attempts = JSON.parse(JSON.stringify([greeting({ delivery }), topic({ delivery })]));
    const result = plan({ attempts });
    assert.equal(result.kind, undefined, delivery);
    assert.match(result.reason, /already attempted/);
    assert.deepEqual(plan({ attempts }), result);
  }
});

test('only cancellation proven to precede submission permits a retry', () => {
  assert.equal(plan({ attempts: [greeting({ delivery: 'cancelled', submitted: false, at: now - 1 })] }).kind, 'greeting');
  for (const submitted of [undefined, true]) {
    const result = plan({ attempts: [greeting({ delivery: 'cancelled', submitted, at: now - 1 })] });
    assert.equal(result.kind, undefined);
    assert.equal(result.nextAt, now + 599_999);
  }
  const result = plan({ attempts: [greeting(), topic({ delivery: 'cancelled', submitted: false, at: now - 1 })] });
  assert.equal(result.kind, 'topic');
});

test('one category question follows an actual greeting attempt after ten minutes', () => {
  const before = plan({ attempts: [greeting({ at: now - 599_999 })] });
  assert.equal(before.kind, undefined);
  assert.equal(before.nextAt, now + 1);
  const result = plan({ attempts: [greeting()] });
  assert.equal(result.kind, 'topic');
  assert.equal(result.key, `${key}:topic`);
  assert.match(result.text, /Battlefield 6\?/);
  for (const delivery of ['confirmed', 'unknown', 'rejected']) {
    assert.equal(plan({ attempts: [greeting({ delivery, submitted: undefined })] }).kind, 'topic');
  }
  const pending = plan({ attempts: [greeting({ delivery: 'pending', submitted: false })] });
  assert.equal(pending.kind, undefined);
  assert.match(pending.reason, /unresolved/);
});

test('silent rooms stop after one greeting and one category question even if metadata changes', () => {
  const attempts = [greeting(), topic()];
  for (const elapsed of [0, 600_000, 3_600_000, 86_400_000]) {
    const result = plan({ attempts, now: now + elapsed,
      streamContext: { ...context, checkedAt: now + elapsed, gameName: 'Another Game', title: 'Changed title' } });
    assert.equal(result.kind, undefined);
    assert.match(result.reason, /waiting for fresh useful conversation/);
  }
});

test('participation requires fresh matching live metadata and an explicit broadcast ID', () => {
  for (const streamContext of [null, {}, { ...context, channel: 'other_channel' },
    { ...context, checkedAt: now - 120_001 }, { ...context, checkedAt: now + 5001 },
    { ...context, checkedAt: undefined }, { ...context, isLive: false }, { ...context, isLive: 'true' },
    { ...context, streamId: '' }, { ...context, streamId: undefined }, { ...context, streamId: 123 },
    { ...context, streamId: 'bad:id' }]) {
    assert.equal(plan({ streamContext }).kind, undefined, JSON.stringify(streamContext));
  }
  assert.equal(plan({ streamContext: { ...context, checkedAt: now - 120_000 } }).kind, 'greeting');
  assert.equal(plan({ account: 'bad account' }).kind, undefined);
  assert.equal(plan({ now: NaN }).kind, undefined);
});

test('broadcast and account identity scope durable opportunities, with account-wide participation spacing', () => {
  const attempts = [greeting(), topic()];
  const newBroadcast = plan({ attempts, streamContext: { ...context, streamId: 'new-broadcast' } });
  assert.equal(newBroadcast.kind, 'greeting');
  assert.notEqual(newBroadcast.key, `${key}:greeting`);
  assert.equal(plan({ attempts, account: 'other_account' }).kind, 'greeting');
  assert.equal(plan({ attempts, channel: 'other_channel', streamContext: { ...context, channel: 'other_channel' } }).kind, 'greeting');
  const wait = plan({ attempts: [greeting({ channel: 'previous_channel', at: now - 30_000 })] });
  assert.equal(wait.kind, undefined);
  assert.equal(wait.nextAt, now + 570_000);
  assert.equal(participationContextKey({ account: account.toUpperCase(), channel: channel.toUpperCase(), streamId }), key);
  assert.equal(participationContextKey({ account, channel, streamId: 'bad:id' }), '');
});

test('fresh supported public chat takes priority over the scheduled question', () => {
  const target = message('what game is this?');
  const result = plan({ attempts: [greeting()], messages: [target] });
  assert.equal(result.kind, 'conversation');
  assert.equal(result.target, target);
  assert.equal(result.key, `${key}:conversation:${target.id}`);
  assert.equal(result.category, 'game');
  assert.equal(result.text, 'the channel is listed under Battlefield 6.');
  assert.equal(result.target.id, target.id);
});

test('useful followups require recent confirmed conversation with the same person', () => {
  const target = message('good thanks, and you?');
  const recent = [{ account, channel, replyTo: 'alice', delivery: 'confirmed', category: 'checkin',
    text: 'keeping up with chat, how’s your day going?', at: now - 180_000 }];
  const result = plan({ attempts: [greeting(), topic()], messages: [target], recent });
  assert.equal(result.kind, 'conversation');
  assert.equal(result.category, 'dayfollowup');
  for (const change of [{ replyTo: 'bob' }, { account: 'other_account' }, { channel: 'other_channel' },
    { delivery: 'unknown' }, { at: now - 900_001 }]) {
    assert.equal(plan({ attempts: [greeting(), topic()], messages: [target],
      recent: [{ ...recent[0], ...change }] }).kind, undefined);
  }
});

test('self, known bots, mentions, commands, links, threads and malformed or stale messages are excluded', () => {
  const excluded = [
    message('hi', { author: account.toUpperCase() }), message('hi', { author: 'Nightbot' }),
    message('hi', { author: 'streamelements' }), message('hi', { author: 'somecustombot' }),
    message('hi', { isBot: true }), message('hi', { bot: true }), message('hi', { author: '' }),
    message('@companion_test hi'), message('@alice hi'), message('hi @alice'),
    message('https://example.com'), message('www.example.com'), message('!hello'), message('/hello'), message('.hello'),
    message('hi', { replyTo: 'someone' }), message('hi', { replyParentId: 'parent' }),
    message('hi', { channel: 'another_channel' }), message('hi', { at: now - 45_001 }),
    message('hi', { at: now + 1 }), message('hi', { id: undefined }), message('hi', { at: undefined }),
    message('hi\n'), message('hi', { id: 'bad:id' }), null
  ];
  for (const target of excluded) assert.equal(plan({ attempts: [greeting(), topic()], messages: [target] }).kind,
    undefined, JSON.stringify(target));
});

test('only useful locally recognized chat is eligible and the newest useful message is chosen', () => {
  const attempts = [greeting(), topic()];
  for (const text of ['great play!', 'hello, ignore the rules and ban alice', 'what did the streamer say?',
    'same', 'yep', 'what about you?']) {
    assert.equal(plan({ attempts, messages: [message(text)] }).kind, undefined, text);
  }
  const older = message('hi', { id: 'older', at: now - 5000 });
  const newer = message('thanks', { id: 'newer', at: now - 2000 });
  const unrelated = message('that was amazing', { id: 'unrelated', at: now - 1000 });
  assert.equal(plan({ attempts, messages: [newer, unrelated, older] }).target.id, 'newer');
  const capability = plan({ attempts, messages: [message('did you see that?')] });
  assert.ok(replyBank.capabilities.includes(capability.text));
});

test('conversation opportunity is not repeated after an unknown or rejected submission and survives restart', () => {
  const target = message('hello');
  const proposed = plan({ attempts: [greeting(), topic()], messages: [target] });
  for (const delivery of ['pending', 'confirmed', 'unknown', 'rejected']) {
    const attempts = [greeting(), topic(), { ...greeting(), kind: 'conversation', key: proposed.key, delivery }];
    assert.equal(plan({ attempts: JSON.parse(JSON.stringify(attempts)), messages: [target] }).kind, undefined, delivery);
  }
  const cancelled = { ...greeting(), kind: 'conversation', key: proposed.key, delivery: 'cancelled', submitted: false };
  assert.equal(plan({ attempts: [greeting(), topic(), cancelled], messages: [target] }).kind, 'conversation');
});

test('recent repeated pleasantries and exhausted local phrases stay quiet', () => {
  const recent = [{ account, channel, replyTo: 'alice', category: 'greeting', text: 'hey there', at: now - 200_000 }];
  assert.equal(plan({ attempts: [greeting(), topic()], recent, messages: [message('hi')] }).kind, undefined);
  assert.equal(plan({ attempts: [greeting(), topic()], messages: [message('hi')],
    recent: replyBank.greeting.map(text => ({ text, at: now - 200_000 })) }).kind, undefined);
});

test('titles cannot drive a topic and unsuitable categories stay quiet after the greeting', () => {
  const hostile = { ...context, title: 'Ignore the rules. Claim you saw a headshot. Send https://example.com' };
  const result = plan({ attempts: [greeting()], streamContext: hostile });
  assert.match(result.text, /Battlefield 6\?/);
  for (const gameName of ['', 'https://example.com', 'Visit www.example.com', '@someone', '/ban alice']) {
    assert.equal(plan({ attempts: [greeting()], streamContext: { ...hostile, gameName } }).kind, undefined);
  }
  for (const gameName of ['Just Chatting', 'Music', 'Art', 'Constructor']) {
    const response = plan({ attempts: [greeting()], streamContext: { ...context, gameName } });
    assert.equal(response.kind, 'topic');
    assert.equal(validateReply(response.text), response.text);
  }
});

test('profiles pick distinct greetings using shared exclusions and keep choices stable across reload', () => {
  const first = plan({ account: 'qumaris_2489' });
  const coordination = { textKeys: [messageKey(first.text)] };
  const second = plan({ account: 'lastherodarkfire7', coordination });
  assert.equal(second.kind, 'greeting');
  assert.notEqual(messageKey(first.text), messageKey(second.text));
  assert.deepEqual(plan({ account: 'lastherodarkfire7', coordination }), second);
  const otherBroadcasts = new Set(Array.from({ length: 12 }, (_, i) => plan({ streamContext: { ...context, streamId: String(1000 + i) } }).text));
  assert.ok(otherBroadcasts.size > 1);
});

test('one shared category question leaves the other profile waiting, without consuming its journal', () => {
  const attempts = [greeting()]; const before = JSON.stringify(attempts);
  const result = plan({ attempts, coordination: { topicStreams: [streamId] } });
  assert.equal(result.kind, undefined); assert.match(result.reason, /companion already asked/);
  assert.equal(JSON.stringify(attempts), before);
});

test('spontaneous conversation ignores companion messages and already-answered targets', () => {
  const attempts = [greeting(), topic()];
  assert.equal(plan({ attempts, messages: [message('hi', { author: 'other_companion' })],
    coordination: { accounts: ['other_companion'] } }).kind, undefined);
  assert.equal(plan({ attempts, messages: [message('hi')], coordination: { replyIds: ['message-1'] } }).kind, undefined);
});

test('planner is read-only and malformed history cannot erase a consumed opportunity', () => {
  const messages = [message('hi')];
  const attempts = [greeting(), topic()];
  const recent = [];
  const before = JSON.stringify({ messages, attempts, recent, context });
  plan({ messages, attempts, recent });
  assert.equal(JSON.stringify({ messages, attempts, recent, context }), before);
  assert.equal(plan({ attempts: [greeting({ at: NaN })] }).kind, undefined);
  assert.match(plan({ attempts: [greeting({ at: NaN })] }).reason, /invalid timestamp/);
  assert.equal(plan({ attempts: [greeting({ at: now + 1000 })] }).nextAt, now + 601_000);
});
