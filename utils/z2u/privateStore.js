'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

function fault(code) { const error = new Error(code); error.code = code; return error; }
async function privatePath(filename) {
  if (!path.isAbsolute(filename)) throw fault('PRIVATE_PATH_REQUIRED');
  const root = path.resolve(__dirname, '../..');
  const target = path.resolve(filename);
  if (target === root || target.startsWith(root + path.sep)) throw fault('PRIVATE_PATH_REQUIRED');
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (await fs.realpath(dir) !== dir) throw fault('SYMLINK_NOT_ALLOWED');
  const info = await fs.stat(dir);
  if ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw fault('PRIVATE_DIRECTORY_REQUIRED');
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw fault('PRIVATE_FILE_REQUIRED');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}
async function readPrivate(filename) {
  const target = await privatePath(filename);
  const handle = await fs.open(target, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile('utf8')); }
  catch { throw fault('INVALID_PRIVATE_STORE'); }
  finally { await handle.close(); }
}
async function writePrivate(filename, data) {
  const target = await privatePath(filename), temp = target + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(data) + '\n'); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temp, target);
    const dir = await fs.open(path.dirname(target), 'r'); try { await dir.sync(); } finally { await dir.close(); }
  } finally { if (handle) await handle.close(); await fs.unlink(temp).catch(() => {}); }
}
function lockRecord() {
  return { version: 1, host: os.hostname(), pid: process.pid, token: randomUUID(), startedAt: new Date().toISOString() };
}
async function lockIdentity(target) {
  const handle = await fs.open(target, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid()) || stat.size > 4096) throw fault('RUNTIME_LOCKED');
    let record;
    try { record = JSON.parse(await handle.readFile('utf8')); } catch { throw fault('RUNTIME_LOCKED'); }
    if (!record || record.version !== 1 || record.host !== os.hostname() || !Number.isSafeInteger(record.pid) || record.pid < 1 ||
        typeof record.token !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(record.token) ||
        typeof record.startedAt !== 'string' || !Number.isFinite(Date.parse(record.startedAt))) throw fault('RUNTIME_LOCKED');
    return { record, dev: stat.dev, ino: stat.ino };
  } finally { await handle.close(); }
}
function sameLock(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.record.token === b.record.token && a.record.pid === b.record.pid && a.record.host === b.record.host;
}
async function removeOwnedLock(target, identity) {
  const current = await lockIdentity(target);
  if (!sameLock(current, identity)) throw fault('LOCK_CHANGED');
  await fs.unlink(target);
}
async function recoveryAbsent(recoveryFile) {
  try { await fs.lstat(recoveryFile); throw fault('RUNTIME_LOCKED'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function createLock(target) {
  const record = lockRecord();
  const handle = await fs.open(target, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(record)); await handle.sync();
    const stat = await handle.stat();
    return { record, dev: stat.dev, ino: stat.ino };
  } finally { await handle.close(); }
}
async function recoverRuntimeLock(target, recoveryFile) {
  let guard;
  try { guard = await createLock(recoveryFile); }
  catch (error) { if (error.code === 'EEXIST') throw fault('RUNTIME_LOCKED'); throw error; }
  try {
    let owner;
    try { owner = await lockIdentity(target); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    // A successful probe, EPERM, PID reuse, or an unknown error cannot prove
    // death. Wall-clock age is never used to take a lock from a worker.
    try { process.kill(owner.record.pid, 0); throw fault('RUNTIME_LOCKED'); }
    catch (error) { if (error.code !== 'ESRCH') throw fault('RUNTIME_LOCKED'); }
    // Every acquiring process observes the guard before AND after its exclusive
    // create. With a dead owner, the same identity is stable until this unlink.
    await removeOwnedLock(target, owner);
  } finally { await removeOwnedLock(recoveryFile, guard); }
}
async function acquireRuntimeLock(filename) {
  const target = await privatePath(filename), recoveryFile = target + '.recover';
  for (let attempt = 0; attempt < 2; attempt++) {
    await recoveryAbsent(recoveryFile);
    let owner;
    try { owner = await createLock(target); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt) throw fault('RUNTIME_LOCKED');
      await recoverRuntimeLock(target, recoveryFile);
      continue;
    }
    try { await recoveryAbsent(recoveryFile); }
    catch (error) { await removeOwnedLock(target, owner); throw error; }
    // Concurrent/finally cleanup callers share one unlink. A second delayed
    // cleanup must never act on a replacement owner's newly created lock.
    let releasing;
    return () => releasing || (releasing = removeOwnedLock(target, owner));
  }
  throw fault('RUNTIME_LOCKED');
}
module.exports = { fault, privatePath, readPrivate, writePrivate, acquireRuntimeLock };
