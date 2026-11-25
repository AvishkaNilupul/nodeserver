import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ViewerClips } from '../lib/clips.mjs';
import { TwitchChat, chatScopes } from '../lib/twitch.mjs';

const epoch = 1800000000000;
const input = { requestId: 'clip-request', channel: 'friend_channel', streamId: '456789', source: 'manual' };
function harness(t, options = {}) {
  let time = epoch, serial = 0;
  const timers = new Map(), calls = [], credentials = { account: 'companion_test', clientId: 'clientid12345', accessToken: 'test-access', refreshToken: 'test-refresh', userId: '123', scopes: [...chatScopes, 'clips:edit'] };
  const state = { authorized: true, account: credentials.account, connected: true, channel: input.channel,
    settings: { allowedChannel: input.channel, paused: false }, browser: { online: true, lastSeenAt: new Date(time).toISOString() },
    watch: { enabled: true, status: 'playing', channel: input.channel, checkedAt: time },
    streamContext: { channel: input.channel, streamId: input.streamId, isLive: true, checkedAt: time },
    coordination: { available: true, paused: false }, permissions: { playbackAccess: true }, controls: { pending: [] } };
  const control = { generation: 'intent-1', status: () => structuredClone(state) };
  const twitch = { credentials, prepareViewerClip: async (...args) => { calls.push(['prepare', ...args]); return { broadcasterId: '456', creatorId: '123' }; },
    createViewerClip: async (...args) => { calls.push(['create', ...args]); return 'SomeClip-Slug'; },
    getViewerClip: async (...args) => { calls.push(['get', ...args]); return { id: 'SomeClip-Slug', broadcasterId: '456', creatorId: '123' }; } };
  Object.assign(twitch, options.twitch || {});
  const dir = mkdtempSync(join(tmpdir(), 'viewer-clips-test-')), file = join(dir, 'jobs.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const settings = { twitch, control, file, now: () => time,
    setTimer: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay }); return id; }, clearTimer: id => timers.delete(id), ...options };
  const clips = new ViewerClips(settings); t.after(() => clips.close());
  const flush = async () => {
    const timer = timers.entries().next().value;
    if (!timer) return;
    timers.delete(timer[0]); timer[1].fn();
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
  };
  return { clips, settings, twitch, control, state, calls, file, timers, flush,
    advance: ms => { time += ms; }, now: () => time };
}

test('acknowledges durable queued job before Twitch, submits once and confirms the canonical URL', async t => {
  const h = harness(t), result = h.clips.create(input);
  assert.equal(result.job.state, 'queued'); assert.equal(h.calls.length, 0);
  assert.equal(JSON.parse(readFileSync(h.file)).jobs[0].state, 'queued'); assert.equal(statSync(h.file).mode & 0o777, 0o600);
  await h.flush();
  assert.equal(h.clips.status().jobs[0].state, 'confirmed'); assert.equal(h.clips.status().jobs[0].url, 'https://clips.twitch.tv/SomeClip-Slug');
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
  assert.equal(h.clips.create(input).job.state, 'confirmed'); await h.flush();
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
  assert.throws(() => h.clips.create({ ...input, channel: 'another_channel' }), /already belongs/);
});

test('malformed requests and every stale or mismatched live gate never submit', async t => {
  const h = harness(t);
  for (const change of [{ requestId: '' }, { channel: '../oops' }, { streamId: 'not-a-stream' }, { source: 'random' }, { extra: true }]) assert.throws(() => h.clips.create({ ...input, ...change }), /Invalid/);
  const original = structuredClone(h.state);
  for (const change of [
    { authorized: false }, { account: 'wrong_account' }, { browser: { online: false } },
    { browser: { online: true, lastSeenAt: new Date(epoch - 45001).toISOString() } }, { permissions: { playbackAccess: false } },
    { settings: { allowedChannel: 'wrong_channel' } }, { watch: { ...original.watch, status: 'ad' } },
    { watch: { ...original.watch, checkedAt: epoch - 15001 } }, { streamContext: { ...original.streamContext, streamId: '987' } },
    { streamContext: { ...original.streamContext, checkedAt: epoch - 90001 } }, { controls: { pending: [{ state: 'queued' }] } }
  ]) {
    Object.assign(h.state, structuredClone(original), change); assert.throws(() => h.clips.create(input));
  }
  assert.equal(h.calls.length, 0);
});

