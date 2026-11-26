import { installDirectorFixture } from './director-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwitchChat, chatScopes } from '../lib/twitch.mjs';
import { ChatSendHolds } from '../lib/chat-holds.mjs';

const BASE = 1800000000000, ACCOUNT = 'fixture_companion', CHANNEL = 'live_channel';
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function fixture(t) {
  let time = BASE, rejected = true, beforeResponse;
  const dir = mkdtempSync(join(tmpdir(), 'follower-holds-')), file = join(dir, 'holds.json'), calls = [], saved = [], finishes = [], reserves = [], observations = [];
  const holds = new ChatSendHolds({ file, now: () => time });
  const twitch = new TwitchChat({ credentials: { account: ACCOUNT, userId: '123', clientId: 'fixtureclient123', accessToken: 'fixture-access', scopes: chatScopes },
    sendHolds: holds, now: () => time, saveHistory: async value => { saved.push(structuredClone(value)); }, fetchImpl: async (address, options) => {
      calls.push({ address, options });
      if (address.includes('/users?')) return response({ data: [{ login: CHANNEL, id: '456' }] });
      if (address.includes('/streams?')) return response({ data: [{ id: '789', user_id: '456', user_login: CHANNEL, title: 'Fixture', game_name: 'Fixture game' }] });
      if (address.includes('/chat/settings?')) return response({ data: [{ broadcaster_id: '456', follower_mode: true, follower_mode_duration: 30, subscriber_mode: false, emote_mode: false, slow_mode: false }] });
      if (address.includes('/shared_chat/')) return response({ data: [] });
      if (address.endsWith('/chat/messages')) { await beforeResponse?.(); return response({ data: [rejected ? { is_sent: false, drop_reason: { code: 'followers_only_mode' } } : { is_sent: true, message_id: 'confirmed-fixture' }] }); }
      throw Error('Unexpected fixture API call.');
    } });
  twitch.validatedAt = time; twitch.connected = true; twitch.channel = CHANNEL; twitch.broadcasterId = '456';
  twitch.coordinator = { observation: { channel: CHANNEL, autoReply: true, exchangeContext: { streamId: '789' } }, seed() {}, snapshot: () => ({ accounts: [], available: true, paused: false }),
    reserve: async intent => { reserves.push(intent); return { ok: true, reservationId: `permit-${reserves.length}` }; },
    begin: async () => ({ ok: true }), finish: async (...args) => finishes.push(args), refresh: async input => { observations.push(input); } };
  installDirectorFixture(twitch);
  t.after(() => { twitch.disconnect(); rmSync(dir, { recursive: true, force: true }); });
  return { twitch, holds, file, calls, saved, finishes, reserves, observations, advance: ms => { time += ms; }, accept: () => { rejected = false; }, defer: fn => { beforeResponse = fn; } };
}
const send = (twitch, extra = {}) => twitch.send({ account: ACCOUNT, channel: CHANNEL, text: 'A normal intended message', ...extra });

test('followers-only is a room requirement, not an account denial or follow claim', async t => {
  const f = fixture(t), result = await f.twitch.inspectChannel(ACCOUNT, CHANNEL);
  assert.equal(result.canReply, true); assert.equal(result.reason, ''); assert.equal(result.chatSettings.followersOnly, true); assert.equal(result.chatSettings.followerMinutes, 30);
  assert.equal('isFollowing' in result, false); assert.equal(f.calls.some(c => /followed|followers/.test(c.address)), false);
  f.accept(); assert.equal((await send(f.twitch)).delivery, 'confirmed'); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, false);
});

test('a real follower rejection consumes exactly one attempt then durably blocks every send category before provider or reserve work', async t => {
  const f = fixture(t), first = await send(f.twitch);
  assert.equal(first.delivery, 'rejected'); assert.equal(first.sendHold.held, true); assert.equal(f.twitch.connected, true);
  assert.equal(f.twitch.history.length, 1); assert.deepEqual(f.finishes.map(row => row.slice(0, 2)), [['permit-1', 'rejected']]);
  const calls = f.calls.length, reserves = f.reserves.length;
  for (const extra of [{}, { replyTo: 'fresh-mention' }, { kind: 'greeting', participationKey: 'greeting' }, { kind: 'topic', participationKey: 'topic' }, { kind: 'conversation', participationKey: 'conversation' }, { kind: 'exchange', exchangeId: 'scene', participationKey: 'exchange:scene' }]) {
    f.advance(600001); const result = await send(f.twitch, extra); assert.equal(result.suppressed, true); assert.equal(result.retryable, false); assert.equal(result.submitted, false);
  }
  assert.equal(f.calls.length, calls); assert.equal(f.reserves.length, reserves); assert.equal(f.twitch.history.length, 1);
  const restored = new ChatSendHolds({ file: f.file }); assert.equal(restored.status(ACCOUNT, CHANNEL).held, true); assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(f.observations.at(-1).observation.autoReply, false); assert.equal(f.observations.at(-1).observation.exchangeContext, null);
});

