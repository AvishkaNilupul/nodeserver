import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStatusLogger } from '../lib/status-log.mjs';

const NOW = Date.parse('2026-11-25T14:00:00Z');
const instance = (at = NOW) => ({ id: 'primary', available: true, authorized: true, connected: true, error: '',
  settings: { paused: false, autoReply: true, autoResume: false }, browser: { online: true, lastSeenAt: new Date(at).toISOString() },
  watch: { enabled: true, status: 'playing', checkedAt: at }, coordination: { available: true, paused: false } });
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'companion-status-')), directory = join(root, 'private');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let at = NOW; const warnings = [];
  const logger = createStatusLogger({ directory, now: () => at, warn: value => warnings.push(value), ...extra });
  const read = () => fs.existsSync(join(directory, 'status.jsonl')) ? fs.readFileSync(join(directory, 'status.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { logger, directory, root, read, warnings, time: value => { at = value; }, observe: value => logger.observe({ instances: [value] }) };
}

test('real observations produce baseline, state transitions and bounded checkpoints with original source timestamps', t => {
  const f = fixture(t), value = instance();
  assert.equal(f.logger.lifecycle('started'), true); assert.equal(f.observe(value), true);
  f.time(NOW + 5000); value.browser.lastSeenAt = new Date(NOW + 5000).toISOString(); value.watch.checkedAt = NOW + 5000; f.observe(value);
  assert.deepEqual(f.read().map(x => x.event), ['started', 'baseline']);
  f.time(NOW + 60_000); value.browser.lastSeenAt = new Date(NOW + 60_000).toISOString(); value.watch.checkedAt = NOW + 59_000; f.observe(value);
  assert.equal(f.read().at(-1).event, 'checkpoint'); assert.equal(f.read().at(-1).playbackObservedAt, NOW + 59_000);
  f.time(NOW + 65_000); value.connected = false; value.error = 'Twitch revoked the chat subscription’s authorization (authorization_revoked). Reauthorize Twitch before reconnecting.'; f.observe(value);
  const error = f.read().at(-1); assert.equal(error.event, 'transition'); assert.equal(error.errorCode, 'authorization_revoked');
  assert.equal(error.chatTokenPresent, true); assert.equal(error.chatConnected, false); assert.equal(error.observedAt, new Date(NOW + 65_000).toISOString());
  assert.equal(Object.hasOwn(error, 'errorAt'), false); assert.equal(error.browserObservedAt, NOW + 60_000);
  f.logger.lifecycle('stopped'); assert.equal(f.read().at(-1).event, 'stopped');
});

test('stale, invalid and future source timestamps cannot be turned into fresh playback by a successful host read', t => {
  const f = fixture(t), value = instance(); f.observe(value);
  f.time(NOW + 45_001); f.observe(value);
  let last = f.read().at(-1); assert.equal(last.browserFresh, false); assert.equal(last.playbackFresh, false);
  assert.equal(last.browserObservedAt, NOW); assert.equal(last.playbackObservedAt, NOW);
  for (const source of [NOW + 120_000, -1, Infinity, 'not-a-date']) {
    value.browser.lastSeenAt = source; value.watch.checkedAt = source;
    const other = fixture(t); other.observe(value); last = other.read().at(-1);
    assert.equal(last.browserFresh, false); assert.equal(last.playbackFresh, false);
    assert.equal(last.browserObservedAt, null); assert.equal(last.playbackObservedAt, null);
  }
  value.available = false; f.observe(value); last = f.read().at(-1);
  assert.equal(last.helperAvailable, false); assert.equal(last.errorCode, 'helper_unavailable');
  assert.equal(last.browserObservedAt, null); assert.equal(last.playbackObservedAt, null);
});

test('strict construction excludes sensitive values even in unexpected fields, errors and enum values', t => {
  const f = fixture(t), secrets = ['sensitive-chat-body', 'sensitive-person@example.test', '+818012345678', 'Bearer sensitive-token', '/Users/private-person/private-cookie'];
  const value = instance();
  value.account = secrets[1]; value.channel = secrets[0]; value.error = secrets.join(' '); value.sent = secrets;
  value.settings.account = secrets[1]; value.browser.sessionId = secrets[3]; value.watch.status = secrets[0];
  value.activity = { reason: secrets.join(' ') }; value.chat = { messages: secrets }; value.controls = { pending: secrets };
  f.logger.observe({ instances: [value, { ...value, id: secrets[1] }], csrfToken: secrets[3] });
  const text = JSON.stringify(f.read()); for (const secret of secrets) assert.equal(text.includes(secret), false);
  assert.equal(f.read().length, 1); assert.equal(f.read()[0].errorCode, 'other'); assert.equal(f.read()[0].playbackStatus, 'unknown');
  assert.deepEqual(Object.keys(f.read()[0]).sort(), ['version', 'event', 'observedAt', 'profile', 'helperAvailable', 'chatTokenPresent', 'chatConnected',
    'controlPaused', 'automaticReplies', 'recoveryEnabled', 'browserFresh', 'watchEnabled', 'playbackStatus', 'playbackFresh',
    'coordinationAvailable', 'coordinationPaused', 'errorCode', 'browserObservedAt', 'playbackObservedAt', 'subscriptionEvents'].sort());
});

test('rotation retains complete records in at most four bounded owner-only files and restart records a new baseline', t => {
  const f = fixture(t, { maxBytes: 1024 }), value = instance();
  for (let n = 0; n < 30; n++) { f.time(NOW + n); value.connected = n % 2 === 0; assert.equal(f.observe(value), true); }
  const files = fs.readdirSync(f.directory); assert.equal(files.length, 4);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  for (const file of files) {
    const path = join(f.directory, file), stat = fs.statSync(path); assert.ok(stat.size <= 1024); assert.equal(stat.mode & 0o777, 0o600);
    for (const line of fs.readFileSync(path, 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  }
  const restarted = createStatusLogger({ directory: f.directory, now: () => NOW + 100, maxBytes: 1024 }); restarted.observe({ instances: [value] });
  assert.equal(f.read().at(-1).event, 'baseline');
});

test('I/O failures never escape or flood warnings and later actual reads can recover', t => {
  let broken = true;
  const f = fixture(t, { io: { ...fs, mkdirSync: (...args) => { if (broken) throw Error('sensitive-storage-path'); return fs.mkdirSync(...args); } } });
  assert.equal(f.logger.lifecycle('started'), false);
  for (let n = 0; n < 50; n++) assert.equal(f.observe(instance()), false);
  assert.equal(f.warnings.length, 1); assert.doesNotMatch(f.warnings[0], /sensitive-storage-path/);
  broken = false; assert.equal(f.observe(instance()), true); assert.equal(f.read().at(-1).event, 'baseline');
  broken = true; f.time(NOW + 60_000); assert.equal(f.observe(instance()), false); assert.equal(f.warnings.length, 1);
});

test('symlink and hardlink log entries are refused without modifying the linked file', t => {
  for (const hard of [false, true]) {
    const f = fixture(t), target = join(f.root, 'preserve'); fs.writeFileSync(target, 'untouched'); fs.mkdirSync(f.directory);
    if (hard) fs.linkSync(target, join(f.directory, 'status.jsonl')); else fs.symlinkSync(target, join(f.directory, 'status.jsonl'));
    assert.equal(f.observe(instance()), false); assert.equal(fs.readFileSync(target, 'utf8'), 'untouched'); assert.equal(f.warnings.length, 1);
  }
});

test('a partial failed append is repaired before the next observation even if immediate truncation also fails', t => {
  let partial = false, failTruncate = false;
  const f = fixture(t, { io: { ...fs,
    writeFileSync: (descriptor, line) => {
      if (partial) { partial = false; fs.writeSync(descriptor, line.slice(0, 80)); failTruncate = true; throw Error('ENOSPC sensitive details'); }
      return fs.writeFileSync(descriptor, line);
    },
    ftruncateSync: (...args) => { if (failTruncate) { failTruncate = false; throw Error('EIO'); } return fs.ftruncateSync(...args); }
  } });
  const value = instance(); assert.equal(f.observe(value), true);
  f.time(NOW + 1000); value.connected = false; partial = true; assert.equal(f.observe(value), false);
  f.time(NOW + 2000); assert.equal(f.observe(value), true);
  assert.deepEqual(f.read().map(x => x.event), ['baseline', 'transition']);
  assert.equal(f.read().at(-1).chatConnected, false); assert.equal(f.warnings.length, 1);
});


test('native subscription feed availability creates typed transitions without storing arbitrary details', t => {
  const f = fixture(t), value = instance();
  value.eventFeed = { status: 'enabled', reason: 'sensitive-native-notice', token: 'sensitive-native-token' };
  f.observe(value); assert.equal(f.read().at(-1).subscriptionEvents, 'enabled');
  f.time(NOW + 1); value.eventFeed.status = 'unexpected-private'; f.observe(value);
  assert.equal(f.read().at(-1).event, 'transition'); assert.equal(f.read().at(-1).subscriptionEvents, 'unavailable');
  f.time(NOW + 2); value.eventFeed.status = 'enabled'; value.connected = false; f.observe(value);
  assert.equal(f.read().at(-1).subscriptionEvents, 'unavailable');
  const text = JSON.stringify(f.read()); for (const privateValue of ['sensitive-native-notice', 'sensitive-native-token', 'unexpected-private']) assert.equal(text.includes(privateValue), false);
});
