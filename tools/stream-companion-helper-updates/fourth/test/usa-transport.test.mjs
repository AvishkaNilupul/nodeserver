import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createUsTransport, blockedUsTransport } from '../lib/usa-transport.mjs';
import { TwitchChat } from '../lib/twitch.mjs';
import { createHelper } from '../server.mjs';

const CLIENT = 'testclient1234', SESSION = 'browser-session-0001';
const form = { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ client_id: CLIENT, scopes: 'user:read:chat user:write:chat' }).toString() };
const endpoint = 'https://id.twitch.tv/oauth2/device';
const jsonResult = body => ({ ok: true, status: 200, headers: [['content-type', 'application/json']], body: JSON.stringify(body) });
function harness(t, options = {}) {
  let time = 1_800_000_000_000;
  const relay = createUsTransport({ now: () => time, ...options }); t.after(() => relay.close());
  let session = SESSION, epoch;
  const proof = () => ({ ip: '203.0.113.17', loc: 'US', checkedAt: time });
  const poll = (value = proof()) => { const result = relay.poll({ sessionId: session, ...(epoch ? { epoch } : {}), proof: value }); epoch = result.epoch; return result; };
  const begin = (job, value = proof()) => relay.begin({ sessionId: session, epoch, id: job.id, proof: value });
  const complete = (job, result) => relay.complete({ sessionId: session, epoch, id: job.id, result });
  const event = (socketId, seq, value) => relay.event({ sessionId: session, epoch, socketId, seq, event: value });
  const operation = () => { const promise = relay.fetch(endpoint, form); promise.catch(() => {}); return promise; };
  const open = async () => {
    const socket = new relay.WebSocket('wss://eventsub.wss.twitch.tv/ws');
    const job = poll().job; begin(job); complete(job, { ok: true });
    event(job.socketId, 1, { type: 'open' }); await Promise.resolve(); return { socket, job };
  };
  return { relay, poll, begin, complete, event, operation, open, proof,
    advance: value => { time += value; }, rotate: value => { session = value; epoch = undefined; return poll(); },
    raw: () => ({ sessionId: session, epoch }) };
}

test('module, blocked Twitch defaults and missing browser lease never use Node network', async t => {
  const originalFetch = globalThis.fetch, originalSocket = globalThis.WebSocket; let direct = 0;
  globalThis.fetch = () => { direct++; throw Error('direct network'); };
  globalThis.WebSocket = class { constructor() { direct++; throw Error('direct socket'); } };
  t.after(() => { globalThis.fetch = originalFetch; globalThis.WebSocket = originalSocket; });
  const h = harness(t);
  await assert.rejects(h.operation(), error => error.notSubmitted === true);
  await assert.rejects(blockedUsTransport.fetch(endpoint, form));
  assert.throws(() => new blockedUsTransport.WebSocket('wss://eventsub.wss.twitch.tv/ws'));
  const twitch = new TwitchChat();
  await assert.rejects(twitch.startAuthorization(CLIENT, 'igores0minekill'), error => error.providerNotSubmitted === true && !error.message.includes(CLIENT));
  assert.equal(direct, 0); assert.equal(h.relay.status().state, 'held');
});

test('HTTP is issued once, begins once, and exact completion replay only acknowledges', async t => {
  const h = harness(t); h.poll(); const promise = h.operation(), job = h.poll().job;
  assert.equal(job.url, endpoint); assert.equal(job.method, 'POST'); assert.equal(job.body, form.body);
  assert.deepEqual(job.headers, [['content-type', 'application/x-www-form-urlencoded']]);
  assert.equal(h.poll().job, null); assert.equal(h.begin(job).ok, true); assert.throws(() => h.begin(job));
  const result = jsonResult({ device_code: 'test-only-code' });
  assert.deepEqual(h.complete(job, result), { ok: true });
  assert.deepEqual(h.complete(job, result), { ok: true });
  assert.throws(() => h.complete(job, jsonResult({ device_code: 'changed' })));
  assert.deepEqual(await (await promise).json(), { device_code: 'test-only-code' });
  assert.equal(h.poll().job, null); assert.equal(h.relay.status().pending, 0);
});

