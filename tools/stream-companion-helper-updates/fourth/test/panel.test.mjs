import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

test('installed controls retain draft previews and disconnected send gating', async t => {
  const html = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://unit-test/panel.html' });
  const saved = { document: globalThis.document, chrome: globalThis.chrome, interval: globalThis.setInterval };
  const settings = { account: 'companion_test', allowedChannel: 'friend_channel', pairingToken: 'paired-test', replySource: 'local', clientId: '', paused: true, autoReply: false };
  const messages = [];
  globalThis.document = dom.window.document;
  globalThis.setInterval = () => 0;
  globalThis.chrome = { runtime: { async sendMessage(message) {
    messages.push(message);
    if (message.type === 'getState') return { settings: { ...settings }, chat: { connected: false, messages: [], digest: { messages: 0, people: 0, topics: [] } }, sent: [] };
    if (message.type === 'saveSettings') { Object.assign(settings, message.settings); return { ok: true }; }
    if (message.type === 'pickPhrase') return { text: 'hello there', source: 'local' };
    if (message.type === 'authorize') return { error: 'Enter your Twitch developer app Client ID.' };
    throw new Error('Unexpected panel action');
  } } };
  t.after(() => { globalThis.document = saved.document; globalThis.chrome = saved.chrome; globalThis.setInterval = saved.interval; dom.window.close(); });
  await import(`../extension/panel.js?test=${Date.now()}`);
  const doc = dom.window.document;
  const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
  assert.equal(doc.getElementById('connection').textContent, 'Paused');
  assert.equal(doc.getElementById('watchEnabled'), null); assert.equal(doc.getElementById('nextStream'), null);
  doc.getElementById('pause').click(); await flush();
  assert.equal(doc.getElementById('connection').textContent, 'Draft mode · chat disconnected');
  assert.equal(settings.autoReply, false);
  doc.getElementById('pickPhrase').click(); await flush();
  assert.equal(doc.getElementById('draft').value, 'hello there');
  assert.equal(doc.getElementById('messagePreview').textContent, 'hello there');
  assert.equal(doc.getElementById('send').disabled, true);
  doc.getElementById('authorize').click(); await flush();
  assert.match(doc.getElementById('status').textContent, /Client ID/);
  assert.equal(messages.filter(m => m.type === 'send').length, 0);
});

test('overview exposes confirmed delivery, current no-send reason and stale playback while preserving edits', async t => {
  const html = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://unit-test/panel.html' });
  const saved = { document: globalThis.document, chrome: globalThis.chrome, interval: globalThis.setInterval };
  const now = Date.now(), calls = [];
  let tick;
  const state = {
    settings: { account: 'companion_test', allowedChannel: 'friend_channel', replySource: 'local', paused: false, autoReply: true, autoResume: true },
    chat: { connected: true, account: 'companion_test', channel: 'friend_channel', messages: [], digest: { messages: 5, people: 2, topics: [] } },
    sent: [{ at: now - 250_000, channel: 'friend_channel', text: 'the confirmed reply', delivery: 'confirmed' }, { at: now - 1000, channel: 'friend_channel', text: 'unknown reply', delivery: 'unknown' }],
    watch: { enabled: true, channel: 'friend_channel', status: 'playing', checkedAt: now - 60_000 },
    lastError: { at: now - 86400_000, message: 'old connection failure' },
    drops: { enabled: true, status: 'No earned rewards.' },
    permissions: { permissions: [], origins: [] }
  };
  globalThis.document = dom.window.document;
  globalThis.setInterval = fn => { tick = fn; return 0; };
  globalThis.chrome = {
    permissions: { request(access) { calls.push({ type: 'permission', access }); return Promise.resolve(true); } },
    runtime: { async sendMessage(message) {
      calls.push(message);
      if (message.type === 'getState') return structuredClone(state);
      if (message.type === 'openTwitch') return { ok: true };
      if (message.type === 'stopWatching') { state.watch.enabled = false; return { ok: true }; }
      throw new Error('Unexpected panel action');
    } }
  };
  t.after(() => { globalThis.document = saved.document; globalThis.chrome = saved.chrome; globalThis.setInterval = saved.interval; dom.window.close(); });
  await import(`../extension/panel.js?activity-test=${Date.now()}`);
  const doc = dom.window.document, $ = id => doc.getElementById(id);
  const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
  assert.equal($('latestReplyText').textContent, 'the confirmed reply');
  assert.match($('latestReplyMeta').textContent, /friend_channel.*Twitch confirmed/);
  assert.match($('latestAttemptState').textContent, /uncertain/);
  assert.equal($('replyActivity').textContent, 'Cooldown');
  assert.equal($('playbackStatus').textContent, 'Check overdue');
  assert.match($('lastError').textContent, /^Earlier issue/);
  assert.equal(doc.querySelector('.drops-section details').open, false);
  assert.equal($('dropsBadge').textContent, 'On');
  $('allowedChannel').value = 'my_unsaved_edit';
  state.settings.allowedChannel = 'raid_destination';
  tick(); await flush();
  assert.equal($('allowedChannel').value, 'my_unsaved_edit');
  $('openTwitch').click(); await flush();
  assert.ok(calls.findIndex(x => x.type === 'permission') < calls.findIndex(x => x.type === 'openTwitch'));
  $('stopWatching').click(); await flush();
  assert.equal($('playbackStatus').textContent, 'Checks off');
  assert.equal($('stopWatching').disabled, true);
  assert.equal(calls.filter(x => x.type === 'send').length, 0);
});

