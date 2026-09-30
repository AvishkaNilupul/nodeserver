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

// Marketplace covers have upload size limits (Gameflip mangles anything much
// over 2 MB, and a 6x6 PNG grid easily exceeds that), so every cover we
// generate is written under this budget: keep the lossless PNG when it fits,
// otherwise re-encode as JPEG, dropping quality and then resolution until it
// does.
const MAX_COVER_BYTES = 1024 * 1024;
const JPEG_QUALITIES = [88, 80, 72, 64, 55];
const JPEG_WIDTHS = [null, 1600, 1200, 900];

async function writeCoverFile(png, prefix) {
  const stamp = Date.now() + "-" + Math.random().toString(36).slice(2);
  if (png.length <= MAX_COVER_BYTES) {
    const out = path.join(os.tmpdir(), prefix + stamp + ".png");
    await fsp.writeFile(out, png);
    return out;
  }
  let best = null;
  for (const width of JPEG_WIDTHS) {
    for (const quality of JPEG_QUALITIES) {
      let img = sharp(png).flatten({ background: "#ffffff" });
      if (width) img = img.resize({ width, withoutEnlargement: true });
      const buf = await img.jpeg({ quality, mozjpeg: true }).toBuffer();
      if (!best || buf.length < best.length) best = buf;
      if (buf.length <= MAX_COVER_BYTES) {
        const out = path.join(os.tmpdir(), prefix + stamp + ".jpg");
        await fsp.writeFile(out, buf);
        return out;
      }
    }
  }
  const out = path.join(os.tmpdir(), prefix + stamp + ".jpg");
  await fsp.writeFile(out, best);
  return out;
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
      qty: Math.max(1, Number(it.qty) || 1),
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
    // Multi-copy reward (same item at several watch-time tiers): a "×N"
    // badge at the tile's top-right so the cover shows the real copy count.
    if (cells[i].qty > 1) {
      badgeSvgStr +=
        '<rect x="' +
        (x + TILE - 58) +
        '" y="' +
        (y + 12) +
        '" width="58" height="32" rx="16" fill="#16a34a"/>' +
        '<text x="' +
        (x + TILE - 29) +
        '" y="' +
        (y + 35) +
        '" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#ffffff" text-anchor="middle">×' +
        cells[i].qty +
        "</text>";
    }
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

  const png = await sharp(Buffer.from(baseSvg, "utf8"))
    .composite(
      composites.concat([
        { input: Buffer.from(badgeSvgStr, "utf8"), left: 0, top: 0 },
      ]),
    )
    .png()
    .toBuffer();
  return writeCoverFile(png, "set-grid-");
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

  const png = await sharp(Buffer.from(svg, "utf8"))
    .composite(composites)
    .png()
    .toBuffer();
  return writeCoverFile(png, "promo-cover-");
}

// ------------------------------------------------------------------
// Bulk-pack covers (docs/bulk-packs/PACKS-2.md §5). The two covers above,
// built by the builders above UNCHANGED, plus a bold yellow band reading
// "PACK OF N ACCOUNTS" — with a red "−D%" tag when the pack is discounted and,
// on the farm cover, the farming term. Band text is sized from the cover's
// width, so it still reads when a marketplace shrinks the cover to a
// thumbnail. Each returns a temp file path like the builders (the caller may
// delete it), or "" when no pack cover could be built. They never throw, so a
// caller can always fall back to the plain cover.
// ------------------------------------------------------------------

const PACK_FONT = "Arial, sans-serif"; // the face every cover above uses
const PACK_WEIGHT = 800; // the promo title's weight
const PACK_INK = "#1e1b4b";
const PACK_TAG_FILL = "#dc2626";
const PACK_SHADOW = 10; // soft shadow under the band, px
// Grids narrower than this are scaled up first, so the band's text is set
// at a size that stays crisp (a 1-item grid is only 300px wide).
const PACK_MIN_WIDTH = 900;
// Band layout, per px of a line's font size: caps are ~0.72em tall in Arial
// and in the wider faces fontconfig substitutes for it.
const PACK_CAP = 0.72;
const PACK_GAP = 0.4; // between a line's text and its tag pill
const PACK_TAG_SCALE = 0.84; // tag text size relative to its line
const PACK_PILL_PAD = 0.45; // pill side padding, per px of tag size
const PACK_PILL_H = 1.45; // pill height, per px of tag size

