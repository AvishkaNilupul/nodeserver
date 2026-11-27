import test from 'node:test';
import assert from 'node:assert/strict';
import { HostStore } from '../lib/store.mjs';
import { digest, PROFILE_IDS } from '../lib/bank.mjs';
import { messageKey } from '../lib/exchanges.mjs';

const START = 1_800_000_000_000, channel = 'fixture_channel';
const clients = PROFILE_IDS.map(id => ({ id, account: `fixture_${id}` }));
const binding = { generation: 'private_generation_sentinel', sessionId: 'private_session_sentinel', settingsRevision: 1 };
const restrictions = { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false };
function fixture(t, { mode = 'mentions', imported = true } = {}) {
  let now = START;
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true, now: () => now, random: () => 0 });
  t.after(() => store.close());
  if (imported) for (const client of clients) for (const source of ['helper', 'browser']) {
    const records = [], preferences = source === 'browser' ? { chatMode: mode, replySource: 'local' } : undefined;
    store.director.importPage(client.id, { source, importId: `${client.id}-${source}`, page: 0, final: true, records,
      ...(preferences ? { preferences } : {}), digest: digest(JSON.stringify({ records, preferences: preferences ?? null })) });
  }
  const editBank = edit => {
    const current = store.director.bank(); edit(current.bank);
    store.director.saveBank({ requestId: `fixture-bank-${current.revision}`, expectedRevision: current.revision, bank: current.bank });
  };
  if (mode === 'participate') editBank(bank => { for (const entry of bank.entries) if (['greeting', 'topic'].includes(entry.kind)) entry.enabled = false; });
  const sync = (extra = {}, id = 'primary') => store.sync(id, { channel, connected: true, ready: true,
    playback: { status: 'playing', checkedAt: now }, seed: [], ...extra });
  const observe = (messages = [], extra = {}, id = 'primary') => {
    sync({}, id);
    return store.director.observe(id, { protocol: 1, binding, armed: true,
      streamContext: { channel, streamId: '123456789', gameName: 'Art', title: 'Private title sentinel', isLive: true, checkedAt: now },
      messages, restrictions, ...extra }).director;
  };
  const incoming = (text, id = 'incoming_sentinel') => ({ id, author: 'fixture_viewer', text, at: now, channel });
  const reason = (id = 'primary') => store.director.internal(id).reason;
  const contribution = (id, { account = clients[0].account, targetChannel = channel, at = now - 1000, kind = '' } = {}) =>
    store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(id, account, targetChannel, '123456789', kind, messageKey(id), '', at, 'confirmed');
  const rows = () => Object.fromEntries(['director_banks', 'director_profiles', 'director_opportunities', 'director_plans', 'director_history', 'contributions', 'host_permits', 'host_exchange_schedules']
    .map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { store, editBank, sync, observe, incoming, reason, contribution, rows, now: () => now, advance(ms) { now += ms; } };
}

test('migration readiness and internal response schema stay unchanged', t => {
  const f = fixture(t, { imported: false }), value = f.store.director.internal('primary');
  assert.equal(value.ready, false); assert.equal(value.reason, 'Waiting for every companion history migration.');
  assert.deepEqual(Object.keys(value), ['protocol', 'authorityEpoch', 'ready', 'profile', 'bankRevision', 'reason']);
  assert.equal(value.protocol, 1);
});

test('quiet and fresh unaddressed chat have distinct truthful reasons without consuming work', t => {
  const f = fixture(t); f.observe();
  assert.equal(f.reason(), 'No fresh human message to answer.');
  f.observe([f.incoming('a general room comment')]);
  assert.equal(f.reason(), 'Waiting for a fresh message this companion can answer.');
  const before = f.rows(); for (let i = 0; i < 10; i++) f.reason();
  assert.deepEqual(f.rows(), before); assert.equal(before.director_opportunities.length, 0);
});

test('offline, missing metadata, unarmed and channel restrictions are distinct holds', t => {
  const f = fixture(t);
  f.observe([], { streamContext: { channel, streamId: '', isLive: false, checkedAt: f.now() } }); assert.match(f.reason(), /channel is offline/);
  f.observe([], { streamContext: null }); assert.match(f.reason(), /current live channel information/);
  f.observe([], { armed: false }); assert.match(f.reason(), /off or paused/);
  f.observe([], { restrictions: { ...restrictions, sendHeld: true } }); assert.match(f.reason(), /Sending is held/);
  f.observe([], { restrictions: { ...restrictions, sharedChat: true } }); assert.match(f.reason(), /shared chat/);
  f.observe([], { restrictions: { ...restrictions, emoteOnly: true } }); assert.match(f.reason(), /chat restrictions/);
});

test('playback pause, unverified and stale source checks update without rewriting readiness', t => {
  const f = fixture(t); f.observe();
  f.sync({ playback: { status: 'paused', checkedAt: f.now() } }); assert.match(f.reason(), /playback is paused/);
  f.sync({ playback: { status: 'buffering', checkedAt: f.now() } }); assert.match(f.reason(), /not confirmed as playing/);
  f.sync({ playback: { status: 'playing', checkedAt: f.now() - 45001 } }); assert.match(f.reason(), /recent video check/);
  f.sync({ playback: { status: 'ad', checkedAt: f.now() } }); assert.equal(f.reason(), 'No fresh human message to answer.');
  assert.equal(f.store.director.internal('primary').ready, true);
});

test('heartbeat, disconnected chat and stale paired observations are diagnosed separately', t => {
  const f = fixture(t); f.observe(); f.advance(45001); assert.match(f.reason(), /fresh companion heartbeat/);
  f.sync(); assert.match(f.reason(), /fresh browser check-in/);
  f.sync({ connected: false }); assert.match(f.reason(), /Chat is disconnected/);
  f.observe(); assert.equal(f.reason(), 'No fresh human message to answer.');
});

