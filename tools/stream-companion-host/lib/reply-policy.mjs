import { replyOpportunity, validateReply } from './text-policy.mjs';
import { messageKey } from './exchanges.mjs';

// Original local phrases. Categories describe the incoming message, not events
// on the stream: the extension has no video/audio context.
export const replyBank = Object.freeze({
  greeting: Object.freeze([
    'hey, how’s your day going?', 'hey! how’s it going?', 'yo, what’s up?', 'hey there',
    'hiya, how are you doing?', 'hey hey', 'hey, good to see you', 'hello there'
  ]),
  checkin: Object.freeze([
    'here in chat, how about you?', 'keeping up with chat, how’s your day going?',
    'just hanging out in chat, how about you?', 'i’m here for the conversation, what about you?'
  ]),
  goodday: Object.freeze([
    'nice, glad to hear it', 'ah nice! what have you been up to?',
    'sounds like a good day', 'glad it’s going well'
  ]),
  roughday: Object.freeze([
    'ah, that sounds rough', 'hope the rest of your day goes a bit better',
    'sorry it’s been a rough one', 'hope you get a chance to take it easy'
  ]),
  quietday: Object.freeze([
    'fair enough, taking it easy then?', 'a quiet day sounds alright',
    'nothing wrong with a chill day', 'fair enough'
  ]),
  thanks: Object.freeze([
    'no worries', 'you’re welcome', 'anytime', 'all good', 'of course',
    'no problem', 'glad that helped', 'you got it'
  ]),
  farewell: Object.freeze([
    'take care!', 'catch you later', 'have a good one', 'see you around',
    'later! take care', 'bye for now', 'catch you next time', 'see you next time'
  ]),
  goodnight: Object.freeze([
    'night! sleep well', 'good night, take care', 'rest well', 'night night',
    'sleep well!', 'night, take it easy', 'good night!', 'night, see you around'
  ]),
  welcome: Object.freeze([
    'thanks for the welcome', 'thanks! how’s it going?', 'appreciate the welcome', 'thanks, good to be here',
    'cheers for the welcome', 'thanks! hey everyone', 'appreciate it', 'thanks, hey hey'
  ]),
  dayfollowup: Object.freeze([
    'glad it’s going well! i’m here keeping up with chat.',
    'nice! i’m here for the conversation.',
    'glad to hear it. i’m keeping up with the chat here.'
  ]),
  reciprocal: Object.freeze([
    'i’m here keeping up with chat; no day of my own to report.',
    'just here for the conversation. i don’t have an offline day.',
    'i’m following the chat here; i don’t have a day outside it.'
  ]),
  quietfollowup: Object.freeze([
    'fair enough, enjoy the downtime', 'sounds like a chance to unwind',
    'a little downtime sounds good'
  ]),
  dayplans: Object.freeze([
    'hope you get some downtime after that', 'sounds like a full day',
    'hope the rest goes smoothly'
  ]),
  capabilities: Object.freeze([
    'i can follow the chat, but i don’t read the video or audio.',
    'i only have chat and channel info, so i can’t judge what happened on screen.',
    'i don’t see the stream itself; i’m replying from chat context.'
  ]),
  automation: Object.freeze([
    'yep, i’m an automated chat companion.', 'yeah, these are automated replies.',
    'yep, chat companion here.', 'yeah, i’m automated, not the owner typing live.'
  ])
});

export function normalizeStreamContext(raw, channel, now = Date.now()) {
  const expected = String(channel || '').toLowerCase();
  if (!raw || typeof raw !== 'object' || !/^[a-z0-9_]{3,25}$/.test(expected)
    || typeof raw.channel !== 'string' || raw.channel.toLowerCase() !== expected
    || !Number.isFinite(raw.checkedAt) || raw.checkedAt < now - 120_000 || raw.checkedAt > now + 5_000) return null;
  const clean = (value, size) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, size) : '';
  return { channel: expected, title: clean(raw.title, 160), gameName: clean(raw.gameName, 100),
    streamId: typeof raw.streamId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.streamId) ? raw.streamId : '',
    isLive: typeof raw.isLive === 'boolean' ? raw.isLive : null, checkedAt: raw.checkedAt };
}

