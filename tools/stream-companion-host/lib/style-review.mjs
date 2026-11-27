import { defaultBank, validateBank, digest, PROFILE_IDS } from './bank.mjs';
import { messageKey } from './exchanges.mjs';
import { STYLE_PROFILES } from './style-catalog.mjs';

function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Array.from(value, canonical);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  throw new TypeError('Fingerprints require finite JSON values.');
}

/** SHA256 of UTF8 JSON: sorted object keys, unchanged strings and array order,
 * finite JSON numbers (JSON.stringify maps -0 to0). No text/case normalization. */
export function bankFingerprint(value) { return digest(JSON.stringify(canonical(value))); }

function keys(input, name) {
  if (!Array.isArray(input) || input.length > 1000 || input.some(key => typeof key !== 'string' || !/^[a-f0-9]{16}$/.test(key))) {
    throw new TypeError(`${name} must contain normalized16-character text keys.`);
  }
  return new Set(input);
}
const clone = value => structuredClone(value);
const styleId = id => /^style:(primary|test|third|fourth):/.test(id);
const matchesStock = (entry, stock) => stock && entry.kind !== 'exchange' && entry.kind === stock.kind
  && entry.category === stock.category && JSON.stringify(entry.lines) === JSON.stringify(stock.lines);

/** Pure proposal builder. It never saves, arms, posts, changes revision or reads a DB. */
export function prepareStyleBank(bank, { avoidTextKeys = [] } = {}) {
  validateBank(bank);
  const avoid = keys(avoidTextKeys, 'avoidTextKeys'), stock = new Map(defaultBank().entries.map(entry => [entry.id, entry]));
  const sourceIds = new Set(bank.entries.map(entry => entry.id)), changes = [], warnings = [], entries = [], custom = [];
  const addFiltered = (entry, sourceId, action) => {
    const removed = entry.lines.filter(line => avoid.has(messageKey(line)));
    const lines = entry.category === 'livestatus' && removed.length ? [] : entry.lines.filter(line => !avoid.has(messageKey(line)));
    if (!lines.length) { changes.push({ action: 'omit', id: entry.id, sourceId, removedTextKeys: [...new Set(removed.map(messageKey))] }); return; }
    const result = { ...entry, lines };
    entries.push(result);
    if (action || removed.length) changes.push({ action: action || 'filter', id: entry.id, sourceId, accountIds: [...entry.accountIds], enabled: entry.enabled,
      ...(removed.length ? { removedTextKeys: [...new Set(removed.map(messageKey))] } : {}) });
  };
  for (const original of bank.entries) {
    const entry = clone(original);
    if (entry.kind !== 'exchange' && styleId(entry.id)) { addFiltered(entry, entry.id); continue; }
    if (matchesStock(entry, stock.get(entry.id))) {
      changes.push({ action: 'replace-stock', id: entry.id });
      for (const accountId of entry.accountIds) {
        const id = `style:${accountId}:${entry.id}`;
        if (sourceIds.has(id)) { warnings.push({ code: 'existing-style-preserved', entryId: id, sourceId: entry.id }); continue; }
        const profile = STYLE_PROFILES[accountId];
        const lines = entry.kind === 'greeting' ? profile.greetings : entry.kind === 'reply' ? profile.replies[entry.category] : entry.lines;
        addFiltered({ ...entry, id, lines: [...lines], accountIds: [accountId],
          enabled: entry.enabled && entry.kind !== 'topic' && (entry.kind !== 'greeting' || accountId === 'primary') }, entry.id, 'split-stock');
      }
    } else {
      entries.push(entry); custom.push(entry);
      if (entry.kind !== 'exchange') warnings.push({ code: 'custom-entry-preserved', entryId: entry.id, kind: entry.kind,
        category: entry.category, accountIds: [...entry.accountIds], message: 'Custom wording and assignments are unchanged; review possible style/policy overlap.' });
      const avoided = entry.lines.filter(line => avoid.has(messageKey(line)));
      if (avoided.length) warnings.push({ code: 'preserved-avoid-overlap', entryId: entry.id, textKeys: [...new Set(avoided.map(messageKey))] });
    }
  }
  for (const entry of custom.filter(entry => entry.enabled && entry.kind !== 'exchange')) {
    if (entries.some(other => styleId(other.id) && other.enabled && other.kind === entry.kind && other.category === entry.category
      && other.accountIds.some(id => entry.accountIds.includes(id)))) warnings.push({ code: 'custom-style-overlap', entryId: entry.id, kind: entry.kind, category: entry.category });
  }
  const exchanges = entries.filter(entry => entry.kind === 'exchange' && entry.enabled);
  if (exchanges.length) warnings.push({ code: 'scripted-exchanges-preserved', entryIds: exchanges.map(entry => entry.id),
    message: 'Existing approved exchange scenes are unchanged; review scripted banter separately.' });
  const candidate = { entries, profiles: clone(bank.profiles) };
  // Reject limits or malformed catalog output; never discard custom data to fit.
  validateBank(candidate);
  return { bank: candidate, manifest: { sourceBankSha256: bankFingerprint(bank), candidateSha256: bankFingerprint(candidate),
    stylelabels: Object.fromEntries(PROFILE_IDS.map(id => [id, STYLE_PROFILES[id].label])), changes, warnings } };
}

