import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalControl } from '../lib/local-control.mjs';
import { createClipController } from '../../stream-companion-host/lib/clips.mjs';
import { DatabaseSync } from 'node:sqlite';

const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); } });
function storage(initial = {}) {
  const data = structuredClone(initial);
  return { data, async get(keys) { if (keys == null) return structuredClone(data); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); },
    async set(value) { Object.assign(data, structuredClone(value)); }, async clear() { for (const k of Object.keys(data)) delete data[k]; }, async setAccessLevel() {} };
}
let sequence = 0;
async function fixture(t, { paused = false, enabled = true } = {}) {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch, now: Date.now, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const epoch = 1800000000000;
  let time = epoch, url = 'https://www.twitch.tv/live_channel', tabStatus = 'complete', videoPaused = false, scriptOverride;
  const intervals = new Map(), requests = [], executions = [], focus = [];
  const account = 'fixture_companion';
  const local = storage({ settings: { schemaVersion: 8, revision: 1, account, allowedChannel: 'live_channel', paused, pairingToken: 'fixture-token', autoReply: false, autoResume: !paused, chatMode: 'mentions', replySource: 'local' },
    watchSession: { enabled, tabId: 42, account, channel: 'live_channel', url, status: 'playing', checkedAt: epoch - 24000, lastProgressAt: epoch - 24000,
      currentTime: 50, hasVideo: true, paused: false, ad: false, documentId: 'fixture-doc', sessionId: 'fixture-watch', generation: 1, waitingSince: epoch - 24000 } });
  const session = storage();
  const chrome = { storage: { local, session }, runtime: { id: 'fixture-extension', onInstalled: event(), onStartup: event(), onMessage: event() },
    sidePanel: { async setPanelBehavior() {} }, alarms: { onAlarm: event(), async create() {}, async clearAll() {} },
    permissions: { async contains() { return true; }, async getAll() { return { permissions: ['scripting'], origins: ['https://www.twitch.tv/*'] }; }, request() { throw Error('Never request permissions from a heartbeat.'); } },
    tabs: { onUpdated: event(), onRemoved: event(), async get(id) { assert.equal(id, 42); return { id, url, status: tabStatus }; },
      async update(...args) { focus.push(args); throw Error('A heartbeat must not focus a tab.'); }, async create() { throw Error('A heartbeat must not open a tab.'); } },
    windows: { async update(...args) { focus.push(args); throw Error('A heartbeat must not focus a window.'); } },
    scripting: { async executeScript(request) {
      executions.push({ time, request });
      assert.deepEqual(request.target, { tabId: 42, frameIds: [0] }); assert.equal(request.world, 'ISOLATED');
      const result = [{ frameId: 0, documentId: 'fixture-doc', result: { url, hasVideo: true, currentTime: 100 + (time - epoch) / 1000, readyState: 4, paused: videoPaused, ended: false, ad: false, offline: false, error: false } }];
      return scriptOverride ? scriptOverride(result) : result;
    } }
  };
  const chat = { authorized: true, connected: !paused, account, channel: 'live_channel', messages: [], sent: [], coordination: { available: true, paused: false, accounts: [account] } };
  const twitch = { status: () => structuredClone(chat), disconnect() { chat.connected = false; chat.channel = ''; } };
  const control = new LocalControl({ twitch, now: () => time });
  if (paused) control.stopped = true;
  globalThis.chrome = chrome; Date.now = () => time;
  globalThis.setInterval = (fn, delay) => { const id = intervals.size + 1; intervals.set(id, { fn, delay }); return id; };
  globalThis.clearInterval = id => intervals.delete(id);
  globalThis.fetch = async (address, options) => {
    const body = JSON.parse(options.body); requests.push({ address, body, time });
    const json = value => ({ ok: true, json: async () => value });
    if (address.endsWith('/api/control/bridge')) return json(control.bridge(body));
    if (address.endsWith('/api/twitch/status')) return json(structuredClone(chat));
    if (address.endsWith('/api/twitch/channel')) return json({ channel: body.channel, checkedAt: time, canReply: true, streamContext: { channel: body.channel, streamId: '123', isLive: true, title: 'Fixture broadcast', gameName: 'Fixture game', checkedAt: time } });
    if (address.endsWith('/api/twitch/disconnect')) { const value = control.disconnect(body); twitch.disconnect(); return json(value); }
    throw Error(`Unexpected helper operation in heartbeat fixture: ${address}`);
  };
  const flush = async () => { for (let i = 0; i < 35; i++) await new Promise(resolve => setImmediate(resolve)); };
  t.after(async () => { scriptOverride = undefined; await flush(); globalThis.chrome = original.chrome; globalThis.fetch = original.fetch; Date.now = original.now; globalThis.setInterval = original.setInterval; globalThis.clearInterval = original.clearInterval; });
  await import(`../extension/background.js?heartbeat-fixture=${++sequence}`); await flush();
  const heartbeat = async () => { for (const interval of [...intervals.values()]) if (interval.delay === 5000) interval.fn(); await flush(); };
  const alarm = async () => { await chrome.alarms.onAlarm.handlers[0]({ name: 'companion-chat' }); await flush(); };
  // Establish the existing bridge generation and ordinary metadata refresh.
  await heartbeat(); if (!paused) await alarm(); await heartbeat();
  return { epoch, local, chat, chrome, control, executions, requests, focus, heartbeat, alarm, flush,
    now: () => time, advance: ms => { time += ms; }, pauseVideo: () => { videoPaused = true; }, override: fn => { scriptOverride = fn; },
    navigateLoading: async () => { url += '?reload=1'; tabStatus = 'loading'; chrome.tabs.onUpdated.handlers[0](42, { status: 'loading', url }, { id: 42, url, status: tabStatus }); await flush(); } };
}

