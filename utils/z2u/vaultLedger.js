'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');

const STATES = new Set(['reserved', 'uploading', 'upload_uncertain', 'stocked', 'delivered', 'released']);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(value)) {
    fail('INVALID_ID', 'Use opaque IDs of 1–200 characters; never pass credentials or free text.');
  }
  return value;
}
function automatic(value) { return value && value.automaticDeliveryEnabled === true && value.deactivateWhenEmpty === true; }
function saleReference(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^(?:Z)?[1-9]\d*$/.test(value)) return value;
  fail('INVALID_EVIDENCE', 'Sale reference must be a canonical native identifier.');
}
function checkAutomatic(value) { if (!automatic(value)) fail('AUTOMATIC_DELIVERY_REQUIRED', 'Automatic delivery and deactivation when empty must both be verified.'); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function preparationGuard(value, { requireEmpty = false } = {}) {
  if (!value || value.pausedVerified !== true || value.dedicatedStorageVerified !== true ||
      (requireEmpty && value.emptyStorageVerified !== true)) fail('PREPARATION_UNVERIFIED', 'Preparation requires a verified paused offer and dedicated empty storage.');
  for (const key of ['storageCategoryId', 'gameId', 'categoryId', 'snapshotHash', 'storageNameHash', 'evidenceId']) id(value[key]);
  for (const key of ['storageCategoryId', 'gameId', 'categoryId']) {
    if (!/^[1-9]\d*$/.test(value[key])) fail('PREPARATION_UNVERIFIED', 'Preparation identities must be canonical native IDs.');
  }
  for (const key of ['snapshotHash', 'storageNameHash']) if (!/^[a-f0-9]{64}$/.test(value[key])) fail('PREPARATION_UNVERIFIED', 'Preparation requires exact snapshot and storage-name digests.');
  return value;
}
function samePreparation(a, b) {
  return ['storageCategoryId', 'gameId', 'categoryId', 'snapshotHash', 'storageNameHash'].every(key => a?.[key] === b?.[key]);
}
function initial() { return { version: 1, revision: 0, offers: [], batches: [], units: [] }; }
function validate(data) {
  if (data?.version !== 1 || !Number.isSafeInteger(data.revision) || data.revision < 0 ||
      !Array.isArray(data.offers) || !Array.isArray(data.batches) || !Array.isArray(data.units)) fail('CORRUPT_LEDGER', 'Invalid vault ledger.');
  const sources = new Set(), storage = new Set(), offers = new Set(), batches = new Set();
  for (const offer of data.offers) { id(offer.offerId); if (offers.has(offer.offerId)) fail('CORRUPT_LEDGER', 'Duplicate offer.'); offers.add(offer.offerId); }
  for (const batch of data.batches) {
    id(batch.batchId); id(batch.offerId);
    if (!offers.has(batch.offerId) || batches.has(batch.batchId)) fail('CORRUPT_LEDGER', 'Invalid batch.');
    if (batch.preparationOnly === true) preparationGuard(batch.preparation, { requireEmpty: true });
    batches.add(batch.batchId);
  }
  for (const unit of data.units) {
    id(unit.sourceId); id(unit.offerId); id(unit.batchId);
    if (!STATES.has(unit.status) || sources.has(unit.sourceId) || !batches.has(unit.batchId) || !offers.has(unit.offerId)) fail('CORRUPT_LEDGER', 'Invalid stock identity or state.');
    const batch = data.batches.find(b => b.batchId === unit.batchId);
    if (batch.offerId !== unit.offerId) fail('CORRUPT_LEDGER', 'Stock ownership mismatch.');
    sources.add(unit.sourceId);
    if (unit.storageId) { id(unit.storageId); if (storage.has(unit.storageId)) fail('CORRUPT_LEDGER', 'Duplicate remote stock identity.'); storage.add(unit.storageId); }
    if (['stocked', 'delivered', 'released'].includes(unit.status) && !unit.storageId) fail('CORRUPT_LEDGER', 'Missing remote stock identity.');
    if (unit.status === 'delivered' && !unit.deliveryId) fail('CORRUPT_LEDGER', 'Missing delivery evidence.');
    if (unit.saleReference !== undefined && saleReference(unit.saleReference) !== unit.saleReference) fail('CORRUPT_LEDGER', 'Invalid persisted sale reference.');
  }
  return data;
}
async function exists(file) { try { await fs.lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function readPrivate(file) {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 10 * 1024 * 1024) fail('UNSAFE_FILE', 'Ledger and lock files must be private regular files smaller than 10 MiB.');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

/** Durable local journal, not an upstream stock allocator or remote API adapter.
 * Callers must reserve stock through the existing Nodeserver stock layer FIRST.
 * Store this file in a private local directory, never in the public repository.
 * Locks have no expiry: an old lock is not evidence that its owner stopped.
 */
function openVaultLedger(filename, { lockTimeoutMs = 5000, pollMs = 20 } = {}) {
  if (!path.isAbsolute(filename)) fail('INVALID_PATH', 'An absolute private ledger path is required.');
  if (!(lockTimeoutMs >= 0 && lockTimeoutMs <= 60000) || !(pollMs >= 1 && pollMs <= 1000)) fail('INVALID_OPTIONS', 'Invalid lock timing.');
  const file = path.resolve(filename), lockFile = file + '.lock', recoveryFile = file + '.recover';
  async function load() { try { return validate(await readPrivate(file)); } catch (e) { if (e.code === 'ENOENT') return initial(); throw e; } }
  async function write(data) {
    const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(data) + '\n');
      await handle.sync(); await handle.close(); handle = null;
      await fs.rename(temp, file);
      const directory = await fs.open(path.dirname(file), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { if (handle) await handle.close(); await fs.unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async function acquire() {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (true) {
      if (!(await exists(recoveryFile))) {
        let handle;
        try { handle = await fs.open(lockFile, 'wx', 0o600); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        if (handle) {
          const owner = { version: 1, pid: process.pid, host: os.hostname(), token: randomUUID(), createdAt: new Date().toISOString() };
          try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); }
          finally { await handle.close(); }
          if (!(await exists(recoveryFile))) return owner;
          await release(owner);
        }
      }
      if (Date.now() - started >= lockTimeoutMs) fail('LEDGER_LOCKED', 'Ledger is locked; inspect the owner and explicitly recover a dead-process lock.');
      await wait(pollMs);
    }
  }
  async function release(owner) {
    const actual = await readPrivate(lockFile);
    if (actual.token !== owner.token || actual.pid !== owner.pid) fail('LOCK_CHANGED', 'Lock ownership changed; refusing to unlink it.');
    await fs.unlink(lockFile);
  }
  async function transaction(fn) {
    const owner = await acquire();
    try {
      const data = await load(); const result = fn(data);
      data.revision++; validate(data); await write(data);
      return structuredClone(result);
    } finally { await release(owner); }
  }
  function batchUnits(data, batchId) {
    id(batchId); const batch = data.batches.find(b => b.batchId === batchId);
    if (!batch) fail('BATCH_NOT_FOUND', 'Unknown batch.');
    return { batch, units: data.units.filter(u => u.batchId === batchId) };
  }
  function attachStorage(data, unit, storageId) {
    id(storageId);
    if (unit.storageId && unit.storageId !== storageId) fail('OWNERSHIP_MISMATCH', 'Source already belongs to another storage item.');
    if (data.units.some(u => u.sourceId !== unit.sourceId && u.storageId === storageId)) fail('DUPLICATE_STORAGE', 'Storage item already belongs to another source.');
    unit.storageId = storageId;
  }
  async function configureOffer(offerId, config) {
    id(offerId); checkAutomatic(config);
    return transaction(data => {
      const value = { offerId, automaticDeliveryEnabled: true, deactivateWhenEmpty: true };
      const index = data.offers.findIndex(o => o.offerId === offerId);
      if (index < 0) data.offers.push(value); else data.offers[index] = value;
      return value;
    });
  }
  async function disableOffer(offerId) {
    id(offerId);
    return transaction(data => {
      const value = { offerId, automaticDeliveryEnabled: false, deactivateWhenEmpty: false };
      const index = data.offers.findIndex(o => o.offerId === offerId);
      if (index < 0) data.offers.push(value); else data.offers[index] = value;
      return value;
    });
  }
  async function reserveBatch({ offerId, batchId, sourceIds }) {
    id(offerId); id(batchId);
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 1000) fail('INVALID_BATCH', 'A batch must contain 1–1000 source IDs.');
    sourceIds = sourceIds.map(id).sort();
    if (new Set(sourceIds).size !== sourceIds.length) fail('DUPLICATE_SOURCE', 'Duplicate source IDs.');
    return transaction(data => {
      checkAutomatic(data.offers.find(o => o.offerId === offerId));
      const existing = data.batches.find(b => b.batchId === batchId);
      if (existing) {
        if (existing.preparationOnly) fail('PREPARATION_REQUIRED', 'Use the paused preparation workflow for this batch.');
        const units = data.units.filter(u => u.batchId === batchId);
        if (existing.offerId !== offerId || !same(units.map(u => u.sourceId).sort(), sourceIds)) fail('BATCH_CONFLICT', 'Batch ID already identifies different stock.');
        return { batchId, units, replay: true };
      }
      if (data.units.some(u => sourceIds.includes(u.sourceId))) fail('DUPLICATE_SOURCE', 'A source ID is already journaled, including released or delivered stock.');
      data.batches.push({ batchId, offerId, attemptId: '' });
      const units = sourceIds.map(sourceId => ({ sourceId, batchId, offerId, status: 'reserved', storageId: '', deliveryId: '', evidenceId: '', updatedAt: new Date().toISOString() }));
      data.units.push(...units); return { batchId, units, replay: false };
    });
  }
  async function reservePreparationBatch({ offerId, batchId, sourceIds, guard }) {
    id(offerId); id(batchId); guard = { ...preparationGuard(guard) };
    if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 1000) fail('INVALID_BATCH', 'A batch must contain 1–1000 source IDs.');
    sourceIds = sourceIds.map(id).sort();
    if (new Set(sourceIds).size !== sourceIds.length) fail('DUPLICATE_SOURCE', 'Duplicate source IDs.');
    return transaction(data => {
      const existing = data.batches.find(batch => batch.batchId === batchId);
      if (existing) {
        const units = data.units.filter(unit => unit.batchId === batchId);
        if (!existing.preparationOnly || existing.offerId !== offerId || !samePreparation(existing.preparation, guard) ||
            !same(units.map(unit => unit.sourceId).sort(), sourceIds)) fail('BATCH_CONFLICT', 'Preparation batch identity changed.');
        return { batchId, units, replay: true };
      }
      preparationGuard(guard, { requireEmpty: true });
      if (data.batches.some(batch => batch.offerId === offerId || batch.preparation?.storageCategoryId === guard.storageCategoryId)) fail('PREPARATION_CONFLICT', 'Preparation requires a dedicated new offer/storage journal binding.');
      if (data.units.some(unit => sourceIds.includes(unit.sourceId))) fail('DUPLICATE_SOURCE', 'A source ID is already journaled.');
      const config = { offerId, automaticDeliveryEnabled: false, deactivateWhenEmpty: false };
      const index = data.offers.findIndex(offer => offer.offerId === offerId);
      if (index < 0) data.offers.push(config); else data.offers[index] = config;
      data.batches.push({ batchId, offerId, attemptId: '', preparationOnly: true, preparation: { ...guard } });
      const units = sourceIds.map(sourceId => ({ sourceId, batchId, offerId, status: 'reserved', storageId: '', deliveryId: '', evidenceId: '', updatedAt: new Date().toISOString() }));
      data.units.push(...units);
      return { batchId, units, replay: false };
    });
  }
  async function beginPreparationUpload(batchId, attemptId, guard) {
    id(attemptId); guard = { ...preparationGuard(guard) };
    return transaction(data => {
      const { batch, units } = batchUnits(data, batchId);
      if (!batch.preparationOnly || !samePreparation(batch.preparation, guard)) fail('PREPARATION_UNVERIFIED', 'Paused preparation evidence does not match this batch.');
      if (batch.attemptId) {
        if (batch.attemptId !== attemptId) fail('RECONCILIATION_REQUIRED', 'An earlier preparation attempt may have uploaded this stock.');
        return { maySubmit: false, batchId, attemptId, units };
      }
      preparationGuard(guard, { requireEmpty: true });
      if (units.some(unit => unit.status !== 'reserved')) fail('INVALID_TRANSITION', 'Only reserved preparation stock can begin upload.');
      if (data.batches.some(item => item.attemptId === attemptId)) fail('DUPLICATE_ATTEMPT', 'Upload attempt IDs must be unique.');
      batch.attemptId = attemptId;
      for (const unit of units) { unit.status = 'uploading'; unit.updatedAt = new Date().toISOString(); }
      return { maySubmit: true, batchId, attemptId, units };
    });
  }
  async function beginUpload(batchId, attemptId) {
    id(attemptId);
    return transaction(data => {
      const { batch, units } = batchUnits(data, batchId);
      if (batch.preparationOnly) fail('PREPARATION_REQUIRED', 'Preparation batches require fresh paused-offer evidence.');
      checkAutomatic(data.offers.find(o => o.offerId === batch.offerId));
      if (batch.attemptId) {
        if (batch.attemptId !== attemptId) fail('RECONCILIATION_REQUIRED', 'A previous attempt may have uploaded this stock.');
        return { maySubmit: false, batchId, attemptId, units };
      }
      if (units.some(u => u.status !== 'reserved')) fail('INVALID_TRANSITION', 'Only reserved stock may begin upload.');
      if (data.batches.some(b => b.attemptId === attemptId)) fail('DUPLICATE_ATTEMPT', 'Upload attempt IDs must be unique.');
      batch.attemptId = attemptId;
      for (const unit of units) { unit.status = 'uploading'; unit.updatedAt = new Date().toISOString(); }
      return { maySubmit: true, batchId, attemptId, units };
    });
  }
  async function markUploadUncertain(batchId, attemptId) {
    id(attemptId);
    return transaction(data => {
      const { batch, units } = batchUnits(data, batchId);
      if (batch.attemptId !== attemptId) fail('ATTEMPT_MISMATCH', 'Unknown upload attempt.');
      for (const unit of units) if (unit.status === 'uploading') { unit.status = 'upload_uncertain'; unit.updatedAt = new Date().toISOString(); }
      return { batchId, units };
    });
  }
  function applyEvidence(data, evidence) {
    const { sourceId, offerId, storageId, evidenceId, kind } = evidence;
    [sourceId, offerId, storageId, evidenceId].forEach(id);
    const unit = data.units.find(u => u.sourceId === sourceId);
    if (!unit || unit.offerId !== offerId) fail('OWNERSHIP_MISMATCH', 'Evidence does not match the reserved source and offer.');
    if (evidence.ownershipVerified !== true) fail('OWNERSHIP_UNVERIFIED', 'Explicit source-to-storage ownership evidence is required.');
    if (!['stocked', 'delivered', 'deleted_unsold'].includes(kind)) fail('INVALID_EVIDENCE', 'Missing rows, errors and timeouts are not stock evidence.');
    if (unit.status === 'reserved') fail('INVALID_TRANSITION', 'Stock has not begun upload.');
    attachStorage(data, unit, storageId);
    if (kind === 'stocked') {
      checkAutomatic(evidence);
      if (data.batches.find(batch => batch.batchId === unit.batchId)?.preparationOnly) checkAutomatic(data.offers.find(offer => offer.offerId === offerId));
      if (['delivered', 'released'].includes(unit.status)) fail('INVALID_TRANSITION', 'Terminal stock cannot become available again.');
      unit.status = 'stocked';
    } else if (kind === 'delivered') {
      id(evidence.deliveryId);
      if (evidence.deliverySucceeded !== true) fail('INVALID_EVIDENCE', 'Confirmed successful delivery is required.');
      if (unit.status === 'released' || (unit.deliveryId && unit.deliveryId !== evidence.deliveryId)) fail('INVALID_TRANSITION', 'Conflicting terminal delivery evidence.');
      if (data.units.some(u => u.sourceId !== sourceId && u.deliveryId === evidence.deliveryId)) fail('DUPLICATE_DELIVERY', 'Delivery unit ID belongs to another source.');
      if (evidence.saleReference !== undefined) {
        const reference = saleReference(evidence.saleReference);
        if (unit.saleReference && unit.saleReference !== reference) fail('INVALID_TRANSITION', 'Conflicting terminal sale reference.');
        unit.saleReference = reference;
      }
      unit.status = 'delivered'; unit.deliveryId = evidence.deliveryId;
    } else {
      if (evidence.deletionVerified !== true || evidence.unsoldVerified !== true || evidence.completeRead !== true) fail('INVALID_EVIDENCE', 'Verified deletion and complete unsold evidence are both required.');
      if (unit.status === 'delivered') fail('INVALID_TRANSITION', 'Delivered stock cannot be released.');
      unit.status = 'released';
    }
    unit.evidenceId = evidenceId; unit.updatedAt = new Date().toISOString(); return unit;
  }
  async function reconcile(evidence) { return transaction(data => applyEvidence(data, evidence)); }
  async function confirmStocked(batchId, { attemptId, items, automaticDeliveryEnabled, deactivateWhenEmpty, complete, evidenceId }) {
    id(attemptId); id(evidenceId); checkAutomatic({ automaticDeliveryEnabled, deactivateWhenEmpty });
    if (complete !== true || !Array.isArray(items)) fail('INCOMPLETE_EVIDENCE', 'A complete storage read is required.');
    return transaction(data => {
      const { batch, units } = batchUnits(data, batchId);
      if (batch.attemptId !== attemptId) fail('ATTEMPT_MISMATCH', 'Unknown upload attempt.');
      if (items.length !== units.length || new Set(items.map(i => i.sourceId)).size !== units.length || units.some(u => !items.some(i => i.sourceId === u.sourceId))) fail('INCOMPLETE_EVIDENCE', 'Storage mapping must cover every batch source exactly once.');
      return items.map(item => applyEvidence(data, { ...item, kind: 'stocked', offerId: batch.offerId, evidenceId, automaticDeliveryEnabled, deactivateWhenEmpty }));
    });
  }
  async function inspectLock() { try { return await readPrivate(lockFile); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  async function recoverDeadLock(expectedToken) {
    id(expectedToken);
    const handle = await fs.open(recoveryFile, 'wx', 0o600).catch(e => { if (e.code === 'EEXIST') fail('RECOVERY_LOCKED', 'Another recovery is running or needs manual inspection.'); throw e; });
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname() })); await handle.sync();
      const owner = await inspectLock();
      if (!owner || owner.token !== expectedToken || owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('LOCK_CHANGED', 'Recovery requires the exact local lock identity.');
      try { process.kill(owner.pid, 0); fail('OWNER_ALIVE', 'Lock owner is still alive.'); }
      catch (e) { if (e.code !== 'ESRCH') throw e; }
      await fs.unlink(lockFile); return { recovered: true };
    } finally { await handle.close(); await fs.unlink(recoveryFile); }
  }
  // Reads also serialize, so an uninitialized file cannot race the first writer.
  async function snapshot() { const owner = await acquire(); try { return structuredClone(await load()); } finally { await release(owner); } }
  return { configureOffer, disableOffer, reserveBatch, reservePreparationBatch, beginPreparationUpload, beginUpload, confirmStocked, markUploadUncertain, reconcile, snapshot, inspectLock, recoverDeadLock };
}

module.exports = { openVaultLedger };
