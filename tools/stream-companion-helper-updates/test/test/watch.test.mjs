import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { WatchSession, watchChannel, playbackState } from '../extension/watch.js';
import { watchPage } from '../extension/watch-page.js';

test('watch targets are exact HTTPS channel pages, never inventory, popouts or VODs', () => {
  assert.equal(watchChannel('https://www.twitch.tv/Some_Channel?referrer=raid'), 'some_channel');
  for (const url of ['https://www.twitch.tv/drops/inventory', 'https://www.twitch.tv/drops', 'https://www.twitch.tv/videos/123', 'https://www.twitch.tv/some_channel/videos', 'https://www.twitch.tv/popout/some_channel/chat', 'https://www.twitch.tv/directory', 'https://www.twitch.tv/settings', 'https://www.twitch.tv/login', 'http://www.twitch.tv/some_channel', 'https://www.twitch.tv.evil.example/some_channel', 'https://www.twitch.tv/../settings', 'https://a@www.twitch.tv/some_channel']) assert.equal(watchChannel(url), '', url);
});

test('health requires advancing native time and distinguishes pause, buffering, stall and stale evidence', () => {
  const snapshot = { documentId: 'doc', videoId: 'v1', hasVideo: true, currentTime: 10, readyState: 4, paused: false, ended: false, ad: false, offline: false, error: false };
  let s = playbackState(snapshot, {}, 100000);
  assert.equal(s.status, 'checking');
  s = playbackState({ ...snapshot, currentTime: 15 }, s, 105000);
  assert.equal(s.status, 'playing'); assert.equal(s.lastProgressAt, 105000);
  assert.equal(playbackState({ ...snapshot, currentTime: 15, paused: true }, s, 106000).status, 'paused');
  assert.equal(playbackState({ ...snapshot, currentTime: 15, readyState: 2 }, s, 110000).status, 'buffering');
  assert.equal(playbackState({ ...snapshot, currentTime: 15 }, s, 136000).status, 'stalled');
  assert.equal(playbackState({ ...snapshot, documentId: 'new-document', currentTime: 15 }, s, 136000).status, 'checking');
  assert.equal(playbackState({ ...snapshot, currentTime: 0 }, s, 136000).status, 'checking');
  assert.equal(playbackState({ ...snapshot, offline: true }, s, 136000).status, 'offline');
  assert.equal(playbackState({ ...snapshot, error: true }, s, 136000).status, 'error');
  assert.equal(playbackState({ ...snapshot, ended: true }, s, 136000).status, 'ended');
  assert.equal(playbackState({ ...snapshot, hasVideo: false }, s, 136000).status, 'unavailable');
});

test('ad transitions reset the playback clock; progressing ads count as expected playback', () => {
  const ad = { documentId: 'doc', videoId: 'v1', hasVideo: true, currentTime: 0, readyState: 4, paused: false, ad: true };
  const initial = playbackState(ad, { documentId: 'doc', videoId: 'v1', hasVideo: true, currentTime: 900, ad: false, lastProgressAt: 99000 }, 100000);
  assert.equal(initial.status, 'checking');
  assert.equal(playbackState({ ...ad, currentTime: 5 }, initial, 105000).status, 'ad');
  assert.equal(playbackState({ ...ad, paused: true }, initial, 105000).status, 'paused');
});

function page(t, body, properties = {}) {
  const dom = new JSDOM(body, { url: 'https://www.twitch.tv/example' });
  dom.window.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: Number(this.dataset.width || 640), height: Number(this.dataset.height || 360) }; };
  for (const video of dom.window.document.querySelectorAll('video')) for (const [key, value] of Object.entries({ currentTime: 12, readyState: 4, paused: false, ended: false, error: null, ...properties })) Object.defineProperty(video, key, { configurable: true, value });
  const original = new Map();
  for (const [key, value] of Object.entries({ document: dom.window.document, location: dom.window.location, getComputedStyle: dom.window.getComputedStyle.bind(dom.window) })) { original.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true, writable: true }); }
  t.after(() => { dom.window.close(); for (const [key, desc] of original) { if (desc) Object.defineProperty(globalThis, key, desc); else delete globalThis[key]; } });
  return dom.window.document;
}

test('page snapshot reads native video and ad state without returning chat text or interacting', t => {
  const d = page(t, '<div data-a-target="video-player"><video></video><span data-a-target="video-ad-countdown">0:10</span></div><div id="chat">error #2000 stream has ended secret unrelated chat</div>');
  let clicks = 0, plays = 0; d.addEventListener('click', () => clicks++); d.querySelector('video').play = () => { plays++; };
  const s = watchPage();
  assert.equal(s.hasVideo, true); assert.equal(s.ad, true); assert.equal(s.currentTime, 12); assert.equal(s.error, false); assert.equal(s.offline, false);
  assert.equal(clicks, 0); assert.equal(plays, 0); assert.equal(JSON.stringify(s).includes('secret'), false);
});