function metric() { return { confirmed: 0, withText: 0, missingText: 0, questions: 0, greetings: 0, greetingQuestions: 0, styleMatches: 0, assignedBankMatches: 0 }; }
function addMetric(value, row, text, styleKeys, bankKeys) {
  value.confirmed++;
  if (text === null) { value.missingText++; return; }
  value.withText++;
  const question = /[?？]/u.test(text), greeting = row.kind === 'greeting' || ['greeting', 'participation-greeting'].includes(row.category);
  value.questions += Number(question); value.greetings += Number(greeting); value.greetingQuestions += Number(question && greeting);
  value.styleMatches += Number(styleKeys?.has(messageKey(text))); value.assignedBankMatches += Number(bankKeys?.has(messageKey(text)));
}

/** Factual outgoing-history review. Confirmation is delivery evidence, not
 * engagement/approval; absent target context cannot establish relevance. */
export function reviewHistory({ history, bank, negativeFeedbackKeys = [] }) {
  if (!Array.isArray(history)) throw new TypeError('history must be an array.');
  validateBank(bank);
  const negative = keys(negativeFeedbackKeys, 'negativeFeedbackKeys');
  const styleKeys = Object.fromEntries(PROFILE_IDS.map(id => [id, new Set([...STYLE_PROFILES[id].greetings,
    ...Object.values(STYLE_PROFILES[id].replies).flat()].map(messageKey))]));
  const bankKeys = Object.fromEntries(PROFILE_IDS.map(id => [id, new Set(bank.entries.filter(entry => entry.enabled && entry.accountIds.includes(id)).flatMap(entry => entry.lines).map(messageKey))]));
  const accounts = Object.fromEntries(PROFILE_IDS.map(id => [id, { label: STYLE_PROFILES[id].label, ...metric() }]));
  const channels = new Map(), repeats = new Map(), broadcasts = new Map(), totals = metric();
  let nonConfirmed = 0, unknownAccountRows = 0, explicitNegativeMatches = 0;
  const confirmed = history.filter(row => row && row.delivery === 'confirmed');
  for (const row of history) if (!row || row.delivery !== 'confirmed') nonConfirmed++;
  for (const row of confirmed) {
    const accountId = PROFILE_IDS.includes(row.accountId) ? row.accountId : PROFILE_IDS.includes(row.client_id) ? row.client_id : null;
    if (!accountId) unknownAccountRows++;
    const text = row.textAvailable === false || typeof row.text !== 'string' || !row.text.trim() ? null : row.text;
    addMetric(totals, row, text, styleKeys[accountId], bankKeys[accountId]);
    if (accountId) addMetric(accounts[accountId], row, text, styleKeys[accountId], bankKeys[accountId]);
    const channel = typeof row.channel === 'string' ? row.channel : '';
    if (!channels.has(channel)) channels.set(channel, metric());
    addMetric(channels.get(channel), row, text, styleKeys[accountId], bankKeys[accountId]);
    if (text === null) continue;
    const textKey = messageKey(text);
    if (negative.has(textKey)) explicitNegativeMatches++;
    const key = JSON.stringify([channel, textKey]);
    if (!repeats.has(key)) repeats.set(key, { channel, textKey, count: 0, accountIds: new Set(), streamIds: new Set(), questions: 0, greetings: 0 });
    const group = repeats.get(key); group.count++; if (accountId) group.accountIds.add(accountId);
    if (typeof row.streamId === 'string' && row.streamId) group.streamIds.add(row.streamId);
    group.questions += Number(/[?？]/u.test(text)); group.greetings += Number(row.kind === 'greeting' || ['greeting', 'participation-greeting'].includes(row.category));
    if (!broadcasts.has(textKey)) broadcasts.set(textKey, { textKey, count: 0, channels: new Set(), streamIds: new Set() });
    const broadcast = broadcasts.get(textKey); broadcast.count++; broadcast.channels.add(channel);
    if (typeof row.streamId === 'string' && row.streamId) broadcast.streamIds.add(row.streamId);
  }
  const repeatedText = [...repeats.values()].filter(group => group.count > 1).map(group => ({ ...group,
    accountIds: [...group.accountIds].sort(), streamIds: [...group.streamIds].sort(), crossBroadcast: group.streamIds.size > 1 })).sort((a, b) => a.channel.localeCompare(b.channel) || a.textKey.localeCompare(b.textKey));
  const recommendations = [];
  const crossBroadcastRepeatedText = [...broadcasts.values()].filter(group => group.count > 1 && group.streamIds.size > 1)
    .map(group => ({ ...group, channels: [...group.channels].sort(), streamIds: [...group.streamIds].sort() })).sort((a, b) => a.textKey.localeCompare(b.textKey));
  if (repeatedText.length || crossBroadcastRepeatedText.length) recommendations.push({ code: 'review-repeated-wording', sameChannelGroups: repeatedText.length,
    crossBroadcastGroups: crossBroadcastRepeatedText.length, message: 'Review repeated wording, including cross-broadcast reuse; these counts do not establish a duplicate-guard failure.' });
  if (totals.questions) recommendations.push({ code: 'review-question-mix', questions: totals.questions, confirmedWithText: totals.withText, message: 'Review question/greeting mix and contextual usefulness; delivery does not demonstrate engagement.' });
  if (totals.missingText) recommendations.push({ code: 'incomplete-text-coverage', rows: totals.missingText, message: 'Missing historical text limits style/repetition conclusions.' });
  if (explicitNegativeMatches) recommendations.push({ code: 'explicit-negative-feedback', rows: explicitNegativeMatches, textKeys: [...negative].sort(), message: 'Only explicitly supplied feedback keys are marked negative; no sentiment is inferred.' });
  if (bank.entries.some(entry => entry.kind === 'exchange' && entry.enabled)) recommendations.push({ code: 'review-scripted-banter', message: 'Existing approved exchanges remain enabled; review their wording separately.' });
  return { sourceBankSha256: bankFingerprint(bank), rows: history.length, confirmedRows: confirmed.length, nonConfirmedRows: nonConfirmed,
    unknownAccountRows, totals, accounts, channels: Object.fromEntries([...channels.entries()].sort(([a], [b]) => a.localeCompare(b))), repeatedText, crossBroadcastRepeatedText,
    explicitNegativeFeedback: { suppliedKeys: [...negative].sort(), confirmedMatches: explicitNegativeMatches }, recommendations,
    limitations: ['Only confirmed rows with available text contribute to wording metrics.', 'Greeting/question counters overlap; greetingQuestions records their intersection.',
      'Catalog matches use normalized text keys; substituted game/title text may not match a template.', 'Outgoing history alone does not establish audience engagement, target relevance, or a guard failure.',
      'This report and candidate tool never activate changes or learn approval from silence or failed delivery.'] };
}
