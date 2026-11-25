import { readFile } from 'node:fs/promises';

const SOURCES = Object.freeze([
  { id: 'primary', name: 'Main companion', port: 8792, configPath: new URL('../../stream-companion/private/config.json', import.meta.url) },
  { id: 'test', name: 'Second companion', port: 8793, configPath: new URL('../../stream-companion-test/private/config.json', import.meta.url) }
]);
const LOGIN = /^[a-z0-9_]{3,25}$/;
const ACTIONS = new Set(['start', 'stop', 'watch', 'settings', 'draft', 'send', 'drops-enable', 'drops-disable', 'drops-check']);
const STATES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled', 'expired']);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const login = value => typeof value === 'string' && LOGIN.test(value) ? value : '';
const timestamp = value => Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const number = value => Number.isFinite(value) && value >= 0 ? value : 0;
const keys = (value, expected) => record(value) && Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
const CLIP_STATES = new Set(['queued', 'submitting', 'pending', 'confirmed', 'failed', 'cancelled', 'unknown']);
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);

function cleanClipJob(raw, clean) {
  if (!record(raw) || !opaque(raw.requestId) || !login(raw.account) || !login(raw.channel)
    || !/^\d{1,32}$/.test(raw.streamId || '') || !['manual', 'automatic'].includes(raw.source)
    || !CLIP_STATES.has(raw.state) || !Number.isFinite(raw.createdAt) || !Number.isFinite(raw.updatedAt)) return null;
  const clipId = typeof raw.clipId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(raw.clipId) ? raw.clipId : '';
  return { requestId: raw.requestId, account: raw.account, channel: raw.channel, streamId: raw.streamId, source: raw.source,
    createdAt: raw.createdAt, updatedAt: raw.updatedAt, state: raw.state, clipId,
    url: raw.state === 'confirmed' && clipId && raw.url === `https://clips.twitch.tv/${clipId}` ? raw.url : '', error: clean(raw.error) };
}

export function validateCommand(value) {
  if (!keys(value, ['requestId', 'action', 'params']) || typeof value.requestId !== 'string'
    || !/^[a-zA-Z0-9_:-]{1,160}$/.test(value.requestId) || !ACTIONS.has(value.action) || !record(value.params)) throw failure('Choose a supported account action.');
  const p = value.params, settings = () => ['mentions', 'participate'].includes(p.chatMode)
    && ['local', 'ai'].includes(p.replySource) && typeof p.autoResume === 'boolean';
  let valid = false;
  if (value.action === 'start') valid = keys(p, ['channel', 'chatMode', 'replySource', 'autoResume']) && !!login(p.channel) && settings();
  else if (value.action === 'settings') valid = keys(p, ['chatMode', 'replySource', 'autoResume']) && settings();
  else if (value.action === 'draft') valid = keys(p, ['mode']) && ['reply', 'summary'].includes(p.mode);
  else if (value.action === 'send') valid = keys(p, ['text']) && typeof p.text === 'string' && p.text.trim() === p.text
    && p.text.length > 0 && p.text.length <= 300 && !/^[/.]|[\r\n\u0000-\u001f\u007f]|https?:\/\/|www\./i.test(p.text);
  else valid = keys(p, []);
  if (!valid) throw failure('The account action has invalid settings.');
  return { requestId: value.requestId, action: value.action, params: { ...p } };
}

