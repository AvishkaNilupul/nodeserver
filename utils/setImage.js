// Composes a grid cover image from a drop set's item images (like the
// hand-made collages used on marketplace listings), so published listings get
// a proper cover photo automatically: white rounded cards on a vivid purple
// background.
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const axios = require("axios");
const sharp = require("sharp");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const CELL = 300; // full cell incl. padding
const PAD = 16; // gap around each tile
const TILE = CELL - PAD * 2;
const IMG = TILE - 40; // image inside the tile
const MAX_ITEMS = 36;
const BADGE = "#7c3aed";

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

function escXml(s) {
  return String(s == null ? "" : s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// Item name as centred, word-wrapped <tspan> lines for a text tile (used when
// an item has no image). Font size shrinks for longer names; wraps to a few
// lines and ellipsises anything that still doesn't fit.
function nameTspans(name, cx, cyMid) {
  const nm = String(name || "Item")
    .trim()
    .toUpperCase();
  const longest = Math.max(1, ...nm.split(/\s+/).map((w) => w.length));
  const fs = longest > 12 ? 22 : longest > 9 ? 27 : 33;
  const perLine = Math.max(6, Math.floor((TILE * 0.86) / (fs * 0.6)));
  const maxLines = 3;
  const words = nm.split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= perLine) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && cur !== lines[maxLines - 1]) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, perLine - 1) + "…";
  }
  const lineH = fs + 8;
  const startY = cyMid - ((lines.length - 1) * lineH) / 2 + fs / 3;
  const tspans = lines
    .map(
      (ln, i) =>
        '<tspan x="' +
        cx +
        '" y="' +
        (startY + i * lineH) +
        '">' +
        escXml(ln) +
        "</tspan>",
    )
    .join("");
  return { tspans, fs };
}

