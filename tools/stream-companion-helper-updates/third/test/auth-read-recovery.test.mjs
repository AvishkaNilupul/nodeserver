import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchChat, chatScopes } from '../lib/twitch.mjs';

const NOW = 1800000000000;
const original = { account: 'fixture_companion', clientId: 'fixtureclient123', userId: '123',
  accessToken: 'old-access', refreshToken: 'old-refresh', scopes: [...chatScopes, 'clips:edit'] };
const rotated = { access_token: 'rotated-access', refresh_token: 'rotated-refresh' };
const granted = { access_token: 'grant-access', refresh_token: 'grant-refresh' };
const response = (data = {}, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const identity = { client_id: original.clientId, login: original.account, user_id: original.userId, scopes: original.scopes };
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t, hook, { credentials = original } = {}) {
  const calls = [], saved = [], sockets = [];
  let saveHook, time = NOW;
  const client = new TwitchChat({ credentials: structuredClone(credentials), now: () => time,
    transport: { invalidate() {} }, setTimer: () => ({ unref() {} }), clearTimer() {},
    WebSocketImpl: class extends EventTarget { constructor() { super(); sockets.push(this); } close() {} },
    saveCredentials: async value => { await saveHook?.(value); saved.push(structuredClone(value)); },
    fetchImpl: async (url, options = {}) => {
      const parsed = new URL(url), op = parsed.pathname.split('/').pop();
      const call = { op, method: options.method || 'GET', authorization: options.headers?.Authorization || '',
        form: op === 'token' ? Object.fromEntries(new URLSearchParams(options.body)) : null };
      calls.push(call);
      const custom = await hook?.(call, client); if (custom) return custom;
      if (op === 'validate') return call.authorization === 'OAuth old-access' ? response({}, 401) : response(identity);
      if (op === 'token') return response(call.form.grant_type === 'refresh_token' ? rotated : granted);
      if (op === 'users') return call.authorization === 'Bearer old-access' ? response({}, 401) : response({ data: [{ id: '456', login: 'live_channel' }] });
      return response({}, 401);
    } });
  client.validatedAt = NOW - 1000;
  t.after(() => client.disconnect());
  return { client, calls, saved, sockets, save: fn => { saveHook = fn; }, setTime: value => { time = value; }, count: op => calls.filter(c => c.op === op).length,
    authorize: async () => {
      client.pendingAuth = { clientId: original.clientId, account: original.account, scopes: original.scopes,
        deviceCode: 'fixture-device', expires: NOW + 10000, nextPoll: 0, interval: 5000 };
      return client.pollAuthorization();
    } };
}

test('cached identity plus GET401 refreshes once, saves rotation, and reconnects without a new grant', async t => {
  const h = fixture(t); assert.equal((await h.client.connect(original.account, 'live_channel')).connecting, true);
  assert.equal(h.count('users'), 2); assert.equal(h.count('validate'), 2); assert.equal(h.count('token'), 1);
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].refreshToken, rotated.refresh_token);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.calls.find(c => c.op === 'token').form.client_secret, undefined);
});

test('non401 read failures never start authorization recovery', async t => {
  const h = fixture(t, call => call.op === 'users' ? response({}, call.authorization ? 503 : 200) : null);
  await assert.rejects(h.client.api('users?login=live_channel'), e => e.status === 503);
  assert.equal(h.calls.length, 1);
});

test('a successful GET uses its existing token without extra validation or refresh', async t => {
  const h = fixture(t, call => call.op === 'users' ? response({ data: [] }) : null);
  assert.deepEqual(await h.client.api('users?login=live_channel'), { data: [] });
  assert.equal(h.calls.length, 1); assert.equal(h.saved.length, 0);
});

test('concurrent GET401 responses share one refresh and each read retries only once', async t => {
  const h = fixture(t);
  await Promise.all([h.client.api('users?login=live_channel'), h.client.api('users?login=live_channel'), h.client.api('users?login=live_channel')]);
  assert.equal(h.count('users'), 6); assert.equal(h.count('validate'), 2); assert.equal(h.count('token'), 1); assert.equal(h.saved.length, 1);
});

