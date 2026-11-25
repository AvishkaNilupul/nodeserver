import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { HostStore } from '../lib/store.mjs';

const START = 1_800_000_000_000;
const CHANNEL = 'friend_channel';
const STREAM = '123456789';
const clients = [
  { id: 'primary', account: 'first_account', name: 'First companion' },
  { id: 'test', account: 'second_account', name: 'Second companion' }
];
const textKey = number => number.toString(16).padStart(16, '0');
const proposal = (extra = {}) => ({ requestId: randomUUID(), channel: CHANNEL,
  streamId: STREAM, kind: 'topic', textKey: textKey(1), replyId: '', ...extra });
function fixture(t, { file = ':memory:', policy } = {}) {
  let time = START;
  const store = new HostStore({ file, clients, now: () => time, policy });
  t.after(() => store.close());
  const sync = (id, extra = {}) => store.sync(id, { channel: CHANNEL, connected: true, ready: true,
    playback: { status: 'playing', checkedAt: time }, seed: [], ...extra });
  sync('primary'); sync('test');
  return { store, sync, advance: amount => { time += amount; }, now: () => time };
}
function finishOne(f, id, body, delivery = 'confirmed') {
  const claim = f.store.reserve(id, body); assert.equal(claim.ok, true, JSON.stringify(claim));
  assert.equal(f.store.begin(id, { reservationId: claim.reservationId }).ok, true);
  assert.equal(f.store.finish(id, { reservationId: claim.reservationId, delivery, submitted: true }).ok, true);
  return claim;
}

test('an unused expired lease releases wording and topic ownership without an attempt', t => {
  const f = fixture(t);
  const body = proposal(); const first = f.store.reserve('primary', body); assert.equal(first.ok, true);
  f.advance(20_001);
  assert.equal(f.store.begin('primary', { reservationId: first.reservationId }).ok, false);
  assert.deepEqual(f.store.snapshot('primary', CHANNEL).topicStreams, []);
  assert.equal(f.store.reserve('primary', body).ok, false, 'expired request ID cannot create a fresh grant');
  const second = f.store.reserve('test', proposal());
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL).attemptsLastHour, 0);
});

test('begin is single-use and a global pause between reserve and begin prevents submission', t => {
  const f = fixture(t);
  const claim = f.store.reserve('primary', proposal()); assert.equal(claim.ok, true);
  f.store.setPaused(true);
  assert.equal(f.store.begin('primary', { reservationId: claim.reservationId }).ok, false);
  f.store.finish('primary', { reservationId: claim.reservationId, delivery: 'cancelled', submitted: false });
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL)?.attemptsLastHour || 0, 0);
  f.store.setPaused(false);
  const second = f.store.reserve('test', proposal()); assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(f.store.begin('test', { reservationId: second.reservationId }).ok, true);
  assert.equal(f.store.begin('test', { reservationId: second.reservationId }).ok, false);
});

test('begin revalidates duplicates reconciled after the lease was reserved', t => {
  const cases = [
    { name: 'wording', candidate: { kind: 'greeting' }, seed: { kind: 'greeting', textKey: textKey(1), replyId: '' } },
    { name: 'topic', candidate: { kind: 'topic' }, seed: { kind: 'topic', textKey: textKey(2), replyId: '' } },
    { name: 'reply target', candidate: { kind: 'conversation', replyId: 'incoming-1' }, seed: { kind: 'conversation', textKey: textKey(2), replyId: 'incoming-1' } }
  ];
  for (const entry of cases) {
    const f = fixture(t);
    const claim = f.store.reserve('primary', proposal(entry.candidate)); assert.equal(claim.ok, true);
    f.sync('test', { seed: [{ channel: CHANNEL, streamId: STREAM, ...entry.seed,
      at: START - 180_001, delivery: 'confirmed' }] });
    assert.equal(f.store.begin('primary', { reservationId: claim.reservationId }).ok, false, entry.name);
    f.store.finish('primary', { reservationId: claim.reservationId, delivery: 'cancelled', submitted: false });
  }
});