test('automatic clips require connected, unheld, resumed coordination; explicit manual clips may use held chat', async t => {
  const h = harness(t);
  h.state.connected = false; h.state.settings.paused = true; h.state.coordination.paused = true;
  assert.throws(() => h.clips.create({ ...input, source: 'automatic' }), /held/);
  assert.equal(h.clips.create(input).job.state, 'queued'); await h.flush();
  assert.equal(h.clips.status().jobs[0].state, 'confirmed');
});

test('Stop or channel change during asynchronous preparation cancels without a Create POST', async t => {
  let release;
  const h = harness(t, { twitch: { prepareViewerClip: () => new Promise(resolve => { release = resolve; }) } });
  // Overrides can replace only one method while retaining credentials and other fixture methods.
  h.clips.twitch = { ...h.twitch, credentials: { account: 'companion_test', accessToken: 'access', scopes: ['clips:edit'] } };
  h.clips.create(input);
  const flushing = h.flush();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.control.generation = 'intent-stop'; release({ broadcasterId: '456', creatorId: '123' }); await flushing;
  assert.equal(h.clips.status().jobs[0].state, 'cancelled'); assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 0);
});

test('unknown network submission remains consumed and is never retried', async t => {
  const h = harness(t); h.twitch.createViewerClip = async () => { h.calls.push(['create']); throw Object.assign(Error('lost response'), { uncertain: true }); };
  h.clips.create(input); await h.flush();
  assert.equal(h.clips.status().jobs[0].state, 'unknown');
  assert.throws(() => h.clips.create({ ...input, requestId: 'new-request' }), /ten minutes/);
  h.clips.create(input); await h.flush(); assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
});

test('known clipping restriction records failed and does not switch identity or retry', async t => {
  const h = harness(t); h.twitch.createViewerClip = async () => { h.calls.push(['create']); throw Error('Twitch refused clipping here.'); };
  h.clips.create(input); await h.flush();
  assert.equal(h.clips.status().jobs[0].state, 'failed'); assert.match(h.clips.status().jobs[0].error, /refused/);
  assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
});

test('a persistent journal failure before submission prevents Twitch entirely', async t => {
  const h = harness(t); h.clips.write = () => { throw Error('disk full'); };
  assert.throws(() => h.clips.create(input), /could not be saved/);
  await h.flush(); assert.equal(h.calls.length, 0); assert.equal(h.clips.status().authorized, false);
});

test('restart of queued/submitting jobs records unknown without any POST', async t => {
  const h = harness(t); h.clips.create(input); h.clips.close();
  const restored = new ViewerClips(h.settings); t.after(() => restored.close());
  assert.equal(restored.status().jobs[0].state, 'unknown'); await h.flush(); assert.equal(h.calls.length, 0);
});

test('restart with a known ID performs GET only, preserving confirmation deadline', async t => {
  const h = harness(t); h.twitch.getViewerClip = async () => null;
  h.clips.create(input); await h.flush(); assert.equal(h.clips.status().jobs[0].state, 'pending'); h.clips.close();
  h.twitch.getViewerClip = async () => { h.calls.push(['get']); return { id: 'SomeClip-Slug', broadcasterId: '456', creatorId: '123' }; };
  const restored = new ViewerClips(h.settings); t.after(() => restored.close()); await h.flush();
  assert.equal(restored.status().jobs[0].state, 'confirmed'); assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 1);
});

test('clip confirmation stops at sixty seconds and mismatch never produces a link', async t => {
  const h = harness(t); h.twitch.getViewerClip = async () => null;
  h.clips.create(input); await h.flush(); h.advance(60000); await h.flush();
  assert.equal(h.clips.status().jobs[0].state, 'unknown'); assert.equal(h.clips.status().jobs[0].url, '');
  const other = harness(t); other.twitch.getViewerClip = async () => ({ id: 'SomeClip-Slug', broadcasterId: '999', creatorId: '123' });
  other.clips.create(input); await other.flush(); assert.equal(other.clips.status().jobs[0].state, 'unknown'); assert.equal(other.clips.status().jobs[0].url, '');
});

