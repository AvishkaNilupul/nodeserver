// The grid cover's "N ITEMS" band (setImage.buildSetGridImage, opts.showTotal).
// Measured 2026-10-06: an "11 Items" Overwatch offer carried a cover with seven
// numbered tiles and a small ×5 badge — it read as seven items.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const sharp = require("sharp");

const { buildSetGridImage } = require("../utils/setImage");

const single = (n) => ({ items: Array.from({ length: n }, (_, i) => ({ name: "Item " + (i + 1), qty: 1 })) });
const withCopies = { items: [...single(6).items, { name: "100 Comp Points", qty: 5 }] };

async function size(file) {
  const m = await sharp(file).metadata();
  const bytes = fs.readFileSync(file);
  fs.unlinkSync(file);
  return { width: m.width, height: m.height, bytes };
}

test("a bundle with several copies of an item gets the total band on top", async () => {
  const plain = await size(await buildSetGridImage(withCopies));
  const banded = await size(await buildSetGridImage(withCopies, { showTotal: true }));
  assert.deepStrictEqual([plain.width, plain.height], [900, 900], "7 tiles = a 3×3 grid");
  assert.deepStrictEqual([banded.width, banded.height], [900, 1000], "the same grid under a 100px band");
});

test("one copy of everything is drawn exactly as before, option or not", async () => {
  const plain = await size(await buildSetGridImage(single(6)));
  const asked = await size(await buildSetGridImage(single(6), { showTotal: true }));
  assert.deepStrictEqual([asked.width, asked.height], [plain.width, plain.height]);
  assert.ok(plain.bytes.equals(asked.bytes), "tiles already count the bundle: no band, no change");
});

test("without the option nothing changes for a multi-copy set", async () => {
  const a = await size(await buildSetGridImage(withCopies));
  const b = await size(await buildSetGridImage(withCopies, {}));
  assert.ok(a.bytes.equals(b.bytes));
});

test("a single tile with many copies still fits its band", async () => {
  const one = await size(await buildSetGridImage({ items: [{ name: "Esports Pack", qty: 11 }] }, { showTotal: true }));
  assert.deepStrictEqual([one.width, one.height], [300, 400]);
});
