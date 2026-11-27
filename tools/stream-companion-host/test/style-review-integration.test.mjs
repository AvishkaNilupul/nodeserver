import test from 'node:test';
import assert from 'node:assert/strict';
import { HostStore } from '../lib/store.mjs';
import { digest, PROFILE_IDS } from '../lib/bank.mjs';
import { prepareStyleBank } from '../lib/style-review.mjs';
import { STYLE_PROFILES } from '../lib/style-catalog.mjs';

function fixture(t) {
  let now = 1_800_000_000_000;
  const clients = PROFILE_IDS.map(id => ({ id, account: `fixture_${id}` }));
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true, now: () => now, random: () => 0 });
  t.after(() => store.close());
  for (const client of clients) for (const source of ['helper', 'browser']) {
    const records = [], preferences = source === 'browser' ? { chatMode: 'participate', replySource: 'local' } : undefined;
    store.director.importPage(client.id, { source, importId: `${client.id}-${source}`, page: 0, final: true, records,
      ...(preferences ? { preferences } : {}), digest: digest(JSON.stringify({ records, preferences: preferences ?? null })) });
  }
  const observe = (id, messages = []) => {
    store.sync(id, { channel: 'fixture_channel', connected: true, ready: true, playback: { status: 'playing', checkedAt: now }, seed: [],
      exchangeContext: { streamId: 'fixture_stream', checkedAt: now, lastHumanAt: 0 } });
    return store.director.observe(id, { protocol: 1, binding: { generation: 'fixture_generation', sessionId: `session_${id}`, settingsRevision: 1 }, armed: true,
      streamContext: { channel: 'fixture_channel', streamId: 'fixture_stream', gameName: 'Art', title: 'Fixture', checkedAt: now, isLive: true },
      messages, restrictions: { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false } }).director;
  };
  return { store, observe, now: () => now, advance(ms) { now += ms; } };
}

test('the existing director accepts the proposed bank and binds each exact reply to its account style and revision', t => {
  const f = fixture(t), before = f.store.director.status();
  const proposal = prepareStyleBank(before.bank);
  const saved = f.store.director.saveBank({ requestId: 'reviewed-style-bank', expectedRevision: before.revision, bank: proposal.bank });
  assert.equal(saved.revision, before.revision + 1);
  for (const id of PROFILE_IDS) {
    const plan = f.observe(id, [{ id: `incoming_${id}`, author: 'fixture_viewer', text: `@fixture_${id} thanks`, at: f.now(), channel: 'fixture_channel' }]).plan;
    assert.ok(plan, id); assert.equal(plan.clientId, id); assert.equal(plan.category, 'thanks');
    assert.ok(STYLE_PROFILES[id].replies.thanks.includes(plan.text));
    assert.equal(plan.exactKey, digest(plan.text)); assert.equal(plan.bankRevision, saved.revision);
    assert.equal(plan.replyId, `incoming_${id}`);
    for (const other of PROFILE_IDS.filter(other => other !== id)) assert.ok(!STYLE_PROFILES[other].replies.thanks.includes(plan.text));
  }
  assert.equal(f.store.director.history().history.length, 0, 'planning is not delivery');
  assert.equal(f.store.budget('fixture_channel').count, 0);
});

test('proposing and saving styles preserves submitted history, consumed greeting, budget and scene identities', t => {
  const f = fixture(t), plan = f.observe('primary').plan;
  const lease = f.store.reserve('primary', { requestId: 'fixture-send', channel: plan.channel, streamId: plan.streamId, kind: plan.kind,
    text: plan.text, textKey: plan.textKey, replyId: plan.replyId, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding: plan.binding });
  assert.equal(lease.ok, true);
  assert.equal(f.store.begin('primary', { reservationId: lease.reservationId, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding: plan.binding }).ok, true);
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'confirmed', submitted: true,
    outcome: { at: f.now(), messageId: 'fixture_provider_message', reason: '' } });
  const history = f.store.director.history(), scenes = f.store.director.scenes(), current = f.store.director.status();
  const proposal = prepareStyleBank(current.bank);
  f.store.director.saveBank({ requestId: 'styles-after-confirmation', expectedRevision: current.revision, bank: proposal.bank });
  assert.deepEqual(f.store.director.history(), history);
  assert.deepEqual(f.store.director.scenes(), scenes);
  assert.equal(f.store.budget('fixture_channel').count, 1);
  assert.equal(f.store.director.consumed(plan.opportunityKey), true);
  f.advance(600001);
  assert.equal(f.observe('primary').plan, undefined, 'new group IDs do not repeat a consumed greeting or start a disabled questionnaire');
});
