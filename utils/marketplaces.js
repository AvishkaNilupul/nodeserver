// Connectors for external marketplaces (Gameflip, Digiseller/Plati/GGsell,
// G2G) so drop-set listings can be published from the site instead of being
// created by hand on each platform.
//
// API keys are stored encrypted (utils/secretBox) inside utils/settings.json
// under `marketplaces`, and are only ever returned to the UI masked.
const crypto = require("crypto");
const { URLSearchParams } = require("url");
const fs = require("fs");
const path = require("path");

const axios = require("axios");
const FormData = require("form-data");
const otplib = require("otplib");

const { loadSettings, saveSettings } = require("./settings");
const { encrypt, decrypt } = require("./secretBox");

// Which credential fields each marketplace needs.
const FIELDS = {
  gameflip: ["apiKey", "apiSecret"],
  digiseller: ["sellerId", "apiKey"],
  g2g: ["userId", "apiKey", "apiSecret"],
};

const MARKETPLACES = Object.keys(FIELDS);

// ------------------------------------------------------------------
// Key storage
// ------------------------------------------------------------------
function getKeys(marketplace) {
  const s = loadSettings();
  const stored = (s.marketplaces || {})[marketplace] || {};
  const out = {};
  for (const f of FIELDS[marketplace] || []) {
    out[f] = stored[f] ? decrypt(stored[f]) : "";
  }
  return out;
}

async function setKeys(marketplace, values) {
  if (!FIELDS[marketplace]) throw new Error("Unknown marketplace");
  const s = loadSettings();
  s.marketplaces = s.marketplaces || {};
  const cur = s.marketplaces[marketplace] || {};
  for (const f of FIELDS[marketplace]) {
    const v = values[f];
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    // Empty string clears the field; untouched fields keep their old value.
    cur[f] = trimmed ? encrypt(trimmed) : "";
  }
  s.marketplaces[marketplace] = cur;
  await saveSettings(s);
}

function mask(v) {
  if (!v) return "";
  if (v.length <= 4) return "****";
  return v.slice(0, 3) + "…" + v.slice(-2);
}

// Masked status for the UI: which marketplaces are configured, never the keys.
function keyStatus() {
  const out = {};
  for (const mp of MARKETPLACES) {
    const keys = getKeys(mp);
    const fields = {};
    let configured = true;
    for (const f of FIELDS[mp]) {
      fields[f] = mask(keys[f]);
      if (!keys[f]) configured = false;
    }
    out[mp] = { configured, fields };
  }
  return out;
}

function requireKeys(marketplace) {
  const keys = getKeys(marketplace);
  for (const f of FIELDS[marketplace]) {
    if (!keys[f]) {
      throw new Error(
        marketplace + " is not configured — set its API keys first",
      );
    }
  }
  return keys;
}

function apiError(prefix, e) {
  const detail =
    (e.response &&
      e.response.data &&
      JSON.stringify(e.response.data).slice(0, 400)) ||
    e.message ||
    String(e);
  const err = new Error(prefix + ": " + detail);
  err.status = e.response && e.response.status;
  return err;
}

// ------------------------------------------------------------------
// Gameflip
// ------------------------------------------------------------------
const GF_API = "https://production-gameflip.fingershock.com/api/v1";

function gfHeaders(keys) {
  const code = otplib.generateSync({ secret: keys.apiSecret });
  return { Authorization: "GFAPI " + keys.apiKey + ":" + code };
}

async function gameflipTest() {
  const keys = requireKeys("gameflip");
  try {
    const r = await axios.get(GF_API + "/account/me/profile", {
      headers: gfHeaders(keys),
      timeout: 20000,
    });
    const d = (r.data && r.data.data) || {};
    return { ok: true, detail: "Connected as " + (d.display_name || d.owner) };
  } catch (e) {
    throw apiError("Gameflip", e);
  }
}

