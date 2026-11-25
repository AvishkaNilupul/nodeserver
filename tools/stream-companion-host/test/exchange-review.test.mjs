import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostStore } from '../lib/store.mjs';
import { messageKey } from '../lib/exchanges.mjs';

// Independent black-box review: public store methods, a virtual clock, and
// ephemeral databases only. No SQL internals, live accounts or service calls.
const START = 1_800_000_000_000, CHANNEL = 'review_channel', STREAM = '123456789';
const CLIENTS = [{ id: 'primary', account: 'first_account', name: 'First' }, { id: 'test', account: 'second_account', name: 'Second' }];

function fixture(t, file = ':memory:') {
  let clock = START;
  let store = new HostStore({ file, clients: CLIENTS, now: () => clock, random: () => 0 });
  t.after(() => store.close());
  const sync = (id, extra = {}) => store.sync(id, { channel: CHANNEL, connected: true, ready: true,
    playback: { status: 'playing', checkedAt: clock }, seed: [],
    exchangeContext: { streamId: STREAM, checkedAt: clock, lastHumanAt: 0 }, ...extra });
  const syncBoth = () => { for (const client of CLIENTS) sync(client.id); store.status(); };
  const channel = () => store.status().exchanges.channels.find(x => x.channel === CHANNEL);
  const offers = () => CLIENTS.flatMap(client => {
    const offer = store.snapshot(client.id, CHANNEL).exchange;
    return offer ? [{ clientId: client.id, ...offer }] : [];
  });
  const healthyTo = value => {
    assert.ok(value >= clock, 'healthy review clocks only move forward');
    do { clock = Math.min(value, clock + 30000); syncBoth(); } while (clock < value);
  };
  return {
    get store() { return store; }, now: () => clock, sync, syncBoth, channel, offers, healthyTo,
    setTime(value) { assert.ok(value >= clock, 'review clocks only move forward'); clock = value; },
    advance(value) { clock += value; },
    enable() { store.setExchangesEnabled(true); syncBoth(); },
    due() {
      const state = channel(), at = Date.parse(state?.nextAt || ''); assert.ok(Number.isFinite(at), 'an eligible schedule is visible');
      const target = Math.max(clock, at + 1);
      // Healthy warmup/line delays preserve continuing check-ins. Explicit
      // downtime tests use advance()/setTime() instead.
      healthyTo(target);
      const current = offers(); assert.equal(current.length, 1, 'exactly one account gets the due line'); return current[0];
    },
    reopen() { store.close(); store = new HostStore({ file, clients: CLIENTS, now: () => clock, random: () => 0 }); }
  };
}
function proposal(offer, extra = {}) {
  return { requestId: randomUUID(), channel: offer.channel, streamId: offer.streamId, kind: 'exchange',
    exchangeId: offer.id, textKey: messageKey(offer.text), replyId: '', ...extra };
}
function claim(f, offer) {
  const body = proposal(offer); const result = f.store.reserve(offer.clientId, body);
  assert.equal(result.ok, true, JSON.stringify(result)); return { ...result, body };
}
function publish(f, offer, delivery = 'confirmed') {
  const reservation = claim(f, offer);
  assert.equal(f.store.begin(offer.clientId, { reservationId: reservation.reservationId }).ok, true);
  assert.equal(f.store.finish(offer.clientId, { reservationId: reservation.reservationId, delivery, submitted: true }).ok, true);
  return reservation;
}
function rejects(fn) {
  let result;
  try { result = fn(); } catch (error) { assert.ok(error.status >= 400 && error.status < 500, String(error)); return; }
  assert.equal(result.ok, false, 'an invalid exchange must not grant a turn');
}

test('review: feature starts disabled, waits its warmup, and exposes one stable explicitly bot-labelled offer', t => {
  const f = fixture(t); f.syncBoth();
  assert.equal(f.store.status().exchanges.enabled, false); assert.equal(f.offers().length, 0);
  f.enable(); const nextAt = Date.parse(f.channel().nextAt);
  assert.ok(nextAt >= START + 3600000 && nextAt <= START + 7200000);
  assert.equal(f.offers().length, 0);
  const first = f.due(); assert.ok(first.text.startsWith('[companion bot]'));
  const again = f.offers()[0];
  assert.equal(again.id, first.id); assert.equal(again.text, first.text); assert.equal(again.key, `exchange:${first.id}`);
});