test('page snapshot excludes hidden preview players and detects native offline/error overlays', t => {
  const d = page(t, '<video hidden></video><div data-a-target="video-player"><span data-a-target="player-overlay-offline">offline</span></div>');
  assert.equal(watchPage().hasVideo, false); assert.equal(watchPage().offline, true);
  d.querySelector('[data-a-target="player-overlay-offline"]').remove();
  d.querySelector('[data-a-target="video-player"]').textContent = 'A network error occurred. Error #2000';
  assert.equal(watchPage().error, true);
});

function controller(hooks = {}) {
  const data = {}, calls = [], settings = { account: 'qumaris_2489', paused: false };
  let grant = true, time = 10, url = 'https://www.twitch.tv/first_channel', status = 'complete', documentId = 'doc1', override, tabExists = true;
  const api = {
    storage: { local: { async get() { return structuredClone(data); }, async set(value) { Object.assign(data, structuredClone(value)); } } },
    permissions: { async contains() { return grant; } },
    tabs: { async get(id) { calls.push(['get', id]); if (!tabExists) throw Error('No tab'); return { id, url, status }; }, async remove() { throw Error('Must not close tabs'); }, async update() { throw Error('Must not control tabs'); } },
    scripting: { async executeScript(request) { calls.push(['execute', request.target]); if (override) return override(request); return [{ frameId: 0, documentId, result: { url, videoId: 'v1', hasVideo: true, currentTime: time, readyState: 4, paused: false, ended: false, ad: false, offline: false, error: false } }]; } }
  };
  const instance = new WatchSession(api, async () => structuredClone(settings), hooks);
  return { instance, data, api, calls, settings, attach: () => instance.attach({ tabId: 42, account: settings.account, channel: 'first_channel' }), time: value => { time = value; }, navigate: (value, state = 'complete') => { url = value; status = state; }, document: value => { documentId = value; }, override: fn => { override = fn; }, revoke: () => { grant = false; }, close: () => { tabExists = false; } };
}

test('controller tracks only the attached top frame, throttles checks and marks stale evidence', async () => {
  const h = controller(); await h.attach(); await h.instance.poll({ force: true });
  assert.equal((await h.instance.state()).status, 'checking');
  h.time(15); await h.instance.poll({ force: true });
  assert.equal((await h.instance.state()).status, 'playing');
  assert.deepEqual(h.calls.filter(x => x[0] === 'execute').map(x => x[1]), [{ tabId: 42, frameIds: [0] }, { tabId: 42, frameIds: [0] }]);
  await h.instance.poll(); assert.equal(h.calls.filter(x => x[0] === 'execute').length, 2);
  h.data.watchSession.checkedAt = Date.now() - 46000;
  assert.equal((await h.instance.state()).status, 'stale');
  await h.instance.handleTabUpdated(99, { url: 'https://www.twitch.tv/other_channel' });
  assert.equal((await h.instance.state()).channel, 'first_channel');
});

test('tracked navigation invalidates old evidence before channel sync and duplicate updates do not resync', async () => {
  const events = []; let h;
  h = controller({ onNavigation: token => { events.push(['invalidate', token.channel]); }, onChannel: async token => { events.push(['sync', token.channel, token.isRaid]); assert.equal(await h.instance.current(token), true); assert.equal((await h.instance.state()).status, 'checking'); return { ok: true }; } });
  await h.attach(); await h.instance.poll({ force: true }); h.time(15); await h.instance.poll({ force: true });
  h.navigate('https://www.twitch.tv/second_channel?referrer=raid');
  await h.instance.handleTabUpdated(42, { url: 'https://www.twitch.tv/second_channel?referrer=raid' });
  assert.deepEqual(events, [['invalidate', 'second_channel'], ['sync', 'second_channel', true]]);
  assert.equal((await h.instance.state()).syncStatus, 'aligned'); assert.equal((await h.instance.state()).checkedAt, 0);
  await h.instance.handleTabUpdated(42, { url: 'https://www.twitch.tv/second_channel?referrer=raid' });
  assert.equal(events.length, 2);
});

test('same-channel reload resets document evidence but does not switch chat', async () => {
  let syncs = 0; const h = controller({ onNavigation: () => syncs++, onChannel: () => syncs++ });
  await h.attach(); await h.instance.poll({ force: true });
  await h.instance.handleTabUpdated(42, { status: 'loading' }, { url: 'https://www.twitch.tv/first_channel' });
  assert.equal(syncs, 0); assert.equal((await h.instance.state()).documentId, '');
  h.document('doc2'); await h.instance.handleTabUpdated(42, { status: 'complete' });
  assert.equal((await h.instance.state()).status, 'checking');
});

test('navigation away and tab closure notify chat alignment without modifying any tab', async () => {
  const events = []; const h = controller({ onNavigation: t => events.push(t.channel), onChannel: async () => ({ ok: false, error: 'No stream channel.' }) });
  await h.attach(); h.navigate('https://www.twitch.tv/directory'); await h.instance.poll({ force: true });
  assert.deepEqual(events, ['']); assert.equal((await h.instance.state()).syncStatus, 'blocked'); assert.equal((await h.instance.state()).status, 'unavailable');
  await h.instance.handleTabRemoved(99); assert.equal((await h.instance.state()).enabled, true);
  await h.instance.handleTabRemoved(42); assert.equal((await h.instance.state()).enabled, false); assert.deepEqual(events, ['', '']);
});

