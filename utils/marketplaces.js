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
  ggsel: ["apiKey"],
  // FunPay has no API — the single credential is the account's session token.
  funpay: ["golden_key"],
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

function dsLocales(value, ruValue) {
  // Digiseller wants ru-RU and en-US variants. Titles keep the same text for
  // both (product names); descriptions pass a translated ruValue.
  return [
    { locale: "ru-RU", value: ruValue != null ? ruValue : value },
    { locale: "en-US", value },
  ];
}

// Cataloguer categories — the authorized catalog whose IDs product/create
// accepts (the public dictionary tree returns IDs create rejects). Drill down
// one level at a time via rootCategoryId.
// Digiseller's cataloguer API is slow and flaky, so each level is cached for
// a few hours and every page request gets one retry before giving up.
const dsCatCache = new Map(); // rootId -> { rows, until }
const DS_CAT_TTL_MS = 6 * 60 * 60 * 1000;

async function dsCategoriesPage(token, rootCategoryId, page, count) {
  let url =
    DS_API +
    "/cataloguer/categories?page=" +
    page +
    "&count=" +
    count +
    "&token=" +
    encodeURIComponent(token);
  if (rootCategoryId) {
    url += "&rootCategoryId=" + encodeURIComponent(rootCategoryId);
  }
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios.get(url, {
        headers: { Accept: "application/json" },
        timeout: 30000,
      });
      const d = r.data || {};
      if (d.retval !== undefined && String(d.retval) !== "0") {
        throw new Error(dsErrorText(d));
      }
      return d.content || [];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function digisellerCategories(rootCategoryId) {
  const cacheKey = String(rootCategoryId || "");
  const hit = dsCatCache.get(cacheKey);
  if (hit && Date.now() < hit.until) return hit.rows;
  const token = await digisellerToken();
  try {
    const COUNT = 500;
    const all = [];
    const seen = new Set();
    for (let page = 1; page <= 40; page++) {
      const rows = await dsCategoriesPage(token, rootCategoryId, page, COUNT);
      for (const row of rows) {
        const id = String(row.category_id);
        if (seen.has(id) || id === String(rootCategoryId || "")) continue;
        seen.add(id);
        all.push(row);
      }
      if (rows.length < COUNT) break;
    }
    dsCatCache.set(cacheKey, { rows: all, until: Date.now() + DS_CAT_TTL_MS });
    return all;
  } catch (e) {
    // A stale cache entry is far more useful than a timeout error.
    if (hit) return hit.rows;
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
  const desc = String(description || "").slice(0, 5000);
  const descRu = (await translateEnToRu(desc)).slice(0, 5000);
  try {
    const r = await axios.post(
      DS_API + "/product/create/uniquefixed?token=" + encodeURIComponent(token),
      {
        content_type: "text",
        name: dsLocales(String(title).slice(0, 200)),
        price: { price, currency: "USD" },
        description: dsLocales(desc, descRu),
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

// How many delivery units a product still has, via the public product-info
// endpoint (no token needed). Returns a number, or null when the response
// doesn't carry a recognisable stock field.
async function digisellerProductStock(productId) {
  try {
    const r = await axios.get(
      DS_API + "/products/" + encodeURIComponent(productId) + "/data",
      { headers: { Accept: "application/json" }, timeout: 20000 },
    );
    const d = r.data || {};
    const p = d.product || d.content || d;
    // Only trust real numeric stock fields: booleans coerce to 0/1 and
    // num_in_lock counts locked (not sellable) units, so both would make the
    // auto-feeder misjudge stock and over-feed accounts.
    for (const f of ["num_in_stock", "in_stock", "count_goods"]) {
      const raw = p && p[f];
      if (typeof raw === "boolean") continue;
      const v = Number(raw);
      if (Number.isFinite(v)) return v;
    }
    return null;
  } catch {
    return null;
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
// GGSel (seller.ggsel.com) — its own v2 seller API, separate from the
// Digiseller/Plati path above. Auth is a single API key in the Authorization
// header; offers are always priced in RUB.
// ------------------------------------------------------------------
const GG_API = "https://seller.ggsel.com/api_sellers/v2";

function ggHeaders(keys) {
  return { Authorization: keys.apiKey, "Content-Type": "application/json" };
}

// USD -> RUB, cached ~6h. GGSel offers must be priced in RUB, but the rest of
// the site works in USD, so convert at publish time. Falls back to a static
// rate when the FX lookup is unavailable.
let rubRate = { value: 0, until: 0 };
const RUB_FALLBACK = 90;
async function usdToRub() {
  const now = Date.now();
  if (rubRate.value && now < rubRate.until) return rubRate.value;
  try {
    const r = await axios.get("https://open.er-api.com/v6/latest/USD", {
      timeout: 15000,
    });
    const v = r.data && r.data.rates && Number(r.data.rates.RUB);
    if (Number.isFinite(v) && v > 0) {
      rubRate = { value: v, until: now + 6 * 60 * 60 * 1000 };
      return v;
    }
  } catch {
    /* fall through to fallback */
  }
  return rubRate.value || RUB_FALLBACK;
}

// EN -> RU for the Russian-language fields GGSel/Digiseller/FunPay listings
// carry alongside the English ones (we used to submit the same English text
// into both). Uses Google's keyless gtx endpoint, translating line-by-line so
// bullet-list descriptions keep their structure. Best-effort: on any failure
// the English text is returned so publishing never breaks on translation.
async function translateEnToRu(text) {
  const src = String(text || "");
  // Already (partly) Russian — hand-written RU text, leave it alone.
  if (!src.trim() || /[а-яё]/i.test(src)) return src;
  const lines = src.split("\n");
  const idx = []; // positions of the non-empty lines we send
  const params = new URLSearchParams();
  lines.forEach((line, i) => {
    if (line.trim()) {
      idx.push(i);
      params.append("q", line);
    }
  });
  if (!idx.length) return src;
  try {
    const r = await axios.post(
      "https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=ru&format=text",
      params.toString(),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15000,
      },
    );
    const out = Array.isArray(r.data) ? r.data : [r.data];
    if (out.length !== idx.length) return src;
    const result = lines.slice();
    idx.forEach((lineNo, i) => {
      const v = out[i];
      if (typeof v === "string" && v.trim()) result[lineNo] = v;
    });
    return result.join("\n");
  } catch (e) {
    console.error("EN->RU translate failed (using English):", e.message);
    return src;
  }
}

async function ggselTest() {
  const keys = requireKeys("ggsel");
  try {
    const r = await axios.get(GG_API + "/offers", {
      headers: ggHeaders(keys),
      timeout: 20000,
    });
    const n = Array.isArray(r.data && r.data.data) ? r.data.data.length : 0;
    return { ok: true, detail: "Connected — " + n + " offer(s) visible" };
  } catch (e) {
    throw apiError("GGSel test", e);
  }
}

// Category tree, one level per request. Pass a parentId to drill into a
// section's children; omit it for the top level. Each node is
// { id, title, tree, content_type, fee, has_children }.
//
// The API paginates at 100 rows and some levels are huge (Games has 24k+
// children), so every page is fetched — in parallel batches — and the full
// level is cached for a few hours. Previously only page 1 was read, which is
// why most games (e.g. Rocket League) never appeared in the dropdown.
const ggCatCache = new Map(); // parentId -> { rows, until }
const GG_CAT_TTL_MS = 12 * 60 * 60 * 1000;

async function ggCategoriesPage(keys, parentId, page) {
  const params = { page };
  if (parentId) params.parent_id = parentId;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await axios.get(GG_API + "/categories", {
        headers: ggHeaders(keys),
        params,
        timeout: 30000,
      });
      const d = r.data || {};
      return {
        rows: Array.isArray(d.data) ? d.data : [],
        totalPages: Number(d.pagination && d.pagination.total_pages) || 1,
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function ggselCategories(parentId) {
  const cacheKey = String(parentId || "");
  const hit = ggCatCache.get(cacheKey);
  if (hit && Date.now() < hit.until) return hit.rows;
  const keys = requireKeys("ggsel");
  try {
    const first = await ggCategoriesPage(keys, parentId, 1);
    const all = [...first.rows];
    const totalPages = Math.min(first.totalPages, 400);
    const BATCH = 8;
    for (let start = 2; start <= totalPages; start += BATCH) {
      const pages = [];
      for (let p = start; p < start + BATCH && p <= totalPages; p++) {
        pages.push(p);
      }
      const results = await Promise.all(
        pages.map((p) => ggCategoriesPage(keys, parentId, p)),
      );
      for (const r of results) all.push(...r.rows);
    }
    ggCatCache.set(cacheKey, { rows: all, until: Date.now() + GG_CAT_TTL_MS });
    return all;
  } catch (e) {
    // A stale cache entry is far more useful than a timeout error.
    if (hit) return hit.rows;
    throw apiError("GGSel categories", e);
  }
}

// GGSel wants cover images as a data-URI base64 string (raw base64 is
// rejected with "wrong file format"). Reads a local file and encodes it;
// returns "" when there is no usable image so the offer just has no cover.
function ggselImageDataUri(imagePath) {
  if (!imagePath) return "";
  let buf;
  try {
    buf = fs.readFileSync(imagePath);
  } catch {
    return "";
  }
  const ext = String(path.extname(imagePath) || "").toLowerCase();
  const mime =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : ext === ".gif"
          ? "image/gif"
          : "image/png";
  return "data:" + mime + ";base64," + buf.toString("base64");
}

// Push deliverable content lines to an offer. Each value becomes one product
// GGSel hands to a buyer automatically (autoselling must be on). Returns the
// number of products the API accepted.
async function ggselAddProducts(offerId, values) {
  const keys = requireKeys("ggsel");
  const products = (Array.isArray(values) ? values : [])
    .map((v) => String(v || "").trim())
    .filter(Boolean)
    .map((value) => ({ value }));
  if (!products.length) return 0;
  try {
    await axios.post(
      GG_API + "/offers/" + Number(offerId) + "/products",
      { products },
      { headers: ggHeaders(keys), timeout: 30000 },
    );
  } catch (e) {
    throw apiError("GGSel add products", e);
  }
  return products.length;
}

// Create an offer, then activate it so buyers can see it. GGSel prices are in
// RUB, so a USD price is converted unless priceRub is passed explicitly.
//
// When `products` (an array of delivery-content strings) is supplied the offer
// is created with autoselling on and those items are attached, so GGSel hands
// one to each buyer automatically — this is the real "Automatic" delivery, as
// opposed to just setting delivery:"auto" on an empty offer (which GGSel shows
// as Manual because there is nothing to deliver). `coverImagePath` points at a
// local image used as the offer cover. Returns { externalId, url, note, qty }.
async function ggselPublish({
  title,
  description,
  priceUsd,
  priceRub,
  categoryId,
  quantity,
  delivery,
  instructions,
  coverImagePath,
  products,
}) {
  const keys = requireKeys("ggsel");
  if (!categoryId) throw new Error("Pick a GGSel category first");
  let price = Number(priceRub);
  let note = "";
  if (!Number.isFinite(price) || price <= 0) {
    const rate = await usdToRub();
    price = Math.round(Number(priceUsd) * rate * 100) / 100;
    note =
      "Priced at " +
      price +
      "₽ (~$" +
      Number(priceUsd) +
      " @ " +
      rate.toFixed(2) +
      "₽/$).";
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("GGSel needs a price above 0");
  }
  const content = (Array.isArray(products) ? products : [])
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  // Autoselling is what actually makes GGSel auto-deliver; it needs stock, so
  // it is only enabled when we have content lines to attach.
  const autoselling = delivery === "auto" && content.length > 0;
  // With autoselling the sellable count is driven by attached products; keep
  // the offer's quantity in sync so stock is not artificially capped.
  const qty = autoselling
    ? content.length
    : Math.max(1, parseInt(quantity, 10) || 1);
  const t = String(title || "").slice(0, 200);
  const d = String(description || "").slice(0, 5000);
  const dRu = (await translateEnToRu(d)).slice(0, 5000);
  const instrEn = instructions ? String(instructions) : "";
  const instrRu = instrEn ? await translateEnToRu(instrEn) : "";
  const cover = ggselImageDataUri(coverImagePath);
  let created;
  try {
    const r = await axios.post(
      GG_API + "/offers",
      {
        category_id: Number(categoryId),
        title_ru: t,
        title_en: t,
        description_ru: dRu,
        description_en: d,
        instructions_ru: instrRu || undefined,
        instructions_en: instrEn || undefined,
        cover_image_ru: cover || undefined,
        cover_image_en: cover || undefined,
        price,
        currency: "RUB",
        is_autoselling: autoselling,
        delivery: delivery === "auto" ? "auto" : "manual",
        quantity: qty,
        min_quantity: 1,
        max_quantity: qty,
      },
      { headers: ggHeaders(keys), timeout: 30000 },
    );
    created = (r.data && r.data.data) || {};
  } catch (e) {
    throw apiError("GGSel create", e);
  }
  const offerId = created.id;
  if (!offerId) {
    throw new Error(
      "GGSel create: no offer id in response: " +
        JSON.stringify(created).slice(0, 300),
    );
  }
  // Attach the delivery content so autoselling has stock to hand out. If this
  // fails the offer would go live with no stock, so surface it as an error.
  if (autoselling) {
    await ggselAddProducts(offerId, content);
  }
  // New offers start as drafts; activate so they go live.
  try {
    await axios.post(
      GG_API + "/offers/batch_activate",
      { offer_ids: [offerId] },
      { headers: ggHeaders(keys), timeout: 20000 },
    );
  } catch (e) {
    note =
      (note ? note + " " : "") +
      "Created as draft but activation failed — activate it in the GGSel " +
      "panel. (" +
      (e.message || "error") +
      ")";
  }
  return {
    externalId: String(offerId),
    url: "https://ggsel.net/en/catalog/product/" + offerId,
    note,
    qty,
  };
}

// Remaining sellable units of an offer. Tries the single-offer endpoint and
// falls back to scanning the offer list. Returns a number or null when the
// response doesn't carry a recognisable stock field.
function ggselStockField(o) {
  if (!o || typeof o !== "object") return null;
  for (const f of ["available_quantity", "products_count", "quantity"]) {
    const v = Number(o[f]);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

async function ggselOfferStock(offerId) {
  const keys = requireKeys("ggsel");
  try {
    const r = await axios.get(GG_API + "/offers/" + Number(offerId), {
      headers: ggHeaders(keys),
      timeout: 20000,
    });
    const v = ggselStockField((r.data && r.data.data) || r.data);
    if (v !== null) return v;
  } catch {
    /* fall through to the list scan */
  }
  try {
    const r = await axios.get(GG_API + "/offers", {
      headers: ggHeaders(keys),
      timeout: 20000,
    });
    const rows = Array.isArray(r.data && r.data.data) ? r.data.data : [];
    const row = rows.find((o) => String(o && o.id) === String(offerId));
    return ggselStockField(row);
  } catch {
    return null;
  }
}

// Products can only be attached to an autoselling offer — GGSel rejects
// /products on a non-autoselling offer with 422 "Autoselling is required for
// products" (verified live 2026-07-24). An offer published with delivery
// "auto" but no initial stock is created with is_autoselling:false, so this
// MUST run BEFORE the first ggselAddProducts. Enabling autoselling on an
// offer with 0 stock also pauses it (an autoselling offer with nothing to
// sell can't be on sale), which ggselFinalizeStock undoes after the add.
// Idempotent: a no-op when autoselling is already on. Returns whether it
// flipped the flag.
async function ggselEnableAutoselling(offerId) {
  const keys = requireKeys("ggsel");
  let offer;
  try {
    const r = await axios.get(GG_API + "/offers/" + Number(offerId), {
      headers: ggHeaders(keys),
      timeout: 20000,
    });
    offer = (r.data && r.data.data) || r.data || {};
  } catch (e) {
    throw apiError("GGSel offer read", e);
  }
  if (offer.is_autoselling) return { changed: false };
  try {
    await axios.patch(
      GG_API + "/offers/" + Number(offerId),
      { is_autoselling: true, delivery: "auto" },
      { headers: ggHeaders(keys), timeout: 20000 },
    );
  } catch (e) {
    throw apiError("GGSel enable autoselling", e);
  }
  return { changed: true };
}

// After products are attached, sync the sellable quantity to the real stock
// and re-activate the offer if enabling autoselling (above) left it paused.
// Called AFTER ggselAddProducts. Without the re-activate, a freshly-fed offer
// would sit paused with stock but off sale.
async function ggselFinalizeStock(offerId) {
  const keys = requireKeys("ggsel");
  let offer;
  try {
    const r = await axios.get(GG_API + "/offers/" + Number(offerId), {
      headers: ggHeaders(keys),
      timeout: 20000,
    });
    offer = (r.data && r.data.data) || r.data || {};
  } catch (e) {
    throw apiError("GGSel offer read", e);
  }
  const stock = Number(offer.in_stock_products_count) || 0;
  // Nothing settled yet — GGSel attaches products through an async job, so
  // right after an add the count can still read 0. Not an error; the next
  // guardian tick re-runs this once the job lands.
  if (stock <= 0) return { stock: 0, reactivated: false, pending: true };
  // Sync the sellable quantity — best-effort. GGSel occasionally 500s here,
  // and it must NOT block the activate below (going live is what matters; a
  // stale quantity just caps sellable count, it doesn't take money without
  // delivering).
  let quantitySynced = true;
  try {
    await axios.patch(
      GG_API + "/offers/" + Number(offerId),
      { quantity: stock, max_quantity: stock },
      { headers: ggHeaders(keys), timeout: 20000 },
    );
  } catch {
    quantitySynced = false;
  }
  // Activate: enabling autoselling on a then-empty offer paused it, and an
  // offer published but never activated sits as "draft" — either way a
  // stocked offer that isn't "active" is off sale. This is the critical step.
  let reactivated = false;
  if (offer.status === "paused" || offer.status === "draft") {
    try {
      await axios.post(
        GG_API + "/offers/batch_activate",
        { offer_ids: [Number(offerId)] },
        { headers: ggHeaders(keys), timeout: 20000 },
      );
      reactivated = true;
    } catch (e) {
      throw apiError("GGSel reactivate", e);
    }
  }
  return { stock, reactivated, quantitySynced };
}

// GGSel has no delete-offer API; pausing takes it off sale (reversible).
async function ggselDelist(offerId) {
  const keys = requireKeys("ggsel");
  try {
    await axios.post(
      GG_API + "/offers/batch_pause",
      { offer_ids: [Number(offerId)] },
      { headers: ggHeaders(keys), timeout: 20000 },
    );
  } catch (e) {
    throw apiError("GGSel delist", e);
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

// Update mutable fields (price / stock / status) of an offer that already
// exists on G2G. Unlike creating, updating an existing offer is allowed even
// for delivery types the API won't let you *create* — so this is the supported
// way to manage price and stock of offers listed on g2g.com from here.
//
// Verified against G2G's Open API (2026-07-21): PATCH /v2/offers/{id} with a
// partial body — only the fields you send are changed. Price updates work on
// any offer. `stock` maps to api_qty (the API-managed stock); note that
// manual/gifting offers keep api_qty=0 and manage their real stock
// (available_qty, which the API rejects as "no attributes to be updated") on
// g2g.com — so stock updates here only apply to API-delivery offers.
async function g2gUpdateOffer(offerId, fields) {
  if (!offerId) throw new Error("G2G offer_id is required");
  const f = fields || {};
  const body = {};
  if (f.unitPrice != null && f.unitPrice !== "") {
    const price = Number(f.unitPrice);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("G2G needs a price above 0");
    }
    body.unit_price = price;
  }
  if (f.stock != null && f.stock !== "") {
    const qty = Number(f.stock);
    if (!Number.isFinite(qty) || qty < 0) {
      throw new Error("G2G needs a stock of 0 or more");
    }
    body.api_qty = Math.round(qty);
  }
  if (f.title != null) body.title = String(f.title).slice(0, 128);
  if (f.description != null) body.description = String(f.description);
  if (f.status != null) body.offer_status = String(f.status);
  if (!Object.keys(body).length) {
    throw new Error("G2G update: nothing to change");
  }
  const d = await g2gRequest(
    "patch",
    "/v2/offers/" + encodeURIComponent(offerId),
    body,
  );
  const payload = d.payload || d.data || d;
  return { externalId: String(payload.offer_id || payload.id || offerId) };
}

// Fetch one existing offer (current price/stock/status/etc.). Used by the bulk
// updater to show what's live before changing it, and to safely diff after.
async function g2gGetOffer(offerId) {
  if (!offerId) throw new Error("G2G offer_id is required");
  const d = await g2gRequest(
    "get",
    "/v2/offers/" + encodeURIComponent(offerId),
  );
  return d.payload || d.data || d;
}

// List the seller's own offers so the price updater can show them grouped by
// game. G2G exposes this only as a POST search (there is no GET /v2/offers
// list), so page through and return them all. brandId/serviceId let the UI
// group per game; there's no working server-side product filter.
async function g2gListOffers({ pageSize = 100, maxPages = 30 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const d = await g2gRequest("post", "/v2/offers/search", {
      page,
      page_size: pageSize,
    });
    const p = d.payload || d.data || d;
    const rows = p.results || p.offers || [];
    for (const o of rows) {
      out.push({
        offerId: o.offer_id,
        title: o.title,
        status: o.status,
        currency: o.currency,
        unitPrice: o.unit_price,
        availableQty: o.available_qty,
        serviceId: o.service_id,
        brandId: o.brand_id,
      });
    }
    if (rows.length < pageSize) break;
  }
  return out;
}

// ------------------------------------------------------------------
// FunPay — no public API, so the seller's own account is driven through
// funpay.com using a stored session token. The `golden_key` cookie is
// FunPay's persistent auth token; paste it from a signed-in FunPay browser
// session (DevTools → Application → Cookies → funpay.com → golden_key). A lot
// is created by scraping a fresh CSRF token from the offer editor, then
// POSTing the very form the site itself submits (/lots/offerSave).
// ------------------------------------------------------------------
const FP_BASE = "https://funpay.com/en";
const FP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function fpCookie(goldenKey, extra) {
  const parts = ["golden_key=" + goldenKey];
  if (extra) parts.push(extra);
  return parts.join("; ");
}

// Forward EVERY cookie FunPay sets on the authenticated GET (PHPSESSID and any
// others), not just PHPSESSID: offerSave rejects the POST with HTTP 428
// (precondition required) unless the full cookie set from the page load is
// present. The CSRF token is bound to this session, so the POST must reuse it.
function fpSessionCookie(setCookie) {
  const arr = Array.isArray(setCookie)
    ? setCookie
    : setCookie
      ? [setCookie]
      : [];
  return arr
    .map((c) => String(c).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

function fpUnescape(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// A FunPay page carries its per-session CSRF token (and the logged-in user) in
// <body data-app-data='{"csrf-token":"…","userId":…}'>. Parse it out.
function fpParseApp(html) {
  const out = { csrf: "", userId: "", username: "" };
  const app =
    /data-app-data="([^"]+)"/.exec(html) ||
    /data-app-data='([^']+)'/.exec(html);
  if (app) {
    try {
      const data = JSON.parse(fpUnescape(app[1]));
      out.csrf = data["csrf-token"] || "";
      out.userId = data.userId != null ? String(data.userId) : "";
    } catch {
      const m = /csrf-token[^a-f0-9]{0,12}([a-f0-9]{16,})/i.exec(app[1]);
      if (m) out.csrf = m[1];
    }
  }
  const uname = /class="user-link-name"[^>]*>([^<]+)</.exec(html);
  if (uname) out.username = uname[1].trim();
  return out;
}

// Read a single form field's current value out of raw editor HTML (handles
// both <input value="…"> and <textarea>…</textarea>).
function fpFieldValue(html, name) {
  const esc = name.replace(/[[\]]/g, "\\$&");
  const inp = new RegExp('name="' + esc + '"[^>]*\\bvalue="([^"]*)"', "i").exec(
    html,
  );
  if (inp) return fpUnescape(inp[1]);
  const ta = new RegExp(
    'name="' + esc + '"[^>]*>([\\s\\S]*?)</textarea>',
    "i",
  ).exec(html);
  return ta ? fpUnescape(ta[1]) : "";
}

function fpOfferIds(html) {
  const ids = new Set();
  // FunPay's trade page lists each offer as <a class="tc-item"
  // data-offer="123…">; the edit URL is just offerEdit?node=N (no offer param),
  // so the id lives in the data-offer attribute. Match that first, and keep the
  // ?offer= URL form as a fallback for any other page shape.
  const re = /data-offer="(\d+)"|[?&]offer=(\d+)/gi;
  let m;
  while ((m = re.exec(html))) ids.add(m[1] || m[2]);
  return ids;
}

async function fpGet(pathOrUrl, goldenKey, session) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : FP_BASE + pathOrUrl;
  const r = await axios.get(url, {
    headers: {
      Cookie: fpCookie(goldenKey, session),
      "User-Agent": FP_UA,
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: (s) => s >= 200 && s < 400,
  });
  return { html: String(r.data || ""), setCookie: r.headers["set-cookie"] };
}

function fpEncode(map) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(map)) {
    if (v === undefined || v === null) continue;
    p.append(k, String(v));
  }
  return p.toString();
}

async function fpPostOfferSave(goldenKey, session, body) {
  const r = await axios.post(FP_BASE + "/lots/offerSave", fpEncode(body), {
    headers: {
      Cookie: fpCookie(goldenKey, session),
      "User-Agent": FP_UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Accept: "application/json, text/javascript, */*; q=0.01",
      // FunPay's precondition check needs a same-origin Referer/Origin.
      Origin: "https://funpay.com",
      Referer:
        FP_BASE +
        "/lots/offerEdit?node=" +
        encodeURIComponent(body.node_id || ""),
    },
    timeout: 30000,
    validateStatus: () => true,
  });
  // A non-2xx (notably 428 "precondition required" — missing cookies/headers)
  // means the offer was NOT saved; never treat it as success.
  if (r.status < 200 || r.status >= 300) {
    throw new Error(
      "FunPay offerSave returned HTTP " +
        r.status +
        (r.status === 428
          ? " — session precondition failed (paste a fresh golden_key and retry)"
          : ""),
    );
  }
  let data = r.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      data = { raw: data.slice(0, 400) };
    }
  }
  // FunPay reports validation problems as { error: "<html…>" } or
  // { errors: {...} }; a plain { done: true } (or a url) means success.
  const errRaw = data && (data.error || data.msg);
  const hasErr =
    (errRaw && !data.done && !data.url) ||
    (data && data.errors && Object.keys(data.errors).length && !data.done);
  if (hasErr) {
    const msg = String(errRaw || JSON.stringify(data.errors))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300);
    throw new Error(msg || "FunPay rejected the offer");
  }
  return data;
}

// Load the offer editor for a category (optionally an existing offer) and
// return the session + nonces needed to (re)save it.
async function fpLoadEditor(goldenKey, nodeId, offerId) {
  let p = "/lots/offerEdit?node=" + encodeURIComponent(nodeId || "");
  if (offerId) p += "&offer=" + encodeURIComponent(offerId);
  const { html, setCookie } = await fpGet(p, goldenKey);
  const app = fpParseApp(html);
  const csrf = app.csrf || fpFieldValue(html, "csrf_token");
  if (!csrf) {
    throw new Error(
      "could not read FunPay CSRF token — the golden_key is likely expired",
    );
  }
  return {
    session: fpSessionCookie(setCookie),
    csrf,
    formCreatedAt: fpFieldValue(html, "form_created_at"),
    nodeId: fpFieldValue(html, "node_id") || String(nodeId || ""),
    html,
  };
}

async function funpayTest() {
  const keys = requireKeys("funpay");
  try {
    const { html } = await fpGet("/", keys.golden_key);
    const app = fpParseApp(html);
    if (!app.userId && !app.username) {
      throw new Error(
        "golden_key not accepted — copy a fresh one from a signed-in FunPay " +
          "session (Cookies → funpay.com → golden_key)",
      );
    }
    return {
      ok: true,
      detail: "Connected as " + (app.username || "user " + app.userId),
    };
  } catch (e) {
    if (e.response) throw apiError("FunPay test", e);
    throw new Error("FunPay test: " + e.message);
  }
}

// USD -> arbitrary currency, cached ~6h. FunPay offers are priced in whatever
// currency the seller's account uses, but the rest of the site works in USD, so
// convert at publish time when needed. USD is a 1:1 no-op; any other currency
// uses the live rate, falling back to a static estimate if the FX lookup fails.
let fxCache = { rates: null, until: 0 };
const FX_FALLBACK = { RUB: 90, EUR: 0.92 };
async function usdRate(currency) {
  const cur = String(currency || "USD").toUpperCase();
  if (cur === "USD") return 1;
  const now = Date.now();
  if (fxCache.rates && now < fxCache.until && Number(fxCache.rates[cur]) > 0) {
    return Number(fxCache.rates[cur]);
  }
  try {
    const r = await axios.get("https://open.er-api.com/v6/latest/USD", {
      timeout: 15000,
    });
    const rates = r.data && r.data.rates;
    if (rates && Number(rates[cur]) > 0) {
      fxCache = { rates, until: now + 6 * 60 * 60 * 1000 };
      return Number(rates[cur]);
    }
  } catch {
    /* fall through to fallback */
  }
  return (fxCache.rates && Number(fxCache.rates[cur])) || FX_FALLBACK[cur] || 1;
}

// Create a lot in a FunPay category (node). Returns { externalId, externalNode,
// url, note }. The offer id isn't in the save response, so it's recovered by
// diffing the category's offer ids before and after the create.
//
// The offer's price is in the FunPay account's own currency: pass `currency`
// (USD/EUR/RUB) to convert the site's USD price at the live rate, or
// `priceOverride` to set the amount in that currency directly (no conversion).
async function funpayPublish({
  nodeId,
  title,
  description,
  priceUsd,
  currency,
  priceOverride,
  amount,
  active,
  autoDelivery,
  secrets,
  paymentMsg,
}) {
  const keys = requireKeys("funpay");
  const node = String(nodeId || "").trim();
  if (!/^\d+$/.test(node)) {
    throw new Error("FunPay category node id must be numeric (e.g. 2430)");
  }
  const cur = String(currency || "USD").toUpperCase();
  let price = Number(priceOverride);
  let fxNote = "";
  if (!Number.isFinite(price) || price <= 0) {
    if (cur === "USD") {
      price = Number(priceUsd);
    } else {
      const rate = await usdRate(cur);
      price = Math.round(Number(priceUsd) * rate * 100) / 100;
      fxNote =
        "Priced at " +
        price +
        " " +
        cur +
        " (~$" +
        Number(priceUsd) +
        " @ " +
        rate.toFixed(4) +
        " " +
        cur +
        "/$). ";
    }
  }
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("FunPay needs a price above 0");
  }
  const goldenKey = keys.golden_key;

  let before = new Set();
  try {
    const { html } = await fpGet("/lots/" + node + "/trade", goldenKey);
    before = fpOfferIds(html);
  } catch {
    /* non-fatal — we just won't be able to diff for the new id */
  }

  const editor = await fpLoadEditor(goldenKey, node);
  // FunPay caps offer fields; over the limit it rejects the whole save with a
  // generic "Please fill out every field." A 51-item bundle description runs
  // ~1800 chars, so trim to a safe length (verified: 1500 saves, 1800 fails).
  const t = String(title || "").slice(0, 200);
  let d = String(description || "").slice(0, 1000);
  if (String(description || "").length > 1000) d = d.slice(0, 997) + "…";
  // Russian runs longer than English, so re-apply the cap after translating.
  let dRu = await translateEnToRu(d);
  if (dRu.length > 1000) dRu = dRu.slice(0, 997) + "…";
  const lines = (
    Array.isArray(secrets) ? secrets : String(secrets || "").split("\n")
  )
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const auto = !!autoDelivery && lines.length > 0;
  const msg = (paymentMsg ? String(paymentMsg) : "").slice(0, 1500);

  const body = {
    csrf_token: editor.csrf,
    form_created_at: editor.formCreatedAt,
    offer_id: "0",
    node_id: node,
    location: "",
    deleted: "",
    "fields[summary][en]": t,
    "fields[summary][ru]": t,
    "fields[desc][en]": d,
    "fields[desc][ru]": dRu,
    "fields[payment_msg][en]": msg,
    "fields[payment_msg][ru]": msg,
    price: String(price),
    amount: String(Math.max(1, parseInt(amount, 10) || 1)),
  };
  if (auto) {
    body.auto_delivery = "on";
    body.secrets = lines.join("\n");
  }
  // An unchecked "active" box is simply omitted (HTML form semantics), which
  // saves the offer off-sale.
  if (active !== false) body.active = "on";

  await fpPostOfferSave(goldenKey, editor.session, body);

  let offerId = "";
  try {
    const { html } = await fpGet("/lots/" + node + "/trade", goldenKey);
    const after = fpOfferIds(html);
    for (const id of after) {
      if (!before.has(id)) {
        offerId = id;
        break;
      }
    }
  } catch {
    /* leave blank; the row still records, delist just needs the id */
  }

  return {
    externalId: offerId || "node" + node + "-" + Date.now(),
    externalNode: node,
    url: offerId
      ? "https://funpay.com/en/lots/offer?id=" + offerId
      : "https://funpay.com/en/lots/" + node + "/trade",
    note:
      fxNote +
      (auto ? "auto-delivery: " + lines.length + " item(s). " : "") +
      (offerId
        ? ""
        : "Couldn't auto-detect the new offer id — delist it on FunPay manually."),
  };
}

// FunPay has no per-field update, so taking an offer off sale means reloading
// its editor and re-saving every current value with the `active` box dropped.
async function funpayDelist(offerId, nodeId) {
  const keys = requireKeys("funpay");
  if (!offerId || /^node\d+-/.test(String(offerId))) {
    throw new Error("no FunPay offer id on record — delist it on FunPay");
  }
  const goldenKey = keys.golden_key;
  const editor = await fpLoadEditor(goldenKey, nodeId, offerId);
  const h = editor.html;
  const body = {
    csrf_token: editor.csrf,
    form_created_at: editor.formCreatedAt,
    offer_id: String(offerId),
    node_id: editor.nodeId,
    location: fpFieldValue(h, "location"),
    deleted: "",
    "fields[summary][en]": fpFieldValue(h, "fields[summary][en]"),
    "fields[summary][ru]": fpFieldValue(h, "fields[summary][ru]"),
    "fields[desc][en]": fpFieldValue(h, "fields[desc][en]"),
    "fields[desc][ru]": fpFieldValue(h, "fields[desc][ru]"),
    "fields[payment_msg][en]": fpFieldValue(h, "fields[payment_msg][en]"),
    "fields[payment_msg][ru]": fpFieldValue(h, "fields[payment_msg][ru]"),
    price: fpFieldValue(h, "price"),
    amount: fpFieldValue(h, "amount") || "1",
    // `active` intentionally omitted → off sale.
  };
  await fpPostOfferSave(goldenKey, editor.session, body);
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
  digisellerProductStock,
  digisellerDelist,
  g2gTest,
  g2gServices,
  g2gBrands,
  g2gProducts,
  g2gAttributes,
  g2gPublish,
  g2gUpdateOffer,
  g2gGetOffer,
  g2gListOffers,
  g2gDelist,
  ggselTest,
  ggselCategories,
  ggselPublish,
  ggselAddProducts,
  ggselOfferStock,
  ggselEnableAutoselling,
  ggselFinalizeStock,
  ggselDelist,
  funpayTest,
  funpayPublish,
  funpayDelist,
};
