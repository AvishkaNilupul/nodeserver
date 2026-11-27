import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchChat, chatScopes } from '../lib/twitch.mjs';
import { LocalControl } from '../lib/local-control.mjs';
import { createClipController } from '../../stream-companion-host/lib/clips.mjs';
import { DatabaseSync } from 'node:sqlite';

const EPOCH = 1800000000000, ACCOUNT = 'fixture_companion', CHANNEL = 'live_channel';
const credentials = { account: ACCOUNT, clientId: 'fixtureclient123', userId: '123', accessToken: 'fixture-access', refreshToken: 'fixture-refresh', scopes: chatScopes };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
function provider({ now, latency = () => {}, failAt = () => false, streamId = () => '789' }) {
  const reads = [];
  const fetch = async (address, options = {}) => {
    assert.equal(options.method, 'GET', 'metadata checks must be read only'); reads.push({ address, at: now() });
    if (failAt() && address.includes('/streams?')) return response({}, 503);
    if (address.includes('/users?')) return response({ data: [{ login: CHANNEL, id: '456' }] });
    if (address.includes('/streams?')) return response({ data: [{ id: streamId(), user_id: '456', user_login: CHANNEL, title: 'Fixture broadcast', game_name: 'Fixture game' }] });
    if (address.includes('/chat/settings?')) return response({ data: [{ broadcaster_id: '456', follower_mode: false, subscriber_mode: false, emote_mode: false, slow_mode: false }] });
    if (address.includes('/shared_chat/session?')) { latency(); return response({ data: [] }); }
    throw Error(`Unexpected provider request: ${address}`);
  };
  return { fetch, reads };
}

function helperFixture(t) {
  let time = EPOCH, failure = false;
  const p = provider({ now: () => time, failAt: () => failure });
  const helper = new TwitchChat({ credentials: structuredClone(credentials), now: () => time, fetchImpl: p.fetch }); helper.validatedAt = time;
  t.after(() => helper.disconnect());
  return { helper, reads: p.reads, setTime: value => { time = value; }, fail: () => { failure = true; } };
}

test('the actual helper cache retains original checkedAt on a hit and is expired before a just-under60-second request', async t => {
  const f = helperFixture(t), first = await f.helper.inspectChannel(ACCOUNT, CHANNEL);
  assert.equal(first.checkedAt, EPOCH); assert.equal(f.reads.length, 4);
  f.setTime(EPOCH + 29999); const hit = await f.helper.inspectChannel(ACCOUNT, CHANNEL);
  assert.equal(hit.checkedAt, EPOCH); assert.equal(hit.streamContext.checkedAt, EPOCH); assert.equal(f.reads.length, 4);
  f.setTime(EPOCH + 59999); const fresh = await f.helper.inspectChannel(ACCOUNT, CHANNEL);
  assert.equal(fresh.checkedAt, EPOCH + 59999); assert.equal(fresh.streamContext.checkedAt, EPOCH + 59999); assert.equal(f.reads.length, 8);
});

test('metadata failure does not refresh the cached checkedAt or turn a failed provider read into live evidence', async t => {
  const f = helperFixture(t); await f.helper.inspectChannel(ACCOUNT, CHANNEL);
  f.setTime(EPOCH + 60000); f.fail(); await assert.rejects(f.helper.inspectChannel(ACCOUNT, CHANNEL), /HTTP 503/);
  assert.equal(f.helper.channelCache.get(`${ACCOUNT}:${CHANNEL}`).checkedAt, EPOCH);
});

