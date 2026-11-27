import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLE_PROFILES } from '../lib/style-catalog.mjs';
import { PROFILE_IDS, REPLY_CATEGORIES, renderBankLine, validateBank } from '../lib/bank.mjs';
import { messageKey } from '../lib/exchanges.mjs';
import { localReply, replyCategory } from '../lib/reply-policy.mjs';
import { validateReply } from '../lib/text-policy.mjs';

function entriesFor(id) {
  const profile = STYLE_PROFILES[id];
  return [
    { id: `${id}:greeting`, kind: 'greeting', category: 'greeting', lines: [...profile.greetings], accountIds: [id], enabled: true },
    ...Object.entries(profile.replies).map(([category, lines]) => ({
      id: `${id}:reply:${category}`, kind: 'reply', category, lines: [...lines], accountIds: [id], enabled: true
    }))
  ];
}

test('catalog covers the four stable bindings and exactly the supported reply categories', () => {
  assert.deepEqual(Object.keys(STYLE_PROFILES), PROFILE_IDS);
  for (const [id, profile] of Object.entries(STYLE_PROFILES)) {
    assert.deepEqual(Object.keys(profile), ['label', 'description', 'greetings', 'replies'], id);
    assert.ok(profile.label.length && profile.description.length);
    assert.equal(profile.greetings.length, 2, id);
    assert.deepEqual(Object.keys(profile.replies), REPLY_CATEGORIES, id);
    for (const [category, lines] of Object.entries(profile.replies)) {
      assert.ok(lines.length >= 2 && lines.length <= 3, `${id}/${category}`);
      for (const line of lines) assert.equal(validateReply(line), line, `${id}/${category}`);
    }
  }
});

test('data is frozen through every profile, category and line array', () => {
  function check(value) {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) if (child && typeof child === 'object') check(child);
  }
  check(STYLE_PROFILES);
  assert.throws(() => { STYLE_PROFILES.primary.replies.thanks.push('changed'); }, TypeError);
  assert.throws(() => { STYLE_PROFILES.test.description = 'changed'; }, TypeError);
});

test('catalog materializes as a valid finite bank with each authored group bound only to its profile', () => {
  const input = {
    entries: PROFILE_IDS.flatMap(entriesFor),
    profiles: PROFILE_IDS.map(id => ({ id, chatMode: 'mentions', replySource: 'local' }))
  };
  const bank = validateBank(input);
  assert.equal(bank.entries.length, PROFILE_IDS.length * (REPLY_CATEGORIES.length + 1));
  for (const id of PROFILE_IDS) {
    const own = bank.entries.filter(entry => entry.accountIds.includes(id));
    assert.equal(own.length, REPLY_CATEGORIES.length + 1);
    assert.ok(own.every(entry => entry.id.startsWith(`${id}:`) && entry.accountIds.length === 1));
  }
  assert.deepEqual(input.entries[0].accountIds, ['primary']);
});

test('metadata substitutions use existing game/title rules and missing fields abstain', () => {
  const context = { gameName: 'Portal 2', title: 'A public title' };
  for (const profile of Object.values(STYLE_PROFILES)) {
    for (const [category, placeholder, value] of [['game', '{game}', context.gameName], ['streamtitle', '{title}', context.title]]) {
      for (const line of profile.replies[category]) {
        assert.equal(line.split(placeholder).length, 2);
        assert.equal(renderBankLine(line, context), line.replace(placeholder, value));
        assert.equal(renderBankLine(line, {}), '');
      }
    }
  }
  const invalid = entriesFor('primary');
  invalid.find(entry => entry.category === 'thanks').lines = ['thanks for {title}'];
  assert.throws(() => validateBank({ entries: invalid, profiles: PROFILE_IDS.map(id => ({ id, chatMode: 'mentions', replySource: 'local' })) }), /substitution/);
});