test('an older pending validation cannot restore a cache that suppresses GET401 recovery', async t => {
  const gate = deferred(), entered = deferred(); let validations = 0;
  const h = fixture(t, call => { if (call.op === 'validate' && ++validations === 1) { entered.resolve(); return gate.promise; } });
  h.client.validatedAt = null;
  const older = h.client.ensureIdentity(original.account); await entered.promise;
  const read = h.client.api('users?login=live_channel');
  gate.resolve(response(identity)); await Promise.all([older, read]);
  assert.equal(h.count('validate'), 3); assert.equal(h.count('token'), 1); assert.equal(h.count('users'), 2);
});

test('a delayed401 for an already rotated token reuses the new grant without another refresh', async t => {
  const gate = deferred(), entered = deferred(); let reads = 0;
  const h = fixture(t, call => { if (call.op === 'users' && ++reads === 1) { entered.resolve(); return gate.promise; } });
  const read = h.client.api('users?login=live_channel'); await entered.promise;
  h.client.validatedAt = null; await h.client.ensureIdentity(original.account);
  gate.resolve(response({}, 401)); await read;
  assert.equal(h.count('token'), 1); assert.equal(h.count('validate'), 2); assert.equal(h.count('users'), 2);
});

test('a second GET401 is terminal after exactly one authorization recovery', async t => {
  const h = fixture(t, call => call.op === 'users' ? response({}, 401) : null);
  await assert.rejects(h.client.api('users?login=live_channel'), e => e.status === 401 && e.retryable === false && /no further retry/.test(e.message));
  assert.equal(h.count('users'), 2); assert.equal(h.count('token'), 1); assert.equal(h.saved.length, 1);
});

test('a rejected refresh is terminal without repeating the read or token POST', async t => {
  const h = fixture(t, call => call.op === 'token' ? response({}, 400) : null);
  await assert.rejects(h.client.api('users?login=live_channel'), /refresh was refused/);
  assert.equal(h.count('users'), 1); assert.equal(h.count('token'), 1); assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].refreshHeld, true);
});

for (const path of ['chat/messages', 'eventsub/subscriptions']) test(`${path} POST401 never refreshes or replays the mutation`, async t => {
  const h = fixture(t);
  await assert.rejects(h.client.api(path, { fixture: true }), e => e.status === 401 && /no automatic retry/.test(e.message));
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].method, 'POST'); assert.equal(h.saved.length, 0);
});

test('a denied clip POST never refreshes or repeats submission', async t => {
  const h = fixture(t);
  await assert.rejects(h.client.createViewerClip('456'), /permission expired/);
  assert.equal(h.count('clips'), 1); assert.equal(h.count('token'), 0); assert.equal(h.count('validate'), 0);
});

test('an uncertain mutation and an uncertain retried GET never make another provider attempt', async t => {
  const h = fixture(t, call => { if (call.op === 'messages' || call.op === 'users' && call.authorization !== 'Bearer old-access') throw Error('fixture lost response'); });
  await assert.rejects(h.client.api('chat/messages', { fixture: true }), /no automatic retry/);
  assert.equal(h.count('messages'), 1); assert.equal(h.count('token'), 0);
  await assert.rejects(h.client.api('users?login=live_channel'), /no automatic retry/);
  assert.equal(h.count('users'), 2); assert.equal(h.count('token'), 1);
});

test('Stop during the failed GET prevents validation, refresh, and read replay', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, call => { if (call.op === 'users') { entered.resolve(); return gate.promise; } });
  const read = h.client.api('users?login=live_channel'); await entered.promise;
  h.client.disconnect(); gate.resolve(response({}, 401));
  await assert.rejects(read, e => e.cancelled === true); assert.equal(h.calls.length, 1);
});

test('Stop during validation prevents a refresh POST and GET replay', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, call => { if (call.op === 'validate') { entered.resolve(); return gate.promise; } });
  const read = h.client.api('users?login=live_channel'); await entered.promise;
  h.client.disconnect(); gate.resolve(response({}, 401));
  await assert.rejects(read, e => e.cancelled === true); assert.equal(h.count('token'), 0); assert.equal(h.count('users'), 1);
});