test('real 5-second bridge heartbeats read native playback and permit detector warmup through the unchanged15-second gate', async t => {
  const f = await fixture(t), db = new DatabaseSync(':memory:'), creates = [], clipJobs = [], messages = [];
  const accounts = { snapshot: async () => ({ instances: [{ ...f.control.status(), id: 'primary', available: true, chat: { messages } }] }),
    clipStatus: async id => id === 'primary' ? { ok: true, authorized: true, account: f.chat.account, jobs: clipJobs } : Promise.reject(Error('unused fixture account')),
    clipCreate: async (id, body) => { creates.push({ id, body }); const job = { ...body, account: f.chat.account, createdAt: f.now(), updatedAt: f.now(), state: 'queued', clipId: '', url: '', error: '' }; clipJobs.push(job); return { ok: true, job }; },
    clipAuthorization: async () => { throw Error('No OAuth in heartbeat fixture.'); } };
  const clips = createClipController({ db, accounts, isPaused: () => false, now: f.now, randomId: () => 'heartbeat-moment' });
  t.after(async () => { await clips.close(); db.close(); });
  clips.configure({ enabled: true, channel: 'live_channel', accountIds: ['primary'] });
  const phases = [];
  for (let elapsed = 0; elapsed <= 110000; elapsed += 5000) {
    if (elapsed) { f.advance(5000); if (elapsed % 30000 === 0) await f.alarm(); await f.heartbeat(); }
    if (elapsed === 95000) for (let i = 0; i < 8; i++) messages.push({ id: `reaction-${i}`, author: `viewer_${i % 4}`, text: 'wow', at: f.now() - i * 100, channel: 'live_channel' });
    await clips.tick(); phases.push(clips.snapshot().detector.state);
    const w = f.control.status().watch;
    assert.ok(f.now() - w.checkedAt <= 15000, `playback evidence became stale at ${elapsed}: ${f.now() - w.checkedAt}ms`);
  }
  assert.equal(phases[18], 'watching', '90 seconds of current evidence completes warmup');
  assert.equal(creates.length, 1); assert.equal(creates[0].body.source, 'automatic');
  assert.ok(f.executions.length >= 20); assert.ok(f.executions.length <= 25, 'existing throttle bounds the native checks');
  assert.equal(f.focus.length, 0);
  assert.equal(f.requests.some(r => /\/send$|\/connect$|\/compose$/.test(r.address)), false);
});

test('a hung native read cannot delay bridge transport or Stop and cannot restore playback after its late result', async t => {
  const f = await fixture(t); let release;
  f.override(result => new Promise(resolve => { release = () => resolve(result); }));
  f.advance(5000); const before = f.requests.filter(r => r.address.endsWith('/api/control/bridge')).length;
  await f.heartbeat(); assert.ok(release, 'native read is still pending');
  assert.ok(f.requests.filter(r => r.address.endsWith('/api/control/bridge')).length > before, 'transport did not await the renderer');
  const command = f.control.command({ requestId: 'fixture-stop', action: 'stop', params: {} }).command;
  await f.heartbeat(); await f.heartbeat();
  assert.equal(f.local.data.settings.paused, true); assert.equal(f.local.data.watchSession.enabled, false);
  assert.equal(f.control.status().controls.recent.find(c => c.id === command.id).state, 'completed');
  release(); await f.flush(); assert.equal(f.local.data.watchSession.enabled, false); assert.equal(f.local.data.watchSession.status, 'off');
  assert.equal(f.focus.length, 0);
});

test('a native navigation invalidates an in-flight document before its late heartbeat read can publish playing', async t => {
  const f = await fixture(t); let release;
  f.override(result => new Promise(resolve => { release = () => resolve(result); }));
  f.advance(5000); await f.heartbeat(); assert.ok(release);
  await f.navigateLoading();
  assert.equal(f.local.data.watchSession.checkedAt, 0);
  release(); await f.flush();
  assert.equal(f.local.data.watchSession.checkedAt, 0); assert.equal(f.local.data.watchSession.status, 'checking'); assert.equal(f.focus.length, 0);
});

test('paused settings do not kick native reads', async t => {
  const held = await fixture(t, { paused: true });
  held.advance(5000); await held.heartbeat(); assert.equal(held.executions.length, 0);
});


test('a genuinely paused native player is published as paused on the next heartbeat', async t => {
  const f = await fixture(t); f.pauseVideo();
  f.advance(5000); await f.heartbeat(); f.advance(5000); await f.heartbeat();
  assert.equal(f.control.status().watch.status, 'paused');
  assert.ok(f.now() - f.control.status().watch.checkedAt <= 15000);
  assert.equal(f.focus.length, 0);
});

test('a disabled watch session cannot start checking playback merely because the bridge is active', async t => {
  const f = await fixture(t, { enabled: false });
  f.advance(5000); await f.heartbeat(); assert.equal(f.executions.length, 0);
  assert.equal(f.local.data.watchSession.enabled, false); assert.equal(f.focus.length, 0);
});
