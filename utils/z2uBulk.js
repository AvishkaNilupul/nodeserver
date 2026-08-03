// Builds a Z2U "Batch Release Products" .xlsx so drop-set listings can be
// bulk-published on z2u.com in the same shape the site itself accepts when a
// seller downloads its template, fills it in, and re-uploads.
//
// Z2U has no public API. The Batch flow lives at:
//   GET  /downloadTemp?service={svc}&game={game}     -> a template .xlsx
//   POST /Sell/acceptExcelProducts                   -> upload filled file
// The layout of the download template was reverse-engineered live: rows 1-9
// are game/service headers and per-column hints; the importer keys off column
// POSITIONS (B..R) at data rows starting at row 10. Sheet name matters --
// the country-dropdown validation formula references HEADER_CREATE_NEW_LISTING,
// so the data sheet is named that.
//
// Column map for each offer row (r=10..N):
//   B CURRENCY (USD default)     C Price               D Description
//   E Inventory (stock)          F MIN UNIT PER ORDER  G Expiry Days (7/14/30)
//   H DELIVERY OPTION            I Online Hour         J Sort Num
//   K Product Types              L Title               M Add Image (URL)
//   N Integer-multiple (0/1)     O MAX UNIT PER ORDER  P Area (country/Global)
//   Q Platform                   R Device
const { buildXlsx } = require("./xlsxWriter");

const DELIVERY_OPTIONS = ["Put into my account", "Send Code", "Gift Giving"];
const PRODUCT_TYPES = ["Digital key", "Manual Top Up", "Send a gift"];
const EXPIRY_DAYS = [7, 14, 30];
const PLATFORMS = [
  "Battle.net",
  "Steam",
  "Xbox live",
  "PlayStation Network",
  "Nintendo",
];

// Every game we currently sell Twitch drops on, mapped to Z2U's numeric ids.
// service is the (universal) Z2U service id: 3=Items, 5=Accounts, ...
// The site pairs (service, game) in every Batch/Manage/download URL.
const GAME_MAP = {
  overwatch: { game: 18848, name: "Overwatch", platform: "Battle.net" },
  r6: { game: 8178, name: "Rainbow Six Siege", platform: "Battle.net" },
  hunt: { game: 8416, name: "Hunt: Showdown", platform: "Steam" },
  brawlhalla: { game: 8471, name: "Brawlhalla", platform: "Steam" },
};
const SERVICE_MAP = {
  items: 3,
  accounts: 5,
  topup: 2,
  boosting: 4,
  giftcards: 10,
  dlc: 15,
};

function pickEnum(list, val, dflt) {
  if (val && list.includes(val)) return val;
  return dflt;
}

// One offer row -- 18 cells (A..R). A stays empty on data rows (only header
// rows use column A). Empty cells are skipped by the underlying writer, so the
// stored file only contains cells we actually set.
function offerRow(o) {
  const row = new Array(18);
  row[0] = ""; // A
  row[1] = pickEnum(
    // B CURRENCY -- Z2U lists 51; USD covers the vast majority of Twitch drop
    // sales and matches LO's existing OW listings.
    [
      "USD", "EUR", "GBP", "AUD", "CAD", "JPY", "CNY", "RUB", "BRL", "MXN",
      "SGD", "KRW", "TRY", "PLN", "SEK", "NOK", "DKK", "CHF", "HKD", "NZD",
    ],
    o.currency,
    "USD",
  );
  row[2] = Number(o.priceUsd) || 0; // C Price
  row[3] = String(o.description || ""); // D
  row[4] = Math.max(1, parseInt(o.stock, 10) || 1); // E Inventory
  row[5] = Math.max(1, parseInt(o.minQty, 10) || 1); // F MIN
  row[6] = pickEnum(EXPIRY_DAYS, Number(o.expiryDays), 30); // G Expiry
  row[7] = pickEnum(DELIVERY_OPTIONS, o.delivery, "Gift Giving"); // H
  row[8] = Math.min(96, Math.max(1, parseInt(o.onlineHour, 10) || 24)); // I
  row[9] = 0; // J Sort Num
  row[10] = pickEnum(PRODUCT_TYPES, o.productType, "Send a gift"); // K
  row[11] = String(o.title || "").slice(0, 200); // L Title
  row[12] = String(o.imageUrl || ""); // M image URL(s)
  row[13] = 0; // N Integer-multiple required (0 = no)
  row[14] = Math.max(1, parseInt(o.maxQty, 10) || 1); // O MAX
  row[15] = String(o.area || "Global"); // P Area
  row[16] = pickEnum(PLATFORMS, o.platform, "Battle.net"); // Q Platform
  row[17] = String(o.device || ""); // R Device (freeform)
  return row;
}

