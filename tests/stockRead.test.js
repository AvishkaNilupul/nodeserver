// The guardian's auto-feed decides how many accounts to push into a quantity
// listing from a single number: the remaining stock. Reading it wrong is
// expensive in both directions — too low over-feeds accounts into a full
// offer, and an unreadable value silently skips the feed and raises a
// "could not read remaining stock" finding. Both live failure modes are
// pinned here (field priority, and the page-1-only offer scan).
const test = require("node:test");
const assert = require("node:assert");
const { ggselStockField } = require("../utils/marketplaces");

// Shapes copied from live seller-API responses, 2026-08-09.
const SINGLE_OFFER = {
  id: 102603021,
  status: "active",
  quantity: 4,
  max_quantity: null,
  in_stock_products_count: 4,
  in_stock_splitted_products_count: 0,
  sold_products_count: 0,
  has_splitted_products: false,
  is_autoselling: true,
};
const LIST_ROW = {
  id: 102690414,
  status: "active",
  quantity: 10,
  max_quantity: 10,
  has_splitted_products: false,
  is_autoselling: false,
};

test("real attached-unit count wins over the advertised quantity", () => {
  // quantity is what the offer advertises; in_stock_products_count is what is
  // actually left to deliver. They drift after a sale until finalize re-syncs,
  // and feeding against the stale advertised number over-feeds.
  assert.strictEqual(
    ggselStockField({
      ...SINGLE_OFFER,
      quantity: 9,
      in_stock_products_count: 4,
    }),
    4,
  );
  assert.strictEqual(ggselStockField(SINGLE_OFFER), 4);
});

test("a list row falls back to quantity, the only stock field it carries", () => {
  assert.strictEqual(ggselStockField(LIST_ROW), 10);
});

test("a splitted-product offer is counted by its splitted units", () => {
  assert.strictEqual(
    ggselStockField({
      ...SINGLE_OFFER,
      has_splitted_products: true,
      in_stock_splitted_products_count: 7,
      in_stock_products_count: 0,
      quantity: 3,
    }),
    7,
  );
});

test("a sold-out offer reads as 0, not as unreadable", () => {
  assert.strictEqual(
    ggselStockField({
      ...SINGLE_OFFER,
      quantity: 0,
      in_stock_products_count: 0,
    }),
    0,
  );
});

test("null and boolean stock fields are refused, never coerced to 0", () => {
  // Number(null) is 0 and Number(false) is 0 — either would read as an empty
  // offer and make the auto-feeder push a full target's worth of accounts in.
  assert.strictEqual(
    ggselStockField({
      has_splitted_products: false,
      in_stock_products_count: null,
      quantity: null,
    }),
    null,
  );
  assert.strictEqual(
    ggselStockField({
      has_splitted_products: false,
      in_stock_products_count: true,
      quantity: false,
    }),
    null,
  );
  // A null real count still falls through to a usable advertised quantity.
  assert.strictEqual(
    ggselStockField({
      has_splitted_products: false,
      in_stock_products_count: null,
      quantity: 5,
    }),
    5,
  );
});

test("dead field names are gone: an offer is not read by them alone", () => {
  // available_quantity / products_count are on neither payload; matching them
  // would mean trusting a field the API never sends.
  assert.strictEqual(
    ggselStockField({ available_quantity: 12, products_count: 12 }),
    null,
  );
});

test("a missing offer reads as unknown rather than empty", () => {
  assert.strictEqual(ggselStockField(undefined), null);
  assert.strictEqual(ggselStockField(null), null);
  assert.strictEqual(ggselStockField({}), null);
});

// --- the paginated offer scan -------------------------------------------
// GGSel serves /offers 100 rows a page. The scan used to request the endpoint
// bare, so it only ever saw page 1 and reported every older offer as missing.
// This mirrors the walk in ggselFindOfferInList against a faked 3-page seller
// account (211 offers, the live count) to prove an offer past page 1 is found.
function walk(pages, offerId) {
  const PAGE = 100;
  for (let page = 1; page <= 50; page++) {
    const body = pages[page - 1] || { data: [], pagination: {} };
    const rows = Array.isArray(body.data) ? body.data : [];
    const row = rows.find((o) => String(o && o.id) === String(offerId));
    if (row) return { row, pagesRead: page };
    const pg = body.pagination || {};
    const more =
      pg.has_next_page === undefined
        ? rows.length === PAGE
        : !!pg.has_next_page;
    if (!more) return { row: null, pagesRead: page };
  }
  return { row: null, pagesRead: 50 };
}

function fakeAccount(total) {
  const pages = [];
  for (let start = 0; start < total; start += 100) {
    const data = [];
    for (let i = start; i < Math.min(start + 100, total); i++) {
      data.push({ id: 1000 + i, quantity: 1, in_stock_products_count: 2 });
    }
    pages.push({
      data,
      pagination: { has_next_page: start + 100 < total },
    });
  }
  return pages;
}

test("an offer past the first page is found instead of reported missing", () => {
  const pages = fakeAccount(211);
  const onPage3 = walk(pages, 1000 + 205);
  assert.ok(onPage3.row, "offer on page 3 must be found");
  assert.strictEqual(onPage3.pagesRead, 3);
  assert.strictEqual(ggselStockField(onPage3.row), 2);
});

test("the scan stops at the last page and reports a genuinely absent offer", () => {
  const pages = fakeAccount(211);
  const missing = walk(pages, 999999);
  assert.strictEqual(missing.row, null);
  assert.strictEqual(missing.pagesRead, 3, "must not spin past the last page");
});

test("a first page that is not full ends the walk immediately", () => {
  const pages = fakeAccount(11);
  assert.strictEqual(walk(pages, 999999).pagesRead, 1);
});
