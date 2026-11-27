import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from '../lib/store.mjs';
import { digest, PROFILE_IDS } from '../lib/bank.mjs';
import { prepareEventBank } from '../lib/event-catalog.mjs';
import { messageKey } from '../lib/exchanges.mjs';

const START = 1_800_000_000_000, channel = 'fixture_channel', streamId = '123456789';
const clients = PROFILE_IDS.map(id => ({ id, account: `fixture_${id}` }));
const binding = { generation: 'private_generation', sessionId: 'private_session', settingsRevision: 1 };
const restrictions = { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false };
function fixture(t, { disk = false, policy } = {}) {
  let now = START;
  const directory = disk ? mkdtempSync(join(tmpdir(), 'director-event-')) : null;
  const options = { file: directory ? join(directory, 'test.sqlite') : ':memory:', clients, directorEnabled: true, now: () => now, random: () => 0, ...(policy ? { policy } : {}) };
  let store = new HostStore(options);
  t.after(() => { store.close();if (directory) rmSync(directory, { recursive: true, force: true }); });
  for (const client of clients) for (const source of ['helper', 'browser']) {
    const records = [], preferences = source === 'browser' ? { chatMode: 'participate', replySource: 'local' } : undefined;
    store.director.importPage(client.id, { source, importId: `${client.id}-${source}`, page: 0, final: true, records, ...(preferences ? { preferences } : {}), digest: digest(JSON.stringify({ records, preferences: preferences ?? null })) });
  }
  const current = store.director.bank(), bank = prepareEventBank(current.bank).bank;
  for (const entry of bank.entries) if (!['reply', 'event'].includes(entry.kind)) entry.enabled = false;
  store.director.saveBank({ requestId: 'fixture-events', expectedRevision: current.revision, bank });
  const sync = (id, extra = {}) => store.sync(id, { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: now }, ...extra });
  const observe = (id, events = [], extra = {}) => {
    sync(id);return store.director.observe(id, { protocol: 1, binding, armed: true, streamContext: { channel, streamId, isLive: true, checkedAt: now, gameName: 'Art' }, messages: [], restrictions, events, ...extra }).director;
  };
  const warm = () => { for (const c of clients) observe(c.id); };
  const event = (type = 'bits', id = `${type === 'bits' ? 'bits' : type === 'gift_batch' ? 'gift' : 'notice'}:native-one`) => ({ id, channel, type, at: now });
  const offer = (e, extra = {}) => { for (const c of clients) observe(c.id, [e], extra);return store.db.prepare("SELECT * FROM director_plans WHERE state='offered' AND json_extract(payload_json,'$.kind')='event' ORDER BY created_at DESC LIMIT 1").get(); };
  const payload = row => row && JSON.parse(row.payload_json);
  const reserve = p => store.reserve(p.clientId, { requestId: `request:${p.planId}`, planId: p.planId, authorityEpoch: p.authorityEpoch, binding: p.binding, channel: p.channel, streamId: p.streamId, kind: p.kind, text: p.text, textKey: p.textKey, replyId: p.replyId, ...(p.replyId ? { replyAt: p.replyAt } : {}) });
  const begin = (p, lease) => store.begin(p.clientId, { reservationId: lease.reservationId, planId: p.planId, authorityEpoch: p.authorityEpoch, binding: p.binding });
  warm();
  return { get store() { return store; }, sync, observe, warm, event, offer, payload, reserve, begin, now: () => now, advance(ms) { now += ms; }, reopen() { store.close();store = new HostStore(options);warm(); } };
}

