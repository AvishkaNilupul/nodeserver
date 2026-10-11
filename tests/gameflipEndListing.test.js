// utils/marketplaces.gameflipEndListing — taking a listing off Gameflip for
// good, and what it may REPORT about it.
//
// Its callers hand an account back to stock on "ended". Under its rate limiter
// Gameflip answers 200 to writes it never applies, so "ended" has to be
// Gameflip's own word about the listing afterwards: HTTP 404 carrying its error
// envelope (utils/gameflipGone). This file drives the real function over a
// scripted HTTP client.
//
// The one that mattered: when the DELETE itself answered 404 the function used
// to return at once — "already gone" — with nothing read back. A 404 on a
// delete is the delete's answer, not the listing's.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const ID = "4f1b3263-aaaa-bbbb-cccc-0000000000e1";
// What Gameflip really sends (read live 2026-10-11).
const NOT_FOUND = { status: "FAILURE", data: null, error: { message: "Not Found", code: 404, http_status: 404 } };
const LIMITED = { status: "FAILURE", data: null, error: { message: "Too many attempts - Retry later", code: 429, http_status: 429 } };
const httpError = (status, data) => Object.assign(new Error("Request failed with status code " + status), { response: { status, data } });

// A fresh utils/marketplaces.js over a scripted axios. `script` answers each
// call: { patch, del, get } — a function returning a value to resolve with, or
// throwing.
function load(script) {
  const calls = [];
  const run = (verb, fn) => async (url) => {
    calls.push(verb + " " + url.replace(/^.*\/api\/v1/, ""));
    if (!fn) return { data: {} };
    return fn();
  };
  const stubAxios = {
    get: run("GET", script.get),
    patch: run("PATCH", script.patch),
    delete: run("DELETE", script.del),
    post: async () => ({ data: {} }),
    put: async () => ({ data: {} }),
    create: () => stubAxios,
    defaults: { headers: {} },
    interceptors: { request: { use() {} }, response: { use() {} } },
  };
  const stubSettings = {
    loadSettings: () => ({ marketplaces: { gameflip: { apiKey: "k", apiSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" } } }),
    saveSettings: () => {},
    getAutoFarm: () => ({}),
    getUnclaimedPricing: () => ({}),
  };
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const fromMarketplaces = parent && /marketplaces\.js$/.test(parent.filename || "");
    if (request === "axios") return stubAxios;
    if (fromMarketplaces && request === "./settings") {
      return { ...realLoad.call(this, request, parent, isMain), ...stubSettings };
    }
    if (fromMarketplaces && request === "./secretBox") {
      return { ...realLoad.call(this, request, parent, isMain), decrypt: (v) => String(v || "") };
    }
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    const path = require.resolve("../utils/marketplaces");
    delete require.cache[path];
    const mod = require("../utils/marketplaces");
    delete require.cache[path];
    return { mod, calls };
  } finally {
    Module._load = realLoad;
  }
}

const gone = () => {
  throw httpError(404, NOT_FOUND);
};
const status = (st) => () => ({ data: { data: { status: st } } });

test("an on-sale listing: off sale, deleted, and Gameflip's own 404 read back — ended, and proved", async () => {
  const { mod, calls } = load({ get: gone });
  assert.deepStrictEqual(await mod.gameflipEndListing(ID, { status: "onsale" }), { deleted: true, confirmed: true });
  assert.deepStrictEqual(calls, ["PATCH /listing/" + ID, "DELETE /listing/" + ID, "GET /listing/" + ID]);
});

test("a draft, a ready or an expired listing is deleted outright — no off-sale patch for it to refuse first", async () => {
  for (const st of ["draft", "ready", "expired"]) {
    const { mod, calls } = load({
      get: gone,
      patch: () => {
        throw new Error("a listing that is not on sale must not be patched");
      },
    });
    assert.deepStrictEqual(await mod.gameflipEndListing(ID, { status: st }), { deleted: true, confirmed: true }, st);
    assert.deepStrictEqual(calls, ["DELETE /listing/" + ID, "GET /listing/" + ID], st);
  }
});

test("a 404 on the DELETE is the delete's answer, not the listing's — the listing is read back before anything is reported", async () => {
  // Really gone already: the read-back says so, and that is the proof.
  let w = load({ del: gone, get: gone });
  assert.deepStrictEqual(await w.mod.gameflipEndListing(ID, { status: "draft" }), { deleted: false, confirmed: true });
  assert.deepStrictEqual(w.calls, ["DELETE /listing/" + ID, "GET /listing/" + ID], "read back — it used to return on the delete's 404 alone");

  // The delete answered 404 and the listing is still there: NOT ended.
  w = load({ del: gone, get: status("draft") });
  await assert.rejects(w.mod.gameflipEndListing(ID, { status: "draft" }), (e) => {
    assert.strictEqual(e.status, 409);
    assert.match(e.message, /still exists after the delete \(status "draft"\)/);
    return true;
  });
});

test("a delete Gameflip answered and did not apply is not 'ended'", async () => {
  const { mod } = load({ get: status("onsale") });
  await assert.rejects(mod.gameflipEndListing(ID, { status: "onsale" }), (e) => {
    assert.strictEqual(e.status, 409);
    assert.match(e.message, /still exists after the delete \(status "onsale"\)/);
    return true;
  });
});

test("only Gameflip's OWN 404 confirms — a proxy's page, the limiter or a timeout do not", async () => {
  for (const [what, err] of [
    ["a proxy's 404 page", httpError(404, "<html><h1>404 Not Found</h1><hr>nginx</html>")],
    ["a 404 with no body", httpError(404, undefined)],
    ["the limiter", httpError(429, LIMITED)],
    ["a timeout", Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ECONNABORTED" })],
  ]) {
    const { mod } = load({
      get: () => {
        throw err;
      },
    });
    await assert.rejects(mod.gameflipEndListing(ID, { status: "draft" }), /Gameflip end listing \(confirm\)/, what);
  }
});

test("a listing a buyer has, or is paying for, is never touched", async () => {
  for (const st of ["sold", "sale_pending"]) {
    const { mod, calls } = load({ get: gone });
    await assert.rejects(mod.gameflipEndListing(ID, { status: st }), new RegExp("is " + st + " — not ended"));
    assert.deepStrictEqual(calls, [], st);
  }
});

test("an off-sale patch Gameflip refuses stops it there: nothing is deleted while it may still be on sale", async () => {
  const { mod, calls } = load({
    patch: () => {
      throw httpError(429, LIMITED);
    },
    get: gone,
  });
  await assert.rejects(mod.gameflipEndListing(ID, { status: "onsale" }), /Gameflip end listing \(off sale\)/);
  assert.deepStrictEqual(calls, ["PATCH /listing/" + ID]);
});

test("a delete Gameflip refuses for any other reason is that error — not read as gone", async () => {
  const { mod, calls } = load({
    del: () => {
      throw httpError(429, LIMITED);
    },
    get: gone,
  });
  await assert.rejects(mod.gameflipEndListing(ID, { status: "draft" }), /Gameflip end listing \(delete\)/);
  assert.deepStrictEqual(calls, ["DELETE /listing/" + ID]);
});
