'use strict';
const { DOMParser } = require('linkedom');
const { createZ2uClient } = require('./client');
const { createVaultProtocol, extractStoragePage } = require('./vaultProtocol');
const { extractOrderPage } = require('./orderAudit');
const { deliveryReady } = require('./vaultImport');
const { fault, readPrivate, writePrivate } = require('./privateStore');
const { openSession } = require('./session');
const { adoptionDigest } = require('./launch');
const path = require('node:path');

const parseDocument = html => new DOMParser().parseFromString(html, 'text/html');
const CODES = new Set(['ABORTED', 'SESSION_EXPIRED', 'PRIVACY_LOCKED', 'STORAGE_DISABLED', 'CHALLENGE', 'SESSION_SETUP_FAILED', 'READ_FAILED', 'HTTP_ERROR', 'RESPONSE_TOO_LARGE', 'SESSION_UNVERIFIED', 'INVALID_RESPONSE', 'REDIRECT', 'REQUEST_REJECTED', 'DELIVERY_UNVERIFIED', 'OFFER_UNVERIFIED', 'INVALID_CONFIG', 'ENOENT']);
const safeCode = error => CODES.has(error?.code) ? error.code : 'CHECK_FAILED';
const checkAbort = signal => { if (signal?.aborted) throw fault('ABORTED'); };
const errorState = error => ['SESSION_EXPIRED', 'PRIVACY_LOCKED', 'STORAGE_DISABLED', 'SESSION_SETUP_FAILED', 'INVALID_CONFIG', 'ENOENT'].includes(error?.code) ? 'blocked' : 'unknown';
function protectionSummary(offerId, result) {
  const protection = ['verified', 'expiry_hold', 'offer_hold', 'pause_unverified'].includes(result?.protection) ? result.protection : 'unverified';
  const saleReconciliation = ['verified', 'held', 'not_connected'].includes(result?.saleReconciliation) ? result.saleReconciliation : 'held';
  return { offerId, ready: result?.ready === true, protection, saleReconciliation };
}
async function verifyAccess(client, { signal } = {}) {
  checkAbort(signal);
  const document = parseDocument(await client.readPage('/sellOrder/index/order_status/ALL'));
  const orders = extractOrderPage(document);
  const sellerAccess = Number.isSafeInteger(orders.counts.ALL) && orders.counts.ALL >= 0;
  if (!sellerAccess) throw fault('SESSION_UNVERIFIED');
  checkAbort(signal);
  const storage = extractStoragePage(parseDocument(await client.readPage('/userStorage/product')));
  if (!Number.isSafeInteger(storage.total) || storage.total < 0) throw fault('SESSION_UNVERIFIED');
  return { sellerAccess: true, storageAccess: true, storageVisible: storage.total, orderTotal: orders.counts.ALL };
}
function validateConfig(config) {
  if (!config || config.version !== 1 || !Array.isArray(config.offers) || config.offers.length > 20) throw fault('INVALID_CONFIG');
  const seen = new Set(), storages = new Set();
  for (const offer of config.offers) {
    if (!offer || !['offerId', 'storageId', 'gameId', 'categoryId'].every(key => typeof offer[key] === 'string' && /^[1-9]\d*$/.test(offer[key])) || seen.has(offer.offerId) || storages.has(offer.storageId) || !Number.isSafeInteger(offer.maxPurchaseQuantity) || offer.maxPurchaseQuantity < 1 || !['account', 'code'].includes(offer.kind)) throw fault('INVALID_CONFIG');
    // Offer IDs and exact source sets are explicitly adopted. A matching title
    // never grants permission to feed or revive another product.
    if (offer.setId !== undefined && !/^[a-f0-9]{24}$/.test(offer.setId)) throw fault('INVALID_CONFIG');
    seen.add(offer.offerId); storages.add(offer.storageId);
  }
  return config;
}
async function loadConfig(stateDir) {
  try { return validateConfig(await readPrivate(path.join(stateDir, 'config.json'))); }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, offers: [] }; throw error; }
}
async function connect(stateDir, options = {}) {
  const session = await openSession(path.join(stateDir, 'session.json'));
  const client = createZ2uClient({ ...options, ...session });
  return { client, protocol: createVaultProtocol(client) };
}
async function runCheck({ stateDir, client, protocol, config, previous = {}, now = () => new Date().toISOString(), checkOffer, signal } = {}) {
  const status = { version: 1, mode: config?.offers?.length ? 'protect' : 'observe', checkedAt: now(), lastSuccessAt: previous.lastSuccessAt || null,
    adoptedOfferDigests: {},
    accessLastSuccessAt: previous.accessLastSuccessAt || null,
    consecutiveFailures: Number.isSafeInteger(previous.consecutiveFailures) && previous.consecutiveFailures >= 0 ? previous.consecutiveFailures : 0, access: null, protectionChecks: [], offers: [], alerts: [], healthy: false };
  try {
    checkAbort(signal);
    validateConfig(config);
    for (const offer of config.offers) {
      try { status.adoptedOfferDigests[offer.offerId] = adoptionDigest(offer); } catch { /* Invalid adoption cannot authorize a launch. */ }
    }
    // Protection owns its own authenticated protocol checks. A changed global
    // storage template or its separate privacy gate must not skip pausing an
    // adopted offer whose committed inventory is expiring. Cache each result so
    // the health pass cannot repeat the protection action in the same cycle.
    const protectedOffers = new Map();
    for (const offer of config.offers) {
      checkAbort(signal);
      let summary, error;
      try {
        const result = checkOffer ? await checkOffer(offer, { signal }) : { saleReconciliation: 'not_connected' };
        checkAbort(signal);
        summary = protectionSummary(offer.offerId, result);
      } catch (caught) {
        if (signal?.aborted || caught?.code === 'ABORTED') throw fault('ABORTED');
        error = caught;
        summary = { ...protectionSummary(offer.offerId), code: safeCode(caught), state: errorState(caught) };
      }
      status.protectionChecks.push(summary);
      protectedOffers.set(offer.offerId, { summary, error });
    }
    status.access = await verifyAccess(client, { signal });
    checkAbort(signal);
    status.accessLastSuccessAt = status.checkedAt;
    for (const offer of config.offers) {
      checkAbort(signal);
      try {
        const cached = protectedOffers.get(offer.offerId);
        if (cached.error) throw cached.error;
        const extra = cached.summary;
        checkAbort(signal);
        const actual = await protocol.readOfferDelivery(offer.offerId);
        checkAbort(signal);
        const automaticDelivery = deliveryReady(actual, offer.offerId, offer.storageId, offer.maxPurchaseQuantity);
        const inventory = extractStoragePage(parseDocument(await protocol.readStoragePage({ storageId: offer.storageId, status: '1', page: 1 })));
        if (!Number.isSafeInteger(inventory.total)) throw fault('INVALID_RESPONSE');
        checkAbort(signal);
        // Inventory total is an observation, not a free-stock count or proof of
        // settings/public listing readiness. Never replenish from this alone.
        status.offers.push({ offerId: offer.offerId, automaticDelivery, visibleUnsold: inventory.total,
          reconciliation: extra.saleReconciliation || 'held', protection: extra.protection || 'unverified', healthy: automaticDelivery && inventory.total > 0 && extra.ready === true });
        if (!automaticDelivery) status.alerts.push({ code: 'AUTOMATIC_DELIVERY_REQUIRED', offerId: offer.offerId });
        if (inventory.total === 0) status.alerts.push({ code: 'STORAGE_EMPTY', offerId: offer.offerId });
        if (extra.ready !== true) status.alerts.push({ code: 'OFFER_NOT_READY', offerId: offer.offerId });
      } catch (error) {
        if (signal?.aborted || error?.code === 'ABORTED') throw fault('ABORTED');
        status.offers.push({ offerId: offer.offerId, healthy: false }); status.alerts.push({ code: safeCode(error), state: errorState(error), offerId: offer.offerId });
      }
    }
    if (!config.offers.length) status.alerts.push({ code: 'NO_ADOPTED_OFFERS' });
    status.healthy = status.alerts.length === 0;
    if (status.healthy) { status.lastSuccessAt = status.checkedAt; status.consecutiveFailures = 0; }
    else status.consecutiveFailures += 1;
  } catch (error) {
    if (signal?.aborted || error?.code === 'ABORTED') status.aborted = true;
    else status.consecutiveFailures += 1;
    status.alerts.push({ code: status.aborted ? 'ABORTED' : safeCode(error), state: errorState(error) });
  }
  if (stateDir && !status.aborted) await writePrivate(path.join(stateDir, 'health.json'), status);
  return status;
}
async function monitor({ cycle, intervalMs = 300000, signal, onStatus = () => {} }) {
  if (typeof cycle !== 'function' || !Number.isFinite(intervalMs) || intervalMs < 60000) throw fault('INVALID_MONITOR');
  while (!signal?.aborted) {
    let status;
    try { status = await cycle({ signal }); }
    catch (error) { if (signal?.aborted) break; throw error; }
    await onStatus(status);
    if (signal?.aborted) break;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, intervalMs); signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
    });
  }
}
module.exports = { parseDocument, verifyAccess, validateConfig, loadConfig, connect, runCheck, monitor, safeCode };
