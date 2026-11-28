import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { attachWatchTab } from '../watch-only.mjs';
import { buildWatchExtension } from '../build.mjs';

const tagged = 'https://www.twitch.tv/example#companion-watch';
function page(url = tagged) {
  const location = { href: url };
  const listeners = new Map();
  const events = {
    addEventListener(key, handler) { listeners.set(key, handler); },
    removeEventListener(key, handler) {
      if (listeners.get(key) === handler) listeners.delete(key);
    }
  };
  const calls = [];
  let ad = false;
  const player = { querySelectorAll: () => ad ? [{ getClientRects: () => [1] }] : [] };
  const video = { tagName: 'VIDEO', paused: false, ended: false, readyState: 4, currentTime: 1,
    closest: () => player, getClientRects: () => [1], isConnected: true };
  const init = vm.runInNewContext('(' + attachWatchTab.toString() + ')', { URL, location, document: events, window: events });
  init(expected => { calls.push(expected); });
  return { listeners, location, calls, video, setAd(value) { ad = value; },
    async tick(time) { video.currentTime = time; await listeners.get('timeupdate')?.({ target: video }); } };
}

test('untagged, foreign and non-channel pages have no watch listeners', () => {
  for (const url of [tagged.replace('#companion-watch', ''), tagged.replace('www.twitch.tv', 'example.org'),
    tagged.replace('/example', '/videos/123'), tagged.replace('#', '?other=1#')]) assert.equal(page(url).listeners.size, 0);
});

test('waits for non-ad video to advance and releases all listeners after one selection', async () => {
  const p = page();
  p.video.paused = true;
  await p.tick(2); await p.tick(3);
  p.video.paused = false;
  p.setAd(true);
  await p.tick(4); await p.tick(6);
  assert.deepEqual(p.calls, []);
  p.setAd(false);
  await p.tick(6); await p.tick(6.1);
  assert.deepEqual(p.calls, []);
  await p.tick(7.5); await p.tick(10);
  assert.deepEqual(p.calls, ['https://www.twitch.tv/example']);
  assert.equal(p.listeners.size, 0);
});

test('leaving the opted-in document stops pending work', async () => {
  const p = page();
  await p.tick(1);
  p.location.href = tagged.replace('example', 'another');
  await p.tick(3);
  assert.equal(p.listeners.size, 0);
  assert.deepEqual(p.calls, []);
});

test('unpacked extension contains one isolated Twitch script and no worker or privileged API', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'watch-package-'));
  try {
    const path = join(tmp, 'extension');
    await buildWatchExtension(path);
    assert.deepEqual((await readdir(path)).sort(), ['manifest.json', 'watch-only.js']);
    const manifest = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
    assert.deepEqual(manifest.content_scripts[0].matches, ['https://www.twitch.tv/*']);
    for (const key of ['background', 'permissions', 'host_permissions', 'web_accessible_resources']) assert.equal(manifest[key], undefined);
    const code = await readFile(join(path, manifest.content_scripts[0].js[0]), 'utf8');
    vm.runInNewContext(code, { URL, location: { href: 'https://www.twitch.tv/example' } });
  } finally { await rm(tmp, { recursive: true, force: true }); }
});
