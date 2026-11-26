import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDS = ['primary', 'test', 'third', 'fourth'];
const WATCH = new Set(['playing', 'paused', 'buffering', 'stalled', 'ad', 'advertisement', 'offline', 'ended', 'checking', 'commercial', 'error', 'unknown']);
const CODES = ['authorization_revoked', 'chat_user_banned', 'user_removed', 'version_removed', 'unknown_reason'];
const LIMIT = 1024 * 1024, CHECKPOINT_MS = 60_000, FRESH_MS = 45_000;
const stamp = value => typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const sourceTime = (value, now) => { const at = stamp(value); return Number.isFinite(at) && at > 0 && at <= now ? at : null; };
const fresh = (at, now) => at !== null && now - at <= FRESH_MS;
function errorCode(value, available) {
  if (!available) return 'helper_unavailable';
  if (typeof value !== 'string' || !value) return 'none';
  for (const code of CODES) if (value.includes(`(${code})`)) return code;
  if (value.includes('HTTP 403')) return 'subscription_refused';
  if (value === 'Twitch chat disconnected.') return 'chat_disconnected';
  if (value === 'Twitch chat connection interrupted.') return 'chat_interrupted';
  return 'other';
}

// Construct every persisted field explicitly. Never serialize helper objects,
// raw errors, chat, settings text, accounts or command payloads.
function project(instance, now) {
  const available = instance.available === true;
  const browserObservedAt = available ? sourceTime(instance.browser?.lastSeenAt, now) : null;
  const playbackObservedAt = available ? sourceTime(instance.watch?.checkedAt, now) : null;
  const browserFresh = available && instance.browser?.online === true && fresh(browserObservedAt, now);
  return { state: { helperAvailable: available, chatTokenPresent: available && instance.authorized === true,
    chatConnected: available && instance.connected === true, controlPaused: instance.settings?.paused !== false,
    automaticReplies: available && instance.settings?.autoReply === true, recoveryEnabled: available && instance.settings?.autoResume === true,
    browserFresh, watchEnabled: available && instance.watch?.enabled === true,
    playbackStatus: available && WATCH.has(instance.watch?.status) ? instance.watch.status : 'unknown',
    playbackFresh: browserFresh && instance.watch?.enabled === true && fresh(playbackObservedAt, now),
    coordinationAvailable: available && instance.coordination?.available === true, coordinationPaused: instance.coordination?.paused === true,
    errorCode: errorCode(instance.error, available) }, browserObservedAt, playbackObservedAt };
}

export function createStatusLogger({ directory = fileURLToPath(new URL('../private/', import.meta.url)), now = Date.now,
  warn = message => console.warn(message), io = fs, maxBytes = LIMIT } = {}) {
  if (typeof directory !== 'string' || !Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > LIMIT) throw Error('Invalid status log configuration.');
  const file = join(directory, 'status.jsonl'), previous = new Map();
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
      if (!warned) { warned = true; try { warn('Companion status logging is unavailable. Runtime controls are unchanged.'); } catch {} }
      return false;
    }
  };
  const lifecycle = event => {
    if (!['started', 'stopped'].includes(event)) return false;
    return write({ event, observedAt: new Date(now()).toISOString() });
  };
  const observe = snapshot => {
    if (!Array.isArray(snapshot?.instances)) return false;
    const at = now(); if (!Number.isFinite(at) || at <= 0) return false;
    let ok = true;
    for (const id of IDS) {
      const instance = snapshot.instances.find(value => value?.id === id); if (!instance) continue;
      const value = project(instance, at), signature = JSON.stringify(value.state), old = previous.get(id);
      const event = !old ? 'baseline' : old.signature !== signature ? 'transition' : at - old.at >= CHECKPOINT_MS ? 'checkpoint' : '';
      if (!event) continue;
      if (write({ event, observedAt: new Date(at).toISOString(), profile: id, ...value.state,
        browserObservedAt: value.browserObservedAt, playbackObservedAt: value.playbackObservedAt })) previous.set(id, { signature, at });
      else ok = false;
    }
    return ok;
  };
  return { observe, lifecycle };
}
