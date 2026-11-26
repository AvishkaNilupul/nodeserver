import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostStore } from '../lib/store.mjs';
import { digest, defaultBank, validateBank } from '../lib/bank.mjs';
import { messageKey } from '../lib/exchanges.mjs';

const START = 1_800_000_000_000;
const clients = [{ id: 'primary', account: 'first_account' }, { id: 'test', account: 'second_account' }, { id: 'third', account: 'third_account' }];
const channel = 'friend_channel', streamId = '123456789';
const binding = { generation: 'generation-1', sessionId: 'browser-1', settingsRevision: 1 };
const restrictions = { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false };
function fixture(t, options = {}) {
  let now = START;
  const store = new HostStore({ file: ':memory:', clients, directorEnabled: true, now: () => now, random: () => 0, ...options });
  t.after(() => store.close());
  const sync = id => store.sync(id, { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: now }, seed: [], exchangeContext: { streamId, checkedAt: now, lastHumanAt: 0 } });
  const context = () => ({ channel, streamId, gameName: 'Art', title: 'A public title', checkedAt: now, isLive: true });
  const observe = (id = 'primary', extra = {}) => { sync(id); return store.director.observe(id, { protocol: 1, binding, armed: true, streamContext: context(), messages: [], restrictions, ...extra }).director; };
  const page = (id, source, records = [], extra = {}) => {
    const preferences = source === 'browser' ? { chatMode: 'participate', replySource: 'local' } : undefined;
    const payload = { source, importId: `${id}-${source}`, page: 0, final: true, records: records.map(row => ({ recordId: digest(JSON.stringify(row)), ...row })), ...(preferences ? { preferences } : {}), ...extra };
    payload.digest = digest(JSON.stringify({ records: payload.records, preferences: payload.preferences ?? null }));
    return store.director.importPage(id, payload);
  };
  const migrate = () => { for (const c of clients) { page(c.id, 'helper'); page(c.id, 'browser'); } };
  return { store, sync, observe, page, migrate, context, now: () => now, advance(ms) { now += ms; } };
}
function reserve(f, plan, extra = {}) {
  return f.store.reserve(plan.clientId, { requestId: `request-${plan.planId}`, channel: plan.channel, streamId: plan.streamId, kind: plan.kind, text: plan.text, textKey: plan.textKey,
    replyId: plan.replyId, ...(plan.replyId ? { replyAt: plan.replyAt } : {}), ...(plan.exchangeId ? { exchangeId: plan.exchangeId } : {}), planId: plan.planId,
    authorityEpoch: plan.authorityEpoch, binding: plan.binding, ...extra });
}
function begin(f, plan, lease) { return f.store.begin(plan.clientId, { reservationId: lease.reservationId, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding: plan.binding }); }
function incoming(f, text = '@first_account hi', id = 'message-one') { return { id, author: 'human_person', text, at: f.now(), channel }; }

test('director seeds exactly one editable bank and requires every paired source before any automatic offer', t => {
  const f = fixture(t); assert.equal(f.store.director.status().revision, 1);
  assert.equal(f.observe().plan, undefined); assert.equal(f.store.director.ready, false);
  f.page('primary', 'helper'); f.page('primary', 'browser'); assert.equal(f.observe().plan, undefined);
  for (const c of clients.slice(1)) { f.page(c.id, 'helper'); f.page(c.id, 'browser'); }
  const plan = f.observe().plan; assert.equal(plan.kind, 'greeting'); assert.equal(plan.exactKey, digest(plan.text)); assert.equal(plan.textKey, messageKey(plan.text));
});

test('bank CAS/idempotency never rewrites a leased payload and central preferences cannot be overwritten by import', t => {
  const f = fixture(t); f.migrate(); const plan = f.observe().plan, lease = reserve(f, plan); assert.equal(lease.ok, true);
  const current = f.store.director.status(), bank = structuredClone(current.bank); bank.entries.find(x => x.kind === 'greeting').lines = ['a changed greeting'];
  const request = { requestId: 'bank-change', expectedRevision: current.revision, bank };
  const saved = f.store.director.saveBank(request); assert.equal(saved.revision, current.revision + 1);
  assert.deepEqual(f.store.director.saveBank(request), saved);
  assert.throws(() => f.store.director.saveBank({ ...request, expectedRevision: 1 }), /identifier/);
  assert.equal(JSON.parse(f.store.db.prepare('SELECT payload_json FROM director_plans WHERE id=?').get(plan.planId).payload_json).text, plan.text);
  assert.equal(begin(f, plan, lease).ok, false);
  assert.equal(f.observe().plan.text, 'a changed greeting');
});

