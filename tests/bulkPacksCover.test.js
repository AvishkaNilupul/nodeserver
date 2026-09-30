// Bulk-pack covers (docs/bulk-packs/PACKS-2.md §5): utils/setImage.js
// buildBulkCoverImage / buildBulkFarmCoverImage on the REAL image stack
// (sharp + librsvg), fed a DropSet-like set whose images are local files under
// public/. No network, no database. Every temp file lands in a private TMPDIR
// that each test checks and the suite removes.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

let sharp = null;
try {
  sharp = require("sharp");
} catch {
  sharp = null;
}
const SKIP = sharp ? false : "sharp (the real image stack) is not installed";

// os.tmpdir() reads TMPDIR on every call, so each cover file lands here.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "bulk-cover-test-"));
process.env.TMPDIR = TMP;
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const si = sharp ? require("../utils/setImage") : null;

// Five items -> a 3 x 2 grid of 300px cells (900 x 600): three with local
// images (one a x2 multi-copy reward), two hand-entered ones without an image
// (the grid shows their names as text tiles).
const SET = {
  _id: "set-bulk-cover-test",
  name: "Bulk cover test set",
  items: [
    { name: "Mythic Skin", image: "/app-icon-512.png" },
    { name: "Glider", image: "/app-icon-192.png", qty: 2 },
    { name: "Banner Spray Emote", image: "" },
    { name: "Pickaxe", image: "/listing-default-cover.png" },
    { name: "Loading Screen Wrap" },
  ],
};
const itemsOf = (n) => SET.items.concat(SET.items, SET.items).slice(0, n);
const FARM_IMAGES = [
  "/app-icon-512.png",
  "/app-icon-192.png",
  "/listing-default-cover.png",
];
const FARM_BULLETS = [
  "Fully Automated Farming",
  "Account-Safe and Undetectable",
  "Reliable Daily Rewards",
];
// The promo cover the farm pack cover is built on (two tile rows, the term in
// the band rather than a subtitle).
const promoOptsFor = (game, itemImages) => ({
  title: game + " Twitch Drops Automatic Farming",
  serviceText: "",
  bullets: FARM_BULLETS.slice(),
  itemImages,
  twitchTiles: true,
  rows: 2,
});

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const isPng = (file) =>
  fs.readFileSync(file).subarray(0, 8).equals(PNG_SIG) && /\.png$/.test(file);
const newFiles = (before) => fs.readdirSync(TMP).filter((f) => !before.has(f));
const snapshot = () => new Set(fs.readdirSync(TMP));

async function raw(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}
function px(img, x, y) {
  const i = (y * img.w + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}
// n full-width rows of a from row ay equal n rows of b from row by, exactly.
function rowsEqual(a, ay, b, by, n) {
  assert.equal(a.w, b.w, "same width");
  const len = a.w * 4 * n;
  return a.data
    .subarray(ay * a.w * 4, ay * a.w * 4 + len)
    .equals(b.data.subarray(by * b.w * 4, by * b.w * 4 + len));
}
// Share of pixels in rows [y0, y1) matching pred.
function share(img, y0, y1, pred) {
  let hit = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < img.w; x++) if (pred(px(img, x, y))) hit++;
  }
  return hit / ((y1 - y0) * img.w);
}
const isYellow = ([r, g, b]) => r > 230 && g > 180 && b < 120;
const isInk = ([r, g, b]) => r < 90 && g < 90 && b < 140; // headline #1e1b4b
const isRed = ([r, g, b]) => r > 180 && g < 90 && b < 90; // tag #dc2626
// First row (from y0) that is band-yellow at the left edge.
function firstYellowRow(img, y0 = 0) {
  for (let y = y0; y < img.h; y++) if (isYellow(px(img, 4, y))) return y;
  return -1;
}

