import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { normalizeStreamContext } from '../extension/chat-context.js';
import { controlState } from '../extension/local-control.js';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const metadataStart = source.includes('function metadataBinding(') ? 'function metadataBinding(' : 'async function refreshChannelInfo(';
const realFunctions = section(metadataStart, '\nfunction sendHoldReason(')
  + section('async function refreshChat(', '\nasync function importBrowser(')
  + section('async function controlBrowserState(', '\nasync function openSelectedWatch(');
const EPOCH = 1800000000000, ACCOUNT = 'fixture_companion', CHANNEL = 'live_channel';
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function context(checkedAt = EPOCH - 32000) { return { channel: CHANNEL, streamId: '789', title: 'Fixture', gameName: 'Fixture', isLive: true, checkedAt }; }
function info(value = context()) { return { channel: value.channel, checkedAt: value.checkedAt, streamContext: value, canReply: true }; }
function fixture({ cached = info(), binding = {}, status } = {}) {
  let time = EPOCH;
  const metadataEntered = deferred(), metadata = deferred(), calls = [], actions = [];
  const config = { account: ACCOUNT, allowedChannel: CHANNEL, revision: 4, paused: false, autoReply: false, chatMode: 'mentions' };
  const scope = { operationEpoch: 2, chatRefreshSequence: 0, channelInfo: cached,
    channelInfoBinding: { account: ACCOUNT, channel: CHANNEL, revision: 4, epoch: 2, ...binding }, metadataFlight: null,
    chat: { account: ACCOUNT, channel: CHANNEL, connected: true, messages: [], streamContext: cached?.streamContext },
    settings: async () => ({ ...config }), watch: { state: async () => ({}), poll: async () => {} }, drops: { state: async () => ({}) },
    activity: {}, Date: { now: () => time }, normalizeStreamContext, sendHoldReason: () => '',
    mergeMessages: (_a, b) => b, digest: () => ({}), syncDirector: async () => { actions.push('director'); },
    requestRecovery: () => { actions.push('recovery'); }, requestAutoReply: () => { actions.push('automatic'); },
    chrome: { storage: { local: { get: async () => ({}) }, session: { set: async () => {} } } },
    helper: async (path, body) => {
      calls.push({ path, body });
      if (path === '/api/twitch/status') return status ? status(calls.filter(c => c.path === path).length) : { account: ACCOUNT, channel: CHANNEL, connected: true, messages: [] };
      assert.equal(path, '/api/twitch/channel'); metadataEntered.resolve(); return metadata.promise;
    } };
  vm.createContext(scope); vm.runInContext(realFunctions, scope);
  return { scope, config, calls, actions, entered: metadataEntered.promise, complete: metadata.resolve,
    setTime: value => { time = value; }, refresh: () => scope.refreshChat({ automatic: false }),
    heartbeat: async () => controlState(await scope.controlBrowserState()) };
}

test('a heartbeat during real metadata refresh retains the same32-second verified context and timestamp', async () => {
  const f = fixture(), pending = f.refresh(); await f.entered;
  const beat = await f.heartbeat();
  assert.equal(beat.connected, true); assert.equal(beat.streamContext?.streamId, '789');
  assert.equal(beat.streamContext?.checkedAt, EPOCH - 32000);
  f.complete(info()); await pending;
  assert.equal(f.scope.chat.streamContext?.checkedAt, EPOCH - 32000);
  assert.equal(f.calls.length, 2, 'only the existing status and metadata reads are used');
});

