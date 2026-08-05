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
  // ZeusX has no public API either — the credential is the seller session's
  // access_token (~7-day life). The refresh_token is reusable (does not rotate),
  // so the server mints fresh access tokens from it via /user/exchange-token and
  // the operator never has to re-paste — see zeusxRefreshAccessToken +
  // utils/zeusxTokenRefresher.
  zeusx: ["accessToken", "refreshToken"],
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
      // Bin the half-built draft. Left behind it is invisible stock the seller
      // has to clean up by hand, and Gameflip then rejects the next attempt
      // with "code for digital goods already exists" because the same
      // credentials are still attached to the abandoned draft.
      await axios
        .delete(GF_API + "/listing/" + listingId, {
          headers: gfHeaders(keys),
          timeout: 20000,
        })
        .catch(() => {});
      throw apiError(
        "Gameflip could not attach the delivery content (draft " +
          listingId +
          " discarded)",
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

// Every listing id of ours currently in a given status, in ONE paged query.
// The watcher used to GET each listing separately; at ~150 live listings that
// burns Gameflip's rate limit on every tick, and the 429s it earns look exactly
// like "not sold yet" — so sales went unnoticed and their chains never relisted.
async function gameflipListingIdsByStatus(status) {
  const keys = requireKeys("gameflip");
  const me = await axios.get(GF_API + "/account/me/profile", {
    headers: gfHeaders(keys),
    timeout: 20000,
  });
  const owner = ((me.data || {}).data || {}).owner;
  if (!owner) throw new Error("Gameflip profile has no owner id");
  const ids = new Set();
  for (let start = 0; start < 2000; start += 100) {
    const r = await axios.get(GF_API + "/listing", {
      headers: gfHeaders(keys),
      params: { owner, status, limit: 100, start },
      timeout: 25000,
    });
    const rows = ((r.data || {}).data || []).filter(Boolean);
    rows.forEach((x) => ids.add(x.id));
    if (rows.length < 100) break;
  }
  return ids;
}

// Gameflip's status patches cannot be trusted on the way DOWN either. The
// restore below already documents the lie — under the rate limiter Gameflip
// answers 200 to a status patch and leaves the listing where it was — but the
// take-off-sale step trusted its 200, so when the limiter swallowed it the very
// next patch hit a still-onsale listing and came back "Cannot change 'price'
// when status is onsale". A json-patch is atomic, so the markup, the retitle and
// the held-back stock release were all lost together, which is exactly the
// failure this whole off-sale dance exists to prevent.
//
// So: read the status back and retry, same shape as the restore. Returns once
// the listing really is off sale; throws (having changed nothing that matters)
// otherwise, leaving the caller to retry on its next sweep.
async function gfTakeOffSale(listingId, setStatus, label) {
  let err = null;
  for (const w of [0, 20000, 60000]) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try {
      await setStatus("draft");
    } catch (e) {
      err = e;
      continue;
    }
    try {
      if ((await gameflipListingStatus(listingId)) !== "onsale") return;
      err = new Error("still onsale after the status patch (rate-limited)");
    } catch (e) {
      err = e;
    }
  }
  throw apiError(label + " (could not take off sale)", err || new Error("?"));
}

// A listing whose status we cannot read must not be patched: "onsale" decides
// whether the edit needs an off-sale window at all, and guessing it wrong either
// loses the whole atomic patch (guessed draft, was onsale) or ends with a
// listing put on sale that the owner had parked in draft (guessed onsale, was
// draft). Retry the read, then give up and let the caller retry later.
async function gfReadStatusOrThrow(listingId, label) {
  let err = null;
  for (const w of [0, 5000, 15000]) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try {
      return await gameflipListingStatus(listingId);
    } catch (e) {
      err = e;
    }
  }
  throw apiError(
    label + " (could not read listing status, so it was left untouched)",
    err || new Error("?"),
  );
}

// Patch an existing listing's price (cents) and optionally its name and
// description — used for the post-event scarcity markup once a drop campaign
// ends and the items become unobtainable.
//
// Gameflip refuses to edit a LIVE listing: "Cannot change 'price' when status
// is onsale" (same for 'name'), and because a json-patch is atomic one rejected
// op fails the whole request. Silently, this broke every post-event reprice —
// the markup, the retitle AND the held-back stock release all went down with
// it. So take the listing off sale, patch, and put it straight back. The
// restore is retried and its failure outranks the patch's: a listing left in
// draft is off the market entirely, which is far worse than stale text.
async function gameflipReprice(
  listingId,
  { priceUsd, title, description, imagePath } = {},
) {
  const keys = requireKeys("gameflip");
  const ops = [];
  const cents = Math.round(Number(priceUsd) * 100);
  if (Number.isFinite(cents) && cents >= 75) {
    ops.push({ op: "replace", path: "/price", value: cents });
  }
  if (title) {
    ops.push({
      op: "replace",
      path: "/name",
      value: String(title).slice(0, 120),
    });
  }
  if (description) {
    ops.push({
      op: "replace",
      path: "/description",
      value: String(description).slice(0, 5000),
    });
  }
  // A stacked bundle grows its cover too: swap in a freshly generated grid image
  // so the photo matches the (now larger) item set instead of showing the
  // pre-stack picture with items missing. cover_photo, like price, is rejected
  // while the listing is onsale, so the swap rides the SAME off-sale window as
  // the reprice — opening a second draft/onsale cycle would double the exposure
  // to the rate limiter the restore backoff below already fights.
  const wantCover = !!(imagePath && fs.existsSync(imagePath));
  if (!ops.length && !wantCover) return;
  const patch = (body) =>
    axios.patch(GF_API + "/listing/" + listingId, body, {
      headers: {
        ...gfHeaders(keys),
        "Content-Type": "application/json-patch+json",
      },
      timeout: 20000,
    });
  const setStatus = (v) =>
    patch([{ op: "replace", path: "/status", value: v }]);
  // Upload the new cover and delete the photos it replaces. Only valid while the
  // listing is in draft; every caller below runs it inside an off-sale window.
  // Mirrors gameflipReplaceCover: a stale-photo delete the limiter rejects is
  // cosmetic, so it retries a little and gives up without failing the swap.
  const swapCover = async () => {
    let stale = [];
    try {
      const cur = await axios.get(GF_API + "/listing/" + listingId, {
        headers: gfHeaders(keys),
        timeout: 20000,
      });
      stale = Object.keys(((cur.data || {}).data || {}).photo || {});
    } catch {
      stale = [];
    }
    await gfUploadPhoto(keys, listingId, imagePath);
    if (stale.length) {
      const delOps = stale.map((id) => ({
        op: "replace",
        path: "/photo/" + id + "/status",
        value: "deleted",
      }));
      for (const w of [0, 15000, 45000]) {
        if (w) await new Promise((r) => setTimeout(r, w));
        try {
          await patch(delOps);
          break;
        } catch (e) {
          if (!e.response || e.response.status !== 429) break;
        }
      }
    }
  };

  const live = await gfReadStatusOrThrow(listingId, "Gameflip reprice");
  if (live !== "onsale") {
    // Already off sale: apply the ops and swap the cover directly, no toggle.
    if (ops.length) {
      try {
        await patch(ops);
      } catch (e) {
        throw apiError("Gameflip reprice", e);
      }
    }
    if (wantCover) {
      try {
        await swapCover();
      } catch (e) {
        throw apiError("Gameflip cover", e);
      }
    }
    return;
  }

  await gfTakeOffSale(listingId, setStatus, "Gameflip reprice");
  let patchErr = null;
  if (ops.length) {
    try {
      await patch(ops);
    } catch (e) {
      patchErr = apiError("Gameflip reprice", e);
    }
  }
  let coverErr = null;
  if (wantCover) {
    try {
      await swapCover();
    } catch (e) {
      coverErr = apiError("Gameflip cover", e);
    }
  }
  // Putting it back is the step that must not be trusted blindly: under its
  // rate limiter Gameflip answers 200 to the status patch yet leaves the
  // listing in "ready" — complete, public, but NOT purchasable. So verify by
  // reading the status back, and since the limiter's window is minutes wide
  // (429 "Too many attempts"), back off in tens of seconds rather than ms.
  let restored = false;
  let restoreErr = null;
  const waits = [0, 20000, 60000, 120000];
  for (const w of waits) {
    if (w) await new Promise((r) => setTimeout(r, w));
    try {
      await setStatus("onsale");
    } catch (e) {
      restoreErr = e;
      continue;
    }
    try {
      if ((await gameflipListingStatus(listingId)) === "onsale") {
        restored = true;
        restoreErr = null;
        break;
      }
      restoreErr = new Error(
        'status settled on "ready" instead of "onsale" (rate-limited)',
      );
    } catch (e) {
      restoreErr = e;
    }
  }
  if (!restored) {
    throw new Error(
      "Gameflip listing " +
        listingId +
        " IS NOT BACK ON SALE (left in draft/ready, so nobody can buy it) —" +
        " put it back on sale manually. " +
        ((restoreErr && restoreErr.message) || "unknown error"),
    );
  }
  if (patchErr) throw patchErr;
  if (coverErr) throw coverErr;
}