test('Pause during observation discards late results and stop never touches tabs', async () => {
  const h = controller(); await h.attach(); let finish;
  h.override(() => new Promise(resolve => { finish = resolve; }));
  const work = h.instance.poll({ force: true }); while (!finish) await new Promise(resolve => setImmediate(resolve));
  const before = h.calls.length; await h.instance.stop('Companion is paused.'); assert.equal(h.calls.length, before);
  finish([{ frameId: 0, documentId: 'doc1', result: { url: 'https://www.twitch.tv/first_channel', hasVideo: true, currentTime: 99 } }]); await work;
  assert.equal((await h.instance.state()).enabled, false); assert.equal((await h.instance.state()).status, 'off');
});

test('Pause during channel validation prevents an obsolete sync result from rearming state', async () => {
  let release, token; const h = controller({ onChannel: t => { token = t; return new Promise(resolve => { release = resolve; }); } });
  await h.attach(); h.navigate('https://www.twitch.tv/second_channel');
  const work = h.instance.poll({ force: true }); while (!release) await new Promise(resolve => setImmediate(resolve));
  await h.instance.stop(); assert.equal(await h.instance.current(token), false); release({ ok: true }); await work;
  assert.equal((await h.instance.state()).enabled, false); assert.equal((await h.instance.state()).syncStatus, 'idle');
});

test('loading and query updates during raid validation preserve its channel token', async () => {
  let release, token, syncs = 0;
  const h = controller({ onChannel: t => { token = t; syncs++; return new Promise(resolve => { release = resolve; }); } });
  await h.attach(); h.navigate('https://www.twitch.tv/second_channel?referrer=raid');
  const work = h.instance.handleTabUpdated(42, { url: 'https://www.twitch.tv/second_channel?referrer=raid' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await h.instance.handleTabUpdated(42, { status: 'loading' }, { url: 'https://www.twitch.tv/second_channel?referrer=raid' });
  h.navigate('https://www.twitch.tv/second_channel');
  await h.instance.handleTabUpdated(42, { url: 'https://www.twitch.tv/second_channel' });
  assert.equal(await h.instance.current(token), true); assert.equal(syncs, 1);
  release({ ok: true }); await work;
  assert.equal((await h.instance.state()).syncStatus, 'aligned');
});

test('a newer channel navigation invalidates pending validation without blocking on it', async () => {
  let release, token;
  const h = controller({ onChannel: t => { if (t.channel === 'second_channel') { token = t; return new Promise(resolve => { release = resolve; }); } return { ok: true }; } });
  await h.attach();
  const first = h.instance.navigate('https://www.twitch.tv/second_channel');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await h.instance.navigate('https://www.twitch.tv/third_channel');
  assert.equal(await h.instance.current(token), false);
  release({ ok: false, error: 'Obsolete result' }); await first;
  assert.equal((await h.instance.state()).channel, 'third_channel'); assert.equal((await h.instance.state()).syncStatus, 'aligned'); assert.equal((await h.instance.state()).syncError, '');
});

test('permission removal holds unknown playback; account changes and Pause stop before page access', async () => {
  for (const reason of ['permission', 'account', 'pause']) {
    const h = controller(); await h.attach(); const before = h.calls.length;
    if (reason === 'permission') h.revoke(); else if (reason === 'account') h.settings.account = 'other_account'; else h.settings.paused = true;
    await h.instance.poll({ force: true }); assert.equal((await h.instance.state()).enabled, reason === 'permission'); assert.equal(h.calls.length, before);
    if (reason === 'permission') assert.equal((await h.instance.state()).status, 'unavailable');
  }
});

test('old-document execution during navigation cannot report healthy video for the new page', async () => {
  const h = controller(); await h.attach();
  h.override(() => { h.navigate('https://www.twitch.tv/second_channel'); return [{ frameId: 0, documentId: 'old-doc', result: { url: 'https://www.twitch.tv/first_channel', hasVideo: true, currentTime: 30, readyState: 4 } }]; });
  await h.instance.poll({ force: true });
  assert.equal((await h.instance.state()).channel, 'second_channel'); assert.equal((await h.instance.state()).checkedAt, 0); assert.notEqual((await h.instance.state()).status, 'playing');
});

test('unexpected subframe or missing document evidence cannot establish playback', async () => {
  for (const output of [{ frameId: 5, documentId: 'frame', result: { url: 'https://www.twitch.tv/first_channel', hasVideo: true, currentTime: 20 } }, { frameId: 0, result: { url: 'https://www.twitch.tv/first_channel', hasVideo: true, currentTime: 20 } }]) {
    const h = controller(); await h.attach(); h.override(() => [output]); await h.instance.poll({ force: true });
    assert.equal((await h.instance.state()).checkedAt, 0); assert.notEqual((await h.instance.state()).status, 'playing');
  }
});