function privateValues(config) {
  const found = [];
  const visit = (v, key = '', depth = 0) => {
    if (depth > 5) return;
    if (typeof v === 'string' && /token|secret|password|key|extensionid|clientid/i.test(key) && v.length >= 4) found.push(v);
    else if (record(v)) for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
  };
  visit(config); return found;
}
function cleaner(secrets) {
  const values = [...new Set(secrets)].sort((a, b) => b.length - a.length);
  return (value, max = 300) => {
    if (typeof value !== 'string') return '';
    let out = value;
    for (const secret of values) out = out.split(secret).join('[redacted]');
    return out.replace(/\b(?:Bearer|OAuth)\s+\S+/gi, '[redacted]')
      .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|api[_ -]?key|pairing[_ -]?token|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '[redacted]')
      .replace(/chrome-extension:\/\/[^\s"'<>]+|file:\/\/[^\s"'<>]+/gi, '[redacted]')
      .replace(/(?:~?\/(?:Users|home|private|var|etc)\/|[A-Za-z]:[\\/])[^\s"'<>)]*/g, '[redacted]')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  };
}

function cleanCommand(raw, clean) {
  if (!record(raw) || typeof raw.id !== 'string' || raw.id.length > 200 || !ACTIONS.has(raw.action) || !STATES.has(raw.state)) return null;
  const result = record(raw.result) ? Object.fromEntries(['text', 'reason', 'mode', 'category', 'source'].filter(k => typeof raw.result[k] === 'string').map(k => [k, clean(raw.result[k], k === 'text' ? 6000 : 300)])) : undefined;
  if (result && typeof raw.result.ok === 'boolean') result.ok = raw.result.ok;
  let params = {};
  try { params = validateCommand({ requestId: raw.requestId || raw.id, action: raw.action, params: raw.params }).params; } catch { /* Invalid diagnostics never gain authority. */ }
  if (typeof params.text === 'string') params.text = clean(params.text);
  return { id: clean(raw.id, 200), requestId: clean(raw.requestId, 160), action: raw.action, params, state: raw.state,
    createdAt: number(timestamp(raw.createdAt)), expiresAt: number(timestamp(raw.expiresAt)), ...(result ? { result } : {}), error: clean(raw.error) };
}

function empty(source, time, error) {
  return { id: source.id, name: source.name, available: false, checkedAt: new Date(time).toISOString(), account: '', authorized: false, connected: false, channel: '', error,
    settings: { allowedChannel: '', paused: true, autoReply: false, autoResume: false, chatMode: 'mentions', replySource: 'local' },
    browser: { online: false, lastSeenAt: null }, watch: { enabled: false, status: 'unknown', channel: '', checkedAt: 0, error: '' },
    activity: { state: 'waiting', reason: error, at: 0 }, streamContext: null, chat: { messages: [], digest: { messages: 0, people: 0, topics: [] } },
    sent: [], drops: { enabled: false }, coordination: { available: false, paused: false, reason: '' }, permissions: { playbackAccess: false }, controls: { pending: null, recent: [] } };
}

function project(source, raw, time, clean) {
  if (!record(raw) || raw.ok !== true || typeof raw.authorized !== 'boolean' || typeof raw.connected !== 'boolean'
    || raw.authorized && !login(raw.account) || raw.connected && (!raw.authorized || !login(raw.channel))) throw failure('The companion returned invalid control status.', 503);
  const base = empty(source, time, ''), s = record(raw.settings) ? raw.settings : {}, b = record(raw.browser) ? raw.browser : {}, w = record(raw.watch) ? raw.watch : {};
  const lastSeen = timestamp(b.lastSeenAt), online = b.online === true && Number.isFinite(lastSeen) && lastSeen <= time + 5000 && lastSeen >= time - 45000;
  const messages = (Array.isArray(raw.chat?.messages) ? raw.chat.messages : []).filter(m => record(m) && login(m.author) && typeof m.text === 'string' && Number.isFinite(m.at) && m.at <= time + 5000 && m.at >= time - 900000)
    .slice(-100).map(m => ({ id: clean(m.id, 160), author: m.author, text: clean(m.text), at: m.at, channel: login(m.channel) || login(raw.channel) }));
  const sent = (Array.isArray(raw.sent) ? raw.sent : []).filter(m => record(m) && login(m.account) && login(m.channel) && Number.isFinite(m.at) && m.at <= time + 5000 && m.at >= time - 14 * 86400000 && typeof m.text === 'string')
    .sort((a, b) => b.at - a.at).slice(0, 50).map(m => ({ at: m.at, account: m.account, channel: m.channel, text: clean(m.text),
      delivery: ['confirmed', 'rejected', 'pending', 'cancelled'].includes(m.delivery) ? m.delivery : 'unknown',
      kind: ['greeting', 'topic', 'conversation', 'exchange'].includes(m.kind) ? m.kind : m.replyTo ? 'reply' : 'message',
      reason: /verified_phone_number/.test(m.reason || '') ? 'Twitch requires a verified phone number to chat here.' : clean(m.reason), replyTo: login(m.replyTo), messageId: clean(m.messageId, 160) }));
  let streamContext = null;
  const c = raw.streamContext;
  if (record(c) && login(c.channel) && Number.isFinite(c.checkedAt) && c.checkedAt >= time - 120000 && c.checkedAt <= time + 5000) streamContext = {
    channel: c.channel, title: clean(c.title, 160), gameName: clean(c.gameName, 100), streamId: clean(c.streamId, 128), isLive: c.isLive === true, checkedAt: c.checkedAt
  };
  const activity = record(raw.activity) ? raw.activity : {}, coordination = record(raw.coordination) ? raw.coordination : {};
  const drops = { enabled: raw.drops?.enabled === true };
  for (const k of ['state', 'status', 'phase', 'reason', 'error']) if (typeof raw.drops?.[k] === 'string') drops[k] = clean(raw.drops[k]);
  for (const k of ['checkedAt', 'lastCheckAt', 'claimed', 'available', 'pending']) if (Number.isFinite(raw.drops?.[k])) drops[k] = number(raw.drops[k]);
  if (Number.isFinite(raw.drops?.lastCheck)) drops.lastCheckAt = number(raw.drops.lastCheck);
  drops.history = (Array.isArray(raw.drops?.history) ? raw.drops.history : []).slice(-20).filter(record).map(x => ({ at: number(timestamp(x.at)),
    name: clean(x.name, 120), text: clean(x.text), reason: clean(x.reason), state: clean(x.state, 40),
    delivery: ['confirmed', 'rejected', 'pending', 'cancelled'].includes(x.delivery) ? x.delivery : 'unknown', channel: login(x.channel) }));
  const recent = (Array.isArray(raw.controls?.recent) ? raw.controls.recent : []).map(x => cleanCommand(x, clean)).filter(Boolean).slice(0, 30);
  const pending = (Array.isArray(raw.controls?.pending) ? raw.controls.pending : [raw.controls?.pending]).map(x => cleanCommand(x, clean)).filter(x => x && ['queued', 'running'].includes(x.state));
  pending.sort((a, b) => Number(b.action === 'stop') - Number(a.action === 'stop') || b.createdAt - a.createdAt);
  return { ...base, available: true, account: login(raw.account), authorized: raw.authorized, connected: raw.connected, channel: login(raw.channel), error: clean(raw.error),
    settings: { allowedChannel: login(s.allowedChannel), paused: s.paused !== false, autoReply: s.autoReply === true, autoResume: s.autoResume === true,
      chatMode: s.chatMode === 'participate' ? 'participate' : 'mentions', replySource: s.replySource === 'ai' ? 'ai' : 'local' },
    browser: { online, lastSeenAt: Number.isFinite(lastSeen) ? new Date(lastSeen).toISOString() : null },
    watch: { enabled: w.enabled === true, status: ['playing', 'paused', 'buffering', 'stalled', 'ad', 'advertisement', 'offline', 'ended', 'checking', 'commercial', 'error'].includes(w.status) ? w.status : 'unknown', channel: login(w.channel), checkedAt: number(w.checkedAt), error: clean(w.error) },
    activity: { state: clean(activity.state, 40), reason: clean(activity.reason), at: number(activity.at) }, streamContext,
    chat: { messages, digest: { messages: messages.length, people: new Set(messages.map(m => m.author)).size, topics: [] } }, sent, drops,
    coordination: { available: coordination.available === true, paused: coordination.paused === true, reason: clean(coordination.reason) },
    permissions: { playbackAccess: raw.permissions?.playbackAccess === true }, controls: { pending: pending[0] || null, recent } };
}

export function createAccountManager({ sources = SOURCES, fetchImpl = fetch, readFileImpl = readFile, now = Date.now } = {}) {
  const selected = sources.map(s => {
    const fixed = SOURCES.find(x => x.id === s.id);
    if (!fixed || s.port !== undefined && s.port !== fixed.port) throw Error('Unsupported account source.');
    return { ...fixed, configPath: s.configPath ?? fixed.configPath };
  });
  if (!selected.length || new Set(selected.map(s => s.id)).size !== selected.length) throw Error('Unique account sources required.');
  const configurations = async () => Promise.all(selected.map(async source => {
    try {
      const data = await readFileImpl(source.configPath, { encoding: 'utf8', signal: AbortSignal.timeout(1500) });
      if (Buffer.byteLength(data) > 64000) throw Error();
      const config = JSON.parse(data);
      if (!/^[a-p]{32}$/.test(config.extensionId || '') || typeof config.pairingToken !== 'string' || !/^\S{16,1024}$/.test(config.pairingToken)) throw Error();
      return { source, config, secrets: privateValues(config) };
    } catch { return { source, error: 'Local account setup needs attention.', secrets: [] }; }
  }));
  const request = async (entry, path, body) => {
    if (entry.error) throw failure(entry.error, 503);
    let response;
    try { response = await fetchImpl(`http://127.0.0.1:${entry.source.port}${path}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
      headers: { Origin: `chrome-extension://${entry.config.extensionId}`, Authorization: `Bearer ${entry.config.pairingToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch { throw failure('The local companion helper is unavailable.', 503); }
    let raw;
    try {
      if (Number(response.headers.get('content-length')) > 256000) throw Error();
      const reader = response.body.getReader(), chunks = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 256000) { await reader.cancel(); throw Error(); } chunks.push(Buffer.from(value)); } }
      finally { reader.releaseLock(); }
      raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw failure('The local companion returned invalid data.', 503); }
    if (!response.ok || !record(raw) || raw.ok !== true) {
      const clean = cleaner(entry.secrets), message = clean(raw?.error);
      throw failure(message || 'The account action could not be accepted.', [400, 409, 429].includes(response.status) ? response.status : 503);
    }
    return raw;
  };
  let cached = null, cachedAt = 0, inflight = null, revision = 0, inflightRevision = -1;
  const snapshot = async () => {
    if (cached && now() >= cachedAt && now() - cachedAt < 1500) return cached;
    if (inflight && inflightRevision === revision) return inflight;
    const expected = revision;
    const flight = (async () => {
      const entries = await configurations(), clean = cleaner(entries.flatMap(x => x.secrets));
      const instances = await Promise.all(entries.map(async entry => {
        try { return project(entry.source, await request(entry, '/api/control/status', {}), now(), clean); }
        catch (e) { return empty(entry.source, now(), clean(e.message)); }
      }));
      const at = now(), value = { updatedAt: new Date(at).toISOString(), instances };
      if (expected === revision) { cachedAt = at; cached = value; }
      return value;
    })().finally(() => { if (inflight === flight) inflight = null; });
    inflightRevision = expected; inflight = flight; return flight;
  };
  const command = async (id, input) => {
    if (!selected.some(s => s.id === id)) throw failure('Unknown companion.', 404);
    const body = validateCommand(input), entries = await configurations(), entry = entries.find(x => x.source.id === id);
    const clean = cleaner(entries.flatMap(x => x.secrets));
    let raw;
    try { raw = await request(entry, '/api/control/command', body); }
    catch (e) { throw failure(clean(e.message), e.status || 503); }
    const job = cleanCommand(raw.command, clean); if (!job) throw failure('The companion did not confirm the requested command.', 503);
    revision++; cached = null; return { ok: true, command: job };
  };
  const clipRequest = async (id, path, body) => {
    if (!selected.some(s => s.id === id)) throw failure('Unknown companion.', 404);
    const entries = await configurations(), clean = cleaner(entries.flatMap(x => x.secrets));
    try { return { raw: await request(entries.find(x => x.source.id === id), path, body), clean }; }
    catch (e) { throw failure(clean(e.message), e.status || 503); }
  };
  const clipStatus = async id => {
    const { raw, clean } = await clipRequest(id, '/api/clips/status', {});
    if (typeof raw.authorized !== 'boolean' || !login(raw.account) || !Array.isArray(raw.jobs)) throw failure('The companion returned invalid clip status.', 503);
    return { ok: true, account: raw.account, authorized: raw.authorized,
      jobs: raw.jobs.slice(-100).map(x => cleanClipJob(x, clean)).filter(Boolean) };
  };
  const clipCreate = async (id, body) => {
    if (!keys(body, ['requestId', 'channel', 'streamId', 'source']) || !opaque(body.requestId) || !login(body.channel)
      || !/^\d{1,32}$/.test(body.streamId || '') || !['manual', 'automatic'].includes(body.source)) throw failure('Invalid clip request.');
    const { raw, clean } = await clipRequest(id, '/api/clips/create', body), job = cleanClipJob(raw.job, clean);
    if (!job || job.requestId !== body.requestId || job.channel !== body.channel || job.streamId !== body.streamId || job.source !== body.source) throw failure('The companion did not confirm the clip request.', 503);
    return { ok: true, job };
  };
  const clipAuthorization = async (id, body) => {
    if (!keys(body, ['action']) || !['start', 'poll'].includes(body.action)) throw failure('Invalid clip authorization request.');
    const { raw, clean } = await clipRequest(id, '/api/clips/authorization', body);
    if (raw.pending !== true && raw.authorized !== true && (typeof raw.userCode !== 'string' || typeof raw.verificationUrl !== 'string')) throw failure('Twitch did not confirm clip authorization.', 503);
    const value = { ok: true, pending: raw.pending === true, authorized: raw.authorized === true, account: login(raw.account) };
    if (raw.verificationUrl !== undefined) {
      if (raw.verificationUrl !== 'https://www.twitch.tv/activate' || typeof raw.userCode !== 'string'
        || !/^[A-Za-z0-9-]{4,32}$/.test(raw.userCode)) throw failure('Twitch returned invalid authorization details.', 503);
      value.verificationUrl = raw.verificationUrl; value.userCode = clean(raw.userCode, 32);
    }
    if (Number.isFinite(raw.pollAfterMs)) value.pollAfterMs = Math.max(5000, Math.min(60000, raw.pollAfterMs));
    if (Number.isFinite(raw.expiresAt)) value.expiresAt = raw.expiresAt;
    revision++; cached = null; return value;
  };
  return { snapshot, command, clipStatus, clipCreate, clipAuthorization };
}
