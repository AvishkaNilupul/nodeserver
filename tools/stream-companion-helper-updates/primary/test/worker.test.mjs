import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalControl } from '../lib/local-control.mjs';

const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); } });
function storage() {
  const data = {};
  return { data, async get(keys) { if (keys == null) return structuredClone(data); const out = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = structuredClone(data[k]); return out; }, async set(value) { Object.assign(data, structuredClone(value)); }, async clear() { for (const key of Object.keys(data)) delete data[key]; }, async setAccessLevel() {} };
}
let sequence = 0;
async function harness(t) {
  const savedChrome = globalThis.chrome, savedFetch = globalThis.fetch;
  const local = storage(), session = storage(), calls = [];
  const chrome = { storage: { local, session }, tabs: { onUpdated: event(), onRemoved: event() }, runtime: { id: 'unit-test', onInstalled: event(), onStartup: event(), onMessage: event() }, sidePanel: { async setPanelBehavior() {} }, alarms: { onAlarm: event(), async create() {}, async clearAll() {} } };
  const chat = { connected: true, account: 'qumaris_2489', channel: 'test_channel', messages: [{ id: 'incoming', author: 'alice', text: '@qumaris_2489 hello', at: Date.now() }] };
  let fetchOverride;
  globalThis.chrome = chrome;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const custom = await fetchOverride?.(url, options); if (custom) return custom;
    if (url.endsWith('/status')) return { ok: true, json: async () => structuredClone(chat) };
    if (url.endsWith('/send')) return { ok: true, json: async () => ({ submitted: true, delivery: 'confirmed', messageId: 'api-id' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await import(`../extension/background.js?test=${++sequence}`);
  t.after(() => { globalThis.chrome = savedChrome; globalThis.fetch = savedFetch; });
  const panel = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/panel.html` };
  const send = (message, sender = panel) => new Promise(resolve => chrome.runtime.onMessage.handlers[0](message, sender, resolve));
  await send({ type: 'saveSettings', settings: { account: 'qumaris_2489', allowedChannel: 'test_channel', pairingToken: 'local-test', paused: false } });
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { chrome, local, session, chat, calls, panel, send, flush, override: fn => { fetchOverride = fn; } };
}

async function hostedHarness(t, { access = true, offline = false, windowId = 1 } = {}) {
  const h = await harness(t), opened = [], focused = [];
  let tab = { id: 70, windowId, url: 'https://www.twitch.tv/test_channel', status: 'complete' }, clock = 1, connectHook;
  h.chat.messages = []; h.chat.authorized = true;
  h.chrome.permissions = { contains: async () => access, getAll: async () => ({ permissions: access ? ['scripting'] : [], origins: access ? ['https://www.twitch.tv/*'] : [] }), request() { throw Error('A queued command must never request browser access.'); } };
  Object.assign(h.chrome.tabs, { create: async options => { opened.push(options); tab = { ...tab, url: options.url }; return { ...tab }; },
    get: async () => ({ ...tab }), update: async (id, options) => { focused.push({ id, options }); return { ...tab }; } });
  h.chrome.windows = { update: async (id, options) => { focused.push({ windowId: id, options }); } };
  h.chrome.scripting = { executeScript: async () => [{ frameId: 0, documentId: 'control-doc', result: { url: tab.url, hasVideo: true, currentTime: clock++, readyState: 4, paused: false } }] };
  const twitch = { status: () => ({ ...h.chat, authorized: true, sent: h.local.data.sent || [] }), disconnect() { h.chat.connected = false; h.chat.channel = ''; h.chat.messages = []; } };
  const control = new LocalControl({ twitch });
  h.override(async (url, options) => {
    const body = JSON.parse(options.body);
    const json = value => ({ ok: true, json: async () => value });
    try {
      if (url.endsWith('/api/control/bridge')) return json(control.bridge(body));
      if (url.endsWith('/api/twitch/channel')) return json({ channel: body.channel, checkedAt: Date.now(), canReply: !offline, reason: offline ? 'The stream is offline.' : '', streamContext: { channel: body.channel, streamId: offline ? '' : '987654321', gameName: 'Minecraft', title: 'A stream', isLive: !offline, checkedAt: Date.now() } });
      if (url.endsWith('/api/twitch/disconnect')) { const result = control.disconnect(body); twitch.disconnect(); return json(result); }
      if (url.endsWith('/api/twitch/connect')) {
        const intent = body.explicitStart ? control.nativeStart(body) : undefined;
        const permitted = intent ? { ...body, controlGeneration: intent.generation } : body;
        control.guard(permitted); await connectHook?.(); control.guard(permitted);
        Object.assign(h.chat, { connected: true, channel: body.channel, account: body.account });
        return json({ connecting: true, ...(intent ? { intent } : {}) });
      }
      if (url.endsWith('/api/twitch/send')) { control.guard(body); return json({ submitted: true, delivery: 'confirmed', messageId: 'reviewed-api-id' }); }
    } catch (error) { return { ok: false, status: 409, json: async () => ({ error: error.message }) }; }
    return null;
  });
  const poll = async () => { await h.chrome.alarms.onAlarm.handlers[0]({ name: 'companion-chat' }); await h.flush(); };
  await poll();
  return { ...h, control, opened, focused, poll, connectHook: fn => { connectHook = fn; },
    command: (action, params = {}, requestId = `control-${h.calls.length}-${action}`) => control.command({ requestId, action, params }).command };
}

test('hosted Start connects the correct profile and opens playback before arming selected settings', async t => {
  const h = await hostedHarness(t);
  const command = h.command('start', { channel: 'another_channel', chatMode: 'mentions', replySource: 'ai', autoResume: true });
  await h.poll(); await h.poll();
  const result = h.control.status().controls.recent.find(x => x.id === command.id);
  assert.equal(result.state, 'completed', result.error);
  assert.equal(h.local.data.settings.allowedChannel, 'another_channel'); assert.equal(h.local.data.settings.autoReply, true);
  assert.equal(h.local.data.settings.autoResume, true); assert.equal(h.local.data.settings.replySource, 'ai'); assert.equal(h.local.data.settings.chatMode, 'mentions');
  assert.equal(h.opened.length, 1); assert.equal(h.opened[0].url, 'https://www.twitch.tv/another_channel');
  const connect = h.calls.find(x => x.url.endsWith('/connect'));
  assert.equal(connect.body.account, 'qumaris_2489'); assert.equal(connect.body.explicitStart, undefined);
  assert.equal(connect.body.controlGeneration, command.generation); assert.ok(connect.body.controlSessionId);
  assert.equal(connect.body.controlCommandId, command.id);
  const completion = h.calls.find(x => x.url.endsWith('/bridge') && x.body.completion?.id === command.id);
  assert.equal(completion.body.state.settings.allowedChannel, 'another_channel'); assert.equal(completion.body.state.settings.autoReply, true);
  assert.equal(h.calls.some(x => x.url.endsWith('/send')), false);
});

test('hosted Start preserves offline waiting intent and opens normal watch without sending', async t => {
  const h = await hostedHarness(t, { offline: true });
  const command = h.command('start', { channel: 'friend_offline', chatMode: 'participate', replySource: 'local', autoResume: true });
  await h.poll(); await h.poll();
  const result = h.control.status().controls.recent.find(x => x.id === command.id);
  assert.equal(result.state, 'completed', result.error);
  assert.equal(h.local.data.settings.autoReply, true); assert.equal(h.local.data.settings.autoResume, true);
  assert.equal(h.opened[0].url, 'https://www.twitch.tv/friend_offline');
  assert.equal(h.control.status().streamContext.isLive, false); assert.match(h.control.status().activity.reason, /offline|live playback/i);
  h.chat.messages = [{ id: 'offline-human', author: 'alice', text: '@qumaris_2489 hello', at: Date.now() }];
  await h.poll();
  assert.equal(h.calls.some(x => x.url.endsWith('/send')), false);
});

test('hosted Stop preempts a slow Start without opening a stream or restoring automatic chat', async t => {
  const h = await hostedHarness(t); let release;
  h.connectHook(() => new Promise(resolve => { release = resolve; }));
  const start = h.command('start', { channel: 'another_channel', chatMode: 'participate', replySource: 'local', autoResume: true });
  await h.poll(); assert.ok(release);
  const stop = h.command('stop'); await h.poll(); release(); await h.flush(); await h.poll();
  assert.equal(h.local.data.settings.paused, true); assert.equal(h.local.data.settings.autoReply, false); assert.equal(h.local.data.settings.autoResume, false);
  assert.equal(h.opened.length, 0); assert.equal(h.calls.some(x => x.url.endsWith('/send')), false);
  const recent = h.control.status().controls.recent;
  assert.equal(recent.find(x => x.id === start.id).state, 'cancelled'); assert.equal(recent.find(x => x.id === stop.id).state, 'completed');
});

test('missing playback permission fails hosted Start and disarms without an extension permission prompt', async t => {
  const h = await hostedHarness(t, { access: false });
  const command = h.command('start', { channel: 'another_channel', chatMode: 'participate', replySource: 'local', autoResume: true });
  await h.poll(); await h.poll();
  const result = h.control.status().controls.recent.find(x => x.id === command.id);
  assert.equal(result.state, 'failed'); assert.match(result.error, /playback access/);
  assert.equal(h.local.data.settings.paused, true); assert.equal(h.local.data.settings.autoReply, false);
  assert.equal(h.opened.length, 0); assert.equal(h.calls.some(x => x.url.endsWith('/connect')), false);
});

test('hosted drafts stay drafts, reviewed sends execute once, and command results contain no setup secrets', async t => {
  const h = await hostedHarness(t);
  h.chat.messages = [{ id: 'fresh-mention', author: 'alice', text: '@qumaris_2489 hello', at: Date.now() }];
  const draft = h.command('draft', { mode: 'reply' }); await h.poll(); await h.poll();
  const drafted = h.control.status().controls.recent.find(x => x.id === draft.id);
  assert.equal(drafted.state, 'completed'); assert.ok(drafted.result.text); assert.equal(h.calls.some(x => x.url.endsWith('/send')), false);
  const send = h.command('send', { text: 'one reviewed message' }, 'reviewed-idempotent'); await h.poll(); await h.poll();
  h.command('send', { text: 'one reviewed message' }, 'reviewed-idempotent'); await h.poll();
  assert.equal(h.calls.filter(x => x.url.endsWith('/send')).length, 1);
  assert.equal(h.control.status().controls.recent.find(x => x.id === send.id).state, 'completed');
  assert.equal(JSON.stringify(h.control.status()).includes('local-test'), false);
});

test('hosted Watch brings its tracked stream forward without opening duplicate tabs', async t => {
  const h = await hostedHarness(t);
  h.command('start', { channel: 'test_channel', chatMode: 'mentions', replySource: 'local', autoResume: false }); await h.poll(); await h.poll();
  assert.equal(h.opened.length, 1);
  h.focused.length = 0;
  h.command('watch'); await h.poll(); await h.poll();
  assert.equal(h.opened.length, 1); assert.ok(h.focused.some(x => x.options.active)); assert.ok(h.focused.some(x => x.options.focused));
});

test('hosted Watch still opens the ordinary stream while stopped without connecting or arming chat', async t => {
  const h = await hostedHarness(t);
  h.command('stop'); await h.poll(); await h.poll();
  const command = h.command('watch'); await h.poll(); await h.poll();
  assert.equal(h.control.status().controls.recent.find(x => x.id === command.id).state, 'completed');
  assert.equal(h.opened.length, 1); assert.equal(h.opened[0].url, 'https://www.twitch.tv/test_channel');
  assert.equal(h.local.data.settings.paused, true); assert.equal(h.local.data.settings.autoReply, false);
  assert.equal(h.calls.some(x => x.url.endsWith('/connect') || x.url.endsWith('/send')), false);
});

test('hosted Start and stopped Watch focus the window returned by the newly created stream tab', async t => {
  const h = await hostedHarness(t, { windowId: 947 });
  h.command('start', { channel: 'test_channel', chatMode: 'mentions', replySource: 'local', autoResume: false });
  await h.poll(); await h.poll();
  assert.deepEqual(h.focused.filter(x => x.windowId !== undefined), [{ windowId: 947, options: { focused: true } }]);
  h.command('stop'); await h.poll(); await h.poll(); h.focused.length = 0;
  h.command('watch'); await h.poll(); await h.poll();
  assert.deepEqual(h.focused.filter(x => x.windowId !== undefined), [{ windowId: 947, options: { focused: true } }]);
});

test('Stop during a newly created hosted watch tab prevents the delayed window focus', async t => {
  const h = await hostedHarness(t, { windowId: 947 }); let release;
  const create = h.chrome.tabs.create;
  h.chrome.tabs.create = async options => { await new Promise(resolve => { release = resolve; }); return create(options); };
  h.command('watch'); await h.poll(); assert.ok(release);
  h.command('stop'); await h.poll(); release(); await h.flush(); await h.poll();
  assert.equal(h.focused.length, 0); assert.equal(h.local.data.settings.paused, true);
});

test('a hosted watch expiring while its new tab opens cannot focus that window afterward', async t => {
  const originalNow = Date.now; let time = originalNow(); Date.now = () => time;
  let release;
  try {
    const h = await hostedHarness(t, { windowId: 947 }), create = h.chrome.tabs.create;
    h.chrome.tabs.create = async options => { await new Promise(resolve => { release = resolve; }); return create(options); };
    const command = h.command('watch'); await h.poll(); assert.ok(release);
    time = Date.parse(command.expiresAt) + 1; release(); await h.flush();
    assert.equal(h.focused.length, 0);
  } finally { release?.(); Date.now = originalNow; }
});

test('hosted settings cannot resume Stop, while native Connect still resumes draft-only fallback', async t => {
  const h = await hostedHarness(t);
  h.command('stop'); await h.poll(); await h.poll();
  const settings = h.command('settings', { chatMode: 'participate', replySource: 'ai', autoResume: true }); await h.poll(); await h.poll();
  assert.equal(h.control.status().controls.recent.find(x => x.id === settings.id).state, 'completed');
  assert.equal(h.local.data.settings.paused, true); assert.equal(h.local.data.settings.autoReply, false);
  assert.equal(h.local.data.settings.chatMode, 'participate'); assert.equal(h.local.data.settings.replySource, 'ai'); assert.equal(h.local.data.settings.autoResume, true);
  const result = await h.send({ type: 'connect' });
  assert.equal(result.error, undefined); assert.equal(h.local.data.settings.paused, false); assert.equal(h.local.data.settings.autoReply, false);
  assert.equal(h.local.data.settings.autoResume, false); assert.equal(h.opened.length, 0);
  const connect = h.calls.find(x => x.url.endsWith('/connect')); assert.equal(connect.body.explicitStart, true); assert.ok(connect.body.controlGeneration); assert.ok(connect.body.controlSessionId);
});

test('a hosted send expiring during its durable intent write never reaches the helper send boundary', async t => {
  const originalNow = Date.now; let time = originalNow(); Date.now = () => time;
  let release;
  try {
    const h = await hostedHarness(t), originalSet = h.local.set.bind(h.local);
    h.local.set = async value => {
      if (!release && value.sent?.some(x => x.delivery === 'pending')) await new Promise(resolve => { release = resolve; });
      return originalSet(value);
    };
    const command = h.command('send', { text: 'one reviewed message' }); await h.poll(); assert.ok(release);
    time = Date.parse(command.expiresAt) + 1;
    assert.equal(h.control.status().controls.recent.find(x => x.id === command.id).state, 'expired');
    release(); await h.flush();
    assert.equal(h.calls.filter(x => x.url.endsWith('/send')).length, 0);
    assert.equal(h.local.data.sent.at(-1).delivery, 'cancelled');
  } finally { release?.(); Date.now = originalNow; }
});

test('baseline has no Twitch access; drops request only optional scripting and Twitch access', async () => {
  const m = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(m.permissions, ['storage', 'sidePanel', 'alarms']);
  assert.deepEqual(m.host_permissions, ['http://127.0.0.1:8792/*']);
  assert.equal(m.content_scripts, undefined);
  assert.deepEqual(m.optional_permissions, ['scripting']);
  assert.deepEqual(m.optional_host_permissions, ['https://www.twitch.tv/*']);
});

test('old viewing/follow settings are stripped and startup cannot resume automation', async t => {
  const h = await harness(t);
  h.local.data.settings = { ...h.local.data.settings, schemaVersion: 5, autoReply: true, watchEnabled: true, followAfterWatch: true, unfollowInactive: true };
  assert.equal((await h.send({ type: 'getState' })).settings.autoReply, false);
  await h.chrome.runtime.onStartup.handlers[0]();
  assert.equal(h.local.data.settings.autoReply, false);
  for (const key of ['watchEnabled', 'followAfterWatch', 'unfollowInactive']) assert.equal(key in h.local.data.settings, false);
  assert.ok(h.calls.some(c => c.url.endsWith('/disconnect')));
  for (const type of ['capture', 'nextStream', 'watchActionState']) assert.match((await h.send({ type })).error, /Unknown operation/);
});

test('Twitch pages cannot configure, read, or send; a full-page extension panel works', async t => {
  const h = await harness(t);
  for (const sender of [{ id: 'unit-test', tab: { id: 7 }, url: 'https://www.twitch.tv/test_channel' }, { id: 'other', url: h.panel.url }, { id: 'unit-test', url: 'chrome-extension://unit-test/other.html' }]) {
    for (const type of ['getState', 'send', 'saveSettings', 'compose', 'pickPhrase']) assert.match((await h.send({ type }, sender)).error, /only available from the extension panel/);
  }
  assert.ok((await h.send({ type: 'getState' }, { ...h.panel, tab: { id: 7 } })).settings);
  assert.ok((await h.send({ type: 'getState' }, { ...h.panel, url: 'chrome-extension://unit-test/simple.html', tab: { id: 8 } })).settings);
});

test('local previews still work with no helper or Twitch account authorization', async t => {
  const h = await harness(t);
  await h.send({ type: 'saveSettings', settings: { ...h.local.data.settings, pairingToken: '' } });
  h.override(() => { throw new Error('offline'); });
  assert.ok((await h.send({ type: 'pickPhrase', category: 'greeting' })).text);
  assert.equal((await h.send({ type: 'getState' })).settings.autoReply, false);
});

test('manual send preserves casual wording through the official API and enforces cooldown', async t => {
  const h = await harness(t);
  const result = await h.send({ type: 'send', text: 'hello' });
  assert.equal(result.delivery, 'confirmed'); assert.equal(result.messageId, 'api-id');
  assert.equal(h.local.data.sent[0].text, 'hello');
  assert.equal(h.local.data.sent[0].delivery, 'confirmed');
  assert.match((await h.send({ type: 'send', text: 'hey' })).error, /cooldown/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});

test('automatic replies answer direct mentions once through the official API', async t => {
  const h = await harness(t);
  await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { ...h.local.data.settings, autoReply: true } });
  await h.send({ type: 'getState' }); await h.flush();
  const calls = h.calls.filter(c => c.url.endsWith('/send'));
  assert.equal(calls.length, 1); assert.equal(calls[0].body.replyTo, 'incoming');
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});

test('unknown requests, unmentioned chat, future and stale messages cannot trigger automatic posts', async t => {
  const h = await harness(t);
  await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { ...h.local.data.settings, autoReply: true } });
  for (const [index, fields] of [{ text: '@qumaris_2489 what game is this?' }, { text: 'hello everyone' }, { at: Date.now() - 46000 }, { at: Date.now() + 2000 }].entries()) {
    h.chat.messages = [{ id: `message-${index}`, author: 'alice', text: '@qumaris_2489 hi', at: Date.now(), ...fields }];
    await h.send({ type: 'getState' }); await h.flush();
  }
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('Pause interrupts a slow model reply and clears the official chat connection', async t => {
  const h = await harness(t); let finish;
  await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { ...h.local.data.settings, replySource: 'ai', autoReply: true } });
  h.override(url => url.endsWith('/api/compose') ? new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ text: 'hello' }) }); }) : null);
  await h.send({ type: 'getState' }); await h.flush(); assert.ok(finish);
  await h.send({ type: 'saveSettings', settings: { ...h.local.data.settings, paused: true } });
  finish(); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.equal(h.local.data.settings.autoReply, false);
  assert.equal((await h.send({ type: 'getState' })).chat.connected, false);
});

test('failed API submission consumes its budget and does not retry uncertain delivery', async t => {
  const h = await harness(t);
  h.override(url => { if (url.endsWith('/send')) throw new Error('lost response'); });
  assert.match((await h.send({ type: 'send', text: 'hello' })).error, /lost response/);
  assert.equal(h.local.data.sent[0].delivery, 'unknown');
  assert.match((await h.send({ type: 'send', text: 'hello' })).error, /cooldown/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});

test('AI requests include the precise mention target and recent replies', async t => {
  const h = await harness(t);
  h.chat.messages.push({ id: 'unrelated', author: 'bob', text: 'something else', at: Date.now() });
  await h.send({ type: 'saveSettings', settings: { ...h.local.data.settings, replySource: 'ai' } });
  h.local.data.sent = [{ at: Date.now() - 300000, channel: 'test_channel', text: '[bot] hey', delivery: 'confirmed' }];
  h.override(url => url.endsWith('/api/compose') ? { ok: true, json: async () => ({ text: 'hello' }) } : null);
  await h.send({ type: 'compose', mode: 'reply' });
  const request = h.calls.find(c => c.url.endsWith('/api/compose')).body;
  assert.equal(request.target.id, 'incoming'); assert.equal(request.recentReplies[0].text, '[bot] hey');
});

test('away mode preserves intent on startup and reconnects without opening the panel', async t => {
  const h = await harness(t); await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { autoResume: true, autoReply: true } });
  h.chat.connected = false; h.chat.channel = ''; h.chat.messages = [];
  await h.chrome.runtime.onStartup.handlers[0](); await h.flush();
  assert.equal(h.local.data.settings.autoResume, true); assert.equal(h.local.data.settings.autoReply, true);
  assert.equal(h.calls.filter(c => c.url.endsWith('/connect')).length, 1);
  await h.chrome.alarms.onAlarm.handlers[0]({ name: 'companion-chat' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/connect')).length, 1, 'recovery uses backoff');
});

test('away mode can monitor without replies; revocation and Pause stop recovery', async t => {
  const h = await harness(t); await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { autoResume: true, autoReply: false } });
  h.chat.connected = false; h.chat.channel = ''; h.chat.recoverable = false;
  await h.chrome.alarms.onAlarm.handlers[0]({ name: 'companion-chat' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/connect')).length, 0);
  h.chat.recoverable = true;
  await h.chrome.alarms.onAlarm.handlers[0]({ name: 'companion-chat' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/connect')).length, 1);
  await h.send({ type: 'pause' });
  assert.equal(h.local.data.settings.autoResume, false); assert.equal(h.local.data.settings.autoReply, false);
  h.session.data.recovery = {};
  await h.chrome.alarms.onAlarm.handlers[0]({ name: 'companion-chat' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/connect')).length, 1);
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('Pause bypasses a pending connection and cancels queued sends', async t => {
  const h = await harness(t); let release;
  h.override(url => url.endsWith('/connect') ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ connecting: true }) }); }) : null);
  const connecting = h.send({ type: 'connect' }); await h.flush(); assert.ok(release);
  const sending = h.send({ type: 'send', text: 'hello' });
  await h.send({ type: 'pause' });
  assert.equal(h.local.data.settings.paused, true);
  release(); await connecting; assert.match((await sending).error, /cancelled/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('local catch-up works without a model provider and only quotes received chat', async t => {
  const h = await harness(t);
  const result = await h.send({ type: 'compose', mode: 'summary' });
  assert.match(result.summary, /@alice: “@qumaris_2489 hello”/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/api/compose')).length, 0);
  h.chat.messages = [];
  assert.match((await h.send({ type: 'compose', mode: 'summary' })).summary, /No chat messages/);
});

test('changing app identity cannot leave automatic replies armed', async t => {
  const h = await harness(t); await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { autoReply: true } });
  assert.match((await h.send({ type: 'saveSettings', settings: { clientId: 'different-client' } })).error, /Save setup/);
});

test('Watch on Twitch opens the normal saved channel even while chat/helper are paused', async t => {
  const h = await harness(t); const opened = [];
  await h.send({ type: 'pause' });
  const before = h.calls.length;
  h.override(() => { throw new Error('helper unavailable'); });
  h.chrome.tabs = { create: async options => { opened.push(options); return { id: 123 }; } };
  assert.equal((await h.send({ type: 'openTwitch' })).ok, true);
  assert.deepEqual(opened, [{ url: 'https://www.twitch.tv/test_channel', active: true }]);
  assert.equal(h.calls.length, before, 'watching does not request a local player or fetch stream data');
  assert.equal(h.local.data.settings.paused, true);
});

test('watching rejects empty or malformed targets before creating a browser tab', async t => {
  const h = await harness(t); let opened = 0;
  h.chrome.tabs = { create: async () => { opened++; } };
  for (const allowedChannel of ['', 'https://evil.example', '../settings', 'name?redirect=other']) {
    h.local.data.settings.allowedChannel = allowedChannel;
    assert.match((await h.send({ type: 'openTwitch' })).error, /channel login/);
  }
  assert.equal(opened, 0);
});

test('Pause chat and Disconnect never close, mute, or modify normal Twitch tabs', async t => {
  const h = await harness(t);
  h.chrome.tabs = new Proxy({}, { get() { throw new Error('Chat controls must not control browser tabs'); } });
  assert.equal((await h.send({ type: 'disconnect' })).ok, true);
  assert.equal((await h.send({ type: 'pause' })).ok, true);
});

async function tracked(h) {
  const tab = { id: 7, url: 'https://www.twitch.tv/test_channel', status: 'complete' };
  let clock = 10;
  h.chrome.permissions = { contains: async () => true, getAll: async () => ({ permissions: ['scripting'], origins: ['https://www.twitch.tv/*'] }) };
  Object.assign(h.chrome.tabs, { create: async () => tab, get: async () => ({ ...tab }) });
  h.chrome.scripting = { executeScript: async () => [{ frameId: 0, documentId: 'doc', result: { url: tab.url, hasVideo: true, currentTime: clock++, readyState: 4, paused: false } }] };
  h.chat.messages = [];
  h.override((url, options) => {
    const b = JSON.parse(options.body);
    if (url.endsWith('/channel')) return { ok: true, json: async () => ({ channel: b.channel, checkedAt: Date.now(), canReply: true, streamContext: { channel: b.channel, streamId: '987654321', gameName: 'Minecraft', title: 'A stream', isLive: true, checkedAt: Date.now() } }) };
    if (url.endsWith('/connect')) { h.chat.channel = b.channel; h.chat.connected = true; h.chat.messages = []; }
    if (url.endsWith('/disconnect')) { h.chat.connected = false; h.chat.channel = ''; h.chat.messages = []; }
    return null;
  });
  await h.send({ type: 'getState' });
  assert.equal((await h.send({ type: 'openTwitch' })).ok, true);
  await h.send({ type: 'getState' });
  for (const fn of h.chrome.tabs.onUpdated.handlers) fn(tab.id, { status: 'complete' }, tab);
  await h.flush();
  return { tab, update: async (url, change = {}) => { tab.url = url; for (const fn of h.chrome.tabs.onUpdated.handlers) fn(tab.id, { url, ...change }, tab); await h.flush(); } };
}

async function exchangeReady(t) {
  const h = await harness(t); await tracked(h);
  const offer = { id: 'scheduled-turn', key: 'exchange:scheduled-turn', account: 'qumaris_2489', channel: 'test_channel',
    streamId: '987654321', text: '@other_companion a short chat break.', notBefore: Date.now() - 1, expiresAt: Date.now() + 20_000 };
  h.chat.coordination = { available: true, paused: false, accounts: ['qumaris_2489', 'other_companion'], textKeys: [], topicStreams: [], replyIds: [], exchange: offer };
  h.local.data.participationAttempts = ['greeting', 'topic'].map(kind => ({ key: `old-${kind}`, kind,
    account: offer.account, channel: offer.channel, streamId: offer.streamId, at: Date.now() - 600_000, delivery: 'confirmed', submitted: true }));
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate', replySource: 'ai' } });
  return { h, offer };
}

test('a due exchange uses exact host text without AI or a fabricated Twitch reply target', async t => {
  const { h, offer } = await exchangeReady(t);
  await h.send({ type: 'getState' }); await h.flush();
  const sends = h.calls.filter(c => c.url.endsWith('/send'));
  assert.equal(sends.length, 1); assert.equal(sends[0].body.text, offer.text);
  assert.match(sends[0].body.text, /^@other_companion \S/);
  assert.equal(sends[0].body.kind, 'exchange'); assert.equal(sends[0].body.exchangeId, offer.id);
  assert.equal(sends[0].body.participationKey, offer.key); assert.equal(sends[0].body.streamId, offer.streamId);
  assert.equal(sends[0].body.replyTo, ''); assert.equal(sends[0].body.replyAuthor, '');
  assert.equal(h.calls.some(c => c.url.endsWith('/api/compose')), false);
  const observation = h.calls.filter(c => c.url.endsWith('/status')).at(-1).body.observation;
  assert.deepEqual(observation.exchangeContext, { streamId: offer.streamId, checkedAt: observation.exchangeContext.checkedAt, lastHumanAt: 0 });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});

test('a later plain companion mention cannot hide an earlier human mention or trigger exchange AI', async t => {
  const { h } = await exchangeReady(t);
  h.chat.messages = [{ id: 'human-first', author: 'alice', text: '@qumaris_2489 hello', at: Date.now() - 1000 },
    { id: 'companion-last', author: 'other_companion', text: '@qumaris_2489 hello', at: Date.now() - 1 }];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => url.endsWith('/api/compose')
    ? (h.calls.push({ url, body: JSON.parse(options.body) }), { ok: true, json: async () => ({ text: 'hello there' }) })
    : originalFetch(url, options);
  await h.send({ type: 'getState' }); await h.flush();
  const sends = h.calls.filter(c => c.url.endsWith('/send'));
  assert.equal(sends.length, 1); assert.equal(sends[0].body.replyTo, 'human-first');
  assert.equal(sends[0].body.exchangeId, undefined);
  assert.equal(h.calls.find(c => c.url.endsWith('/api/compose')).body.target.id, 'human-first');
  const context = h.calls.filter(c => c.url.endsWith('/status')).at(-1).body.observation.exchangeContext;
  assert.equal(context.lastHumanAt, h.chat.messages[0].at);
});

test('fresh public conversation takes priority over a due exchange', async t => {
  const { h } = await exchangeReady(t);
  await h.send({ type: 'saveSettings', settings: { replySource: 'local' } });
  h.chat.messages = [{ id: 'human-public', author: 'alice', text: 'what game is this?', at: Date.now() - 1 }];
  await h.send({ type: 'getState' }); await h.flush();
  const sends = h.calls.filter(c => c.url.endsWith('/send'));
  assert.equal(sends.length, 1); assert.equal(sends[0].body.kind, 'conversation');
  assert.equal(sends[0].body.replyTo, 'human-public');
});

test('expired offers, paused host, mention-only mode and pending participation spacing hold exchanges', async t => {
  const { h, offer } = await exchangeReady(t);
  const poll = async () => { await h.send({ type: 'getState' }); await h.flush(); };
  offer.expiresAt = Date.now() - 1; await poll();
  offer.expiresAt = Date.now() + 20_000; h.chat.coordination.paused = true; await poll();
  h.chat.coordination.paused = false;
  await h.send({ type: 'saveSettings', settings: { chatMode: 'mentions' } }); await poll();
  assert.equal(h.calls.filter(c => c.url.endsWith('/status')).at(-1).body.observation.exchangeContext, null);
  await h.send({ type: 'saveSettings', settings: { chatMode: 'participate' } });
  h.local.data.participationAttempts.push({ ...h.local.data.participationAttempts[0], kind: 'conversation', key: 'unresolved', at: Date.now() - 1, delivery: 'pending', submitted: false });
  await poll();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('exchange text changes during final refresh cancel the prepared line', async t => {
  const { h, offer } = await exchangeReady(t); let polls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/status') && ++polls === 2) offer.text = '@other_companion a changed line.';
    return originalFetch(url, options);
  };
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('settings changes while saving an exchange intent cancel before helper submission', async t => {
  const { h } = await exchangeReady(t); let release;
  const originalSet = h.local.set.bind(h.local);
  h.local.set = async value => {
    if (!release && value.participationAttempts?.some(x => x.kind === 'exchange' && x.delivery === 'pending')) {
      await new Promise(resolve => { release = resolve; });
    }
    return originalSet(value);
  };
  await h.send({ type: 'getState' }); await h.flush(); assert.ok(release);
  h.local.data.settings = { ...h.local.data.settings, chatMode: 'mentions', revision: h.local.data.settings.revision + 1 };
  release(); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.equal(h.local.data.participationAttempts.find(x => x.kind === 'exchange').delivery, 'cancelled');
});

test('Pause interrupts an exchange while its durable intent is being saved', async t => {
  const { h } = await exchangeReady(t); let release;
  const originalSet = h.local.set.bind(h.local);
  h.local.set = async value => {
    if (!release && value.participationAttempts?.some(x => x.kind === 'exchange' && x.delivery === 'pending')) {
      await new Promise(resolve => { release = resolve; });
    }
    return originalSet(value);
  };
  await h.send({ type: 'getState' }); await h.flush(); assert.ok(release);
  await h.send({ type: 'pause' }); release(); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.equal(h.local.data.settings.paused, true);
  const entry = h.local.data.participationAttempts.find(x => x.kind === 'exchange');
  assert.equal(entry.delivery, 'cancelled'); assert.equal(entry.submitted, false);
});

test('an offer expiring while its durable intent is saved never reaches the helper', async t => {
  const { h } = await exchangeReady(t); let release;
  const originalSet = h.local.set.bind(h.local);
  h.local.set = async value => {
    if (!release && value.participationAttempts?.some(x => x.kind === 'exchange' && x.delivery === 'pending')) {
      await new Promise(resolve => { release = resolve; });
    }
    return originalSet(value);
  };
  await h.send({ type: 'getState' }); await h.flush(); assert.ok(release);
  const originalNow = Date.now, later = Date.now() + 20_001;
  Date.now = () => later;
  try { release(); await h.flush(); } finally { Date.now = originalNow; }
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  const entry = h.local.data.participationAttempts.find(x => x.kind === 'exchange');
  assert.equal(entry.delivery, 'cancelled'); assert.equal(entry.submitted, false);
});

test('uncertain exchanges remain consumed after the local hourly budget clears', async t => {
  const { h } = await exchangeReady(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => url.endsWith('/send')
    ? (h.calls.push({ url, body: JSON.parse(options.body) }), { ok: true, json: async () => ({ delivery: 'unknown', submitted: false }) })
    : originalFetch(url, options);
  await h.send({ type: 'getState' }); await h.flush();
  const entry = h.local.data.participationAttempts.find(x => x.kind === 'exchange');
  assert.equal(entry.delivery, 'unknown'); assert.equal(entry.submitted, true);
  entry.at -= 3_600_001; h.local.data.sent = [];
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});

test('tracked stream navigation aligns chat and preserves selected reply intent', async t => {
  const h = await harness(t), w = await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true, autoResume: true } });
  await w.update('https://www.twitch.tv/next_channel?referrer=raid');
  const s = await h.send({ type: 'getState' });
  assert.equal(s.settings.allowedChannel, 'next_channel'); assert.equal(s.chat.channel, 'next_channel');
  assert.equal(s.settings.autoReply, true); assert.equal(s.settings.autoResume, true);
  assert.equal(s.watch.syncStatus, 'aligned');
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('Pause cancels channel alignment while its official check is pending', async t => {
  const h = await harness(t), w = await tracked(h); let release;
  await h.send({ type: 'saveSettings', settings: { autoReply: true, autoResume: true } });
  h.override(url => url.endsWith('/channel') ? new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ channel: 'next_channel', canReply: true }) }); }) : null);
  await w.update('https://www.twitch.tv/next_channel?referrer=raid'); assert.ok(release);
  await h.send({ type: 'pause' }); release(); await h.flush();
  assert.equal(h.local.data.settings.paused, true); assert.equal(h.local.data.settings.autoReply, false);
  assert.equal(h.calls.filter(c => c.url.endsWith('/connect') && c.body.channel === 'next_channel').length, 0);
  assert.equal((await h.send({ type: 'getState' })).watch.enabled, false);
});

test('closing the tracked stream disarms replies and away-mode recovery', async t => {
  const h = await harness(t); await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true, autoResume: true } });
  for (const fn of h.chrome.tabs.onRemoved.handlers) fn(7); await h.flush();
  const s = await h.send({ type: 'getState' });
  assert.equal(s.settings.autoReply, false); assert.equal(s.settings.autoResume, false); assert.equal(s.watch.enabled, false);
});

test('paused player suppresses automatic sends until playback advances again', async t => {
  const h = await harness(t); await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true } });
  h.local.data.watchSession.status = 'paused'; h.local.data.watchSession.checkedAt = Date.now();
  h.chat.messages = [{ id: 'paused-mention', author: 'alice', text: '@qumaris_2489 hello', at: Date.now() }];
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.match((await h.send({ type: 'getState' })).activity.reason, /playback: paused/);
  h.local.data.watchSession.status = 'playing';
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});

const channelResponse = channel => ({ ok: true, json: async () => ({ channel, checkedAt: Date.now(), canReply: true,
  streamContext: { channel, gameName: 'Minecraft', title: 'A stream', isLive: true, checkedAt: Date.now() } }) });

test('Pause remains final when an alignment settings write is already in flight', async t => {
  const h = await harness(t), w = await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true, autoResume: true } });
  const originalSet = h.local.set.bind(h.local); let release, held = false;
  h.local.set = async value => {
    if (!held && value.settings?.allowedChannel === 'next_channel' && !value.settings.paused) {
      held = true; await new Promise(resolve => { release = resolve; });
    }
    return originalSet(value);
  };
  await w.update('https://www.twitch.tv/next_channel?referrer=raid');
  assert.ok(release, 'navigation reached the delayed settings write');
  const pausing = h.send({ type: 'pause' }); await h.flush();
  release(); await pausing; await h.flush();
  const state = await h.send({ type: 'getState' });
  assert.equal(state.settings.paused, true);
  assert.equal(state.settings.autoReply, false); assert.equal(state.settings.autoResume, false);
  assert.equal(state.watch.enabled, false); assert.equal(state.chat.connected, false);
  assert.equal(h.calls.filter(c => c.url.endsWith('/connect') && c.body.channel === 'next_channel').length, 0);
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('closing the tracked tab preserves a newer reply source saved during disconnect', async t => {
  const h = await harness(t); await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true, autoResume: true } });
  let release;
  h.override(url => {
    if (url.endsWith('/disconnect')) {
      h.chat.connected = false; h.chat.channel = ''; h.chat.messages = [];
      return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true }) }); });
    }
    return null;
  });
  for (const fn of h.chrome.tabs.onRemoved.handlers) fn(7); await h.flush();
  assert.ok(release, 'closure is waiting for its disconnect response');
  const saved = await h.send({ type: 'saveSettings', settings: { replySource: 'ai', autoReply: false, autoResume: false } });
  assert.equal(saved.ok, true);
  release(); await h.flush();
  const state = await h.send({ type: 'getState' });
  assert.equal(state.settings.replySource, 'ai');
  assert.equal(state.settings.autoReply, false); assert.equal(state.settings.autoResume, false);
  assert.equal(state.watch.enabled, false);
});

test('a pre-navigation status response cannot restore the old connected chat or messages', async t => {
  const h = await harness(t), w = await tracked(h);
  h.chat.messages = [{ id: 'old-message', author: 'alice', text: 'old channel conversation', at: Date.now() }];
  const stale = structuredClone(h.chat); let releaseStatus, releaseChannel;
  h.override((url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/status') && !releaseStatus) return new Promise(resolve => {
      releaseStatus = () => resolve({ ok: true, json: async () => stale });
    });
    if (url.endsWith('/disconnect')) { h.chat.connected = false; h.chat.channel = ''; h.chat.messages = []; }
    if (url.endsWith('/channel') && body.channel === 'next_channel') return new Promise(resolve => {
      releaseChannel = () => resolve(channelResponse(body.channel));
    });
    if (url.endsWith('/connect')) { h.chat.connected = true; h.chat.channel = body.channel; }
    return null;
  });
  const refreshing = h.send({ type: 'getState' }); await h.flush();
  assert.ok(releaseStatus);
  await w.update('https://www.twitch.tv/next_channel?referrer=raid');
  assert.ok(releaseChannel, 'alignment is pending and the settings revision has not changed yet');
  releaseStatus(); const state = await refreshing;
  assert.equal(state.chat.connected, false);
  assert.equal(state.chat.channel, ''); assert.deepEqual(state.chat.messages, []);
  assert.equal(state.settings.allowedChannel, 'test_channel');
  releaseChannel(); await h.flush();
  const completed = await h.send({ type: 'getState' });
  assert.equal(completed.settings.allowedChannel, 'next_channel');
  assert.equal(completed.chat.channel, 'next_channel');
  assert.equal(completed.watch.syncStatus, 'aligned');
});

test('Pause before helper submission records a cancelled attempt rather than uncertain delivery', async t => {
  const h = await harness(t);
  const originalSet = h.local.set.bind(h.local); let release, held = false;
  h.local.set = async value => {
    if (!held && value.sent?.some(x => x.delivery === 'pending')) {
      held = true; await new Promise(resolve => { release = resolve; });
    }
    return originalSet(value);
  };
  const sending = h.send({ type: 'send', text: 'hello' }); await h.flush();
  assert.ok(release, 'the local intent is waiting to persist');
  await h.send({ type: 'pause' });
  release(); assert.match((await sending).error, /Setup changed/); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.equal(h.local.data.sent[0].delivery, 'cancelled');
  assert.match(h.local.data.sent[0].reason, /Setup changed/);
});


test('participation greets automatically without incoming chat and persists its intent', async t => {
  const h = await harness(t); await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate' } });
  await h.send({ type: 'getState' }); await h.flush();
  const sends = h.calls.filter(c => c.url.endsWith('/send'));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.kind, 'greeting'); assert.equal(sends[0].body.replyTo, '');
  assert.ok(sends[0].body.participationKey); assert.equal(sends[0].body.streamId, '987654321');
  assert.equal(h.local.data.participationAttempts[0].delivery, 'confirmed');
  assert.equal(h.local.data.participationAttempts[0].submitted, true);
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});

test('a shared suppression keeps the contribution retryable without consuming budgets or claiming delivery', async t => {
  const h = await harness(t); await tracked(h);
  h.chat.coordination = { textKeys: [], topicStreams: [], replyIds: [], accounts: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/send')) {
      h.calls.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ delivery: 'cancelled', submitted: false, suppressed: true, reason: 'A companion already contributed this wording.' }) };
    }
    return originalFetch(url, options);
  };
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate' } });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(x => x.url.endsWith('/send')).length, 1);
  assert.deepEqual(h.local.data.sent, []);
  assert.equal(h.local.data.participationAttempts[0].delivery, 'cancelled');
  assert.equal(h.local.data.participationAttempts[0].submitted, false);
  const state = await h.send({ type: 'getState' });
  assert.notEqual(state.activity.state, 'sent');
  await h.flush();
});

test('a registered companion mention does not trigger automatic reply generation or sending', async t => {
  const h = await harness(t);
  h.chat.coordination = { accounts: ['other_companion'], textKeys: [], topicStreams: [], replyIds: [] };
  h.chat.messages = [{ id: 'companion-mention', author: 'other_companion', text: '@qumaris_2489 hello', at: Date.now() }];
  await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { autoReply: true } });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(x => x.url.endsWith('/send') || x.url.endsWith('/compose')).length, 0);
});

test('central host outage holds generation and forwards fresh playback without consuming send budget', async t => {
  const h = await harness(t); await tracked(h);
  h.chat.coordination = { available: false, reason: 'Central host is unavailable; waiting.', accounts: [], textKeys: [], topicStreams: [], replyIds: [] };
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate' } });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(x => x.url.endsWith('/send') || x.url.endsWith('/compose')).length, 0);
  assert.equal((h.local.data.sent || []).length, 0);
  const forwarded = h.calls.filter(x => x.url.endsWith('/status')).at(-1).body.observation;
  assert.equal(forwarded.channel, 'test_channel'); assert.equal(forwarded.autoReply, true);
  assert.equal(forwarded.playback.enabled, true); assert.ok(Number.isFinite(forwarded.playback.checkedAt));
  h.chat.coordination.available = true;
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(x => x.url.endsWith('/send')).length, 1);
});

test('a transient central hold retries the same fresh target once using its already prepared AI draft', async t => {
  const h = await harness(t); let generations = 0, submissions = 0;
  h.override(url => {
    if (url.endsWith('/compose')) { generations++; return { ok: true, json: async () => ({ text: 'prepared reply for this target', category: 'greeting' }) }; }
    if (url.endsWith('/send')) {
      submissions++; return { ok: true, json: async () => submissions === 1
        ? { delivery: 'cancelled', suppressed: true, submitted: false, code: 'busy', retryable: true, reason: 'Another companion has this turn.' }
        : { delivery: 'confirmed', submitted: true, messageId: 'one-live-reply' } };
    }
  });
  await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { replySource: 'ai', autoReply: true } });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(submissions, 1); assert.equal(generations, 1); assert.equal(h.local.data.sent.length, 0);
  assert.equal(h.local.data.handled.includes('qumaris_2489:test_channel:incoming'), false);
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(submissions, 2); assert.equal(generations, 1);
  const attempts = h.calls.filter(x => x.url.endsWith('/send'));
  assert.equal(attempts[0].body.text, attempts[1].body.text); assert.equal(attempts[1].body.replyTo, 'incoming');
  assert.equal(h.local.data.sent.filter(x => x.delivery === 'confirmed').length, 1);
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(submissions, 2);
});

test('permanent shared duplicate suppression keeps the fresh target handled', async t => {
  const h = await harness(t); let generations = 0, submissions = 0;
  h.override(url => {
    if (url.endsWith('/compose')) { generations++; return { ok: true, json: async () => ({ text: 'already covered reply', category: 'greeting' }) }; }
    if (url.endsWith('/send')) { submissions++; return { ok: true, json: async () => ({ delivery: 'cancelled', submitted: false, suppressed: true, retryable: false, code: 'duplicate', reason: 'Already covered.' }) }; }
  });
  await h.send({ type: 'getState' }); await h.send({ type: 'saveSettings', settings: { replySource: 'ai', autoReply: true } });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.local.data.handled.includes('qumaris_2489:test_channel:incoming'), true);
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(generations, 1); assert.equal(submissions, 1); assert.equal(h.local.data.sent.length, 0);
});

test('unknown provider outcome never releases a handled target or reuses its draft for retry', async t => {
  const h = await harness(t); let generations = 0, submissions = 0;
  h.override(url => {
    if (url.endsWith('/compose')) { generations++; return { ok: true, json: async () => ({ text: 'one uncertain reply', category: 'greeting' }) }; }
    if (url.endsWith('/send')) { submissions++; return { ok: true, json: async () => ({ delivery: 'unknown', submitted: false, reason: 'Provider result unavailable.' }) }; }
  });
  await h.send({ type: 'getState' }); await h.send({ type: 'saveSettings', settings: { replySource: 'ai', autoReply: true } });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.local.data.sent[0].delivery, 'unknown');
  h.local.data.sent = []; // Even without the global cooldown, uncertainty stays consumed.
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.local.data.handled.includes('qumaris_2489:test_channel:incoming'), true);
  assert.equal(generations, 1); assert.equal(submissions, 1);
});

test('a settings revision invalidates a held prepared draft before the fresh target retries', async t => {
  const h = await harness(t); let generations = 0, submissions = 0;
  h.override(url => {
    if (url.endsWith('/compose')) { generations++; return { ok: true, json: async () => ({ text: 'AI draft that must not survive settings change', category: 'greeting' }) }; }
    if (url.endsWith('/send')) { submissions++; return { ok: true, json: async () => submissions === 1
      ? { delivery: 'cancelled', suppressed: true, submitted: false, retryable: true, code: 'turn_wait', reason: 'Wait for turn.' }
      : { delivery: 'confirmed', submitted: true, messageId: 'new-local-reply' } }; }
  });
  await h.send({ type: 'getState' }); await h.send({ type: 'saveSettings', settings: { replySource: 'ai', autoReply: true } });
  await h.send({ type: 'getState' }); await h.flush();
  await h.send({ type: 'saveSettings', settings: { replySource: 'local' } });
  await h.send({ type: 'getState' }); await h.flush();
  const attempts = h.calls.filter(x => x.url.endsWith('/send'));
  assert.equal(generations, 1); assert.equal(submissions, 2);
  assert.notEqual(attempts[1].body.text, attempts[0].body.text);
  assert.equal(h.local.data.sent.at(-1).delivery, 'confirmed');
});

test('participation cannot send without playback tracking or while the player is paused', async t => {
  const h = await harness(t); h.chat.messages = []; await h.send({ type: 'getState' });
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate' } });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.match((await h.send({ type: 'getState' })).activity.reason, /Watch on Twitch/);
  await tracked(h); h.local.data.watchSession.status = 'paused'; h.local.data.watchSession.checkedAt = Date.now();
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('Pause cancels a greeting while its durable intent is being saved', async t => {
  const h = await harness(t); await tracked(h);
  const originalSet = h.local.set.bind(h.local); let release, held = false;
  h.local.set = async value => {
    if (!held && value.participationAttempts?.some(x => x.delivery === 'pending')) {
      held = true; await new Promise(resolve => { release = resolve; });
    }
    return originalSet(value);
  };
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate' } });
  await h.send({ type: 'getState' }); await h.flush(); assert.ok(release);
  await h.send({ type: 'pause' }); release(); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.equal(h.local.data.participationAttempts[0].delivery, 'cancelled');
  assert.equal(h.local.data.participationAttempts[0].submitted, false);
  assert.equal(h.local.data.settings.autoReply, false);
});

test('an uncertain greeting is not repeated after startup and the hourly history clears', async t => {
  const h = await harness(t); await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true, autoResume: true, chatMode: 'participate' } });
  await h.send({ type: 'getState' }); await h.flush();
  const entry = h.local.data.participationAttempts[0];
  entry.delivery = 'pending'; entry.at = Date.now() - 3600001;
  h.local.data.participationAttempts.push({ ...entry, key: entry.key.replace(/greeting$/, 'topic'), kind: 'topic', delivery: 'unknown' });
  h.local.data.sent = [];
  await h.chrome.runtime.onStartup.handlers[0](); await h.flush();
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.local.data.settings.chatMode, 'participate');
  assert.equal(h.local.data.participationAttempts[0].delivery, 'pending');
  assert.equal(h.calls.filter(c => c.url.endsWith('/send') && c.body.kind === 'greeting').length, 1);
});

test('automatic channel navigation resets participation to mention-only', async t => {
  const h = await harness(t), w = await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true, autoResume: true, chatMode: 'participate' } });
  await w.update('https://www.twitch.tv/next_channel');
  assert.equal((await h.send({ type: 'getState' })).settings.chatMode, 'mentions');
  assert.equal(h.calls.filter(c => c.url.endsWith('/send') && c.body.channel === 'next_channel').length, 0);
});

test('a newly received direct mention takes priority over the prepared greeting', async t => {
  const h = await harness(t); await tracked(h); let polls = 0;
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate' } });
  h.override(url => {
    if (url.endsWith('/status')) {
      polls++;
      if (polls >= 2) h.chat.messages = [{ id: 'fresh-priority', author: 'alice', text: '@qumaris_2489 hello', at: Date.now() }];
    }
    return null;
  });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  await h.send({ type: 'getState' }); await h.flush();
  const sends = h.calls.filter(c => c.url.endsWith('/send'));
  assert.equal(sends.length, 1); assert.equal(sends[0].body.replyTo, 'fresh-priority');
  assert.equal(sends[0].body.kind, undefined);
});


test('simple start cannot arm after another control changes the setup revision', async t => {
  const h = await harness(t);
  await h.send({ type: 'getState' });
  const revision = h.local.data.settings.revision;
  await h.send({ type: 'saveSettings', settings: { replySource: 'ai' } });
  const result = await h.send({ type: 'saveSettings', expectedRevision: revision, settings: { chatMode: 'participate', autoReply: true, autoResume: true } });
  assert.match(result.error, /Setup changed/);
  assert.equal(h.local.data.settings.autoReply, false);
});
