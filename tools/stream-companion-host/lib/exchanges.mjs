import { randomUUID } from 'node:crypto';

export const EXCHANGE_POLICY = Object.freeze({ intervalMinMs: 60 * 60000, intervalMaxMs: 120 * 60000,
  replyMinMs: 3 * 60000, replyMaxMs: 6 * 60000, deadlineMs: 20 * 60000,
  quietMs: 90000, accountGapMs: 10 * 60000, contextMs: 120000 });

// These are hypothetical wordplay prompts, never claims about a broadcast or a
// person. Scene IDs are durable: changing the catalogue must not reuse an ID.
export const SCENES = Object.freeze([
  ['map_battery', 'quick debate: infinite map or infinite battery for a quest?', 'map. a full battery still won’t explain where the quest went.'],
  ['checkpoint_menu', 'checkpoint at the entrance or right before the boss?', 'before the boss. navigating the menu already has enough phases.'],
  ['mystery_button', 'a mysterious button comes with a manual. read it or press it?', 'read it. then check whether the backup button has its own manual.'],
  ['helpful_sign', 'locked door, key, suspiciously helpful sign. which gets inspected first?', 'the sign. that much helpfulness is basically a puzzle wearing a hat.'],
  ['robot_parade', 'should a robot parade start with title music or final boss music?', 'title music. let the robots have an opening act before the drama.'],
  ['nested_chests', 'a treasure chest full of smaller treasure chests. rare loot?', 'that’s a filing system. the rare drop is an organised inventory.'],
  ['snack_compass', 'how useful would a compass pointing towards snacks be?', 'depends. does it remember the way back from the pantry?'],
  ['light_riddle', 'tiny riddle: what room gets lighter when something is added?', 'add a lamp. a very literal answer with a surprisingly good lighting budget.'],
  ['warning_shortcut', 'a shortcut has three warning signs. still taking it?', 'the signs have already explained the next chapter. excellent storytelling, suspicious route.'],
  ['settings_button', 'if a settings menu gets one extra button, what should it do?', 'explain this setting. the tooltip about the tooltip can wait for the sequel.'],
  ['stairs_jump', 'double jump or clearly labelled stairs for a tower level?', 'stairs for navigation, double jump for the completely necessary victory animation.'],
  ['question_map', 'every landmark on a map is a question mark. helpful or mysterious?', 'excellent mystery, questionable directions. bonus points if the legend is also a question mark.'],
  ['loading_tooltip', 'loading screen: useful tip or extremely dramatic quote?', 'useful tip. the ancient wisdom can wait until the progress bar finishes.'],
  ['backpack_loop', 'a backpack contains another backpack. extra storage or extra confusion?', 'a strong opening question for the item-description editor. capacity remains under review.'],
  ['quest_log', 'best tiny upgrade for a quest log?', 'a note saying what changed. preferably before it becomes another quest to figure that out.'],
  ['savepoint_tea', 'a save point offers tea. charming detail or dangerous distraction?', 'charming, as long as the actual save button doesn’t get hidden behind the teapot.'],
  ['elevator_music', 'boss music in an elevator between floors. good level design?', 'excellent foreshadowing, questionable lift design. the floor indicator deserves a solo.'],
  ['pigeon_tutorial', 'a pigeon teaches keyboard shortcuts. what’s lesson one?', 'keep the breadcrumbs away from the keyboard. advanced shortcuts can come later.'],
  ['crate_typography', 'a crate says definitely not loot. convincing?', 'confident typography. deeply unconvincing crate.'],
  ['cloud_slots', 'how should cloud-save slots be organised?', 'clear backup labels. then a completely unnecessary weather forecast.'],
  ['minimap_desk', 'rotate the minimap or rotate the entire desk?', 'the minimap. that desk has cables and they’ve already suffered enough.'],
  ['quest_board', 'the quest board needs organising. where does that side quest start?', 'align the checkboxes. reward: one beautifully straight column.'],
  ['keyboard_riddle', 'what has lots of keys but still can’t open a door?', 'a keyboard. unless the door has an unusually elaborate settings menu.'],
  ['polite_compass', 'endless lantern or an exceptionally polite compass?', 'lantern. very polite directions can still point the wrong way.'],
  ['pot_credits', 'should adventure game credits list every broken pot?', 'yes, but that’s a heroic amount of scrolling for the pottery department.'],
  ['polite_platform', 'a moving platform asks which floor you want. useful upgrade?', 'useful, right up until every floor offers another platform tutorial.'],
  ['dragon_calendar', 'a dragon starts keeping a calendar. what goes on it first?', 'clear date labels. even a hoard needs a filing convention.'],
  ['invisible_bridge', 'an invisible bridge comes with a very visible instruction booklet. reading it?', 'yes. page one had better explain where the bridge actually starts.'],
  ['pause_clock', 'pause screen: a clock or a tiny landscape?', 'landscape. optional clock, provided checking the time doesn’t become a side quest.'],
  ['rubber_sword', 'give a rubber sword a legendary item description?', 'unmatched flexibility. modest paperwork. outstanding bounce.'],
  ['library_maze', 'a library is also a maze. most valuable item?', 'a clear catalogue. the index shouldn’t need its own boss encounter.'],
  ['tutorial_skip', 'what should a tutorial say after the final lesson?', 'that’s everything. with a small button to read the useful bits again.']
].map(([id, ...lines]) => Object.freeze({ id, lines: Object.freeze(lines) })));

