import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNativeEvent, mergeNativeEvents, currentNativeEvent, validNativeEvent, NATIVE_EVENT_LIMIT } from '../extension/native-events.js';

const at = 1_800_000_000_000, channel = 'fixture_channel';
const context = { channel, broadcasterId: '456', at, subscriptionType: 'channel.chat.notification' };
const raw = (notice_type, extra = {}) => ({ broadcaster_user_id: '456', broadcaster_user_login: channel, message_id: 'native-one',
  notice_type, [notice_type]: {}, ...extra });

test('bits require native positive cheer evidence and retain no text, actor or amount', () => {
  const event = normalizeNativeEvent(raw('text', { cheer: { bits: 100 }, message: { text: 'PRIVATE_TEXT' }, chatter_user_login: 'private_actor' }),
    { ...context, subscriptionType: 'channel.chat.message' });
  assert.deepEqual(event, { id: 'bits:native-one', channel, type: 'bits', at });
  for (const bits of [0, -1, '100', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(normalizeNativeEvent(raw('text', { cheer: { bits } }), { ...context, subscriptionType: 'channel.chat.message' }), null);
  }
  assert.equal(normalizeNativeEvent(raw('text', { message: { text: 'Cheer100' } }), { ...context, subscriptionType: 'channel.chat.message' }), null);
});

test('supported notices include anonymous/textless facts without inventing names or counts', () => {
  for (const [notice, type] of [['sub', 'sub'], ['resub', 'resub'], ['sub_gift', 'gift']]) {
    assert.deepEqual(normalizeNativeEvent(raw(notice, { chatter_is_anonymous: true, chatter_user_login: 'must_not_be_retained' }), context),
      { id: 'notice:native-one', channel, type, at });
  }
  assert.deepEqual(normalizeNativeEvent(raw('community_sub_gift', { community_sub_gift: { id: 'community-one', total: 10 } }), context),
    { id: 'gift:community-one', channel, type: 'gift_batch', at });
  for (const notice of ['raid', 'announcement', 'gift_paid_upgrade', 'bits_badge_tier', 'shared_chat_sub']) assert.equal(normalizeNativeEvent(raw(notice), context), null);
});

test('wrong-room, shared, malformed identities and malformed notices never become events', () => {
  for (const edit of [{ broadcaster_user_id: '999' }, { broadcaster_user_login: 'wrong_channel' }, { source_broadcaster_user_id: '456' },
    { source_broadcaster_user_id: '999' }, { message_id: '' }, { message_id: 'https://private.example' }, { sub: null }]) {
    assert.equal(normalizeNativeEvent(raw('sub', edit), context), null);
  }
  assert.equal(normalizeNativeEvent(raw('sub'), { ...context, at: NaN }), null);
  assert.equal(normalizeNativeEvent(raw('sub'), { ...context, subscriptionType: 'channel.subscription' }), null);
  assert.equal(normalizeNativeEvent(raw('sub_gift', { sub_gift: { community_gift_id: '' } }), context), null);
  assert.equal(normalizeNativeEvent(raw('community_sub_gift', { message_id: '', community_sub_gift: { id: 'group-one' } }), context), null);
});

test('group children and their parent share one identity and the parent always wins without replay-freshening', () => {
  const child = normalizeNativeEvent(raw('sub_gift', { sub_gift: { community_gift_id: 'group-one' } }), { ...context, at: at - 2000 });
  const parent = normalizeNativeEvent(raw('community_sub_gift', { community_sub_gift: { id: 'group-one' } }), { ...context, at: at - 1000 });
  assert.equal(child.id, parent.id);
  let events = mergeNativeEvents([], [child, parent], at); assert.deepEqual(events, [parent]);
  events = mergeNativeEvents(events, [{ ...child, at }, { ...parent, at }], at); assert.deepEqual(events, [parent]);
  assert.deepEqual(mergeNativeEvents([], [parent, child], at), [parent]);
  assert.equal(currentNativeEvent([child], child, channel, at), false, 'group children are only correlation markers');
});

test('identity is independent of subscriber, envelope or current ingest time and outputs are defensive copies', () => {
  const source = raw('sub'); const first = normalizeNativeEvent(source, context);
  assert.deepEqual(normalizeNativeEvent({ ...source, chatter_user_login: 'other_name', envelope_id: 'other-envelope' }, context), first);
  const merged = mergeNativeEvents([first], [{ ...first, at: at + 1000 }], at);
  assert.equal(merged[0].at, at); merged[0].type = 'resub'; assert.equal(first.type, 'sub');
});

test('native buffer is bounded and actual source time/channel/type are required at execution', () => {
  const events = Array.from({ length: 50 }, (_, n) => ({ id: `bits:message-${n}`, channel, type: 'bits', at: at - n }));
  const merged = mergeNativeEvents([], events, at); assert.equal(merged.length, NATIVE_EVENT_LIMIT);
  assert.equal(currentNativeEvent(merged, events[0], channel, at), true);
  for (const change of [{ at: at + 1 }, { channel: 'wrong_channel' }, { type: 'sub' }, { id: 'bits:unknown-message' }, { extra: 'PRIVATE_FIELD' }]) {
    assert.equal(currentNativeEvent(merged, { ...events[0], ...change }, channel, at), false);
  }
  assert.equal(currentNativeEvent(merged, events[0], channel, at + 45_001), false);
  assert.deepEqual(mergeNativeEvents([], [{ ...events[0], at: at - 900_001 }, { ...events[0], at: at + 5001 }], at), []);
  assert.equal(validNativeEvent({ id: 'notice:one', channel, type: 'bits', at }), false);
});
