"use strict";

const { createHash } = require("node:crypto");
const { stockEvidence } = require("./vaultProtocol");

function decimal(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  return null;
}
function same(value, expected) { return decimal(value) !== null && decimal(value) === expected; }
function zero(value) { return value === 0 || value === "0"; }
function opaque(value) { return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(value); }
function reference(value) {
  return decimal(value) || (typeof value === "string" && /^Z[1-9]\d{0,39}$/.test(value) ? value : null);
}
function timestamp(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?$/.test(value)) return value;
  return null;
}
function expectation(input) {
  const result = {};
  for (const key of ["productId", "storageId", "gameId", "categoryId"]) {
    result[key] = decimal(input[key]);
    if (!result[key]) throw new TypeError(`Invalid ${key}`);
  }
  return result;
}

/** Sold Out / Out of stock time establish consumption, not delivery success. */
function classifyProduct(product, expectedInput) {
  const expected = expectation(expectedInput);
  const held = reason => ({ state: "held", reason, ...expected });
  if (!product || typeof product !== "object" || Array.isArray(product)) return held("missing_product");
  if (!same(product.id, expected.productId) || !same(product.storage_id, expected.storageId) ||
      !same(product.gid, expected.gameId) || !same(product.category_id, expected.categoryId)) return held("ownership_mismatch");
  const evidence = stockEvidence(product);
  if (evidence.unsoldVerified) return { state: "unsold", ...expected, evidence };
  if (product.status !== 2 && product.status !== "2") return held("not_confirmed_sold");
  if (!zero(product.delete_time) || product.wd_order !== "") return held("deleted_or_withdrawn");
  const saleReference = reference(product.buy_order), usedTime = timestamp(product.used_time);
  if (!decimal(product.buy_user_id) || !saleReference || usedTime === null) return held("incomplete_sale_evidence");
  return { state: "consumed_pending_confirmation", ...expected, saleReference, usedTime };
}

function receiptMatches(receipt, observed, offerId) {
  return receipt?.verified === true && receipt.deliverySucceeded === true && opaque(receipt.receiptId) &&
    same(receipt.offerId, offerId) && ["productId", "storageId", "gameId", "categoryId"].every(key => same(receipt[key], observed[key])) &&
    reference(receipt.saleReference) === observed.saleReference;
}

/**
 * Only already journaled source-to-product mappings can become delivered.
 * verifyDeliveryReceipt is a trusted adapter seam for observed successful native
 * delivery receipts. No populated log schema was available during this build.
 * Omitting the verifier holds consumption pending confirmation; never releases.
 */
async function reconcileProduct({ ledger, protocol, sourceId, offerId, productId, storageId,
  gameId, categoryId, verifyDeliveryReceipt }) {
  if (!opaque(sourceId) || !decimal(offerId)) throw new TypeError("Invalid source or offer identity");
  const expected = expectation({ productId, storageId, gameId, categoryId });
  offerId = decimal(offerId);
  const snapshot = await ledger.snapshot();
  const records = snapshot.units.filter(unit => unit.sourceId === sourceId);
  const unit = records.length === 1 ? records[0] : null;
  const held = reason => ({ state: "held", reason, sourceId, offerId, productId: expected.productId });
  if (!unit || unit.offerId !== offerId || unit.storageId !== expected.productId) return held("ledger_ownership_mismatch");
  if (unit.status === "delivered") return { state: "delivered", sourceId, offerId, productId: expected.productId,
    deliveryId: unit.deliveryId, evidenceId: unit.evidenceId, saleReference: unit.saleReference || null, replay: true };
  if (!["uploading", "upload_uncertain", "stocked"].includes(unit.status)) return held("ledger_state_unavailable");
  let product;
  try { product = await protocol.readProduct(expected.productId); }
  catch { return held("product_read_failed"); }
  const observed = classifyProduct(product, expected);
  if (observed.state === "held") return held(observed.reason);
  if (observed.state === "unsold") return { state: "unsold", sourceId, offerId, productId: expected.productId };
  const pending = reason => ({ state: "consumed_pending_confirmation", reason, sourceId, offerId,
    productId: expected.productId, saleReference: observed.saleReference });
  if (typeof verifyDeliveryReceipt !== "function") return pending("delivery_verifier_unavailable");
  let receipt;
  try { receipt = await verifyDeliveryReceipt({ ...observed, offerId }); }
  catch { return pending("delivery_receipt_read_failed"); }
  if (!receiptMatches(receipt, observed, offerId)) return pending("delivery_receipt_unverified");
  const digest = createHash("sha256").update(JSON.stringify([receipt.receiptId, expected.productId, observed.saleReference])).digest("hex");
  // Product-scoped delivery identity supports a multi-unit order whose native
  // delivery receipt is shared, while the ledger still rejects source reuse.
  const evidenceId = `z2u-receipt:${digest}`, deliveryId = `z2u-unit:${digest}`;
  await ledger.reconcile({ kind: "delivered", sourceId, offerId, storageId: expected.productId,
    evidenceId, deliveryId,
    ownershipVerified: true, deliverySucceeded: true, saleReference: observed.saleReference });
  return { state: "delivered", sourceId, offerId, productId: expected.productId, evidenceId, deliveryId,
    saleReference: observed.saleReference, replay: false };
}

/** Reads only the observed editor controls; it cannot establish offer status. */
function extractOfferConstraints(document) {
  const forms = [...document.querySelectorAll("form#form")];
  if (forms.length !== 1) return { ready: false, reason: "editor_form_missing_or_ambiguous", status: "unknown" };
  const read = name => {
    const controls = [...forms[0].querySelectorAll(`[name="${name}"]`)];
    return controls.length === 1 && !controls[0].disabled ? controls[0].value : null;
  };
  const integer = value => typeof value === "string" && /^(0|[1-9]\d*)$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
  const offerId = read("list_pk"), maximum = integer(read("list_max_num")), minimum = integer(read("list_less_num")), stock = integer(read("list_stock_num"));
  const result = { ready: false, offerId: typeof offerId === "string" && /^[1-9]\d*$/.test(offerId) ? offerId : null,
    maxPurchaseQuantity: maximum, minPurchaseQuantity: minimum, advertisedStock: stock, status: "unknown" };
  if (!result.offerId || maximum === null || minimum === null || stock === null) return { ...result, reason: "invalid_or_missing_constraints" };
  if (maximum === 0) return { ...result, reason: "zero_maximum_semantics_unverified" };
  if (minimum < 1 || minimum > maximum) return { ...result, reason: "invalid_purchase_range" };
  return { ...result, ready: true, reason: "purchase_constraints_verified" };
}

module.exports = { classifyProduct, reconcileProduct, extractOfferConstraints, receiptMatches };