// The farm cover's footer lines (utils/bulkPacks/markets.js FARM_BULLETS,
// scripts/eldorado-farm-listings.js BULLETS).
const PACK_FARM_BULLETS = [
  "Fully Automated Farming",
  "Account-Safe and Undetectable",
  "Reliable Daily Rewards",
];
// buildPromoCoverImage's own layout (topPad, titleFs + 12, the gap above the
// grid): with no serviceText its tile grid starts at
// PROMO_TOP_PAD + titleLines * PROMO_TITLE_LINE_H + PROMO_GRID_GAP. The farm
// band goes into the middle of that gap; bandFitsAt() re-checks the pixels,
// so a layout change there moves the band to the top instead of into text.
const PROMO_TOP_PAD = 52;
const PROMO_TITLE_LINE_H = 72;
const PROMO_GRID_GAP = 26;

// {packSize, discountPct} -> {main, tag}, or null when there is no pack to
// show: N must be a whole number >= 2 (a "pack" of one is a plain listing).
// The tag is "−D%" (D to one decimal) only when D rounds above 0.
function packLabel(opts) {
  const o = opts && typeof opts === "object" ? opts : {};
  const size = Math.floor(Number(o.packSize));
  if (!Number.isSafeInteger(size) || size < 2) return null;
  const pct = Math.round(Math.min(99, Number(o.discountPct)) * 10) / 10;
  return {
    main: "PACK OF " + size + " ACCOUNTS",
    tag: Number.isFinite(pct) && pct > 0 ? "−" + pct + "%" : "",
  };
}

// The farming term the way the farm titles spell it (utils/bulkPacks/copy.js
// farmTerm: "1 Year" for 365, else "N Days"); "" without a usable term.
function farmTermLine(days) {
  const n = Math.round(Number(days));
  if (!Number.isFinite(n) || n < 1) return "";
  return (n === 365 ? "1 YEAR" : n === 1 ? "1 DAY" : n + " DAYS") + " FARMING";
}

// Ink width of one line of band text per px of font size, measured by
// rendering it exactly as the band does (librsvg via sharp, same face and
// weight) and trimming the blank margins. The fit then holds whatever face
// fontconfig substitutes for Arial on the host (a bare Linux box falls back to
// far wider ones). A deliberately wide estimate stands in if it can't measure.
async function bandTextWidth(text) {
  const fs = 100;
  const w = fs * (text.length + 2);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    w +
    '" height="' +
    fs * 2 +
    '"><rect width="100%" height="100%" fill="#ffffff"/>' +
    '<text x="' +
    fs +
    '" y="' +
    fs * 1.3 +
    '" font-family="' +
    PACK_FONT +
    '" font-weight="' +
    PACK_WEIGHT +
    '" font-size="' +
    fs +
    '" fill="#000000">' +
    escXml(text) +
    "</text></svg>";
  try {
    const { info } = await sharp(Buffer.from(svg, "utf8"))
      .trim()
      .toBuffer({ resolveWithObject: true });
    if (info.width > 10 && info.width < w - 10) return info.width / fs;
  } catch {
    // nothing rendered (no usable font?) — estimate below
  }
  return text.length * 0.75;
}

// Band height for a cover `width` px wide: one line of text, or two when
// there is a tag or a term under the headline.
function packBandHeight(width, label, term) {
  return Math.round(width * (label.tag || term ? 0.22 : 0.15));
}

