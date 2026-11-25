import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from '../lib/store.mjs';
import { messageKey, EXCHANGE_POLICY as P, SCENES } from '../lib/exchanges.mjs';

const START = 1800000000000, channel = 'three_channel', streamId = '123456789';
const clients = ['primary', 'test', 'third'].map(id => ({ id, account: `${id}_companion` }));
const pairKey = offer => [offer.account, /^\[companion bot\] @([a-z0-9_]+) /.exec(offer.text)?.[1]].sort().join(':');
function fixture(t, { persistent = false } = {}) {
  let time = START;
  const dir = persistent ? mkdtempSync(join(tmpdir(), 'three-exchanges-')) : null, file = dir ? join(dir, 'state.sqlite') : ':memory:';
  let store = new HostStore({ file, clients, now: () => time, random: () => 0 });
  const state = new Map(clients.map(c => [c.id, {}]));
  t.after(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const sync = id => store.sync(id, { channel, connected: true, ready: true,
    playback: { status: 'playing', checkedAt: time }, exchangeContext: { streamId, checkedAt: time, lastHumanAt: 0 }, ...state.get(id) });
  const syncAll = () => { for (const c of clients) sync(c.id); store.status(); };
  const schedule = () => store.status().exchanges.channels.find(c => c.channel === channel);
  const offers = () => clients.flatMap(c => { const offer = store.snapshot(c.id, channel).exchange; return offer ? [{ clientId: c.id, ...offer }] : []; });
  const healthyTo = target => { assert.ok(target >= time); do { time = Math.min(target, time + 20000); syncAll(); } while (time < target); };
  const due = () => { const next = Date.parse(schedule().nextAt); assert.ok(Number.isFinite(next)); healthyTo(Math.max(time, next)); const current = offers(); assert.equal(current.length, 1); return current[0]; };
  const accountId = offer => clients.find(c => c.account === offer.account).id;
  const reserve = offer => store.reserve(accountId(offer), { requestId: randomUUID(), channel, streamId, kind: 'exchange', exchangeId: offer.id, textKey: messageKey(offer.text) });
  const deliver = (offer, delivery = 'confirmed') => { const permit = reserve(offer); assert.equal(permit.ok, true, JSON.stringify(permit)); assert.equal(store.begin(accountId(offer), { reservationId: permit.reservationId }).ok, true);
    store.finish(accountId(offer), { reservationId: permit.reservationId, delivery, submitted: true }); return permit; };
  const complete = () => { const first = due(); deliver(first); const second = due(); assert.equal(pairKey(second), pairKey(first)); assert.notEqual(second.account, first.account); deliver(second); return { first, second }; };
  syncAll();
  return { get store() { return store; }, now: () => time, state, sync, syncAll, schedule, offers, healthyTo, due, reserve, deliver, complete,
    enable() { store.setExchangesEnabled(true); },
    reopen() { store.close(); store = new HostStore({ file, clients, now: () => time, random: () => 0 }); syncAll(); } };
}

test('three personal companions rotate all pairs fairly while keeping exactly two tagged lines per scene', t => {
  const f = fixture(t); f.enable();
  const pairs = new Map(), initiators = new Set(), previousInitiator = new Map(), lines = new Set();
  for (let i = 0; i < 6; i++) {
    const { first, second } = f.complete(), key = pairKey(first); pairs.set(key, (pairs.get(key) || 0) + 1); initiators.add(first.account);
    if (previousInitiator.has(key)) assert.notEqual(first.account, previousInitiator.get(key), 'a revisited pair alternates its own initiator');
    previousInitiator.set(key, first.account);
    for (const offer of [first, second]) { assert.match(offer.text, /^\[companion bot\] @/); assert.equal(lines.has(offer.text), false); lines.add(offer.text); }
    assert.equal(f.offers().length, 0); assert.equal(f.schedule().usedScenes, i + 1);
    assert.equal(Date.parse(f.schedule().nextAt) - f.now(), P.intervalMinMs);
  }
  assert.equal(pairs.size, 3); assert.deepEqual([...pairs.values()], [2, 2, 2]); assert.equal(initiators.size, 3); assert.equal(lines.size, 12);
});

test('an active pair is immutable while the unrelated third leaves or changes broadcast', t => {
  const f = fixture(t); f.enable(); const first = f.due(), key = pairKey(first);
  assert.equal(key, 'primary_companion:test_companion');
  f.state.set('third', { connected: false }); f.sync('third');
  assert.equal(f.offers()[0].id, first.id); assert.equal(pairKey(f.offers()[0]), key);
  f.deliver(first);
  f.state.set('third', { exchangeContext: { streamId: '999', checkedAt: f.now(), lastHumanAt: 0 } }); f.sync('third');
  const second = f.due(); assert.equal(pairKey(second), key); assert.equal(second.account, 'test_companion'); f.deliver(second);
  assert.equal(f.schedule().usedScenes, 1);
});

test('a selected partner cannot be replaced by the third account and a new pair waits a full interval', t => {
  const f = fixture(t); f.enable(); const first = f.due(); f.deliver(first);
  f.state.set('test', { connected: false }); f.sync('test');
  assert.equal(f.offers().length, 0); assert.equal(f.schedule().usedScenes, 1);
  assert.equal(Date.parse(f.schedule().nextAt) - f.now(), P.intervalMinMs);
  f.healthyTo(f.now() + P.replyMinMs); assert.equal(f.offers().length, 0);
  const next = f.due(); assert.notEqual(next.id, first.id); assert.equal(pairKey(next), 'primary_companion:third_companion'); assert.equal(f.schedule().usedScenes, 2);
});

test('human activity observed by the third defers an existing pair without changing ownership', t => {
  const f = fixture(t); f.enable(); const first = f.due(), originalKey = pairKey(first);
  f.state.set('third', { exchangeContext: { streamId, checkedAt: f.now(), lastHumanAt: f.now() } }); f.sync('third');
  assert.equal(f.offers().length, 0); assert.equal(f.reserve(first).code, 'exchange_quiet');
  f.state.set('third', {}); f.sync('third'); f.healthyTo(f.now() + P.quietMs + 1);
  const resumed = f.offers(); assert.equal(resumed.length, 1); assert.equal(resumed[0].id, first.id); assert.equal(pairKey(resumed[0]), originalKey);
});

test('unknown delivery from a pair containing third never unlocks a reply or repeats its scene', t => {
  const f = fixture(t); f.state.set('test', { connected: false }); f.sync('test'); f.enable();
  const first = f.due(); assert.equal(pairKey(first), 'primary_companion:third_companion'); f.deliver(first, 'unknown');
  assert.equal(f.offers().length, 0); assert.equal(f.schedule().usedScenes, 1);
  f.healthyTo(f.now() + P.replyMaxMs + 1); assert.equal(f.offers().length, 0);
  const next = f.due(); assert.notEqual(next.text, first.text); assert.notEqual(next.id, first.id); assert.equal(f.schedule().usedScenes, 2);
});

test('durable pair history survives host restart and the active scene remains cancelled', t => {
  const f = fixture(t, { persistent: true }); f.enable(); const first = f.due(); f.reopen();
  assert.equal(f.offers().length, 0); assert.equal(f.reserve(first).code, 'exchange_cancelled'); assert.equal(f.schedule().usedScenes, 1);
  const next = f.due(); assert.equal(pairKey(next), 'primary_companion:third_companion'); assert.notEqual(next.id, first.id);
});

test('all pairs share one finite scene catalogue and exhaustion stays quiet', t => {
  const f = fixture(t); f.enable(); const seen = new Set(), pairCounts = new Map();
  for (let i = 0; i < SCENES.length; i++) {
    const { first, second } = f.complete(), key = pairKey(first); pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
    assert.equal(seen.has(first.text), false); assert.equal(seen.has(second.text), false); seen.add(first.text); seen.add(second.text);
  }
  assert.equal(f.schedule().usedScenes, SCENES.length); assert.equal(pairCounts.size, 3);
  assert.ok(Math.max(...pairCounts.values()) - Math.min(...pairCounts.values()) <= 1);
  f.healthyTo(f.now() + P.intervalMaxMs + 1); assert.equal(f.offers().length, 0); assert.equal(f.schedule().state, 'exhausted');
  f.store.setExchangesEnabled(false); f.enable(); f.healthyTo(f.now() + P.intervalMaxMs + 1); assert.equal(f.offers().length, 0); assert.equal(f.schedule().usedScenes, SCENES.length);
});
