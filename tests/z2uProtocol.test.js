"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createZ2uClient, Z2uError, checkedUrl, gateCode } = require("../utils/z2u/client");
const { createVaultProtocol, buildImportFields, buildStorageFields, buildDeliveryFields, stockEvidence } = require("../utils/z2u/vaultProtocol");

function response(body, { status = 200, url = "https://www.z2u.com/userStorage/product", headers = {} } = {}) {
  return { ok: status >= 200 && status < 300, status, url, headers: new Headers(headers), text: async () => body };
}
function fakeClient(fn) { return createZ2uClient({ fetch: fn, intervalMs: 0 }); }

test("fixed origin prevents session headers reaching other hosts", async () => {
  let calls = 0;
  const client = fakeClient(async () => { calls++; return response("ok"); });
  for (const path of ["https://attacker.invalid/", "//attacker.invalid/", "http://www.z2u.com/", "https://u:p@www.z2u.com/", "/path#fragment"]) {
    assert.throws(() => checkedUrl(path), { code: "INVALID_URL" });
    await assert.rejects(client.readPage(path), { code: "INVALID_URL" });
  }
  assert.equal(calls, 0);
});

test("manual redirects never follow session to another origin", async () => {
  let calls = 0;
  const client = fakeClient(async (_url, init) => {
    calls++; assert.equal(init.redirect, "manual");
    return response("", { status: 302, headers: { location: "https://attacker.invalid/" } });
  });
  await assert.rejects(client.readPage("/userStorage/product"), { code: "INVALID_URL" });
  assert.equal(calls, 1);
});

test("session/privacy/storage/challenge states are distinct from empty inventory", async () => {
  for (const [url, html, code] of [
    ["https://www.z2u.com/user/verify_pass.html", "", "PRIVACY_LOCKED"],
    ["https://www.z2u.com/userStorage/applyCheck.html", "", "STORAGE_DISABLED"],
    ["https://www.z2u.com/login", "", "SESSION_EXPIRED"],
    ["https://www.z2u.com/userStorage/product", "<title>Just a moment...</title>", "CHALLENGE"],
  ]) {
    assert.equal(gateCode(url, html), code);
    await assert.rejects(fakeClient(async () => response(html, { url })).readPage("/userStorage/product"), { code });
  }
  assert.equal(gateCode("https://www.z2u.com/userStorage/product", '<a href="/login">Login</a>Storage List (Totals:0)'), null);
});

test("HTTP and malformed/throttled write responses remain uncertain and are never retried", async () => {
  for (const result of [response("<h1>Unavailable</h1>", { status: 503 }), response('{"code":0,"msg":"throttled SECRET"}'), response("not json")]) {
    let calls = 0;
    const client = fakeClient(async () => { calls++; return result; });
    await assert.rejects(client.mutate("/Platform/userStorage/storageEntrance.html?entrance=addproduct", () => new FormData()), error => error.uncertain && !error.message.includes("SECRET"));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const client = fakeClient(async () => { calls++; throw new Error("cookie=SECRET"); });
  await assert.rejects(client.mutate("/write", () => new FormData()), error => error.code === "WRITE_UNCERTAIN" && !error.message.includes("SECRET"));
  assert.equal(calls, 1);
});

test("CSRF uses AJAX GET response header, never envelope url", async () => {
  const calls = [];
  const client = fakeClient(async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.headers.get("X-Requested-With"), "XMLHttpRequest");
    if (url.endsWith("/public/createToken")) return response('{"code":1,"url":"wrong-token"}', { headers: { __token__: "header-token" } });
    assert.equal(init.body.get("__token__"), "header-token");
    return response('{"code":1,"data":{"count":1}}');
  });
  const result = await client.mutate("/write", token => new URLSearchParams({ __token__: token }), { csrf: true });
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls.length, 2);
  assert.deepEqual(result, { acknowledged: true, verified: false, data: { count: 1 } });
});

test("missing token prevents dispatch; serialized operations do not race", async () => {
  let calls = 0;
  const client = fakeClient(async () => { calls++; return response('{"code":1,"url":"not-token"}'); });
  await assert.rejects(client.mutate("/write", token => new URLSearchParams({ __token__: token }), { csrf: true }), { code: "TOKEN_MISSING", uncertain: false });
  assert.equal(calls, 1);
  let active = 0, peak = 0;
  const paced = createZ2uClient({ intervalMs: 5, fetch: async () => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
    return response("read");
  } });
  await Promise.all([paced.readPage("/one"), paced.readPage("/two"), paced.readPage("/three")]);
  assert.equal(peak, 1);
});