test('a lost begin response can be safely cancelled when the helper certifies no provider request', t => {
  const f = fixture(t);
  const claim = f.store.reserve('primary', proposal()); assert.equal(claim.ok, true);
  assert.equal(f.store.begin('primary', { reservationId: claim.reservationId }).ok, true);
  // Model the client receiving no response: it did not call Twitch and queues this proof.
  f.store.finish('primary', { reservationId: claim.reservationId, delivery: 'cancelled', submitted: false });
  assert.deepEqual(f.store.snapshot('test', CHANNEL).topicStreams, []);
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL)?.attemptsLastHour || 0, 0);
  assert.equal(f.store.reserve('test', proposal()).ok, true);
});

test('submitting permission does not expire into a retryable send and survives restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-host-review-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'host.sqlite'); let time = START;
  const first = new HostStore({ file, clients, now: () => time });
  first.sync('primary', { channel: CHANNEL, connected: true, ready: true,
    playback: { status: 'playing', checkedAt: time }, seed: [] });
  const claim = first.reserve('primary', proposal()); assert.equal(claim.ok, true);
  assert.equal(first.begin('primary', { reservationId: claim.reservationId }).ok, true);
  first.close(); time += 300_000;
  const reopened = new HostStore({ file, clients, now: () => time }); t.after(() => reopened.close());
  reopened.sync('test', { channel: CHANNEL, connected: true, ready: true,
    playback: { status: 'playing', checkedAt: time }, seed: [] });
  assert.equal(reopened.reserve('test', proposal({ textKey: textKey(2) })).ok, false);
  assert.ok(reopened.snapshot('test', CHANNEL).topicStreams.includes(STREAM));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('UI-only status polling ages stale submission to uncertain without releasing ownership', t => {
  const f = fixture(t);
  const claim = f.store.reserve('primary', proposal({ kind: 'conversation', replyId: 'incoming-1' })); assert.equal(claim.ok, true);
  assert.equal(f.store.begin('primary', { reservationId: claim.reservationId }).ok, true);
  f.advance(120_001);
  const status = f.store.status();
  assert.equal(status.channels.find(x => x.channel === CHANNEL).activeSpeaker, null);
  assert.ok(status.events.some(x => x.delivery === 'unknown'));
  const snapshot = f.store.snapshot('test', CHANNEL);
  assert.ok(snapshot.textKeys.includes(textKey(1)));
  assert.ok(snapshot.replyIds.includes('incoming-1'));
  assert.equal(status.channels.find(x => x.channel === CHANNEL).attemptsLastHour, 1);
});

test('permits and idempotency keys are bound to their original client and proposal', t => {
  const f = fixture(t);
  const body = proposal(); const first = f.store.reserve('primary', body); assert.equal(first.ok, true);
  const repeat = f.store.reserve('primary', body); assert.equal(repeat.ok, true);
  assert.equal(repeat.reservationId, first.reservationId);
  assert.throws(() => f.store.reserve('primary', { ...body, textKey: textKey(99) }), error => error.status === 409);
  assert.throws(() => f.store.begin('test', { reservationId: first.reservationId }), error => error.status === 403);
  assert.throws(() => f.store.finish('test', { reservationId: first.reservationId, delivery: 'cancelled', submitted: false }), error => error.status === 403);
});

test('confirmed delivery cannot be downgraded or released by late conflicting completion', t => {
  const f = fixture(t);
  const claim = finishOne(f, 'primary', proposal());
  for (const [delivery, submitted] of [['unknown', true], ['rejected', true], ['cancelled', false], ['confirmed', true]]) {
    f.store.finish('primary', { reservationId: claim.reservationId, delivery, submitted });
    assert.ok(f.store.snapshot('test', CHANNEL).textKeys.includes(textKey(1)), delivery);
    assert.ok(f.store.snapshot('test', CHANNEL).topicStreams.includes(STREAM), delivery);
    assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL).attemptsLastHour, 1, delivery);
  }
});

test('known rejection stays rejected when an older unknown completion is replayed', t => {
  const f = fixture(t);
  const claim = finishOne(f, 'primary', proposal(), 'rejected');
  f.store.finish('primary', { reservationId: claim.reservationId, delivery: 'unknown', submitted: true });
  assert.equal(f.store.snapshot('test', CHANNEL).textKeys.includes(textKey(1)), false);
  assert.equal(f.store.snapshot('test', CHANNEL).topicStreams.includes(STREAM), false);
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL).attemptsLastHour, 1);
});