async function gfUploadPhoto(keys, listingId, imagePath) {
  const init = await axios.post(
    GF_API + "/listing/" + listingId + "/photo",
    {},
    { headers: gfHeaders(keys), timeout: 20000 },
  );
  const { upload_url: uploadUrl, id: photoId } = init.data.data;
  const buf = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).slice(1).toLowerCase() || "png";
  await axios.put(uploadUrl, buf, {
    headers: { "Content-Type": "image/" + (ext === "jpg" ? "jpeg" : ext) },
    timeout: 30000,
  });
  await axios.patch(
    GF_API + "/listing/" + listingId,
    [
      { op: "replace", path: "/photo/" + photoId + "/status", value: "active" },
      // display_order puts the photo in the listing's gallery — without it the
      // image only shows as the search thumbnail, not on the listing page.
      { op: "replace", path: "/photo/" + photoId + "/display_order", value: 0 },
      { op: "replace", path: "/cover_photo", value: photoId },
    ],
    {
      headers: {
        ...gfHeaders(keys),
        "Content-Type": "application/json-patch+json",
      },
      timeout: 20000,
    },
  );
}

// Create a digital listing and put it on sale. Returns { externalId, url }.
// When `autoDeliverCode` is set the listing is created as an auto-delivered
// digital code: Gameflip stores the text and hands it to the buyer the moment
// the purchase completes, with no seller action needed.
async function gameflipPublish({
  title,
  description,
  priceUsd,
  imagePath,
  autoDeliverCode,
}) {
  const keys = requireKeys("gameflip");
  const cents = Math.round(Number(priceUsd) * 100);
  if (!Number.isFinite(cents) || cents < 75) {
    throw new Error("Gameflip minimum price is $0.75");
  }
  const auto =
    typeof autoDeliverCode === "string" && autoDeliverCode.trim().length > 0;
  let listingId;
  try {
    const r = await axios.post(
      GF_API + "/listing",
      {
        kind: "item",
        name: String(title).slice(0, 120),
        description: String(description || "").slice(0, 5000),
        // Auto-delivered codes must not use DIGITAL_INGAME (that combination
        // means a Steam bot trade on Gameflip); UNKNOWN is their generic
        // digital-goods category.
        category: auto ? "UNKNOWN" : "DIGITAL_INGAME",
        platform: "unknown",
        price: cents,
        accept_currency: "USD",
        shipping_within_days: auto ? 0 : 3,
        expire_in_days: 30,
        shipping_fee: 0,
        shipping_paid_by: "seller",
        shipping_predefined_package: "None",
        digital: true,
        digital_region: "none",
        digital_fee_included: false,
        digital_deliverable: auto ? "code" : "transfer",
        tags: ["twitch", "drops"],
      },
      { headers: gfHeaders(keys), timeout: 30000 },
    );
    listingId = r.data.data.id;
  } catch (e) {
    throw apiError("Gameflip create", e);
  }
  if (imagePath && fs.existsSync(imagePath)) {
    try {
      await gfUploadPhoto(keys, listingId, imagePath);
    } catch (e) {
      console.error("gameflip photo upload failed:", e.message);
    }
  }
  if (auto) {
    try {
      await axios.put(
        GF_API + "/listing/" + listingId + "/digital_goods",
        { code: autoDeliverCode },
        { headers: gfHeaders(keys), timeout: 20000 },
      );
    } catch (e) {
      throw apiError(
        "Gameflip created draft " +
          listingId +
          " but could not attach the delivery content",
        e,
      );
    }
  }
  try {
    await axios.patch(
      GF_API + "/listing/" + listingId,
      [{ op: "replace", path: "/status", value: "onsale" }],
      {
        headers: {
          ...gfHeaders(keys),
          "Content-Type": "application/json-patch+json",
        },
        timeout: 20000,
      },
    );
  } catch (e) {
    // Listing exists but stayed a draft (e.g. no photo). Surface a hint.
    throw apiError(
      "Gameflip created draft " + listingId + " but could not put it on sale",
      e,
    );
  }
  return {
    externalId: listingId,
    url: "https://gameflip.com/item/" + listingId,
  };
}