// The band as a transparent SVG overlay, `width` x (bandH + PACK_SHADOW): the
// headline on the first line; the term and/or the tag pill centred on a
// second line. Every line is fitted to the band's width and height.
async function packBandSvg(width, bandH, label, term) {
  const W = Math.round(width);
  const avail = W - 2 * Math.round(W * 0.05);
  const kMain = await bandTextWidth(label.main);
  const kTerm = term ? await bandTextWidth(term) : 0;
  const kTag = label.tag ? await bandTextWidth(label.tag) : 0;
  // Pill width per px of its LINE's font size.
  const kPill = kTag ? PACK_TAG_SCALE * (kTag + 2 * PACK_PILL_PAD) : 0;

  const lines = [];
  if (!term && !label.tag) {
    lines.push({
      fs: Math.floor(Math.min(bandH * 0.5, avail / kMain)),
      text: label.main,
      k: kMain,
    });
  } else {
    const fs1 = Math.floor(Math.min(bandH * 0.37, avail / kMain));
    const k2 = (term ? kTerm : 0) + (term && kTag ? PACK_GAP : 0) + kPill;
    lines.push({ fs: fs1, text: label.main, k: kMain });
    lines.push({
      // A tag alone on its line may be larger than one sharing it.
      fs: Math.floor(Math.min(fs1 * (term ? 0.62 : 0.74), avail / k2)),
      text: term,
      k: kTerm,
      tag: label.tag,
    });
  }
  // A line's height: its caps, or its pill when that is taller.
  const lineH = (ln) =>
    Math.max(
      ln.text ? PACK_CAP * ln.fs : 0,
      ln.tag ? PACK_PILL_H * PACK_TAG_SCALE * ln.fs : 0,
    );
  const between = lines.length > 1 ? Math.round(lines[0].fs * 0.34) : 0;
  const stackH = lines.reduce((s, ln) => s + lineH(ln), 0) + between;
  let top = (bandH - stackH) / 2;

  let svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    W +
    '" height="' +
    (bandH + PACK_SHADOW) +
    '"><defs>' +
    '<linearGradient id="packBand" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#fde047"/>' +
    '<stop offset="1" stop-color="#facc15"/>' +
    "</linearGradient>" +
    '<linearGradient id="packShade" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#000000" stop-opacity="0.3"/>' +
    '<stop offset="1" stop-color="#000000" stop-opacity="0"/>' +
    "</linearGradient>" +
    "</defs>" +
    '<rect y="' +
    bandH +
    '" width="' +
    W +
    '" height="' +
    PACK_SHADOW +
    '" fill="url(#packShade)"/>' +
    '<rect width="' +
    W +
    '" height="' +
    bandH +
    '" fill="url(#packBand)"/>' +
    '<rect y="' +
    (bandH - 4) +
    '" width="' +
    W +
    '" height="4" fill="#ca8a04"/>';
  for (const ln of lines) {
    const h = lineH(ln);
    const cy = top + h / 2; // vertical centre of this line
    top += h + between;
    const tfs = PACK_TAG_SCALE * ln.fs;
    const pillW = ln.tag ? kPill * ln.fs : 0;
    const textW = ln.text ? ln.k * ln.fs : 0;
    const gap = ln.text && ln.tag ? PACK_GAP * ln.fs : 0;
    let x = (W - (textW + gap + pillW)) / 2;
    if (ln.text) {
      svg +=
        '<text x="' +
        (x + textW / 2).toFixed(1) +
        '" y="' +
        (cy + (PACK_CAP / 2) * ln.fs).toFixed(1) +
        '" font-family="' +
        PACK_FONT +
        '" font-weight="' +
        PACK_WEIGHT +
        '" font-size="' +
        ln.fs +
        '" fill="' +
        PACK_INK +
        '" text-anchor="middle">' +
        escXml(ln.text) +
        "</text>";
      x += textW + gap;
    }
    if (ln.tag) {
      const pillH = PACK_PILL_H * tfs;
      svg +=
        '<rect x="' +
        x.toFixed(1) +
        '" y="' +
        (cy - pillH / 2).toFixed(1) +
        '" width="' +
        pillW.toFixed(1) +
        '" height="' +
        pillH.toFixed(1) +
        '" rx="' +
        (pillH / 2).toFixed(1) +
        '" fill="' +
        PACK_TAG_FILL +
        '" stroke="#ffffff" stroke-width="' +
        Math.max(3, Math.round(pillH * 0.07)) +
        '"/>' +
        '<text x="' +
        (x + pillW / 2).toFixed(1) +
        '" y="' +
        (cy + (PACK_CAP / 2) * tfs).toFixed(1) +
        '" font-family="' +
        PACK_FONT +
        '" font-weight="' +
        PACK_WEIGHT +
        '" font-size="' +
        tfs.toFixed(1) +
        '" fill="#ffffff" text-anchor="middle">' +
        escXml(ln.tag) +
        "</text>";
    }
  }
  return svg + "</svg>";
}

