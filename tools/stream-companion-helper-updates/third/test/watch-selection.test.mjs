import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { watchPage } from '../extension/watch-page.js';
import { WatchSession, playbackState } from '../extension/watch.js';

function page(t, html) {
  const dom = new JSDOM(html, { url: 'https://www.twitch.tv/fixture_channel', runScripts: 'outside-only' });
  const { window } = dom, document = window.document;
  window.HTMLElement.prototype.getClientRects = function () {
    for (let el = this; el; el = el.parentElement) if (el.hidden || window.getComputedStyle(el).display === 'none') return [];
    return [{}];
  };
  window.HTMLElement.prototype.getBoundingClientRect = function () { return { width: Number(this.dataset.width || 640), height: Number(this.dataset.height || 360) }; };
  const media = (selector, extra = {}) => {
    const element = typeof selector === 'string' ? document.querySelector(selector) : selector;
    for (const [key, value] of Object.entries({ currentTime: 12, readyState: 4, paused: false, ended: false, error: null, ...extra })) Object.defineProperty(element, key, { configurable: true, writable: true, value });
    element.play = element.pause = element.click = () => assert.fail('Native player controls must never be called.');
    return element;
  };
  for (const element of document.querySelectorAll('video,audio')) media(element);
  t.after(() => window.close());
  // Exercise the exact standalone function shape injected by chrome.scripting.
  return { document, media, read: () => window.eval(`(${watchPage.toString()})()`) };
}
const state = (raw, documentId = 'native-document') => ({ ...raw, documentId });

test('serialized reader chooses native main video instead of a larger outside paused preview', t => {
  const p = page(t, '<div data-a-target="video-player"><video id="main"></video></div><video id="preview" data-width="1920" data-height="1080"></video>');
  p.media('#preview', { paused: true, currentTime: 900 });
  const read = p.read(); assert.equal(read.currentTime, 12); assert.equal(read.paused, false); assert.match(read.videoId, /^v\d+$/);
});

test('an outside playing preview cannot hide a paused or audio-only native main player', t => {
  for (const html of ['<video id="main"></video>', '<audio id="main"></audio>']) {
    const p = page(t, `<div data-test-selector="video-player">${html}</div><video id="preview" data-width="1920" data-height="1080"></video>`);
    p.media('#main', { paused: true }); p.media('#preview', { currentTime: 900 });
    const read = p.read();
    if (html.startsWith('<video')) { assert.equal(read.paused, true); assert.equal(read.currentTime, 12); }
    else { assert.equal(read.hasVideo, false); assert.equal(read.videoId, ''); }
  }
});

for (const [name, markup] of [
  ['own opacity', '<video id="retired" style="opacity:0"></video>'],
  ['ancestor opacity', '<div style="opacity:0"><video id="retired"></video></div>'],
  ['ancestor visibility', '<div style="visibility:hidden"><video id="retired"></video></div>'],
  ['ancestor collapse', '<div style="visibility:collapse"><video id="retired"></video></div>'],
  ['ancestor display', '<div style="display:none"><video id="retired"></video></div>'],
  ['hidden ancestor', '<div hidden><video id="retired"></video></div>']
]) test(`retired video with ${name} cannot mask active native video`, t => {
  const p = page(t, `<div data-a-target="video-player">${markup}<video id="main"></video></div>`);
  p.media('#retired', { paused: true, currentTime: 900 });
  const read = p.read(); assert.equal(read.currentTime, 12); assert.equal(read.paused, false);
});

test('visible active native ad media is checked honestly while paused content remains in the player', t => {
  const p = page(t, '<div data-a-target="video-player"><video id="content"></video><video id="ad"></video><span data-a-target="video-ad-countdown">0:10</span></div>');
  p.media('#content', { currentTime: 900, paused: true }); const ad = p.media('#ad', { currentTime: 1 });
  let read = p.read(); assert.equal(read.ad, true); assert.equal(read.currentTime, 1);
  let s = playbackState(state(read), {}, 100000); assert.equal(s.status, 'checking');
  ad.currentTime = 6; read = p.read(); s = playbackState(state(read), s, 105000); assert.equal(s.status, 'ad');
  ad.paused = true; assert.equal(playbackState(state(p.read()), s, 106000).status, 'paused');
});

test('media IDs stay with each DOM element and replacement at the same index receives a new ID', t => {
  const p = page(t, '<div data-a-target="video-player"><video id="main"></video></div>');
  const first = p.read(); const video = p.document.querySelector('video'); video.currentTime = 17;
  assert.equal(p.read().videoId, first.videoId);
  const replacement = p.document.createElement('video'); video.replaceWith(replacement); p.media(replacement, { currentTime: 900 });
  const next = p.read(); assert.notEqual(next.videoId, first.videoId); assert.equal(next.currentTime, 900);
  replacement.parentElement.append(replacement); assert.equal(p.read().videoId, next.videoId);
  assert.equal(replacement.hasAttribute('data-companion-id'), false);
});