test('ordinary disconnect, recovery connect and reload preserve the hold; only an explicit guarded callback can clear it', async t => {
  const f = fixture(t); await send(f.twitch); f.twitch.disconnect(); f.twitch.openSocket = () => {}; f.twitch.validateLater = () => {};
  await f.twitch.connect(ACCOUNT, CHANNEL); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, true);
  await f.twitch.connect(ACCOUNT, CHANNEL, { beforeConnect: () => f.twitch.clearSendHold(ACCOUNT, CHANNEL) });
  assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, false);
  const restored = new ChatSendHolds({ file: f.file }); restored.recover(f.twitch.history); assert.equal(restored.status(ACCOUNT, CHANNEL).held, false);
});

test('holds are isolated by account and channel and real history recovers a lost newer hold without fake attempts', async t => {
  const f = fixture(t); await send(f.twitch);
  assert.equal(f.holds.status('other_companion', CHANNEL).held, false); assert.equal(f.holds.status(ACCOUNT, 'other_channel').held, false);
  const fresh = new ChatSendHolds(); fresh.recover(f.twitch.history); assert.equal(fresh.status(ACCOUNT, CHANNEL).held, true); assert.equal(f.twitch.history.length, 1);
});

test('Stop during an in-flight real rejection retains its hold without reconnecting', async t => {
  const f = fixture(t); let release; f.defer(() => new Promise(resolve => { release = resolve; }));
  const sending = send(f.twitch); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.twitch.disconnect(); release(); const result = await sending;
  assert.equal(result.delivery, 'rejected'); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, true); assert.equal(f.twitch.connected, false);
});

test('an older late rejection cannot reinstate the hold after a newer explicit clear', async t => {
  const f = fixture(t); let release; f.defer(() => new Promise(resolve => { release = resolve; }));
  const sending = send(f.twitch); while (!release) await new Promise(resolve => setImmediate(resolve));
  f.advance(1); f.twitch.clearSendHold(ACCOUNT, CHANNEL); release(); await sending;
  assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, false);
  const restored = new ChatSendHolds({ file: f.file }); restored.recover(f.twitch.history); assert.equal(restored.status(ACCOUNT, CHANNEL).held, false);
});

test('a cancelled connection preparation cannot reach the explicit hold-clear callback', async t => {
  const f = fixture(t); await send(f.twitch); let release;
  f.twitch.ensureIdentity = async () => new Promise(resolve => { release = resolve; });
  let clears = 0;
  const connecting = f.twitch.connect(ACCOUNT, CHANNEL, { beforeConnect: () => { clears++; f.twitch.clearSendHold(ACCOUNT, CHANNEL); } });
  while (!release) await new Promise(resolve => setImmediate(resolve)); f.twitch.disconnect(); release(); await connecting;
  assert.equal(clears, 0); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, true);
});

test('corrupt or unwritable hold journals fail closed without losing the real rejected outcome', async t => {
  const f = fixture(t); f.holds.write = () => { throw Error('disk unavailable'); };
  const result = await send(f.twitch); assert.equal(result.delivery, 'rejected'); assert.equal(f.twitch.history[0].delivery, 'rejected'); assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, true);
  assert.throws(() => f.holds.clear(ACCOUNT, CHANNEL));
  writeFileSync(f.file, '{invalid'); const corrupt = new ChatSendHolds({ file: f.file });
  assert.equal(corrupt.status(ACCOUNT, CHANNEL).held, true); assert.equal(readFileSync(f.file, 'utf8'), '{invalid');
});


test('history persistence failure after a known follower rejection cannot relabel it unknown', async t => {
  const f = fixture(t); let writes = 0;
  f.twitch.saveHistory = async () => { if (++writes > 1) throw Error('History storage unavailable.'); };
  const result = await send(f.twitch);
  assert.equal(result.delivery, 'rejected'); assert.equal(f.twitch.history[0].delivery, 'rejected');
  assert.equal(f.holds.status(ACCOUNT, CHANNEL).held, true); assert.deepEqual(f.finishes.map(row => row.slice(0, 2)), [['permit-1', 'rejected']]);
});
