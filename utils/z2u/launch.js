"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { constants } = require("node:fs");
const { createHash, randomUUID, timingSafeEqual } = require("node:crypto");
const { Z2uError } = require("./client");
const { privatePath } = require("./privateStore");
const { SCALARS, ARRAYS, validateOfferEditFields, verifyOfferSnapshot } = require("./offers");
const { extractStoragePage } = require("./vaultProtocol");
const { deliveryReady } = require("./vaultImport");
const { classifyProduct } = require("./lifecycle");

const DAY = 86400000;
const fail = message => { throw new Z2uError("LAUNCH_UNVERIFIED", message); };
function decimal(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  fail("Canonical native identity required");
}
function sameId(value, expected) { try { return decimal(value) === expected; } catch { return false; } }
function opaque(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,199}$/.test(value); }
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function accountDigest(account, password) {
  if (typeof account !== "string" || !account || typeof password !== "string" || !password) fail("Complete account identity required");
  return digest(["z2u-native-account-v1", account, password]);
}
function sameDigest(a, b) {
  return typeof a === "string" && typeof b === "string" && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) &&
    timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function adopted(offer) {
  if (!offer || offer.kind !== "account" || offer.maxPurchaseQuantity !== 1 ||
      typeof offer.setId !== "string" || !/^[a-f0-9]{24}$/.test(offer.setId) || offer.expectedSnapshot?.status !== "paused") {
    fail("A reviewed one-account paused adoption is required");
  }
  const result = { offerId: decimal(offer.offerId), storageId: decimal(offer.storageId), gameId: decimal(offer.gameId),
    categoryId: decimal(offer.categoryId), setId: offer.setId, kind: "account", maxPurchaseQuantity: 1 };
  const fields = validateOfferEditFields(offer.expectedSnapshot.fields, result.offerId);
  if (fields.list_max_num !== "1" || fields.list_less_num !== "1" || fields.list_stock_num !== "1") fail("Canary quantity must be exactly one");
  for (const key of ["offerId", "gameId", "categoryId"]) if (!sameId(offer.expectedSnapshot[key], result[key])) fail("Adoption snapshot identity mismatch");
  if (offer.expectedSnapshot.title !== fields.list_title || offer.expectedSnapshot.description !== fields.list_description) fail("Adoption contents mismatch");
  result.expectedSnapshot = { offerId: result.offerId, gameId: result.gameId, categoryId: result.categoryId,
    status: "paused", title: fields.list_title, description: fields.list_description,
    fields: Object.fromEntries([...SCALARS, ...ARRAYS].map(key => [key, fields[key]])) };
  return result;
}
function adoptionDigest(offer) { return digest(adopted(offer)); }
function fresh(value, now, maximumAge) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(time) && time <= now + 5000 && now - time <= maximumAge;
}
function sourceProofValid(proof, expected, now) {
  return proof?.verified === true && Object.entries(expected).every(([key, value]) => proof[key] === value) &&
    fresh(proof.checkedAt, now, 120000) && typeof proof.expiresAt === "string" && Date.parse(proof.expiresAt) > now + DAY &&
    typeof proof.credentialDigest === "string" && /^[a-f0-9]{64}$/.test(proof.credentialDigest);
}
function workerProofValid(proof, offerId, configDigest, now) {
  return proof?.verified === true && proof.running === true && proof.offerId === offerId &&
    proof.configDigest === configDigest && fresh(proof.checkedAt, now, 300000);
}

async function journalUnit(ledger, offerId) {
  const snapshot = await ledger.snapshot();
  const offer = snapshot.offers.filter(row => row.offerId === offerId);
  const units = snapshot.units.filter(row => row.offerId === offerId && row.status !== "released");
  if (offer.length !== 1 || offer[0].automaticDeliveryEnabled !== true || offer[0].deactivateWhenEmpty !== true ||
      units.length !== 1 || units[0].status !== "stocked" || !opaque(units[0].sourceId) || !opaque(units[0].batchId)) {
    fail("Exactly one durably stocked and protected source is required");
  }
  return { sourceId: units[0].sourceId, batchId: units[0].batchId, productId: decimal(units[0].storageId) };
}

