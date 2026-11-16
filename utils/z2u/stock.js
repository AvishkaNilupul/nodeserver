'use strict';

const { createHash } = require('node:crypto');
const DAY = 86400000;
const WRITE = { writeConcern: { w: 'majority', j: true } };
function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function opaque(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(value)) fail('INVALID_ID', 'An opaque batch identifier is required.');
  return value;
}
function decimal(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) return value;
  fail('INVALID_ID', 'A canonical native identifier is required.');
}
function objectId(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) fail('INVALID_ID', 'A canonical source identifier is required.');
  return value;
}
function lower(value) { return typeof value === 'string' ? value.trim().toLowerCase() : ''; }
function sameIds(a, b) { return Array.isArray(a) && Array.isArray(b) && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort()); }
function exactCounts(a, b) { return a.size === b.size && [...a].every(([k, n]) => b.get(k) === n); }
function safeReference(value) {
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === 'string' && /^(?:Z)?[1-9]\d*$/.test(value)) return value;
  fail('INVALID_EVIDENCE', 'A verified sale reference is required.');
}

// The source batch is a durable anchor independent of a MarketplaceListing.
// A process can die after the allocator CAS but before any local journal write.
// Reopening this anchor recovers its rows; it NEVER runs a second allocation.
function productionDependencies() {
  const mongoose = require('mongoose');
  const Stock = require('../noclaimStock');
  const engine = require('../unclaimedAutoList');
  const holdings = require('../noclaimHoldings');
  const DropSet = require('../../models/DropSet');
  const Unclaimed = require('../../models/UnclaimedAccount');
  const Pool = require('../../models/AvailableAccount');
  const Bot = require('../../models/BotAccount');
  const DropLog = require('../../models/DropLog');
  const Skin = require('../../models/SkinAccount');
  const rented = require('../rentedAccounts');
  if (mongoose.connection.readyState !== 1) fail('DATABASE_REQUIRED', 'Connect the production stock database first.');
  const batches = mongoose.connection.db.collection('z2ustockbatches');
  return {
    stock: Stock,
    readSet: id => DropSet.findById(id).lean(),
    readBatch: id => batches.findOne({ _id: id }),
    async insertBatch(batch) {
      try { await batches.insertOne(batch, WRITE); return true; }
      catch (error) { if (error.code === 11000) return false; throw error; }
    },
    saveBatch: (id, fields) => batches.updateOne({ _id: id }, { $set: fields }, WRITE),
    claimedRows: anchor => Unclaimed.find({ source: 'noclaim', market: 'z2u', manualListing: anchor }).sort({ _id: 1 }).lean(),
    async context() {
      const [base, candidates, leases] = await Promise.all([
        holdings.snapshotBase({ force: true }), engine.collectNoClaimCandidates(), rented.rentedIndex({ fresh: true }),
      ]);
      return { base, candidates, leases };
    },
    async facts(row, context) {
      const pool = await Pool.findById(row.poolAccountId).lean();
      if (!pool) return { pool: null };
      const login = lower(row.login);
      const regex = new RegExp('^' + login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
      const identities = [{ clientSecret: pool.clientSecret }, { login: regex }];
      if (pool.twitchId) identities.push({ twitchId: pool.twitchId });
      const [bots, pools, siblings, listings, skin, freshLeases] = await Promise.all([
        Bot.find({ $or: identities }, { login: 1, clientSecret: 1, twitchId: 1, soldAt: 1, soldBulkOrderId: 1, resellerId: 1, copiedCount: 1, lastCopiedAt: 1, container: 1 }).lean(),
        Pool.find({ $or: [{ usernameLower: login }, { clientSecret: pool.clientSecret }, ...(pool.twitchId ? [{ twitchId: pool.twitchId }] : [])] }, { username: 1, usernameLower: 1, clientSecret: 1 }).lean(),
        Unclaimed.find({ source: 'noclaim', $or: [{ loginLower: login }, { poolAccountId: String(pool._id) }, ...(pool.twitchId ? [{ twitchId: pool.twitchId }] : [])] }, { _id: 1 }).lean(),
        engine.activeListingsForLogin(login),
        Skin.exists({ $or: [{ twitchLogin: login }, ...(pool.twitchId ? [{ twitchId: pool.twitchId }] : [])] }),
        rented.rentedIndex({ fresh: true }),
      ]);
      const accountIds = [pool._id, ...bots.map(bot => bot._id)];
      const archiveHeld = await DropLog.exists({ account: { $in: accountIds }, $or: [{ connected: true }, { soldAt: { $ne: null } }] });
      return { pool, bots, pools, siblings, listings, skinHeld: !!skin, archiveHeld: !!archiveHeld,
        leased: rented.isRented(freshLeases, { clientSecret: pool.clientSecret, login }),
        candidates: context.candidates.filter(c => lower(c.login) === login || c.clientSecret === pool.clientSecret || (pool.twitchId && c.twitchId === pool.twitchId)),
        ownerBlocked: !!engine.poolOwnerBlock(pool) };
    },
    inventory: (row, pool) => engine.inventoryForCandidate({ ...row, clientSecret: pool.clientSecret }),
    credential: row => engine.credentialForLedger(row),
  };
}

/** Only dedicated no-claim accounts with the exact finished set are supported.
 * No auto-farm, scoped/rent-farm source, pasted account list or release operation.
 * deps is the narrow test seam; normal callers supply ledger/adoptedOffers.
 */
function createZ2uStockAdapter({ ledger, adoptedOffers = [], minLifeMs = DAY, deps, now = Date.now } = {}) {
  if (!Number.isSafeInteger(minLifeMs) || minLifeMs < DAY) fail('INVALID_EXPIRY', 'Vault stock requires at least one day of known remaining life.');
  if (!Array.isArray(adoptedOffers)) fail('INVALID_ADOPTION', 'Explicit Z2U offer-to-set adoption is required.');
  const adopted = new Map();
  for (const offer of adoptedOffers) {
    const offerId = decimal(offer?.offerId), setId = objectId(offer?.setId);
    if (adopted.has(offerId)) fail('INVALID_ADOPTION', 'An offer can adopt only one exact source set.');
    adopted.set(offerId, setId);
  }
  function requireAdopted(offerId, setId) {
    if (adopted.get(offerId) !== setId) fail('OFFER_NOT_ADOPTED', 'The offer must explicitly adopt this exact source set in Z2U configuration.');
  }
  let loaded = deps;
  const dependencies = () => loaded || (loaded = productionDependencies());

  async function readSet(setId) {
    const d = dependencies();
    const set = await d.readSet(objectId(setId));
    if (!set || set.stockSource !== 'noclaim' || !Array.isArray(set.items) || !set.items.length) fail('UNSUPPORTED_SOURCE', 'A populated no-claim DropSet is required.');
    if (set.accountScopeIds?.length || set.accountScopeLogins?.length || set.autoFarmTaskId) fail('UNSUPPORTED_SOURCE', 'Scoped and auto-farm sets are excluded.');
    const games = new Set(set.items.map(item => lower(item.game)));
    if (games.size !== 1 || games.has('') || (set.coverGame && !games.has(lower(set.coverGame)))) fail('INVALID_SET', 'The exact set must belong to one game.');
    const game = [...games][0];
    if (/overwatch/i.test(game)) fail('GAME_RESTRICTED', 'This game is not enabled on Z2U.');
    // Legacy gameMarketsFor governs only the three old auto-list markets and
    // discards all other names. Dedicated Z2U adoption is the policy boundary.
    for (const item of set.items) {
      if (typeof item.itemKey !== 'string' || !item.itemKey.endsWith('|' + game) || !Number.isSafeInteger(item.qty ?? 1) || (item.qty ?? 1) < 1) fail('INVALID_SET', 'Each promised reward needs a game-specific key and positive whole quantity.');
    }
    if (d.stock.deliveryEnabled() !== true) fail('DELIVERY_DISABLED', 'The no-claim delivery switch is disabled.');
    const required = d.stock.requiredFromSet(set);
    const signature = createHash('sha256').update(JSON.stringify({ game, required: [...required].sort() })).digest('hex');
    return { set, required, signature };
  }

  function checkRows(batch, rows, expectedIds) {
    if (rows.length !== batch.count) fail('PARTIAL_RESERVATION', 'The batch does not have exactly its requested source count.');
    const ids = rows.map(row => objectId(String(row._id)));
    if (new Set(ids).size !== ids.length || (expectedIds && !sameIds(ids, expectedIds))) fail('RESERVATION_MISMATCH', 'The batch source mapping changed.');
    const logins = new Set(), pools = new Set();
    for (const row of rows) {
      if (row.source !== 'noclaim' || row.market !== 'z2u' || row.manualListing !== batch.anchor || String(row.set) !== batch.setId || row.status !== 'manual' || row.manualDeliveredAt || row.soldAt || row.farm === 'autofarm') fail('RESERVATION_MISMATCH', 'A source is no longer exclusively reserved for this batch.');
      if (!lower(row.login) || lower(row.login) !== row.loginLower || !row.poolAccountId || logins.has(row.loginLower) || pools.has(String(row.poolAccountId))) fail('DUPLICATE_IDENTITY', 'Source identities are missing or duplicated.');
      logins.add(row.loginLower); pools.add(String(row.poolAccountId));
    }
    return ids;
  }

  function checkFacts(row, facts, batch) {
    const p = facts.pool;
    // claimForSet(mode:fed) itself sets pool.listed=true. The exact ledger
    // anchor and active-listing checks distinguish our hold from another one.
    if (!p || facts.ownerBlocked || p.status !== 'claimed' || !/^noclaim-farm:/i.test(String(p.claimedNote || '')) || p.manualSold || p.suspendedAt || p.lastCheckStatus === 'suspended' || !p.clientSecret || lower(p.username) !== row.loginLower || (row.twitchId && String(p.twitchId) !== String(row.twitchId))) fail('OWNER_UNVERIFIED', 'Source pool ownership or identity is not valid.');
    // An account handed over for any game is not a dedicated virgin Z2U unit.
    if (!Array.isArray(p.soldGames) || p.soldGames.length || facts.leased || facts.skinHeld || facts.archiveHeld) fail('SOURCE_COMMITTED', 'Source has a sale, lease, linked account or archive commitment.');
    if (!Array.isArray(facts.pools) || facts.pools.length !== 1 || String(facts.pools[0]._id) !== String(p._id) || !Array.isArray(facts.siblings) || facts.siblings.length !== 1 || String(facts.siblings[0]._id) !== String(row._id)) fail('DUPLICATE_IDENTITY', 'Source has duplicate pool or reservation identities.');
    if (!Array.isArray(facts.bots) || facts.bots.some(bot => bot.clientSecret !== p.clientSecret || lower(bot.login) !== row.loginLower || bot.soldAt || bot.soldBulkOrderId || bot.resellerId || bot.lastCopiedAt || bot.copiedCount > 0 || !/^noclaim-bot-/i.test(bot.container || ''))) fail('SOURCE_COMMITTED', 'Source has another bot identity or ownership commitment.');
    if (!Array.isArray(facts.candidates) || facts.candidates.length !== 1 || facts.candidates[0].clientSecret !== p.clientSecret || lower(facts.candidates[0].login) !== row.loginLower || facts.candidates[0].farm === 'autofarm') fail('OWNER_UNVERIFIED', 'Source must appear once in the live no-claim fleet.');
    if (!Array.isArray(facts.listings) || facts.listings.some(listing => listing.marketplace !== 'z2u' || String(listing.externalId) !== batch.offerId)) fail('SOURCE_COMMITTED', 'Source is committed to another marketplace listing.');
  }

  async function verifyBatch(batch, expectedIds, expectedUnits) {
    const d = dependencies();
    const { set, required, signature } = await readSet(batch.setId);
    if (signature !== batch.setSignature) fail('SET_CHANGED', 'The promised set changed after reservation.');
    const rows = await d.claimedRows(batch.anchor);
    const sourceIds = checkRows(batch, rows, expectedIds);
    const context = await d.context();
    const units = [];
    let expiresAt = Infinity;
    for (const row of rows) {
      const facts = await d.facts(row, context);
      checkFacts(row, facts, batch);
      const live = await d.inventory(row, facts.pool);
      if (!live?.inv || !Array.isArray(live.inv.drops) || !Array.isArray(live.inv.inProgress) || lower(live.inv.login) !== row.loginLower || lower(live.login) !== row.loginLower || !Array.isArray(live.sellable)) fail('INVENTORY_UNVERIFIED', 'A complete live inventory with matching identity is required.');
      if ([...live.inv.drops, ...live.inv.inProgress].some(drop => drop?.connected)) fail('SOURCE_CONNECTED', 'A game is connected on this source.');
      if (!exactCounts(d.stock.heldCounts(live.sellable), required)) fail('BUNDLE_MISMATCH', 'Live finished rewards do not exactly match the promised set.');
      const gone = d.stock.coverGoneAt({ items: d.stock.wavesOfDrops(live.sellable), readAt: new Date(now()) }, context.base, required);
      if (!Number.isFinite(gone) || gone < now() + minLifeMs) fail('EXPIRY_UNVERIFIED', 'Every promised reward needs a known claim expiry beyond the minimum vault life.');
      expiresAt = Math.min(expiresAt, gone);
      const credential = await d.credential(row);
      if (lower(credential?.login) !== row.loginLower || typeof credential.password !== 'string' || !credential.password) fail('CREDENTIAL_UNVERIFIED', 'Source credentials cannot be verified.');
      const unit = { sourceId: String(row._id), account: credential.login, password: credential.password };
      if (expectedUnits) {
        const previous = expectedUnits.find(item => item.sourceId === unit.sourceId);
        if (!previous || previous.account !== unit.account || previous.password !== unit.password) fail('CREDENTIAL_CHANGED', 'Credentials changed after the upload payload was prepared.');
      }
      units.push(unit);
      // The network read can take seconds. Re-check local ownership after it.
      checkFacts(row, await d.facts(row, context), batch);
    }
    checkRows(batch, await d.claimedRows(batch.anchor), sourceIds);
    if ((await readSet(batch.setId)).signature !== batch.setSignature) fail('SET_CHANGED', 'The promised set changed during live verification.');
    return { units, sourceIds, expiresAt: new Date(expiresAt).toISOString(), set };
  }

  async function verifyReservation({ batchId, offerId, sourceIds, units }) {
    opaque(batchId); offerId = decimal(offerId);
    if (!Array.isArray(units) || !sameIds(units.map(unit => unit.sourceId), sourceIds)) fail('INVALID_STOCK', 'Verification must bind the exact upload credentials.');
    const batch = await dependencies().readBatch(batchId);
    if (!batch || batch.offerId !== offerId || !sameIds(batch.sourceIds, sourceIds)) fail('RESERVATION_MISMATCH', 'Unknown source reservation.');
    requireAdopted(offerId, batch.setId);
    const verified = await verifyBatch(batch, sourceIds, units);
    await dependencies().saveBatch(batchId, { expiresAt: verified.expiresAt });
    return { verified: true, reservationId: batch.anchor, offerId, sourceIds: verified.sourceIds, expiresAt: verified.expiresAt };
  }

  async function reserveExactBatch({ batchId, offerId, setId, count, existingOnly = false }) {
    opaque(batchId); offerId = decimal(offerId); objectId(setId);
    requireAdopted(offerId, setId);
    if (!Number.isSafeInteger(count) || count < 1 || count > 80) fail('INVALID_QUANTITY', 'Reserve between one and eighty whole accounts.');
    const d = dependencies();
    const { set, signature } = await readSet(setId);
    let batch = await d.readBatch(batchId);
    let created = false;
    if (!batch && existingOnly) fail('RESERVATION_MISMATCH', 'An existing source batch is required; launch cannot allocate new stock.');
    if (!batch) {
      const proposed = { _id: batchId, offerId, setId, count, setSignature: signature,
        anchor: 'z2u:' + createHash('sha256').update(batchId).digest('hex'), state: 'claiming', sourceIds: [], createdAt: new Date(now()) };
      created = await d.insertBatch(proposed);
      batch = created ? proposed : await d.readBatch(batchId);
    }
    if (!batch || batch.offerId !== offerId || batch.setId !== setId || batch.count !== count || batch.setSignature !== signature) fail('BATCH_CONFLICT', 'Batch identity is immutable.');
    if (created) {
      try { await d.stock.claimForSet(set, count, { market: 'z2u', mode: 'fed', listingId: batch.anchor }); }
      catch { /* Any committed source remains held and is recovered by its anchor. */ }
    }
    const rows = await d.claimedRows(batch.anchor);
    const ids = rows.map(row => String(row._id));
    if (rows.length !== count) return { status: 'held', reason: 'PARTIAL_RESERVATION', reservationId: batch.anchor, sourceIds: ids, units: [] };
    if (batch.sourceIds.length && !sameIds(batch.sourceIds, ids)) fail('RESERVATION_MISMATCH', 'Reserved source mapping changed.');
    await d.saveBatch(batchId, { sourceIds: ids, state: 'reserved' });
    batch = { ...batch, sourceIds: ids };
    try {
      const verified = await verifyBatch(batch, ids);
      const boundUnits = verified.units.map(unit => ({ ...unit }));
      await d.saveBatch(batchId, { expiresAt: verified.expiresAt });
      return { status: 'reserved', reservationId: batch.anchor, sourceIds: ids, units: verified.units, expiresAt: verified.expiresAt,
        verifyReservation: args => verifyReservation({ ...args, units: boundUnits }) };
    } catch (error) {
      // Never leak upstream errors, which can contain logins/tokens/passwords.
      const known = new Set(['PARTIAL_RESERVATION', 'RESERVATION_MISMATCH', 'DUPLICATE_IDENTITY', 'OWNER_UNVERIFIED', 'SOURCE_COMMITTED', 'INVENTORY_UNVERIFIED', 'SOURCE_CONNECTED', 'BUNDLE_MISMATCH', 'EXPIRY_UNVERIFIED', 'CREDENTIAL_UNVERIFIED', 'SET_CHANGED', 'GAME_RESTRICTED', 'DELIVERY_DISABLED']);
      return { status: 'held', reason: known.has(error.code) ? error.code : 'VERIFICATION_FAILED', reservationId: batch.anchor, sourceIds: ids, units: [] };
    }
  }

  async function markDelivered({ batchId, sourceId, offerId, productId, evidenceId, deliveryId, saleReference, priceUsd = 0 }) {
    opaque(batchId); objectId(sourceId); offerId = decimal(offerId); productId = decimal(productId);
    opaque(evidenceId); opaque(deliveryId); saleReference = safeReference(saleReference);
    if (!Number.isFinite(priceUsd) || priceUsd < 0) fail('INVALID_PRICE', 'A nonnegative confirmed unit price is required.');
    if (!ledger?.snapshot) fail('DELIVERY_UNVERIFIED', 'The durable delivery journal is required.');
    const saved = (await ledger.snapshot()).units.find(unit => unit.sourceId === sourceId);
    if (!saved || saved.status !== 'delivered' || saved.batchId !== batchId || saved.offerId !== offerId || saved.storageId !== productId || saved.deliveryId !== deliveryId || saved.evidenceId !== evidenceId || saved.saleReference !== saleReference) fail('DELIVERY_UNVERIFIED', 'Success evidence must exactly match the persisted delivery journal.');
    const d = dependencies();
    const batch = await d.readBatch(batchId);
    if (!batch || batch.offerId !== offerId || !batch.sourceIds.includes(sourceId)) fail('RESERVATION_MISMATCH', 'Delivery is not owned by this source batch.');
    const rows = await d.claimedRows(batch.anchor);
    const row = rows.find(item => String(item._id) === sourceId);
    if (!row || String(row.set) !== batch.setId || row.market !== 'z2u' || row.source !== 'noclaim' || row.farm === 'autofarm' || !['manual', 'sold'].includes(row.status)) fail('RESERVATION_MISMATCH', 'Source ownership changed before delivery bookkeeping.');
    if (row.status === 'sold' && row.soldMarket !== 'z2u') fail('SOURCE_COMMITTED', 'Source was sold by another owner.');
    const marked = await d.stock.markSold([sourceId], { market: 'z2u', priceUsd, orderId: saleReference, expectedManualListing: batch.anchor });
    if (marked !== 1) fail('SALE_BOOKKEEPING_UNCERTAIN', 'Source sale could not be recorded; retry the same verified evidence.');
    return { status: 'delivered', sourceId, productId, deliveryId, saleReference };
  }
  async function readBatchState({ batchId, offerId }) {
    opaque(batchId); offerId = decimal(offerId);
    const d = dependencies();
    const batch = await d.readBatch(batchId);
    if (!batch || batch.offerId !== offerId) fail('RESERVATION_MISMATCH', 'Unknown source batch for this offer.');
    const rows = await d.claimedRows(batch.anchor);
    const expires = Date.parse(batch.expiresAt);
    return { status: batch.state, expiresAt: Number.isFinite(expires) ? new Date(expires).toISOString() : null,
      holdCount: rows.filter(row => row.status === 'manual').length };
  }
  return { reserveExactBatch, verifyReservation, markDelivered, readBatchState };
}

module.exports = { createZ2uStockAdapter };