for (const [name, change] of [
  ['wrong account', f => { f.scope.channelInfoBinding.account = 'other_account'; }],
  ['wrong channel', f => { f.scope.channelInfoBinding.channel = 'other_channel'; }],
  ['wrong revision', f => { f.scope.channelInfoBinding.revision--; }],
  ['wrong epoch', f => { f.scope.channelInfoBinding.epoch--; }],
  ['expired context', f => { f.setTime(EPOCH + 90001); }],
  ['future timestamp', f => { f.scope.channelInfo.streamContext.checkedAt = EPOCH + 5001; }],
  ['malformed live flag', f => { f.scope.channelInfo.streamContext.isLive = 'true'; }],
  ['wrong context channel', f => { f.scope.channelInfo.streamContext.channel = 'other_channel'; }]
]) test(`pending metadata never publishes ${name}`, async () => {
  const f = fixture(); change(f); const pending = f.refresh(); await f.entered;
  assert.equal((await f.heartbeat()).streamContext, null);
  f.complete(info(context(EPOCH))); await pending;
});

test('a context crossing the existing120-second limit is omitted from the next pending heartbeat', async () => {
  const f = fixture(), pending = f.refresh(); await f.entered;
  assert.equal((await f.heartbeat()).streamContext?.checkedAt, EPOCH - 32000);
  f.setTime(EPOCH + 88001);
  assert.equal((await f.heartbeat()).streamContext, null);
  f.complete(info()); await pending;
  assert.equal(f.scope.chat.streamContext, null, 'an expired result must not reattach');
});

test('a newer disconnected status is immediate and an older metadata completion cannot revive it', async () => {
  const f = fixture({ status: n => ({ account: ACCOUNT, channel: n === 1 ? CHANNEL : '', connected: n === 1, messages: [] }) });
  const older = f.refresh(); await f.entered; await f.refresh();
  assert.equal(f.scope.chat.connected, false); assert.equal((await f.heartbeat()).streamContext, null);
  f.complete(info(context(EPOCH))); await older;
  assert.equal(f.scope.chat.connected, false); assert.equal(f.scope.chat.streamContext, null);
  assert.deepEqual(f.actions, ['recovery']);
});

for (const change of ['Stop', 'revision', 'account', 'channel']) test(`${change} fences metadata completion and heartbeat reuse`, async () => {
  const f = fixture(), pending = f.refresh(); await f.entered;
  if (change === 'Stop') { f.scope.operationEpoch++; f.config.paused = true; f.scope.chat = { connected: false, messages: [] }; }
  if (change === 'revision') f.config.revision++;
  if (change === 'account') f.config.account = 'other_account';
  if (change === 'channel') f.config.allowedChannel = 'other_channel';
  f.complete(info(context(EPOCH))); await pending;
  assert.equal((await f.heartbeat()).streamContext, null);
  assert.deepEqual(f.actions, [], 'cancelled refresh cannot ask for a director/automatic action');
});

test('an older delayed status cannot overwrite a newer disconnected snapshot', async () => {
  const first = deferred(), entered = deferred();
  const f = fixture({ status: n => { if (n === 1) { entered.resolve(); return first.promise; } return { account: ACCOUNT, channel: '', connected: false, messages: [] }; } });
  const older = f.refresh(); await entered.promise; await f.refresh();
  first.resolve({ account: ACCOUNT, channel: CHANNEL, connected: true, messages: [{ id: 'old' }] }); await older;
  assert.equal(f.scope.chat.connected, false); assert.equal(f.calls.filter(c => c.path === '/api/twitch/channel').length, 0);
  assert.deepEqual(f.actions, ['recovery']);
});

test('overlapping refreshes keep the newer messages while sharing one metadata flight', async () => {
  const f = fixture({ status: n => ({ account: ACCOUNT, channel: CHANNEL, connected: true, messages: [{ id: String(n) }] }) });
  const older = f.refresh(); await f.entered; const newer = f.refresh();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  f.complete(info(context(EPOCH))); await Promise.all([older, newer]);
  assert.equal(f.scope.chat.messages[0].id, '2'); assert.equal(f.scope.chat.streamContext?.checkedAt, EPOCH);
  assert.equal(f.calls.filter(c => c.path === '/api/twitch/channel').length, 1);
  assert.deepEqual(f.actions, ['director'], 'only the newest refresh continues past metadata');
});

