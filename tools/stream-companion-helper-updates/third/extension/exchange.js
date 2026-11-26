import { validateReply } from './core.js';

const LOGIN = /^[a-z0-9_]{3,25}$/;
const TURN = /^[a-zA-Z0-9:_-]{1,200}$/;

// A host offer is scoped to one account and broadcast. Keep this validator
// shared by the browser, helper and remote adapter so none can broaden it.
export function exchangeOffer(value, { account, channel, streamId, accounts = [], now = Date.now(), due = true } = {}) {
  if (!value || typeof value !== 'object' || !Array.isArray(accounts) || !Number.isFinite(now) || !LOGIN.test(account || '')
    || !LOGIN.test(channel || '') || value.account !== account || value.channel !== channel
    || typeof value.id !== 'string' || !TURN.test(value.id) || value.key !== `exchange:${value.id}`
    || typeof value.streamId !== 'string' || !/^\d{1,128}$/.test(value.streamId)
    || (streamId !== undefined && value.streamId !== streamId)
    || !Number.isFinite(value.notBefore) || value.notBefore < 0 || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= value.notBefore || value.expiresAt <= now || (due && value.notBefore > now)) return null;
  const recipient = typeof value.text === 'string' && /^@([a-z0-9_]{3,25}) \S/.exec(value.text)?.[1];
  if (!recipient || recipient === account || !accounts.includes(recipient)) return null;
  try { if (validateReply(value.text) !== value.text) return null; } catch { return null; }
  return { id: value.id, account, channel, streamId: value.streamId, key: value.key, text: value.text,
    notBefore: value.notBefore, expiresAt: value.expiresAt };
}
