// mp.ggselEmptyVault — the proof a GGSel delist hands accounts back on.
//
// A paused GGSel offer keeps its codes, and re-activating it sells every one of
// them again (2,390 leftover codes of released accounts sat in paused offers on
// 2026-09-28). So a delist archives the in-stock codes and may release only
// what GGSel then REPORTS archived. These tests run the real function against a
// fake GGSel product store: axios and the settings module are stubbed through
// Module._load, the same way tests/ggselFinalizeSplitted.test.js does it.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

function loadWith(products, { deleteFails = false, stuck = false } = {}) {
  const calls = { deletes: [] };
  const fakeAxios = {
    async get(url) {
      if (!/\/offers\/\d+\/products\?page=/.test(url)) throw new Error("unexpected GET " + url);
      return { data: { data: products.map((p) => ({ ...p })), pagination: { has_next_page: false } } };
    },
    async delete(url, cfg) {
      calls.deletes.push({ url, ids: cfg.data.product_ids });
      if (deleteFails) {
        const e = new Error("Request failed with status code 422");
        e.response = { status: 422, data: {} };
        throw e;
      }
      if (!stuck) {
        for (const p of products) {
          if (cfg.data.product_ids.includes(p.id) && p.status === "in_stock") p.status = "archived";
        }
      }
      return { data: { success: true, job_id: "j" } };
    },
    async post() { return { data: {} }; },
    async patch() { return { data: {} }; },
  };
  const mpPath = require.resolve("../utils/marketplaces");
  const settingsPath = require.resolve("../utils/settings");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "axios") return fakeAxios;
    try {
      if (Module._resolveFilename(request, parent, isMain) === settingsPath) {
        return {
          loadSettings: () => ({ marketplaces: { ggsel: { apiKey: "test-api-key" } } }),
          saveSettings: () => {},
        };
      }
    } catch {
      /* not resolvable — fall through */
    }
    return origLoad.apply(this, arguments);
  };
  delete require.cache[mpPath];
  delete require.cache[settingsPath];
  let mp;
  try {
    mp = require(mpPath);
  } finally {
    Module._load = origLoad;
    delete require.cache[mpPath];
    delete require.cache[settingsPath];
  }
  return { mp, calls };
}

const code = (login) => "TWITCH DROP ACCOUNT\n\nLogin: " + login + "\nPassword: pw\n\n1. Log in…";

test("archives the in-stock codes and reports sold and archived from GGSel's own states", async () => {
  const { mp, calls } = loadWith([
    { id: 1, status: "in_stock", value: code("Alpha1") },
    { id: 2, status: "sold", value: code("beta2") },
    { id: 3, status: "archived", value: code("gamma3") },
    { id: 4, status: "in_stock", value: code("delta4") },
  ]);
  const out = await mp.ggselEmptyVault(555, { settleMs: 0, polls: 1 });
  assert.deepEqual(calls.deletes.map((d) => d.ids), [[1, 4]], "only in-stock codes are archived");
  assert.deepEqual(out.archived, [{ id: 1, login: "alpha1" }, { id: 4, login: "delta4" }]);
  assert.deepEqual(out.sold, [{ id: 2, login: "beta2" }]);
  assert.deepEqual(out.left, []);
  // Archived long ago is not "archived now": the caller must not re-release it.
  assert.ok(!out.archived.some((p) => p.id === 3));
});

test("a refused archive proves nothing: the codes are reported left, never archived", async () => {
  const { mp } = loadWith([{ id: 9, status: "in_stock", value: code("echo5") }], { deleteFails: true });
  const out = await mp.ggselEmptyVault(556, { settleMs: 0, polls: 1 });
  assert.deepEqual(out.archived, []);
  assert.deepEqual(out.left, [{ id: 9, login: "echo5" }]);
});

test("an archive GGSel accepts but never applies is reported left, not archived", async () => {
  const { mp } = loadWith([{ id: 7, status: "in_stock", value: code("fox6") }], { stuck: true });
  const out = await mp.ggselEmptyVault(557, { settleMs: 0, polls: 2 });
  assert.deepEqual(out.archived, []);
  assert.deepEqual(out.left, [{ id: 7, login: "fox6" }]);
});

test("an empty vault makes no archive call", async () => {
  const { mp, calls } = loadWith([{ id: 1, status: "sold", value: code("golf7") }]);
  const out = await mp.ggselEmptyVault(558, { settleMs: 0, polls: 1 });
  assert.equal(calls.deletes.length, 0);
  assert.deepEqual(out.sold, [{ id: 1, login: "golf7" }]);
});

test("ggselCodeLogin reads the login a code carries, lowercased", () => {
  const { mp } = loadWith([]);
  assert.equal(mp.ggselCodeLogin(code("MiXeD9")), "mixed9");
  assert.equal(mp.ggselCodeLogin("owner-typed text with no login line"), "");
});
