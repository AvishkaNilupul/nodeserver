import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostStore } from '../lib/store.mjs';
import { EXCHANGE_POLICY as P, messageKey } from '../lib/exchanges.mjs';

const START = 1_800_000_000_000, HOUR = 3_600_000;
const channel = 'headroom_channel', streamId = '123456789';
const clients = ['primary', 'test', 'third', 'fourth'].map(id => ({ id, account: `${id}_companion` }));
function fixture(t, random = () => 0) {
  let time = START, seedId = 0;
  const store = new HostStore({ file: ':memory:', clients, now: () => time, random });
  t.after(() => store.close());
  const syncAll = () => { for (const c of clients) store.sync(c.id, { channel, connected: true, ready: true,
    playback: { status: 'playing', checkedAt: time }, exchangeContext: { streamId, checkedAt: time, lastHumanAt: 0 } }); };
  const advance = ms => { while (ms > 0) { const step = Math.min(20_000, ms); time += step; ms -= step; syncAll(); } };
  const schedule = () => store.status().exchanges.channels.find(x => x.channel === channel);
  const offers = () => clients.flatMap(c => {
    const offer = store.snapshot(c.id, channel).exchange;
    return offer ? [{ clientId: c.id, ...offer }] : [];
  });
  const seed = (count, { delivery = 'confirmed', firstAt = time - 600_000 } = {}) => {
    for (let i = 0; i < count; i++) {
      const identity = `existing-${++seedId}`;
      store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run(identity, clients[i % clients.length].account,
        channel, streamId, '', messageKey(identity), '', firstAt + i * 60_000, delivery);
    }
  };
  const beforeDue = count => { const next = Date.parse(schedule().nextAt); advance(next - time - 1000); seed(count); advance(1000); };
  const reserve = offer => store.reserve(offer.clientId, { requestId: randomUUID(), channel, streamId, kind: 'exchange',
    exchangeId: offer.id, textKey: messageKey(offer.text) });
  const begin = (offer, permit) => store.begin(offer.clientId, { reservationId: permit.reservationId });
  const finish = (offer, permit, delivery = 'confirmed') => store.finish(offer.clientId, { reservationId: permit.reservationId,
    delivery, submitted: delivery !== 'cancelled' });
  const publish = offer => { const permit = reserve(offer); assert.equal(permit.ok, true, JSON.stringify(permit));
    assert.equal(begin(offer, permit).ok, true); finish(offer, permit); return permit; };
  syncAll(); store.setExchangesEnabled(true);
  return { store, syncAll, advance, schedule, offers, seed, beforeDue, reserve, begin, finish, publish, now: () => time };
}

test('five consumed hourly slots defer the opener without consuming a scene or an unsent attempt', t => {
  const f = fixture(t); f.beforeDue(5);
  assert.equal(f.store.budget(channel).count, 5);
  assert.equal(f.offers().length, 0);
  assert.equal(f.schedule().state, 'spacing_wait');
  assert.match(f.schedule().reason, /both companion lines/);
  assert.equal(f.schedule().usedScenes, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_exchanges').get().n, 0);
  f.advance(P.deadlineMs + 1);
  assert.equal(f.offers().length, 0); assert.equal(f.store.budget(channel).count, 5); assert.equal(f.schedule().usedScenes, 0);
});

test('four consumed slots admit both confirmed turns at the existing minimum and maximum reply delays', t => {
  for (const sample of [0, 1]) {
    const f = fixture(t, () => sample); f.beforeDue(4);
    const first = f.offers()[0]; assert.ok(first); const originalDeadline = first.expiresAt;
    assert.equal(originalDeadline - f.now(), P.deadlineMs); f.publish(first);
    assert.equal(f.store.budget(channel).count, 5);
    const replyAt = Date.parse(f.schedule().nextAt);
    assert.equal(replyAt - f.now(), sample ? P.replyMaxMs : P.replyMinMs);
    f.advance(replyAt - f.now());
    const second = f.offers()[0]; assert.ok(second, 'the return needs one remaining slot, not two');
    assert.notEqual(second.account, first.account); assert.equal(second.expiresAt, originalDeadline); f.publish(second);
    assert.equal(f.store.budget(channel).count, 6);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM contributions WHERE kind='exchange'").get().n, 2);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM host_exchanges WHERE state='completed'").get().n, 1);
    assert.equal(f.schedule().usedScenes, 1);
  }
});

test('rolling-hour expiry admits a deferred pair only when two actual slots become free', t => {
  const f = fixture(t); const due = Date.parse(f.schedule().nextAt); f.advance(due - f.now() - 1000);
  f.seed(4); f.seed(1, { firstAt: due - HOUR + 1000 }); f.advance(1000);
  assert.equal(f.store.budget(channel).count, 5); assert.equal(f.offers().length, 0); assert.equal(f.schedule().usedScenes, 0);
  f.advance(999); assert.equal(f.offers().length, 0);
  f.advance(1); assert.equal(f.store.budget(channel).count, 4); assert.equal(f.offers().length, 1);
  assert.equal(f.schedule().usedScenes, 1); assert.equal(f.store.budget(channel).count, 4, 'admission itself charges nothing');
});

