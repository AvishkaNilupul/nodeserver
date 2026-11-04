// Steam account sales on Eldorado: one instant-delivery offer per region in
// Steam › Accounts, and the sale sync that records what sold.
// Contract: docs/STEAM-SALES.md. Built on the same rules as utils/epicSales.js.
//
// What a buyer receives, instantly, on Eldorado's own order page:
//   Account details  login = the Steam account name, password = the Steam password
//   Email details    provider URL = our mail page (/mail/), login = the account's
//                    Outlook address, password = a random password that ONLY opens
//                    the mail page (a BuyerMailSession of kind "steam").
// The mail page shows only mail from Steam, only from the purchase on, for
// sessionDays. The Outlook inbox itself is never handed over.
//
// Lifecycle of one account:
//   stock ──list──▶ listed (SteamAccount.stage "listed", unit on ONE listing,
//                   mail session stage "listed" with no expiry clock)
//   listed ──sale──▶ sold (stage "sold", soldAt; session "sold", expires
//                   sale + sessionDays)
//   listed ──remove/delete──▶ stock (session revoked "unlisted")
//
// The stage flip stock→listed is the reservation: it is a conditional update
// per account, so two operator actions (or two processes) can never put one
// account on two offers. Every mutation and every tick also runs under one
// in-process lock, so a tick never reads a listing halfway through a rewrite.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");

const SteamAccount = require("../models/SteamAccount");
const SteamListing = require("../models/SteamListing");
const SteamSale = require("../models/SteamSale");
const SteamSalesState = require("../models/SteamSalesState");
const products = require("./steamProducts");
const SteamBoost = require("../models/SteamBoost");
const BuyerMailSession = require("../models/BuyerMailSession");
const { encrypt, decrypt } = require("./secretBox");

// Replaceable for tests (_setDeps).
const deps = {
  eld: require("./eldoradoAccountOffers"),
  outlook: require("./outlookGraphReader"),
  notify: async (text) => {
    try {
      await require("./telegram").sendTelegram(text);
    } catch (e) {
      console.error("[steamSales] telegram:", (e && e.message) || e);
    }
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;
const LISTED_SESSION_MS = 365 * DAY_MS;
const TICK_MS = Number(process.env.STEAM_SALES_TICK_MS) || 5 * 60 * 1000;
const FIRST_TICK_MS = 4 * 60 * 1000;
const ORDER_SCAN_EVERY_MS = 15 * 60 * 1000;
const MISSING_ALERT_AFTER_MS = 30 * 60 * 1000;
const UNMATCHED_GRACE_MS = 20 * 60 * 1000;
const RENEW_WINDOW_MS = 5 * DAY_MS;
const RENEW_MIN_GAP_MS = 6 * 60 * 60 * 1000;
const INBOX_CACHE_MS = 5 * 60 * 1000;
const ORDER_STATES_NEW = ["Paid", "Delivered", "Received"];
const ORDER_STATES_ALL = ["Paid", "Delivered", "Received", "Completed", "Disputed", "Canceled"];
const LIVE_LISTING = ["active", "paused", "sold_out"];
const DEFAULTS = { syncEnabled: true, sessionDays: 7, priceUsd: 1 };

// Steam › Accounts on Eldorado (gameId 42, no trade environment, no
// attributes). Passed to eldoradoAccountOffers as an object, so the shared
// Epic section list stays as it is.
const SECTION = Object.freeze({
  key: "steam",
  name: "Steam accounts",
  gameId: "42",
  tradeEnvironmentId: null,
  offerAttributes: [],
  seoAlias: "steam-accounts",
});

const IMG_DIR = path.join(__dirname, "..", "public", "img");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function userError(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  e.user = true;
  return e;
}

function dec(v) {
  try {
    return v ? String(decrypt(v) || "") : "";
  } catch {
    return "";
  }
}

let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(() => fn());
  chain = run.catch(() => {});
  return run;
}

const PW_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
function mintPassword(len = 16) {
  let s = "";
  for (let i = 0; i < len; i++) s += PW_ALPHABET[crypto.randomInt(PW_ALPHABET.length)];
  return s;
}

function parseEldDate(s) {
  const v = String(s || "").trim();
  if (!v) return NaN;
  return new Date(/(z|[+-]\d\d:?\d\d)$/i.test(v) ? v : v + "Z").getTime();
}

function regionName(cc) {
  const c = String(cc || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return "";
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(c) || c;
  } catch {
    return c;
  }
}

// The buyer-facing mail page. Must be https: it goes into the delivery entry.
function providerUrl() {
  const base = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/i.test(base)) return "";
  return base + "/mail/";
}

function regionOf(acc) {
  const c = String((acc && acc.signupCountry) || "").toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : "";
}

