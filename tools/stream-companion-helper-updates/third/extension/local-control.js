import { validateReply } from './core.js';

const ID = /^[a-zA-Z0-9:_-]{1,160}$/;
const LOGIN = /^[a-z0-9_]{3,25}$/;
const actions = new Set(['start', 'stop', 'watch', 'settings', 'draft', 'send', 'drops-enable', 'drops-disable', 'drops-check']);
const stoppedActions = new Set(['stop', 'watch', 'settings', 'drops-disable']);
const only = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const stamp = value => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const clean = (value, limit = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';
const bool = value => value === true;
const numeric = value => Number.isFinite(value) ? value : 0;
const validText = value => { try { return validateReply(value) === value; } catch { return false; } };

export function typedCommand(value, now = Date.now()) {
  if (!value || typeof value.id !== 'string' || typeof value.requestId !== 'string' || typeof value.generation !== 'string'
    || !ID.test(value.id) || !ID.test(value.requestId) || !ID.test(value.generation)
    || !actions.has(value.action) || value.state !== 'running') return null;
  const createdAt = stamp(value.createdAt), expiresAt = stamp(value.expiresAt), p = value.params;
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || createdAt > now + 5000
    || expiresAt <= now || expiresAt <= createdAt || expiresAt - createdAt > 90_000) return null;
  if (value.action === 'start' ? !only(p, ['channel', 'chatMode', 'replySource', 'autoResume'])
    || !LOGIN.test(p.channel || '') || !['mentions', 'participate'].includes(p.chatMode)
    || !['local', 'ai'].includes(p.replySource) || typeof p.autoResume !== 'boolean'
    : value.action === 'settings' ? !only(p, ['chatMode', 'replySource', 'autoResume'])
      || !['mentions', 'participate'].includes(p.chatMode) || !['local', 'ai'].includes(p.replySource) || typeof p.autoResume !== 'boolean'
      : value.action === 'draft' ? !only(p, ['mode']) || !['reply', 'summary'].includes(p.mode)
        : value.action === 'send' ? !only(p, ['text']) || !validText(p.text)
          : !only(p, []) || Object.keys(p).length) return null;
  return { id: value.id, requestId: value.requestId, action: value.action, params: { ...p }, generation: value.generation,
    state: 'running', createdAt: value.createdAt, expiresAt: value.expiresAt };
}

// Do not pass stored settings or Chrome watch/drop objects wholesale across
// this boundary: they contain pairing credentials and browser-internal IDs.
export function controlState(raw = {}) {
  const settings = raw.settings || {}, chat = raw.chat || {}, watch = raw.watch || {}, drops = raw.drops || {};
  const coordination = raw.coordination || chat.coordination || {};
  const context = raw.streamContext || chat.streamContext;
  const result = { account: clean(chat.account || raw.account || settings.account, 30), authorized: bool(chat.authorized ?? raw.authorized),
    connected: bool(chat.connected ?? raw.connected), channel: clean(chat.channel || raw.channel, 30), error: clean(raw.helperError || chat.error || raw.error),
    settings: { allowedChannel: clean(settings.allowedChannel, 30), paused: bool(settings.paused), autoReply: bool(settings.autoReply),
      autoResume: bool(settings.autoResume), chatMode: settings.chatMode === 'participate' ? 'participate' : 'mentions', replySource: settings.replySource === 'ai' ? 'ai' : 'local' },
    watch: { enabled: bool(watch.enabled), status: clean(watch.status, 30), channel: clean(watch.channel, 30), checkedAt: numeric(watch.checkedAt), error: clean(watch.error || watch.detail) },
    activity: { state: clean(raw.activity?.state, 30), reason: clean(raw.activity?.reason), at: numeric(raw.activity?.at) },
    streamContext: context ? { channel: clean(context.channel, 30), streamId: clean(context.streamId, 128), title: clean(context.title, 300),
      gameName: clean(context.gameName, 100), isLive: bool(context.isLive), checkedAt: numeric(context.checkedAt) } : null,
    // The helper already owns authoritative chat and send history. Do not echo
    // those large buffers through the60k paired-request boundary.
    chat: { messages: [],
      digest: { messages: numeric(chat.digest?.messages), people: numeric(chat.digest?.people), topics: (Array.isArray(chat.digest?.topics) ? chat.digest.topics : []).slice(0, 6).map(x => clean(x, 40)) } },
    sent: [],
    drops: { enabled: bool(drops.enabled), status: clean(drops.status), lastCheck: numeric(drops.lastCheck),
      history: (Array.isArray(drops.history) ? drops.history : []).slice(-20).filter(x => x && typeof x === 'object')
        .map(x => ({ id: clean(x.id, 160), name: clean(x.name, 120), at: numeric(x.at), delivery: clean(x.delivery, 20), reason: clean(x.reason) })) },
    coordination: { available: coordination.available === true, paused: bool(coordination.paused), reason: clean(coordination.reason),
      accounts: (Array.isArray(coordination.accounts) ? coordination.accounts : []).filter(x => typeof x === 'string' && LOGIN.test(x)).slice(0, 100) },
    permissions: { playbackAccess: bool(raw.permissions?.playbackAccess) } };
  const secrets = [settings.pairingToken, settings.clientId].filter(value => typeof value === 'string' && value.length >= 4);
  const redact = value => typeof value === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value)
    : Array.isArray(value) ? value.map(redact) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)])) : value;
  const safe = redact(result), bytes = () => new TextEncoder().encode(JSON.stringify(safe)).length;
  // Leave space for a4k completion, generation/session IDs and JSON overhead.
  while (bytes() > 32_000 && safe.drops.history.length) safe.drops.history.shift();
  while (bytes() > 32_000 && safe.coordination.accounts.length) safe.coordination.accounts.shift();
  return safe;
}

