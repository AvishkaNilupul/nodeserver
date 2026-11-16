"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DOMParser } = require("../utils/z2u/node_modules/linkedom");
const { SCALARS, ARRAYS } = require("../utils/z2u/offers");
const { createVaultProtocol } = require("../utils/z2u/vaultProtocol");
const parseDocument = html => new DOMParser().parseFromString(html, "text/html");
const escapeHtml = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

async function fixture() {
  const state = { status: "4", fields: { ...Object.fromEntries(SCALARS.map(name => [name, "1"])),
    list_pk: "15", list_title: "Synthetic old set", list_description: "Old complete description", list_max_num: "0",
    "list_device_id[]": ["7", "8"], "list_transaction_mode[]": ["1"], "listPic[]": ["synthetic-image"] },
    writes: [], apply: true, uncertain: false, enable: false, pauseFails: false, corruptField: false, editorFails: false };
  const options = { offerId: "15", gameId: "13", categoryId: "14", parseDocument };
  const protocol = createVaultProtocol({
    readPage: async path => {
      if (path === "/sell/manageList?service=14&game=13&page=1") {
        return `<script>let url="https://www.z2u.com/sell/manageList?service=14&game=13";</script>
          <div class="div-table-row" data="15"><a class="set_status" data-value="${state.status}">Action</a></div>`;
      }
      assert.equal(path, "/sell/manageEdit.html?id=15");
      if (state.editorFails && state.writes.length) throw new Error("SECRET RESPONSE");
      if (state.enableOnEditorRead && state.writes.length) state.status = "1";
      return `<form id="form">${SCALARS.map(name => name === "list_description" ?
        `<textarea name="${name}">${escapeHtml(state.fields[name])}</textarea>` :
        `<input name="${name}" value="${escapeHtml(state.fields[name])}">`).join("")}
        ${ARRAYS.map(name => state.fields[name].map(value => `<input name="${name}" value="${escapeHtml(value)}">`).join("")).join("")}</form>`;
    },
    readJson: async () => { throw new Error("Unexpected JSON"); },
    mutate: async (path, build, options) => {
      const body = build("SYNTHETIC-FRESH-TOKEN");
      state.writes.push({ path, fields: [...body.entries()] });
      if (path === "/sell/productAction") {
        assert.equal(body.get("list_action"), "off_line");
        assert.equal(body.get("list_pk"), "15");
        if (state.pauseFails) { const error = new Error("Synthetic failure"); error.uncertain = true; throw error; }
        state.status = "4";
        return { acknowledged: true, verified: false };
      }
      assert.equal(path, "/sell/manageListToUpdate");
      assert.equal(options.csrf, true);
      assert.equal(body.get("__token__"), "SYNTHETIC-FRESH-TOKEN");
      if (state.apply) {
        for (const name of SCALARS) state.fields[name] = body.get(name);
        for (const name of ARRAYS) state.fields[name] = body.getAll(name);
        if (state.corruptField) state.fields.list_stock_num = "99";
      }
      if (state.enable) state.status = "1";
      if (state.uncertain) { const error = new Error("Synthetic lost acknowledgement"); error.uncertain = true; throw error; }
      return { acknowledged: true, verified: false };
    },
  });
  const priorSnapshot = await protocol.readOfferSnapshot(options);
  const desiredFields = { ...structuredClone(priorSnapshot.fields), list_title: "Synthetic exact set", list_description: "New full description with <literal> & text",
    list_max_num: "1", list_less_num: "1", list_stock_num: "1" };
  return { state, protocol, options, priorSnapshot, desiredFields,
    edit: overrides => protocol.editPausedOffer({ priorSnapshot, desiredFields, parseDocument, ...overrides }) };
}