test('a changed media clock cannot establish progress until that same element advances', t => {
  const base = { hasVideo: true, videoId: 'v1', currentTime: 12, readyState: 4, paused: false, ended: false, ad: false, offline: false, error: false, documentId: 'doc' };
  let s = playbackState(base, {}, 100000); s = playbackState({ ...base, currentTime: 17 }, s, 105000); assert.equal(s.status, 'playing');
  const replacement = { ...base, videoId: 'v2', currentTime: 900 };
  s = playbackState(replacement, s, 110000); assert.equal(s.status, 'checking'); assert.equal(s.lastProgressAt, 0);
  s = playbackState({ ...replacement, currentTime: 905 }, s, 115000); assert.equal(s.status, 'playing');
  s = playbackState({ ...replacement, currentTime: 910, documentId: 'new-doc' }, s, 120000); assert.equal(s.status, 'checking');
  s = playbackState({ ...replacement, currentTime: 915, documentId: 'new-doc', ad: true }, s, 125000); assert.equal(s.status, 'checking');
});


test('a saved pre-upgrade checkpoint without media identity must be observed twice before playing', () => {
  const raw = { documentId: 'same-document', videoId: 'v1', hasVideo: true, currentTime: 900, readyState: 4, paused: false, ad: false };
  const legacy = { ...raw, videoId: undefined, currentTime: 12, status: 'playing', lastProgressAt: 99000 };
  const first = playbackState(raw, legacy, 100000);
  assert.equal(first.status, 'checking'); assert.equal(first.lastProgressAt, 0);
  const second = playbackState({ ...raw, currentTime: 905 }, first, 105000);
  assert.equal(second.status, 'playing'); assert.equal(second.lastProgressAt, 105000);
});

test('missing or malformed media identity never freshens advancing native-clock evidence', () => {
  for (const videoId of ['', undefined, 'v0', 'v1\n', 'https://media.example/private', {}, 'v9999999999']) {
    const raw = { hasVideo: true, currentTime: 20, videoId, documentId: 'doc', readyState: 4, paused: false };
    const prior = { ...raw, currentTime: 10, lastProgressAt: 99000 };
    const next = playbackState(raw, prior, 100000); assert.notEqual(next.status, 'playing'); assert.equal(next.lastProgressAt, 0);
  }
});

test('new document and unsupported player layout start without inherited progress or audio fallback', t => {
  const p = page(t, '<video id="standalone"></video>'); const q = page(t, '<video id="standalone"></video>');
  assert.equal(p.read().videoId, q.read().videoId);
  const prior = playbackState(state({ ...p.read(), currentTime: 12 }), state({ ...p.read(), currentTime: 5 }), 100000);
  assert.equal(prior.status, 'playing');
  assert.equal(playbackState(state({ ...q.read(), currentTime: 50 }, 'new-document'), prior, 105000).status, 'checking');
  const audio = page(t, '<audio></audio>'); assert.equal(audio.read().hasVideo, false);
});

test('actual tracked poll executes the reader and keeps main pause truth, document IDs and real check times', async t => {
  const p = page(t, '<div data-a-target="video-player"><video id="main"></video></div><video id="preview" data-width="1920" data-height="1080"></video>');
  const main = p.media('#main'), outside = p.media('#preview', { currentTime: 900 });
  const data = {}, originalNow = Date.now; let now = 100000;
  Date.now = () => now; t.after(() => { Date.now = originalNow; });
  const url = 'https://www.twitch.tv/fixture_channel';
  const api = { storage: { local: { async get() { return structuredClone(data); }, async set(value) { Object.assign(data, structuredClone(value)); } } },
    permissions: { async contains() { return true; } }, tabs: { async get() { return { id: 42, url, status: 'complete' }; }, async update() { assert.fail('No tab controls.'); } },
    scripting: { async executeScript(request) {
      assert.deepEqual(request.target, { tabId: 42, frameIds: [0] }); assert.equal(request.world, 'ISOLATED'); assert.equal(request.func, watchPage);
      return [{ frameId: 0, documentId: 'native-doc', result: p.read() }];
    } } };
  const watch = new WatchSession(api, async () => ({ account: 'fixture_companion', paused: false }));
  await watch.attach({ tabId: 42, channel: 'fixture_channel', account: 'fixture_companion' });
  assert.equal((await watch.poll({ force: true })).status, 'checking');
  now += 5000; main.currentTime += 5; assert.equal((await watch.poll({ force: true })).status, 'playing');
  main.paused = true; outside.currentTime += 5; now += 5000;
  const paused = await watch.poll({ force: true }); assert.equal(paused.status, 'paused'); assert.equal(paused.checkedAt, now); assert.equal(paused.documentId, 'native-doc');
});

test('existing primary commercial slate remains distinct from observable ad advancement', t => {
  const p = page(t, '<div data-a-target="video-player">Commercial break in progress<video></video></div>');
  const raw = p.read();
  if (Object.hasOwn(raw, 'commercialBreak')) {
    assert.equal(raw.commercialBreak, true);
    assert.equal(playbackState(state(raw), {}, 100000).status, 'commercial');
  }
  assert.equal(raw.ad, false);
  assert.equal(JSON.stringify(raw).includes('Commercial break'), false);
});
