import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { HostStore } from '../lib/store.mjs';
import { createHostServer } from '../server.mjs';
import { messageKey } from '../lib/exchanges.mjs';

// Primary is a source-only overlay, not a runnable package. Stage only its
// public sources under an explicit ESM boundary; never read installed private
// journals, credentials or live helper state during an integration review.
const stage = await mkdtemp(join(tmpdir(), 'companion-director-review-source-'));
await cp(new URL('../../stream-companion-helper-updates/primary/', import.meta.url), stage, { recursive: true });
await writeFile(join(stage, 'package.json'), JSON.stringify({ type: 'module' }));
test.after(() => rm(stage, { recursive: true, force: true }));
const { importPages } = await import(pathToFileURL(join(stage, 'extension/director.js')));
const { HostCoordinator } = await import(pathToFileURL(join(stage, 'lib/host-coordinator.mjs')));
const { DirectorAdapter } = await import(pathToFileURL(join(stage, 'lib/director-adapter.mjs')));
const { TwitchChat } = await import(pathToFileURL(join(stage, 'lib/twitch.mjs')));

const START = Date.parse('2026-11-26T05:00:00Z');
const CHANNEL = 'sample_channel';
const CLIENTS = ['primary', 'test', 'third'].map((id, i) => ({ id, account: ['main_account', 'second_account', 'third_account'][i], name: id, token: `fixture-${id}-${'x'.repeat(40)}` }));
const BINDING = { generation: 'generation-one', sessionId: 'session-one', settingsRevision: 1 };
const context = now => ({ channel: CHANNEL, streamId: '12345', title: 'A stream title', gameName: 'Some Game', isLive: true, checkedAt: now });
function fixture(t, options = {}) {
  let now = START;
  const store = new HostStore({ file: ':memory:', clients: CLIENTS, directorEnabled: true, now: () => now, random: () => 0.5, ...options });
  t.after(() => store.close());
  return { store, director: store.director, now: () => now, advance: ms => { now += ms; } };
}
async function migrate(director, overrides = {}) {
  for (const client of CLIENTS) for (const source of ['helper', 'browser']) {
    const input = overrides[`${client.id}:${source}`] || {};
    const pages = await importPages({ source, account: client.account, ...input });
    for (const page of pages) director.importPage(client.id, page);
  }
}
function observe(f, { id = 'primary', binding = BINDING, messages = [], armed = true } = {}) {
  f.store.sync(id, { channel: CHANNEL, connected: true, ready: true, playback: { status: 'playing', checkedAt: f.now() } });
  return f.director.observe(id, { protocol: 1, binding, armed, messages, streamContext: context(f.now()), restrictions: { sharedChat: false, emoteOnly: false, subscribersOnly: false, sendHeld: false } }).director;
}
function reserve(store, plan, extra = {}) {
  return store.reserve(plan.clientId, { requestId: `reserve:${plan.planId}`, channel: plan.channel, streamId: plan.streamId, kind: plan.kind,
    text: plan.text, textKey: plan.textKey, replyId: plan.replyId, ...(plan.replyId ? { replyAt: plan.replyAt } : {}),
    ...(plan.exchangeId ? { exchangeId: plan.exchangeId } : {}), planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding: plan.binding, ...extra });
}
function begin(store, plan, reservationId) { return store.begin(plan.clientId, { reservationId, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding: plan.binding }); }

test('review: readiness waits for every final authenticated source page and replay is durable', async t => {
  const f = fixture(t), records = Array.from({ length: 41 }, (_, i) => ({ account: 'main_account', channel: CHANNEL, at: START - 100000 - i, text: `legacy wording ${i}`, delivery: 'unknown' }));
  const pages = await importPages({ source: 'helper', account: 'main_account', history: records }); assert.ok(pages.length >= 3);
  for (const client of CLIENTS) for (const source of ['helper', 'browser']) {
    if (client.id === 'primary' && source === 'helper') continue;
    for (const page of await importPages({ source, account: client.account })) f.director.importPage(client.id, page);
  }
  for (const page of pages.slice(0, -1)) f.director.importPage('primary', page);
  assert.equal(f.director.ready, false); assert.equal(f.director.history().history.length, 40);
  const final = f.director.importPage('primary', pages.at(-1)); assert.equal(f.director.ready, true);
  assert.deepEqual(f.director.importPage('primary', pages.at(-1)), final);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM director_history').get().n, 41);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM contributions').get().n, 41);
});

