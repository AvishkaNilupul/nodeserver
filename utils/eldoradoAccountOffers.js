// Eldorado "Account" category offers — the shelf Epic Games accounts sell on
// (gameId 108). This is a different product from the Twitch Drops items the
// rest of the connector lists (gameId 235 / CustomItem): its own endpoints,
// and Eldorado's OWN instant delivery.
//
// How instant delivery works here: every unit of stock is one "account
// delivery details" entry stored on the offer — the account login + password,
// optional email details (provider URL, email login, email password), optional
// 2FA details and a short unencrypted note. When a buyer pays, Eldorado hands
// one entry to that buyer on the order page ("Here is your account!") and the
// offer's quantity drops by one. Nothing is sent through chat and nothing has
// to be marked delivered by us.
//
// The endpoint shapes below were read from eldorado.gg's own web app (the
// sell / edit-offer forms and the seller dashboard, 2026-10-28):
//   create   POST   /api/flexibleOffers/account            {augmentedGame, details, accountDeliveryDetails}
//   edit     PUT    /api/flexibleOffers/account/{id}/details  (same DTO; entries keep their id)
//   read     GET    /api/flexibleOffers/{id}/private
//   stock    GET    /api/offers/accountDetails/byOfferId/{id}   → {accountDeliveryDetails: [...]}
//   order    GET    /api/offers/accountDetails/byOrderId/{id}   (the entry a buyer received)
//   mine     GET    /api/flexibleOffers/me/search
//   pause    PUT    /api/flexibleOffersUser/me/{id}/pause
//   resume   PUT    /api/flexibleOffersUser/me/{id}/resume
//   price    PUT    /api/flexibleOffersUser/me/{id}/changePrice  {amount, currency}
//   delete   DELETE /api/flexibleOffersUser/me/{id}
//
// Every call goes through marketplaces.eldRequest, so the stored seller cookie,
// the CSRF header and the refresh-on-401 behave exactly as for every other
// Eldorado call the server makes.

const mp = require("./marketplaces");

const EPIC_GAME_ID = "108";
const CATEGORY = "Account";

// The Eldorado sections an Epic account offer can be filed under.
//   epic           Epic Games › Accounts. A "high-risk" section: listing needs
//                  Eldorado's per-seller permission (see epicPermission).
//   rocket-league  Rocket League › Accounts, Device PC. Only for FRESH Epic
//                  accounts (no games): Rocket League runs on an Epic account,
//                  and this section sells new ones as "fresh RL accounts".
//                  Not high-risk.
// The Rocket League attributes are the section's form fields
// (GET /api/library/1/Account/attributes/offers — every one is required, the
// Select ones AND the Numeric "Credits" (in thousands) and "Level"), in the
// shape Eldorado's place-offer form sends ({id, type, values} for a Select,
// {id, type, value} for a Numeric; convertToOfferAttributes, 2026-10-30).
// A fresh account is 0 credits, unranked, level 0, no title. Eldorado
// answered a create without the Numeric ones "Required attribute 'Credits'
// is not set".
const SECTIONS = {
  epic: {
    key: "epic",
    name: "Epic Games accounts",
    gameId: EPIC_GAME_ID,
    tradeEnvironmentId: null,
    offerAttributes: [],
    seoAlias: "epic-games-accounts",
  },
  "rocket-league": {
    key: "rocket-league",
    name: "Rocket League accounts (PC)",
    gameId: "1",
    tradeEnvironmentId: "0", // Device: PC
    offerAttributes: [
      { id: "rl-credits", type: "Select", values: ["credits-0299"] },
      { id: "rocket-league-credits-numeric", type: "Numeric", value: 0 },
      { id: "rocket-league-current-rank", type: "Select", values: ["rank-unranked"] },
      { id: "rocket-league-level", type: "Select", values: ["level-09"] },
      { id: "rocket-league-level-numeric", type: "Numeric", value: 0 },
      { id: "rocket-league-tags-titles", type: "Select", values: ["tag-other"] },
    ],
    seoAlias: "rocket-league-accounts-for-sale",
  },
};