// True when rows [y - 2, y + PACK_SHADOW] of the image are plain background
// (no near-white title text or tile), i.e. a band inserted at y cuts nothing.
async function bandFitsAt(png, width, height, y) {
  const top = y - 2;
  const rows = PACK_SHADOW + 3;
  if (top < 0 || top + rows > height) return false;
  const { data, info } = await sharp(png)
    .extract({ left: 0, top, width, height: rows })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += info.channels) {
    if (Math.min(data[i], data[i + 1], data[i + 2]) > 225) return false;
  }
  return true;
}

// The game's most common cached drop images — the query the farm covers
// already use (utils/bulkPacks/markets.js gameDropImages). Only over a live
// Mongo connection: building a cover never waits for (or opens) one.
async function farmDropImages(game) {
  try {
    const mongoose = require("mongoose");
    if (!mongoose.connection || mongoose.connection.readyState !== 1) return [];
    const DropLog = require("../models/DropLog");
    const re = new RegExp(
      "^" + String(game).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      "i",
    );
    const rows = await DropLog.aggregate(
      [
        { $match: { game: re, imageLocal: { $ne: "" } } },
        { $group: { _id: "$imageLocal", accounts: { $sum: 1 } } },
        { $sort: { accounts: -1 } },
        { $limit: 30 },
      ],
      { maxTimeMS: 20000 },
    );
    return (rows || []).map((r) => r && r._id).filter(Boolean);
  } catch {
    return [];
  }
}

// A W x H canvas painted with buildSetGridImage's own background (diagonal
// purple gradient, light streak top-left, shade bottom-right) laid out for a
// gw x gh grid at (gx, gy) and carried on past the grid's sides, so the side
// margins of a widened cover meet the grid without a seam. It mirrors that
// builder's background: if that changes, the only effect is a visible seam.
function gridBackdropSvg(W, H, gx, gy, gw, gh) {
  const box = (w, h) => "matrix(" + w + " 0 0 " + h + " " + gx + " " + gy + ")";
  // Light streak: grid triangle (0,0) (sw,0) (0,sh), its hypotenuse run on to
  // the canvas's left edge.
  const sw = Math.round(gw * 0.55);
  const sh = Math.round(gh * 0.55);
  const lightY = gy + sh + (gx * sh) / sw;
  // Shade: grid triangle (gw,gh) (a,gh) (gw,b), run on to the right edge.
  const a = Math.round(gw * 0.45);
  const b = Math.round(gh * 0.45);
  const right = W - gx - gw;
  const shadeY = gy + b - (right * (gh - b)) / (gw - a);
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="' +
    W +
    '" height="' +
    H +
    '"><defs>' +
    '<linearGradient id="bg" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="1" gradientTransform="' +
    box(gw, gh) +
    '">' +
    '<stop offset="0" stop-color="#a855f7"/>' +
    '<stop offset="0.5" stop-color="#8b5cf6"/>' +
    '<stop offset="1" stop-color="#6d28d9"/>' +
    "</linearGradient>" +
    '<linearGradient id="streak" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1" y2="1" gradientTransform="' +
    box(sw, sh) +
    '">' +
    '<stop offset="0" stop-color="rgba(255,255,255,0.16)"/>' +
    '<stop offset="1" stop-color="rgba(255,255,255,0)"/>' +
    "</linearGradient>" +
    "</defs>" +
    '<rect width="100%" height="100%" fill="url(#bg)"/>' +
    '<polygon points="0,' +
    gy +
    " " +
    (gx + sw) +
    "," +
    gy +
    " 0," +
    lightY.toFixed(1) +
    '" fill="url(#streak)"/>' +
    '<polygon points="' +
    W +
    "," +
    H +
    " " +
    (gx + a) +
    "," +
    H +
    " " +
    W +
    "," +
    shadeY.toFixed(1) +
    '" fill="rgba(0,0,0,0.10)"/>' +
    "</svg>"
  );
}

