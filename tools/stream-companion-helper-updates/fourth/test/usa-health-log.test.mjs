import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUsaHealthLogger } from '../lib/usa-health-log.mjs';
import { createHelper } from '../server.mjs';

const NOW = Date.parse('2026-11-26T16:00:00Z');
const ready = () => ({ countryRequired: 'US', state: 'ready', country: 'US', checkedAt: NOW, browserOnline: true, pending: 0, sockets: 1 });
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'fourth-usa-health-')), directory = join(root, 'private');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let at = NOW, raw = ready(), reads = 0, callback, clearCalls = 0, unrefCalls = 0;
  const warnings = [], transport = { status() { reads++; return raw; } };
  const logger = createUsaHealthLogger({ directory, transport, now: () => at, warn: value => warnings.push(value),
    setIntervalImpl: (fn, ms) => { assert.ok(ms <= 5000); callback = fn; return { unref() { unrefCalls++; } }; },
    clearIntervalImpl: () => { clearCalls++; }, ...extra });
  const read = () => fs.existsSync(join(directory, 'usa-health.jsonl'))
    ? fs.readFileSync(join(directory, 'usa-health.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  return { logger, root, directory, transport, warnings, read, time: value => { at = value; }, raw: value => { raw = value; },
    tick: () => callback?.(), reads: () => reads, clears: () => clearCalls, unrefs: () => unrefCalls };
}

test('cached samples log baseline, real state changes and sixty-second checkpoints with source timestamps', t => {
  const f = fixture(t); assert.deepEqual(f.read(), []); assert.equal(f.reads(), 0);
  assert.equal(f.logger.start(), true); assert.equal(f.unrefs(), 1); assert.equal(f.reads(), 1);
  f.time(NOW + 5000); f.raw({ ...ready(), checkedAt: NOW + 5000 }); f.tick();
  assert.deepEqual(f.read().map(row => row.event), ['baseline']);
  f.time(NOW + 60000); f.raw({ ...ready(), checkedAt: NOW + 59000 }); f.tick();
  assert.equal(f.read().at(-1).event, 'checkpoint'); assert.equal(f.read().at(-1).proofObservedAt, NOW + 59000);
  f.time(NOW + 65000); f.raw({ ...ready(), state: 'held', country: null, checkedAt: 0, browserOnline: false, sockets: 0 }); f.tick();
  assert.equal(f.read().at(-1).event, 'transition'); assert.equal(f.read().at(-1).proofFresh, false);
  assert.equal(f.read().at(-1).observedAt, new Date(NOW + 65000).toISOString());
  f.raw({ ...ready(), state: 'closed', country: null, checkedAt: 0, browserOnline: false, sockets: 0 }); f.logger.close();
  assert.equal(f.read().at(-1).event, 'stopped'); assert.equal(f.read().at(-1).state, 'closed');
});

test('expired, future, invalid or absent checkedAt cannot become fresh from a sampling time', t => {
  for (const source of [NOW - 5001, NOW + 1, -1, 0, Infinity, NaN, '2026-11-26T16:00:00Z', undefined]) {
    const f = fixture(t); f.raw({ ...ready(), checkedAt: source }); f.logger.start();
    const row = f.read()[0]; assert.equal(row.proofFresh, false);
    assert.equal(row.proofObservedAt, source === NOW - 5001 ? source : null); f.logger.close();
  }
  const f = fixture(t); f.logger.start(); f.time(NOW + 5001); f.tick();
  assert.equal(f.read().at(-1).proofFresh, false); assert.equal(f.read().at(-1).proofObservedAt, NOW);
});

