"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DOMParser } = require("../utils/z2u/node_modules/linkedom");
const { SCALARS, ARRAYS } = require("../utils/z2u/offers");
const { openVaultLedger } = require("../utils/z2u/vaultLedger");
const { adoptionDigest, accountDigest, activateOneUnitOffer } = require("../utils/z2u/launch");
const parseDocument = html => new DOMParser().parseFromString(html, "text/html");
const NOW = Date.parse("2026-11-16T10:00:00.000Z");

async function fixture(t) {
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "z2u-launch-")));
  t.after(() => fs.rm(stateDir, { force: true, recursive: true }));
  const ledger = openVaultLedger(path.join(stateDir, "ledger.json"));
  await ledger.configureOffer("15", { automaticDeliveryEnabled: true, deactivateWhenEmpty: true });
  await ledger.reserveBatch({ offerId: "15", batchId: "batch", sourceIds: ["source"] });
  await ledger.beginUpload("batch", "attempt");
  await ledger.confirmStocked("batch", { attemptId: "attempt", complete: true, evidenceId: "upload-proof",
    automaticDeliveryEnabled: true, deactivateWhenEmpty: true, items: [{ sourceId: "source", storageId: "11", ownershipVerified: true }] });
  const fields = { ...Object.fromEntries(SCALARS.map(key => [key, "1"])), ...Object.fromEntries(ARRAYS.map(key => [key, []])),
    list_pk: "15", list_title: "Synthetic exact one-account bundle", list_description: "Synthetic complete promise", list_unit_price: "3", list_currency_type: "USD" };
  const offer = { offerId: "15", storageId: "12", gameId: "13", categoryId: "14", setId: "111111111111111111111111", kind: "account", maxPurchaseQuantity: 1,
    expectedSnapshot: { offerId: "15", gameId: "13", categoryId: "14", title: fields.list_title, description: fields.list_description, status: "paused", fields } };
  const state = { now: NOW, status: "paused", writes: [], pauseCalls: 0, sourceCalls: 0, workerCalls: 0,
    sourcePatch: {}, workerPatch: {}, snapshotPatch: {}, fieldsPatch: {}, pauseFails: false, uncertain: false,
    storage: { id: 12, gid: 13, category_id: 14, type: 1, is_repeat: 2 },
    settings: { id: 15, storage_id: 12, is_auto_deliver: 1, outstock: 1, is_agiso: 0, buy_more: 1 },
    inventory: '<h1>Storage List (Totals：1)</h1><div id="productlist"><input class="checkone" data="11"></div>',
    product: { id: 11, storage_id: 12, gid: 13, category_id: 14, status: 1, delete_time: 0, wd_order: "", buy_user_id: 0, buy_order: 0, used_time: null,
      account: "synthetic-account", password: "synthetic-password" } };
  const options = { client: { mutate: async (url, body, opts) => {
    const intent = JSON.parse(await fs.readFile(path.join(stateDir, "launch-intents", "15.json"), "utf8"));
    assert.equal(intent.action, "on_line");
    state.writes.push({ url, fields: [...body().entries()], csrf: opts.csrf });
    state.status = "on_sale";
    if (state.afterWrite) state.afterWrite();
    if (state.uncertain) throw new Error("SECRET synthetic response");
    return { acknowledged: true, verified: false };
  } }, protocol: {
    readOfferSnapshot: async () => ({ ...structuredClone(offer.expectedSnapshot), verified: true,
      fields: { ...structuredClone(fields), ...state.fieldsPatch }, status: state.status, statusCode: state.status === "paused" ? 4 : 1,
      constraints: { ready: true, maxPurchaseQuantity: 1, minPurchaseQuantity: 1, advertisedStock: 1 }, ...state.snapshotPatch }),
    readOfferState: async () => ({ verified: true, offerId: "15", gameId: "13", categoryId: "14", status: state.status, statusCode: state.status === "paused" ? 4 : 1 }),
    readOfferDelivery: async () => state.settings, readStorage: async () => state.storage,
    readStoragePage: async () => state.inventory,
    readProduct: async () => { if (state.advanceDuringProductRead) state.now += state.advanceDuringProductRead; return state.product; },
    pauseOffer: async () => { state.pauseCalls++; if (state.pauseFails) throw new Error("SECRET pause"); state.status = "paused"; return { verified: true, status: "paused" }; },
  }, ledger, offer, stateDir, parseDocument, now: () => state.now,
  verifySource: async identity => { state.sourceCalls++; return { verified: true, ...identity, checkedAt: new Date(state.now).toISOString(),
    expiresAt: new Date(state.now + 3 * 86400000).toISOString(), credentialDigest: accountDigest("synthetic-account", "synthetic-password"), ...state.sourcePatch }; },
  verifyWorker: async ({ offerId, configDigest }) => { state.workerCalls++; return { verified: true, running: true, offerId, configDigest,
    checkedAt: new Date(state.now).toISOString(), ...state.workerPatch }; } };
  return { state, options, intentFile: path.join(stateDir, "launch-intents", "15.json"), launch: () => activateOneUnitOffer(options) };
}

test("one-unit launch records durable intent before one exact activation and verifies readback", async t => {
  const f = await fixture(t);
  const result = await f.launch();
  assert.equal(result.verified, true);
  assert.equal(result.status, "on_sale");
  assert.equal(result.configDigest, adoptionDigest(f.options.offer));
  assert.deepEqual(f.state.writes, [{ url: "/sell/productAction", fields: [["list_pk", "15"], ["list_action", "on_line"]], csrf: false }]);
  const intentText = await fs.readFile(f.intentFile, "utf8");
  assert.equal(intentText.includes("synthetic-account"), false);
  assert.equal(intentText.includes("synthetic-password"), false);
  assert.equal(intentText.includes("credentialDigest"), false);
  assert.equal((await fs.stat(f.intentFile)).mode & 0o077, 0);
  const calls = [f.state.sourceCalls, f.state.workerCalls];
  await assert.rejects(f.launch(), { code: "ACTIVATION_ALREADY_ATTEMPTED" });
  assert.deepEqual([f.state.sourceCalls, f.state.workerCalls], calls);
  assert.equal(f.state.writes.length, 1);
});