const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); } });
function storage(initial = {}) {
  const data = structuredClone(initial);
  return { data, async get(keys) { if (keys == null) return structuredClone(data); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
    async set(value) { Object.assign(data, structuredClone(value)); }, async clear() {}, async setAccessLevel() {} };
}
let sequence = 0;
async function backgroundFixture(t, { failedFrom = Infinity } = {}) {
  let time = EPOCH;
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, now: Date.now, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const intervals = new Map(), channelReads = [], nativeReads = [];
  const p = provider({ now: () => time, latency: () => { time += 200; }, failAt: () => time - EPOCH >= failedFrom });
  const helper = new TwitchChat({ credentials: structuredClone(credentials), now: () => time, fetchImpl: p.fetch });
  helper.validatedAt = time; helper.connected = true; helper.channel = CHANNEL;
  const local = storage({ settings: { schemaVersion: 8, revision: 1, account: ACCOUNT, allowedChannel: CHANNEL, paused: false, pairingToken: 'fixture-token', autoReply: false, autoResume: true, chatMode: 'mentions', replySource: 'local' },
    watchSession: { enabled: true, tabId: 42, account: ACCOUNT, channel: CHANNEL, url: `https://www.twitch.tv/${CHANNEL}`, status: 'playing', checkedAt: EPOCH - 1000, lastProgressAt: EPOCH - 1000,
      currentTime: 5, videoId: 'v1', hasVideo: true, paused: false, ad: false, documentId: 'fixture-doc', sessionId: 'fixture-watch', generation: 1, waitingSince: EPOCH - 1000 } });
  const chrome = { storage: { local, session: storage() }, runtime: { id: 'fixture-extension', onInstalled: event(), onStartup: event(), onMessage: event() }, sidePanel: { async setPanelBehavior() {} },
    alarms: { onAlarm: event(), async create() {}, async clearAll() {} }, permissions: { async contains() { return true; } },
    tabs: { onUpdated: event(), onRemoved: event(), async get(id) { return { id, url: `https://www.twitch.tv/${CHANNEL}`, status: 'complete' }; } },
    scripting: { async executeScript(request) { nativeReads.push({ at: time, request }); return [{ frameId: 0, documentId: 'fixture-doc', result: { url: `https://www.twitch.tv/${CHANNEL}`, hasVideo: true, videoId: 'v1', currentTime: 10 + (time - EPOCH) / 1000, readyState: 4, paused: false, ended: false, ad: false, offline: false, error: false } }]; } } };
  const control = new LocalControl({ twitch: helper, now: () => time });
  globalThis.chrome = chrome; Date.now = () => time;
  globalThis.setInterval = (fn, delay) => { const id = intervals.size + 1; intervals.set(id, { fn, delay }); return id; }; globalThis.clearInterval = id => intervals.delete(id);
  globalThis.fetch = async (address, options) => {
    const body = JSON.parse(options.body), json = value => response(value);
    if (address.endsWith('/api/control/bridge')) return json(control.bridge(body));
    if (address.endsWith('/api/twitch/status')) return json(helper.status());
    if (address.endsWith('/api/twitch/channel')) { channelReads.push(time); try { return json(await helper.inspectChannel(body.account, body.channel)); } catch { return response({ error: 'Fixture metadata unavailable.' }, 503); } }
    if (address.endsWith('/api/twitch/disconnect')) return json(control.disconnect(body));
    throw Error(`Unexpected local request: ${address}`);
  };
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };
  t.after(async () => { await flush(); helper.disconnect(); globalThis.chrome = original.chrome; globalThis.fetch = original.fetch; Date.now = original.now; globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval; });
  await import(`../extension/background.js?metadata-fixture=${++sequence}`); await flush();
  const heartbeat = async () => { for (const interval of [...intervals.values()]) if (interval.delay === 5000) interval.fn(); await flush(); };
  const alarm = async () => { await chrome.alarms.onAlarm.handlers[0]({ name: 'companion-chat' }); await flush(); };
  await heartbeat(); await alarm();
  return { control, helper, channelReads, providerReads: p.reads, nativeReads, heartbeat, alarm, now: () => time, setTime: value => { assert.ok(value >= time, 'fixture time must advance truthfully'); time = value; } };
}

