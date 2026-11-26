const LOGIN = /^[a-z0-9_]{3,25}$/;
const KNOWN_BOTS = new Set(['nightbot', 'moobot', 'streamelements', 'streamlabs', 'fossabot', 'wizebot',
  'botisimo', 'commanderroot', 'sery_bot', 'serybot', 'soundalerts', 'pretzelrocks']);
const login = value => typeof value === 'string' ? value.toLowerCase() : '';

export function normalizeStreamContext(raw, channel, now = Date.now()) {
  const expected = String(channel || '').toLowerCase();
  if (!raw || typeof raw !== 'object' || !LOGIN.test(expected)
    || typeof raw.channel !== 'string' || raw.channel.toLowerCase() !== expected
    || !Number.isFinite(raw.checkedAt) || raw.checkedAt < now - 120_000 || raw.checkedAt > now + 5_000) return null;
  const clean = (value, size) => typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, size) : '';
  return { channel: expected, title: clean(raw.title, 160), gameName: clean(raw.gameName, 100),
    streamId: typeof raw.streamId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(raw.streamId) ? raw.streamId : '',
    isLive: typeof raw.isLive === 'boolean' ? raw.isLive : null, checkedAt: raw.checkedAt };
}
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
