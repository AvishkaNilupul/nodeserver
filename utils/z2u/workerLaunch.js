'use strict';
const path = require('node:path');
const { readPrivate, fault } = require('./privateStore');
const { activateOneUnitOffer, adoptionDigest, accountDigest } = require('./launch');
const { loadConfig, parseDocument } = require('./runtime');

/** Explicit startup launch runs inside the sole authenticated worker process. */
async function launchFromWorker({ stateDir, client, protocol, ledger, stockAdapter, offer, signal,
  launch = activateOneUnitOffer, read = readPrivate, readConfig = loadConfig, now = () => new Date().toISOString() }) {
  const checkAbort = () => { if (signal?.aborted) throw fault('ABORTED'); };
  checkAbort();
  const verifySource = async identity => {
    checkAbort();
    const before = await stockAdapter.readBatchState({ batchId: identity.batchId, offerId: identity.offerId });
    checkAbort();
    if (!Number.isSafeInteger(before.holdCount) || before.holdCount !== 1 || !before.expiresAt) throw fault('SOURCE_UNVERIFIED');
    // This is an existing journaled batch. Its immutable Mongo anchor is read
    // before recovery, so a missing source batch cannot start another claim.
    const reserved = await stockAdapter.reserveExactBatch({ batchId: identity.batchId, offerId: identity.offerId, setId: identity.setId, count: 1, existingOnly: true });
    checkAbort();
    if (reserved.status !== 'reserved' || reserved.units?.length !== 1 || reserved.units[0].sourceId !== identity.sourceId || typeof reserved.verifyReservation !== 'function') throw fault('SOURCE_UNVERIFIED');
    const proof = await reserved.verifyReservation({ batchId: identity.batchId, offerId: identity.offerId, sourceIds: [identity.sourceId] });
    checkAbort();
    if (proof.verified !== true || proof.offerId !== identity.offerId || proof.sourceIds?.length !== 1 || proof.sourceIds[0] !== identity.sourceId) throw fault('SOURCE_UNVERIFIED');
    return { ...identity, verified: true, checkedAt: now(), expiresAt: proof.expiresAt,
      credentialDigest: accountDigest(reserved.units[0].account, reserved.units[0].password) };
  };
  const verifyWorker = async identity => {
    checkAbort();
    const health = await read(path.join(stateDir, 'health.json'));
    const current = (await readConfig(stateDir)).offers.find(row => row.offerId === offer.offerId);
    checkAbort();
    const digest = current && adoptionDigest(current);
    const guards = health.protectionChecks?.filter(row => row.offerId === offer.offerId) || [];
    if (digest !== identity.configDigest || health.adoptedOfferDigests?.[offer.offerId] !== digest ||
        health.mode !== 'protect' || health.access?.sellerAccess !== true || health.access?.storageAccess !== true ||
        guards.length !== 1 || !['verified', 'offer_hold'].includes(guards[0].protection) || guards[0].saleReconciliation !== 'verified') throw fault('WORKER_UNVERIFIED');
    // Keep the persisted observation time. Calling this verifier cannot make
    // stale protection evidence fresh merely by returning the current clock.
    return { verified: true, running: !signal?.aborted, offerId: offer.offerId, configDigest: digest, checkedAt: health.checkedAt };
  };
  return launch({ stateDir, client, protocol, ledger, offer, verifySource, verifyWorker, parseDocument });
}
module.exports = { launchFromWorker };
