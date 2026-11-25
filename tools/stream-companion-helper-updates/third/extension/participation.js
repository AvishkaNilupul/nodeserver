import { validateReply } from './core.js';
import { localReply, normalizeStreamContext } from './replies.js';
import { distinctPhrase, messageKey, phraseSample } from './message-policy.js';
import { exchangeOffer } from './exchange.js';

const PARTICIPATION_GAP = 600_000;
const MESSAGE_FRESHNESS = 45_000;
const LOGIN = /^[a-z0-9_]{3,25}$/;
const STREAM_ID = /^[a-zA-Z0-9_-]{1,128}$/;
const KNOWN_BOTS = new Set([
  'nightbot', 'moobot', 'streamelements', 'streamlabs', 'fossabot', 'wizebot',
  'botisimo', 'commanderroot', 'sery_bot', 'serybot', 'soundalerts', 'pretzelrocks'
]);

const login = value => typeof value === 'string' ? value.toLowerCase() : '';
const consumed = attempt => !(attempt.delivery === 'cancelled' && attempt.submitted === false);
const submitted = attempt => attempt.submitted === true
  || ['confirmed', 'rejected', 'unknown'].includes(attempt.delivery);

export function humanMessages(messages, account, companions = []) {
  const excluded = new Set([login(account), ...companions.map(login)]);
  return (Array.isArray(messages) ? messages : []).filter(message => {
    const author = login(message?.author);
    return LOGIN.test(author) && !excluded.has(author) && !KNOWN_BOTS.has(author) && !author.endsWith('bot')
      && message.isBot !== true && message.bot !== true;
  });
}

export function exchangeContext({ messages, account, channel, streamContext, accounts = [], now = Date.now() } = {}) {
  const context = normalizeStreamContext(streamContext, channel, now);
  if (!context?.isLive || !/^\d{1,128}$/.test(context.streamId)) return null;
  const lastHumanAt = humanMessages(messages, account, accounts).reduce((last, message) =>
    Number.isFinite(message.at) && message.at > 0 && message.at <= now
      && (!message.channel || login(message.channel) === channel) ? Math.max(last, message.at) : last, 0);
  return { streamId: context.streamId, checkedAt: context.checkedAt, lastHumanAt };
}

export function planExchange({ account, channel, streamContext, attempts = [], coordination = {}, now = Date.now() } = {}) {
  const context = normalizeStreamContext(streamContext, channel, now);
  if (!context?.isLive || !Array.isArray(attempts) || coordination.available !== true || coordination.paused) return null;
  const ledger = attempts.filter(attempt => attempt && login(attempt.account) === account && consumed(attempt));
  if (ledger.some(attempt => !Number.isFinite(attempt.at) || attempt.at < 0 || attempt.at + PARTICIPATION_GAP > now)) return null;
  const exchange = exchangeOffer(coordination.exchange, { account, channel, streamId: context.streamId,
    accounts: coordination.accounts || [], now });
  if (!exchange || ledger.some(attempt => attempt.key === exchange.key)) return null;
  return { kind: 'exchange', key: exchange.key, exchangeId: exchange.id, streamId: context.streamId, text: exchange.text,
    category: 'participation-exchange', reason: 'A scheduled, labelled companion exchange is due.' };
}

// Stable across worker reloads. The caller durably records the returned key
// before submitting a message; planning itself never changes the ledger.
export function participationContextKey({ account, channel, streamId } = {}) {
  account = login(account);
  channel = login(channel);
  if (!LOGIN.test(account) || !LOGIN.test(channel) || typeof streamId !== 'string'
    || !STREAM_ID.test(streamId)) return '';
  return `participation:${account}:${channel}:${streamId}`;
}

function safeTarget(message, account, channel, now) {
  if (!message || typeof message !== 'object' || typeof message.text !== 'string'
    || typeof message.id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(message.id)
    || !Number.isFinite(message.at) || message.at < now - MESSAGE_FRESHNESS || message.at > now) return false;
  const author = login(message.author);
  if (!LOGIN.test(author) || author === account || KNOWN_BOTS.has(author) || author.endsWith('bot')
    || message.isBot === true || message.bot === true) return false;
  if (message.channel !== undefined && login(message.channel) !== channel) return false;
  // Direct mentions belong to the worker's higher-priority mention path.
  // All other mentions are someone else's conversation. Do not hijack them.
  if (/@[a-z0-9_]+/i.test(message.text) || /(?:https?:\/\/|www\.)/i.test(message.text)
    || /^[\s]*[!/.]/.test(message.text) || /[\u0000-\u001f\u007f]/.test(message.text)) return false;
  if (message.replyTo || message.replyParentId || message.reply_parent_message_id) return false;
  return true;
}

const greetings = Object.freeze([
  'hey chat, hope everyone’s doing well!', 'hi everyone, how’s it going?',
  'hello chat, hope the day’s treating you well', 'hey all, how are things?',
  'hi chat, hope everyone’s having a good one', 'hello everyone, good to be in chat',
  'hey everyone, how’s your day going?', 'hi all, hope it’s been a good one'
]);