test('only exact own plan text and current binding can reserve, and begin remains single use', t => {
  const f = fixture(t); f.migrate(); const plan = f.observe().plan;
  assert.throws(() => reserve(f, plan, { text: plan.text.toUpperCase() }), /exact server plan/);
  assert.throws(() => reserve(f, { ...plan, clientId: 'test' }), /does not belong/);
  const lease = reserve(f, plan); assert.equal(lease.ok, true); assert.equal(begin(f, plan, lease).ok, true); assert.equal(begin(f, plan, lease).ok, false);
  assert.equal(f.store.budget(channel).count, 1); assert.equal(f.store.director.history().history.length, 1);
  assert.throws(() => f.store.reserve('test', { requestId: 'old-planner', channel, streamId, kind: 'topic', textKey: messageKey('old automatic text'), replyId: '' }), /does not belong/);
});

test('provider outcomes enrich one canonical row monotonically and unknown never gets a second grant', t => {
  const f = fixture(t); f.migrate(); const plan = f.observe().plan, lease = reserve(f, plan); begin(f, plan, lease);
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'unknown', submitted: true });
  assert.throws(() => reserve(f, plan), /already used/);
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'confirmed', submitted: true, outcome: { at: f.now(), messageId: 'provider-one', reason: '' } });
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'unknown', submitted: true });
  const rows = f.store.director.history().history; assert.equal(rows.length, 1); assert.equal(rows[0].delivery, 'confirmed'); assert.equal(rows[0].messageId, 'provider-one'); assert.equal(rows[0].text, plan.text);
  assert.equal(f.store.budget(channel).count, 1);
});

test('a lost begin response can be certified no-send without consuming greeting or budget', t => {
  const f = fixture(t); f.migrate(); const plan = f.observe().plan, lease = reserve(f, plan); begin(f, plan, lease);
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'cancelled', submitted: false });
  assert.equal(f.store.budget(channel).count, 0); assert.equal(f.observe().plan.kind, 'greeting');
});

test('migration pages are digest-bound, account-bound, ordered and idempotent', t => {
  const f = fixture(t), row = { type: 'history', account: 'first_account', channel, at: f.now() - 1000, text: 'previously posted', delivery: 'unknown', submitted: true, kind: 'greeting', streamId };
  const first = f.page('primary', 'helper', [row]); assert.equal(first.complete, true); assert.deepEqual(f.page('primary', 'helper', [row]), first);
  assert.equal(f.store.budget(channel).count, 1);
  assert.throws(() => f.page('primary', 'helper', [{ ...row, text: 'changed' }]), /cannot change/);
  assert.throws(() => f.page('test', 'helper', [row]), /account history/);
  assert.throws(() => f.page('third', 'helper', [], { page: 1 }), /start at zero/);
});

test('browser participation and handled tombstones survive missing helper text without invented history', t => {
  const f = fixture(t); f.page('primary', 'helper');
  f.page('primary', 'browser', [
    { type: 'participation', account: 'first_account', channel, at: f.now() - 3600000, streamId, kind: 'greeting', participationKey: `participation:first_account:${channel}:${streamId}:greeting`, delivery: 'unknown', submitted: true },
    { type: 'handled', key: `first_account:${channel}:handled-message` }
  ]);
  for (const c of clients.slice(1)) { f.page(c.id, 'helper'); f.page(c.id, 'browser'); }
  assert.equal(f.observe('primary', { messages: [incoming(f, '@first_account hi', 'handled-message')] }).plan.kind, 'topic');
  assert.equal(f.store.director.history().history.length, 0);
});

