import test from 'node:test';
import assert from 'node:assert/strict';
import { TwitchChat } from '../lib/twitch.mjs';
import { LocalControl } from '../lib/local-control.mjs';
import { ChatRecovery } from '../lib/chat-recovery.mjs';

const account = 'test_account', channel = 'test_channel', sessionId = 'test-browser-session';
const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let time = 1800000000000, ready = true, connects = 0;
  const raw = { authorized: true, account, connected: true, channel, recoverable: true };
  const twitch = {
    status: () => ({ ...raw, coordination: { paused: true } }),
    disconnect() { raw.connected = false; raw.channel = ''; },
    async connect(a, c, { beforeConnect, recoverHistory }) {
      assert.equal(recoverHistory, true);
      beforeConnect(); assert.deepEqual([a, c], [account, channel]); connects++; raw.channel = c;
    }
  };
  const now = () => time, control = new LocalControl({ twitch, now });
  const recovery = new ChatRecovery({ control, twitch, now, routeReady: () => ready, locked: operation => Promise.resolve().then(operation) });
  const state = { account, settings: { allowedChannel: channel, autoReply: true, autoResume: false, revision: 1 }, watch: { enabled: true, channel } };
  const beat = (s = state, session = sessionId, generation = control.generation) => {
    const input = { sessionId: session, controlGeneration: generation, state: s };
    control.bridge(input); recovery.heartbeat(input);
  };
  const binding = { controlGeneration: control.generation, controlSessionId: sessionId, account, channel };
  return { twitch, raw, control, recovery, state, beat, binding, connects: () => connects,
    advance: ms => { time += ms; }, route: value => { ready = value; }, now };
}

test('only a connected, armed subscription can recover; paired alarms and concurrent heartbeats coalesce', async () => {
  const h = fixture();
  h.twitch.disconnect(); h.beat(); await flush(); assert.equal(h.connects(), 0);
  Object.assign(h.raw, { connected: true, channel }); h.beat(); h.twitch.disconnect();
  h.beat(); h.beat(); assert.equal(h.recovery.owns(h.binding), true);
  assert.equal(h.recovery.owns({ ...h.binding, controlCommandId: 'explicit-start' }), false);
  await flush(); assert.equal(h.connects(), 1); assert.equal(h.recovery.status().lastAttemptAt, h.now());
  h.beat(); await flush(); assert.equal(h.connects(), 1); // Still awaiting the welcome.
  h.raw.connected = true; h.beat(); assert.equal(h.recovery.status().state, 'recovered');
});

test('a missing USA route and a terminal authorization/subscription failure stay held', async () => {
  const h = fixture(); h.beat(); h.twitch.disconnect(); h.route(false);
  h.beat(); await flush(); assert.equal(h.connects(), 0); assert.match(h.recovery.status().reason, /US route/);
  h.route(true); h.raw.recoverable = false; h.beat(); await flush();
  assert.equal(h.connects(), 0); assert.match(h.recovery.status().reason, /authorization/);
  h.raw.recoverable = true; h.raw.authorized = false; h.beat(); await flush();
  assert.equal(h.connects(), 0); assert.equal(h.recovery.status().state, 'held');
});

test('successive failed receives back off to one minute and publish a due time', async () => {
  const h = fixture(); let attempts = 0;
  h.twitch.connect = async () => { attempts++; throw Error('simulated network failure'); };
  h.beat(); h.twitch.disconnect();
  for (const [index, delay] of [5000, 10000, 20000, 40000, 60000, 60000].entries()) {
    h.beat(); await flush();
    assert.equal(attempts, index + 1); assert.equal(h.recovery.status().nextAttemptAt, h.now() + delay);
    h.advance(delay - 1); h.beat(); await flush(); assert.equal(attempts, index + 1);
    h.advance(1);
  }
  assert.equal(h.recovery.status().state, 'waiting');
});

test('Stop, revised settings, browser replacement and expired heartbeat fence a slow receive recovery', async () => {
  for (const cancel of [
    h => h.control.command({ requestId: 'requested-stop', action: 'stop', params: {} }),
    h => h.beat({ ...h.state, settings: { ...h.state.settings, revision: 2, allowedChannel: 'new_channel' } }),
    h => h.beat(h.state, 'replacement-session'),
    h => h.advance(60_000)
  ]) {
    const h = fixture(); let finish, opened = 0;
    h.twitch.connect = async (_account, _channel, { beforeConnect }) => {
      await new Promise(resolve => { finish = resolve; }); beforeConnect(); opened++;
    };
    h.beat(); h.twitch.disconnect(); h.beat(); await flush(); assert.ok(finish);
    cancel(h); finish(); await flush(); assert.equal(opened, 0);
  }
});

test('a local lease expiring during a real TwitchChat lookup remains recoverable on return', async t => {
  let time = 1800000000000, release, sockets = 0;
  class Socket extends EventTarget { constructor() { super(); sockets++; } close() {} }
  const now = () => time;
  const twitch = new TwitchChat({ credentials: { account, accessToken: 'fixture-only' }, WebSocketImpl: Socket, now });
  t.after(() => twitch.disconnect());
  twitch.ensureIdentity = async () => {};
  twitch.api = async () => { await new Promise(resolve => { release = resolve; }); return { data: [{ login: channel, id: '123' }] }; };
  const control = new LocalControl({ twitch, now });
  const recovery = new ChatRecovery({ control, twitch, now, locked: fn => Promise.resolve().then(fn) });
  const input = { sessionId, controlGeneration: control.generation, state: { account,
    settings: { allowedChannel: channel, autoReply: true, revision: 1 }, watch: { enabled: true, channel } } };
  const beat = () => { control.bridge(input); recovery.heartbeat(input); };
  Object.assign(twitch, { connected: true, channel }); beat(); twitch.fail('Twitch chat disconnected.', true);
  beat(); await flush(); assert.ok(release);
  time += 60_000; release(); await flush();
  assert.equal(sockets, 0); assert.equal(twitch.status().recoverable, true);
  twitch.api = async () => ({ data: [{ login: channel, id: '123' }] });
  beat(); await flush(); assert.equal(sockets, 1);
});

test('a failed receive diagnostic leaves the bridge free to deliver a claimed command', () => {
  const h = fixture(); h.beat();
  h.control.command({ requestId: 'test-watch', action: 'watch', params: {} });
  h.twitch.status = () => { throw Error('fake private diagnostic'); };
  const input = { sessionId, controlGeneration: h.control.generation, state: h.state };
  const reply = h.control.bridge(input); h.recovery.heartbeat(input);
  assert.equal(reply.command.action, 'watch'); assert.equal(h.recovery.status().state, 'waiting');
  assert.doesNotMatch(h.recovery.status().reason, /fake private/);
});
