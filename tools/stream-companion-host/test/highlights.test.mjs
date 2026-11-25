import test from 'node:test';
import assert from 'node:assert/strict';
import { detectHighlight } from '../lib/highlights.mjs';

const now = 1_000_000;
const burst = (at = now) => Array.from({ length: 8 }, (_, i) => ({ id: `message-${i}`, author: `viewer_${i % 4}`, text: ['wow', 'PogChamp', 'omg', 'what a moment'][i % 4], at: at - i * 500, channel: 'aviskarex' }));
const detect = overrides => detectHighlight({ messages: burst(), channel: 'aviskarex', streamId: '123', observedSince: now - 90_000, now, ...overrides });

test('detects a fresh diverse reaction burst with stable evidence identity', () => {
  const result = detect();
  assert.equal(result.reason, 'Chat reaction detected');
  assert.equal(result.evidence.messageCount, 8);
  assert.equal(result.evidence.uniqueAuthors, 4);
  assert.equal(result.evidence.reactionAuthors, 3);
  assert.equal(detect({ messages: burst().reverse() }).eventId, result.eventId);
});

test('ignores duplicate feeds, both companions, future data and historical backlog', () => {
  assert.equal(detect({ messages: [...burst().slice(0, 4), ...burst().slice(0, 4)] }), null);
  assert.equal(detect({ excludedAuthors: ['viewer_0', 'viewer_1'] }), null);
  assert.equal(detect({ messages: burst(now + 60_000) }), null);
  assert.equal(detect({ observedSince: now - 10_000 }), null);
  assert.equal(detect({ messages: burst(now - 30_000) }), null);
  assert.equal(detect({ messages: burst().map(m => ({ ...m, channel: 'otherchannel' })) }), null);
  assert.equal(detect({ messages: burst(), lastEventAt: now }), null);
});

test('requires multiple reaction authors and a significant rate increase', () => {
  assert.equal(detect({ messages: burst().map(m => ({ ...m, text: 'ordinary discussion' })) }), null);
  assert.equal(detect({ messages: burst().map(m => ({ ...m, author: 'same_viewer' })) }), null);
  const baseline = Array.from({ length: 30 }, (_, i) => ({ id: `baseline-${i}`, author: `viewer_${i % 4}`, text: 'chat', at: now - 21_000 - i * 1800 }));
  assert.equal(detect({ messages: [...baseline, ...burst()] }), null);
  assert.equal(detect({ messages: burst().map(m => ({ ...m, at: now - 12_000 - Number(m.id.split('-')[1]) * 200 })) }), null);
  assert.equal(detect({ baselineSince: now - 40_000 }), null, 'truncated baseline does not inflate a steady stream into a highlight');
});