export function messageKey(text) {
  if (typeof text !== 'string') return '';
  const value = text.replace(/^\[bot\]\s*/i, '').normalize('NFKC').toLowerCase()
    .replace(/['’‘]/g, '').replace(/[\p{P}\p{Z}\p{C}]+/gu, ' ').trim();
  if (!value) return '';
  let hash = 0xcbf29ce484222325n;
  for (const character of value) hash = BigInt.asUintN(64, (hash ^ BigInt(character.codePointAt(0))) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
export function renderLine(sceneId, turn, other) {
  const scene = SCENES.find(x => x.id === sceneId);
  if (!scene || ![1, 2].includes(turn) || !/^[a-z0-9_]{3,25}$/.test(other)) throw new Error('Invalid curated exchange line.');
  const text = `[companion bot] @${other} ${scene.lines[turn - 1]}`;
  if (text.length > 300 || /[\r\n]|https?:|www\./i.test(text)) throw new Error('Invalid curated exchange text.');
  return text;
}
const iso = x => x > 0 ? new Date(x).toISOString() : null;
const hold = (code, reason) => ({ ok: false, code, reason });

export class ExchangeEngine {
  constructor(store, random = Math.random) {
    this.s = store; this.db = store.db; this.random = random; this.ticking = false;
    this.db.exec(`INSERT OR IGNORE INTO host_controls VALUES ('exchangesEnabled','false');
      CREATE TABLE IF NOT EXISTS host_exchange_schedules(channel TEXT PRIMARY KEY,next_at INTEGER NOT NULL DEFAULT 0,last_initiator TEXT NOT NULL DEFAULT '',state TEXT NOT NULL DEFAULT 'waiting_for_partners',reason TEXT NOT NULL DEFAULT 'Waiting for both companions.');
      CREATE TABLE IF NOT EXISTS host_used_scenes(channel TEXT NOT NULL,scene_id TEXT NOT NULL,used_at INTEGER NOT NULL,PRIMARY KEY(channel,scene_id));
      CREATE TABLE IF NOT EXISTS host_exchanges(id TEXT PRIMARY KEY,channel TEXT NOT NULL,stream_id TEXT NOT NULL,scene_id TEXT NOT NULL,created_at INTEGER NOT NULL,deadline INTEGER NOT NULL,state TEXT NOT NULL,reason TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS host_exchange_lines(id TEXT PRIMARY KEY,exchange_id TEXT NOT NULL,turn INTEGER NOT NULL,account TEXT NOT NULL,other_account TEXT NOT NULL,text_key TEXT NOT NULL,not_before INTEGER NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL,permit_id TEXT NOT NULL DEFAULT '',UNIQUE(exchange_id,turn));
      CREATE INDEX IF NOT EXISTS host_exchange_channel ON host_exchanges(channel,state);`);
    this.s.transaction(() => {
      // Persisted playback is useful to the ordinary dashboard, but cannot prove
      // that both exchange participants have returned after this process boot.
      this.db.exec("UPDATE host_clients SET exchange_checked_at=0");
      for (const run of this.db.prepare("SELECT * FROM host_exchanges WHERE state='active'").all()) this.cancel(run, 'Exchange cancelled after host restart.');
      for (const row of this.db.prepare('SELECT * FROM host_exchange_schedules WHERE next_at>0 AND next_at<=?').all(this.s.now())) {
        this.schedule(row.channel, this.s.now() + this.delay('interval'), 'scheduled', 'A new warmup follows host downtime.');
      }
    });
  }
  get enabled() { return this.db.prepare("SELECT value FROM host_controls WHERE key='exchangesEnabled'").get().value === 'true'; }
  delay(which) {
    const min = EXCHANGE_POLICY[`${which}MinMs`], max = EXCHANGE_POLICY[`${which}MaxMs`];
    const sample = Number(this.random());
    return min + Math.floor(Math.max(0, Math.min(0.999999999999, Number.isFinite(sample) ? sample : 0)) * (max - min + 1));
  }
  schedule(channel, nextAt, state, reason) {
    this.db.prepare('UPDATE host_exchange_schedules SET next_at=?,state=?,reason=? WHERE channel=?').run(nextAt, state, reason, channel);
  }
  context(body, ready) {
    const x = body.exchangeContext;
    if (!ready || !x || typeof x.streamId !== 'string' || !/^\d{1,128}$/.test(x.streamId)
      || !Number.isFinite(x.checkedAt) || x.checkedAt < this.s.now() - EXCHANGE_POLICY.contextMs || x.checkedAt > this.s.now() + 5000
      || !Number.isFinite(x.lastHumanAt) || x.lastHumanAt < 0 || x.lastHumanAt > this.s.now() + 5000) return { streamId: '', checkedAt: 0, lastHumanAt: 0 };
    return { streamId: x.streamId, checkedAt: x.checkedAt, lastHumanAt: x.lastHumanAt };
  }
  eligiblePartners(channel) {
    const finite = [...this.s.clients.keys()].every(id => ['primary', 'test', 'third'].includes(id));
    // Retain the original generic two-client store contract without extending
    // pair selection to arbitrary larger rosters.
    if (!finite && this.s.clients.size !== 2) return [];
    return this.db.prepare('SELECT * FROM host_clients WHERE channel=?').all(channel)
      .filter(c => this.s.clients.has(c.client_id) && this.s.eligible(c) && c.exchange_stream_id
        && c.exchange_checked_at > 0 && c.exchange_checked_at >= this.s.now() - EXCHANGE_POLICY.contextMs
        && c.exchange_checked_at <= this.s.now() + 5000)
      .sort((a, b) => a.account.localeCompare(b.account));
  }
  lastPair(channel, pair) {
    const [a, b] = pair;
    return this.db.prepare(`SELECT e.rowid AS last_run,a.account AS initiator FROM host_exchanges e
      JOIN host_exchange_lines a ON a.exchange_id=e.id AND a.turn=1
      JOIN host_exchange_lines b ON b.exchange_id=e.id AND b.turn=2
      WHERE e.channel=? AND ((a.account=? AND b.account=?) OR (a.account=? AND b.account=?))
      ORDER BY e.rowid DESC LIMIT 1`).get(channel, a.account, b.account, b.account, a.account) || { last_run: 0, initiator: '' };
  }
  partners(channel, run = null) {
    const active = this.eligiblePartners(channel);
    if (run) {
      const lines = this.db.prepare('SELECT turn,account,other_account FROM host_exchange_lines WHERE exchange_id=? ORDER BY turn').all(run.id);
      if (run.channel !== channel || lines.length !== 2 || lines[0].turn !== 1 || lines[1].turn !== 2
        || lines[0].account === lines[1].account || lines[0].other_account !== lines[1].account
        || lines[1].other_account !== lines[0].account) return null;
      const pair = active.filter(c => lines.some(line => line.account === c.account));
      return pair.length === 2 && pair.every(c => c.exchange_stream_id === run.stream_id) ? pair : null;
    }
    const pairs = [];
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (a.exchange_stream_id !== b.exchange_stream_id) continue;
      pairs.push({ pair: [a, b], last: this.lastPair(channel, [a, b]).last_run,
        key: `${a.account}:${b.account}` });
    }
    pairs.sort((a, b) => a.last - b.last || a.key.localeCompare(b.key));
    // Prefer a ready pair; spacing for one account must not starve a different
    // eligible pair. While globally held, retain one pair for waiting status.
    return pairs.find(x => this.gate(channel, x.pair).ok)?.pair || pairs[0]?.pair || null;
  }
  gate(channel, pair, account) {
    if (!this.enabled) return hold('exchange_cancelled', 'Companion exchanges are disabled.');
    if (this.s.paused) return hold('paused', 'Central coordination is paused.');
    if (!pair) return hold('exchange_cancelled', 'Both companions need fresh participation and the same live broadcast.');
    const observers = this.eligiblePartners(channel).filter(c => c.exchange_stream_id === pair[0].exchange_stream_id);
    if (Math.max(...observers.map(c => c.last_human_at)) > this.s.now() - EXCHANGE_POLICY.quietMs) return hold('exchange_quiet', 'Human conversation has priority; waiting for a quiet moment.');
    const priority = this.db.prepare("SELECT p.*,c.* FROM host_proposals p JOIN host_clients c USING(client_id) WHERE p.channel=? AND p.kind<>'exchange' AND p.state='waiting' AND p.last_at>? AND (p.reply_at=0 OR p.reply_at>=?)").all(channel, this.s.now() - 30000, this.s.now() - 45000)
      .some(c => this.s.clients.has(c.client_id) && c.channel === channel && this.s.eligible(c, !!c.kind || !!c.reply_id));
    if (priority) return hold('exchange_priority', 'A useful conversation opportunity has priority.');
    const accounts = account ? [account] : pair.map(c => c.account);
    for (const a of accounts) {
      const last = this.db.prepare("SELECT MAX(at) AS at FROM contributions WHERE account=? AND kind<>'' AND delivery IN ('pending','confirmed','unknown','rejected')").get(a).at;
      if (last != null && last + EXCHANGE_POLICY.accountGapMs > this.s.now()) return hold('exchange_spacing', 'Waiting between this account’s participation messages.');
    }
    const b = this.s.budget(channel);
    if (b.count >= this.s.policy.maxAttemptsPerHour || b.rows.length && b.next > this.s.now()) return hold('exchange_spacing', 'Waiting for the shared channel allowance.');
    if (this.db.prepare("SELECT 1 FROM host_permits WHERE channel=? AND state='leased'").get(channel)) return hold('exchange_wait', 'Another companion is completing a turn.');
    return { ok: true };
  }
  cancel(run, reason) {
    if (run.state !== 'active') return;
    // Set the run terminal first: a cancelled permit's completion hook must not
    // recursively schedule a second line or reopen this scene.
    this.db.prepare("UPDATE host_exchanges SET state='cancelled',reason=? WHERE id=? AND state='active'").run(reason, run.id);
    const lines = this.db.prepare('SELECT * FROM host_exchange_lines WHERE exchange_id=?').all(run.id);
    this.db.prepare("UPDATE host_exchange_lines SET state='cancelled' WHERE exchange_id=? AND state IN ('waiting','offered','leased')").run(run.id);
    for (const line of lines) {
      const p = line.permit_id && this.db.prepare('SELECT * FROM host_permits WHERE reservation_id=?').get(line.permit_id);
      if (p?.state === 'leased') this.s._finish(p.client_id, { reservationId: p.reservation_id, delivery: 'cancelled', submitted: false });
    }
    this.schedule(run.channel, this.enabled ? this.s.now() + this.delay('interval') : 0, this.enabled ? 'scheduled' : 'disabled', reason);
    this.s.event('', run.channel, 'exchange', reason);
  }
  tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const c of this.db.prepare("SELECT DISTINCT channel FROM host_clients WHERE channel<>''").all()) this.db.prepare('INSERT OR IGNORE INTO host_exchange_schedules(channel) VALUES (?)').run(c.channel);
      const schedules = this.db.prepare('SELECT * FROM host_exchange_schedules ORDER BY channel').all();
      for (const schedule of schedules) {
        const channel = schedule.channel;
        let run = this.db.prepare("SELECT * FROM host_exchanges WHERE channel=? AND state='active'").get(channel);
        let pair = this.partners(channel, run);
        if (run) {
          if (!this.enabled || this.s.paused || !pair || pair[0].exchange_stream_id !== run.stream_id || run.deadline <= this.s.now()) {
            this.cancel(run, !this.enabled ? 'Companion exchanges are disabled.' : this.s.paused ? 'Central coordination is paused.' : run.deadline <= this.s.now() ? 'The exchange deadline passed.' : 'A partner or live broadcast changed.');
            run = null;
          } else {
            const lines = this.db.prepare('SELECT * FROM host_exchange_lines WHERE exchange_id=? ORDER BY turn').all(run.id);
            for (const line of lines) if (line.permit_id) {
              const p = this.db.prepare('SELECT * FROM host_permits WHERE reservation_id=?').get(line.permit_id);
              if (p && ['expired', 'unknown', 'rejected', 'cancelled'].includes(p.state)) { this.cancel(run, 'The exchange turn ended without confirmed delivery.'); run = null; break; }
            }
          }
        }
        if (!run) pair = this.partners(channel);
        if (!this.enabled) { this.schedule(channel, 0, 'disabled', 'Companion exchanges are disabled.'); continue; }
        if (this.s.paused) { this.schedule(channel, this.db.prepare('SELECT next_at FROM host_exchange_schedules WHERE channel=?').get(channel).next_at, 'paused', 'Central coordination is paused.'); continue; }
        if (!pair) { this.schedule(channel, this.db.prepare('SELECT next_at FROM host_exchange_schedules WHERE channel=?').get(channel).next_at, 'waiting_for_partners', 'Waiting for both companions on the same fresh live broadcast.'); continue; }
        if (run) {
          const line = this.db.prepare("SELECT * FROM host_exchange_lines WHERE exchange_id=? AND state NOT IN ('confirmed','cancelled') ORDER BY turn LIMIT 1").get(run.id);
          const g = line ? this.gate(channel, pair, line.account) : { ok: false, code: 'exchange_wait', reason: 'Waiting for delivery confirmation.' };
          this.schedule(channel, line?.not_before || 0, !g.ok && ['exchange_quiet', 'exchange_spacing', 'exchange_priority', 'exchange_wait'].includes(g.code) ? g.code === 'exchange_quiet' ? 'quiet_wait' : 'spacing_wait' : `turn_${line?.turn || 1}`, g.ok ? 'A tagged companion line is scheduled.' : g.reason);
          continue;
        }
        const current = this.db.prepare('SELECT * FROM host_exchange_schedules WHERE channel=?').get(channel);
        const used = new Set(this.db.prepare('SELECT scene_id FROM host_used_scenes WHERE channel=?').all(channel).map(x => x.scene_id));
        const remaining = SCENES.filter(x => !used.has(x.id));
        if (!remaining.length) { this.schedule(channel, 0, 'exhausted', 'All curated scenes have been used; exchanges remain quiet.'); continue; }
        if (current.next_at && current.next_at <= this.s.now() && ['waiting_for_partners', 'paused'].includes(current.state)) {
          this.schedule(channel, this.s.now() + this.delay('interval'), 'scheduled', 'A fresh warmup follows the companions returning.'); continue;
        }
        if (!current.next_at) { this.schedule(channel, this.s.now() + this.delay('interval'), 'scheduled', 'Waiting through the companion exchange warmup.'); continue; }
        if (current.next_at > this.s.now()) { this.schedule(channel, current.next_at, 'scheduled', 'Waiting for the next occasional exchange.'); continue; }
        const g = this.gate(channel, pair);
        if (!g.ok) { this.schedule(channel, current.next_at, g.code === 'exchange_quiet' ? 'quiet_wait' : 'spacing_wait', g.reason); continue; }
        const previous = this.lastPair(channel, pair);
        const first = pair.find(c => c.account !== previous.initiator) || pair[0], second = pair.find(c => c !== first);
        const scene = remaining[Math.min(remaining.length - 1, Math.floor(this.delaySample() * remaining.length))];
        const id = randomUUID(), deadline = this.s.now() + EXCHANGE_POLICY.deadlineMs;
        this.db.prepare('INSERT INTO host_used_scenes VALUES (?,?,?)').run(channel, scene.id, this.s.now());
        this.db.prepare("INSERT INTO host_exchanges VALUES (?,?,?,?,?,?,'active','')").run(id, channel, pair[0].exchange_stream_id, scene.id, this.s.now(), deadline);
        for (const [i, c] of [first, second].entries()) {
          const other = i ? first : second, turn = i + 1;
          this.db.prepare("INSERT INTO host_exchange_lines(id,exchange_id,turn,account,other_account,text_key,not_before,expires_at,state) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(randomUUID(), id, turn, c.account, other.account, messageKey(renderLine(scene.id, turn, other.account)), i ? 0 : this.s.now(), deadline, i ? 'waiting' : 'offered');
        }
        this.db.prepare("UPDATE host_exchange_schedules SET last_initiator=?,next_at=?,state='turn_1',reason='First tagged companion line is due.' WHERE channel=?").run(first.account, this.s.now(), channel);
        this.s.event('', channel, 'exchange', 'A new two-line companion exchange was scheduled.');
      }
    } finally { this.ticking = false; }
  }
  delaySample() { const x = Number(this.random()); return Math.max(0, Math.min(0.999999999999, Number.isFinite(x) ? x : 0)); }
  offer(clientId, channel) {
    this.tick();
    const c = this.s.client(clientId), run = this.db.prepare("SELECT * FROM host_exchanges WHERE channel=? AND state='active'").get(channel);
    if (!run || c.channel !== channel) return undefined;
    const line = this.db.prepare("SELECT * FROM host_exchange_lines WHERE exchange_id=? AND account=? AND state IN ('offered','leased')").get(run.id, c.account);
    if (!line || line.not_before > this.s.now() || line.expires_at <= this.s.now()) return undefined;
    const g = this.gate(channel, this.partners(channel, run), line.account);
    // An already-owned unused lease is still the same exact offer; its own
    // presence must not invalidate the helper's final local validation.
    if (!g.ok && !(g.code === 'exchange_wait' && line.state === 'leased')) return undefined;
    return { id: line.id, account: line.account, channel, streamId: run.stream_id, key: `exchange:${line.id}`,
      text: renderLine(run.scene_id, line.turn, line.other_account), notBefore: line.not_before, expiresAt: line.expires_at };
  }
  validate(c, p, begin = false) {
    const line = this.db.prepare('SELECT * FROM host_exchange_lines WHERE id=?').get(p.exchangeId || p.exchange_id || '');
    const run = line && this.db.prepare('SELECT * FROM host_exchanges WHERE id=?').get(line.exchange_id);
    if (!line || !run || run.state !== 'active') return hold('exchange_cancelled', 'This companion exchange is no longer available.');
    if (line.account !== c.account || run.channel !== p.channel || run.stream_id !== (p.streamId || p.stream_id) || line.text_key !== (p.textKey || p.text_key)) return hold('exchange_invalid', 'The proposal does not match its exact curated exchange line.');
    if (p.replyId || p.reply_id || p.replyAt || p.reply_at) return hold('exchange_invalid', 'Companion exchanges do not use a fabricated reply target.');
    if (begin ? line.state !== 'leased' || line.permit_id !== p.reservation_id : line.state !== 'offered') return hold('exchange_consumed', 'This exchange line has already been consumed.');
    if (line.expires_at <= this.s.now()) return hold('exchange_cancelled', 'This exchange line expired.');
    if (!line.not_before || line.not_before > this.s.now()) return hold('exchange_wait', 'The next exchange line is not due yet.');
    const pair = this.partners(p.channel, run);
    if (!pair || pair[0].exchange_stream_id !== run.stream_id) return hold('exchange_cancelled', 'A partner or live broadcast changed.');
    const g = this.gate(p.channel, pair, line.account);
    if (!g.ok && !(begin && g.code === 'exchange_wait')) return g;
    return { ok: true, line };
  }
  leased(lineId, permitId) { this.db.prepare("UPDATE host_exchange_lines SET state='leased',permit_id=? WHERE id=? AND state='offered'").run(permitId, lineId); }
  started(lineId) { this.db.prepare("UPDATE host_exchange_lines SET state='submitting' WHERE id=? AND state='leased'").run(lineId); }
  outcome(p, delivery) {
    this.tick();
    if (p.kind !== 'exchange' || !p.exchange_id) return;
    const line = this.db.prepare('SELECT * FROM host_exchange_lines WHERE id=?').get(p.exchange_id);
    if (!line || line.permit_id !== p.reservation_id) return;
    const run = this.db.prepare('SELECT * FROM host_exchanges WHERE id=?').get(line.exchange_id);
    this.db.prepare('UPDATE host_exchange_lines SET state=? WHERE id=?').run(delivery, line.id);
    if (!run || run.state !== 'active') return;
    if (delivery !== 'confirmed') { this.cancel(run, 'The exchange turn ended without confirmed delivery.'); return; }
    if (line.turn === 1) {
      this.db.prepare("UPDATE host_exchange_lines SET state='offered',not_before=? WHERE exchange_id=? AND turn=2 AND state='waiting'").run(this.s.now() + this.delay('reply'), run.id);
    } else {
      this.db.prepare("UPDATE host_exchanges SET state='completed',reason='Both tagged lines were confirmed.' WHERE id=? AND state='active'").run(run.id);
      this.schedule(run.channel, this.s.now() + this.delay('interval'), 'scheduled', 'Both tagged lines were confirmed; waiting for the next interval.');
    }
  }
  setEnabled(enabled) {
    this.db.prepare("UPDATE host_controls SET value=? WHERE key='exchangesEnabled'").run(String(enabled));
    if (!enabled) for (const run of this.db.prepare("SELECT * FROM host_exchanges WHERE state='active'").all()) this.cancel(run, 'Companion exchanges are disabled.');
    this.tick(); this.s.event('', '', 'control', enabled ? 'Occasional tagged companion exchanges enabled.' : 'Companion exchanges disabled.');
    return { ok: true, exchangesEnabled: enabled };
  }
  status() {
    this.tick();
    return { enabled: this.enabled, intervalMinMs: EXCHANGE_POLICY.intervalMinMs, intervalMaxMs: EXCHANGE_POLICY.intervalMaxMs,
      replyMinMs: EXCHANGE_POLICY.replyMinMs, replyMaxMs: EXCHANGE_POLICY.replyMaxMs,
      channels: this.db.prepare('SELECT * FROM host_exchange_schedules ORDER BY channel').all().map(x => ({ channel: x.channel, state: x.state, nextAt: iso(x.next_at), reason: x.reason,
        usedScenes: this.db.prepare('SELECT COUNT(*) AS n FROM host_used_scenes WHERE channel=?').get(x.channel).n, totalScenes: SCENES.length })) };
  }
}
