"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { classifyProduct, reconcileProduct, extractOfferConstraints } = require("../utils/z2u/lifecycle");
const { openVaultLedger } = require("../utils/z2u/vaultLedger");

const expected = { productId: "11", storageId: "12", gameId: "13", categoryId: "14" };
const unsold = () => ({ id: 11, storage_id: 12, gid: 13, category_id: 14, status: 1,
  delete_time: 0, wd_order: "", buy_user_id: 0, buy_order: 0, used_time: null });
const consumed = () => ({ ...unsold(), status: 2, buy_user_id: 99, buy_order: 101, used_time: "2026-11-16 12:00:00" });
function receipt(extra = {}) { return { ...expected, offerId: "15", saleReference: "101", verified: true,
  deliverySucceeded: true, receiptId: "synthetic-native-receipt", ...extra }; }

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "z2u-lifecycle-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = openVaultLedger(path.join(directory, "ledger.json"));
  await ledger.configureOffer("15", { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
  await ledger.reserveBatch({ offerId: "15", batchId: "batch", sourceIds: ["source"] });
  await ledger.beginUpload("batch", "attempt");
  await ledger.confirmStocked("batch", { attemptId: "attempt", complete: true, evidenceId: "synthetic-upload",
    automaticDeliveryEnabled: true, deactivateWhenEmpty: true, items: [{ sourceId: "source", storageId: "11", ownershipVerified: true }] });
  return { ledger, sourceId: "source", offerId: "15", ...expected };
}

test("product consumption is explicitly distinct from successful delivery", () => {
  assert.equal(classifyProduct(unsold(), expected).state, "unsold");
  const result = classifyProduct(consumed(), expected);
  assert.equal(result.state, "consumed_pending_confirmation");
  assert.equal(result.saleReference, "101");
  assert.equal(JSON.stringify(result).includes("buy_user_id"), false);
  assert.equal(classifyProduct({ ...consumed(), status: "2" }, expected).state, "consumed_pending_confirmation");
});

test("deleted/withdrawn, malformed and ownership-mismatched products are held", () => {
  for (const patch of [{ id: 999 }, { storage_id: 999 }, { gid: 999 }, { category_id: 999 },
    { status: true }, { status: [2] }, { status: "02" }, { status: 3 }, { status: 4 }, { status: 5 },
    { delete_time: 123 }, { wd_order: "withdrawn" }, { buy_order: 0 }, { buy_order: [] },
    { buy_user_id: true }, { buy_user_id: 0 }, { used_time: null }, { used_time: "unknown" }]) {
    assert.equal(classifyProduct({ ...consumed(), ...patch }, expected).state, "held");
  }
  for (const key of Object.keys(consumed())) {
    const product = consumed(); delete product[key];
    assert.equal(classifyProduct(product, expected).state, "held", key);
  }
  assert.equal(classifyProduct(null, expected).state, "held");
  assert.throws(() => classifyProduct(consumed(), { ...expected, productId: [11] }));
});

test("no receipt verifier never marks consumed product delivered", async t => {
  const args = await fixture(t);
  const result = await reconcileProduct({ ...args, protocol: { readProduct: async () => consumed() } });
  assert.equal(result.state, "consumed_pending_confirmation");
  assert.equal(result.reason, "delivery_verifier_unavailable");
  assert.equal((await args.ledger.snapshot()).units[0].status, "stocked");
});

test("successful exact receipt produces durable delivered state and idempotent replay", async t => {
  const args = await fixture(t);
  let reads = 0;
  const input = { ...args, protocol: { readProduct: async () => { reads++; return consumed(); } },
    verifyDeliveryReceipt: async observed => { assert.equal(observed.productId, "11"); return receipt(); } };
  const result = await reconcileProduct(input);
  assert.deepEqual({ state: result.state, replay: result.replay }, { state: "delivered", replay: false });
  const recorded = (await args.ledger.snapshot()).units[0];
  assert.equal(recorded.status, "delivered");
  assert.equal(result.deliveryId, recorded.deliveryId);
  assert.equal(result.evidenceId, recorded.evidenceId);
  assert.equal(recorded.saleReference, "101");
  const replay = await reconcileProduct(input);
  assert.equal(replay.replay, true);
  assert.equal(replay.deliveryId, recorded.deliveryId);
  assert.equal(replay.saleReference, "101");
  assert.equal(reads, 1);
});

test("receipt must match every ownership field and a positive success decision", async t => {
  const args = await fixture(t);
  for (const patch of [{ verified: false }, { deliverySucceeded: false }, { productId: 999 }, { storageId: 999 },
    { gameId: 999 }, { categoryId: 999 }, { offerId: 999 }, { saleReference: "102" }, { productId: [11] }, { receiptId: "" }]) {
    const result = await reconcileProduct({ ...args, protocol: { readProduct: async () => consumed() }, verifyDeliveryReceipt: async () => receipt(patch) });
    assert.equal(result.state, "consumed_pending_confirmation");
  }
  assert.equal((await args.ledger.snapshot()).units[0].status, "stocked");
});

test("errors, missing products and failed receipts never release stock or expose error details", async t => {
  const args = await fixture(t);
  for (const protocol of [{ readProduct: async () => null }, { readProduct: async () => { throw new Error("SECRET credentials"); } }]) {
    const result = await reconcileProduct({ ...args, protocol });
    assert.equal(result.state, "held");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
  }
  const result = await reconcileProduct({ ...args, protocol: { readProduct: async () => consumed() },
    verifyDeliveryReceipt: async () => { throw new Error("SECRET credentials"); } });
  assert.equal(result.state, "consumed_pending_confirmation");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.equal((await args.ledger.snapshot()).units[0].status, "stocked");
});

test("ledger ownership mismatch prevents even reading the foreign product", async t => {
  const args = await fixture(t);
  let calls = 0;
  const result = await reconcileProduct({ ...args, productId: "99", protocol: { readProduct: async () => { calls++; return consumed(); } } });
  assert.equal(result.reason, "ledger_ownership_mismatch");
  assert.equal(calls, 0);
});

function editor(values, duplicates = []) {
  return { querySelectorAll: () => [{ querySelectorAll: selector => {
    const name = /name="([^"]+)"/.exec(selector)[1];
    if (!(name in values)) return [];
    return Array.from({ length: duplicates.includes(name) ? 2 : 1 }, () => ({ value: values[name], disabled: false }));
  } }] };
}
test("offer maximum zero is unknown; finite positive constraints remain separate from status", () => {
  const fields = { list_pk: "15", list_max_num: "0", list_less_num: "1", list_stock_num: "10" };
  assert.equal(extractOfferConstraints(editor(fields)).reason, "zero_maximum_semantics_unverified");
  const valid = extractOfferConstraints(editor({ ...fields, list_max_num: "10" }));
  assert.equal(valid.ready, true);
  assert.equal(valid.maxPurchaseQuantity, 10);
  assert.equal(valid.status, "unknown");
  for (const value of ["", "01", "1e2", "-1", "9007199254740993"]) {
    assert.equal(extractOfferConstraints(editor({ ...fields, list_max_num: value })).ready, false);
  }
  assert.equal(extractOfferConstraints(editor({ ...fields, list_max_num: "5", list_less_num: "6" })).ready, false);
  assert.equal(extractOfferConstraints(editor(fields, ["list_pk"])).ready, false);
  assert.equal(extractOfferConstraints({ querySelectorAll: () => [] }).ready, false);
});