test('completion replay after a long outage retains permit idempotency beyond contribution retention', t => {
  for (const delivery of ['confirmed', 'unknown']) {
    const f = fixture(t);
    const body = proposal({ kind: 'conversation', replyId: `incoming-${delivery}` });
    const claim = finishOne(f, 'primary', body, delivery);
    f.advance(14 * 86_400_000 + 1);
    f.store.status(); // Contribution/event maintenance must not erase the replay identity.
    assert.equal(f.store.finish('primary', { reservationId: claim.reservationId, delivery, submitted: true }).ok, true, delivery);
    assert.equal(f.store.reserve('primary', body).ok, false, `${delivery} request ID must not become a new grant`);
  }
});

test('unknown delivery retains its opportunity without freezing distinct future conversation', t => {
  const f = fixture(t, { policy: { channelGapMs: 1000, maxAttemptsPerHour: 6, leaseMs: 20_000, presenceMs: 45_000 } });
  finishOne(f, 'primary', proposal({ kind: 'conversation', replyId: 'incoming-1' }), 'unknown');
  f.advance(1001); f.sync('primary'); f.sync('test');
  assert.equal(f.store.reserve('test', proposal({ kind: 'conversation', replyId: 'incoming-1', textKey: textKey(2) })).ok, false);
  const fresh = f.store.reserve('test', proposal({ kind: 'conversation', replyId: 'incoming-2', textKey: textKey(3) }));
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
});

test('channel cooldown and budget span accounts; no-post cancellation consumes neither', t => {
  const f = fixture(t, { policy: { channelGapMs: 1000, maxAttemptsPerHour: 2, leaseMs: 20_000, presenceMs: 45_000 } });
  finishOne(f, 'primary', proposal({ kind: 'greeting' }));
  assert.equal(f.store.reserve('test', proposal({ kind: 'greeting', textKey: textKey(2) })).ok, false);
  f.advance(1001); f.sync('test');
  finishOne(f, 'test', proposal({ kind: 'greeting', textKey: textKey(2) }), 'rejected');
  f.advance(1001); f.sync('primary');
  assert.equal(f.store.reserve('primary', proposal({ kind: 'greeting', textKey: textKey(3) })).ok, false);
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL).attemptsLastHour, 2);
  f.advance(3_600_001); f.sync('primary'); f.sync('test');
  const claim = f.store.reserve('primary', proposal({ kind: 'greeting', textKey: textKey(4) }));
  assert.equal(claim.ok, true, JSON.stringify(claim));
  f.store.finish('primary', { reservationId: claim.reservationId, delivery: 'cancelled', submitted: false });
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL).attemptsLastHour, 0);
});

test('stale playback or presence cannot grant an automatic turn', t => {
  const f = fixture(t);
  f.sync('primary', { playback: { status: 'playing', checkedAt: START - 45_001 } });
  assert.equal(f.store.reserve('primary', proposal()).ok, false);
  f.sync('primary', { playback: { status: 'paused', checkedAt: START } });
  assert.equal(f.store.reserve('primary', proposal()).ok, false);
  f.sync('primary'); f.advance(45_001);
  assert.equal(f.store.reserve('primary', proposal()).ok, false);
});

test('a proposal from a previous channel cannot monopolize a ready client’s current turn', t => {
  const f = fixture(t);
  f.store.setPaused(true);
  assert.equal(f.store.reserve('primary', proposal({ kind: 'conversation', replyId: 'old-channel-message' })).ok, false);
  f.store.setPaused(false);
  f.advance(1); f.sync('primary', { channel: 'another_channel' });
  const current = f.store.reserve('test', proposal({ kind: 'conversation', replyId: 'fresh-channel-message', textKey: textKey(2) }));
  assert.equal(current.ok, true, JSON.stringify(current));
});

test('an expired direct-reply waiter cannot block a fresh useful conversation', t => {
  const f = fixture(t);
  f.store.setPaused(true);
  const staleTarget = { kind: '', replyId: 'expiring-direct-mention', replyAt: START };
  assert.equal(f.store.reserve('primary', proposal(staleTarget)).ok, false);
  f.advance(40_000); f.sync('primary');
  assert.equal(f.store.reserve('primary', proposal(staleTarget)).ok, false);
  // The proposal heartbeat remains fresh, but the incoming message does not.
  f.advance(5001); f.sync('primary'); f.sync('test'); f.store.setPaused(false);
  const fresh = f.store.reserve('test', proposal({ kind: 'conversation', replyId: 'fresh-incoming', replyAt: f.now(), textKey: textKey(2) }));
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
});

