import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, PROFILE_IDS } from '../lib/bank.mjs';
import { messageKey } from '../lib/exchanges.mjs';
import { HostStore } from '../lib/store.mjs';

const channel = 'fixture_channel', streamId = '123456789', otherChannel = 'fixture_other';
const clients = PROFILE_IDS.map(id => ({ id, account: `fixture_${id}` }));
const binding = { generation: 'test_generation', sessionId: 'test_session', settingsRevision: 1 };
const restrictions = { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false };
const wording = 'fixture alert';

function fixture(t, { disk = false, primaryLines = [wording], testLines = ['different fixture alert for test'], greeting = false } = {}) {
  let now = 1800000000000;
  const dir = disk ? mkdtempSync(join(tmpdir(), 'event-wording-')) : null;
  const options = { clients, directorEnabled: true, now: () => now, file: dir ? join(dir, 'fixture.sqlite') : ':memory:' };
  let store = new HostStore(options);
  t.after(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  for (const { id } of clients) for (const source of ['helper', 'browser']) {
    const records = [], preferences = source === 'browser' ? { chatMode: 'participate', replySource: 'local' } : undefined;
    store.director.importPage(id, { source, importId: `${id}-${source}`, page: 0, final: true, records,
      ...(preferences ? { preferences } : {}), digest: digest(JSON.stringify({ records, preferences: preferences ?? null })) });
  }
  const { revision, bank } = store.director.bank();
  bank.entries = bank.entries.filter(e => e.kind === 'reply' || greeting && e.kind === 'greeting');
  const linesByClient = { primary: primaryLines, test: testLines };
  for (const { id } of clients) bank.entries.push({ id: `event:${id}:bits`, kind: 'event', category: 'bits',
    lines: linesByClient[id] ?? [`different fixture alert for ${id}`], accountIds: [id], enabled: true });
  store.director.saveBank({ requestId: 'fixture-events', expectedRevision: revision, bank });
  const observe = (clientId, id, { room = channel, stream = streamId, messages = [], eventAt = now } = {}) => {
    store.sync(clientId, { channel: room, connected: true, ready: true, playback: { status: 'playing', checkedAt: now } });
    return store.director.observe(clientId, { protocol: 1, binding, armed: true, restrictions, messages,
      streamContext: { channel: room, streamId: stream, isLive: true, checkedAt: now, gameName: 'Art' },
      events: id ? [{ channel: room, type: 'bits', id: `bits:${id}`, at: eventAt }] : [] }).director.plan;
  };
  const reserve = p => store.reserve(p.clientId, { requestId: `request:${p.planId}`, planId: p.planId,
    authorityEpoch: p.authorityEpoch, binding, channel: p.channel, streamId: p.streamId, kind: p.kind, text: p.text, textKey: p.textKey });
  const begin = (p, lease) => store.begin(p.clientId, { reservationId: lease.reservationId, planId: p.planId, authorityEpoch: p.authorityEpoch, binding });
  const history = (overrides = {}) => store.director.writeHistory({ attemptId: 'historical', clientId: 'third', account: 'fixture_third', channel,
    streamId, kind: 'event', text: null, textKey: messageKey(wording), delivery: 'unknown', source: 'legacy', at: now - 7200000, submitted: true, ...overrides });
  return { get store() { return store; }, now: () => now, advance(ms) { now += ms; }, observe, reserve, begin, history,
    restart() { store.close(); store = new HostStore(options); } };
}

test('a new event stays quiet after the same wording was tried earlier in a long broadcast', t => {
  const f = fixture(t, { disk: true });
  const first = f.observe('primary', 'first'), lease = f.reserve(first);
  assert.equal(lease.ok, true);
  assert.equal(f.begin(first, lease).ok, true);
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'unknown', submitted: true });
  f.advance(15 * 86400000);
  f.restart();
  assert.equal(f.observe('primary', 'later'), undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM contributions').get().n, 0);
  assert.equal(f.store.director.history().history.length, 1);
  f.restart();
  assert.equal(f.observe('test', 'later'), undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_permits').get().n, 1);
  assert.equal(f.store.budget(channel).count, 0);
});

test('a repeat stays silent with alternate bank entries and a human can still ask a question on that cheer', t => {
  const f = fixture(t, { primaryLines: [wording, 'unused fixture alternative'] });
  const id = 'second';
  const selected = f.store.director.distinct([wording, 'unused fixture alternative'], `event:${channel}:bits:${id}`, []);
  f.history({ textKey: messageKey(selected) });
  assert.equal(f.observe('primary', id), undefined);
  assert.equal(f.observe('test', id), undefined);
  const messages = [{ id, author: 'fixture_viewer', text: '@fixture_primary thanks', at: f.now() }];
  assert.equal(f.observe('primary', id, { messages })?.replyId, id);
});

test('submitted pending, confirmed, rejected and unknown history counts across accounts, including hash-only history', t => {
  for (const delivery of ['pending', 'confirmed', 'rejected', 'unknown']) {
    const f = fixture(t);
    f.history({ delivery });
    assert.equal(f.observe('primary', 'new'), undefined, delivery);
    assert.equal(f.store.db.prepare('SELECT text FROM director_history').get().text, null);
  }
});

test('cancelled attempts, other channels, streams, wording and message kinds do not silence a new event', t => {
  for (const changes of [{ delivery: 'cancelled', submitted: false }, { channel: otherChannel }, { streamId: '999' },
    { streamId: '' }, { textKey: messageKey('distinct fixture') }, { kind: 'conversation' }]) {
    const f = fixture(t);
    f.history(changes);
    assert.equal(f.observe('primary', 'fresh')?.text, wording, JSON.stringify(changes));
  }
});

test('a matching attempt recorded between offer, reserve and begin prevents submission', t => {
  for (const stage of ['reserve', 'begin']) {
    const f = fixture(t), plan = f.observe('primary', 'outstanding');
    const lease = stage === 'begin' ? f.reserve(plan) : undefined;
    if (lease) assert.equal(lease.ok, true);
    f.history();
    const gate = lease ? { ...plan, reservationId: lease.reservationId } : plan;
    assert.throws(() => f.store.director.validatePlan(plan.clientId, gate, !!lease), /already attempted/);
    let result;
    try { result = lease ? f.begin(plan, lease) : f.reserve(plan); }
    catch (error) { assert.equal(error.status, 409); result = { ok: false }; }
    assert.equal(result.ok, false, stage);
    assert.equal(f.store.budget(channel).count, 0);
    assert.equal(f.observe('test', 'outstanding'), undefined);
  }
});

test('two outstanding offers with the same wording can only begin one attempt', t => {
  const f = fixture(t, { testLines: [wording] });
  const first = f.observe('primary', 'a'), second = f.observe('test', 'b');
  assert.equal(first.textKey, second.textKey);
  const lease = f.reserve(first);
  assert.equal(lease.ok, true);
  assert.equal(f.begin(first, lease).ok, true);
  assert.equal(f.store.director.history().history[0].delivery, 'pending');
  assert.throws(() => f.reserve(second), { status: 409 });
  assert.equal(f.observe('third', 'b'), undefined);
  assert.equal(f.store.budget(channel).count, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_permits').get().n, 1);
});

test('late matching history survives a restart that releases the original unsubmitted offer', t => {
  const f = fixture(t, { disk: true });
  assert.equal(f.observe('primary', 'released').text, wording);
  f.history();
  f.restart();
  assert.equal(f.observe('test', 'released'), undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_permits').get().n, 0);
});

test('an alert with an empty normalized key is silent and does not fall back to another carrier', t => {
  const f = fixture(t, { primaryLines: ['!!!'] });
  assert.equal(f.observe('primary', 'empty'), undefined);
  assert.equal(f.observe('test', 'empty'), undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM director_plans').get().n, 0);
});

test('a suppressed event holds fallback only while the native notification is fresh', t => {
  const f = fixture(t, { greeting: true });
  f.history();
  assert.equal(f.observe('primary', 'fading', { eventAt: f.now() - 44000 }), undefined);
  f.store.transaction(() => f.store.director.plan('primary'));
  assert.equal(f.store.director.current('primary'), undefined);
  f.advance(2000);
  f.store.transaction(() => f.store.director.plan('primary'));
  assert.equal(JSON.parse(f.store.director.current('primary').payload_json).kind, 'greeting');
});
