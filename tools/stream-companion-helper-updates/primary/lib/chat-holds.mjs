import { readFileSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const login = value => typeof value === 'string' && /^[a-z0-9_]{3,25}$/.test(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
const failure = () => Object.assign(new Error('Chat send safety state could not be saved. Chat is held.'), { status: 503 });
const reason = 'Twitch says this account does not meet the channel’s follower requirement. Automatic chat is held; check Twitch, then use Start to retry.';
const key = (account, channel) => `${account}:${channel}`;

export class ChatSendHolds {
  constructor({ file, now = Date.now, read = readFileSync, write = writeFileSync, rename = renameSync, chmod = chmodSync } = {}) {
    Object.assign(this, { now, read, write, rename, chmod });
    this.file = file instanceof URL ? fileURLToPath(file) : file; this.records = new Map(); this.revisions = new Map(); this.storageError = false;
    try {
      let value;
      if (this.file) { try { const text = this.read(this.file, 'utf8'); if (Buffer.byteLength(text) > 500000) throw Error(); value = JSON.parse(text); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      if (value !== undefined) {
        if (!exact(value, ['version', 'records']) || value.version !== 1 || !Array.isArray(value.records) || value.records.length > 512) throw Error();
        for (const entry of value.records) {
          if (!exact(entry, ['account', 'channel', 'held', 'at']) || !login(entry.account) || !login(entry.channel) || typeof entry.held !== 'boolean'
              || !Number.isSafeInteger(entry.at) || entry.at < 0 || this.records.has(key(entry.account, entry.channel))) throw Error();
          this.records.set(key(entry.account, entry.channel), { ...entry });
        }
      }
      this.persist();
    } catch { this.storageError = true; }
  }
  persist() {
    if (this.storageError) throw failure();
    if (!this.file) return;
    try {
      const temp = `${this.file}.tmp`;
      this.write(temp, JSON.stringify({ version: 1, records: [...this.records.values()] }) + '\n', { mode: 0o600 });
      this.chmod(temp, 0o600); this.rename(temp, this.file); this.chmod(this.file, 0o600);
    } catch { this.storageError = true; throw failure(); }
  }
  status(account, channel) {
    const entry = this.records.get(key(account, channel)), held = this.storageError || entry?.held === true;
    return { account: login(account) ? account : '', channel: login(channel) ? channel : '', held, code: held ? this.storageError ? 'send_hold_storage' : 'followers_only_mode' : '',
      reason: held ? this.storageError ? 'Chat send safety state needs attention. Chat is held.' : reason : '', at: entry?.at || 0 };
  }
  revision(account, channel) { return this.revisions.get(key(account, channel)) || 0; }
  hold(account, channel, expectedRevision) {
    if (!login(account) || !login(channel)) throw failure();
    if (expectedRevision !== undefined && expectedRevision !== this.revision(account, channel)) return false;
    if (this.storageError || !this.records.has(key(account, channel)) && this.records.size >= 512) { this.storageError = true; throw failure(); }
    this.records.set(key(account, channel), { account, channel, held: true, at: this.now() }); this.persist(); return true;
  }
  clear(account, channel) {
    if (!login(account) || !login(channel) || this.storageError) throw failure();
    if (!this.records.has(key(account, channel)) && this.records.size >= 512) { this.storageError = true; throw failure(); }
    const id = key(account, channel); this.revisions.set(id, this.revision(account, channel) + 1);
    this.records.set(id, { account, channel, held: false, at: this.now() }); this.persist();
  }
  recover(history) {
    if (this.storageError) return;
    try {
      for (const attempt of Array.isArray(history) ? history : []) {
        if (attempt?.delivery !== 'rejected' || attempt.reason !== 'followers_only_mode' || !login(attempt.account) || !login(attempt.channel) || (!Number.isSafeInteger(attempt.at) || attempt.at < 0)) continue;
        const previous = this.records.get(key(attempt.account, attempt.channel));
        const at = Number.isSafeInteger(attempt.sendHoldAt) ? attempt.sendHoldAt : attempt.at;
        if (previous && (previous.at >= at || !previous.held && previous.at >= attempt.at)) continue;
        if (this.records.size >= 512 && !previous) throw failure();
        this.records.set(key(attempt.account, attempt.channel), { account: attempt.account, channel: attempt.channel, held: true, at });
      }
      this.persist();
    } catch { this.storageError = true; }
  }
}