function labelOf(acc) {
  return (acc && acc.accountName) || "";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getConfig() {
  const doc = await SteamSalesState.findById("main").lean();
  return { ...DEFAULTS, ...(doc || {}) };
}

async function setConfig(patch, actor) {
  const p = patch || {};
  const set = { updatedBy: String(actor || "") };
  if (typeof p.syncEnabled === "boolean") set.syncEnabled = p.syncEnabled;
  if (p.sessionDays != null) {
    const d = Math.round(Number(p.sessionDays));
    if (!(d >= 1 && d <= 14)) throw userError("The mail page window must be 1 to 14 days");
    set.sessionDays = d;
  }
  if (p.priceUsd != null) set.priceUsd = validPrice(p.priceUsd);
  await SteamSalesState.updateOne({ _id: "main" }, { $set: set }, { upsert: true });
  return getConfig();
}

function validPrice(p) {
  const n = Math.round(Number(p) * 100) / 100;
  if (!Number.isFinite(n) || n < deps.eld.MIN_PRICE || n > 500) {
    throw userError("Price must be between $" + deps.eld.MIN_PRICE.toFixed(2) + " and $500");
  }
  return n;
}

// ---------------------------------------------------------------------------
// Inbox check (the Mac pool must say this inbox is a Steam inbox)
// ---------------------------------------------------------------------------

const inboxCache = new Map(); // email -> { at, value }

// { ok, reason }. The mail page can serve Steam mail only for an inbox the Mac
// pool records as used for Steam, and it must not be another site's inbox.
async function checkInbox(email, { fresh = false } = {}) {
  const key = String(email || "").toLowerCase();
  const hit = inboxCache.get(key);
  // A failed check (proxy down) is kept 30 s only, so the page recovers fast.
  const ttl = hit && hit.value && hit.value.transient ? 30 * 1000 : INBOX_CACHE_MS;
  if (!fresh && hit && Date.now() - hit.at < ttl) return hit.value;
  let value;
  try {
    const c = await deps.outlook.checkInbox(key);
    // `uses` is the full list (the proxy leaves "epic" out of sharedWith).
    const uses = (c.uses || c.sharedWith || []).map(String);
    if (c.status !== "live") value = { ok: false, reason: "the Mac mail pool doesn't know this inbox" };
    else if (!uses.includes("steam")) value = { ok: false, reason: "the Mac mail pool has no Steam use recorded for this inbox" };
    else if (uses.some((u) => u !== "steam")) value = { ok: false, reason: "the inbox is also used for " + uses.filter((u) => u !== "steam").join(", ") };
    else value = { ok: true, reason: "" };
  } catch (e) {
    value = { ok: false, reason: "the Mac mail proxy is not answering", transient: true, error: (e && e.message) || String(e) };
  }
  inboxCache.set(key, { at: Date.now(), value });
  return value;
}

// ---------------------------------------------------------------------------
// What can be sold
// ---------------------------------------------------------------------------

// Why an account can't go on a region listing now ([] = it can). `inbox` is
// the checkInbox answer, or null when it was not asked (cheaper list views).
function blockersOf(acc, inbox) {
  const out = [];
  if (acc.stage !== "stock") {
    out.push(
      acc.stage === "listed" ? "already on sale" : acc.stage === "sold" ? "sold" : acc.stage === "boosting" ? "boosting hours" : "marked “needs attention”",
    );
  }
  if ((acc.games || []).length) out.push("has games (region offers sell empty accounts; game offers come later)");
  // utils/steamBoost.js: it owns free games and idle hours now, so it is not
  // the fresh empty account a region offer promises.
  if (acc.boostedAt) out.push("hour-boosted (sells on the boosted offers, not as an empty account)");
  if (!regionOf(acc)) out.push("no signup country");
  if (!dec(acc.password)) out.push("no saved password");
  if (!/@/.test(dec(acc.email))) out.push("no saved email");
  if (inbox && !inbox.ok) out.push(inbox.reason);
  return out;
}

// Ready accounts grouped by region, plus the blocked stock accounts and why.
async function stockView({ checkInboxes = true } = {}) {
  const accounts = await SteamAccount.find({ stage: "stock" }).sort({ signedUpAt: 1, createdAt: 1 }).lean();
  const groups = new Map();
  const blocked = [];
  for (const acc of accounts) {
    const email = dec(acc.email).toLowerCase();
    let inbox = null;
    if (checkInboxes && email) inbox = await checkInbox(email);
    const why = blockersOf(acc, inbox);
    if (why.length) {
      blocked.push({ _id: String(acc._id), accountName: acc.accountName, region: regionOf(acc), reasons: why });
      continue;
    }
    const r = regionOf(acc);
    if (!groups.has(r)) groups.set(r, { region: r, regionName: regionName(r), accounts: [] });
    groups.get(r).accounts.push({ _id: String(acc._id), accountName: acc.accountName, signedUpAt: acc.signedUpAt });
  }
  return {
    groups: [...groups.values()].sort((a, b) => a.regionName.localeCompare(b.regionName)),
    blocked,
  };
}

// Load + vet the accounts for one region listing. With no ids, every ready
// account of that region is taken. Throws a user error naming each problem.
async function vetAccounts({ region, accountIds = null, ...rawProduct }) {
  const product = products.normalize(rawProduct);
  const cc = String(region || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw userError("Choose a region");
  const q = accountIds && accountIds.length
    ? { _id: { $in: [...new Set(accountIds.map(String))].filter((x) => /^[a-f\d]{24}$/i.test(x)) } }
    : { stage: "stock", signupCountry: cc };
  const accounts = await SteamAccount.find(q).sort({ signedUpAt: 1, createdAt: 1 }).lean();
  if (accountIds && accountIds.length && accounts.length !== new Set(accountIds.map(String)).size) {
    throw userError("Some of those accounts no longer exist");
  }
  const problems = [];
  const vetted = [];
  for (const acc of accounts) {
    const email = dec(acc.email).toLowerCase();
    const inbox = email ? await checkInbox(email, { fresh: true }) : null;
    const why = product.kind === "region" ? blockersOf(acc, inbox) : [
      ...(acc.stage !== "stock" ? ["account is not free stock"] : []),
      ...(!dec(acc.password) || !/@/.test(email) ? ["missing login"] : []),
      ...(inbox && !inbox.ok ? [inbox.reason] : []),
      ...products.blockers(acc, product),
    ];
    if (product.kind !== "region" && await SteamBoost.exists({ steamAccountId: acc._id, state: { $in: ["queued", "boosting", "stopping"] } })) why.push("worker has not acknowledged logout");
    if (regionOf(acc) && regionOf(acc) !== cc) why.push("is a " + regionName(regionOf(acc)) + " account, not " + regionName(cc));
    if (why.length) {
      // Picking "all ready accounts of a region" skips the blocked ones;
      // naming accounts by id refuses them.
      if (accountIds && accountIds.length) problems.push(acc.accountName + ": " + why.join("; "));
      continue;
    }
    vetted.push({ acc, email, password: dec(acc.password) });
  }
  if (problems.length) throw userError("Can't list: " + problems.join(" | "));
  if (!vetted.length) throw userError("No ready " + regionName(cc) + " account to list");
  return vetted;
}

// ---------------------------------------------------------------------------
// Offer text, entries, cover
// ---------------------------------------------------------------------------

function suggestTitle(region) {
  return ("Steam Account | " + regionName(region) + " Region | Fresh New | Email Codes Included | Instant Delivery").slice(0, 160);
}

// Owner's one-month purchase instruction, with the sales copy approved
// 2026-11-04. Signup country does not establish finalized Store country.
const REGION_WARNING =
  "Please wait at least 1 month after receiving the account before making purchases on the Steam Store.";

function descriptionFooter(days) {
  const d = Math.max(1, Number(days) || DEFAULTS.sessionDays);
  return [
    "WHAT YOU RECEIVE",
    "• Steam account username and password.",
    "• Private mail-page login for Steam Guard and email-change codes.",
    "• " + d + " days of access to Steam emails, starting from purchase.",
    "",
    "AFTER DELIVERY",
    "Change the Steam password and linked email to your own. Use the private mail page to receive the email-change codes. " +
      "The original email inbox itself is not included.",
    "",
    "PURCHASE NOTE",
    REGION_WARNING,
    "",
    "Need help? Contact us through your Eldorado order.",
  ].join("\n");
}

function suggestDescription(region, days) {
  const name = regionName(region);
  return [
    "Receive one newly created Steam account with no games added. Your login details are delivered automatically " +
      "on the Eldorado order page after payment.",
    "",
    "ACCOUNT DETAILS",
    "• Signup country: " + name + " (" + region + ").",
    "• No paid games included.",
    "• Steam's $5 USD account limitation has not been removed.",
    "• The finalized Steam Store country is not guaranteed.",
    "",
    descriptionFooter(days),
  ].join("\n").slice(0, 2000);
}

// The note shown with every delivered unit. Eldorado stores it UNENCRYPTED, so
// it must never carry a secret.
function additionalInfoText(days) {
  const d = Math.max(1, Number(days) || DEFAULTS.sessionDays);
  return (
    "Steam emails (Steam Guard and email change codes): open the Provider URL above and sign in with the Email login and " +
    "Email password. That page shows only the emails Steam sends to this account, from your purchase on, for " + d +
    " days. The Email password only works on that page; the Steam password is the one under Account details. " +
    "Please change the account email to your own right after you log in (Steam > Account details > Change email)."
  );
}

function entryFor({ login, steamPassword, email, mailPassword, purl, days, entryId }) {
  return {
    id: entryId || null,
    accountLogin: login,
    accountPassword: steamPassword,
    emailProviderUrl: purl,
    emailLogin: email,
    emailPassword: mailPassword,
    additionalInfo: additionalInfoText(days),
  };
}

// Our square cover for the region (scripts/make-steam-covers.js), or the
// generic one when that country has none yet.
function coverFor(region) {
  const cc = String(region || "").toLowerCase();
  const own = path.join(IMG_DIR, "steam-cover-" + cc + ".jpg");
  if (/^[a-z]{2}$/.test(cc) && fs.existsSync(own)) return { file: own, public: "/img/steam-cover-" + cc + ".jpg" };
  return { file: path.join(IMG_DIR, "steam-cover.jpg"), public: "/img/steam-cover.jpg" };
}

// ---------------------------------------------------------------------------
// Mail-page sessions and the stage reservation
// ---------------------------------------------------------------------------

async function mintListedSession(acc, email, listingId, actor) {
  await BuyerMailSession.updateMany(
    { inboxAddress: email, revokedAt: null, stage: "listed" },
    { $set: { revokedAt: new Date(), revokedReason: "replaced" } },
  );
  const password = mintPassword();
  const row = await BuyerMailSession.create({
    kind: "steam",
    steamAccountId: acc._id,
    inboxAddress: email,
    passwordHash: await bcrypt.hash(password, 10),
    passwordEnc: encrypt(password),
    expiresAt: new Date(Date.now() + LISTED_SESSION_MS),
    stage: "listed",
    steamListingId: listingId || null,
    marketplace: "eldorado",
    createdByUserId: String(actor || ""),
    note: "steam instant-delivery listing",
  });
  return { row, password };
}

async function revokeSessions(ids, reason) {
  const list = (ids || []).filter(Boolean);
  if (!list.length) return 0;
  const r = await BuyerMailSession.updateMany(
    { _id: { $in: list }, revokedAt: null, stage: "listed" },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
  );
  return (r && r.modifiedCount) || 0;
}

// stock → listed, one account at a time, only if it is still in stock.
// Returns the ids actually reserved.
async function reserve(ids) {
  const got = [];
  for (const id of ids) {
    const r = await SteamAccount.updateOne({ _id: id, stage: "stock" }, { $set: { stage: "listed" } });
    if (r && r.modifiedCount === 1) got.push(String(id));
  }
  return got;
}

async function release(ids, { held = false } = {}) {
  if (!ids.length) return;
  await SteamAccount.updateMany({ _id: { $in: ids }, stage: "listed" }, { $set: { stage: held ? "problem" : "stock" } });
}

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

async function previewListing({ region, priceUsd, accountIds = null, ...rawProduct } = {}) {
  const product = products.normalize(rawProduct);
  const cfg = await getConfig();
  const cc = String(region || "").toUpperCase();
  const purl = providerUrl();
  let vetted = [];
  const problems = [];
  try {
    vetted = await vetAccounts({ region: cc, accountIds, ...product });
  } catch (e) {
    problems.push(e.message);
  }
  if (!purl) problems.push("PUBLIC_BASE_URL is not an https address, so the mail page link can't be built");
  const live = await SteamListing.findOne({ region: cc, kind: product.kind, ...(product.kind !== "region" ? { appId: product.appId, minHours: product.minHours } : {}), status: { $in: LIVE_LISTING } }).select("_id title").lean();
  if (live) problems.push("There is already a live " + regionName(cc) + " listing. Add the accounts to it instead.");
  let price = cfg.priceUsd;
  try {
    price = validPrice(priceUsd != null ? priceUsd : cfg.priceUsd);
  } catch (e) {
    problems.push(e.message);
  }
  const copy = product.kind === "region" ? { title: suggestTitle(cc), description: suggestDescription(cc, cfg.sessionDays) } : products.text(product, cc, regionName(cc), descriptionFooter(cfg.sessionDays));
  return {
    ...product,
    section: products.section(product, SECTION),
    region: cc,
    regionName: regionName(cc),
    title: copy.title,
    description: copy.description,
    priceUsd: price,
    cover: coverFor(cc).public,
    accounts: vetted.map((v) => ({ _id: String(v.acc._id), accountName: v.acc.accountName })),
    note: additionalInfoText(cfg.sessionDays),
    problems,
  };
}

// `accountIds` (optional): list exactly these accounts (the distributor's
// pick) instead of every ready account of the region.
async function createListing({ region, priceUsd, accountIds = null, ...rawProduct } = {}, actor) {
  const product = products.normalize(rawProduct);
  return withLock(async () => {
    const pv = await previewListing({ region, priceUsd, accountIds, ...product });
    if (pv.problems.length) throw userError(pv.problems.join(" | "));
    const cfg = await getConfig();
    const vetted = await vetAccounts({ region: pv.region, accountIds, ...product });
    const reserved = await reserve(vetted.map((v) => v.acc._id));
    const take = vetted.filter((v) => reserved.includes(String(v.acc._id)));
    if (!take.length) throw userError("Those accounts were just taken by another action. Refresh and try again.", 409);
    const listing = new SteamListing({
      market: "eldorado",
      ...product,
      section: pv.section,
      region: pv.region,
      status: "draft",
      title: pv.title,
      description: pv.description,
      priceUsd: pv.priceUsd,
      coverSource: pv.cover,
      createdBy: String(actor || ""),
      accounts: [],
    });
    await listing.save();
    const minted = [];
    try {
      const entries = [];
      for (const v of take) {
        const { row, password } = await mintListedSession(v.acc, v.email, listing._id, actor);
        minted.push(row._id);
        listing.accounts.push({
          steamAccountId: v.acc._id,
          sessionId: row._id,
          login: String(v.acc.accountName).toLowerCase(),
          label: labelOf(v.acc),
          state: "listed",
          addedAt: new Date(),
        });
        entries.push(
          entryFor({
            login: v.acc.accountName,
            steamPassword: v.password,
            email: v.email,
            mailPassword: password,
            purl: providerUrl(),
            days: cfg.sessionDays,
          }),
        );
      }
      const image = await deps.eld.uploadImage(coverFor(pv.region).file);
      listing.mainOfferImage = image;
      await listing.save();
      const created = await deps.eld.createAccountOffer({
        title: pv.title,
        description: pv.description,
        priceUsd: pv.priceUsd,
        hasOriginalEmail: false,
        mainOfferImage: image,
        offerImages: [],
        entries,
        section: pv.section,
      });
      if (!created.id) {
        // On Eldorado, but its id could not be read: keep the accounts
        // reserved (the offer may already be selling) and say so loudly.
        listing.status = "error";
        listing.lastError = "Created on Eldorado, but the new offer's id could not be read. Check My offers on Eldorado.";
        listing.lastErrorAt = new Date();
        await listing.save();
        throw userError(listing.lastError, 502);
      }
      listing.externalId = created.id;
      listing.url = deps.eld.offerUrl(created.id, pv.section);
      listing.status = "active";
      await listing.save();
    } catch (e) {
      if (!listing.externalId && listing.status !== "error") {
        // Nothing reached Eldorado: give the accounts back.
        await revokeSessions(minted, "unlisted");
        await release(reserved);
        listing.status = "removed";
        for (const u of listing.accounts) {
          u.state = "removed";
          u.removedAt = new Date();
          u.removedReason = "create failed";
        }
        listing.lastError = (e && e.message) || String(e);
        listing.lastErrorAt = new Date();
        await listing.save().catch(() => {});
      }
      throw e;
    }
    try {
      await readBack(listing);
      listing.lastSyncAt = new Date();
    } catch (e) {
      listing.lastError = "Created; reading it back failed: " + e.message;
      listing.lastErrorAt = new Date();
    }
    await listing.save();
    await deps.notify(
      "🟢 Steam listing is live on Eldorado: " + listing.title + " — $" + listing.priceUsd.toFixed(2) + " × " +
        listing.accounts.length + " account(s).\n" + listing.url,
    );
    return listingView(listing.toObject());
  });
}

// Read the offer + its delivery entries into the listing doc.
// Returns { offer, entries, missing } (missing = listed units not in stock).
async function readBack(listing, now = new Date()) {
  const offer = await deps.eld.getAccountOffer(listing.externalId);
  const entries = await deps.eld.getAccountEntries(listing.externalId);
  if (!stockReadable(offer, entries)) {
    throw userError("Eldorado reports " + offer.quantity + " in stock but returned " + entries.length + " readable entries", 502);
  }
  const present = new Map(entries.filter((e) => e.accountLogin).map((e) => [e.accountLogin.toLowerCase(), e]));
  let missing = 0;
  for (const u of listing.accounts) {
    if (u.state !== "listed") continue;
    const e = present.get(u.login);
    if (e) {
      if (e.id && u.entryId !== e.id) u.entryId = e.id;
      u.missingSince = null;
      u.missingAlertedAt = null;
    } else {
      if (!u.missingSince) u.missingSince = now;
      missing++;
    }
  }
  listing.remote = {
    offerState: String((offer && offer.offerState) || ""),
    quantity: offer && offer.quantity != null ? Number(offer.quantity) : null,
    entries: entries.length,
    expireDate: String((offer && offer.expireDate) || ""),
    readAt: now,
  };
  if (offer && offer.pricePerUnit && offer.pricePerUnit.currency === "USD" && Number(offer.pricePerUnit.amount) > 0) {
    listing.priceUsd = Number(offer.pricePerUnit.amount);
  }
  if (offer && offer.offerTitle) listing.title = String(offer.offerTitle);
  deriveStatus(listing);
  return { offer, entries, missing };
}

function stockReadable(offer, entries) {
  const q = offer && offer.quantity != null ? Number(offer.quantity) : NaN;
  const readable = (entries || []).filter((e) => e && e.accountLogin).length;
  if (!Number.isFinite(q)) return true;
  return readable === q;
}

function deriveStatus(listing) {
  if (listing.status === "removed" || listing.status === "draft") return;
  const st = String((listing.remote && listing.remote.offerState) || "");
  const inStock = (listing.remote && listing.remote.entries) || 0;
  if (!inStock) listing.status = "sold_out";
  else if (/^paused$/i.test(st)) listing.status = "paused";
  else if (/^active$/i.test(st)) listing.status = "active";
}

async function loadListing(id) {
  if (!/^[a-f\d]{24}$/i.test(String(id || ""))) throw userError("Invalid listing id");
  const l = await SteamListing.findById(id);
  if (!l) throw userError("Listing not found", 404);
  return l;
}

function requireLive(l) {
  if (!l.externalId || !LIVE_LISTING.includes(l.status)) {
    throw userError("This listing is not live on Eldorado (status: " + l.status + ")");
  }
}

// The offer fields to send back unchanged on a stock rewrite: what Eldorado
// has now (the owner may have edited it there), falling back to our record.
function offerFields(listing, offer, patch = {}) {
  const usd = offer && offer.pricePerUnit && offer.pricePerUnit.currency === "USD" ? Number(offer.pricePerUnit.amount) : NaN;
  return {
    title: patch.title != null ? patch.title : (offer && offer.offerTitle) || listing.title,
    description: patch.description != null ? patch.description : offer && offer.description != null ? offer.description : listing.description,
    priceUsd: patch.priceUsd != null ? patch.priceUsd : Number.isFinite(usd) && usd > 0 ? usd : listing.priceUsd,
    hasOriginalEmail: false,
    mainOfferImage: (offer && offer.mainOfferImage && offer.mainOfferImage.largeImage && offer.mainOfferImage) || listing.mainOfferImage,
    offerImages: (offer && offer.offerImages) || [],
    section: listing.section || SECTION,
  };
}

// The complete stock to write back: our listed units still in stock (rebuilt
// from our own records) + entries we don't manage, passed through untouched.
async function rebuildEntries(listing, remote, cfg, { dropAccountId = null, offer = null } = {}) {
  const purl = providerUrl();
  if (!purl) throw userError("PUBLIC_BASE_URL is not an https address");
  if (!stockReadable(offer, remote)) {
    throw userError(
      "Eldorado reports " + offer.quantity + " in stock but returned " + remote.length +
        " readable entries, so the stock is not rewritten. Try again in a minute.",
      502,
    );
  }
  const byLogin = new Map(remote.filter((e) => e.accountLogin).map((e) => [e.accountLogin.toLowerCase(), e]));
  const ours = new Set();
  const out = [];
  for (const u of listing.accounts) {
    if (u.state !== "listed") continue;
    const r = byLogin.get(u.login);
    if (!r) continue; // left the stock (sold, or about to be recorded): never put it back
    ours.add(u.login);
    if (dropAccountId && String(u.steamAccountId) === String(dropAccountId)) continue;
    const [acc, sess] = await Promise.all([
      SteamAccount.findById(u.steamAccountId).select("accountName password email").lean(),
      u.sessionId ? BuyerMailSession.findById(u.sessionId).select("passwordEnc revokedAt").lean() : null,
    ]);
    const steamPassword = dec(acc && acc.password);
    const email = dec(acc && acc.email).toLowerCase();
    const mailPassword = sess && !sess.revokedAt ? dec(sess.passwordEnc) : "";
    if (!steamPassword || !email || !mailPassword) {
      throw userError("Can't rewrite this offer's stock: " + u.label + " has no saved login or its mail page session was revoked. Remove it first.");
    }
    out.push(entryFor({ login: acc.accountName, steamPassword, email, mailPassword, purl, days: cfg.sessionDays, entryId: r.id }));
  }
  for (const e of remote) {
    if (e.accountLogin && ours.has(e.accountLogin.toLowerCase())) continue;
    if (!e.accountLogin || !e.accountPassword || e.legacy) {
      throw userError("The offer has a stock entry this page doesn't manage and can't read back. Edit it on Eldorado instead.");
    }
    out.push({
      id: e.id || null,
      accountLogin: e.accountLogin,
      accountPassword: e.accountPassword,
      emailProviderUrl: e.emailProviderUrl,
      emailLogin: e.emailLogin,
      emailPassword: e.emailPassword,
      additionalInfo: e.additionalInfo,
    });
  }
  return out;
}

// Add every ready account of the listing's region (or the given ones).
async function addAccounts(listingId, accountIds, actor) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    if (listing.kind === "rivals") throw userError("Rivals stock requires its own verified costume preparation. Use the Rivals page.");
    requireLive(listing);
    const cfg = await getConfig();
    const vetted = await vetAccounts({ region: listing.region, accountIds, kind: listing.kind, appId: listing.appId, minHours: listing.minHours });
    const remote = await deps.eld.getAccountEntries(listing.externalId);
    const offer = await deps.eld.getAccountOffer(listing.externalId);
    const kept = await rebuildEntries(listing, remote, cfg, { offer });
    const reserved = await reserve(vetted.map((v) => v.acc._id));
    const take = vetted.filter((v) => reserved.includes(String(v.acc._id)));
    if (!take.length) throw userError("Those accounts were just taken by another action. Refresh and try again.", 409);
    const minted = [];
    const added = [];
    try {
      for (const v of take) {
        const { row, password } = await mintListedSession(v.acc, v.email, listing._id, actor);
        minted.push(row._id);
        added.push({
          unit: {
            steamAccountId: v.acc._id,
            sessionId: row._id,
            login: String(v.acc.accountName).toLowerCase(),
            label: labelOf(v.acc),
            state: "listed",
            addedAt: new Date(),
          },
          entry: entryFor({
            login: v.acc.accountName,
            steamPassword: v.password,
            email: v.email,
            mailPassword: password,
            purl: providerUrl(),
            days: cfg.sessionDays,
          }),
        });
      }
      await deps.eld.updateAccountOffer(listing.externalId, { ...offerFields(listing, offer), entries: [...kept, ...added.map((a) => a.entry)] });
    } catch (e) {
      await revokeSessions(minted, "unlisted");
      await release(reserved);
      throw e;
    }
    for (const a of added) listing.accounts.push(a.unit);
    const wasSoldOut = listing.status === "sold_out";
    await readBack(listing);
    // An offer that went quiet because it ran out goes back on sale; one the
    // owner paused stays paused.
    if (wasSoldOut && listing.remote.offerState && !/^active$/i.test(listing.remote.offerState)) {
      await deps.eld.resumeAccountOffer(listing.externalId).catch((e) => {
        listing.lastError = "Stock added, but resuming the offer failed: " + e.message;
        listing.lastErrorAt = new Date();
      });
      await readBack(listing).catch(() => {});
    }
    await listing.save();
    return listingView(listing.toObject());
  });
}

