// ggselFinalizeStock used to read stock from in_stock_products_count alone.
// On an offer that sells "splitted" products that field is 0 — the real units
// live in in_stock_splitted_products_count — so finalize always took its
// `pending` early return and never reached the activate step. A splitted offer
// could therefore sit stocked, paused and off sale indefinitely, with the
// guardian's self-heal structurally unable to fix it.
//
// That also put the two stock readers in disagreement: ggselStockField (used by
// ggselOfferStockDetailed, the gate that decides whether to self-heal at all)
// prefers the splitted field, so the gate saw stock while finalize saw none.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("module");

// Load marketplaces.js with axios replaced, capturing the requests it makes.
function loadMarketplaces(offer, { afterActivate } = {}) {
  const calls = { gets: [], posts: [], patches: [] };
  let getCount = 0;

  const fakeAxios = {
    async get(url) {
      calls.gets.push(url);
      getCount++;
      // The verify read after batch_activate is the second GET.
      const body = getCount > 1 && afterActivate ? afterActivate : offer;
      return { data: { data: body } };
    },
    async post(url, body) {
      calls.posts.push({ url, body });
      return { data: { ok: true } };
    },
    async patch(url, body) {
      calls.patches.push({ url, body });
      return { data: { ok: true } };
    },
  };

  const mpPath = require.resolve("../utils/marketplaces");
  const settingsPath = require.resolve("../utils/settings");
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "axios") return fakeAxios;
    // ggselFinalizeStock resolves its key through getKeys() -> loadSettings().
    // Stub the settings module so a key is always present — the credential
    // plumbing is not what these tests exercise.
    try {
      if (Module._resolveFilename(request, parent, isMain) === settingsPath) {
        // decrypt() passes an unencrypted string straight through, so a plain
        // value here is enough to satisfy requireKeys("ggsel").
        return {
          loadSettings: () => ({
            marketplaces: { ggsel: { apiKey: "test-api-key" } },
          }),
          saveSettings: () => {},
        };
      }
    } catch {
      /* not a resolvable module — fall through */
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

// A paused offer whose stock lives only in the splitted-products field.
const SPLITTED_PAUSED = {
  id: 102669379,
  status: "paused",
  has_splitted_products: true,
  in_stock_splitted_products_count: 5,
  in_stock_products_count: 0,
  quantity: 0,
};

test("finalize re-activates a paused splitted-products offer", async () => {
  const { mp, calls } = loadMarketplaces(SPLITTED_PAUSED, {
    afterActivate: { ...SPLITTED_PAUSED, status: "active" },
  });
  const fin = await mp.ggselFinalizeStock(102669379);

  assert.notStrictEqual(
    fin.pending,
    true,
    "a splitted offer with 5 units in stock must not be treated as pending",
  );
  assert.strictEqual(fin.stock, 5, "stock should come from the splitted field");
  assert.strictEqual(
    fin.reactivated,
    true,
    "the paused offer must be activated",
  );
  assert.ok(
    calls.posts.some((p) => p.url.includes("batch_activate")),
    "batch_activate must actually be called",
  );
});

test("finalize reports an activation that did not stick", async () => {
  // GGSel answers 2xx to batch_activate but leaves the offer paused.
  const { mp } = loadMarketplaces(SPLITTED_PAUSED, {
    afterActivate: { ...SPLITTED_PAUSED, status: "paused" },
  });
  const fin = await mp.ggselFinalizeStock(102669379);

  assert.strictEqual(
    fin.activationStuck,
    true,
    "a still-paused offer after activate must be reported as stuck",
  );
});

test("a genuinely empty offer is still pending", async () => {
  const { mp } = loadMarketplaces({
    id: 1,
    status: "paused",
    has_splitted_products: true,
    in_stock_splitted_products_count: 0,
    in_stock_products_count: 0,
  });
  const fin = await mp.ggselFinalizeStock(1);

  assert.strictEqual(fin.pending, true, "no stock anywhere is still pending");
  assert.strictEqual(fin.reactivated, false, "an empty offer must not go live");
});