test('a leased direct reply cannot begin after its target expires', t => {
  const f = fixture(t);
  const claim = f.store.reserve('primary', proposal({ kind: '', replyId: 'almost-expired-mention', replyAt: START - 40_000 }));
  assert.equal(claim.ok, true);
  f.advance(5001); f.sync('primary');
  assert.equal(f.store.begin('primary', { reservationId: claim.reservationId }).ok, false);
  f.store.finish('primary', { reservationId: claim.reservationId, delivery: 'cancelled', submitted: false });
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL)?.attemptsLastHour || 0, 0);
});

test('history reconciliation uses coordinationId without charging one submission twice', t => {
  const f = fixture(t);
  const claim = finishOne(f, 'primary', proposal());
  const seed = [{ channel: CHANNEL, streamId: STREAM, kind: 'topic', textKey: textKey(1), replyId: '',
    at: START + 7, delivery: 'confirmed', coordinationId: claim.reservationId }];
  f.advance(8); f.sync('primary', { seed }); f.sync('primary', { seed });
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL).attemptsLastHour, 1);
  const forged = [{ ...seed[0], coordinationId: claim.reservationId }];
  assert.throws(() => f.sync('test', { seed: forged }), error => error.status === 403);
});

test('migration preserves old confirmed topic ownership and text hashes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-host-migration-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'old.sqlite'); const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE companion_accounts (account TEXT PRIMARY KEY);
    CREATE TABLE contributions (reservation_id TEXT PRIMARY KEY, account TEXT NOT NULL,
      channel TEXT NOT NULL, stream_id TEXT NOT NULL, kind TEXT NOT NULL, text_key TEXT NOT NULL,
      reply_id TEXT NOT NULL, at INTEGER NOT NULL, delivery TEXT NOT NULL);`);
  old.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run('old-permit', 'first_account', CHANNEL,
    STREAM, 'topic', textKey(1), '', START - 10_000, 'confirmed'); old.close();
  const f = fixture(t, { file });
  assert.ok(f.store.snapshot('test', CHANNEL).topicStreams.includes(STREAM));
  assert.ok(f.store.snapshot('test', CHANNEL).textKeys.includes(textKey(1)));
  assert.equal(f.store.reserve('test', proposal({ textKey: textKey(2) })).ok, false);
});

test('migration and repeated seed sync charge a legacy reservation and its history copy only once', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-host-seed-migration-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'old.sqlite'); const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE companion_accounts (account TEXT PRIMARY KEY);
    CREATE TABLE contributions (reservation_id TEXT PRIMARY KEY, account TEXT NOT NULL,
      channel TEXT NOT NULL, stream_id TEXT NOT NULL, kind TEXT NOT NULL, text_key TEXT NOT NULL,
      reply_id TEXT NOT NULL, at INTEGER NOT NULL, delivery TEXT NOT NULL);`);
  const insert = old.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)');
  insert.run('legacy-random-reservation', 'first_account', CHANNEL, STREAM, 'topic', textKey(1), '', START - 180_002, 'unknown');
  insert.run(`seed:first_account:${CHANNEL}:${START - 180_001}`, 'first_account', CHANNEL, STREAM, 'topic', textKey(1), '', START - 180_001, 'confirmed');
  old.close();
  const f = fixture(t, { file });
  const seed = [{ channel: CHANNEL, streamId: STREAM, kind: 'topic', textKey: textKey(1), replyId: '', at: START - 180_001, delivery: 'confirmed' }];
  f.sync('primary', { seed }); f.sync('primary', { seed });
  assert.equal(f.store.status().channels.find(x => x.channel === CHANNEL).attemptsLastHour, 1);
  assert.ok(f.store.snapshot('test', CHANNEL).topicStreams.includes(STREAM));
  assert.ok(f.store.snapshot('test', CHANNEL).textKeys.includes(textKey(1)));
});