async function removeAccount(listingId, accountId, actor) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    const unit = listing.accounts.find((u) => String(u.steamAccountId) === String(accountId) && u.state === "listed");
    if (!unit) throw userError("That account is not listed here");
    const cfg = await getConfig();
    const remote = await deps.eld.getAccountEntries(listing.externalId);
    if (!remote.some((e) => e.accountLogin && e.accountLogin.toLowerCase() === unit.login)) {
      throw userError("That account already left Eldorado's stock, so it was probably just sold. Wait for the sale to be recorded.");
    }
    const offer = await deps.eld.getAccountOffer(listing.externalId);
    const entries = await rebuildEntries(listing, remote, cfg, { dropAccountId: accountId, offer });
    if (!entries.length) throw userError("It's the last account on this offer. Delete the listing instead.");
    await deps.eld.updateAccountOffer(listing.externalId, { ...offerFields(listing, offer), entries });
    unit.state = "removed";
    unit.removedAt = new Date();
    unit.removedReason = "removed by " + (actor || "operator");
    await revokeSessions([unit.sessionId], "unlisted");
    await release([String(unit.steamAccountId)], { held: listing.kind === "rivals" });
    await readBack(listing).catch(() => {});
    await listing.save();
    return listingView(listing.toObject());
  });
}