test('review: replaying confirmed first delivery cannot shift its reply schedule or resurrect it after line two', t => {
  const f = fixture(t); f.enable(); const first = f.due(); const published = publish(f, first);
  const replyAt = Date.parse(f.channel().nextAt);
  assert.ok(replyAt >= f.now() + 180000 && replyAt <= f.now() + 360000);
  f.advance(1000); f.syncBoth();
  f.store.finish(first.clientId, { reservationId: published.reservationId, delivery: 'confirmed', submitted: true });
  assert.equal(Date.parse(f.channel().nextAt), replyAt);
  const second = f.due();
  assert.notEqual(second.id, first.id); assert.notEqual(second.account, first.account); assert.ok(second.text.startsWith('[companion bot]'));
  publish(f, second); const after = f.channel().nextAt;
  f.store.finish(first.clientId, { reservationId: published.reservationId, delivery: 'confirmed', submitted: true });
  assert.equal(f.channel().nextAt, after); assert.equal(f.offers().length, 0); assert.equal(f.channel().usedScenes, 1);
});

test('review: uncertain or rejected first delivery cannot create line two, even if confirmed later', t => {
  for (const delivery of ['unknown', 'rejected']) {
    const f = fixture(t); f.enable(); const first = f.due(); const submitted = publish(f, first, delivery);
    f.advance(360001); f.syncBoth(); assert.equal(f.offers().length, 0, delivery);
    try { f.store.finish(first.clientId, { reservationId: submitted.reservationId, delivery: 'confirmed', submitted: true }); }
    catch (error) { assert.ok(error.status >= 400 && error.status < 500); }
    assert.equal(f.offers().length, 0, `${delivery} cannot be revived into a reply`);
    assert.equal(f.channel().usedScenes, 1);
    assert.ok(Date.parse(f.channel().nextAt) > f.now(), 'a new exchange needs a future schedule');
  }
});

test('review: disabling after first confirmation cancels the pending reply and re-enabling starts a fresh warmup', t => {
  const f = fixture(t); f.enable(); const first = f.due(); const submitted = publish(f, first);
  const oldReplyAt = Date.parse(f.channel().nextAt);
  f.store.setExchangesEnabled(false); f.setTime(oldReplyAt + 1); f.syncBoth();
  assert.equal(f.offers().length, 0); assert.equal(f.store.status().exchanges.enabled, false);
  f.store.setExchangesEnabled(true); f.syncBoth();
  assert.ok(Date.parse(f.channel().nextAt) >= f.now() + 3600000);
  f.store.finish(first.clientId, { reservationId: submitted.reservationId, delivery: 'confirmed', submitted: true });
  assert.equal(f.offers().length, 0); assert.equal(f.channel().usedScenes, 1);
});

test('review: a reserved line cannot begin after a partner disconnects or changes broadcast', t => {
  for (const change of [{ connected: false, ready: false }, { exchangeContext: { streamId: '987654321', checkedAt: START + 3600001, lastHumanAt: 0 } }]) {
    const f = fixture(t); f.enable(); const first = f.due(); const reservation = claim(f, first);
    const partner = CLIENTS.find(x => x.id !== first.clientId);
    f.sync(partner.id, change);
    assert.equal(f.store.begin(first.clientId, { reservationId: reservation.reservationId }).ok, false);
    assert.equal(f.offers().length, 0);
  }
});

test('review: unused expired exchange permission cannot reoffer its consumed line', t => {
  const f = fixture(t); f.enable(); const first = f.due(); const reservation = claim(f, first);
  f.advance(20001); f.syncBoth();
  assert.equal(f.store.begin(first.clientId, { reservationId: reservation.reservationId }).ok, false);
  assert.equal(f.offers().some(x => x.id === first.id), false);
  assert.equal(f.channel().usedScenes, 1);
  assert.ok(Date.parse(f.channel().nextAt) > f.now());
});