// Current status of a listing (onsale / sold / draft / ...), used to detect
// sales of auto-delivered listings.
async function gameflipListingStatus(listingId) {
  const keys = requireKeys("gameflip");
  try {
    const r = await axios.get(GF_API + "/listing/" + listingId, {
      headers: gfHeaders(keys),
      timeout: 20000,
    });
    return ((r.data && r.data.data) || {}).status || "";
  } catch (e) {
    throw apiError("Gameflip listing status", e);
  }
}

async function gameflipDelist(listingId) {
  const keys = requireKeys("gameflip");
  try {
    await axios.patch(
      GF_API + "/listing/" + listingId,
      [{ op: "replace", path: "/status", value: "draft" }],
      {
        headers: {
          ...gfHeaders(keys),
          "Content-Type": "application/json-patch+json",
        },
        timeout: 20000,
      },
    );
    await axios.delete(GF_API + "/listing/" + listingId, {
      headers: gfHeaders(keys),
      timeout: 20000,
    });
  } catch (e) {
    throw apiError("Gameflip delist", e);
  }
}

// ------------------------------------------------------------------
// Digiseller (Plati.market / GGsell storefronts)
// ------------------------------------------------------------------
const DS_API = "https://api.digiseller.com/api";

let dsToken = { token: "", validUntil: 0, sellerId: "" };

async function digisellerToken() {
  const keys = requireKeys("digiseller");
  const now = Date.now();
  if (
    dsToken.token &&
    dsToken.sellerId === keys.sellerId &&
    now < dsToken.validUntil
  ) {
    return dsToken.token;
  }
  const timestamp = Math.floor(now / 1000);
  const sign = crypto
    .createHash("sha256")
    .update(keys.apiKey + timestamp)
    .digest("hex");
  try {
    const r = await axios.post(
      DS_API + "/apilogin",
      { seller_id: Number(keys.sellerId), timestamp, sign },
      { headers: { "Content-Type": "application/json" }, timeout: 20000 },
    );
    if (String(r.data.retval) !== "0" || !r.data.token) {
      throw new Error(
        "apilogin failed: " + (r.data.retdesc || "retval " + r.data.retval),
      );
    }
    // Tokens are valid ~2h; refresh a bit early.
    dsToken = {
      token: r.data.token,
      validUntil: now + 90 * 60 * 1000,
      sellerId: keys.sellerId,
    };
    return dsToken.token;
  } catch (e) {
    throw apiError("Digiseller login", e);
  }
}

// Digiseller reports failures as { retval: 1, retdesc: "Validation error",
// errors: [{code, message}] } — pull the messages out so errors are actionable.
function dsErrorText(d) {
  let msg = d.retdesc || "retval " + d.retval;
  const text = (v) => {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (Array.isArray(v)) return v.map(text).filter(Boolean).join(" / ");
    if (typeof v === "object") {
      if (v.value) return String(v.value);
      return JSON.stringify(v).slice(0, 200);
    }
    return String(v);
  };
  if (Array.isArray(d.errors) && d.errors.length) {
    msg +=
      " — " +
      d.errors
        .map((e) => (e.code ? e.code + ": " : "") + text(e.message || e))
        .join("; ");
  } else if (d.errors && typeof d.errors === "object") {
    msg += " — " + JSON.stringify(d.errors).slice(0, 400);
  }
  return msg;
}

function dsLocales(value) {
  // Digiseller wants ru-RU and en-US variants; we use the same text for both.
  return [
    { locale: "ru-RU", value },
    { locale: "en-US", value },
  ];
}

