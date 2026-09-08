// Build a Z2U "batch release products" .xlsx from the game's OWN template.
//
// Z2U has no create API worth the name, but it does accept a filled copy of the
// spreadsheet it hands out per game:
//   GET  /downloadTemp?service={svc}&game={game}   -> the template
//   POST /platform/Sell/acceptExcelProducts        -> upload the filled file
//
// Everything here is driven by that downloaded template rather than by
// hard-coded knowledge, because BOTH the accepted values and the column
// positions differ per game. Verified live 2026-09-08:
//
//   * Halo Infinite accepts exactly one delivery option ("Order Delivery") and
//     one product type; Overwatch offers neither of them ("Put into my account,
//     Send Code, Gift Giving").
//   * Rocket League and Halo insert an extra "Items Type" column at L, shifting
//     Title, Add Image, MAX, Area and Platform one column right of where they
//     sit for Overwatch.
//
// A builder with fixed columns therefore writes the title into "Items Type" and
// the image URL into Title — silently, producing garbage listings. An earlier
// draft of this file did exactly that. So: locate every column by its header
// text, and refuse rather than guess when a value the game does not accept is
// asked for.
const { buildXlsx } = require("./xlsxWriter");
const { parseZ2uTemplate, templateRows, colIndex, pickOption } = require("./z2uTemplate");

// The two fields that change what the buyer actually receives. If the game does
// not offer what we asked for, publishing "the nearest thing" would misdescribe
// the product — an account bundle listed as an in-game meet-up, say — so these
// throw instead of falling back.
const MUST_MATCH_EXACTLY = ["delivery", "productType"];

function buildOfferRow(offer, template) {
  const cols = template.columns || {};
  const row = [];
  const put = (field, value) => {
    const letter = cols[field];
    if (!letter || value === undefined || value === "") return;
    row[colIndex(letter)] = value;
  };

  const chosen = {
    delivery: pickOption(template.deliveryOptions, offer.delivery),
    productType: pickOption(template.productTypes, offer.productType),
    area: pickOption(template.areas, offer.area || "Global"),
    platform: pickOption(template.platforms, offer.platform || "Global"),
    device: pickOption(template.devices, offer.device),
    currency: pickOption(template.currencies, offer.currency || "USD"),
    expiryDays: pickOption(
      (template.expiryDays || []).map(String),
      String(offer.expiryDays || 30),
    ),
  };
  for (const field of MUST_MATCH_EXACTLY) {
    const c = chosen[field];
    if (c.options.length && !c.exact) {
      throw new Error(
        "Z2U bulk: " + template.gameName + " does not offer " +
          JSON.stringify(offer[field]) + " for " + field +
          " — it accepts: " + c.options.join(", "),
      );
    }
  }

  put("currency", chosen.currency.value || "USD");
  put("price", Number(offer.priceUsd) || 0);
  put("description", String(offer.description || ""));
  put("stock", Math.max(1, parseInt(offer.stock, 10) || 1));
  put("minQty", Math.max(1, parseInt(offer.minQty, 10) || 1));
  put("expiryDays", Number(chosen.expiryDays.value) || 30);
  put("delivery", chosen.delivery.value);
  // Z2U accepts 1-96 hours; how long before the offer goes visible.
  put("onlineHour", Math.min(96, Math.max(1, parseInt(offer.onlineHour, 10) || 1)));
  put("sortNum", 0);
  put("productType", chosen.productType.value);
  put("itemsType", String(offer.itemsType || ""));
  put("title", String(offer.title || "").slice(0, 200));
  put("imageUrl", String(offer.imageUrl || ""));
  put("integerMultiple", 0);
  put("maxQty", Math.max(1, parseInt(offer.maxQty, 10) || parseInt(offer.stock, 10) || 1));
  if (chosen.area.value) put("area", chosen.area.value);
  if (chosen.platform.value) put("platform", chosen.platform.value);
  if (chosen.device.value) put("device", chosen.device.value);
  return row;
}

// templateBuffer is the raw .xlsx from /downloadTemp for THIS game.
function buildZ2uBulkFile({ templateBuffer, offers }) {
  if (!templateBuffer) throw new Error("Z2U bulk: no template downloaded");
  const template = parseZ2uTemplate(templateBuffer);
  if (!template.columns || !template.columns.title) {
    throw new Error(
      "Z2U bulk: could not find the Title column in the template header — " +
        "Z2U changed the sheet layout",
    );
  }
  // Rows 1-9 are reproduced from the template itself: the game name, the
  // service label and the header row the importer keys off. Guessing them is
  // exactly the kind of thing that differs per game.
  const head = templateRows(templateBuffer, 9);
  const data = (offers || []).map((o) => buildOfferRow(o, template));
  return {
    buffer: buildXlsx([{ name: "HEADER_CREATE_NEW_LISTING", rows: head.concat(data) }]),
    template,
    rows: data.length,
  };
}

module.exports = { buildZ2uBulkFile, buildOfferRow, MUST_MATCH_EXACTLY };