test('review: helper/browser copies enrich one canonical attempt without charging its allowance twice', async t => {
  const f = fixture(t), at = START - 1000, text = 'legacy exact text';
  f.store.db.prepare('INSERT INTO contributions VALUES (?,?,?,?,?,?,?,?,?)').run('legacy-permit', 'main_account', CHANNEL, '12345', 'greeting', messageKey(text), '', at, 'unknown');
  const history = [{ account: 'main_account', channel: CHANNEL, streamId: '12345', kind: 'greeting', text, at, delivery: 'confirmed', coordinationId: 'legacy-permit' }];
  await migrate(f.director, { 'primary:helper': { history }, 'primary:browser': { history } });
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM contributions').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM director_history').get().n, 1);
  assert.equal(f.director.history().history[0].text, text); assert.equal(f.director.history().history[0].delivery, 'confirmed');
});

test('review: imported unknown greeting and handled direct mention cannot replay after authority switch', async t => {
  const f = fixture(t), greetingKey = `participation:main_account:${CHANNEL}:12345:greeting`, target = { id: 'incoming-one', author: 'some_viewer', text: '@main_account hello', at: START - 1000 };
  await migrate(f.director, { 'primary:browser': { participationAttempts: [{ account: 'main_account', channel: CHANNEL, streamId: '12345', kind: 'greeting', key: greetingKey, at: START - 700000, delivery: 'unknown' }], handled: [`main_account:${CHANNEL}:${target.id}`] } });
  f.director.preferences('primary', { requestId: 'participate', chatMode: 'participate', replySource: 'local' });
  const state = observe(f, { messages: [target] });
  assert.ok(!state.plan || state.plan.kind !== 'greeting'); assert.ok(!state.plan || state.plan.replyId !== target.id);
  assert.equal(f.director.consumed(greetingKey), true); assert.equal(f.director.consumed(`main_account:${CHANNEL}:${target.id}`), true);
});

test('review: exact text binding rejects normalized-equivalent rewrites and late confirmation updates one row', async t => {
  const f = fixture(t); await migrate(f.director); observe(f);
  const result = f.director.manual('primary', { requestId: 'reviewed-message', binding: BINDING, text: 'Hello, there!' }), plan = result.plan;
  const rewritten = 'hello there'; assert.equal(messageKey(rewritten), plan.textKey);
  assert.throws(() => reserve(f.store, plan, { text: rewritten }), /exact server plan/);
  const lease = reserve(f.store, plan); assert.equal(lease.ok, true); assert.equal(begin(f.store, plan, lease.reservationId).ok, true);
  assert.equal(begin(f.store, plan, lease.reservationId).ok, false);
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'unknown', submitted: true });
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'confirmed', submitted: true, outcome: { at: f.now(), messageId: 'provider-message-one', reason: 'Confirmed.' } });
  f.store.finish('primary', { reservationId: lease.reservationId, delivery: 'unknown', submitted: true });
  const history = f.director.history().history; assert.equal(history.length, 1); assert.equal(history[0].text, 'Hello, there!'); assert.equal(history[0].delivery, 'confirmed'); assert.equal(history[0].messageId, 'provider-message-one');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM contributions').get().n, 1);
});

test('review: replaced binding and Pause invalidate unused work and delayed AI results', async t => {
  const f = fixture(t); await migrate(f.director); observe(f);
  const plan = f.director.manual('primary', { requestId: 'before-stop', binding: BINDING, text: 'reviewed text' }).plan, lease = reserve(f.store, plan);
  observe(f, { binding: { ...BINDING, generation: 'generation-after-stop' }, armed: false });
  assert.equal(begin(f.store, plan, lease.reservationId).ok, false); assert.equal(f.director.history().history[0].delivery, 'cancelled');
  f.director.preferences('primary', { requestId: 'use-ai', chatMode: 'mentions', replySource: 'ai' });
  const state = observe(f, { messages: [{ id: 'fresh-target', author: 'some_viewer', text: '@main_account hello', at: f.now() - 1000 }] }); assert.ok(state.generation);
  f.store.setPaused(true);
  assert.throws(() => f.director.generated('primary', { requestId: state.generation.requestId, generationId: state.generation.generationId, binding: BINDING, result: { text: 'late generated text', reason: 'late' } }), /stale|held|current/);
  assert.ok(f.director.status().plans.every(plan => plan.state !== 'offered'));
});

test('review: ambiguous legacy cancellation imports as consumed uncertainty rather than a retry', async t => {
  const f = fixture(t), pages = await importPages({ source: 'browser', account: 'main_account', history: [{ account: 'main_account', channel: CHANNEL, text: 'old ambiguous attempt', at: START - 1000, delivery: 'cancelled' }] });
  for (const page of pages) f.director.importPage('primary', page);
  assert.equal(f.director.history().history[0].delivery, 'unknown'); assert.equal(f.director.history().history[0].submitted, true);
});

