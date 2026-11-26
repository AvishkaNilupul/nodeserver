import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const login = x => typeof x === 'string' && /^[a-z0-9_]{3,25}$/.test(x);
const requestId = x => typeof x === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(x);
const clipId = x => typeof x === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(x);
const digits = x => typeof x === 'string' && /^\d{1,32}$/.test(x);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const terminal = new Set(['confirmed', 'failed', 'cancelled', 'unknown']);
const states = new Set(['queued', 'submitting', 'pending', ...terminal]);
const stamp = x => Number.isFinite(x) && x > 0;
const safeError = x => typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300) : 'Clip operation failed.';

export function clipInput(input) {
  if (!exact(input, ['requestId', 'channel', 'streamId', 'source']) || !requestId(input.requestId)
      || !login(input.channel) || !digits(input.streamId) || !['manual', 'automatic'].includes(input.source)) throw fail('Invalid clip request.');
  return { ...input };
}

// A local job is durable before acknowledgement and before the one Twitch POST.
// Recovery performs GET confirmation only, never another Create call.
export class ViewerClips {
  constructor({ twitch, control, file, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    read = readFileSync, write = writeFileSync, rename = renameSync, chmod = chmodSync } = {}) {
    Object.assign(this, { twitch, control, now, setTimer, clearTimer, read, write, rename, chmod });
    this.file = file instanceof URL ? fileURLToPath(file) : file;
    this.jobs = []; this.timers = new Set(); this.closed = false; this.storageError = false;
    try {
      let saved;
      if (this.file) { try { const text = this.read(this.file, 'utf8'); if (Buffer.byteLength(text) > 2000000) throw Error(); saved = JSON.parse(text); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      if (saved !== undefined) {
        if (!exact(saved, ['version', 'jobs']) || saved.version !== 1 || !Array.isArray(saved.jobs) || saved.jobs.length > 2000) throw Error();
        const seen = new Set();
        for (const job of saved.jobs) {
          if (!object(job) || !requestId(job.requestId) || seen.has(job.requestId) || !login(job.account) || !login(job.channel) || !digits(job.streamId)
              || !['manual', 'automatic'].includes(job.source) || !states.has(job.state) || !stamp(job.createdAt) || !stamp(job.updatedAt)
              || job.clipId && !clipId(job.clipId) || job.broadcasterId && !digits(job.broadcasterId) || job.creatorId && !digits(job.creatorId)
              || !Number.isFinite(job.confirmUntil)) throw Error();
          seen.add(job.requestId);
          this.jobs.push({ ...job, error: safeError(job.error || ''), url: job.state === 'confirmed' && clipId(job.clipId) ? `https://clips.twitch.tv/${job.clipId}` : '' });
        }
      }
      for (const job of this.jobs) {
        if (!terminal.has(job.state) && !job.clipId) Object.assign(job, { state: 'unknown', updatedAt: now(), error: 'The previous submission outcome is unconfirmed. It will not be retried.' });
        else if (!terminal.has(job.state) && job.confirmUntil <= now()) Object.assign(job, { state: 'unknown', updatedAt: now(), error: 'Twitch did not confirm the clip within 60 seconds. It will not be recreated.' });
      }
      this.persist();
      for (const job of this.jobs) if (job.state === 'pending' && job.clipId) this.schedule(() => this.confirm(job), 0);
    } catch { this.storageError = true; }
  }
  persist() {
    if (this.storageError) throw fail('Clip history could not be saved; clipping is held.', 503);
    if (!this.file) return;
    try {
      const temporary = `${this.file}.tmp`;
      this.write(temporary, JSON.stringify({ version: 1, jobs: this.jobs }) + '\n', { mode: 0o600 });
      this.chmod(temporary, 0o600); this.rename(temporary, this.file); this.chmod(this.file, 0o600);
    } catch { this.storageError = true; throw fail('Clip history could not be saved; clipping is held.', 503); }
  }
  publicJob(job) {
    return Object.fromEntries(['requestId', 'account', 'channel', 'streamId', 'source', 'createdAt', 'updatedAt', 'state', 'clipId', 'url', 'error'].map(k => [k, job[k]]));
  }
  status() {
    const account = this.twitch.credentials?.account;
    return { ok: true, account: login(account) ? account : '', authorized: !this.storageError && !!this.twitch.credentials?.accessToken && this.twitch.credentials?.scopes?.includes('clips:edit') === true,
      jobs: this.jobs.slice(-50).reverse().map(job => this.publicJob(job)), ...(this.storageError ? { error: 'Clip history could not be saved; clipping is held.' } : {}) };
  }
  gate(input, expectedGeneration) {
    if (this.closed || this.storageError) throw fail('Clipping is unavailable.', 503);
    const s = this.control.status(), time = this.now(), fresh = (value, age) => {
      const at = typeof value === 'string' ? Date.parse(value) : value;
      return Number.isFinite(at) && at <= time + 1000 && at >= time - age;
    };
    if (expectedGeneration !== undefined && this.control.generation !== expectedGeneration) throw fail('Clip cancelled by a session change.', 409);
    if (!s.authorized || !login(s.account) || s.account !== this.twitch.credentials?.account) throw fail('The companion account is not authorized.', 409);
    if (!this.twitch.credentials?.scopes?.includes('clips:edit')) throw fail('Enable clips for this account first.', 409);
    if (!s.browser?.online || !fresh(s.browser.lastSeenAt, 45000) || s.permissions?.playbackAccess !== true) throw fail('Open this account’s stream and wait for live playback.', 409);
    if (s.settings?.allowedChannel !== input.channel || s.watch?.enabled !== true || s.watch.channel !== input.channel || s.watch.status !== 'playing' || !fresh(s.watch.checkedAt, 15000)) throw fail('Live playback is not confirmed on this channel.', 409);
    if (s.streamContext?.channel !== input.channel || s.streamContext?.streamId !== input.streamId || s.streamContext?.isLive !== true || !fresh(s.streamContext.checkedAt, 90000)) throw fail('The selected broadcast is no longer current.', 409);
    const pending = Array.isArray(s.controls?.pending) ? s.controls.pending : [s.controls?.pending];
    if (pending.some(value => value && ['queued', 'running'].includes(value.state))) throw fail('Wait for the current account operation.', 409);
    if (input.source === 'automatic' && (s.connected !== true || s.settings.paused !== false || s.coordination?.available !== true || s.coordination?.paused === true)) throw fail('Automatic clips are held with this session.', 409);
    return s.account;
  }
  create(raw) {
    const input = clipInput(raw);
    const existing = this.jobs.find(job => job.requestId === input.requestId);
    if (existing) {
      if (['channel', 'streamId', 'source'].some(k => existing[k] !== input[k])) throw fail('Clip request ID already belongs to another moment.', 409);
      return { ok: true, job: this.publicJob(existing) };
    }
    const account = this.gate(input), time = this.now();
    if (this.jobs.some(job => job.channel === input.channel && (job.createdAt > time - 600000 || !terminal.has(job.state)))) throw fail('Waiting ten minutes between clips on this channel.', 429);
    if (this.jobs.filter(job => job.channel === input.channel && job.createdAt > time - 3600000).length >= 3) throw fail('The channel clip limit is three per hour.', 429);
    const job = { ...input, account, createdAt: time, updatedAt: time, state: 'queued', clipId: '', url: '', error: '', broadcasterId: '', creatorId: '', confirmUntil: 0 };
    // Retain request IDs for 14 days. Active/uncertain jobs are never pruned here.
    this.jobs = this.jobs.filter(value => !terminal.has(value.state) || value.createdAt >= time - 14 * 86400000);
    if (this.jobs.length >= 2000) throw fail('Clip history is full; clipping is held.', 503);
    this.jobs.push(job); this.persist();
    const generation = this.control.generation;
    this.schedule(() => this.run(job, generation), 0);
    return { ok: true, job: this.publicJob(job) };
  }
  schedule(fn, delay) {
    if (this.closed) return;
    const timer = this.setTimer(() => { this.timers.delete(timer); if (!this.closed) void fn().catch(() => {}); }, delay);
    timer?.unref?.(); this.timers.add(timer);
  }
  update(job, values) { Object.assign(job, values, { updatedAt: this.now() }); this.persist(); }
  async run(job, generation) {
    if (this.closed || this.storageError || job.state !== 'queued') return;
    let attempted = false;
    try {
      this.gate(job, generation);
      const context = await this.twitch.prepareViewerClip(job.account, job.channel, job.streamId);
      this.gate(job, generation);
      if (job.source === 'automatic') {
        await this.twitch.refreshCoordination?.();
        this.gate(job, generation);
        const shared = this.twitch.coordinator?.snapshot?.(job.channel);
        if (!shared || shared.available !== true || shared.paused !== false) throw fail('Central coordination is holding automatic clips.', 409);
        if (typeof this.twitch.coordinator?.request !== 'function') throw fail('The host cannot confirm this clip moment.', 409);
        const permission = await this.twitch.coordinator.request('/internal/clips/permit', { requestId: job.requestId });
        this.gate(job, generation);
        if (permission?.ok !== true) throw fail('Automatic clip settings or session changed. This moment is held.', 409);
      }
      if (!digits(context.broadcasterId) || !digits(context.creatorId)) throw fail('The clip account or broadcaster could not be confirmed.');
      this.update(job, { state: 'submitting', broadcasterId: context.broadcasterId, creatorId: context.creatorId });
      // There is no await between the final live/intent gate and the POST.
      this.gate(job, generation); attempted = true;
      const id = await this.twitch.createViewerClip(context.broadcasterId);
      this.update(job, { state: 'pending', clipId: id, confirmUntil: this.now() + 60000 });
      if (!this.closed) await this.confirm(job);
    } catch (e) {
      if (this.storageError) return;
      this.update(job, { state: attempted ? e.uncertain ? 'unknown' : 'failed' : 'cancelled',
        error: attempted ? e.uncertain ? 'The clip submission outcome is unconfirmed. It will not be retried.' : safeError(e.message) : safeError(e.message) });
    }
  }
  async confirm(job) {
    if (this.closed || this.storageError || job.state !== 'pending') return;
    if (this.now() >= job.confirmUntil) { this.update(job, { state: 'unknown', error: 'Twitch did not confirm the clip within 60 seconds. It will not be recreated.' }); return; }
    try {
      const clip = await this.twitch.getViewerClip(job.clipId);
      if (this.closed) return;
      if (clip) {
        if (clip.id !== job.clipId || clip.broadcasterId !== job.broadcasterId || clip.creatorId !== job.creatorId) { this.update(job, { state: 'unknown', error: 'Twitch returned a clip for a different account or broadcast.' }); return; }
        this.update(job, { state: 'confirmed', url: `https://clips.twitch.tv/${job.clipId}`, error: '' }); return;
      }
    } catch { /* Read failures may be retried within the existing confirmation window. */ }
    if (!this.closed && !this.storageError) this.schedule(() => this.confirm(job), Math.min(3000, Math.max(0, job.confirmUntil - this.now())));
  }
  authorization(input) {
    if (!exact(input, ['action']) || !['start', 'poll'].includes(input.action)) throw fail('Invalid clip authorization action.');
    if (this.closed || this.storageError) throw fail('Clipping is unavailable.', 503);
    const requireHeld = expected => {
      const s = this.control.status(), pending = Array.isArray(s.controls?.pending) ? s.controls.pending : [s.controls?.pending];
      if (this.closed || expected !== undefined && expected !== this.control.generation || s.connected === true || s.settings?.paused !== true
          || pending.some(value => value && ['queued', 'running'].includes(value.state))) throw fail('Stop this companion before enabling clip permission.', 409);
    };
    requireHeld();
    const account = this.twitch.credentials?.account;
    if (!login(account) || !this.twitch.credentials?.clientId) throw fail('Connect this companion to Twitch first.', 409);
    const result = () => ({ ok: true, account, pending: this.authOperation?.state !== 'authorized',
      ...(this.authOperation?.public || {}), ...(this.authOperation?.state === 'authorized' ? { authorized: true } : {}) });
    if (input.action === 'start') {
      if (this.authOperation && (this.authFlight || ['starting', 'waiting', 'polling'].includes(this.authOperation.state))
          && (!this.authOperation.public.expiresAt || this.authOperation.public.expiresAt > this.now())) return result();
      const operation = this.authOperation = { state: 'starting', generation: this.control.generation, public: { pollAfterMs: 5000 } };
      this.authFlight = (async () => {
        try {
          const value = await this.twitch.startAuthorization(this.twitch.credentials.clientId, account, { clips: true });
          requireHeld(operation.generation);
          operation.state = 'waiting'; operation.public = { ...value, pollAfterMs: Math.max(5000, value.pollAfterMs || 5000) };
        } catch { operation.state = 'failed'; operation.error = 'Twitch clip authorization could not start. Stop the account and choose Enable clips again.'; }
      })().finally(() => { this.authFlight = null; });
      return result();
    }
    const operation = this.authOperation;
    if (!operation) throw fail('Start Enable clips before checking authorization.', 409);
    requireHeld(operation.generation);
    if (operation.state === 'failed') throw fail(operation.error, 409);
    if (operation.state === 'authorized' || this.authFlight) return result();
    if (operation.public.expiresAt <= this.now()) { operation.state = 'failed'; throw fail('Clip authorization expired. Choose Enable clips again.', 409); }
    if (!this.twitch.pendingAuth?.scopes?.includes('clips:edit')) throw fail('Clip authorization was cancelled. Choose Enable clips again.', 409);
    if (this.now() < this.twitch.pendingAuth.nextPoll) return { ...result(), pollAfterMs: this.twitch.pendingAuth.nextPoll - this.now() };
    operation.state = 'polling';
    this.authFlight = (async () => {
      try {
        const value = await this.twitch.pollAuthorization({ beforeSave: () => requireHeld(operation.generation) });
        requireHeld(operation.generation);
        if (value.authorized === true) { operation.state = 'authorized'; operation.public = {}; }
        else { operation.state = 'waiting'; operation.public.pollAfterMs = Math.max(5000, value.pollAfterMs || 5000); }
      } catch { operation.state = 'failed'; operation.error = 'Twitch clip authorization was denied, cancelled or expired. Choose Enable clips again.'; }
    })().finally(() => { this.authFlight = null; });
    return result();
  }

  close() { this.closed = true; for (const timer of this.timers) this.clearTimer(timer); this.timers.clear(); }
}