test("native import matches observed fields and rejects ambiguous line boundaries", () => {
  assert.deepEqual(buildImportFields({ storageId: "42", kind: "code", units: [{ code: "DIAGNOSTIC", otherInfo: "Not for sale", remark: "import-unique" }] }), {
    add_storage: "42", content: "DIAGNOSTIC|Not for sale|import-unique", split: "3", add_unit: "0", is_first: "1",
  });
  assert.equal(buildImportFields({ storageId: "42", kind: "account", units: [{ account: "test", password: "test-pass" }], priority: true }).content, "test|test-pass||");
  for (const code of ["a|b", "a\nb", "a\rb"]) assert.throws(() => buildImportFields({ storageId: "42", kind: "code", units: [{ code }] }));
  assert.throws(() => buildImportFields({ storageId: "42", kind: "code", units: [{ code: "a" }, { code: "a" }] }), /Duplicate/);
  assert.equal(buildStorageFields({ gameId: 12, categoryId: 3, name: "Diagnostic", kind: "code" }).is_repeat, "2");
});

test("configuration requires finite verified maximum and forces native automatic delivery", async () => {
  assert.throws(() => buildDeliveryFields({ offerId: "42", storageId: "43", maxPurchaseQuantity: 0 }));
  const calls = [];
  const fields = buildDeliveryFields({ offerId: "42", storageId: "43", maxPurchaseQuantity: 10 });
  assert.deepEqual(fields, { id: "42", storage_id: "43", is_auto_deliver: "1", outstock: "1", is_agiso: "0", buy_more: "10", note: "" });
  const protocol = createVaultProtocol({ readPage() {}, readJson: async (path, body) => { calls.push({ path, body }); return { ...fields, id: 42, storage_id: 43 }; },
    mutate: async (path, makeBody) => { calls.push({ path, body: Object.fromEntries(makeBody()) }); throw new Z2uError("WRITE_UNCERTAIN", "throttle", { uncertain: true }); } });
  const result = await protocol.configureNativeDelivery({ offerId: 42, storageId: 43, maxPurchaseQuantity: 10 });
  assert.equal(result.verified, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].path, /submitDeliver$/);
  assert.match(calls[1].path, /getProDetail$/);
});

test("acknowledged config is still uncertain if readback differs or fails", async () => {
  for (const readJson of [async () => ({ id: 42, is_auto_deliver: 2 }), async () => { throw new Error("session"); }]) {
    const protocol = createVaultProtocol({ readPage() {}, readJson, mutate: async () => ({ acknowledged: true, verified: false }) });
    await assert.rejects(protocol.configureNativeDelivery({ offerId: 42, storageId: 43, maxPurchaseQuantity: 10 }), { uncertain: true });
  }
});

test("read APIs use observed routes and native import leaves verification to ledger", async () => {
  const requests = [];
  const protocol = createVaultProtocol({ readPage: async path => { requests.push({ path }); return "html"; },
    readJson: async (path, body) => { requests.push({ path, body }); return { id: 42, type: 2, is_repeat: 2 }; },
    mutate: async (path, makeBody) => { requests.push({ path, body: Object.fromEntries(makeBody()) }); return { acknowledged: true, verified: false }; } });
  await protocol.readStoragePage({ storageId: 42, page: 2 });
  await protocol.readDeliveryLogsPage({ page: 3 });
  await protocol.readProduct(24);
  const result = await protocol.importUnits({ storageId: 42, kind: "code", units: [{ code: "DIAGNOSTIC" }] });
  assert.equal(result.verified, false);
  assert.match(requests[0].path, /storage_id=42/);
  assert.match(requests[0].path, /status=&page=2/);
  assert.match(requests[1].path, /autoDeliverLogs/);
  assert.deepEqual(requests[2].body, { id: "24" });
  assert.match(requests[3].path, /getOnestorage$/);
  assert.equal(requests[4].body.content, "DIAGNOSTIC||");
});

test("repeatable or mismatched storage cannot receive one-time units", async () => {
  for (const storage of [{ id: 42, type: 2, is_repeat: 1 }, { id: 43, type: 2, is_repeat: 2 }, { id: 42, type: 1, is_repeat: 2 }, {}]) {
    let writes = 0;
    const protocol = createVaultProtocol({ readPage() {}, readJson: async () => storage, mutate: async () => { writes++; } });
    await assert.rejects(protocol.importUnits({ storageId: 42, kind: "code", units: [{ code: "DIAGNOSTIC" }] }), { code: "STORAGE_MISMATCH", uncertain: false });
    assert.equal(writes, 0);
  }
});