function messageBody(text, account) {
  if (typeof text !== 'string' || !/^[a-z0-9_]{3,25}$/i.test(account || '')) return '';
  return text.replace(new RegExp(`(?:^|\\s)@${account}(?![a-z0-9_])[,:]?`, 'gi'), ' ')
    .replace(/[’]/g, "'").toLowerCase().replace(/\s+/g, ' ').trim();
}

export function replyCategory(text, account) {
  if (typeof text !== 'string' || !/^[a-z0-9_]{3,25}$/i.test(account || '')) return '';
  const value = messageBody(text, account);
  // Use whole-message patterns: "hello, can you ban alice" is not a greeting
  // opportunity. Unrecognized requests remain unanswered.
  if (/^(?:(?:hey|hi|hello)[,! ]+)?(?:are you (?:a |an )?(?:bot|ai|automated companion|automated)|is this (?:a |an )?(?:bot|ai|automated)|(?:bot|ai) check)[?!. ]*$/.test(value)) return 'automation';
  if (/^(?:what(?:'s| is) (?:the|this) game|what game (?:is this|is it|are (?:we|they|you) (?:watching|playing))|which game is this)[?!., ]*$/.test(value)) return 'game';
  if (/^(?:what(?:'s| is) the (?:stream|channel) title|what does the title say)[?!., ]*$/.test(value)) return 'streamtitle';
  if (/^(?:is (?:the stream|this channel|the channel) live|are (?:they|we) live)[?!., ]*$/.test(value)) return 'livestatus';
  if (/^(?:did you (?:see|hear) that|can you (?:see|hear) (?:the stream|the video|the streamer)|what just happened on (?:screen|stream))[?!., ]*$/.test(value)) return 'capabilities';
  const casual = value.replace(/^(?:hey|hi|hello|hiya|heya|yo)[!,. ]+(?=how|what|you|u)/, '');
  if (/^(?:how(?:'s| is) it going|how are (?:you|u)(?: doing)?|how you doing|hru|how(?:'s| is) your (?:day|morning|evening)(?: going)?|what(?:'s| is) up|whats up|sup|you good|u good)[?!., ]*$/.test(casual)) return 'checkin';
  if (/^(?:(?:i'm|i am|im|doing|it's|it is|its) )?(?:good|great|pretty good|doing good|doing well|all good|going well|not bad|really good)(?: thanks|, thanks| thank you)?[!., ]*$/.test(value)) return 'goodday';
  if (/^(?:(?:i'm|i am|im|it's|it is|its) )?(?:tired|exhausted|having a rough day|having a bad day|a rough day|a bad day|rough day|bad day|rough|not great|not so good|been a long day)[!., ]*$/.test(value)) return 'roughday';
  if (/^(?:not much|nothing much|just chilling|just chillin|taking it easy|same old)(?: here| really)?[!., ]*$/.test(value)) return 'quietday';
  if (/^(?:hey|hi|hello|hiya|heya|yo|sup|hey hey|hello hello|good morning|good afternoon|good evening)(?: there| again)?[!., ]*$/.test(value)) return 'greeting';
  if (/^(?:thanks|thank you|ty|tysm|cheers|thanks a lot|thank you so much)(?: for (?:that|the help|your help))?[!., ]*$/.test(value)) return 'thanks';
  if (/^(?:gn|night|night night|good ?night|sleep well|heading to bed|going to bed)(?: everyone| all| chat)?[!., ]*$/.test(value)) return 'goodnight';
  if (/^(?:bye|goodbye|see you|see ya|later|catch you later|gotta go|got to go|have a good one|take care)(?: everyone| all| chat)?[!., ]*$/.test(value)) return 'farewell';
  if (/^(?:welcome|welcome in|welcome back|nice to meet you)[!., ]*$/.test(value)) return 'welcome';
  return '';
}

export function pickPhrase({ category, recent = [], excludedKeys = [], now = Date.now(), random = Math.random, bank = replyBank }) {
  if (!Object.hasOwn(bank, category)) throw new Error('Unknown phrase category.');
  const used = new Set([...excludedKeys, ...recent.filter(x => x.at > now - 3_600_000).map(x => messageKey(x.text))]);
  const choices = bank[category].filter(text => !used.has(messageKey(text)));
  if (!choices.length) return { text: '', reason: 'All matching phrases were used recently; staying quiet.', source: 'local' };
  const sample = Number(random());
  const index = Number.isFinite(sample) ? Math.max(0, Math.min(choices.length - 1, Math.floor(sample * choices.length))) : 0;
  return { text: validateReply(choices[index]), reason: `Local reply bank · ${category}.`, source: 'local' };
}

function recentConversation({ recent, opportunity, account, channel, now }) {
  return recent.filter(x => x.delivery === 'confirmed' && x.at > now - 900_000 && x.at < opportunity.at
    && x.account === account && x.channel === channel
    && x.replyTo?.toLowerCase() === opportunity.author.toLowerCase()).sort((a, b) => a.at - b.at).at(-1);
}

function contextualCategory(value, previous) {
  if (!previous) return '';
  const prior = previous.category;
  if (['greeting', 'checkin', 'goodday'].includes(prior)
    && /^(?:(?:i'm|i am|im|doing) )?(?:good|great|pretty good|all good|not bad)(?:,? thanks)?[,! .]*(?:and (?:you|u)|how about (?:you|u)|what about (?:you|u))[?!., ]*$/.test(value)) return 'dayfollowup';
  if (['greeting', 'checkin', 'goodday', 'roughday', 'quietday', 'dayplans'].includes(prior)
    && /^(?:and (?:you|u)|how about (?:you|u)|what about (?:you|u)|you|u)[?!., ]*$/.test(value)) return 'reciprocal';
  if (prior === 'quietday' && /taking it easy then\?/i.test(previous.text)
    && /^(?:yeah|yep|yes|sure|exactly|pretty much)[!., ]*$/.test(value)) return 'quietfollowup';
  if (['greeting', 'checkin', 'goodday'].includes(prior)
    && /(?:how.{0,12}(?:day|going)|what have you been up to)/i.test(previous.text)
    && /^(?:just )?(?:finished|got back from|got home from) (?:work|school|class|classes)[!., ]*$/.test(value)) return 'dayplans';
  return '';
}

function metadataReply(category, context, bank) {
  const choices = bank?.[category] || [];
  const text = category === 'livestatus' ? choices[context?.isLive === false ? Math.min(1, choices.length - 1) : 0] || '' : choices[0] || '';
  if (!text) return { text: '', reason: 'Current channel information is unavailable; staying quiet.', source: 'local', category };
  try { return { text: validateReply(text), reason: 'Reply uses channel information, not video or audio.', source: 'local', category }; }
  catch { return { text: '', reason: 'Channel information is not suitable for a chat reply; staying quiet.', source: 'local', category }; }
}

export function localReply({ messages = [], account, channel, target, recent = [], excludedKeys = [], streamContext, now = Date.now(), random = Math.random, bank = replyBank }) {
  const opportunity = target || replyOpportunity(messages, account, now)
    || messages.findLast(m => m.author.toLowerCase() !== account.toLowerCase() && m.at >= now - 45_000 && m.at <= now);
  if (!opportunity || opportunity.at < now - 45_000 || opportunity.at > now || opportunity.author.toLowerCase() === account.toLowerCase()) {
    return { text: '', reason: 'No fresh incoming message to answer.', source: 'local', category: '' };
  }
  const previous = recentConversation({ recent, opportunity, account, channel, now });
  const category = replyCategory(opportunity.text, account)
    || contextualCategory(messageBody(opportunity.text, account), previous);
  if (!category) return { text: '', reason: 'No supported reply to this message or its conversation context; staying quiet.', source: 'local', category: '' };
  // Do not restart the same pleasantry with the same person every few minutes.
  const repeated = ['greeting', 'welcome', 'thanks', 'checkin', 'dayfollowup', 'reciprocal', 'quietfollowup', 'dayplans', 'capabilities', 'game', 'streamtitle', 'livestatus'].includes(category) && recent.some(x =>
    x.at > now - 1_800_000 && x.at <= now && x.category === category
    && x.replyTo?.toLowerCase() === opportunity.author.toLowerCase()
    && (!channel || x.channel === channel) && (!x.account || x.account === account));
  if (repeated) return { text: '', reason: 'Already answered this part of the conversation.', source: 'local', category };
  if (['game', 'streamtitle', 'livestatus'].includes(category)) {
    const result = metadataReply(category, normalizeStreamContext(streamContext, channel, now), bank);
    return excludedKeys.includes(messageKey(result.text))
      ? { text: '', reason: 'A companion already shared this channel information; staying quiet.', source: 'local', category }
      : result;
  }
  return { ...pickPhrase({ category, recent, excludedKeys, now, random, bank }), category };
}
