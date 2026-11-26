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

