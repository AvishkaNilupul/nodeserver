import { createHash } from 'node:crypto';

export const HIGHLIGHT_POLICY = Object.freeze({ warmupMs: 90_000, windowMs: 20_000, baselineMs: 120_000,
  minimumMessages: 8, minimumAuthors: 4, minimumReactionAuthors: 3, multiplier: 3, newestMs: 10_000 });
const LOGIN = /^[a-z0-9_]{3,25}$/;
const MESSAGE_ID = /^[A-Za-z0-9_:-]{1,160}$/;
const REACTION = /\b(?:wow|omg|holy|insane|crazy|clutch|unbelievable|incredible|amazing|no way|let['’]?s go|clip(?: it)?|pog(?:gers|champ)?|kekw|lul|lmao|rofl)\b/i;

// This observes chat reactions only. No video, audio or generated chat is evidence.
export function detectHighlight({ messages = [], excludedAuthors = [], channel, streamId, observedSince,
  baselineSince = observedSince, now = Date.now(), lastEventAt = 0, policy = HIGHLIGHT_POLICY } = {}) {
  if (!LOGIN.test(channel || '') || typeof streamId !== 'string' || !/^\d{1,32}$/.test(streamId)
    || !Number.isFinite(now) || !Number.isFinite(observedSince) || observedSince > now
    || now - observedSince < policy.warmupMs) return null;
  const excluded = new Set(excludedAuthors.map(x => String(x).toLowerCase()));
  if (!Number.isFinite(baselineSince) || baselineSince > now) return null;
  const unique = new Map(), start = Math.max(observedSince, baselineSince, now - policy.windowMs - policy.baselineMs);
  for (const m of messages) {
    if (!m || !MESSAGE_ID.test(m.id || '') || !LOGIN.test(m.author || '') || excluded.has(m.author)
      || typeof m.text !== 'string' || m.text.length > 1000 || !Number.isFinite(m.at) || m.at < start || m.at > now
      || m.channel && m.channel !== channel || unique.has(m.id)) continue;
    unique.set(m.id, m);
  }
  const recentStart = now - policy.windowMs;
  const recent = [...unique.values()].filter(m => m.at > recentStart && m.at > lastEventAt);
  const authors = new Set(recent.map(m => m.author));
  const reactions = recent.filter(m => REACTION.test(m.text));
  const reactionAuthors = new Set(reactions.map(m => m.author));
  if (recent.length < policy.minimumMessages || authors.size < policy.minimumAuthors
    || reactionAuthors.size < policy.minimumReactionAuthors || !reactions.length
    || now - Math.max(...reactions.map(m => m.at)) > policy.newestMs) return null;
  const baselineCount = [...unique.values()].filter(m => m.at <= recentStart).length;
  const baselineMs = recentStart - start;
  // Truncated high-volume history must never look like a quiet baseline.
  if (baselineMs < 30_000) return null;
  const baselineRate = baselineCount / (baselineMs / 1000), burstRate = recent.length / (policy.windowMs / 1000);
  if (burstRate < baselineRate * policy.multiplier) return null;
  const messageIds = recent.map(m => m.id).sort();
  const eventId = createHash('sha256').update(JSON.stringify([channel, streamId, messageIds])).digest('hex').slice(0, 32);
  return { eventId, channel, streamId, triggerAt: Math.max(...recent.map(m => m.at)), reason: 'Chat reaction detected',
    evidence: { messageIds, messageCount: recent.length, uniqueAuthors: authors.size, reactionAuthors: reactionAuthors.size,
      baselineRate: Math.round(baselineRate * 1000) / 1000, burstRate: Math.round(burstRate * 1000) / 1000 } };
}