test("paused edit repairs old unknown maximum with full form, fresh token and exact readback", async () => {
  const f = await fixture();
  assert.equal(f.priorSnapshot.constraints.ready, false);
  const after = await f.edit();
  assert.equal(after.verified, true);
  assert.equal(after.status, "paused");
  assert.equal(after.statusCode, 4);
  assert.equal(after.constraints.maxPurchaseQuantity, 1);
  assert.deepEqual(after.fields, f.desiredFields);
  assert.equal(f.state.writes.length, 1);
  assert.equal(JSON.stringify(after).includes("SYNTHETIC-FRESH-TOKEN"), false);
  assert.deepEqual(f.state.writes[0].fields.filter(([name]) => name === "list_device_id[]"), [["list_device_id[]", "7"], ["list_device_id[]", "8"]]);
});

test("empty transaction checkbox selection preserves the observed empty fallback field", async () => {
  const f = await fixture();
  f.desiredFields["list_transaction_mode[]"] = [];
  await f.edit();
  assert.deepEqual(f.state.writes[0].fields.filter(([name]) => name.startsWith("list_transaction_mode")), [["list_transaction_mode", ""]]);
});

test("on-sale, expired, stale or unverified prior snapshots cannot dispatch an edit", async () => {
  for (const change of [f => { f.state.status = "1"; }, f => { f.state.status = "5"; },
    f => { f.state.fields.list_title = "Changed elsewhere"; }, f => { f.priorSnapshot.verified = false; },
    f => { f.priorSnapshot.categoryId = "99"; }]) {
    const f = await fixture(); change(f);
    await assert.rejects(f.edit());
    assert.equal(f.state.writes.length, 0);
  }
});

test("complete desired fields cannot change identity or inject omitted/unobserved/token fields", async () => {
  for (const change of [fields => { delete fields["listPic[]"]; }, fields => { fields.list_pk = "16"; },
    fields => { fields.__token__ = "stale"; }, fields => { fields.list_max_num = "0"; },
    fields => { fields.list_less_num = "2"; }, fields => { fields.list_stock_num = "-1"; },
    fields => { fields.list_unit_price = "0"; }, fields => { fields["list_device_id[]"] = [true]; }]) {
    const f = await fixture(); change(f.desiredFields);
    await assert.rejects(f.edit(), TypeError);
    assert.equal(f.state.writes.length, 0);
  }
});

test("lost acknowledgement converges by exact paused readback and never retries save", async () => {
  const f = await fixture(); f.state.uncertain = true;
  assert.equal((await f.edit()).verified, true);
  assert.equal(f.state.writes.length, 1);
  const missing = await fixture(); missing.state.uncertain = true; missing.state.apply = false;
  await assert.rejects(missing.edit(), error => error.code === "WRITE_UNCERTAIN" && error.uncertain === true);
  assert.equal(missing.state.writes.length, 1);
});

test("unexpected activation is immediately paused and edit remains uncertain", async () => {
  for (const pauseFails of [false, true]) {
    const f = await fixture(); f.state.enable = true; f.state.pauseFails = pauseFails;
    await assert.rejects(f.edit(), error => error.code === "WRITE_UNCERTAIN" && error.uncertain === true);
    assert.deepEqual(f.state.writes.map(row => row.path), ["/sell/manageListToUpdate", "/sell/productAction"]);
    assert.equal(f.state.status, pauseFails ? "1" : "4");
  }
});

test("activation during complete editor read is caught by final group state verification", async () => {
  const f = await fixture(); f.state.enableOnEditorRead = true;
  await assert.rejects(f.edit(), error => error.code === "WRITE_UNCERTAIN" && error.uncertain === true);
  assert.deepEqual(f.state.writes.map(row => row.path), ["/sell/manageListToUpdate", "/sell/productAction"]);
  assert.equal(f.state.status, "4");
});

test("acknowledged save still fails on changed or unreadable full readback", async () => {
  for (const flag of ["corruptField", "editorFails"]) {
    const f = await fixture(); f.state[flag] = true;
    await assert.rejects(f.edit(), error => error.code === "WRITE_UNCERTAIN" && !error.message.includes("SECRET"));
    assert.equal(f.state.writes.length, 1);
  }
});