function sectionOf(key) {
  const s = SECTIONS[String(key || "epic")];
  if (!s) throw new Error("Unknown Eldorado section: " + key);
  return s;
}
// Field limits from Eldorado's form validators.
const MAX_LOGIN = 100;
const MAX_PASSWORD = 100;
const MAX_PROVIDER_URL = 100;
const MAX_ADDITIONAL_INFO = 1000;
const MAX_TITLE = 160;
const MIN_TITLE = 5;
const MAX_DESCRIPTION = 2000;
// appConstants.offerConstants.minimalOfferValue (read 2026-10-28).
const MIN_PRICE = 0.05;

function eldFail(label, e) {
  const status = e && e.response && e.response.status;
  const body = e && e.response && e.response.data;
  let detail = "";
  if (body && typeof body === "object") {
    if (Array.isArray(body.messages)) detail = body.messages.join("; ");
    else if (body.message) detail = String(body.message);
    else if (body.title) detail = String(body.title);
  } else if (typeof body === "string" && body) {
    detail = body.slice(0, 300);
  }
  if (!detail && e && e.message && !e.response) detail = e.message;
  const err = new Error(
    label + " failed" + (status ? " (HTTP " + status + ")" : "") + (detail ? ": " + detail : ""),
  );
  err.status = status || 0;
  err.eldorado = true;
  return err;
}

async function call(label, method, path, opts) {
  try {
    return await mp.eldRequest(method, path, opts || {});
  } catch (e) {
    throw eldFail(label, e);
  }
}

function money(usd) {
  const n = Math.round(Number(usd) * 100) / 100;
  if (!Number.isFinite(n) || n < MIN_PRICE) {
    throw new Error("Eldorado: price must be at least $" + MIN_PRICE.toFixed(2));
  }
  return n;
}

function clip(s, max) {
  return String(s == null ? "" : s).trim().slice(0, max);
}

// One unit of stock in Eldorado's shape. `id` is set for an entry that already
// exists on the offer (Eldorado keeps it), null for a new one.
function toEntry(e) {
  const login = String((e && e.accountLogin) || "").trim();
  const password = String((e && e.accountPassword) || "");
  if (!login || !password) throw new Error("Eldorado entry needs a login and a password");
  if (login.length > MAX_LOGIN || password.length > MAX_PASSWORD) {
    throw new Error("Eldorado entry login/password is longer than 100 characters");
  }
  const hasEmail = !!(e.emailProviderUrl || e.emailLogin || e.emailPassword);
  if (hasEmail) {
    if (String(e.emailProviderUrl || "").length > MAX_PROVIDER_URL) {
      throw new Error("Eldorado entry provider URL is longer than 100 characters");
    }
    if (String(e.emailLogin || "").length > MAX_LOGIN || String(e.emailPassword || "").length > MAX_PASSWORD) {
      throw new Error("Eldorado entry email login/password is longer than 100 characters");
    }
  }
  const info = String(e.additionalInfo || "").trim();
  if (info.length > MAX_ADDITIONAL_INFO) {
    throw new Error("Eldorado entry note is longer than 1000 characters");
  }
  return {
    id: e.id || null,
    accountDetails: { accountLogin: login, accountPassword: password },
    emailDetails: hasEmail
      ? {
          emailProviderUrl: String(e.emailProviderUrl || "").trim(),
          emailLogin: String(e.emailLogin || "").trim(),
          emailPassword: String(e.emailPassword || ""),
        }
      : null,
    mfaDetails: null,
    additionalInfo: info || null,
  };
}

// An entry as Eldorado returns it, flattened. Unknown shapes come back with
// empty fields rather than throwing: the caller decides what a missing login
// means.
function fromEntry(raw) {
  const r = raw || {};
  const s = r.structuredDetails || r;
  const acc = s.accountDetails || {};
  const mail = s.emailDetails || {};
  return {
    id: r.id != null ? String(r.id) : "",
    accountLogin: String(acc.accountLogin || "").trim(),
    accountPassword: acc.accountPassword != null ? String(acc.accountPassword) : "",
    emailProviderUrl: String(mail.emailProviderUrl || ""),
    emailLogin: String(mail.emailLogin || "").trim(),
    emailPassword: mail.emailPassword != null ? String(mail.emailPassword) : "",
    additionalInfo: String(s.additionalInfo || r.additionalInfo || ""),
    legacy: !!r.legacySecretDetails,
  };
}