for (const delivery of ['pending', 'unknown', 'rejected']) {
  test(`${delivery} attempts still consume headroom and cannot be replaced by an unsent opener`, t => {
    const f = fixture(t); const due = Date.parse(f.schedule().nextAt); f.advance(due - f.now() - 1000);
    f.seed(5, { delivery }); f.advance(1000);
    assert.equal(f.offers().length, 0); assert.equal(f.store.budget(channel).count, 5); assert.equal(f.schedule().usedScenes, 0);
  });
}

test('headroom is rechecked at reserve when delayed history fills a slot after the offer', t => {
  const f = fixture(t); f.beforeDue(4); const first = f.offers()[0]; assert.ok(first);
  f.seed(1, { firstAt: f.now() - 240_000 });
  assert.equal(f.offers().length, 0);
  const held = f.reserve(first); assert.equal(held.code, 'exchange_spacing'); assert.match(held.reason, /both companion lines/);
  assert.equal(f.store.budget(channel).count, 5); assert.equal(f.schedule().usedScenes, 1, 'an already selected scene retains its durable identity');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM host_permits').get().n, 0);
});

test('headroom is rechecked at begin and a denied unused lease never consumes quota', t => {
  const f = fixture(t); f.beforeDue(4); const first = f.offers()[0], permit = f.reserve(first); assert.equal(permit.ok, true);
  f.seed(1, { firstAt: f.now() - 240_000 });
  assert.equal(f.offers().length, 0);
  const held = f.begin(first, permit); assert.equal(held.code, 'exchange_spacing'); assert.match(held.reason, /both companion lines/);
  f.finish(first, permit, 'cancelled');
  assert.equal(f.store.budget(channel).count, 5);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM contributions WHERE kind='exchange'").get().n, 0);
  assert.equal(f.offers().length, 0); assert.equal(f.schedule().usedScenes, 1);
});

test('pair admission reserves no capacity against a later useful human reply', t => {
  const f = fixture(t); f.beforeDue(4); const first = f.offers()[0]; f.publish(first);
  f.advance(P.replyMinMs);
  const humanClient = clients.find(c => c.account !== first.account);
  const permit = f.store.reserve(humanClient.id, { requestId: 'useful-human-reply', channel, streamId, kind: '',
    textKey: messageKey('a useful human reply'), replyId: 'fresh-human-target', replyAt: f.now() });
  assert.equal(permit.ok, true, JSON.stringify(permit));
  assert.equal(f.store.begin(humanClient.id, { reservationId: permit.reservationId }).ok, true);
  f.store.finish(humanClient.id, { reservationId: permit.reservationId, delivery: 'confirmed', submitted: true });
  assert.equal(f.store.budget(channel).count, 6); assert.equal(f.offers().length, 0);
  f.advance(first.expiresAt - f.now());
  assert.equal(f.offers().length, 0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) AS n FROM contributions WHERE kind='exchange'").get().n, 1);
  assert.equal(f.store.db.prepare("SELECT state FROM host_exchanges ORDER BY rowid LIMIT 1").get().state, 'cancelled');
  assert.equal(f.schedule().usedScenes, 1, 'no lost-scene reuse or artificial quota reservation');
});

test('the last shared slot stays available to an ordinary human reply while a pair waits', t => {
  const f = fixture(t); f.beforeDue(5);
  const permit = f.store.reserve('primary', { requestId: 'human-gets-final-slot', channel, streamId, kind: '',
    textKey: messageKey('a useful reply instead of a scripted opener'), replyId: 'human-question', replyAt: f.now() });
  assert.equal(permit.ok, true); assert.equal(f.store.begin('primary', { reservationId: permit.reservationId }).ok, true);
  f.store.finish('primary', { reservationId: permit.reservationId, delivery: 'confirmed', submitted: true });
  assert.equal(f.store.budget(channel).count, 6); assert.equal(f.schedule().usedScenes, 0); assert.equal(f.offers().length, 0);
});

test('a delayed opener needs room for the existing maximum return delay before the strict deadline, also at begin', t => {
  const f = fixture(t); f.beforeDue(0); const first = f.offers()[0]; assert.ok(first);
  f.advance(P.deadlineMs - P.replyMaxMs - 1);
  assert.equal(f.offers()[0]?.id, first.id);
  const permit = f.reserve(first); assert.equal(permit.ok, true);
  f.advance(1);
  assert.equal(f.offers().length, 0);
  const held = f.begin(first, permit); assert.equal(held.code, 'exchange_spacing'); assert.match(held.reason, /enough time/);
  f.finish(first, permit, 'cancelled');
  assert.equal(f.store.budget(channel).count, 0); assert.equal(f.schedule().usedScenes, 1);
});
