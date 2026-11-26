import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { validateFetch, validateSocket, MAX_HTTP_BODY, MAX_FRAME } from '../extension/usa-policy.js';

const CLOSE_SOURCES = new Set(['browser-close', 'browser-error', 'proof-expiry', 'lease-expiry', 'local-reset', 'local-close', 'setup-timeout', 'command-failure']);
const bytes = value => Buffer.byteLength(value, 'utf8');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure = (code = 'usa_transport_held', notSubmitted = true, status = 409) => Object.assign(
  new Error('Fourth Twitch traffic is held until its paired browser confirms a fresh USA route.'), { code, notSubmitted, status });
const closeEvent = (code = 1006, wasClean = false) => {
  const event = new Event('close');
  Object.defineProperties(event, { code: { value: code }, wasClean: { value: wasClean }, reason: { value: '' } });
  return event;
};
export const blockedUsTransport = Object.freeze({
  fetch: async () => { throw failure(); },
  WebSocket: class { constructor() { throw failure(); } },
  invalidate() {}, bind() {}, close() {},
  status: () => ({ countryRequired: 'US', state: 'held', country: null, checkedAt: 0, browserOnline: false, pending: 0, sockets: 0, lastSocketClose: null })
});

/** No Node external network, persistent browser secrets, retries, or direct fallback. */
export function createUsTransport({ now = Date.now, requestMs = 10_000, leaseMs = 15_000, proofMs = 5000,
  setTimer = setTimeout, clearTimer = clearTimeout, sweepMs = 250 } = {}) {
  requestMs = Math.max(1, Math.min(10_000, requestMs)); leaseMs = Math.max(1, Math.min(15_000, leaseMs));
  proofMs = Math.max(1, Math.min(5000, proofMs));
  let session = '', epoch = randomUUID(), leaseUntil = 0, proof = null, closed = false, invalidating = false;
  let lastSocketClose = null, closeCallbackDepth = 0, eventSource = '';
  const fromSource = (source, callback) => { const previous = eventSource; eventSource = source; try { return callback(); } finally { eventSource = previous; } };
  let getGeneration = () => 0, getControlGeneration = () => 0;
  const jobs = new Map(), sockets = new Map(), completed = new Map(), retired = new Map();
  const fence = () => [getGeneration(), getControlGeneration()];
  const matching = job => JSON.stringify(job.fence) === JSON.stringify(fence());
  const online = () => !!session && now() < leaseUntil;
  const fresh = value => exact(value, ['ip', 'loc', 'checkedAt']) && typeof value.ip === 'string' && isIP(value.ip) > 0
    && value.loc === 'US' && Number.isSafeInteger(value.checkedAt) && value.checkedAt <= now() + 2000 && now() - value.checkedAt <= proofMs;
  const remember = (id, value) => { completed.set(id, value); while (completed.size > 512) completed.delete(completed.keys().next().value); };
  const current = input => {
    if (closed || !online() || input.sessionId !== session || input.epoch !== epoch) throw failure('usa_transport_session');
  };
  function settle(job, error, result, resultDigest = null) {
    if (!jobs.has(job.id)) return;
    jobs.delete(job.id); clearTimer(job.timer); job.signal?.removeEventListener('abort', job.abort);
    remember(job.id, { epoch: job.epoch, digest: resultDigest });
    if (error) job.reject(error); else job.resolve(result);
    // Credentials and returned bodies become unreachable after settlement.
    job.body = undefined; job.headers = undefined;
  }
  function invalidate(source = eventSource || 'local-reset') {
    if (invalidating) return;
    invalidating = true; epoch = randomUUID(); proof = null;
    for (const job of [...jobs.values()]) settle(job, failure('usa_transport_cancelled', job.state !== 'begun'));
    let record = closeCallbackDepth === 0;
    for (const socket of [...sockets.values()]) if (socket.finish(1006, false, true, source, record)) record = false;
    sockets.clear();
    invalidating = false;
  }
  function sweep() {
    if (closed) return;
    if (session && !online()) { invalidate('lease-expiry'); leaseUntil = 0; }
    else if ([...sockets.values()].some(socket => socket.constructed && socket.readyState !== 3) && !fresh(proof)) invalidate('proof-expiry');
    for (const job of [...jobs.values()]) if (job.expiresAt <= now() || !matching(job)) settle(job, failure('usa_transport_expired', job.state !== 'begun'));
  }
  const interval = setInterval(sweep, Math.max(10, sweepMs)); interval.unref?.();
  function queue(kind, fields = {}, signal) {
    sweep();
    if (closed || !online() || jobs.size >= 32 || signal?.aborted) throw failure();
    const job = { ...fields, id: randomUUID(), kind, epoch, fence: fence(), state: 'queued', expiresAt: now() + requestMs, signal };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.timer = setTimer(() => settle(job, failure('usa_transport_timeout', job.state !== 'begun')), requestMs); job.timer?.unref?.();
    job.abort = () => { const begun = job.state === 'begun'; settle(job, failure('usa_transport_aborted', !begun)); if (begun) invalidate(); };
    jobs.set(job.id, job); signal?.addEventListener('abort', job.abort, { once: true });
    return job;
  }
  function parseProof(value, nullable = false) {
    if (nullable && value === null) return null;
    if (!fresh(value)) throw failure('usa_transport_proof');
    return { ...value };
  }
  function poll(input) {
    if (!object(input) || Object.keys(input).some(key => !['sessionId', 'epoch', 'proof'].includes(key))
      || !identifier(input.sessionId) || !Object.hasOwn(input, 'proof') || input.epoch !== undefined && !identifier(input.epoch)) throw failure('usa_transport_input', true, 400);
    if (closed) throw failure();
    sweep();
    for (const [id, expiresAt] of retired) if (expiresAt <= now()) retired.delete(id);
    const suppliedProof = parseProof(input.proof, true);
    if (input.sessionId !== session) {
      if (retired.has(input.sessionId) || retired.size >= 512) throw failure('usa_transport_retired');
      if (session) retired.set(session, now() + 60_000);
      invalidate(); session = input.sessionId;
    } else if (input.epoch !== epoch) {
      leaseUntil = now() + leaseMs;
      if (suppliedProof) proof = suppliedProof;
      return { ok: true, epoch, leaseExpiresAt: leaseUntil, needsProof: !fresh(proof), job: null };
    }
    leaseUntil = now() + leaseMs;
    if (suppliedProof) proof = suppliedProof;
    let issued = null;
    for (const job of jobs.values()) {
      if (job.state !== 'queued') continue;
      if (!matching(job) || job.epoch !== epoch) { settle(job, failure('usa_transport_stale')); continue; }
      if (job.kind !== 'ws-close' && !fresh(proof)) continue;
      job.state = 'leased';
      const { id, kind, expiresAt, url, method, headers, body, socketId, data, code, reason } = job;
      issued = { id, kind, expiresAt, ...(url === undefined ? {} : { url }), ...(method === undefined ? {} : { method }),
        ...(headers === undefined ? {} : { headers }), ...(body === undefined ? {} : { body }), ...(socketId === undefined ? {} : { socketId }),
        ...(data === undefined ? {} : { data }), ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
      break;
    }
    return { ok: true, epoch, leaseExpiresAt: leaseUntil, needsProof: !fresh(proof), job: issued };
  }
  function begin(input) {
    if (!exact(input, ['sessionId', 'epoch', 'id', 'proof'])) throw failure('usa_transport_input', true, 400);
    sweep(); current(input);
    const job = jobs.get(input.id);
    if (!job || job.epoch !== epoch || job.state !== 'leased' || !matching(job) || job.expiresAt <= now()) throw failure('usa_transport_claim');
    if (job.kind !== 'ws-close') proof = parseProof(input.proof);
    else if (input.proof !== null) proof = parseProof(input.proof);
    job.state = 'begun';
    return { ok: true, expiresAt: job.expiresAt };
  }
  function responseValue(value) {
    if (!exact(value, ['ok', 'status', 'headers', 'body']) || value.ok !== true || !Number.isInteger(value.status) || value.status < 200 || value.status > 599
      || !Array.isArray(value.headers) || value.headers.length > 2 || typeof value.body !== 'string' || bytes(value.body) > MAX_HTTP_BODY) throw failure('usa_transport_result', false, 400);
    const names = new Set(); let headerBytes = 0;
    for (const pair of value.headers) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string'
        || !['content-type', 'retry-after'].includes(pair[0]) || names.has(pair[0]) || /[\r\n\u0000-\u001f\u007f]/.test(pair[1])) throw failure('usa_transport_result', false, 400);
      names.add(pair[0]); headerBytes += bytes(pair[1]);
    }
    if (headerBytes > 8192 || [204, 205, 304].includes(value.status) && value.body !== '') throw failure('usa_transport_result', false, 400);
    return new Response([204, 205, 304].includes(value.status) ? null : value.body, { status: value.status, headers: value.headers });
  }
  function complete(input) {
    if (!exact(input, ['sessionId', 'epoch', 'id', 'result']) || !object(input.result)) throw failure('usa_transport_input', true, 400);
    sweep(); current(input);
    const hash = digest(input.result), prior = completed.get(input.id);
    if (prior) { if (prior.epoch === epoch && prior.digest === hash) return { ok: true }; throw failure('usa_transport_completed'); }
    const job = jobs.get(input.id);
    if (!job || job.epoch !== epoch || !matching(job) || job.expiresAt <= now()) throw failure('usa_transport_claim');
    if (input.result.ok === false) {
      if (!exact(input.result, ['ok', 'code']) || !['network_error', 'aborted', 'timeout', 'non_us', 'bad_response'].includes(input.result.code)) throw failure('usa_transport_result', false, 400);
      settle(job, failure('usa_transport_failed', job.state !== 'begun'), undefined, hash); return { ok: true };
    }
    if (job.state !== 'begun') throw failure('usa_transport_claim');
    let value;
    if (job.kind === 'fetch') value = responseValue(input.result);
    else {
      if (!exact(input.result, ['ok']) || input.result.ok !== true) throw failure('usa_transport_result', false, 400);
      if (job.kind === 'ws-open') { const socket = sockets.get(job.socketId); if (!socket) throw failure('usa_transport_socket'); socket.constructed = true; }
    }
    settle(job, null, value, hash); return { ok: true };
  }
  function event(input) {
    if (!exact(input, ['sessionId', 'epoch', 'socketId', 'seq', 'event']) || !Number.isSafeInteger(input.seq) || input.seq < 1 || input.seq > 1e9 || !object(input.event)) throw failure('usa_transport_input', true, 400);
    sweep(); current(input);
    const socket = sockets.get(input.socketId), hash = digest(input.event);
    if (!socket || socket.epoch !== epoch || !socket.constructed) throw failure('usa_transport_socket');
    if (socket.events.has(input.seq)) { if (socket.events.get(input.seq) === hash) return { ok: true, seq: input.seq }; throw failure('usa_transport_sequence'); }
    if (input.seq !== socket.seq + 1) throw failure('usa_transport_sequence');
    const value = input.event;
    if (value.type === 'open' && exact(value, ['type']) && socket.readyState === 0) { socket.readyState = 1; clearTimer(socket.setupTimer); socket.dispatchEvent(new Event('open')); }
    else if (value.type === 'message' && exact(value, ['type', 'data']) && typeof value.data === 'string' && bytes(value.data) <= MAX_FRAME && socket.readyState === 1) socket.dispatchEvent(new MessageEvent('message', { data: value.data }));
    else if (value.type === 'error' && exact(value, ['type'])) fromSource('browser-error', () => socket.dispatchEvent(new Event('error')));
    else if (value.type === 'close' && exact(value, ['type', 'code', 'wasClean']) && Number.isInteger(value.code) && value.code >= 1000 && value.code <= 4999 && typeof value.wasClean === 'boolean') socket.finish(value.code, value.wasClean, false, 'browser-close');
    else throw failure('usa_transport_event', false, 400);
    socket.seq = input.seq; socket.events.set(input.seq, hash); while (socket.events.size > 64) socket.events.delete(socket.events.keys().next().value);
    // Keep a bounded closed facade until epoch retirement, so close ACK loss is idempotent.
    return { ok: true, seq: input.seq };
  }
  class RelayWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    CONNECTING = 0; OPEN = 1; CLOSING = 2; CLOSED = 3;
    constructor(raw) {
      super(); this.url = validateSocket(raw); this.readyState = 0; this.bufferedAmount = 0; this.extensions = ''; this.protocol = ''; this.binaryType = 'blob';
      this.socketId = randomUUID(); this.epoch = epoch; this.seq = 0; this.events = new Map(); this.constructed = false;
      if ([...sockets.values()].filter(socket => socket.readyState !== 3).length >= 4) throw failure();
      for (const [key, socket] of sockets) if (socket.readyState === 3 && sockets.size >= 64) sockets.delete(key);
      const job = queue('ws-open', { url: this.url, socketId: this.socketId }); this.job = job;
      sockets.set(this.socketId, this);
      this.setupTimer = setTimer(() => { if (this.readyState === 0) { fromSource('setup-timeout', () => { this.dispatchEvent(new Event('error')); invalidate('setup-timeout'); }); } }, requestMs); this.setupTimer?.unref?.();
      job.promise.catch(() => { if (this.readyState !== 3) fromSource('command-failure', () => { this.dispatchEvent(new Event('error')); this.finish(1006, false, true, 'command-failure'); }); });
    }
    finish(code = 1006, wasClean = false, remove = true, source = 'local-reset', record = true) {
      if (this.readyState === 3) return false;
      this.readyState = 3; clearTimer(this.setupTimer);
      if (record && closeCallbackDepth === 0) lastSocketClose = { source: CLOSE_SOURCES.has(source) ? source : 'local-reset', at: now(),
        code: Number.isInteger(code) && code >= 1000 && code <= 4999 ? code : 1006, wasClean: wasClean === true };
      if (remove) sockets.delete(this.socketId);
      queueMicrotask(() => {
        closeCallbackDepth++;
        try { this.dispatchEvent(closeEvent(code, wasClean)); } finally { closeCallbackDepth--; }
      });
      return true;
    }
    close(code = 1000, reason = '') {
      if (code !== 1000 && (!Number.isInteger(code) || code < 3000 || code > 4999) || typeof reason !== 'string' || bytes(reason) > 123) throw failure('usa_transport_close', true, 400);
      if (this.readyState === 3 || this.readyState === 2) return;
      if (this.job && jobs.has(this.job.id) && this.job.state !== 'begun') { settle(this.job, failure('usa_transport_cancelled')); this.finish(1000, true, true, 'local-close'); return; }
      this.readyState = 2;
      try { queue('ws-close', { socketId: this.socketId, code, reason }).promise.then(() => this.finish(1000, true, false, 'local-close'), () => this.finish(1006, false, true, 'command-failure')); }
      catch { this.finish(1006, false, true, 'command-failure'); }
    }
    send(data) {
      if (this.readyState !== 1 || typeof data !== 'string' || bytes(data) > MAX_FRAME) throw failure('usa_transport_socket', true, 400);
      queue('ws-send', { socketId: this.socketId, data }).promise.catch(() => fromSource('command-failure', () => { this.dispatchEvent(new Event('error')); this.finish(1006, false, true, 'command-failure'); }));
    }
  }
  return {
    WebSocket: RelayWebSocket,
    async fetch(raw, options = {}) {
      if (options.redirect !== undefined && options.redirect !== 'error') throw failure('usa_transport_target', true, 400);
      let request;
      try { request = validateFetch(raw instanceof URL ? raw.href : raw, { method: options.method || 'GET', headers: [...new Headers(options.headers || {})],
        ...(options.body === undefined || options.body === null ? {} : { body: options.body instanceof URLSearchParams ? options.body.toString() : options.body }) }); }
      catch { throw failure('usa_transport_target', true, 400); }
      return queue('fetch', request, options.signal).promise;
    }, poll, begin, complete, event, invalidate,
    bind({ getGeneration: nextGeneration, getControlGeneration: nextControl } = {}) { if (nextGeneration) getGeneration = nextGeneration; if (nextControl) getControlGeneration = nextControl; },
    status() { sweep(); const valid = online() && fresh(proof); return { countryRequired: 'US', state: closed ? 'closed' : valid ? 'ready' : 'held', country: valid ? 'US' : null,
      checkedAt: valid ? proof.checkedAt : 0, browserOnline: online(), pending: jobs.size, sockets: [...sockets.values()].filter(s => s.readyState !== 3).length, lastSocketClose: lastSocketClose ? { ...lastSocketClose } : null }; },
    close() { if (closed) return; closed = true; invalidate(); clearInterval(interval); leaseUntil = 0; }
  };
}