test('coordination pause takes priority but does not change migration-ready semantics', t => {
  const f = fixture(t); f.observe(); f.store.setPaused(true);
  assert.equal(f.reason(), 'Central coordination is paused.'); assert.equal(f.store.director.internal('primary').ready, true);
  f.store.setPaused(false); assert.equal(f.reason(), 'No fresh human message to answer.');
});

test('existing channel/account cooldowns and hourly limits are reported, not extended or reset', t => {
  const f = fixture(t); f.observe(); f.contribution('recent');
  assert.match(f.reason(), /channel message cooldown/);
  f.advance(180001); f.observe(); assert.equal(f.reason(), 'No fresh human message to answer.');
  for (let i = 0; i < 5; i++) f.contribution(`more-${i}`, { at: f.now() - 200000 - i });
  assert.match(f.reason(), /channel hourly message allowance is full/);
  const before = f.rows(); f.reason(); assert.deepEqual(f.rows(), before);
  const other = fixture(t); other.observe(); other.contribution('other-room', { targetChannel: 'other_room' }); assert.match(other.reason(), /this account’s message cooldown/);
  for (let i = 0; i < 5; i++) other.contribution(`other-more-${i}`, { targetChannel: 'other_room', at: other.now() - 200000 - i });
  assert.match(other.reason(), /account’s hourly message allowance is full/);
});

test('unsupported local message and disabled category wording remain distinct no-match outcomes', t => {
  const f = fixture(t); f.observe([f.incoming('@fixture_primary explain quantum gravity')]);
  assert.match(f.reason(), /no supported local reply/);
  const before = f.rows(); f.reason(); assert.deepEqual(f.rows(), before); assert.equal(before.director_opportunities.length, 1);
  const disabled = fixture(t); disabled.editBank(bank => { bank.entries.find(e => e.id === 'reply_thanks').enabled = false; });
  disabled.observe([disabled.incoming('@fixture_primary thanks')]); assert.match(disabled.reason(), /disabled or unavailable/);
  const count = disabled.store.db.prepare('SELECT COUNT(*) AS n FROM director_opportunities').get().n;
  disabled.editBank(bank => { bank.entries.find(e => e.id === 'reply_thanks').enabled = true; });
  assert.doesNotMatch(disabled.reason(), /disabled/); assert.equal(disabled.store.director.current('primary'), undefined);
  assert.equal(disabled.store.db.prepare('SELECT COUNT(*) AS n FROM director_opportunities').get().n, count);
});

test('current local/model command reasons do not leak incoming text, IDs, title or binding', t => {
  const f = fixture(t); const local = f.observe([f.incoming('@fixture_primary thanks')]);
  assert.ok(local.plan); assert.match(f.reason(), /ready for a check before sending/);
  assert.doesNotMatch(f.reason(), /incoming_sentinel|private_|title|thanks/i);
  f.store.director.observations.get('primary').messages = [];
  assert.match(f.reason(), /reply target is no longer current/);
  const model = fixture(t); model.editBank(bank => { bank.profiles.find(p => p.id === 'primary').replySource = 'ai'; });
  const generated = model.observe([model.incoming('@fixture_primary hello PRIVATE_INCOMING_SENTINEL')]);
  assert.ok(generated.generation); assert.match(model.reason(), /configured model/);
  assert.doesNotMatch(model.reason(), /PRIVATE_INCOMING|private_generation|private_session|incoming_sentinel|title/);
  const before = model.rows(); model.reason(); assert.deepEqual(model.rows(), before);
  model.store.director.observations.get('primary').messages[0].text = '@fixture_primary a changed body';
  assert.match(model.reason(), /reply target is no longer current/);
});

test('occasional exchange timing is a read-only check, not a promise to post or a timer mutation', t => {
  const f = fixture(t, { mode: 'participate' }); f.observe();
  f.store.db.prepare("UPDATE host_controls SET value='true' WHERE key='exchangesEnabled'").run();
  const next = f.now() + 60001;
  f.store.db.prepare("UPDATE host_exchange_schedules SET state='scheduled',next_at=? WHERE channel=?").run(next, channel);
  const before = f.rows(); assert.match(f.reason(), /Next occasional exchange check in 2 minutes\./); assert.doesNotMatch(f.reason(), /\d{4}-\d{2}-\d{2}T/); assert.deepEqual(f.rows(), before);
  f.advance(1); assert.match(f.reason(), /Next occasional exchange check in 1 minute\./); assert.deepEqual(f.rows(), before);
  f.store.db.prepare("UPDATE host_exchange_schedules SET state='spacing_wait',reason='PRIVATE_SCHEDULE_SENTINEL' WHERE channel=?").run(channel);
  assert.match(f.reason(), /existing spacing or shared capacity/); assert.doesNotMatch(f.reason(), /PRIVATE_SCHEDULE/);
  f.store.db.prepare("UPDATE host_exchange_schedules SET state='waiting_for_partners' WHERE channel=?").run(channel); assert.match(f.reason(), /ready partners/);
});

test('snapshot embeds diagnostics without recursion or creating extra opportunities', t => {
  const f = fixture(t); f.observe(); const original = f.store._snapshot.bind(f.store); let depth = 0;
  f.store._snapshot = (...args) => { depth++; assert.equal(depth, 1); try { return original(...args); } finally { depth--; } };
  const before = f.rows();
  for (let i = 0; i < 20; i++) assert.equal(f.store.snapshot('primary', channel).director.reason, 'No fresh human message to answer.');
  assert.deepEqual(f.rows(), before);
});
