import test from 'node:test';
import assert from 'node:assert/strict';
import { createController, createView, renderHost, relativeAge, remaining } from '../public/app.js';

const now = Date.parse('2026-11-25T00:00:00Z');
const snapshot = (extra = {}) => ({ version: '1.0.0', updatedAt: new Date(now).toISOString(), paused: false,
  host: { health: 'ready', uptimeSeconds: 240 }, policy: { channelGapMs: 180000, maxAttemptsPerHour: 6, leaseMs: 20000 },
  clients: [{ id: 'primary', name: 'First companion', account: 'first_account', channel: 'friend_channel', connected: true,
    ready: true, online: true, lastSeenAt: new Date(now - 2000).toISOString(), playback: 'playing', lastDecision: 'Waiting for useful chat.', pendingCompletions: 0 }],
  channels: [{ channel: 'friend_channel', attemptsLastHour: 2, nextTurnAt: new Date(now + 90000).toISOString(), activeSpeaker: null, waiting: [] }],
  events: [{ id: 'event-1', at: new Date(now - 1000).toISOString(), account: 'first_account', channel: 'friend_channel', type: 'confirmed', delivery: 'confirmed', kind: 'topic', reason: 'Twitch confirmed delivery.' }],
  exchanges: { enabled: false, intervalMinMs: 3600000, intervalMaxMs: 7200000, replyMinMs: 180000, replyMaxMs: 360000, channels: [] },
  csrfToken: 'ephemeral-control-nonce', ...extra });
const response = (data, ok = true) => ({ ok, json: async () => structuredClone(data) });
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { promise, resolve }; };

// Instrumented DOM: there is deliberately no HTML parser or innerHTML escape
// hatch. Any attempted markup injection through the renderer throws.
class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this._text = ''; this.hidden = false; }
  set innerHTML(_) { throw Error('Dynamic HTML is forbidden'); }
  get textContent() { return this._text + this.children.map(x => x.textContent).join(''); }
  set textContent(value) { this._text = String(value); this.children = []; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}
function view() {
  const nodes = new Map();
  return createView({ getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: tag => new Node(tag) });
}

test('hostile status text stays literal and CSRF credentials never enter rendered text', () => {
  const v = view(), hostile = '<img src=x onerror=alert(1)>';
  const data = snapshot(); data.clients[0].account = hostile; data.clients[0].lastDecision = hostile;
  data.events[0].reason = hostile; data.channels[0].waiting = [{ account: hostile, kind: 'constructor', reason: hostile }];
  renderHost(v, { data, network: 'online', controlPending: false, controlError: '' }, now);
  const visible = Object.values(v.nodes).map(node => node.textContent).join('\n');
  assert.ok(visible.includes(hostile));
  assert.ok(!visible.includes(data.csrfToken));
  assert.equal(v.nodes['host-status'].textContent, 'Host online');
  assert.equal(v.nodes['coordination-toggle'].disabled, false);
});

test('chat connectivity does not imply playing video or eligibility for a turn', () => {
  const v = view(), data = snapshot(); data.clients[0].playback = 'paused'; data.clients[0].ready = false;
  renderHost(v, { data, network: 'online', controlPending: false, controlError: '' }, now);
  const card = v.nodes.accounts.textContent;
  assert.ok(card.includes('Connected')); assert.ok(card.includes('Paused')); assert.ok(card.includes('Waiting'));
  assert.ok(!card.includes('Ready for a turn'));
  data.clients[0].lastSeenAt = new Date(now - 60000).toISOString();
  renderHost(v, { data, network: 'online', controlPending: false, controlError: '' }, now);
  assert.ok(v.nodes.accounts.textContent.includes('Check-in stale'));
  assert.ok(v.nodes.accounts.textContent.includes('Last: connected'));
});

test('global coordination pause holds an otherwise ready account without claiming its chat disconnected', () => {
  const v = view(); renderHost(v, { data: snapshot({ paused: true }), network: 'online', controlPending: false, controlError: '' }, now);
  assert.ok(v.nodes.accounts.textContent.includes('On hold'));
  assert.ok(v.nodes.accounts.textContent.includes('Connected'));
  assert.ok(!v.nodes.accounts.textContent.includes('Ready for a turn'));
  assert.equal(v.nodes['coordination-toggle'].textContent, 'Resume coordination');
});