// Swap a live listing's cover photo (an oversized upload renders broken on
// Gameflip, so a re-generated one has to replace it). Like a reprice, the
// cover_photo field is rejected while the listing is onsale — "Cannot change
// 'cover_photo' when status is onsale" — so take it off sale, patch, and put
// it back with the same verified restore as gameflipReprice: Gameflip's rate
// limiter can answer 200 yet leave the listing in "ready", i.e. not buyable.
async function gameflipReplaceCover(listingId, imagePath) {
  const keys = requireKeys("gameflip");
  const patch = (body) =>
    axios.patch(GF_API + "/listing/" + listingId, body, {
      headers: {
        ...gfHeaders(keys),
        "Content-Type": "application/json-patch+json",
      },
      timeout: 20000,
    });
  const setStatus = (v) =>
    patch([{ op: "replace", path: "/status", value: v }]);

  const live = await gfReadStatusOrThrow(listingId, "Gameflip cover");
  if (live === "onsale") {
    await gfTakeOffSale(listingId, setStatus, "Gameflip cover");
  }
  // Photos already on the listing (the broken one, plus any half-finished
  // upload) stay in the gallery unless they are explicitly deleted, so the
  // buyer would still see the bad image next to the new cover.
  let stale = [];
  try {
    const cur = await axios.get(GF_API + "/listing/" + listingId, {
      headers: gfHeaders(keys),
      timeout: 20000,
    });
    stale = Object.keys(((cur.data || {}).data || {}).photo || {});
  } catch {
    stale = [];
  }
  let uploadErr = null;
  try {
    await gfUploadPhoto(keys, listingId, imagePath);
    if (stale.length) {
      const ops = stale.map((id) => ({
        op: "replace",
        path: "/photo/" + id + "/status",
        value: "deleted",
      }));
      // Gameflip's limiter rejects the delete right after an upload; a stale
      // photo left behind is cosmetic, so retry a few times and give up.
      for (const w of [0, 15000, 45000]) {
        if (w) await new Promise((r) => setTimeout(r, w));
        try {
          await patch(ops);
          break;
        } catch (e) {
          if (!e.response || e.response.status !== 429) break;
        }
      }
    }
  } catch (e) {
    uploadErr = apiError("Gameflip cover", e);
  }
  if (live === "onsale") {
    let restored = false;
    let restoreErr = null;
    for (const w of [0, 20000, 60000, 120000]) {
      if (w) await new Promise((r) => setTimeout(r, w));
      try {
        await setStatus("onsale");
      } catch (e) {
        restoreErr = e;
        continue;
      }
      try {
        if ((await gameflipListingStatus(listingId)) === "onsale") {
          restored = true;
          restoreErr = null;
          break;
        }
        restoreErr = new Error(
          'status settled on "ready" instead of "onsale" (rate-limited)',
        );
      } catch (e) {
        restoreErr = e;
      }
    }
    if (!restored) {
      throw new Error(
        "Gameflip listing " +
          listingId +
          " IS NOT BACK ON SALE (left in draft/ready, so nobody can buy it) —" +
          " put it back on sale manually. " +
          ((restoreErr && restoreErr.message) || "unknown error"),
      );
    }
  }
  if (uploadErr) throw uploadErr;
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

// Digiseller's API is occasionally slow enough to blow the 20s timeout.
// Retry transient failures (timeouts, resets, 5xx) with a short backoff —
// real auth errors (retval != 0, 4xx) still fail on the first attempt.
function isTransientNetError(e) {
  if (!e) return false;
  if (e.code === "ECONNABORTED" || e.code === "ECONNRESET") return true;
  if (e.response && e.response.status >= 500) return true;
  return /timeout|socket hang up|network/i.test(String(e.message || ""));
}

async function withNetRetries(fn, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isTransientNetError(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw last;
}

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
    const r = await withNetRetries(() =>
      axios.post(
        DS_API + "/apilogin",
        { seller_id: Number(keys.sellerId), timestamp, sign },
        { headers: { "Content-Type": "application/json" }, timeout: 20000 },
      ),
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
    throw dsApiError("Digiseller login", e);
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

// A Digiseller token inherits the permission set assigned to its API key in
// the seller panel (Settings → API). Read calls (login, categories) work with
// a read-only key, but every mutating call — create, edit/base, content/add —
// comes back retval -1 / errors[].code "auth-0" ("Access denied" /
// "Недостаточно прав") when the key lacks product-management rights. The
// failure arrives two ways: as an axios HTTP-4xx whose response body is that
// retval object, or as a thrown Error whose message already carries the
// auth-0 text. Detect both.
function dsIsPermissionDenied(e) {
  const d = e && e.response && e.response.data;
  if (
    d &&
    Array.isArray(d.errors) &&
    d.errors.some((x) => x && String(x.code || "").toLowerCase() === "auth-0")
  ) {
    return true;
  }
  return /auth-0|access denied|недостаточно прав/i.test(
    String((e && e.message) || ""),
  );
}

// Surface an auth-0 denial as an actionable instruction instead of raw JSON,
// so the auto-farm UI tells the operator exactly which permission to grant.
function dsApiError(prefix, e) {
  if (dsIsPermissionDenied(e)) {
    const err = new Error(
      prefix +
        ': Digiseller API key lacks product-management rights (auth-0 "Access' +
        ' denied"). In the Digiseller panel → Settings → API, enable "Products' +
        ' / Create" and "Products / Edit" for this key, then retry — the token' +
        " inherits the key's rights, so no re-login is needed.",
    );
    err.status = e.response && e.response.status;
    err.permission = true;
    return err;
  }
  return apiError(prefix, e);
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
    throw dsApiError("Digiseller categories", e);
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
    throw dsApiError("Digiseller attributes", e);
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
    throw dsApiError("Digiseller create", e);
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
    const ext = String(path.extname(imagePath) || ".png").toLowerCase();
    form.append(field, buf, {
      filename: "cover" + (ext === ".jpeg" ? ".jpg" : ext),
      contentType:
        ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : "image/png",
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
  throw dsApiError("Digiseller image upload", lastErr);
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
    // Digiseller answers with the id of every unit it created, in the order
    // they were sent: {"content":[{"content_id":299264577,"serial":null}]}.
    // Capturing them is the ONLY way to delete a single bad unit later —
    // there is no endpoint that lists a product's content (verified live
    // 2026-07-29: every list/get shape 404s, and GET on /product/content is
    // 405). So an id we fail to record here can never be targeted again.
    const contentIds = Array.isArray(d.content)
      ? d.content.map((c) => (c && c.content_id != null ? String(c.content_id) : ""))
      : [];
    return { added: content.length, contentIds };
  } catch (e) {
    throw dsApiError("Digiseller add content", e);
  }
}

// Remove ONE delivery unit from a product. Both ids go in the query string and
// are PascalCase — a JSON body is ignored and the call answers "Field
// ProductId is required" (verified live 2026-07-29, along with the successful
// add->delete round trip on product 6001876).
async function digisellerRemoveContent(productId, contentId) {
  const token = await digisellerToken();
  try {
    const r = await axios.delete(
      DS_API +
        "/product/content?token=" +
        encodeURIComponent(token) +
        "&ProductId=" +
        Number(productId) +
        "&ContentId=" +
        Number(contentId),
      { timeout: 25000 },
    );
    const d = r.data || {};
    if (d.retval !== undefined && String(d.retval) !== "0") {
      throw new Error(dsErrorText(d));
    }
    return { removed: true };
  } catch (e) {
    throw dsApiError("Digiseller remove content", e);
  }
}

// How many delivery units a product still has. The PUBLIC product-info
// endpoint omits num_in_stock unless "show remaining quantity" is enabled on
// the product, but the TOKEN-authenticated read returns it regardless
// (verified live 2026-07-28: public read shows only show_rest, the token read
// shows num_in_stock). Reading with the seller token is what lets the guardian
// auto-feed digiseller listings. Returns a number, or null when it genuinely
// can't be determined.
async function digisellerProductStock(productId) {
  let qs = "";
  try {
    const token = await digisellerToken();
    qs = "?token=" + encodeURIComponent(token) + "&showHiddenVariants=true";
  } catch {
    // Keys unavailable — fall back to the public read (may carry no stock).
    qs = "";
  }
  try {
    const r = await axios.get(
      DS_API + "/products/" + encodeURIComponent(productId) + "/data" + qs,
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
    // Authenticated read still carried no stock figure — only expected on the
    // public fallback (no seller token) or an unusual product type.
    console.error(
      "digiseller stock unreadable for product " +
        productId +
        ": response had no num_in_stock/in_stock/count_goods" +
        (qs ? " (authenticated read)" : " (public read — no seller token)"),
    );
    return null;
  } catch (e) {
    // A genuine transport/API failure is a different problem from the above and
    // must not look the same in the logs.
    console.error(
      "digiseller stock request failed for product " +
        productId +
        ": " +
        (e.response
          ? "HTTP " + e.response.status
          : e.message || String(e)),
    );
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
    throw dsApiError("Digiseller delist", e);
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

// Edit an existing offer's text (and optionally its price) in place. GGSel
// supports PATCH /offers/{id} — verified live 2026-07-30 — so a stale title can
// be corrected without delisting, which would lose the offer id, its attached
// stock and its catalog placement. (Digiseller has no equivalent: every
// /product/edit/* path 404s while /product/create/* answers, so a Digiseller
// product's text can only be changed by republishing it.)
async function ggselUpdateOffer(offerId, { title, description, priceRub } = {}) {
  const keys = requireKeys("ggsel");
  const body = {};
  if (title) {
    // Mirror ggselPublish: the English title is used for both locales.
    const t = String(title).slice(0, 200);
    body.title_ru = t;
    body.title_en = t;
  }
  if (description) {
    const d = String(description).slice(0, 5000);
    body.description_en = d;
    body.description_ru = (await translateEnToRu(d)).slice(0, 5000);
  }
  const p = Number(priceRub);
  if (Number.isFinite(p) && p > 0) body.price = p;
  if (!Object.keys(body).length) return;
  try {
    await axios.patch(GG_API + "/offers/" + encodeURIComponent(offerId), body, {
      headers: ggHeaders(keys),
      timeout: 30000,
    });
  } catch (e) {
    throw apiError("GGSel update", e);
  }
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

/* ------------------- GGSel per-game category resolution ------------------ */
// GGSel's catalog has a per-game "Twitch Drops" section (often with a lower
// fee than generic categories — 2% vs 15%+). Resolution order, verified
// against the live API and the seller's own 58-offer history:
//   1. The seller's own past offers: an offer whose category tree reads
//      "Games > {Game} > Twitch Drops" for this game — reuse its category.
//   2. Catalog search: find the game node under Игры/Games, list its
//      children, pick the "Twitch Drops" child.
//   3. The game's "Accounts/Аккаунты" child (how the seller listed games
//      that lack a Twitch Drops section, e.g. Where Winds Meet).
// Returns "" when nothing matches; caller decides the final fallback.

function normGame(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, " ")
    .trim();
}

function gameMatches(a, b) {
  const na = normGame(a);
  const nb = normGame(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Own-offer category history, cached 12h (building it costs one detail call
// per offer).
let ggCatHistory = { until: 0, rows: [] };

async function ggselCategoryHistory() {
  if (Date.now() < ggCatHistory.until) return ggCatHistory.rows;
  const keys = requireKeys("ggsel");
  const list = await axios.get(GG_API + "/offers?limit=100", {
    headers: ggHeaders(keys),
    timeout: 20000,
  });
  const rows = [];
  for (const o of (list.data && list.data.data) || []) {
    if (!o || !o.id) continue;
    try {
      const det = await axios.get(GG_API + "/offers/" + o.id, {
        headers: ggHeaders(keys),
        timeout: 20000,
      });
      const cat = det.data && det.data.data && det.data.data.category;
      if (cat && cat.id && cat.tree) {
        rows.push({ id: String(cat.id), tree: String(cat.tree) });
      }
    } catch {
      /* skip unreadable offers */
    }
  }
  ggCatHistory = { until: Date.now() + 12 * 3600 * 1000, rows };
  return rows;
}

async function ggselResolveCategoryId(game) {
  const keys = requireKeys("ggsel");

  // 1) Own history: "Games > {Game} > Twitch Drops" (tree root may be
  //    localized as Игры).
  try {
    for (const row of await ggselCategoryHistory()) {
      const parts = row.tree.split(">").map((x) => x.trim());
      if (parts.length < 3) continue;
      if (!/twitch/i.test(parts[parts.length - 1])) continue;
      if (gameMatches(parts[1], game)) return row.id;
    }
  } catch {
    /* fall through to search */
  }

  // 2) Catalog search: game node under Игры/Games, then its Twitch child.
  let parent = null;
  try {
    const r = await axios.get(
      GG_API + "/categories/search?q=" + encodeURIComponent(game),
      { headers: ggHeaders(keys), timeout: 20000 },
    );
    for (const h of (r.data && r.data.data) || []) {
      const root = String(h.tree || "")
        .split(">")[0]
        .trim();
      if (!h.has_children) continue;
      if (root !== "\u0418\u0433\u0440\u044b" && root !== "Games") continue;
      if (!gameMatches(h.title, game)) continue;
      parent = h;
      break;
    }
  } catch {
    return "";
  }
  if (!parent) return "";

  try {
    const kids = await axios.get(
      GG_API + "/categories?parent_id=" + parent.id,
      { headers: ggHeaders(keys), timeout: 20000 },
    );
    const rows = (kids.data && kids.data.data) || [];
    const twitch = rows.find((k) => /twitch/i.test(String(k.title || "")));
    if (twitch) return String(twitch.id);
    // 3) The game's accounts section — the seller's own fallback pattern.
    const acc = rows.find((k) =>
      /^(accounts|\u0430\u043a\u043a\u0430\u0443\u043d\u0442\u044b)$/i.test(
        String(k.title || "").trim(),
      ),
    );
    if (acc) return String(acc.id);
  } catch {
    /* nothing */
  }
  return "";
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

// Parse every named field of the offer editor form (inputs, selects,
// textareas) so a re-save can round-trip values we don't model — category
// nodes differ in which extra fields they carry. Checkboxes/radios are
// included only when checked (HTML form semantics: unchecked = omitted).
function fpFormValues(html) {
  const out = {};
  const inputRe = /<input\b[^>]*>/gi;
  let m;
  while ((m = inputRe.exec(html))) {
    const tag = m[0];
    const name = /name="([^"]+)"/.exec(tag);
    if (!name) continue;
    const type = ((/type="([^"]+)"/.exec(tag) || [])[1] || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "file") continue;
    const val = /value="([^"]*)"/.exec(tag);
    if (type === "checkbox" || type === "radio") {
      if (/\bchecked\b/i.test(tag)) {
        out[name[1]] = val ? fpUnescape(val[1]) : "on";
      }
      continue;
    }
    out[name[1]] = val ? fpUnescape(val[1]) : "";
  }
  const taRe = /<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(html))) out[m[1]] = fpUnescape(m[2]);
  const selRe = /<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi;
  while ((m = selRe.exec(html))) {
    const opt = /<option\b[^>]*\bselected\b[^>]*>/i.exec(m[2]);
    const v = opt && /value="([^"]*)"/.exec(opt[0]);
    out[m[1]] = v ? fpUnescape(v[1]) : "";
  }
  return out;
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

// Edit the UNDELIVERED auto-delivery pool of an existing FunPay offer: drop
// the lines belonging to `removeLogins` (matched on the "login:" prefix of
// each login:password secret) and append `addLines`. FunPay has no update
// API, so this reloads the editor and re-saves every current field with the
// new pool — the editor's secrets textarea is the source of truth for which
// lines are still undelivered, which is what lets a caller tell "burned line
// pulled from the pool" apart from "line already handed to a buyer".
// `activate`: true/false forces the active box; null keeps its current state.
// An offer whose pool ends up empty is saved off-sale (FunPay would otherwise
// sell with nothing to deliver).
async function funpayUpdateSecrets(
  offerId,
  nodeId,
  { removeLogins = [], addLines = [], activate = null } = {},
) {
  const keys = requireKeys("funpay");
  if (!offerId || /^node\d+-/.test(String(offerId))) {
    throw new Error("no FunPay offer id on record — edit it on FunPay");
  }
  const goldenKey = keys.golden_key;
  const editor = await fpLoadEditor(goldenKey, nodeId, offerId);
  const form = fpFormValues(editor.html);
  const pool = String(form.secrets || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const prefixes = removeLogins
    .map((l) => String(l || "").trim().toLowerCase() + ":")
    .filter((p) => p.length > 1);
  const kept = [];
  const removedLines = [];
  for (const line of pool) {
    const burned = prefixes.some((p) => line.toLowerCase().startsWith(p));
    (burned ? removedLines : kept).push(line);
  }
  const have = new Set(kept);
  let added = 0;
  for (const raw of addLines) {
    const line = String(raw || "").trim();
    if (!line || have.has(line)) continue;
    kept.push(line);
    have.add(line);
    added++;
  }
  const wasActive = form.active != null;
  const body = {
    ...form,
    csrf_token: editor.csrf,
    form_created_at: form.form_created_at || editor.formCreatedAt,
    offer_id: String(offerId),
    node_id: form.node_id || editor.nodeId,
    location: form.location || "",
    deleted: "",
    amount: form.amount || "1",
  };
  delete body.secrets;
  delete body.auto_delivery;
  delete body.active;
  if (kept.length) {
    body.auto_delivery = "on";
    body.secrets = kept.join("\n");
  }
  const on = (activate === null ? wasActive : !!activate) && kept.length > 0;
  if (on) body.active = "on";
  await fpPostOfferSave(goldenKey, editor.session, body);
  return {
    removed: removedLines.length,
    added,
    pool: kept.length,
    active: on,
  };
}

// ------------------------------------------------------------------
// ZeusX (no public API — the seller panel's own JSON endpoints)
//
// zeusx.com itself sits behind Cloudflare, but api.zeusx.com answers a plain
// bearer token (the seller session's access_token). A listing needs the game's
// "service category base" id plus that base's required attributes, which are
// per game and are configured under autoFarm.zeusxGames.
// ------------------------------------------------------------------
const ZX_API = "https://api.zeusx.com/v1";
// ZeusX refuses to create or update an offer below this.
const ZX_MIN_PRICE = 1;

function zxHeaders(keys) {
  return {
    Authorization: "Bearer " + keys.accessToken,
    Origin: "https://zeusx.com",
    Referer: "https://zeusx.com/",
    "Content-Type": "application/json",
    "zeusx-currency": "USD",
  };
}

function zxError(what, e) {
  if (e && e.__zeusx) return e;
  const body = e.response && e.response.data;
  const msg =
    (body && body.error && (body.error.description || body.error.message)) ||
    (body && body.message) ||
    e.message;
  return new Error(what + ": " + String(msg).slice(0, 300));
}

// The API answers 200 with { isSuccess: false, error } for business failures.
function zxData(what, r) {
  const body = r.data || {};
  if (body.isSuccess === false) {
    const err = body.error || {};
    const out = new Error(
      what + ": " + String(err.description || err.message || "failed").slice(0, 300),
    );
    out.__zeusx = true;
    throw out;
  }
  return body.data;
}

// Milliseconds until the JWT's `exp`; negative if already expired, +Infinity if
// unreadable (so a token we can't parse is never treated as expiring).
function zxTokenMsLeft(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split(".")[1], "base64").toString("utf8"),
    );
    if (!payload.exp) return Infinity;
    return payload.exp * 1000 - Date.now();
  } catch {
    return Infinity;
  }
}

// Exchange the stored (reusable) refresh_token for a fresh access_token and save
// it. ZeusX's refresh_token does NOT rotate, so this can run indefinitely — the
// operator pastes a session once and never again. No-op-throws if no refresh
// token was ever stored.
async function zeusxRefreshAccessToken() {
  const keys = getKeys("zeusx");
  if (!keys.refreshToken) {
    throw new Error(
      "ZeusX refresh: no refresh token stored — paste a fresh ZeusX session once to enable auto-refresh",
    );
  }
  let body;
  try {
    const r = await axios.post(
      ZX_API + "/user/exchange-token",
      { access_token: keys.accessToken || "", refresh_token: keys.refreshToken },
      {
        headers: {
          Origin: "https://zeusx.com",
          Referer: "https://zeusx.com/",
          "Content-Type": "application/json",
          "zeusx-currency": "USD",
        },
        timeout: 20000,
      },
    );
    body = r.data || {};
  } catch (e) {
    throw zxError("ZeusX refresh", e);
  }
  if (body.isSuccess === false) {
    throw new Error("ZeusX refresh: " + JSON.stringify(body.error || {}).slice(0, 200));
  }
  const data = body.data || body;
  const access = data.access_token || data.accessToken || data.token;
  const refresh = data.refresh_token || data.refreshToken || keys.refreshToken;
  if (!access) throw new Error("ZeusX refresh: no access_token in response");
  await setKeys("zeusx", { accessToken: access, refreshToken: refresh });
  return access;
}

// Refresh proactively when the access_token is within `withinMs` of expiry (and
// we have a refresh token to do it with). Returns true if it refreshed. Safe to
// call often — it only hits the network when actually near expiry.
async function zeusxEnsureFreshToken(withinMs) {
  const keys = getKeys("zeusx");
  if (!keys.accessToken || !keys.refreshToken) return false;
  const margin = Number(withinMs) || 2 * 24 * 60 * 60 * 1000; // default 2 days
  if (zxTokenMsLeft(keys.accessToken) > margin) return false;
  await zeusxRefreshAccessToken();
  return true;
}

async function zeusxTest() {
  const keys = requireKeys("zeusx");
  try {
    const r = await axios.get(ZX_API + "/user/me", {
      headers: zxHeaders(keys),
      timeout: 20000,
    });
    const me = zxData("ZeusX", r) || {};
    return {
      ok: true,
      detail: "Signed in as " + (me.username || me.display_name || me.id || "seller"),
    };
  } catch (e) {
    throw zxError("ZeusX test", e);
  }
}

// Attributes a listing must carry for one game category (Rank, Tier, ...).
async function zeusxBaseAttributes(serviceCategoryBaseId) {
  const keys = requireKeys("zeusx");
  try {
    const r = await axios.get(
      ZX_API +
        "/base-attribute/get-attributes?service_category_base_id=" +
        encodeURIComponent(serviceCategoryBaseId),
      { headers: zxHeaders(keys), timeout: 20000 },
    );
    return zxData("ZeusX attributes", r) || [];
  } catch (e) {
    throw zxError("ZeusX attributes", e);
  }
}

// Required attributes with no configured answer get the base's first option,
// so publishing never dies on a cosmetic field we do not model.
async function zeusxAttributeValues(serviceCategoryBaseId, configured) {
  const chosen = new Map(
    (Array.isArray(configured) ? configured : []).map((a) => [
      String(a.base_attribute_id || a.attributeId),
      String(a.base_attribute_value || a.attributeValueId),
    ]),
  );
  const attrs = await zeusxBaseAttributes(serviceCategoryBaseId);
  const out = [];
  for (const attr of attrs) {
    const id = String(attr.id || attr.base_attribute_id || "");
    if (!id) continue;
    const options = attr.base_attribute_options || [];
    let value = chosen.get(id);
    if (!value) {
      if (!attr.is_required && !attr.required) continue;
      const first = options.find((o) => o.is_active !== false);
      if (!first) continue;
      value = String(first.id);
    }
    out.push({ base_attribute_id: id, base_attribute_value: String(value) });
  }
  // Keep configured answers for attributes the listing endpoint expects but
  // the attribute feed did not return.
  for (const [id, value] of chosen) {
    if (!out.some((o) => o.base_attribute_id === id)) {
      out.push({ base_attribute_id: id, base_attribute_value: value });
    }
  }
  return out;
}

// Photos go to S3 through a presigned URL, then the listing references the id.
async function zeusxUploadPhoto(imagePath) {
  const keys = requireKeys("zeusx");
  const buf = fs.readFileSync(imagePath);
  const ext = (path.extname(imagePath) || ".png").toLowerCase();
  const contentType =
    ext === ".jpg" || ext === ".jpeg"
      ? "image/jpeg"
      : ext === ".webp"
        ? "image/webp"
        : "image/png";
  let slot;
  try {
    const r = await axios.post(
      ZX_API + "/upload/request-upload-urls",
      {
        type: "OFFER_PHOTO",
        files: [{ file_name: "cover" + ext, content_type: contentType }],
      },
      { headers: zxHeaders(keys), timeout: 20000 },
    );
    slot = (zxData("ZeusX upload url", r) || [])[0];
  } catch (e) {
    throw zxError("ZeusX upload url", e);
  }
  if (!slot || !slot.upload_url) throw new Error("ZeusX upload: no upload url");
  try {
    await axios.put(slot.upload_url, buf, {
      headers: { "Content-Type": contentType },
      timeout: 60000,
      maxBodyLength: Infinity,
    });
  } catch (e) {
    throw zxError("ZeusX upload", e);
  }
  return {
    photo_id: slot.upload_file_id,
    photo_url: slot.upload_file_path,
    file_name: slot.upload_file_name,
  };
}

function zxDescriptionHtml(description) {
  const text = String(description || "").trim();
  if (/<[a-z][\s\S]*>/i.test(text)) return text.slice(0, 20000);
  return text
    .split(/\n{2,}/)
    .map((p) => "<p>" + p.replace(/\n/g, "<br>") + "</p>")
    .join("")
    .slice(0, 20000);
}

// Per-game placement, configured under autoFarm.zeusxGames:
//   { "overwatch": { serviceCategoryId: "1", serviceCategoryBaseId: "269",
//                    attributes: [{ base_attribute_id, base_attribute_value }] } }
function zeusxGameConfig(game) {
  const { loadSettings: load } = require("./settings");
  const af = (load().autoFarm || {});
  const map = af.zeusxGames || {};
  const key = String(game || "").trim().toLowerCase();
  if (!key) return null;
  if (map[key]) return map[key];
  const hit = Object.keys(map).find(
    (k) => key.includes(k) || k.includes(key),
  );
  return hit ? map[hit] : null;
}

// Storefront URL. ZeusX serves offers under
// /game/<game-slug>/<game_id>/<category>/<slug>, and only falls back to the id
// route when the create response has not filled the slug in yet.
function zeusxOfferUrl(offer) {
  const slug = offer && offer.slug;
  const gameId = offer && offer.game_id;
  const category = String(
    (offer && (offer.service_category_name || offer.cache_sc_service_category_name)) ||
      "",
  )
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  const gameSlug = String(
    (offer && (offer.service_category_base_name || offer.cache_scb_base_name)) || "",
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  if (slug && gameId && gameSlug && category) {
    return (
      "https://zeusx.com/game/" + gameSlug + "/" + gameId + "/" + category + "/" + slug
    );
  }
  return "https://zeusx.com/offer/" + ((offer && offer.offer_code) || (offer && offer.id) || "");
}

// ZeusX's game catalog. The site loads it as a static JSON blob (the same one
// the create-offer game picker uses), so every game's category ids are
// resolvable without the seller mapping anything by hand — the settings map is
// only an override for games whose name we cannot match.
const ZX_MENU_URL =
  "https://us-prod-zeusx-assets.s3.amazonaws.com/static-content/get-menu.json";
const ZX_MENU_TTL_MS = 6 * 60 * 60 * 1000;
let zxMenuCache = { at: 0, bases: [] };

async function zeusxMenu() {
  if (zxMenuCache.bases.length && Date.now() - zxMenuCache.at < ZX_MENU_TTL_MS) {
    return zxMenuCache.bases;
  }
  const r = await axios.get(ZX_MENU_URL, { timeout: 20000 });
  const cats = (r.data && r.data.data) || [];
  const bases = [];
  for (const c of cats) {
    for (const b of c.bases || []) {
      bases.push({
        serviceCategoryId: String(c.service_category_id),
        serviceCategoryName: c.service_category_name,
        serviceCategoryBaseId: String(b.service_category_base_id),
        gameId: String(b.game_id || ""),
        name: String(b.base_name || ""),
      });
    }
  }
  if (bases.length) zxMenuCache = { at: Date.now(), bases };
  return bases;
}

const zxNorm = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Game name -> ZeusX Accounts category. Matched on word overlap rather than
// substrings, because ZeusX's catalog is full of near-namesakes: "Black
// Desert" must not land on "Black Desert Mobile", and a game it simply does
// not carry (PUBG PC) must resolve to nothing rather than "PUBG: BLINDSPOT".
const ZX_NOISE_WORDS = new Set([
  "twitch",
  "drops",
  "drop",
  "account",
  "accounts",
  "the",
  "of",
  "a",
]);
// Edition words that change WHICH product is being sold, so a query without
// one must not silently match a candidate that has it.
const ZX_EDITION_WORDS = new Set([
  "mobile",
  "classic",
  "online",
  "remastered",
  "legacy",
  "beta",
  "pc",
  "console",
]);
// A different platform is a different product, so these cost far more than a
// cosmetic suffix: "Black Desert" is the PC game, not "Black Desert Mobile".
const ZX_PLATFORM_WORDS = new Set(["mobile", "console", "pc"]);

function zxTokens(v) {
  return zxNorm(v)
    .split(" ")
    .filter((w) => w && !ZX_NOISE_WORDS.has(w));
}

function zxMatchScore(queryTokens, name) {
  const cand = zxTokens(name);
  if (!cand.length || !queryTokens.length) return 0;
  const q = new Set(queryTokens);
  const c = new Set(cand);
  let shared = 0;
  for (const w of c) if (q.has(w)) shared++;
  if (!shared) return 0;
  const union = new Set([...q, ...c]).size;
  let score = shared / union;
  // Every word of the candidate must be in the query, or "Rust" would match
  // "Rust Console" as readily as itself. Sequel numbers and edition words are
  // exempt: sellers write "Overwatch" for "Overwatch 2".
  const core = cand.filter(
    (w) => !ZX_EDITION_WORDS.has(w) && !/^\d+$/.test(w),
  );
  if (!core.every((w) => q.has(w))) score -= 0.34;
  for (const w of cand) {
    if (q.has(w)) continue;
    if (ZX_PLATFORM_WORDS.has(w)) score -= 0.3;
    else if (ZX_EDITION_WORDS.has(w)) score -= 0.02;
    else if (/^\d+$/.test(w)) score -= 0.02;
  }
  return score;
}

async function zeusxResolveCategory(game, serviceCategoryId) {
  const q = zxTokens(game);
  if (!q.length) return null;
  const catId = String(serviceCategoryId || "1");
  let bases;
  try {
    bases = (await zeusxMenu()).filter((b) => b.serviceCategoryId === catId);
  } catch {
    return null;
  }
  const exact = bases.find((b) => zxNorm(b.name) === zxNorm(game));
  if (exact) return exact;
  let best = null;
  let bestScore = 0;
  for (const b of bases) {
    const score = zxMatchScore(q, b.name);
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  // Below this the "match" is one shared word out of several — a different
  // game with a word in common. A bare sequel ("Overwatch" -> "Overwatch 2")
  // lands just under 0.5, hence the slack.
  return bestScore >= 0.45 ? best : null;
}

// Automatic delivery: ZeusX itself hands the buyer the account the instant they
// pay — the same model as the Gameflip/FunPay auto-delivery here, where the
// marketplace holds the credential and releases it on payment (no chat, no
// poller, works even if this server is offline at the sale). The credential
// therefore has to ride on the offer at publish time.
//
// Confirmed live against create-offer (2026-08-04):
//   delivery_method: "AUTOMATIC"  (vs the default "COORDINATED")
//   the credential is a NESTED object, not inline fields — inline every-which-way
//   returns HTTP 500 (which, gotcha, STILL creates a broken offer shell), while a
//   nested `game_account` object is accepted (200).
//   handover_method is null for an account we are NOT handing an email over for
//   (is_account_linked:false) — the enum values only apply when linked.
//   Per-account credential fields: registered_email, username, password,
//   additional_information (the buyer-facing delivery text).
//
// Our Twitch-drop accounts are never bound to an email we hand over, so every
// credential is is_account_linked:false + handover_method:null.
function zxConnectGuide() {
  return (
    "You received a Twitch account (username + password above).\n\n" +
    "1. Log in to it, then open https://www.twitch.tv/drops/inventory and " +
    'scroll to the "Received" section at the bottom.\n' +
    '2. Click the purple "Connect" button under the item you want to add.\n' +
    "3. Follow the instructions on the site where the connection is made.\n\n" +
    "Any issue — message the seller here on ZeusX."
  );
}

function zxAutoDeliveryCredential(account) {
  return {
    is_account_linked: false,
    handover_method: null,
    registered_email: String((account && account.email) || ""),
    username: String((account && account.login) || ""),
    password: String((account && account.password) || ""),
    additional_information: zxConnectGuide(),
  };
}

// Build the delivery half of the offer body. `accounts` is [{login,password,email}].
// One account -> nested `game_account`; several -> `game_accounts` array (each a
// stock unit ZeusX hands out on a sale). See utils/../_zx_confirm1.js.
function zxDeliveryFields(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { delivery_method: "COORDINATED", is_account_linked: false };
  }
  const creds = accounts.map(zxAutoDeliveryCredential);
  const fields = { delivery_method: "AUTOMATIC", is_account_linked: false };
  if (creds.length === 1) fields.game_account = creds[0];
  else fields.game_accounts = creds;
  return fields;
}

async function zeusxPublish({
  title,
  description,
  priceUsd,
  quantity,
  game,
  serviceCategoryId,
  serviceCategoryBaseId,
  attributes,
  tags,
  coverImagePath,
  deliveryDays,
  deliveryHours,
  // When set to a non-empty [{login,password,email}], the offer is published as
  // ZeusX "Automatic" delivery (instant hand-over on payment) instead of the
  // default "Coordinated" (manual) offer.
  autoDeliverAccounts,
}) {
  requireKeys("zeusx");
  const cfg = zeusxGameConfig(game) || {};
  let baseId = String(serviceCategoryBaseId || cfg.serviceCategoryBaseId || "");
  let categoryId = String(serviceCategoryId || cfg.serviceCategoryId || "1");
  if (!baseId) {
    const hit = await zeusxResolveCategory(game, categoryId);
    if (hit) {
      baseId = hit.serviceCategoryBaseId;
      categoryId = hit.serviceCategoryId;
    }
  }
  if (!baseId) {
    throw new Error(
      'ZeusX has no game called "' +
        (game || "") +
        '" in its Accounts catalog — map it by hand under autoFarm.zeusxGames ' +
        "(serviceCategoryBaseId).",
    );
  }
  let price = Number(priceUsd);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("ZeusX needs a price above 0");
  }
  let priceNote = "";
  if (price < ZX_MIN_PRICE) {
    priceNote =
      "Listed at $" +
      ZX_MIN_PRICE.toFixed(2) +
      " — ZeusX rejects anything below its $1 minimum (set price was $" +
      price.toFixed(2) +
      ").";
    price = ZX_MIN_PRICE;
  }
  const auto =
    Array.isArray(autoDeliverAccounts) && autoDeliverAccounts.length > 0;
  // When auto-delivering, the stock count is exactly the number of accounts we
  // attach — each is one deliverable unit ZeusX hands out on a sale.
  const qty = auto
    ? autoDeliverAccounts.length
    : Math.max(1, parseInt(quantity, 10) || 1);
  const photos = [];
  if (coverImagePath) {
    try {
      photos.push(await zeusxUploadPhoto(coverImagePath));
    } catch (e) {
      console.error("zeusx cover upload failed:", e.message);
    }
  }
  const offer = {
    service_category_id: categoryId,
    service_category_base_id: baseId,
    offer_base_attribute_value: await zeusxAttributeValues(
      baseId,
      attributes && attributes.length ? attributes : cfg.attributes,
    ),
    title: String(title || "").slice(0, 200),
    description: zxDescriptionHtml(description),
    listed_price: String(price),
    quantity: qty,
    has_multiple_stock: qty > 1,
    // Either "AUTOMATIC" (credential rides on the offer, ZeusX delivers on
    // payment) when autoDeliverAccounts is set, or the default "COORDINATED"
    // manual offer. See zxDeliveryFields above.
    ...zxDeliveryFields(autoDeliverAccounts),
    days: Math.max(0, parseInt(deliveryDays, 10) || 0),
    hours: Math.max(0, parseInt(deliveryHours, 10) || (deliveryDays ? 0 : 1)),
    tags: (Array.isArray(tags) ? tags : [])
      .map((t) => String(t || "").trim())
      .filter(Boolean)
      .slice(0, 10),
    uploaded_photos: photos,
    removing_photo_ids: [],
    photos: [],
    agreeTerm: true,
  };
  const keys = requireKeys("zeusx");
  let created;
  try {
    const r = await axios.post(
      ZX_API + "/offer/create-offer",
      { offer },
      { headers: zxHeaders(keys), timeout: 60000 },
    );
    created = zxData("ZeusX create", r) || {};
  } catch (e) {
    throw zxError("ZeusX create", e);
  }
  const id = created.id || created.offer_id || created.offer_code || "";
  if (!id) {
    throw new Error(
      "ZeusX create: no offer id in response: " +
        JSON.stringify(created).slice(0, 300),
    );
  }
  return {
    externalId: String(id),
    url: zeusxOfferUrl(created),
    qty,
    note: priceNote,
  };
}

async function zeusxOffer(offerId) {
  const keys = requireKeys("zeusx");
  try {
    const r = await axios.get(ZX_API + "/offer/" + encodeURIComponent(offerId), {
      headers: zxHeaders(keys),
      timeout: 20000,
    });
    return zxData("ZeusX offer", r) || {};
  } catch (e) {
    throw zxError("ZeusX offer", e);
  }
}

async function zeusxUpdateOffer(offerId, { title, description, priceUsd, quantity } = {}) {
  const keys = requireKeys("zeusx");
  const current = await zeusxOffer(offerId);
  const offer = {
    service_category_id: String(current.service_category_id || "1"),
    service_category_base_id: String(current.service_category_base_id || ""),
    offer_base_attribute_value: (current.offer_base_attribute_value || []).map(
      (a) => ({
        base_attribute_id: String(a.base_attribute_id),
        base_attribute_value: String(a.base_attribute_value),
      }),
    ),
    title: String(title != null ? title : current.title || "").slice(0, 200),
    description:
      description != null
        ? zxDescriptionHtml(description)
        : current.description || "",
    listed_price: String(
      priceUsd != null
        ? Math.max(ZX_MIN_PRICE, Number(priceUsd))
        : current.listed_price,
    ),
    quantity:
      quantity != null
        ? Math.max(0, parseInt(quantity, 10) || 0)
        : Number(current.quantity) || 0,
    delivery_method: current.delivery_method || "COORDINATED",
    is_account_linked: !!current.is_account_linked,
    days: Number(current.days) || 0,
    hours: Number(current.hours) || 1,
    tags: (current.tags || []).map((t) => (t && t.tag_name) || String(t)),
    uploaded_photos: [],
    removing_photo_ids: [],
    photos: [],
    agreeTerm: true,
  };
  offer.has_multiple_stock = offer.quantity > 1;
  try {
    const r = await axios.put(
      ZX_API + "/offer/" + encodeURIComponent(offerId) + "/update",
      { offer },
      { headers: zxHeaders(keys), timeout: 60000 },
    );
    return zxData("ZeusX update", r);
  } catch (e) {
    throw zxError("ZeusX update", e);
  }
}

// Hiding takes the offer off the storefront and is reversible; cancelling
// (DELETE) is permanent, so delisting hides.
async function zeusxDelist(offerId) {
  const keys = requireKeys("zeusx");
  const current = await zeusxOffer(offerId).catch(() => null);
  if (current && current.is_hidden) return;
  try {
    const r = await axios.put(
      ZX_API + "/offer/" + encodeURIComponent(offerId) + "/toggle-offer-hidden",
      {},
      { headers: zxHeaders(keys), timeout: 20000 },
    );
    zxData("ZeusX delist", r);
  } catch (e) {
    throw zxError("ZeusX delist", e);
  }
}

async function zeusxRelist(offerId) {
  const keys = requireKeys("zeusx");
  const current = await zeusxOffer(offerId).catch(() => null);
  if (current && !current.is_hidden) return;
  try {
    const r = await axios.put(
      ZX_API + "/offer/" + encodeURIComponent(offerId) + "/toggle-offer-hidden",
      {},
      { headers: zxHeaders(keys), timeout: 20000 },
    );
    zxData("ZeusX relist", r);
  } catch (e) {
    throw zxError("ZeusX relist", e);
  }
}

async function zeusxMyListings(pageIndex) {
  const keys = requireKeys("zeusx");
  try {
    const r = await axios.get(
      ZX_API + "/offer/my-sales-listing?pageIndex=" + (parseInt(pageIndex, 10) || 0),
      { headers: zxHeaders(keys), timeout: 20000 },
    );
    return zxData("ZeusX listings", r) || { sales: [] };
  } catch (e) {
    throw zxError("ZeusX listings", e);
  }
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
  gameflipReprice,
  gameflipReplaceCover,
  gameflipListingIdsByStatus,
  digisellerTest,
  digisellerCategories,
  digisellerCategoryAttributes,
  digisellerPublish,
  digisellerUploadImage,
  digisellerAddContent,
  digisellerRemoveContent,
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
  ggselUpdateOffer,
  ggselAddProducts,
  ggselOfferStock,
  ggselResolveCategoryId,
  ggselEnableAutoselling,
  ggselFinalizeStock,
  ggselDelist,
  funpayTest,
  funpayPublish,
  funpayDelist,
  funpayUpdateSecrets,
  zeusxTest,
  zeusxRefreshAccessToken,
  zeusxEnsureFreshToken,
  zeusxPublish,
  zeusxOffer,
  zeusxUpdateOffer,
  zeusxDelist,
  zeusxRelist,
  zeusxMyListings,
  zeusxBaseAttributes,
  zeusxUploadPhoto,
  zeusxOfferUrl,
  zeusxResolveCategory,
  zeusxMenu,
};
