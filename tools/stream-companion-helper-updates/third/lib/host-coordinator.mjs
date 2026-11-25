import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { messageKey } from '../extension/message-policy.js';
import { exchangeOffer } from '../extension/exchange.js';

const HOST = 'http://127.0.0.1:8795';
const LOGIN = /^[a-z0-9_]{3,25}$/;
const MAX_AGE = 45_000, RETENTION = 14 * 86400_000;
const terminal = new Set(['confirmed', 'rejected', 'unknown', 'cancelled']);
const outcomeRank = { unknown: 0, cancelled: 1, rejected: 2, confirmed: 3 };
const transientHolds = new Set(['busy', 'turn_wait', 'channel_cooldown', 'channel_budget', 'not_ready', 'paused', 'unavailable', 'channel_limit', 'expired', 'exchange_wait', 'exchange_quiet', 'exchange_spacing', 'exchange_priority']);
const unavailable = 'Central host is unavailable; waiting before submitting a message.';
const clean = (value, limit = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, limit) : '';

export class HostCoordinator {
  constructor({ config, outboxFile, fetchImpl = fetch, now = Date.now, getConnection = null, testURL, autoStart = true } = {}) {
    if (!config || config.url !== HOST || !/^[a-z0-9_-]{1,40}$/.test(config.clientId || '')
      || !LOGIN.test(config.account || '') || typeof config.token !== 'string' || !/^\S{32,1024}$/.test(config.token)) {
      throw new Error('Central host pairing is missing or invalid. Run the central host setup.');
    }
    if (!outboxFile) throw new Error('Central host completion storage is required.');
    this.config = { ...config }; this.outboxFile = outboxFile; this.fetch = fetchImpl; this.now = now;
    this.baseURL = testURL || HOST; this.getConnection = getConnection;
    this.presence = { channel: '', connected: false }; this.observation = null;
    this.cached = null; this.cachedChannel = ''; this.checkedAt = 0; this.reason = unavailable;
    this.history = []; this.pending = []; this.acknowledged = new Map();
    this.serial = Promise.resolve(); this.refreshFlight = null; this.flushFlight = null; this.closed = false;
    this.loaded = this.load().catch(() => { this.storageFailed = true; });
    if (autoStart) {
      this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, 5000);
      this.timer.unref?.();
    }
  }
  register(account) {
    if (account !== this.config.account) throw new Error('Central host pairing does not match this account.');
  }
  async load() {
    let parsed;
    try { parsed = JSON.parse(await readFile(this.outboxFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!parsed || !Array.isArray(parsed.pending) || !Array.isArray(parsed.acknowledged)) throw Error('Invalid completion journal.');
    for (const item of parsed.pending) if (!this.validCompletion(item)) throw Error('Invalid completion journal.');
    this.pending = parsed.pending;
    for (const item of parsed.acknowledged.slice(-1024)) {
      if (!this.validCompletion(item)) throw Error('Invalid completion journal.');
      this.acknowledged.set(item.reservationId, item.delivery);
    }
  }
  validCompletion(item) {
    return item && typeof item.reservationId === 'string' && /^[a-zA-Z0-9:_-]{1,200}$/.test(item.reservationId)
      && terminal.has(item.delivery) && typeof item.submitted === 'boolean'
      && (item.delivery !== 'cancelled' || item.submitted === false);
  }
  mutate(fn) {
    const work = this.serial.then(fn, fn); this.serial = work.catch(() => {}); return work;
  }
  async persist() {
    const path = this.outboxFile instanceof URL ? this.outboxFile : String(this.outboxFile);
    const directory = path instanceof URL ? new URL('.', path) : dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path instanceof URL ? new URL(`${path.href}.${randomUUID()}.tmp`) : `${path}.${randomUUID()}.tmp`;
    const data = { pending: this.pending, acknowledged: [...this.acknowledged].slice(-1024).map(([reservationId, delivery]) => ({ reservationId, delivery, submitted: delivery !== 'cancelled' })) };
    await writeFile(temporary, JSON.stringify(data) + '\n', { mode: 0o600 });
    await chmod(temporary, 0o600); await rename(temporary, path); await chmod(path, 0o600);
  }
  seed(history = []) {
    this.history = history.filter(item => item && item.account === this.config.account
      && LOGIN.test(item.channel || '') && Number.isFinite(item.at) && item.at <= this.now()
      && item.at >= this.now() - RETENTION && (terminal.has(item.delivery) || item.delivery === 'pending')).slice(-256);
  }
  observationValue(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw.playback && typeof raw.playback === 'object' ? raw.playback : {};
    const status = ['playing', 'ad', 'paused', 'stalled', 'buffering', 'offline', 'error', 'checking', 'unavailable', 'commercial'].includes(p.status) ? p.status : 'unknown';
    const context = raw.exchangeContext;
    const exchangeContext = raw.chatMode === 'participate' && raw.autoReply === true && raw.paused !== true
      && context && typeof context.streamId === 'string' && /^\d{1,128}$/.test(context.streamId)
      && Number.isFinite(context.checkedAt) && context.checkedAt >= 0 && Number.isFinite(context.lastHumanAt)
      && context.lastHumanAt >= 0 && context.lastHumanAt <= this.now() && context.checkedAt <= this.now() + 5000
      && this.now() - context.checkedAt <= 120_000
      ? { streamId: context.streamId, checkedAt: context.checkedAt, lastHumanAt: context.lastHumanAt } : null;
    return { channel: LOGIN.test(raw.channel || '') ? raw.channel : '', paused: raw.paused === true,
      exchangeContext,
      autoReply: raw.autoReply === true, playback: { status, checkedAt: Number.isFinite(p.checkedAt) ? p.checkedAt : 0,
        channel: LOGIN.test(p.channel || '') ? p.channel : '', enabled: p.enabled === true } };
  }
  snapshot(channel) {
    channel = LOGIN.test(channel || '') ? channel : '';
    const age = this.now() - this.checkedAt;
    const fresh = this.cached && this.cachedChannel === channel && age >= 0 && age <= MAX_AGE && !this.storageFailed;
    const exchange = fresh && !this.cached.paused && exchangeOffer(this.cached.exchange, { account: this.config.account, channel,
      accounts: this.cached.accounts, now: this.now() });
    return fresh ? { ...this.cached, exchange: exchange || undefined, available: true }
      : { available: false, paused: false, reason: this.storageFailed ? 'Central host completion storage needs attention; sending is on hold.' : this.reason,
        textKeys: [], topicStreams: [], replyIds: [], accounts: this.cached?.accounts || [this.config.account] };
  }
  cache(snapshot, channel) {
    if (!snapshot || !Array.isArray(snapshot.textKeys) || !Array.isArray(snapshot.topicStreams)
      || !Array.isArray(snapshot.replyIds) || !Array.isArray(snapshot.accounts)) throw Error('Invalid host snapshot');
    this.cached = { available: true, paused: snapshot.paused === true,
      reason: this.safeReason(snapshot.reason), textKeys: snapshot.textKeys.filter(x => typeof x === 'string').slice(-2000),
      topicStreams: snapshot.topicStreams.filter(x => typeof x === 'string').slice(-2000),
      replyIds: snapshot.replyIds.filter(x => typeof x === 'string').slice(-2000),
      accounts: snapshot.accounts.filter(x => typeof x === 'string' && LOGIN.test(x)).slice(0, 100) };
    const exchange = exchangeOffer(snapshot.exchange, { account: this.config.account, channel,
      accounts: this.cached.accounts, now: this.now(), due: false });
    if (exchange) this.cached.exchange = exchange;
    this.cachedChannel = channel; this.checkedAt = this.now(); this.reason = unavailable;
  }
  safeReason(value) {
    const reason = clean(value);
    return reason.includes(this.config.token) ? 'Central host needs attention.' : reason;
  }
  hold(code, reason) {
    const knownCode = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'hold';
    return { ok: false, code: knownCode, retryable: transientHolds.has(knownCode), reason: this.safeReason(reason) || 'Central host is holding this turn.' };
  }
  async request(path, body) {
    const response = await this.fetch(`${this.baseURL}${path}`, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(1500), headers: { Authorization: `Bearer ${this.config.token}`,
        'X-Companion-Id': this.config.clientId, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw Error('Central host request was not accepted.');
    const text = await response.text(); if (Buffer.byteLength(text) > 256_000) throw Error('Invalid central host response.');
    const result = JSON.parse(text); if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('Invalid central host response.');
    return result;
  }
  async queueCompletion(reservationId, delivery) {
    const item = { reservationId, delivery, submitted: delivery !== 'cancelled' };
    if (!this.validCompletion(item)) throw Error('Invalid central host completion.');
    await this.loaded; if (this.storageFailed) throw Error('Central host completion storage needs attention.');
    await this.mutate(async () => {
      const existing = this.pending.find(x => x.reservationId === reservationId);
      const known = existing?.delivery || this.acknowledged.get(reservationId);
      if (known && outcomeRank[known] >= outcomeRank[delivery]) return;
      const previous = this.pending;
      this.pending = this.pending.filter(x => x.reservationId !== reservationId);
      this.pending.push(item);
      try { await this.persist(); }
      catch { this.pending = previous; this.storageFailed = true; throw Error('Central host completion storage needs attention.'); }
    });
  }
  async reconcileHistory() {
    for (const item of this.history) {
      if (item.coordinationId && terminal.has(item.delivery)) await this.queueCompletion(item.coordinationId, item.delivery);
    }
  }
  async flush() {
    await this.loaded;
    if (this.storageFailed) return;
    if (this.flushFlight) return this.flushFlight;
    this.flushFlight = (async () => {
      const items = await this.mutate(() => this.pending.slice());
      for (const item of items) {
        try {
          const result = await this.request('/internal/finish', item); if (result.ok !== true) break;
          await this.mutate(async () => {
            this.pending = this.pending.filter(x => x.reservationId !== item.reservationId || x.delivery !== item.delivery);
            const known = this.acknowledged.get(item.reservationId);
            if (!known || outcomeRank[known] < outcomeRank[item.delivery]) this.acknowledged.set(item.reservationId, item.delivery);
            if (this.acknowledged.size > 1024) this.acknowledged.delete(this.acknowledged.keys().next().value);
            try { await this.persist(); } catch { this.storageFailed = true; throw Error('Central host completion storage needs attention.'); }
          });
        } catch { break; }
      }
    })().finally(() => { this.flushFlight = null; });
    return this.flushFlight;
  }
  async refresh(input = {}) {
    if (this.closed) return this.snapshot(this.presence.channel);
    if ('channel' in input) this.presence.channel = LOGIN.test(input.channel || '') ? input.channel : '';
    if ('connected' in input) this.presence.connected = input.connected === true;
    if (input.observation !== undefined) this.observation = this.observationValue(input.observation);
    if (this.refreshFlight) return this.refreshFlight;
    this.refreshFlight = (async () => {
      await this.loaded;
      if (this.storageFailed) return this.snapshot(this.presence.channel);
      try {
        await this.reconcileHistory(); await this.flush();
        const connection = this.getConnection?.() || this.presence;
        const channel = LOGIN.test(connection.channel || '') ? connection.channel : '';
        const connected = connection.connected === true && !!channel;
        const observation = this.observation, playback = observation?.playback;
        const ready = connected && observation?.channel === channel && !observation.paused && observation.autoReply
          && playback.enabled && playback.channel === channel && ['playing', 'ad'].includes(playback.status)
          && playback.checkedAt <= this.now() + 5000 && this.now() - playback.checkedAt <= MAX_AGE;
        const seed = this.history.filter(x => x.delivery !== 'cancelled').map(item => ({ channel: item.channel,
          streamId: clean(item.streamId, 128), kind: clean(item.kind, 30), textKey: messageKey(item.text), replyId: clean(item.replyId, 150),
          at: item.at, delivery: item.delivery, ...(item.coordinationId ? { coordinationId: item.coordinationId } : {}) }));
        const result = await this.request('/internal/sync', { channel, connected, ready: !!ready,
          exchangeContext: ready ? observation.exchangeContext : null,
          playback: { status: playback?.status || 'unknown', checkedAt: playback?.checkedAt || 0 }, seed, pendingCompletions: this.pending.length });
        if (result.ok !== true) throw Error('Central host synchronization is on hold.');
        this.cache(result.snapshot, channel); this.presence = { channel, connected };
      } catch { this.cached = null; this.reason = unavailable; }
      return this.snapshot(this.presence.channel);
    })().finally(() => { this.refreshFlight = null; });
    return this.refreshFlight;
  }
  async reserve({ account, channel, text, streamId = '', kind = '', replyTo = '', replyAt, exchangeId }) {
    if (account !== this.config.account) return this.hold('binding', 'Central host account binding does not match.');
    await this.refresh({ channel, connected: true });
    if (this.snapshot(channel).available !== true) return this.hold('unavailable', this.snapshot(channel).reason);
    // An unacknowledged cancellation can still own a host tombstone. Keep the
    // fresh target retryable until that proven no-send completion is replayed.
    if (this.pending.some(item => item.delivery === 'cancelled')) return this.hold('unavailable', 'Waiting for the central host to release an unused turn.');
    try {
      const result = await this.request('/internal/reserve', { requestId: randomUUID(), channel, streamId,
        kind, textKey: messageKey(text), replyId: replyTo, ...(replyTo && Number.isFinite(replyAt) ? { replyAt } : {}),
        ...(exchangeId !== undefined ? { exchangeId } : {}) });
      if (result.snapshot) this.cache(result.snapshot, channel);
      return result.ok === true && typeof result.reservationId === 'string'
        ? { ok: true, reservationId: result.reservationId, expiresAt: result.expiresAt }
        : this.hold(result.code, result.reason);
    } catch { this.cached = null; return this.hold('unavailable', unavailable); }
  }
  async begin(reservationId) {
    try {
      const result = await this.request('/internal/begin', { reservationId });
      if (result.ok === true) return { ok: true };
      return this.hold(result.code, result.reason);
    } catch { this.cached = null; return this.hold('unavailable', unavailable); }
  }
  async finish(reservationId, delivery) {
    await this.queueCompletion(reservationId, delivery); await this.flush();
    return { queued: this.pending.some(x => x.reservationId === reservationId) };
  }
  close() { this.closed = true; clearInterval(this.timer); }
}