// Change the offer's title and/or description. The stock is written back in
// full (Eldorado's edit takes the whole offer), from a complete read only.
async function updateText(listingId, { title, description } = {}) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    const patch = {};
    if (title != null) {
      const t = String(title).trim();
      if (t.length < 5 || t.length > 160) throw userError("The title needs 5 to 160 characters");
      patch.title = t;
    }
    if (description != null) {
      const d = String(description);
      if (d.length > 2000) throw userError("The description can be up to 2000 characters");
      patch.description = d;
    }
    if (!Object.keys(patch).length) throw userError("Nothing to change");
    const cfg = await getConfig();
    const remote = await deps.eld.getAccountEntries(listing.externalId);
    const offer = await deps.eld.getAccountOffer(listing.externalId);
    const entries = await rebuildEntries(listing, remote, cfg, { offer });
    if (!entries.length) throw userError("The offer has no stock left to keep");
    await deps.eld.updateAccountOffer(listing.externalId, { ...offerFields(listing, offer, patch), entries });
    if (patch.title) listing.title = patch.title;
    if (patch.description != null) listing.description = patch.description;
    await readBack(listing).catch(() => {});
    await listing.save();
    return listingView(listing.toObject());
  });
}

// Rewrite a live listing's description from the current template (its own
// region and the mail page window), keeping the title.
async function refreshDescription(listingId) {
  const listing = await loadListing(listingId);
  const cfg = await getConfig();
  return updateText(listingId, { description: listing.kind === "rivals" ? listing.description : listing.kind === "region" ? suggestDescription(listing.region, cfg.sessionDays) : products.text(products.normalize(listing), listing.region, regionName(listing.region), descriptionFooter(cfg.sessionDays)).description });
}

