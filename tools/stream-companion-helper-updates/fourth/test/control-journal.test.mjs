import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LocalControl } from '../lib/local-control.mjs';
const TIME = 1800000000000, sessionId = 'journal-worker';
const params = { channel: 'sample_channel', chatMode: 'participate', replySource: 'local', autoResume: true };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'companion-intent-')), intentFile = join(directory, 'control-intent.json');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let connected = false;
  const twitch = { credentials: { accessToken: 'NEVER_PERSIST_THIS' }, disconnect: () => connected = false,
    status: () => ({ account: 'sample_account', authorized: true, connected, channel: connected ? params.channel : '', sent: [], messages: [] }) };
  const make = () => new LocalControl({ twitch, intentFile, now: () => TIME });
  const c = make();
  const bridge = (control, extra = {}) => control.bridge({ sessionId, controlGeneration: control.generation, ...extra });
  bridge(c);
  const command = (control, action, value = {}) => control.command({ requestId: randomUUID(), action, params: value }).command;
  const read = () => JSON.parse(readFileSync(intentFile, 'utf8'));
  return { c, make, bridge, command, read, intentFile, directory, connect: () => connected = true };
}

test('a Stop remains held across helper restart before any worker acknowledgement', t => {
  const f = fixture(t), original = f.c.generation;
  f.command(f.c, 'stop'); assert.deepEqual(f.read(), { version: 1, held: true });
  const restarted = f.make();
  assert.equal(restarted.stopped, true); assert.notEqual(restarted.generation, original);
  assert.equal(restarted.status().controls.recent.length, 0, 'no queued operations survive or replay');
  assert.equal(restarted.status().settings.paused, true);
  assert.equal(statSync(f.intentFile).mode & 0o777, 0o600);
});

test('a crash during Start retains the durable hold without storing jobs, credentials or message bodies', t => {
  const f = fixture(t), cmd = f.command(f.c, 'start', params);
  assert.equal(f.c.stopped, false, 'this current provisional generation may connect');
  f.bridge(f.c); assert.equal(f.read().held, true);
  const text = readFileSync(f.intentFile, 'utf8');
  for (const forbidden of [cmd.id, cmd.generation, params.channel, 'NEVER_PERSIST_THIS', 'start']) assert.ok(!text.includes(forbidden));
  const restarted = f.make(); assert.equal(restarted.stopped, true);
  f.bridge(restarted);
  assert.throws(() => restarted.guard({ controlGeneration: cmd.generation, controlSessionId: sessionId }), { status: 409 });
});

test('only a connected intended channel and current armed browser state release successful Start hold', t => {
  const f = fixture(t), cmd = f.command(f.c, 'start', params); f.bridge(f.c); f.connect();
  f.bridge(f.c, { state: { settings: { allowedChannel: params.channel, ...params, paused: false, autoReply: true } },
    completion: { id: cmd.id, generation: cmd.generation, state: 'completed', result: { ok: true } } });
  assert.equal(f.read().held, false); assert.equal(f.c.status().controls.recent[0].state, 'completed');
  assert.equal(f.make().stopped, false);
});

test('an unconfirmed or stale-generation Start completion cannot release persisted safety hold', t => {
  const f = fixture(t), cmd = f.command(f.c, 'start', params); f.bridge(f.c);
  f.bridge(f.c, { state: { settings: { allowedChannel: params.channel, ...params, paused: false, autoReply: true } },
    completion: { id: cmd.id, generation: cmd.generation, state: 'completed', result: { ok: true } } });
  assert.equal(f.read().held, true); assert.equal(f.c.stopped, true);
  assert.equal(f.c.status().controls.recent[0].state, 'failed');
  f.connect();
  f.bridge(f.c, { completion: { id: cmd.id, generation: cmd.generation, state: 'completed', result: { ok: true } } });
  assert.equal(f.read().held, true);
});

test('corrupt and unwritable intent files fail closed while safe status remains readable', t => {
  const f = fixture(t); writeFileSync(f.intentFile, '{invalid private text');
  const corrupt = f.make(); assert.equal(corrupt.stopped, true); assert.match(corrupt.status().error, /safety state/);
  const unavailable = new LocalControl({ twitch: f.c.twitch, intentFile: join(f.directory, 'missing-parent', 'intent.json'), now: () => TIME });
  unavailable.bridge({ sessionId });
  assert.equal(unavailable.stopped, true); assert.match(unavailable.status().error, /safety state/);
  assert.throws(() => unavailable.command({ requestId: randomUUID(), action: 'start', params }), { status: 503 });
  assert.doesNotMatch(JSON.stringify(unavailable.status()), /missing-parent|NEVER_PERSIST_THIS/);
});

test('native chat-only Connect releases its provisional journal only after actual intended identity connects', t => {
  const f = fixture(t); f.command(f.c, 'stop'); f.bridge(f.c);
  const intent = f.c.nativeStart({ controlGeneration: f.c.generation, controlSessionId: sessionId, account: 'sample_account', channel: params.channel });
  assert.equal(f.read().held, true); f.c.nativeConnected(intent.generation); assert.equal(f.read().held, true);
  f.connect(); f.bridge(f.c); assert.equal(f.read().held, false);
  assert.equal(f.c.status().settings.autoReply, false, 'native Connect remains chat-only');
});
