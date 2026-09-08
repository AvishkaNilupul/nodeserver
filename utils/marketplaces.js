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
  // G2G's Open API only accepts pushes for the *account* section, not the Game
  // Items category where every Twitch Drops offer lives, and the account has no
  // API key any more. So G2G is driven through its own internal seller API at
  // sls.g2g.com, exactly like ZeusX: the operator supplies the refresh trio
  // once and the server mints fresh access tokens from it forever via
  // /user/refresh_access. See g2gRefreshAccess + utils/g2gSessionRefresher.
  //
  // `refresh_token`, `active_device_token` and `long_lived_token` are all set
  // as ORDINARY COOKIES on g2g.com as well as living in local storage, so the
  // operator can read them from either. The seller id is the numeric prefix of
  // refresh_token ("<sellerId>.<secret>") and is also shown in the account menu.
  g2g: ["userId", "refreshToken", "activeDeviceToken"],
  ggsel: ["apiKey"],
  // FunPay has no API — the single credential is the account's session token.
  funpay: ["golden_key"],
  // ZeusX has no public API either — the credential is the seller session's
  // access_token (~7-day life). The refresh_token is reusable (does not rotate),
  // so the server mints fresh access tokens from it via /user/exchange-token and
  // the operator never has to re-paste — see zeusxRefreshAccessToken +
  // utils/zeusxTokenRefresher.
  zeusx: ["accessToken", "refreshToken"],
  // Eldorado has no usable public API either. Auth is cookie-based, so the one
  // credential is the whole Cookie header copied from a signed-in seller
  // session (DevTools -> Application -> Cookies -> eldorado.gg -> copy all).
  // The server renews it in place via /authentication/refreshTokens, so this is
  // a one-time paste — see eldoradoRefreshSession + utils/eldoradoSessionRefresher.
  eldorado: ["cookie"],
  // PlayerAuctions is the same shape as Eldorado — cookie auth, httpOnly
  // session cookies, renewed in place via account-api /SignIn/RefreshToken.
  // The one difference worth remembering: there is NO CSRF token here, so the
  // whole credential really is just the Cookie header from a signed-in seller
  // session (DevTools -> Network -> any request -> copy the Cookie header).
  playerauctions: ["cookie"],
  // Z2U has no API at all — the seller panel is a server-rendered PHP site, so
  // the one credential is the whole Cookie header from a signed-in session.
  // Unlike the old note in this repo, prod reaches z2u.com fine: there is no
  // Cloudflare challenge on these paths (verified from the prod host
  // 2026-09-08), so no browser bridge is needed.
  z2u: ["cookie"],
};

// Credentials a marketplace will USE if present but must not be blocked on.
// `requireKeys` ignores these; `getKeys`/`setKeys` still round-trip them, so an
// operator can supply one without it becoming a hard precondition.
const OPTIONAL_FIELDS = {
  // G2G's access token is deliberately NOT required. The server mints one from
  // the refresh trio on its very first call, so asking an operator to copy a
  // short-lived token only adds a value that can expire between the copy and
  // the paste — and one more secret to move around for no gain. Stored if
  // supplied, ignored if not.
  // long_lived_token is genuinely optional: a session that was never
  // "remember me"-d does not have one, and /user/refresh_access works without.
  g2g: ["accessToken", "longLivedToken"],
};

const MARKETPLACES = Object.keys(FIELDS);

// ------------------------------------------------------------------
// Key storage
// ------------------------------------------------------------------
function allFields(marketplace) {
  return (FIELDS[marketplace] || []).concat(OPTIONAL_FIELDS[marketplace] || []);
}

function getKeys(marketplace) {
  const s = loadSettings();
  const stored = (s.marketplaces || {})[marketplace] || {};
  const out = {};
  for (const f of allFields(marketplace)) {
    out[f] = stored[f] ? decrypt(stored[f]) : "";
  }
  return out;
}