// The set's grid cover (buildSetGridImage) under a pack band: the grid is
// kept whole, the band goes on top. A cover never ends up taller than wide
// (square grids get side margins), so a square thumbnail crop keeps the band.
async function buildBulkCoverImage(set, opts) {
  let gridFile = "";
  try {
    const label = packLabel(opts);
    if (!label || !set || typeof set !== "object") return "";
    gridFile = await buildSetGridImage(set);
    if (!gridFile) return "";
    let grid = await sharp(gridFile).png().toBuffer();
    const meta = await sharp(grid).metadata();
    let gw = meta.width;
    let gh = meta.height;
    if (gw < PACK_MIN_WIDTH) {
      gh = Math.round((gh * PACK_MIN_WIDTH) / gw);
      gw = PACK_MIN_WIDTH;
      grid = await sharp(grid).resize(gw, gh).png().toBuffer();
    }
    const bandH = packBandHeight(gw, label, "");
    const W = Math.max(gw, gh + bandH);
    const H = gh + bandH;
    const gx = Math.round((W - gw) / 2);
    const bg = gridBackdropSvg(W, H, gx, bandH, gw, gh);
    const band = await packBandSvg(W, bandH, label, "");
    const png = await sharp(Buffer.from(bg, "utf8"))
      .composite([
        { input: grid, left: gx, top: bandH },
        { input: Buffer.from(band, "utf8"), left: 0, top: 0 },
      ])
      .png()
      .toBuffer();
    return await writeCoverFile(png, "bulk-set-");
  } catch (e) {
    console.error("setImage: bulk set cover failed:", (e && e.message) || e);
    return "";
  } finally {
    if (gridFile) await fsp.unlink(gridFile).catch(() => {});
  }
}

// The farm promo cover (buildPromoCoverImage, as the farm listings build it
// but with two tile rows and the term in the band instead of a subtitle) with
// the pack band between its title and its tiles. opts.itemImages overrides
// the game's cached drop images (looked up from DropLog when omitted).
async function buildBulkFarmCoverImage(game, days, opts) {
  let promoFile = "";
  try {
    const g = String(game == null ? "" : game).trim();
    const label = packLabel(opts);
    if (!g || !label) return "";
    const term = farmTermLine(days);
    const title = g + " Twitch Drops Automatic Farming";
    const itemImages = Array.isArray(opts.itemImages)
      ? opts.itemImages
      : await farmDropImages(g);
    promoFile = await buildPromoCoverImage({
      title,
      serviceText: "",
      bullets: PACK_FARM_BULLETS.slice(),
      itemImages,
      twitchTiles: true,
      rows: 2,
    });
    if (!promoFile) return "";
    const promo = await sharp(promoFile).png().toBuffer();
    const meta = await sharp(promo).metadata();
    const W = meta.width;
    const H0 = meta.height;
    const bandH = packBandHeight(W, label, term);
    let splitY =
      PROMO_TOP_PAD +
      wrapTitle(title, 22, 3).length * PROMO_TITLE_LINE_H +
      Math.round(PROMO_GRID_GAP / 2);
    if (!(await bandFitsAt(promo, W, H0, splitY))) splitY = 0;
    const parts = [];
    if (splitY > 0) {
      parts.push({
        input: await sharp(promo)
          .extract({ left: 0, top: 0, width: W, height: splitY })
          .png()
          .toBuffer(),
        left: 0,
        top: 0,
      });
    }
    parts.push({
      input: await sharp(promo)
        .extract({ left: 0, top: splitY, width: W, height: H0 - splitY })
        .png()
        .toBuffer(),
      left: 0,
      top: splitY + bandH,
    });
    parts.push({
      input: Buffer.from(await packBandSvg(W, bandH, label, term), "utf8"),
      left: 0,
      top: splitY,
    });
    const png = await sharp({
      create: {
        width: W,
        height: H0 + bandH,
        channels: 4,
        background: "#8b5cf6",
      },
    })
      .composite(parts)
      .png()
      .toBuffer();
    return await writeCoverFile(png, "bulk-farm-");
  } catch (e) {
    console.error("setImage: bulk farm cover failed:", (e && e.message) || e);
    return "";
  } finally {
    if (promoFile) await fsp.unlink(promoFile).catch(() => {});
  }
}

module.exports = {
  buildSetGridImage,
  buildPromoCoverImage,
  buildBulkCoverImage,
  buildBulkFarmCoverImage,
};