test('all five native event types select one of four account voices with exact source facts and no fabricated reply', t => {
  for (const type of ['bits', 'sub', 'resub', 'gift', 'gift_batch']) {
    const f = fixture(t), event = f.event(type), p = f.payload(f.offer(event));assert.ok(p, type);
    assert.equal(p.kind, 'event');assert.equal(p.category, type);assert.deepEqual(p.event, event);assert.equal(p.expiresAt, event.at + 45000);
    assert.equal(p.replyId, '');assert.equal(p.replyAuthor, '');assert.equal(p.replyAt, 0);assert.equal(p.source, 'automatic');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM director_plans WHERE state='offered'").get().n, 1);
    const entry = f.store.director.bank().bank.entries.find(e => e.kind === 'event' && e.category === type && e.accountIds.includes(p.clientId));assert.ok(entry.lines.includes(p.text));
  }
});

test('only a fresh native carrier can win an event when other healthy accounts missed the notification', t => {
  const f = fixture(t), event = f.event('bits', 'bits:sparse-1');
  const result = f.observe('primary', [event]);assert.equal(result.plan?.kind, 'event');assert.deepEqual(result.plan.event, event);
  assert.equal(result.plan.clientId, 'primary');
});

test('a companion busy with a different event cannot starve another fresh carrier', t => {
  const f = fixture(t), first = f.event('bits', 'bits:first-event');
  assert.equal(f.observe('primary', [first]).plan?.kind, 'event');
  const second = f.event('sub', 'notice:second-event'), result = f.observe('test', [second]);
  assert.equal(result.plan?.kind, 'event');assert.equal(result.plan.clientId, 'test');assert.deepEqual(result.plan.event, second);
});

test('carrier election accepts differing native delivery times but binds the selected account’s exact source tuple', t => {
  const f = fixture(t), event = f.event('sub', 'notice:delivery-times');
  for (let i = 0; i < clients.length; i++) f.store.director.observations.get(clients[i].id).events = [{ ...event, at: f.now() - i }];
  const sorted = [...clients].sort((a, b) => a.id.localeCompare(b.id));
  const owner = sorted[Number(BigInt(`0x${messageKey(`event:${channel}:${event.id}`)}`) % BigInt(sorted.length))];
  const own = f.store.director.observations.get(owner.id).events[0], result = f.observe(owner.id, [own]);
  assert.equal(result.plan.clientId, owner.id);assert.deepEqual(result.plan.event, own);
});

test('a carrier whose own chat already contains its event wording is excluded from election', t => {
  const f = fixture(t);let event;
  for (let i = 0; i < 100; i++) { const candidate = f.event('bits', `bits:wording-${i}`);if (BigInt(`0x${messageKey(`event:${channel}:${candidate.id}`)}`) % 2n === 1n) { event = candidate;break; } }
  const testWords = f.store.director.bank().bank.entries.find(e => e.id === 'event:test:bits').lines;
  const testObservation = f.store.director.observations.get('test');testObservation.events = [event];testObservation.messages = testWords.map((text, i) => ({ id: `duplicate-${i}`, author: 'fixture_viewer', text, at: f.now() }));
  const result = f.observe('primary', [event]);assert.equal(result.plan.clientId, 'primary');assert.equal(result.plan.kind, 'event');
});

test('ordinary protocol1 without events stays valid while malformed metadata and stale/wrong-channel facts never plan', t => {
  const f = fixture(t);const e = f.event();
  for (const bad of [{ ...e, extra: 'private' }, { ...e, type: 'raid' }, { ...e, at: 'now' }]) assert.throws(() => f.observe('primary', [bad]), /event observation/);
  for (const ignored of [{ ...e, at: f.now() - 45001 }, { ...e, at: f.now() + 1 }, { ...e, channel: 'other_channel' }]) assert.equal(f.offer(ignored), undefined);
  const value = { protocol: 1, binding, armed: true, streamContext: null, messages: [], restrictions };
  assert.equal(f.store.director.observe('primary', value).ok, true);
});

