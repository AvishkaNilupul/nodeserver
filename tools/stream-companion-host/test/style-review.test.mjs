import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultBank, validateBank, PROFILE_IDS } from '../lib/bank.mjs';
import { messageKey } from '../lib/exchanges.mjs';
import { STYLE_PROFILES } from '../lib/style-catalog.mjs';
import { bankFingerprint, prepareStyleBank, reviewHistory } from '../lib/style-review.mjs';

const copy = value => structuredClone(value);
const entry = (id, lines = ['custom wording'], extra = {}) => ({ id, kind: 'reply', category: 'thanks', lines, accountIds: ['primary'], enabled: true, ...extra });
const style = (bank, id, stock) => bank.entries.find(entry => entry.id === `style:${id}:${stock}`);

test('canonical fingerprint sorts object keys but retains string and array content/order', () => {
  assert.equal(bankFingerprint({ z: 1, a: { y: 'é', x: [1, 2] } }), bankFingerprint({ a: { x: [1, 2], y: 'é' }, z: 1 }));
  assert.notEqual(bankFingerprint(['live', 'offline']), bankFingerprint(['offline', 'live']));
  assert.notEqual(bankFingerprint('Hi'), bankFingerprint('hi'));
  for (const invalid of [undefined, NaN, Infinity, new Date(), [undefined]]) assert.throws(() => bankFingerprint(invalid));
});

test('default proposal has124 groups, primary-only arrival, quiet topics and unchanged approved exchanges', () => {
  const source = defaultBank(), before = copy(source), result = prepareStyleBank(source);
  assert.equal(result.bank.entries.length, 124); validateBank(result.bank);
  assert.deepEqual(source, before); assert.deepEqual(result.bank.profiles, source.profiles);
  for (const id of PROFILE_IDS) {
    assert.equal(style(result.bank, id, 'greeting').enabled, id === 'primary');
    assert.deepEqual(style(result.bank, id, 'greeting').accountIds, [id]);
    assert.deepEqual(style(result.bank, id, 'greeting').lines, STYLE_PROFILES[id].greetings);
  }
  assert.ok(result.bank.entries.filter(entry => entry.kind === 'topic').every(entry => entry.enabled === false));
  assert.deepEqual(result.bank.entries.filter(entry => entry.kind === 'exchange'), source.entries.filter(entry => entry.kind === 'exchange'));
  assert.ok(result.manifest.warnings.some(warning => warning.code === 'scripted-exchanges-preserved'));
  assert.equal(result.manifest.sourceBankSha256, bankFingerprint(source));
  assert.equal(result.manifest.candidateSha256, bankFingerprint(result.bank));
});

test('selective assignments, disabled groups and profile preferences survive stock conversion', () => {
  const source = defaultBank(), thanks = source.entries.find(entry => entry.id === 'reply_thanks');
  thanks.accountIds = ['third', 'primary']; thanks.enabled = false;
  source.profiles[0].chatMode = 'participate'; source.profiles[0].replySource = 'ai';
  const { bank } = prepareStyleBank(source);
  assert.deepEqual(bank.profiles, source.profiles);
  assert.equal(style(bank, 'test', 'reply_thanks'), undefined); assert.equal(style(bank, 'fourth', 'reply_thanks'), undefined);
  for (const id of ['primary', 'third']) assert.equal(style(bank, id, 'reply_thanks').enabled, false);
});

test('custom stock edits and custom groups remain byte-equivalent with review warnings', () => {
  const source = defaultBank(); source.entries[0].lines = ['my own arrival'];
  const custom = entry('custom_reply', ['my own thanks'], { accountIds: ['third', 'primary'], enabled: false }); source.entries.push(custom);
  const result = prepareStyleBank(source);
  assert.deepEqual(result.bank.entries.find(entry => entry.id === 'greeting'), source.entries[0]);
  assert.deepEqual(result.bank.entries.find(entry => entry.id === custom.id), custom);
  assert.ok(result.manifest.warnings.some(warning => warning.code === 'custom-entry-preserved' && warning.entryId === 'greeting'));
});

