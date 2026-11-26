import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { importPages, importAcknowledged, directorOffer } from '../extension/director.js';
import { messageKey } from '../extension/message-policy.js';
import { HostCoordinator } from '../lib/host-coordinator.mjs';
import { DirectorAdapter } from '../lib/director-adapter.mjs';
import { TwitchChat } from '../lib/twitch.mjs';

const at = 1_800_000_000_000, account = 'companion_test', channel = 'friend_channel';
const binding = { generation: 'generation-one', sessionId: 'session-one', settingsRevision: 4 };
const input = { controlGeneration: binding.generation, controlSessionId: binding.sessionId, settingsRevision: 4 };
const hash = text => createHash('sha256').update(text).digest('hex');
const json = value => new Response(JSON.stringify(value), { status: 200 });
const config = { url: 'http://127.0.0.1:8795', clientId: 'primary', account, token: 'central-test-pairing-only-not-real-1234567890' };
const snapshot = { paused: false, textKeys: [], topicStreams: [], replyIds: [], accounts: [account, 'other_companion'] };
const state = () => ({ protocol: 1, authorityEpoch: 'authority-one', ready: true,
  profile: { id: 'primary', chatMode: 'participate', replySource: 'local', revision: 1 }, bankRevision: 1 });
function plan(overrides = {}) {
  const text = overrides.text || 'hello chat';
  return { planId: 'plan-one', authorityEpoch: 'authority-one', clientId: 'primary', account, channel,
    streamId: '123456', kind: '', participationKey: '', opportunityKey: 'opportunity-one', text,
    textKey: messageKey(text), exactKey: hash(text), category: 'greeting', source: 'automatic',
    replyId: '', replyAuthor: '', replyAt: 0, bankRevision: 1, profileRevision: 1,
    notBefore: at - 1000, expiresAt: at + 20_000, binding, ...overrides };
}
async function coordinator(t, fetchImpl, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'central-director-client-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const client = new HostCoordinator({ config, outboxFile: join(dir, 'outcomes.json'), now: () => at, autoStart: false, fetchImpl, ...extra });
  t.after(() => client.close());
  client.cache(snapshot, channel); client.presence = { channel, connected: true };
  return { client, file: join(dir, 'outcomes.json') };
}

test('browser import retains old broadcast tombstones, no-match targets, exact unknown history and source journals', async () => {
  const raw = { source: 'browser', account, history: [{ account, channel, at: at - 9_000_000, text: 'exact OLD wording', delivery: 'unknown' }],
    participationAttempts: [{ account, channel, at: at - 9_000_000, key: `participation:${account}:${channel}:123456:greeting`,
      kind: 'greeting', streamId: '123456', delivery: 'pending', submitted: false }],
    handled: [`${account}:${channel}:unsupported-message`], preferences: { chatMode: 'participate', replySource: 'ai' } };
  const before = structuredClone(raw), pages = await importPages(raw);
  assert.deepEqual(raw, before); assert.deepEqual(pages, await importPages(raw));
  const records = pages.flatMap(x => x.records);
  assert.equal(records[0].text, 'exact OLD wording'); assert.equal(records[0].delivery, 'unknown');
  assert.equal(records[1].participationKey, raw.participationAttempts[0].key);
  assert.equal(records[1].delivery, 'pending'); assert.equal(records[2].key, raw.handled[0]);
  assert.ok(records.every(x => /^[a-f0-9]{64}$/.test(x.recordId)));
  assert.equal(pages.at(-1).final, true); assert.deepEqual(pages.at(-1).preferences, raw.preferences);
});

test('migration pages are bounded and require the exact durable final ACK', async () => {
  const pages = await importPages({ source: 'browser', account, handled: Array.from({ length: 47 }, (_, n) => `${account}:${channel}:incoming-${n}`) });
  assert.equal(pages.length, 3); assert.equal(pages[0].records.length, 20);
  for (const page of pages) {
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 20_000);
    const ack = { ok: true, source: page.source, importId: page.importId, page: page.page, digest: page.digest,
      complete: page.final, nextPage: page.page + 1 };
    assert.equal(importAcknowledged(ack, page), true);
    assert.equal(importAcknowledged({ ...ack, digest: hash('different') }, page), false);
    assert.equal(importAcknowledged({ ...ack, complete: !page.final }, page), false);
  }
  await assert.rejects(importPages({ source: 'browser', account, handled: [`other_account:${channel}:incoming`] }), /handled/i);
});

