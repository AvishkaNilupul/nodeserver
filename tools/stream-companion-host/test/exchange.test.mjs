import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HostStore } from '../lib/store.mjs';
import { messageKey, SCENES, renderLine, EXCHANGE_POLICY as P } from '../lib/exchanges.mjs';
import { messageKey as helperMessageKey } from '../../stream-companion/extension/message-policy.js';

const START = 1800000000000, channel = 'sample_channel', streamId = '123456789';
const clients = [{ id: 'alpha', account: 'alpha_companion' }, { id: 'beta', account: 'beta_companion' }];
function fixture(t, { random = () => 0, clients: roster = clients } = {}) {
  let time = START;
  const store = new HostStore({ file: ':memory:', clients: roster, now: () => time, random });
  t.after(() => store.close());
  const sync = (id, extra = {}) => store.sync(id, { channel, connected: true, ready: true,
    playback: { status: 'playing', checkedAt: time }, exchangeContext: { streamId, checkedAt: time, lastHumanAt: 0 }, ...extra });
  const both = () => { for (const c of roster) sync(c.id); };
  const advance = (ms, alive = false) => {
    if (alive) { while (ms > 0) { const step = Math.min(20000, ms); time += step; ms -= step; both(); } }
    else time += ms;
  };
  const scheduled = () => store.status().exchanges.channels.find(c => c.channel === channel);
  const due = () => { advance(Date.parse(scheduled().nextAt) - time, true); both(); return offer(); };
  const offer = () => { for (const c of roster) { const x = store.snapshot(c.id, channel).exchange; if (x) return { id: c.id, ...x }; } };
  const prepare = x => ({ requestId: randomUUID(), channel, streamId, kind: 'exchange', exchangeId: x.id, textKey: messageKey(x.text) });
  const reserve = x => store.reserve(roster.find(c => c.account === x.account).id, prepare(x));
  const begin = (x, permit) => store.begin(roster.find(c => c.account === x.account).id, { reservationId: permit.reservationId });
  const finish = (x, permit, delivery = 'confirmed') => store.finish(roster.find(c => c.account === x.account).id, { reservationId: permit.reservationId, delivery, submitted: delivery !== 'cancelled' });
  both();
  return { store, sync, both, advance, scheduled, due, offer, prepare, reserve, begin, finish, now: () => time };
}

test('all curated lines identify bots, mention the partner, fit longest handles and share production hashing', () => {
  assert.equal(new Set(SCENES.map(x => x.id)).size, SCENES.length);
  for (const scene of SCENES) for (const turn of [1, 2]) {
    const text = renderLine(scene.id, turn, 'a'.repeat(25));
    assert.match(text, /^\[companion bot\] @a{25} \S/);
    assert.ok(text.length <= 300);
    assert.doesNotMatch(text, /[\r\n]|https?:|www\./i);
    assert.equal(messageKey(text), helperMessageKey(text));
  }
});

test('exchanges default disabled; enable schedules a full warmup and emits one exact due offer', t => {
  const f = fixture(t);
  assert.equal(f.store.status().exchanges.enabled, false);
  assert.equal(f.offer(), undefined);
  f.store.setExchangesEnabled(true);
  assert.equal(Date.parse(f.scheduled().nextAt) - f.now(), P.intervalMinMs);
  assert.equal(f.offer(), undefined);
  const x = f.due(); assert.ok(x);
  assert.equal(x.key, `exchange:${x.id}`);
  assert.equal(x.streamId, streamId);
  assert.equal(x.notBefore, f.now());
  assert.equal(x.expiresAt - f.now(), P.deadlineMs);
  assert.equal(f.scheduled().usedScenes, 1);
  const other = clients.find(c => c.account !== x.account);
  assert.equal(f.store.snapshot(other.id, channel).exchange, undefined);
});

