import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostStore } from '../lib/store.mjs';
import { messageKey, EXCHANGE_POLICY as P } from '../lib/exchanges.mjs';

const START = 1_800_000_000_000, channel = 'four_channel', streamId = '123456789';
const clients = ['primary', 'test', 'third', 'fourth'].map(id => ({ id, account: `${id}_companion` }));
const pairKey = offer => [offer.account, /^@([a-z0-9_]+) /.exec(offer.text)?.[1]].sort().join(':');
function fixture(t) {
  let time = START;
  const store = new HostStore({ file: ':memory:', clients, now: () => time, random: () => 0 }); t.after(() => store.close());
  const state = new Map(clients.map(c => [c.id, {}]));
  const sync = id => store.sync(id, { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: time },
    exchangeContext: { streamId, checkedAt: time, lastHumanAt: 0 }, ...state.get(id) });
  const syncAll = () => { for (const client of clients) sync(client.id); store.status(); };
  const schedule = () => store.status().exchanges.channels.find(x => x.channel === channel);
  const offers = () => clients.flatMap(client => { const value = store.snapshot(client.id, channel).exchange; return value ? [{ clientId: client.id, ...value }] : []; });
  const healthyTo = target => { assert.ok(target >= time); do { time = Math.min(target, time + 20000); syncAll(); } while (time < target); };
  const due = () => { const next = Date.parse(schedule().nextAt); assert.ok(Number.isFinite(next)); healthyTo(Math.max(time, next)); const current = offers(); assert.equal(current.length, 1); return current[0]; };
  const deliver = (offer, delivery = 'confirmed') => {
    const permit = store.reserve(offer.clientId, { requestId: randomUUID(), channel, streamId, kind: 'exchange', exchangeId: offer.id, textKey: messageKey(offer.text) });
    assert.equal(permit.ok, true, JSON.stringify(permit)); assert.equal(store.begin(offer.clientId, { reservationId: permit.reservationId }).ok, true);
    store.finish(offer.clientId, { reservationId: permit.reservationId, delivery, submitted: true }); return permit;
  };
  const complete = () => { const first = due(); deliver(first); const second = due(); assert.equal(pairKey(second), pairKey(first)); assert.notEqual(second.account, first.account); deliver(second); return { first, second }; };
  syncAll(); store.setExchangesEnabled(true);
  return { store, state, sync, syncAll, schedule, offers, healthyTo, due, deliver, complete, now: () => time };
}

test('four personal companions rotate all six eligible pairs and retain one two-line scene at a time', t => {
  const f = fixture(t), counts = new Map(), initiators = new Map(), texts = new Set();
  for (let run = 0; run < 12; run++) {
    const { first, second } = f.complete(), key = pairKey(first); counts.set(key, (counts.get(key) || 0) + 1);
    if (initiators.has(key)) assert.notEqual(first.account, initiators.get(key), 'each revisited pair alternates its initiator');
    initiators.set(key, first.account);
    for (const offer of [first, second]) { assert.match(offer.text, /^@[a-z0-9_]+ \S/); assert.equal(texts.has(offer.text), false); texts.add(offer.text); }
    assert.equal(f.offers().length, 0); assert.equal(f.schedule().usedScenes, run + 1);
    assert.equal(Date.parse(f.schedule().nextAt) - f.now(), P.intervalMinMs);
  }
  assert.equal(counts.size, 6); assert.ok([...counts.values()].every(count => count === 2)); assert.equal(texts.size, 24);
});

test('the two unrelated companions cannot change or replace the active pair', t => {
  const f = fixture(t), first = f.due(), originalKey = pairKey(first);
  const pair = new Set(originalKey.split(':')), unrelated = clients.filter(x => !pair.has(x.account));
  f.state.set(unrelated[0].id, { connected: false }); f.sync(unrelated[0].id);
  f.state.set(unrelated[1].id, { exchangeContext: { streamId: '999', checkedAt: f.now(), lastHumanAt: 0 } }); f.sync(unrelated[1].id);
  assert.equal(f.offers()[0].id, first.id); assert.equal(pairKey(f.offers()[0]), originalKey); f.deliver(first);
  const second = f.due(); assert.equal(pairKey(second), originalKey); f.deliver(second); assert.equal(f.schedule().usedScenes, 1);
});

test('uncertain fourth delivery consumes its scene and never authorizes the second line', t => {
  const f = fixture(t); f.state.set('test', { connected: false }); f.sync('test'); f.state.set('third', { connected: false }); f.sync('third');
  const first = f.due(); assert.equal(pairKey(first), 'fourth_companion:primary_companion'); f.deliver(first, 'unknown');
  assert.equal(f.offers().length, 0); assert.equal(f.schedule().usedScenes, 1);
  f.healthyTo(f.now() + P.replyMaxMs + 1); assert.equal(f.offers().length, 0);
  const next = f.due(); assert.notEqual(next.id, first.id); assert.notEqual(next.text, first.text); assert.equal(f.schedule().usedScenes, 2);
});