test('repeat preparation preserves existing style edits, assignments and enabled state without expansion', () => {
  const first = prepareStyleBank(defaultBank()).bank, changed = style(first, 'third', 'greeting');
  changed.lines = ['an explicitly edited arrival']; changed.accountIds = ['test']; changed.enabled = true;
  const second = prepareStyleBank(first);
  assert.equal(bankFingerprint(second.bank), bankFingerprint(first));
  assert.deepEqual(style(second.bank, 'third', 'greeting'), changed); assert.deepEqual(second.manifest.changes, []);
});

test('an existing style group wins over partially converted stock without overwrite or duplicate id', () => {
  const source = defaultBank(), existing = entry('style:primary:reply_thanks', ['edited style'], { enabled: false });
  source.entries.push(existing); const result = prepareStyleBank(source);
  assert.deepEqual(style(result.bank, 'primary', 'reply_thanks'), existing);
  assert.equal(result.bank.entries.filter(entry => entry.id === existing.id).length, 1);
  assert.ok(result.manifest.warnings.some(warning => warning.code === 'existing-style-preserved'));
});

test('explicit normalized feedback removes catalog lines and remains idempotent', () => {
  const phrase = STYLE_PROFILES.primary.greetings[0], key = messageKey(phrase.toUpperCase());
  const first = prepareStyleBank(defaultBank(), { avoidTextKeys: [key] });
  assert.ok(!style(first.bank, 'primary', 'greeting')?.lines.some(line => messageKey(line) === key));
  assert.equal(bankFingerprint(prepareStyleBank(first.bank, { avoidTextKeys: [key] }).bank), bankFingerprint(first.bank));
});

test('explicit feedback on existing style edits preserves every other field and omits an empty group', () => {
  const source = prepareStyleBank(defaultBank()).bank, changed = style(source, 'test', 'reply_thanks');
  changed.lines = ['remove this', 'keep this edit']; changed.enabled = false; changed.accountIds = ['third'];
  const first = prepareStyleBank(source, { avoidTextKeys: [messageKey('remove this')] }).bank;
  assert.deepEqual(style(first, 'test', 'reply_thanks'), { ...changed, lines: ['keep this edit'] });
  const second = prepareStyleBank(first, { avoidTextKeys: [messageKey('keep this edit')] }).bank;
  assert.equal(style(second, 'test', 'reply_thanks'), undefined);
});

test('livestatus feedback omits the entire ordered pair instead of leaving a false-status singleton', () => {
  const source = prepareStyleBank(defaultBank()).bank, pair = style(source, 'primary', 'reply_livestatus');
  assert.equal(pair.lines.length, 2);
  const result = prepareStyleBank(source, { avoidTextKeys: [messageKey(pair.lines[1])] });
  assert.equal(style(result.bank, 'primary', 'reply_livestatus'), undefined);
  assert.deepEqual(style(result.bank, 'test', 'reply_livestatus').lines, style(source, 'test', 'reply_livestatus').lines);
});

test('custom and exchange negative-key matches are preserved and warned rather than edited', () => {
  const source = defaultBank(), custom = entry('custom_keep'); source.entries.push(custom);
  const exchange = source.entries.find(entry => entry.kind === 'exchange'); exchange.id = 'style:primary:approved_scene';
  exchange.accountIds = ['fourth', 'primary']; exchange.enabled = false;
  const result = prepareStyleBank(source, { avoidTextKeys: [messageKey(custom.lines[0]), messageKey(exchange.lines[0])] });
  assert.deepEqual(result.bank.entries.find(entry => entry.id === custom.id), custom);
  assert.deepEqual(result.bank.entries.find(entry => entry.id === exchange.id), exchange);
  assert.equal(result.manifest.warnings.filter(warning => warning.code === 'preserved-avoid-overlap').length, 2);
});

test('candidate limits reject rather than deleting custom entries and input stays unchanged', () => {
  const source = defaultBank(); for (let i = 0; i < 37; i++) source.entries.push(entry(`custom_${i}`));
  const before = copy(source); assert.throws(() => prepareStyleBank(source), /invalid or too large/); assert.deepEqual(source, before);
});

