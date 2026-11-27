import { validateReply } from './core.js';

export const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
export const MAX_HTTP_BODY = 262144;
export const MAX_FRAME = 65536;
export const MAX_REQUEST = 65536;
const bytes = text => new TextEncoder().encode(text).length;
const invalid = () => { throw Error('Unsupported USA relay request.'); };
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
const digits = v => typeof v === 'string' && /^\d{1,32}$/.test(v);
const opaque = (v, max = 8192) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[\x21-\x7e]+$/.test(v);
function target(raw, protocol, host) {
  if (typeof raw !== 'string' || raw.length > 4096 || !/^[\x21-\x7e]+$/.test(raw)) invalid();
  let url; try { url = new URL(raw); } catch { invalid(); }
  if (url.protocol !== protocol || url.hostname !== host || url.port || url.username || url.password || url.hash || url.href !== raw) invalid();
  return url;
}
function scopes(value) {
  if (typeof value !== 'string') invalid();
  const values = value.split(' '), allowed = ['user:read:chat', 'user:write:chat', 'clips:edit'];
  if (![2, 3].includes(values.length) || new Set(values).size !== values.length || values.some(v => !allowed.includes(v)) || !values.includes(allowed[0]) || !values.includes(allowed[1])) invalid();
}
function form(body, path) {
  const data = new URLSearchParams(body), entries = [...data];
  if (new Set(entries.map(([k]) => k)).size !== entries.length) invalid();
  const value = Object.fromEntries(entries);
  if (!/^[A-Za-z0-9]{10,80}$/.test(value.client_id || '')) invalid();
  if (path === '/oauth2/device') {
    if (!exact(value, ['client_id', 'scopes'])) invalid(); scopes(value.scopes);
  } else if (value.grant_type === 'refresh_token') {
    if (!exact(value, ['client_id', 'grant_type', 'refresh_token']) || !opaque(value.refresh_token)) invalid();
  } else {
    if (!exact(value, ['client_id', 'scopes', 'device_code', 'grant_type']) || value.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code' || !opaque(value.device_code)) invalid();
    scopes(value.scopes);
  }
}
function jsonBody(body, path) {
  let value; try { value = JSON.parse(body); } catch { invalid(); }
  if (path === '/helix/chat/messages') {
    const keys = ['broadcaster_id', 'sender_id', 'message', ...(Object.hasOwn(value || {}, 'reply_parent_message_id') ? ['reply_parent_message_id'] : [])];
    if (!exact(value, keys) || !digits(value.broadcaster_id) || !digits(value.sender_id) || typeof value.message !== 'string' || value.message.length > 300
      || Object.hasOwn(value, 'reply_parent_message_id') && !opaque(value.reply_parent_message_id, 160)) invalid();
    try { if (validateReply(value.message) !== value.message) invalid(); } catch { invalid(); }
  } else if (!exact(value, ['type', 'version', 'condition', 'transport']) || !['channel.chat.message', 'channel.chat.notification'].includes(value.type) || value.version !== '1'
    || !exact(value.condition, ['broadcaster_user_id', 'user_id']) || !digits(value.condition.broadcaster_user_id) || !digits(value.condition.user_id)
    || !exact(value.transport, ['method', 'session_id']) || value.transport.method !== 'websocket' || !opaque(value.transport.session_id, 200)) invalid();
}
export function validateFetch(raw, { method = 'GET', headers = [], body } = {}) {
  if (!['GET', 'POST'].includes(method) || !Array.isArray(headers) || headers.length > 4 || body !== undefined && (typeof body !== 'string' || bytes(body) > MAX_REQUEST)) invalid();
  const normalized = [], names = new Set();
  for (const pair of headers) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') invalid();
    const name = pair[0].toLowerCase(), value = pair[1];
    if (names.has(name) || !['authorization', 'client-id', 'content-type', 'accept'].includes(name) || /[\r\n\u0000-\u001f\u007f]/.test(value)) invalid();
    if (name === 'authorization' && !/^(?:Bearer|OAuth) [A-Za-z0-9._~:+/-]{1,8192}$/.test(value)
      || name === 'client-id' && !/^[A-Za-z0-9]{10,80}$/.test(value)
      || name === 'content-type' && !['application/json', 'application/x-www-form-urlencoded'].includes(value)
      || name === 'accept' && value !== 'application/json') invalid();
    names.add(name); normalized.push([name, value]);
  }
  const header = Object.fromEntries(normalized);
  let url;
  if (typeof raw === 'string' && raw.startsWith('https://id.twitch.tv/')) {
    url = target(raw, 'https:', 'id.twitch.tv');
    if (url.search) invalid();
    if (method === 'GET' && url.pathname === '/oauth2/validate') {
      if (!/^OAuth /.test(header.authorization || '') || names.has('client-id') || names.has('content-type') || body !== undefined) invalid();
    } else {
      if (method !== 'POST' || !['/oauth2/device', '/oauth2/token'].includes(url.pathname) || names.has('authorization') || names.has('client-id') || header['content-type'] !== 'application/x-www-form-urlencoded' || typeof body !== 'string') invalid();
      form(body, url.pathname);
    }
  } else {
    url = target(raw, 'https:', 'api.twitch.tv');
    if (!/^Bearer /.test(header.authorization || '') || !header['client-id']) invalid();
    const entries = [...url.searchParams], query = Object.fromEntries(entries);
    if (new Set(entries.map(([k]) => k)).size !== entries.length) invalid();
    if (method === 'GET') {
      const key = { '/helix/users': 'login', '/helix/streams': 'user_id', '/helix/chat/settings': 'broadcaster_id', '/helix/shared_chat/session': 'broadcaster_id', '/helix/clips': 'id' }[url.pathname];
      if (!key || !exact(query, [key]) || body !== undefined || names.has('content-type')) invalid();
      if (key === 'login' ? !/^[a-z0-9_]{3,25}$/.test(query[key]) : key === 'id' ? !/^[A-Za-z0-9_-]{1,256}$/.test(query[key]) : !digits(query[key])) invalid();
    } else if (url.pathname === '/helix/clips') {
      if (!exact(query, ['broadcaster_id', 'duration']) || !digits(query.broadcaster_id) || query.duration !== '30' || body !== undefined || names.has('content-type')) invalid();
    } else {
      if (!['/helix/eventsub/subscriptions', '/helix/chat/messages'].includes(url.pathname) || url.search || header['content-type'] !== 'application/json' || typeof body !== 'string') invalid();
      jsonBody(body, url.pathname);
    }
  }
  return { url: url.href, method, headers: normalized, ...(body === undefined ? {} : { body }) };
}
export function validateSocket(raw) {
  if (typeof raw !== 'string' || raw.includes('#')) invalid();
  const address = raw.replace(/^wss:\/\/eventsub\.wss\.twitch\.tv(?=\?|$)/, 'wss://eventsub.wss.twitch.tv/');
  const url = target(address, 'wss:', 'eventsub.wss.twitch.tv');
  if (!['/', '/ws'].includes(url.pathname) || url.search.length > 2048 || /[^A-Za-z0-9_.~%+&=:/?-]/.test(url.search)) invalid();
  return url.href;
}
