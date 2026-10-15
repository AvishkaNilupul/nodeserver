// Code shop — cover image of a product (docs/code-shop/03-MARKETS.md, cover.js).
//
// Reuses the promo cover generator (utils/setImage.buildPromoCoverImage) with
// the product's reward images as tiles, in slot order. That generator reads a
// tile only from an https URL or a path under public/, and it CYCLES through
// whatever it loaded, so every tile position gets an explicit image here: a
// slot without an image, and every spare tile of the grid, gets one filler
// tile (the slot count big, "CODES" small) instead of a repeat of the rewards.
//
// The filler is written under public/ only for the render and deleted in
// `finally`, whatever the render does. The cover file the generator returns is
// the CALLER's to delete (publish.js does it in its own `finally`).

const crypto = require("crypto");
const fsp = require("fs/promises");
const path = require("path");

const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
// The largest grid gridFor() hands out (6 x 3); rewards past it are cut.
const MAX_TILES = 18;
const FILLER_PX = 512;
const PURPLE = "#7c3aed";

// Pure. How many columns and rows of tiles a product of n slots gets.
//   n <= 4  -> 2 x 2
//   n <= 12 -> 2 rows, ceil(n / 2) columns
//   else    -> 3 rows, min(6, ceil(n / 3)) columns (18 tiles at most)
function gridFor(n) {
  const k = Math.max(0, Math.floor(Number(n) || 0));
  if (k <= 4) return { cols: 2, rows: 2 };
  if (k <= 12) return { cols: Math.ceil(k / 2), rows: 2 };
  return { cols: Math.min(6, Math.ceil(k / 3)), rows: 3 };
}

// A tile the generator can actually read: an https URL, or an absolute path
// under public/ ("/img/x.png" — never "//host/x", which is a URL).
function tileRef(image) {
  const s = typeof image === "string" ? image.trim() : "";
  if (/^https:\/\//i.test(s)) return s;
  if (s.startsWith("/") && !s.startsWith("//")) return s;
  return "";
}

function fillerSvg(n) {
  const big = String(n);
  // Shrink the number as it grows so "18" fits as well as "3".
  const bigPx = big.length > 1 ? 230 : 280;
  const word = n === 1 ? "CODE" : "CODES";
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    FILLER_PX +
    '" height="' +
    FILLER_PX +
    '">' +
    '<rect width="100%" height="100%" rx="64" fill="' +
    PURPLE +
    '"/>' +
    '<text x="50%" y="300" font-family="Arial, sans-serif" font-weight="800" font-size="' +
    bigPx +
    '" fill="#ffffff" text-anchor="middle">' +
    big +
    "</text>" +
    '<text x="50%" y="400" font-family="Arial, sans-serif" font-weight="700" font-size="72" ' +
    'letter-spacing="8" fill="#ede9fe" text-anchor="middle">' +
    word +
    "</text>" +
    "</svg>"
  );
}

function createCover(deps = {}) {
  const setImage = () => (typeof deps.setImage === "function" ? deps.setImage() : require("../setImage"));
  const sharp = () => deps.sharp || require("sharp");

  function fillerName() {
    const name = "_tile_" + crypto.randomBytes(8).toString("hex") + ".png";
    return { file: path.join(PUBLIC_DIR, name), ref: "/" + name };
  }

  // -> path of the cover file (caller deletes it). Throws when no slot has an
  // image: a cover of nothing but fillers says nothing about the product.
  async function build(product) {
    const p = product || {};
    const slots = Array.isArray(p.slots) ? p.slots : [];
    const texts = p.texts || {};
    const n = slots.length;
    const { cols, rows } = gridFor(n);
    const total = cols * rows;
    const images = slots.slice(0, MAX_TILES).map((s) => tileRef(s && s.image));
    if (!images.some(Boolean)) throw new Error("no item images for the cover");

    let filler = null;
    try {
      if (images.length < total || images.some((x) => !x)) {
        // Named before it is written, so `finally` also removes a half-written file.
        filler = fillerName();
        const png = await sharp()(Buffer.from(fillerSvg(n), "utf8")).png().toBuffer();
        await fsp.writeFile(filler.file, png);
      }
      const itemImages = [];
      for (let i = 0; i < total; i++) itemImages.push(images[i] || filler.ref);
      return await setImage().buildPromoCoverImage({
        title: texts.coverTitle,
        serviceText: texts.coverServiceText,
        bullets: Array.isArray(texts.coverBullets) ? texts.coverBullets : [],
        itemImages,
        twitchTiles: false,
        cols,
        rows,
      });
    } finally {
      if (filler) await fsp.unlink(filler.file).catch(() => {});
    }
  }

  return { build };
}

module.exports = { createCover, gridFor, MAX_TILES, PUBLIC_DIR };