test('a valid input whose expansion exceeds60k is rejected without truncating custom content', () => {
  const stock = defaultBank(), source = { entries: [stock.entries.find(entry => entry.id === 'topic_general')], profiles: stock.profiles };
  for (let i = 0; i < 14; i++) source.entries.push(entry(`large_custom_${i}`, Array.from({ length: 16 }, (_, j) => `${i}:${j} ` + 'x'.repeat(250))));
  let filler = 1;
  while (Buffer.byteLength(JSON.stringify(source)) < 59600) {
    const id = `fill_${filler++}`;
    source.entries.push(entry(id, ['y'.repeat(Math.min(260, 59700 - Buffer.byteLength(JSON.stringify(source))))]));
  }
  validateBank(source); const before = copy(source);
  assert.throws(() => prepareStyleBank(source), /invalid or too large/); assert.deepEqual(source, before);
});

test('only the four validated profile IDs are accepted and revision wrappers are not bank schema', () => {
  const source = defaultBank(); source.profiles[0].id = 'other'; assert.throws(() => prepareStyleBank(source));
  assert.throws(() => prepareStyleBank({ ...defaultBank(), revision: 8 }));
  assert.throws(() => prepareStyleBank(defaultBank(), { avoidTextKeys: ['a'.repeat(64)] }));
});

test('review quality uses confirmed available text only, with explicit coverage and overlapping question/greeting counts', () => {
  const history = [
    { id: 1, accountId: 'primary', channel: 'room', streamId: '1', delivery: 'confirmed', kind: 'greeting', text: 'hey, how are things?' },
    { id: 2, accountId: 'test', channel: 'room', streamId: '1', delivery: 'confirmed', text: null, textAvailable: false },
    { id: 3, accountId: 'third', channel: 'room', streamId: '1', delivery: 'unknown', text: 'hey, how are things?' },
    { id: 4, accountId: 'fourth', channel: 'room', streamId: '1', delivery: 'rejected', text: 'hey, how are things?' }
  ];
  const report = reviewHistory({ history, bank: defaultBank() });
  assert.equal(report.confirmedRows, 2); assert.equal(report.nonConfirmedRows, 2);
  assert.equal(report.totals.withText, 1); assert.equal(report.totals.missingText, 1);
  assert.equal(report.totals.questions, 1); assert.equal(report.totals.greetings, 1); assert.equal(report.totals.greetingQuestions, 1);
  assert.deepEqual(report.repeatedText, []); assert.equal(report.explicitNegativeFeedback.confirmedMatches, 0);
  assert.deepEqual(Object.keys(report.accounts), PROFILE_IDS);
});

test('review reports normalized cross-broadcast/channel reuse without inventing duplicate-guard failure or feedback', () => {
  const history = [
    { accountId: 'primary', channel: 'one_room', streamId: '1', delivery: 'confirmed', text: 'Hi chat!' },
    { accountId: 'test', channel: 'one_room', streamId: '2', delivery: 'confirmed', text: 'hi chat' },
    { accountId: 'third', channel: 'other_room', streamId: '3', delivery: 'confirmed', text: 'HI CHAT.' }
  ];
  const report = reviewHistory({ history, bank: defaultBank(), negativeFeedbackKeys: [messageKey('hi chat')] });
  assert.equal(report.repeatedText.length, 1); assert.equal(report.repeatedText[0].crossBroadcast, true);
  assert.equal(report.crossBroadcastRepeatedText[0].count, 3); assert.equal(report.crossBroadcastRepeatedText[0].channels.length, 2);
  assert.equal(report.explicitNegativeFeedback.confirmedMatches, 3);
  assert.ok(report.recommendations.some(item => item.message.includes('do not establish a duplicate-guard failure')));
});

test('style coverage is per-account, not accidental matching against another account catalog', () => {
  const text = STYLE_PROFILES.primary.greetings[0];
  const report = reviewHistory({ bank: defaultBank(), history: [{ accountId: 'primary', delivery: 'confirmed', channel: 'room', text },
    { accountId: 'test', delivery: 'confirmed', channel: 'room', text }] });
  assert.equal(report.accounts.primary.styleMatches, 1); assert.equal(report.accounts.test.styleMatches, 0);
  assert.equal(report.accounts.primary.withText, 1); assert.equal(report.accounts.test.withText, 1);
});
