import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateReply, digest } from '../extension/core.js';

const TTL = 90000, FRESH = 45000, LIMIT = 100;
const login = x => typeof x === 'string' && /^[a-z0-9_]{3,25}$/.test(x);
const opaque = x => typeof x === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/.test(x);
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const stamp = x => Number.isFinite(x) && x >= 0 ? x : 0;
const iso = x => x > 0 ? new Date(x).toISOString() : null;
const exact = (o, keys) => object(o) && Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));
const terminal = new Set(['completed', 'failed', 'cancelled', 'expired']);

export function commandInput(input) {
  if (!exact(input, ['requestId', 'action', 'params']) || !opaque(input.requestId) || !object(input.params)) throw error('Invalid control command.');
  const { action, params: p } = input;
  const mode = x => ['mentions', 'participate'].includes(x);
  const source = x => ['local', 'ai'].includes(x);
  switch (action) {
    case 'start':
      if (!exact(p, ['channel', 'chatMode', 'replySource', 'autoResume']) || !login(p.channel) || !mode(p.chatMode) || !source(p.replySource) || typeof p.autoResume !== 'boolean') throw error('Invalid Start settings.');
      break;
    case 'settings':
      if (!exact(p, ['chatMode', 'replySource', 'autoResume']) || !mode(p.chatMode) || !source(p.replySource) || typeof p.autoResume !== 'boolean') throw error('Invalid safe settings.');
      break;
    case 'draft': if (!exact(p, ['mode']) || !['reply', 'summary'].includes(p.mode)) throw error('Invalid draft mode.'); break;
    case 'send':
      if (!exact(p, ['text']) || typeof p.text !== 'string' || validateReply(p.text) !== p.text) throw error('Invalid reviewed message.');
      break;
    case 'stop': case 'watch': case 'drops-enable': case 'drops-disable': case 'drops-check':
      if (!exact(p, [])) throw error('This control takes no settings.'); break;
    default: throw error('Unknown control action.');
  }
  const keys = action === 'start' ? ['channel', 'chatMode', 'replySource', 'autoResume'] : action === 'settings' ? ['chatMode', 'replySource', 'autoResume'] : action === 'send' ? ['text'] : action === 'draft' ? ['mode'] : [];
  return { requestId: input.requestId, action, params: Object.fromEntries(keys.map(k => [k, p[k]])) };
}