function stockDocument({ total, ids, pages = [] }) {
  return { querySelectorAll(selector) {
    if (selector === "h1") return [{ textContent: `Storage List (Totals：${total})` }];
    if (selector === "#productlist .checkone[data]") return ids.map(value => ({ getAttribute: () => value }));
    if (selector === "a[href]") return pages.map(page => ({ getAttribute: () => `/userStorage/product?storage_id=42&page=${page}` }));
    throw new Error("Unexpected selector");
  } };
}

test("import readback matches secret content privately and requires remote ownership", async () => {
  const product = { id: 24, storage_id: 42, gid: 12, category_id: 3, account: "DIAGNOSTIC", password: "", note: "unique-marker", remark: "description", status: 1, buy_order: 0, used_time: null, delete_time: 0, wd_order: "", buy_user_id: 0 };
  const protocol = createVaultProtocol({ readPage: async () => "html", readJson: async () => product, mutate() {} });
  const input = { storageId: 42, gameId: 12, categoryId: 3, kind: "code", units: [{ code: "DIAGNOSTIC", otherInfo: "description", remark: "unique-marker" }],
    parseDocument: () => stockDocument({ total: 1, ids: ["24"] }) };
  const result = await protocol.reconcileUploadedUnits(input);
  assert.equal(result.complete, true);
  assert.equal(result.matched[0].productId, "24");
  assert.equal(result.matched[0].status, 1);
  assert.equal(result.matched[0].unsoldVerified, true);
  assert.equal(JSON.stringify(result).includes("DIAGNOSTIC"), false);
  assert.equal(JSON.stringify(result).includes("unique-marker"), false);
  product.delete_time = 1794806000;
  const recycled = await protocol.reconcileUploadedUnits(input);
  assert.equal(recycled.matched[0].status, 1);
  assert.equal(recycled.matched[0].unsoldVerified, false);
  assert.equal(recycled.matched[0].deleteTime, 1794806000);
  product.storage_id = 99;
  await assert.rejects(protocol.reconcileUploadedUnits(input), { code: "STORAGE_MISMATCH" });
});

test("stock evidence requires all deletion, withdrawal, buyer and sale markers to be clear", () => {
  const unsold = { status: 1, delete_time: 0, wd_order: "", buy_user_id: 0, buy_order: 0, used_time: null };
  assert.equal(stockEvidence(unsold).unsoldVerified, true);
  for (const changed of [{ delete_time: 1 }, { wd_order: "withdrawal-diagnostic" }, { buy_user_id: 99 }, { buy_order: 99 }, { used_time: 1794806000 }, { status: 2 }]) {
    assert.equal(stockEvidence({ ...unsold, ...changed }).unsoldVerified, false);
  }
  for (const key of Object.keys(unsold)) {
    const incomplete = { ...unsold }; delete incomplete[key];
    assert.equal(stockEvidence(incomplete).unsoldVerified, false);
  }
  assert.equal(stockEvidence({ ...unsold, buy_user_id: 99 }).hasBuyer, true);
  assert.equal(stockEvidence({ ...unsold, buy_user_id: undefined }).hasBuyer, null);
});

test("repeated pages, partial totals and duplicate product matches never become clear upload receipts", async () => {
  const products = { "24": { id: 24, storage_id: 42, gid: 12, category_id: 3, account: "DIAGNOSTIC", password: "", note: "unique-marker", remark: "", status: 1 } };
  products["25"] = { ...products["24"], id: 25 };
  const protocol = createVaultProtocol({ readPage: async () => "html", readJson: async (_path, body) => products[body.id], mutate() {} });
  const base = { storageId: 42, gameId: 12, categoryId: 3, kind: "code", units: [{ code: "DIAGNOSTIC", remark: "unique-marker" }] };
  const repeated = await protocol.reconcileUploadedUnits({ ...base, parseDocument: () => stockDocument({ total: 2, ids: ["24"], pages: [2] }) });
  assert.equal(repeated.complete, false);
  const duplicate = await protocol.reconcileUploadedUnits({ ...base, parseDocument: () => stockDocument({ total: 2, ids: ["24", "25"] }) });
  assert.equal(duplicate.complete, true);
  assert.deepEqual(duplicate.matched, []);
  assert.deepEqual(duplicate.ambiguous, [0]);
  const missing = await protocol.reconcileUploadedUnits({ ...base, units: [{ code: "DIFFERENT", remark: "unique-marker" }], parseDocument: () => stockDocument({ total: 1, ids: ["24"] }) });
  assert.deepEqual(missing.matched, []);
  assert.deepEqual(missing.missing, [0]);
});