async function setPrice(listingId, priceUsd) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    listing.priceUsd = await deps.eld.changeAccountOfferPrice(listing.externalId, validPrice(priceUsd));
    await readBack(listing).catch(() => {});
    await listing.save();
    return listingView(listing.toObject());
  });
}

async function pauseListing(listingId) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    await deps.eld.pauseAccountOffer(listing.externalId);
    await readBack(listing).catch(() => {});
    if (listing.status === "active") listing.status = "paused";
    await listing.save();
    return listingView(listing.toObject());
  });
}

async function resumeListing(listingId) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    await deps.eld.resumeAccountOffer(listing.externalId);
    await readBack(listing).catch(() => {});
    await listing.save();
    return listingView(listing.toObject());
  });
}

// Take the offer down for good. A unit that already left the stock may be a
// sale not recorded yet, so the sale sync runs for this listing first and the
// delete waits while any unit is unaccounted for.
async function deleteListing(listingId, actor) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    if (listing.status === "removed") return listingView(listing.toObject());
    const cfg = await getConfig();
    if (listing.externalId) {
      const notes = [];
      try {
        const r = await readBack(listing);
        if (r.missing) await scanOrders([listing], cfg, new Date(), notes, { states: ORDER_STATES_ALL });
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      await listing.save();
      const unaccounted = listing.accounts.filter((u) => u.state === "listed" && u.missingSince);
      if (unaccounted.length) {
        throw userError(
          unaccounted.map((u) => u.label).join(", ") + " left Eldorado's stock but no order for it is recorded yet. Wait a few minutes and try again.",
          409,
        );
      }
      try {
        await deps.eld.deleteAccountOffer(listing.externalId);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    const sessions = [];
    const back = [];
    for (const u of listing.accounts) {
      if (u.state !== "listed") continue;
      u.state = "removed";
      u.removedAt = new Date();
      u.removedReason = "listing deleted by " + (actor || "operator");
      sessions.push(u.sessionId);
      back.push(String(u.steamAccountId));
    }
    await revokeSessions(sessions, "unlisted");
    await release(back, { held: listing.kind === "rivals" });
    listing.status = "removed";
    await listing.save();
    return listingView(listing.toObject());
  });
}