// Build the grid PNG for a set. Returns the temp file path, or "" if the set
// has no items at all. Items with an image show it; items without one show
// their name as a text tile, so a hand-entered set still gets a proper cover.
// Caller may delete the file when done.
async function buildSetGridImage(set) {
  const rawItems = (set.items || [])
    .slice(0, MAX_ITEMS)
    .filter((it) => it && (it.name || it.image));
  if (!rawItems.length) return "";
  const cells = [];
  for (const it of rawItems) {
    cells.push({
      name: String(it.name || "").trim(),
      buf: await loadImage(it.image),
    });
  }

  const n = cells.length;
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const width = cols * CELL;
  const height = rows * CELL;

  const open =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    width +
    '" height="' +
    height +
    '">';

  // Base layer: vivid purple gradient with soft diagonal light streaks, plus
  // white rounded cards. Badge layer (numbers) is a separate transparent SVG
  // composited last so it sits on top of the images.
  let baseSvg =
    open +
    "<defs>" +
    '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#a855f7"/>' +
    '<stop offset="0.5" stop-color="#8b5cf6"/>' +
    '<stop offset="1" stop-color="#6d28d9"/>' +
    "</linearGradient>" +
    '<linearGradient id="streak" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="rgba(255,255,255,0.16)"/>' +
    '<stop offset="1" stop-color="rgba(255,255,255,0)"/>' +
    "</linearGradient>" +
    "</defs>" +
    '<rect width="100%" height="100%" fill="url(#bg)"/>' +
    '<polygon points="0,0 ' +
    Math.round(width * 0.55) +
    ",0 0," +
    Math.round(height * 0.55) +
    '" fill="url(#streak)"/>' +
    '<polygon points="' +
    width +
    "," +
    height +
    " " +
    Math.round(width * 0.45) +
    "," +
    height +
    " " +
    width +
    "," +
    Math.round(height * 0.45) +
    '" fill="rgba(0,0,0,0.10)"/>';
  let badgeSvgStr = open;
  for (let i = 0; i < n; i++) {
    const x = (i % cols) * CELL + PAD;
    const y = Math.floor(i / cols) * CELL + PAD;
    baseSvg +=
      '<rect x="' +
      (x + 3) +
      '" y="' +
      (y + 6) +
      '" width="' +
      TILE +
      '" height="' +
      TILE +
      '" rx="24" fill="rgba(0,0,0,0.18)"/>' +
      '<rect x="' +
      x +
      '" y="' +
      y +
      '" width="' +
      TILE +
      '" height="' +
      TILE +
      '" rx="24" fill="#ffffff"/>';
    // No image for this item — render its name as a text tile so the grid still
    // shows what's in the bundle instead of an empty white card.
    if (!cells[i].buf) {
      const { tspans, fs } = nameTspans(
        cells[i].name,
        x + TILE / 2,
        y + TILE / 2,
      );
      baseSvg +=
        '<text font-family="Arial, sans-serif" font-weight="700"' +
        ' fill="#1f2937" text-anchor="middle" font-size="' +
        fs +
        '">' +
        tspans +
        "</text>";
    }
    badgeSvgStr +=
      '<rect x="' +
      (x + 12) +
      '" y="' +
      (y + 12) +
      '" width="46" height="32" rx="16" fill="' +
      BADGE +
      '"/>' +
      '<text x="' +
      (x + 35) +
      '" y="' +
      (y + 35) +
      '" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">' +
      (i + 1) +
      "</text>";
  }
  baseSvg += "</svg>";
  badgeSvgStr += "</svg>";

  const composites = [];
  for (let i = 0; i < n; i++) {
    if (!cells[i].buf) continue; // text tile — nothing to composite
    const cx = (i % cols) * CELL;
    const cy = Math.floor(i / cols) * CELL;
    try {
      const resized = await sharp(cells[i].buf)
        .resize(IMG, IMG, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
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
  // No guard on composites here: a set of only text tiles is still a valid,
  // useful cover (the names show what's in the bundle).

  const out = path.join(
    os.tmpdir(),
    "set-grid-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2) +
      ".png",
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

// ------------------------------------------------------------------
// Promo cover template (the "<GAME> TWITCH DROPS AUTOMATIC FARMING" collage):
// a purple gradient card with a bold title, a service subtitle, a grid of
// white rounded tiles (drop item images with a few Twitch-glyph accents), and
// footer bullet lines. Used by custom listings.
// ------------------------------------------------------------------

const TWITCH_PURPLE = "#772ce8";
// simple-icons Twitch glyph (24x24 viewBox).
const TWITCH_PATH =
  "M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 " +
  "4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 " +
  "3.428h-3.429l-3 3v-3H6.857V1.714h13.714z";

// Word-wrap a title into at most maxLines upper-cased lines of ~maxChars.
function wrapTitle(text, maxChars, maxLines) {
  const words = String(text || "")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else {
      lines.push(cur);
      cur = w;
      if (lines.length >= maxLines) break;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && cur !== lines[maxLines - 1]) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/, "") + "…";
  }
  return lines.length ? lines : ["ITEMS"];
}

// Evenly spread `count` Twitch-accent tiles across `total` grid cells.
function twitchCellSet(total, enabled) {
  const set = new Set();
  if (!enabled || total <= 0) return set;
  const count = Math.min(total, Math.max(2, Math.round(total * 0.2)));
  for (let k = 0; k < count; k++) {
    set.add(Math.floor(((k + 0.5) * total) / count) % total);
  }
  return set;
}

// Build the promo cover PNG. `itemImages` is a list of image refs (local
// /public paths or https URLs); tiles cycle through them, so a game with only
// a few cached drop images still fills the grid. Returns the temp file path.
// Caller may delete the file when done.
async function buildPromoCoverImage(opts) {
  opts = opts || {};
  const cols = Math.max(2, Math.min(6, parseInt(opts.cols, 10) || 5));
  const rows = Math.max(2, Math.min(6, parseInt(opts.rows, 10) || 3));
  const title = String(opts.title || "Twitch Drops Automatic Farming");
  const serviceText = String(opts.serviceText || "").trim();
  const bullets = (Array.isArray(opts.bullets) ? opts.bullets : [])
    .map((b) => String(b || "").trim())
    .filter(Boolean)
    .slice(0, 4);
  const twitchTiles = opts.twitchTiles !== false;

  const W = 1024;
  const M = 56;
  const GAP = 20;
  const cardW = Math.floor((W - 2 * M - (cols - 1) * GAP) / cols);
  const gridW = cols * cardW + (cols - 1) * GAP;
  const gridX = Math.round((W - gridW) / 2);

  const titleFs = 60;
  const titleLineH = titleFs + 12;
  const titleLines = wrapTitle(title, 22, 3);
  const titleH = titleLines.length * titleLineH;
  const serviceFs = 42;

  const topPad = 52;
  const gridTop = topPad + titleH + (serviceText ? serviceFs + 26 : 0) + 26;
  const gridH = rows * cardW + (rows - 1) * GAP;

  const bulletFs = 34;
  const bulletLineH = bulletFs + 18;
  const bulletsBlock = bullets.length ? 34 + bullets.length * bulletLineH : 0;
  const H = gridTop + gridH + bulletsBlock + 52;

  const total = cols * rows;
  const twitchSet = twitchCellSet(total, twitchTiles);

  // Load item images once; tiles cycle through the loaded buffers.
  const bufs = [];
  for (const ref of opts.itemImages || []) {
    const b = await loadImage(ref);
    if (b) bufs.push(b);
  }

  const open =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    W +
    '" height="' +
    H +
    '">';

  let svg =
    open +
    "<defs>" +
    '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">' +
    '<stop offset="0" stop-color="#a855f7"/>' +
    '<stop offset="0.5" stop-color="#8b5cf6"/>' +
    '<stop offset="1" stop-color="#6d28d9"/>' +
    "</linearGradient>" +
    "</defs>" +
    '<rect width="100%" height="100%" fill="url(#bg)"/>' +
    '<polygon points="0,0 ' +
    Math.round(W * 0.6) +
    ",0 0," +
    Math.round(H * 0.4) +
    '" fill="rgba(255,255,255,0.10)"/>';

  // Title lines.
  titleLines.forEach((ln, i) => {
    svg +=
      '<text x="' +
      W / 2 +
      '" y="' +
      (topPad + titleFs + i * titleLineH) +
      '" font-family="Arial, sans-serif" font-weight="800" font-size="' +
      titleFs +
      '" fill="#ffffff" text-anchor="middle">' +
      escXml(ln) +
      "</text>";
  });
  if (serviceText) {
    svg +=
      '<text x="' +
      W / 2 +
      '" y="' +
      (topPad + titleH + serviceFs) +
      '" font-family="Arial, sans-serif" font-weight="700" font-size="' +
      serviceFs +
      '" fill="#f3e8ff" text-anchor="middle">' +
      escXml(serviceText.toUpperCase()) +
      "</text>";
  }

  // White tile cards + Twitch glyphs (item images are composited after).
  const glyph = Math.round(cardW * 0.42);
  for (let i = 0; i < total; i++) {
    const x = gridX + (i % cols) * (cardW + GAP);
    const y = gridTop + Math.floor(i / cols) * (cardW + GAP);
    svg +=
      '<rect x="' +
      (x + 3) +
      '" y="' +
      (y + 6) +
      '" width="' +
      cardW +
      '" height="' +
      cardW +
      '" rx="26" fill="rgba(0,0,0,0.16)"/>' +
      '<rect x="' +
      x +
      '" y="' +
      y +
      '" width="' +
      cardW +
      '" height="' +
      cardW +
      '" rx="26" fill="#ffffff"/>';
    if (twitchSet.has(i)) {
      const s = glyph / 24;
      const gx = x + (cardW - glyph) / 2;
      const gy = y + (cardW - glyph) / 2;
      svg +=
        '<g transform="translate(' +
        gx +
        "," +
        gy +
        ") scale(" +
        s +
        ')"><path d="' +
        TWITCH_PATH +
        '" fill="' +
        TWITCH_PURPLE +
        '"/></g>';
    }
  }

  // Footer bullets (left-aligned, "* " prefixed).
  const bulletsTop = gridTop + gridH + 34;
  bullets.forEach((b, i) => {
    svg +=
      '<text x="' +
      gridX +
      '" y="' +
      (bulletsTop + bulletFs + i * bulletLineH) +
      '" font-family="Arial, sans-serif" font-weight="700" font-size="' +
      bulletFs +
      '" fill="#ffffff">' +
      escXml("* " + b.replace(/^\*\s*/, "")) +
      "</text>";
  });
  svg += "</svg>";

  // Composite the drop item images into the non-Twitch cells.
  const composites = [];
  const inner = Math.round(cardW * 0.68);
  let imgIdx = 0;
  for (let i = 0; i < total && bufs.length; i++) {
    if (twitchSet.has(i)) continue;
    const buf = bufs[imgIdx % bufs.length];
    imgIdx++;
    const x = gridX + (i % cols) * (cardW + GAP);
    const y = gridTop + Math.floor(i / cols) * (cardW + GAP);
    try {
      const resized = await sharp(buf)
        .resize(inner, inner, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      composites.push({
        input: resized,
        left: x + Math.round((cardW - inner) / 2),
        top: y + Math.round((cardW - inner) / 2),
      });
    } catch {
      // skip images sharp can't decode
    }
  }

  const out = path.join(
    os.tmpdir(),
    "promo-cover-" +
      Date.now() +
      "-" +
      Math.random().toString(36).slice(2) +
      ".png",
  );
  await sharp(Buffer.from(svg, "utf8")).composite(composites).png().toFile(out);
  return out;
}

module.exports = { buildSetGridImage, buildPromoCoverImage };
