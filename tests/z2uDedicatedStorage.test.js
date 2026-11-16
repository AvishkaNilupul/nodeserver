"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DOMParser } = require("../utils/z2u/node_modules/linkedom");
const { extractCategoryEvidence, verifyDedicatedStorage } = require("../utils/z2u/dedicatedStorage");
const parseDocument = html => new DOMParser().parseFromString(html, "text/html");
const NOW = Date.parse("2026-11-16T12:00:00.000Z");
function fixture() {
  const offer = { offerId: "15", storageId: "12", gameId: "13", categoryId: "14" };
  const state = {
    storage: { id: 12, gid: 13, category_id: 14, name: "Synthetic dedicated storage", type: 1, is_repeat: 2, parent_id: 0 },
    options: '<option value="0">Select category</option><option value="12" class="is_last" data-num="0" data-type="1">Synthetic dedicated storage</option>',
    index: '<div id="menus-table"><div id="node-12"><div><input class="checkone" data="12"></div><div>Stock 0</div><div>Used 0</div><div>Totals 0</div><div><div class="action-btn-group" data-id="12" data-gid="13" data-category_id="14" data-type="1"></div></div></div></div>',
    inventory: '<h1>Storage List (Totals：0)</h1><div id="productlist"></div>',
    groups: { 1: { valid: true, context: { gameId: "13", categoryId: "14" }, offers: [{ offerId: "15", status: "paused", statusCode: 4 }], pages: [1, 2] },
      2: { valid: true, context: { gameId: "13", categoryId: "14" }, offers: [{ offerId: "16", status: "expired", statusCode: 5 }], pages: [1, 2] } },
    settings: { "15": { id: 15, product_id: 15, storage_id: 0 }, "16": { id: 16, product_id: 16, storage_id: 0 } }, links: [],
  };
  const options = { offer, provenance: { version: 1, ...offer, name: "Synthetic dedicated storage", createdAt: "2026-11-16T11:00:00.000Z" }, parseDocument, now: () => NOW,
    protocol: { readStorage: async () => state.storage, readStorageOptions: async () => state.options,
      readCategoriesPage: async () => state.index, readStoragePage: async () => state.inventory,
      readOfferGroup: async ({ page }) => state.groups[page], readOfferDelivery: async id => { state.links.push(id); return state.settings[id]; } } };
  return { state, options, verify: () => verifyDedicatedStorage(options) };
}

test("fresh empty category is checked against every offer across the explicit group", async () => {
  const f = fixture();
  assert.deepEqual(await f.verify(), { verified: true, ...f.options.offer });
  assert.deepEqual(f.state.links, ["15", "16"]);
  assert.deepEqual(extractCategoryEvidence(parseDocument(f.state.index), "12"), { storageId: "12", gameId: "13", categoryId: "14", type: "1", stock: 0, used: 0, total: 0 });
  f.state.settings["15"].storage_id = 12;
  assert.equal((await f.verify()).verified, true);
});

test("creation provenance requires exact identities, name and recent canonical UTC timestamp", async () => {
  for (const patch of [{ version: 2 }, { offerId: 15 }, { storageId: "99" }, { gameId: "99" }, { name: "Other" },
    { createdAt: "2026-11-15T11:59:59.999Z" }, { createdAt: "2026-11-16T12:00:05.001Z" },
    { createdAt: "2026-11-16 11:00:00" }, { createdAt: null }]) {
    const f = fixture(); Object.assign(f.options.provenance, patch);
    await assert.rejects(f.verify(), { code: "STORAGE_DEDICATION_UNVERIFIED" });
    assert.equal(f.state.links.length, 0);
  }
});

test("wrong, repeatable, child, nonempty or previously used category is rejected", async () => {
  const cases = [f => { f.state.storage.id = 99; }, f => { f.state.storage.gid = 99; },
    f => { f.state.storage.category_id = 99; }, f => { f.state.storage.type = 2; },
    f => { f.state.storage.is_repeat = 1; }, f => { f.state.storage.parent_id = 99; },
    f => { f.state.index = f.state.index.replace("Stock 0", "Stock 1"); },
    f => { f.state.index = f.state.index.replace("Used 0", "Used 1"); },
    f => { f.state.index = f.state.index.replace("Totals 0", "Totals 1"); },
    f => { f.state.inventory = f.state.inventory.replace("Totals：0", "Totals：1"); },
    f => { f.state.inventory += '<div id="productlist"><input class="checkone" data="11"></div>'; }];
  for (const change of cases) { const f = fixture(); change(f); await assert.rejects(f.verify(), { code: "STORAGE_DEDICATION_UNVERIFIED" }); }
});

test("option names and category metadata cannot substitute for exact unambiguous category identity", async () => {
  for (const change of [f => { f.state.options += f.state.options; }, f => { f.state.options = f.state.options.replace('data-num="0"', 'data-num="1"'); },
    f => { f.state.options = f.state.options.replace('data-type="1"', 'data-type="2"'); },
    f => { f.state.options = f.state.options.replace('class="is_last"', 'disabled class="is_last"'); },
    f => { f.state.index += f.state.index; }, f => { f.state.index = f.state.index.replace('data-gid="13"', 'data-gid="99"'); }]) {
    const f = fixture(); change(f); await assert.rejects(f.verify(), { code: "STORAGE_DEDICATION_UNVERIFIED" });
  }
});

test("any other linked offer, foreign target linkage or missing linkage field rejects dedication", async () => {
  for (const change of [f => { f.state.settings["16"].storage_id = 12; },
    f => { f.state.settings["15"].storage_id = 99; }, f => { delete f.state.settings["16"].storage_id; },
    f => { f.state.settings["16"].storage_id = false; }, f => { f.state.settings["16"].product_id = 99; }]) {
    const f = fixture(); change(f); await assert.rejects(f.verify(), { code: "STORAGE_DEDICATION_UNVERIFIED" });
  }
});

test("unknown target state, repeated pages, partial bound or foreign context cannot prove full scan", async () => {
  for (const change of [f => { f.state.groups[1].offers[0] = { offerId: "15", status: "on_sale", statusCode: 1 }; },
    f => { f.state.groups[2] = f.state.groups[1]; }, f => { f.options.maxPages = 1; },
    f => { f.state.groups[2].context.gameId = "99"; }, f => { f.state.groups[2].offers[0].status = "unknown"; },
    f => { f.state.groups[1].offers = []; }]) {
    const f = fixture(); change(f); await assert.rejects(f.verify(), { code: "STORAGE_DEDICATION_UNVERIFIED" });
  }
});