// ---------------------------------------------------------------------------
// Sale sync
// ---------------------------------------------------------------------------

async function markUnitSold(unit, orderId, soldAt, cfg) {
  unit.state = "sold";
  unit.soldAt = soldAt;
  unit.orderId = orderId;
  unit.missingSince = null;
  await SteamAccount.updateOne(
    { _id: unit.steamAccountId },
    { $set: { stage: "sold", soldAt, soldNote: ("Eldorado order " + orderId).slice(0, 300) } },
  );
  if (unit.sessionId) {
    await BuyerMailSession.updateOne(
      { _id: unit.sessionId, stage: "listed" },
      {
        $set: {
          stage: "sold",
          soldAt,
          expiresAt: new Date(soldAt.getTime() + cfg.sessionDays * DAY_MS),
          orderRef: orderId,
          marketplace: "eldorado",
          passwordEnc: "",
        },
      },
    );
  }
}

function orderState(o) {
  return String((o && o.state && o.state.state) || (o && o.orderState) || "");
}

function orderTotalUsd(o) {
  const t = o && o.totalPrice;
  if (t && (!t.currency || t.currency === "USD") && Number.isFinite(Number(t.amount))) return Number(t.amount);
  return 0;
}

// Which listed units an order handed over: the order's own delivery entries
// when Eldorado shows them, else the units that left the stock (only when
// exactly as many left as the order bought — anything else is ambiguous).
async function matchUnits(listing, order, notes, { exactOnly = false } = {}) {
  const orderId = String(order.id);
  const qty = Math.max(1, parseInt(order.purchaseQuantity, 10) || 1);
  let logins = [];
  try {
    logins = (await deps.eld.orderAccountDetails(orderId)).map((e) => e.accountLogin.toLowerCase()).filter(Boolean);
  } catch (e) {
    notes.push("order " + orderId.slice(0, 8) + " details: " + e.message);
  }
  if (logins.length) {
    const units = listing.accounts.filter((u) => logins.includes(u.login) && u.state === "listed");
    if (units.length) return { units, matchedBy: "order-details", qty };
  }
  if (exactOnly) return { units: [], matchedBy: "unmatched", qty };
  const gone = listing.accounts
    .filter((u) => u.state === "listed" && u.missingSince)
    .sort((a, b) => new Date(a.missingSince) - new Date(b.missingSince));
  if (gone.length === qty) return { units: gone, matchedBy: "stock-diff", qty };
  return { units: [], matchedBy: "unmatched", qty };
}

