'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const sync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { acquireRuntimeLock, readPrivate, writePrivate } = require('../utils/z2u/privateStore');
const modulePath = require.resolve('../utils/z2u/privateStore');
const run = promisify(execFile);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'z2u-lock-recovery-'));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'runtime.lock') };
}
const ownerSource = `
const { acquireRuntimeLock } = require(process.argv[1]);
(async () => {
  const unlock = await acquireRuntimeLock(process.argv[2]);
  process.on('message', async () => { await unlock(); process.exit(0); });
  process.send({ status: 'acquired', pid: process.pid });
})().catch(error => process.send({ status: error.code || 'ERROR' }, () => process.exit(0)));
`;
async function childOwner(t, file) {
  const child = spawn(process.execPath, ['-e', ownerSource, modulePath, file], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const [message] = await once(child, 'message');
  return { child, message, exited };
}
async function deadOwner(t, file) {
  const owner = await childOwner(t, file);
  assert.equal(owner.message.status, 'acquired');
  owner.child.kill('SIGKILL');
  const [, signal] = await owner.exited;
  assert.equal(signal, 'SIGKILL');
  return owner.message.pid;
}

test('SIGKILL leftovers recover for runtime and session-write locks only after owner death', async t => {
  const { file } = await fixture(t);
  for (const target of [file, path.join(path.dirname(file), 'session.json.write.lock')]) {
    const pid = await deadOwner(t, target);
    assert.equal((await readPrivate(target)).pid, pid);
    const unlock = await acquireRuntimeLock(target);
    const current = await readPrivate(target);
    assert.equal(current.pid, process.pid);
    assert.equal(current.version, 1);
    assert.equal(current.host, os.hostname());
    await unlock();
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
    await assert.rejects(fs.stat(target + '.recover'), { code: 'ENOENT' });
  }
});

test('concurrent startup after a crash grants exactly one live owner', async t => {
  const { file } = await fixture(t);
  await deadOwner(t, file);
  const contenders = await Promise.all(Array.from({ length: 8 }, () => childOwner(t, file)));
  const winners = contenders.filter(owner => owner.message.status === 'acquired');
  assert.equal(winners.length, 1);
  assert.ok(contenders.filter(owner => owner !== winners[0]).every(owner => owner.message.status === 'RUNTIME_LOCKED'));
  assert.equal((await readPrivate(file)).pid, winners[0].message.pid);
  winners[0].child.send('release');
  await winners[0].exited;
  const unlock = await acquireRuntimeLock(file);
  await unlock();
});

test('live or unknown PID, foreign host, and incomplete lock records are never stolen', async t => {
  const { file } = await fixture(t);
  const pid = await deadOwner(t, file);
  const valid = await readPrivate(file);
  const cases = [
    { ...valid, pid: process.pid, startedAt: '2000-01-01T00:00:00.000Z' },
    { ...valid, host: 'synthetic-other-host' },
    { ...valid, pid: '123' }, { ...valid, pid: 0 },
    { ...valid, token: '' }, { ...valid, startedAt: undefined },
    { pid, token: valid.token },
  ];
  for (const record of cases) {
    await writePrivate(file, record);
    const before = await fs.readFile(file, 'utf8');
    await assert.rejects(acquireRuntimeLock(file), { code: 'RUNTIME_LOCKED' });
    assert.equal(await fs.readFile(file, 'utf8'), before);
  }
  await fs.writeFile(file, '{partial', { mode: 0o600 });
  await assert.rejects(acquireRuntimeLock(file), { code: 'RUNTIME_LOCKED' });
  assert.equal(await fs.readFile(file, 'utf8'), '{partial');
  await writePrivate(file, valid);
  const original = process.kill;
  process.kill = () => { throw Object.assign(new Error('Synthetic unknown process'), { code: 'EPERM' }); };
  try { await assert.rejects(acquireRuntimeLock(file), { code: 'RUNTIME_LOCKED' }); }
  finally { process.kill = original; }
  assert.equal((await readPrivate(file)).token, valid.token);
});

test('recovery rechecks exact token and inode before unlinking a replacement owner', async t => {
  const { file } = await fixture(t);
  const pid = await deadOwner(t, file);
  const original = process.kill;
  let replacement;
  process.kill = (target, signal) => {
    assert.equal(target, pid);
    replacement = { ...JSON.parse(sync.readFileSync(file, 'utf8')), pid: process.pid, token: 'new-owner-token' };
    sync.writeFileSync(file, JSON.stringify(replacement), { mode: 0o600 });
    return original(target, signal);
  };
  try { await assert.rejects(acquireRuntimeLock(file), { code: 'LOCK_CHANGED' }); }
  finally { process.kill = original; }
  assert.deepEqual(await readPrivate(file), replacement);
  await assert.rejects(fs.stat(file + '.recover'), { code: 'ENOENT' });
});

test('a recovery guard blocks fresh contenders and ambiguous guard leftovers fail closed', async t => {
  const { file } = await fixture(t);
  await deadOwner(t, file);
  const old = await readPrivate(file);
  await writePrivate(file + '.recover', old);
  await assert.rejects(acquireRuntimeLock(file), { code: 'RUNTIME_LOCKED' });
  assert.equal((await readPrivate(file)).token, old.token);
  await fs.unlink(file);
  await assert.rejects(acquireRuntimeLock(file), { code: 'RUNTIME_LOCKED' });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await fs.writeFile(file + '.recover', '{partial', { mode: 0o600 });
  await assert.rejects(acquireRuntimeLock(file), { code: 'RUNTIME_LOCKED' });
});

test('release never removes a lock that no longer has its ownership token', async t => {
  const { file } = await fixture(t);
  const unlock = await acquireRuntimeLock(file);
  const original = await readPrivate(file);
  await writePrivate(file, { ...original, token: 'replacement-token' });
  await assert.rejects(unlock(), { code: 'LOCK_CHANGED' });
  assert.equal((await readPrivate(file)).token, 'replacement-token');
});

test('concurrent and repeated cleanup shares one unlink and cannot delete the next owner', async t => {
  const { file } = await fixture(t);
  const unlock = await acquireRuntimeLock(file);
  const first = unlock(), duplicate = unlock();
  assert.equal(first, duplicate);
  await Promise.all([first, duplicate]);
  const nextUnlock = await acquireRuntimeLock(file);
  const next = await readPrivate(file);
  await unlock();
  assert.equal((await readPrivate(file)).token, next.token);
  await nextUnlock();
});

test('CLI startup recovers runtime and vault locks from the same killed worker through their ownership APIs', async t => {
  const { dir, file } = await fixture(t);
  const ledgerPath = path.join(dir, 'vault-ledger.json');
  const ledgerModule = require.resolve('../utils/z2u/vaultLedger');
  const source = `
const fs = require('node:fs/promises');
const { acquireRuntimeLock } = require(process.argv[1]);
const { openVaultLedger } = require(process.argv[2]);
(async () => {
  await acquireRuntimeLock(process.argv[3]);
  const original = fs.rename;
  fs.rename = async (from, to) => {
    if (to === process.argv[4]) { process.send('transaction-held'); return new Promise(() => {}); }
    return original(from, to);
  };
  process.on('message', () => {});
  await openVaultLedger(process.argv[4]).configureOffer('15', { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
})().catch(() => process.exit(99));
`;
  const child = spawn(process.execPath, ['-e', source, modulePath, ledgerModule, file, ledgerPath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  assert.equal((await once(child, 'message'))[0], 'transaction-held');
  child.kill('SIGKILL'); await exited;
  const script = path.resolve(__dirname, '../scripts/z2u-runtime.js');
  await assert.rejects(run(process.execPath, [script, 'check', '--state-dir', dir]), error => {
    assert.equal(error.code, 2); // No imported session; recovery itself succeeded.
    const health = JSON.parse(error.stdout);
    assert.equal(health.healthy, false);
    assert.ok(health.alerts.some(alert => alert.code === 'ENOENT'));
    return true;
  });
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await assert.rejects(fs.stat(ledgerPath + '.lock'), { code: 'ENOENT' });
  await assert.rejects(fs.stat(ledgerPath + '.recover'), { code: 'ENOENT' });
});