// Rows 1-9 recreate the game/service header block from the downloaded
// template. The importer historically only reads the data rows (10+), but a
// couple of importers we've seen also validate that the "Service" and game
// name are on the expected header cells, so we play safe and reproduce them.
function headerBlock({ gameName, serviceLabel }) {
  const rows = [];
  rows[0] = [gameName]; // row 1: A1=game
  rows[1] = ["Inventory"]; // row 2: A2 section label
  rows[2] = ["Service", serviceLabel]; // row 3: A3="Service", B3=service label
  rows[3] = []; // rows 4-6 blank spacer
  rows[4] = [];
  rows[5] = [];
  rows[6] = ["", "Unit Price"]; // row 7: B7 hint
  rows[7] = [
    "",
    "CURRENCY",
    "Price",
    "Description",
    "Inventory",
    "MIN UNIT PER ORDER",
    "Expiry date(Days)",
    "DELIVERY OPTION",
    "Online(Hour)",
    "Set Sort Num",
    "Product Types",
    "Title",
    "Add Image",
    "Integer multiple required(1 / 0)",
    "MAX UNIT PER ORDER",
    "Area",
    "Platform",
    "Device",
  ]; // row 8: column headers
  rows[8] = []; // row 9: hint row (left blank; importer ignores it)
  return rows;
}

// Build the workbook. Returns a Buffer.
//   game    - key from GAME_MAP, or { game, name, platform }
//   service - key from SERVICE_MAP, or numeric id
//   offers  - [{ title, description, priceUsd, stock, delivery, productType,
//               expiryDays, imageUrl, currency, minQty, maxQty, area,
//               platform, device, onlineHour }]
function buildZ2uBulkFile({ game, service, offers }) {
  const g = typeof game === "string" ? GAME_MAP[game.toLowerCase()] : game;
  if (!g || !g.game || !g.name) {
    throw new Error(
      "buildZ2uBulkFile: unknown game (want an entry in GAME_MAP or " +
        "{ game, name, platform })",
    );
  }
  const svcId =
    typeof service === "number"
      ? service
      : SERVICE_MAP[String(service || "").toLowerCase()] || SERVICE_MAP.items;
  const serviceLabel =
    Object.entries(SERVICE_MAP).find(([, v]) => v === svcId)?.[0] || "items";
  const serviceProper =
    serviceLabel[0].toUpperCase() + serviceLabel.slice(1).toLowerCase();

  const rows = headerBlock({ gameName: g.name, serviceLabel: serviceProper });
  // Data rows start at row 10 (0-indexed 9). buildXlsx skips undefined rows,
  // so an explicit empty row 9 keeps the alignment.
  const dataRows = (offers || []).map((o) =>
    offerRow({ platform: g.platform, ...o }),
  );
  return buildXlsx([
    // Sheet name matches the reference in Z2U's country-dropdown formula:
    // 'HEADER_CREATE_NEW_LISTING!AP1:AP86'. Keeping the same name protects us
    // from any importer that also cross-checks the sheet reference.
    { name: "HEADER_CREATE_NEW_LISTING", rows: rows.concat(dataRows) },
  ]);
}

module.exports = {
  buildZ2uBulkFile,
  offerRow,
  GAME_MAP,
  SERVICE_MAP,
  DELIVERY_OPTIONS,
  PRODUCT_TYPES,
  EXPIRY_DAYS,
  PLATFORMS,
};