test('corrupted journal fails closed without discarding stored data', t => {
  const h = harness(t); h.clips.close(); writeFileSync(h.file, '{broken');
  const restored = new ViewerClips(h.settings); t.after(() => restored.close());
  assert.equal(restored.status().authorized, false); assert.throws(() => restored.create(input), /unavailable/);
  assert.equal(readFileSync(h.file, 'utf8'), '{broken');
});

const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
function authHarness(t, { grantClips = false, save = async () => {} } = {}) {
  let time = epoch;
  const calls = [], credentials = { clientId: 'clientid12345', account: 'companion_test', accessToken: 'old-access', refreshToken: 'old-refresh', userId: '123' };
  const twitch = new TwitchChat({ credentials: { ...credentials }, now: () => time, saveCredentials: save, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/device')) return response({ device_code: 'private-device-code', user_code: 'PUBLIC123', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 });
    if (url.endsWith('/token')) return response({ access_token: 'new-access', refresh_token: 'new-refresh' });
    if (url.endsWith('/validate')) return response({ client_id: credentials.clientId, login: credentials.account, user_id: credentials.userId, scopes: [...chatScopes, ...(grantClips ? ['clips:edit'] : [])] });
    throw Error('Unexpected fixture request.');
  } });
  t.after(() => twitch.disconnect());
  return { twitch, calls, advance: ms => { time += ms; } };
}

test('normal chat authorization adds no clip scope; explicit enable requests all chat scopes plus clips', async t => {
  const h = authHarness(t, { grantClips: true });
  await h.twitch.startAuthorization('clientid12345', 'companion_test');
  assert.equal(new URLSearchParams(h.calls.at(-1).options.body).get('scopes'), chatScopes.join(' '));
  const publicFlow = await h.twitch.startAuthorization('clientid12345', 'companion_test', { clips: true });
  assert.equal('deviceCode' in publicFlow, false);
  assert.equal(new URLSearchParams(h.calls.at(-1).options.body).get('scopes'), [...chatScopes, 'clips:edit'].join(' '));
  h.advance(5000); await h.twitch.pollAuthorization();
  assert.equal(h.twitch.credentials.scopes.includes('clips:edit'), true);
  await h.twitch.startAuthorization('clientid12345', 'companion_test');
  assert.equal(new URLSearchParams(h.calls.at(-1).options.body).get('scopes'), [...chatScopes, 'clips:edit'].join(' '));
});

test('a missing clip grant or failed credential persistence leaves the old authorization intact', async t => {
  const missing = authHarness(t);
  await missing.twitch.startAuthorization('clientid12345', 'companion_test', { clips: true }); missing.advance(5000);
  await assert.rejects(missing.twitch.pollAuthorization(), /permissions/); assert.equal(missing.twitch.credentials.accessToken, 'old-access');
  const disk = authHarness(t, { grantClips: true, save: async () => { throw Error('disk failed'); } });
  await disk.twitch.startAuthorization('clientid12345', 'companion_test', { clips: true }); disk.advance(5000);
  await assert.rejects(disk.twitch.pollAuthorization(), /disk/); assert.equal(disk.twitch.credentials.accessToken, 'old-access');
});

test('clip API uses an explicit POST exactly once and never trusts remote clip URLs', async t => {
  let creates = 0, call;
  const h = authHarness(t, { grantClips: true });
  h.twitch.fetch = async (url, options) => { call = { url, options }; creates++; return response({ data: [{ id: 'Clip-Slug', edit_url: 'https://evil.invalid/' }] }, 202); };
  assert.equal(await h.twitch.createViewerClip('456'), 'Clip-Slug'); assert.equal(call.options.method, 'POST'); assert.match(call.url, /clips\?broadcaster_id=456&duration=30$/); assert.equal(creates, 1);
  h.twitch.fetch = async () => { creates++; throw Error('lost'); };
  await assert.rejects(h.twitch.createViewerClip('456'), e => e.uncertain === true); assert.equal(creates, 2);
});