test('native ID validation matches helper type prefixes and the exact whole160-character bound', t => {
  const f = fixture(t), event = f.event('bits', 'bits:' + 'a'.repeat(155));
  assert.equal(f.observe('primary', [event]).plan?.event.id.length, 160);
  for (const bad of [{ ...event, id: event.id + 'a' }, { ...event, id: 'notice:wrong-prefix' }, { ...event, id: 'bits:' }, { ...event, type: 'resub' }]) {
    assert.throws(() => f.observe('primary', [bad]), /event observation/);
  }
});

test('a group child waits for its parent; original group identity is reacted to once', t => {
  const f = fixture(t), child = f.event('gift', 'gift:group-one');assert.equal(f.offer(child), undefined);
  const parent = { ...child, type: 'gift_batch' }, p = f.payload(f.offer(parent));assert.ok(p);assert.deepEqual(p.event, parent);
  for (const c of clients) f.observe(c.id, [parent, child]);assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM director_plans WHERE state='offered'").get().n, 1);
});

test('confirmed, rejected and unknown attempts consume one global event and expose only typed history provenance', t => {
  for (const delivery of ['confirmed', 'rejected', 'unknown']) {
    const f = fixture(t, { policy: { channelGapMs: 1 } }), event = f.event(), p = f.payload(f.offer(event)), lease = f.reserve(p);assert.equal(lease.ok, true);assert.equal(f.begin(p, lease).ok, true);
    f.store.finish(p.clientId, { reservationId: lease.reservationId, delivery, submitted: true, outcome: { messageId: delivery === 'confirmed' ? 'provider-one' : '' } });
    f.advance(2);assert.equal(f.offer(event), undefined);assert.equal(f.store.budget(channel).count, 1);
    const history = f.store.director.history().history;assert.equal(history.length, 1);assert.deepEqual(history[0].event, event);assert.equal(history[0].delivery, delivery);
    assert.doesNotMatch(JSON.stringify(history), /private_generation|private_session|opportunityKey|authorityEpoch/);
  }
});

test('certified no-send cancellation releases the shared claim without a budget charge', t => {
  const f = fixture(t), event = f.event(), p = f.payload(f.offer(event)), lease = f.reserve(p);assert.equal(f.begin(p, lease).ok, true);
  f.store.finish(p.clientId, { reservationId: lease.reservationId, delivery: 'cancelled', submitted: false });
  assert.equal(f.store.budget(channel).count, 0);const second = f.payload(f.offer(event));assert.ok(second);
  f.store.finish(p.clientId, { reservationId: lease.reservationId, delivery: 'cancelled', submitted: false });
  assert.equal(f.store.director.eventClaim(second.opportunityKey).owner_plan, second.planId);
  assert.equal(f.store.director.eventClaim(second.opportunityKey).state, 'offered');
  const nextLease = f.reserve(second);assert.equal(nextLease.ok, true);assert.equal(f.begin(second, nextLease).ok, true);
});

test('reserve and begin reject changed native identity/type/time, binding, text, paused playback and moderation', t => {
  const f = fixture(t), event = f.event(), p = f.payload(f.offer(event));
  assert.throws(() => f.store.reserve(p.clientId, { requestId: 'modified', planId: p.planId, authorityEpoch: p.authorityEpoch, binding: p.binding, channel, streamId, kind: 'event', text: p.text + ' changed', textKey: p.textKey }), /exact server plan/);
  const lease = f.reserve(p);assert.equal(lease.ok, true);
  f.store.director.observations.get(p.clientId).events[0].at--;
  assert.equal(f.begin(p, lease).ok, false);assert.equal(f.store.budget(channel).count, 0);
  for (const extra of [{ armed: false }, { restrictions: { ...restrictions, sharedChat: true } }, { restrictions: { ...restrictions, subscribersOnly: true } }, { streamContext: { channel, isLive: false, streamId: '', checkedAt: f.now() } }]) {
    const held = fixture(t);assert.equal(held.offer(held.event(), extra), undefined);
  }
  const held = fixture(t);for (const c of clients) held.sync(c.id, { playback: { status: 'paused', checkedAt: held.now() } });
  // Keep observations but explicitly mark all source playback paused.
  for (const c of clients) held.store.db.prepare("UPDATE host_clients SET playback='paused',ready=0 WHERE client_id=?").run(c.id);
  assert.equal(held.store.director.eventCandidate('primary', held.store.director.observation('primary'), { textKeys: [] }), null);
});