function entryList(r) {
  if (Array.isArray(r)) return r;
  if (!r || typeof r !== "object") return [];
  for (const k of ["accountDeliveryDetails", "results", "items", "accountDetails"]) {
    if (Array.isArray(r[k])) return r[k];
  }
  // A single entry (the per-order read can answer with one object).
  if (r.structuredDetails || r.accountDetails || r.legacySecretDetails) return [r];
  return [];
}

// `section` picks where the offer is filed. An edit MUST send the same section
// the offer was created in, or Eldorado would be asked to move it.
function offerDto({ title, description, priceUsd, hasOriginalEmail, mainOfferImage, offerImages, entries, section }) {
  const sec = sectionOf(section);
  const t = clip(title, MAX_TITLE);
  if (t.length < MIN_TITLE) throw new Error("Eldorado: the title needs at least 5 characters");
  if (!mainOfferImage || !mainOfferImage.largeImage) {
    throw new Error("Eldorado: a cover image is required");
  }
  const list = (entries || []).map(toEntry);
  if (!list.length) throw new Error("Eldorado: an instant-delivery offer needs at least one account");
  return {
    augmentedGame: {
      gameId: sec.gameId,
      category: CATEGORY,
      tradeEnvironmentId: sec.tradeEnvironmentId,
      offerAttributes: sec.offerAttributes.map((a) =>
        a.type === "Numeric" ? { id: a.id, type: a.type, value: a.value } : { id: a.id, type: a.type, values: [...a.values] },
      ),
    },
    details: {
      pricing: {
        quantity: list.length,
        pricePerUnit: { amount: money(priceUsd), currency: "USD" },
        volumeDiscounts: [],
      },
      description: clip(description, MAX_DESCRIPTION),
      guaranteedDeliveryTime: "Instant",
      offerTitle: t,
      mainOfferImage,
      offerImages: offerImages || [],
      hasOriginalEmail: !!hasOriginalEmail,
    },
    accountDeliveryDetails: list,
  };
}

function offerIdOf(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  return String(r.id || (r.offer && r.offer.id) || r.offerId || "");
}

// The public offer page. Eldorado's route is `:seoAlias/oa/:offerId`; the
// alias is the section's ("epic-games-accounts" for Epic Games accounts).
function offerUrl(offerId, section) {
  if (!offerId) return "";
  return "https://www.eldorado.gg/" + sectionOf(section).seoAlias + "/oa/" + encodeURIComponent(offerId);
}

// Create the offer. Returns { id, raw }. Eldorado has answered offer creates
// with the new offer (items) — when the body carries no id, the newest own
// account offer with the same title is taken as it.
async function createAccountOffer(opts) {
  const dto = offerDto(opts);
  const r = await call("Eldorado account offer create", "POST", "/api/flexibleOffers/account", { data: dto });
  let id = offerIdOf(r);
  if (!id) {
    const mine = await myAccountOffers({ pageSize: 20, gameId: dto.augmentedGame.gameId }).catch(() => []);
    const hit = mine
      .filter((o) => String(o.offerTitle || "").trim() === dto.details.offerTitle)
      .sort((a, b) => String(b.createdDate || b.expireDate || "").localeCompare(String(a.createdDate || a.expireDate || "")))[0];
    id = hit ? String(hit.id) : "";
  }
  return { id, raw: r };
}

async function getAccountOffer(offerId) {
  const r = await call(
    "Eldorado account offer read",
    "GET",
    "/api/flexibleOffers/" + encodeURIComponent(offerId) + "/private",
  );
  return (r && r.offer) || r || null;
}

async function getAccountEntries(offerId) {
  const r = await call(
    "Eldorado account stock read",
    "GET",
    "/api/offers/accountDetails/byOfferId/" + encodeURIComponent(offerId),
  );
  return entryList(r).map(fromEntry);
}

// Rewrite the offer. `entries` is the COMPLETE stock after the change: an
// entry left out is removed from the offer, an entry without id is added.
async function updateAccountOffer(offerId, opts) {
  const dto = offerDto(opts);
  await call(
    "Eldorado account offer update",
    "PUT",
    "/api/flexibleOffers/account/" + encodeURIComponent(offerId) + "/details",
    { data: dto },
  );
  return true;
}

async function pauseAccountOffer(offerId) {
  await call("Eldorado account offer pause", "PUT", "/api/flexibleOffersUser/me/" + encodeURIComponent(offerId) + "/pause");
}

async function resumeAccountOffer(offerId) {
  await call("Eldorado account offer resume", "PUT", "/api/flexibleOffersUser/me/" + encodeURIComponent(offerId) + "/resume");
}

