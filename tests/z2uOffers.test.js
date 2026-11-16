"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DOMParser } = require("../utils/z2u/node_modules/linkedom");
const { SCALARS, extractOfferEditor, extractOfferGroup, verifyOfferSnapshot } = require("../utils/z2u/offers");
const { createVaultProtocol } = require("../utils/z2u/vaultProtocol");
const parseDocument = html => new DOMParser().parseFromString(html, "text/html");

function editorHtml(extra = "", overrides = {}) {
  const values = { ...Object.fromEntries(SCALARS.map(name => [name, "1"])), list_pk: "15",
    list_title: "Synthetic exact set", list_description: "Synthetic listing description",
    list_max_num: "2", list_less_num: "1", list_stock_num: "3", insurance: "0", ...overrides };
  return `<form id="form">${Object.entries(values).map(([name, value]) =>
    name === "insurance" ? `<select name="insurance"><option value="0">None</option><option value="7">Seven</option></select>` :
    name === "list_description" ? `<textarea name="${name}">${value}</textarea>` : `<input name="${name}" value="${value}">`).join("")}
    <select multiple name="list_device_id[]"><option selected value="7">Device</option><option value="8">Other</option></select>
    <input type="checkbox" name="list_transaction_mode[]" value="1" checked>
    <input type="checkbox" name="list_transaction_mode[]" value="2">
    <input type="hidden" name="listPic[]" value="synthetic-image">
    <input type="hidden" name="__token__" value="SECRET-TOKEN">
    <notemtpy name="$data.product_imgs"></notemtpy>${extra}</form>`;
}
function groupHtml({ gameId = "13", categoryId = "14", rows = [["15", "4"]], pages = [] } = {}) {
  return `<script>var url = "https://www.z2u.com/sell/manageList?service=${categoryId}&game=${gameId}";</script>
    ${rows.map(([offerId, status]) => `<div class="div-table-row" data="${offerId}"><span class="set_status" data-value="${status}">State</span></div>`).join("")}
    ${pages.map(page => `<a href="/sell/manageList?service=${categoryId}&game=${gameId}&page=${page}">Page</a>`).join("")}`;
}
function fakeProtocol(pages) {
  const requested = [];
  return { requested, protocol: createVaultProtocol({
    readPage: async url => { requested.push(url); if (!(url in pages)) throw new Error("Unexpected synthetic URL"); return pages[url]; },
    readJson: async () => { throw new Error("Read-only offer reader unexpectedly requested JSON"); },
    mutate: async () => { throw new Error("Read-only offer reader attempted mutation"); },
  }) };
}

test("static editor captures complete public fields using actual form-control semantics", () => {
  const actual = extractOfferEditor(parseDocument(editorHtml()));
  assert.equal(actual.valid, true);
  assert.equal(actual.title, "Synthetic exact set");
  assert.equal(actual.description, "Synthetic listing description");
  assert.equal(actual.fields.insurance, "0");
  assert.deepEqual(actual.fields["list_transaction_mode[]"], ["1"]);
  assert.deepEqual(actual.fields["list_device_id[]"], ["7"]);
  assert.deepEqual(actual.fields["listPic[]"], ["synthetic-image"]);
  assert.equal(JSON.stringify(actual).includes("SECRET-TOKEN"), false);
  assert.equal(actual.status, "unknown");
  assert.equal(actual.gameId, null);
  assert.equal(actual.constraints.maxPurchaseQuantity, 2);
});

test("browser checkbox state overrides its initial checked attribute", () => {
  const document = parseDocument(editorHtml());
  const checkbox = document.querySelector('input[type="checkbox"][checked]');
  Object.defineProperty(checkbox, "checked", { value: false });
  assert.deepEqual(extractOfferEditor(document).fields["list_transaction_mode[]"], []);
});

test("static textarea values decode entities once while preserving literal markup", () => {
  const document = parseDocument(editorHtml("", { list_description: "&lt;strong&gt;One &amp; two&lt;/strong&gt; &amp;lt;literal&amp;gt;" }));
  const actual = extractOfferEditor(document);
  assert.equal(actual.description, "<strong>One & two</strong> &lt;literal&gt;");
  // A browser-like textarea has already decoded RCDATA. Its value must survive.
  const original = document.createElement.bind(document);
  document.createElement = name => name === "textarea" ? { value: "&" } : original(name);
  document.querySelector('textarea[name="list_description"]').value = "<strong>One & two</strong> &lt;literal&gt;";
  assert.equal(extractOfferEditor(document).description, "<strong>One & two</strong> &lt;literal&gt;");
});

test("editor rejects unknown, disabled, missing or duplicate scalar fields", () => {
  for (const html of [editorHtml('<input name="unexpected" value="x">'),
    editorHtml('<input name="list_pk" value="15">'),
    editorHtml().replace('name="list_pk"', 'disabled name="list_pk"'),
    editorHtml().replace('name="list_title"', 'name="missing_title"')]) {
    assert.equal(extractOfferEditor(parseDocument(html)).valid, false);
  }
  assert.equal(extractOfferEditor(parseDocument('<form id="form"></form><form id="form"></form>')).valid, false);
});

test("group identity is derived from explicit game/service script, with finite states", () => {
  const actual = extractOfferGroup(parseDocument(groupHtml({ rows: [["15", "1"], ["16", "4"], ["17", "5"]], pages: [2] })));
  assert.equal(actual.valid, true);
  assert.deepEqual(actual.context, { gameId: "13", categoryId: "14" });
  assert.deepEqual(actual.offers.map(row => row.status), ["on_sale", "paused", "expired"]);
  assert.deepEqual(actual.pages, [1, 2]);
  for (const html of [groupHtml({ rows: [["15", "0"]] }), groupHtml({ rows: [["15", "4"], ["15", "4"]] }),
    groupHtml() + groupHtml({ gameId: "99", rows: [] }), groupHtml().replace(/<script>.*?<\/script>/, "")]) {
    assert.equal(extractOfferGroup(parseDocument(html)).valid, false);
  }
});