test('partial helper import holds authority and retries the same deterministic pages without any send fallback', async t => {
  let fail = true; const sent = [];
  const h = await coordinator(t, async (url, options) => {
    const body = JSON.parse(options.body); sent.push({ url, body });
    if (url.endsWith('/import')) {
      if (fail && body.page === 1) throw Error('temporary outage');
      return json({ ok: true, source: body.source, importId: body.importId, page: body.page, digest: body.digest, complete: body.final, nextPage: body.page + 1 });
    }
    return json({ ok: true, director: state() });
  });
  h.client.seed(Array.from({ length: 23 }, (_, n) => ({ account, channel, at: at - n * 1000, text: `old message ${n}`, delivery: 'unknown' })));
  await assert.rejects(h.client.directorRequest('observe', { binding }), /outage/);
  assert.equal(h.client.helperImportDone, undefined); assert.equal(h.client.currentPlan('plan-one', binding), null);
  assert.equal(sent.some(x => x.url.endsWith('/observe')), false);
  const firstDigest = sent[0].body.digest; fail = false;
  await h.client.directorRequest('observe', { binding });
  assert.equal(sent[2].body.digest, firstDigest); assert.equal(h.client.helperImportDone, true);
  assert.equal(JSON.parse(await readFile(h.file, 'utf8')).imports.helper.complete, true);
});

test('a helper crash after final host ACK resumes frozen pages despite changed source history and preferences', async t => {
  const accepted = [], h = await coordinator(t, async (_url, options) => {
    const body = JSON.parse(options.body); accepted.push(body);
    return json({ ok: true, source: body.source, importId: body.importId, page: body.page, digest: body.digest,
      complete: body.final, nextPage: body.page + 1 });
  });
  h.client.seed([{ account, channel, at, text: 'original unknown', delivery: 'unknown' }]);
  const persist = h.client.persist.bind(h.client);
  h.client.persist = async () => { if (h.client.imports.helper?.complete) throw Error('crash before final local ACK write'); return persist(); };
  await assert.rejects(h.client.ensureHelperImport(), /acknowledgement/);
  const frozenId = accepted[0].importId;
  const recovered = new HostCoordinator({ config, outboxFile: h.file, now: () => at, autoStart: false,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); assert.equal(body.importId, frozenId);
      assert.equal(body.records[0].text, 'original unknown'); assert.equal(body.records[0].delivery, 'unknown');
      return json({ ok: true, source: body.source, importId: body.importId, page: body.page, digest: body.digest,
        complete: body.final, nextPage: body.page + 1 });
    } });
  t.after(() => recovered.close());
  recovered.seed([{ account, channel, at, text: 'new confirmed text', delivery: 'confirmed' }]);
  await recovered.ensureHelperImport(); assert.equal(recovered.imports.helper.complete, true);
});

test('exact central offer binding rejects changed account, epoch, session, timing and target', () => {
  const accept = value => directorOffer(value, { account, channel, binding, authorityEpoch: 'authority-one', now: at });
  assert.ok(accept(plan()));
  for (const change of [{ account: 'other_companion' }, { authorityEpoch: 'old-authority' },
    { binding: { ...binding, settingsRevision: 3 } }, { expiresAt: at }, { notBefore: at + 1000 },
    { replyId: 'incoming', replyAuthor: 'alice', replyAt: at - 45_001 }]) assert.equal(accept(plan(change)), null);
});

test('manual top-level response caches only against a fresh current authority observation', async t => {
  const h = await coordinator(t, async () => json({ ok: true }));
  h.client.cacheDirector({ ok: true, director: state() }, binding);
  const exact = plan({ source: 'manual', streamId: '' });
  h.client.cacheDirector({ ok: true, plan: exact }, binding);
  assert.deepEqual(h.client.currentPlan(exact.planId, binding), exact);
  assert.equal(h.client.currentPlan(exact.planId, { ...binding, sessionId: 'old-session' }), null);
  h.client.cache({ ...snapshot, paused: true }, channel);
  assert.equal(h.client.currentPlan(exact.planId, binding), null);
});