function topicChoices(context) {
  const game = context.gameName;
  if (!game || /[@<>\[\]{}\\/]|https?:|www\./i.test(game)) return [];
  const categories = new Map([
    ['just chatting', ['how’s everyone’s day going?', 'what’s been the highlight of your day?', 'what have you been enjoying lately?']],
    ['music', ['what music have you been enjoying lately?', 'any albums you’d recommend?', 'what’s a song you keep coming back to?']],
    ['art', ['what do you like drawing or making?', 'what art styles do you enjoy?', 'what’s a creative project you’d like to try?']]
  ]);
  return (categories.get(game.toLowerCase()) || [
    `what do you enjoy most about ${game}?`, `what got you interested in ${game}?`,
    `what’s one thing you’d recommend knowing about ${game}?`, `what keeps ${game} interesting for you?`
  ]).filter(text => { try { return validateReply(text) === text; } catch { return false; } });
}

/**
 * Pure opportunity selection, not permission to send. The worker must still
 * enforce explicit participation mode, matching advancing native playback,
 * account/channel identity, chat restrictions, and the global send budget.
 * Conversations are locally recognized, then composed again by the caller's
 * selected reply source; greeting/topic text is final and always local.
 * Only an explicit cancelled + submitted:false entry can be attempted again.
 */
export function planParticipation({ messages = [], account, channel, streamContext,
  recent = [], attempts = [], coordination = {}, now = Date.now() } = {}) {
  account = login(account);
  channel = login(channel);
  if (!Number.isFinite(now) || !LOGIN.test(account) || !LOGIN.test(channel)) {
    return { reason: 'A valid account, channel and current time are required.' };
  }
  const context = normalizeStreamContext(streamContext, channel, now);
  if (!context || context.isLive !== true) return { reason: 'Waiting for fresh live channel information.' };
  const streamId = streamContext.streamId;
  const contextKey = participationContextKey({ account, channel, streamId });
  if (!contextKey) return { reason: 'Waiting for the current broadcast ID.' };
  const excludedKeys = [...(coordination.textKeys || []), ...[...recent, ...messages]
    .filter(x => x && typeof x.text === 'string' && x.at > now - 3_600_000 && x.at <= now
      && (!x.channel || login(x.channel) === channel)).map(x => messageKey(x.text))];

  const ledger = (Array.isArray(attempts) ? attempts : []).filter(attempt => attempt
    && typeof attempt === 'object' && login(attempt.account) === account && consumed(attempt));
  if (ledger.some(attempt => !Number.isFinite(attempt.at) || attempt.at < 0)) {
    return { reason: 'Participation history has an invalid timestamp; staying quiet.' };
  }
  // This spacing spans channels and broadcasts for the selected account. The
  // separate global gate also counts manual sends and mention replies.
  const latestAt = ledger.reduce((latest, attempt) => Math.max(latest, attempt.at), -Infinity);
  if (latestAt + PARTICIPATION_GAP > now) return {
    reason: 'Waiting ten minutes between conversation-mode attempts.', nextAt: latestAt + PARTICIPATION_GAP
  };
  const broadcast = ledger.filter(attempt => login(attempt.channel) === channel && attempt.streamId === streamId);
  const greeting = broadcast.find(attempt => attempt.kind === 'greeting');
  const history = (Array.isArray(recent) ? recent : []).filter(reply => reply
    && typeof reply.text === 'string' && Number.isFinite(reply.at));
  const candidates = (Array.isArray(messages) ? messages : []).filter(message => safeTarget(message, account, channel, now)
    && !(coordination.accounts || []).includes(login(message.author)) && !(coordination.replyIds || []).includes(message.id))
    .sort((a, b) => b.at - a.at);
  for (const target of candidates) {
    const key = `${contextKey}:conversation:${target.id}`;
    if (broadcast.some(attempt => attempt.key === key)) continue;
    const reply = localReply({ messages: candidates, account, channel, target, recent: history,
      streamContext, now, excludedKeys, random: () => phraseSample(`${contextKey}:${target.id}`) });
    if (reply.text) return {
      kind: 'conversation', key, streamId, target, text: reply.text, category: reply.category,
      reason: 'Fresh public chat has a supported conversational reply.'
    };
  }

  const exchange = planExchange({ account, channel, streamContext, attempts, coordination, now });
  if (exchange) return exchange;

  if (!greeting) {
    const text = distinctPhrase(greetings, { seed: `${contextKey}:greeting`, excludedKeys });
    return text ? { kind: 'greeting', key: `${contextKey}:greeting`, streamId, text,
      category: 'participation-greeting', reason: 'One distinct greeting for this broadcast.' }
      : { reason: 'Greeting phrases were already used recently; waiting for fresh conversation.' };
  }

  const topic = broadcast.some(attempt => attempt.kind === 'topic');
  if (!topic && submitted(greeting)) {
    if ((coordination.topicStreams || []).includes(streamId)) return {
      reason: 'A companion already asked a category question for this broadcast; waiting for fresh useful conversation.'
    };
    const text = distinctPhrase(topicChoices(context), { seed: `${contextKey}:topic`, excludedKeys });
    if (text) return {
      kind: 'topic', key: `${contextKey}:topic`, streamId, text, category: 'participation-topic',
      reason: 'One category question after the broadcast greeting.'
    };
    return { reason: 'No suitable category question; waiting for fresh useful conversation.' };
  }
  return { reason: topic ? 'Greeting and category question already attempted; waiting for fresh useful conversation.'
    : 'Greeting submission is unresolved; waiting for fresh useful conversation.' };
}