// Cataloguer categories — the authorized catalog whose IDs product/create
// accepts (the public dictionary tree returns IDs create rejects). Drill down
// one level at a time via rootCategoryId.
async function digisellerCategories(rootCategoryId) {
  const token = await digisellerToken();
  try {
    const COUNT = 500;
    const all = [];
    const seen = new Set();
    for (let page = 1; page <= 40; page++) {
      let url =
        DS_API +
        "/cataloguer/categories?page=" +
        page +
        "&count=" +
        COUNT +
        "&token=" +
        encodeURIComponent(token);
      if (rootCategoryId) {
        url += "&rootCategoryId=" + encodeURIComponent(rootCategoryId);
      }
      const r = await axios.get(url, {
        headers: { Accept: "application/json" },
        timeout: 20000,
      });
      const d = r.data || {};
      if (d.retval !== undefined && String(d.retval) !== "0") {
        throw new Error(dsErrorText(d));
      }
      const rows = d.content || [];
      for (const row of rows) {
        const id = String(row.category_id);
        if (seen.has(id) || id === String(rootCategoryId || "")) continue;
        seen.add(id);
        all.push(row);
      }
      if (rows.length < COUNT) break;
    }
    return all;
  } catch (e) {
    throw apiError("Digiseller categories", e);
  }
}

// Attributes (e.g. platform / region pickers) a cataloguer category may need.
async function digisellerCategoryAttributes(categoryId) {
  const token = await digisellerToken();
  try {
    const r = await axios.get(
      DS_API +
        "/cataloguer/" +
        encodeURIComponent(categoryId) +
        "/attributes?token=" +
        encodeURIComponent(token),
      { headers: { Accept: "application/json" }, timeout: 20000 },
    );
    const d = r.data || {};
    if (d.retval !== undefined && String(d.retval) !== "0") {
      throw new Error(dsErrorText(d));
    }
    return d.content || [];
  } catch (e) {
    throw apiError("Digiseller attributes", e);
  }
}

async function digisellerTest() {
  await digisellerToken();
  return { ok: true, detail: "Token issued — connection OK" };
}

// Create a "unique product with fixed price". Returns { externalId, url }.
async function digisellerPublish({ title, description, priceUsd, categories }) {
  const token = await digisellerToken();
  const price = Math.round(Number(priceUsd) * 100) / 100;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Digiseller needs a price above 0");
  }
  // Digiseller rejects products that aren't placed in a marketplace catalog
  // category (owner: 1 = Plati.Market, 3 = GGsell).
  const cats = (Array.isArray(categories) ? categories : [])
    .filter((c) => c && c.categoryId)
    .map((c) => {
      const out = {
        owner: Number(c.owner),
        cataloguer_category_id: Number(c.categoryId),
      };
      const attrs = (Array.isArray(c.attributes) ? c.attributes : [])
        .filter((a) => a && a.attributeId && a.attributeValueId)
        .map((a) => ({
          attribute_id: Number(a.attributeId),
          attribute_value_id: Number(a.attributeValueId),
        }));
      if (attrs.length) out.cataloguer_attributes = attrs;
      return out;
    });
  if (!cats.length) {
    throw new Error("Pick a Plati catalog category first");
  }
  try {
    const r = await axios.post(
      DS_API + "/product/create/uniquefixed?token=" + encodeURIComponent(token),
      {
        content_type: "text",
        name: dsLocales(String(title).slice(0, 200)),
        price: { price, currency: "USD" },
        description: dsLocales(String(description || "").slice(0, 5000)),
        categories: cats,
        address_required: false,
        guarantee: { enabled: true, value: 3 },
      },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 },
    );
    const d = r.data || {};
    if (d.retval !== undefined && String(d.retval) !== "0") {
      throw new Error("create failed: " + dsErrorText(d));
    }
    const productId =
      (d.content && (d.content.product_id || d.content.id)) ||
      d.product_id ||
      d.id;
    if (!productId) {
      throw new Error(
        "no product id in response: " + JSON.stringify(d).slice(0, 300),
      );
    }
    return {
      externalId: String(productId),
      url: "https://plati.market/itm/" + productId,
      note:
        "Product created (hidden until it has content). Add delivery text/stock" +
        " in Digiseller, or it stays unsellable.",
    };
  } catch (e) {
    throw apiError("Digiseller create", e);
  }
}

