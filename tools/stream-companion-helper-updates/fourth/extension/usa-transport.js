import { validateFetch, validateSocket, TRACE_URL, MAX_HTTP_BODY, MAX_FRAME } from './usa-policy.js';

export const NETWORK_ORIGINS = Object.freeze(['https://id.twitch.tv/*', 'https://api.twitch.tv/*', 'https://www.cloudflare.com/*', 'https://eventsub.wss.twitch.tv/*']);
export const USA_ACCESS = Object.freeze({ permissions: ['scripting'], origins: ['https://www.twitch.tv/*', ...NETWORK_ORIGINS] });
const encoder = new TextEncoder();
const byteLength = value => encoder.encode(value).length;
const id = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
const failure = code => Object.assign(Error('USA connection is held.'), { code });
const reasons = Object.freeze({ access: 'Enable USA & Twitch access first.', setup: 'Save this profile’s local pairing first.', checking: 'Checking the USA connection.', non_us: 'USA routing could not be verified. Keep Nord connected to United States.', bad_response: 'The USA connection check was not valid.', network_error: 'The USA connection is unavailable.', timeout: 'The USA connection timed out.', aborted: 'The USA connection was reset.', lease: 'The paired connection expired. Waiting to reconnect.', helper: 'Waiting for the paired local helper.', stopped: 'The connection was reset after Stop.' });
export async function hasUsaAccess(chrome) {
  if (!chrome.permissions?.contains || !chrome.permissions?.getAll) return false;
  try {
    const granted = await chrome.permissions.getAll();
    if (!NETWORK_ORIGINS.every(origin => granted.origins?.includes(origin))) return false;
    return (await Promise.all(NETWORK_ORIGINS.map(origin => chrome.permissions.contains({ origins: [origin] })))).every(Boolean);
  } catch { return false; }
}
export function parseUsaTrace(text, checkedAt) {
  if (typeof text !== 'string' || byteLength(text) > 16384) throw failure('bad_response');
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('='); if (at < 0) continue;
    const key = line.slice(0, at), value = line.slice(at + 1);
    if (['ip', 'loc'].includes(key)) { if (Object.hasOwn(values, key)) throw failure('bad_response'); values[key] = value; }
  }
  const ip = values.ip;
  let valid = typeof ip === 'string' && ip.length <= 45 && /^[0-9a-fA-F:.]+$/.test(ip);
  if (valid && ip.includes(':')) { try { valid = new URL(`https://[${ip}]/`).hostname.startsWith('['); } catch { valid = false; } }
  else if (valid) valid = ip.split('.').length === 4 && ip.split('.').every(n => /^(0|[1-9]\d{0,2})$/.test(n) && Number(n) <= 255);
  if (!valid || !values.loc || !/^[A-Z]{2}$/.test(values.loc)) throw failure('bad_response');
  if (values.loc !== 'US') throw failure('non_us');
  return { ip, loc: 'US', checkedAt };
}
async function boundedText(response, maximum, signal) {
  if (!response || Number(response.headers?.get?.('content-length')) > maximum) throw failure('bad_response');
  if (response.body === null && [204, 205, 304].includes(response.status)) return '';
  if (!response.body?.getReader) throw failure('bad_response');
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw failure('aborted');
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maximum) { await reader.cancel().catch(() => {}); throw failure('bad_response'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw failure('bad_response'); }
  } finally { reader.releaseLock(); }
}
/** Ephemeral browser-only execution. No relay job, proof or provider credential is persisted. */
export class UsaBrowserRelay {
  constructor({ settings, access, post, fetchImpl = globalThis.fetch, WebSocketImpl = globalThis.WebSocket, now = Date.now,
    sessionId = () => crypto.randomUUID(), setTimer = setTimeout, clearTimer = clearTimeout, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
    // WorkerGlobalScope host methods require their original global receiver.
    // Capture each dependency once; keep injected functions' arguments/results
    // intact without calling a browser native with the relay as its receiver.
    const hostCall = fn => (...args) => Reflect.apply(fn, globalThis, args);
    Object.assign(this, { settings, access, post, fetch: hostCall(fetchImpl), WebSocket: WebSocketImpl, now, makeSession: sessionId,
      setTimer: hostCall(setTimer), clearTimer: hostCall(clearTimer), setInterval: hostCall(setIntervalImpl), clearInterval: hostCall(clearIntervalImpl) });
    this.sessionId = sessionId(); this.epoch = ''; this.version = 0; this.identity = ''; this.leaseExpiresAt = 0;
    this.seen = new Map(); this.sockets = new Map(); this.requests = new Set(); this.tasks = new Set(); this.lastCheckAt = 0; this.reason = 'setup'; this.publicationPending = false;
  }
  status() {
    const ready = !!this.epoch && this.leaseExpiresAt > this.now() && this.proof?.loc === 'US' && this.proof.checkedAt >= this.now() - 5000;
    return { ready, country: ready ? 'US' : null, heldReason: ready ? '' : reasons[this.reason] || reasons.helper, lastCheckAt: this.lastCheckAt };
  }
  start() {
    if (this.timer == null) { this.timer = this.setInterval(() => { void this.tick(); }, 1000); this.timer.unref?.(); }
    void this.tick();
  }
  stop() { if (this.timer) this.clearInterval(this.timer); this.timer = null; this.reset('stopped'); }
  cleanup() {
    this.clearTimer(this.leaseTimer); this.leaseTimer = null;
    this.clearTimer(this.renewalTimer); this.renewalTimer = null; this.publicationPending = false;
    this.probe?.controller.abort(); this.probe = null;
    for (const controller of this.requests) controller.abort(); this.requests.clear();
    for (const socket of this.sockets.values()) { socket.retired = true; try { socket.ws.close(1000, 'Connection reset'); } catch {} }
    this.sockets.clear();
  }
  reset(reason = 'aborted') {
    this.version++; this.cleanup(); this.epoch = ''; this.proof = null; this.leaseExpiresAt = 0; this.seen.clear(); this.sessionId = this.makeSession(); this.reason = reason;
  }
  settingsChanged(value) {
    const identity = `${value?.account || ''}\u0000${value?.pairingToken || ''}`;
    if (this.identity && this.identity !== identity) this.reset('setup');
    this.identity = identity;
  }
  current(version, epoch = this.epoch) { return version === this.version && !!epoch && epoch === this.epoch && this.leaseExpiresAt > this.now(); }
  adopt(reply) {
    if (!reply || reply.ok !== true || !id(reply.epoch) || !Number.isFinite(reply.leaseExpiresAt) || reply.leaseExpiresAt <= this.now() || reply.leaseExpiresAt > this.now() + 20000 || typeof reply.needsProof !== 'boolean') throw failure('bad_response');
    if (this.epoch !== reply.epoch) { this.version++; this.cleanup(); this.seen.clear(); this.epoch = reply.epoch; }
    this.leaseExpiresAt = reply.leaseExpiresAt; this.clearTimer(this.leaseTimer);
    const version = this.version;
    if (this.proof) this.scheduleRenewal(this.proof, version);
    this.leaseTimer = this.setTimer(() => { if (version === this.version && this.leaseExpiresAt <= this.now()) this.reset('lease'); }, Math.max(1, this.leaseExpiresAt - this.now())); this.leaseTimer?.unref?.();
  }
  scheduleRenewal(proof, version = this.version) {
    this.clearTimer(this.renewalTimer);
    const epoch = this.epoch;
    this.renewalTimer = this.setTimer(() => {
      this.renewalTimer = null;
      if (!this.current(version, epoch) || this.proof !== proof) return;
      void this.attest().catch(() => {});
    }, Math.max(0, proof.checkedAt + 1000 - this.now()));
    this.renewalTimer?.unref?.();
  }
  publishProof(version) {
    if (!this.current(version)) return;
    this.publicationPending = true; void this.tick();
  }
  async tick() {
    if (this.pollFlight) return this.pollFlight;
    const invocationVersion = this.version; let operationVersion = invocationVersion;
    this.pollFlight = (async () => {
      try {
        const s = await this.settings();
        if (invocationVersion !== this.version) return;
        this.settingsChanged(s);
        const version = this.version, sessionId = this.sessionId; operationVersion = version;
        if (typeof s.pairingToken !== 'string' || s.pairingToken.length < 16 || s.pairingToken.length > 1024 || /\s/.test(s.pairingToken)) { this.reset('setup'); return; }
        const access = await this.access();
        if (version !== this.version || sessionId !== this.sessionId) return;
        if (!access) { this.reset('access'); return; }
        const proof = this.proof && this.proof.checkedAt >= this.now() - 5000 ? this.proof : null;
        this.publicationPending = false;
        const reply = await this.post('/api/usa-transport/poll', { sessionId, ...(this.epoch ? { epoch: this.epoch } : {}), proof }, s);
        if (version !== this.version || sessionId !== this.sessionId) return;
        this.adopt(reply); operationVersion = this.version;
        if (this.proof && this.proof !== proof) this.publicationPending = true;
        if (reply.job !== null && reply.job !== undefined) this.launch(reply.job, s);
        if (reply.needsProof || !this.proof || this.proof.checkedAt < this.now() - 2000) {
          void this.attest().catch(() => {});
        }
      } catch (error) { if (operationVersion === this.version) this.reset(error?.code || 'helper'); }
    })().finally(() => {
      this.pollFlight = null;
      if (this.publicationPending) { this.publicationPending = false; void this.tick(); }
    });
    return this.pollFlight;
  }
  async attest() {
    if (this.probe) return this.probe.promise;
    const controller = new AbortController(), version = this.version;
    const timer = this.setTimer(() => controller.abort(), 3500); timer?.unref?.();
    const promise = (async () => {
      try {
        if (!await this.access() || version !== this.version) throw failure('access');
        const response = await this.fetch(TRACE_URL, { method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
        if (!response.ok || controller.signal.aborted) throw failure('network_error');
        const text = await boundedText(response, 16384, controller.signal);
        const proof = parseUsaTrace(text, this.now());
        if (version !== this.version || controller.signal.aborted) throw failure('aborted');
        this.lastCheckAt = proof.checkedAt; this.proof = proof; this.reason = 'checking';
        this.scheduleRenewal(proof, version); this.publishProof(version); return proof;
      } catch (error) {
        const code = ['non_us', 'bad_response', 'access'].includes(error?.code) ? error.code : controller.signal.aborted ? 'timeout' : 'network_error';
        if (version === this.version) { this.lastCheckAt = this.now(); this.reset(code); }
        throw failure(code);
      } finally { this.clearTimer(timer); if (this.probe?.controller === controller) this.probe = null; }
    })();
    this.probe = { controller, promise }; return promise;
  }
  launch(job, settings) {
    if (!job || !id(job.id) || !['fetch', 'ws-open', 'ws-close', 'ws-send'].includes(job.kind) || !Number.isFinite(job.expiresAt) || job.expiresAt <= this.now() || job.expiresAt > this.now() + 12000) { this.reset('bad_response'); return; }
    for (const [key, expiry] of this.seen) if (expiry < this.now()) this.seen.delete(key);
    if (this.seen.has(job.id)) return;
    if (this.seen.size >= 512 || this.tasks.size >= 4) { this.reset('bad_response'); return; }
    this.seen.set(job.id, job.expiresAt);
    const task = this.execute(job, settings); this.tasks.add(task); void task.finally(() => this.tasks.delete(task));
  }
  async execute(job, settings) {
    const version = this.version, epoch = this.epoch, sessionId = this.sessionId;
    const valid = () => this.current(version, epoch) && job.expiresAt > this.now();
    let controller, timer, completing = false;
    try {
      let request;
      if (job.kind === 'fetch') request = validateFetch(job.url, { method: job.method, headers: job.headers, body: job.body });
      else if (job.kind === 'ws-open') { if (!id(job.socketId) || this.sockets.has(job.socketId)) throw failure('bad_response'); validateSocket(job.url); }
      else if (!id(job.socketId) || job.kind === 'ws-send' && (typeof job.data !== 'string' || byteLength(job.data) > MAX_FRAME)
        || job.kind === 'ws-close' && (job.code !== undefined && job.code !== 1000 && !(job.code >= 3000 && job.code <= 4999) || job.reason !== undefined && (typeof job.reason !== 'string' || byteLength(job.reason) > 123))) throw failure('bad_response');
      let deadline = job.expiresAt;
      {
        const proof = job.kind === 'ws-close' ? null : await this.attest();
        if (!valid()) return;
        const begin = await this.post('/api/usa-transport/begin', { sessionId, epoch, id: job.id, proof }, settings);
        // No asynchronous work may intervene between this single-use ACK and dispatch.
        if (!valid() || begin?.ok !== true || !Number.isFinite(begin.expiresAt) || begin.expiresAt <= this.now()) return;
        deadline = Math.min(deadline, begin.expiresAt);
      }
      if (!valid()) return;
      if (job.kind === 'fetch') {
        controller = new AbortController(); this.requests.add(controller);
        timer = this.setTimer(() => controller.abort(), Math.max(1, Math.min(10000, deadline - this.now()))); timer?.unref?.();
        const response = await this.fetch(request.url, { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }),
          credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal });
        if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) throw failure('bad_response');
        const body = await boundedText(response, MAX_HTTP_BODY, controller.signal), headers = [];
        if (byteLength(body) > MAX_HTTP_BODY) throw failure('bad_response');
        for (const name of ['content-type', 'retry-after']) { const value = response.headers.get(name); if (value !== null) { if (value.length > 1024 || /[\u0000-\u001f\u007f]/.test(value)) throw failure('bad_response'); headers.push([name, value]); } }
        if (valid() && !controller.signal.aborted) { completing = true; await this.complete({ sessionId, epoch, id: job.id, result: { ok: true, status: response.status, headers, body } }, settings); }
      } else if (job.kind === 'ws-open') {
        const ws = new this.WebSocket(job.url), entry = { ws, version, epoch, sessionId, settings, seq: 0, queue: Promise.resolve(), queuedBytes: 0, queuedFrames: 0, retired: false, accepted: false };
        this.sockets.set(job.socketId, entry);
        const enqueue = event => this.socketEvent(job.socketId, entry, event);
        ws.addEventListener('open', () => enqueue({ type: 'open' }));
        ws.addEventListener('message', event => { if (typeof event.data !== 'string' || byteLength(event.data) > MAX_FRAME) { this.reset('bad_response'); return; } enqueue({ type: 'message', data: event.data }); });
        ws.addEventListener('error', () => enqueue({ type: 'error' }));
        ws.addEventListener('close', event => enqueue({ type: 'close', code: event.code, wasClean: event.wasClean === true }));
        entry.openAck = this.complete({ sessionId, epoch, id: job.id, result: { ok: true } }, settings);
        await entry.openAck; entry.accepted = true;
      } else {
        const entry = this.sockets.get(job.socketId);
        if (job.kind === 'ws-close') { if (entry) { entry.retired = true; this.sockets.delete(job.socketId); entry.ws.close(job.code || 1000, job.reason || ''); } }
        else { if (!entry || entry.retired || entry.ws.readyState !== 1) throw failure('bad_response'); entry.ws.send(job.data); }
        await this.complete({ sessionId, epoch, id: job.id, result: { ok: true } }, settings);
      }
    } catch (error) {
      if (!this.current(version, epoch)) return;
      const code = ['non_us', 'bad_response'].includes(error?.code) ? error.code : controller?.signal.aborted ? 'timeout' : 'network_error';
      // A lost BEGIN is deliberately not retried. Retiring this session also
      // stops any sibling sockets/results from outliving the ambiguous command.
      if (!controller || completing) { this.reset(code); return; }
      try { await this.complete({ sessionId, epoch, id: job.id, result: { ok: false, code } }, settings); } catch {}
    } finally { if (controller) this.requests.delete(controller); this.clearTimer(timer); }
  }
  async complete(payload, settings) {
    const result = await this.post('/api/usa-transport/complete', payload, settings);
    if (result?.ok !== true) throw failure('bad_response');
    return result;
  }
  socketEvent(socketId, entry, event) {
    if (entry.retired || !this.current(entry.version, entry.epoch)) return;
    const size = event.type === 'message' ? byteLength(event.data) : 0;
    entry.queuedBytes += size; entry.queuedFrames++;
    if (entry.queuedBytes > 524288 || entry.queuedFrames > 64) { this.reset('bad_response'); return; }
    entry.queue = entry.queue.then(async () => {
      await entry.openAck;
      if (entry.retired || !this.current(entry.version, entry.epoch)) return;
      const seq = ++entry.seq;
      const result = await this.post('/api/usa-transport/event', { sessionId: entry.sessionId, epoch: entry.epoch, socketId, seq, event }, entry.settings);
      if (result?.ok !== true || result.seq !== seq) throw failure('bad_response');
      if (event.type === 'close') { entry.retired = true; this.sockets.delete(socketId); }
    }).catch(() => { if (this.current(entry.version, entry.epoch)) this.reset('helper'); }).finally(() => { entry.queuedBytes -= size; entry.queuedFrames--; });
  }
}