test(
  "set cover: a PNG of the grid, unchanged, under a PACK OF N band with a -D% tag",
  { skip: SKIP },
  async () => {
    const before = snapshot();
    const file = await si.buildBulkCoverImage(SET, {
      packSize: 5,
      discountPct: 20,
    });
    assert.ok(file && fs.existsSync(file), "a cover file");
    assert.ok(isPng(file), "a PNG file: " + file);
    assert.equal(path.dirname(file), TMP);
    // Only the cover is left behind: the intermediate grid file is deleted.
    assert.deepEqual(newFiles(before), [path.basename(file)]);

    const cover = await raw(file);
    const gridFile = await si.buildSetGridImage(SET);
    const grid = await raw(gridFile);
    fs.unlinkSync(gridFile);
    assert.deepEqual([grid.w, grid.h], [900, 600]);

    // Plausible dimensions: grid width, grid height plus a band on top, never
    // taller than wide.
    assert.equal(cover.w, 900);
    const bandH = cover.h - grid.h;
    assert.ok(bandH >= 150 && bandH <= 300, "two-line band height " + bandH);
    assert.ok(cover.h <= cover.w, "not taller than wide");

    // The grid sits under the band pixel for pixel (its top 12 rows carry the
    // band's soft shadow, on the grid's own padding).
    assert.ok(
      rowsEqual(cover, bandH + 12, grid, 12, grid.h - 12),
      "grid unchanged",
    );

    // The band: yellow across the full width, a dark headline, a red tag.
    assert.equal(firstYellowRow(cover), 0);
    assert.ok(isYellow(px(cover, cover.w - 5, 5)), "band spans the width");
    const ink = share(cover, 0, bandH, isInk);
    const red = share(cover, 0, bandH, isRed);
    assert.ok(ink > 0.04, "headline text in the band: " + ink.toFixed(3));
    assert.ok(red > 0.01, "a red -D% tag in the band: " + red.toFixed(3));
    // Nothing of the band leaks into the grid below its shadow.
    assert.equal(share(cover, bandH + 12, cover.h, isYellow), 0);
    fs.unlinkSync(file);
  },
);

test(
  "set cover without a discount: one shorter band line and no tag",
  { skip: SKIP },
  async () => {
    const withTag = await si.buildBulkCoverImage(SET, {
      packSize: 5,
      discountPct: 20,
    });
    const file = await si.buildBulkCoverImage(SET, {
      packSize: 10,
      discountPct: 0,
    });
    assert.ok(isPng(file));
    const cover = await raw(file);
    const tagged = await raw(withTag);
    assert.equal(cover.w, 900);
    const bandH = cover.h - 600;
    assert.ok(bandH >= 100 && bandH < tagged.h - 600, "one-line band " + bandH);
    assert.ok(share(cover, 0, bandH, isInk) > 0.04, "headline text");
    assert.equal(share(cover, 0, bandH, isRed), 0, "no tag without a discount");
    // Discounts that round to nothing show no tag either.
    const tiny = await si.buildBulkCoverImage(SET, {
      packSize: 10,
      discountPct: 0.01,
    });
    assert.equal(share(await raw(tiny), 0, bandH, isRed), 0);
    for (const f of [file, withTag, tiny]) fs.unlinkSync(f);
  },
);

test(
  "square and tiny grids: widened to a square with seamless margins, band on top",
  { skip: SKIP },
  async () => {
    for (const n of [4, 9, 1]) {
      const set = { _id: "sq" + n, items: itemsOf(n) };
      const gridFile = await si.buildSetGridImage(set);
      const g = await sharp(gridFile).metadata();
      fs.unlinkSync(gridFile);
      assert.equal(g.width, g.height, n + " items make a square grid");

      const file = await si.buildBulkCoverImage(set, {
        packSize: 5,
        discountPct: 15,
      });
      assert.ok(isPng(file), n + " items: PNG");
      const cover = await raw(file);
      assert.equal(cover.w, cover.h, n + " items: square cover");
      assert.ok(
        cover.w >= 900,
        n + " items: small grids are scaled up (" + cover.w + ")",
      );
      assert.ok(
        isYellow(px(cover, 4, 4)) && isYellow(px(cover, cover.w - 5, 4)),
      );

      // The grid (scaled to >= 900) is centred under the band; the margin
      // beside it continues its background, so there is no visible seam.
      const gw = Math.max(900, g.width);
      const gx = Math.round((cover.w - gw) / 2);
      const bandH = cover.h - gw;
      assert.ok(gx > 0 && bandH > 0);
      for (const y of [bandH + 40, Math.round(bandH + gw / 2), cover.h - 20]) {
        for (const [inX, outX] of [
          [gx + 2, gx - 2],
          [gx + gw - 3, gx + gw + 1],
        ]) {
          const a = px(cover, inX, y);
          const b = px(cover, outX, y);
          const d = Math.max(...[0, 1, 2].map((c) => Math.abs(a[c] - b[c])));
          assert.ok(
            d <= 8,
            n + " items: seam at x=" + outX + " y=" + y + " (delta " + d + ")",
          );
        }
      }
      fs.unlinkSync(file);
    }
  },
);