test('only confirmed first delivery unlocks one delayed second line and duplicate finish preserves its deadline', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true);
  const first = f.due(), permit = f.reserve(first); assert.equal(permit.ok, true, JSON.stringify(permit));
  assert.equal(f.begin(first, permit).ok, true);
  assert.equal(f.begin(first, permit).ok, false);
  f.finish(first, permit);
  const secondAt = Date.parse(f.scheduled().nextAt);
  assert.equal(secondAt - f.now(), P.replyMinMs);
  assert.equal(f.offer(), undefined);
  f.advance(15000, true); f.finish(first, permit);
  assert.equal(Date.parse(f.scheduled().nextAt), secondAt);
  f.advance(secondAt - f.now(), true);
  const second = f.offer(); assert.ok(second);
  assert.notEqual(second.id, first.id); assert.notEqual(second.account, first.account);
  const secondPermit = f.reserve(second); assert.equal(secondPermit.ok, true, JSON.stringify(secondPermit));
  assert.equal(f.begin(second, secondPermit).ok, true); f.finish(second, secondPermit);
  assert.equal(f.offer(), undefined);
  assert.equal(Date.parse(f.scheduled().nextAt) - f.now(), P.intervalMinMs);
  assert.equal(f.store.status().channels[0].attemptsLastHour, 2);
});

test('unknown, rejected and unused cancelled first turns never unlock a second line', t => {
  for (const outcome of ['unknown', 'rejected', 'cancelled']) {
    const f = fixture(t); f.store.setExchangesEnabled(true);
    const x = f.due(), permit = f.reserve(x); assert.equal(permit.ok, true);
    if (outcome !== 'cancelled') assert.equal(f.begin(x, permit).ok, true);
    f.finish(x, permit, outcome);
    f.advance(6 * 60000, true);
    assert.equal(f.offer(), undefined);
    assert.equal(f.scheduled().usedScenes, 1);
    if (outcome === 'unknown') {
      f.finish(x, permit, 'confirmed');
      assert.equal(f.offer(), undefined, 'late confirmed unknown result cannot resurrect a cancelled exchange');
    }
  }
});

test('exact account, broadcast, text and exchange ID are bound at reserve and immutable under request replay', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true); const x = f.due();
  const own = clients.find(c => c.account === x.account).id, other = clients.find(c => c.account !== x.account).id;
  for (const [id, change] of [[other, {}], [own, { streamId: '999' }], [own, { textKey: messageKey('different line') }]]) {
    assert.equal(f.store.reserve(id, { ...f.prepare(x), ...change }).ok, false);
  }
  const body = f.prepare(x), permit = f.store.reserve(own, body); assert.equal(permit.ok, true);
  assert.throws(() => f.store.reserve(own, { ...body, exchangeId: randomUUID() }), { status: 409 });
  assert.throws(() => f.store.reserve(own, { ...body, requestId: randomUUID(), replyId: 'fake_reply' }), { status: 400 });
  assert.throws(() => f.store.reserve(own, { ...body, requestId: randomUUID(), kind: 'conversation' }), { status: 400 });
  assert.equal(f.store.reserve(own, { ...body, requestId: randomUUID() }).ok, false);
  assert.equal(f.begin(x, permit).ok, true);
});

test('human activity defers a due exchange and the 90-second quiet guard is rechecked before begin', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true);
  f.advance(Date.parse(f.scheduled().nextAt) - f.now(), true);
  f.both(); const x = f.offer(), permit = f.reserve(x); assert.equal(permit.ok, true);
  f.sync('beta', { exchangeContext: { streamId, checkedAt: f.now(), lastHumanAt: f.now() } });
  assert.equal(f.begin(x, permit).code, 'exchange_quiet');
  f.finish(x, permit, 'cancelled');
  assert.equal(f.scheduled().usedScenes, 1);
  const nextAt = Date.parse(f.scheduled().nextAt);
  while (f.now() < nextAt) {
    f.advance(Math.min(20000, nextAt - f.now()));
    for (const c of clients) f.sync(c.id, { exchangeContext: { streamId, checkedAt: f.now(), lastHumanAt: f.now() } });
  }
  assert.equal(f.offer(), undefined); assert.equal(f.scheduled().state, 'quiet_wait');
  assert.equal(f.scheduled().usedScenes, 1, 'quiet waiting does not consume another scene');
});

test('both partners require current metadata and playback and partner loss cancels unused permission', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true);
  f.sync('beta', { exchangeContext: { streamId, checkedAt: f.now() - 120001, lastHumanAt: 0 } });
  assert.equal(f.offer(), undefined);
  f.sync('beta', { exchangeContext: { streamId, checkedAt: f.now() + 5001, lastHumanAt: 0 } });
  assert.equal(f.offer(), undefined);
  f.sync('beta'); const x = f.due(), permit = f.reserve(x); assert.equal(permit.ok, true);
  const other = clients.find(c => c.account !== x.account);
  f.sync(other.id, { ready: false });
  assert.equal(f.begin(x, permit).ok, false);
  assert.equal(f.offer(), undefined);
  assert.equal(f.scheduled().usedScenes, 1);
  assert.equal(f.store.status().channels[0].attemptsLastHour, 0);
});

