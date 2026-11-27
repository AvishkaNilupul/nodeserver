import { createHash } from 'node:crypto';
import { SCENES } from './exchanges.mjs';
import { replyBank } from './reply-policy.mjs';
import { validateReply } from './text-policy.mjs';

export const PROFILE_IDS = Object.freeze(['primary', 'test', 'third', 'fourth']);
const LEGACY_PROFILE_IDS = Object.freeze(['primary', 'test', 'third']);
export const REPLY_CATEGORIES = Object.freeze([...Object.keys(replyBank), 'game', 'streamtitle', 'livestatus']);
export const TOPIC_CATEGORIES = Object.freeze(['general', 'just chatting', 'music', 'art']);
export const EVENT_CATEGORIES = Object.freeze(['bits', 'sub', 'resub', 'gift', 'gift_batch']);
export const MAX_BANK_ENTRIES = 160;
export const digest = value => createHash('sha256').update(value).digest('hex');
export const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,160}$/.test(value);
export const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
export const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const failure = (message, status = 400) => Object.assign(new Error(message), { status });

export function defaultBank() {
  const entry = (id, kind, category, lines) => ({ id, kind, category, lines: [...lines], accountIds: [...PROFILE_IDS], enabled: true });
  return { entries: [
    entry('greeting', 'greeting', 'greeting', ['hey chat, hope everyone’s doing well!', 'hi everyone, how’s it going?',
      'hello chat, hope the day’s treating you well', 'hey all, how are things?', 'hi chat, hope everyone’s having a good one',
      'hello everyone, good to be in chat', 'hey everyone, how’s your day going?', 'hi all, hope it’s been a good one']),
    entry('topic_general', 'topic', 'general', ['what do you enjoy most about {game}?', 'what got you interested in {game}?',
      'what’s one thing you’d recommend knowing about {game}?', 'what keeps {game} interesting for you?']),
    entry('topic_chatting', 'topic', 'just chatting', ['how’s everyone’s day going?', 'what’s been the highlight of your day?', 'what have you been enjoying lately?']),
    entry('topic_music', 'topic', 'music', ['what music have you been enjoying lately?', 'any albums you’d recommend?', 'what’s a song you keep coming back to?']),
    entry('topic_art', 'topic', 'art', ['what do you like drawing or making?', 'what art styles do you enjoy?', 'what’s a creative project you’d like to try?']),
    ...Object.entries(replyBank).map(([category, lines]) => entry(`reply_${category}`, 'reply', category, lines)),
    entry('reply_game', 'reply', 'game', ['the channel is listed under {game}.']),
    entry('reply_streamtitle', 'reply', 'streamtitle', ['the stream title says: “{title}”']),
    entry('reply_livestatus', 'reply', 'livestatus', ['the channel is currently listed as live.', 'the channel is currently listed as offline.']),
    ...SCENES.map(scene => entry(scene.id, 'exchange', 'exchange', scene.lines))
  ], profiles: PROFILE_IDS.map(id => ({ id, chatMode: 'mentions', replySource: 'local' })) };
}

function validateBankForRoster(input, profileIds) {
  if (!exact(input, ['entries', 'profiles']) || !Array.isArray(input.entries) || input.entries.length < 1 || input.entries.length > MAX_BANK_ENTRIES
    || !Array.isArray(input.profiles) || input.profiles.length !== profileIds.length || Buffer.byteLength(JSON.stringify(input)) > 60000) throw failure('The message bank is invalid or too large.');
  const seen = new Set();
  const entries = input.entries.map(item => {
    if (!exact(item, ['id', 'kind', 'category', 'lines', 'accountIds', 'enabled']) || typeof item.id !== 'string' || !/^[a-z0-9_:-]{1,80}$/.test(item.id) || seen.has(item.id)
      || !['greeting', 'topic', 'reply', 'exchange', 'event'].includes(item.kind) || typeof item.enabled !== 'boolean'
      || !Array.isArray(item.accountIds) || !item.accountIds.length || item.accountIds.length > profileIds.length || new Set(item.accountIds).size !== item.accountIds.length || item.accountIds.some(id => !profileIds.includes(id))
      || !Array.isArray(item.lines) || !item.lines.length || item.lines.length > 16 || item.kind === 'exchange' && item.lines.length !== 2) throw failure('A message bank entry is invalid.');
    const categories = item.kind === 'reply' ? REPLY_CATEGORIES : item.kind === 'topic' ? TOPIC_CATEGORIES : item.kind === 'event' ? EVENT_CATEGORIES : [item.kind];
    if (!categories.includes(item.category)) throw failure('Choose a supported message category.');
    seen.add(item.id);
    const lines = item.lines.map(line => {
      if (typeof line !== 'string' || line.length > 260 || line !== line.trim()) throw failure('Message bank lines must contain 1–260 characters.');
      validateReply(line);
      const allowed = item.kind === 'topic' || item.kind === 'reply' && item.category === 'game' ? ['game'] : item.kind === 'reply' && item.category === 'streamtitle' ? ['title'] : [];
      if (/[{}]/.test(line.replace(/\{(game|title)\}/g, (_, key) => allowed.includes(key) ? '' : '{invalid}'))) throw failure('This message contains an unsupported substitution.');
      // Exchange mentions are assembled by the host from the chosen partner.
      if (item.kind === 'exchange' && /@|\[companion bot\]/i.test(line)) throw failure('Exchange lines must contain only the scene text.');
      return line;
    });
    return { id: item.id, kind: item.kind, category: item.category, lines, accountIds: [...item.accountIds].sort(), enabled: item.enabled };
  });
  const profiles = profileIds.map(id => {
    const matches = input.profiles.filter(profile => profile?.id === id), profile = matches[0];
    if (matches.length !== 1 || !exact(profile, ['id', 'chatMode', 'replySource']) || !['mentions', 'participate'].includes(profile.chatMode) || !['local', 'ai'].includes(profile.replySource)) throw failure('Every supported message profile is required.');
    return { id, chatMode: profile.chatMode, replySource: profile.replySource };
  });
  return { entries, profiles };
}

export function validateBank(input) { return validateBankForRoster(input, PROFILE_IDS); }

// A new immutable revision extends only the previously shared groups. Existing
// revisions and selective assignments never become defaults for another account.
export function upgradeBankForFourth(input) {
  if (Array.isArray(input?.profiles) && input.profiles.length === PROFILE_IDS.length) {
    validateBank(input);
    return null;
  }
  const previous = validateBankForRoster(input, LEGACY_PROFILE_IDS);
  return validateBank({
    entries: previous.entries.map(entry => ({ ...entry, accountIds: entry.accountIds.length === LEGACY_PROFILE_IDS.length
      && LEGACY_PROFILE_IDS.every(id => entry.accountIds.includes(id)) ? [...entry.accountIds, 'fourth'] : entry.accountIds })),
    profiles: [...previous.profiles, { id: 'fourth', chatMode: 'mentions', replySource: 'local' }]
  });
}

export function renderBankLine(line, context) {
  const result = line.replace(/\{(game|title)\}/g, (_, key) => key === 'game' ? context?.gameName || '' : context?.title || '');
  if (line.includes('{game}') && !context?.gameName || line.includes('{title}') && !context?.title) return '';
  try { return validateReply(result); } catch { return ''; }
}