test('strict projection excludes IPs, URLs, tokens, messages, errors and arbitrary enums', t => {
  const f = fixture(t), secrets = ['203.0.113.19', 'https://private.example/path', 'Bearer private-token', 'private-chat-text', '/Users/private-path'];
  f.raw({ countryRequired: secrets[0], state: secrets[2], country: secrets[1], browserOnline: secrets[3], checkedAt: NOW,
    pending: secrets[4], sockets: 500, ip: secrets[0], url: secrets[1], error: secrets.join(' '), messages: secrets, token: secrets[2] });
  assert.equal(f.logger.start(), true); const row = f.read()[0], text = JSON.stringify(f.read());
  for (const secret of secrets) assert.equal(text.includes(secret), false);
  assert.deepEqual(Object.keys(row).sort(), ['version', 'event', 'observedAt', 'profile', 'countryRequired', 'state', 'country', 'browserOnline', 'proofFresh', 'pending', 'sockets', 'proofObservedAt', 'lastSocketClose'].sort());
  assert.equal(row.profile, 'fourth'); assert.equal(row.countryRequired, 'US'); assert.equal(row.state, 'unknown');
  assert.equal(row.country, null); assert.equal(row.pending, null); assert.equal(row.sockets, null); assert.equal(row.browserOnline, false);
});

test('counts remain bounded and malformed or throwing cached status never escapes', t => {
  for (const count of [-1, 0.5, Infinity, NaN, '1', 33]) {
    const f = fixture(t); f.raw({ ...ready(), pending: count, sockets: count }); f.logger.start();
    assert.equal(f.read()[0].pending, null); assert.equal(f.read()[0].sockets, null);
  }
  const f = fixture(t); f.raw({ ...ready(), pending: 32, sockets: 4 }); f.logger.start();
  assert.equal(f.read()[0].pending, 32); assert.equal(f.read()[0].sockets, 4);
  f.transport.status = () => { throw Error('Bearer secret-provider-error'); }; assert.doesNotThrow(f.tick);
  assert.equal(f.read().at(-1).state, 'unknown'); assert.equal(f.read().at(-1).proofObservedAt, null);
  assert.equal(JSON.stringify(f.read()).includes('secret-provider-error'), false);
});

test('rotation is at most four bounded owner-only files and restart starts a new baseline', t => {
  const f = fixture(t, { maxBytes: 1024 }); f.logger.start();
  for (let n = 0; n < 70; n++) { f.time(NOW + n); f.raw({ ...ready(), sockets: n % 2 }); f.tick(); }
  const files = fs.readdirSync(f.directory); assert.equal(files.length, 4); assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  for (const name of files) {
    const path = join(f.directory, name), stat = fs.statSync(path); assert.ok(stat.size <= 1024); assert.equal(stat.mode & 0o777, 0o600);
    for (const line of fs.readFileSync(path, 'utf8').trim().split('\n')) assert.doesNotThrow(() => JSON.parse(line));
  }
  f.logger.close(); const restarted = createUsaHealthLogger({ directory: f.directory, transport: { status: ready }, now: () => NOW + 100,
    maxBytes: 1024, setIntervalImpl: () => 1, clearIntervalImpl: () => {} });
  restarted.start(); assert.equal(f.read().at(-1).event, 'baseline'); restarted.close();
});

test('I/O failures do not escape or flood warnings, and a later sample can recover', t => {
  let broken = true;
  const f = fixture(t, { io: { ...fs, mkdirSync: (...args) => { if (broken) throw Error('secret-storage-path'); return fs.mkdirSync(...args); } } });
  assert.equal(f.logger.start(), false); for (let n = 0; n < 30; n++) assert.doesNotThrow(f.tick);
  assert.equal(f.warnings.length, 1); assert.equal(f.warnings[0].includes('secret-storage-path'), false);
  broken = false; f.tick(); assert.equal(f.read().at(-1).event, 'baseline');
  broken = true; assert.doesNotThrow(() => f.logger.close()); assert.equal(f.clears(), 1);
});

test('symlink and hardlink entries are refused without touching their target', t => {
  for (const hard of [false, true]) {
    const f = fixture(t), target = join(f.root, 'preserve'); fs.writeFileSync(target, 'untouched'); fs.mkdirSync(f.directory);
    if (hard) fs.linkSync(target, join(f.directory, 'usa-health.jsonl')); else fs.symlinkSync(target, join(f.directory, 'usa-health.jsonl'));
    assert.equal(f.logger.start(), false); assert.equal(fs.readFileSync(target, 'utf8'), 'untouched');
    assert.equal(f.warnings.length, 1); f.logger.close();
  }
});

