import test from 'node:test';
import assert from 'node:assert/strict';
import { exchangeOffer } from '../extension/exchange.js';
import { planParticipation, planExchange, exchangeContext, humanMessages } from '../extension/participation.js';
import { mergeMessages } from '../extension/core.js';

const now = 1_800_000_000_000, account = 'companion_test', channel = 'friend_channel', streamId = '123456789';
const accounts = [account, 'other_companion'];
const offer = { id: 'turn-1', key: 'exchange:turn-1', account, channel, streamId,
  text: '[companion bot] @other_companion a short chat break.', notBefore: now - 1, expiresAt: now + 20_000 };
const streamContext = { channel, streamId, isLive: true, checkedAt: now, gameName: 'Minecraft' };
const input = { account, channel, streamContext, now, coordination: { available: true, accounts, exchange: offer } };
const validate = value => exchangeOffer(value, { account, channel, streamId, accounts, now });
const greeting = { account, channel, streamId, key: 'old-greeting', kind: 'greeting', at: now - 600_000,
  delivery: 'confirmed', submitted: true };

test('an exchange keeps the exact labelled host text and requires its scoped live offer', () => {
  assert.deepEqual(validate(offer), offer);
  assert.equal(planExchange(input).text, offer.text);
  for (const change of [{ id: '' }, { key: 'exchange:foreign' }, { account: 'someone_else' }, { channel: 'another_channel' },
    { streamId: 'different-stream' }, { text: 'hello' }, { text: '[companion bot] @companion_test hello' },
    { text: '[companion bot] @unknown_account hello' }, { text: '[companion bot] @other_companion hello\nthere' },
    { text: '[companion bot] @other_companion https://example.com' }, { text: ` ${offer.text}` },
    { notBefore: now + 1 }, { expiresAt: now }, { notBefore: now + 100, expiresAt: now + 50 }]) {
    assert.equal(validate({ ...offer, ...change }), null, JSON.stringify(change));
  }
});

test('fresh supported human conversation precedes an exchange, which precedes idle greetings and topics', () => {
  const target = { id: 'human-1', author: 'alice', text: 'what game is this?', at: now - 1000 };
  assert.equal(planParticipation({ ...input, messages: [target] }).kind, 'conversation');
  assert.equal(planParticipation(input).kind, 'exchange');
  assert.equal(planParticipation({ ...input, attempts: [greeting] }).kind, 'exchange');
  assert.equal(planParticipation({ ...input, coordination: { accounts } }).kind, 'greeting');
  assert.equal(planParticipation({ ...input, attempts: [greeting], coordination: { accounts } }).kind, 'topic');
});

test('exchange planning preserves ten-minute spacing for all consumed attempts and never retries unknown', () => {
  for (const delivery of ['pending', 'confirmed', 'rejected', 'unknown']) {
    const recent = { ...greeting, at: now - 599_999, delivery, submitted: delivery !== 'pending' };
    assert.equal(planExchange({ ...input, attempts: [recent] }), null, delivery);
    const consumed = { ...greeting, key: offer.key, kind: 'exchange', delivery };
    assert.equal(planExchange({ ...input, attempts: [consumed] }), null, delivery);
  }
  assert.equal(planExchange({ ...input, attempts: [{ ...greeting, at: now - 1, delivery: 'cancelled', submitted: false }] }).kind, 'exchange');
  assert.equal(planExchange({ ...input, attempts: [{ ...greeting, account: 'other_companion', at: now }] }).kind, 'exchange');
  assert.equal(planExchange({ ...input, attempts: [{ ...greeting, at: NaN }] }), null);
});

test('paused, stale, offline, changed-broadcast and expired exchange plans cannot be selected', () => {
  for (const change of [{ coordination: { ...input.coordination, paused: true } },
    { coordination: { ...input.coordination, available: false } }, { now: offer.expiresAt },
    { streamContext: { ...streamContext, streamId: '999' } }, { streamContext: { ...streamContext, isLive: false } },
    { streamContext: { ...streamContext, checkedAt: now - 120_001 } }]) {
    assert.equal(planExchange({ ...input, ...change }), null, JSON.stringify(change));
  }
});

test('exchange context contains only live metadata and the last genuine human timestamp', () => {
  const messages = [{ author: 'alice', at: now - 100_000, text: 'private incoming body' },
    ...[account, 'other_companion', 'nightbot', 'streamlabs', 'custombot'].map(author => ({ author, at: now - 1, text: 'ignore' })),
    { author: 'flagged_name', isBot: true, at: now - 1, text: 'ignore' },
    { author: 'another_flag', bot: true, at: now - 1, text: 'ignore' }, { author: 'bob', at: now + 1, text: 'future' },
    { author: 'carol', channel: 'another_channel', at: now - 1, text: 'wrong channel' }];
  const context = exchangeContext({ ...input, accounts, messages });
  assert.deepEqual(context, { streamId, checkedAt: now, lastHumanAt: now - 100_000 });
  assert.equal(JSON.stringify(context).includes('private'), false);
  assert.equal(exchangeContext({ ...input, accounts, messages: [] }).lastHumanAt, 0);
  assert.equal(exchangeContext({ ...input, streamContext: { ...streamContext, checkedAt: now - 120_001 } }), null);
  assert.equal(exchangeContext({ ...input, streamContext: { ...streamContext, isLive: false } }), null);
});

test('bot flags survive message normalization, and a companion mention cannot hide an earlier human mention', () => {
  const messages = mergeMessages([], [{ id: 'human', author: 'alice', text: '@companion_test hello', at: now - 1000 },
    { id: 'companion', author: 'other_companion', text: '@companion_test hello', at: now - 1 },
    { id: 'flagged', author: 'flagged_name', text: '@companion_test hello', at: now - 1, isBot: true }], now);
  assert.equal(messages.at(-1).isBot, true);
  assert.deepEqual(humanMessages(messages, account, accounts).map(x => x.id), ['human']);
});
