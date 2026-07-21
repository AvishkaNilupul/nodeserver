// Builds a G2G "Bulk Upload for Items" .xlsx from data the site already has,
// so item-category offers G2G's Open API refuses to create (non-instant
// delivery) can still be pushed in bulk by uploading this file on g2g.com.
//
// The trick that makes this work without the seller downloading a blank
// template per game: G2G's importer keys off the Product ID in cell B1 of the
// Offers sheet, and that ID is the same product_id the site's G2G connector
// already fetches (service -> brand -> product). The Offers-sheet columns are
// identical across every game; only the Product ID/Name and the Offer
// Attributes reference sheet are game-specific, and those come from the API.
const { buildXlsx } = require("./xlsxWriter");

// The 19 Offers-tab columns, in the exact order G2G's current template uses
// them. Column A is "Offer ID": blank creates a new offer, a real G2G offer id
// updates that offer. G2G's importer rejects the file ("download the latest
// excel format") unless this column is present and the layout matches.
const OFFER_HEADERS = [
  "Offer ID",
  "Offer Attributes",
  "Title",
  "Description",
  "Stock",
  "Low Stock Alert Qty",
  "Min. Purchase Qty",
  "Currency",
  "Unit Price",
  "Delivery Methods",
  "Delivery Speed Details Quantity",
  "Delivery Speed Details Time",
  "Wholesale Quantity",
  "Wholesale Price",
  "Offer Images",
  "Offer Images Title",
  "Sales Country Settings",
  "Sales Country",
  "Offer Status",
];

const UNIQUE_HEADER =
  "Unique (yes: seller can only create 1 offer for this attribute)";
const IMAGE_NOTE =
  "Optional. If the image URL format is incorrect, offers will still be " +
  "created/updated, but the system will delete the images automatically. " +
  "Learn about image format: " +
  "https://support.g2g.com/support/solutions/articles/5000839369";

// Pull attribute groups + delivery methods out of G2G's /attributes response,
// which the caller passes through untouched. Shapes vary a little between
// endpoints, so every field is looked up defensively.
function parseAttributes(apiResp) {
  const payload =
    (apiResp && (apiResp.payload || apiResp.data)) || apiResp || {};
  let rawGroups = payload.attribute_groups;
  if (!Array.isArray(rawGroups)) {
    // Fall back to the first array of objects that looks like groups.
    rawGroups = Object.keys(payload)
      .map((k) => payload[k])
      .find((v) => Array.isArray(v) && v.length && typeof v[0] === "object");
  }
  const groups = (Array.isArray(rawGroups) ? rawGroups : [])
    .map((g) => {
      const name =
        g.attribute_group_name || g.group_name || g.name || "Attribute";
      const required = !!(g.is_required || g.required);
      const values = (g.attributes || g.attribute_list || g.children || [])
        .map((a) => ({
          id: String(a.attribute_id || a.id || ""),
          name: String(a.attribute_name || a.name || a.value || ""),
        }))
        .filter((a) => a.name);
      return { name, required, values };
    })
    .filter((g) => g.values.length);

  const deliveryMethods = (payload.delivery_method_list || [])
    .map(
      (m) =>
        m.delivery_method_name ||
        m.name ||
        m.title ||
        (m.delivery_method && m.delivery_method.name) ||
        "",
    )
    .filter(Boolean);

  return { groups, deliveryMethods };
}

// The "Offer Attributes" reference sheet. G2G lists one row per valid
// combination with the joined value in the last data column; we reproduce that
// (capped, since it is reference-only) so the file matches a real template.
function attributeSheetRows(groups) {
  if (!groups.length) {
    return [["Column 1", "Offer Attributes Value", UNIQUE_HEADER]];
  }
  const header = [];
  groups.forEach((_, i) => header.push("Column " + (i + 1)));
  header.push("Offer Attributes Value", UNIQUE_HEADER);

  const rows = [header];
  const CAP = 2000;
  // Cartesian product of every group's values.
  let combos = [[]];
  for (const g of groups) {
    const next = [];
    for (const combo of combos) {
      for (const v of g.values) {
        next.push(combo.concat(v.name));
        if (next.length >= CAP) break;
      }
      if (next.length >= CAP) break;
    }
    combos = next;
    if (combos.length >= CAP) break;
  }
  for (const combo of combos) {
    const value = combo.join(" > ");
    rows.push([...combo, value, "no"]);
  }
  return rows;
}

// Build the whole workbook. Returns a Buffer.
//
//  productId    - G2G product_id (goes in B1; also the download filename)
//  productName  - human product path, e.g. "Items > Rust" (B2)
//  attributesApi- raw response from g2gAttributes(productId), or null
//  offers       - [{ attributeValue, title, description, stock, unitPrice,
//                    images, imagesTitle }]
//  defaults     - offer-wide defaults (currency, deliveryMethods, ...)
function buildG2gBulkFile({
  productId,
  productName,
  attributesApi,
  offers,
  defaults,
}) {
  const d = defaults || {};
  const currency = d.currency || "USD";
  const lowStock = num(d.lowStock, 1);
  const minQty = num(d.minQty, 1);
  const deliveryMethods = d.deliveryMethods || "";
  const deliverySpeedQty = d.deliverySpeedQty || "";
  const deliverySpeedTime = d.deliverySpeedTime || "";
  const salesCountrySettings = d.salesCountrySettings || "Global";
  const salesCountry = d.salesCountry || "";
  const status = d.status || "live";

  const { groups } = parseAttributes(attributesApi);

  // ---- Offers sheet ----
  const offersRows = [
    ["Product ID", String(productId || ""), "(Do not modify)"],
    ["Product Name", String(productName || ""), "(Do not modify)"],
    [],
  ];
  // Row 4: the optional/conditional hint row (columns match the real template;
  // all shifted one column right by the leading "Offer ID" column).
  const hint = [];
  hint[0] = "Do not modify"; // A: Offer ID
  hint[1] = "Please refer to Offer Attributes"; // B: Offer Attributes
  hint[12] = "Optional"; // M: Wholesale Quantity
  hint[13] = "Optional"; // N: Wholesale Price
  hint[14] = IMAGE_NOTE; // O: Offer Images
  hint[15] = "Optional"; // P: Offer Images Title
  hint[17] = "Conditional"; // R: Sales Country
  offersRows.push(hint);
  offersRows.push(OFFER_HEADERS.slice());

  for (const o of offers || []) {
    offersRows.push([
      o.offerId || "", // A: Offer ID — blank creates a new offer
      o.attributeValue || "",
      o.title || "",
      o.description || "",
      num(o.stock, 1),
      lowStock,
      minQty,
      currency,
      round2(o.unitPrice),
      deliveryMethods,
      deliverySpeedQty,
      deliverySpeedTime,
      "", // Wholesale Quantity
      "", // Wholesale Price
      o.images || "",
      o.imagesTitle || "",
      salesCountrySettings,
      salesCountry,
      status,
    ]);
  }

  return buildXlsx([
    { name: "Offer Attributes", rows: attributeSheetRows(groups) },
    { name: "Offers", rows: offersRows },
  ]);
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : dflt;
}
function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

module.exports = { buildG2gBulkFile, parseAttributes, OFFER_HEADERS };
