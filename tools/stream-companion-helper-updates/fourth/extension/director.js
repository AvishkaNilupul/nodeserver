import { validateReply } from './core.js';

const LOGIN = /^[a-z0-9_]{3,25}$/;
const ID = /^[a-zA-Z0-9:_-]{1,200}$/;
const deliveries = new Set(['pending', 'confirmed', 'rejected', 'unknown', 'cancelled']);
const kinds = new Set(['', 'greeting', 'topic', 'conversation', 'exchange']);
export const sameBinding = (a, b) => !!a && !!b && a.generation === b.generation && a.sessionId === b.sessionId
  && a.settingsRevision === b.settingsRevision;
export function directorBinding(binding, settingsRevision) {
  const value = { generation: binding?.controlGeneration, sessionId: binding?.controlSessionId, settingsRevision };
  if (!ID.test(value.generation || '') || !ID.test(value.sessionId || '') || !Number.isSafeInteger(settingsRevision)
    || settingsRevision < 0) throw Error('Waiting for the current paired control session.');
  return value;
}
export async function sha256(value) {
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function historyRecord(raw, account, type) {
  if (!raw || typeof raw !== 'object' || raw.account && raw.account !== account || !LOGIN.test(raw.channel || '')
    || !Number.isFinite(raw.at) || raw.at < 0 || !deliveries.has(raw.delivery)) throw Error('Historical message records need attention; central sending is held.');
  const record = { type, account, channel: raw.channel, at: raw.at, delivery: raw.delivery };
  // An old cancellation without the explicit no-provider certificate must
  // remain consumed during migration, never become a retry opportunity.
  if (record.delivery === 'cancelled' && raw.submitted !== false) record.delivery = 'unknown';
  if (typeof raw.submitted === 'boolean') record.submitted = raw.submitted;
  for (const key of ['text', 'coordinationId', 'kind', 'streamId', 'replyId', 'replyTo', 'category', 'messageId', 'reason', 'planId']) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'string' || raw[key].length > (key === 'text' ? 300 : key === 'reason' ? 500 : 400)) throw Error('Historical message records need attention; central sending is held.');
      record[key] = raw[key];
    }
  }
  const key = raw.participationKey ?? raw.key;
  if (key !== undefined) {
    if (typeof key !== 'string' || key.length > 400) throw Error('Historical participation records need attention.');
    record.participationKey = key;
  }
  return record;
}
/** Build bounded deterministic pages without deleting or rewriting source journals. */
export async function importPages({ source, account, history = [], participationAttempts = [], handled = [], preferences } = {}) {
  if (!['helper', 'browser'].includes(source) || !LOGIN.test(account || '') || !Array.isArray(history)
    || !Array.isArray(participationAttempts) || !Array.isArray(handled)) throw Error('Invalid central history import.');
  const records = history.map(x => historyRecord(x, account, 'history'));
  if (source === 'browser') {
    for (const entry of participationAttempts) records.push(historyRecord(entry, account, 'participation'));
    for (const key of handled) {
      if (typeof key !== 'string' || !key.startsWith(`${account}:`) || key.length > 400) throw Error('Historical handled targets need attention; central sending is held.');
      records.push({ type: 'handled', key });
    }
  }
  if (records.length > 20_000) throw Error('Historical import needs bounded reconciliation; central sending is held.');
  for (const record of records) record.recordId = await sha256(record);
  const importId = `${source}:${await sha256({ records, preferences: preferences ?? null })}`;
  const chunks = [[]];
  for (const record of records) {
    let chunk = chunks.at(-1);
    if (chunk.length >= 20 || new TextEncoder().encode(JSON.stringify([...chunk, record])).length > 16_000) chunks.push(chunk = []);
    chunk.push(record);
  }
  const pages = [];
  for (let page = 0; page < chunks.length; page++) {
    const final = page === chunks.length - 1;
    const selected = final && source === 'browser' && preferences ? preferences : undefined;
    pages.push({ source, importId, page, final, records: chunks[page],
      digest: await sha256({ records: chunks[page], preferences: selected ?? null }), ...(selected ? { preferences: selected } : {}) });
  }
  return pages;
}
export function importAcknowledged(result, page) {
  return result?.ok === true && result.source === page.source && result.importId === page.importId
    && result.page === page.page && result.digest === page.digest && result.nextPage === page.page + 1
    && result.complete === page.final;
}
/** Exact immutable server payload; normalized duplicate identity is deliberately separate. */
export function directorOffer(value, { account, channel, binding, authorityEpoch, now = Date.now(), due = true } = {}) {
  if (!value || !LOGIN.test(account || '') || !LOGIN.test(channel || '') || value.account !== account || value.channel !== channel
    || !ID.test(value.planId || '') || !ID.test(value.authorityEpoch || '') || value.authorityEpoch !== authorityEpoch
    || !sameBinding(value.binding, binding) || !kinds.has(value.kind) || !['automatic', 'manual'].includes(value.source)
    || typeof value.streamId !== 'string' || !/^\d{0,128}$/.test(value.streamId)
    || typeof value.participationKey !== 'string' || value.participationKey.length > 400
    || typeof value.opportunityKey !== 'string' || value.opportunityKey.length > 500
    || typeof value.exactKey !== 'string' || !/^[a-f0-9]{64}$/.test(value.exactKey)
    || typeof value.textKey !== 'string' || !/^[a-f0-9]{16}$/.test(value.textKey)
    || !Number.isSafeInteger(value.bankRevision) || !Number.isSafeInteger(value.profileRevision)
    || !Number.isFinite(value.notBefore) || !Number.isFinite(value.expiresAt) || value.notBefore < 0
    || value.expiresAt <= value.notBefore || value.expiresAt <= now || (due && value.notBefore > now)
    || typeof value.category !== 'string' || value.category.length > 40 || typeof value.replyId !== 'string'
    || typeof value.replyAuthor !== 'string' || !Number.isFinite(value.replyAt)) return null;
  try { if (validateReply(value.text) !== value.text) return null; } catch { return null; }
  if (value.replyId && (!ID.test(value.replyId) || !LOGIN.test(value.replyAuthor) || value.replyAt > now || now - value.replyAt > 45_000)) return null;
  if (!value.replyId && (value.replyAuthor || value.replyAt !== 0)) return null;
  if (value.source === 'automatic' && !value.streamId) return null;
  return { ...value, binding: { ...value.binding } };
}
