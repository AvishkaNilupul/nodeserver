'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { buildImportFields } = require('./vaultProtocol');
const { verifyOfferSnapshot } = require('./offers');
const { deliveryReady } = require('./vaultImport');

function fail(code) { const error = new Error(code); error.code = code; throw error; }
function decimal(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  fail('INVALID_ID');
}
function opaque(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(value); }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function sameIds(a, b) { return Array.isArray(a) && a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
const SAFE = new Set(['OFFER_NOT_PAUSED', 'OFFER_UNVERIFIED', 'STORAGE_UNVERIFIED', 'STORAGE_NOT_EMPTY', 'RESERVATION_UNVERIFIED', 'RECONCILIATION_REQUIRED', 'DELIVERY_UNVERIFIED', 'READBACK_INCOMPLETE', 'READBACK_MISMATCH', 'BATCH_CONFLICT', 'PREPARATION_CONFLICT', 'PREPARATION_REQUIRED']);

/**
 * Bootstrap only a reviewed PAUSED offer with a newly created dedicated account
 * category. Z2U refuses native-auto configuration until that category has stock.
 * expectedStorageName comes from the fresh category-creation record, not a title
 * search or select-option availability. No publish/resume/release path exists.
 */
async function prepareReservedBatch({ ledger, protocol, verifyReservation, verifyDedicatedStorage, offerId, storageId, gameId, categoryId,
  expectedSnapshot, expectedStorageName, batchId, attemptId, units, maxPurchaseQuantity,
  parseDocument, maxPages = 100, note = '', totalCostUsd = '0', priority = false }) {
  offerId = decimal(offerId); storageId = decimal(storageId); gameId = decimal(gameId); categoryId = decimal(categoryId);
  if (!opaque(batchId) || !opaque(attemptId)) fail('INVALID_ID');
  if (!Number.isSafeInteger(maxPurchaseQuantity) || maxPurchaseQuantity < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) fail('INVALID_QUANTITY');
  if (typeof expectedStorageName !== 'string' || !expectedStorageName.trim() || expectedStorageName.length > 300 ||
      typeof parseDocument !== 'function' || typeof verifyReservation !== 'function' || typeof verifyDedicatedStorage !== 'function' || typeof note !== 'string') fail('INVALID_PREPARATION');
  for (const method of ['reservePreparationBatch', 'beginPreparationUpload', 'snapshot', 'disableOffer', 'configureOffer', 'markUploadUncertain', 'confirmStocked']) {
    if (typeof ledger?.[method] !== 'function') fail('INVALID_ADAPTER');
  }
  for (const method of ['readOfferSnapshot', 'readStorage', 'readOfferDelivery', 'reconcileUploadedUnits', 'importUnits', 'configureNativeDelivery', 'pauseOffer']) {
    if (typeof protocol?.[method] !== 'function') fail('INVALID_ADAPTER');
  }
  if (!Array.isArray(units) || !units.length || units.some(unit => !opaque(unit?.sourceId))) fail('INVALID_STOCK');
  units = structuredClone(units);
  const sourceIds = units.map(unit => unit.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) fail('DUPLICATE_SOURCE');
  expectedSnapshot = structuredClone(expectedSnapshot);
  if (expectedSnapshot?.offerId !== offerId || expectedSnapshot.gameId !== gameId || expectedSnapshot.categoryId !== categoryId ||
      expectedSnapshot.status !== 'paused' || expectedSnapshot.statusCode !== 4 ||
      expectedSnapshot.constraints?.maxPurchaseQuantity !== maxPurchaseQuantity || !verifyOfferSnapshot(expectedSnapshot, expectedSnapshot).verified) fail('INVALID_PREPARATION');
  const payload = { storageId, kind: 'account', totalCostUsd, priority, units: units.map(({ sourceId, ...unit }) => ({ ...unit,
    remark: unit.remark || 'z2u-' + createHash('sha256').update(batchId + '\0' + sourceId).digest('hex').slice(0, 32) })) };
  buildImportFields(payload);
  if (payload.units.some(unit => unit.remark.length > 300) || new Set(payload.units.map(unit => unit.remark)).size !== units.length) fail('INVALID_MARKER');
  const scope = { offerId, gameId, categoryId, parseDocument, maxPages };
  const base = { batchId, attemptId, sourceCount: units.length, verified: false, preparationOnly: true };
  const guard = { storageCategoryId: storageId, gameId, categoryId, snapshotHash: hash(expectedSnapshot), storageNameHash: hash(expectedStorageName),
    evidenceId: 'prepare-' + randomUUID(), pausedVerified: true, dedicatedStorageVerified: true, emptyStorageVerified: false };
  let intentRecorded = false, dispatched = false, acknowledged = false;

  async function paused() {
    const actual = await protocol.readOfferSnapshot(scope);
    if (actual?.status === 'on_sale') fail('OFFER_NOT_PAUSED');
    if (actual?.status !== 'paused' || actual.statusCode !== 4 || !verifyOfferSnapshot(actual, expectedSnapshot).verified ||
        actual.constraints?.maxPurchaseQuantity !== maxPurchaseQuantity) fail('OFFER_UNVERIFIED');
  }
  async function storage() {
    const actual = await protocol.readStorage(storageId);
    let matches = false;
    try { matches = decimal(actual?.id) === storageId && decimal(actual.gid) === gameId && decimal(actual.category_id) === categoryId; } catch { /* Refuse coercion. */ }
    if (!matches || actual.name !== expectedStorageName || ![1, '1'].includes(actual.type) || ![2, '2'].includes(actual.is_repeat) ||
        (actual.parent_id !== undefined && ![0, '0'].includes(actual.parent_id))) fail('STORAGE_UNVERIFIED');
  }
  async function reservation() {
    let receipt;
    try { receipt = await verifyReservation({ offerId, batchId, sourceIds: [...sourceIds] }); } catch { fail('RESERVATION_UNVERIFIED'); }
    let matches = false;
    try { matches = decimal(receipt?.offerId) === offerId; } catch { /* Invalid receipt. */ }
    if (receipt?.verified !== true || !matches || !opaque(receipt.reservationId) || !sameIds(receipt.sourceIds, sourceIds)) fail('RESERVATION_UNVERIFIED');
  }
  async function dedicated() {
    let receipt;
    try { receipt = await verifyDedicatedStorage({ offerId, storageId, gameId, categoryId }); } catch { fail('STORAGE_UNVERIFIED'); }
    try {
      if (receipt?.verified !== true || decimal(receipt.offerId) !== offerId || decimal(receipt.storageId) !== storageId ||
          decimal(receipt.gameId) !== gameId || decimal(receipt.categoryId) !== categoryId) fail('STORAGE_UNVERIFIED');
    } catch { fail('STORAGE_UNVERIFIED'); }
  }
  const readback = () => protocol.reconcileUploadedUnits({ storageId, gameId, categoryId, kind: 'account', units: payload.units, parseDocument, maxPages });
  function empty(remote) {
    return remote?.complete === true && remote.total === 0 && remote.observed === 0 &&
      Array.isArray(remote.matched) && remote.matched.length === 0 && Array.isArray(remote.ambiguous) && remote.ambiguous.length === 0 &&
      sameIds(remote.missing, units.map((_unit, index) => index));
  }
  function mapping(remote) {
    if (remote?.complete !== true || remote.total !== units.length || remote.observed !== remote.total ||
        !Array.isArray(remote.matched) || remote.matched.length !== units.length || !Array.isArray(remote.missing) || remote.missing.length ||
        !Array.isArray(remote.ambiguous) || remote.ambiguous.length) fail('READBACK_INCOMPLETE');
    const indices = new Set(), products = new Set(), items = [];
    for (const match of remote.matched) {
      let productId, identity = false;
      try { productId = decimal(match?.productId); identity = decimal(match.storageId) === storageId && decimal(match.gameId) === gameId && decimal(match.categoryId) === categoryId; } catch { /* Fail below. */ }
      if (!identity || !Number.isSafeInteger(match.unitIndex) || match.unitIndex < 0 || match.unitIndex >= units.length || indices.has(match.unitIndex) || products.has(productId) ||
          match.unsoldVerified !== true || match.status !== 1 || ![null, undefined, '', 0, '0'].includes(match.usedTime) || ![null, undefined, '', 0, '0'].includes(match.saleReference)) fail('READBACK_MISMATCH');
      indices.add(match.unitIndex); products.add(productId);
      items.push({ sourceId: units[match.unitIndex].sourceId, storageId: productId, ownershipVerified: true });
    }
    return items;
  }
  try {
    const snapshot = await ledger.snapshot();
    const existing = snapshot.batches.find(batch => batch.batchId === batchId);
    if (existing && !existing.preparationOnly) fail('BATCH_CONFLICT');
    if (existing?.attemptId && existing.attemptId !== attemptId) fail('RECONCILIATION_REQUIRED');
    intentRecorded = !!existing?.attemptId;
    await paused(); await storage(); await reservation();
    const beforeSettings = await protocol.readOfferDelivery(offerId);
    let settingsOwned = false, storageBound = [0, '0'].includes(beforeSettings?.storage_id);
    try {
      settingsOwned = decimal(beforeSettings?.id) === offerId;
      if (!storageBound) storageBound = decimal(beforeSettings.storage_id) === storageId;
    } catch { /* Refuse foreign/malformed delivery settings. */ }
    // Live getProDetail uses 2 for disabled, 1 for enabled. Unknown zero/null
    // flags cannot silently become permission to bootstrap another binding.
    if (!settingsOwned || !storageBound || ![2, '2', 1, '1'].includes(beforeSettings.is_auto_deliver)) fail('DELIVERY_UNVERIFIED');
    if (!deliveryReady(beforeSettings, offerId, storageId, maxPurchaseQuantity)) await ledger.disableOffer(offerId);
    if (!intentRecorded) {
      await dedicated();
      if (!empty(await readback())) fail('STORAGE_NOT_EMPTY');
      guard.emptyStorageVerified = true;
    }
    await paused(); await storage();
    await ledger.reservePreparationBatch({ offerId, batchId, sourceIds, guard });
    // The file lock can wait behind another caller. The last remote proof before
    // durable intent must still say exact paused offer and dedicated category.
    // Dedicated-category scans can be slow; renew the credential-bound source
    // proof after them, rather than uploading the earlier verified password.
    if (!intentRecorded) await reservation();
    await paused();
    const intent = await ledger.beginPreparationUpload(batchId, attemptId, guard);
    intentRecorded = true;
    if (intent.maySubmit) {
      try { const response = await protocol.importUnits(payload); dispatched = true; acknowledged = response?.acknowledged === true; }
      catch { dispatched = 'unknown'; }
      await ledger.markUploadUncertain(batchId, attemptId);
    }
    await paused(); await storage();
    let items = mapping(await readback());
    await paused();
    // A native settings write is idempotent, but its acknowledgment is never
    // readiness proof. A crash after it converges from fresh readback on retry.
    let settings = await protocol.readOfferDelivery(offerId);
    if (!deliveryReady(settings, offerId, storageId, maxPurchaseQuantity)) {
      await ledger.disableOffer(offerId);
      try { await protocol.configureNativeDelivery({ offerId, storageId, maxPurchaseQuantity, note }); }
      catch { /* A lost response can still have changed native settings. */ }
    }
    await paused(); await storage();
    settings = await protocol.readOfferDelivery(offerId);
    if (!deliveryReady(settings, offerId, storageId, maxPurchaseQuantity)) fail('DELIVERY_UNVERIFIED');
    items = mapping(await readback());
    await paused();
    if (!deliveryReady(await protocol.readOfferDelivery(offerId), offerId, storageId, maxPurchaseQuantity)) fail('DELIVERY_UNVERIFIED');
    // False remains persisted until native settings AND final paused/readback
    // checks prove the entire bootstrap ready. Never emulate auto-enabled state.
    await ledger.configureOffer(offerId, { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
    await ledger.confirmStocked(batchId, { attemptId, complete: true, evidenceId: 'prepared-' + randomUUID(),
      automaticDeliveryEnabled: true, deactivateWhenEmpty: true, items });
    await paused();
    if (!deliveryReady(await protocol.readOfferDelivery(offerId), offerId, storageId, maxPurchaseQuantity)) fail('DELIVERY_UNVERIFIED');
    return { ...base, status: 'stocked', verified: true, stocked: units.length, dispatched, acknowledged };
  } catch (error) {
    try { await ledger.disableOffer(offerId); } catch { /* Remote containment must still run when journal storage fails. */ }
    let pauseVerified = false;
    try { const result = await protocol.pauseOffer(scope); pauseVerified = result?.verified === true && result.status === 'paused'; } catch { /* Remains held. */ }
    const reason = SAFE.has(error?.code) ? error.code : 'PREPARATION_UNVERIFIED';
    if (!intentRecorded) fail(reason);
    return { ...base, status: 'held', reason, dispatched, acknowledged, pauseVerified };
  }
}

module.exports = { prepareReservedBatch };