async function recordIntent(filename, data) {
  let handle;
  try { handle = await fs.open(filename, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Z2uError("ACTIVATION_ALREADY_ATTEMPTED", "Activation intent already exists; reconcile without dispatching again"); throw error; }
  try { await handle.writeFile(JSON.stringify(data) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await fs.open(path.dirname(filename), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/**
 * Explicit one-unit launch only. No worker calls this function automatically.
 * Source/worker callbacks are trusted local verifiers, not remote API schemas.
 * Intent survives crashes and all outcomes; this offer can never auto-retry.
 */
async function activateOneUnitOffer({ client, protocol, ledger, offer, stateDir, verifySource, verifyWorker,
  parseDocument = html => new DOMParser().parseFromString(html, "text/html"), now = Date.now }) {
  const wanted = adopted(offer), configDigest = adoptionDigest(wanted);
  if (typeof stateDir !== "string" || !path.isAbsolute(stateDir) || typeof verifySource !== "function" ||
      typeof verifyWorker !== "function" || typeof client?.mutate !== "function" || typeof ledger?.snapshot !== "function") fail("Complete launch verifiers required");
  const intentFile = await privatePath(path.join(stateDir, "launch-intents", wanted.offerId + ".json"));
  try { await fs.lstat(intentFile); throw new Z2uError("ACTIVATION_ALREADY_ATTEMPTED", "Activation intent already exists; reconcile without dispatching again"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const unit = await journalUnit(ledger, wanted.offerId);
  const identity = { offerId: wanted.offerId, storageId: wanted.storageId, gameId: wanted.gameId,
    categoryId: wanted.categoryId, setId: wanted.setId, ...unit };
  let source;
  try { source = await verifySource({ ...identity }); }
  catch { fail("Fresh source verification failed"); }
  if (!sourceProofValid(source, identity, now())) fail("Fresh source identity or expiry was not verified");
  const worker = async () => {
    let proof;
    try { proof = await verifyWorker({ ...identity, configDigest }); }
    catch { fail("Worker verification failed"); }
    if (!workerProofValid(proof, wanted.offerId, configDigest, now())) fail("Matching live worker heartbeat required");
  };
  const remote = async status => {
    const actual = await protocol.readOfferSnapshot({ ...identity, parseDocument });
    if (!verifyOfferSnapshot(actual, { ...wanted.expectedSnapshot, status }).verified ||
        actual.statusCode !== (status === "paused" ? 4 : 1)) fail("Full canary snapshot changed");
    const settings = await protocol.readOfferDelivery(wanted.offerId);
    if (!deliveryReady(settings, wanted.offerId, wanted.storageId, 1)) fail("Native automatic delivery changed");
    const storage = await protocol.readStorage(wanted.storageId);
    if (!storage || !sameId(storage.id, wanted.storageId) || !sameId(storage.gid, wanted.gameId) ||
        !sameId(storage.category_id, wanted.categoryId) || ![1, "1"].includes(storage.type) || ![2, "2"].includes(storage.is_repeat)) fail("Dedicated account storage changed");
    const inventory = extractStoragePage(parseDocument(await protocol.readStoragePage({ storageId: wanted.storageId, status: "", page: 1 })));
    if (inventory.total !== 1 || inventory.productIds.length !== 1 || inventory.productIds[0] !== unit.productId || inventory.pages.some(page => page !== 1)) fail("Exactly one dedicated remote product is required");
    const product = await protocol.readProduct(unit.productId);
    if (classifyProduct(product, identity).state !== "unsold" || !sameDigest(accountDigest(product.account, product.password), source.credentialDigest)) fail("Native source identity or unused state changed");
    return actual;
  };
  await worker();
  await remote("paused");
  if (JSON.stringify(await journalUnit(ledger, wanted.offerId)) !== JSON.stringify(unit)) fail("Journal source mapping changed");
  await worker();
  const lastState = await protocol.readOfferState({ ...identity, parseDocument });
  if (lastState.verified !== true || lastState.statusCode !== 4 || lastState.status !== "paused" ||
      !["offerId", "gameId", "categoryId"].every(key => lastState[key] === identity[key])) fail("Offer is no longer the reviewed paused listing");
  if (!sourceProofValid(source, identity, now())) fail("Source verification expired before activation");
  const attemptId = randomUUID();
  await recordIntent(intentFile, { version: 1, action: "on_line", attemptId, ...identity, configDigest, createdAt: new Date(now()).toISOString() });
  try {
    await client.mutate("/sell/productAction", () => new URLSearchParams({ list_pk: wanted.offerId, list_action: "on_line" }), { csrf: false });
    await remote("on_sale");
    await worker();
  } catch {
    let paused = false;
    try { paused = (await protocol.pauseOffer({ ...identity, parseDocument })).verified === true; } catch { /* Keep the intent and source held. */ }
    const error = new Z2uError("WRITE_UNCERTAIN", paused ? "Activation unverified; deactivation verified" : "Activation and deactivation remain unverified", { uncertain: true });
    error.deactivationVerified = paused;
    throw error;
  }
  return { verified: true, offerId: wanted.offerId, productId: unit.productId, status: "on_sale", attemptId, configDigest };
}

module.exports = { adoptionDigest, accountDigest, activateOneUnitOffer };