test('legacy contribution is text unavailable and exact migrated history merges the original permit once', t => {
  const f = fixture(t);
  f.store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run('older-identity', 'first_account', channel, streamId, 'greeting', messageKey('historic greeting'), '', f.now() - 180001, 'unknown');
  f.store.director.legacyContribution(f.store.db.prepare('SELECT * FROM contributions WHERE reservation_id=?').get('older-identity'));
  assert.equal(f.store.director.history().history[0].textAvailable, false);
  f.page('primary', 'helper', [{ type: 'history', account: 'first_account', channel, at: f.now() - 180001, text: 'historic greeting', delivery: 'confirmed', submitted: true, kind: 'greeting', streamId }]);
  f.page('primary', 'browser', [{ type: 'history', account: 'first_account', channel, at: f.now() - 180001, text: 'historic greeting', delivery: 'unknown', submitted: true, kind: 'greeting', streamId }]);
  assert.equal(f.store.budget(channel).count, 1); const rows = f.store.director.history().history; assert.equal(rows.length, 1); assert.equal(rows[0].text, 'historic greeting'); assert.equal(rows[0].delivery, 'confirmed');
});

test('fresh mentions preempt unused greeting and peer/bot messages never become automatic targets', t => {
  const f = fixture(t); f.migrate(); const first = f.observe().plan;
  const reply = f.observe('primary', { messages: [incoming(f)] }).plan;
  assert.equal(reply.replyId, 'message-one'); assert.equal(reply.kind, ''); assert.notEqual(reply.planId, first.planId);
  f.store.director.cancel({ requestId: 'cancel-unused', planId: reply.planId });
  const next = f.observe('primary', { messages: [{ ...incoming(f), author: 'second_account' }, { ...incoming(f), author: 'nightbot' }] }).plan;
  assert.equal(next.kind, 'greeting');
});

test('editable metadata reply is central and disabled category has no hardcoded fallback', t => {
  const f = fixture(t); f.migrate(); let current = f.store.director.status(), bank = structuredClone(current.bank);
  bank.entries.find(x => x.id === 'reply_game').lines = ['current category: {game}'];
  f.store.director.saveBank({ requestId: 'metadata-edit', expectedRevision: current.revision, bank });
  assert.equal(f.observe('primary', { messages: [incoming(f, '@first_account what game is this?')] }).plan.text, 'current category: Art');
  current = f.store.director.status(); bank = structuredClone(current.bank); bank.entries.find(x => x.id === 'reply_game').enabled = false;
  f.store.director.saveBank({ requestId: 'metadata-off', expectedRevision: current.revision, bank });
  assert.equal(f.observe('primary', { messages: [incoming(f, '@first_account what game is this?', 'another-question')] }).plan, undefined);
});

test('AI generation is one durable handled opportunity, fenced by exact target and bank/binding revisions', t => {
  const f = fixture(t); f.migrate(); f.store.director.preferences('primary', { requestId: 'choose-ai', chatMode: 'mentions', replySource: 'ai' });
  const state = f.observe('primary', { messages: [incoming(f)] }), gen = state.generation;
  assert.ok(gen); assert.equal(f.store.director.status().plans[0].state, 'generating');
  const completed = f.store.director.generated('primary', { requestId: gen.requestId, generationId: gen.generationId, binding, result: { text: 'hello from the selected source', reason: 'reply' } });
  const plan = completed.director.plan; const lease = reserve(f, plan); assert.equal(lease.ok, true); assert.equal(begin(f, plan, lease).ok, true);
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'unknown', submitted: true });
  assert.equal(f.observe('primary', { messages: [incoming(f)] }).generation, undefined);
});

test('no-match and interrupted generation do not regenerate after polling or stale returns', t => {
  const f = fixture(t); f.migrate(); f.store.director.preferences('primary', { requestId: 'choose-ai', chatMode: 'mentions', replySource: 'ai' });
  const gen = f.observe('primary', { messages: [incoming(f)] }).generation;
  f.store.director.generated('primary', { requestId: gen.requestId, generationId: gen.generationId, binding, result: { text: '', reason: 'no match' } });
  assert.equal(f.observe('primary', { messages: [incoming(f)] }).generation, undefined);
  const second = f.observe('primary', { messages: [incoming(f, '@first_account hey', 'second-message')] }).generation;
  f.advance(45001); f.observe('primary', { messages: [incoming(f, '@first_account hey', 'second-message')] });
  assert.throws(() => f.store.director.generated('primary', { requestId: second.requestId, generationId: second.generationId, binding, result: { text: 'late answer', reason: '' } }), /no longer current/);
});