test('USA proof is strict and missing proof cannot release a queued OAuth request', async t => {
  const h = harness(t); h.poll(null); const promise = h.operation();
  assert.equal(h.poll(null).needsProof, true); assert.equal(h.poll(null).job, null);
  for (const proof of [{ ...h.proof(), loc: 'CA' }, { ...h.proof(), ip: 'invalid' }, { ...h.proof(), checkedAt: h.proof().checkedAt + 2001 }, { ...h.proof(), extra: true }]) assert.throws(() => h.poll(proof));
  const job = h.poll().job; h.advance(5001);
  assert.throws(() => h.begin(job, { ...h.proof(), checkedAt: h.proof().checkedAt - 5001 }));
  h.relay.invalidate(); await assert.rejects(promise, error => error.notSubmitted === true);
});

test('lost poll response does not redeliver, and expiry is a certified no-send', async t => {
  const h = harness(t); h.poll(); const promise = h.operation(), job = h.poll().job;
  assert.ok(job.id); assert.equal(h.poll().job, null); h.advance(10_001); h.poll();
  await assert.rejects(promise, error => error.notSubmitted === true);
  assert.throws(() => h.begin(job)); assert.equal(h.poll().job, null);
});

test('lost begin or provider response is terminal unknown and cannot be replayed', async t => {
  const h = harness(t); h.poll(); const promise = h.operation(), job = h.poll().job;
  h.begin(job); assert.throws(() => h.begin(job)); h.advance(10_001); h.poll();
  await assert.rejects(promise, error => error.notSubmitted === false);
  assert.throws(() => h.complete(job, jsonResult({}))); assert.equal(h.poll().job, null);
});

test('Stop while browser attests prevents late begin using both generation fences', async t => {
  for (const which of ['twitch', 'control']) {
    const h = harness(t); let generation = 1, controlGeneration = 'initial';
    h.relay.bind({ getGeneration: () => generation, getControlGeneration: () => controlGeneration });
    h.poll(); const promise = h.operation(), job = h.poll().job;
    if (which === 'twitch') generation++; else controlGeneration = 'stopped';
    assert.throws(() => h.begin(job)); await assert.rejects(promise, error => error.notSubmitted === true);
  }
});

test('disconnect invalidates begun and queued work and old-epoch results remain inert', async t => {
  const h = harness(t); h.poll(); const first = h.operation(), job = h.poll().job;
  h.begin(job); const queued = h.operation(); const old = h.raw(); h.relay.invalidate();
  await assert.rejects(first, error => error.notSubmitted === false); await assert.rejects(queued, error => error.notSubmitted === true);
  assert.throws(() => h.relay.complete({ ...old, id: job.id, result: jsonResult({}) }));
  assert.equal(h.poll().job, null); assert.notEqual(h.raw().epoch, old.epoch);
});

test('retired worker cannot reclaim work; bounded retirement expires after all old deadlines', async t => {
  const h = harness(t); h.poll(); const promise = h.operation(), job = h.poll().job, old = h.raw();
  h.rotate('browser-session-0002'); await assert.rejects(promise, error => error.notSubmitted === true);
  assert.throws(() => h.relay.poll({ ...old, proof: h.proof() }));
  assert.throws(() => h.relay.begin({ ...old, id: job.id, proof: h.proof() }));
  for (let i = 3; i <= 513; i++) h.rotate(`browser-session-${String(i).padStart(4, '0')}`);
  assert.throws(() => h.rotate('browser-session-0514'));
  h.advance(60_001); assert.equal(h.rotate('browser-session-0515').ok, true);
  const next = h.operation(), nextJob = h.poll().job; h.begin(nextJob); h.complete(nextJob, jsonResult({ recovered: true }));
  assert.deepEqual(await (await next).json(), { recovered: true });
});

