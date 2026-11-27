import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LocalControl } from '../lib/local-control.mjs';
import { createHash } from 'node:crypto';
import { messageKey } from '../extension/message-policy.js';

const event = () => ({ handlers: [], addListener(fn) { this.handlers.push(fn); } });
function storage() {
  const data = {};
  return { data, async get(keys) { if (keys == null) return structuredClone(data); const out = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = structuredClone(data[k]); return out; }, async set(value) { Object.assign(data, structuredClone(value)); }, async clear() { for (const key of Object.keys(data)) delete data[key]; }, async setAccessLevel() {} };
}
let sequence = 0;
async function harness(t, { inactive = false } = {}) {
  const savedChrome = globalThis.chrome, savedFetch = globalThis.fetch;
  const local = storage(), session = storage(), calls = [];
  const chrome = { storage: { local, session }, tabs: { onUpdated: event(), onRemoved: event() }, runtime: { id: 'unit-test', onInstalled: event(), onStartup: event(), onMessage: event() }, sidePanel: { async setPanelBehavior() {} }, alarms: { onAlarm: event(), async create() {}, async clearAll() {} } };
  const chat = { connected: true, account: 'qumaris_2489', channel: 'test_channel', messages: [{ id: 'incoming', author: 'alice', text: '@qumaris_2489 hello', at: Date.now() }] };
  if (inactive) {
    chat.connected = false;
    local.data.settings = { schemaVersion: 8, revision: 3, account: 'qumaris_2489', allowedChannel: 'test_channel', pairingToken: 'local-test',
      paused: true, autoReply: false, autoResume: false, chatMode: 'participate', replySource: 'local' };
    local.data.sent = [{ account: 'qumaris_2489', channel: 'test_channel', at: Date.now() - 7_200_000, text: 'old uncertain text', delivery: 'unknown' }];
    local.data.participationAttempts = [{ account: 'qumaris_2489', channel: 'test_channel', streamId: '987654321', kind: 'greeting',
      key: 'participation:qumaris_2489:test_channel:987654321:greeting', at: Date.now() - 7_200_000, delivery: 'unknown', submitted: true }];
    local.data.handled = ['qumaris_2489:test_channel:no-match'];
  }
  let fetchOverride, centralOffer = null, centralPaused = false, centralReady = true, planSequence = 0;
  const control = new LocalControl({ twitch: { status: () => ({ ...chat, sent: local.data.sent || [] }),
    disconnect() { chat.connected = false; chat.channel = ''; chat.messages = []; } } });
  const makePlan = (body, value) => ({ planId: value.planId || `plan-${++planSequence}`, authorityEpoch: 'fixture-authority', clientId: 'primary',
    account: local.data.settings.account, channel: local.data.settings.allowedChannel,
    streamId: value.source === 'manual' ? '' : '987654321', kind: '', participationKey: '', opportunityKey: 'fixture-opportunity',
    textKey: messageKey(value.text), exactKey: createHash('sha256').update(value.text).digest('hex'), category: 'greeting', source: 'automatic',
    replyId: '', replyAuthor: '', replyAt: 0, bankRevision: 1, profileRevision: 1, notBefore: Date.now() - 1, expiresAt: Date.now() + 20000,
    binding: { generation: body.controlGeneration, sessionId: body.controlSessionId, settingsRevision: body.settingsRevision }, ...value });
  const director = (body, plan) => ({ protocol: 1, ready: centralReady && !centralPaused, reason: centralPaused ? 'Central coordination paused.' : '',
    authorityEpoch: 'fixture-authority', bankRevision: 1, profile: { id: 'primary', revision: 1,
      chatMode: local.data.settings.chatMode, replySource: local.data.settings.replySource }, ...(plan ? { plan } : {}) });
  globalThis.chrome = chrome;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    const custom = await fetchOverride?.(url, options); if (custom) return custom;
    const body = JSON.parse(options.body), json = value => ({ ok: true, json: async () => value });
    if (url.endsWith('/api/control/bridge')) return json(control.bridge(body));
    if (url.endsWith('/api/director/import')) return json({ ok: true, source: body.page.source, importId: body.page.importId,
      page: body.page.page, digest: body.page.digest, nextPage: body.page.page + 1, complete: body.page.final });
    if (url.endsWith('/api/director/preferences')) return json({ ok: true });
    if (url.endsWith('/api/director/sync')) {
      const value = typeof centralOffer === 'function' ? centralOffer(body) : centralOffer;
      return json({ ok: true, director: director(body, value ? makePlan(body, value) : null) });
    }
    if (url.endsWith('/api/director/draft')) return json({ ok: true, director: director(body), draft: { text: body.mode === 'summary' ? '' : 'central draft',
      ...(body.mode === 'summary' ? { summary: 'Central chat summary.' } : {}), category: body.category || 'greeting', reason: 'Central reviewed draft.' } });
    if (url.endsWith('/api/director/manual')) { const plan = makePlan(body, { text: body.text, source: 'manual' }); return json({ ok: true, plan, director: director(body, plan) }); }
    if (url.endsWith('/api/twitch/channel')) return json({ channel: body.channel, checkedAt: Date.now(), canReply: true,
      streamContext: { channel: body.channel, streamId: '987654321', gameName: 'Minecraft', title: 'A stream', isLive: true, checkedAt: Date.now() } });
    if (url.endsWith('/disconnect')) { chat.connected = false; chat.channel = ''; chat.messages = []; return json({ ok: true }); }
    if (url.endsWith('/status')) return { ok: true, json: async () => structuredClone(chat) };
    if (url.endsWith('/send')) return { ok: true, json: async () => ({ submitted: true, delivery: 'confirmed', messageId: 'api-id' }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  await import(`../extension/background.js?test=${++sequence}`);
  t.after(() => { globalThis.chrome = savedChrome; globalThis.fetch = savedFetch; });
  const panel = { id: chrome.runtime.id, url: `chrome-extension://${chrome.runtime.id}/panel.html` };
  const send = (message, sender = panel) => new Promise(resolve => chrome.runtime.onMessage.handlers[0](message, sender, resolve));
  if (!inactive) await send({ type: 'saveSettings', settings: { account: 'qumaris_2489', allowedChannel: 'test_channel', pairingToken: 'local-test', paused: false } });
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
  await send({ type: 'getState' }); await flush();
  return { chrome, local, session, chat, calls, panel, send, flush, control,
    offer: value => { centralOffer = value && { planId: `automatic-${++planSequence}`, ...value }; },
    central: values => { if ('paused' in values) centralPaused = values.paused; if ('ready' in values) centralReady = values.ready; },
    override: fn => { fetchOverride = fn; } };
}

async function hostedHarness(t, { access = true, offline = false, windowId = 1 } = {}) {
  const h = await harness(t), opened = [], focused = [];
  let tab = { id: 70, windowId, url: 'https://www.twitch.tv/test_channel', status: 'complete' }, clock = 1, connectHook;
  h.chat.messages = []; h.chat.authorized = true;
  h.chrome.permissions = { contains: async () => access, getAll: async () => ({ permissions: access ? ['scripting'] : [], origins: access ? ['https://www.twitch.tv/*'] : [] }), request() { throw Error('A queued command must never request browser access.'); } };
  Object.assign(h.chrome.tabs, { create: async options => { opened.push(options); tab = { ...tab, url: options.url }; return { ...tab }; },
    get: async () => ({ ...tab }), update: async (id, options) => { focused.push({ id, options }); return { ...tab }; } });
  h.chrome.windows = { update: async (id, options) => { focused.push({ windowId: id, options }); } };
  h.chrome.scripting = { executeScript: async () => [{ frameId: 0, documentId: 'control-doc', result: { url: tab.url, videoId: 'v1', hasVideo: true, currentTime: clock++, readyState: 4, paused: false } }] };
  const twitch = { status: () => ({ ...h.chat, authorized: true, sent: h.local.data.sent || [] }), disconnect() { h.chat.connected = false; h.chat.channel = ''; h.chat.messages = []; } };
  const control = h.control; control.twitch = twitch;
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
  assert.deepEqual(m.host_permissions, ['http://127.0.0.1:8793/*']);
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


test('manual send preserves casual wording through the official API and enforces cooldown', async t => {
  const h = await harness(t);
  const result = await h.send({ type: 'send', text: 'hello' });
  assert.equal(result.delivery, 'confirmed'); assert.equal(result.messageId, 'api-id');
  assert.equal(h.local.data.sent[0].text, 'hello');
  assert.equal(h.local.data.sent[0].delivery, 'confirmed');
  assert.match((await h.send({ type: 'send', text: 'hey' })).error, /cooldown/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});




test('failed API submission consumes its budget and does not retry uncertain delivery', async t => {
  const h = await harness(t);
  h.override(url => { if (url.endsWith('/send')) throw new Error('lost response'); });
  assert.match((await h.send({ type: 'send', text: 'hello' })).error, /lost response/);
  assert.equal(h.local.data.sent[0].delivery, 'unknown');
  assert.match((await h.send({ type: 'send', text: 'hello' })).error, /cooldown/);
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
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
  h.chrome.scripting = { executeScript: async () => [{ frameId: 0, documentId: 'doc', result: { url: tab.url, videoId: 'v1', hasVideo: true, currentTime: clock++, readyState: 4, paused: false } }] };
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
  h.offer({ ...offer, kind: 'exchange', participationKey: offer.key, exchangeId: offer.id, opportunityKey: offer.key, text: offer.text, planId: offer.id });
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



test('expired offers, paused host, mention-only mode and incomplete authority hold exchanges', async t => {
  const { h, offer } = await exchangeReady(t);
  const poll = async () => { await h.send({ type: 'getState' }); await h.flush(); };
  offer.expiresAt = Date.now() - 1; h.offer({ ...offer, kind: 'exchange', participationKey: offer.key, exchangeId: offer.id }); await poll();
  offer.expiresAt = Date.now() + 20_000; h.offer({ ...offer, kind: 'exchange', participationKey: offer.key, exchangeId: offer.id }); h.chat.coordination.paused = true; await poll();
  h.chat.coordination.paused = false;
  await h.send({ type: 'saveSettings', settings: { chatMode: 'mentions' } }); await poll();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  await h.send({ type: 'saveSettings', settings: { chatMode: 'participate' } });
  h.central({ ready: false });
  await poll();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
});

test('exchange text changes during final refresh cancel the prepared line', async t => {
  const { h, offer } = await exchangeReady(t); let polls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/api/director/sync') && ++polls === 2) h.offer({ ...offer, kind: 'exchange', participationKey: offer.key, exchangeId: offer.id, text: '@other_companion a changed line.' });
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
  const replyAt = Date.now();
  h.offer({ text: 'central reply', replyId: 'paused-mention', replyAuthor: 'alice', replyAt });
  h.chat.messages = [{ id: 'paused-mention', author: 'alice', text: '@qumaris_2489 hello', at: replyAt }];
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.match((await h.send({ type: 'getState' })).activity.reason, /playback: paused/);
  h.local.data.watchSession.status = 'playing';
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 1);
});

const channelResponse = channel => ({ ok: true, json: async () => ({ channel, checkedAt: Date.now(), canReply: true,
  streamContext: { channel, streamId: '987654321', gameName: 'Minecraft', title: 'A stream', isLive: true, checkedAt: Date.now() } }) });

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
  release(); assert.match((await sending).error, /Setup changed|Central message cancelled/); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.equal(h.local.data.sent[0].delivery, 'cancelled');
  assert.match(h.local.data.sent[0].reason, /Setup changed|Central message cancelled/);
});


test('participation greets automatically without incoming chat and persists its intent', async t => {
  const h = await harness(t); await tracked(h);
  h.offer({ text: 'central greeting', kind: 'greeting', participationKey: 'participation:qumaris_2489:test_channel:987654321:greeting' });
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
  h.offer({ text: 'central greeting', kind: 'greeting', participationKey: 'participation:qumaris_2489:test_channel:987654321:greeting' });
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
  h.offer({ text: 'central greeting', kind: 'greeting', participationKey: 'participation:qumaris_2489:test_channel:987654321:greeting' });
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





test('participation cannot send without playback tracking or while the player is paused', async t => {
  const h = await harness(t); h.chat.messages = []; await h.send({ type: 'getState' });
  h.offer({ text: 'central greeting', kind: 'greeting', participationKey: 'participation:qumaris_2489:test_channel:987654321:greeting' });
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate' } });
  await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.filter(c => c.url.endsWith('/send')).length, 0);
  assert.match((await h.send({ type: 'getState' })).activity.reason, /Watch on Twitch/);
  h.offer(null); await tracked(h); h.local.data.watchSession.status = 'paused'; h.local.data.watchSession.checkedAt = Date.now();
  h.offer({ text: 'central greeting', kind: 'greeting', participationKey: 'participation:qumaris_2489:test_channel:987654321:greeting' });
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
  h.offer({ text: 'central greeting', kind: 'greeting', participationKey: 'participation:qumaris_2489:test_channel:987654321:greeting' });
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
  h.offer({ text: 'central greeting', kind: 'greeting', participationKey: 'participation:qumaris_2489:test_channel:987654321:greeting' });
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


test('simple start cannot arm after another control changes the setup revision', async t => {
  const h = await harness(t);
  await h.send({ type: 'getState' });
  const revision = h.local.data.settings.revision;
  await h.send({ type: 'saveSettings', settings: { replySource: 'ai' } });
  const result = await h.send({ type: 'saveSettings', expectedRevision: revision, settings: { chatMode: 'participate', autoReply: true, autoResume: true } });
  assert.match(result.error, /Setup changed/);
  assert.equal(h.local.data.settings.autoReply, false);
});

// Message selection, target priority and no-match consumption now belong to the
// host director suites. These checks exercise the browser's command boundary.
test('a stopped disconnected worker imports old browser ledgers without connecting or arming', async t => {
  const h = await harness(t, { inactive: true }); await h.flush();
  const pages = h.calls.filter(x => x.url.endsWith('/api/director/import')).map(x => x.body.page);
  assert.ok(pages.length > 0, 'Reload must import while inactive');
  const records = pages.flatMap(x => x.records);
  assert.ok(records.some(x => x.type === 'history' && x.text === 'old uncertain text'));
  assert.ok(records.some(x => x.type === 'participation' && x.participationKey.endsWith(':greeting')));
  assert.ok(records.some(x => x.type === 'handled' && x.key.endsWith(':no-match')));
  assert.equal(h.local.data.directorImport.complete, true);
  assert.equal(h.local.data.settings.paused, true); assert.equal(h.local.data.settings.autoReply, false);
  assert.equal(h.calls.some(x => x.url.endsWith('/connect') || x.url.endsWith('/send')), false);
});

test('an available central controller with no offer never invokes a local message planner', async t => {
  const h = await harness(t); await tracked(h);
  await h.send({ type: 'saveSettings', settings: { autoReply: true, chatMode: 'participate', replySource: 'ai' } });
  h.chat.messages = [{ id: 'fresh-human', author: 'alice', text: '@qumaris_2489 hello', at: Date.now() }];
  await h.send({ type: 'getState' }); await h.flush();
  assert.ok(h.calls.some(x => x.url.endsWith('/api/director/sync')));
  assert.equal(h.calls.some(x => x.url.endsWith('/send') || x.url.endsWith('/api/compose')), false);
  assert.deepEqual(h.local.data.sent || [], []);
});

test('manual previews and summaries come from central draft routes without browser-echoed chat', async t => {
  const h = await harness(t);
  assert.equal((await h.send({ type: 'pickPhrase', category: 'greeting' })).text, 'central draft');
  assert.equal((await h.send({ type: 'compose', mode: 'summary' })).summary, 'Central chat summary.');
  const drafts = h.calls.filter(x => x.url.endsWith('/api/director/draft'));
  assert.deepEqual(drafts.map(x => x.body.mode), ['phrase', 'summary']);
  assert.ok(drafts.every(x => !('messages' in x.body) && !('target' in x.body) && !('recentReplies' in x.body)));
  assert.equal(h.calls.some(x => x.url.endsWith('/send') || x.url.endsWith('/api/compose')), false);
});

test('controller outage holds manual phrase previews without a local fallback', async t => {
  const h = await harness(t); h.override(() => { throw Error('controller offline'); });
  const result = await h.send({ type: 'pickPhrase', category: 'greeting' });
  assert.match(result.error, /offline/); assert.equal(result.text, undefined);
  assert.equal(h.calls.some(x => x.url.endsWith('/send')), false);
});

test('an exact central mention offer reaches the helper with all plan bindings unchanged', async t => {
  const h = await harness(t); await tracked(h);
  const at = Date.now(); h.chat.messages = [{ id: 'central-target', author: 'alice', text: '@qumaris_2489 hello', at }];
  h.offer({ text: 'host-selected wording', replyId: 'central-target', replyAuthor: 'alice', replyAt: at });
  await h.send({ type: 'saveSettings', settings: { autoReply: true } }); await h.send({ type: 'getState' }); await h.flush();
  const sends = h.calls.filter(x => x.url.endsWith('/send'));
  assert.equal(sends.length, 1); assert.equal(sends[0].body.text, 'host-selected wording');
  assert.equal(sends[0].body.replyTo, 'central-target'); assert.equal(sends[0].body.replyAuthor, 'alice');
  assert.equal(sends[0].body.authorityEpoch, 'fixture-authority'); assert.ok(sends[0].body.planId);
  assert.equal(sends[0].body.binding.generation, sends[0].body.controlGeneration);
  assert.equal(sends[0].body.binding.sessionId, sends[0].body.controlSessionId);
  assert.equal(sends[0].body.binding.settingsRevision, sends[0].body.settingsRevision);
  assert.equal(h.calls.some(x => x.url.endsWith('/api/compose')), false);
});

test('a central offer with altered exact-text hash is rejected before the helper send boundary', async t => {
  const h = await harness(t); await tracked(h);
  h.offer({ text: 'altered wording', exactKey: 'f'.repeat(64) });
  await h.send({ type: 'saveSettings', settings: { autoReply: true } }); await h.send({ type: 'getState' }); await h.flush();
  assert.equal(h.calls.some(x => x.url.endsWith('/send')), false);
  assert.equal((h.local.data.sent || []).length, 0);
});

test('Pause fences a slow central decision without generating or sending locally', async t => {
  const h = await harness(t); await tracked(h); let release;
  await h.send({ type: 'saveSettings', settings: { autoReply: true } });
  h.override((url, options) => {
    if (!url.endsWith('/api/director/sync')) return null;
    const body = JSON.parse(options.body);
    return new Promise(resolve => { release = () => resolve({ ok: true, json: async () => ({ ok: true, director: {
      protocol: 1, ready: true, authorityEpoch: 'fixture-authority', bankRevision: 1,
      profile: { id: 'primary', chatMode: 'mentions', replySource: 'local', revision: 1 },
      plan: { text: 'late decision', binding: { generation: body.controlGeneration, sessionId: body.controlSessionId, settingsRevision: body.settingsRevision } }
    } }) }); });
  });
  const pending = h.send({ type: 'getState' }); await h.flush(); assert.ok(release);
  await h.send({ type: 'pause' }); release(); await pending; await h.flush();
  assert.equal(h.local.data.settings.paused, true); assert.equal(h.local.data.settings.autoReply, false);
  assert.equal(h.calls.some(x => x.url.endsWith('/send') || x.url.endsWith('/api/compose')), false);
});