test(
  "farm cover: the promo cover, unchanged, split by the band between its title and tiles",
  { skip: SKIP },
  async () => {
    const before = snapshot();
    const file = await si.buildBulkFarmCoverImage("Marvel Rivals", 365, {
      packSize: 5,
      discountPct: 20,
      itemImages: FARM_IMAGES,
    });
    assert.ok(file && isPng(file), "a PNG file: " + file);
    assert.deepEqual(
      newFiles(before),
      [path.basename(file)],
      "the promo temp file is deleted",
    );

    const cover = await raw(file);
    const promoFile = await si.buildPromoCoverImage(
      promoOptsFor("Marvel Rivals", FARM_IMAGES),
    );
    const promo = await raw(promoFile);
    fs.unlinkSync(promoFile);
    assert.equal(cover.w, 1024);
    assert.equal(promo.w, 1024);
    const bandH = cover.h - promo.h;
    assert.ok(bandH >= 150 && bandH <= 300, "two-line band height " + bandH);
    assert.ok(
      cover.h / cover.w < 1.2,
      "about as tall as the plain promo cover",
    );

    // Band position: below the three title lines, above the tiles.
    const y0 = firstYellowRow(cover);
    assert.ok(y0 > 200 && y0 < 400, "band starts at " + y0);
    // Everything above the band and below its shadow is the promo, pixel for pixel.
    assert.ok(rowsEqual(cover, 0, promo, 0, y0), "title part unchanged");
    assert.ok(
      rowsEqual(cover, y0 + bandH + 12, promo, y0 + 12, promo.h - y0 - 12),
      "tiles and bullets unchanged",
    );
    // The split ran through empty background: no white title text or tile in
    // the rows around it (the ones the band's shadow falls on included).
    for (let y = y0 - 2; y <= y0 + 10; y++) {
      for (let x = 0; x < promo.w; x++) {
        assert.ok(
          Math.min(...px(promo, x, y).slice(0, 3)) <= 225,
          "split row " + y + " is background",
        );
      }
    }
    const ink = share(cover, y0, y0 + bandH, isInk);
    const red = share(cover, y0, y0 + bandH, isRed);
    assert.ok(ink > 0.04, "headline + term text: " + ink.toFixed(3));
    assert.ok(red > 0.008, "a red -D% tag: " + red.toFixed(3));
    fs.unlinkSync(file);
  },
);

test(
  "farm cover: the term and the tag are optional; no images and no DB still makes a cover",
  { skip: SKIP },
  async () => {
    const full = await si.buildBulkFarmCoverImage("Fortnite", 180, {
      packSize: 10,
      discountPct: 10,
      itemImages: FARM_IMAGES,
    });
    const plain = await si.buildBulkFarmCoverImage("Fortnite", 0, {
      packSize: 10,
      discountPct: 0,
      itemImages: FARM_IMAGES,
    });
    const promoFile = await si.buildPromoCoverImage(
      promoOptsFor("Fortnite", FARM_IMAGES),
    );
    const promo = await sharp(promoFile).metadata();
    fs.unlinkSync(promoFile);
    const a = await raw(full);
    const b = await raw(plain);
    const bandFull = a.h - promo.height;
    const bandPlain = b.h - promo.height;
    assert.ok(
      bandPlain >= 100 && bandPlain < bandFull,
      "one line " + bandPlain + " < two " + bandFull,
    );
    const y0 = firstYellowRow(b);
    assert.ok(y0 > 0, "band placed");
    assert.equal(
      share(b, y0, y0 + bandPlain, isRed),
      0,
      "no tag without a discount",
    );
    assert.ok(share(b, y0, y0 + bandPlain, isInk) > 0.04, "headline text");

    // itemImages omitted and no Mongo connection: DropLog is not queried (the
    // build must not wait on a connection) and the tiles simply stay plain.
    const started = Date.now();
    const noImages = await si.buildBulkFarmCoverImage("Fortnite", 365, {
      packSize: 5,
    });
    assert.ok(noImages && isPng(noImages), "cover without images");
    assert.ok(Date.now() - started < 8000, "no wait for a database");
    for (const f of [full, plain, noImages]) fs.unlinkSync(f);
  },
);

