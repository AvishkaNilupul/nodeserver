import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannelDirectory } from '../lib/channels.mjs';

const NOW = Date.parse('2026-11-25T06:00:00Z');
const response = (data, options = {}) => new Response(JSON.stringify(data), { status: 200, ...options });
const user = (login = 'aviskarex', stream = null) => ({ login, displayName: 'Avi', broadcastSettings: { title: 'ROB RUN', game: { name: 'ROB RUN' } }, stream });
const live = (login = 'live_streamer') => ({ node: { id: '123456', viewersCount: 420, game: { name: 'Art' }, broadcaster: { login, displayName: 'Live Streamer', broadcastSettings: { title: 'Drawing' } } } });

test('directory pins aviskarex even offline and projects live metadata without upstream extras', async () => {
  const calls = [];
  const directory = createChannelDirectory({ now: () => NOW, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    const body = JSON.parse(options.body);
    return response(body.variables.login ? { data: { user: { ...user(), accessToken: 'SHOULD_NOT_LEAK' } } }
      : { data: { streams: { edges: [live(), live('aviskarex'), live(), live('bad/login')] } }, extensions: { private: 'SHOULD_NOT_LEAK' } });
  } });
  const result = await directory.snapshot();
  assert.deepEqual(result.channels.map(x => x.login), ['aviskarex', 'live_streamer']);
  assert.equal(result.channels[0].isLive, false); assert.equal(result.channels[0].viewers, 0);
  assert.equal(result.channels[1].isLive, true); assert.equal(result.channels[1].game, 'Art');
  assert.equal(result.updatedAt, '2026-11-25T06:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /SHOULD_NOT_LEAK|accessToken/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, 'https://gql.twitch.tv/gql'); assert.equal(call.method, 'POST');
    assert.equal(call.redirect, 'error'); assert.equal(call.credentials, 'omit');
    assert.deepEqual(Object.keys(call.headers).sort(), ['Client-Id', 'Content-Type']);
  }
});

test('lookup needs an exact canonical channel login and never interprets a failed response as offline', async () => {
  let count = 0;
  const directory = createChannelDirectory({ now: () => NOW, fetchImpl: async () => { count++; throw Error('SECRET_UPSTREAM_DIAGNOSTIC'); } });
  for (const input of ['', 'ab', '../bad', 'https://twitch.tv/name', 'AvIsKaReX', 'x'.repeat(26), null]) await assert.rejects(directory.lookup(input), { status: 400 });
  assert.equal(count, 0);
  const result = await directory.lookup('aviskarex');
  assert.equal(result.isLive, null); assert.equal(result.viewers, null);
  assert.doesNotMatch(JSON.stringify(result), /SECRET_UPSTREAM_DIAGNOSTIC/);
});

test('lookup confirms live/offline only from matching valid user and stream records', async () => {
  let payload;
  const directory = createChannelDirectory({ now: () => NOW, cacheMs: 0, fetchImpl: async () => response(payload) });
  payload = { data: { user: user('aviskarex', { id: '91234', viewersCount: 17, game: { name: 'Art' } }) } };
  assert.deepEqual(await directory.lookup('aviskarex'), { login: 'aviskarex', displayName: 'Avi', title: 'ROB RUN', game: 'Art', viewers: 17, isLive: true, checkedAt: NOW });
  for (const invalid of [null, {}, { stream: null }, user('wrong_login'), user('aviskarex', {}), { ...user(), stream: undefined }]) {
    payload = { data: { user: invalid } };
    assert.equal((await directory.lookup('aviskarex')).isLive, null);
  }
  payload = { data: { user: user() } };
  assert.equal((await directory.lookup('aviskarex')).isLive, false);
});

test('cache coalesces reads, isolates returned values and expires without turning clock rollback into freshness', async () => {
  let clock = NOW, calls = 0;
  const directory = createChannelDirectory({ now: () => clock, fetchImpl: async (_url, options) => {
    calls++; await new Promise(resolve => setTimeout(resolve, 3));
    return response(JSON.parse(options.body).variables.login ? { data: { user: user() } } : { data: { streams: { edges: [] } } });
  } });
  const [a, b] = await Promise.all([directory.snapshot(), directory.snapshot()]);
  assert.equal(calls, 2); a.channels[0].displayName = 'MUTATED'; assert.equal(b.channels[0].displayName, 'Avi');
  assert.equal((await directory.lookup('aviskarex')).displayName, 'Avi'); assert.equal(calls, 2);
  clock += 30001; await directory.snapshot(); assert.equal(calls, 4);
  clock = NOW - 1; await directory.lookup('aviskarex'); assert.equal(calls, 5);
});

test('HTTP, malformed JSON, GraphQL errors and oversized payloads produce bounded unknown status', async () => {
  const bad = [
    () => response({ data: { user: user() } }, { status: 429 }),
    () => new Response('NOT_JSON_PRIVATE', { status: 200 }),
    () => response({ data: { user: user() }, errors: [{ message: 'PRIVATE_GQL' }] }),
    () => response({ data: {} }),
    () => response({ data: { user: user() }, padding: 'x'.repeat(200000) }),
    () => response({ data: { user: user() } }, { headers: { 'content-length': '200000' } })
  ];
  for (const fetchImpl of bad) {
    const directory = createChannelDirectory({ now: () => NOW, fetchImpl });
    const result = await directory.lookup('aviskarex');
    assert.equal(result.isLive, null); assert.doesNotMatch(JSON.stringify(result), /NOT_JSON_PRIVATE|PRIVATE_GQL/);
  }
});

test('timeout covers the response body as well as headers and aborts ignored fetch implementations', async () => {
  let signal;
  const directory = createChannelDirectory({ now: () => NOW, timeoutMs: 10, fetchImpl: (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  assert.equal((await directory.lookup('aviskarex')).isLive, null); assert.equal(signal.aborted, true);
  const stalledBody = createChannelDirectory({ now: () => NOW, timeoutMs: 10, fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }) });
  assert.equal((await stalledBody.lookup('aviskarex')).isLive, null);
});

test('directory failure preserves pinned status and leaves the account state untouched', async () => {
  const directory = createChannelDirectory({ now: () => NOW, fetchImpl: async (_url, options) => {
    return response(JSON.parse(options.body).variables.login ? { data: { user: user() } } : { errors: [{ message: 'PRIVATE_DIRECTORY' }] });
  } });
  const result = await directory.snapshot();
  assert.equal(result.channels.length, 1); assert.equal(result.channels[0].isLive, false);
  assert.match(result.error, /temporarily unavailable/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIRECTORY/);
});
