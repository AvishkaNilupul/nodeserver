'use strict';
const { buildImportFields } = require('./vaultProtocol');
const { createHash, randomUUID } = require('node:crypto');

function problem(code, message) { const error = new Error(message); error.code = code; return error; }
function opaqueId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(value); }
function decimalId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  throw problem('INVALID_ID', 'Native IDs must be canonical positive decimal strings or safe positive integers.');
}
function sameIds(a, b) { return Array.isArray(a) && a.length === b.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
function deliveryReady(actual, offerId, storageId, maxPurchaseQuantity) {
  if (!actual || !Number.isSafeInteger(maxPurchaseQuantity) || maxPurchaseQuantity < 1) return false;
  try {
    const cutoff = Number(decimalId(actual.buy_more));
    return decimalId(actual.id) === decimalId(offerId) && decimalId(actual.storage_id) === decimalId(storageId) &&
      [1, '1'].includes(actual.is_auto_deliver) && [1, '1'].includes(actual.outstock) && [0, '0'].includes(actual.is_agiso) &&
      Number.isSafeInteger(cutoff) && cutoff >= maxPurchaseQuantity;
  } catch { return false; }
}

/**
 * Upload ALREADY reserved stock. verifyReservation must query the real upstream
 * allocator; the file journal alone cannot prevent another market selling it.
 * Credentials stay in memory and the request payload, never in the ledger/result.
 * storageId here is the STORAGE CATEGORY; ledger storageId is the individual
 * PRODUCT ID returned by later verified reconciliation. Never interchange them.
 */
async function importReservedBatch({ ledger, protocol, verifyReservation, offerId, storageId,
  batchId, attemptId, kind, units, maxPurchaseQuantity, totalCostUsd = '0', priority = false,
  gameId, categoryId, parseDocument, maxPages = 100 }) {
  offerId = decimalId(offerId); storageId = decimalId(storageId);
  if (!opaqueId(batchId) || !opaqueId(attemptId)) throw problem('INVALID_ID', 'Invalid batch or attempt identity.');
  if (!Number.isSafeInteger(maxPurchaseQuantity) || maxPurchaseQuantity < 1) throw problem('INVALID_QUANTITY', 'A verified positive listing maximum purchase quantity is required.');
  if (!ledger || typeof ledger.disableOffer !== 'function' || !protocol || typeof protocol.readOfferDelivery !== 'function' || typeof protocol.importUnits !== 'function' || typeof verifyReservation !== 'function') throw problem('INVALID_ADAPTER', 'Ledger, native vault protocol and upstream reservation verifier are required.');
  if (!Array.isArray(units) || !units.length || units.some(unit => !opaqueId(unit?.sourceId))) throw problem('INVALID_STOCK', 'Reserved units need opaque source IDs.');
  const sourceIds = units.map(unit => unit.sourceId);
  if (new Set(sourceIds).size !== sourceIds.length) throw problem('DUPLICATE_SOURCE', 'Source IDs must be unique.');
  if (parseDocument !== undefined) {
    if (typeof parseDocument !== 'function' || typeof protocol.reconcileUploadedUnits !== 'function') throw problem('INVALID_ADAPTER', 'Automatic readback needs the DOM parser and protocol reconciler.');
    gameId = decimalId(gameId); categoryId = decimalId(categoryId);
  }
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 100) throw problem('INVALID_OPTIONS', 'Readback requires a bound of 1–100 pages.');
  const payload = { storageId, kind, totalCostUsd, priority, units: units.map(({ sourceId, ...unit }) => ({ ...unit,
    remark: unit.remark || 'z2u-' + createHash('sha256').update(batchId + '\0' + sourceId).digest('hex').slice(0, 32) })) };
  // Full format checks happen before recording an upload intent.
  buildImportFields(payload);
  if (payload.units.some(unit => unit.remark.length > 300)) throw problem('INVALID_MARKER', 'Import markers must be no longer than 300 characters.');
  if (new Set(payload.units.map(unit => unit.remark)).size !== units.length) throw problem('DUPLICATE_MARKER', 'Each source needs a unique import marker.');
  let receipt;
  try { receipt = await verifyReservation({ offerId, batchId, sourceIds: [...sourceIds] }); }
  catch { throw problem('RESERVATION_UNVERIFIED', 'Cannot verify the upstream stock reservation.'); }
  let receiptOffer;
  try { receiptOffer = decimalId(receipt?.offerId); } catch { /* invalid receipt */ }
  if (receipt?.verified !== true || !opaqueId(receipt.reservationId) || receiptOffer !== offerId || !sameIds(receipt.sourceIds, sourceIds)) throw problem('RESERVATION_UNVERIFIED', 'The upstream reservation must cover this offer and exactly these source IDs.');
  let actual;
  try { actual = await protocol.readOfferDelivery(offerId); }
  catch {
    await ledger.disableOffer(offerId);
    throw problem('DELIVERY_UNVERIFIED', 'Cannot verify current native automatic delivery settings.');
  }
  if (!deliveryReady(actual, offerId, storageId, maxPurchaseQuantity)) {
    await ledger.disableOffer(offerId);
    throw problem('AUTOMATIC_DELIVERY_REQUIRED', 'Current offer must use this native storage category, automatic delivery and out-of-stock deactivation.');
  }
  await ledger.configureOffer(offerId, { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
  await ledger.reserveBatch({ offerId, batchId, sourceIds });
  // Reserving may wait behind another worker's file lock. Refresh immediately
  // before intent so the earlier settings snapshot cannot authorize this send.
  try { actual = await protocol.readOfferDelivery(offerId); }
  catch { await ledger.disableOffer(offerId); throw problem('DELIVERY_UNVERIFIED', 'Cannot verify current native automatic delivery settings.'); }
  if (!deliveryReady(actual, offerId, storageId, maxPurchaseQuantity)) {
    await ledger.disableOffer(offerId);
    throw problem('AUTOMATIC_DELIVERY_REQUIRED', 'Native delivery changed before upload; stock remains reserved.');
  }
  const intent = await ledger.beginUpload(batchId, attemptId);
  const base = { batchId, attemptId, sourceCount: sourceIds.length, verified: false };
  async function readback(result) {
    if (parseDocument === undefined) return result;
    let remote;
    try { remote = await protocol.reconcileUploadedUnits({ storageId, gameId, categoryId, kind,
      units: payload.units, parseDocument, maxPages }); }
    catch { return { ...result, status: 'reconciliation_required', reason: 'readback_failed' }; }
    if (remote?.complete !== true || !Number.isSafeInteger(remote.total) || remote.total < units.length || remote.observed !== remote.total || !Array.isArray(remote.matched) || !Array.isArray(remote.missing) || !Array.isArray(remote.ambiguous) || remote.missing.length || remote.ambiguous.length || remote.matched.length !== units.length) {
      return { ...result, status: 'partial', reason: 'incomplete_readback' };
    }
    const indices = new Set(), products = new Set();
    const empty = value => value == null || value === '' || value === 0 || value === '0';
    for (const match of remote.matched) {
      let productId, matchedStorage, matchedGame, matchedCategory;
      try { productId = decimalId(match?.productId); matchedStorage = decimalId(match.storageId); matchedGame = decimalId(match.gameId); matchedCategory = decimalId(match.categoryId); }
      catch { return { ...result, status: 'reconciliation_required', reason: 'identity_mismatch' }; }
      if (!Number.isSafeInteger(match?.unitIndex) || match.unitIndex < 0 || match.unitIndex >= units.length ||
          indices.has(match.unitIndex) || products.has(productId) || matchedStorage !== storageId || matchedGame !== gameId || matchedCategory !== categoryId) {
        return { ...result, status: 'reconciliation_required', reason: 'identity_mismatch' };
      }
      if (match.unsoldVerified !== true || match.status !== 1 || !empty(match.usedTime) || !empty(match.saleReference)) return { ...result, status: 'reconciliation_required', reason: 'stock_not_proven_unused' };
      indices.add(match.unitIndex); products.add(productId);
    }
    let current;
    try { current = await protocol.readOfferDelivery(offerId); }
    catch { await ledger.disableOffer(offerId); return { ...result, status: 'reconciliation_required', reason: 'delivery_unverified' }; }
    if (!deliveryReady(current, offerId, storageId, maxPurchaseQuantity)) {
      await ledger.disableOffer(offerId); return { ...result, status: 'reconciliation_required', reason: 'delivery_disabled' };
    }
    await ledger.confirmStocked(batchId, { attemptId, complete: true, evidenceId: 'readback-' + randomUUID(),
      automaticDeliveryEnabled: true, deactivateWhenEmpty: true,
      items: remote.matched.map(match => ({ sourceId: units[match.unitIndex].sourceId, storageId: decimalId(match.productId), ownershipVerified: true })) });
    return { ...result, status: 'stocked', verified: true, stocked: units.length };
  }
  if (!intent.maySubmit) return readback({ ...base, status: 'reconciliation_required', dispatched: false, acknowledged: false });
  let acknowledgment;
  try { acknowledgment = await protocol.importUnits(payload); }
  catch {
    // Even a thrown local read may follow an earlier dispatched write in an
    // adapter. Only remote evidence can free the stock; never guess from errors.
    await ledger.markUploadUncertain(batchId, attemptId);
    return readback({ ...base, status: 'upload_uncertain', dispatched: 'unknown', acknowledged: false });
  }
  // A successful response is not proof that every row exists remotely.
  await ledger.markUploadUncertain(batchId, attemptId);
  return readback({ ...base, status: 'awaiting_reconciliation', dispatched: true, acknowledged: acknowledgment?.acknowledged === true });
}

/** Apply explicit readback evidence; missing entries remain held, never freed. */
async function reconcileImportedBatch({ ledger, batchId, attemptId, evidence }) {
  const snapshot = await ledger.snapshot();
  const batch = snapshot.batches.find(item => item.batchId === batchId);
  if (!batch || batch.attemptId !== attemptId) throw problem('ATTEMPT_MISMATCH', 'Reconciliation must name the recorded upload attempt.');
  const units = snapshot.units.filter(unit => unit.batchId === batchId);
  if (!evidence || !Array.isArray(evidence.items) || !opaqueId(evidence.evidenceId)) throw problem('INVALID_EVIDENCE', 'Explicit storage evidence is required.');
  const seen = new Set();
  for (const item of evidence.items) {
    if (!opaqueId(item?.sourceId) || !opaqueId(item.storageId) || item.ownershipVerified !== true || seen.has(item.sourceId) || !units.some(unit => unit.sourceId === item.sourceId)) throw problem('OWNERSHIP_MISMATCH', 'Readback must map distinct reserved sources to verified storage product IDs.');
    seen.add(item.sourceId);
  }
  if (evidence.complete === true) {
    await ledger.confirmStocked(batchId, { ...evidence, attemptId });
  } else {
    for (const item of evidence.items) {
      await ledger.reconcile({ ...item, kind: 'stocked', offerId: batch.offerId, evidenceId: evidence.evidenceId,
        automaticDeliveryEnabled: evidence.automaticDeliveryEnabled, deactivateWhenEmpty: evidence.deactivateWhenEmpty });
    }
  }
  const current = (await ledger.snapshot()).units.filter(unit => unit.batchId === batchId);
  const stocked = current.filter(unit => unit.status === 'stocked').length;
  const delivered = current.filter(unit => unit.status === 'delivered').length;
  const released = current.filter(unit => unit.status === 'released').length;
  const held = current.length - stocked - delivered - released;
  return { batchId, attemptId, status: stocked === current.length ? 'stocked' : 'partial', verified: stocked === current.length,
    sourceCount: current.length, stocked, delivered, released, held };
}

module.exports = { importReservedBatch, reconcileImportedBatch, deliveryReady };