test('source expiry, shared cooldown/hourly budget and each account participation gap are not relaxed', t => {
  const f = fixture(t), e = f.event();f.store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run('prior', 'someone_else', channel, streamId, '', 'a'.repeat(16), '', f.now() - 1000, 'confirmed');assert.equal(f.offer(e), undefined);
  const full = fixture(t);for (let i = 0; i < 6; i++) full.store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(`prior${i}`, 'someone_else', channel, streamId, '', String(i).repeat(16), '', full.now() - 200000 - i, 'unknown');assert.equal(full.offer(full.event()), undefined);
  const own = fixture(t);for (const c of clients) own.store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(c.id, c.account, 'other_channel', streamId, 'conversation', c.id.padEnd(16, '0'), '', own.now() - 200000, 'confirmed');assert.equal(own.offer(own.event()), undefined);
  const expired = fixture(t), event = expired.event(), p = expired.payload(expired.offer(event));expired.advance(45000);expired.warm();assert.equal(expired.offer(event), undefined);assert.throws(() => expired.reserve(p), /stale|used/);
});

test('Stop and restart release unused offers, while a begun unknown event survives restart without replay', t => {
  const f = fixture(t, { disk: true, policy: { channelGapMs: 1 } }), e = f.event(), p = f.payload(f.offer(e));
  f.sync(p.clientId, { connected: false, ready: false });f.store.director.expire();assert.equal(f.store.director.current(p.clientId), undefined);
  f.reopen();const again = f.payload(f.offer(e));assert.ok(again);const lease = f.reserve(again);f.begin(again, lease);f.store.finish(again.clientId, { reservationId: lease.reservationId, delivery: 'unknown', submitted: true });
  f.advance(2);f.reopen();assert.equal(f.offer(e), undefined);assert.equal(f.store.budget(channel).count, 1);
});

test('a direct human question on a cheer has priority and is globally covered without a second acknowledgement', t => {
  const f = fixture(t), event = f.event(), message = { id: 'native-one', author: 'fixture_viewer', channel, at: f.now(), text: '@fixture_primary thanks' };
  for (const c of clients) f.observe(c.id, [event], { messages: [message] });
  const p = JSON.parse(f.store.director.current('primary').payload_json);assert.equal(p.kind, '');assert.equal(p.replyId, message.id);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM director_plans WHERE state='offered' AND json_extract(payload_json,'$.kind')='event'").get().n, 0);
  const lease = f.reserve(p);f.begin(p, lease);f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'confirmed', submitted: true });
  assert.equal(f.offer(event), undefined);assert.equal(f.store.director.history().history.length, 1);
});

test('a fresh human question cancels an unused event claim owned by another account before reserving', t => {
  const f = fixture(t), event = f.event(), prior = f.payload(f.offer(event));assert.ok(prior);
  const message = { id: 'native-one', author: 'fixture_viewer', channel, at: f.now(), text: '@fixture_primary thanks' };
  f.observe('primary', [event], { messages: [message] });
  const p = JSON.parse(f.store.director.current('primary').payload_json);assert.equal(p.kind, '');assert.equal(p.replyId, message.id);
  assert.equal(f.store.db.prepare('SELECT state FROM director_plans WHERE id=?').get(prior.planId).state, 'cancelled');
  assert.equal(f.store.director.eventClaim(`event:${channel}:${event.id}`).owner_plan, p.planId);
  const lease = f.reserve(p);assert.equal(lease.ok, true);assert.equal(f.begin(p, lease).ok, true);
});