test('invalid incoming metadata cannot acquire verified ownership or a fresh timestamp', async () => {
  const f = fixture({ cached: null }), pending = f.refresh(); await f.entered;
  f.complete(info({ ...context(), checkedAt: 'invalid' })); await pending;
  assert.equal((await f.heartbeat()).streamContext, null);
});

test('a verified offline refresh replaces the previous live evidence without changing its checkedAt', async () => {
  const f = fixture(), pending = f.refresh(); await f.entered;
  f.complete(info({ ...context(EPOCH), isLive: false, streamId: '' })); await pending;
  const beat = await f.heartbeat();
  assert.equal(beat.streamContext?.isLive, false); assert.equal(beat.streamContext?.streamId, '');
  assert.equal(beat.streamContext?.checkedAt, EPOCH);
});

test('a new binding starts its own metadata read and an older flight cannot clear or overwrite it', async () => {
  const f = fixture(), oldInfo = deferred(), newInfo = deferred(), oldEntered = deferred(), newEntered = deferred();
  f.scope.helper = async path => {
    if (path === '/api/twitch/status') return { account: f.config.account, channel: CHANNEL, connected: true, messages: [] };
    assert.equal(path, '/api/twitch/channel');
    if (f.config.account === ACCOUNT) { oldEntered.resolve(); return oldInfo.promise; }
    newEntered.resolve(); return newInfo.promise;
  };
  const older = f.refresh(); await oldEntered.promise;
  f.config.account = 'new_companion'; f.config.revision++; f.scope.operationEpoch++;
  const newer = f.refresh(); await newEntered.promise;
  assert.equal((await f.heartbeat()).streamContext, null);
  oldInfo.resolve(info()); await older;
  assert.notEqual(f.scope.metadataFlight, null, 'older finally must not erase the current flight');
  newInfo.resolve(info(context(EPOCH))); await newer;
  assert.equal(f.scope.chat.account, 'new_companion');
  assert.equal((await f.heartbeat()).streamContext?.checkedAt, EPOCH);
  assert.equal(f.scope.channelInfoBinding.account, 'new_companion');
  assert.deepEqual(f.actions, ['director']);
});

test('a fresh same-binding cache hit keeps its original timestamp without another metadata read', async () => {
  const checkedAt = EPOCH - 29999, f = fixture({ cached: info(context(checkedAt)) });
  await f.refresh(); const beat = await f.heartbeat();
  assert.equal(beat.streamContext?.checkedAt, checkedAt);
  assert.equal(f.calls.filter(c => c.path === '/api/twitch/channel').length, 0);
});

test('a disconnected helper snapshot cannot retain metadata from a still-valid cache', async () => {
  const f = fixture({ cached: info(context(EPOCH)), status: () => ({ account: ACCOUNT, channel: '', connected: false, messages: [] }) });
  await f.refresh(); assert.equal(f.scope.chat.connected, false);
  assert.equal(f.scope.chat.streamContext, null); assert.equal((await f.heartbeat()).streamContext, null);
  assert.equal(f.calls.length, 1);
});

for (const change of ['revision', 'account', 'channel', 'Stop']) test(`a ${change} during heartbeat awaits cannot publish the old metadata binding`, async () => {
  const f = fixture(), entered = deferred(), playback = deferred();
  f.scope.watch.state = async () => { entered.resolve(); return playback.promise; };
  const pending = f.heartbeat(); await entered.promise;
  f.config.revision++;
  if (change === 'account') f.config.account = 'other_account';
  if (change === 'channel') f.config.allowedChannel = 'other_channel';
  if (change === 'Stop') { f.scope.operationEpoch++; f.config.paused = true; f.scope.chat = { connected: false, messages: [] }; }
  playback.resolve({}); const beat = await pending;
  assert.equal(beat.settings.revision, f.config.revision);
  assert.equal(beat.settings.allowedChannel, f.config.allowedChannel);
  assert.equal(beat.settings.paused, f.config.paused);
  assert.equal(beat.streamContext, null);
  assert.deepEqual(f.calls, [], 'a cached heartbeat must not add metadata/provider reads');
});
