// Minimal, dependency-free .xlsx writer.
//
// The project has no spreadsheet library and adding one just to emit a bulk
// upload file is overkill, so this builds a valid OOXML workbook by hand: a
// ZIP (stored/no-compression, so we only need CRC32 from Node's zlib) holding
// the handful of XML parts Excel and marketplace importers require.
//
// Usage:
//   buildXlsx([{ name: "Sheet1", rows: [[ "a", 1 ], [ "b", 2 ]] }]) -> Buffer
// Each cell is a string (written as an inline string) or a number. null/""
// cells are skipped so the file stays small.
const zlib = require("zlib");

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 0 -> "A", 25 -> "Z", 26 -> "AA" ...
function colName(index) {
  let n = index;
  let name = "";
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

function isNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function sheetXml(rows) {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    "<sheetData>",
  ];
  rows.forEach((row, r) => {
    const rn = r + 1;
    const cells = [];
    (row || []).forEach((val, c) => {
      if (val === null || val === undefined || val === "") return;
      const ref = colName(c) + rn;
      if (isNumber(val)) {
        cells.push('<c r="' + ref + '"><v>' + val + "</v></c>");
      } else {
        cells.push(
          '<c r="' +
            ref +
            '" t="inlineStr"><is><t xml:space="preserve">' +
            xmlEscape(val) +
            "</t></is></c>",
        );
      }
    });
    parts.push('<row r="' + rn + '">' + cells.join("") + "</row>");
  });
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

function workbookXml(sheets) {
  const tags = sheets
    .map(
      (s, i) =>
        '<sheet name="' +
        xmlEscape(s.name) +
        '" sheetId="' +
        (i + 1) +
        '" r:id="rId' +
        (i + 1) +
        '"/>',
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
    ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    "<sheets>" +
    tags +
    "</sheets></workbook>"
  );
}

function workbookRels(sheets) {
  const rels = sheets
    .map(
      (s, i) =>
        '<Relationship Id="rId' +
        (i + 1) +
        '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"' +
        ' Target="worksheets/sheet' +
        (i + 1) +
        '.xml"/>',
    )
    .join("");
  const stylesId = sheets.length + 1;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels +
    '<Relationship Id="rId' +
    stylesId +
    '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>"
  );
}

function contentTypes(sheets) {
  const overrides = sheets
    .map(
      (s, i) =>
        '<Override PartName="/xl/worksheets/sheet' +
        (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>',
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    overrides +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    "</Types>"
  );
}

const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
  "</Relationships>";

const STYLES_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

// ------------------------------------------------------------------
// ZIP container (stored entries; CRC32 via zlib.crc32 or a local table).
// ------------------------------------------------------------------
let crcTable = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf) >>> 0;
  if (!crcTable) {
    crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const data = Buffer.from(e.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// sheets: [{ name, rows }] where rows is an array of arrays of string|number.
function buildXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) {
    throw new Error("buildXlsx needs at least one sheet");
  }
  const entries = [
    { name: "[Content_Types].xml", data: contentTypes(sheets) },
    { name: "_rels/.rels", data: ROOT_RELS },
    { name: "xl/workbook.xml", data: workbookXml(sheets) },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels(sheets) },
    { name: "xl/styles.xml", data: STYLES_XML },
  ];
  sheets.forEach((s, i) => {
    entries.push({
      name: "xl/worksheets/sheet" + (i + 1) + ".xml",
      data: sheetXml(s.rows || []),
    });
  });
  return zip(entries);
}

module.exports = { buildXlsx, colName };
