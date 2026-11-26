import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchChat, chatScopes } from '../lib/twitch.mjs';
import { ViewerClips } from '../lib/clips.mjs';

const now = 1800000000000;
const credentials = { account: 'companion_test', clientId: 'clientid12345', userId: '123', accessToken: 'old-access', refreshToken: 'old-refresh', scopes: [...chatScopes, 'clips:edit'] };
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const identity = { login: credentials.account, client_id: credentials.clientId, user_id: credentials.userId, scopes: [...chatScopes, 'clips:edit'] };
function harness(t, fetchImpl) {
  const saved = [];
  const twitch = new TwitchChat({ credentials: structuredClone(credentials), now: () => now, fetchImpl, saveCredentials: async value => saved.push(structuredClone(value)) });
  t.after(() => twitch.disconnect());
  return { twitch, saved };
}

test('definitive Create401 persists clip-only invalidation while preserving chat credentials and allows a new explicit grant', async t => {
  const h = harness(t, async () => response({}, 401));
  await assert.rejects(h.twitch.createViewerClip('456'), /permission expired/);
  assert.deepEqual(h.twitch.credentials.scopes, chatScopes);
  assert.equal(h.twitch.credentials.clipPermissionInvalid, true);
  for (const key of ['account', 'clientId', 'userId', 'accessToken', 'refreshToken']) assert.equal(h.twitch.credentials[key], credentials[key]);
  assert.equal(h.saved.length, 1); assert.equal(h.saved[0].clipPermissionInvalid, true);
  const clips = new ViewerClips({ twitch: h.twitch, control: { status: () => ({}) } }); t.after(() => clips.close());
  assert.equal(clips.status().authorized, false);
  // A successful ordinary identity check cannot silently undo the explicit clip repair requirement.
  h.twitch.fetch = async () => response(identity); await h.twitch.ensureIdentity(credentials.account);
  assert.deepEqual(h.twitch.credentials.scopes, chatScopes); assert.equal(clips.status().authorized, false);
  // Recovery requires a new scoped authorization approved on Twitch.
  h.twitch.fetch = async url => {
    if (url.endsWith('/device')) return response({ device_code: 'private-code', user_code: 'PUBLIC123', verification_uri: 'https://www.twitch.tv/activate', expires_in: 600, interval: 5 });
    if (url.endsWith('/token')) return response({ access_token: 'new-access', refresh_token: 'new-refresh' });
    if (url.endsWith('/validate')) return response(identity);
    throw Error('Unexpected fixture call.');
  };
  await h.twitch.startAuthorization(credentials.clientId, credentials.account, { clips: true }); h.twitch.pendingAuth.nextPoll = now;
  await h.twitch.pollAuthorization();
  assert.equal(h.twitch.credentials.clipPermissionInvalid, undefined); assert.equal(clips.status().authorized, true);
});

test('preparation identity401 or fresh metadata401 also disables clips without removing chat credentials', async t => {
  const identityFailure = harness(t, async () => response({}, 401));
  delete identityFailure.twitch.credentials.refreshToken;
  await assert.rejects(identityFailure.twitch.prepareViewerClip(credentials.account, 'friend_channel', '456789'));
  assert.equal(identityFailure.twitch.credentials.clipPermissionInvalid, true);
  assert.equal(identityFailure.twitch.credentials.accessToken, credentials.accessToken);
  const metadataFailure = harness(t, async url => url.endsWith('/validate') ? response(identity) : response({}, 401));
  await assert.rejects(metadataFailure.twitch.prepareViewerClip(credentials.account, 'friend_channel', '456789'));
  assert.equal(metadataFailure.twitch.credentials.clipPermissionInvalid, true); assert.equal(metadataFailure.saved.length, 1);
});

test('a refresh401 during preparation invalidates clips, while transient failures do not', async t => {
  const failed = harness(t, async () => response({}, 401));
  await assert.rejects(failed.twitch.prepareViewerClip(credentials.account, 'friend_channel', '456789'));
  assert.equal(failed.twitch.credentials.clipPermissionInvalid, true);
  const transient = harness(t, async () => response({}, 503));
  await assert.rejects(transient.twitch.createViewerClip('456'));
  assert.equal(transient.twitch.credentials.clipPermissionInvalid, undefined); assert.equal(transient.saved.length, 0);
});

test('a late401 cannot invalidate a replacement grant installed while the request was in flight', async t => {
  let release;
  const h = harness(t, () => new Promise(resolve => { release = resolve; }));
  const posting = h.twitch.createViewerClip('456');
  h.twitch.credentials = { ...h.twitch.credentials, accessToken: 'newer-approved-access' };
  release(response({}, 401)); await assert.rejects(posting);
  assert.equal(h.twitch.credentials.clipPermissionInvalid, undefined); assert.equal(h.saved.length, 0);
});