async function changeAccountOfferPrice(offerId, priceUsd) {
  const amount = money(priceUsd);
  await call(
    "Eldorado account offer price",
    "PUT",
    "/api/flexibleOffersUser/me/" + encodeURIComponent(offerId) + "/changePrice",
    { data: { amount, currency: "USD" } },
  );
  return amount;
}

async function deleteAccountOffer(offerId) {
  await call("Eldorado account offer delete", "DELETE", "/api/flexibleOffersUser/me/" + encodeURIComponent(offerId));
}

async function myAccountOffers({ pageIndex = 1, pageSize = 50, gameId = EPIC_GAME_ID } = {}) {
  const qs = new URLSearchParams({
    gameId: String(gameId),
    category: CATEGORY,
    pageIndex: String(pageIndex),
    pageSize: String(pageSize),
  });
  const r = await call("Eldorado account offers list", "GET", "/api/flexibleOffers/me/search?" + qs);
  const rows = (r && (r.results || r.items)) || (Array.isArray(r) ? r : []);
  return rows.map((x) => (x && x.offer) || x).filter((o) => o && o.id);
}

// The entry the buyer of one order received.
async function orderAccountDetails(orderId) {
  const r = await call(
    "Eldorado order account details",
    "GET",
    "/api/offers/accountDetails/byOrderId/" + encodeURIComponent(orderId),
  );
  return entryList(r).map(fromEntry);
}

// Eldorado marks some game categories "high risk" (Epic Games accounts is
// one: GET /library/highRiskGameCategories). A seller can only list there
// while their payment profile says allowHighRiskOffers — a per-seller switch
// Eldorado sets; being ID-verified is not enough. Without it every create
// answers 400 "you are not eligible to place offers in this game".
let highRiskCache = { at: 0, list: null };
async function highRiskCategories() {
  if (highRiskCache.list && Date.now() - highRiskCache.at < 6 * 60 * 60 * 1000) return highRiskCache.list;
  const r = await call("Eldorado high-risk categories", "GET", "/api/library/highRiskGameCategories?locale=en-US");
  const list = Array.isArray(r) ? r : (r && (r.games || r.results)) || [];
  highRiskCache = { at: Date.now(), list };
  return list;
}

async function epicPermission(gameId = EPIC_GAME_ID) {
  const out = { canSell: null, allowHighRiskOffers: null, epicIsHighRisk: null, error: "" };
  try {
    const list = await highRiskCategories();
    out.epicIsHighRisk = list.some((x) => String(x && x.gameId) === String(gameId) && x.category === CATEGORY);
  } catch (e) {
    out.error = e.message;
  }
  try {
    const p = await call("Eldorado seller profile", "GET", "/api/userpayment/me");
    const dto = (p && (p.userPaymentPrivateDTO || p)) || {};
    if (typeof dto.allowHighRiskOffers === "boolean") out.allowHighRiskOffers = dto.allowHighRiskOffers;
  } catch (e) {
    out.error = (out.error ? out.error + "; " : "") + e.message;
  }
  if (out.epicIsHighRisk === false) out.canSell = true;
  else if (out.epicIsHighRisk === true && out.allowHighRiskOffers != null) out.canSell = out.allowHighRiskOffers;
  return out;
}

// Seller orders in each of the given states, newest first per state.
async function ordersInStates(states, pageSize = 50) {
  const out = [];
  for (const st of states) {
    const rows = await mp.eldoradoOrders({ orderState: st, pageSize });
    for (const o of rows || []) out.push(o);
  }
  return out;
}

module.exports = {
  EPIC_GAME_ID,
  CATEGORY,
  SECTIONS,
  sectionOf,
  MIN_PRICE,
  MAX_ADDITIONAL_INFO,
  createAccountOffer,
  getAccountOffer,
  getAccountEntries,
  updateAccountOffer,
  pauseAccountOffer,
  resumeAccountOffer,
  changeAccountOfferPrice,
  deleteAccountOffer,
  myAccountOffers,
  orderAccountDetails,
  ordersInStates,
  epicPermission,
  offerUrl,
  uploadImage: (p) => mp.eldoradoUploadImage(p),
  // pure, for tests
  toEntry,
  fromEntry,
  entryList,
  offerDto,
  offerIdOf,
};
