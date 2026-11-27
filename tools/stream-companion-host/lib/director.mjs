import { randomUUID } from 'node:crypto';
import { defaultBank, validateBank, upgradeBankForFourth, renderBankLine, digest, opaque, exact, record, failure, PROFILE_IDS, REPLY_CATEGORIES } from './bank.mjs';
import { messageKey, SCENES } from './exchanges.mjs';
import { localReply, normalizeStreamContext } from './reply-policy.mjs';
import { validateReply, replyOpportunity } from './text-policy.mjs';

const LOGIN = /^[a-z0-9_]{3,25}$/;
const ID = /^[A-Za-z0-9_:-]{1,160}$/;
const active = new Set(['offered', 'leased', 'generating', 'submitting', 'unknown']);
const outcomes = new Set(['pending', 'confirmed', 'rejected', 'unknown', 'cancelled']);
const rank = { pending: 0, unknown: 1, cancelled: 2, rejected: 3, confirmed: 4 };
const safe = (value, max = 300) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
const bots = new Set(['nightbot', 'moobot', 'streamelements', 'streamlabs', 'fossabot', 'wizebot', 'botisimo', 'commanderroot', 'sery_bot', 'serybot', 'soundalerts', 'pretzelrocks']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validBinding = value => exact(value, ['generation', 'sessionId', 'settingsRevision']) && opaque(value.generation) && opaque(value.sessionId)
  && Number.isSafeInteger(value.settingsRevision) && value.settingsRevision >= 0;
const timestamp = value => Number.isFinite(value) && value >= 0;

export class Director {
  constructor(store, { random = Math.random } = {}) {
    this.s = store; this.db = store.db; this.random = random; this.observations = new Map();
    this.epoch = randomUUID();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS director_banks(revision INTEGER PRIMARY KEY,bank_json TEXT NOT NULL,at INTEGER NOT NULL,request_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS director_mutations(request_id TEXT PRIMARY KEY,digest TEXT NOT NULL,result_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS director_profiles(client_id TEXT PRIMARY KEY,seeded INTEGER NOT NULL DEFAULT 0,edited INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS director_import_sources(client_id TEXT NOT NULL,source TEXT NOT NULL,import_id TEXT NOT NULL,next_page INTEGER NOT NULL DEFAULT 0,complete INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(client_id,source));
      CREATE TABLE IF NOT EXISTS director_import_pages(client_id TEXT NOT NULL,source TEXT NOT NULL,import_id TEXT NOT NULL,page INTEGER NOT NULL,digest TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(client_id,source,import_id,page));
      CREATE TABLE IF NOT EXISTS director_import_records(client_id TEXT NOT NULL,source TEXT NOT NULL,record_id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(client_id,source,record_id));
      CREATE TABLE IF NOT EXISTS director_opportunities(key TEXT PRIMARY KEY,account TEXT NOT NULL,channel TEXT NOT NULL,stream_id TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,state TEXT NOT NULL,owner_plan TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS director_plans(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,account TEXT NOT NULL,channel TEXT NOT NULL,opportunity TEXT NOT NULL,state TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,reason TEXT NOT NULL DEFAULT '',reservation_id TEXT NOT NULL DEFAULT '',request_id TEXT NOT NULL DEFAULT '',generation_id TEXT NOT NULL DEFAULT '',mode TEXT NOT NULL DEFAULT '',target_key TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS director_plan_client ON director_plans(client_id,state);
      CREATE TABLE IF NOT EXISTS director_history(id INTEGER PRIMARY KEY,attempt_id TEXT NOT NULL UNIQUE,client_id TEXT NOT NULL,account TEXT NOT NULL,channel TEXT NOT NULL,stream_id TEXT NOT NULL,kind TEXT NOT NULL,text TEXT,text_key TEXT NOT NULL,delivery TEXT NOT NULL,source TEXT NOT NULL,at INTEGER NOT NULL,updated_at INTEGER NOT NULL,submitted INTEGER NOT NULL,category TEXT NOT NULL DEFAULT '',reply_id TEXT NOT NULL DEFAULT '',reply_to TEXT NOT NULL DEFAULT '',message_id TEXT NOT NULL DEFAULT '',reason TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS director_history_account ON director_history(client_id,id);
      CREATE TABLE IF NOT EXISTS director_scenes(content_key TEXT PRIMARY KEY,scene_id TEXT NOT NULL UNIQUE,lines_json TEXT NOT NULL);
    `);
    if (!this.db.prepare('PRAGMA table_info(director_opportunities)').all().some(x => x.name === 'owner_plan')) this.db.exec("ALTER TABLE director_opportunities ADD COLUMN owner_plan TEXT NOT NULL DEFAULT ''");
    if (!this.db.prepare('PRAGMA table_info(director_plans)').all().some(x => x.name === 'target_key')) this.db.exec("ALTER TABLE director_plans ADD COLUMN target_key TEXT NOT NULL DEFAULT ''");
    this.s.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM director_banks LIMIT 1').get()) this.db.prepare('INSERT INTO director_banks VALUES (1,?,?,?)').run(JSON.stringify(validateBank(defaultBank())), this.s.now(), 'initial-defaults');
      const current = this.bank(), upgraded = upgradeBankForFourth(current.bank);
      if (upgraded) this.db.prepare('INSERT INTO director_banks VALUES (?,?,?,?)').run(current.revision + 1, JSON.stringify(upgraded), this.s.now(), 'migration/fourth/v1');
      for (const c of this.s.clients.values()) this.db.prepare('INSERT OR IGNORE INTO director_profiles(client_id) VALUES (?)').run(c.id);
      for (const scene of SCENES) this.db.prepare('INSERT OR IGNORE INTO director_scenes VALUES (?,?,?)').run(digest(JSON.stringify(scene.lines)), scene.id, JSON.stringify(scene.lines));
      this.registerScenes(this.bank().bank);
      this.db.prepare("UPDATE director_plans SET state='cancelled',reason='Unused work cancelled after host restart.',updated_at=? WHERE state IN ('offered','leased','generating')").run(this.s.now());
      // Existing leases were never provider requests; preserve submitting permits.
      for (const p of this.db.prepare("SELECT p.* FROM host_permits p JOIN director_plans d ON d.reservation_id=p.reservation_id WHERE p.state='leased' AND d.state='cancelled'").all()) this.s._finish(p.client_id, { reservationId: p.reservation_id, delivery: 'cancelled', submitted: false });
      for (const row of this.db.prepare('SELECT * FROM contributions').all()) this.legacyContribution(row);
    });
  }
  bank() {
    const row = this.db.prepare('SELECT * FROM director_banks ORDER BY revision DESC LIMIT 1').get();
    return { revision: row.revision, bank: JSON.parse(row.bank_json), requestId: row.request_id };
  }
  profile(clientId) {
    this.s.client(clientId); const current = this.bank();
    return { ...current.bank.profiles.find(x => x.id === clientId), revision: current.revision };
  }
  registerScenes(bank) {
    for (const entry of bank.entries.filter(x => x.kind === 'exchange')) {
      const key = digest(JSON.stringify(entry.lines));
      this.db.prepare('INSERT OR IGNORE INTO director_scenes VALUES (?,?,?)').run(key, `bank:${key.slice(0, 32)}`, JSON.stringify(entry.lines));
    }
  }
  scenes(pair = null) {
    const ids = pair?.map(c => c.client_id);
    return this.bank().bank.entries.filter(x => x.enabled && x.kind === 'exchange' && (!ids || ids.every(id => x.accountIds.includes(id))))
      .map(entry => { const row = this.db.prepare('SELECT scene_id FROM director_scenes WHERE content_key=?').get(digest(JSON.stringify(entry.lines))); return { id: row.scene_id, lines: entry.lines }; });
  }
  renderScene(id, turn, other) {
    const row = this.db.prepare('SELECT * FROM director_scenes WHERE scene_id=?').get(id);
    if (!row || ![1, 2].includes(turn) || !LOGIN.test(other)) throw failure('Invalid curated exchange line.');
    return validateReply(`@${other} ${JSON.parse(row.lines_json)[turn - 1]}`);
  }
  mutation(requestId, input, work) {
    if (!opaque(requestId)) throw failure('Invalid request identifier.');
    const key = digest(JSON.stringify(input)), existing = this.db.prepare('SELECT * FROM director_mutations WHERE request_id=?').get(requestId);
    if (existing) { if (existing.digest !== key) throw failure('This request identifier already belongs to another action.', 409); return JSON.parse(existing.result_json); }
    const result = work(); this.db.prepare('INSERT INTO director_mutations VALUES (?,?,?)').run(requestId, key, JSON.stringify(result)); return result;
  }
  saveBank(input) {
    if (!exact(input, ['requestId', 'expectedRevision', 'bank']) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw failure('Invalid message bank update.');
    const bank = validateBank(input.bank);
    return this.s.transaction(() => this.mutation(input.requestId, input, () => {
      const current = this.bank(); if (current.revision !== input.expectedRevision) throw failure('The message bank changed. Refresh before saving.', 409);
      const revision = current.revision + 1;
      this.db.prepare('INSERT INTO director_banks VALUES (?,?,?,?)').run(revision, JSON.stringify(bank), this.s.now(), input.requestId);
      this.db.exec('UPDATE director_profiles SET edited=1'); this.registerScenes(bank);
      this.cancelUnused('The message bank changed; waiting for a fresh decision.');
      for (const run of this.db.prepare("SELECT * FROM host_exchanges WHERE state='active'").all()) this.s.exchanges.cancel(run, 'The message bank changed; unused exchange work was cancelled.');
      return { ok: true, requestId: input.requestId, revision };
    }));
  }
  preferences(clientId, input) {
    if (!exact(input, ['requestId', 'chatMode', 'replySource']) || !['mentions', 'participate'].includes(input.chatMode) || !['local', 'ai'].includes(input.replySource)) throw failure('Invalid central profile settings.');
    this.s.client(clientId);
    return this.s.transaction(() => this.mutation(input.requestId, { clientId, ...input }, () => {
      const current = this.bank(), bank = current.bank, profile = bank.profiles.find(x => x.id === clientId);
      if (profile.chatMode === input.chatMode && profile.replySource === input.replySource) {
        this.db.prepare('UPDATE director_profiles SET edited=1 WHERE client_id=?').run(clientId);
        return { ok: true, requestId: input.requestId, revision: current.revision, profile: this.profile(clientId) };
      }
      profile.chatMode = input.chatMode; profile.replySource = input.replySource;
      const revision = current.revision + 1;
      this.db.prepare('INSERT INTO director_banks VALUES (?,?,?,?)').run(revision, JSON.stringify(bank), this.s.now(), input.requestId);
      this.db.prepare('UPDATE director_profiles SET edited=1 WHERE client_id=?').run(clientId);
      this.cancelUnused('Central account preferences changed.', clientId);
      return { ok: true, requestId: input.requestId, revision, profile: this.profile(clientId) };
    }));
  }
  imports(clientId) {
    const rows = this.db.prepare('SELECT source,complete FROM director_import_sources WHERE client_id=?').all(clientId);
    return { helper: !!rows.find(x => x.source === 'helper')?.complete, browser: !!rows.find(x => x.source === 'browser')?.complete };
  }
  get ready() { return [...this.s.clients.keys()].every(id => Object.values(this.imports(id)).every(Boolean)); }
  importPage(clientId, input) {
    const c = this.s.client(clientId);
    if (!record(input) || !Object.keys(input).every(key => ['source', 'importId', 'page', 'final', 'digest', 'records', 'preferences'].includes(key))
      || !['helper', 'browser'].includes(input.source) || !opaque(input.importId) || !Number.isSafeInteger(input.page) || input.page < 0 || typeof input.final !== 'boolean'
      || typeof input.digest !== 'string' || !/^[a-f0-9]{64}$/.test(input.digest) || !Array.isArray(input.records) || input.records.length > 50
      || Buffer.byteLength(JSON.stringify(input)) > 60000 || digest(JSON.stringify({ records: input.records, preferences: input.preferences ?? null })) !== input.digest) throw failure('Invalid history migration page.');
    if (input.preferences !== undefined && (input.source !== 'browser' || !input.final || !exact(input.preferences, ['chatMode', 'replySource'])
      || !['mentions', 'participate'].includes(input.preferences.chatMode) || !['local', 'ai'].includes(input.preferences.replySource))) throw failure('Invalid imported profile preferences.');
    return this.s.transaction(() => {
      const old = this.db.prepare('SELECT * FROM director_import_pages WHERE client_id=? AND source=? AND import_id=? AND page=?').get(clientId, input.source, input.importId, input.page);
      if (old) { if (old.digest !== input.digest) throw failure('A migration page cannot change.', 409); return JSON.parse(old.result_json); }
      let source = this.db.prepare('SELECT * FROM director_import_sources WHERE client_id=? AND source=?').get(clientId, input.source);
      if (!source) { if (input.page !== 0) throw failure('Migration pages must start at zero.', 409); this.db.prepare('INSERT INTO director_import_sources VALUES (?,?,?,0,0)').run(clientId, input.source, input.importId); source = { next_page: 0, import_id: input.importId, complete: 0 }; }
      if (source.import_id !== input.importId || source.next_page !== input.page || source.complete) throw failure('Migration pages are out of order.', 409);
      for (const item of input.records) {
        if (!record(item) || typeof item.recordId !== 'string' || !/^[a-f0-9]{64}$/.test(item.recordId) || !['history', 'participation', 'handled'].includes(item.type)) throw failure('Invalid history migration record.');
        const key = digest(JSON.stringify(item)), prior = this.db.prepare('SELECT digest FROM director_import_records WHERE client_id=? AND source=? AND record_id=?').get(clientId, input.source, item.recordId);
        if (prior) { if (prior.digest !== key) throw failure('A migration record cannot change.', 409); continue; }
        this.importRecord(c, item);
        this.db.prepare('INSERT INTO director_import_records VALUES (?,?,?,?)').run(clientId, input.source, item.recordId, key);
      }
      if (input.preferences) {
        const p = this.db.prepare('SELECT * FROM director_profiles WHERE client_id=?').get(clientId);
        if (!p.seeded && !p.edited) {
          const current = this.bank(); Object.assign(current.bank.profiles.find(x => x.id === clientId), input.preferences);
          this.db.prepare('INSERT INTO director_banks VALUES (?,?,?,?)').run(current.revision + 1, JSON.stringify(current.bank), this.s.now(), `seed:${clientId}`);
        }
        this.db.prepare('UPDATE director_profiles SET seeded=1 WHERE client_id=?').run(clientId);
      }
      this.db.prepare('UPDATE director_import_sources SET next_page=?,complete=? WHERE client_id=? AND source=?').run(input.page + 1, Number(input.final), clientId, input.source);
      const result = { ok: true, source: input.source, importId: input.importId, page: input.page, digest: input.digest, complete: input.final, nextPage: input.page + 1 };
      this.db.prepare('INSERT INTO director_import_pages VALUES (?,?,?,?,?,?)').run(clientId, input.source, input.importId, input.page, input.digest, JSON.stringify(result));
      return result;
    });
  }
  opportunity(key, account, channel, stream, kind, at, state, ownerPlan = '') {
    if (!key) return;
    this.db.prepare('INSERT INTO director_opportunities(key,account,channel,stream_id,kind,at,state,owner_plan) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state=CASE WHEN director_opportunities.state=\'cancelled\' OR director_opportunities.owner_plan<>\'\' AND director_opportunities.owner_plan=excluded.owner_plan THEN excluded.state ELSE director_opportunities.state END,owner_plan=CASE WHEN director_opportunities.state=\'cancelled\' THEN excluded.owner_plan ELSE director_opportunities.owner_plan END').run(key, account, channel, stream || '', kind || '', at, state, ownerPlan);
  }
  importRecord(c, item) {
    if (item.type === 'handled') {
      if (typeof item.key !== 'string' || item.key.length > 400) throw failure('Invalid handled-message record.');
      const parts = item.key.split(':'); if (parts.length !== 3 || parts[0] !== c.account || !LOGIN.test(parts[1]) || !ID.test(parts[2])) throw failure('History does not belong to this client.', 403);
      this.opportunity(item.key, c.account, parts[1], '', '', this.s.now(), 'handled'); return;
    }
    if (item.account !== c.account || !LOGIN.test(item.channel || '') || !timestamp(item.at) || item.at > this.s.now() + 5000
      || !outcomes.has(item.delivery) || item.submitted !== undefined && typeof item.submitted !== 'boolean'
      || item.delivery === 'cancelled' && item.submitted !== false) throw failure('Invalid account history record.');
    const stream = safe(item.streamId, 128), kind = ['greeting', 'topic', 'conversation', 'exchange'].includes(item.kind) ? item.kind : '';
    const key = safe(item.participationKey || item.key, 400);
    if (key) {
      if (!key.startsWith(`participation:${c.account}:${item.channel}:`) && !(kind === 'exchange' && /^exchange:[A-Za-z0-9_:-]{1,160}$/.test(key))) throw failure('Participation history does not belong to this client.', 403);
      if (kind === 'exchange') {
        const line = this.db.prepare('SELECT account FROM host_exchange_lines WHERE id=?').get(key.slice(9));
        if (line && line.account !== c.account) throw failure('Exchange history does not belong to this client.', 403);
      }
    }
    if (item.type === 'participation') {
      if (!key || key.length > 400 || !key.startsWith(`participation:${c.account}:${item.channel}:`) && !(kind === 'exchange' && key.startsWith('exchange:'))) throw failure('Invalid participation history.');
      this.opportunity(key, c.account, item.channel, stream, kind, item.at, item.delivery); return;
    }
    const text = typeof item.text === 'string' ? item.text : null;
    if (text !== null && (text.length > 300 || /[\u0000-\u001f\u007f]/.test(text))) throw failure('Invalid outgoing history text.');
    const textKey = text !== null ? messageKey(text) : typeof item.textKey === 'string' && /^[a-f0-9]{16}$/.test(item.textKey) ? item.textKey : '';
    if (key) this.opportunity(key, c.account, item.channel, stream, kind, item.at, item.delivery);
    const replyId = safe(item.replyId, 160);
    let attemptId = safe(item.coordinationId, 160), permit;
    if (attemptId) {
      permit = this.db.prepare('SELECT * FROM host_permits WHERE reservation_id=?').get(attemptId);
      if (permit && (permit.client_id !== c.client_id || permit.channel !== item.channel || permit.text_key !== textKey)) throw failure('History does not match its original permit.', 403);
    }
    if (!attemptId || !permit) {
      // Match the canonical legacy contribution first, including its timestamp
      // tolerance from normalizeLegacySeeds; browser/helper copies charge once.
      const legacy = this.db.prepare('SELECT * FROM contributions WHERE account=? AND channel=? AND text_key=? AND ABS(at-?)<=90000 ORDER BY ABS(at-?) LIMIT 1').get(c.account, item.channel, textKey, item.at, item.at);
      attemptId = legacy?.reservation_id || `legacy:${digest(JSON.stringify([c.account, item.channel, item.at, textKey, replyId])).slice(0, 48)}`;
      if (!legacy && item.delivery !== 'cancelled' && textKey && item.at >= this.s.now() - 14 * 86400000) this.db.prepare('INSERT OR IGNORE INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(attemptId, c.account, item.channel, stream, kind, textKey, replyId, item.at, item.delivery);
    }
    if (permit && ['submitting', 'unknown'].includes(permit.state) && item.delivery !== 'pending') this.s._finish(c.client_id, { reservationId: permit.reservation_id, delivery: item.delivery, submitted: item.submitted !== false, outcome: { at: item.at, messageId: item.messageId || '', reason: item.reason || '' } });
    const historyIdentity = this.db.prepare('SELECT * FROM director_history WHERE account=? AND channel=? AND text_key=? AND ABS(at-?)<=90000 ORDER BY ABS(at-?) LIMIT 1').get(c.account, item.channel, textKey, item.at, item.at);
    if (!permit && historyIdentity) attemptId = historyIdentity.attempt_id;
    this.writeHistory({ attemptId, clientId: c.client_id, account: c.account, channel: item.channel, streamId: stream, kind, text, textKey,
      delivery: permit && ['confirmed', 'rejected', 'cancelled'].includes(permit.state) ? permit.state : item.delivery, source: 'legacy', at: permit?.started_at || item.at,
      submitted: item.submitted === true || ['confirmed', 'rejected', 'unknown'].includes(item.delivery), category: safe(item.category, 40), replyId,
      replyTo: LOGIN.test(item.replyTo || '') ? item.replyTo : '', messageId: safe(item.messageId, 160), reason: safe(item.reason) });
  }
  legacyContribution(row) {
    const c = [...this.s.clients.values()].find(x => x.account === row.account); if (!c) return;
    this.writeHistory({ attemptId: row.reservation_id, clientId: c.id, account: row.account, channel: row.channel, streamId: row.stream_id, kind: row.kind,
      text: null, textKey: row.text_key, delivery: row.delivery, source: 'legacy', at: row.at, submitted: row.delivery !== 'cancelled', replyId: row.reply_id });
    if (['greeting', 'topic'].includes(row.kind)) this.opportunity(`participation:${row.account}:${row.channel}:${row.stream_id}:${row.kind}`, row.account, row.channel, row.stream_id, row.kind, row.at, row.delivery);
  }
  writeHistory(value) {
    const old = this.db.prepare('SELECT * FROM director_history WHERE attempt_id=?').get(value.attemptId);
    if (old) {
      if (old.account !== value.account || old.channel !== value.channel || old.text_key && value.textKey && old.text_key !== value.textKey) throw failure('History identity changed.', 409);
      const upgrade = (rank[value.delivery] ?? -1) > (rank[old.delivery] ?? -1);
      // Reopening the host can backfill consumed opportunities without making
      // an unchanged historical send appear to be a new observation.
      const changed = upgrade || old.text === null && value.text != null
        || !old.category && !!value.category || !old.reply_id && !!value.replyId || !old.reply_to && !!value.replyTo
        || !!value.messageId && value.delivery === 'confirmed' && value.messageId !== old.message_id;
      if (!changed) return;
      this.db.prepare('UPDATE director_history SET text=COALESCE(text,?),delivery=?,updated_at=?,submitted=?,category=CASE WHEN category=\'\' THEN ? ELSE category END,reply_id=CASE WHEN reply_id=\'\' THEN ? ELSE reply_id END,reply_to=CASE WHEN reply_to=\'\' THEN ? ELSE reply_to END,message_id=CASE WHEN ?<>\'\' AND ?=\'confirmed\' THEN ? ELSE message_id END,reason=CASE WHEN ? THEN ? ELSE reason END WHERE attempt_id=?')
        .run(value.text ?? null, upgrade ? value.delivery : old.delivery, this.s.now(), upgrade ? Number(value.submitted) : old.submitted, value.category || '', value.replyId || '', value.replyTo || '', value.messageId || '', value.delivery, value.messageId || '', Number(upgrade), value.reason || '', value.attemptId);
      return;
    }
    this.db.prepare('INSERT INTO director_history(attempt_id,client_id,account,channel,stream_id,kind,text,text_key,delivery,source,at,updated_at,submitted,category,reply_id,reply_to,message_id,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(value.attemptId, value.clientId, value.account, value.channel, value.streamId || '', value.kind || '', value.text ?? null, value.textKey || '', value.delivery, value.source, value.at, this.s.now(), Number(value.submitted), value.category || '', value.replyId || '', value.replyTo || '', value.messageId || '', value.reason || '');
  }
  observation(clientId) {
    const obs = this.observations.get(clientId), c = this.s.client(clientId);
    return obs && obs.at >= this.s.now() - 45000 && c.channel === obs.channel && this.s.online(c) ? obs : null;
  }
  observe(clientId, input) {
    const c = this.s.client(clientId);
    if (!exact(input, ['protocol', 'binding', 'armed', 'streamContext', 'messages', 'restrictions']) || input.protocol !== 1 || !validBinding(input.binding) || typeof input.armed !== 'boolean'
      || !Array.isArray(input.messages) || input.messages.length > 120 || !exact(input.restrictions, ['sharedChat', 'emoteOnly', 'subscribersOnly', 'sendHeld']) || Object.values(input.restrictions).some(x => typeof x !== 'boolean')) throw failure('Invalid director observation.');
    const messages = input.messages.filter(m => record(m) && ID.test(m.id || '') && LOGIN.test(m.author || '') && typeof m.text === 'string'
      && m.text.length <= 600 && timestamp(m.at) && m.at >= this.s.now() - 900000 && m.at <= this.s.now() && (!m.channel || m.channel === c.channel))
      .slice(-100).map(m => ({ id: m.id, author: m.author, text: m.text, at: m.at, ...(m.replyParentId ? { replyParentId: safe(m.replyParentId, 160) } : {}), ...(m.isBot || m.bot ? { isBot: true } : {}) }));
    const context = normalizeStreamContext(input.streamContext, c.channel, this.s.now());
    const old = this.observations.get(clientId);
    const obs = { at: this.s.now(), binding: { ...input.binding }, armed: input.armed, channel: c.channel, context, messages, restrictions: { ...input.restrictions } };
    this.observations.set(clientId, obs);
    try {
      return this.s.transaction(() => {
        if (old && (!same(old.binding, obs.binding) || old.channel !== obs.channel || old.context?.streamId !== context?.streamId || !input.armed)) this.cancelUnused('The browser session or live context changed.', clientId);
        const exchange = this.exchangeContext(clientId, !!c.ready);
        this.db.prepare('UPDATE host_clients SET exchange_stream_id=?,exchange_checked_at=?,last_human_at=? WHERE client_id=?').run(exchange.streamId, exchange.checkedAt, exchange.lastHumanAt, clientId);
        this.plan(clientId);
        return { ok: true, director: this.internal(clientId) };
      });
    } catch (e) { if (old) this.observations.set(clientId, old); else this.observations.delete(clientId); throw e; }
  }
  humanMessages(obs, account) {
    const companions = new Set([...this.s.clients.values()].map(x => x.account));
    return obs.messages.filter(m => m.author !== account && !companions.has(m.author) && !bots.has(m.author) && !m.author.endsWith('bot') && !m.isBot);
  }
  exchangeContext(clientId, ready) {
    const obs = this.observation(clientId), c = this.s.client(clientId), context = obs?.context;
    if (!ready || !obs?.armed || !context?.isLive || !/^\d{1,128}$/.test(context.streamId)) return { streamId: '', checkedAt: 0, lastHumanAt: 0 };
    return { streamId: context.streamId, checkedAt: context.checkedAt,
      lastHumanAt: this.humanMessages(obs, c.account).reduce((latest, m) => Math.max(latest, m.at), 0) };
  }
  canPlan(clientId, automatic = true) {
    const obs = this.observation(clientId), c = this.s.client(clientId);
    if (!obs || this.s.paused || !this.s.eligible(c, automatic)) return false;
    if (Object.values(obs.restrictions).some(Boolean)) return false;
    return !automatic || this.ready && obs.armed && obs.context?.isLive === true && !!obs.context?.streamId;
  }
  consumed(key) { const row = this.db.prepare('SELECT state FROM director_opportunities WHERE key=?').get(key); return row && row.state !== 'cancelled'; }
  choices(clientId, kind, category, context) {
    if (kind === 'topic' && (!context?.gameName || /[@<>\[\]{}\\/]|https?:|www\./i.test(context.gameName))) return [];
    return this.bank().bank.entries.filter(entry => entry.enabled && entry.kind === kind && entry.category === category && entry.accountIds.includes(clientId))
      .flatMap(entry => entry.lines.map(line => renderBankLine(line, context))).filter(Boolean);
  }
  recent(account, channel = null) {
    return this.db.prepare('SELECT * FROM director_history WHERE account=? AND at>? ORDER BY at').all(account, this.s.now() - 3600000)
      .filter(row => !channel || row.channel === channel).map(row => ({ at: row.at, account: row.account, channel: row.channel, text: row.text || '', category: row.category, delivery: row.delivery, replyTo: row.reply_to }));
  }
  distinct(choices, key, excluded) {
    if (!choices.length) return '';
    const start = Number(BigInt(`0x${messageKey(key)}`) % BigInt(choices.length));
    for (let i = 0; i < choices.length; i++) { const text = choices[(start + i) % choices.length]; if (!excluded.includes(messageKey(text))) return text; }
    return '';
  }
  current(clientId) { return this.db.prepare("SELECT * FROM director_plans WHERE client_id=? AND state IN ('offered','leased','generating') ORDER BY created_at DESC LIMIT 1").get(clientId); }
  addressedTarget(clientId, obs, snapshot, ownerPlanId = '') {
    const c = this.s.client(clientId), now = this.s.now();
    const covered = new Set(snapshot.replyIds);
    const ownLease = ownerPlanId && this.db.prepare("SELECT p.reservation_id,p.reply_id FROM host_permits p JOIN director_plans d ON d.reservation_id=p.reservation_id WHERE d.id=? AND d.client_id=? AND d.state='leased' AND p.state='leased' AND p.channel=? AND p.expires_at>?")
      .get(ownerPlanId, clientId, c.channel, now);
    if (ownLease?.reply_id) {
      const otherCoverage = this.db.prepare("SELECT 1 FROM contributions WHERE channel=? AND reply_id=? AND at>? AND delivery IN ('pending','confirmed','unknown') UNION ALL SELECT 1 FROM host_permits WHERE channel=? AND reply_id=? AND state='leased' AND expires_at>? AND reservation_id<>? LIMIT 1")
        .get(c.channel, ownLease.reply_id, now - 3600000, c.channel, ownLease.reply_id, now, ownLease.reservation_id);
      if (!otherCoverage) covered.delete(ownLease.reply_id);
    }
    const candidates = this.humanMessages(obs, c.account).filter(m => {
      if (m.at < now - 45000 || m.at > now || covered.has(m.id)) return false;
      const opportunity = this.db.prepare('SELECT state,owner_plan FROM director_opportunities WHERE key=?').get(`${c.account}:${c.channel}:${m.id}`);
      // A generation owns its existing opportunity; it must not preempt itself
      // with an older target while waiting for the selected source to finish.
      return !opportunity || opportunity.state === 'cancelled'
        || !!ownerPlanId && opportunity.state === 'generating' && opportunity.owner_plan === ownerPlanId;
    });
    const parentIds = [...new Set(candidates.map(m => m.replyParentId).filter(Boolean))];
    // Provider message ownership survives broadcast changes and manual sends.
    // Only canonical confirmed output in this account's room is evidence.
    const ownedParents = new Set(parentIds.length ? this.db.prepare(`SELECT message_id FROM director_history WHERE account=? AND channel=? AND delivery='confirmed' AND message_id IN (${parentIds.map(() => '?').join(',')})`)
      .all(c.account, c.channel, ...parentIds).map(row => row.message_id) : []);
    return candidates.findLast(m => replyOpportunity([m], c.account, now) || ownedParents.has(m.replyParentId)) || null;
  }
  conversationalTarget(clientId, obs, snapshot) {
    const c = this.s.client(clientId), context = obs.context, now = this.s.now(), recent = this.recent(c.account);
    return [...this.humanMessages(obs, c.account)].reverse().find(m => m.at >= now - 45000 && m.at <= now && !/@[a-z0-9_]+|https?:\/\/|www\./i.test(m.text)
      && !/^[\s]*[!/.]|[\u0000-\u001f\u007f]/.test(m.text) && !m.replyParentId
      && !this.consumed(`participation:${c.account}:${c.channel}:${context.streamId}:conversation:${m.id}`) && !snapshot.replyIds.includes(m.id)
      && localReply({ messages: obs.messages, target: m, account: c.account, channel: c.channel, recent, streamContext: context, now }).category);
  }
  makePlan(clientId, data, { requestId = '', mode = '', generation = false } = {}) {
    const c = this.s.client(clientId), obs = this.observation(clientId), profile = this.profile(clientId), now = this.s.now();
    const plan = { planId: randomUUID(), authorityEpoch: this.epoch, clientId, account: c.account, channel: c.channel,
      streamId: data.streamId || '', kind: data.kind || '', participationKey: data.participationKey || '', opportunityKey: data.opportunityKey,
      text: data.text || '', textKey: messageKey(data.text || ''), exactKey: digest(data.text || ''), category: data.category || '', source: data.source || 'automatic',
      replyId: data.target?.id || '', replyAuthor: data.target?.author || '', replyAt: data.target?.at || 0,
      bankRevision: this.bank().revision, profileRevision: profile.revision, notBefore: data.notBefore ?? now, expiresAt: data.expiresAt ?? (data.target ? Math.min(now + 45000, data.target.at + 45000) : now + 45000), binding: { ...obs.binding },
      ...(data.exchangeId ? { exchangeId: data.exchangeId } : {}) };
    const generationId = generation ? randomUUID() : '';
    this.db.prepare('INSERT INTO director_plans(id,client_id,account,channel,opportunity,state,payload_json,created_at,updated_at,request_id,generation_id,mode,target_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(plan.planId, clientId, c.account, c.channel, plan.opportunityKey, generation ? 'generating' : 'offered', JSON.stringify(plan), now, now, requestId, generationId, mode, data.target ? digest(JSON.stringify([data.target.id, data.target.author, data.target.text, data.target.at])) : '');
    if (generation && plan.source === 'automatic') this.opportunity(plan.opportunityKey, plan.account, plan.channel, plan.streamId, plan.kind, now, 'generating', plan.planId);
    return this.db.prepare('SELECT * FROM director_plans WHERE id=?').get(plan.planId);
  }
  plan(clientId) {
    this.expire();
    if (!this.canPlan(clientId)) return;
    const existing = this.current(clientId);
    if (existing) {
      const p = JSON.parse(existing.payload_json), obs = this.observation(clientId);
      const c = this.s.client(clientId), target = this.addressedTarget(clientId, obs, this.s._snapshot(clientId, c.channel), existing.id);
      const freshMention = target && target.id !== p.replyId;
      const conversation = this.profile(clientId).chatMode === 'participate' && ['greeting', 'topic', 'exchange'].includes(p.kind)
        && this.conversationalTarget(clientId, obs, this.s._snapshot(clientId, c.channel));
      if (p.source === 'manual' || !freshMention && !conversation) return;
      this.cancelRow(existing, freshMention ? 'A fresh directly addressed message takes priority.' : 'Fresh supported human conversation takes priority.');
    }
    const c = this.s.client(clientId), obs = this.observation(clientId), profile = this.profile(clientId), context = obs.context;
    const humans = this.humanMessages(obs, c.account), now = this.s.now(), snapshot = this.s._snapshot(clientId, c.channel), recent = this.recent(c.account);
    const excluded = [...snapshot.textKeys, ...obs.messages.filter(x => x.at > now - 3600000).map(x => messageKey(x.text))];
    const allRecent = this.db.prepare("SELECT MAX(at) AS at FROM director_opportunities WHERE account=? AND kind<>'' AND state IN ('pending','submitting','confirmed','rejected','unknown')").get(c.account).at;
    const contribution = this.db.prepare("SELECT MAX(at) AS at FROM contributions WHERE account=? AND kind<>'' AND delivery<>'cancelled'").get(c.account).at;
    let target = this.addressedTarget(clientId, obs, snapshot);
    let kind = '', key = target ? `${c.account}:${c.channel}:${target.id}` : '', category = '', text = '';
    if (!target && profile.chatMode === 'participate') {
      if (Math.max(allRecent || 0, contribution || 0) + 600000 > now) return;
      target = this.conversationalTarget(clientId, obs, snapshot);
      if (target) { kind = 'conversation'; key = `participation:${c.account}:${c.channel}:${context.streamId}:conversation:${target.id}`; }
    }
    if (target) {
      if (profile.replySource === 'ai') { this.makePlan(clientId, { kind, target, streamId: context.streamId, opportunityKey: key, participationKey: kind ? key : '' }, { generation: true, mode: 'reply' }); return; }
      const phrases = Object.fromEntries(REPLY_CATEGORIES.map(cat => [cat, this.choices(clientId, 'reply', cat, context)]));
      for (let attempts = 0; target && attempts < humans.length; attempts++) {
        const result = localReply({ messages: humans, target, account: c.account, channel: c.channel, recent, excludedKeys: excluded, streamContext: context, now, bank: phrases, random: () => Number(BigInt(`0x${messageKey(key)}`) % 1000000n) / 1000000 });
        text = result.text; category = result.category || '';
        if (text) break;
        this.opportunity(key, c.account, c.channel, context.streamId, kind, now, 'no_match');
        if (kind) return;
        target = this.addressedTarget(clientId, obs, snapshot);
        key = target ? `${c.account}:${c.channel}:${target.id}` : '';
      }
      if (!text) return;
    } else if (profile.chatMode === 'participate') {
      const exchange = snapshot.exchange;
      if (exchange && !this.consumed(exchange.key)) { this.makePlan(clientId, { kind: 'exchange', streamId: context.streamId, text: exchange.text, category: 'participation-exchange', opportunityKey: exchange.key, participationKey: exchange.key, exchangeId: exchange.id, notBefore: exchange.notBefore, expiresAt: exchange.expiresAt }); return; }
      const base = `participation:${c.account}:${c.channel}:${context.streamId}`;
      if (!this.consumed(`${base}:greeting`)) { kind = 'greeting'; key = `${base}:greeting`; text = this.distinct(this.choices(clientId, kind, 'greeting', context), key, excluded); }
      else if (!this.consumed(`${base}:topic`) && !snapshot.topicStreams.includes(context.streamId)) {
        const greeting = this.db.prepare('SELECT state FROM director_opportunities WHERE key=?').get(`${base}:greeting`);
        if (!greeting || !['confirmed', 'unknown', 'rejected', 'pending', 'submitting'].includes(greeting.state)) return;
        kind = 'topic'; key = `${base}:topic`; const cat = ['just chatting', 'music', 'art'].includes(context.gameName.toLowerCase()) ? context.gameName.toLowerCase() : 'general';
        text = this.distinct(this.choices(clientId, kind, cat, context), key, excluded);
      }
      category = kind ? `participation-${kind}` : '';
    }
    if (text) this.makePlan(clientId, { text, kind, streamId: context.streamId, opportunityKey: key, participationKey: kind ? key : '', category, target });
  }
  generation(row) {
    const p = JSON.parse(row.payload_json), obs = this.observation(row.client_id);
    const target = p.replyId ? obs?.messages.find(m => m.id === p.replyId && m.author === p.replyAuthor && m.at === p.replyAt) : null;
    if (p.replyId && (!target || row.target_key !== digest(JSON.stringify([target.id, target.author, target.text, target.at])))) return undefined;
    return { generationId: row.generation_id, requestId: row.request_id || row.id, mode: row.mode, account: p.account, channel: p.channel,
      target: target ? { id: target.id, author: target.author, text: target.text, at: target.at } : null, binding: p.binding };
  }
  internal(clientId) {
    const current = this.current(clientId), imports = this.imports(clientId), ready = this.ready && Object.values(imports).every(Boolean);
    const result = { protocol: 1, authorityEpoch: this.epoch, ready, profile: this.profile(clientId), bankRevision: this.bank().revision,
      reason: ready ? this.s.paused ? 'Central coordination is paused.' : '' : 'Waiting for every companion history migration.' };
    if (current && current.state === 'generating') result.generation = this.generation(current);
    else if (current) result.plan = JSON.parse(current.payload_json);
    return result;
  }
  assertBinding(clientId, binding, { automatic = false } = {}) {
    const obs = this.observation(clientId);
    if (!validBinding(binding) || !obs || !same(binding, obs.binding) || !this.canPlan(clientId, automatic)) throw failure('The browser state is stale or held.', 409);
    return obs;
  }
  manual(clientId, input) {
    if (!exact(input, ['requestId', 'binding', 'text']) || !opaque(input.requestId) || validateReply(input.text) !== input.text) throw failure('Invalid reviewed message.');
    return this.s.transaction(() => {
      this.assertBinding(clientId, input.binding);
      const result = this.mutation(input.requestId, { clientId, ...input }, () => {
        const current = this.current(clientId); if (current?.state === 'leased') throw failure('A message is already being prepared.', 409);
        if (current) this.cancelRow(current, 'Replaced by an explicitly reviewed message.');
        const row = this.makePlan(clientId, { text: input.text, source: 'manual', opportunityKey: `manual:${clientId}:${input.requestId}` }, { requestId: input.requestId });
        return { ok: true, plan: JSON.parse(row.payload_json) };
      });
      return { ...result, director: this.internal(clientId) };
    });
  }
  draft(clientId, input) {
    const fields = input?.mode === 'phrase' ? ['requestId', 'binding', 'mode', 'category'] : ['requestId', 'binding', 'mode'];
    if (!exact(input, fields) || !opaque(input.requestId) || !['reply', 'summary', 'phrase'].includes(input.mode) || input.mode === 'phrase' && !REPLY_CATEGORIES.includes(input.category)) throw failure('Invalid draft request.');
    return this.s.transaction(() => {
      const obs = this.assertBinding(clientId, input.binding), c = this.s.client(clientId), profile = this.profile(clientId);
      if (input.mode === 'phrase') return { ok: true, draft: { text: this.distinct(this.choices(clientId, 'reply', input.category, obs.context), input.requestId, this.s._snapshot(clientId, c.channel).textKeys), category: input.category, reason: 'Central message bank.' }, director: this.internal(clientId) };
      const target = replyOpportunity(this.humanMessages(obs, c.account), c.account, this.s.now());
      if (profile.replySource === 'ai') {
        this.mutation(`draft:${digest(`${clientId}:${input.requestId}`).slice(0, 48)}`, { clientId, ...input }, () => ({ ok: true }));
        const old = this.db.prepare('SELECT * FROM director_plans WHERE client_id=? AND request_id=? AND mode=?').get(clientId, input.requestId, input.mode);
        const row = old || this.makePlan(clientId, { source: 'manual', opportunityKey: `draft:${clientId}:${input.requestId}`, target, streamId: obs.context?.streamId || '' }, { requestId: input.requestId, generation: true, mode: input.mode });
        return { ok: true, generation: this.generation(row), director: this.internal(clientId) };
      }
      if (input.mode === 'summary') return { ok: true, draft: { text: '', summary: `${obs.messages.length} recent chat messages from ${new Set(obs.messages.map(m => m.author)).size} people.`, category: 'summary', reason: 'Summary of current chat counts.' }, director: this.internal(clientId) };
      const phrases = Object.fromEntries(REPLY_CATEGORIES.map(cat => [cat, this.choices(clientId, 'reply', cat, obs.context)]));
      const result = localReply({ messages: this.humanMessages(obs, c.account), target, account: c.account, channel: c.channel, recent: this.recent(c.account), streamContext: obs.context, now: this.s.now(), bank: phrases });
      return { ok: true, draft: { text: result.text || '', category: result.category || '', reason: result.reason }, director: this.internal(clientId) };
    });
  }
  generated(clientId, input) {
    if (!exact(input, ['requestId', 'generationId', 'binding', 'result']) || !opaque(input.requestId) || !opaque(input.generationId) || !record(input.result)
      || !Object.keys(input.result).every(key => ['text', 'summary', 'reason'].includes(key)) || typeof input.result.text !== 'string' || typeof input.result.reason !== 'string'
      || input.result.reason.length > 500 || input.result.summary !== undefined && (typeof input.result.summary !== 'string' || input.result.summary.length > 2000)) throw failure('Invalid generated draft.');
    return this.s.transaction(() => {
      const row = this.db.prepare('SELECT * FROM director_plans WHERE client_id=? AND generation_id=?').get(clientId, input.generationId);
      if (!row || (row.request_id || row.id) !== input.requestId) throw failure('This generation does not belong to this request.', 403);
      const p = JSON.parse(row.payload_json), obs = this.assertBinding(clientId, input.binding, { automatic: p.source === 'automatic' });
      if (row.state !== 'generating' || p.authorityEpoch !== this.epoch || !same(p.binding, input.binding) || p.bankRevision !== this.bank().revision || p.expiresAt <= this.s.now()
        || p.streamId && p.streamId !== obs.context?.streamId || p.replyId && !this.generation(row)?.target) throw failure('The generation is no longer current.', 409);
      if (p.source === 'manual') {
        this.db.prepare("UPDATE director_plans SET state='cancelled',reason='Draft completed; waiting for explicit review.',updated_at=? WHERE id=?").run(this.s.now(), row.id);
        const text = input.result.text ? validateReply(input.result.text) : '';
        return { ok: true, draft: { text, ...(row.mode === 'summary' ? { summary: input.result.summary || '' } : {}), category: 'ai', reason: safe(input.result.reason) }, director: this.internal(clientId) };
      }
      const text = input.result.text ? validateReply(input.result.text) : '';
      if (!text) {
        this.db.prepare("UPDATE director_plans SET state='no_match',updated_at=?,reason='No supported generated reply.' WHERE id=?").run(this.s.now(), row.id);
        this.opportunity(p.opportunityKey, p.account, p.channel, p.streamId, p.kind, this.s.now(), 'no_match', p.planId);
      } else {
        if (this.s._snapshot(clientId, p.channel).textKeys.includes(messageKey(text))) throw failure('This generated wording was already used.', 409);
        p.text = text; p.textKey = messageKey(text); p.exactKey = digest(text); p.category = 'ai';
        this.db.prepare("UPDATE director_plans SET state='offered',payload_json=?,updated_at=? WHERE id=?").run(JSON.stringify(p), this.s.now(), row.id);
      }
      return { ok: true, director: this.internal(clientId) };
    });
  }
  validatePlan(clientId, input, begin = false) {
    if (!opaque(input.planId)) throw failure('This message plan does not belong to this companion.', 403);
    const row = this.db.prepare('SELECT * FROM director_plans WHERE id=?').get(input.planId);
    if (!row || row.client_id !== clientId) throw failure('This message plan does not belong to this companion.', 403);
    const p = JSON.parse(row.payload_json);
    if (input.authorityEpoch !== this.epoch || p.authorityEpoch !== this.epoch || input.authorityEpoch !== p.authorityEpoch || !same(input.binding, p.binding)
      || !same(this.observation(clientId)?.binding, p.binding) || p.expiresAt <= this.s.now() || p.notBefore > this.s.now()
      || !this.canPlan(clientId, p.source === 'automatic') || p.streamId && p.source === 'automatic' && p.streamId !== this.observation(clientId)?.context?.streamId) throw failure('This exact message plan is stale or held.', 409);
    if (begin ? row.state !== 'leased' || row.reservation_id !== input.reservationId : !['offered', 'leased'].includes(row.state)) throw failure('This message plan was already used.', 409);
    if (!begin && (input.text !== p.text || input.textKey !== p.textKey || input.channel !== p.channel || (input.streamId || '') !== p.streamId || (input.kind || '') !== p.kind
      || (input.replyId || '') !== p.replyId || (input.replyAt || 0) !== p.replyAt || (input.exchangeId || '') !== (p.exchangeId || ''))) throw failure('The submission does not match the exact server plan.', 409);
    if (p.replyId) {
      const target = this.observation(clientId)?.messages.find(m => m.id === p.replyId && m.author === p.replyAuthor && m.at === p.replyAt);
      if (!target || target.at < this.s.now() - 45000) throw failure('The reply target is no longer current.', 409);
    }
    if (p.kind) {
      const last = this.db.prepare("SELECT MAX(at) AS at FROM director_opportunities WHERE account=? AND kind<>'' AND state IN ('pending','submitting','confirmed','rejected','unknown')").get(p.account).at;
      if (last && last + 600000 > this.s.now()) throw failure('Waiting between this account’s participation messages.', 409);
    }
    const opportunity = this.db.prepare('SELECT * FROM director_opportunities WHERE key=?').get(p.opportunityKey);
    if (opportunity && opportunity.state !== 'cancelled' && !(opportunity.state === 'generating' && opportunity.owner_plan === p.planId)) throw failure('This conversation opportunity was already consumed.', 409);
    return { row, plan: p };
  }
  leased(planId, reservationId) { this.db.prepare("UPDATE director_plans SET state='leased',reservation_id=?,updated_at=? WHERE id=? AND state='offered'").run(reservationId, this.s.now(), planId); }
  started(permit) {
    const row = this.db.prepare('SELECT * FROM director_plans WHERE reservation_id=?').get(permit.reservation_id); if (!row) return;
    const p = JSON.parse(row.payload_json);
    this.db.prepare("UPDATE director_plans SET state='submitting',updated_at=? WHERE id=?").run(this.s.now(), row.id);
    this.opportunity(p.opportunityKey, p.account, p.channel, p.streamId, p.kind, this.s.now(), 'submitting', p.planId);
    this.writeHistory({ attemptId: permit.reservation_id, clientId: p.clientId, account: p.account, channel: p.channel, streamId: p.streamId, kind: p.kind,
      text: p.text, textKey: p.textKey, delivery: 'pending', source: 'central', at: this.s.now(), submitted: true, category: p.category, replyId: p.replyId, replyTo: p.replyAuthor });
  }
  finished(permit, delivery, outcome = {}) {
    const row = this.db.prepare('SELECT * FROM director_plans WHERE reservation_id=?').get(permit.reservation_id);
    if (!row) {
      const contribution = this.db.prepare('SELECT * FROM contributions WHERE reservation_id=?').get(permit.reservation_id);
      if (contribution) this.legacyContribution(contribution);
      return;
    }
    const p = JSON.parse(row.payload_json);
    this.db.prepare('UPDATE director_plans SET state=?,updated_at=? WHERE id=?').run(delivery, this.s.now(), row.id);
    this.db.prepare('UPDATE director_opportunities SET state=? WHERE key=?').run(delivery, p.opportunityKey);
    this.writeHistory({ attemptId: permit.reservation_id, clientId: p.clientId, account: p.account, channel: p.channel, streamId: p.streamId, kind: p.kind,
      text: p.text, textKey: p.textKey, delivery, source: 'central', at: permit.started_at || this.s.now(), submitted: delivery !== 'cancelled', category: p.category,
      replyId: p.replyId, replyTo: p.replyAuthor, messageId: safe(outcome.messageId, 160), reason: safe(outcome.reason) });
  }
  cancelRow(row, reason) {
    if (!['offered', 'generating', 'leased'].includes(row.state)) throw failure('This message may already have been submitted and cannot be cancelled.', 409);
    if (row.reservation_id) {
      const permit = this.db.prepare('SELECT * FROM host_permits WHERE reservation_id=?').get(row.reservation_id);
      if (permit && permit.state !== 'leased' && !['expired', 'cancelled'].includes(permit.state)) throw failure('This message may already have been submitted.', 409);
      if (permit?.state === 'leased') this.s._finish(row.client_id, { reservationId: permit.reservation_id, delivery: 'cancelled', submitted: false });
    }
    this.db.prepare("UPDATE director_plans SET state='cancelled',reason=?,updated_at=? WHERE id=?").run(reason, this.s.now(), row.id);
    this.db.prepare("UPDATE director_opportunities SET state='handled' WHERE owner_plan=? AND state='generating'").run(row.id);
  }
  cancelUnused(reason, clientId = null) {
    for (const row of this.db.prepare("SELECT * FROM director_plans WHERE state IN ('offered','generating','leased')").all().filter(x => !clientId || x.client_id === clientId)) this.cancelRow(row, reason);
  }
  cancel(input) {
    if (!exact(input, ['requestId', 'planId']) || !opaque(input.planId)) throw failure('Invalid message cancellation.');
    return this.s.transaction(() => this.mutation(input.requestId, input, () => {
      const row = this.db.prepare('SELECT * FROM director_plans WHERE id=?').get(input.planId); if (!row) throw failure('Message plan not found.', 404);
      this.cancelRow(row, 'Cancelled from the message controller.'); return { ok: true, planId: row.id, state: 'cancelled' };
    }));
  }
  expire() {
    for (const row of this.db.prepare("SELECT * FROM director_plans WHERE state IN ('offered','leased','generating')").all()) {
      const p = JSON.parse(row.payload_json), obs = this.observation(row.client_id);
      const permit = row.reservation_id ? this.db.prepare('SELECT state FROM host_permits WHERE reservation_id=?').get(row.reservation_id) : null;
      if (p.expiresAt <= this.s.now() || !obs || !same(obs.binding, p.binding) || this.s.paused || permit && ['expired', 'cancelled'].includes(permit.state)) {
        this.cancelRow(row, p.expiresAt <= this.s.now() ? 'The unused message plan expired.' : 'Waiting for fresh browser state.');
      }
    }
  }
  history(accountId = 'all', beforeId = 0) {
    if (accountId !== 'all' && !PROFILE_IDS.includes(accountId) || !Number.isSafeInteger(beforeId) || beforeId < 0) throw failure('Invalid history page.');
    const rows = this.db.prepare(`SELECT * FROM director_history WHERE (?='all' OR client_id=?) AND (?=0 OR id<?) ORDER BY id DESC LIMIT 51`).all(accountId, accountId, beforeId, beforeId);
    return { history: rows.slice(0, 50).map(row => ({ id: row.id, accountId: row.client_id, account: row.account, channel: row.channel, streamId: row.stream_id, kind: row.kind,
      text: row.text, textAvailable: row.text !== null, delivery: row.delivery, source: row.source, at: row.at, updatedAt: row.updated_at, submitted: !!row.submitted,
      category: row.category, replyTo: row.reply_to, messageId: row.message_id, reason: row.reason })), nextBeforeId: rows.length > 50 ? rows[49].id : null };
  }
  status() {
    return this.s.transaction(() => {
      this.s.expire(); const current = this.bank(), imports = [...this.s.clients.keys()].map(id => ({ accountId: id, ...this.imports(id), complete: Object.values(this.imports(id)).every(Boolean) }));
      return { protocol: 1, updatedAt: new Date(this.s.now()).toISOString(), ready: this.ready, reason: this.ready ? '' : 'Waiting for every companion history migration.', revision: current.revision, bank: current.bank,
        profiles: [...this.s.clients.values()].map(c => ({ id: c.id, account: c.account, ...this.profile(c.id), imports: this.imports(c.id), ready: this.ready, reason: this.ready ? '' : 'History migration is incomplete.' })),
        imports, plans: this.db.prepare("SELECT * FROM director_plans WHERE state IN ('offered','leased','generating','submitting','unknown') ORDER BY created_at DESC LIMIT 30").all().map(row => {
          const p = JSON.parse(row.payload_json); return { planId: row.id, accountId: row.client_id, account: p.account, channel: p.channel, streamId: p.streamId, kind: p.kind, text: p.text,
            category: p.category, source: p.source, state: row.state, notBefore: p.notBefore, expiresAt: p.expiresAt, reason: row.reason, cancellable: ['offered', 'leased', 'generating'].includes(row.state) };
        }), ...this.history(), lastMutation: current.requestId === 'initial-defaults' || current.requestId.startsWith('seed:') || current.requestId === 'migration/fourth/v1' ? null : { requestId: current.requestId, revision: current.revision } };
    });
  }
}
