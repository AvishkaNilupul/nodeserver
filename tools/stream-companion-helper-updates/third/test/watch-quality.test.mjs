import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { preferLowWatchQuality } from '../extension/watch-quality.js';
import { WatchSession } from '../extension/watch.js';

const url = 'https://www.twitch.tv/watch_fixture';
function fixture(t, { labels = ['Auto', '1080p60 (Source)', '360p', '160p', 'Audio Only'], delayed = false, portal = false, address = url } = {}) {
  const dom = new JSDOM('<input id="chat"><div data-a-target="video-player"><video></video><button data-a-target="player-settings-button">Settings</button></div>', { url: address, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, doc = w.document, p = doc.querySelector('[data-a-target="video-player"]'), gear = p.querySelector('button');
  const host = portal ? doc.body : p;
  const video = p.querySelector('video'), clicks = [], menu = () => host.querySelector('[data-a-target="player-settings-menu"]');
  w.HTMLElement.prototype.getClientRects = function () { return this.closest('[hidden]') ? [] : [{}]; };
  for (const [k, v] of Object.entries({ paused: false, ended: false, videoHeight: 1080 })) Object.defineProperty(video, k, { configurable: true, writable: true, value: v });
  video.play = video.pause = video.click = () => assert.fail('The player transport must remain untouched');
  gear.onclick = () => {
    clicks.push('gear');
    if (menu()) return (menu().closest('[role="menu"]') || menu()).remove();
    const panel = doc.createElement('div'); panel.dataset.aTarget = 'player-settings-menu';
    if (portal) {
      const shell = doc.createElement('div'); shell.setAttribute('role', 'menu');
      shell.setAttribute('aria-labelledby', 'active-settings-menu-header'); shell.append(panel);
      w.setTimeout(() => host.append(shell), 5);
    } else host.append(panel);
    const quality = doc.createElement('button'); quality.dataset.aTarget = 'player-settings-menu-item-quality'; panel.append(quality);
    quality.onclick = () => {
      clicks.push('quality');
      const render = () => {
        panel.replaceChildren();
        for (const [i, entry] of labels.entries()) {
          const { text, disabled, selected } = typeof entry === 'string' ? { text: entry } : entry;
          const radio = doc.createElement('input'), label = doc.createElement('label');
          radio.type = 'radio'; radio.id = 'quality-' + i; radio.name = 'quality'; radio.checked = !!selected; radio.disabled = !!disabled;
          radio.dataset.aTarget = 'player-settings-submenu-quality-option'; label.htmlFor = radio.id; label.textContent = text;
          radio.onclick = () => clicks.push(text);
          if (portal) {
            const row = doc.createElement('div'); row.dataset.aTarget = radio.dataset.aTarget;
            delete radio.dataset.aTarget; row.append(radio, label); panel.append(row);
          } else panel.append(radio, label);
        }
      };
      if (delayed) w.setTimeout(render, 5); else render();
    };
  };
  const choose = w.eval(`(${preferLowWatchQuality.toString()})`);
  return { choose, doc, video, gear, menu, clicks, w };
}

test('standalone selector uses the lowest enabled native picture, preserves chat and closes its menu', async t => {
  const f = fixture(t, { delayed: true, labels: ['Auto', 'Audio Only', '1080p60 (Source)', '160p60', '160p30AV1', { text: '144p', disabled: true }] });
  assert.equal(await f.choose(url), 160);
  assert.deepEqual(f.clicks, ['gear', 'quality', '160p30AV1', 'gear']);
  assert.equal(f.menu(), null); assert.equal(f.doc.querySelector('#chat').value, '');
});

test('native portal outside the player opens asynchronously, chooses the child radio, and closes', async t => {
  const f = fixture(t, { portal: true, delayed: true, labels: ['Auto', '1080p60(Source)', '720p60', '480p30', '360p30', '160p30'] });
  assert.equal(await f.choose(url), 160);
  assert.deepEqual(f.clicks, ['gear', 'quality', '160p30', 'gear']);
  assert.equal(f.menu(), null);
  assert.equal(f.doc.querySelector('[role="menu"]'), null);
});

test('a pre-existing portal or an unlinked competing gear is left untouched', async t => {
  const f = fixture(t, { portal: true });
  f.gear.click(); await new Promise(resolve => setTimeout(resolve, 10));
  const existing = f.menu();
  assert.ok(existing);
  assert.equal(await f.choose(url), 0); assert.equal(f.menu(), existing);
  assert.deepEqual(f.clicks, ['gear']);
  const g = fixture(t, { portal: true });
  g.doc.body.insertAdjacentHTML('beforeend','<div data-a-target="video-player"><button data-a-target="player-settings-button"></button></div>');
  assert.equal(await g.choose(url), 0); assert.deepEqual(g.clicks, []);
});

test('a source-only player and a player already on the lowest rendition keep their setting', async t => {
  const f = fixture(t, { labels: ['Auto', '1080p (Source)', 'Audio Only'] });
  assert.equal(await f.choose(url), 0); assert.deepEqual(f.clicks, ['gear', 'quality', 'gear']);
  const g = fixture(t, { labels: ['Auto', { text: '360p', selected: true }, '720p'] });
  assert.equal(await g.choose(url), 360); assert.deepEqual(g.clicks, ['gear', 'quality', 'gear']);
});

test('empty and unavailable resolution menus preserve playback', async t => {
  const f = fixture(t, { labels: ['Auto', 'Audio Only', { text: '360p', disabled: true }] });
  assert.equal(await f.choose(url), 0); assert.deepEqual(f.clicks, ['gear', 'quality', 'gear']); assert.equal(f.video.paused, false);
});

test('only a matching active ordinary watch tab is eligible, and the extra-slot marker is supported', async t => {
  const g = fixture(t, { address: url + '#companion-watch' }); assert.equal(await g.choose(url), 160);
  for (const address of [url + '?route=elsewhere', 'https://www.twitch.tv/elsewhere', 'https://example.com/watch_fixture', url + '#other']) {
    const f = fixture(t, { address }); assert.equal(await f.choose(url), 0); assert.deepEqual(f.clicks, []);
  }
  for (const address of ['https://www.twitch.tv/directory', 'https://www.twitch.tv/videos/123']) {
    const f = fixture(t, { address }); assert.equal(await f.choose(address), 0); assert.deepEqual(f.clicks, []);
  }
  const f = fixture(t); f.video.paused = true; assert.equal(await f.choose(url), 0);
  f.video.paused = false; f.video.videoHeight = 0; assert.equal(await f.choose(url), 0);
  f.video.videoHeight = 1080; f.doc.querySelector('video').insertAdjacentHTML('afterend', '<div data-a-target="video-ad-label"></div>');
  assert.equal(await f.choose(url), 0); assert.deepEqual(f.clicks, []);
});

test('commercial slates and an operator navigating away during menu render suppress selection', async t => {
  const f = fixture(t); f.doc.querySelector('video').insertAdjacentHTML('afterend', '<div>Commercial Break In Progress</div>');
  assert.equal(await f.choose(url), 0); assert.deepEqual(f.clicks, []);
  const g = fixture(t, { delayed: true }); const choosing = g.choose(url);
  await new Promise(resolve => setTimeout(resolve, 0)); g.w.history.pushState({}, '', '/other_fixture');
  assert.equal(await choosing, 0); assert.equal(g.clicks.includes('160p'), false);
});

test('a user-open menu or focused composer is preserved', async t => {
  const f = fixture(t); f.doc.querySelector('#chat').focus(); assert.equal(await f.choose(url), 0); assert.deepEqual(f.clicks, []);
  f.doc.querySelector('#chat').blur(); f.gear.click(); assert.equal(await f.choose(url), 0); assert.deepEqual(f.clicks, ['gear']); assert.ok(f.menu());
});

test('the isolated chooser requires only boolean worker confirmation while local storage is restricted', async t => {
  const f = fixture(t);
  const session = { sessionId: 'manual-watch', generation: 3 };
  const messages = [];
  f.w.chrome = { runtime: { sendMessage: async message => { messages.push(message); return true; } },
    get storage() { throw new Error('Unavailable in content scripts'); } };
  assert.equal(await f.choose(url, session), 160);
  assert.ok(messages.length >= 3);
  assert.ok(messages.every(m => m.type === 'watchQualityActive' && m.generation === 3 && m.sessionId === session.sessionId));
});

test('Stop while the quality menu renders cancels selection and restores the menu', async t => {
  const f = fixture(t, { delayed: true });
  const s = { enabled: true, sessionId: 'test', generation: 2, tabId: 1 };
  f.w.chrome = { runtime: { sendMessage: async msg => msg.type === 'watchQualityActive' && s.enabled
    && msg.sessionId === s.sessionId && msg.generation === s.generation } };
  const first = f.choose(url, { ...s });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(f.clicks, ['gear', 'quality']); s.enabled = false;
  assert.equal(await first, 0); assert.equal(f.menu(), null); assert.equal(f.clicks.includes('160p'), false);
});

test('watch lifecycle requests quality once per aligned playing document and reports measured dimensions', async () => {
  let saved = {}, clock = 10, height = 1080, documentId = 'doc-one';
  const choices = [];
  const api = {
    runtime: { id: 'fixture-id' },
    storage: { local: { get: async () => structuredClone(saved), set: async value => { Object.assign(saved, value); } } },
    permissions: { contains: async () => true }, tabs: { get: async () => ({ url, status: 'complete' }) },
    scripting: { executeScript: async request => {
      if (request.func === preferLowWatchQuality) {
        assert.deepEqual(request.target, { tabId: 42, documentIds: [documentId] }); choices.push(documentId);
        const message = { type: 'watchQualityActive', ...request.args[1] };
        const sender = { frameId: 0, documentId, tab: { id: 42 }, id: 'fixture-id', url };
        assert.equal(await watch.qualityActive(message, sender), true);
        for (const changes of [{ frameId: 1 }, { id: 'other' }, { documentId: 'old' }, { tab: { id: 100 } }, { url: url + '?different' }])
          assert.equal(await watch.qualityActive(message, { ...sender, ...changes }), false);
        assert.equal(await watch.qualityActive({ ...message, generation: -1 }, sender), false);
        assert.equal(await watch.qualityActive({ ...message, sessionId: 'old' }, sender), false);
        return [{ frameId: 0, documentId, result: 160 }];
      }
      return [{ frameId: 0, documentId, result: { url, videoId: 'v1', currentTime: clock++, hasVideo: true, readyState: 4, decodedHeight: height } }];
    } }
  };
  const watch = new WatchSession(api, async () => ({ account: 'test_user', paused: false }));
  await watch.attach({ tabId: 42, account: 'test_user', channel: 'watch_fixture' });
  await watch.poll({ force: true }); assert.deepEqual(choices, []);
  const first = await watch.poll({ force: true }); assert.equal(first.decodedHeight, 1080); assert.equal(first.requestedHeight, 160);
  assert.equal(await watch.qualityActive({ sessionId: first.sessionId, generation: first.generation },
    { frameId: 0, documentId, tab: { id: 42 }, id: 'fixture-id', url }), false);
  height = 160; assert.match((await watch.poll({ force: true })).detail, /160p/);
  // The operator can switch back during the same document.
  height = 720; assert.equal((await watch.poll({ force: true })).decodedHeight, 720); assert.deepEqual(choices, ['doc-one']);
  documentId = 'doc-two'; await watch.poll({ force: true }); await watch.poll({ force: true }); assert.deepEqual(choices, ['doc-one', 'doc-two']);
  await watch.stop(); await watch.poll({ force: true }); assert.equal(choices.length, 2);
});