test("offer snapshot requires exact group membership, then exact editor identity", async () => {
  const { protocol, requested } = fakeProtocol({ "/sell/manageList?service=14&game=13&page=1": groupHtml(),
    "/sell/manageEdit.html?id=15": editorHtml() });
  const actual = await protocol.readOfferSnapshot({ offerId: "15", gameId: "13", categoryId: "14", parseDocument });
  assert.equal(actual.verified, true);
  assert.equal(actual.status, "paused");
  assert.equal(actual.gameId, "13");
  assert.equal(actual.categoryId, "14");
  assert.equal(requested.length, 2);
  assert.equal((await protocol.readOfferConstraints("15", { parseDocument })).maxPurchaseQuantity, 2);
  const expected = { offerId: "15", gameId: "13", categoryId: "14", title: actual.title,
    description: actual.description, status: "paused", fields: structuredClone(actual.fields) };
  assert.equal(verifyOfferSnapshot(actual, expected).verified, true);
  assert.equal(verifyOfferSnapshot(actual, { ...expected, fields: { ...expected.fields, list_stock_num: "999" } }).verified, false);
  assert.equal(verifyOfferSnapshot(actual, { ...expected, categoryId: "99" }).verified, false);
  assert.equal(verifyOfferSnapshot(actual, { ...expected, fields: {} }).verified, false);
  assert.equal(verifyOfferSnapshot({ ...actual, constraints: { ready: false } }, expected).verified, false);
});

test("wrong group, missing target, unknown status and mismatched editor stay unverified", async () => {
  for (const [group, editor] of [[groupHtml({ gameId: "99" }), editorHtml()],
    [groupHtml({ rows: [["16", "4"]] }), editorHtml()], [groupHtml({ rows: [["15", "6"]] }), editorHtml()],
    [groupHtml(), editorHtml("", { list_pk: "16" })]]) {
    const { protocol } = fakeProtocol({ "/sell/manageList?service=14&game=13&page=1": group,
      "/sell/manageEdit.html?id=15": editor });
    await assert.rejects(protocol.readOfferSnapshot({ offerId: "15", gameId: "13", categoryId: "14", parseDocument }), { code: "OFFER_UNVERIFIED" });
  }
});

test("group pagination must be bounded and cannot repeat rows", async () => {
  const pages = { "/sell/manageList?service=14&game=13&page=1": groupHtml({ pages: [2] }),
    "/sell/manageList?service=14&game=13&page=2": groupHtml({ pages: [2] }), "/sell/manageEdit.html?id=15": editorHtml() };
  const { protocol } = fakeProtocol(pages);
  await assert.rejects(protocol.readOfferSnapshot({ offerId: "15", gameId: "13", categoryId: "14", parseDocument }), { code: "OFFER_UNVERIFIED" });
  await assert.rejects(protocol.readOfferSnapshot({ offerId: "15", gameId: "13", categoryId: "14", parseDocument, maxPages: 1 }), { code: "OFFER_UNVERIFIED" });
  pages["/sell/manageList?service=14&game=13&page=2"] = groupHtml({ rows: [["16", "5"]], pages: [2] });
  assert.equal((await protocol.readOfferSnapshot({ offerId: "15", gameId: "13", categoryId: "14", parseDocument })).verified, true);
});

test("pause only emits literal off_line and requires fresh inactive readback", async () => {
  let status = "1", writes = 0;
  const protocol = createVaultProtocol({ readPage: async () => groupHtml({ rows: [["15", status]] }),
    readJson: async () => { throw new Error("Unexpected JSON"); },
    mutate: async (path, body, options) => {
      writes++;
      assert.equal(path, "/sell/productAction");
      assert.deepEqual(Object.fromEntries(body()), { list_pk: "15", list_action: "off_line" });
      assert.equal(options.csrf, false);
      status = "4";
      return { acknowledged: true, verified: false };
    } });
  const args = { offerId: "15", gameId: "13", categoryId: "14", parseDocument };
  assert.deepEqual(await protocol.pauseOffer(args), { verified: true, offerId: "15", gameId: "13", categoryId: "14", status: "paused", statusCode: 4, changed: true });
  assert.equal((await protocol.pauseOffer(args)).changed, false);
  status = "5";
  assert.equal((await protocol.pauseOffer(args)).changed, false);
  assert.equal(writes, 1);
});

test("uncertain pause converges only through fresh paused state; never retries or resumes", async () => {
  for (const changed of [true, false]) {
    let status = "1", writes = 0;
    const protocol = createVaultProtocol({ readPage: async () => groupHtml({ rows: [["15", status]] }), readJson: async () => {},
      mutate: async () => { writes++; if (changed) status = "4"; const error = new Error("Synthetic uncertain write"); error.uncertain = true; throw error; } });
    const pending = protocol.pauseOffer({ offerId: "15", gameId: "13", categoryId: "14", parseDocument });
    if (changed) assert.equal((await pending).verified, true);
    else await assert.rejects(pending, error => error.uncertain === true);
    assert.equal(writes, 1);
  }
  let writes = 0;
  const protocol = createVaultProtocol({ readPage: async () => groupHtml({ rows: [["15", "0"]] }), readJson: async () => {}, mutate: async () => { writes++; } });
  await assert.rejects(protocol.pauseOffer({ offerId: "15", gameId: "13", categoryId: "14", parseDocument }), { code: "OFFER_UNVERIFIED" });
  assert.equal(writes, 0);
});