test('automatic clipping rechecks shared pause immediately before submission', async t => {
  const h = harness(t); h.twitch.coordinator = { snapshot: () => ({ available: true, paused: true }) };
  h.twitch.refreshCoordination = async () => {};
  h.clips.create({ ...input, source: 'automatic' }); await h.flush();
  assert.equal(h.clips.status().jobs[0].state, 'cancelled'); assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 0);
  const active = harness(t); active.twitch.coordinator = { snapshot: () => ({ available: true, paused: false }), request: async () => ({ ok: true }) };
  active.twitch.refreshCoordination = async () => {};
  active.clips.create({ ...input, source: 'automatic' }); await active.flush();
  assert.equal(active.clips.status().jobs[0].state, 'confirmed');
});

test('Enable clips acknowledges slow device/token requests immediately, deduplicates flights and exposes only public fields', async t => {
  let deviceRelease, tokenRelease, starts = 0, polls = 0;
  const h = harness(t); h.state.connected = false; h.state.settings.paused = true;
  h.twitch.startAuthorization = async () => { starts++; return new Promise(resolve => { deviceRelease = resolve; }); };
  h.twitch.pollAuthorization = async ({ beforeSave }) => { polls++; await new Promise(resolve => { tokenRelease = resolve; }); beforeSave(); return { authorized: true }; };
  const start = h.clips.authorization({ action: 'start' });
  assert.equal(start.pending, true); assert.equal(start.pollAfterMs, 5000); assert.equal(starts, 1);
  h.clips.authorization({ action: 'start' }); assert.equal(starts, 1);
  h.twitch.pendingAuth = { scopes: [...chatScopes, 'clips:edit'], nextPoll: epoch, expires: epoch + 600000 };
  deviceRelease({ verificationUrl: 'https://www.twitch.tv/activate', userCode: 'PUBLIC123', expiresAt: epoch + 600000, pollAfterMs: 5000 });
  await h.clips.authFlight;
  const poll = h.clips.authorization({ action: 'poll' });
  assert.equal(poll.userCode, 'PUBLIC123'); assert.equal('deviceCode' in poll, false); assert.equal(polls, 1);
  h.clips.authorization({ action: 'poll' }); assert.equal(polls, 1);
  tokenRelease(); await h.clips.authFlight;
  assert.equal(h.clips.authorization({ action: 'poll' }).authorized, true);
  assert.equal(h.clips.authorization({ action: 'poll' }).pending, false);
  assert.equal(h.state.settings.paused, true); assert.equal(h.state.connected, false); assert.equal(h.control.generation, 'intent-1');
});

test('authorization cannot run active or after Stop changes its captured intent', async t => {
  const h = harness(t); assert.throws(() => h.clips.authorization({ action: 'start' }), /Stop/);
  h.state.connected = false; h.state.settings.paused = true;
  h.twitch.startAuthorization = async () => ({ verificationUrl: 'https://www.twitch.tv/activate', userCode: 'PUBLIC123', expiresAt: epoch + 600000, pollAfterMs: 5000 });
  h.clips.authorization({ action: 'start' }); await h.clips.authFlight;
  h.control.generation = 'new-intent';
  assert.throws(() => h.clips.authorization({ action: 'poll' }), /Stop/);
});

test('pausing during token validation prevents clip credentials from being persisted', async t => {
  const saved = [], h = authHarness(t, { grantClips: true, save: async value => saved.push(value) });
  await h.twitch.startAuthorization('clientid12345', 'companion_test', { clips: true }); h.advance(5000);
  await assert.rejects(h.twitch.pollAuthorization({ beforeSave: () => { throw Error('held intent changed'); } }), /intent changed/);
  assert.equal(saved.length, 0); assert.equal(h.twitch.credentials.accessToken, 'old-access');
});


test('a denied or unavailable final clip permit prevents automatic submission', async t => {
  for (const request of [async () => ({ ok: false }), async () => { throw Error('host unavailable'); }]) {
    const h = harness(t); h.twitch.coordinator = { snapshot: () => ({ available: true, paused: false }), request };
    h.twitch.refreshCoordination = async () => {};
    h.clips.create({ ...input, source: 'automatic' }); await h.flush();
    assert.equal(h.clips.status().jobs[0].state, 'cancelled');
    assert.equal(h.calls.filter(([kind]) => kind === 'create').length, 0);
  }
});
