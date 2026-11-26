import test from 'node:test';
import assert from 'node:assert/strict';
import { createUsTransport } from '../lib/usa-transport.mjs';
import { UsaBrowserRelay } from '../extension/usa-transport.js';
import { TRACE_URL } from '../extension/usa-policy.js';
const NOW = 1_800_000_000_000;
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { latency = 2500, mode = 'US', ignoreAbort = false, heldPollAt, heldPollDelay = 0 } = {}) {
  let time = NOW, sequence = 0, session = 0, active = 0, maxActive = 0;
  const timers = new Map(), traces = [], posts = [], nativeSockets = [], facadeCloses = [];
  const timer = (fn, delay, repeat = 0) => { const value = { id: ++sequence, fn, at: time + delay, repeat, unref() {} }; timers.set(value.id, value); return value; };
  const clear = value => timers.delete(value?.id), setTimer = (fn, delay) => timer(fn, delay);
  const setIntervalImpl = (fn, delay) => timer(fn, delay, delay), now = () => time;
  const savedSetInterval = globalThis.setInterval, savedClearInterval = globalThis.clearInterval;
  globalThis.setInterval = setIntervalImpl; globalThis.clearInterval = clear;
  const helper = createUsTransport({ now, setTimer, clearTimer: clear });
  class Socket extends EventTarget {
    constructor() { super(); this.readyState = 0; nativeSockets.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }); }
    close() { this.readyState = 3; }
  }
  const browser = new UsaBrowserRelay({ now, setTimer, clearTimer: clear, setIntervalImpl, clearIntervalImpl: clear,
    settings: async () => ({ account: 'synthetic_companion', pairingToken: 'synthetic-local-pairing' }), access: async () => true,
    sessionId: () => `synthetic-browser-${++session}`, WebSocketImpl: Socket,
    post: async (path, input) => {
      const action = path.split('/').at(-1); posts.push({ action, at: time - NOW, proofAt: input.proof?.checkedAt - NOW, id: input.id });
      const value = helper[action](input);
      if (action === 'poll' && time - NOW === heldPollAt) return new Promise(resolve => setTimer(() => resolve(value), heldPollDelay));
      return value;
    }, fetchImpl: async (url, options) => {
      assert.equal(url, TRACE_URL, 'Only synthetic credentialless trace is allowed.'); assert.equal(options.credentials, 'omit');
      const bootstrap = time === NOW, row = { start: time - NOW, finish: null, aborted: false }; traces.push(row); active++; maxActive = Math.max(maxActive, active);
      return new Promise((resolve, reject) => {
        let done = false, pending;
        const settle = () => {
          if (done) return; done = true; active--; row.finish = time - NOW;
          if (!bootstrap && mode === 'network') reject(Error('synthetic network failure'));
          else resolve(new Response(`ip=203.0.113.17\nloc=${bootstrap ? 'US' : mode}\n`));
        };
        if (bootstrap) settle(); else if (mode !== 'hang') pending = setTimer(settle, latency);
        options.signal.addEventListener('abort', () => { row.aborted = true; if (!ignoreAbort && !done) { done = true; active--; clear(pending); reject(Error('synthetic abort')); } }, { once: true });
      });
    }
  });
  let closed = false;
  const close = () => { if (closed) return; closed = true; browser.stop(); helper.close(); globalThis.setInterval = savedSetInterval; globalThis.clearInterval = savedClearInterval; };
  t.after(close);
  async function advance(to) {
    for (;;) {
      const value = [...timers.values()].filter(value => value.at <= NOW + to).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!value) break; time = value.at; if (value.repeat) value.at += value.repeat; else timers.delete(value.id);
      value.fn(); await flush();
    }
    time = NOW + to; await flush();
  }
  browser.start(); for (let i = 0; i < 8; i++) await flush();
  const facade = new helper.WebSocket('wss://eventsub.wss.twitch.tv/ws');
  facade.addEventListener('close', event => facadeCloses.push({ at: time - NOW, code: event.code }));
  await browser.tick(); for (let i = 0; i < 8; i++) await flush(); assert.equal(facade.readyState, 1);
  return { helper, browser, facade, traces, posts, timers, nativeSockets, facadeCloses, advance, now, close, maxActive: () => maxActive };
}

test('proactive renewal keeps the same socket through repeated2500ms and3499ms US checks', async t => {
  for (const latency of [2500, 3499]) {
    const f = await fixture(t, { latency }); await f.advance(12000);
    assert.equal(f.traces.find(row => row.start > 0).start, 1000);
    assert.equal(f.traces.find(row => row.start > 0).finish, 1000 + latency);
    assert.equal(f.facade.readyState, 1); assert.equal(f.nativeSockets.length, 1); assert.equal(f.maxActive(), 1);
    assert.deepEqual(f.facadeCloses, []); assert.equal(f.helper.status().lastSocketClose, null); assert.equal(f.helper.status().country, 'US');
    f.close();
  }
});

test('proof publication survives an older in-flight poll and runs as soon as that poll returns', async t => {
  const f = await fixture(t, { latency: 3499, heldPollAt: 4000, heldPollDelay: 800 }); await f.advance(4900);
  assert.ok(f.posts.some(row => row.action === 'poll' && row.at === 4800 && row.proofAt === 4499));
  assert.equal(f.helper.status().checkedAt, NOW + 4499); assert.equal(f.facade.readyState, 1); assert.equal(f.maxActive(), 1);
});

