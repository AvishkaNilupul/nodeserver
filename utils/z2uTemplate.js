// Read Z2U's own bulk-upload template to learn what ONE game will actually
// accept.
//
// This exists because the enums are PER GAME, which is easy to miss and
// expensive to get wrong. Measured live 2026-09-08 on four of the seller's own
// games, the "DELIVERY OPTION" column alone offers:
//
//   Rocket League   Put into my account, Order Delivery
//   Overwatch       Put into my account, Send Code, Gift Giving
//   Rainbow Six     Order Delivery, Send Code, Redeem By Seller
//   Halo Infinite   Order Delivery                      <- one option only
//
// Product type, platform and device vary the same way. An earlier attempt at
// this integration hard-coded one game's lists as if they were universal; that
// would publish a Twitch-drops account under "Face to Face Trade" (an in-game
// meet-up) on any game whose list happens to start that way, or simply have the
// row rejected. So the rule here is the same one the offer editor follows: ask
// the site what it accepts, never assume.
//
// The template is an .xlsx, which is a ZIP of XML. utils/xlsxWriter.js already
// writes that format without a dependency; this reads back just enough of it.
const zlib = require("zlib");

// --- minimal ZIP reader (central directory -> one entry) -------------------
function unzipEntry(buf, wanted) {
  // End of central directory: scan back for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("z2u template: not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    if (name === wanted) {
      // Local header: its own name/extra lengths tell us where data starts.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.slice(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error("z2u template: no entry " + wanted);
}

function decodeXml(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Cell values keyed "A1" -> text, resolving shared strings.
function sheetCells(sheetXml, strings) {
  const cells = new Map();
  for (const m of sheetXml.matchAll(/<c[^>]*r="([A-Z]+\d+)"([^>]*)>([\s\S]*?)<\/c>/g)) {
    const isShared = /t="s"/.test(m[2]);
    const v = /<v>([\s\S]*?)<\/v>/.exec(m[3]);
    if (!v) continue;
    const raw = decodeXml(v[1]);
    const val = isShared ? strings[Number(raw)] : raw;
    if (val !== undefined && val !== "") cells.set(m[1], val);
  }
  return cells;
}

// The data-validation column each field lives in, read off row 10 (the first
// data row). Same column letters the bulk file writes.
const VALIDATION_COLUMNS = {
  currencies: "B",
  expiryDays: "G",
  deliveryOptions: "H",
  productTypes: "K",
  areas: "P",
  platforms: "Q",
  devices: "R",
};

// A formula1 is either a literal list ("a,b,c") or a range reference into a
// hidden column of the same sheet (HEADER_CREATE_NEW_LISTING!AQ1:AQ86).
function resolveList(formula, cells) {
  const f = decodeXml(String(formula || "")).trim();
  if (!f) return [];
  const ref = /^[^!]*!\$?([A-Z]+)\$?(\d+):\$?[A-Z]+\$?(\d+)$/.exec(f);
  if (ref) {
    const col = ref[1];
    const from = Number(ref[2]);
    const to = Number(ref[3]);
    const out = [];
    for (let r = from; r <= to; r++) {
      const v = cells.get(col + r);
      if (v !== undefined && String(v).trim()) out.push(String(v).trim());
    }
    return out;
  }
  return f
    .replace(/^"+|"+$/g, "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// Parse a downloaded template into the set of values that game accepts.
function parseZ2uTemplate(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const sheet = unzipEntry(buf, "xl/worksheets/sheet1.xml").toString("utf8");
  let strings = [];
  try {
    const ss = unzipEntry(buf, "xl/sharedStrings.xml").toString("utf8");
    strings = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
      decodeXml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
    );
  } catch {
    // A template with no shared strings is possible; inline values still work.
  }
  const cells = sheetCells(sheet, strings);
  // Take each column's validation from the first data row (10); Z2U repeats the
  // same rule down the sheet.
  const byCol = new Map();
  for (const m of sheet.matchAll(
    /<dataValidation[^>]*sqref="([A-Z]+)(\d+)"[^>]*>([\s\S]*?)<\/dataValidation>/g,
  )) {
    if (byCol.has(m[1])) continue;
    const f = /<formula1>([\s\S]*?)<\/formula1>/.exec(m[3]);
    if (f) byCol.set(m[1], f[1]);
  }
  const out = { gameName: cells.get("A1") || "", service: cells.get("B3") || "" };
  for (const [field, col] of Object.entries(VALIDATION_COLUMNS)) {
    out[field] = byCol.has(col) ? resolveList(byCol.get(col), cells) : [];
  }
  return out;
}

// Pick the value we want if the game allows it, else the first thing it does
// allow — and say which, so a caller can refuse rather than publish something
// misleading (a Twitch account listed as a "Face to Face Trade" meet-up).
function pickOption(list, preferred) {
  const opts = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!opts.length) return { value: "", exact: false, options: opts };
  for (const want of [].concat(preferred || [])) {
    const hit = opts.find((o) => o.toLowerCase() === String(want).toLowerCase());
    if (hit) return { value: hit, exact: true, options: opts };
  }
  return { value: opts[0], exact: false, options: opts };
}

module.exports = {
  parseZ2uTemplate,
  pickOption,
  resolveList,
  unzipEntry,
  VALIDATION_COLUMNS,
};
