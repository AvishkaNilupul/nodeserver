// Composes a numbered grid image from a drop set's item images (like the
// hand-made collages used on marketplace listings), so published listings get
// a proper cover photo automatically.
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const axios = require("axios");
const sharp = require("sharp");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const CELL = 300; // full cell incl. padding
const PAD = 14; // gap around each tile
const TILE = CELL - PAD * 2;
const IMG = TILE - 24; // image inside the tile
const MAX_ITEMS = 36;
const BG = "#14161c";
const TILE_BG = "#23262f";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
}

// Resolve an item's image to a Buffer: local cached file when possible,
// otherwise a (best-effort) download of the remote URL.
async function loadImage(image) {
  const img = String(image || "").trim();
  if (!img) return null;
  try {
    if (img.startsWith("/")) {
      const p = path.normalize(path.join(PUBLIC_DIR, img));
      if (!p.startsWith(PUBLIC_DIR)) return null;
      return await fsp.readFile(p);
    }
    if (/^https:\/\//i.test(img)) {
      const r = await axios.get(
        img.replace(/\{width\}/g, "512").replace(/\{height\}/g, "512"),
        { responseType: "arraybuffer", timeout: 15000, maxContentLength: 8e6 },
      );
      return Buffer.from(r.data);
    }
  } catch {
    return null;
  }
  return null;
}

// Build the grid PNG for a set. Returns the temp file path, or "" if the set
// has no usable images. Caller may delete the file when done.
async function buildSetGridImage(set) {
  const items = (set.items || []).slice(0, MAX_ITEMS);
  const buffers = [];
  for (const it of items) {
    const buf = await loadImage(it.image);
    if (buf) buffers.push(buf);
  }
  if (!buffers.length) return "";

  const n = buffers.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const width = cols * CELL;
  const height = rows * CELL;

  // Base layer: dark canvas + rounded tiles. Badge layer (numbers) is a
  // separate transparent SVG composited last so it sits on top of the images.
  const open =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    width +
    '" height="' +
    height +
    '">';
  let baseSvg =
    open + '<rect width="100%" height="100%" fill="' + esc(BG) + '"/>';
  let badgeSvgStr = open;
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * CELL + PAD;
    const y = Math.floor(i / cols) * CELL + PAD;
    baseSvg +=
      '<rect x="' + x + '" y="' + y + '" width="' + TILE + '" height="' +
      TILE + '" rx="16" fill="' + esc(TILE_BG) + '"/>';
    badgeSvgStr +=
      '<rect x="' + (x + 8) + '" y="' + (y + 8) + '" width="44" height="34" rx="8" fill="rgba(0,0,0,0.65)"/>' +
      '<text x="' + (x + 30) + '" y="' + (y + 33) + '" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#ffffff" text-anchor="middle">' +
      (i + 1) +
      "</text>";
  }
  baseSvg += "</svg>";
  badgeSvgStr += "</svg>";

  const composites = [];
  for (let i = 0; i < n; i++) {
    const cx = (i % cols) * CELL;
    const cy = Math.floor(i / cols) * CELL;
    try {
      const resized = await sharp(buffers[i])
        .resize(IMG, IMG, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      composites.push({
        input: resized,
        left: cx + Math.round((CELL - IMG) / 2),
        top: cy + Math.round((CELL - IMG) / 2),
      });
    } catch {
      // skip images sharp can't decode
    }
  }
  if (!composites.length) return "";

  const out = path.join(
    os.tmpdir(),
    "set-grid-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".png",
  );
  await sharp(Buffer.from(baseSvg, "utf8"))
    .composite(
      composites.concat([
        { input: Buffer.from(badgeSvgStr, "utf8"), left: 0, top: 0 },
      ]),
    )
    .png()
    .toFile(out);
  return out;
}

module.exports = { buildSetGridImage };