test('non-US and failed renewal still close/fence work without provider fallback or socket replay', async t => {
  for (const mode of ['CA', 'network', 'hang']) {
    const f = await fixture(t, { mode, latency: 100 }); await f.advance(6000);
    assert.equal(f.facade.readyState, 3); assert.equal(f.nativeSockets.length, 1);
    assert.equal(f.helper.status().sockets, 0); assert.equal(f.posts.filter(row => row.action === 'begin').length, 1);
    f.close();
  }
});

test('Stop cancels renewal timer and fences an abort-ignoring late US response without new traffic', async t => {
  for (const stopAt of [500, 1500]) {
    const f = await fixture(t, { latency: 2500, ignoreAbort: true }); await f.advance(stopAt);
    const timer = f.browser.renewalTimer; f.browser.stop(); assert.equal(f.browser.renewalTimer, null); assert.equal(f.timers.has(timer?.id), false);
    const traces = f.traces.length, posts = f.posts.length; await f.advance(10000);
    assert.equal(f.traces.length, traces); assert.equal(f.posts.length, posts); assert.equal(f.browser.proof, null);
    assert.equal(f.browser.status().ready, false); assert.equal(f.nativeSockets.length, 1);
    f.close();
  }
});

test('reset cancels the old renewal timer and version-fences its publication', async t => {
  const f = await fixture(t); await f.advance(500); const oldTimer = f.browser.renewalTimer;
  f.browser.reset('stopped'); assert.equal(f.timers.has(oldTimer.id), false); assert.equal(f.browser.publicationPending, false);
  assert.equal(f.browser.renewalTimer, null); assert.equal(f.browser.proof, null);
  f.browser.stop();
});

test('Stop during awaited settings or access cannot bootstrap traffic from the old tick', async t => {
  for (const phase of ['settings', 'access']) {
    let release, waiting = false, calls = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const browser = new UsaBrowserRelay({ settings: async () => { if (phase === 'settings') { waiting = true; await gate; } return { account: 'synthetic_companion', pairingToken: 'synthetic-pairing-token' }; },
      access: async () => { if (phase === 'access') { waiting = true; await gate; } return true; },
      post: async () => { calls++; throw Error('No retired poll is allowed.'); }, fetchImpl: async () => { calls++; throw Error('No retired trace is allowed.'); },
      setIntervalImpl: () => 1, clearIntervalImpl: () => {}, setTimer: () => 1, clearTimer: () => {} });
    const pending = browser.tick(); for (let i = 0; i < 5 && !waiting; i++) await flush();
    assert.equal(waiting, true); browser.stop(); release(); await pending; await flush();
    assert.equal(calls, 0); assert.equal(browser.renewalTimer, null); assert.equal(browser.publicationPending, false);
  }
});

test('Stop during probe permission await cannot launch a country request or rearm renewal', async t => {
  const f = await fixture(t); let release, started = false;
  f.browser.access = async () => { started = true; return new Promise(resolve => { release = resolve; }); };
  const traces = f.traces.length, posts = f.posts.length, pending = f.browser.attest(); pending.catch(() => {});
  await flush(); assert.equal(started, true); f.browser.stop(); release(true); await assert.rejects(pending); await flush();
  assert.equal(f.traces.length, traces); assert.equal(f.posts.length, posts); assert.equal(f.browser.renewalTimer, null);
});

test('Stop after proof success but during its publication settings await prevents a late publication', async t => {
  const f = await fixture(t); let release, blocked = false;
  const original = f.browser.settings;
  f.browser.settings = async () => { if (f.browser.proof?.checkedAt > NOW) { blocked = true; await new Promise(resolve => { release = resolve; }); } return original(); };
  await f.advance(3500); assert.equal(blocked, true);
  const traces = f.traces.length, posts = f.posts.length; f.browser.stop(); release(); await flush();
  await f.advance(8000); assert.equal(f.posts.length, posts); assert.equal(f.traces.length, traces);
  assert.equal(f.browser.renewalTimer, null); assert.equal(f.browser.publicationPending, false);
});

test('late settings/access rejection cannot rotate a stopped lifecycle or restart traffic', async () => {
  for (const phase of ['settings', 'access']) {
    let reject, waiting = false, calls = 0;
    const gate = new Promise((_resolve, no) => { reject = no; });
    const browser = new UsaBrowserRelay({ settings: async () => { if (phase === 'settings') { waiting = true; await gate; } return { pairingToken: 'synthetic-local-pairing' }; },
      access: async () => { if (phase === 'access') { waiting = true; await gate; } return true; },
      post: async () => { calls++; }, fetchImpl: async () => { calls++; }, setIntervalImpl: () => 1, clearIntervalImpl: () => {}, setTimer: () => 1, clearTimer: () => {} });
    const pending = browser.tick(); for (let i = 0; i < 5 && !waiting; i++) await flush();
    browser.stop(); const version = browser.version; reject(Error('synthetic late error')); await pending; await flush();
    assert.equal(calls, 0); assert.equal(browser.version, version); assert.equal(browser.reason, 'stopped');
  }
});