test('a partial failed append is repaired before the next real sample', t => {
  let partial = false, failTruncate = false;
  const f = fixture(t, { io: { ...fs,
    writeFileSync: (descriptor, line) => { if (partial) { partial = false; fs.writeSync(descriptor, line.slice(0, 80)); failTruncate = true; throw Error('private ENOSPC'); } return fs.writeFileSync(descriptor, line); },
    ftruncateSync: (...args) => { if (failTruncate) { failTruncate = false; throw Error('private EIO'); } return fs.ftruncateSync(...args); }
  } });
  f.logger.start(); f.time(NOW + 1000); f.raw({ ...ready(), sockets: 0 }); partial = true; f.tick();
  f.time(NOW + 2000); f.tick(); assert.deepEqual(f.read().map(row => row.event), ['baseline', 'transition']);
  assert.equal(f.read().at(-1).sockets, 0); assert.equal(f.warnings.length, 1);
});

test('start and close are idempotent; closed callbacks never read status or append again', t => {
  const f = fixture(t); f.logger.start(); assert.equal(f.logger.start(), false);
  f.logger.close(); const count = f.reads(), rows = f.read().length; assert.equal(f.clears(), 1);
  f.tick(); assert.equal(f.logger.sample(), false); f.logger.close(); assert.equal(f.logger.start(), false);
  assert.equal(f.reads(), count); assert.equal(f.read().length, rows); assert.equal(f.clears(), 1);
});

test('native network facilities and transport network methods are never used by health logging', t => {
  const previousFetch = globalThis.fetch, previousSocket = globalThis.WebSocket; let calls = 0;
  const forbidden = () => { calls++; throw Error('unexpected network'); };
  globalThis.fetch = forbidden; globalThis.WebSocket = class { constructor() { forbidden(); } };
  t.after(() => { globalThis.fetch = previousFetch; globalThis.WebSocket = previousSocket; });
  const f = fixture(t); Object.assign(f.transport, { fetch: forbidden, verify: forbidden, WebSocket: forbidden, poll: forbidden });
  f.logger.start(); f.tick(); f.logger.close(); assert.equal(calls, 0); assert.equal(f.reads(), 3);
});

test('timer and warning callback failures remain outside helper control paths', t => {
  const f = fixture(t, { setIntervalImpl: () => { throw Error('private timer error'); }, clearIntervalImpl: () => { throw Error('private clear error'); },
    io: { ...fs, mkdirSync: () => { throw Error('private path'); } }, warn: () => { throw Error('private callback error'); } });
  assert.doesNotThrow(() => f.logger.start()); assert.doesNotThrow(() => f.logger.sample()); assert.doesNotThrow(() => f.logger.close());
  for (const intervalMs of [0, 5001, Infinity]) assert.throws(() => createUsaHealthLogger({ transport: { status: ready }, intervalMs }));
});

test('real helper lifecycle starts one logger and closes its timer after the transport closes', async t => {
  const f = fixture(t); let closed = false;
  const transport = { ...f.transport, bind() {}, invalidate() {}, close() { closed = true; f.raw({ ...ready(), state: 'closed', checkedAt: 0, country: null, browserOnline: false, sockets: 0 }); } };
  const logger = { start: () => f.logger.start(), close: () => { assert.equal(closed, true); f.logger.close(); } };
  const server = createHelper({ config: { extensionId: 'fixture', pairingToken: 'fixture-pairing' }, usaTransport: transport, usaHealthLogger: logger });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  assert.equal(f.read()[0].event, 'baseline'); await new Promise(resolve => server.close(resolve));
  assert.equal(f.clears(), 1); assert.equal(f.read().at(-1).state, 'closed'); assert.equal(f.read().at(-1).event, 'stopped');
  const errors = createHelper({ config: { extensionId: 'fixture', pairingToken: 'fixture-pairing' }, usaHealthLogger: { start() { throw Error('start log error'); }, close() { throw Error('close log error'); } } });
  await new Promise(resolve => errors.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => errors.close(resolve));
});
