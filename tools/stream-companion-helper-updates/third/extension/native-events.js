export const NATIVE_EVENT_LIMIT = 32;
const LOGIN = /^[a-z0-9_]{3,25}$/;
const ID = /^[A-Za-z0-9_:-]{1,160}$/;
const TYPES = new Set(['bits', 'sub', 'resub', 'gift', 'gift_batch']);
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const key = (prefix, value) => typeof value === 'string' && ID.test(value) && value.length + prefix.length + 1 <= 160 ? `${prefix}:${value}` : '';

/** Native facts only: no user text, names, counts, URLs or subscription errors. */
export function normalizeNativeEvent(event, { subscriptionType, broadcasterId, channel, at } = {}) {
  if (!record(event) || !LOGIN.test(channel || '') || !/^\d{1,128}$/.test(broadcasterId || '') || event.broadcaster_user_id !== broadcasterId
    || event.broadcaster_user_login !== undefined && event.broadcaster_user_login !== channel
    || event.source_broadcaster_user_id != null || !Number.isSafeInteger(at) || at < 0) return null;
  let type, id;
  if (subscriptionType === 'channel.chat.message') {
    if (!positive(event.cheer?.bits)) return null;
    type = 'bits'; id = key('bits', event.message_id);
  } else if (subscriptionType === 'channel.chat.notification') {
    if (!key('notice', event.message_id)) return null;
    const notice = event.notice_type;
    if (notice === 'sub' && record(event.sub) || notice === 'resub' && record(event.resub)) {
      type = notice; id = key('notice', event.message_id);
    } else if (notice === 'sub_gift' && record(event.sub_gift)) {
      type = 'gift';
      id = event.sub_gift.community_gift_id != null ? key('gift', event.sub_gift.community_gift_id) : key('notice', event.message_id);
    } else if (notice === 'community_sub_gift' && record(event.community_sub_gift)) {
      type = 'gift_batch'; id = key('gift', event.community_sub_gift.id);
    } else return null;
  } else return null;
  return id ? { id, channel, type, at } : null;
}

export function validNativeEvent(value) {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'at,channel,id,type' || !ID.test(value.id || '') || !LOGIN.test(value.channel || '')
    || !TYPES.has(value.type) || !Number.isSafeInteger(value.at) || value.at < 0) return false;
  const prefix = value.id.split(':', 1)[0];
  return value.id.length > prefix.length + 1 && (value.type === 'bits' ? prefix === 'bits'
    : value.type === 'gift_batch' ? prefix === 'gift' : value.type === 'gift' ? ['notice', 'gift'].includes(prefix) : prefix === 'notice');
}

/** A replay never refreshes source time; a batch parent supersedes its children. */
export function mergeNativeEvents(previous = [], incoming = [], now = Date.now()) {
  const events = new Map();
  for (const event of [...previous, ...incoming]) {
    if (!validNativeEvent(event) || event.at < now - 900_000 || event.at > now + 5000) continue;
    const identity = `${event.channel}:${event.id}`, old = events.get(identity);
    if (!old || old.type === 'gift' && event.type === 'gift_batch') events.set(identity, { ...event });
  }
  return [...events.values()].sort((a, b) => a.at - b.at).slice(-NATIVE_EVENT_LIMIT);
}

export function currentNativeEvent(events, expected, channel, now = Date.now()) {
  if (!validNativeEvent(expected) || expected.channel !== channel || expected.at > now || expected.at < now - 45_000
    || expected.type === 'gift' && expected.id.startsWith('gift:')) return false;
  return mergeNativeEvents(events, [], now).some(event => event.id === expected.id && event.channel === expected.channel
    && event.type === expected.type && event.at === expected.at);
}

export function sameNativeEvent(a, b) {
  return validNativeEvent(a) && validNativeEvent(b) && a.id === b.id && a.channel === b.channel && a.type === b.type && a.at === b.at;
}
