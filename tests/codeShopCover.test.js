// Code shop cover (docs/code-shop/03-MARKETS.md, cover.js).
//
// The promo generator is faked: what matters here is the grid, the tile list it
// is handed, and that the filler tile written under public/ (the only place the
// generator reads a local tile from) never outlives a build — not even one
// whose render throws. The filler itself is rendered for real with sharp.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const { createCover, gridFor, PUBLIC_DIR } = require("../utils/codeShop/cover");

const tileFiles = () => fs.readdirSync(PUBLIC_DIR).filter((f) => /^_tile_[0-9a-f]+\.png$/.test(f));

// A fake setImage whose buildPromoCoverImage records its options, checks every
// filler tile it is handed really exists under public/ at render time, and
// answers a made-up cover path (or throws when told to).
function fakeSetImage({ fail = null } = {}) {
  const calls = [];
  const api = {
    async buildPromoCoverImage(opts) {
      const fillers = [...new Set(opts.itemImages.filter((r) => /^\/_tile_/.test(r)))];
      const seen = [];
      for (const ref of fillers) {
        const file = path.join(PUBLIC_DIR, ref.slice(1));
        assert.ok(fs.existsSync(file), "filler tile must exist while rendering: " + ref);
        seen.push(await sharp(file).metadata());
      }
      calls.push({ opts, fillers, meta: seen });
      if (fail) throw fail;
      return "/tmp/made-up-cover.png";
    },
  };
  return { calls, setImage: () => api };
}

function product(images, texts = {}) {
  return {
    slots: images.map((image, i) => ({ slotKey: "g:s" + i + ":1", label: "Reward " + (i + 1), image })),
    texts: {
      coverTitle: "Game Code Bundle",
      coverServiceText: images.length + " Redeem Codes",
      coverBullets: ["Instant Automatic Delivery", "Redeem on Your Own Account"],
      ...texts,
    },
  };
}

let before;
test.beforeEach(() => {
  before = tileFiles();
});
test.afterEach(() => {
  assert.deepEqual(tileFiles(), before, "no filler tile may be left under public/");
});

test("gridFor: 2x2 up to 4, two rows up to 12, then three rows of at most 6", () => {
  const table = [
    [0, 2, 2],
    [1, 2, 2],
    [3, 2, 2],
    [4, 2, 2],
    [5, 3, 2],
    [6, 3, 2],
    [7, 4, 2],
    [11, 6, 2],
    [12, 6, 2],
    [13, 5, 3],
    [15, 5, 3],
    [16, 6, 3],
    [18, 6, 3],
    [19, 6, 3],
    [40, 6, 3],
  ];
  for (const [n, cols, rows] of table) {
    assert.deepEqual(gridFor(n), { cols, rows }, "gridFor(" + n + ")");
    if (n <= 18) assert.ok(cols * rows >= n, "every slot gets a tile at n=" + n);
  }
});

test("slots without an image and spare tiles get the filler; it is deleted after", async () => {
  const fake = fakeSetImage();
  const cover = createCover({ setImage: fake.setImage });
  const out = await cover.build(product(["https://cdn.example.test/a.png", "", "/img/b.png"]));
  assert.equal(out, "/tmp/made-up-cover.png");
  assert.equal(fake.calls.length, 1);
  const { opts, fillers, meta } = fake.calls[0];
  assert.equal(fillers.length, 1, "one filler file serves every filler tile");
  const f = fillers[0];
  assert.deepEqual(opts.itemImages, ["https://cdn.example.test/a.png", f, "/img/b.png", f]);
  assert.equal(opts.cols, 2);
  assert.equal(opts.rows, 2);
  assert.equal(opts.twitchTiles, false);
  assert.equal(opts.title, "Game Code Bundle");
  assert.equal(opts.serviceText, "3 Redeem Codes");
  assert.deepEqual(opts.bullets, ["Instant Automatic Delivery", "Redeem on Your Own Account"]);
  assert.equal(meta[0].width, 512);
  assert.equal(meta[0].height, 512);
  assert.equal(meta[0].format, "png");
  assert.ok(!fs.existsSync(path.join(PUBLIC_DIR, f.slice(1))), "filler deleted after the render");
});

test("images the generator cannot read count as missing", async () => {
  const fake = fakeSetImage();
  const cover = createCover({ setImage: fake.setImage });
  await cover.build(product(["http://plain.example.test/a.png", "//cdn.example.test/b.png", "relative/c.png", "/ok.png"]));
  const { opts, fillers } = fake.calls[0];
  assert.equal(fillers.length, 1);
  assert.deepEqual(opts.itemImages, [fillers[0], fillers[0], fillers[0], "/ok.png"]);
});

test("a full grid needs no filler; rewards past 18 are cut", async () => {
  const fake = fakeSetImage();
  const cover = createCover({ setImage: fake.setImage });
  const four = ["/a.png", "/b.png", "/c.png", "/d.png"];
  await cover.build(product(four));
  assert.deepEqual(fake.calls[0].opts.itemImages, four);
  assert.equal(fake.calls[0].fillers.length, 0);

  const many = Array.from({ length: 20 }, (_, i) => "https://cdn.example.test/" + i + ".png");
  await cover.build(product(many));
  const big = fake.calls[1].opts;
  assert.equal(big.cols, 6);
  assert.equal(big.rows, 3);
  assert.deepEqual(big.itemImages, many.slice(0, 18));
  assert.equal(fake.calls[1].fillers.length, 0);
});

test("spare tiles of a wider grid are fillers too", async () => {
  const fake = fakeSetImage();
  const cover = createCover({ setImage: fake.setImage });
  const five = ["/1.png", "/2.png", "/3.png", "/4.png", "/5.png"];
  await cover.build(product(five));
  const { opts, fillers } = fake.calls[0];
  assert.equal(opts.cols, 3);
  assert.equal(opts.rows, 2);
  assert.deepEqual(opts.itemImages, [...five, fillers[0]]);
});

test("no item images at all: throws and renders nothing", async () => {
  const fake = fakeSetImage();
  const cover = createCover({ setImage: fake.setImage });
  await assert.rejects(cover.build(product(["", "", ""])), /no item images for the cover/);
  await assert.rejects(cover.build(product([])), /no item images for the cover/);
  await assert.rejects(cover.build({}), /no item images for the cover/);
  assert.equal(fake.calls.length, 0);
});

test("the filler is deleted even when the render throws", async () => {
  const fake = fakeSetImage({ fail: new Error("render blew up") });
  const cover = createCover({ setImage: fake.setImage });
  await assert.rejects(cover.build(product(["/a.png", ""])), /render blew up/);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].fillers.length, 1, "a filler was on disk during the failed render");
  // afterEach checks it is gone.
});
