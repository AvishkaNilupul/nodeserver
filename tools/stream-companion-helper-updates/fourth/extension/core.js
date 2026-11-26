export function channelFromUrl(raw) {
  try {
    const url = new URL(raw);
    if (!['www.twitch.tv', 'twitch.tv'].includes(url.hostname)) return '';
    const p = url.pathname.split('/').filter(Boolean);
    const name = p[0] === 'popout' ? p[1] : p[0];
    if (!name || ['directory','settings','downloads','videos','subscriptions','inventory','wallet','search'].includes(name)) return '';
    return /^[a-z0-9_]{3,25}$/i.test(name) ? name.toLowerCase() : '';
  } catch { return ''; }
}

export function cleanMessage(raw) {
  if (!raw || typeof raw.text !== 'string' || typeof raw.author !== 'string') return null;
  const text = raw.text.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 600);
  const author = raw.author.trim().slice(0, 30);
  const at = Number(raw.at);
  if (!text || !author || !Number.isFinite(at)) return null;
  const replyParentId = typeof raw.replyParentId === 'string' ? raw.replyParentId.trim().slice(0, 150) : '';
  return { id: String(raw.id || '').slice(0, 150), author, text, at, ...(replyParentId ? { replyParentId } : {}),
    ...(raw.isBot === true ? { isBot: true } : {}), ...(raw.bot === true ? { bot: true } : {}) };
}

export function mergeMessages(previous, incoming, now = Date.now()) {
  const seen = new Set();
  return [...previous, ...incoming].map(cleanMessage).filter(Boolean)
    .filter(m => m.at >= now - 15 * 60_000 && m.at <= now + 5_000)
    .filter(m => {
      const key = m.id || `${m.author}\u0000${m.text}\u0000${Math.floor(m.at / 10_000)}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(-120);
}

export function validateReply(raw) {
  if (typeof raw !== 'string') throw new Error('The model did not return text.');
  const text = raw.trim();
  if (!text || text.length > 300) throw new Error('Replies must contain 1–300 characters.');
  if (/^[/.]/.test(text) || /[\r\n\u0000-\u001f\u007f]/.test(text)) throw new Error('Chat commands and multiline messages are disabled.');
  if (/https?:\/\/|www\./i.test(text)) throw new Error('Links are disabled.');
  return text;
}

export function sendGate({ channel, allowedChannel, login, expectedLogin, blocked, recent = [], text, now = Date.now() }) {
  if (!channel || channel !== allowedChannel) return 'This channel is in preview mode.';
  if (!login || login.toLowerCase() !== String(expectedLogin).toLowerCase()) return 'The signed-in account does not match the configured account.';
  if (blocked) return 'Twitch is restricting chat in this channel.';
  try { validateReply(text); } catch (e) { return e.message; }
  const sent = recent.filter(x => x.at > now - 3_600_000);
  if (sent.length >= 6) return 'Hourly limit reached (6 messages).';
  if (sent.some(x => now - x.at < 180_000)) return 'Waiting for the 3-minute cooldown.';
  const comparable = value => value.replace(/^\[bot\]\s*/i, '').toLowerCase();
  if (sent.some(x => comparable(x.text) === comparable(text))) return 'That message was already sent recently.';
  return '';
}

export function replyOpportunity(messages, account, now = Date.now()) {
  if (!/^[a-z0-9_]{3,25}$/i.test(account || '')) return null;
  const recent = messages.filter(m => m.at >= now - 45_000 && m.at <= now && m.author.toLowerCase() !== account.toLowerCase());
  const mention = new RegExp(`(?:^|\\s)@${account}(?![a-z0-9_])`, 'i');
  return recent.findLast(m => mention.test(m.text)) || null;
}

export function replyDelay(random = Math.random) {
  const value = Number(random());
  const sample = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return Math.min(12_000, 4_000 + Math.floor(sample * 8_001));
}

export function digest(messages) {
  const authors = new Set(messages.map(m => m.author.toLowerCase()));
  const words = new Map();
  const stop = new Set('this that with from your have just what when there about would could should they them then been were will like really here http https twitch'.split(' '));
  for (const m of messages) for (const w of m.text.toLowerCase().match(/[a-z]{4,}/g) || []) {
    if (!stop.has(w)) words.set(w, (words.get(w) || 0) + 1);
  }
  return { messages: messages.length, people: authors.size, topics: [...words].sort((a,b) => b[1]-a[1]).slice(0,6).map(x => x[0]) };
}

export function localSummary(messages, channel, now = Date.now()) {
  const recent = mergeMessages([], messages, now);
  if (!recent.length) return { summary: 'No chat messages received in the last 15 minutes.', text: '', source: 'local' };
  const stats = digest(recent);
  const quotes = recent.slice(-5).map(m => `@${m.author}: “${m.text.slice(0, 180)}”`).join('\n');
  return { summary: `Recent chat in @${channel}: ${stats.messages} messages from ${stats.people} people (up to 15 minutes / 120 messages).\n${quotes}\nChat excerpts only; no video or audio observations.`, text: '', source: 'local' };
}