test('durable outbox preserves full confirmed outcome across outage and never downgrades or repeats acknowledged metadata', async t => {
  let online = false, requests = 0;
  const h = await coordinator(t, async () => { requests++; if (!online) throw Error('offline'); return json({ ok: true }); });
  await h.client.finish('reservation-one', 'confirmed', { at, messageId: 'twitch-id', reason: '' });
  const saved = JSON.parse(await readFile(h.file, 'utf8'));
  assert.equal(saved.pending[0].outcome.messageId, 'twitch-id');
  await h.client.finish('reservation-one', 'unknown', { at, messageId: '', reason: 'late timeout' });
  assert.equal(h.client.pending[0].delivery, 'confirmed');
  online = true; await h.client.flush(); const count = requests;
  await h.client.finish('reservation-one', 'confirmed', { at, messageId: 'twitch-id', reason: '' });
  assert.equal(requests, count);
  const reopened = new HostCoordinator({ config, outboxFile: h.file, autoStart: false, now: () => at,
    fetchImpl: async () => { throw Error('metadata must remain acknowledged'); } });
  t.after(() => reopened.close()); await reopened.loaded;
  await reopened.queueCompletion('reservation-one', 'confirmed', { at, messageId: 'twitch-id', reason: '' });
  assert.equal(reopened.pending.length, 0);
});

function providerHarness({ offer = plan(), outcome = 'confirmed', begin = async () => {}, beforeSubmit } = {}) {
  let time = at, calls = 0; const completions = [], history = [];
  const coordinator = { snapshot: () => ({ ...snapshot, available: true }), seed() {}, async refresh() {},
    currentPlan: (id, value) => id === offer.planId ? directorOffer(offer, { account, channel, binding: value,
      authorityEpoch: 'authority-one', now: time }) : null,
    reserve: async () => ({ ok: true, reservationId: 'reservation-one' }), begin: async () => { await begin(); return { ok: true }; },
    finish: async (...args) => completions.push(args) };
  const twitch = new TwitchChat({ credentials: { account, userId: '123', accessToken: 'fixture-only' }, coordinator,
    saveHistory: async value => { history.push(structuredClone(value)); }, now: () => time });
  twitch.connected = true; twitch.channel = channel; twitch.broadcasterId = '456'; twitch.ensureIdentity = async () => {};
  twitch.inspectChannel = async () => ({ streamContext: { channel, streamId: '123456', isLive: true, checkedAt: time }, sharedChat: false, chatSettings: {} });
  twitch.api = async path => { if (path.startsWith('shared_chat')) return { data: [] }; calls++; if (outcome === 'unknown') throw Error('lost response');
    return { data: [{ is_sent: true, message_id: 'provider-id' }] }; };
  const args = () => ({ account, channel, text: offer.text, category: offer.category, kind: offer.kind,
    streamId: offer.streamId, participationKey: offer.participationKey, replyTo: offer.replyId, replyAuthor: offer.replyAuthor,
    planId: offer.planId, authorityEpoch: offer.authorityEpoch, binding, beforeSubmit });
  return { twitch, args, history, completions, get calls() { return calls; }, setTime: value => { time = value; } };
}
test('official provider receives only the exact centrally offered bytes and completion enriches the same attempt', async () => {
  const h = providerHarness({ offer: plan({ text: 'EXACT mixed Case wording' }) });
  const result = await h.twitch.send(h.args());
  assert.equal(result.delivery, 'confirmed'); assert.equal(h.calls, 1); assert.equal(h.history[0][0].text, 'EXACT mixed Case wording');
  assert.equal(h.completions.at(-1)[2].messageId, 'provider-id');
});
test('missing plan, same-normalized changed bytes, changed target and stale authority never reach reserve/provider', async () => {
  const h = providerHarness();
  for (const change of [{ planId: undefined }, { text: 'HELLO CHAT!' }, { replyTo: 'invented' }, { authorityEpoch: 'old-authority' },
    { binding: { ...binding, settingsRevision: 3 } }]) await assert.rejects(h.twitch.send({ ...h.args(), ...change }), /central/i);
  assert.equal(h.calls, 0); assert.equal(h.history.length, 0);
});
test('Stop after begin and final command expiry certify cancellation with zero provider calls', async () => {
  let h; h = providerHarness({ begin: async () => h.twitch.disconnect() });
  await assert.rejects(h.twitch.send(h.args()), /disconnected/); assert.equal(h.calls, 0);
  assert.equal(h.completions.at(-1)[1], 'cancelled');
  const delayed = providerHarness({ beforeSubmit: async () => delayed.setTime(at + 30_000) });
  const result = await delayed.twitch.send(delayed.args());
  assert.equal(result.delivery, 'cancelled'); assert.equal(result.submitted, false); assert.equal(delayed.calls, 0);
});
test('unknown provider result keeps its plan consumed and cannot submit a second time', async () => {
  const h = providerHarness({ outcome: 'unknown' });
  await assert.rejects(h.twitch.send(h.args()), /lost response/); assert.equal(h.calls, 1);
  await assert.rejects(h.twitch.send(h.args()), /cooldown|already/); assert.equal(h.calls, 1);
  assert.equal(h.completions.at(-1)[1], 'unknown');
});