test('review: line ownership, broadcast, curated text and request identity are bound before permission', t => {
  const f = fixture(t); f.enable(); const first = f.due();
  const partner = CLIENTS.find(x => x.id !== first.clientId);
  rejects(() => f.store.reserve(partner.id, proposal(first)));
  rejects(() => f.store.reserve(first.clientId, proposal(first, { textKey: messageKey(first.text + ' unexpected extra content') })));
  rejects(() => f.store.reserve(first.clientId, proposal(first, { streamId: '987654321' })));
  const valid = claim(f, first);
  assert.throws(() => f.store.reserve(first.clientId, { ...valid.body, exchangeId: first.id + '-changed' }), error => error.status === 409);
});

test('review: restart preserves future timers, cancels active replies, and rebases overdue schedules', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'companion-exchange-review-'));
  const f = fixture(t, join(dir, 'host.sqlite'));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  f.enable(); const scheduled = f.channel().nextAt;
  f.advance(30000); f.reopen(); f.syncBoth(); assert.equal(f.channel().nextAt, scheduled);
  const first = f.due(); publish(f, first); f.advance(1000); f.reopen(); f.syncBoth();
  assert.equal(f.offers().length, 0); assert.equal(f.channel().usedScenes, 1);
  assert.ok(Date.parse(f.channel().nextAt) >= f.now() + 3600000);
  f.advance(3 * 3600000); f.reopen(); f.syncBoth();
  assert.equal(f.offers().length, 0); assert.ok(Date.parse(f.channel().nextAt) >= f.now() + 3600000);
});

test('review: cancelled scenes are never reused and exhaustion stays quiet across toggles and a new broadcast', t => {
  const f = fixture(t); f.enable(); const total = f.channel().totalScenes;
  assert.ok(Number.isInteger(total) && total > 0 && total < 128, 'the curated catalog is nonempty and bounded');
  const texts = new Set();
  for (let index = 0; index < total; index++) {
    const first = f.due();
    assert.equal(texts.has(first.text), false, 'a consumed scene cannot return the same opening line'); texts.add(first.text);
    claim(f, first); f.store.setExchangesEnabled(false); f.store.setExchangesEnabled(true); f.syncBoth();
    assert.equal(f.channel().usedScenes, index + 1);
  }
  f.advance(3 * 3600000); f.syncBoth();
  assert.equal(f.channel().state, 'exhausted'); assert.equal(f.offers().length, 0);
  f.store.setExchangesEnabled(false); f.store.setExchangesEnabled(true);
  for (const client of CLIENTS) f.sync(client.id, { exchangeContext: { streamId: '987654321', checkedAt: f.now(), lastHumanAt: 0 } });
  assert.equal(f.offers().length, 0); assert.equal(f.channel().usedScenes, total);
});

test('review: returning after missed check-ins cannot immediately publish an overdue scheduled exchange', t => {
  const f = fixture(t); f.enable(); const oldAt = Date.parse(f.channel().nextAt);
  f.setTime(oldAt + 1); f.syncBoth();
  assert.equal(f.offers().length, 0);
  assert.ok(Date.parse(f.channel().nextAt) >= f.now() + 3600000);
  assert.equal(f.channel().usedScenes, 0, 'an overdue timer must not consume a scene on return');
});

test('review: resuming central coordination after a missed timer begins a new warmup', t => {
  const f = fixture(t); f.enable(); const oldAt = Date.parse(f.channel().nextAt);
  f.store.setPaused(true); f.healthyTo(oldAt + 1); assert.equal(f.offers().length, 0);
  f.store.setPaused(false); f.syncBoth();
  assert.equal(f.offers().length, 0);
  assert.ok(Date.parse(f.channel().nextAt) >= f.now() + 3600000);
  assert.equal(f.channel().usedScenes, 0);
});