// Only explicit public data is copied into the local pages. Provider objects,
// browser settings and diagnostics are never spread into a response.
export class LocalControl {
  constructor({ twitch, now = Date.now, secrets = [], onIntent = () => {}, intentFile } = {}) {
    this.twitch = twitch; this.now = now; this.secrets = secrets.filter(x => typeof x === 'string' && x.length >= 4);
    this.onIntent = onIntent; this.generation = randomUUID(); this.stopped = false;
    this.sessionId = ''; this.retiredSessions = new Set(); this.lastSeen = 0; this.browserState = {}; this.commands = [];
    this.intentFile = intentFile instanceof URL ? fileURLToPath(intentFile) : intentFile;
    this.journalHeld = false; this.storageError = false; this.pendingNative = null;
    if (this.intentFile) {
      try {
        let saved;
        try { saved = JSON.parse(readFileSync(this.intentFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (saved !== undefined && (!exact(saved, ['version', 'held']) || saved.version !== 1 || typeof saved.held !== 'boolean')) throw error('Invalid local safety journal.');
        this.journalHeld = saved?.held === true; this.stopped = this.journalHeld;
        this.persist(this.journalHeld);
      } catch { this.storageError = true; this.stopped = true; this.journalHeld = true; this.twitch?.disconnect?.(); }
    }
  }
  persist(held) {
    this.journalHeld = held;
    if (!this.intentFile) { this.storageError = false; return true; }
    try {
      const temporary = `${this.intentFile}.tmp`;
      writeFileSync(temporary, JSON.stringify({ version: 1, held }) + '\n', { mode: 0o600 });
      chmodSync(temporary, 0o600); renameSync(temporary, this.intentFile); chmodSync(this.intentFile, 0o600);
      this.storageError = false; return true;
    } catch { this.storageError = true; this.stopped = true; this.twitch?.disconnect?.(); return false; }
  }
  text(value, max = 300) {
    let text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ') : '';
    for (const secret of this.secrets) text = text.split(secret).join('[redacted]');
    return text.replace(/\b(?:Bearer\s+|oauth:)[a-zA-Z0-9._~+\/-]+/gi, '[redacted]')
      .replace(/\bsk-(?:proj-)?[a-zA-Z0-9_-]{8,}/g, '[redacted]')
      .replace(/\b(?:access[_ -]?token|refresh[_ -]?token|pairing[_ -]?token|api[_ -]?key|client[_ -]?secret)\s*["':=]+\s*[^\s,;}]+/gi, '[redacted]')
      .slice(0, max);
  }
  diagnostic(value) { return this.text(value).replace(/\/(?:Users|home|private|tmp)\/[^\s]+/g, '[private path]'); }
  intent() { return { generation: this.generation, stopped: this.stopped }; }
  online() { return !!this.sessionId && this.lastSeen > 0 && this.lastSeen >= this.now() - FRESH && this.lastSeen <= this.now(); }
  publicCommand(c) {
    return { id: c.id, requestId: c.requestId, action: c.action, params: { ...c.params }, generation: c.generation,
      state: c.state, createdAt: iso(c.created), expiresAt: iso(c.expires), ...(c.result ? { result: { ...c.result } } : {}), ...(c.error ? { error: c.error } : {}) };
  }
  expire() {
    for (const c of this.commands) if (!terminal.has(c.state) && c.expires <= this.now()) {
      c.state = 'expired'; c.error = c.action === 'send' && c.claimedBy ? 'The message outcome is uncertain. Check delivery history; it will not be replayed.' : 'The browser did not finish this command before it expired.';
      if (c.action === 'start' && c.generation === this.generation) this.rotate(true, 'expired-start');
    }
    this.commands = this.commands.slice(-LIMIT);
  }
  rotate(stopped, action) {
    this.generation = randomUUID(); this.stopped = stopped; this.pendingNative = null;
    this.browserState = { ...this.browserState, settings: { ...(this.browserState.settings || {}), paused: true, autoReply: false } };
    this.twitch?.disconnect?.();
    // A Start is provisional until the browser has actually completed it. A
    // crash during connection must boot into a hold rather than auto-resume.
    this.persist(true); this.onIntent(this.intent(), action);
    return this.intent();
  }
  command(raw) {
    const input = commandInput(raw); this.expire();
    if (input.action === 'send' && this.text(input.params.text, 300) !== input.params.text) throw error('Private credential-like text cannot be sent from the control page.');
    const old = this.commands.find(x => x.requestId === input.requestId);
    if (old) {
      if (JSON.stringify([old.action, old.params]) !== JSON.stringify([input.action, input.params])) throw error('A request identifier cannot change its command.', 409);
      return { ok: true, command: this.publicCommand(old) };
    }
    if (input.action !== 'stop' && !this.online()) throw error('The browser profile is closed or has not checked in recently. Open it before using this control.', 503);
    const pending = this.commands.filter(c => !terminal.has(c.state));
    if (input.action !== 'stop' && pending.some(c => c.action !== 'stop')) throw error('Another browser command is still pending.', 409);
    if (this.stopped && ['draft', 'send', 'drops-enable', 'drops-check'].includes(input.action)) throw error('Start the companion before using this control.', 409);
    if (['start', 'stop'].includes(input.action)) {
      for (const c of pending) { c.state = 'cancelled'; c.error = input.action === 'stop' ? 'Cancelled by Stop.' : 'Replaced by a newer explicit Start.'; }
      this.rotate(input.action === 'stop', input.action);
      if (input.action === 'start' && this.storageError) throw error('Local control safety state could not be saved. Start is held.', 503);
    }
    const c = { ...input, id: randomUUID(), generation: this.generation, state: 'queued', created: this.now(), expires: this.now() + TTL };
    this.commands.push(c); this.commands = this.commands.slice(-LIMIT);
    return { ok: true, command: this.publicCommand(c) };
  }
  guard(input = {}, { allowStopped = false, requireSession = false, action } = {}) {
    this.expire();
    if (!this.sessionId && !this.stopped && !requireSession && input.controlGeneration === undefined && input.controlSessionId === undefined) return;
    if (this.storageError) throw error('Local control safety state could not be saved; sending is held.', 503);
    if (input.controlGeneration !== this.generation || input.controlSessionId !== this.sessionId || !this.online()) throw error('This browser operation was cancelled or belongs to an older session.', 409);
    if (input.controlCommandId !== undefined) {
      const command = this.commands.find(c => c.id === input.controlCommandId);
      if (!command || command.state !== 'running' || command.expires <= this.now() || command.generation !== this.generation
        || command.claimedBy !== this.sessionId || action && command.action !== action
        || action === 'send' && command.params.text !== input.text) throw error('This browser command expired or was cancelled before submission.', 409);
    }
    if (this.stopped && !allowStopped) throw error('The companion is stopped. Use a newer explicit Start.', 409);
  }
  nativeStart(input) {
    if (!login(input.account) || !login(input.channel)) throw error('A valid account and channel are required.');
    const account = this.twitch?.status?.().account;
    if (account && input.account !== account) throw error('The account does not match this companion.', 403);
    if (this.storageError) this.persist(true);
    this.guard(input, { allowStopped: true, requireSession: true });
    for (const c of this.commands) if (!terminal.has(c.state)) { c.state = 'cancelled'; c.error = 'Replaced by an explicit native Connect.'; }
    const intent = this.rotate(false, 'native-start');
    if (this.storageError) throw error('Local control safety state could not be saved. Connect is held.', 503);
    this.pendingNative = { generation: intent.generation, account: input.account, channel: input.channel };
    return intent;
  }
  nativeConnected(generation) {
    const pending = this.pendingNative;
    if (!pending || pending.generation !== generation || generation !== this.generation || this.stopped) return;
    const raw = this.twitch?.status?.() || {};
    if (raw.connected === true && raw.account === pending.account && raw.channel === pending.channel) {
      this.persist(false); if (!this.storageError) this.pendingNative = null;
    }
  }
  nativeFailed(generation) { if (generation === this.generation && this.pendingNative) this.rotate(true, 'failed-native-start'); }
  disconnect(input = {}) {
    if (input.disarmOnly === true) { this.guard(input, { allowStopped: true, requireSession: true }); return { ok: true, intent: this.intent(), disarmOnly: true }; }
    for (const c of this.commands) if (!terminal.has(c.state)) { c.state = 'cancelled'; c.error = 'Cancelled by Stop.'; }
    this.rotate(true, 'stop'); return { ok: true, intent: this.intent() };
  }
  completion(raw, sessionId) {
    if (!object(raw) || !opaque(raw.id) || typeof raw.generation !== 'string' || !['completed', 'failed', 'cancelled'].includes(raw.state)) throw error('Invalid browser completion.');
    const c = this.commands.find(c => c.id === raw.id);
    if (!c || c.generation !== raw.generation || c.claimedBy !== sessionId || c.generation !== this.generation || terminal.has(c.state)) return;
    c.state = raw.state;
    if (c.action === 'start' && raw.state === 'completed') {
      const connection = this.twitch?.status?.() || {}, settings = this.browserState.settings || {};
      if (connection.connected !== true || connection.channel !== c.params.channel || !login(connection.account)
        || settings.allowedChannel !== c.params.channel || settings.paused !== false || settings.autoReply !== true
        || settings.chatMode !== c.params.chatMode || settings.replySource !== c.params.replySource || settings.autoResume !== c.params.autoResume) {
        c.state = 'failed'; c.error = 'Start did not confirm its intended connection and armed browser settings.';
        this.rotate(true, 'unconfirmed-start'); return;
      }
      if (!this.persist(false)) { c.state = 'failed'; c.error = 'Local control safety state could not be saved. Start is held.'; return; }
    }
    if (object(raw.result)) c.result = { ...(typeof raw.result.ok === 'boolean' ? { ok: raw.result.ok } : {}),
      ...(typeof raw.result.text === 'string' ? { text: this.text(raw.result.text, 4000) } : {}), ...(typeof raw.result.reason === 'string' ? { reason: this.diagnostic(raw.result.reason) } : {}) };
    if (raw.state !== 'completed') c.error = this.diagnostic(raw.error || 'The browser could not complete this command.');
    if (c.action === 'start' && raw.state !== 'completed') this.rotate(true, 'failed-start');
  }
  bridge(input = {}) {
    if (!object(input) || !opaque(input.sessionId)) throw error('A browser bridge session is required.');
    this.expire();
    if (this.retiredSessions.has(input.sessionId)) return { ok: true, intent: this.intent() };
    const changed = this.sessionId && this.sessionId !== input.sessionId;
    if (changed) { this.retiredSessions.add(this.sessionId); if (this.retiredSessions.size > LIMIT) this.retiredSessions.delete(this.retiredSessions.values().next().value); }
    if (changed) for (const c of this.commands) if (c.state === 'running') {
      c.state = 'cancelled'; c.error = c.action === 'send' ? 'The browser session changed. Delivery may be uncertain; this message will not be replayed.' : 'The browser session changed before completion; this command will not be replayed.';
      if (c.action === 'start' && c.generation === this.generation) this.rotate(true, 'lost-start');
    }
    this.sessionId = input.sessionId; this.lastSeen = this.now();
    if (input.state !== undefined && object(input.state) && input.controlGeneration === this.generation) this.browserState = this.cleanState(input.state);
    if (input.completion !== undefined) this.completion(input.completion, input.sessionId);
    this.nativeConnected(this.generation);
    const c = this.commands.some(c => c.state === 'running') ? undefined : this.commands.find(c => c.state === 'queued' && c.generation === this.generation);
    if (c) { c.state = 'running'; c.claimedBy = input.sessionId; }
    return { ok: true, intent: this.intent(), ...(c ? { command: this.publicCommand(c) } : {}) };
  }
  settings(raw = {}) {
    return { allowedChannel: login(raw.allowedChannel) ? raw.allowedChannel : '', paused: this.stopped || raw.paused === true,
      autoReply: !this.stopped && raw.autoReply === true, autoResume: raw.autoResume === true,
      chatMode: raw.chatMode === 'participate' ? 'participate' : 'mentions', replySource: raw.replySource === 'ai' ? 'ai' : 'local' };
  }
  messages(raw) {
    return (Array.isArray(raw) ? raw : []).slice(-60).filter(object).map(x => ({ id: this.text(x.id, 160),
      author: login(x.author) ? x.author : '', channel: login(x.channel) ? x.channel : '', text: this.text(x.text, 500), at: stamp(x.at) }));
  }
  sent(raw) {
    return (Array.isArray(raw) ? raw : []).slice(-50).filter(object).map(x => ({ at: stamp(x.at), account: login(x.account) ? x.account : '', channel: login(x.channel) ? x.channel : '',
      text: this.text(x.text, 300), delivery: ['pending', 'confirmed', 'rejected', 'unknown', 'cancelled'].includes(x.delivery) ? x.delivery : 'unknown',
      ...(typeof x.submitted === 'boolean' ? { submitted: x.submitted } : {}), reason: this.diagnostic(x.reason), category: this.text(x.category, 40), kind: this.text(x.kind, 30), replyTo: login(x.replyTo) ? x.replyTo : '', messageId: this.text(x.messageId, 160) }));
  }
  coordination(raw = {}) {
    return { available: raw.available === true, paused: raw.paused === true, reason: this.diagnostic(raw.reason),
      accounts: (Array.isArray(raw.accounts) ? raw.accounts : []).filter(login).slice(0, 20) };
  }
  cleanState(raw = {}) {
    const w = object(raw.watch) ? raw.watch : {}, a = object(raw.activity) ? raw.activity : {}, d = object(raw.drops) ? raw.drops : {}, context = object(raw.streamContext) ? raw.streamContext : {};
    return { settings: this.settings(raw.settings), watch: { enabled: w.enabled === true, status: this.text(w.status, 32), channel: login(w.channel) ? w.channel : '', checkedAt: stamp(w.checkedAt), error: this.diagnostic(w.error) },
      activity: { state: this.text(a.state, 32), reason: this.diagnostic(a.reason), at: stamp(a.at) },
      streamContext: { isLive: context.isLive === true, channel: login(context.channel) ? context.channel : '', streamId: this.text(context.streamId, 128), gameName: this.text(context.gameName, 150), title: this.text(context.title, 300), checkedAt: stamp(context.checkedAt) },
      chat: { digest: this.text(raw.chat?.digest, 1500) },
      drops: { enabled: d.enabled === true, status: this.text(d.status, 300), error: this.diagnostic(d.error), lastCheck: stamp(d.lastCheck),
        history: (Array.isArray(d.history) ? d.history : []).slice(-20).filter(object).map(x => ({ at: stamp(x.at), text: this.text(x.text, 300), reason: this.diagnostic(x.reason), state: this.text(x.state, 40), name: this.text(x.name, 120), delivery: ['pending','confirmed','unknown','cancelled'].includes(x.delivery) ? x.delivery : 'unknown', channel: login(x.channel) ? x.channel : '' })) },
      permissions: { playbackAccess: raw.permissions?.playbackAccess === true } };
  }
  status() {
    this.expire();
    const raw = this.twitch?.status?.() || {}, state = this.browserState;
    return { ok: true, updatedAt: new Date(this.now()).toISOString(), account: login(raw.account) ? raw.account : '', authorized: raw.authorized === true,
      connected: !this.stopped && raw.connected === true, channel: login(raw.channel) ? raw.channel : '', error: this.storageError ? 'Local control safety state could not be saved; sending is held.' : this.diagnostic(raw.error),
      settings: this.settings(state.settings), browser: { online: this.online(), lastSeenAt: iso(this.lastSeen) },
      watch: state.watch || this.cleanState().watch, activity: state.activity || this.cleanState().activity, streamContext: state.streamContext || this.cleanState().streamContext,
      chat: { messages: this.messages(raw.messages), digest: digest(this.messages(raw.messages)) }, sent: this.sent(raw.sent), drops: state.drops || this.cleanState().drops,
      coordination: this.coordination(raw.coordination), permissions: state.permissions || { playbackAccess: false },
      controls: { pending: this.commands.filter(c => !terminal.has(c.state)).map(c => this.publicCommand(c)), recent: this.commands.slice(-20).reverse().map(c => this.publicCommand(c)) } };
  }
}