// Upload a gallery image to a Digiseller product (needs [Gallery]: Adding
// token permission).
async function digisellerUploadImage(productId, imagePath) {
  const token = await digisellerToken();
  const buf = fs.readFileSync(imagePath);
  const url =
    DS_API +
    "/product/preview/add/images/" +
    encodeURIComponent(productId) +
    "?token=" +
    encodeURIComponent(token);
  // Digiseller's docs only say "a product image file in multipart/form-data
  // format" without naming the form field, so try the common field names.
  let lastErr;
  for (const field of ["file", "image", "files[]"]) {
    const form = new FormData();
    form.append(field, buf, {
      filename: "cover.png",
      contentType: "image/png",
    });
    try {
      const r = await axios.post(url, form, {
        headers: Object.assign(
          { Accept: "application/json" },
          form.getHeaders(),
        ),
        timeout: 60000,
        maxBodyLength: 30e6,
      });
      const d = r.data || {};
      if (d.retval !== undefined && String(d.retval) !== "0") {
        throw new Error(dsErrorText(d));
      }
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw apiError("Digiseller image upload", lastErr);
}

// Attach delivery content (e.g. "user:pass" lines) so the product is sellable.
async function digisellerAddContent(productId, lines) {
  const token = await digisellerToken();
  const content = lines
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .map((value) => ({ value, id_v: 0 }));
  if (!content.length) throw new Error("No content lines given");
  try {
    const r = await axios.post(
      DS_API + "/product/content/add/text?token=" + encodeURIComponent(token),
      { product_id: Number(productId), content },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 },
    );
    const d = r.data || {};
    if (d.retval !== undefined && String(d.retval) !== "0") {
      throw new Error(dsErrorText(d));
    }
    return { added: content.length };
  } catch (e) {
    throw apiError("Digiseller add content", e);
  }
}

// Disable sales for a product (soft delist).
async function digisellerDelist(productId) {
  const token = await digisellerToken();
  try {
    const r = await axios.post(
      DS_API +
        "/product/edit/base/" +
        encodeURIComponent(productId) +
        "?token=" +
        encodeURIComponent(token),
      { enabled: false },
      { headers: { "Content-Type": "application/json" }, timeout: 30000 },
    );
    const d = r.data || {};
    if (d.retval !== undefined && String(d.retval) !== "0") {
      throw new Error(dsErrorText(d));
    }
  } catch (e) {
    throw apiError("Digiseller delist", e);
  }
}

// ------------------------------------------------------------------
// G2G Open API
// ------------------------------------------------------------------
const G2G_API = "https://open-api.g2g.com";

function g2gHeaders(keys, urlPath) {
  const timestamp = String(Date.now());
  // The signature is computed over the URL *path* only — never the query
  // string (per G2G's official Postman collection).
  const pathOnly = urlPath.split("?")[0];
  const canonical = pathOnly + keys.apiKey + keys.userId + timestamp;
  const signature = crypto
    .createHmac("sha256", keys.apiSecret)
    .update(canonical)
    .digest("hex");
  return {
    "g2g-api-key": keys.apiKey,
    "g2g-userid": keys.userId,
    "g2g-signature": signature,
    "g2g-timestamp": timestamp,
    "Content-Type": "application/json",
  };
}

async function g2gRequest(method, urlPath, body) {
  const keys = requireKeys("g2g");
  try {
    const r = await axios({
      method,
      url: G2G_API + urlPath,
      data: body,
      headers: g2gHeaders(keys, urlPath),
      timeout: 30000,
    });
    return r.data;
  } catch (e) {
    throw apiError("G2G", e);
  }
}

async function g2gTest() {
  const d = await g2gRequest("get", "/v2/store");
  return { ok: true, detail: "Connected — store settings fetched", data: d };
}

// Catalog browsing so the UI can walk service -> brand -> product -> attributes.
function g2gServices() {
  return g2gRequest("get", "/v2/services");
}
function g2gBrands(serviceId) {
  return g2gRequest(
    "get",
    "/v2/services/" + encodeURIComponent(serviceId) + "/brands",
  );
}
async function g2gProducts(serviceId, brandId, categoryId) {
  // G2G treats category_id as mutually exclusive with service_id/brand_id
  // ("... is not required when category_id is exists"), and a category-only
  // query returns every brand's products. Querying by service + brand is the
  // reliable way to get one game's products, so always do that and only use
  // the category (if picked) to narrow the results locally.
  const qs = new URLSearchParams();
  qs.set("service_id", serviceId);
  qs.set("brand_id", brandId);
  const d = await g2gRequest("get", "/v2/products?" + qs.toString());
  if (categoryId) {
    const payload = d.payload || d.data || d;
    for (const key of Object.keys(payload)) {
      if (Array.isArray(payload[key])) {
        const filtered = payload[key].filter(
          (row) =>
            !row ||
            row.category_id === undefined ||
            String(row.category_id) === String(categoryId),
        );
        // If the rows don't carry a matching category, keep the full list
        // rather than showing an empty dropdown.
        if (filtered.length) payload[key] = filtered;
      }
    }
  }
  return d;
}
function g2gAttributes(productId) {
  return g2gRequest(
    "get",
    "/v2/products/" + encodeURIComponent(productId) + "/attributes",
  );
}

// Create an offer. G2G offers hang off a catalog product, so the caller must
// supply productId (+ any required attributes picked from g2gAttributes).
async function g2gPublish({
  productId,
  title,
  description,
  priceUsd,
  qty,
  minQty,
  currency,
  offerAttributes,
  deliveryMethodIds,
}) {
  const price = Number(priceUsd);
  if (!productId) throw new Error("G2G product_id is required");
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("G2G needs a price above 0");
  }
  const body = {
    product_id: String(productId),
    title: String(title || "").slice(0, 128),
    description: String(description || title || ""),
    currency: currency || "USD",
    unit_price: price,
    min_qty: Number(minQty) || 1,
    api_qty: Number(qty) || 1,
    available_qty: Number(qty) || 1,
    low_stock_alert_qty: 0,
  };
  if (Array.isArray(offerAttributes) && offerAttributes.length) {
    body.offer_attributes = offerAttributes;
  }
  let dmIds = deliveryMethodIds;
  if (!Array.isArray(dmIds) || !dmIds.length) {
    // The catalog product dictates the allowed delivery methods; send them
    // all so G2G doesn't reject the offer for missing delivery info.
    try {
      const a = await g2gAttributes(productId);
      const p = a.payload || a.data || a;
      dmIds = (p.delivery_method_list || [])
        .map((m) => m.delivery_method_id)
        .filter(Boolean);
    } catch {
      dmIds = [];
    }
  }
  if (Array.isArray(dmIds) && dmIds.length) {
    body.delivery_method_ids = dmIds;
  }
  let d;
  try {
    d = await g2gRequest("post", "/v2/offers", body);
  } catch (err) {
    if (/delivery_speed/i.test(err.message)) {
      throw new Error(
        "G2G's API only accepts instant-delivery offers (gift cards / top-ups " +
          "or API-delivered stock). This product uses manual/gifting delivery, " +
          "which G2G does not allow to be created through the API — create the " +
          "offer once on g2g.com, after which price/stock can be managed here.",
      );
    }
    throw err;
  }
  const payload = d.payload || d.data || d;
  const offerId = payload.offer_id || payload.id;
  if (!offerId) {
    throw new Error(
      "G2G create: no offer id in response: " + JSON.stringify(d).slice(0, 300),
    );
  }
  return {
    externalId: String(offerId),
    url: "https://www.g2g.com/offer/" + offerId,
  };
}

async function g2gDelist(offerId) {
  await g2gRequest("delete", "/v2/offers/" + encodeURIComponent(offerId));
}

module.exports = {
  MARKETPLACES,
  FIELDS,
  setKeys,
  keyStatus,
  gameflipTest,
  gameflipPublish,
  gameflipListingStatus,
  gameflipDelist,
  digisellerTest,
  digisellerCategories,
  digisellerCategoryAttributes,
  digisellerPublish,
  digisellerUploadImage,
  digisellerAddContent,
  digisellerDelist,
  g2gTest,
  g2gServices,
  g2gBrands,
  g2gProducts,
  g2gAttributes,
  g2gPublish,
  g2gDelist,
};
