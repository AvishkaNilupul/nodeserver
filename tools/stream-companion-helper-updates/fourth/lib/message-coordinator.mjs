import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { messageKey } from '../extension/message-policy.js';

const HOUR = 3_600_000, RETENTION = 14 * 86400_000;
const login = value => typeof value === 'string' && /^[a-z0-9_]{3,25}$/.test(value);
const active = "delivery IN ('pending','confirmed','unknown')";

// The two helpers share only hashes and public routing identifiers here.
// OAuth, pairing, settings and account-owned journals remain separate.
export class MessageCoordinator {
  constructor({ file = join(homedir(), '.local/share/stream-companion/message-coordination.sqlite'), now = Date.now } = {}) {
    this.now = now;
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file, { timeout: 2000 });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS companion_accounts (account TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS contributions (
        reservation_id TEXT PRIMARY KEY, account TEXT NOT NULL, channel TEXT NOT NULL,
        stream_id TEXT NOT NULL, kind TEXT NOT NULL, text_key TEXT NOT NULL,
        reply_id TEXT NOT NULL, at INTEGER NOT NULL, delivery TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS contribution_channel ON contributions(channel, at);
      CREATE INDEX IF NOT EXISTS contribution_broadcast ON contributions(channel, stream_id, kind);`);
  }
  close() { this.db.close(); }
  register(account) {
    if (login(account)) this.db.prepare('INSERT OR IGNORE INTO companion_accounts VALUES (?)').run(account);
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  seed(history = []) {
    this.transaction(() => {
      const insert = this.db.prepare('INSERT OR IGNORE INTO contributions VALUES (?,?,?,?,?,?,?,?,?)');
      for (const item of history) {
        if (!login(item.account) || !login(item.channel) || !Number.isFinite(item.at)
          || item.at < this.now() - RETENTION || item.at > this.now()
          || !['pending', 'confirmed', 'unknown'].includes(item.delivery) || !messageKey(item.text)) continue;
        this.register(item.account);
        insert.run(`seed:${item.account}:${item.channel}:${item.at}`, item.account, item.channel,
          item.streamId || '', item.kind || '', messageKey(item.text), item.replyId || '', item.at, item.delivery);
      }
      this.db.prepare('DELETE FROM contributions WHERE at < ?').run(this.now() - RETENTION);
    });
  }
  snapshot(channel) {
    const accounts = this.db.prepare('SELECT account FROM companion_accounts ORDER BY account').all().map(x => x.account);
    if (!login(channel)) return { textKeys: [], topicStreams: [], replyIds: [], accounts };
    const rows = this.db.prepare(`SELECT text_key, stream_id, kind, reply_id, at FROM contributions
      WHERE channel = ? AND at >= ? AND ${active}`).all(channel, this.now() - RETENTION);
    return {
      textKeys: [...new Set(rows.filter(x => x.at > this.now() - HOUR).map(x => x.text_key))],
      topicStreams: [...new Set(rows.filter(x => x.kind === 'topic').map(x => x.stream_id))],
      replyIds: [...new Set(rows.filter(x => x.at > this.now() - HOUR && x.reply_id).map(x => x.reply_id))], accounts
    };
  }
  reserve({ account, channel, text, streamId = '', kind = '', replyTo = '' }) {
    if (!login(account) || !login(channel) || !messageKey(text)) throw new Error('Invalid coordination intent.');
    return this.transaction(() => {
      this.db.prepare('DELETE FROM contributions WHERE at < ?').run(this.now() - RETENTION);
      const rows = this.db.prepare(`SELECT text_key, stream_id, kind, reply_id, at FROM contributions
        WHERE channel = ? AND ${active}`).all(channel);
      let reason = '';
      if (rows.some(x => x.at > this.now() - HOUR && x.text_key === messageKey(text))) reason = 'A companion already contributed this wording in this channel; staying quiet.';
      else if (kind === 'topic' && rows.some(x => x.kind === 'topic' && x.stream_id === streamId)) reason = 'A companion already asked a category question for this broadcast; waiting for fresh conversation.';
      else if (replyTo && rows.some(x => x.at > this.now() - HOUR && x.reply_id === replyTo)) reason = 'A companion already answered this incoming message; staying quiet.';
      if (reason) return { ok: false, reason };
      const reservationId = randomUUID();
      this.register(account);
      this.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(reservationId,
        account, channel, streamId, kind, messageKey(text), replyTo, this.now(), 'pending');
      return { ok: true, reservationId };
    });
  }
  finish(reservationId, delivery) {
    if (['rejected', 'cancelled'].includes(delivery)) {
      this.db.prepare("DELETE FROM contributions WHERE reservation_id = ? AND delivery = 'pending'").run(reservationId);
    } else {
      const state = delivery === 'confirmed' ? 'confirmed' : 'unknown';
      this.db.prepare("UPDATE contributions SET delivery = CASE WHEN delivery = 'confirmed' THEN delivery ELSE ? END WHERE reservation_id = ?")
        .run(state, reservationId);
    }
  }
}