test("worker adoption digest binds complete immutable fields independent of input object order", async t => {
  const f = await fixture(t), first = adoptionDigest(f.options.offer);
  const reversed = { ...f.options.offer, expectedSnapshot: { ...f.options.offer.expectedSnapshot,
    fields: Object.fromEntries(Object.entries(f.options.offer.expectedSnapshot.fields).reverse()) } };
  assert.equal(adoptionDigest(reversed), first);
  reversed.expectedSnapshot.fields.list_unit_price = "4";
  assert.notEqual(adoptionDigest(reversed), first);
  assert.notEqual(accountDigest("same", "a"), accountDigest("same", "b"));
});

test("fresh exact source and matching live worker proofs are mandatory before dispatch", async t => {
  const cases = [
    f => { f.state.sourcePatch.verified = false; }, f => { f.state.sourcePatch.productId = "99"; },
    f => { f.state.sourcePatch.sourceId = "different"; }, f => { f.state.sourcePatch.setId = "other"; },
    f => { f.state.sourcePatch.checkedAt = new Date(NOW - 120001).toISOString(); },
    f => { f.state.sourcePatch.checkedAt = new Date(NOW + 6000).toISOString(); },
    f => { f.state.sourcePatch.expiresAt = new Date(NOW + 86400000).toISOString(); },
    f => { f.state.sourcePatch.credentialDigest = accountDigest("wrong", "wrong"); },
    f => { f.state.workerPatch.running = false; }, f => { f.state.workerPatch.offerId = "99"; },
    f => { f.state.workerPatch.configDigest = "0".repeat(64); },
    f => { f.state.workerPatch.checkedAt = new Date(NOW - 300001).toISOString(); },
  ];
  for (const change of cases) {
    const f = await fixture(t); change(f);
    await assert.rejects(f.launch(), { code: "LAUNCH_UNVERIFIED" });
    assert.equal(f.state.writes.length, 0);
    await assert.rejects(fs.stat(f.intentFile), { code: "ENOENT" });
  }
});

test("every native listing, vault and unit identity is rechecked before dispatch", async t => {
  const cases = [
    f => { f.state.fieldsPatch.list_stock_num = "2"; }, f => { f.state.snapshotPatch.title = "Different promise"; },
    f => { f.state.settings.outstock = 0; }, f => { f.state.settings.is_auto_deliver = 2; },
    f => { f.state.settings.storage_id = 99; }, f => { f.state.storage.type = 2; },
    f => { f.state.storage.is_repeat = 1; }, f => { f.state.storage.gid = 99; },
    f => { f.state.inventory = f.state.inventory.replace("Totals：1", "Totals：2"); },
    f => { f.state.inventory = f.state.inventory.replace('data="11"', 'data="99"'); },
    f => { f.state.product.delete_time = 123; }, f => { f.state.product.wd_order = "withdrawn"; },
    f => { f.state.product.account = "changed-native-account"; }, f => { f.state.product.password = "changed-native-password"; },
  ];
  for (const change of cases) {
    const f = await fixture(t); change(f);
    await assert.rejects(f.launch(), { code: "LAUNCH_UNVERIFIED" });
    assert.equal(f.state.writes.length, 0);
  }
});

test("slow checks cannot use expired source proof and ambiguous journals cannot launch", async t => {
  const f = await fixture(t); f.state.advanceDuringProductRead = 120001;
  await assert.rejects(f.launch(), { code: "LAUNCH_UNVERIFIED" });
  assert.equal(f.state.writes.length, 0);
  const g = await fixture(t), snapshot = await g.options.ledger.snapshot();
  snapshot.units.push({ ...snapshot.units[0], sourceId: "another", storageId: "22" });
  g.options.ledger = { snapshot: async () => snapshot };
  await assert.rejects(g.launch(), { code: "LAUNCH_UNVERIFIED" });
  assert.equal(g.state.writes.length, 0);
});

test("any uncertain activation or changed readback pauses and permanently retains intent", async t => {
  for (const mode of ["write", "content", "consumed", "worker", "pause-failure"]) {
    const f = await fixture(t);
    if (mode === "write" || mode === "pause-failure") f.state.uncertain = true;
    if (mode === "pause-failure") f.state.pauseFails = true;
    if (mode === "content") f.state.afterWrite = () => { f.state.fieldsPatch.list_unit_price = "9"; };
    if (mode === "consumed") f.state.afterWrite = () => { f.state.product.status = 2; f.state.product.buy_order = 101; f.state.product.buy_user_id = 10; f.state.product.used_time = "2026-11-16 10:00:00"; };
    if (mode === "worker") f.state.afterWrite = () => { f.state.workerPatch.running = false; };
    await assert.rejects(f.launch(), error => error.code === "WRITE_UNCERTAIN" && error.uncertain === true && !error.message.includes("SECRET"));
    assert.equal(f.state.pauseCalls, 1);
    assert.equal(f.state.writes.length, 1);
    assert.equal((await f.options.ledger.snapshot()).units[0].status, "stocked");
    await assert.rejects(f.launch(), { code: "ACTIVATION_ALREADY_ATTEMPTED" });
    assert.equal(f.state.writes.length, 1);
  }
});

test("concurrent explicit launch calls can dispatch only once", async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.launch(), f.launch(), f.launch()]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.pauseCalls, 0);
});