test('a failed refresh preserves last-known cards while marking them stale and disabling controls', async () => {
  let fail = false;
  const controller = createController({ now: () => now, fetchImpl: async () => { if (fail) throw Error('private diagnostic must not render'); return response(snapshot()); } });
  await controller.refresh(); fail = true; await controller.refresh();
  const state = controller.getState(); assert.equal(state.network, 'offline'); assert.ok(state.data);
  const v = view(); renderHost(v, state, now);
  assert.equal(v.nodes['host-status'].textContent, 'Host unavailable');
  assert.equal(v.nodes['coordination-toggle'].disabled, true);
  assert.equal(v.nodes['connection-notice'].hidden, false);
  assert.ok(v.nodes.accounts.textContent.includes('Status stale'));
  assert.ok(!Object.values(v.nodes).some(node => node.textContent.includes('private diagnostic')));
});

test('old or future host timestamps disable control without appearing healthy', async () => {
  for (const at of [now - 10001, now + 5001]) {
    const controller = createController({ now: () => now, fetchImpl: async () => response(snapshot({ updatedAt: new Date(at).toISOString() })) });
    await controller.refresh(); assert.equal(controller.getState().network, 'stale'); assert.equal(controller.canControl(), false);
  }
});

test('repeated pause clicks send one request and confirm via a fresh status read', async () => {
  const held = deferred(); let posts = 0, paused = false; const calls = [];
  const controller = createController({ now: () => now, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url === '/api/control') { posts++; await held.promise; paused = true; return response({ ok: true }); }
    return response(snapshot({ paused }));
  } });
  await controller.refresh();
  const first = controller.toggle(); assert.equal(controller.getState().controlPending, true);
  assert.equal(await controller.toggle(), false); assert.equal(posts, 1);
  held.resolve(); assert.equal(await first, true);
  assert.equal(controller.getState().data.paused, true); assert.equal(controller.getState().controlPending, false);
  const request = calls.find(x => x.url === '/api/control');
  assert.equal(request.options.headers['X-CSRF-Token'], 'ephemeral-control-nonce');
  assert.deepEqual(JSON.parse(request.options.body), { paused: true });
});

test('a status read started before a pause cannot be mistaken for control confirmation', async () => {
  const oldRead = deferred(); let getCount = 0, paused = false;
  const controller = createController({ now: () => now, fetchImpl: async url => {
    if (url === '/api/control') { paused = true; return response({ ok: true }); }
    if (++getCount === 2) return oldRead.promise;
    return response(snapshot({ paused }));
  } });
  await controller.refresh(); const previous = controller.refresh(); const control = controller.toggle();
  oldRead.resolve(response(snapshot({ paused: false }))); await previous; await control;
  assert.equal(getCount, 3); assert.equal(controller.getState().data.paused, true);
});

test('control errors never claim a pause succeeded and public errors contain no provider diagnostics', async () => {
  const controller = createController({ now: () => now, fetchImpl: async url => url === '/api/control'
    ? response({ error: 'secret internal detail' }, false) : response(snapshot()) });
  await controller.refresh(); assert.equal(await controller.toggle(), false);
  assert.equal(controller.getState().data.paused, false);
  assert.ok(controller.getState().controlError); assert.ok(!controller.getState().controlError.includes('secret'));
});

test('time labels are bounded and malformed times remain unverified', () => {
  assert.equal(relativeAge(null, now), 'No check-in');
  assert.equal(relativeAge(new Date(now - 12000).toISOString(), now), '12s ago');
  assert.equal(remaining(new Date(now + 61000).toISOString(), now), '1m 1s');
  assert.equal(remaining('not-a-date', now), '');
});