test('aborting before begin certifies no-send; aborting after begin stays unknown', async t => {
  const h = harness(t); h.poll();
  for (const begun of [false, true]) {
    const controller = new AbortController(), promise = h.relay.fetch(endpoint, { ...form, signal: controller.signal }); promise.catch(() => {});
    const job = h.poll().job; if (begun) h.begin(job); controller.abort();
    await assert.rejects(promise, error => error.notSubmitted === !begun);
    assert.throws(() => h.complete(job, jsonResult({}))); h.poll();
  }
});

test('WebSocket facade relays only ordered, bounded, exactly deduplicated events', async t => {
  const h = harness(t); h.poll(); const { socket, job } = await h.open();
  assert.ok(socket instanceof EventTarget); assert.equal(socket.readyState, socket.OPEN);
  const seen = []; socket.addEventListener('message', event => seen.push(event.data));
  const message = { type: 'message', data: '{"event":"hello"}' };
  assert.deepEqual(h.event(job.socketId, 2, message), { ok: true, seq: 2 });
  h.event(job.socketId, 2, message); assert.deepEqual(seen, [message.data]);
  assert.throws(() => h.event(job.socketId, 2, { type: 'message', data: 'changed' }));
  assert.throws(() => h.event(job.socketId, 4, message));
  assert.throws(() => h.event(job.socketId, 3, { type: 'message', data: 'x'.repeat(65537) }));
  let closed = 0; socket.addEventListener('close', () => closed++);
  h.event(job.socketId, 3, { type: 'close', code: 1000, wasClean: true });
  h.event(job.socketId, 3, { type: 'close', code: 1000, wasClean: true });
  await Promise.resolve(); assert.equal(closed, 1); assert.equal(socket.readyState, socket.CLOSED);
});

test('socket send and close are fixed jobs; cleanup begin accepts null proof', async t => {
  const h = harness(t); h.poll(); const { socket } = await h.open();
  socket.send('heartbeat'); const send = h.poll().job; assert.equal(send.kind, 'ws-send'); assert.equal(send.data, 'heartbeat');
  h.begin(send); h.complete(send, { ok: true });
  assert.throws(() => socket.send('x'.repeat(65537))); assert.throws(() => socket.close(1006));
  socket.close(1000, 'done'); const close = h.poll().job; assert.equal(close.kind, 'ws-close');
  h.begin(close, null); h.complete(close, { ok: true }); await Promise.resolve(); assert.equal(socket.readyState, socket.CLOSED);
});

test('freshness expiry closes sockets independently of the browser lease', async t => {
  const h = harness(t); h.poll(); const { socket, job } = await h.open(); const old = h.raw();
  h.advance(5001); assert.equal(h.relay.status().state, 'held'); await Promise.resolve();
  assert.equal(socket.readyState, socket.CLOSED); assert.equal(h.relay.status().browserOnline, true);
  assert.throws(() => h.relay.event({ ...old, socketId: job.socketId, seq: 2, event: { type: 'open' } }));
});

test('lease expiry fences pending work even when supplied proof was fresh', async t => {
  const h = harness(t); h.poll(); const promise = h.operation(), job = h.poll().job; h.begin(job);
  h.advance(15_001); assert.equal(h.relay.status().browserOnline, false);
  await assert.rejects(promise, error => error.notSubmitted === false);
});