async function exerciseMetadataCycles(t, options = {}) {
  const f = await backgroundFixture(t, options), db = new DatabaseSync(':memory:'), creates = [], jobs = [], messages = [], phases = [], ages = [];
  const adapters = { snapshot: async () => ({ instances: [{ ...f.control.status(), id: 'primary', available: true, chat: { messages } }] }),
    clipStatus: async id => { if (id !== 'primary') throw Error('Unused fixture account.'); return { ok: true, account: ACCOUNT, authorized: true, jobs }; },
    clipCreate: async (id, body) => { creates.push({ id, body }); const job = { ...body, account: ACCOUNT, createdAt: f.now(), updatedAt: f.now(), state: 'queued', clipId: '', url: '', error: '' }; jobs.push(job); return { ok: true, job }; },
    clipAuthorization: async () => { throw Error('No OAuth in metadata fixture.'); } };
  const clips = createClipController({ db, accounts: adapters, isPaused: () => false, now: f.now, randomId: () => 'metadata-moment' });
  t.after(async () => { await clips.close(); db.close(); }); clips.configure({ enabled: true, channel: CHANNEL, accountIds: ['primary'] });
  const events = [];
  for (let at = 5000; at <= 300000; at += 5000) events.push({ at, kind: 'heartbeat' });
  for (let at = 30000; at <= 300000; at += 30000) events.push({ at, kind: 'alarm' });
  for (let at = 1100; at <= 300000; at += 5000) events.push({ at, kind: 'host' });
  const rank = { heartbeat: 0, alarm: 1, host: 2 };
  events.sort((a,b) => a.at - b.at || rank[a.kind] - rank[b.kind]);
  for (const event of events) {
    f.setTime(EPOCH + event.at);
    if (event.kind === 'heartbeat') await f.heartbeat();
    else if (event.kind === 'alarm') await f.alarm();
    else {
      if (event.at === 101100) for (let i = 0; i < 8; i++) messages.push({ id: `reaction-${i}`, author: `viewer_${i % 4}`, text: 'wow', at: f.now() - i * 100, channel: CHANNEL });
      await clips.tick(); const state = clips.snapshot(), context = f.control.status().streamContext;
      phases.push({ at: event.at, state: state.detector.state, reason: state.detector.reason });
      if (context?.checkedAt) ages.push({ at: event.at, age: f.now() - context.checkedAt });
    }
  }
  return { ...f, phases, ages, creates };
}

test('real browser and helper cache phases complete90-second detection and keep metadata fresh throughfive refresh cycles', async t => {
  const f = await exerciseMetadataCycles(t);
  t.diagnostic(JSON.stringify({ maximumMetadataAgeMs: Math.max(...f.ages.map(a => a.age)), realProviderStreamReads: f.providerReads.filter(r => r.address.includes('/streams?')).map(r => r.at - EPOCH), detectorStates: f.phases.filter((p,i) => i === 0 || p.state !== f.phases[i-1].state), mockCreates: f.creates.length }));
  assert.equal(f.creates.length, 1); assert.equal(f.creates[0].body.source, 'automatic');
  assert.ok(f.phases.some(p => p.at === 96100 && p.state === 'watching'), JSON.stringify(f.phases));
  assert.equal(f.phases.some(p => p.at >= 6100 && ['waiting', 'warming', 'unavailable'].includes(p.state) && p.at > 96100), false);
  assert.ok(Math.max(...f.ages.map(a => a.age)) < 90000, JSON.stringify(f.ages));
  const realReads = f.providerReads.filter(r => r.address.includes('/streams?'));
  assert.ok(realReads.length >= 5 && realReads.length <= 6, `${realReads.length} real reads should stay near once per minute`);
});

test('failed provider refreshes preserve old evidence and still stop automatic detection when it exceeds90seconds', async t => {
  const f = await exerciseMetadataCycles(t, { failedFrom: 60000 });
  assert.equal(f.creates.length, 0);
  assert.ok(f.phases.some(p => p.at >= 91100 && p.state === 'waiting' && /live stream/.test(p.reason)), JSON.stringify(f.phases));
  assert.ok(f.ages.some(a => a.age > 90000));
});
