import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT = 1024 * 1024, CHECKPOINT_MS = 60_000, PROOF_MS = 5000;
const CLOSE_SOURCES = new Set(['browser-close', 'browser-error', 'proof-expiry', 'lease-expiry', 'local-reset', 'local-close', 'setup-timeout', 'command-failure']);
function closeState(raw, at) {
  if (!raw || !Number.isSafeInteger(raw.at) || raw.at <= 0 || raw.at > at) return null;
  return { source: CLOSE_SOURCES.has(raw.source) ? raw.source : 'unknown', at: raw.at,
    code: Number.isInteger(raw.code) && raw.code >= 1000 && raw.code <= 4999 ? raw.code : null,
    wasClean: typeof raw.wasClean === 'boolean' ? raw.wasClean : null };
}
const STATES = new Set(['ready', 'held', 'closed']);
const bounded = (value, maximum) => Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;

// Cached health only. Never serialize transport objects, addresses, identifiers,
// errors or payloads. Source time stays source time; sampling cannot refresh it.
function project(raw, at) {
  const checkedAt = Number.isSafeInteger(raw?.checkedAt) && raw.checkedAt > 0 && raw.checkedAt <= at ? raw.checkedAt : null;
  const state = STATES.has(raw?.state) ? raw.state : 'unknown', country = raw?.country === 'US' ? 'US' : null;
  const browserOnline = raw?.browserOnline === true;
  return { state: { countryRequired: 'US', state, country, browserOnline,
    proofFresh: raw?.countryRequired === 'US' && state === 'ready' && country === 'US' && browserOnline && checkedAt !== null && at - checkedAt <= PROOF_MS,
    pending: bounded(raw?.pending, 32), sockets: bounded(raw?.sockets, 4), lastSocketClose: closeState(raw?.lastSocketClose, at) }, proofObservedAt: checkedAt };
}

// Same secure, bounded writer as the host status logger, kept local so this
// independently installed helper has no source-tree dependency on the host.
export function createUsaHealthLogger({ transport, directory = fileURLToPath(new URL('../private/', import.meta.url)), now = Date.now,
  warn = message => console.warn(message), io = fs, maxBytes = LIMIT, intervalMs = 5000,
  setIntervalImpl = (fn, ms) => setInterval(fn, ms), clearIntervalImpl = timer => clearInterval(timer) } = {}) {
  if (!transport || typeof transport.status !== 'function' || typeof directory !== 'string' || !Number.isInteger(maxBytes)
      || maxBytes < 1024 || maxBytes > LIMIT || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > 5000) throw Error('Invalid USA health log configuration.');
  const file = join(directory, 'usa-health.jsonl');
  const uid = process.getuid?.();
  let warned = false;
  const owned = entry => uid === undefined || entry.uid === uid;
  const regular = path => {
    try { const entry = io.lstatSync(path); if (!entry.isFile() || entry.nlink !== 1 || !owned(entry)) throw Error(); return entry; }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const repairTail = entry => {
    if (!entry?.size) return entry;
    const descriptor = io.openSync(file, io.constants.O_RDWR | io.constants.O_NOFOLLOW);
    try {
      const current = io.fstatSync(descriptor); if (!current.isFile() || current.nlink !== 1 || !owned(current) || current.size > maxBytes) throw Error();
      const tail = Buffer.alloc(Math.min(current.size, 4096));
      if (io.readSync(descriptor, tail, 0, tail.length, current.size - tail.length) !== tail.length) throw Error();
      if (tail.at(-1) !== 10) {
        const newline = tail.lastIndexOf(10);
        if (newline === -1 && current.size > tail.length) throw Error();
        // A failed append or interrupted process can leave only an incomplete
        // final record. Preserve all prior complete observations.
        io.ftruncateSync(descriptor, newline === -1 ? 0 : current.size - tail.length + newline + 1); io.fsyncSync(descriptor);
      }
      return io.fstatSync(descriptor);
    } finally { io.closeSync(descriptor); }
  };
  const write = value => {
    try {
      io.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const folder = io.lstatSync(directory); if (!folder.isDirectory() || !owned(folder)) throw Error();
      io.chmodSync(directory, 0o700);
      const line = `${JSON.stringify({ version: 1, ...value })}\n`, bytes = Buffer.byteLength(line);
      if (bytes > maxBytes) throw Error();
      const entries = [file, ...[1, 2, 3].map(n => `${file}.${n}`)].map(path => ({ path, entry: regular(path) }));
      // Refuse tampered entries before rotating or writing any of them.
      for (const { path, entry } of entries) if (entry) { if (entry.size > maxBytes) throw Error(); io.chmodSync(path, 0o600); }
      entries[0].entry = repairTail(entries[0].entry);
      if ((entries[0].entry?.size || 0) + bytes > maxBytes) {
        if (entries[3].entry) io.unlinkSync(`${file}.3`);
        for (let n = 2; n >= 0; n--) if (entries[n].entry) io.renameSync(entries[n].path, `${file}.${n + 1}`);
      }
      const descriptor = io.openSync(file, io.constants.O_WRONLY | io.constants.O_APPEND | io.constants.O_CREAT | io.constants.O_NOFOLLOW, 0o600);
      try {
        const entry = io.fstatSync(descriptor); if (!entry.isFile() || entry.nlink !== 1 || !owned(entry) || entry.size + bytes > maxBytes) throw Error();
        io.fchmodSync(descriptor, 0o600);
        try { io.writeFileSync(descriptor, line); io.fsyncSync(descriptor); }
        catch (error) { try { io.ftruncateSync(descriptor, entry.size); io.fsyncSync(descriptor); } catch {} throw error; }
      } finally { io.closeSync(descriptor); }
      return true;
    } catch {
      if (!warned) { warned = true; try { warn('Fourth USA health logging is unavailable. Runtime controls are unchanged.'); } catch {} }
      return false;
    }
  };
  let timer = null, started = false, closed = false, previous = null;
  const sample = (terminal = false) => {
    if (closed || !started) return false;
    try {
      const at = now(); if (!Number.isSafeInteger(at) || at <= 0 || !Number.isFinite(new Date(at).getTime())) return false;
      let value; try { value = project(transport.status(), at); } catch { value = project(null, at); }
      const signature = JSON.stringify(value.state);
      const event = terminal ? 'stopped' : !previous ? 'baseline' : previous.signature !== signature ? 'transition' : at - previous.at >= CHECKPOINT_MS ? 'checkpoint' : '';
      if (!event) return true;
      if (!write({ event, observedAt: new Date(at).toISOString(), profile: 'fourth', ...value.state, proofObservedAt: value.proofObservedAt })) return false;
      previous = { signature, at }; return true;
    } catch { return false; }
  };
  return {
    sample,
    start() {
      if (closed || started) return false;
      started = true; const result = sample();
      try { timer = setIntervalImpl(() => { sample(); }, intervalMs); timer?.unref?.(); } catch { /* Logging cannot stop the helper. */ }
      return result;
    },
    close() {
      if (closed) return;
      try { if (timer !== null) clearIntervalImpl(timer); } catch { /* Shutdown remains available. */ }
      timer = null;
      try { if (started) sample(true); } finally { closed = true; }
    }
  };
}