test('chat mode defaults to mentions, saves participation while connected and preserves an edited draft', async t => {
  const html = await readFile(new URL('../extension/panel.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'chrome-extension://unit-test/panel.html' });
  const saved = { document: globalThis.document, chrome: globalThis.chrome, interval: globalThis.setInterval };
  const now = Date.now(), calls = [];
  let tick;
  const state = {
    settings: { account: 'companion_test', allowedChannel: 'friend_channel', replySource: 'local', paused: false, autoReply: true, autoResume: true },
    chat: { connected: true, account: 'companion_test', channel: 'friend_channel', messages: [], digest: { messages: 0, people: 0, topics: [] } },
    sent: [], watch: { enabled: true, channel: 'friend_channel', status: 'playing', checkedAt: now }, drops: { enabled: false }
  };
  globalThis.document = dom.window.document;
  globalThis.setInterval = fn => { tick = fn; return 0; };
  globalThis.chrome = { runtime: { async sendMessage(message) {
    calls.push(message);
    if (message.type === 'getState') return structuredClone(state);
    if (message.type === 'saveSettings') { Object.assign(state.settings, message.settings); return { ok: true }; }
    if (message.type === 'pause') { Object.assign(state.settings, { paused: true, autoReply: false, autoResume: false }); state.watch.enabled = false; state.chat.connected = false; return { ok: true }; }
    throw new Error('Unexpected panel action');
  } } };
  t.after(() => { globalThis.document = saved.document; globalThis.chrome = saved.chrome; globalThis.setInterval = saved.interval; dom.window.close(); });
  await import(`../extension/panel.js?participation-test=${Date.now()}`);
  const $ = id => dom.window.document.getElementById(id);
  const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(resolve => setImmediate(resolve)); };
  assert.equal($('chatMode').value, 'mentions');
  assert.equal($('chatMode').disabled, false);
  assert.match($('autoReply').parentElement.textContent, /Automatic chat/);
  assert.equal($('replyActivity').textContent, 'Waiting for a direct mention');
  $('chatMode').value = 'participate'; $('chatMode').dispatchEvent(new dom.window.Event('change'));
  assert.match($('chatModeHelp').textContent, /without an @mention/);
  $('save').click(); await flush();
  assert.equal(state.settings.chatMode, 'participate');
  assert.equal(calls.find(x => x.type === 'saveSettings').settings.autoReply, true);
  assert.equal($('replyActivity').textContent, 'Joining the conversation');
  assert.match($('connection').textContent, /joining the conversation/);
  assert.equal($('dropsBadge').textContent, 'Off');
  state.settings.chatMode = 'mentions'; tick(); await flush();
  assert.equal($('chatMode').value, 'mentions', 'saved mode resets from another panel are reflected');
  $('chatMode').value = 'participate'; tick(); await flush();
  assert.equal($('chatMode').value, 'participate', 'a local unsaved edit is preserved');
  $('pause').click(); await flush();
  assert.equal($('replyActivity').textContent, 'Automatic chat paused');
  assert.equal($('autoReply').checked, false);
  assert.equal($('autoResume').checked, false);
  assert.equal(calls.filter(x => ['send', 'dropsEnable'].includes(x.type)).length, 0);
});