test('Stop after refresh dispatch preserves its one-use rotation but prevents further network work', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, call => { if (call.op === 'token') { entered.resolve(); return gate.promise; } });
  const read = h.client.api('users?login=live_channel'); await entered.promise;
  h.client.disconnect(); gate.resolve(response(rotated));
  await assert.rejects(read, e => e.cancelled === true);
  assert.equal(h.saved.length, 1); assert.equal(h.client.credentials.refreshToken, rotated.refresh_token);
  assert.equal(h.count('validate'), 1); assert.equal(h.count('users'), 1); assert.equal(h.count('token'), 1);
});

test('a newer Start can use a rotation saved by an older stopped generation', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, call => { if (call.op === 'token') { entered.resolve(); return gate.promise; } });
  const read = h.client.api('users?login=live_channel'); const stopped = assert.rejects(read, e => e.cancelled === true);
  await entered.promise; h.client.disconnect();
  const starting = h.client.connect(original.account, 'live_channel');
  gate.resolve(response(rotated));
  await stopped; assert.equal((await starting).connecting, true);
  assert.equal(h.count('token'), 1); assert.equal(h.saved.length, 1); assert.equal(h.count('validate'), 2);
  assert.equal(h.count('users'), 2, 'only the new Start adds a fresh lookup'); assert.equal(h.sockets.length, 1);
});

for (const change of ['Stop', 'account', 'app']) test(`${change} between recovery resolution and API continuation prevents the retried GET`, async t => {
  const h = fixture(t), recover = h.client.recoverReadIdentity.bind(h.client);
  h.client.recoverReadIdentity = async (...args) => {
    const recovered = await recover(...args);
    queueMicrotask(() => {
      if (change === 'Stop') h.client.disconnect();
      if (change === 'account') h.client.credentials = { ...h.client.credentials, account: 'other_account' };
      if (change === 'app') h.client.credentials = { ...h.client.credentials, clientId: 'otherclient123' };
    });
    return recovered;
  };
  await assert.rejects(h.client.api('users?login=live_channel'), e => e.cancelled === true);
  assert.equal(h.count('users'), 1);
});

test('an old refresh completion never overwrites a newer explicit OAuth grant', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, call => { if (call.form?.grant_type === 'refresh_token') { entered.resolve(); return gate.promise; } });
  const read = h.client.api('users?login=live_channel'); await entered.promise;
  await h.authorize(); gate.resolve(response(rotated));
  await assert.rejects(read, e => e.cancelled === true);
  assert.equal(h.client.credentials.refreshToken, granted.refresh_token); assert.equal(h.saved.length, 1);
  assert.equal(h.saved[0].refreshToken, granted.refresh_token); assert.equal(h.count('users'), 1);
});

test('an explicit grant queued behind rotation persistence is the final durable credential pair', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t); h.save(async value => { if (value.refreshToken === rotated.refresh_token) { entered.resolve(); await gate.promise; } });
  const read = h.client.api('users?login=live_channel'); const outcome = read.catch(e => { assert.equal(e.cancelled, true); });
  await entered.promise; const authorization = h.authorize();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  gate.resolve(); await Promise.all([outcome, authorization]);
  assert.equal(h.saved[0].refreshToken, rotated.refresh_token); assert.equal(h.saved.at(-1).refreshToken, granted.refresh_token);
  assert.equal(h.client.credentials.refreshToken, granted.refresh_token);
});

test('clip-permission persistence queued behind a new grant cannot restore the old token', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t); h.save(async value => { if (value.refreshToken === granted.refresh_token) { entered.resolve(); await gate.promise; } });
  const authorization = h.authorize(); await entered.promise;
  const invalidation = h.client.invalidateClipPermission(original.accessToken);
  gate.resolve(); await Promise.all([authorization, invalidation]);
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].refreshToken, granted.refresh_token);
  assert.equal(h.client.credentials.clipPermissionInvalid, undefined); assert.ok(h.client.credentials.scopes.includes('clips:edit'));
});