test('targets, redirects, headers, request shapes and response limits fail closed without secret echo', async t => {
  const h = harness(t); h.poll();
  for (const [url, options] of [['https://example.com/', {}], [endpoint, { ...form, redirect: 'follow' }],
    [endpoint, { ...form, headers: { ...form.headers, Cookie: 'private-secret' } }],
    [endpoint, { ...form, body: `${form.body}&unknown=private-secret` }],
    ['https://api.twitch.tv/helix/users?login=alice&login=bob', { headers: { Authorization: 'Bearer private-secret', 'Client-Id': CLIENT } }]]) {
    await assert.rejects(h.relay.fetch(url, options), error => !error.message.includes('private-secret'));
  }
  for (const url of ['wss://example.com/ws', 'wss://eventsub.wss.twitch.tv/other', 'wss://eventsub.wss.twitch.tv/ws#bad']) assert.throws(() => new h.relay.WebSocket(url));
  const promise = h.operation(), job = h.poll().job; h.begin(job);
  for (const result of [jsonResult('x'.repeat(262145)), { ...jsonResult({}), status: 302, headers: [['location', 'https://evil.example/']] },
    { ...jsonResult({}), headers: [['content-type', 'text/plain\r\nsecret']] }]) assert.throws(() => h.complete(job, result));
  h.complete(job, { ok: false, code: 'bad_response' }); await assert.rejects(promise, error => error.notSubmitted === false);
  assert.equal(JSON.stringify(h.relay.status()).includes('private-secret'), false);
});

test('queues and active sockets are finite, and completing sockets does not exhaust future capacity', async t => {
  const h = harness(t); h.poll(); const pending = Array.from({ length: 32 }, h.operation);
  await assert.rejects(h.operation()); h.relay.invalidate(); await Promise.allSettled(pending); h.poll();
  for (let i = 0; i < 70; i++) { const { socket, job } = await h.open(); h.event(job.socketId, 2, { type: 'close', code: 1000, wasClean: true }); assert.equal(socket.readyState, 3); }
  const sockets = []; for (let i = 0; i < 4; i++) sockets.push(new h.relay.WebSocket('wss://eventsub.wss.twitch.tv/ws?reconnect=test'));
  assert.throws(() => new h.relay.WebSocket('wss://eventsub.wss.twitch.tv/ws'));
});

test('paired helper relay routes enforce Host/Origin/token and Stop cancels leased jobs', async t => {
  const relay = createUsTransport(); const server = createHelper({ config: { extensionId: 'unit-test', pairingToken: 'local-test' }, usaTransport: relay });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const post = (path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: {
      Host: '127.0.0.1:8797', Origin: 'chrome-extension://unit-test', Authorization: 'Bearer local-test', 'Content-Type': 'application/json', ...headers
    } }, res => { let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) })); });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  for (const action of ['poll', 'begin', 'complete', 'event']) {
    const path = `/api/usa-transport/${action}`;
    assert.equal((await post(path, {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post(path, {}, { Authorization: 'Bearer wrong' })).status, 401);
    assert.equal((await post(path, {}, { Host: 'evil.example' })).status, 403);
  }
  const proof = { ip: '203.0.113.17', loc: 'US', checkedAt: Date.now() };
  const first = (await post('/api/usa-transport/poll', { sessionId: SESSION, proof })).data;
  const promise = relay.fetch(endpoint, form); promise.catch(() => {});
  const job = (await post('/api/usa-transport/poll', { sessionId: SESSION, epoch: first.epoch, proof })).data.job;
  assert.ok(job.id); assert.equal((await post('/api/twitch/disconnect', {})).status, 200);
  assert.equal((await post('/api/usa-transport/begin', { sessionId: SESSION, epoch: first.epoch, id: job.id, proof })).status, 409);
  await assert.rejects(promise, error => error.notSubmitted === true);
});

test('pending socket setup deadline fences late open and permits a clean new attempt', async t => {
  const timers = new Set();
  const h = harness(t, { setTimer: fn => { timers.add(fn); return fn; }, clearTimer: fn => timers.delete(fn) });
  h.poll(); const socket = new h.relay.WebSocket('wss://eventsub.wss.twitch.tv/ws'), job = h.poll().job;
  h.begin(job); h.complete(job, { ok: true }); const old = h.raw();
  for (const fn of [...timers]) fn(); await Promise.resolve();
  assert.equal(socket.readyState, 3); assert.throws(() => h.relay.event({ ...old, socketId: job.socketId, seq: 1, event: { type: 'open' } }));
  h.poll(); const recovered = await h.open(); assert.equal(recovered.socket.readyState, 1);
});
