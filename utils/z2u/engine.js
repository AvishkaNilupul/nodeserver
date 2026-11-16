'use strict';
const { randomUUID } = require('node:crypto');
const { verifyOfferSnapshot } = require('./offers');
const { importReservedBatch, deliveryReady } = require('./vaultImport');
const { reconcileProduct } = require('./lifecycle');
const { parseDocument } = require('./runtime');
const { fault } = require('./privateStore');

async function verifyAdoptedOffer(protocol, offer) {
  if (!offer?.expectedSnapshot || typeof offer.setId !== 'string' || offer.kind !== 'account') throw fault('OFFER_UNVERIFIED');
  const actual = await protocol.readOfferSnapshot({ offerId: offer.offerId, gameId: offer.gameId, categoryId: offer.categoryId, parseDocument });
  if (!verifyOfferSnapshot(actual, offer.expectedSnapshot).verified || actual.constraints.maxPurchaseQuantity !== offer.maxPurchaseQuantity) throw fault('OFFER_UNVERIFIED');
  const settings = await protocol.readOfferDelivery(offer.offerId);
  if (!deliveryReady(settings, offer.offerId, offer.storageId, offer.maxPurchaseQuantity)) throw fault('DELIVERY_UNVERIFIED');
  return actual;
}

/** Explicit bounded stock operation. Nothing here creates or revives an offer. */
async function stockOffer({ protocol, ledger, stockAdapter, offer, count, batchId, attemptId = randomUUID() }) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 5 || typeof batchId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,100}$/.test(batchId)) throw fault('INVALID_STOCK_REQUEST');
  await verifyAdoptedOffer(protocol, offer);
  const reservation = await stockAdapter.reserveExactBatch({ batchId, offerId: offer.offerId, setId: offer.setId, count });
  if (reservation.status !== 'reserved' || !Array.isArray(reservation.units) || reservation.units.length !== count || typeof reservation.verifyReservation !== 'function') {
    return { batchId, status: 'held', reason: 'reservation_incomplete' };
  }
  const verifyReservation = async input => {
    // The allocator may have made slow remote inventory reads. Repeat the exact
    // content and quantity checks immediately before the import's own gates.
    const proof = await reservation.verifyReservation(input);
    await verifyAdoptedOffer(protocol, offer);
    return proof;
  };
  const existing = (await ledger.snapshot()).batches.find(row => row.batchId === batchId);
  const result = await importReservedBatch({ ledger, protocol, verifyReservation, offerId: offer.offerId,
    storageId: offer.storageId, gameId: offer.gameId, categoryId: offer.categoryId,
    batchId, attemptId: existing?.attemptId || attemptId, kind: 'account', units: reservation.units,
    maxPurchaseQuantity: offer.maxPurchaseQuantity, parseDocument });
  return { ...result, expiresAt: reservation.expiresAt };
}

async function reconcileOffer({ protocol, ledger, stockAdapter, offer, verifyDeliveryReceipt, now = Date.now, expiryBufferMs = 6 * 60 * 60 * 1000 }) {
  // Changed/paused listings must not suppress reconciliation of inventory that
  // is already committed. Their readiness gate is independent of sale proof.
  let offerReady = false;
  try {
    const actual = await protocol.readOfferSnapshot({ offerId: offer.offerId, gameId: offer.gameId, categoryId: offer.categoryId, parseDocument });
    const expected = { ...offer.expectedSnapshot, status: actual.status,
      fields: { ...offer.expectedSnapshot?.fields, list_stock_num: actual.fields?.list_stock_num } };
    const settings = await protocol.readOfferDelivery(offer.offerId);
    offerReady = verifyOfferSnapshot(actual, expected).verified && actual.status === 'on_sale' &&
      actual.constraints.maxPurchaseQuantity === offer.maxPurchaseQuantity &&
      deliveryReady(settings, offer.offerId, offer.storageId, offer.maxPurchaseQuantity);
  } catch { /* Already-uploaded products still require reconciliation. */ }
  const snapshot = await ledger.snapshot();
  const units = snapshot.units.filter(row => row.offerId === offer.offerId && row.status !== 'released');
  const outstanding = units.filter(row => row.status !== 'delivered');
  let protection = 'verified';
  let expirySafe = Number.isSafeInteger(expiryBufferMs) && expiryBufferMs >= 6 * 60 * 60 * 1000;
  for (const batchId of new Set(outstanding.map(row => row.batchId))) {
    try {
      const source = await stockAdapter.readBatchState({ batchId, offerId: offer.offerId });
      const expires = typeof source.expiresAt === 'string' ? Date.parse(source.expiresAt) : NaN;
      if (!Number.isFinite(expires) || expires <= now() + expiryBufferMs || !Number.isSafeInteger(source.holdCount) || source.holdCount < outstanding.filter(row => row.batchId === batchId).length) expirySafe = false;
    } catch { expirySafe = false; }
  }
  if (outstanding.length && (!expirySafe || !offerReady)) {
    offerReady = false;
    try {
      const paused = await protocol.pauseOffer({ offerId: offer.offerId, gameId: offer.gameId, categoryId: offer.categoryId, parseDocument });
      protection = paused.verified === true ? (!expirySafe ? 'expiry_hold' : 'offer_hold') : 'pause_unverified';
    } catch { protection = 'pause_unverified'; }
  }
  const counts = { unsold: 0, delivered: 0, consumed_pending_confirmation: 0, held: 0 };
  for (const unit of units) {
    if (!unit.storageId) { counts.held++; continue; }
    const result = await reconcileProduct({ ledger, protocol, sourceId: unit.sourceId, offerId: offer.offerId,
      productId: unit.storageId, storageId: offer.storageId, gameId: offer.gameId, categoryId: offer.categoryId,
      verifyDeliveryReceipt });
    if (result.state === 'delivered') {
      // Replay this projection on every pass. A crash after journal commit must
      // not permanently skip the cross-market allocator's sale record.
      if (!stockAdapter || !result.saleReference) { counts.held++; continue; }
      await stockAdapter.markDelivered({ batchId: unit.batchId, sourceId: unit.sourceId, offerId: offer.offerId,
        productId: unit.storageId, evidenceId: result.evidenceId, deliveryId: result.deliveryId, saleReference: result.saleReference });
    }
    counts[result.state] = (counts[result.state] || 0) + 1;
  }
  return { ready: offerReady && counts.unsold > 0 && counts.held === 0 && counts.consumed_pending_confirmation === 0,
    saleReconciliation: counts.held || counts.consumed_pending_confirmation ? 'held' : 'verified', protection, counts };
}
module.exports = { verifyAdoptedOffer, stockOffer, reconcileOffer };
