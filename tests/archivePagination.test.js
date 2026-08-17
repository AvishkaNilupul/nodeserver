const test = require("node:test");
const assert = require("node:assert/strict");

const { paginateArchiveItems } = require("../utils/archivePagination");

const payload = {
  success: true,
  items: Array.from({ length: 205 }, (_, i) => ({ id: i })),
  hasMore: true,
};

test("archive pagination stays backward compatible without a limit", () => {
  assert.equal(paginateArchiveItems(payload, {}), payload);
});

test("archive pagination returns bounded pages and metadata", () => {
  const page = paginateArchiveItems(payload, { limit: "80", offset: "80" });
  assert.equal(page.items.length, 80);
  assert.equal(page.items[0].id, 80);
  assert.equal(page.total, 205);
  assert.equal(page.hasMore, true);
  assert.equal(page.truncated, true);
});

test("archive pagination stops at the cached result boundary", () => {
  const page = paginateArchiveItems(payload, { limit: "80", offset: "200" });
  assert.deepEqual(page.items.map((item) => item.id), [200, 201, 202, 203, 204]);
  assert.equal(page.hasMore, false);
});

test("archive pagination clamps unsafe limits and offsets", () => {
  assert.equal(paginateArchiveItems(payload, { limit: "999" }).limit, 200);
  assert.equal(
    paginateArchiveItems(payload, { limit: "-2", offset: "-10" }).limit,
    1,
  );
  assert.equal(
    paginateArchiveItems(payload, { limit: "10", offset: "-10" }).offset,
    0,
  );
});