test('live status is always exactly live first and offline second', () => {
  for (const [id, profile] of Object.entries(STYLE_PROFILES)) {
    const lines = profile.replies.livestatus;
    assert.equal(lines.length, 2, id);
    assert.match(lines[0], /\blive\b/);
    assert.doesNotMatch(lines[0], /\boffline\b/);
    assert.match(lines[1], /\boffline\b/);
    assert.doesNotMatch(lines[1], /\blive\b/);
    assert.ok(lines.every(line => !/[{}?]/.test(line)));
  }
});

test('profiles do not share exact normalized phrases within the same category', () => {
  for (const category of ['greetings', ...REPLY_CATEGORIES]) {
    const seen = new Map();
    for (const [id, profile] of Object.entries(STYLE_PROFILES)) {
      for (const line of category === 'greetings' ? profile.greetings : profile.replies[category]) {
        const key = messageKey(line);
        assert.ok(!seen.has(key), `${category}: ${id} duplicates ${seen.get(key)}: ${line}`);
        seen.set(key, id);
      }
    }
  }
});

test('direct automation and perception questions keep explicit truthful answers in every voice', () => {
  const account = 'fixture_account';
  assert.equal(replyCategory(`@${account} are you a bot?`, account), 'automation');
  assert.equal(replyCategory(`@${account} did you hear that?`, account), 'capabilities');
  for (const profile of Object.values(STYLE_PROFILES)) {
    for (const line of profile.replies.automation) assert.match(line, /\bautomated\b/);
    for (const line of profile.replies.capabilities) {
      assert.match(line, /(?:not |no |can’t |don’t )/);
      assert.match(line, /(?:video|audio|screen|stream|picture|sound)/);
      assert.doesNotMatch(line, /\?/);
    }
  }
  // Concrete counterexamples must not masquerade as the authored disclosure:
  // neither a claimed human identity nor an invented observed play answers it.
  assert.doesNotMatch('a real person typing live', /\bautomated\b/);
  assert.doesNotMatch('i saw that play on screen', /(?:not |no |can’t |don’t )/);
});

test('reciprocal day answers acknowledge chat-only context rather than inventing an offline event', () => {
  const now = 1_800_000_000_000, account = 'fixture_account', channel = 'fixture_channel';
  const target = { id: 'followup', author: 'chat_person', text: `@${account} and you?`, at: now, channel };
  const recent = [{ account, channel, category: 'checkin', replyTo: target.author, text: 'how’s your day?', at: now - 1000, delivery: 'confirmed' }];
  for (const [id, profile] of Object.entries(STYLE_PROFILES)) {
    const result = localReply({ account, channel, target, recent, now, bank: profile.replies, random: () => 0 });
    assert.equal(result.category, 'reciprocal', id);
    assert.equal(result.text, profile.replies.reciprocal[0], id);
    for (const line of profile.replies.reciprocal) assert.match(line, /\bchat\b|\bconversation\b|\breading along\b/);
  }
  assert.doesNotMatch('i just got home from work', /\bchat\b|\bconversation\b|\breading along\b/);
});

test('questions stay out of closure and factual categories; curious voice has targeted variation', () => {
  for (const profile of Object.values(STYLE_PROFILES)) {
    for (const category of ['thanks', 'farewell', 'goodnight', 'reciprocal', 'capabilities', 'automation', 'game', 'streamtitle', 'livestatus']) {
      assert.ok(profile.replies[category].every(line => !line.includes('?')), category);
    }
    for (const category of ['thanks', 'farewell']) assert.ok(profile.replies[category].every(line => line.length <= 30), category);
  }
  assert.ok(STYLE_PROFILES.test.replies.goodday.every(line => line.includes('?')));
  assert.ok(STYLE_PROFILES.test.replies.roughday.every(line => !line.includes('?')));
  assert.ok(STYLE_PROFILES.fourth.replies.checkin.every(line => !line.includes('?')));
});