test('an unused lease expiring consumes its scene and cannot reoffer its original line', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true);
  const x = f.due(), permit = f.reserve(x); assert.equal(permit.ok, true);
  f.advance(20001); f.both();
  assert.equal(f.begin(x, permit).ok, false); assert.equal(f.offer(), undefined);
  assert.equal(f.scheduled().usedScenes, 1);
  f.both(); const next = f.due(); assert.ok(next); assert.notEqual(next.id, x.id); assert.notEqual(next.text, x.text);
  assert.notEqual(next.account, x.account, 'initiators alternate even when an exchange was cancelled');
});

test('per-account participation spacing, shared limits and useful direct replies have priority', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true);
  f.advance(Date.parse(f.scheduled().nextAt) - f.now(), true); f.both();
  const x = f.offer(); assert.ok(x);
  const ordinary = { requestId: randomUUID(), channel, streamId, kind: 'conversation', textKey: messageKey('useful incoming conversation'), replyId: 'human_message', replyAt: f.now() };
  const permit = f.store.reserve('alpha', ordinary); assert.equal(permit.ok, true);
  assert.equal(f.offer(), undefined);
  assert.equal(f.store.begin('alpha', { reservationId: permit.reservationId }).ok, true);
  f.store.finish('alpha', { reservationId: permit.reservationId, delivery: 'confirmed', submitted: true });
  assert.equal(f.offer(), undefined);
  f.advance(P.accountGapMs - 1, true); assert.equal(f.offer(), undefined);
  f.advance(1, true); assert.ok(f.offer());
});

test('an active exchange has a 20-minute deadline even while human activity keeps deferring it', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true); const x = f.due();
  const original = f.now();
  while (f.now() < original + P.deadlineMs) {
    f.advance(20000);
    for (const c of clients) f.sync(c.id, { exchangeContext: { streamId, checkedAt: f.now(), lastHumanAt: f.now() } });
  }
  assert.equal(f.offer(), undefined);
  const body = f.prepare(x);
  assert.equal(f.store.reserve(clients.find(c => c.account === x.account).id, body).code, 'exchange_cancelled');
  assert.equal(f.scheduled().usedScenes, 1);
});

test('exactly two active clients are required, with no exchange when a third joins', t => {
  const f = fixture(t, { clients: [...clients, { id: 'gamma', account: 'gamma_companion' }] });
  f.store.setExchangesEnabled(true);
  assert.equal(f.scheduled().state, 'waiting_for_partners'); assert.equal(f.offer(), undefined);
});

test('a foreign invalid exchange proposal cannot monopolize the valid offered line', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true); const x = f.due();
  const foreign = clients.find(c => c.account !== x.account);
  const denied = f.store.reserve(foreign.id, f.prepare(x)); assert.equal(denied.code, 'exchange_invalid');
  assert.equal(f.reserve(x).ok, true);
});

test('late confirmed completion after the full deadline cannot resurrect a second line without a prior status poll', t => {
  const f = fixture(t); f.store.setExchangesEnabled(true); const x = f.due(), permit = f.reserve(x);
  assert.equal(f.begin(x, permit).ok, true);
  // A frozen helper returns a definitive result after the host saw no updates.
  // Finish itself must notice that this exchange is over before unlocking line2.
  f.advance(P.deadlineMs + 1);
  f.finish(x, permit);
  f.both(); assert.equal(f.offer(), undefined);
  assert.equal(f.scheduled().usedScenes, 1);
  assert.equal(f.store.status().channels[0].attemptsLastHour, 1);
});

test('randomized production delays remain bounded at their minimum and maximum samples', t => {
  for (const sample of [0, 1]) {
    const f = fixture(t, { random: () => sample }); f.store.setExchangesEnabled(true);
    const interval = Date.parse(f.scheduled().nextAt) - f.now();
    assert.equal(interval, sample ? P.intervalMaxMs : P.intervalMinMs);
    const x = f.due(), permit = f.reserve(x); assert.equal(permit.ok, true);
    assert.equal(f.begin(x, permit).ok, true); f.finish(x, permit);
    assert.equal(Date.parse(f.scheduled().nextAt) - f.now(), sample ? P.replyMaxMs : P.replyMinMs);
  }
});