test('explicit reviewed manual message receives exact central plan and same history without arming a session', t => {
  const f = fixture(t); f.migrate(); f.observe('primary', { armed: false });
  const request = { requestId: 'reviewed-manual', binding, text: 'an explicitly reviewed message' };
  const result = f.store.director.manual('primary', request); assert.equal(result.director.plan.planId, result.plan.planId); assert.equal(result.plan.source, 'manual');
  assert.equal(f.store.director.manual('primary', request).plan.planId, result.plan.planId);
  const lease = reserve(f, result.plan); assert.equal(begin(f, result.plan, lease).ok, true);
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'rejected', submitted: true });
  assert.equal(f.store.director.history().history[0].delivery, 'rejected'); assert.equal(f.store.budget(channel).count, 1);
});

test('scene edits create permanent content identities and restoring old content cannot bypass consumption', t => {
  const f = fixture(t); const old = f.store.director.scenes()[0];
  f.store.db.prepare('INSERT INTO host_used_scenes VALUES (?,?,?)').run(channel, old.id, f.now());
  let current = f.store.director.status(), bank = structuredClone(current.bank); const entry = bank.entries.find(x => x.kind === 'exchange'); const original = [...entry.lines]; entry.lines = ['a distinct new scene?', 'a distinct new answer.'];
  f.store.director.saveBank({ requestId: 'scene-new', expectedRevision: current.revision, bank }); const replacement = f.store.director.scenes()[0]; assert.notEqual(replacement.id, old.id);
  current = f.store.director.status(); bank = structuredClone(current.bank); bank.entries.find(x => x.kind === 'exchange').lines = original;
  f.store.director.saveBank({ requestId: 'scene-restore', expectedRevision: current.revision, bank }); assert.equal(f.store.director.scenes()[0].id, old.id);
  assert.ok(f.store.db.prepare('SELECT 1 FROM host_used_scenes WHERE channel=? AND scene_id=?').get(channel, old.id));
});

test('public projections omit private binding and transfer IDs and history pagination is bounded', t => {
  const f = fixture(t); f.migrate(); f.observe(); const status = f.store.director.status(), json = JSON.stringify(status);
  for (const secret of ['authorityEpoch', 'settingsRevision', 'browser-1', 'generation-1', 'primary-helper']) assert.equal(json.includes(secret), false, secret);
  assert.ok(Buffer.byteLength(json) < 262144); assert.throws(() => f.store.director.history('all', Number.MAX_SAFE_INTEGER + 1));
});

test('restart cancels only unused work and keeps submitting outcomes, imported ownership and bank revisions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'director-restart-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'host.sqlite'); let now = START;
  const first = new HostStore({ file, clients, directorEnabled: true, now: () => now });
  for (const c of clients) for (const source of ['helper', 'browser']) first.director.importPage(c.id, { source, importId: `${c.id}-${source}`, page: 0, final: true, records: [], digest: digest(JSON.stringify({ records: [], preferences: null })) });
  first.sync('primary', { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: now }, seed: [] });
  first.director.observe('primary', { protocol: 1, binding, armed: false, streamContext: { channel, streamId, gameName: 'Art', isLive: true, checkedAt: now }, messages: [], restrictions });
  const plan = first.director.manual('primary', { requestId: 'pending-manual', binding, text: 'a pending message' }).plan;
  const f = { store: first }; const lease = reserve(f, plan); begin(f, plan, lease); first.close(); now += 130000;
  const reopened = new HostStore({ file, clients, directorEnabled: true, now: () => now }); t.after(() => reopened.close()); reopened.status();
  assert.equal(reopened.director.history().history[0].delivery, 'unknown'); assert.equal(reopened.director.ready, true);
  assert.equal(reopened.director.internal('primary').plan, undefined);
  reopened.finish('primary', { reservationId: lease.reservationId, delivery: 'confirmed', submitted: true, outcome: { messageId: 'late-confirmation' } });
  assert.equal(reopened.director.history().history[0].messageId, 'late-confirmation');
});

test('bank rejects unknown keys, arbitrary substitutions, oversized entries and malformed profile assignments', () => {
  const bank = defaultBank(); assert.equal(validateBank(bank).entries.length, 55);
  for (const change of [b => { b.extra = true; }, b => { b.entries[0].lines = ['a {secret}']; }, b => { b.entries[0].accountIds = ['foreign']; }, b => { b.entries[0].lines = ['https://outside.example']; }, b => { b.profiles.pop(); }]) {
    const input = structuredClone(bank); change(input); assert.throws(() => validateBank(input));
  }
});