test('rotation storage failure retains replacement tokens in memory and prevents subsequent network requests', async t => {
  const h = fixture(t); h.save(async () => { throw Error('fixture disk failure'); });
  await assert.rejects(h.client.api('users?login=live_channel'), /disk failure/);
  assert.equal(h.client.credentials.refreshToken, rotated.refresh_token);
  assert.equal(h.count('validate'), 1); assert.equal(h.count('users'), 1); assert.equal(h.count('token'), 1);
});

test('a same-account/app explicit grant between recovery and retry cancels the old read', async t => {
  const h = fixture(t), recover = h.client.recoverReadIdentity.bind(h.client);
  h.client.recoverReadIdentity = async (...args) => {
    const recovered = await recover(...args); assert.equal(Object.isFrozen(recovered), true);
    await h.authorize(); return recovered;
  };
  await assert.rejects(h.client.api('users?login=live_channel'), e => e.cancelled === true);
  assert.equal(h.count('users'), 1); assert.equal(h.client.credentials.refreshToken, granted.refresh_token);
});

test('a lost refresh response holds normal recovery and repeated inspection without replaying the old token', async t => {
  const h = fixture(t, call => { if (call.op === 'token') throw Error('fixture lost response'); });
  await assert.rejects(h.client.connect(original.account, 'live_channel'), e => e.uncertain === true && e.retryable === false);
  assert.equal(h.client.status().recoverable, false); assert.match(h.client.error, /refresh outcome is unconfirmed/);
  assert.equal(h.saved[0].refreshHeld, true); assert.equal(h.saved[0].refreshToken, original.refreshToken);
  await assert.rejects(h.client.ensureIdentity(original.account), /refresh is held/);
  await assert.rejects(h.client.inspectChannel(original.account, 'live_channel'), /refresh is held/);
  assert.equal(h.count('token'), 1); assert.equal(h.count('users'), 1);
});

test('a persisted refresh hold survives reconstruction and a verified explicit grant clears it', async t => {
  const failed = fixture(t, call => { if (call.op === 'token') throw Error('fixture lost response'); });
  await assert.rejects(failed.client.api('users?login=live_channel'), /refresh outcome is unconfirmed/);
  const h = fixture(t, undefined, { credentials: failed.saved[0] });
  await assert.rejects(h.client.ensureIdentity(original.account), /refresh is held/);
  assert.equal(h.calls.length, 0);
  await h.authorize(); assert.equal(h.client.credentials.refreshHeld, undefined);
  assert.equal(h.saved.at(-1).refreshHeld, undefined);
  await h.client.connect(original.account, 'live_channel'); assert.equal(h.sockets.length, 1);
});

test('certified pre-submit refresh failure permits a later fresh attempt without an internal POST retry', async t => {
  let attempts = 0;
  const h = fixture(t, call => { if (call.op === 'token' && ++attempts === 1) throw Object.assign(Error('fixture not submitted'), { notSubmitted: true }); });
  await assert.rejects(h.client.connect(original.account, 'live_channel'), e => e.providerNotSubmitted === true);
  assert.equal(h.client.status().recoverable, true); assert.equal(h.count('token'), 1); assert.equal(h.saved.length, 0);
  assert.equal(h.client.credentials.refreshHeld, undefined);
  assert.equal((await h.client.connect(original.account, 'live_channel')).connecting, true);
  assert.equal(h.count('token'), 2); assert.equal(h.saved.length, 1);
});

for (const status of [429, 503, 200]) test(`refresh HTTP${status} without a complete replacement pair holds without later token replay`, async t => {
  const h = fixture(t, call => call.op === 'token' ? response({}, status) : null);
  await assert.rejects(h.client.connect(original.account, 'live_channel'), e => e.retryable === false);
  assert.equal(h.client.status().recoverable, false); assert.equal(h.saved[0].refreshHeld, true);
  await assert.rejects(h.client.inspectChannel(original.account, 'live_channel'), /refresh is held/);
  assert.equal(h.count('token'), 1); assert.equal(h.count('users'), 1);
});