test('review: real helper/host roundtrip freezes draft/manual text and Stop at the last provider boundary cancels safely', async t => {
  const f = fixture(t), directory = await mkdtemp(join(tmpdir(), 'companion-director-review-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const client of CLIENTS) for (const source of ['helper', 'browser']) {
    if (client.id === 'primary' && source === 'helper') continue;
    for (const page of await importPages({ source, account: client.account })) f.director.importPage(client.id, page);
  }
  const server = createHostServer({ store: f.store, clients: CLIENTS, port: 0, accounts: { snapshot: async () => ({ updatedAt: new Date(f.now()).toISOString(), instances: [] }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const coordinator = new HostCoordinator({ config: { url: 'http://127.0.0.1:8795', clientId: 'primary', account: 'main_account', token: CLIENTS[0].token }, outboxFile: join(directory, 'outbox.json'), now: f.now, autoStart: false,
    testURL: `http://127.0.0.1:${server.address().port}`, getConnection: () => ({ channel: CHANNEL, connected: true }) }); t.after(() => coordinator.close()); coordinator.seed([]);
  const control = { stopped: false, browserState: { settings: { revision: 1, autoReply: true, paused: false, chatMode: 'mentions' }, watch: { enabled: true, channel: CHANNEL, status: 'playing', checkedAt: START } }, guard(input) { if (this.stopped) throw Error('Stopped before provider request.'); assert.equal(input.controlGeneration, BINDING.generation); assert.equal(input.controlSessionId, BINDING.sessionId); } };
  const twitch = new TwitchChat({ coordinator, credentials: { account: 'main_account', userId: '123', clientId: 'fixture', accessToken: 'fixture' }, now: f.now });
  twitch.channel = CHANNEL; twitch.connected = true; twitch.broadcasterId = '456';
  twitch.messages = [{ id: 'target-one', author: 'some_viewer', text: '@main_account hello', at: START - 1000 }];
  twitch.ensureIdentity = async () => {}; twitch.inspectChannel = async () => ({ streamContext: context(f.now()), chatSettings: {}, sharedChat: false });
  twitch.refreshCoordination = input => coordinator.refresh({ channel: CHANNEL, connected: true, ...(input ? { observation: input } : {}) });
  let providerCalls = 0;
  twitch.api = async (path, body) => {
    if (path.startsWith('shared_chat/session?')) return { data: [] };
    assert.equal(path, 'chat/messages'); providerCalls++; assert.equal(body.message, 'exact reviewed message');
    return { data: [{ is_sent: true, message_id: 'provider-confirmed-one' }] };
  };
  const adapter = new DirectorAdapter({ twitch, control, config: {}, now: f.now });
  const input = { controlGeneration: BINDING.generation, controlSessionId: BINDING.sessionId, settingsRevision: 1 };
  const draft = await adapter.draft({ ...input, requestId: 'draft-reviewed', mode: 'reply' }); assert.equal(draft.ok, true); assert.ok(draft.draft.text); assert.equal(f.director.history().history.length, 0);
  const manual = await adapter.manual({ ...input, requestId: 'manual-reviewed', text: 'exact reviewed message' }); assert.equal(manual.plan.text, 'exact reviewed message'); assert.equal(manual.plan.source, 'manual');
  assert.equal(adapter.guardSend({ ...input, binding: BINDING, planId: manual.plan.planId, authorityEpoch: manual.plan.authorityEpoch, text: manual.plan.text }).planId, manual.plan.planId);
  assert.throws(() => adapter.guardSend({ ...input, binding: BINDING, planId: manual.plan.planId, authorityEpoch: manual.plan.authorityEpoch, text: 'altered message' }), /exact current/);
  assert.equal(f.director.history().history.length, 0, 'neither draft nor plan creation claims submission or delivery');
  const send = plan => ({ account: plan.account, channel: plan.channel, text: plan.text, kind: plan.kind, streamId: plan.streamId, participationKey: plan.participationKey,
    category: plan.category, planId: plan.planId, authorityEpoch: plan.authorityEpoch, binding: plan.binding, replyTo: plan.replyId, replyAuthor: plan.replyAuthor });
  const sent = await twitch.send({ ...send(manual.plan), beforeSubmit: () => adapter.guardSend({ ...input, ...send(manual.plan) }) });
  assert.equal(sent.delivery, 'confirmed'); assert.equal(providerCalls, 1); assert.equal(f.director.history().history[0].messageId, 'provider-confirmed-one');
  f.advance(180001); control.browserState.watch.checkedAt = f.now(); twitch.messages = [];
  const cancelledPlan = (await adapter.manual({ ...input, requestId: 'manual-stop-boundary', text: 'must never reach provider' })).plan;
  const cancelled = await twitch.send({ ...send(cancelledPlan), beforeSubmit: () => { control.stopped = true; return adapter.guardSend({ ...input, ...send(cancelledPlan) }); } });
  assert.equal(cancelled.delivery, 'cancelled'); assert.equal(cancelled.submitted, false); assert.equal(providerCalls, 1);
  assert.equal(f.director.history().history[0].delivery, 'cancelled'); assert.equal(f.director.history().history[0].submitted, false);
});