async function setKeys(marketplace, values) {
  if (!FIELDS[marketplace]) throw new Error("Unknown marketplace");
  const s = loadSettings();
  s.marketplaces = s.marketplaces || {};
  const cur = s.marketplaces[marketplace] || {};
  for (const f of allFields(marketplace)) {
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

// Why a delist call failed, when the failure means the listing is not on sale
// anyway: "gone" (the platform has no such listing) or "sold" (a buyer already
// took it). Both satisfy the intent of delisting, so the caller should resolve
// its row instead of leaving it active with an error — four rows on prod sat
// stuck for weeks that way, holding their accounts reserved out of stock.
// Returns "" for anything genuinely transient, notably Gameflip's "pending
// sale", where the sale has not resolved and retrying is right.
function delistOutcome(message) {
  const m = String(message || "").toLowerCase();
  if (/\(sold\)|already sold/.test(m)) return "sold";
  if (/not found|http_status":\s*404/.test(m)) return "gone";
  // Already off sale. Eldorado answers "To pause an offer it must be active"
  // when the offer is not active, which is the delist goal already met — not a
  // failure. Left unmatched it strands the row as active-with-an-error, holding
  // its accounts reserved forever.
  if (/must be active|already (paused|inactive|hidden|cancell?ed|delisted)/.test(m)) {
    return "gone";
  }
  return "";
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

// Our own Gameflip owner id — the same string a listing row carries as
// `owner` (priceScout maps it to `seller`). Market research uses it to drop
// our own rows from "lowest competitor price": every unclaimed row sat at the
// $0.75 floor because the lowest live listing for the game was OUR OWN row
// and the pricer kept undercutting itself. Cached for an hour; returns "" on
// any failure (no keys, network, unexpected shape) so callers can fall back
// to the unfiltered lowest rather than fail a scan.
let gfOwnerCache = { id: "", until: 0 };
async function gameflipOwnerId() {
  const now = Date.now();
  if (gfOwnerCache.id && gfOwnerCache.until > now) return gfOwnerCache.id;
  try {
    const keys = requireKeys("gameflip");
    const pick = (r) => String((((r || {}).data || {}).data || {}).owner || "");
    let owner = pick(
      await axios.get(GF_API + "/account/me", {
        headers: gfHeaders(keys),
        timeout: 20000,
      }),
    );
    // /account/me/profile is the endpoint the rest of this file already reads
    // `owner` from (gameflipTest, gameflipListingIdsByStatus); use it when the
    // account document does not carry the id.
    if (!owner) {
      owner = pick(
        await axios.get(GF_API + "/account/me/profile", {
          headers: gfHeaders(keys),
          timeout: 20000,
        }),
      );
    }
    if (owner) gfOwnerCache = { id: owner, until: now + 60 * 60 * 1000 };
    return owner;
  } catch {
    return "";
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
      // Remove the map entry — a `replace .../status = "deleted"` is rejected
      // 400 by Gameflip, which is why stale covers used to accumulate.
      const delOps = stale.map((id) => ({ op: "remove", path: "/photo/" + id }));
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
      // Remove the map entry — a `replace .../status = "deleted"` is rejected
      // 400 by Gameflip, which is why stale covers used to accumulate.
      const ops = stale.map((id) => ({ op: "remove", path: "/photo/" + id }));
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

// Delete every gallery photo that is NOT the cover_photo — the stale grids left
// behind when a cover was replaced but the limiter rejected the cleanup delete
// (a stale-photo delete right after an upload is the exact case gameflipReplace-
// Cover gives up on). A photo-status delete touches neither cover_photo, price,
// nor status, so Gameflip accepts it while the listing is onsale; only if it is
// ever rejected as an onsale edit do we retry inside an off-sale window and
// restore, using the same verified restore as the cover swap. Idempotent — a
// listing already down to just its cover returns { deleted: 0 }.
async function gameflipDeleteNonCoverPhotos(listingId) {
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
  const readPhotos = async () => {
    const cur = await axios.get(GF_API + "/listing/" + listingId, {
      headers: gfHeaders(keys),
      timeout: 20000,
    });
    const d = (cur.data || {}).data || {};
    const ph = d.photo || {};
    const ids = Object.keys(ph).filter(
      (k) => k !== d.cover_photo && ph[k] && ph[k].status === "active",
    );
    return { ids, status: d.status };
  };

  const first = await readPhotos();
  if (!first.ids.length) return { deleted: 0, remaining: 0 };
  // Gameflip removes a gallery photo with a json-patch REMOVE of its map entry.
  // (A `replace /photo/<id>/status = "deleted"` is rejected 400 "bad value" —
  // that was the long-standing bug that let stale photos pile up.)
  const delOps = first.ids.map((id) => ({ op: "remove", path: "/photo/" + id }));
  // Backoff retries for the limiter, which 429s photo edits in bursts.
  const tryDelete = async () => {
    let err = null;
    for (const w of [0, 15000, 45000, 90000]) {
      if (w) await new Promise((r) => setTimeout(r, w));
      try {
        await patch(delOps);
        return null;
      } catch (e) {
        err = e;
        if (e.response && e.response.status === 429) continue;
        return e; // non-429: surface (may be an onsale-edit rejection)
      }
    }
    return err;
  };

  const onsale = first.status === "onsale";
  let e1 = await tryDelete();
  if (!e1) {
    const after = await readPhotos();
    return { deleted: first.ids.length - after.ids.length, remaining: after.ids.length };
  }
  // Non-429 failure. If it looks like an onsale-edit rejection, retry in an
  // off-sale window; otherwise it is a real error.
  const msg =
    (e1.response && e1.response.data && JSON.stringify(e1.response.data)) ||
    e1.message ||
    "";
  if (!onsale || !/onsale|status/i.test(msg)) {
    throw apiError("Gameflip photo prune", e1);
  }
  await gfTakeOffSale(listingId, setStatus, "Gameflip photo prune");
  const e2 = await tryDelete();
  // Restore onsale with the same verified retry as gameflipReplaceCover.
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
      restoreErr = new Error('status settled on "ready" instead of "onsale" (rate-limited)');
    } catch (e) {
      restoreErr = e;
    }
  }
  if (!restored) {
    throw new Error(
      "Gameflip listing " +
        listingId +
        " IS NOT BACK ON SALE after a photo prune — put it back on sale " +
        "manually. " +
        ((restoreErr && restoreErr.message) || "unknown error"),
    );
  }
  if (e2) throw apiError("Gameflip photo prune", e2);
  const after = await readPhotos();
  return { deleted: first.ids.length - after.ids.length, remaining: after.ids.length };
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

// Plati enforces a ~100 RUB platform floor, about $1.28. Pricing under it is
// not merely rejected per listing: publishing below the floor is what got the
// whole seller account BLOCKED ("продавец товара заблокирован"), taking every
// Plati stock read and the entire auto-feed for the marketplace down with it.
// So the floor is enforced here, at the connector, where no caller can skip
// it — the shared price model targets Gameflip's $0.75 floor and knows nothing
// about which marketplace it is about to publish to.
const DS_MIN_PRICE_USD = 1.28;

function digisellerFloorPrice(priceUsd) {
  const price = Math.round(Number(priceUsd) * 100) / 100;
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("Digiseller needs a price above 0");
  }
  return Math.max(DS_MIN_PRICE_USD, price);
}

// Create a "unique product with fixed price". Returns { externalId, url, price }
// — `price` is what was actually charged, which may have been lifted to the
// platform floor, so the caller records what Plati really has.
async function digisellerPublish({ title, description, priceUsd, categories }) {
  const token = await digisellerToken();
  const price = digisellerFloorPrice(priceUsd);
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
      price,
      note:
        "Product created (hidden until it has content). Add delivery text/stock" +
        " in Digiseller, or it stays unsellable.",
    };
  } catch (e) {
    throw dsApiError("Digiseller create", e);
  }
}

// Bulk-set prices on existing products. Digiseller runs this asynchronously:
// the POST returns a task id and the work lands later, so poll the task rather
// than assuming success. Prices are in each product's own base currency (USD
// for everything we publish) and are floored, since an under-floor price is
// what blocks the account. Returns { total, ok, failed, errors }.
async function digisellerRepriceProducts(updates) {
  const rows = (Array.isArray(updates) ? updates : [])
    .filter((u) => u && u.productId)
    .map((u) => ({
      product_id: Number(u.productId),
      ProductId: Number(u.productId),
      price: digisellerFloorPrice(u.priceUsd),
    }));
  if (!rows.length) return { total: 0, ok: 0, failed: 0, errors: [] };
  const token = await digisellerToken();
  try {
    const r = await axios.post(
      DS_API + "/product/edit/prices?token=" + encodeURIComponent(token),
      rows,
      { headers: { "Content-Type": "application/json" }, timeout: 60000 },
    );
    const taskId = typeof r.data === "string" ? r.data : (r.data || {}).TaskId;
    if (!taskId) {
      throw new Error(
        "no task id in response: " + JSON.stringify(r.data).slice(0, 200),
      );
    }
    // Status 3 = finished. Poll briefly; a large batch takes a few seconds.
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 2000));
      const s = await axios.get(
        DS_API +
          "/product/edit/UpdateProductsTaskStatus?taskId=" +
          encodeURIComponent(taskId) +
          "&token=" +
          encodeURIComponent(token),
        { timeout: 20000 },
      );
      const d = s.data || {};
      if (Number(d.Status) === 3) {
        return {
          total: Number(d.TotalCount) || rows.length,
          ok: Number(d.SuccessCount) || 0,
          failed: Number(d.ErrorCount) || 0,
          errors: d.ErrorsDescriptions || [],
        };
      }
    }
    throw new Error("price update task " + taskId + " did not finish in time");
  } catch (e) {
    throw dsApiError("Digiseller reprice", e);
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
      ? d.content.map((c) =>
          c && c.content_id != null ? String(c.content_id) : "",
        )
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
// auto-feed digiseller listings.
//
// Returns { stock, reason }: `stock` is the unit count, or null when it could
// not be determined, in which case `reason` says why in a form fit to show an
// operator. Callers that only need the number use digisellerProductStock.
async function digisellerProductStockDetailed(productId) {
  let qs = "";
  try {
    const token = await digisellerToken();
    qs = "?token=" + encodeURIComponent(token) + "&showHiddenVariants=true";
  } catch {
    // Keys unavailable — fall back to the public read (may carry no stock).
    qs = "";
  }
  const how = qs ? "authenticated read" : "public read — no seller token";
  try {
    const r = await axios.get(
      DS_API + "/products/" + encodeURIComponent(productId) + "/data" + qs,
      { headers: { Accept: "application/json" }, timeout: 20000 },
    );
    const d = r.data || {};
    // Digiseller answers errors with HTTP 200 and a { retval, retdesc }
    // envelope carrying no product. Without this check the `|| d` fallback
    // below reads the envelope itself, finds no stock field, and reports a
    // hard account-level failure ("продавец товара заблокирован" — the seller
    // is blocked) as a benign "this product has no stock field", which is what
    // hid a blocked seller behind a low-severity auto-feed warning.
    if (d.retval !== undefined && String(d.retval) !== "0") {
      const reason = "Digiseller refused the read: " + dsErrorText(d);
      console.error(
        "digiseller stock unreadable for product " +
          productId +
          ": " +
          reason +
          " (" +
          how +
          ")",
      );
      return { stock: null, reason };
    }
    const p = d.product || d.content || d;
    // Only trust real numeric stock fields: booleans coerce to 0/1 and
    // num_in_lock counts locked (not sellable) units, so both would make the
    // auto-feeder misjudge stock and over-feed accounts.
    for (const f of ["num_in_stock", "in_stock", "count_goods"]) {
      const raw = p && p[f];
      if (raw === null || raw === undefined) continue;
      if (typeof raw === "boolean") continue;
      const v = Number(raw);
      if (Number.isFinite(v)) return { stock: v, reason: "" };
    }
    // The read succeeded but carried no stock figure — only expected on the
    // public fallback (no seller token) or an unusual product type.
    const reason =
      "response had no num_in_stock/in_stock/count_goods (" + how + ")";
    console.error(
      "digiseller stock unreadable for product " + productId + ": " + reason,
    );
    return { stock: null, reason };
  } catch (e) {
    // A genuine transport/API failure is a different problem from the above and
    // must not look the same in the logs.
    const reason =
      "request failed: " +
      (e.response ? "HTTP " + e.response.status : e.message || String(e));
    console.error(
      "digiseller stock request failed for product " +
        productId +
        ": " +
        reason,
    );
    return { stock: null, reason };
  }
}

async function digisellerProductStock(productId) {
  return (await digisellerProductStockDetailed(productId)).stock;
}

// Is this product still offered for sale? `/products/{id}/data` answers for a
// DISABLED product exactly as it does for a live one (verified live 2026-09-06
// on product 6078723: delisted, still reports num_in_stock 3), so the only
// read that tells enabled from disabled is the seller's own goods list, whose
// `visible` field is 1 for a live product and negative for a disabled one.
// Returns true/false, or null when the state could not be read — callers must
// treat null as "unknown", never as "it is down".
async function digisellerProductVisible(productId, { maxPages = 15 } = {}) {
  const want = String(productId);
  try {
    const keys = requireKeys("digiseller");
    const token = await digisellerToken();
    for (let page = 1; page <= maxPages; page++) {
      const r = await axios.post(
        DS_API + "/seller-goods?token=" + encodeURIComponent(token),
        {
          id_seller: Number(keys.sellerId),
          order_col: "cntsell",
          order_dir: "desc",
          rows: 100,
          page,
          currency: "USD",
          lang: "en-US",
          show_hidden: 1,
        },
        { headers: { "Content-Type": "application/json" }, timeout: 30000 },
      );
      const d = r.data || {};
      if (d.retval !== undefined && String(d.retval) !== "0") return null;
      const rows = Array.isArray(d.rows) ? d.rows : [];
      const hit = rows.find((p) => String(p && p.id_goods) === want);
      if (hit) return Number(hit.visible) > 0;
      if (!rows.length || page >= Number(d.pages || 1)) break;
    }
    // Not in the seller's own list at all — it cannot be on sale.
    return false;
  } catch (e) {
    console.error(
      "digiseller visibility unreadable for product " + productId + ": " +
        (e.response ? "HTTP " + e.response.status : e.message),
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

// GGSel rejects an offer whose title is over 100 characters, in either locale
// ("Название (EN) слишком большой длины" / "Title (EN) too long") — half what
// Gameflip allows, so an auto-list title that names every drop in the bundle
// sails past it and takes the whole GGSel publish down with it. Cut on a word
// boundary so the title still reads as a sentence rather than ending mid-word.
const GG_TITLE_MAX = 100;

function ggselTitle(title) {
  const t = String(title || "").trim();
  if (t.length <= GG_TITLE_MAX) return t;
  const cut = t.slice(0, GG_TITLE_MAX);
  const sp = cut.lastIndexOf(" ");
  return (sp > GG_TITLE_MAX * 0.6 ? cut.slice(0, sp) : cut).trim();
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
  const t = ggselTitle(title);
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
async function ggselUpdateOffer(
  offerId,
  { title, description, priceRub } = {},
) {
  const keys = requireKeys("ggsel");
  const body = {};
  if (title) {
    // Mirror ggselPublish: the English title is used for both locales.
    const t = ggselTitle(title);
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
//
// Field semantics, verified live 2026-08-09 against the seller API:
//   in_stock_products_count           unsold units attached to an autoselling
//                                     offer — the real remaining stock, and
//                                     the figure ggselFinalizeStock syncs from.
//   in_stock_splitted_products_count  the same, for offers that sell "splitted"
//                                     products (has_splitted_products).
//   quantity                          the ADVERTISED sellable count. It is the
//                                     only stock-ish field the LIST endpoint
//                                     carries, but on an autoselling offer it
//                                     lags the real stock until a finalize
//                                     re-syncs it — so it is the fallback, not
//                                     the first choice.
// `available_quantity` and `products_count` were checked here before and are
// on neither payload, so this only ever matched `quantity`.
function ggselStockField(o) {
  if (!o || typeof o !== "object") return null;
  const fields = o.has_splitted_products
    ? [
        "in_stock_splitted_products_count",
        "in_stock_products_count",
        "quantity",
      ]
    : ["in_stock_products_count", "quantity"];
  for (const f of fields) {
    const raw = o[f];
    // null coerces to 0 and a boolean to 0/1 — either would read as "empty"
    // and make the auto-feeder over-feed accounts into a full offer.
    if (raw === null || raw === undefined || typeof raw === "boolean") continue;
    const v = Number(raw);
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

// GGSel only accepts an offer in a category with no children of its own
// ("Категория не должна иметь дочерние категории"), and some games nest a
// further level under their Twitch/Accounts section. Walk down to a leaf,
// preferring a Twitch one at every step, so the resolved id is publishable.
const GG_LEAF_MAX_DEPTH = 4;

async function ggselLeafCategory(node, keys) {
  let cur = node;
  for (
    let depth = 0;
    cur && cur.has_children && depth < GG_LEAF_MAX_DEPTH;
    depth++
  ) {
    let rows = [];
    try {
      const r = await axios.get(GG_API + "/categories?parent_id=" + cur.id, {
        headers: ggHeaders(keys),
        timeout: 20000,
      });
      rows = (r.data && r.data.data) || [];
    } catch {
      break;
    }
    if (!rows.length) break;
    cur =
      rows.find((k) => /twitch/i.test(String(k.title || ""))) ||
      rows.find((k) =>
        /^(accounts|\u0430\u043a\u043a\u0430\u0443\u043d\u0442\u044b)$/i.test(
          String(k.title || "").trim(),
        ),
      ) ||
      rows[0];
  }
  return cur ? String(cur.id) : "";
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
    if (twitch) return ggselLeafCategory(twitch, keys);
    // 3) The game's accounts section — the seller's own fallback pattern.
    const acc = rows.find((k) =>
      /^(accounts|\u0430\u043a\u043a\u0430\u0443\u043d\u0442\u044b)$/i.test(
        String(k.title || "").trim(),
      ),
    );
    if (acc) return ggselLeafCategory(acc, keys);
  } catch {
    /* nothing */
  }
  return "";
}

// The single-offer payload is the only one carrying the real attached-unit
// counts, and it also gates the autoselling flip and the activate that puts a
// fed offer back on sale — so a momentary 504 from GGSel's gateway must not
// read as "this offer is unreadable".
async function ggselReadOffer(keys, offerId) {
  const r = await withNetRetries(() =>
    axios.get(GG_API + "/offers/" + Number(offerId), {
      headers: ggHeaders(keys),
      timeout: 20000,
    }),
  );
  return (r.data && r.data.data) || r.data || {};
}

// GGSel serves /offers 100 rows at a time behind a `pagination` block. An
// unpaginated scan therefore only ever sees the newest 100 offers, so every
// older one looks like "no such offer" — which is indistinguishable, to the
// caller, from a genuinely unreadable stock. That is what made the guardian
// report "could not read remaining stock" for long-lived listings forever.
// Walk the pages until the offer turns up. The page cap is a guard against a
// malformed pagination block, not an expected limit.
const GG_OFFERS_PAGE_SIZE = 100;
const GG_OFFERS_MAX_PAGES = 50;

async function ggselFindOfferInList(keys, offerId) {
  for (let page = 1; page <= GG_OFFERS_MAX_PAGES; page++) {
    const r = await axios.get(
      GG_API + "/offers?page=" + page + "&limit=" + GG_OFFERS_PAGE_SIZE,
      { headers: ggHeaders(keys), timeout: 20000 },
    );
    const rows = Array.isArray(r.data && r.data.data) ? r.data.data : [];
    const row = rows.find((o) => String(o && o.id) === String(offerId));
    if (row) return row;
    const pg = (r.data && r.data.pagination) || {};
    const more =
      pg.has_next_page === undefined
        ? rows.length === GG_OFFERS_PAGE_SIZE
        : !!pg.has_next_page;
    if (!more) return null;
  }
  return null;
}

// Returns { stock, reason } — see digisellerProductStockDetailed for the
// contract. ggselOfferStock keeps the number-or-null shape callers expect.
async function ggselOfferStockDetailed(offerId) {
  const keys = requireKeys("ggsel");
  const errText = (e) =>
    e.response ? "HTTP " + e.response.status : e.message || String(e);
  let singleErr = null;
  try {
    const v = ggselStockField(await ggselReadOffer(keys, offerId));
    if (v !== null) return { stock: v, reason: "" };
  } catch (e) {
    singleErr = e;
  }
  try {
    const row = await ggselFindOfferInList(keys, offerId);
    const v = ggselStockField(row);
    if (v !== null) return { stock: v, reason: "" };
    const reason =
      (row
        ? "the offer's list row carried no stock field"
        : "no such offer in the seller's offer list") +
      (singleErr
        ? " (single-offer read failed: " + errText(singleErr) + ")"
        : "");
    console.error(
      "ggsel stock unreadable for offer " + offerId + ": " + reason,
    );
    return { stock: null, reason };
  } catch (e) {
    const reason = "request failed: " + errText(e);
    console.error(
      "ggsel stock request failed for offer " + offerId + ": " + reason,
    );
    return { stock: null, reason };
  }
}

async function ggselOfferStock(offerId) {
  return (await ggselOfferStockDetailed(offerId)).stock;
}

// The offer's own on-sale state ("active" / "paused" / …). ggselDelist pauses
// an offer, so this is how a caller proves the delist actually took. Stock is
// NOT that proof: a paused offer keeps reporting the products still attached
// to it. Returns "" / null when unreadable — never assume "down" from that.
async function ggselOfferStatus(offerId) {
  const keys = requireKeys("ggsel");
  try {
    const o = await ggselReadOffer(keys, offerId);
    return String((o && o.status) || "");
  } catch (e) {
    try {
      const row = await ggselFindOfferInList(keys, offerId);
      // Absent from the seller's offer list entirely — it is not on sale.
      if (!row) return "gone";
      return String(row.status || "");
    } catch {
      console.error(
        "ggsel status unreadable for offer " + offerId + ": " +
          (e.response ? "HTTP " + e.response.status : e.message),
      );
      return null;
    }
  }
}

// The offer's current price in ROUBLES, or null when it cannot be read.
//
// Exists because GGSel's PATCH is unreliable about reporting success: a live
// reprice canary got `504 Gateway Time-out` from nginx for an update whose
// outcome was genuinely unknown. Without a way to read the price back, a
// caller cannot tell "applied" from "not applied", so it cannot decide whether
// to record the new price — and it would either leave the DB disagreeing with
// the live offer or retry blindly. Mirrors ggselOfferStatus's shape, including
// its fall back to the paginated offer list (an older offer is invisible to a
// direct GET; see ggselFindOfferInList).
async function ggselOfferPrice(offerId) {
  const keys = requireKeys("ggsel");
  const priceOf = (o) => {
    const p = Number(o && o.price);
    return Number.isFinite(p) && p > 0 ? p : null;
  };
  try {
    return priceOf(await ggselReadOffer(keys, offerId));
  } catch {
    try {
      return priceOf(await ggselFindOfferInList(keys, offerId));
    } catch {
      return null;
    }
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
    offer = await ggselReadOffer(keys, offerId);
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
    offer = await ggselReadOffer(keys, offerId);
  } catch (e) {
    throw apiError("GGSel offer read", e);
  }
  // Read stock the same way every other caller does. This used to read only
  // in_stock_products_count, which is 0 on an offer that sells "splitted"
  // products — its units live in in_stock_splitted_products_count. Such an
  // offer therefore always took the pending early return below and could NEVER
  // be re-activated or have its quantity synced: stocked, paused, and off sale
  // indefinitely, with the guardian's self-heal unable to touch it.
  // ggselStockField encodes the verified field precedence (splitted first when
  // has_splitted_products, then the plain count, then advertised quantity), so
  // using it keeps this in step with ggselOfferStockDetailed instead of
  // disagreeing with the gate that decides whether to call this at all.
  const stock = Number(ggselStockField(offer)) || 0;
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
  let activationStuck = false;
  let activationStatus = "";
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
    // batch_activate answering 2xx does NOT mean the offer went live: GGSel
    // accepts the call and leaves the offer off sale, which is how one offer
    // was "successfully re-activated" 466 times while sitting off sale the
    // whole time. Read the status back so a caller can tell a real activation
    // from an accepted-but-ignored one. Best-effort: a failed verify read must
    // not turn a probably-fine activation into a thrown error, so it just
    // leaves activationStuck false.
    //
    // Report WHICH status it stuck at, not just that it stuck. The two mean
    // different things: "paused" is an offer that was live and got taken off
    // sale, "draft" is one that was published and never went live at all
    // (offer 102669379, observed live 2026-08-11). A reader chasing a "still
    // paused" message for a draft offer is looking for the wrong thing.
    try {
      const after = await ggselReadOffer(keys, offerId);
      const status = String((after && after.status) || "");
      if (status === "paused" || status === "draft") {
        activationStuck = true;
        activationStatus = status;
      }
    } catch {
      /* verify is advisory — leave activationStuck false */
    }
  }
  return { stock, reactivated, quantitySynced, activationStuck, activationStatus };
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
// G2G (g2g.com)
//
// Two different APIs live under this heading; do not confuse them.
//
// 1. The **internal seller API** at sls.g2g.com — the one the g2g.com web app
//    itself talks to, and the ONLY one that can touch our listings. Every
//    Twitch-Drops offer we sell sits in `Digital Products > Gaming > Game
//    Items > <game>` (service 0765978e-…439e), which the public Open API
//    cannot serve. (Careful: the "Support Gift Card & Top Up Only" heading in
//    G2G's docs is only an Apidog FOLDER label, not a documented restriction —
//    it appears in no description anywhere. The real blockers are structural:
//    `delivery_method_code` is an enum of exactly {instant_inventory,
//    direct_top_up}; `POST /v2/orders/{id}/delivery` needs a `delivery_id` that
//    only ever arrives in an `order.api_delivery` WEBHOOK, and this server
//    exposes no webhook receiver; deliver-code `content` is validated against
//    the offer's `code_label` columns, so a multi-line credential is rejected;
//    no screenshot-upload endpoint exists anywhere in the API, and Game Items
//    loses disputes without one; and PATCH cannot change title, description or
//    status, so there is no API delist at all.) So the auto-lister and the
//    fulfiller both run on this API, the same way Z2U / Eldorado /
//    PlayerAuctions do.
//
//    Auth is G2G's own token trio, NOT a cookie and NOT Firebase (Firebase is
//    only the realtime/chat layer). Every request carries
//
//        authorization: <access_token>          <-- RAW. No "Bearer " prefix.
//
//    Sending "Bearer <token>" answers 401 {"message":"Unauthorized"}; the bare
//    token answers 200. That one detail is the whole gate — it cost a probe to
//    find, so it is asserted in tests/g2g.test.js.
//
//    The access_token is short-lived, so the durable credential is the refresh
//    trio, pasted once from a signed-in browser (DevTools -> Application ->
//    Local Storage -> www.g2g.com: `refresh_token`, `active_device_token`,
//    optionally `long_lived_token`), plus the numeric seller id. The server
//    mints fresh access tokens forever via POST /user/refresh_access — the same
//    never-re-paste shape as zeusxRefreshAccessToken.
//
// 2. The **Open API** at open-api.g2g.com — HMAC-signed, key-based. Kept below
//    only for the catalog pickers and the xlsx bulk-file generator that already
//    use it (g2gServices/g2gBrands/g2gProducts/g2gAttributes + utils/g2gBulk).
//    NOTE the account currently has NO API key at all (the table at
//    g2g.com/offers/api is empty), so every one of those calls answers
//    401 40100001 until the operator generates one. That is pre-existing and
//    deliberate — nothing in the automation path depends on it.
// ------------------------------------------------------------------
const G2G_SLS = "https://sls.g2g.com";
const G2G_WEB = "https://www.g2g.com";
const G2G_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";

// "Digital Products > Gaming > Game Items" — the service every Twitch Drops
// offer of ours belongs to. The per-game brand id comes from the public catalog
// (assets.g2g.com/offer/categories.json); see utils/g2gGames.js.
const G2G_ITEMS_SERVICE = "0765978e-3fdf-48b4-bed3-184823aa439e";

// G2G's floor for a Game Items offer. Mirrored in utils/pricing.js
// MARKETPLACE_FLOORS.g2g — tests/pricing.test.js asserts the two agree.
const G2G_MIN_PRICE = 0.5;

// Offer statuses seen on live rows. "live" and "delisted" are the two we set.
const G2G_STATUS = { LIVE: "live", DELISTED: "delisted" };

function g2gError(what, e) {
  const status = e && e.response && e.response.status;
  const body = e && e.response && e.response.data;
  let detail = "";
  if (body && typeof body === "object") {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    detail =
      msgs
        .map((m) => (m && (m.text || m.message)) || "")
        .filter(Boolean)
        .join("; ") ||
      body.message ||
      JSON.stringify(body).slice(0, 300);
  } else if (typeof body === "string") {
    detail = body.slice(0, 300);
  }
  const err = new Error(
    what + " failed" + (status ? " (HTTP " + status + ")" : "") +
      (detail ? ": " + detail : ": " + (e && e.message)),
  );
  err.__g2g = true;
  err.status = status;
  throw err;
}

// Milliseconds until a JWT expires; Infinity when it carries no exp we can read
// (so an unparseable token is never mistaken for an expired one).
function g2gTokenMsLeft(token) {
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

// Exchange the stored refresh trio for a fresh access token and save whatever
// came back. G2G MAY rotate the refresh token on each call, so every value the
// response carries is written back — that is safe whether it rotates or not.
async function g2gRefreshAccess() {
  const keys = getKeys("g2g");
  if (!keys.refreshToken || !keys.userId) {
    throw new Error(
      "G2G refresh: no session stored — paste a G2G session once " +
        "(Marketplace keys -> G2G) to enable auto-refresh",
    );
  }
  let body;
  try {
    const r = await axios.post(
      G2G_SLS + "/user/refresh_access",
      {
        user_id: String(keys.userId),
        refresh_token: keys.refreshToken,
        active_device_token: keys.activeDeviceToken || "",
        long_lived_token: keys.longLivedToken || "",
      },
      {
        headers: {
          "Content-Type": "application/json",
          Origin: G2G_WEB,
          Referer: G2G_WEB + "/",
          "User-Agent": G2G_UA,
        },
        timeout: 20000,
      },
    );
    body = r.data || {};
  } catch (e) {
    g2gError("G2G refresh", e);
  }
  const d = body.payload || body.data || body;
  const access = d.access_token || d.accessToken;
  if (!access) {
    throw new Error(
      "G2G refresh: no access_token in response: " +
        JSON.stringify(body).slice(0, 200),
    );
  }
  const next = { accessToken: access };
  if (d.refresh_token) next.refreshToken = d.refresh_token;
  if (d.active_device_token) next.activeDeviceToken = d.active_device_token;
  if (d.long_lived_token) next.longLivedToken = d.long_lived_token;
  await setKeys("g2g", next);
  return access;
}

// Refresh proactively when the access token is within `withinMs` of expiry.
// Returns true if it actually refreshed. Cheap to call often.
async function g2gEnsureFreshToken(withinMs) {
  const keys = getKeys("g2g");
  if (!keys.refreshToken) return false;
  const margin = Number(withinMs) || 10 * 60 * 1000; // default 10 minutes
  if (keys.accessToken && g2gTokenMsLeft(keys.accessToken) > margin) {
    return false;
  }
  await g2gRefreshAccess();
  return true;
}

// One seller-API call. Refreshes-and-retries ONCE on 401: G2G's access token is
// short-lived, so any call can 401 at any moment, and a pre-flight liveness
// probe races that and loses (the same lesson eldRequest learned).
async function g2gRequest(method, path, opts = {}) {
  const keys = requireKeys("g2g");
  const send = async (token) => {
    return axios({
      method,
      url: G2G_SLS + path,
      params: opts.params,
      data: opts.body,
      headers: {
        // RAW token — a "Bearer " prefix here is a guaranteed 401.
        authorization: token,
        "Content-Type": "application/json",
        Origin: G2G_WEB,
        Referer: G2G_WEB + "/",
        "User-Agent": G2G_UA,
      },
      timeout: opts.timeout || 30000,
    });
  };
  let token = keys.accessToken;
  if (!token) token = await g2gRefreshAccess();
  let r;
  try {
    r = await send(token);
  } catch (e) {
    const status = e && e.response && e.response.status;
    if (status === 401 && !opts.__retried) {
      let fresh;
      try {
        fresh = await g2gRefreshAccess();
      } catch {
        g2gError(opts.what || "G2G", e);
      }
      try {
        r = await send(fresh);
      } catch (e2) {
        g2gError(opts.what || "G2G", e2);
      }
    } else {
      g2gError(opts.what || "G2G", e);
    }
  }
  const body = r.data || {};
  // G2G answers 200 with an in-band error code for some failures.
  if (body && body.code && Number(body.code) >= 4000) {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    throw new Error(
      (opts.what || "G2G") +
        " failed: " +
        (msgs.map((m) => m && m.text).filter(Boolean).join("; ") ||
          "code " + body.code),
    );
  }
  return body.payload !== undefined ? body.payload : body;
}

// The seller id is part of nearly every path/param, so read it once.
function g2gSellerId() {
  const keys = requireKeys("g2g");
  return String(keys.userId);
}

function g2gOfferUrl(offerId) {
  return G2G_WEB + "/offer/" + encodeURIComponent(String(offerId || ""));
}

async function g2gTest() {
  const seller = g2gSellerId();
  const p = await g2gRequest("get", "/order/count-my-orders", {
    params: { seller_id: seller },
    what: "G2G test",
  });
  const counts = p || {};
  const parts = [];
  if (counts.preparing != null) parts.push(counts.preparing + " to deliver");
  if (counts.delivering != null) parts.push(counts.delivering + " delivering");
  return {
    ok: true,
    detail:
      "Connected as seller " + seller +
      (parts.length ? " — " + parts.join(", ") : ""),
    data: counts,
  };
}

// ---- offers -------------------------------------------------------

// Every offer on the account. Paged; G2G caps limit at 100.
async function g2gListOffers({ pageSize = 100, maxPages = 30, status } = {}) {
  const seller = g2gSellerId();
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const params = { page, limit: pageSize };
    if (status) params.status = status;
    const p = await g2gRequest(
      "get",
      "/v3/offer/seller/" + encodeURIComponent(seller) + "/my_offers",
      { params, what: "G2G list offers" },
    );
    const rows = (p && (p.results || p.offers)) || [];
    for (const o of rows) {
      out.push({
        offerId: o.offer_id,
        title: o.title,
        status: o.status,
        currency: o.offer_currency || o.currency,
        unitPrice: o.unit_price,
        // available_qty is actual_qty minus what checkout is holding, so the
        // number to write back when syncing stock is actual_qty.
        availableQty: o.available_qty,
        actualQty: o.actual_qty,
        reservedQty: o.reserved_qty,
        minQty: o.min_qty,
        serviceId: o.service_id,
        brandId: o.brand_id,
        relationId: o.relation_id,
        url: g2gOfferUrl(o.offer_id),
      });
    }
    if (rows.length < pageSize) break;
  }
  return out;
}

async function g2gGetOffer(offerId) {
  if (!offerId) throw new Error("G2G offer_id is required");
  return g2gRequest("get", "/offer/" + encodeURIComponent(offerId), {
    what: "G2G get offer",
  });
}

// Partial update. G2G's PUT /offer/{id} wants the fields it is changing; send
// only what the caller asked for so an unrelated field is never clobbered.
async function g2gUpdateOffer(offerId, fields) {
  if (!offerId) throw new Error("G2G offer_id is required");
  const f = fields || {};
  const body = {};
  if (f.unitPrice != null && f.unitPrice !== "") {
    const price = Number(f.unitPrice);
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error("G2G needs a price above 0");
    }
    if (price < G2G_MIN_PRICE) {
      throw new Error("G2G's minimum price is " + G2G_MIN_PRICE.toFixed(2));
    }
    body.unit_price = price;
  }
  // Stock on a Game Items offer is actual_qty; available_qty is derived
  // (actual minus whatever checkout is holding) and is not settable.
  if (f.stock != null && f.stock !== "") {
    const qty = Number(f.stock);
    if (!Number.isFinite(qty) || qty < 0) {
      throw new Error("G2G needs a stock of 0 or more");
    }
    body.actual_qty = Math.round(qty);
  }
  if (f.title != null) body.title = String(f.title).slice(0, 128);
  if (f.description != null) {
    body.description = String(f.description).slice(0, 5000);
  }
  if (f.status != null) body.status = String(f.status);
  if (f.minQty != null) body.min_qty = Math.max(1, Number(f.minQty) || 1);
  if (!Object.keys(body).length) {
    throw new Error("G2G update: nothing to change");
  }
  body.seller_id = g2gSellerId();
  const p = await g2gRequest("put", "/offer/" + encodeURIComponent(offerId), {
    body,
    what: "G2G update offer",
  });
  return { externalId: String((p && (p.offer_id || p.id)) || offerId) };
}

function g2gReprice(offerId, priceUsd) {
  return g2gUpdateOffer(offerId, { unitPrice: priceUsd });
}

function g2gSetQuantity(offerId, qty) {
  return g2gUpdateOffer(offerId, { stock: qty });
}

// Take an offer off sale. This is a STATUS change, never a delete: G2G keeps
// the offer's history and sales count, and a deleted offer cannot be brought
// back. g2gRelist is its exact inverse.
async function g2gDelist(offerId) {
  await g2gUpdateOffer(offerId, { status: G2G_STATUS.DELISTED });
}

async function g2gRelist(offerId) {
  await g2gUpdateOffer(offerId, { status: G2G_STATUS.LIVE });
}

// The delivery methods and buyer purchase-form a (service, brand) pair allows.
// Read this before publishing — the allowed set differs per game (Albion offers
// Face to face trade / Island / Auction House) and G2G rejects an offer whose
// delivery_method_ids are not in it.
async function g2gProductSettings(serviceId, brandId) {
  const p = await g2gRequest(
    "get",
    "/offer/product_settings/service/" +
      encodeURIComponent(serviceId) +
      "/brand/" +
      encodeURIComponent(brandId) +
      "/product_settings",
    { what: "G2G product settings" },
  );
  const groups = (p && p.results) || [];
  const byType = {};
  for (const g of groups) byType[g.product_settings_type] = g.results || [];
  const delivery = (byType.delivery_method || []).map((d) => ({
    id: d.product_settings_id,
    code: (d.product_settings && d.product_settings.code) || "",
    label:
      (d.product_settings &&
        d.product_settings.label &&
        d.product_settings.label.en) ||
      "",
  }));
  return { delivery, purchaseForm: byType.purchase_form || [], raw: p };
}

// The per-(service, brand) product this offer hangs off. Every live offer
// carries one and G2G rejects a create without it.
async function g2gRelationId(serviceId, brandId) {
  const p = await g2gRequest("get", "/offer/keyword_relation/search", {
    params: { service_id: serviceId, brand_id: brandId },
    what: "G2G relation",
  });
  const first = ((p && p.results) || [])[0];
  return (first && first.relation_id) || "";
}

// The attribute collections a product demands — "Server", "Item Type",
// "Platform" and so on. Each is a dropdown with an enumerated child list, and
// `is_required` ones must all be answered or the create is rejected.
async function g2gCollections(relationId) {
  const p = await g2gRequest("get", "/offer/keyword_relation/collection/", {
    params: { relation_id: relationId },
    what: "G2G collections",
  });
  return ((p && p.results) || []).map((c) => ({
    collectionId: c.collection_id,
    label: (c.label && c.label.en) || c.collection_id,
    required: !!c.is_required,
    multiselect: !!c.is_multiselect,
    sortOrder: c.sort_order,
    values: (c.children || []).map((v) => ({
      datasetId: v.dataset_id,
      value: v.value || (v.label && v.label.en) || "",
    })),
  }));
}

// What attributes did WE last use for this game? The operator picked those by
// hand on g2g.com, so they are the only trustworthy answer: the dropdowns are
// per-game and their first entry is routinely wrong for us (Albion's first
// server is "Albion Americas" while every offer we run is "Albion Asia").
// Guessing files an offer under the wrong server, which is how the account
// ended up with a Rainbow Six Siege bundle sitting in Rainbow Six Mobile.
async function g2gAttributesFromOwnOffers(brandId, { limit = 60 } = {}) {
  const mine = await g2gListOffers({ pageSize: limit, maxPages: 3 });
  const match = mine.filter((o) => String(o.brandId) === String(brandId));
  for (const row of match) {
    let full;
    try {
      full = await g2gGetOffer(row.offerId);
    } catch {
      continue;
    }
    const attrs = (full && full.offer_attributes) || [];
    if (attrs.length) {
      return {
        attributes: attrs,
        collectionTree: full.offer_title_collection_tree || [],
        relationId: full.relation_id || "",
        fromOffer: row.offerId,
      };
    }
  }
  return null;
}

// Everything a create needs beyond title/price/stock, resolved from the live
// catalog plus our own history. Throws with a precise, actionable message
// rather than publishing something mis-filed.
async function g2gResolveOfferShape({ serviceId, brandId }) {
  const service = String(serviceId || G2G_ITEMS_SERVICE);
  const brand = String(brandId || "");
  const learned = await g2gAttributesFromOwnOffers(brand);
  const relationId =
    (learned && learned.relationId) || (await g2gRelationId(service, brand));
  if (!relationId) {
    throw new Error(
      "G2G: no product (relation_id) for brand " + brand +
        " under Game Items — this game cannot be listed there",
    );
  }
  const collections = await g2gCollections(relationId);
  const required = collections.filter((c) => c.required);
  const attributes = (learned && learned.attributes) || [];
  const answered = new Set(attributes.map((a) => a.collection_id));
  const missing = required.filter((c) => !answered.has(c.collectionId));
  if (missing.length) {
    throw new Error(
      "G2G needs " + missing.map((m) => m.label).join(" + ") +
        " for this game and we have no offer of our own to copy it from. " +
        "List one " + brand + " offer by hand on g2g.com first (choose " +
        missing
          .map(
            (m) =>
              m.label + ": one of " +
              m.values.slice(0, 6).map((v) => v.value).join(" / ") +
              (m.values.length > 6 ? " …" : ""),
          )
          .join("; ") +
        "), and every later publish will copy it.",
    );
  }
  return {
    relationId,
    attributes,
    collectionTree: (learned && learned.collectionTree) || [],
    learnedFrom: learned && learned.fromOffer,
  };
}

// Create a Game Items offer. `serviceId`/`brandId` identify the game; the
// legacy `productId` argument is accepted as the relation id so the existing
// publish route keeps working.
async function g2gPublish({
  serviceId,
  brandId,
  relationId,
  productId,
  title,
  description,
  priceUsd,
  qty,
  minQty,
  currency,
  offerAttributes,
  deliveryMethodIds,
  collectionTree,
  lowStockQty,
}) {
  const price = Number(priceUsd);
  const service = String(serviceId || G2G_ITEMS_SERVICE);
  const brand = String(brandId || "");
  if (!brand) throw new Error("G2G brand_id is required (the game)");
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error("G2G needs a price above 0");
  }
  if (price < G2G_MIN_PRICE) {
    throw new Error("G2G's minimum price is " + G2G_MIN_PRICE.toFixed(2));
  }
  const stock = Math.max(1, Number(qty) || 1);

  // A create without relation_id + the product's required attributes is
  // rejected, and one with the WRONG attributes is worse: it goes live filed
  // under another server or platform. Resolve both when the caller has not.
  let relation = relationId || productId || "";
  let attrs = offerAttributes;
  let tree = collectionTree;
  if (!relation || !Array.isArray(attrs) || !attrs.length) {
    const shape = await g2gResolveOfferShape({ serviceId: service, brandId: brand });
    relation = relation || shape.relationId;
    if (!Array.isArray(attrs) || !attrs.length) attrs = shape.attributes;
    if (!Array.isArray(tree) || !tree.length) tree = shape.collectionTree;
  }

  let dmIds = deliveryMethodIds;
  if (!Array.isArray(dmIds) || !dmIds.length) {
    // The product dictates which delivery methods are legal; take the first
    // one it offers rather than guessing an id that will be rejected.
    const settings = await g2gProductSettings(service, brand);
    dmIds = settings.delivery.slice(0, 1).map((d) => d.id);
    if (!dmIds.length) {
      throw new Error(
        "G2G: no delivery method available for this game — cannot publish",
      );
    }
  }

  // PUBLISHING IS TWO CALLS, AND THE FIRST ONE IS NOT THE OFFER.
  //
  // POST /offer does NOT create the offer you asked for. It answers 200 with a
  // real-looking offer_id, and every content field comes back empty:
  // title "", unit_price 0, actual_qty 0, delivery_method_ids []. It is an
  // empty DRAFT shell, and calling it twice returns the SAME shell — which is
  // how two different publishes ended up sharing one externalId, each pointing
  // at an offer that does not exist. The content only lands with the PUT below,
  // so a create that skips it silently publishes nothing at all.
  const created = await g2gRequest("post", "/offer", {
    body: { seller_id: g2gSellerId(), service_id: service, brand_id: brand },
    what: "G2G create offer",
  });
  const offerId = created && (created.offer_id || created.id);
  if (!offerId) {
    throw new Error(
      "G2G create: no offer id in response: " +
        JSON.stringify(created).slice(0, 300),
    );
  }

  const body = {
    seller_id: g2gSellerId(),
    service_id: service,
    brand_id: brand,
    relation_id: String(relation),
    offer_type: "public",
    title: String(title || "").slice(0, 128),
    description: String(description || title || "").slice(0, 5000),
    // `currency`, NOT `offer_currency` — the offer READS BACK as
    // offer_currency, so a read-modify-write sends the wrong name and the
    // write is rejected with "Missing mandatory parameter: currency".
    currency: currency || "USD",
    unit_price: price,
    min_qty: Math.max(1, Number(minQty) || 1),
    // Both, deliberately: actual_qty is the stock G2G stores, and a manual
    // delivery_speed additionally demands `qty` ("Missing mandatory parameter:
    // qty when delivery_speed is manual").
    actual_qty: stock,
    qty: stock,
    low_stock_alert_qty: Number(lowStockQty) || 0,
    delivery_method_ids: dmIds,
    // "manual", never "instant". Instant is the only speed G2G's OPEN api
    // accepts, which is exactly why the Open API cannot create these offers at
    // all; the seller API wants the same value our own live offers carry.
    delivery_speed: "manual",
    delivery_speed_details: [{ min: 1, max: 2147483647, delivery_time: 10 }],
    sales_territory_settings: { settings_type: "global", countries: [] },
    status: G2G_STATUS.LIVE,
  };
  if (Array.isArray(attrs) && attrs.length) body.offer_attributes = attrs;
  if (Array.isArray(tree) && tree.length) {
    body.offer_title_collection_tree = tree;
  }

  await g2gRequest("put", "/offer/" + encodeURIComponent(offerId), {
    body,
    what: "G2G publish offer",
  });

  // Read back before claiming success. A 200 is not evidence that anything
  // changed here — the create above proves it — and a listing row that records
  // an offer which does not exist is worse than no row at all, because the
  // next run reports it as correct.
  const back = await g2gGetOffer(offerId).catch(() => null);
  if (!back || !back.title) {
    throw new Error(
      "G2G publish: offer " + offerId + " did not read back as a live offer",
    );
  }
  return { externalId: String(offerId), url: g2gOfferUrl(offerId) };
}

// ---- orders -------------------------------------------------------

// The cheap poll: one small call that says whether anything needs doing.
// `preparing` is the count of paid orders awaiting delivery.
async function g2gOrderCounts() {
  return g2gRequest("get", "/order/count-my-orders", {
    params: { seller_id: g2gSellerId() },
    what: "G2G order counts",
  });
}

// Seller-side orders. NOTE the seller_id param is mandatory — omit it and G2G
// answers 4001 "Missing mandatory parameter: buyer_id", which reads like a bug
// report but just means "you didn't say which side you are".
async function g2gOrders({ page = 1, pageSize = 30, status } = {}) {
  const params = { seller_id: g2gSellerId(), page, limit: pageSize };
  if (status) params.status = status;
  const p = await g2gRequest("get", "/order/list_my_order", {
    params,
    what: "G2G orders",
  });
  const rows = (p && (p.results || p.orders)) || [];
  return rows.map(g2gNormalizeOrder);
}

function g2gNormalizeOrder(o) {
  return {
    orderId: o.order_id,
    orderItemId: o.order_item_id,
    offerId: o.offer_id,
    title: o.offer_title,
    buyerId: o.buyer_id,
    status: o.order_item_status,
    sellerStatus: o.seller_sub_status,
    purchasedQty: Number(o.purchased_qty) || 0,
    deliveredQty: Number(o.delivered_qty) || 0,
    refundedQty: Number(o.refunded_qty) || 0,
    unitPrice: Number(o.unit_price) || 0,
    amount: Number(o.amount) || 0,
    currency: o.offer_currency || o.checkout_currency || "USD",
    serviceId: o.service_id,
    raw: o,
  };
}

// Paid orders that still need delivering. `seller_sub_status: "to_deliver"` is
// the signal the seller UI itself uses for its "Preparing" tab.
async function g2gPendingOrders({ maxPages = 5, pageSize = 30 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const rows = await g2gOrders({ page, pageSize });
    for (const o of rows) {
      if (
        o.status === "preparing" ||
        o.sellerStatus === "to_deliver" ||
        (o.deliveredQty < o.purchasedQty && o.status === "delivering")
      ) {
        out.push(o);
      }
    }
    if (rows.length < pageSize) break;
  }
  return out;
}

async function g2gOrder(orderItemId) {
  if (!orderItemId) throw new Error("G2G order_item_id is required");
  const p = await g2gRequest(
    "get",
    "/order/item/" + encodeURIComponent(orderItemId),
    { params: { seller_id: g2gSellerId() }, what: "G2G order" },
  );
  return p;
}

// ---- delivery -----------------------------------------------------
//
// The lifecycle, read off a real completed order:
//   start_deliver      "You have viewed the delivery details."
//   mark_as_delivering "Delivery in progress."
//   delivered_qty      "You delivered N quantity."
//   (buyer confirms)   "Receipt of the item has been confirmed."  -> Completed
//
// delivered_qty is a COUNTER, not a hand-over channel — the delivery record
// carries no content. The credential itself travels through G2G chat, which is
// a Firebase Realtime Database and has no REST endpoint in the app's API map,
// so the hand-over stays operator-assisted for now (see utils/g2gFulfiller.js).

async function g2gStartDeliver(orderItemId) {
  return g2gRequest(
    "put",
    "/order/item/" + encodeURIComponent(orderItemId) + "/start_deliver",
    { body: { seller_id: g2gSellerId() }, what: "G2G start deliver" },
  );
}

async function g2gMarkDelivering(orderItemId) {
  return g2gRequest(
    "put",
    "/order/item/" + encodeURIComponent(orderItemId) + "/mark_as_delivering",
    { body: { seller_id: g2gSellerId() }, what: "G2G mark delivering" },
  );
}

async function g2gSetDeliveredQty(orderItemId, qty) {
  const n = Math.max(1, Number(qty) || 1);
  return g2gRequest(
    "put",
    "/order/item/" + encodeURIComponent(orderItemId) + "/delivered_qty",
    {
      body: { seller_id: g2gSellerId(), delivery_qty: n },
      what: "G2G delivered qty",
    },
  );
}

async function g2gDeliveries(orderItemId) {
  const p = await g2gRequest(
    "get",
    "/order/item/" + encodeURIComponent(orderItemId) + "/deliveries",
    { params: { seller_id: g2gSellerId() }, what: "G2G deliveries" },
  );
  return (p && p.results) || [];
}

// Proof of delivery. G2G only holds payment when a buyer does NOT confirm or
// opens a case — a confirmed order completes with no proof at all (verified on
// a real completed order, whose delivery_proofs is a 404). So this is a dispute
// safety net, not a per-sale step.
async function g2gDeliveryProofs(orderItemId) {
  try {
    const p = await g2gRequest(
      "get",
      "/order/item/" + encodeURIComponent(orderItemId) + "/delivery_proofs",
      { params: { seller_id: g2gSellerId() }, what: "G2G delivery proofs" },
    );
    return (p && (p.results || p)) || [];
  } catch (e) {
    // "Could not find any uploaded delivery proof" is the normal answer for an
    // order nobody disputed — a buyer-confirmed order completes with no proof
    // at all. Match on the HTTP status, not on wording: g2gError renders G2G's
    // message text and drops the 4041 code, and the text says "could not find",
    // which a /not found/ regex silently misses.
    if (e.status === 404 || /not\s*found|could not find/i.test(e.message)) {
      return [];
    }
    throw e;
  }
}

// ---- chat ---------------------------------------------------------

// Create-or-fetch our own SendBird chat profile. The POST (unlike the GET at
// the same path) is what returns `session_tokens`, which is how a server-side
// sender authenticates to SendBird without a second stored credential.
// See utils/g2gChat.js for why the token alone is not enough for SendBird REST.
async function g2gChatProfile(userId) {
  const id = String(userId || g2gSellerId());
  return g2gRequest("post", "/chat/user", {
    body: { user_id: id },
    what: "G2G chat profile",
  });
}


// ---- legacy Open API (catalog pickers + the xlsx bulk-file generator) ------
//
// HMAC-signed, key-based, and scoped by G2G to Gift Card & Top Up products. It
// cannot create or manage a Game Items offer, so nothing in the automation path
// uses it — these four calls only feed the manual catalog dropdowns in
// public/listings.html and utils/g2gBulk.js. They read their key bag directly
// rather than through requireKeys("g2g"), because FIELDS.g2g now holds the
// seller-session credential instead. With no API key on the account they answer
// 401 40100001; that is expected and harmless.
const G2G_API = "https://open-api.g2g.com";

function g2gOpenApiKeys() {
  const stored = (loadSettings().marketplaces || {}).g2g || {};
  const read = (f) => (stored[f] ? decrypt(stored[f]) : "");
  const keys = {
    userId: read("userId"),
    apiKey: read("apiKey"),
    apiSecret: read("apiSecret"),
  };
  if (!keys.apiKey || !keys.apiSecret) {
    throw new Error(
      "G2G's Open API has no key on this account — generate one at " +
        "g2g.com/offers/api if you need the catalog pickers. The listing and " +
        "delivery automation does not use it.",
    );
  }
  return keys;
}

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

async function g2gOpenRequest(method, urlPath, body) {
  const keys = g2gOpenApiKeys();
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

function g2gServices() {
  return g2gOpenRequest("get", "/v2/services");
}

function g2gBrands(serviceId) {
  return g2gOpenRequest(
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
  const d = await g2gOpenRequest("get", "/v2/products?" + qs.toString());
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
  return g2gOpenRequest(
    "get",
    "/v2/products/" + encodeURIComponent(productId) + "/attributes",
  );
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
    const type = (
      (/type="([^"]+)"/.exec(tag) || [])[1] || "text"
    ).toLowerCase();
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
    .map(
      (l) =>
        String(l || "")
          .trim()
          .toLowerCase() + ":",
    )
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
      what +
        ": " +
        String(err.description || err.message || "failed").slice(0, 300),
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
      {
        access_token: keys.accessToken || "",
        refresh_token: keys.refreshToken,
      },
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
    throw new Error(
      "ZeusX refresh: " + JSON.stringify(body.error || {}).slice(0, 200),
    );
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
      detail:
        "Signed in as " + (me.username || me.display_name || me.id || "seller"),
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
  const af = load().autoFarm || {};
  const map = af.zeusxGames || {};
  const key = String(game || "")
    .trim()
    .toLowerCase();
  if (!key) return null;
  if (map[key]) return map[key];
  const hit = Object.keys(map).find((k) => key.includes(k) || k.includes(key));
  return hit ? map[hit] : null;
}

// Storefront URL. ZeusX serves offers under
// /game/<game-slug>/<game_id>/<category>/<slug>, and only falls back to the id
// route when the create response has not filled the slug in yet.
function zeusxOfferUrl(offer) {
  const slug = offer && offer.slug;
  const gameId = offer && offer.game_id;
  const category = String(
    (offer &&
      (offer.service_category_name || offer.cache_sc_service_category_name)) ||
      "",
  )
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
  const gameSlug = String(
    (offer &&
      (offer.service_category_base_name || offer.cache_scb_base_name)) ||
      "",
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  if (slug && gameId && gameSlug && category) {
    return (
      "https://zeusx.com/game/" +
      gameSlug +
      "/" +
      gameId +
      "/" +
      category +
      "/" +
      slug
    );
  }
  return (
    "https://zeusx.com/offer/" +
    ((offer && offer.offer_code) || (offer && offer.id) || "")
  );
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
  if (
    zxMenuCache.bases.length &&
    Date.now() - zxMenuCache.at < ZX_MENU_TTL_MS
  ) {
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
  const core = cand.filter((w) => !ZX_EDITION_WORDS.has(w) && !/^\d+$/.test(w));
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
    const r = await axios.get(
      ZX_API + "/offer/" + encodeURIComponent(offerId),
      {
        headers: zxHeaders(keys),
        timeout: 20000,
      },
    );
    return zxData("ZeusX offer", r) || {};
  } catch (e) {
    throw zxError("ZeusX offer", e);
  }
}

async function zeusxUpdateOffer(
  offerId,
  { title, description, priceUsd, quantity } = {},
) {
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
      ZX_API +
        "/offer/my-sales-listing?pageIndex=" +
        (parseInt(pageIndex, 10) || 0),
      { headers: zxHeaders(keys), timeout: 20000 },
    );
    return zxData("ZeusX listings", r) || { sales: [] };
  } catch (e) {
    throw zxError("ZeusX listings", e);
  }
}

// ------------------------------------------------------------------
// Eldorado.gg (no usable public API — the seller panel's own JSON endpoints)
//
// Eldorado DOES have an official "Seller API", but it is gated behind 50
// completed orders and — verified 2026-09-06 by reading the full 125-path spec
// at /swagger/seller/swagger.json — it is the SAME surface on the SAME host.
// The gate unlocks the documentation, not capability, so there is nothing to
// wait for. See docs/ELDORADO-INTEGRATION-PLAN.md.
//
// Auth is cookie-based: httpOnly session cookies plus a CSRF double-submit.
// Every call must carry `X-XSRF-Token` whose value is the `__Host-XSRF-TOKEN`
// cookie — note the `__Host-` prefix, reading a plain `XSRF-TOKEN` yields
// nothing and the request 403s. This applies to GETs too whenever the jar holds
// that cookie, which a real signed-in session always does.
// POST /api/authentication/refreshTokens (no body) renews the session from the
// cookie, so the operator pastes a session once and the refresher keeps it
// alive — see utils/eldoradoSessionRefresher.
//
// Our product lists under Eldorado's native "Twitch Drops" category:
// gameId 235 / category CustomItem. Its "Game" selector has only 13 values;
// everything we farm that is not in that list goes under "Other" (id 11) with
// the game name carried in the title, which is what the dominant sellers do.
const ELD_BASE = "https://www.eldorado.gg";
const ELD_GAME_ID = "235";
const ELD_CATEGORY = "CustomItem";
// Eldorado's TalkJS application. Stable; only used to address the chat API.
const ELD_TALKJS_APP = "49mLECOW";
// Eldorado rejects anything under $0.50 (appConstants.offerConstants).
const ELD_MIN_PRICE = 0.5;

function eldCookieJar(str) {
  const jar = new Map();
  for (const part of String(str || "").split(/;\s*/)) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 1) continue;
    jar.set(part.slice(0, i).trim(), part.slice(i + 1));
  }
  return jar;
}

function eldJarHeader(jar) {
  return [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

// Fold a response's set-cookie back into the jar so refreshed session cookies
// survive. Returns true when anything actually changed (worth persisting).
function eldAbsorbCookies(jar, setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  let changed = false;
  for (const line of arr) {
    const pair = String(line).split(";")[0];
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1);
    if (jar.get(k) !== v) {
      jar.set(k, v);
      changed = true;
    }
  }
  return changed;
}

function eldXsrf(jar) {
  const raw = jar.get("__Host-XSRF-TOKEN") || jar.get("XSRF-TOKEN") || "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function eldError(label, e) {
  if (e && e.__eld) throw e;
  const status = e && e.response && e.response.status;
  const body = e && e.response && e.response.data;
  let detail = "";
  if (body && typeof body === "object" && Array.isArray(body.messages)) {
    detail = body.messages.join("; ");
  } else if (typeof body === "string" && body) {
    detail = body.slice(0, 300);
  }
  if (status === 401) {
    detail =
      detail ||
      "session not accepted — paste a fresh Eldorado cookie header from a " +
        "signed-in browser session";
  }
  const err = new Error(
    label + " failed" + (status ? " (HTTP " + status + ")" : "") +
      (detail ? ": " + detail : e && e.message ? ": " + e.message : ""),
  );
  err.__eld = true;
  err.status = status;
  throw err;
}

// One request against the seller panel, carrying the stored jar and the CSRF
// header. Persists renewed cookies back into settings.
//
// Eldorado's id token is short-lived, so ANY call can come back 401 at any
// moment — a pre-flight "is the session alive?" probe races that and loses. So
// a 401 refreshes the session and replays the request exactly once, which is
// what makes a long-running tick survive token expiry without operator input.
async function eldRequest(method, path, opts = {}) {
  try {
    return await eldRequestOnce(method, path, opts);
  } catch (e) {
    const status = e && e.response && e.response.status;
    const isRefresh = String(path).includes("authentication/refreshTokens");
    if (status !== 401 || isRefresh || opts.__retried) throw e;
    await eldoradoRefreshSession();
    return await eldRequestOnce(method, path, { ...opts, __retried: true });
  }
}

async function eldRequestOnce(method, path, opts = {}) {
  const keys = requireKeys("eldorado");
  const jar = eldCookieJar(keys.cookie);
  const m = String(method).toUpperCase();
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: ELD_BASE,
    Referer: ELD_BASE + "/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    Cookie: eldJarHeader(jar),
    ...(opts.headers || {}),
  };
  // The header goes on EVERY request, not just mutations: once the jar carries
  // a `__Host-XSRF-TOKEN` cookie, Eldorado 403s any request whose header does
  // not match it — GETs included (caught live 2026-09-06 on /authentication/claims).
  const xsrf = eldXsrf(jar);
  if (xsrf) headers["X-XSRF-Token"] = xsrf;
  let data = opts.data;
  if (data && data.getHeaders) Object.assign(headers, data.getHeaders());
  else if (data !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const r = await axios({
    method: m,
    url: ELD_BASE + path,
    data,
    headers,
    timeout: opts.timeout || 45000,
    responseType: opts.responseType || "json",
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  if (eldAbsorbCookies(jar, r.headers["set-cookie"])) {
    await setKeys("eldorado", { cookie: eldJarHeader(jar) });
  }
  return r.data;
}

async function eldoradoTest() {
  try {
    const claims = await eldRequest("GET", "/api/authentication/claims");
    const counts = await eldRequest(
      "GET",
      "/api/v1/item-management/me/offers/state-count?category=" + ELD_CATEGORY,
    ).catch(() => null);
    return {
      ok: true,
      detail:
        "Connected as " +
        ((claims && claims.email) || "seller") +
        (counts ? " — " + (counts.activeOffers || 0) + " active offers" : ""),
    };
  } catch (e) {
    return { ok: false, detail: eldSafeMessage(e) };
  }
}

function eldSafeMessage(e) {
  try {
    eldError("Eldorado", e);
  } catch (wrapped) {
    return wrapped.message;
  }
  return String((e && e.message) || e);
}

// The session cookie renews itself from the refresh cookie — no body, no
// stored refresh token. Returns true when the jar actually moved.
async function eldoradoRefreshSession() {
  const keys = requireKeys("eldorado");
  const jar = eldCookieJar(keys.cookie);
  const before = eldJarHeader(jar);
  try {
    await eldRequest("POST", "/api/authentication/refreshTokens", { data: {} });
  } catch (e) {
    eldError("Eldorado session refresh", e);
  }
  const after = getKeys("eldorado").cookie || "";
  return after !== before;
}

// Cheap liveness probe. eldRequest already refreshes-and-retries on any 401, so
// this is a health check for the refresher tick, not the thing keeping calls alive.
async function eldoradoEnsureFreshSession() {
  try {
    await eldRequest("GET", "/api/authentication/claims");
    return false;
  } catch (e) {
    if (e && e.status && e.status !== 401) throw e;
  }
  await eldoradoRefreshSession();
  await eldRequest("GET", "/api/authentication/claims");
  return true;
}

// --- Category placement -------------------------------------------------
// The "Game" selector for Twitch Drops is a fixed 13-value list. Anything not
// on it (Overwatch, CoD, WoT, Marvel Rivals, Fortnite …) goes under "Other",
// which is where the two dominant sellers put ~2/3 of their catalogue.
let eldTradeEnvCache = { at: 0, list: null };

async function eldoradoTradeEnvironments() {
  if (eldTradeEnvCache.list && Date.now() - eldTradeEnvCache.at < 6 * 3600e3) {
    return eldTradeEnvCache.list;
  }
  const lib = await eldRequest(
    "GET",
    "/api/library/" + ELD_GAME_ID + "/" + ELD_CATEGORY + "?locale=en-US",
  );
  const list = (lib && lib.tradeEnvironments) || [];
  if (list.length) eldTradeEnvCache = { at: Date.now(), list };
  return list;
}

function eldNorm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const ELD_GAME_ALIASES = {
  r6: "Rainbow Six Siege",
  r6s: "Rainbow Six Siege",
  rainbowsixsiegex: "Rainbow Six Siege",
  tomclancysrainbowsixsiege: "Rainbow Six Siege",
  eft: "Escape from Tarkov",
  escapefromtarkov: "Escape from Tarkov",
  pubgbattlegrounds: "PUBG",
  playerunknownsbattlegrounds: "PUBG",
  apex: "Apex Legends",
  bdo: "Black Desert",
  blackdesertonline: "Black Desert",
  eve: "EVE Online",
};

// Resolve one of our game names onto a tradeEnvironment, falling back to
// "Other". Returns { id, name, value } ready for the create payload.
async function eldoradoResolveGame(game) {
  const envs = await eldoradoTradeEnvironments();
  const want = eldNorm(ELD_GAME_ALIASES[eldNorm(game)] || game);
  const hit =
    envs.find((e) => eldNorm(e.value) === want) ||
    envs.find((e) => want && eldNorm(e.value) === eldNorm(ELD_GAME_ALIASES[want]));
  const chosen = hit || envs.find((e) => eldNorm(e.value) === "other");
  if (!chosen) throw new Error("Eldorado: could not resolve a Twitch Drops game slot");
  return { id: String(chosen.id), name: chosen.name || "Game", value: chosen.value };
}

// --- Images -------------------------------------------------------------
// A main image is MANDATORY on create ("Offer main image is missing." otherwise).
// Upload first, then reference the bare filenames on the offer.
async function eldoradoUploadImage(imagePath) {
  const form = new FormData();
  form.append("image", fs.createReadStream(imagePath));
  let res;
  try {
    res = await eldRequest("POST", "/api/files/me/Offer", {
      data: form,
      timeout: 90000,
    });
  } catch (e) {
    eldError("Eldorado image upload", e);
  }
  const paths = (res && res.localPaths) || [];
  const pick = (kind) => {
    const p = paths.find((x) => new RegExp(kind + "\\.[a-z]+$", "i").test(x));
    return p ? p.split("/").pop() : "";
  };
  const img = {
    smallImage: pick("Small"),
    largeImage: pick("Large"),
    originalSizeImage: pick("Original"),
  };
  if (!img.largeImage) throw new Error("Eldorado image upload returned no paths");
  return img;
}

// --- Listing ------------------------------------------------------------
function eldPrice(usd) {
  const n = Number(usd);
  if (!isFinite(n) || n <= 0) throw new Error("Eldorado: invalid price");
  return Math.max(ELD_MIN_PRICE, Math.round(n * 100) / 100);
}

// Create one Twitch Drops offer. `quantity` is the stock (one unit = one
// account), which is what makes this strictly better than the ZeusX
// one-listing-per-account model.
async function eldoradoPublish({
  game,
  title,
  description,
  priceUsd,
  quantity = 1,
  minQuantity = 1,
  coverImagePath,
  deliveryTime = "Minute20",
  volumeDiscounts = [],
  extraImagePaths = [],
}) {
  requireKeys("eldorado");
  if (!title) throw new Error("Eldorado: a title is required");
  if (!coverImagePath) {
    throw new Error("Eldorado: a cover image is required (the API rejects offers without one)");
  }
  const env = await eldoradoResolveGame(game);
  const mainOfferImage = await eldoradoUploadImage(coverImagePath);
  const offerImages = [];
  for (const p of (extraImagePaths || []).slice(0, 4)) {
    try {
      offerImages.push(await eldoradoUploadImage(p));
    } catch (e) {
      console.error("eldorado extra image failed:", e.message);
    }
  }
  const details = {
    offerTitle: String(title).slice(0, 160),
    description: String(description || "").slice(0, 2000),
    tradeEnvironmentValues: [{ id: env.id, name: env.name, value: env.value }],
    offerAttributeIdValues: [],
    attributes: [],
    guaranteedDeliveryTime: deliveryTime,
    pricing: {
      pricePerUnit: { amount: eldPrice(priceUsd), currency: "USD" },
      quantity: Math.max(1, parseInt(quantity, 10) || 1),
      minQuantity: Math.max(1, parseInt(minQuantity, 10) || 1),
      volumeDiscounts: volumeDiscounts || [],
    },
    mainOfferImage,
    offerImages,
  };
  const augmentedGame = {
    gameId: ELD_GAME_ID,
    category: ELD_CATEGORY,
    tradeEnvironmentId: env.id,
  };
  let created;
  try {
    created = await eldRequest("POST", "/api/v1/item-management/me/offers/item", {
      data: { details, augmentedGame },
    });
  } catch (e) {
    eldError("Eldorado publish", e);
  }
  return {
    // `externalId` is the name every other connector returns and the shared
    // publish route reads; `id` is kept for callers that already use it.
    externalId: created && created.id,
    id: created && created.id,
    url: eldoradoOfferUrl(created),
    raw: created,
  };
}

function eldoradoOfferUrl(offer) {
  if (!offer || !offer.id) return "";
  return ELD_BASE + "/twitch-drops/i/" + ELD_GAME_ID + "?offerId=" + offer.id;
}

// Read an offer back. NOTE the endpoint is `/private`; `/details` is PUT-only.
async function eldoradoOffer(offerId) {
  try {
    const r = await eldRequest(
      "GET",
      "/api/v1/item-management/me/offers/" + encodeURIComponent(offerId) + "/private",
    );
    return (r && r.offer) || null;
  } catch (e) {
    eldError("Eldorado offer", e);
  }
}

// Edit an existing offer in place (title / description / price / stock / game).
// Reads the current offer and rewrites the same {details, augmentedGame} DTO the
// create call takes, so an untouched field keeps its current value.
async function eldoradoUpdateOffer(offerId, patch = {}) {
  const cur = await eldoradoOffer(offerId);
  if (!cur) throw new Error("Eldorado: offer " + offerId + " not found");
  const env =
    patch.game != null
      ? await eldoradoResolveGame(patch.game)
      : {
          id: String(((cur.tradeEnvironmentValues || [])[0] || {}).id ?? "11"),
          name: ((cur.tradeEnvironmentValues || [])[0] || {}).name || "Game",
          value: ((cur.tradeEnvironmentValues || [])[0] || {}).value || "Other",
        };
  const details = {
    offerTitle: String(
      patch.title != null ? patch.title : cur.offerTitle || "",
    ).slice(0, 160),
    description: String(
      patch.description != null ? patch.description : cur.description || "",
    ).slice(0, 2000),
    tradeEnvironmentValues: [{ id: env.id, name: env.name, value: env.value }],
    offerAttributeIdValues: cur.offerAttributeIdValues || [],
    attributes: cur.attributes || [],
    guaranteedDeliveryTime:
      patch.deliveryTime || cur.guaranteedDeliveryTime || "Minute20",
    pricing: {
      pricePerUnit: {
        amount:
          patch.priceUsd != null
            ? eldPrice(patch.priceUsd)
            : (cur.pricePerUnit && cur.pricePerUnit.amount) || ELD_MIN_PRICE,
        currency: "USD",
      },
      quantity:
        patch.quantity != null
          ? Math.max(1, parseInt(patch.quantity, 10) || 1)
          : cur.quantity,
      minQuantity: patch.minQuantity != null ? patch.minQuantity : cur.minQuantity || 1,
      volumeDiscounts: patch.volumeDiscounts || cur.volumeDiscounts || [],
    },
    mainOfferImage: patch.mainOfferImage || cur.mainOfferImage,
    offerImages: patch.offerImages || cur.offerImages || [],
  };
  // NOTE: expireDate is deliberately NOT settable here. Offers auto-expire ~3
  // weeks after creation, Eldorado exposes no renew endpoint, and sending
  // expireDate through this DTO is silently IGNORED (verified live 2026-09-07 —
  // the value comes back unchanged). Keeping a listing alive past its date means
  // re-creating it, which is what the publisher scripts do when they treat a
  // closed/expired offer as absent.
  try {
    await eldRequest(
      "PUT",
      "/api/v1/item-management/me/offers/item/" +
        encodeURIComponent(offerId) +
        "/details",
      {
        data: {
          details,
          augmentedGame: {
            gameId: ELD_GAME_ID,
            category: ELD_CATEGORY,
            tradeEnvironmentId: env.id,
          },
        },
      },
    );
  } catch (e) {
    eldError("Eldorado update", e);
  }
  return await eldoradoOffer(offerId);
}

// Restock without rewriting the offer. The body is a BARE integer, not an
// object — this is the lever the farm uses to keep stock in step.
async function eldoradoSetQuantity(offerId, quantity) {
  const q = Math.max(0, parseInt(quantity, 10) || 0);
  try {
    await eldRequest(
      "PUT",
      "/api/v1/item-management/me/offers/" + encodeURIComponent(offerId) + "/quantity",
      { data: q },
    );
  } catch (e) {
    eldError("Eldorado set quantity", e);
  }
  return q;
}

async function eldoradoReprice(offerId, priceUsd) {
  const amount = eldPrice(priceUsd);
  try {
    await eldRequest(
      "PUT",
      "/api/v1/item-management/me/offers/" + encodeURIComponent(offerId) + "/price",
      { data: { amount, currency: "USD" } },
    );
  } catch (e) {
    eldError("Eldorado reprice", e);
  }
  return amount;
}

// Pausing takes the offer off the storefront and is reversible; DELETE is
// permanent, so delisting pauses (same contract as the ZeusX connector).
async function eldoradoDelist(offerId) {
  const cur = await eldoradoOffer(offerId).catch(() => null);
  if (cur && cur.offerState === "Paused") return;
  try {
    await eldRequest(
      "POST",
      "/api/v1/item-management/me/offers/" + encodeURIComponent(offerId) + "/pause",
    );
  } catch (e) {
    eldError("Eldorado delist", e);
  }
}

async function eldoradoRelist(offerId) {
  const cur = await eldoradoOffer(offerId).catch(() => null);
  if (cur && cur.offerState === "Active") return;
  try {
    await eldRequest(
      "POST",
      "/api/v1/item-management/me/offers/" + encodeURIComponent(offerId) + "/resume",
    );
  } catch (e) {
    eldError("Eldorado relist", e);
  }
}

async function eldoradoDeleteOffer(offerId) {
  try {
    await eldRequest(
      "DELETE",
      "/api/v1/item-management/me/offers/" + encodeURIComponent(offerId),
    );
  } catch (e) {
    eldError("Eldorado delete", e);
  }
}

async function eldoradoMyListings(pageIndex = 1, pageSize = 50) {
  try {
    return await eldRequest(
      "GET",
      "/api/v1/item-management/me/offers/me/search?pageIndex=" +
        (parseInt(pageIndex, 10) || 1) +
        "&pageSize=" +
        (parseInt(pageSize, 10) || 50),
    );
  } catch (e) {
    eldError("Eldorado listings", e);
  }
}

// --- Orders + delivery ---------------------------------------------------
// Eldorado has NO native credential vault for CustomItem (its auto-delivery is
// a Roblox in-game trading bot), so the hand-over is a chat message followed by
// marking the order delivered — which is exactly how the top seller on this
// category posts a 35-second median delivery time.
//
// The chat is TalkJS. Everything needed to post into it is derivable
// server-side (all verified live 2026-09-06 against the real chat iframe):
//   nymId                 = sha1(order.sellerId).hex[:20] + "_n"   <-- NOTE the suffix
//   conversation internal = sha1(order.talkJsConversationId).hex[:20]  (NO suffix)
//   sessionId             = client-generated, any stable random id
//   bearer token          = GET /api/conversations/me/authorize -> { token }
// then POST {appApi}/{appId}//say/{conversationInternalId}/?sessionId=…

function eldInternalId(externalId) {
  return crypto.createHash("sha1").update(String(externalId)).digest("hex").slice(0, 20);
}

// TalkJS USER ids carry a trailing "_n" that conversation ids do not. Without it
// the send is rejected with 404 {"error":"Sender does not exist"} — which is how
// this was caught, on a live send test against a completed order (2026-09-06).
function eldNymId(userId) {
  return eldInternalId(userId) + "_n";
}

// Seller orders in one state, filtered server-side. `displayFilter` is REQUIRED
// — omitting it returns 400. States: Paid | Disputed | Delivered | Received |
// Completed | Canceled | PendingReview.
async function eldoradoOrders({ orderState = "Paid", pageSize = 50 } = {}) {
  const qs = new URLSearchParams({
    displayFilter: "DisplaySellingOrders",
    orderGroup: "Regular",
    orderState,
    pageSize: String(Math.min(50, Math.max(1, parseInt(pageSize, 10) || 50))),
    pageDirection: "Next",
  });
  try {
    const r = await eldRequest("GET", "/api/v1/orders/me/seller/orders?" + qs);
    return (r && r.results) || [];
  } catch (e) {
    eldError("Eldorado orders", e);
  }
}

// The fulfiller's queue: paid but not yet delivered.
async function eldoradoPaidOrders(opts = {}) {
  return eldoradoOrders({ ...opts, orderState: "Paid" });
}

async function eldoradoOrderStateCounts() {
  try {
    return await eldRequest("GET", "/api/orders/me/statesCount");
  } catch (e) {
    eldError("Eldorado order counts", e);
  }
}

let eldTalkTokenCache = { at: 0, token: "" };

async function eldoradoTalkjsToken(force) {
  if (!force && eldTalkTokenCache.token && Date.now() - eldTalkTokenCache.at < 5 * 60e3) {
    return eldTalkTokenCache.token;
  }
  let r;
  try {
    r = await eldRequest("GET", "/api/conversations/me/authorize");
  } catch (e) {
    eldError("Eldorado chat authorize", e);
  }
  const token = (r && r.token) || "";
  if (!token) throw new Error("Eldorado chat: no TalkJS token returned");
  eldTalkTokenCache = { at: Date.now(), token };
  return token;
}

// One TalkJS session id per process is enough — it only correlates calls.
const ELD_TALK_SESSION = crypto.randomUUID
  ? crypto.randomUUID()
  : crypto.randomBytes(16).toString("hex");

// Post a message into an order's chat as the seller. `order` needs
// `sellerId` and `talkJsConversationId` (both present on the order rows).
async function eldoradoSendOrderMessage(order, text) {
  if (!order || !order.talkJsConversationId) {
    throw new Error("Eldorado chat: order has no talkJsConversationId");
  }
  const body = String(text || "").trim();
  if (!body) throw new Error("Eldorado chat: refusing to send an empty message");
  const token = await eldoradoTalkjsToken();
  const conv = eldInternalId(order.talkJsConversationId);
  const nymId = eldNymId(order.sellerId);
  const url =
    "https://app.talkjs.com/api/v0/" +
    ELD_TALKJS_APP +
    "//say/" +
    conv +
    "/?sessionId=" +
    encodeURIComponent(ELD_TALK_SESSION);
  const payload = {
    text: body,
    custom: undefined,
    nymId,
    // Makes a retry after a timeout safe — TalkJS dedupes on this.
    idempotencyKey:
      "eld-" + String(order.id || "") + "-" + crypto.createHash("sha1").update(body).digest("hex").slice(0, 12),
  };
  try {
    const r = await axios.post(url, payload, {
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "x-talkjs-client-build": "jssdk-release-2946179",
      },
      timeout: 30000,
    });
    return r.data || { ok: true };
  } catch (e) {
    if (e && e.response && e.response.status === 401) {
      // Token aged out mid-flight — mint a fresh one and retry once.
      const fresh = await eldoradoTalkjsToken(true);
      const r = await axios.post(url, payload, {
        headers: {
          Authorization: "Bearer " + fresh,
          "Content-Type": "application/json",
          "x-talkjs-client-build": "jssdk-release-2946179",
        },
        timeout: 30000,
      });
      return r.data || { ok: true };
    }
    eldError("Eldorado chat send", e);
  }
}

// Never call this before the buyer actually has the credential.
async function eldoradoMarkDelivered(orderId) {
  try {
    await eldRequest("PUT", "/api/orders/me/" + encodeURIComponent(orderId) + "/deliver");
  } catch (e) {
    eldError("Eldorado mark delivered", e);
  }
}

// ------------------------------------------------------------------
// PlayerAuctions
// ------------------------------------------------------------------
// Reverse-engineered private API behind member.playerauctions.com (an Angular
// app). Full verified contract: docs/PLAYERAUCTIONS-INTEGRATION-PLAN.md.
//
// Five hosts, split by concern, all cookie-authenticated:
//   user-api    — the member: messages, notifications, status, API keys
//   offer-api   — offers, the game/item taxonomy, offer images
//   order-api   — orders, order detail, delivery confirmation
//   account-api — sign-in and token refresh
//   public-api  — anonymous reference data (no credentials sent)
//
// Auth is cookie-only and there is NO CSRF token — the Angular bundle carries
// Angular's stock XSRF names but PlayerAuctions never sets an XSRF-TOKEN
// cookie, so no header is derived from it. Do not go looking for Eldorado's
// `__Host-XSRF-TOKEN` equivalent here; it does not exist.
//
// The session cookies are httpOnly, so — as with Eldorado — the operator pastes
// the whole Cookie header from a signed-in seller session once, and the server
// renews it in place via POST account-api/api/SignIn/RefreshToken (empty body).
const PA_USER_API = "https://user-api.playerauctions.com/api";
const PA_OFFER_API = "https://offer-api.playerauctions.com/api";
const PA_ORDER_API = "https://order-api.playerauctions.com/api";
const PA_ACCOUNT_API = "https://account-api.playerauctions.com/api";
const PA_MAIN_SITE = "https://www.playerauctions.com";
const PA_MEMBER_SITE = "https://member.playerauctions.com";

// PlayerAuctions rejects any trade whose price x minUnitPerOrder is under $5.
const PA_MIN_PRICE = 5;
// An order message is capped at 300 chars (50 for a brand-new member). The long
// claim guide therefore lives in the offer's `instruction` field instead — see
// paDeliveryMessage.
const PA_MAX_MESSAGE = 300;
// Writes are throttled server-side ("Operated too frequent"). Space them out.
const PA_WRITE_GAP_MS = 25000;

// deliveryGuarantee enum (GET offer-api/api/games/{id}/item/deliveryTimes).
const PA_DELIVERY = {
  min20: 5,
  hour1: 101,
  hour2: 4,
  hour6: 106,
  hour12: 12,
  hour24: 3,
  hour48: 6,
  day7: 1,
  day10: 102,
};

function paCookieJar(str) {
  const jar = new Map();
  for (const part of String(str || "").split(/;\s*/)) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 1) continue;
    jar.set(part.slice(0, i).trim(), part.slice(i + 1));
  }
  return jar;
}

function paJarHeader(jar) {
  return [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

// Fold a response's Set-Cookie back into the jar so a refreshed session sticks.
// Returns true when something actually changed (worth persisting).
function paAbsorbCookies(jar, setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  let changed = false;
  for (const line of arr) {
    const pair = String(line).split(";")[0];
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1);
    if (jar.get(k) !== v) {
      jar.set(k, v);
      changed = true;
    }
  }
  return changed;
}

// PlayerAuctions answers HTTP 200 for business failures and hides the verdict in
// the envelope, so every caller goes through this. Branching on the HTTP status
// alone silently treats a rejected create as a success.
function paUnwrap(label, body) {
  if (body && typeof body === "object" && "isSuccess" in body) {
    if (body.isSuccess === false) {
      const err = new Error(
        label +
          " failed" +
          (body.code ? " (code " + body.code + ")" : "") +
          (body.message ? ": " + body.message : ""),
      );
      err.__pa = true;
      err.paCode = body.code;
      // code 1 is the write throttle — worth retrying, unlike a validation 400.
      err.retryable = body.code === 1;
      throw err;
    }
    return "data" in body ? body.data : body;
  }
  return body;
}

function paError(label, e) {
  if (e && e.__pa) throw e;
  const status = e && e.response && e.response.status;
  const body = e && e.response && e.response.data;
  let detail = "";
  if (body && typeof body === "object" && body.message) detail = String(body.message);
  else if (typeof body === "string" && body) detail = body.slice(0, 300);
  if (status === 401) {
    detail =
      detail ||
      "session not accepted — paste a fresh PlayerAuctions cookie header from " +
        "a signed-in seller session";
  }
  if (status === 403) detail = detail || "account suspended";
  if (status === 429) detail = detail || "rate limited";
  const err = new Error(
    label +
      " failed" +
      (status ? " (HTTP " + status + ")" : "") +
      (detail ? ": " + detail : e && e.message ? ": " + e.message : ""),
  );
  err.__pa = true;
  err.status = status;
  err.retryable = status === 429;
  throw err;
}

// One request against the seller API, carrying the stored jar. A 401 refreshes
// the session and replays exactly once — PlayerAuctions' access token is short
// lived, so any call can 401 at any moment and a pre-flight liveness probe
// races that and loses (the lesson Eldorado taught).
async function paRequest(method, base, path, opts = {}) {
  const tokenWeUsed = paStoredAccessToken();
  try {
    return await paRequestOnce(method, base, path, opts);
  } catch (e) {
    const status = e && e.response && e.response.status;
    const isRefresh = String(path).includes("SignIn/RefreshToken");
    if (status !== 401 || isRefresh || opts.__retried) throw e;
    // Serialised across processes; may be a no-op if someone else refreshed
    // first, in which case the retry simply picks up their jar.
    await paRefreshOnce(tokenWeUsed);
    return await paRequestOnce(method, base, path, { ...opts, __retried: true });
  }
}

async function paRequestOnce(method, base, path, opts = {}) {
  const keys = requireKeys("playerauctions");
  const jar = paCookieJar(keys.cookie);
  const m = String(method).toUpperCase();
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Origin: PA_MEMBER_SITE,
    Referer: PA_MEMBER_SITE + "/",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    Cookie: paJarHeader(jar),
    ...(opts.headers || {}),
  };
  let data = opts.data;
  if (data && data.getHeaders) Object.assign(headers, data.getHeaders());
  else if (data !== undefined && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const r = await axios({
    method: m,
    url: base + path,
    data,
    headers,
    timeout: opts.timeout || 45000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  if (paAbsorbCookies(jar, r.headers["set-cookie"])) {
    await setKeys("playerauctions", { cookie: paJarHeader(jar) });
  }
  return r.data;
}

async function paGet(base, path, label) {
  try {
    return paUnwrap(label, await paRequest("GET", base, path));
  } catch (e) {
    return paError(label, e);
  }
}

// The game and item taxonomy answers anonymously, so it must not be gated on
// having a cookie. This matters more than it looks: the publishers ask "does
// this game accept Item offers?" BEFORE any credential is needed, and the
// auto-lister's per-game gate treats a thrown error as "not supported" — so
// routing taxonomy through the authenticated path would quietly disable
// PlayerAuctions listing for every game whenever the cookie lapsed.
async function paPublicGet(base, path, label) {
  try {
    const r = await axios({
      method: "GET",
      url: base + path,
      headers: {
        Accept: "application/json, text/plain, */*",
        Origin: PA_MEMBER_SITE,
        Referer: PA_MEMBER_SITE + "/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      },
      timeout: 45000,
    });
    return paUnwrap(label, r.data);
  } catch (e) {
    return paError(label, e);
  }
}

async function paSend(method, base, path, data, label) {
  try {
    return paUnwrap(label, await paRequest(method, base, path, { data }));
  } catch (e) {
    return paError(label, e);
  }
}

async function playerauctionsTest() {
  try {
    const st = await paGet(PA_USER_API, "/User/status", "PlayerAuctions status");
    const offers = await paGet(
      PA_OFFER_API,
      "/Offer/Offers?pageIndex=1&pageSize=1&sortField=null&sortOrder=null",
      "PlayerAuctions offers",
    ).catch(() => null);
    const m = (st && st.members) || {};
    return {
      ok: true,
      detail:
        "Connected as " +
        (m.nickName || "seller") +
        (st && st.isSeller ? " (seller)" : "") +
        (offers ? " — " + (offers.count || 0) + " active offers" : ""),
    };
  } catch (e) {
    return { ok: false, detail: paSafeMessage(e) };
  }
}

function paSafeMessage(e) {
  try {
    paError("PlayerAuctions", e);
  } catch (wrapped) {
    return wrapped.message;
  }
  return String((e && e.message) || e);
}

// The seller's own profile — memberId, nickname, seller level. `level` gates
// two things that matter: proof-of-delivery screenshots (level 0 must attach
// them) and the official API-key programme (level 2+).
async function playerauctionsMe() {
  return await paGet(PA_USER_API, "/User/status", "PlayerAuctions status");
}

async function playerauctionsSellerLevel() {
  const st = await playerauctionsMe().catch(() => null);
  const lvl = st && st.members ? st.members.level : null;
  return Number.isFinite(lvl) ? lvl : 0;
}

// --- The refresh lock ---------------------------------------------------
//
// PlayerAuctions rotates the whole session on refresh, and presenting a spent
// refresh token revokes the family. That makes a CONCURRENT refresh fatal, and
// concurrency here is normal, not exotic: the pm2 server's fulfiller ticks every
// 60s while a publishing script runs for an hour in its own process, both
// reading the same jar out of settings.json. When the 30-minute access token
// expires they 401 within moments of each other, both refresh, and the second
// one kills the session. That is exactly how it died twice on 2026-09-07.
//
// PlayerAuctions' own web client has this problem across browser tabs and
// solves it the same way — its HTTP interceptor carries a localStorage
// refreshTokenLock with a 15s timeout and a 5s cool-down. This is the
// server-side equivalent, using an atomic exclusive file create as the lock.
//
// The important half is not the lock but the RE-CHECK under it: if the stored
// access token has changed since our request was built, somebody else already
// refreshed and we simply use their result instead of spending the token again.
const PA_LOCK_FILE = path.join(__dirname, ".playerauctions-refresh.lock");
const PA_STAMP_FILE = path.join(__dirname, ".playerauctions-refresh.stamp");
const PA_LOCK_TIMEOUT_MS = 30000;
const PA_LOCK_POLL_MS = 250;
// A second refresh this soon after a successful one is a stampede, not a real
// need. Belt and braces alongside the token comparison: if a refresh ever fails
// to change the stored token, the comparison cannot dedupe and only this can.
// PlayerAuctions' own client carries the same idea as COOL_DOWN_PERIOD.
const PA_COOLDOWN_MS = 15000;

function paStoredAccessToken() {
  try {
    return paCookieJar(getKeys("playerauctions").cookie || "").get("Production_access_token") || "";
  } catch {
    return "";
  }
}

function paLastRefreshAge() {
  try {
    return Date.now() - Number(fs.readFileSync(PA_STAMP_FILE, "utf8").trim());
  } catch {
    return null; // never refreshed on this host
  }
}

function paStampRefresh() {
  try {
    fs.writeFileSync(PA_STAMP_FILE, String(Date.now()), "utf8");
  } catch {
    /* the stamp is an optimisation, not a correctness requirement */
  }
}

function paLockAge() {
  try {
    return Date.now() - fs.statSync(PA_LOCK_FILE).mtimeMs;
  } catch {
    return null; // no lock
  }
}

function paTryLock() {
  try {
    fs.closeSync(fs.openSync(PA_LOCK_FILE, "wx"));
    return true;
  } catch {
    // A lock left behind by a killed process must not wedge every future
    // refresh, so one older than the timeout is taken over.
    const age = paLockAge();
    if (age != null && age > PA_LOCK_TIMEOUT_MS) {
      try {
        fs.unlinkSync(PA_LOCK_FILE);
        fs.closeSync(fs.openSync(PA_LOCK_FILE, "wx"));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function paUnlock() {
  try {
    fs.unlinkSync(PA_LOCK_FILE);
  } catch {
    /* already gone */
  }
}

const paSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Refresh at most once across every process on this host. `tokenWeUsed` is the
// access token the failed request carried; when the stored one no longer
// matches it, another process has already refreshed and we skip straight to the
// retry.
// `doRefresh` exists so the serialisation can be tested without a live session;
// production always uses the real refresh.
async function paRefreshOnce(tokenWeUsed, doRefresh = playerauctionsRefreshSession) {
  if (tokenWeUsed && paStoredAccessToken() !== tokenWeUsed) return false;

  const deadline = Date.now() + PA_LOCK_TIMEOUT_MS;
  while (!paTryLock()) {
    if (Date.now() > deadline) break; // give up waiting; re-check below
    await paSleep(PA_LOCK_POLL_MS);
    // Whoever holds the lock may have finished in the meantime.
    if (tokenWeUsed && paStoredAccessToken() !== tokenWeUsed) return false;
  }
  try {
    // Re-check under the lock — the window between "lock is free" and "we hold
    // it" is exactly where a double refresh would slip through.
    if (tokenWeUsed && paStoredAccessToken() !== tokenWeUsed) return false;
    const age = paLastRefreshAge();
    if (age != null && age >= 0 && age < PA_COOLDOWN_MS) return false;
    await doRefresh();
    paStampRefresh();
    return true;
  } finally {
    paUnlock();
  }
}

// Read the JWT expiry out of the stored jar without calling PlayerAuctions.
// Used by the self-check to report session health, because the obvious
// alternative — "test the refresh" — destroys the session (see below).
function playerauctionsTokenExpiry() {
  const out = { access: null, refresh: null };
  let cookie = "";
  try {
    cookie = getKeys("playerauctions").cookie || "";
  } catch {
    return out;
  }
  const jar = paCookieJar(cookie);
  for (const [name, key] of [
    ["Production_access_token", "access"],
    ["Production_refresh_token", "refresh"],
  ]) {
    const raw = jar.get(name);
    if (!raw) continue;
    try {
      const body = JSON.parse(
        Buffer.from(String(raw).split(".")[1], "base64").toString("utf8"),
      );
      if (body && body.exp) out[key] = new Date(body.exp * 1000);
    } catch {
      /* a jar we cannot parse is not an error, just unknown */
    }
  }
  return out;
}

// Renews the session from the refresh cookie. Body is an empty object; the new
// cookies come back as Set-Cookie and are folded into the stored jar.
//
// ⚠ THIS IS DESTRUCTIVE TO EVERY OTHER COPY OF THE JAR.
// PlayerAuctions rotates the WHOLE session on refresh: a success mints a new
// session id (the `sid` claim changes) and invalidates every other copy of that
// cookie, and presenting an already-spent refresh token reads as token reuse
// and revokes the entire family — signing the operator's browser out with it.
// Learned the hard way 2026-09-07: the same paste was installed on a laptop and
// on prod, each refreshed once, and the account was signed out everywhere.
//
// Rule: exactly ONE host owns a given cookie, and only its session refresher
// ever calls this. Never "test" it from a second machine.
async function playerauctionsRefreshSession() {
  const keys = requireKeys("playerauctions");
  const before = paJarHeader(paCookieJar(keys.cookie));
  try {
    await paRequest("POST", PA_ACCOUNT_API, "/SignIn/RefreshToken", { data: {} });
  } catch (e) {
    paError("PlayerAuctions session refresh", e);
  }
  const after = getKeys("playerauctions").cookie || "";
  return after !== before;
}

// Cheap liveness probe for the refresher tick. paRequest already refreshes and
// replays on 401, so this is a health check, not the thing keeping calls alive.
// Health check for the refresher tick — NOT a pre-flight probe.
//
// paRequest already refreshes-and-retries on 401, under the cross-process lock.
// So this only has to answer "is the session usable?". The earlier version
// called playerauctionsRefreshSession() DIRECTLY when the probe failed, which
// bypassed the lock and spent the refresh token a second time — the exact
// "a pre-flight liveness probe races the refresh and loses" trap the Eldorado
// integration had already documented.
//
// Nothing on the hot path should call this: the fulfiller does not need it,
// because its first real request refreshes on its own if it has to.
async function playerauctionsEnsureFreshSession() {
  const before = paStoredAccessToken();
  await paRequest("GET", PA_USER_API, "/User/status");
  return paStoredAccessToken() !== before;
}

// --- Taxonomy -----------------------------------------------------------
// These endpoints answer anonymously, so they stay readable even when the
// cookie has lapsed. Cached because they change on the order of months.
let paGamesCache = { at: 0, list: null };

async function playerauctionsGames() {
  if (paGamesCache.list && Date.now() - paGamesCache.at < 12 * 3600e3) {
    return paGamesCache.list;
  }
  const list = await paPublicGet(PA_OFFER_API, "/games", "PlayerAuctions games");
  if (Array.isArray(list) && list.length) {
    paGamesCache = { at: Date.now(), list };
  }
  return list || [];
}

function paNorm(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// Our farm's game names are not PlayerAuctions' storefront names. These are the
// pairs that do not fall out of a normalised comparison.
const PA_GAME_ALIASES = {
  overwatch2: "Overwatch",
  callofduty: "Call of Duty - Warzone / BO7 & All Legacy Versions",
  cod: "Call of Duty - Warzone / BO7 & All Legacy Versions",
  callofdutywarzone: "Call of Duty - Warzone / BO7 & All Legacy Versions",
  modernwarfare: "Call of Duty - Warzone / BO7 & All Legacy Versions",
  blackops7: "Call of Duty - Warzone / BO7 & All Legacy Versions",
  r6: "Tom Clancys Rainbow Six Siege",
  r6s: "Tom Clancys Rainbow Six Siege",
  rainbowsixsiege: "Tom Clancys Rainbow Six Siege",
  rainbowsixsiegex: "Tom Clancys Rainbow Six Siege",
  tomclancysrainbowsixsiege: "Tom Clancys Rainbow Six Siege",
  tomclancysrainbowsixsiegex: "Tom Clancys Rainbow Six Siege",
  eft: "Escape From Tarkov",
  escapefromtarkov: "Escape From Tarkov",
  tarkov: "Escape From Tarkov",
  halo: "Halo Infinite",
  halocampaignevolved: "Halo Infinite",
  rust: "RUST",
  pubg: "PUBG: BATTLEGROUNDS",
  pubgbattlegrounds: "PUBG: BATTLEGROUNDS",
  playerunknownsbattlegrounds: "PUBG: BATTLEGROUNDS",
  apex: "Apex Legends",
  bdo: "Black Desert",
  blackdesertonline: "Black Desert",
  eve: "EVE Online",
  wot: "World of Tanks",
  lol: "League of Legends",
  callofdutymodernwarfare: "Call of Duty - Warzone / BO7 & All Legacy Versions",
  callofdutyblackops: "Call of Duty - Warzone / BO7 & All Legacy Versions",
  callofdutywarzone2: "Call of Duty - Warzone / BO7 & All Legacy Versions",
  cs2: "Counter-Strike 2",
  counterstrike2: "Counter-Strike 2",
  thefinals: "The Finals",
  naraka: "NARAKA: BLADEPOINT",
  narakabladepoint: "NARAKA: BLADEPOINT",
};

// Resolve one of our game names to a PlayerAuctions catalogue row.
// Returns null when the game is not on PlayerAuctions at all.
//
// Our names come from Twitch campaign data and are usually MORE specific than
// PlayerAuctions' storefront name — "NBA 2K27" vs their "NBA 2K",
// "Call of Duty: Modern Warfare 4" vs their one giant
// "Call of Duty - Warzone / BO7 & All Legacy Versions" row. So the useful
// direction is mostly "is their name a prefix of ours?", not the reverse, and
// a bare exact match resolves only a minority of the catalogue.
async function playerauctionsResolveGame(game) {
  const raw = String(game || "").trim();
  if (!raw) return null;
  const games = await playerauctionsGames();
  const alias = (t) => PA_GAME_ALIASES[paNorm(t)];
  const want = paNorm(alias(raw) || raw);
  if (!want) return null;

  // 1. Exact, after normalisation.
  const exact = games.find((g) => paNorm(g.gameName) === want);
  if (exact) return exact;

  // 2. The part before a colon, through the alias map. This is what carries
  //    every "Call of Duty: <subtitle>" onto their single Call of Duty row.
  if (raw.includes(":")) {
    const head = raw.split(":")[0].trim();
    const mapped = alias(head);
    if (mapped) {
      const hit = games.find((g) => paNorm(g.gameName) === paNorm(mapped));
      if (hit) return hit;
    }
  }

  // 3. THEIR name is a prefix of ours — "NBA 2K" for our "NBA 2K27",
  //    "Hunt: Showdown" for our "Hunt: Showdown 1896", "Overwatch" for
  //    "Overwatch 2". Longest wins, so "Call of Duty Mobile" can never beat a
  //    better match, and a very short storefront name cannot swallow
  //    everything that happens to start with it.
  const prefixes = games
    .filter((g) => paNorm(g.gameName).length >= 4 && want.startsWith(paNorm(g.gameName)))
    .sort((a, b) => paNorm(b.gameName).length - paNorm(a.gameName).length);
  if (prefixes.length) return prefixes[0];

  // 4. OURS is a prefix of theirs, or merely contained in it. Both are looser,
  //    so they need a longer needle before they are allowed to fire.
  if (want.length >= 6) {
    const pre = games.find((g) => paNorm(g.gameName).startsWith(want));
    if (pre) return pre;
    const inc = games.find((g) => paNorm(g.gameName).includes(want));
    if (inc) return inc;
  }
  return null;
}

// Does this game accept the product type we want to list under? Only 149 of
// PlayerAuctions' ~400 games allow "item" — several games we farm (Rainbow Six,
// Apex, Rocket League, Dead by Daylight, The Finals) are account-only, and an
// Item offer for them is rejected. Callers must check before publishing.
function paGameSupports(game, productType) {
  const types = String((game && game.productType) || "")
    .toLowerCase()
    .split(",")
    .map((s) => s.trim());
  return types.includes(String(productType || "").toLowerCase());
}

// The item tree. NOTE the plural: /games/{id}/Items/categories is the tree,
// while /games/{id}/Item/categories is a 404. Both spellings are load-bearing.
async function playerauctionsItemCategories(gameId) {
  return (
    (await paPublicGet(
      PA_OFFER_API,
      "/games/" + encodeURIComponent(gameId) + "/Items/categories",
      "PlayerAuctions item categories",
    )) || []
  );
}

async function playerauctionsServers(gameId) {
  return (
    (await paPublicGet(
      PA_OFFER_API,
      "/games/" + encodeURIComponent(gameId) + "/Item/servers",
      "PlayerAuctions servers",
    )) || []
  );
}

async function playerauctionsDeliveryTimes(gameId) {
  return (
    (await paPublicGet(
      PA_OFFER_API,
      "/games/" + encodeURIComponent(gameId) + "/item/deliveryTimes",
      "PlayerAuctions delivery times",
    )) || []
  );
}

// Pick the leaf item to file a drops bundle under, or refuse.
//
// PlayerAuctions' item trees are per-game and often narrow, so there is not
// always an honest home for a Twitch-drops bundle. Real examples:
//
//   Overwatch      Skins > Other Skins          <- good
//   Call of Duty   Bundle > Other Bundles       <- good (what the live offers use)
//   Marvel Rivals  Twitch Drops > Twitch Drops  <- a literal category, perfect
//   Fortnite       Ore > Copper Ore, Skins > Spider-Man, ...
//   NBA 2K         VC > 15000 VC                <- currency only
//   Palia          {id:-1, "Others", no subs}   <- a sentinel, not a category
//
// The first pass here filed Fortnite under "Copper Ore" and NBA 2K under
// "15000 VC". Both were accepted by the API and both are wrong: a buyer
// browsing NBA 2K currency would find a drops bundle. Mis-filing is worse than
// not listing on a marketplace that penalises disputes, so this REFUSES
// (returns null) unless it finds a defensible home, and the publishers report
// the game as unlistable instead.
// Roots that can honestly hold a cosmetic drops bundle, best first. Tree order
// is not preference order — Fortnite lists "Weapons" before "Skins" — so these
// are scored rather than scanned.
const PA_ROOT_PREFERENCE = [
  /twitch\s*drops?/i,
  /drop/i,
  /skin|cosmetic/i,
  /coating|armou?r/i,
  /bundle|pack/i,
  /outfit|emote|spray|charm|banner|icon/i,
  /weapon/i,
];
// Currency and hard-goods roots. A drops bundle filed under "15000 VC" or
// "Copper Ore" is accepted by the API and is still wrong — a buyer browsing
// NBA 2K currency should not find one.
const PA_ROOT_DENY =
  /^(vc|gold|coin|credit|currenc|cash|silver|gem|token|ore|crystal|powder|twine|material|mechanical)/i;

function paRootScore(name) {
  const n = String(name || "");
  if (PA_ROOT_DENY.test(n.trim())) return -1;
  for (let i = 0; i < PA_ROOT_PREFERENCE.length; i++) {
    if (PA_ROOT_PREFERENCE[i].test(n)) return i;
  }
  return -1;
}

async function playerauctionsPickItemPath(gameId, hint) {
  const tree = await playerauctionsItemCategories(gameId);
  if (!tree.length) return null;
  const want = paNorm(hint || "");
  // id <= 0 is a sentinel row, not a real category; filing under it yields
  // "Invalid Item Name" on create.
  const roots = tree.filter((r) => Number(r.id) > 0);
  if (!roots.length) return null;

  const asLeaf = (root, sub) => ({
    rootItem: root.id,
    rootName: root.name,
    itemId: sub ? sub.id : root.id,
    itemName: sub ? sub.name : root.name,
    itemPath: root.id + "|" + (sub ? sub.id : root.id),
  });
  const subsOf = (root) => (root.subCategorys || []).filter((x) => Number(x.id) > 0);

  // 1. A category literally named for our product wins outright.
  const native = roots.find((r) => /twitch\s*drops?/i.test(String(r.name || "")));
  if (native) {
    const subs = subsOf(native);
    return asLeaf(native, subs[0] || null);
  }

  // 2. An explicit hint, anywhere in the tree.
  if (want) {
    for (const root of roots) {
      for (const sub of subsOf(root)) {
        if (paNorm(sub.name) === want || paNorm(sub.name).includes(want)) {
          return asLeaf(root, sub);
        }
      }
    }
  }

  // 3. The best-scoring cosmetic root. Its "Other ..." leaf if it has one —
  //    the honest catch-all the hand-made listings on this account use — and
  //    otherwise its first leaf, which is the same compromise the operator's
  //    own live Halo offer makes (Armor Coatings > Funko). The ROOT is what
  //    categorises the listing; the title carries the real product.
  const ranked = roots
    .map((r) => ({ root: r, score: paRootScore(r.name) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => a.score - b.score);
  for (const { root } of ranked) {
    const subs = subsOf(root);
    if (!subs.length) return asLeaf(root, null);
    const neutral = subs.find((x) => /^(other|misc|general|any)/i.test(String(x.name).trim()));
    return asLeaf(root, neutral || subs[0]);
  }

  // No cosmetic root at all — a currency-only tree (NBA 2K) or nothing but the
  // sentinel (Palia). Better no listing than a misfiled one.
  return null;
}

// The delivery-guarantee enum is PER GAME, not global. Marvel Rivals and Palia
// have no 20-minute tier at all, and sending customId 5 there is rejected with
// "Delivery time can't be empty or error delivery time." So resolve the wanted
// tier against the game's own list and fall back to the fastest it does offer —
// a slower guarantee is a worse listing, but no listing is worse still.
async function playerauctionsResolveDelivery(gameId, wanted) {
  const tiers = await playerauctionsDeliveryTimes(gameId).catch(() => []);
  const usable = tiers.filter((t) => t && t.isEnable !== false);
  if (!usable.length) return wanted;
  if (usable.some((t) => t.customId === Number(wanted))) return Number(wanted);
  const fastest = usable
    .slice()
    .sort((a, b) => (a.convertToHour || 0) - (b.convertToHour || 0))[0];
  return fastest ? fastest.customId : wanted;
}

// --- Offers -------------------------------------------------------------
function playerauctionsOfferUrl(offer) {
  if (!offer) return "";
  if (offer.url) return offer.url;
  const id = offer.offerId || offer.id || offer;
  return PA_MAIN_SITE + "/i/" + encodeURIComponent(id) + "/";
}

// The seller-search filter that Cancel and HideOrDisplay both demand. Omitting
// it 400s with "The keywords field is required.;The ProductType field is
// required.;The ListingStatus field is required."
function paSearchParameters() {
  return { keywords: "", productType: "All", listingStatus: "Active" };
}

// PlayerAuctions rejects a title it does not like with a flat
// "Title format error." and no detail. Every title on the account that DOES
// work is plain ASCII, and the ones that failed all carried typographic
// characters our own listing copy introduces — an em dash in "Fortnite Twitch
// Drops (5 Items) — …", a "…" ellipsis, a "|" separator. So fold the
// typography down to ASCII rather than dropping the listing.
const PA_TITLE_FOLD = [
  [/[\u2010-\u2015\u2212]/g, "-"],   // hyphens, en/em dashes, minus
  [/\u2026/g, "..."],                 // ellipsis
  [/[\u2018\u2019\u201B]/g, "'"],     // curly single quotes
  [/[\u201C\u201D\u201F]/g, '"'],     // curly double quotes
  [/[\u00D7\u2715\u2716]/g, "x"],     // multiplication signs
  [/[\u00A0\u2007\u202F]/g, " "],     // non-breaking spaces
  [/[|]/g, "-"],                      // pipe reads as a format error too
];

function paSanitizeTitle(title) {
  let t = String(title || "");
  for (const [re, to] of PA_TITLE_FOLD) t = t.replace(re, to);
  // Accented letters fold to their base letter FIRST, so "Pok\u00e9mon" becomes
  // "Pokemon" rather than losing the letter to "Pokmon" below. That is not
  // cosmetic: the rent-farm fulfiller reads the game back out of our own
  // title, and a dropped letter left six live Pok\u00e9mon GO offers unable to
  // resolve their game at all.
  t = t.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  // Anything still outside printable ASCII goes; a title is not worth failing
  // a publish over.
  t = t.replace(/[^\x20-\x7E]/g, "");
  // Folding can leave doubled separators ("A - - B") and edge punctuation.
  t = t.replace(/\s+/g, " ").replace(/(\s-)+\s-/g, " -").replace(/^[\s-]+|[\s-]+$/g, "");
  return t.slice(0, 150).trim();
}

// Build the Item offer DTO. `isAgree`/`agreeCheck` are forced true because the
// server reads them back as false, so a read-modify-write would drop the
// Secure Seller Delivery Agreement and the write would be rejected.
function paItemOfferBody({
  gameId,
  itemPath,
  rootItem,
  itemId,
  categoryId = 0,
  serverId = 0,
  title,
  description,
  instruction = "",
  priceUsd,
  itemsPerUnit = 1,
  totalUnit = 1,
  minUnitPerOrder = 1,
  offerDuration = 30,
  deliveryGuarantee = PA_DELIVERY.min20,
  discounts = [],
  blobName,
  screenShot,
}) {
  const price = Math.max(PA_MIN_PRICE, Number(priceUsd) || 0);
  const body = {
    gameId: Number(gameId),
    itemPath: String(itemPath || ""),
    rootItem: Number(rootItem),
    itemId: Number(itemId),
    categoryId: Number(categoryId) || 0,
    serverId: Number(serverId) || 0,
    title: paSanitizeTitle(title),
    offerDesc: String(description || ""),
    instruction: String(instruction || ""),
    price,
    itemsPerUnit: Number(itemsPerUnit) || 1,
    totalUnit: Number(totalUnit) || 1,
    minUnitPerOrder: Number(minUnitPerOrder) || 1,
    offerDuration: Number(offerDuration) || 30,
    deliveryGuarantee: Number(deliveryGuarantee),
    discounts: discounts || [],
    otherItem: "",
    deliveryTime: 0,
    isAgree: true,
    agreeCheck: true,
  };
  if (blobName) body.blobName = blobName;
  if (screenShot) body.screenShot = screenShot;
  return body;
}

// Publish one Item offer. Resolves the game and the item leaf when the caller
// did not pin them, so callers can pass a plain game name.
async function playerauctionsPublish(opts = {}) {
  requireKeys("playerauctions");
  let { gameId, itemPath, rootItem, itemId } = opts;
  if (!gameId) {
    const g = await playerauctionsResolveGame(opts.game);
    if (!g) throw new Error("PlayerAuctions has no game matching " + opts.game);
    if (!paGameSupports(g, "item")) {
      throw new Error(
        "PlayerAuctions game " + g.gameName + " does not accept Item offers " +
          "(allowed: " + g.productType + ")",
      );
    }
    gameId = g.gameId;
  }
  if (!itemPath) {
    const leaf = await playerauctionsPickItemPath(gameId, opts.itemHint);
    if (!leaf) throw new Error("no item category found for PlayerAuctions game " + gameId);
    itemPath = leaf.itemPath;
    rootItem = leaf.rootItem;
    itemId = leaf.itemId;
  }
  // Artwork is optional here (an Item offer publishes without one), so a failed
  // upload must never cost us the listing.
  let blobName = opts.blobName;
  let screenShot = opts.screenShot;
  if (!blobName && opts.coverImagePath) {
    try {
      // The upload answers {blobName, sasUri, created, length, verified} —
      // note `sasUri`, not `url`. Missing it left every cover half-wired: the
      // blob name was set but the offer carried no image URL.
      const up = await playerauctionsUploadImage(opts.coverImagePath, gameId);
      blobName = (up && (up.blobName || up.name)) || "";
      screenShot = (up && (up.sasUri || up.url || up.imageUrl || up.path)) || "";
    } catch (e) {
      console.error("playerauctions image upload:", e.message);
    }
  }
  const deliveryGuarantee = await playerauctionsResolveDelivery(
    gameId,
    opts.deliveryGuarantee != null ? opts.deliveryGuarantee : PA_DELIVERY.min20,
  );
  const body = paItemOfferBody({
    ...opts,
    gameId,
    itemPath,
    rootItem,
    itemId,
    deliveryGuarantee,
    blobName,
    screenShot,
  });
  const created = await paSend(
    "POST",
    PA_OFFER_API,
    "/offers/Item",
    body,
    "PlayerAuctions publish",
  );
  const offerId = paOfferIdOf(created);
  return { offerId, id: offerId, url: playerauctionsOfferUrl(offerId), raw: created };
}

// Pull an offer id out of a storefront URL. Offer pages are
// ".../<game>-items/294684983i!<slug>/", so the id is the digits before "i!".
// The seller ORDERS list carries no offerId field at all — only the order's
// title and a link on the detail — so this is how an order is tied back to the
// listing row that knows how to fulfil it.
function playerauctionsOfferIdFromUrl(url) {
  const m = String(url || "").match(/\/(\d+)i!/);
  return m ? m[1] : "";
}

// The create response has been seen as both a bare id and an object.
function paOfferIdOf(created) {
  if (created == null) return "";
  if (typeof created === "number" || typeof created === "string") return String(created);
  return String(created.offerId || created.id || "");
}

async function playerauctionsOffer(offerId) {
  return await paGet(
    PA_OFFER_API,
    "/offers/Item/" + encodeURIComponent(offerId),
    "PlayerAuctions offer",
  );
}

// Update an offer.
//
// ⚠ PlayerAuctions implements an update as cancel-old + create-new, so this
// returns a DIFFERENT offerId and the old one stops resolving. Callers MUST
// persist the returned id — a stored externalId goes stale on every reprice or
// restock, and a fulfiller pointed at a dead offer silently stops delivering.
async function playerauctionsUpdateOffer(offerId, patch = {}) {
  const cur = await playerauctionsOffer(offerId);
  if (!cur) throw new Error("PlayerAuctions offer " + offerId + " not found");
  const body = paItemOfferBody({
    gameId: cur.gameId,
    itemPath: cur.itemPath,
    rootItem: cur.rootItem,
    itemId: cur.itemId,
    categoryId: cur.categoryId,
    serverId: cur.serverId,
    title: patch.title !== undefined ? patch.title : cur.title,
    description: patch.description !== undefined ? patch.description : cur.offerDesc,
    instruction: patch.instruction !== undefined ? patch.instruction : cur.instruction,
    priceUsd: patch.priceUsd !== undefined ? patch.priceUsd : cur.price,
    itemsPerUnit: patch.itemsPerUnit !== undefined ? patch.itemsPerUnit : cur.itemsPerUnit,
    totalUnit: patch.totalUnit !== undefined ? patch.totalUnit : cur.totalUnit,
    minUnitPerOrder:
      patch.minUnitPerOrder !== undefined ? patch.minUnitPerOrder : cur.minUnitPerOrder,
    offerDuration: patch.offerDuration !== undefined ? patch.offerDuration : cur.offerDuration,
    deliveryGuarantee:
      patch.deliveryGuarantee !== undefined ? patch.deliveryGuarantee : cur.deliveryGuarantee,
    discounts: patch.discounts !== undefined ? patch.discounts : cur.discounts,
    blobName: cur.blobName,
    screenShot: cur.screenShot,
  });
  body.offerId = Number(offerId);
  const res = await paSend(
    "PUT",
    PA_OFFER_API,
    "/offers/Item",
    body,
    "PlayerAuctions update offer",
  );
  const newId = paOfferIdOf(res) || String(offerId);
  return { offerId: newId, replaced: newId !== String(offerId), raw: res };
}

// Stock and price are ordinary field updates, but they inherit the new-id
// behaviour above, so both return the id the caller must now store.
async function playerauctionsSetQuantity(offerId, totalUnit) {
  return await playerauctionsUpdateOffer(offerId, {
    totalUnit: Math.max(0, parseInt(totalUnit, 10) || 0),
  });
}

async function playerauctionsReprice(offerId, priceUsd) {
  return await playerauctionsUpdateOffer(offerId, { priceUsd });
}

async function playerauctionsMyListings(pageIndex = 1, pageSize = 50) {
  const res = await paGet(
    PA_OFFER_API,
    "/Offer/Offers?pageIndex=" + pageIndex + "&pageSize=" + pageSize +
      "&sortField=null&sortOrder=null",
    "PlayerAuctions listings",
  );
  return { count: (res && res.count) || 0, items: (res && res.items) || [] };
}

// Hide (delist) / display (relist). Pausing keeps the offer, unlike Cancel.
async function playerauctionsHide(offerId) {
  return await paSend(
    "POST",
    PA_OFFER_API,
    "/Offer/HideOrDisplay",
    { flag: "hide", offerIds: [Number(offerId)], isAll: false, parameters: paSearchParameters() },
    "PlayerAuctions hide offer",
  );
}

async function playerauctionsDisplay(offerId) {
  return await paSend(
    "POST",
    PA_OFFER_API,
    "/Offer/HideOrDisplay",
    { flag: "display", offerIds: [Number(offerId)], isAll: false, parameters: paSearchParameters() },
    "PlayerAuctions display offer",
  );
}

async function playerauctionsDelist(offerId) {
  return await playerauctionsHide(offerId);
}

async function playerauctionsRelist(offerId) {
  return await playerauctionsDisplay(offerId);
}

// Permanent. Prefer hide() when the offer may come back.
async function playerauctionsCancelOffer(offerId) {
  return await paSend(
    "POST",
    PA_OFFER_API,
    "/Offer/Cancel",
    { offerIds: [Number(offerId)], isAll: false, parameters: paSearchParameters() },
    "PlayerAuctions cancel offer",
  );
}

// Offer artwork. Optional — an Item offer publishes without one — but a listing
// with a cover converts better, so the publishers attach one when they can.
async function playerauctionsUploadImage(imagePath, gameId, { isTitle = true } = {}) {
  const fd = new FormData();
  fd.append("file", fs.createReadStream(imagePath));
  if (gameId != null) fd.append("gameId", String(gameId));
  if (isTitle) fd.append("type", "title");
  return await paSend(
    "POST",
    PA_OFFER_API,
    "/media/images",
    fd,
    "PlayerAuctions image upload",
  );
}

// --- Orders -------------------------------------------------------------
async function playerauctionsOrders({ pageIndex = 1, pageSize = 100 } = {}) {
  const res = await paGet(
    PA_ORDER_API,
    "/Order/SellerOrders?pageIndex=" + pageIndex + "&pageSize=" + pageSize +
      "&sortField=null&sortOrder=null",
    "PlayerAuctions orders",
  );
  return { count: (res && res.count) || 0, items: (res && res.items) || [] };
}

async function playerauctionsOrderDetail(orderId) {
  return await paGet(
    PA_ORDER_API,
    "/orderdetail/" + encodeURIComponent(orderId),
    "PlayerAuctions order detail",
  );
}

// An order is ours to ship when payment has settled and we have not already
// claimed delivery.
//
// Deciding this from a status string alone is not safe, and the reason is
// concrete: the coarse `status.orderStatus` reads "Pending Delivery" BOTH
// before and after the seller claims delivery (verified on order 16458589,
// whose display string had already moved to "Delivery Pending Buyer
// Confirmation"). And no paid-but-unshipped order existed on the account while
// this was reverse-engineered, so the exact display string for that state is
// unobserved — guessing it would either miss every sale or re-ship every
// completed one.
//
// So the authoritative check is the ORDER'S OWN EVENT LOG, which is a factual
// record rather than a label: payment has settled, and no seller delivery claim
// has been written. The status strings are used only as a cheap pre-filter to
// avoid fetching detail for orders that obviously need nothing.

// States that can never need shipping: unpaid, cancelled, refunded, or already
// seen through to the end.
// NOTE the absence of a bare "completed": a paid-and-awaiting-delivery order
// could plausibly be labelled something like "Payment Completed", and matching
// that would silently stop every delivery. Only delivery/order completion
// excludes an order here.
const PA_NOT_SHIPPABLE =
  /(pending payment|payment failed|cancel|refund|fully completed|order completed|disputed)/i;
// States that mean the seller has already handed over.
const PA_ALREADY_SHIPPED = /(pending buyer|inspection|feedback|delivered)/i;

// Event-log evidence.
const PA_PAID_EVENT = /(payment settlement completed|payment verified|payment received)/i;
const PA_DELIVERED_EVENT =
  /(delivery claimed by seller|full delivery claimed|marked as delivered|delivery completed)/i;

function paStatusStrings(order) {
  const st = order && order.status;
  return [
    String((order && order.orderStatus) || ""),
    String((st && st.orderStatus) || ""),
    String((st && st.current) || (typeof st === "string" ? st : "")),
  ].filter(Boolean);
}

// Cheap pre-filter over a LIST row. Deliberately permissive: anything not
// obviously finished is worth one detail fetch, because a missed sale is far
// more expensive than an extra GET.
function playerauctionsNeedsDelivery(order) {
  const strings = paStatusStrings(order);
  if (strings.some((s) => PA_ALREADY_SHIPPED.test(s))) return false;
  if (strings.some((s) => PA_NOT_SHIPPABLE.test(s))) return false;
  return true;
}

// The authoritative check, against a full order detail.
function playerauctionsDetailNeedsDelivery(detail) {
  if (!detail) return false;
  if (!playerauctionsNeedsDelivery(detail)) return false;
  const logs = (detail.eventLogs || [])
    .map((e) => String((e && e.content) || "").replace(/<[^>]+>/g, " "))
    .join(" | ");
  // Already handed over — never re-ship.
  if (PA_DELIVERED_EVENT.test(logs)) return false;
  // Payment has to have settled. When the log carries no payment event at all
  // (an older order, or a shape we have not seen), fall back to the status
  // strings rather than refusing to ship a genuine sale.
  if (PA_PAID_EVENT.test(logs)) return true;
  return paStatusStrings(detail).some((s) => /pending delivery|delivery pending/i.test(s));
}

// The delivery queue. The list endpoint carries a display status only, so every
// candidate is confirmed against its order detail — which is also where the
// event log and the guarantee clock live.
async function playerauctionsPendingOrders(opts = {}) {
  const { items } = await playerauctionsOrders(opts);
  const out = [];
  for (const o of items) {
    if (!playerauctionsNeedsDelivery(o)) continue;
    const detail = await playerauctionsOrderDetail(o.orderId).catch(() => null);
    // A detail we could not read is not evidence of anything; skip rather than
    // ship blind.
    if (!detail) continue;
    if (!playerauctionsDetailNeedsDelivery(detail)) continue;
    out.push({ ...o, detail });
  }
  return out;
}

// --- Read-only console feeds --------------------------------------------
// These exist so the operator never has to open PlayerAuctions in a browser.
// That is not a convenience: signing in anywhere rotates the session id and
// kills the server's copy, so the browser is the single thing that breaks
// auto-delivery. Reading through the server's own session removes the reason
// to go there at all.

async function playerauctionsBalance() {
  return await paGet(PA_USER_API, "/Disburse/detail", "PlayerAuctions balance");
}

async function playerauctionsMessages() {
  return await paGet(PA_USER_API, "/User/Messages", "PlayerAuctions messages");
}

async function playerauctionsMessageThread(id, isFromSystem = false) {
  return await paGet(
    PA_USER_API,
    "/messages/detail?id=" + encodeURIComponent(id) + "&isFromSystem=" + !!isFromSystem,
    "PlayerAuctions message",
  );
}

async function playerauctionsNotifications({ pageIndex = 1, pageSize = 20 } = {}) {
  return await paGet(
    PA_USER_API,
    "/User/Notifications?pageIndex=" + pageIndex + "&pageSize=" + pageSize,
    "PlayerAuctions notifications",
  );
}

// One cheap call the console opens on: who we are, how the session is doing,
// what is on sale and what is waiting to ship.
async function playerauctionsSnapshot() {
  const out = { at: new Date().toISOString() };
  const exp = playerauctionsTokenExpiry();
  out.session = {
    accessMinsLeft: exp.access ? Math.round((exp.access - Date.now()) / 60000) : null,
    refreshMinsLeft: exp.refresh ? Math.round((exp.refresh - Date.now()) / 60000) : null,
  };
  const me = await playerauctionsMe();
  const m = (me && me.members) || {};
  out.seller = {
    nickName: m.nickName,
    memberId: m.memberId,
    level: m.level,
    role: m.role,
    isSeller: !!(me && me.isSeller),
  };
  const offers = await playerauctionsMyListings(1, 50);
  out.offers = { count: offers.count, items: offers.items };
  const orders = await playerauctionsOrders({ pageSize: 100 });
  const byStatus = {};
  for (const o of orders.items) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  out.orders = { count: orders.count, byStatus, items: orders.items.slice(0, 40) };
  out.pending = (await playerauctionsPendingOrders({ pageSize: 100 })).map((o) => ({
    orderId: o.orderId,
    title: o.orderTitle,
    buyer: o.name,
    price: o.price,
    quantity: o.quantity,
    createTime: o.createTime,
    status: o.status,
  }));
  return out;
}

// --- Delivery -----------------------------------------------------------
// The credential travels as an order message. PlayerAuctions caps a message at
// 300 characters (50 for a brand-new member), which is why the long claim guide
// belongs in the offer's `instruction` field and not in here.
async function playerauctionsSendOrderMessage(orderId, content) {
  const text = String(content || "");
  if (text.length > PA_MAX_MESSAGE) {
    throw new Error(
      "PlayerAuctions message is " + text.length + " chars, over the " +
        PA_MAX_MESSAGE + "-char limit — shorten it or move the detail into the " +
        "offer's instruction field",
    );
  }
  return await paSend(
    "POST",
    PA_USER_API,
    "/messages",
    { objectIdType: "Order", objectId: Number(orderId), content: text },
    "PlayerAuctions send message",
  );
}

// Mark an order delivered.
//
// ⚠ multipart, not JSON, and at seller level 0 PlayerAuctions REQUIRES 1-2
// screenshots as proof of delivery. `proofImagePaths` is therefore mandatory in
// practice for this account — see utils/playerauctionsProof.js, which renders
// one. Never call this before the buyer actually has the credential.
async function playerauctionsMarkDelivered(orderId, proofImagePaths = []) {
  const fd = new FormData();
  const paths = (Array.isArray(proofImagePaths) ? proofImagePaths : [proofImagePaths])
    .filter(Boolean)
    .slice(0, 2);
  for (const p of paths) fd.append("images", fs.createReadStream(p));
  return await paSend(
    "POST",
    PA_ORDER_API,
    "/order/confirmdelivery/" + encodeURIComponent(orderId),
    fd,
    "PlayerAuctions mark delivered",
  );
}

// ------------------------------------------------------------------
// Z2U (z2u.com)
//
// Z2U has no API of any kind — not even the half-API ZeusX exposes. The seller
// panel is a server-rendered PHP site (ThinkPHP) and every "endpoint" is the
// same form the browser posts, so this connector drives the site the way
// FunPay is driven: one stored session cookie, scrape the page, re-submit its
// own form.
//
// Auth is the whole Cookie header from a signed-in session, pasted once
// (DevTools -> Network -> any z2u.com request -> copy the Cookie header). The
// session cookies are httpOnly, so the operator is the only possible source.
// Renewed cookies are absorbed back into settings on every call, so the paste
// keeps rolling for as long as Z2U keeps the session alive.
//
// **Z2U does NOT challenge server-side calls.** Verified live 2026-09-08 from
// the production host: `/` answers 200 and `/sell/manage` answers a plain 302
// to the login page — a WAF would have returned 403. An older note in this
// codebase claimed cf_clearance was bound to the operator's browser IP and
// that prod would need an extension bridge to publish; that is not true of
// these paths today, and the bridge was never needed.
//
// The seller panel surface, all confirmed live against the real account:
//   GET  /sell/manage                          -> the game tiles (service+game ids)
//   GET  /sell/manageList?service=&game=       -> every offer in one group
//   GET  /sell/manageEdit.html?id=<pk>         -> one offer's editor form
//   POST /sell/manageListToUpdate              -> save that form (price/stock/text)
//   POST /sell/productAction {list_pk,list_action}
//                                              -> on_line | off_line | extend
//   POST /sell/submitSellInfo                  -> create a new offer
//   GET  /sellOrder/index/order_status/<S>     -> sold orders (S = ALL,
//                                                 WAIT_DELIVERY, DELIVERED,
//                                                 COMMENT, CANCELED)
//   GET  /sellOrder?order_id=<Z…>              -> one order + its delivery form
//   POST /sellOrder/form_submit                -> deliver that order
//   POST /public/createToken                   -> the per-request CSRF token
//
// Ajax replies are ThinkPHP envelopes: {code, msg, data, url, wait}, where
// code 1 is success and code 0 carries a human message in `msg`.
const Z2U_BASE = "https://www.z2u.com";
// Z2U rejects anything under $0.30 on the item categories we sell in.
const Z2U_MIN_PRICE = 0.3;

// The seller-panel status codes on `.set_status[data-value]`, read off the
// live shelf 2026-09-08. 1 is the only one that is actually on sale; the two
// off-sale codes are worth telling apart because they need different repairs:
// a seller-paused offer just needs `on_line`, while one Z2U itself pulled for
// running out its duration needs `extend` first or it falls straight back off.
const Z2U_STATUS = {
  1: "online",
  4: "paused",
  5: "expired",
};

function z2uJar(str) {
  const jar = new Map();
  for (const part of String(str || "").split(/;\s*/)) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 1) continue;
    jar.set(part.slice(0, i).trim(), part.slice(i + 1));
  }
  return jar;
}

function z2uJarHeader(jar) {
  return [...jar.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

// Fold Set-Cookie replies back into the jar. Returns true when anything moved,
// so the caller only writes settings when there is something to write.
function z2uAbsorbCookies(jar, setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  let moved = false;
  for (const raw of arr) {
    const pair = String(raw).split(";")[0];
    const i = pair.indexOf("=");
    if (i < 1) continue;
    const k = pair.slice(0, i).trim();
    const v = pair.slice(i + 1);
    // A logout/expiry clears the cookie by setting it empty — never let that
    // overwrite a live value, or one stray response burns the session.
    if (!v || v === "deleted") continue;
    if (jar.get(k) !== v) {
      jar.set(k, v);
      moved = true;
    }
  }
  return moved;
}

function z2uHtmlText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    // Cell HTML is cut mid-tag by the row splitter, so the fragment ends with a
    // dangling "<div" that has no ">" to close it and survives the strip above.
    .replace(/<[^>]*$/, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// A signed-out session does not error — Z2U just 302s to the login page, and
// following that redirect would hand the caller a perfectly valid 200 of the
// wrong page. So redirects are NOT followed and a 3xx to /login is the session
// check.
function z2uCheckSession(r, what) {
  const loc = String((r.headers && r.headers.location) || "");
  if (r.status >= 300 && r.status < 400 && /login|signin|passport/i.test(loc)) {
    const e = new Error(
      what +
        ": Z2U session expired — paste a fresh Cookie header under " +
        "Marketplace keys -> Z2U (DevTools -> Network -> any z2u.com request " +
        "-> copy the Cookie header).",
    );
    e.__z2uAuth = true;
    throw e;
  }
}

async function z2uRequest(method, path, opts = {}) {
  return (await z2uRequestFull(method, path, opts)).data;
}

// Same request, but the whole axios response — Z2U returns its CSRF token in a
// RESPONSE HEADER, so at least one caller needs more than the body.
async function z2uRequestFull(method, path, opts = {}) {
  const keys = requireKeys("z2u");
  const jar = z2uJar(keys.cookie);
  const headers = {
    Accept: opts.ajax
      ? "application/json, text/javascript, */*; q=0.01"
      : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
    Cookie: z2uJarHeader(jar),
    Referer: Z2U_BASE + "/sell/manage",
    Origin: Z2U_BASE,
    ...(opts.headers || {}),
  };
  if (opts.ajax) headers["X-Requested-With"] = "XMLHttpRequest";
  let data = opts.data;
  if (data && data.getHeaders) Object.assign(headers, data.getHeaders());
  else if (data && typeof data === "object" && !(data instanceof String)) {
    data = new URLSearchParams(data).toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  }
  const r = await axios({
    method: String(method).toUpperCase(),
    url: Z2U_BASE + path,
    data,
    headers,
    timeout: opts.timeout || 45000,
    // The bulk template is a real .xlsx; without this axios sniffs it as text
    // and the bytes come back mangled, so the ZIP header parse fails with an
    // out-of-range offset rather than anything that names the real problem.
    ...(opts.responseType ? { responseType: opts.responseType } : {}),
    maxRedirects: 0,
    // 3xx must reach us as a value, not an exception, so z2uCheckSession can
    // tell "signed out" from every other failure.
    validateStatus: (s) => s >= 200 && s < 400,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  z2uCheckSession(r, opts.what || "Z2U");
  if (z2uAbsorbCookies(jar, r.headers["set-cookie"])) {
    await setKeys("z2u", { cookie: z2uJarHeader(jar) });
  }
  return r;
}

// ThinkPHP's ajaxReturn envelope. code 1 = success; anything else carries a
// message worth surfacing verbatim, because Z2U's are specific ("Order does
// not exist.", "Insufficient inventory").
function z2uAjax(what, body) {
  let j = body;
  if (typeof j === "string") {
    try {
      j = JSON.parse(j);
    } catch {
      throw new Error(
        what + ": Z2U returned HTML, not JSON (session or CSRF problem)",
      );
    }
  }
  if (!j || typeof j !== "object") throw new Error(what + ": empty reply");
  if (Number(j.code) !== 1) {
    throw new Error(
      what + ": " + String(j.msg || j.data || "failed").slice(0, 200),
    );
  }
  return j;
}

// Z2U mints a one-shot CSRF token per mutating form post.
//
// TWO THINGS ARE COUNTER-INTUITIVE HERE, both learned by a live 404:
//  1. `/public/createToken` is a **GET**. A POST to it 404s.
//  2. The token is NOT in the JSON body. The body is the ordinary envelope and
//     its `url` field is a redirect target (the page you came from), which is
//     easy to mistake for the token because it happens to be about the right
//     length. The real value comes back as the **`__token__` RESPONSE HEADER** —
//     the site's own getToken() reads it with
//     `request.getResponseHeader("__token__")`.
// Trusting the body silently posts an empty token, and every write 404s.
async function z2uCsrf() {
  const r = await z2uRequestFull("GET", "/public/createToken", {
    ajax: true,
    what: "Z2U token",
  });
  const h = r.headers || {};
  const tok = String(h["__token__"] || h["__TOKEN__"] || "").trim();
  if (!tok) {
    throw new Error(
      "Z2U token: no __token__ response header (Z2U changed how it mints CSRF tokens)",
    );
  }
  return tok;
}

// ---- parsers (pure, exported so they can be tested without a session) ----

// The "Manage Listing" landing page: one tile per (service, game) the seller
// has offers in. These ids are the only way to address a group, and they are
// account-specific, so they are discovered rather than hard-coded.
function parseZ2uGroups(html) {
  const out = [];
  const seen = new Set();
  const re =
    /<a[^>]+href="[^"]*\/sell\/manageList\?service=(\d+)&(?:amp;)?game=(\d+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const key = m[1] + ":" + m[2];
    if (seen.has(key)) continue;
    seen.add(key);
    const text = z2uHtmlText(m[3]);
    const offers = /(\d+)\s*Offers?/i.exec(text);
    out.push({
      service: m[1],
      game: m[2],
      // The tile reads "5 Offers Albion Online (Global) Items" — the count is
      // a badge, not part of the name.
      label: text.replace(/^\s*\d+\s*Offers?\s*/i, "").trim(),
      offers: offers ? Number(offers[1]) : null,
    });
  }
  return out;
}

// Split one offer row into its cells, keyed by the cell's own <div class=
// "title"> label ("Unit Price", "Stock", …) rather than by column position:
// Z2U has shuffled columns before, and a positional parser silently reads the
// wrong number rather than failing.
function z2uRowCells(chunk) {
  const cells = {};
  const parts = String(chunk).split(/class="div-table-cell/);
  for (const part of parts.slice(1)) {
    // The split lands INSIDE the opening tag, so the rest of that tag has to go
    // or every cell text starts with a stray `">`.
    const body = part.slice(part.indexOf(">") + 1);
    const t = /<div[^>]*class="title"[^>]*>([\s\S]*?)<\/div>/i.exec(body);
    const label = t ? z2uHtmlText(t[1]).replace(/[:.]$/, "").trim() : "";
    if (!label) continue;
    // Drop the label block itself: it is the column heading Z2U repeats in
    // every row ("Unit Price", "Stock"), not part of the value.
    cells[label.toLowerCase()] = body.replace(t[0], " ");
  }
  return cells;
}

function z2uFirstInt(s) {
  const m = /(-?\d+)/.exec(String(s || ""));
  return m ? Number(m[1]) : null;
}

// Every offer in one (service, game) group. Z2U renders the whole group in one
// page — the "Expire soon / Low Stock / Deactivated" tabs are client-side
// filters over these same rows — so one fetch is the whole truth.
function parseZ2uOffers(html) {
  const out = [];
  const chunks = String(html || "").split(/class="div-table-row"/);
  for (const chunk of chunks.slice(1)) {
    const pk = /data="(\d+)"/.exec(chunk);
    if (!pk) continue;
    const cells = z2uRowCells(chunk);
    const nameCell = cells["product name"] || "";
    const nameText = z2uHtmlText(nameCell);
    const published = /Publish\s*(\d{4}\/\d{2}\/\d{2})/i.exec(nameText);
    const statusCell = cells["status"] || "";
    const sv = /class="set_status"[^>]*data-value="(\d+)"/i.exec(statusCell);
    const statusCode = sv ? Number(sv[1]) : null;
    const priceCell = cells["unit price"] || "";
    const price = /value="([\d.]+)"/.exec(priceCell);
    const attr = z2uHtmlText(cells["attribute"] || "").replace(/^Attribute:?\s*/i, "");
    out.push({
      pk: pk[1],
      title: nameText
        .replace(/^\s*Product Name\s*/i, "")
        .replace(/^\s*Publish\s*\d{4}\/\d{2}\/\d{2}\s*/i, "")
        .replace(/#\d+\s*$/, "")
        .trim(),
      publishedAt: published ? published[1] : "",
      price: price ? Number(price[1]) : null,
      currency: (/\b([A-Z]{3})\b/.exec(z2uHtmlText(priceCell).replace(/Unit Price/i, "")) || [])[1] || "USD",
      stock: z2uFirstInt(z2uHtmlText(cells["stock"] || "").replace(/^Stock/i, "")),
      minQty: z2uFirstInt(z2uHtmlText(cells["min qty"] || "").replace(/^Min QTY\.?/i, "")),
      expiryDays: z2uFirstInt(
        z2uHtmlText(cells["product expiration date"] || "").replace(
          /^Product expiration date/i,
          "",
        ),
      ),
      delivery: z2uHtmlText(cells["delivery method"] || "")
        .replace(/^Delivery Method\s*/i, "")
        .trim(),
      attribute: attr,
      statusCode,
      status: Z2U_STATUS[statusCode] || (statusCode == null ? "unknown" : "offline"),
      // The one thing that actually matters: is it on sale right now.
      online: statusCode === 1,
      canExtend: /class="[^"]*set_extend/i.test(statusCell),
    });
  }
  return out;
}

// One page of sold orders. Each order is a `.orderPanel` block; the fields we
// need (id, buyer, money, state) are plain text inside it, and the opaque
// `oid` hash — needed for the delivery-record page — hangs off the
// showProRecord link.
function parseZ2uOrders(html) {
  const out = [];
  const chunks = String(html || "").split(/class="[^"]*orderPanel/);
  for (const raw of chunks.slice(1)) {
    // Same mid-tag split as the offer rows: drop the rest of the opening tag.
    const chunk = raw.slice(raw.indexOf(">") + 1);
    const id = /\b(Z\d{9,12})\b/.exec(chunk);
    if (!id) continue;
    const text = z2uHtmlText(chunk);
    const buyer = /buyer\s*:?\s*([^\s]+)/i.exec(text);
    const date = /Date:?\s*(\d{4}-\d{2}-\d{2}[\s\d:]*)/i.exec(text);
    const amount = /Total Amount:?\s*([A-Z]{3})\s*([\d.]+)/i.exec(text);
    const oid = /showProRecord\?oid=([a-f0-9]{16,})/i.exec(chunk);
    // The product title sits between the date and the unit price; take the
    // longest run of text that is neither, which survives Z2U's spacing.
    const title = /\d{2}:\d{2}:\d{2}\s*(.+?)\s*(?:USD|EUR|GBP)\s*[\d.]/i.exec(text);
    // Z2U prints a state badge ("Waiting for buyer reply") between the date and
    // the product name, so it lands inside the title capture.
    const badge = /^\s*(?:Waiting for buyer reply|WAIT FOR CONFIRMED|Cancell?ed|Delivered|Completed|Refunded)\s*/i;
    let titleText = title ? title[1].trim() : "";
    while (badge.test(titleText)) titleText = titleText.replace(badge, "").trim();
    out.push({
      orderId: id[1],
      buyer: buyer ? buyer[1] : "",
      date: date ? date[1].trim() : "",
      title: titleText,
      amount: amount ? Number(amount[2]) : null,
      currency: amount ? amount[1] : "USD",
      oid: oid ? oid[1] : "",
      state: /WAIT FOR CONFIRMED/i.test(text)
        ? "wait_confirm"
        : /Cancell?ed/i.test(text)
          ? "canceled"
          : /Waiting for buyer reply/i.test(text)
            ? "wait_buyer"
            : "",
      text: text.slice(0, 400),
    });
  }
  return out;
}

// Read a <form>'s current state back out as name/value pairs — the same set a
// browser would submit. This is what makes editing safe: Z2U's save endpoint
// replaces the whole offer, so anything not sent back is wiped. Rather than
// reconstruct 18 fields from our own model (and silently blank the two we
// forgot), we re-submit the page's own answer with only the fields we mean to
// change patched.
function parseZ2uForm(html, formId) {
  const src = String(html || "");
  const scoped = formId
    ? (new RegExp(
        '<form[^>]*id=["\']' + formId + '["\'][^>]*>([\\s\\S]*?)</form>',
        "i",
      ).exec(src) || [])[1]
    : src;
  const body = scoped || "";
  const out = [];
  // inputs
  const inputRe = /<input\b([^>]*)>/gi;
  let m;
  while ((m = inputRe.exec(body))) {
    const tag = m[1];
    const name = (/name=["']([^"']+)["']/i.exec(tag) || [])[1];
    if (!name) continue;
    const type = String((/type=["']([^"']+)["']/i.exec(tag) || [])[1] || "text").toLowerCase();
    if (type === "submit" || type === "button" || type === "file") continue;
    // An unchecked box or radio is simply absent from a real submission.
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(tag)) continue;
    const value = (/value=["']([^"']*)["']/i.exec(tag) || [])[1] || "";
    out.push([name, value]);
  }
  // textareas
  const taRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((m = taRe.exec(body))) {
    const name = (/name=["']([^"']+)["']/i.exec(m[1]) || [])[1];
    if (!name) continue;
    out.push([
      name,
      m[2]
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#0?39;/g, "'")
        .replace(/&amp;/gi, "&"),
    ]);
  }
  // selects — take the selected option(s); with none marked, a browser submits
  // the first option, so mirror that rather than dropping the field.
  const selRe = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  while ((m = selRe.exec(body))) {
    const name = (/name=["']([^"']+)["']/i.exec(m[1]) || [])[1];
    if (!name) continue;
    const opts = [];
    const optRe = /<option\b([^>]*)>/gi;
    let o;
    while ((o = optRe.exec(m[2]))) {
      opts.push({
        value: (/value=["']([^"']*)["']/i.exec(o[1]) || [])[1] || "",
        selected: /\bselected\b/i.test(o[1]),
      });
    }
    const chosen = opts.filter((x) => x.selected);
    if (chosen.length) for (const c of chosen) out.push([name, c.value]);
    else if (opts.length) out.push([name, opts[0].value]);
  }
  return out;
}

async function z2uTest() {
  try {
    const html = await z2uRequest("GET", "/sell/manage", { what: "Z2U test" });
    const groups = parseZ2uGroups(html);
    const offers = groups.reduce((n, g) => n + (g.offers || 0), 0);
    return {
      ok: true,
      detail:
        "Connected — " +
        groups.length +
        " game groups, " +
        offers +
        " offers on the shelf",
    };
  } catch (e) {
    return { ok: false, detail: String((e && e.message) || e).slice(0, 300) };
  }
}

async function z2uGroups() {
  return parseZ2uGroups(
    await z2uRequest("GET", "/sell/manage", { what: "Z2U groups" }),
  );
}

async function z2uOffers(service, game) {
  const html = await z2uRequest(
    "GET",
    "/sell/manageList?service=" +
      encodeURIComponent(service) +
      "&game=" +
      encodeURIComponent(game),
    { what: "Z2U offers" },
  );
  return parseZ2uOffers(html).map((o) => ({
    ...o,
    service: String(service),
    game: String(game),
  }));
}

// The whole shelf, group by group. Z2U is a shared-hosting PHP site and each
// group page is ~500KB, so the caller gets a small pause between fetches
// rather than 16 parallel requests.
async function z2uAllOffers({ delayMs = 800 } = {}) {
  const groups = await z2uGroups();
  const out = [];
  for (const g of groups) {
    const rows = await z2uOffers(g.service, g.game);
    for (const r of rows) out.push({ ...r, groupLabel: g.label });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}

// on_line / off_line / extend. `extend` is the one that matters most: every
// offer carries a duration (7/14/30 days) and Z2U pulls it off sale when that
// runs out, which is why a shelf nobody tends goes dark on its own.
async function z2uSetOfferStatus(pk, action) {
  const allowed = ["on_line", "off_line", "extend"];
  if (!allowed.includes(action)) {
    throw new Error("Z2U: unknown offer action " + action);
  }
  const body = await z2uRequest("POST", "/sell/productAction", {
    ajax: true,
    what: "Z2U " + action,
    data: { list_pk: String(pk), list_action: action },
  });
  return z2uAjax("Z2U " + action, body);
}

const z2uRelist = (pk) => z2uSetOfferStatus(pk, "on_line");
const z2uDelist = (pk) => z2uSetOfferStatus(pk, "off_line");
const z2uExtend = (pk) => z2uSetOfferStatus(pk, "extend");

// Patch an existing offer by re-submitting its own editor form.
//
// Z2U's save replaces the offer wholesale, so the form is read back first and
// only the named fields are changed — see parseZ2uForm. Price and stock are
// the two that matter for keeping a shelf honest.
async function z2uUpdateOffer(pk, patch = {}) {
  const html = await z2uRequest(
    "GET",
    "/sell/manageEdit.html?id=" + encodeURIComponent(pk),
    { what: "Z2U edit" },
  );
  const fields = parseZ2uForm(html, "form");
  if (!fields.length) {
    throw new Error(
      "Z2U edit: offer " + pk + " has no editor form (deleted, or session lost)",
    );
  }
  const patched = {
    ...(patch.priceUsd != null
      ? { list_unit_price: String(Math.max(Z2U_MIN_PRICE, Number(patch.priceUsd)).toFixed(2)) }
      : {}),
    ...(patch.stock != null
      ? { list_stock_num: String(Math.max(0, parseInt(patch.stock, 10) || 0)) }
      : {}),
    ...(patch.title ? { list_title: String(patch.title).slice(0, 200) } : {}),
    ...(patch.description ? { list_description: String(patch.description) } : {}),
    ...(patch.expiryDays ? { list_term_of_validity: String(patch.expiryDays) } : {}),
  };
  const form = new FormData();
  const applied = new Set();
  for (const [name, value] of fields) {
    const bare = name.replace(/\[\]$/, "");
    if (Object.prototype.hasOwnProperty.call(patched, bare)) {
      // Multi-value fields keep every entry; a patched one collapses to the
      // new single value, and only once.
      if (applied.has(bare)) continue;
      applied.add(bare);
      form.append(name, patched[bare]);
      continue;
    }
    form.append(name, value);
  }
  for (const [k, v] of Object.entries(patched)) {
    if (!applied.has(k)) form.append(k, v);
  }
  form.append("list_pk", String(pk));
  form.append("__token__", await z2uCsrf());
  const body = await z2uRequest("POST", "/sell/manageListToUpdate", {
    ajax: true,
    what: "Z2U update",
    data: form,
  });
  return z2uAjax("Z2U update", body);
}

// Sold orders. WAIT_DELIVERY is the queue a fulfiller drains; ALL is what an
// audit reads.
async function z2uOrders(status = "WAIT_DELIVERY", { page = 1 } = {}) {
  const s = String(status || "ALL").toUpperCase();
  // Paging is ?page=N. The path-segment form Z2U uses elsewhere (/p/2) is
  // silently ignored here and returns page 1 again — which would make a paging
  // loop spin forever on the same 20 rows.
  const p = Math.max(1, parseInt(page, 10) || 1);
  const html = await z2uRequest(
    "GET",
    "/sellOrder/index/order_status/" +
      encodeURIComponent(s) +
      (p > 1 ? "?page=" + p : ""),
    { what: "Z2U orders" },
  );
  return parseZ2uOrders(html);
}

// Walk every page of one order state. Stops when a page repeats the previous
// page (Z2U answers 200 with page 1 rather than an empty list past the end).
async function z2uAllOrders(status = "ALL", { maxPages = 10, delayMs = 500 } = {}) {
  const out = [];
  const seen = new Set();
  for (let p = 1; p <= maxPages; p++) {
    const rows = await z2uOrders(status, { page: p });
    const fresh = rows.filter((r) => !seen.has(r.orderId));
    if (!fresh.length) break;
    for (const r of fresh) {
      seen.add(r.orderId);
      out.push(r);
    }
    if (rows.length < 20) break;
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  return out;
}

async function z2uOrderPage(orderId) {
  return z2uRequest("GET", "/sellOrder?order_id=" + encodeURIComponent(orderId), {
    what: "Z2U order",
  });
}

// Hand the buyer their goods.
//
// The delivery form is per-category and only rendered while an order is
// actually awaiting delivery, so it is read off the live order page instead of
// being reconstructed here — same reasoning as z2uUpdateOffer. If the page
// carries no delivery form the order is not deliverable (already delivered,
// cancelled, or in dispute) and this refuses loudly rather than posting a
// payload Z2U will quietly drop.
// Is this order actually deliverable, and what does its form ask for?
//
// Split out from z2uDeliver so a caller can check BEFORE claiming an account.
// The delivery form is rendered only while an order is genuinely awaiting
// delivery — on a delivered, cancelled or disputed order the element does not
// exist at all — so this is the honest test for "can we hand over right now".
// Returns null when there is no form.
function z2uParseDeliveryForm(html) {
  const scoped =
    (/<form[^>]*id=["']form_submit["'][^>]*>([\s\S]*?)<\/form>/i.exec(String(html)) || [])[1];
  if (!scoped) return null;
  const fields = parseZ2uForm(html, "form_submit");
  const textareas = [];
  const taRe = /<textarea\b([^>]*)>/gi;
  let m;
  while ((m = taRe.exec(scoped))) {
    const n = (/name=["']([^"']+)["']/i.exec(m[1]) || [])[1];
    if (n) textareas.push(n);
  }
  if (!fields.length || !textareas.length) return null;
  return { fields, textareas };
}

async function z2uDeliveryForm(orderId) {
  return z2uParseDeliveryForm(await z2uOrderPage(orderId));
}

async function z2uDeliver(orderId, message) {
  const text = String(message || "").trim();
  if (!text) throw new Error("Z2U deliver: refusing to send an empty delivery");
  const html = await z2uOrderPage(orderId);
  const fields = parseZ2uForm(html, "form_submit");
  const hasTextField = /<textarea\b/i.test(
    (new RegExp('<form[^>]*id=["\']form_submit["\'][^>]*>([\\s\\S]*?)</form>', "i").exec(
      String(html),
    ) || [])[1] || "",
  );
  if (!fields.length || !hasTextField) {
    throw new Error(
      "Z2U deliver: order " +
        orderId +
        " has no delivery form on its page — it is not awaiting delivery " +
        "(already delivered, cancelled, or under dispute).",
    );
  }
  const form = new FormData();
  let filled = false;
  const src = String(html);
  const scoped =
    (new RegExp('<form[^>]*id=["\']form_submit["\'][^>]*>([\\s\\S]*?)</form>', "i").exec(src) ||
      [])[1] || "";
  const textareaNames = new Set();
  const taRe = /<textarea\b([^>]*)>/gi;
  let m;
  while ((m = taRe.exec(scoped))) {
    const n = (/name=["']([^"']+)["']/i.exec(m[1]) || [])[1];
    if (n) textareaNames.add(n);
  }
  for (const [name, value] of fields) {
    if (textareaNames.has(name)) {
      form.append(name, text);
      filled = true;
      continue;
    }
    form.append(name, value);
  }
  if (!filled) {
    throw new Error("Z2U deliver: could not find the delivery text field");
  }
  form.append("order_id", String(orderId));
  form.append("__token__", await z2uCsrf());
  const body = await z2uRequest("POST", "/sellOrder/form_submit", {
    ajax: true,
    what: "Z2U deliver",
    data: form,
  });
  return z2uAjax("Z2U deliver", body);
}

// Download the bulk template Z2U hands out for ONE game. It is a real .xlsx and
// it is the authority on what that game accepts — see utils/z2uTemplate.
async function z2uTemplateFile(service, game) {
  const r = await z2uRequestFull(
    "GET",
    "/downloadTemp?service=" + encodeURIComponent(service) + "&game=" + encodeURIComponent(game),
    { what: "Z2U template", responseType: "arraybuffer" },
  );
  const buf = Buffer.from(r.data || []);
  // An .xlsx is a ZIP; anything else means Z2U handed back an error page.
  if (buf.length < 200 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(
      "Z2U template: service " + service + " / game " + game +
        " did not return a spreadsheet (" + buf.length + " bytes)",
    );
  }
  return buf;
}

// What one game will accept, parsed from its own template. Cached briefly: a
// bulk run asks for the same game repeatedly and the file is ~10KB each time.
const z2uTemplateCache = new Map();
const Z2U_TEMPLATE_TTL_MS = 30 * 60 * 1000;
async function z2uGameOptions(service, game) {
  const key = service + ":" + game;
  const hit = z2uTemplateCache.get(key);
  if (hit && Date.now() - hit.at < Z2U_TEMPLATE_TTL_MS) return hit.value;
  const buf = await z2uTemplateFile(service, game);
  const value = {
    ...require("./z2uTemplate").parseZ2uTemplate(buf),
    templateBuffer: buf,
  };
  z2uTemplateCache.set(key, { at: Date.now(), value });
  return value;
}

// Create offers by uploading a filled copy of the game's own template.
//
// !! NOT WORKING YET — DO NOT WIRE THIS INTO ANYTHING AUTOMATIC. !!
//
// The file this builds is correct as far as can be checked offline (columns and
// enums come from the game's own template), and the endpoint is real: only
// /platform/Sell/acceptExcelProducts exists, the other casings 404. But every
// upload is refused with code 0 "Invalid request! Please refresh the page to
// resubmit". Ruled out on 2026-09-08 against the live account:
//   * missing CSRF        — a valid token from /public/createToken (read off the
//                           __token__ RESPONSE header) was sent as a form field,
//                           as a request header, and as a query param. All three
//                           refused identically.
//   * stale session state — the create page was fetched first in the same jar.
//   * wrong path/casing   — /Sell/…, /sell/…, /sell/showuploaddata all 404.
// So the guard is something else the browser sends that has not been observed
// yet. Cracking it needs a real batch upload captured from the seller panel.
//
// The one reassuring part: it fails CLOSED. Five upload attempts created
// nothing — the shelf stayed at exactly 47 offers with no probe rows — so this
// is safe to retry, unlike the ZeusX create that made junk out of its failures.
async function z2uBulkPublish({ service, game, offers }) {
  if (!Array.isArray(offers) || !offers.length) {
    throw new Error("Z2U bulk: nothing to publish");
  }
  const templateBuffer = await z2uTemplateFile(service, game);
  const { buildZ2uBulkFile } = require("./z2uBulk");
  const built = buildZ2uBulkFile({ templateBuffer, offers });
  const form = new FormData();
  form.append("game", String(game));
  form.append("service", String(service));
  form.append("upload", built.buffer, {
    filename: "batch.xlsx",
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  // The batch upload is CSRF-guarded like every other mutating post here.
  // Without it Z2U answers code 0 "Invalid request! Please refresh the page to
  // resubmit" — which at least fails cleanly and creates nothing, but creates
  // nothing.
  form.append("__token__", await z2uCsrf());
  const body = await z2uRequest("POST", "/platform/Sell/acceptExcelProducts", {
    ajax: true,
    what: "Z2U bulk publish",
    data: form,
    timeout: 120000,
  });
  return { reply: body, rows: built.rows, gameName: built.template.gameName };
}

function z2uOfferUrl(pk) {
  return Z2U_BASE + "/sell/manageEdit.html?id=" + encodeURIComponent(pk);
}

module.exports = {
  MARKETPLACES,
  FIELDS,
  // --- Z2U (see the Z2U section above; scraper-driven, no API) ---
  Z2U_MIN_PRICE,
  Z2U_STATUS,
  z2uTest,
  z2uGroups,
  z2uOffers,
  z2uAllOffers,
  z2uSetOfferStatus,
  z2uRelist,
  z2uDelist,
  z2uExtend,
  z2uUpdateOffer,
  z2uOrders,
  z2uAllOrders,
  z2uOrderPage,
  z2uDeliver,
  z2uDeliveryForm,
  z2uParseDeliveryForm,
  z2uTemplateFile,
  z2uGameOptions,
  z2uBulkPublish,
  z2uOfferUrl,
  // Pure parsers, exported so the HTML shapes can be tested without a session.
  parseZ2uGroups,
  parseZ2uOffers,
  parseZ2uOrders,
  parseZ2uForm,
  delistOutcome,
  setKeys,
  keyStatus,
  // Live USD -> currency rate (cached ~6h). Used by the research scanner to
  // bring FunPay's EUR-quoted pages back to USD.
  usdRate,
  gameflipTest,
  gameflipOwnerId,
  gameflipPublish,
  gameflipListingStatus,
  gameflipDelist,
  gameflipReprice,
  gameflipReplaceCover,
  gameflipDeleteNonCoverPhotos,
  gameflipListingIdsByStatus,
  digisellerTest,
  digisellerCategories,
  digisellerCategoryAttributes,
  digisellerPublish,
  digisellerRepriceProducts,
  digisellerFloorPrice,
  DS_MIN_PRICE_USD,
  digisellerUploadImage,
  digisellerAddContent,
  digisellerRemoveContent,
  digisellerProductStock,
  digisellerProductStockDetailed,
  digisellerProductVisible,
  digisellerDelist,
  // G2G — the seller-session connector (sls.g2g.com). See the block comment
  // above G2G_SLS for why the Open API is not used for listing or delivery.
  G2G_MIN_PRICE,
  G2G_ITEMS_SERVICE,
  G2G_STATUS,
  g2gRefreshAccess,
  g2gEnsureFreshToken,
  g2gTokenMsLeft,
  g2gTest,
  g2gOfferUrl,
  g2gListOffers,
  g2gGetOffer,
  g2gPublish,
  g2gUpdateOffer,
  g2gReprice,
  g2gSetQuantity,
  g2gDelist,
  g2gRelist,
  g2gProductSettings,
  g2gRelationId,
  g2gCollections,
  g2gAttributesFromOwnOffers,
  g2gResolveOfferShape,
  g2gOrderCounts,
  g2gOrders,
  g2gPendingOrders,
  g2gOrder,
  g2gStartDeliver,
  g2gMarkDelivering,
  g2gSetDeliveredQty,
  g2gDeliveries,
  g2gDeliveryProofs,
  g2gSellerId,
  g2gChatProfile,
  // G2G legacy Open API — catalog pickers + utils/g2gBulk only.
  g2gServices,
  g2gBrands,
  g2gProducts,
  g2gAttributes,
  ggselTest,
  ggselCategories,
  ggselPublish,
  ggselUpdateOffer,
  // GGSel prices in roubles, and ggselUpdateOffer takes `priceRub` only — so
  // any caller repricing a GGSel row needs the rate. Callers already probe for
  // this (`typeof mp.usdToRub === "function"` in unclaimedAutoList's reprice)
  // and skip GGSel rows when it is missing, which it always was: every GGSel
  // row in that path was silently unrepriceable. Exporting it closes that gap
  // and lets scripts/reprice-listings.js convert without duplicating the rate
  // fetch, its 6h cache, or the 90₽ fallback — a wrong rate here would mean
  // prices off by ~90x in either direction.
  usdToRub,
  ggselAddProducts,
  ggselOfferStock,
  ggselOfferStockDetailed,
  ggselOfferStatus,
  ggselOfferPrice,
  ggselStockField,
  ggselResolveCategoryId,
  ggselTitle,
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
  eldoradoTest,
  eldoradoRefreshSession,
  eldoradoEnsureFreshSession,
  eldoradoTradeEnvironments,
  eldoradoResolveGame,
  eldoradoUploadImage,
  eldoradoPublish,
  eldoradoOffer,
  eldoradoOfferUrl,
  eldoradoUpdateOffer,
  eldoradoSetQuantity,
  eldoradoReprice,
  eldoradoDelist,
  eldoradoRelist,
  eldoradoDeleteOffer,
  eldoradoMyListings,
  eldoradoOrders,
  eldoradoPaidOrders,
  eldoradoOrderStateCounts,
  eldoradoSendOrderMessage,
  playerauctionsTest,
  playerauctionsMe,
  playerauctionsSellerLevel,
  playerauctionsRefreshSession,
  playerauctionsTokenExpiry,
  paRefreshOnce,
  paStoredAccessToken,
  PA_COOLDOWN_MS,
  playerauctionsEnsureFreshSession,
  playerauctionsGames,
  playerauctionsResolveGame,
  playerauctionsItemCategories,
  playerauctionsServers,
  playerauctionsDeliveryTimes,
  playerauctionsPickItemPath,
  playerauctionsResolveDelivery,
  playerauctionsPublish,
  playerauctionsOffer,
  playerauctionsOfferUrl,
  playerauctionsOfferIdFromUrl,
  paSanitizeTitle,
  playerauctionsUpdateOffer,
  playerauctionsSetQuantity,
  playerauctionsReprice,
  playerauctionsMyListings,
  playerauctionsHide,
  playerauctionsDisplay,
  playerauctionsDelist,
  playerauctionsRelist,
  playerauctionsCancelOffer,
  playerauctionsUploadImage,
  playerauctionsOrders,
  playerauctionsOrderDetail,
  playerauctionsBalance,
  playerauctionsMessages,
  playerauctionsMessageThread,
  playerauctionsNotifications,
  playerauctionsSnapshot,
  playerauctionsPendingOrders,
  playerauctionsNeedsDelivery,
  playerauctionsDetailNeedsDelivery,
  playerauctionsSendOrderMessage,
  playerauctionsMarkDelivered,
  PA_DELIVERY,
  PA_MIN_PRICE,
  PA_MAX_MESSAGE,
  PA_WRITE_GAP_MS,
  eldoradoMarkDelivered,
  ELD_MIN_PRICE,
  // exported for tests: the TalkJS internal-id derivations the chat send relies on
  eldInternalId,
  eldNymId,
};