for (const [kind, value] of [['object', {}], ['array', []], ['null', null], ['empty string', ''], ['number', 123]]) {
  test(`a malformed ${kind} refresh token pair holds the original grant without validation or replay`, async t => {
    const h = fixture(t, call => call.op === 'token' ? response({ access_token: value, refresh_token: value }) : null);
    await assert.rejects(h.client.connect(original.account, 'live_channel'), e => e.uncertain === true && e.retryable === false);
    assert.equal(h.saved.length, 1); assert.equal(h.saved[0].accessToken, original.accessToken);
    assert.equal(h.saved[0].refreshToken, original.refreshToken); assert.equal(h.saved[0].refreshHeld, true);
    assert.equal(h.count('validate'), 1); assert.equal(h.count('users'), 1); assert.equal(h.count('token'), 1);
    await assert.rejects(h.client.inspectChannel(original.account, 'live_channel'), /refresh is held/);
    assert.equal(h.count('token'), 1);
  });
}

test('a whole JSON null refresh response holds the original pair before any further request', async t => {
  const h = fixture(t, call => call.op === 'token' ? response(null) : null);
  await assert.rejects(h.client.connect(original.account, 'live_channel'), e => e.uncertain === true && e.retryable === false);
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].accessToken, original.accessToken);
  assert.equal(h.saved[0].refreshToken, original.refreshToken); assert.equal(h.saved[0].refreshHeld, true);
  await assert.rejects(h.client.inspectChannel(original.account, 'live_channel'), /refresh is held/);
  assert.equal(h.count('token'), 1); assert.equal(h.count('users'), 1); assert.equal(h.count('validate'), 1);
});

test('a delayed unknown refresh failure after a newer grant cannot hold or overwrite that grant', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, async call => { if (call.form?.grant_type === 'refresh_token') { entered.resolve(); await gate.promise; throw Error('fixture lost response'); } });
  const read = h.client.api('users?login=live_channel'); await entered.promise;
  await h.authorize(); gate.resolve();
  await assert.rejects(read, e => e.cancelled === true);
  assert.equal(h.client.credentials.refreshToken, granted.refresh_token); assert.equal(h.client.credentials.refreshHeld, undefined);
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].refreshToken, granted.refresh_token);
});

test('an older completed grant save cannot clear a newer authorization queued behind it', async t => {
  const gate = deferred(), entered = deferred();
  const h = fixture(t, call => {
    if (call.op === 'device') return response({ device_code: 'device-B', user_code: 'CODE-B', expires_in: 60, interval: 5, verification_uri: 'https://www.twitch.tv/activate' });
    if (call.form?.device_code === 'device-B') return response({ access_token: 'grant-b-access', refresh_token: 'grant-b-refresh' });
  });
  h.save(async value => { if (value.refreshToken === granted.refresh_token) { entered.resolve(); await gate.promise; } });
  const first = h.authorize(); await entered.promise;
  await h.client.startAuthorization(original.clientId, original.account); h.setTime(NOW + 5000);
  const second = h.client.pollAuthorization();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  gate.resolve(); await Promise.all([first, second]);
  assert.equal(h.saved[0].refreshToken, granted.refresh_token); assert.equal(h.saved.at(-1).refreshToken, 'grant-b-refresh');
  assert.equal(h.client.credentials.refreshToken, 'grant-b-refresh'); assert.equal(h.client.pendingAuth, null);
});

test('a failed durable hold remains held in memory and does not repeat token submission', async t => {
  const h = fixture(t, call => { if (call.op === 'token') throw Error('fixture lost response'); });
  h.save(async () => { throw Error('fixture disk failure'); });
  await assert.rejects(h.client.connect(original.account, 'live_channel'), /safety state could not be saved/);
  assert.equal(h.client.status().recoverable, false); assert.equal(h.client.credentials.refreshHeld, true);
  await assert.rejects(h.client.inspectChannel(original.account, 'live_channel'), /refresh is held/);
  assert.equal(h.count('token'), 1);
});