function adapterHarness({ generation, generateImpl } = {}) {
  let currentGeneration = binding.generation; const observed = [], generated = [];
  const ownMessage = { id: 'incoming-one', author: 'alice', text: `@${account} hello`, at: at - 1000 };
  const control = { stopped: false, browserState: { settings: { revision: 4, paused: false, autoReply: true, chatMode: 'participate' },
    watch: { enabled: true, channel, status: 'playing', checkedAt: at } },
    guard(value) { if (value.controlGeneration !== currentGeneration) throw Error('Operation cancelled by Stop.'); }, diagnostic: value => String(value).slice(0, 300) };
  const coordinator = { ensureHelperImport: async () => {}, snapshot: () => snapshot,
    async directorRequest(path, body) { observed.push({ path, body }); if (path === 'generated') { generated.push(body); return { ok: true, director: state() }; }
      return { ok: true, director: state(), ...(generation ? { generation: { ...generation, target: ownMessage } } : {}) }; } };
  const twitch = { credentials: { account }, channel, connected: true, messages: [ownMessage], history: [], coordinator,
    sendHold: () => ({ held: false }), status: () => ({ messages: [ownMessage] }), refreshCoordination: async value => { observed.push({ path: 'coordination', body: value }); },
    inspectChannel: async () => ({ streamContext: { channel, streamId: '123456', isLive: true, gameName: 'Minecraft', title: 'Own metadata', checkedAt: at }, chatSettings: {}, sharedChat: false }) };
  const adapter = new DirectorAdapter({ twitch, control, config: { apiKey: 'fixture-model-only' }, now: () => at, generateImpl });
  return { adapter, observed, generated, ownMessage, control, stop() { currentGeneration = 'new-stop'; control.stopped = true; } };
}
test('helper observations use only own EventSub messages and inspected metadata while preserving exchange context', async () => {
  const h = adapterHarness();
  await h.adapter.sync({ ...input, messages: [{ text: 'browser injected' }], streamContext: { title: 'untrusted browser title' } });
  const observed = h.observed.find(x => x.path === 'observe').body;
  assert.equal(observed.messages[0].text, h.ownMessage.text); assert.equal(observed.streamContext.title, 'Own metadata');
  assert.equal(h.observed.find(x => x.path === 'coordination').body.exchangeContext.streamId, '123456');
});
test('central AI requests are generated once and a delayed result after Stop never returns as an offer', async () => {
  let resolve, count = 0;
  const generation = { generationId: 'generation-request', requestId: 'model-request', account, channel, mode: 'reply', binding };
  const h = adapterHarness({ generation, generateImpl: async request => { count++; assert.equal(request.target.id, 'incoming-one');
    return new Promise(done => { resolve = done; }); } });
  const pending = h.adapter.sync(input);
  for (let n = 0; n < 10 && !resolve; n++) await new Promise(done => setImmediate(done));
  assert.ok(resolve); h.stop(); resolve({ text: 'generated words', reason: 'fixture' });
  await assert.rejects(pending, /Stop/); assert.equal(h.generated.length, 0); assert.equal(count, 1);
});
test('no central generation request means no local AI or phrase fallback', async () => {
  let count = 0; const h = adapterHarness({ generateImpl: async () => { count++; throw Error('must not generate'); } });
  await h.adapter.sync(input); assert.equal(count, 0);
  await assert.rejects(h.adapter.sync({ ...input, settingsRevision: 3 }), /settings changed/);
});