test(
  'bad input returns "" and never throws (no temp file left behind)',
  { skip: SKIP },
  async () => {
    const before = snapshot();
    const errors = [];
    const origError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    try {
      const exploding = {
        get items() {
          throw new Error("boom: items getter");
        },
      };
      const setCases = [
        [null, { packSize: 5 }],
        [undefined, { packSize: 5 }],
        ["set", { packSize: 5 }],
        [{ items: [] }, { packSize: 5 }],
        [{ items: [{}, null] }, { packSize: 5 }],
        [SET, { packSize: 1 }],
        [SET, { packSize: 0, discountPct: 20 }],
        [SET, { packSize: -5 }],
        [SET, { packSize: "five" }],
        [SET, { packSize: NaN }],
        [SET, { packSize: 1e21 }],
        [SET, {}],
        [SET, null],
        [SET, undefined],
        [exploding, { packSize: 5 }],
      ];
      for (const [i, [set, opts]] of setCases.entries()) {
        assert.equal(
          await si.buildBulkCoverImage(set, opts),
          "",
          "set case #" + i,
        );
      }
      const exploding2 = {
        toString() {
          throw new Error("boom: game toString");
        },
      };
      const farmCases = [
        ["", 365, { packSize: 5 }],
        ["   ", 365, { packSize: 5 }],
        [null, 365, { packSize: 5 }],
        ["Fortnite", 365, { packSize: 1 }],
        ["Fortnite", 365, { packSize: "x" }],
        ["Fortnite", 365, null],
        ["Fortnite", 365, undefined],
        ["Fortnite", 365, "5"],
        [exploding2, 365, { packSize: 5 }],
      ];
      for (const [i, [game, days, opts]] of farmCases.entries()) {
        assert.equal(
          await si.buildBulkFarmCoverImage(game, days, opts),
          "",
          "farm case #" + i,
        );
      }
    } finally {
      console.error = origError;
    }
    assert.ok(
      errors.some((e) => /bulk set cover failed/.test(e)),
      "a real failure is logged",
    );
    assert.ok(
      errors.some((e) => /bulk farm cover failed/.test(e)),
      "a real failure is logged",
    );
    assert.deepEqual(newFiles(before), [], "no temp files left");
  },
);

// The existing builders are used as-is by many callers (the auto-lister,
// Gameflip fulfiller, custom listings...). The pack covers were added beside
// them WITHOUT touching them. These fingerprints are of their source as it was
// before the pack covers existed; if you change one of them on purpose,
// re-check both pack covers (the farm band's split in particular) and update
// the fingerprint here.
test("the existing builders are untouched", { skip: SKIP }, async () => {
  const fingerprints = {
    buildSetGridImage:
      "3e271a179e59f91a3d86a59692999e537c434e131620f8196b820f75231c7bc6",
    buildPromoCoverImage:
      "beda332867150e9f79489762d7941ac8ccc573aa89215f2ac5b3d2dedd1bafa2",
  };
  for (const [name, want] of Object.entries(fingerprints)) {
    assert.equal(typeof si[name], "function", name + " still exported");
    const got = crypto
      .createHash("sha256")
      .update(si[name].toString())
      .digest("hex");
    assert.equal(got, want, name + " source changed");
  }
  assert.equal(typeof si.buildBulkCoverImage, "function");
  assert.equal(typeof si.buildBulkFarmCoverImage, "function");

  // Their outputs keep their documented geometry: the grid is ceil(sqrt(n))
  // columns of 300px cells ...
  for (const [n, w, h] of [
    [1, 300, 300],
    [5, 900, 600],
    [10, 1200, 900],
  ]) {
    const f = await si.buildSetGridImage({ items: itemsOf(n) });
    const m = await sharp(f).metadata();
    fs.unlinkSync(f);
    assert.deepEqual(
      [m.format, m.width, m.height],
      ["png", w, h],
      n + " items",
    );
  }
  // ... and the farm listings' promo cover (3-line title, "1 Year Service",
  // 5 x 3 tiles, three bullets) is 1024 x 1142.
  const p = await si.buildPromoCoverImage({
    title: "Marvel Rivals Twitch Drops Automatic Farming",
    serviceText: "1 Year Service",
    bullets: FARM_BULLETS.slice(),
    itemImages: FARM_IMAGES,
    twitchTiles: true,
  });
  const pm = await sharp(p).metadata();
  fs.unlinkSync(p);
  assert.deepEqual([pm.format, pm.width, pm.height], ["png", 1024, 1142]);

  // Building pack covers leaves the set alone and the plain grid identical.
  const snap = JSON.parse(JSON.stringify(SET));
  const g1file = await si.buildSetGridImage(SET);
  const g1 = await raw(g1file);
  fs.unlinkSync(
    await si.buildBulkCoverImage(SET, { packSize: 5, discountPct: 20 }),
  );
  fs.unlinkSync(
    await si.buildBulkFarmCoverImage("Fortnite", 365, {
      packSize: 5,
      itemImages: FARM_IMAGES,
    }),
  );
  const g2file = await si.buildSetGridImage(SET);
  const g2 = await raw(g2file);
  fs.unlinkSync(g1file);
  fs.unlinkSync(g2file);
  assert.deepEqual(SET, snap, "set not mutated");
  assert.ok(g1.data.equals(g2.data), "grid output identical before and after");
});