async function recordSale(listing, order, state, cfg, now, notes) {
  const orderId = String(order.id);
  const created = Date.parse(order.createdDate || "");
  const soldAt = Number.isFinite(created) ? new Date(created) : now;
  const { units, matchedBy, qty } = await matchUnits(listing, order, notes);
  if (!units.length && now - soldAt < UNMATCHED_GRACE_MS) {
    notes.push("order " + orderId.slice(0, 8) + " not matched yet");
    return null;
  }
  const sale = new SteamSale({
    market: "eldorado",
    orderId,
    offerId: listing.externalId,
    listingId: listing._id,
    title: listing.title,
    region: listing.region,
    priceUsd: orderTotalUsd(order),
    quantity: qty,
    buyerUsername: String(order.buyerUsername || ""),
    orderState: state,
    orderCreatedAt: soldAt,
    matchedBy,
    needsAttention: matchedBy === "unmatched" || units.length !== qty,
    note:
      matchedBy === "unmatched"
        ? "Could not tell which account this buyer received"
        : units.length !== qty
          ? "Order is for " + qty + " but " + units.length + " account(s) matched"
          : "",
    lastCheckedAt: now,
    accounts: [],
  });
  // Claim the order first (unique orderId), then mark the accounts: a second
  // pass that sees the same order stops at the duplicate key.
  try {
    await sale.save();
  } catch (e) {
    if (e && e.code === 11000) return null;
    throw e;
  }
  for (const u of units) {
    await markUnitSold(u, orderId, soldAt, cfg);
    sale.accounts.push({ steamAccountId: u.steamAccountId, sessionId: u.sessionId, label: u.label, login: u.login });
  }
  await sale.save();
  deriveStatus(listing);
  const names = units.map((u) => u.label).join(", ") || "?";
  await deps.notify(
    (sale.needsAttention ? "⚠️ " : "💰 ") + "Steam account sold on Eldorado: " + listing.title + "\n" +
      "Order " + orderId + (sale.priceUsd ? " — $" + sale.priceUsd.toFixed(2) : "") + " — account(s): " + names + ".\n" +
      (sale.needsAttention ? sale.note + ". Open Steam accounts → Selling on Eldorado." : "The buyer's mail page is open for " + cfg.sessionDays + " days."),
  );
  return sale;
}

async function scanOrders(listings, cfg, now, notes, { states = ORDER_STATES_NEW } = {}) {
  const byOffer = new Map(listings.filter((l) => l.externalId).map((l) => [l.externalId, l]));
  if (!byOffer.size) return { seen: 0, recorded: 0 };
  const orders = await deps.eld.ordersInStates(states, 50);
  const done = new Set();
  let seen = 0;
  let recorded = 0;
  for (const o of orders) {
    const listing = byOffer.get(String((o && o.offerId) || ""));
    if (!listing) continue;
    const orderId = String(o.id || "");
    if (!orderId || done.has(orderId)) continue;
    done.add(orderId);
    seen++;
    const st = orderState(o);
    const sale = await SteamSale.findOne({ orderId });
    if (!sale) {
      if (/^canceled$/i.test(st) && !listing.accounts.some((u) => u.state === "listed" && u.missingSince)) continue;
      if (await recordSale(listing, o, st, cfg, now, notes)) recorded++;
      continue;
    }
    if (sale.matchedBy === "unmatched") {
      // Only the order's own delivery entry may settle an old unmatched order.
      const m = await matchUnits(listing, o, notes, { exactOnly: true });
      if (m.units.length) {
        for (const u of m.units) {
          await markUnitSold(u, orderId, sale.orderCreatedAt || now, cfg);
          sale.accounts.push({ steamAccountId: u.steamAccountId, sessionId: u.sessionId, label: u.label, login: u.login });
        }
        sale.matchedBy = m.matchedBy;
        sale.needsAttention = m.units.length !== m.qty;
        sale.note = sale.needsAttention ? "Order is for " + m.qty + " but " + m.units.length + " account(s) matched" : "";
        deriveStatus(listing);
        await deps.notify("✅ Steam sale " + orderId + " is now matched to " + m.units.map((u) => u.label).join(", ") + ".");
      }
    }
    if (sale.orderState !== st) {
      const was = sale.orderState;
      sale.orderState = st;
      if (/^(disputed|canceled)$/i.test(st)) {
        sale.needsAttention = true;
        sale.note = /canceled/i.test(st)
          ? "Order was cancelled/refunded after delivery. The buyer saw the password: change it before selling this account again."
          : "Order is disputed. Answer on Eldorado (3 h to reply; 12 h for proof).";
        await deps.notify("⚠️ Steam order " + orderId + " (" + listing.title + ") went " + was + " → " + st + ". " + sale.note);
      }
    }
    sale.lastCheckedAt = now;
    await sale.save();
  }
  return { seen, recorded };
}

async function alertMissing(listings, now) {
  for (const l of listings) {
    const late = l.accounts.filter(
      (u) => u.state === "listed" && u.missingSince && !u.missingAlertedAt && now - new Date(u.missingSince) >= MISSING_ALERT_AFTER_MS,
    );
    if (!late.length) continue;
    for (const u of late) u.missingAlertedAt = now;
    await l.save();
    await deps.notify(
      "⚠️ Steam listing “" + l.title + "”: " + late.map((u) => u.label).join(", ") + " left Eldorado's stock " +
        Math.round((now - new Date(late[0].missingSince)) / 60000) + " min ago but no order for it was found. Was it removed on Eldorado by hand?",
    );
  }
}

async function renewIfDue(listing, offer, now, notes) {
  if (!offer || !/^active$/i.test(String(offer.offerState || ""))) return false;
  const exp = parseEldDate(offer.expireDate);
  if (!Number.isFinite(exp) || exp - now > RENEW_WINDOW_MS) return false;
  if (listing.lastRenewedAt && now - new Date(listing.lastRenewedAt) < RENEW_MIN_GAP_MS) return false;
  listing.lastRenewedAt = now;
  await deps.eld.pauseAccountOffer(listing.externalId);
  await deps.eld.resumeAccountOffer(listing.externalId);
  notes.push(listing.title.slice(0, 40) + ": renewed (expiry was " + String(offer.expireDate).slice(0, 10) + ")");
  return true;
}

