import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ExchangeEngine } from './exchanges.mjs';
import { Director } from './director.mjs';

const HOUR = 3_600_000, RETENTION = 14 * 86400_000;
const active = "delivery IN ('pending','confirmed','unknown')";
const login = x => typeof x === 'string' && /^[a-z0-9_]{3,25}$/.test(x);
const identifier = x => typeof x === 'string' && /^[a-zA-Z0-9_:-]{1,160}$/.test(x);
const fingerprint = x => typeof x === 'string' && /^[a-f0-9]{16}$/.test(x);
const iso = x => Number.isFinite(x) && x > 0 ? new Date(x).toISOString() : null;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const proposalKey = p => JSON.stringify([p.channel, p.streamId || '', p.kind || '', p.textKey, p.replyId || '', p.replyAt || 0, p.exchangeId || '']);

export class HostStore {
  constructor({ file = join(homedir(), '.local/share/stream-companion/message-coordination.sqlite'), clients = [], now = Date.now, policy = {}, random = Math.random, directorEnabled = false } = {}) {
    this.now = now; this.startedAt = now();
    this.policy = { channelGapMs: 180000, maxAttemptsPerHour: 6, leaseMs: 20000, presenceMs: 45000, ...policy };
    if (!clients.length || new Set(clients.map(x => x.id)).size !== clients.length || new Set(clients.map(x => x.account)).size !== clients.length) throw error('Unique host clients are required.');
    for (const c of clients) if (!identifier(c.id) || !login(c.account)) throw error('Invalid host client.');
    this.clients = new Map(clients.map(c => [c.id, { id: c.id, account: c.account, name: String(c.name || c.id).slice(0, 80) }]));
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file, { timeout: 2000 });
    if (file !== ':memory:') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS companion_accounts (account TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS contributions (reservation_id TEXT PRIMARY KEY, account TEXT NOT NULL,
        channel TEXT NOT NULL, stream_id TEXT NOT NULL, kind TEXT NOT NULL, text_key TEXT NOT NULL,
        reply_id TEXT NOT NULL, at INTEGER NOT NULL, delivery TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS contribution_channel ON contributions(channel,at);
      CREATE INDEX IF NOT EXISTS contribution_broadcast ON contributions(channel,stream_id,kind);
      CREATE TABLE IF NOT EXISTS host_clients (client_id TEXT PRIMARY KEY, account TEXT NOT NULL,
        name TEXT NOT NULL, channel TEXT NOT NULL DEFAULT '', connected INTEGER NOT NULL DEFAULT 0,
        ready INTEGER NOT NULL DEFAULT 0, playback TEXT NOT NULL DEFAULT 'unknown', playback_at INTEGER NOT NULL DEFAULT 0,
        last_seen INTEGER NOT NULL DEFAULT 0, last_decision TEXT NOT NULL DEFAULT '', pending_completions INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS host_controls (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO host_controls VALUES ('paused','false');
      CREATE TABLE IF NOT EXISTS host_permits (reservation_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,
        client_id TEXT NOT NULL,account TEXT NOT NULL,channel TEXT NOT NULL,stream_id TEXT NOT NULL,kind TEXT NOT NULL,
        text_key TEXT NOT NULL,reply_id TEXT NOT NULL,at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        state TEXT NOT NULL,started_at INTEGER NOT NULL DEFAULT 0,finished_at INTEGER NOT NULL DEFAULT 0,
        UNIQUE(client_id,request_id));
      CREATE INDEX IF NOT EXISTS host_permit_channel ON host_permits(channel,state,expires_at);
      CREATE TABLE IF NOT EXISTS host_proposals (client_id TEXT NOT NULL,channel TEXT NOT NULL,opportunity TEXT NOT NULL,
        kind TEXT NOT NULL,reply_id TEXT NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,state TEXT NOT NULL,
        reason TEXT NOT NULL,PRIMARY KEY(client_id,channel));
      CREATE TABLE IF NOT EXISTS host_events (id INTEGER PRIMARY KEY,at INTEGER NOT NULL,account TEXT NOT NULL,
        channel TEXT NOT NULL,type TEXT NOT NULL,reason TEXT NOT NULL,delivery TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL DEFAULT '');`);
    for (const table of ['host_permits', 'host_proposals']) if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(x => x.name === 'reply_at')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN reply_at INTEGER NOT NULL DEFAULT 0`);
    for (const [table, column, definition] of [['host_clients', 'exchange_stream_id', "TEXT NOT NULL DEFAULT ''"], ['host_clients', 'exchange_checked_at', 'INTEGER NOT NULL DEFAULT 0'], ['host_clients', 'last_human_at', 'INTEGER NOT NULL DEFAULT 0'], ['host_permits', 'exchange_id', "TEXT NOT NULL DEFAULT ''"]]) {
      if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(x => x.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
    const put = this.db.prepare('INSERT INTO host_clients(client_id,account,name) VALUES (?,?,?) ON CONFLICT(client_id) DO UPDATE SET account=excluded.account,name=excluded.name');
    for (const c of this.clients.values()) { put.run(c.id, c.account, c.name); this.db.prepare('INSERT OR IGNORE INTO companion_accounts VALUES (?)').run(c.account); }
    this.transaction(() => this.normalizeLegacySeeds());
    this.exchanges = new ExchangeEngine(this, random);
    if (directorEnabled) this.director = new Director(this, { random });
  }
  close() { this.db.close(); }
  normalizeLegacySeeds() {
    // The previous helper seeded its history in addition to its original
    // reservation. Fold those two representations of one attempt together.
    const rows = this.db.prepare('SELECT * FROM contributions WHERE reservation_id NOT IN (SELECT reservation_id FROM host_permits) ORDER BY at').all();
    const rank = { pending: 0, unknown: 1, rejected: 2, confirmed: 3 };
    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify([row.account, row.channel, row.stream_id, row.kind, row.text_key, row.reply_id]);
      const previous = groups.get(key);
      if (previous && row.at - previous.at <= 1000 && (row.reservation_id.startsWith('seed:') || previous.reservation_id.startsWith('seed:'))) {
        const keep = row.reservation_id.startsWith('seed:') ? row : previous;
        const remove = keep === row ? previous : row;
        const delivery = (rank[row.delivery] ?? -1) >= (rank[previous.delivery] ?? -1) ? row.delivery : previous.delivery;
        this.db.prepare('UPDATE contributions SET at=?,delivery=? WHERE reservation_id=?').run(Math.max(row.at, previous.at), delivery, keep.reservation_id);
        this.db.prepare('DELETE FROM contributions WHERE reservation_id=?').run(remove.reservation_id);
        groups.set(key, { ...keep, at: Math.max(row.at, previous.at), delivery });
      } else groups.set(key, row);
    }
  }
  transaction(fn) {
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.inTransaction = true;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this.inTransaction = false; }
  }
  client(id) {
    if (!this.clients.has(id)) throw error('Unknown coordination client.', 403);
    return this.db.prepare('SELECT * FROM host_clients WHERE client_id=?').get(id);
  }
  get paused() { return this.db.prepare("SELECT value FROM host_controls WHERE key='paused'").get().value === 'true'; }
  online(c) { return c.last_seen > 0 && c.last_seen >= this.now() - this.policy.presenceMs; }
  eligible(c, automatic = true) {
    return this.online(c) && !!c.connected && (!automatic || !!c.ready && c.playback_at >= this.now() - this.policy.presenceMs && ['playing', 'ad'].includes(c.playback));
  }
  event(account, channel, type, reason, delivery = '', kind = '') {
    const recent = this.db.prepare('SELECT * FROM host_events WHERE account=? AND channel=? ORDER BY id DESC LIMIT 1').get(account, channel);
    if (recent && recent.type === type && recent.reason === reason && recent.delivery === delivery && recent.at > this.now() - 10000) return;
    this.db.prepare('INSERT INTO host_events(at,account,channel,type,reason,delivery,kind) VALUES (?,?,?,?,?,?,?)').run(this.now(), account, channel, type, reason, delivery, kind);
    this.db.exec('DELETE FROM host_events WHERE id NOT IN (SELECT id FROM host_events ORDER BY id DESC LIMIT 500)');
  }
  expire() {
    this.db.prepare("UPDATE host_permits SET state='expired',finished_at=? WHERE state='leased' AND expires_at<=?").run(this.now(), this.now());
    const uncertain = this.db.prepare("SELECT * FROM host_permits WHERE state='submitting' AND started_at<=?").all(this.now() - 120000);
    for (const p of uncertain) {
      this.db.prepare("UPDATE host_permits SET state='unknown' WHERE reservation_id=? AND state='submitting'").run(p.reservation_id);
      this.db.prepare("UPDATE contributions SET delivery='unknown' WHERE reservation_id=? AND delivery='pending'").run(p.reservation_id);
      const reason = 'Delivery is uncertain; the contribution will not be retried.';
      this.db.prepare('UPDATE host_clients SET last_decision=? WHERE client_id=?').run(reason, p.client_id);
      this.event(p.account, p.channel, 'uncertain', reason, 'unknown', p.kind);
      this.exchanges?.outcome(p, 'unknown');
      this.director?.finished(p, 'unknown');
    }
    this.db.prepare('DELETE FROM contributions WHERE at<?').run(this.now() - RETENTION);
    // Keep permit/request outcomes for idempotent completion replay even after
    // an extended outage. Contribution/content retention is independent.
    this.db.prepare('DELETE FROM host_proposals WHERE last_at<?').run(this.now() - 60000);
    this.exchanges?.tick();
    this.director?.expire();
  }
  snapshot(clientId, channel) {
    return this.transaction(() => this._snapshot(clientId, channel));
  }
  _snapshot(clientId, channel) {
    this.client(clientId);
    const exchange = this.exchanges?.offer(clientId, channel);
    const rows = login(channel) ? this.db.prepare(`SELECT * FROM contributions WHERE channel=? AND at>=? AND ${active}`).all(channel, this.now() - RETENTION) : [];
    const leases = login(channel) ? this.db.prepare("SELECT * FROM host_permits WHERE channel=? AND state='leased' AND expires_at>?").all(channel, this.now()) : [];
    return { available: true, paused: this.paused, reason: this.paused ? 'Central coordination is paused.' : '',
      textKeys: [...new Set([...rows.filter(x => x.at > this.now() - HOUR), ...leases].map(x => x.text_key))],
      topicStreams: [...new Set([...rows, ...leases].filter(x => x.kind === 'topic').map(x => x.stream_id))],
      replyIds: [...new Set([...rows.filter(x => x.at > this.now() - HOUR), ...leases].filter(x => x.reply_id).map(x => x.reply_id))],
      accounts: [...this.clients.values()].map(x => x.account).sort(), ...(exchange ? { exchange } : {}),
      ...(this.director ? { director: this.director.internal(clientId) } : {}) };
  }
  sync(clientId, body = {}) {
    return this.transaction(() => {
      this.expire(); const c = this.client(clientId);
      if (body.account !== undefined && body.account !== c.account) throw error('Account does not match this client.', 403);
      const channel = body.channel || ''; if (channel && !login(channel)) throw error('Invalid channel.');
      const playback = ['playing', 'ad', 'paused', 'buffering', 'stalled', 'offline', 'ended', 'error', 'unknown'].includes(body.playback?.status) ? body.playback.status : 'unknown';
      const at = Number.isFinite(body.playback?.checkedAt) && body.playback.checkedAt <= this.now() + 5000 ? body.playback.checkedAt : 0;
      const connected = body.connected === true && !!channel;
      const ready = connected && body.ready === true && at >= this.now() - this.policy.presenceMs && ['playing', 'ad'].includes(playback);
      const pending = Number.isInteger(body.pendingCompletions) ? Math.max(0, Math.min(1000, body.pendingCompletions)) : 0;
      this.db.prepare('UPDATE host_clients SET channel=?,connected=?,ready=?,playback=?,playback_at=?,last_seen=?,pending_completions=? WHERE client_id=?')
        .run(channel, Number(connected), Number(ready), playback, at, this.now(), pending, clientId);
      const context = this.director ? this.director.exchangeContext(clientId, ready) : this.exchanges.context(body, ready);
      this.db.prepare('UPDATE host_clients SET exchange_stream_id=?,exchange_checked_at=?,last_human_at=? WHERE client_id=?').run(context.streamId, context.checkedAt, context.lastHumanAt, clientId);
      for (const lease of this.db.prepare("SELECT * FROM host_permits WHERE client_id=? AND state='leased'").all(clientId)) {
        if (!connected || lease.channel !== channel || (!!lease.kind || !!lease.reply_id) && !ready) this._finish(clientId, { reservationId: lease.reservation_id, delivery: 'cancelled', submitted: false });
      }
      this.db.prepare("UPDATE host_proposals SET state='cancelled',reason='Companion changed channel or disconnected.' WHERE client_id=? AND (channel<>? OR ?=0) AND state='waiting'")
        .run(clientId, channel, Number(connected));
      if (c.channel !== channel || !!c.connected !== connected || !!c.ready !== ready || c.playback !== playback) this.event(c.account, channel, 'presence', ready ? 'Ready for coordinated chat.' : connected ? 'Connected; automatic chat is waiting for fresh playback.' : 'Companion is disconnected.');
      if (body.seed !== undefined && (!Array.isArray(body.seed) || body.seed.length > 256)) throw error('Invalid history seed.');
      for (const seed of body.seed || []) {
        if (!seed || !login(seed.channel) || !fingerprint(seed.textKey) || !Number.isFinite(seed.at) || seed.at < this.now() - RETENTION || seed.at > this.now() + 5000
          || !['pending', 'confirmed', 'unknown', 'rejected'].includes(seed.delivery)) continue;
        if (seed.coordinationId) {
          const permit = this.db.prepare('SELECT * FROM host_permits WHERE reservation_id=?').get(seed.coordinationId);
          if (permit && permit.client_id !== clientId) throw error('History does not belong to this client.', 403);
          if (permit) {
            if (permit.channel !== seed.channel || permit.text_key !== seed.textKey) throw error('History does not match its permit.', 409);
            if (seed.delivery !== 'pending') this._finish(clientId, { reservationId: permit.reservation_id, delivery: seed.delivery, submitted: true });
            continue;
          }
        }
        this.db.prepare('INSERT OR IGNORE INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(`seed:${c.account}:${seed.channel}:${seed.at}`, c.account, seed.channel,
          typeof seed.streamId === 'string' ? seed.streamId.slice(0, 128) : '', typeof seed.kind === 'string' ? seed.kind.slice(0, 24) : '', seed.textKey,
          typeof seed.replyId === 'string' ? seed.replyId.slice(0, 160) : '', seed.at, seed.delivery);
      }
      return { ok: true, snapshot: this.snapshot(clientId, channel) };
    });
  }
  budget(channel) {
    const rows = this.db.prepare("SELECT * FROM contributions WHERE channel=? AND at>? AND delivery IN ('pending','confirmed','unknown','rejected') ORDER BY at").all(channel, this.now() - HOUR);
    return { rows, count: rows.length, last: rows.at(-1), next: Math.max(0, (rows.at(-1)?.at || 0) + this.policy.channelGapMs) };
  }
  hold(c, proposal, code, reason, retryAt) {
    this.db.prepare('UPDATE host_clients SET last_decision=? WHERE client_id=?').run(reason, c.client_id);
    this.db.prepare('UPDATE host_proposals SET state=?,reason=? WHERE client_id=? AND channel=?')
      .run(['duplicate', 'topic_taken', 'answered', 'target_expired', 'exchange_invalid', 'exchange_cancelled', 'exchange_consumed'].includes(code) ? 'blocked' : 'waiting', reason, c.client_id, proposal.channel);
    this.event(c.account, proposal.channel, 'waiting', reason, '', proposal.kind);
    return { ok: false, code, reason, ...(retryAt ? { retryAt } : {}), snapshot: this.snapshot(c.client_id, proposal.channel) };
  }
  reserve(clientId, body = {}) {
    return this.transaction(() => {
      this.expire(); const c = this.client(clientId);
      if (body.account !== undefined && body.account !== c.account) throw error('Account does not match this client.', 403);
      if (this.director) this.director.validatePlan(clientId, body);
      if (!identifier(body.requestId) || !login(body.channel) || !fingerprint(body.textKey)
        || !['', 'greeting', 'topic', 'conversation', 'exchange', 'event'].includes(body.kind || '')
        || typeof (body.streamId || '') !== 'string' || (body.streamId || '').length > 128
        || (body.kind && !identifier(body.streamId)) || body.replyId && !identifier(body.replyId)
        || body.replyAt !== undefined && (!Number.isFinite(body.replyAt) || body.replyAt <= 0 || body.replyAt > this.now() + 5000)) throw error('Invalid turn proposal.');
      if (body.kind === 'exchange' ? !identifier(body.exchangeId) || !/^\d{1,128}$/.test(body.streamId) || !!body.replyId || !!body.replyAt : body.exchangeId !== undefined) throw error('Invalid exchange proposal.');
      const p = { channel: body.channel, streamId: body.streamId || '', kind: body.kind || '', textKey: body.textKey, replyId: body.replyId || '', replyAt: body.replyAt || 0, exchangeId: body.exchangeId || '' };
      const existing = this.db.prepare('SELECT * FROM host_permits WHERE client_id=? AND request_id=?').get(clientId, body.requestId);
      if (existing) {
        const same = proposalKey(p) === proposalKey({ channel: existing.channel, streamId: existing.stream_id, kind: existing.kind, textKey: existing.text_key, replyId: existing.reply_id, replyAt: existing.reply_at, exchangeId: existing.exchange_id });
        if (!same) throw error('A request identifier cannot change its proposal.', 409);
        if (existing.state === 'leased') return { ok: true, reservationId: existing.reservation_id, expiresAt: existing.expires_at, snapshot: this.snapshot(clientId, p.channel) };
        return { ok: false, code: 'already_used', reason: 'This turn permit is no longer available.', snapshot: this.snapshot(clientId, p.channel) };
      }
      const oldProposal = this.db.prepare('SELECT * FROM host_proposals WHERE client_id=? AND channel=?').get(clientId, p.channel);
      const firstAt = oldProposal?.opportunity === proposalKey(p) ? oldProposal.first_at : this.now();
      this.db.prepare('INSERT INTO host_proposals(client_id,channel,opportunity,kind,reply_id,first_at,last_at,state,reason,reply_at) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_id,channel) DO UPDATE SET opportunity=excluded.opportunity,kind=excluded.kind,reply_id=excluded.reply_id,first_at=excluded.first_at,last_at=excluded.last_at,state=excluded.state,reason=excluded.reason,reply_at=excluded.reply_at')
        .run(clientId, p.channel, proposalKey(p), p.kind, p.replyId, firstAt, this.now(), 'waiting', 'Waiting for a turn.', p.replyAt);
      if (this.paused) return this.hold(c, p, 'paused', 'Central coordination is paused.');
      if (c.channel !== p.channel || !this.eligible(c, !!p.kind || !!p.replyId)) return this.hold(c, p, 'not_ready', 'This companion needs a fresh connection and playback observation.');
      if (p.replyAt && p.replyAt < this.now() - 45000) return this.hold(c, p, 'target_expired', 'This incoming message is no longer fresh.');
      if (p.kind === 'exchange') {
        const check = this.exchanges.validate(c, p);
        if (!check.ok) return this.hold(c, p, check.code, check.reason);
      }
      const snapshot = this.snapshot(clientId, p.channel);
      if (snapshot.textKeys.includes(p.textKey)) return this.hold(c, p, 'duplicate', 'A companion already contributed this wording in this channel.');
      if (p.kind === 'topic' && snapshot.topicStreams.includes(p.streamId)) return this.hold(c, p, 'topic_taken', 'A companion already asked a category question for this broadcast.');
      if (p.replyId && snapshot.replyIds.includes(p.replyId)) return this.hold(c, p, 'answered', 'A companion already answered this incoming message.');
      const busy = this.db.prepare("SELECT * FROM host_permits WHERE channel=? AND state='leased' ORDER BY at DESC LIMIT 1").get(p.channel);
      if (busy) return this.hold(c, p, 'busy', 'Another companion is completing its turn.', busy.state === 'leased' ? busy.expires_at : undefined);
      const budget = this.budget(p.channel);
      if (budget.count >= this.policy.maxAttemptsPerHour) return this.hold(c, p, 'channel_budget', 'The shared channel hourly limit has been reached.', budget.rows[0].at + HOUR + 1);
      if (budget.rows.length && budget.next > this.now()) return this.hold(c, p, 'channel_cooldown', 'Waiting between shared channel contributions.', budget.next);
      const candidates = this.db.prepare("SELECT p.*,c.account,c.connected,c.ready,c.last_seen,c.playback,c.playback_at FROM host_proposals p JOIN host_clients c USING(client_id) WHERE p.channel=? AND c.channel=p.channel AND p.state='waiting' AND p.last_at>?").all(p.channel, this.now() - 30000)
        .filter(x => this.clients.has(x.client_id) && this.eligible(x, !!x.kind || !!x.reply_id) && (!x.reply_at || x.reply_at >= this.now() - 45000)
          // Only this exact validated offered line can be an exchange candidate.
          // A held stale/foreign line must not become an idle fairness blocker.
          && (x.kind !== 'exchange' || p.kind === 'exchange' && x.client_id === clientId));
      const priority = x => x.reply_id && x.kind !== 'conversation' || !x.kind ? 0 : x.kind === 'conversation' ? 1 : x.kind === 'event' ? 2 : x.kind === 'greeting' ? 3 : x.kind === 'topic' ? 4 : 5;
      candidates.sort((a, b) => priority(a) - priority(b) || Number(a.account === budget.last?.account) - Number(b.account === budget.last?.account) || a.first_at - b.first_at || a.client_id.localeCompare(b.client_id));
      if (candidates[0]?.client_id !== clientId) return this.hold(c, p, 'turn_wait', 'Another ready companion has the next turn.');
      const reservationId = randomUUID(), expiresAt = this.now() + this.policy.leaseMs;
      this.db.prepare('INSERT INTO host_permits(reservation_id,request_id,client_id,account,channel,stream_id,kind,text_key,reply_id,at,expires_at,state,reply_at,exchange_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(reservationId, body.requestId, clientId, c.account, p.channel, p.streamId, p.kind, p.textKey, p.replyId, this.now(), expiresAt, 'leased', p.replyAt, p.exchangeId);
      if (p.kind === 'exchange') this.exchanges.leased(p.exchangeId, reservationId);
      if (this.director) this.director.leased(body.planId, reservationId);
      this.db.prepare("UPDATE host_proposals SET state='leased',reason='Turn reserved.' WHERE client_id=? AND channel=?").run(clientId, p.channel);
      this.db.prepare("UPDATE host_clients SET last_decision='Turn reserved.' WHERE client_id=?").run(clientId);
      this.event(c.account, p.channel, 'reserved', 'Turn reserved; waiting for the helper to begin.', '', p.kind);
      return { ok: true, reservationId, expiresAt, snapshot: this.snapshot(clientId, p.channel) };
    });
  }
  owned(clientId, reservationId) {
    this.client(clientId); if (!identifier(reservationId)) throw error('Invalid turn permit.');
    const permit = this.db.prepare('SELECT * FROM host_permits WHERE reservation_id=?').get(reservationId);
    if (!permit || permit.client_id !== clientId) throw error('This turn does not belong to this client.', 403);
    return permit;
  }
  begin(clientId, body = {}) {
    const { reservationId } = body;
    return this.transaction(() => {
      this.expire(); const p = this.owned(clientId, reservationId), c = this.client(clientId);
      const deny = (code, reason) => ({ ok: false, code, reason });
      if (p.state === 'expired') return deny('expired', 'The unused turn expired before submission.');
      if (p.state === 'cancelled') return deny(this.paused ? 'paused' : 'not_ready', 'The unused turn was cancelled before a Twitch request.');
      if (p.state !== 'leased') return deny('already_used', 'This turn cannot be started again.');
      if (this.director) this.director.validatePlan(clientId, { ...body, reservationId }, true);
      if (this.paused) return deny('paused', 'Central coordination is paused.');
      if (c.channel !== p.channel || !this.eligible(c, !!p.kind || !!p.reply_id)) return deny('not_ready', 'This companion is no longer ready.');
      if (p.reply_at && p.reply_at < this.now() - 45000) return deny('target_expired', 'This incoming message is no longer fresh.');
      if (p.kind === 'exchange') { const check = this.exchanges.validate(c, p, true); if (!check.ok) return deny(check.code, check.reason); }
      const published = this.db.prepare(`SELECT * FROM contributions WHERE channel=? AND at>=? AND ${active}`).all(p.channel, this.now() - RETENTION);
      if (published.some(x => x.at > this.now() - HOUR && x.text_key === p.text_key)
        || p.kind === 'topic' && published.some(x => x.kind === 'topic' && x.stream_id === p.stream_id)
        || p.reply_id && published.some(x => x.at > this.now() - HOUR && x.reply_id === p.reply_id)) return deny('duplicate', 'Another contribution now covers this wording or conversation opportunity.');
      const budget = this.budget(p.channel);
      if (budget.count >= this.policy.maxAttemptsPerHour || budget.rows.length && budget.next > this.now()) return deny('channel_limit', 'The shared channel limit changed before this turn began.');
      this.db.prepare("UPDATE host_permits SET state='submitting',started_at=? WHERE reservation_id=? AND state='leased'").run(this.now(), reservationId);
      if (p.kind === 'exchange') this.exchanges.started(p.exchange_id);
      this.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(reservationId, p.account, p.channel, p.stream_id, p.kind, p.text_key, p.reply_id, this.now(), 'pending');
      this.director?.started(p);
      this.db.prepare("UPDATE host_clients SET last_decision='Twitch submission started.' WHERE client_id=?").run(clientId);
      this.event(p.account, p.channel, 'submitting', 'Helper authorized for one Twitch submission.', 'pending', p.kind);
      return { ok: true };
    });
  }
  _finish(clientId, { reservationId, delivery, submitted, outcome } = {}) {
    const p = this.owned(clientId, reservationId);
    if (!['confirmed', 'rejected', 'unknown', 'cancelled'].includes(delivery)) throw error('Invalid delivery outcome.');
    if (delivery === 'cancelled' && submitted !== false) throw error('Cancellation must certify no Twitch request.');
    if (outcome !== undefined && (!outcome || typeof outcome !== 'object' || Array.isArray(outcome) || Object.keys(outcome).some(key => !['at', 'messageId', 'reason'].includes(key))
      || outcome.at !== undefined && (!Number.isFinite(outcome.at) || outcome.at < 0 || outcome.at > this.now() + 5000)
      || outcome.messageId !== undefined && (typeof outcome.messageId !== 'string' || outcome.messageId.length > 160)
      || outcome.reason !== undefined && (typeof outcome.reason !== 'string' || outcome.reason.length > 500))) throw error('Invalid delivery metadata.');
    if (['confirmed', 'rejected', 'cancelled'].includes(p.state)) { this.director?.finished(p, p.state, outcome); return { ok: true, delivery: p.state }; }
    if (delivery !== 'cancelled' && !['submitting', 'unknown'].includes(p.state)) throw error('This turn did not start a Twitch submission.', 409);
    this.db.prepare('UPDATE host_permits SET state=?,finished_at=? WHERE reservation_id=?').run(delivery, this.now(), reservationId);
    this.db.prepare('UPDATE contributions SET delivery=? WHERE reservation_id=?').run(delivery, reservationId);
    const reason = delivery === 'confirmed' ? 'Twitch confirmed delivery.' : delivery === 'rejected' ? 'Twitch rejected this submission.' : delivery === 'cancelled' ? 'Turn cancelled before any Twitch request.' : 'Delivery is uncertain; the contribution will not be retried.';
    this.db.prepare('UPDATE host_clients SET last_decision=? WHERE client_id=?').run(reason, clientId);
    this.db.prepare('UPDATE host_proposals SET state=?,reason=? WHERE client_id=? AND channel=?').run(delivery, reason, clientId, p.channel);
    this.event(p.account, p.channel, 'finished', reason, delivery, p.kind);
    this.exchanges?.outcome(p, delivery);
    this.director?.finished(p, delivery, outcome);
    return { ok: true, delivery };
  }
  finish(clientId, body) { return this.transaction(() => this._finish(clientId, body)); }
  setPaused(paused) {
    if (typeof paused !== 'boolean') throw error('A pause setting is required.');
    return this.transaction(() => {
      this.db.prepare("UPDATE host_controls SET value=? WHERE key='paused'").run(String(paused));
      if (paused) for (const p of this.db.prepare("SELECT * FROM host_permits WHERE state='leased'").all()) this._finish(p.client_id, { reservationId: p.reservation_id, delivery: 'cancelled', submitted: false });
      if (paused) this.director?.cancelUnused('Central coordination paused.');
      this.exchanges.tick();
      this.event('', '', 'control', paused ? 'Central coordination paused.' : 'Central coordination resumed.');
      return { ok: true, paused };
    });
  }
  setExchangesEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw error('An exchange setting is required.');
    return this.transaction(() => this.exchanges.setEnabled(enabled));
  }
  status() {
    this.transaction(() => this.expire());
    const clients = [...this.clients.values()].map(c => {
      const row = this.client(c.id), online = this.online(row);
      return { ...c, channel: row.channel, connected: online && !!row.connected, ready: !this.paused && this.eligible(row), online,
        lastSeenAt: iso(row.last_seen), playback: online && row.playback_at >= this.now() - this.policy.presenceMs ? row.playback : 'unknown',
        lastDecision: online ? row.last_decision || (row.ready ? 'Ready for coordinated chat.' : 'Waiting for the companion.') : 'Waiting for a fresh heartbeat.', pendingCompletions: row.pending_completions };
    });
    const names = new Set(clients.map(c => c.channel).filter(login));
    for (const r of this.db.prepare('SELECT DISTINCT channel FROM contributions WHERE at>?').all(this.now() - HOUR)) names.add(r.channel);
    const channels = [...names].sort().map(channel => {
      const budget = this.budget(channel);
      const permit = this.db.prepare("SELECT * FROM host_permits WHERE channel=? AND (state='submitting' OR state='leased' AND expires_at>?) ORDER BY at DESC LIMIT 1").get(channel, this.now());
      const next = budget.count >= this.policy.maxAttemptsPerHour ? Math.max(budget.next, budget.rows[0].at + HOUR + 1) : budget.next;
      return { channel, nextTurnAt: next > this.now() ? iso(next) : null, attemptsLastHour: budget.count,
        activeSpeaker: permit?.account || null, waiting: this.db.prepare("SELECT c.account,p.kind,p.reason FROM host_proposals p JOIN host_clients c USING(client_id) WHERE p.channel=? AND p.state='waiting' AND p.last_at>? AND (p.reply_at=0 OR p.reply_at>=?)").all(channel, this.now() - 30000, this.now() - 45000).map(x => ({ ...x })) };
    });
    return { version: '1.0.0', updatedAt: new Date(this.now()).toISOString(), paused: this.paused,
      host: { health: 'ready', uptimeSeconds: Math.floor((this.now() - this.startedAt) / 1000) },
      exchanges: this.transaction(() => this.exchanges.status()),
      policy: { channelGapMs: this.policy.channelGapMs, maxAttemptsPerHour: this.policy.maxAttemptsPerHour, leaseMs: this.policy.leaseMs }, clients, channels,
      events: this.db.prepare('SELECT * FROM host_events ORDER BY id DESC LIMIT 80').all().map(e => ({ id: e.id, at: iso(e.at), account: e.account, channel: e.channel, type: e.type, reason: e.reason, delivery: e.delivery || undefined, kind: e.kind || undefined })) };
  }
}