test('exchange settings and waiting reasons render literally without hiding their bot identity or limits', async () => {
  const v = view(), data = snapshot(), hostile = '<script>steal()</script>';
  data.exchanges.enabled = true; data.exchanges.channels = [{ channel: hostile, state: 'waiting_for_partners', nextAt: null,
    reason: hostile, usedScenes: 2, totalScenes: 10 }];
  renderHost(v, { data, network: 'online', controlPending: false, controlError: '' }, now);
  assert.equal(v.nodes['exchange-state'].textContent, 'Enabled');
  assert.equal(v.nodes['exchange-toggle'].textContent, 'Disable bot exchanges');
  assert.ok(v.nodes['exchange-channels'].textContent.includes(hostile));
  assert.ok(v.nodes['exchange-channels'].textContent.includes('Waiting for both companions'));
  assert.ok(v.nodes['exchange-channels'].textContent.includes('2 / 10 scenes used'));
  assert.equal(v.nodes['exchange-policy'].textContent, 'At most 2 lines · 60–120 minutes between exchanges · 3–6 minutes between lines');
  const { readFile } = await import('node:fs/promises');
  const markup = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(markup.includes('Every public line starts with <code>[companion bot]</code>'));
  assert.ok(markup.includes('both companions are running on the same live broadcast'));
});

test('exchange toggle sends one exact-key request and holds the pause control during its mutation', async () => {
  const held = deferred(); let enabled = false, posts = 0; const bodies = [];
  const controller = createController({ now: () => now, fetchImpl: async (url, options) => {
    if (url === '/api/control') { posts++; bodies.push(JSON.parse(options.body)); await held.promise; enabled = true; return response({ ok: true }); }
    const data = snapshot(); data.exchanges.enabled = enabled; return response(data);
  } });
  await controller.refresh(); const exchange = controller.toggleExchanges();
  assert.equal(controller.getState().controlKind, 'exchangesEnabled');
  assert.equal(await controller.toggle(), false); assert.equal(await controller.toggleExchanges(), false);
  const v = view(); renderHost(v, controller.getState(), now);
  assert.equal(v.nodes['coordination-toggle'].disabled, true);
  assert.equal(v.nodes['exchange-toggle'].disabled, true);
  assert.equal(v.nodes['coordination-toggle'].textContent, 'Pause coordination');
  assert.equal(v.nodes['exchange-toggle'].textContent, 'Enabling…');
  held.resolve(); assert.equal(await exchange, true); assert.equal(posts, 1);
  assert.deepEqual(bodies, [{ exchangesEnabled: true }]);
  assert.equal(controller.getState().data.exchanges.enabled, true);
});

test('pause mutation blocks exchange changes and enabled exchanges stay held by central pause', async () => {
  const held = deferred(); let paused = false;
  const controller = createController({ now: () => now, fetchImpl: async url => {
    if (url === '/api/control') { await held.promise; paused = true; return response({ ok: true }); }
    const data = snapshot({ paused }); data.exchanges.enabled = true; return response(data);
  } });
  await controller.refresh(); const pause = controller.toggle();
  assert.equal(await controller.toggleExchanges(), false); held.resolve(); await pause;
  const v = view(); renderHost(v, controller.getState(), now);
  assert.equal(v.nodes['exchange-state'].textContent, 'Enabled · on hold');
  assert.equal(v.nodes['exchange-toggle'].textContent, 'Disable bot exchanges');
});

test('stale or missing exchange state cannot enable the feature', async () => {
  let posts = 0;
  const controller = createController({ now: () => now, fetchImpl: async url => {
    if (url === '/api/control') { posts++; return response({ ok: true }); }
    return response(snapshot({ updatedAt: new Date(now - 15000).toISOString() }));
  } });
  await controller.refresh(); assert.equal(await controller.toggleExchanges(), false); assert.equal(posts, 0);
  const v = view(); renderHost(v, controller.getState(), now);
  assert.equal(v.nodes['exchange-toggle'].disabled, true); assert.equal(v.nodes['exchange-state'].textContent, 'Status stale');
  renderHost(v, { data: snapshot({ exchanges: undefined }), network: 'online', controlPending: false, controlError: '' }, now);
  assert.equal(v.nodes['exchange-toggle'].disabled, true); assert.equal(v.nodes['exchange-state'].textContent, 'Feature unavailable');
});

test('an accepted control without a confirming exchange setting is not presented as success', async () => {
  const controller = createController({ now: () => now, fetchImpl: async url => response(url === '/api/control' ? { ok: true } : snapshot()) });
  await controller.refresh(); assert.equal(await controller.toggleExchanges(), false);
  assert.equal(controller.getState().data.exchanges.enabled, false);
  assert.ok(controller.getState().controlError.includes('not confirmed'));
});