async function tick({ force = false } = {}) {
  return withLock(async () => {
    const cfg = await getConfig();
    if (!cfg.syncEnabled && !force) return { skipped: "sale sync is switched off" };
    const now = new Date();
    const notes = [];
    let ok = true;
    // A create that never finished may or may not have reached Eldorado.
    // Never guessed: flagged, accounts stay reserved.
    const stale = await SteamListing.find({ status: "draft", createdAt: { $lt: new Date(now - 10 * 60 * 1000) } });
    for (const d of stale) {
      d.status = "error";
      d.lastError = "The create was interrupted. Check My offers on Eldorado before deleting this row.";
      d.lastErrorAt = now;
      await d.save();
    }
    const listings = await SteamListing.find({ status: { $in: LIVE_LISTING }, externalId: { $ne: "" } });
    if (!listings.length) {
      await SteamSalesState.updateOne({ _id: "main" }, { $set: { lastTickAt: now, lastTickOk: true, lastTickNote: "no live listing" } }, { upsert: true });
      return { ok: true, listings: 0, notes };
    }
    let anyMissing = false;
    for (const l of listings) {
      try {
        const r = await readBack(l, now);
        if (r.missing) anyMissing = true;
        await renewIfDue(l, r.offer, now, notes);
        l.lastError = "";
      } catch (e) {
        ok = false;
        l.lastError = (e && e.message) || String(e);
        l.lastErrorAt = now;
        notes.push(l.title.slice(0, 40) + ": " + l.lastError);
      }
      l.lastSyncAt = now;
      await l.save();
    }
    const due = force || !cfg.lastOrderScanAt || now - new Date(cfg.lastOrderScanAt) >= ORDER_SCAN_EVERY_MS;
    if (anyMissing || due) {
      try {
        const r = await scanOrders(listings, cfg, now, notes, { states: due ? ORDER_STATES_ALL : ORDER_STATES_NEW });
        if (r.recorded) notes.push(r.recorded + " sale(s) recorded");
        await SteamSalesState.updateOne({ _id: "main" }, { $set: { lastOrderScanAt: now } }, { upsert: true });
      } catch (e) {
        ok = false;
        notes.push("orders: " + ((e && e.message) || e));
      }
      for (const l of listings) await l.save();
    }
    await alertMissing(listings, now);
    await SteamSalesState.updateOne(
      { _id: "main" },
      { $set: { lastTickAt: now, lastTickOk: ok, lastTickNote: notes.join(" | ").slice(0, 900) } },
      { upsert: true },
    );
    return { ok, listings: listings.length, notes };
  });
}

let timer = null;
function start() {
  if (timer) return;
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      console.error("[steamSales] tick failed:", (e && e.message) || e);
    }
    timer = setTimeout(loop, TICK_MS);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(loop, FIRST_TICK_MS);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

// ---------------------------------------------------------------------------
// Views for the page
// ---------------------------------------------------------------------------

function listingView(l) {
  const units = (l.accounts || []).map((u) => ({
    steamAccountId: String(u.steamAccountId),
    label: u.label,
    state: u.state,
    addedAt: u.addedAt,
    soldAt: u.soldAt,
    orderId: u.orderId,
    missingSince: u.missingSince,
    removedReason: u.removedReason,
  }));
  return {
    _id: String(l._id),
    market: l.market,
    kind: l.kind, appId: l.appId, minHours: l.minHours,
    region: l.region,
    regionName: regionName(l.region),
    status: l.status,
    title: l.title,
    priceUsd: l.priceUsd,
    url: l.url,
    cover: l.coverSource,
    listed: units.filter((u) => u.state === "listed").length,
    sold: units.filter((u) => u.state === "sold").length,
    units,
    remote: l.remote || {},
    lastSyncAt: l.lastSyncAt,
    lastError: l.lastError,
    lastErrorAt: l.lastErrorAt,
    createdAt: l.createdAt,
  };
}

async function overview() {
  const [cfg, listings, sales, stock, proxy] = await Promise.all([
    getConfig(),
    SteamListing.find({ status: { $ne: "removed" } }).sort({ createdAt: -1 }).lean(),
    SteamSale.find({}).sort({ orderCreatedAt: -1, createdAt: -1 }).limit(50).lean(),
    stockView(),
    deps.outlook.proxyHealth().catch(() => null),
  ]);
  return {
    config: {
      syncEnabled: cfg.syncEnabled,
      sessionDays: cfg.sessionDays,
      priceUsd: cfg.priceUsd,
      lastTickAt: cfg.lastTickAt || null,
      lastTickOk: cfg.lastTickOk == null ? null : cfg.lastTickOk,
      lastTickNote: cfg.lastTickNote || "",
    },
    mailPage: { url: providerUrl(), proxyOk: !!proxy },
    listings: listings.map(listingView),
    ready: stock.groups.map((g) => ({
      ...g,
      liveListingId: (listings.find((l) => l.kind === "region" && l.region === g.region && LIVE_LISTING.includes(l.status)) || {})._id || null,
    })),
    blocked: stock.blocked,
    sales: sales.map((s) => ({
      _id: String(s._id),
      market: s.market || "eldorado",
      orderId: s.orderId,
      title: s.title,
      region: s.region,
      priceUsd: s.priceUsd,
      quantity: s.quantity,
      orderState: s.orderState,
      orderCreatedAt: s.orderCreatedAt,
      matchedBy: s.matchedBy,
      needsAttention: s.needsAttention,
      note: s.note,
      accounts: (s.accounts || []).map((a) => a.label),
    })),
  };
}

// Whether an Eldorado offer is one of these listings (the order fulfiller
// skips its orders: Eldorado hands the account over itself).
async function isSteamOffer(offerId) {
  const id = String(offerId || "");
  if (!id) return false;
  return !!(await SteamListing.exists({ market: "eldorado", externalId: id }));
}

module.exports = {
  SECTION,
  getConfig,
  setConfig,
  overview,
  previewListing,
  createListing,
  addAccounts,
  removeAccount,
  updateText,
  refreshDescription,
  setPrice,
  pauseListing,
  resumeListing,
  deleteListing,
  tick,
  start,
  stop,
  isSteamOffer,
  // shared with utils/steamG2g.js and utils/steamDistributor.js
  _shared: {
    withLock,
    mintListedSession,
    revokeSessions,
    entryFor,
    descriptionFooter,
    readBack,
    listingView,
    LIVE_LISTING,
    REGION_WARNING,
    dec,
    userError,
    regionName,
    regionOf,
    mintPassword,
    checkInbox,
    blockersOf,
    vetAccounts,
    reserve,
    release,
    stockView,
    providerUrl,
  },
  // for tests
  _setDeps(over) {
    Object.assign(deps, over || {});
    inboxCache.clear();
  },
  _internal: { REGION_WARNING, suggestTitle, suggestDescription, additionalInfoText, entryFor, blockersOf, coverFor, regionName, stockReadable },
};