test('helper and browser representations before and after local preflight merge without a second budget charge', t => {
  const f = fixture(t);
  const helper = { type: 'history', account: 'first_account', channel, at: f.now() - 200000, text: 'a historic preflight message', delivery: 'unknown', submitted: true, kind: 'greeting', streamId };
  const browser = { ...helper, at: helper.at - 12000, delivery: 'confirmed' };
  f.page('primary', 'helper', [helper]); f.page('primary', 'browser', [browser]);
  assert.equal(f.store.budget(channel).count, 1); assert.equal(f.store.director.history().history.length, 1);
  assert.equal(f.store.director.history().history[0].delivery, 'confirmed');
});

test('director-only status polling ages provider uncertainty without replay or budget loss', t => {
  const f = fixture(t); f.migrate(); const plan = f.observe().plan, lease = reserve(f, plan); begin(f, plan, lease);
  f.advance(120001); const status = f.store.director.status();
  assert.equal(status.history[0].delivery, 'unknown'); assert.equal(f.store.budget(channel).count, 1);
  assert.equal(status.plans.find(x => x.planId === plan.planId).cancellable, false);
});

test('AI result cannot bind a changed body to the original target identity', t => {
  const f = fixture(t); f.migrate(); f.store.director.preferences('primary', { requestId: 'choose-ai', chatMode: 'mentions', replySource: 'ai' });
  const gen = f.observe('primary', { messages: [incoming(f)] }).generation;
  f.observe('primary', { messages: [incoming(f, '@first_account a different body')] });
  assert.throws(() => f.store.director.generated('primary', { requestId: gen.requestId, generationId: gen.generationId, binding, result: { text: 'a generated answer', reason: '' } }), /no longer current/);
});

test('fresh exchange context comes only from helper source and never from browser-echoed sync metadata', t => {
  const f = fixture(t); f.migrate(); f.observe('primary', { messages: [incoming(f, 'a human conversation')] });
  let c = f.store.client('primary'); assert.equal(c.exchange_stream_id, streamId); assert.equal(c.last_human_at, f.now());
  f.store.sync('primary', { channel, connected: true, ready: true, playback: { status: 'playing', checkedAt: f.now() }, seed: [], exchangeContext: { streamId: '99999999', checkedAt: f.now(), lastHumanAt: 0 } });
  c = f.store.client('primary'); assert.equal(c.exchange_stream_id, streamId); assert.equal(c.last_human_at, f.now());
});

test('AI participation conversation can reserve and begin without counting its own generation as a prior attempt', t => {
  const f = fixture(t); f.migrate(); f.store.director.preferences('primary', { requestId: 'conversation-ai', chatMode: 'participate', replySource: 'ai' });
  const gen = f.observe('primary', { messages: [incoming(f, 'hi everyone', 'conversation-target')] }).generation;
  // A supported whole-message greeting is the conversation opportunity.
  const generation = gen || f.observe('primary', { messages: [incoming(f, 'hi', 'conversation-target-2')] }).generation;
  assert.ok(generation);
  const response = f.store.director.generated('primary', { requestId: generation.requestId, generationId: generation.generationId, binding, result: { text: 'hi, how are things?', reason: 'conversation reply' } });
  const plan = response.director.plan; assert.equal(plan.kind, 'conversation');
  const lease = reserve(f, plan); assert.equal(lease.ok, true); assert.equal(begin(f, plan, lease).ok, true);
  assert.equal(f.store.budget(channel).count, 1);
});

test('central profile choices win over later seed preferences and stale observations', t => {
  const f = fixture(t);
  f.store.director.preferences('primary', { requestId: 'explicit-profile', chatMode: 'mentions', replySource: 'ai' });
  f.page('primary', 'helper'); f.page('primary', 'browser');
  assert.equal(f.store.director.profile('primary').replySource, 'ai'); assert.equal(f.store.director.profile('primary').chatMode, 'mentions');
  f.observe('primary', { armed: false }); assert.equal(f.store.director.profile('primary').replySource, 'ai');
});
