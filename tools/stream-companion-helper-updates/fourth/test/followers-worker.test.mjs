import test from 'node:test';
import assert from 'node:assert/strict';

const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); } });
let sequence = 0;
async function fixture(t, { connected = true } = {}) {
  const saved = { chrome: globalThis.chrome, fetch: globalThis.fetch, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  const ACCOUNT = 'fixture_companion', CHANNEL = 'live_channel', data = { settings: { schemaVersion: 8, revision: 1, account: ACCOUNT, allowedChannel: CHANNEL, paused: false, autoReply: true, autoResume: true, chatMode: 'participate', replySource: 'ai', pairingToken: 'fixture-token' } }, calls = [];
  const storage = { async get(keys) { if (keys == null) return structuredClone(data); return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in data).map(k => [k, structuredClone(data[k])])); }, async set(value) { Object.assign(data, structuredClone(value)); }, async clear() {}, async setAccessLevel() {} };
  const hold = { account: ACCOUNT, channel: CHANNEL, held: true, code: 'followers_only_mode', reason: 'Fixture follower requirement hold.', at: Date.now() };
  const chrome = { storage: { local: storage, session: { async get() { return {}; }, async set() {}, async clear() {} } },
    runtime: { id: 'fixture-extension', onInstalled: event(), onStartup: event(), onMessage: event() }, sidePanel: { async setPanelBehavior() {} },
    tabs: { onUpdated: event(), onRemoved: event() }, alarms: { onAlarm: event(), async create() {}, async clearAll() {} }, permissions: { async contains() { return true; } } };
  globalThis.chrome = chrome; globalThis.setInterval = () => 1; globalThis.clearInterval = () => {};
  globalThis.fetch = async (address, options) => {
    const body = JSON.parse(options.body); calls.push({ address, body });
    let value = { ok: true };
    if (address.endsWith('/api/twitch/status')) value = { authorized: true, connected, account: ACCOUNT, channel: connected ? CHANNEL : '', recoverable: true, sendHold: hold,
      coordination: { available: true, paused: false, accounts: [] }, messages: [{ id: 'mention', author: 'viewer', text: `@${ACCOUNT} hello`, at: Date.now() }] };
    else if (address.endsWith('/api/twitch/channel')) value = { canReply: true, channel: CHANNEL, checkedAt: Date.now(), chatSettings: { followersOnly: true }, streamContext: { channel: CHANNEL, streamId: '789', isLive: true, checkedAt: Date.now() } };
    else if (address.endsWith('/api/twitch/connect')) { connected = true; value = { connecting: true }; }
    else if (/\/send$|\/compose$/.test(address)) throw Error('A held session must not invoke this provider operation.');
    return { ok: true, json: async () => value };
  };
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
  await import(`../extension/background.js?follower-hold-fixture=${++sequence}`); await flush();
  t.after(async () => { await flush(); globalThis.chrome = saved.chrome; globalThis.fetch = saved.fetch; globalThis.setInterval = saved.setInterval; globalThis.clearInterval = saved.clearInterval; });
  const send = message => new Promise(resolve => chrome.runtime.onMessage.handlers[0](message, { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/panel.html` }, resolve));
  return { data, calls, send, flush, hold };
}

test('the actual background holds mentions, planning, drafts and manual sends while normal read metadata continues', async t => {
  const f = await fixture(t); await f.send({ type: 'getState' }); await f.flush();
  assert.match((await f.send({ type: 'compose', mode: 'reply' })).error, /follower requirement/);
  assert.match((await f.send({ type: 'send', text: 'A reviewed message' })).error, /follower requirement/);
  await f.send({ type: 'getState' }); await f.flush();
  assert.equal(f.calls.some(c => /\/send$|\/compose$/.test(c.address)), false);
  assert.equal(f.data.sent?.length || 0, 0); assert.equal(f.data.participationAttempts?.length || 0, 0);
  assert.equal(f.calls.filter(c => c.address.endsWith('/api/twitch/status')).at(-1).body.observation.exchangeContext, null);
  assert.equal(f.data.settings.paused, false); assert.equal(f.data.settings.autoReply, true);
});

test('a held background still performs a non-explicit read-only network recovery', async t => {
  const f = await fixture(t, { connected: false }); await f.send({ type: 'getState' }); await f.flush();
  const recovery = f.calls.find(c => c.address.endsWith('/api/twitch/connect'));
  assert.ok(recovery); assert.equal(recovery.body.explicitStart, undefined); assert.equal(f.hold.held, true);
  assert.equal(f.calls.some(c => /\/send$|\/compose$/.test(c.address)), false);
});