export class LocalControlBridge {
  constructor({ transport, state, execute, onIntent = async () => {}, now = Date.now, sessionId = crypto.randomUUID() } = {}) {
    this.transport = transport; this.state = state; this.execute = execute; this.onIntent = onIntent; this.now = now;
    this.sessionId = sessionId; this.intent = null; this.flight = null; this.seen = new Set(); this.completions = [];
  }
  binding() { return this.intent ? { controlSessionId: this.sessionId, controlGeneration: this.intent.generation } : {}; }
  current(command) { return !this.closed && this.intent?.generation === command.generation
    && (!this.intent.stopped || stoppedActions.has(command.action))
    && stamp(command.expiresAt) > this.now(); }
  async adopt(intent) {
    if (!intent || typeof intent.generation !== 'string' || !ID.test(intent.generation) || typeof intent.stopped !== 'boolean') return false;
    const changed = this.intent?.generation !== intent.generation || this.intent?.stopped !== intent.stopped;
    this.intent = { generation: intent.generation, stopped: intent.stopped };
    this.completions = this.completions.filter(x => x.generation === intent.generation);
    if (changed) await this.onIntent(this.intent);
    return true;
  }
  async poll() {
    if (this.closed) return false;
    if (this.flight) return this.flight;
    this.flight = (async () => {
      const binding = this.binding(), completion = this.completions[0];
      const state = await this.state();
      const response = await this.transport({ sessionId: this.sessionId, controlGeneration: binding.controlGeneration,
        state: controlState(state), ...(completion ? { completion } : {}) });
      if (response?.ok !== true || !await this.adopt(response.intent)) return false;
      if (completion) this.completions = this.completions.filter(x => x !== completion);
      const command = typedCommand(response.command, this.now());
      if (command && this.intent?.generation === command.generation && !this.seen.has(command.id)) {
        this.seen.add(command.id); if (this.seen.size > 128) this.seen.delete(this.seen.values().next().value);
        void this.run(command);
      }
      return true;
    })().catch(() => false).finally(() => { this.flight = null; });
    return this.flight;
  }
  async run(command) {
    let completion;
    const check = () => { if (!this.current(command)) throw new Error('Operation cancelled by Stop or a newer session.'); };
    try {
      check(); const result = await this.execute(command, check); check();
      completion = { id: command.id, generation: command.generation, state: 'completed',
        result: { ok: result?.ok !== false, ...Object.fromEntries(['text', 'reason'].filter(k => typeof result?.[k] === 'string').map(k => [k, clean(result[k], k === 'text' ? 4000 : 300)])) } };
    } catch (error) {
      completion = { id: command.id, generation: command.generation, state: this.current(command) ? 'failed' : 'cancelled', error: clean(error?.message || 'The operation failed.') };
    }
    if (completion.generation === this.intent?.generation) {
      this.completions.push(completion); if (this.completions.length > 16) this.completions.shift();
      // If execution finished inside an existing poll, its next heartbeat will
      // carry the result. Never re-execute merely because that response is lost.
      queueMicrotask(() => { void this.poll(); });
    }
  }
  start() { if (!this.timer) { this.timer = setInterval(() => { void this.poll(); }, 5000); this.timer.unref?.(); } }
  close() { this.closed = true; clearInterval(this.timer); this.timer = null; }
}
