// Epic Games account sales: stock readiness, Eldorado instant-delivery
// listings, and the sale sync that records what sold.
//
// The product: an Epic account (made by the generator, owning the free games
// it claimed). What the buyer receives, instantly, from Eldorado's own order
// page — no chat, nothing for us to send:
//   Account details  login = the Epic email, password = the Epic password
//   Email details    provider URL = our mail page (/mail/), login = the same
//                    email, password = a random password that ONLY opens the
//                    mail page (a BuyerMailSession) — never the Outlook one.
// The mail page shows only mail from Epic, only from the purchase on, and
// closes N days after the sale or as soon as Epic says the email was changed
// (utils/buyerSessionWatcher). The Outlook inbox itself never leaves us: it is
// usually also the email of one of our SOOP accounts.
//
// Lifecycle of one unit of stock:
//   ready ──list──▶ listed (session stage "listed", password in the offer's
//                   delivery entry, no expiry clock)
//   listed ──sale──▶ sold (EpicAccount.sold, session stage "sold" with
//                   expiresAt = sale + sessionDays)
//   listed ──remove/delete──▶ removed (session revoked "unlisted")
//
// The sale sync (tick) reads Eldorado only while a listing is live: the
// offer + its remaining delivery entries every tick, and the seller order
// lists when a unit left the stock or every ORDER_SCAN_EVERY_MS. A sale is
// matched to its account by the order's own delivery entry when Eldorado
// shows it, else by which unit left the stock.
//
// Every mutation and every tick runs under one in-process lock, so a tick
// never reads a listing an operator action is halfway through rewriting.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcrypt");
const axios = require("axios");

const EpicAccount = require("../models/EpicAccount");
const EpicFreebie = require("../models/EpicFreebie");
const EpicListing = require("../models/EpicListing");
const EpicSale = require("../models/EpicSale");
const EpicSalesState = require("../models/EpicSalesState");
const BuyerMailSession = require("../models/BuyerMailSession");
const { encrypt, decrypt } = require("./secretBox");
const outlook = require("./outlookGraphReader");
const eld = require("./eldoradoAccountOffers");

const DAY_MS = 24 * 60 * 60 * 1000;
const LISTED_SESSION_MS = 365 * DAY_MS;
const TICK_MS = Number(process.env.EPIC_SALES_TICK_MS) || 5 * 60 * 1000;
const FIRST_TICK_MS = 3 * 60 * 1000;
const ORDER_SCAN_EVERY_MS = 15 * 60 * 1000;
const MISSING_ALERT_AFTER_MS = 30 * 60 * 1000;
const RENEW_WINDOW_MS = 5 * DAY_MS;
const RENEW_MIN_GAP_MS = 6 * 60 * 60 * 1000;
const PROXY_ALERT_GAP_MS = 2 * 60 * 60 * 1000;
const INBOX_CACHE_MS = 5 * 60 * 1000;
const MARKET_CACHE_MS = 10 * 60 * 1000;
const ORDER_STATES_NEW = ["Paid", "Delivered", "Received"];
const ORDER_STATES_ALL = ["Paid", "Delivered", "Received", "Completed", "Disputed", "Canceled"];
const LIVE_LISTING = ["active", "paused", "sold_out"];
const DEFAULTS = { syncEnabled: true, sessionDays: 7, allowSharedInbox: true };

// Inbox uses (scripts/mail-usage.json on the Mac). "epic" is the account's
// own use; "soop" is the case the mail page exists for.
const OWN_USES = new Set(["epic"]);
const SHAREABLE_USES = new Set(["soop"]);

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

async function mapLimit(items, limit, fn) {
  const queue = items.slice();
  const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
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

function labelOf(acc) {
  return (acc && (acc.label || acc.displayName || acc.accountId)) || "";
}

async function notify(text) {
  try {
    await require("./telegram").sendTelegram(text);
  } catch (e) {
    console.error("[epicSales] telegram:", (e && e.message) || e);
  }
}

// The buyer-facing mail page. Must be https: it goes into the delivery entry.
function providerUrl() {
  const base = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[^/\s]+$/i.test(base)) return "";
  return base + "/mail/";
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function getConfig() {
  const doc = await EpicSalesState.findById("main").lean();
  return { ...DEFAULTS, ...(doc || {}) };
}

async function setConfig(patch, actor) {
  const p = patch || {};
  const set = { updatedBy: String(actor || "") };
  if (typeof p.syncEnabled === "boolean") set.syncEnabled = p.syncEnabled;
  if (typeof p.allowSharedInbox === "boolean") set.allowSharedInbox = p.allowSharedInbox;
  if (p.sessionDays != null) {
    const d = Math.round(Number(p.sessionDays));
    if (!(d >= 1 && d <= 14)) throw userError("The mail page window must be 1 to 14 days");
    set.sessionDays = d;
  }
  await EpicSalesState.updateOne({ _id: "main" }, { $set: set }, { upsert: true });
  inboxCache.clear();
  return getConfig();
}

// ---------------------------------------------------------------------------
// Stock: what can be sold
// ---------------------------------------------------------------------------

// The account's games, most valuable first (the title and the cover lead with
// the game a buyer is most likely searching for), then by name.
function gameTitles(acc) {
  const seen = new Map();
  for (const g of (acc && acc.library) || []) {
    const t = String((g && g.title) || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    const price = Number(g.priceUsd) || 0;
    if (!seen.has(k) || seen.get(k).price < price) seen.set(k, { t, price });
  }
  return [...seen.values()].sort((a, b) => b.price - a.price || a.t.localeCompare(b.t)).map((x) => x.t);
}

// Accounts with exactly the same games share a key (and so a listing).
function gameKey(titles) {
  return [...new Set((titles || []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))]
    .sort()
    .join("|");
}

// Whether an inbox may go to a buyer through the mail page.
function inboxVerdict(check, cfg) {
  if (!check || check.error) {
    return {
      ok: false,
      code: "proxy",
      text:
        check && check.error === "proxy_unconfigured"
          ? "Mail proxy is not configured on the server"
          : "Mac mail proxy is not answering, so the mail page can't be confirmed for this inbox",
    };
  }
  if (check.status === "unknown") {
    return { ok: false, code: "unknown_inbox", text: "Inbox is not in the Mac's Outlook list, so the mail page can't read it" };
  }
  const others = [...new Set((check.sharedWith || []).map(String))].filter((u) => !OWN_USES.has(u));
  const hard = others.filter((u) => !SHAREABLE_USES.has(u));
  if (hard.length) {
    return { ok: false, code: "shared", shared: others, text: "Inbox is also used for " + hard.join(", ") };
  }
  if (others.length && !(cfg && cfg.allowSharedInbox)) {
    return {
      ok: false,
      code: "shared",
      shared: others,
      text: "Inbox is also our SOOP account's email (switch on “Sell accounts whose inbox is shared with SOOP” to allow it)",
    };
  }
  return {
    ok: true,
    shared: others,
    warn: others.length ? "Inbox is also our SOOP account's email. The buyer only ever sees Epic's emails" : "",
  };
}

const inboxCache = new Map();
async function checkInbox(email, { fresh = false } = {}) {
  const key = String(email || "").trim().toLowerCase();
  const hit = inboxCache.get(key);
  if (!fresh && hit && Date.now() - hit.at < INBOX_CACHE_MS) return hit.value;
  let value;
  try {
    value = await outlook.checkInbox(key);
  } catch (e) {
    value = { error: e && e.code === "proxy_unconfigured" ? "proxy_unconfigured" : (e && e.message) || "proxy error" };
  }
  inboxCache.set(key, { at: Date.now(), value });
  return value;
}

// Live giveaways an account's games are part of: buyers can still claim those
// for free themselves.
function stillFree(titles, freebies, now) {
  const want = new Set((titles || []).map((t) => t.toLowerCase()));
  return (freebies || []).filter(
    (f) => want.has(String(f.title || "").toLowerCase()) && (!f.endDate || new Date(f.endDate).getTime() > now),
  );
}

function fmtUtc(d) {
  const t = new Date(d);
  return Number.isFinite(t.getTime()) ? t.toISOString().slice(0, 16).replace("T", " ") + " UTC" : "";
}

function readinessOf(acc, ctx) {
  const blockers = [];
  const warnings = [];
  const email = dec(acc.email).trim().toLowerCase();
  const hasPassword = !!dec(acc.password);
  const listing = ctx.listingByAccount.get(String(acc._id)) || null;
  const titles = gameTitles(acc);
  let inbox = null;
  if (!email) blockers.push("No Epic login email saved");
  if (!hasPassword) blockers.push("No Epic password saved");
  if (email && !acc.sold && !listing) {
    inbox = inboxVerdict(ctx.checks.get(email), ctx.cfg);
    if (!inbox.ok) blockers.push(inbox.text);
    else if (inbox.warn) warnings.push(inbox.warn);
    if (ctx.buyerInboxes.has(email)) blockers.push("A buyer's mail page for this inbox is still open");
  }
  if (acc.status !== "ok" && !acc.sold) warnings.push("Epic sign-in for library sync has expired, so the game list may be out of date");
  if (!titles.length && !acc.sold) warnings.push("No games in the library yet");
  const free = acc.sold ? [] : stillFree(titles, ctx.freebies, ctx.now);
  if (free.length) {
    warnings.push(
      free.map((f) => f.title).join(", ") + " is still free on Epic until " + fmtUtc(free[0].endDate) +
        " (buyers can claim it themselves until then)",
    );
  }
  let state = "ready";
  if (acc.sold) state = "sold";
  else if (listing) state = "listed";
  else if (blockers.length) state = "blocked";
  return { state, blockers, warnings, email, listing, inbox, titles };
}

async function stockContext({ fresh = false, accountIds = null } = {}) {
  const cfg = await getConfig();
  const q = accountIds ? { _id: { $in: accountIds } } : {};
  const [accounts, listings, freebies, buyerSessions] = await Promise.all([
    EpicAccount.find(q).sort({ createdAt: 1 }).lean(),
    // "draft"/"error" rows may already be on Eldorado: their units stay taken.
    EpicListing.find({ status: { $in: [...LIVE_LISTING, "draft", "error"] } }).lean(),
    EpicFreebie.find({ active: true, upcoming: false }).lean(),
    BuyerMailSession.find({ revokedAt: null, expiresAt: { $gt: new Date() }, stage: { $ne: "listed" } })
      .select("inboxAddress")
      .lean(),
  ]);
  const listingByAccount = new Map();
  for (const l of listings) {
    for (const u of l.accounts || []) {
      if (u.state === "listed") {
        listingByAccount.set(String(u.epicAccountId), { id: String(l._id), title: l.title, status: l.status });
      }
    }
  }
  // Accounts loaded into a G2G offer's own stock (utils/epicG2g) are on sale
  // there: nothing else may sell them.
  for (const u of await g2gStockUnits()) {
    listingByAccount.set(String(u.epicAccountId), g2gListingRef(u));
  }
  for (const u of await paStockUnits()) {
    listingByAccount.set(String(u.epicAccountId), paListingRef(u));
  }
  const checks = new Map();
  const toCheck = [];
  for (const a of accounts) {
    if (a.sold || listingByAccount.has(String(a._id))) continue;
    const e = dec(a.email).trim().toLowerCase();
    if (e) toCheck.push(e);
  }
  await mapLimit([...new Set(toCheck)], 4, async (e) => checks.set(e, await checkInbox(e, { fresh })));
  return {
    cfg,
    accounts,
    listings,
    listingByAccount,
    freebies,
    checks,
    buyerInboxes: new Set(buyerSessions.map((s) => s.inboxAddress)),
    now: Date.now(),
  };
}

function stockRow(acc, r) {
  return {
    _id: String(acc._id),
    label: labelOf(acc),
    displayName: acc.displayName || "",
    email: r.email,
    source: acc.source || "manual",
    games: r.titles,
    libraryCount: acc.libraryCount || 0,
    libraryValueUsd: acc.libraryValueUsd || 0,
    loginOk: acc.status === "ok",
    state: r.state,
    blockers: r.blockers,
    warnings: r.warnings,
    listing: r.listing,
    sharedWith: (r.inbox && r.inbox.shared) || [],
    createdAt: acc.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Listing text
// ---------------------------------------------------------------------------

function suggestTitle(titles) {
  const t = titles || [];
  if (!t.length) return "Fresh Epic Games Account | No Games | Email Codes Included | Instant Delivery";
  const names = t.length <= 3 ? t.join(" + ") : t.slice(0, 3).join(" + ") + " + " + (t.length - 3) + " more";
  const full = "Epic Games Account | " + names + " | Email Codes Included | Instant";
  return full.length <= 160 ? full : full.slice(0, 157).replace(/\s+\S*$/, "") + "…";
}

function suggestDescription(titles, days) {
  const d = Math.max(1, Number(days) || DEFAULTS.sessionDays);
  const t = titles || [];
  const lines = [];
  if (t.length) {
    lines.push("Epic Games account (PC) with " + (t.length === 1 ? "this game" : "these " + t.length + " games") + " in its library:");
    for (const g of t.slice(0, 40)) lines.push("• " + g);
    if (t.length > 40) lines.push("• … and " + (t.length - 40) + " more");
  } else {
    lines.push("Fresh Epic Games account (PC), no games yet.");
  }
  lines.push("");
  lines.push("Delivered instantly after payment:");
  lines.push("• The Epic Games login (email) and password.");
  lines.push(
    "• Email details: a private mail page with its own login. It shows every email Epic Games sends to this account " +
      "(security codes, verification links) from your purchase on, for " + d + " days. It shows Epic's emails only; " +
      "the mailbox itself is not part of the sale.",
  );
  lines.push("");
  lines.push(
    "After you log in, change the account email to your own (epicgames.com → Account → Personal details). " +
      "From then on the account is fully yours.",
  );
  return lines.join("\n").slice(0, 2000);
}

// The note shown with every delivered unit. Eldorado stores it UNENCRYPTED,
// so it must never carry a secret.
function additionalInfoText(days) {
  const d = Math.max(1, Number(days) || DEFAULTS.sessionDays);
  return (
    "Epic emails (security codes, verification): open the Provider URL above and sign in with the Email login and " +
    "Email password. That page shows only the emails Epic Games sends to this account, from your purchase on, for " +
    d + " days. The Email password only works on that page; the account password is the one under Account details. " +
    "Please change the account email to your own right after you log in (epicgames.com > Account > Personal details)."
  );
}

function entryFor({ email, epicPassword, mailPassword, purl, days, entryId }) {
  return {
    id: entryId || null,
    accountLogin: email,
    accountPassword: epicPassword,
    emailProviderUrl: purl,
    emailLogin: email,
    emailPassword: mailPassword,
    additionalInfo: additionalInfoText(days),
  };
}

// ---------------------------------------------------------------------------
// Cover image
// ---------------------------------------------------------------------------

// Epic's image CDN resizes on request (the store's own thumbnails do this).
function sizedEpicImage(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)epicgames\.com$/i.test(u.hostname) && !u.search) {
      u.search = "?h=720&quality=high&resize=1&w=1280";
    }
    return u.toString();
  } catch {
    return url;
  }
}

async function coverUrlFor(titles) {
  if (!titles || !titles.length) return "";
  const rows = await EpicFreebie.find({ image: { $ne: "" } }).select("title image").lean();
  const byTitle = new Map(rows.map((r) => [String(r.title || "").toLowerCase(), r.image]));
  for (const t of titles) {
    const hit = byTitle.get(String(t).toLowerCase());
    if (hit) return hit;
  }
  return "";
}

async function downloadImage(url) {
  if (!/^https:\/\//i.test(String(url || ""))) throw userError("The cover image must be an https:// link");
  let r;
  try {
    r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 25000,
      maxContentLength: 8 * 1024 * 1024,
      maxRedirects: 3,
      validateStatus: (s) => s === 200,
    });
  } catch (e) {
    throw userError("Could not download the cover image: " + ((e && e.message) || e));
  }
  const ct = String(r.headers["content-type"] || "").toLowerCase();
  const ext = ct.includes("png") ? ".png" : ct.includes("jpeg") || ct.includes("jpg") ? ".jpg" : "";
  if (!ext) throw userError("The cover link is not a JPEG or PNG image");
  const file = path.join(os.tmpdir(), "epic-cover-" + crypto.randomBytes(6).toString("hex") + ext);
  fs.writeFileSync(file, Buffer.from(r.data));
  return file;
}

async function uploadCover(url) {
  const file = await downloadImage(sizedEpicImage(url));
  try {
    return await eld.uploadImage(file);
  } finally {
    fs.unlink(file, () => {});
  }
}

// ---------------------------------------------------------------------------
// Mail-page sessions for listed units
// ---------------------------------------------------------------------------

async function mintListedSession(acc, email, listingId, actor) {
  await BuyerMailSession.updateMany(
    { inboxAddress: email, revokedAt: null, stage: "listed" },
    { $set: { revokedAt: new Date(), revokedReason: "replaced" } },
  );
  const password = mintPassword();
  const row = await BuyerMailSession.create({
    epicAccountId: acc._id,
    inboxAddress: email,
    passwordHash: await bcrypt.hash(password, 10),
    passwordEnc: encrypt(password),
    expiresAt: new Date(Date.now() + LISTED_SESSION_MS),
    stage: "listed",
    listingId: listingId || null,
    marketplace: "eldorado",
    createdByUserId: String(actor || ""),
    note: "instant-delivery listing",
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

// Load + vet the accounts an operator asked to list. Throws a user error that
// names every account that can't go on sale and why.
async function vetAccounts(accountIds) {
  const ids = [...new Set((accountIds || []).map(String))].filter((x) => /^[a-f\d]{24}$/i.test(x));
  if (!ids.length) throw userError("Choose at least one account");
  const ctx = await stockContext({ fresh: true, accountIds: ids });
  if (ctx.accounts.length !== ids.length) throw userError("Some of those accounts no longer exist");
  const problems = [];
  const vetted = [];
  for (const acc of ctx.accounts) {
    const r = readinessOf(acc, ctx);
    if (r.state !== "ready") {
      const why = r.state === "listed" ? "already on “" + r.listing.title + "”" : r.state === "sold" ? "sold" : r.blockers.join("; ");
      problems.push(labelOf(acc) + ": " + why);
      continue;
    }
    vetted.push({ acc, email: r.email, titles: r.titles, epicPassword: dec(acc.password) });
  }
  if (problems.length) throw userError("Can't list: " + problems.join(" | "));
  return { ctx, vetted };
}

// ---------------------------------------------------------------------------
// Eldorado's permission to sell Epic accounts at all
// ---------------------------------------------------------------------------

// Epic Games accounts is one of Eldorado's "high-risk" categories; a seller
// lists there only while Eldorado has switched allowHighRiskOffers on for
// them. Read at most every 10 min (a create refusal re-reads it at once).
const PERMISSION_CACHE_MS = 10 * 60 * 1000;
let permissionCache = { at: 0, value: null };
async function eldoradoPermission({ fresh = false } = {}) {
  if (!fresh && permissionCache.value && Date.now() - permissionCache.at < PERMISSION_CACHE_MS) {
    return permissionCache.value;
  }
  let value;
  try {
    value = { ...(await eld.epicPermission()), checkedAt: new Date() };
  } catch (e) {
    value = { canSell: null, error: (e && e.message) || String(e), checkedAt: new Date() };
  }
  permissionCache = { at: Date.now(), value };
  return value;
}

const NO_PERMISSION_TEXT =
  "Eldorado doesn't let this seller account list Epic Games accounts yet: it's one of Eldorado's high-risk " +
  "categories and our account's “high-risk offers” permission is off. Ask Eldorado support to enable it; " +
  "everything else is ready.";

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

function validPrice(p) {
  const n = Math.round(Number(p) * 100) / 100;
  if (!Number.isFinite(n) || n < eld.MIN_PRICE) throw userError("Price must be at least $" + eld.MIN_PRICE.toFixed(2));
  if (n > 1000) throw userError("Price looks wrong (over $1000)");
  return n;
}

function validTitle(t) {
  const s = String(t || "").trim();
  if (s.length < 5 || s.length > 160) throw userError("Title must be 5 to 160 characters");
  if (/automatic\s+farming/i.test(s)) throw userError("“Automatic Farming” is reserved for the rent-farm product");
  return s;
}

// What a create would send, minus every secret. The panel shows it before
// the operator confirms.
async function previewListing(opts) {
  const { ctx, vetted } = await vetAccounts(opts.accountIds);
  const cfg = ctx.cfg;
  const purl = providerUrl();
  const games = vetted[0].titles;
  const key = gameKey(games);
  const mixed = vetted.some((v) => gameKey(v.titles) !== key);
  const cover = String(opts.coverUrl || "").trim() || (await coverUrlFor(games));
  const noPrice = opts.priceUsd == null || opts.priceUsd === "";
  const permission = await eldoradoPermission();
  return {
    permission,
    title: validTitle(opts.title || suggestTitle(games)),
    priceUsd: noPrice ? null : validPrice(opts.priceUsd),
    description: String(opts.description || suggestDescription(games, cfg.sessionDays)).slice(0, 2000),
    hasOriginalEmail: !!opts.hasOriginalEmail,
    quantity: vetted.length,
    games,
    mixedGames: mixed,
    coverUrl: cover,
    providerUrl: purl,
    sessionDays: cfg.sessionDays,
    units: vetted.map((v) => ({
      _id: String(v.acc._id),
      label: labelOf(v.acc),
      login: v.email,
      games: v.titles.length,
    })),
    note: additionalInfoText(cfg.sessionDays),
    problems: [
      ...(permission.canSell === false ? [NO_PERMISSION_TEXT] : []),
      ...(noPrice ? ["Set a price"] : []),
      ...(purl ? [] : ["PUBLIC_BASE_URL is not an https address, so the mail page link can't be built"]),
      ...(cover ? [] : ["No cover image found for these games. Paste an image link"]),
      ...(mixed ? ["These accounts don't all own the same games. The title and description list the first account's games"] : []),
    ],
  };
}

async function createListing(opts, actor) {
  return withLock(async () => {
    const pv = await previewListing(opts);
    if (pv.problems.some((p) => !/don't all own/.test(p))) throw userError(pv.problems.join(" | "));
    if (pv.mixedGames && !opts.allowMixed) throw userError(pv.problems.find((p) => /don't all own/.test(p)));
    const { ctx, vetted } = await vetAccounts(opts.accountIds);
    const cfg = ctx.cfg;
    const listing = new EpicListing({
      market: "eldorado",
      status: "draft",
      title: pv.title,
      description: pv.description,
      priceUsd: pv.priceUsd,
      hasOriginalEmail: pv.hasOriginalEmail,
      gameKey: gameKey(pv.games),
      games: pv.games,
      coverSource: pv.coverUrl,
      createdBy: String(actor || ""),
      accounts: [],
    });
    await listing.save();
    const minted = [];
    try {
      const entries = [];
      for (const v of vetted) {
        const { row, password } = await mintListedSession(v.acc, v.email, listing._id, actor);
        minted.push(row._id);
        listing.accounts.push({
          epicAccountId: v.acc._id,
          sessionId: row._id,
          login: v.email,
          label: labelOf(v.acc),
          state: "listed",
          addedAt: new Date(),
        });
        entries.push(
          entryFor({ email: v.email, epicPassword: v.epicPassword, mailPassword: password, purl: pv.providerUrl, days: cfg.sessionDays }),
        );
      }
      const image = await uploadCover(pv.coverUrl);
      listing.mainOfferImage = image;
      await listing.save();
      const created = await eld.createAccountOffer({
        title: pv.title,
        description: pv.description,
        priceUsd: pv.priceUsd,
        hasOriginalEmail: pv.hasOriginalEmail,
        mainOfferImage: image,
        offerImages: [],
        entries,
      });
      if (!created.id) {
        // On Eldorado, but its id could not be read: keep every session (the
        // offer may already be selling) and say so loudly.
        listing.status = "error";
        listing.lastError =
          "Created on Eldorado, but the new offer's id could not be read. Find it under “Other Epic offers” and use Link.";
        listing.lastErrorAt = new Date();
        await listing.save();
        throw userError(listing.lastError, 502);
      }
      listing.externalId = created.id;
      listing.url = eld.offerUrl(created.id);
      listing.status = "active";
      await listing.save();
    } catch (e) {
      // Eldorado's own refusal of the category: re-read the permission so the
      // panel says so instead of the old cached answer.
      if (/not eligible to place offers/i.test(String((e && e.message) || ""))) {
        await eldoradoPermission({ fresh: true }).catch(() => {});
      }
      if (!listing.externalId && listing.status !== "error") {
        // Nothing reached Eldorado: give the accounts back.
        await revokeSessions(minted, "unlisted");
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
    // Learn the entry ids + the offer's own state. A failure here is not a
    // failed create: the next tick reads them again.
    try {
      await readBack(listing);
      listing.lastSyncAt = new Date();
    } catch (e) {
      listing.lastError = "Created; reading it back failed: " + e.message;
      listing.lastErrorAt = new Date();
    }
    await listing.save();
    await notify(
      "🟢 Epic listing is live on Eldorado: " + listing.title + " — $" + listing.priceUsd.toFixed(2) + " × " +
        listing.accounts.length + " account(s).\n" + listing.url,
    );
    return listingView(listing.toObject());
  });
}

// Read the offer + its delivery entries and fold them into the listing doc.
// Returns { offer, entries, missing } (missing = listed units not in stock).
async function readBack(listing, now = new Date()) {
  const offer = await eld.getAccountOffer(listing.externalId);
  const entries = await eld.getAccountEntries(listing.externalId);
  if (!stockReadable(offer, entries)) {
    // Eldorado says there is stock but listed none of it: the read is not
    // trustworthy, so no unit is judged gone on it.
    throw userError(
      "Eldorado reports " + offer.quantity + " in stock but returned " + entries.length + " readable entries",
      502,
    );
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

// The entries read agrees with the offer's own quantity (or the offer gives
// none). Entries without a login can't be matched to anything either.
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
  const l = await EpicListing.findById(id);
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
    hasOriginalEmail: offer && offer.hasOriginalEmail != null ? !!offer.hasOriginalEmail : !!listing.hasOriginalEmail,
    mainOfferImage: (offer && offer.mainOfferImage && offer.mainOfferImage.largeImage && offer.mainOfferImage) || listing.mainOfferImage,
    offerImages: (offer && offer.offerImages) || [],
  };
}

// The complete stock to write back: our listed units still in stock (rebuilt
// from our own records) + entries we don't manage, passed through untouched.
async function rebuildEntries(listing, remote, cfg, { dropAccountId = null, offer = null } = {}) {
  const purl = providerUrl();
  if (!purl) throw userError("PUBLIC_BASE_URL is not an https address");
  // Writing the stock back from a partial read would delete the units it
  // missed. Only rewrite what Eldorado shows in full.
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
    if (dropAccountId && String(u.epicAccountId) === String(dropAccountId)) continue;
    const [acc, sess] = await Promise.all([
      EpicAccount.findById(u.epicAccountId).select("password").lean(),
      u.sessionId ? BuyerMailSession.findById(u.sessionId).select("passwordEnc revokedAt").lean() : null,
    ]);
    const epicPassword = dec(acc && acc.password);
    const mailPassword = sess && !sess.revokedAt ? dec(sess.passwordEnc) : "";
    if (!epicPassword || !mailPassword) {
      throw userError(
        "Can't rewrite this offer's stock: " + u.label + " has no saved Epic password or its mail page session was revoked. Remove it first.",
      );
    }
    out.push(entryFor({ email: u.login, epicPassword, mailPassword, purl, days: cfg.sessionDays, entryId: r.id }));
  }
  for (const e of remote) {
    if (e.accountLogin && ours.has(e.accountLogin.toLowerCase())) continue;
    if (!e.accountLogin || !e.accountPassword || e.legacy) {
      throw userError("The offer has a stock entry this panel doesn't manage and can't read back. Edit it on Eldorado instead.");
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

async function addAccounts(listingId, accountIds, actor) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    const { ctx, vetted } = await vetAccounts(accountIds);
    const cfg = ctx.cfg;
    const purl = providerUrl();
    const remote = await eld.getAccountEntries(listing.externalId);
    const offer = await eld.getAccountOffer(listing.externalId);
    const kept = await rebuildEntries(listing, remote, cfg, { offer });
    const minted = [];
    const added = [];
    try {
      for (const v of vetted) {
        const { row, password } = await mintListedSession(v.acc, v.email, listing._id, actor);
        minted.push(row._id);
        added.push({
          unit: { epicAccountId: v.acc._id, sessionId: row._id, login: v.email, label: labelOf(v.acc), state: "listed", addedAt: new Date() },
          entry: entryFor({ email: v.email, epicPassword: v.epicPassword, mailPassword: password, purl, days: cfg.sessionDays }),
        });
      }
      await eld.updateAccountOffer(listing.externalId, {
        ...offerFields(listing, offer),
        entries: [...kept, ...added.map((a) => a.entry)],
      });
    } catch (e) {
      await revokeSessions(minted, "unlisted");
      throw e;
    }
    for (const a of added) listing.accounts.push(a.unit);
    const wasSoldOut = listing.status === "sold_out";
    await readBack(listing);
    // An offer that went quiet because it ran out of stock goes back on sale;
    // one the owner paused stays paused.
    if (wasSoldOut && listing.remote.offerState && !/^active$/i.test(listing.remote.offerState)) {
      await eld.resumeAccountOffer(listing.externalId).catch((e) => {
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
    const unit = listing.accounts.find((u) => String(u.epicAccountId) === String(accountId) && u.state === "listed");
    if (!unit) throw userError("That account is not listed here");
    const cfg = await getConfig();
    const remote = await eld.getAccountEntries(listing.externalId);
    if (!remote.some((e) => e.accountLogin && e.accountLogin.toLowerCase() === unit.login)) {
      throw userError("That account already left Eldorado's stock, so it was probably just sold. Wait for the sale to be recorded.");
    }
    const offer = await eld.getAccountOffer(listing.externalId);
    const entries = await rebuildEntries(listing, remote, cfg, { dropAccountId: accountId, offer });
    if (!entries.length) throw userError("It's the last account on this offer. Pause or delete the listing instead.");
    await eld.updateAccountOffer(listing.externalId, { ...offerFields(listing, offer), entries });
    unit.state = "removed";
    unit.removedAt = new Date();
    unit.removedReason = "removed by " + (actor || "operator");
    await revokeSessions([unit.sessionId], "unlisted");
    await readBack(listing).catch(() => {});
    await listing.save();
    return listingView(listing.toObject());
  });
}

async function updateText(listingId, { title, description }) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    const cfg = await getConfig();
    const patch = {};
    if (title != null) patch.title = validTitle(title);
    if (description != null) patch.description = String(description).slice(0, 2000);
    const remote = await eld.getAccountEntries(listing.externalId);
    const offer = await eld.getAccountOffer(listing.externalId);
    const entries = await rebuildEntries(listing, remote, cfg, { offer });
    if (!entries.length) throw userError("The offer has no stock left to keep");
    await eld.updateAccountOffer(listing.externalId, { ...offerFields(listing, offer, patch), entries });
    if (patch.title) listing.title = patch.title;
    if (patch.description != null) listing.description = patch.description;
    await readBack(listing).catch(() => {});
    await listing.save();
    return listingView(listing.toObject());
  });
}

async function setPrice(listingId, priceUsd) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    const amount = await eld.changeAccountOfferPrice(listing.externalId, validPrice(priceUsd));
    listing.priceUsd = amount;
    await readBack(listing).catch(() => {});
    await listing.save();
    return listingView(listing.toObject());
  });
}

async function pauseListing(listingId) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    requireLive(listing);
    await eld.pauseAccountOffer(listing.externalId);
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
    await eld.resumeAccountOffer(listing.externalId);
    await readBack(listing).catch(() => {});
    await listing.save();
    return listingView(listing.toObject());
  });
}

// Take the offer down for good. A unit that already left the stock may be a
// sale that is not recorded yet, so the sale sync runs for this listing first
// and the delete waits while any unit is unaccounted for.
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
          unaccounted.map((u) => u.label).join(", ") +
            " left Eldorado's stock but no order for it is recorded yet. Wait a few minutes and try again.",
          409,
        );
      }
      try {
        await eld.deleteAccountOffer(listing.externalId);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    const sessions = [];
    for (const u of listing.accounts) {
      if (u.state !== "listed") continue;
      u.state = "removed";
      u.removedAt = new Date();
      u.removedReason = "listing deleted by " + (actor || "operator");
      sessions.push(u.sessionId);
    }
    await revokeSessions(sessions, "unlisted");
    listing.status = "removed";
    await listing.save();
    return listingView(listing.toObject());
  });
}

// Recovery: attach an offer id to a listing whose create could not read it.
async function linkOffer(listingId, offerId) {
  return withLock(async () => {
    const listing = await loadListing(listingId);
    const id = String(offerId || "").trim();
    if (!/^[a-f\d-]{20,64}$/i.test(id)) throw userError("That doesn't look like an Eldorado offer id");
    listing.externalId = id;
    listing.url = eld.offerUrl(id);
    listing.status = "active";
    await readBack(listing);
    listing.lastError = "";
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
  await EpicAccount.updateOne({ _id: unit.epicAccountId }, { $set: { sold: true } });
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
    logins = (await eld.orderAccountDetails(orderId)).map((e) => e.accountLogin.toLowerCase()).filter(Boolean);
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

// How long a paid order may stay unmatched before it is recorded anyway (and
// paged): Eldorado hands the entry over within seconds of payment.
const UNMATCHED_GRACE_MS = 20 * 60 * 1000;

async function recordSale(listing, order, state, cfg, now, notes) {
  const orderId = String(order.id);
  const created = Date.parse(order.createdDate || "");
  const soldAt = Number.isFinite(created) ? new Date(created) : now;
  const { units, matchedBy, qty } = await matchUnits(listing, order, notes);
  if (!units.length && now - soldAt < UNMATCHED_GRACE_MS) {
    // Probably still being delivered: look again on the next scan.
    notes.push("order " + orderId.slice(0, 8) + " not matched yet");
    return null;
  }
  const sale = new EpicSale({
    market: "eldorado",
    orderId,
    offerId: listing.externalId,
    listingId: listing._id,
    title: listing.title,
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
  for (const u of units) {
    await markUnitSold(u, orderId, soldAt, cfg);
    sale.accounts.push({ epicAccountId: u.epicAccountId, sessionId: u.sessionId, label: u.label, login: u.login });
  }
  try {
    await sale.save();
  } catch (e) {
    if (e && e.code === 11000) return null; // recorded by another pass
    throw e;
  }
  deriveStatus(listing);
  const names = units.map((u) => u.label).join(", ") || "?";
  await notify(
    (sale.needsAttention ? "⚠️ " : "💰 ") + "Epic account sold on Eldorado: " + listing.title + "\n" +
      "Order " + orderId + (sale.priceUsd ? " — $" + sale.priceUsd.toFixed(2) : "") + " — account(s): " + names + ".\n" +
      (sale.needsAttention
        ? sale.note + ". Open Epic accounts → Listings & sales."
        : "The buyer's mail page is open for " + cfg.sessionDays + " days (closes early when they change the email)."),
  );
  return sale;
}

async function scanOrders(listings, cfg, now, notes, { states = ORDER_STATES_NEW } = {}) {
  const byOffer = new Map(listings.filter((l) => l.externalId).map((l) => [l.externalId, l]));
  if (!byOffer.size) return { seen: 0, recorded: 0 };
  const orders = await eld.ordersInStates(states, 50);
  const done = new Set();
  let seen = 0;
  let recorded = 0;
  for (const o of orders) {
    const offerId = String((o && o.offerId) || "");
    const listing = byOffer.get(offerId);
    if (!listing) continue;
    const orderId = String(o.id || "");
    if (!orderId || done.has(orderId)) continue;
    done.add(orderId);
    seen++;
    const st = orderState(o);
    const sale = await EpicSale.findOne({ orderId });
    if (!sale) {
      if (/^canceled$/i.test(st) && !listing.accounts.some((u) => u.state === "listed" && u.missingSince)) {
        // Cancelled before anything left the stock: nothing was handed over.
        continue;
      }
      if (await recordSale(listing, o, st, cfg, now, notes)) recorded++;
      continue;
    }
    if (sale.matchedBy === "unmatched") {
      // Only the order's own delivery entry may settle an old unmatched
      // order: a unit that leaves the stock later may belong to a newer one.
      const m = await matchUnits(listing, o, notes, { exactOnly: true });
      if (m.units.length) {
        for (const u of m.units) {
          await markUnitSold(u, orderId, sale.orderCreatedAt || now, cfg);
          sale.accounts.push({ epicAccountId: u.epicAccountId, sessionId: u.sessionId, label: u.label, login: u.login });
        }
        sale.matchedBy = m.matchedBy;
        sale.needsAttention = m.units.length !== m.qty;
        sale.note = sale.needsAttention ? "Order is for " + m.qty + " but " + m.units.length + " account(s) matched" : "";
        deriveStatus(listing);
        await notify("✅ Epic sale " + orderId + " is now matched to " + m.units.map((u) => u.label).join(", ") + ".");
      }
    }
    if (sale.orderState !== st) {
      const was = sale.orderState;
      sale.orderState = st;
      if (/^(disputed|canceled)$/i.test(st)) {
        sale.needsAttention = true;
        sale.note =
          /canceled/i.test(st)
            ? "Order was cancelled/refunded after delivery. The buyer saw the password, so change it before selling this account again."
            : "Order is disputed. Answer on Eldorado (3 h to reply; 12 h for proof).";
        await notify("⚠️ Epic order " + orderId + " (" + listing.title + ") went " + was + " → " + st + ". " + sale.note);
      }
    }
    sale.lastCheckedAt = now;
    await sale.save();
  }
  return { seen, recorded };
}

// Units gone from the stock with no order matched for a while: page once.
async function alertMissing(listings, now) {
  for (const l of listings) {
    const late = l.accounts.filter(
      (u) => u.state === "listed" && u.missingSince && !u.missingAlertedAt && now - new Date(u.missingSince) >= MISSING_ALERT_AFTER_MS,
    );
    if (!late.length) continue;
    for (const u of late) u.missingAlertedAt = now;
    await l.save();
    await notify(
      "⚠️ Epic listing “" + l.title + "”: " + late.map((u) => u.label).join(", ") +
        " left Eldorado's stock " + Math.round((now - new Date(late[0].missingSince)) / 60000) +
        " min ago but no order for it was found. Was it removed on Eldorado by hand?",
    );
  }
}

// The mail page depends on the Mac. While any buyer is inside their window,
// a dead proxy means a buyer who cannot read their Epic code.
async function proxyWatch(now) {
  const open = await BuyerMailSession.countDocuments({
    revokedAt: null,
    expiresAt: { $gt: now },
    stage: { $ne: "listed" },
  });
  const listed = await BuyerMailSession.countDocuments({ revokedAt: null, stage: "listed" });
  if (!open && !listed) return null;
  const health = await outlook.proxyHealth();
  const ok = !!health;
  const st = await EpicSalesState.findById("main").select("lastProxyAlertAt").lean();
  const set = { lastProxyCheckAt: now, lastProxyOk: ok };
  if (!ok && (!st || !st.lastProxyAlertAt || now - new Date(st.lastProxyAlertAt) >= PROXY_ALERT_GAP_MS)) {
    set.lastProxyAlertAt = now;
    await notify(
      "⚠️ The Mac mail proxy is not answering, so Epic buyers can't read their Epic codes on the mail page " +
        "(" + open + " buyer(s) in their window, " + listed + " account(s) on sale). Is the Mac awake and online?",
    );
  }
  await EpicSalesState.updateOne({ _id: "main" }, { $set: set }, { upsert: true });
  return ok;
}

async function renewIfDue(listing, offer, now, notes) {
  if (!offer || !/^active$/i.test(String(offer.offerState || ""))) return false;
  const exp = parseEldDate(offer.expireDate);
  if (!Number.isFinite(exp) || exp - now > RENEW_WINDOW_MS) return false;
  if (listing.lastRenewedAt && now - new Date(listing.lastRenewedAt) < RENEW_MIN_GAP_MS) return false;
  listing.lastRenewedAt = now;
  await eld.pauseAccountOffer(listing.externalId);
  await eld.resumeAccountOffer(listing.externalId);
  const after = await eld.getAccountOffer(listing.externalId).catch(() => null);
  notes.push(
    listing.title.slice(0, 40) + ": renewed, expiry " + String(offer.expireDate).slice(0, 10) + " → " +
      String((after && after.expireDate) || "?").slice(0, 10),
  );
  return true;
}

async function tick({ force = false } = {}) {
  return withLock(async () => {
    const cfg = await getConfig();
    if (!cfg.syncEnabled && !force) return { skipped: "sale sync is switched off" };
    const now = new Date();
    const notes = [];
    let ok = true;
    // A create that never finished (the process stopped mid-way) may or may
    // not have reached Eldorado. Never guessed: flagged for the operator.
    const stale = await EpicListing.find({ status: "draft", createdAt: { $lt: new Date(now - 10 * 60 * 1000) } });
    for (const d of stale) {
      d.status = "error";
      d.lastError =
        "The create was interrupted. If the offer is on Eldorado (see “Other Epic offers”), Link it; otherwise Delete this row.";
      d.lastErrorAt = now;
      await d.save();
    }
    const listings = await EpicListing.find({ status: { $in: LIVE_LISTING }, externalId: { $ne: "" } });
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
    if (listings.length) {
      const st = await EpicSalesState.findById("main").select("lastOrderScanAt").lean();
      const due = force || !st || !st.lastOrderScanAt || now - new Date(st.lastOrderScanAt) >= ORDER_SCAN_EVERY_MS;
      if (anyMissing || due) {
        try {
          const r = await scanOrders(listings, cfg, now, notes, { states: due ? ORDER_STATES_ALL : ORDER_STATES_NEW });
          if (r.recorded) notes.push(r.recorded + " sale(s) recorded");
          await EpicSalesState.updateOne({ _id: "main" }, { $set: { lastOrderScanAt: now } }, { upsert: true });
        } catch (e) {
          ok = false;
          notes.push("orders: " + ((e && e.message) || e));
        }
        for (const l of listings) await l.save();
      }
      await alertMissing(listings, now);
    }
    let proxyOk = null;
    try {
      proxyOk = await proxyWatch(now);
    } catch (e) {
      notes.push("proxy watch: " + e.message);
    }
    await EpicSalesState.updateOne(
      { _id: "main" },
      { $set: { lastTickAt: now, lastTickOk: ok, lastTickNote: notes.join(" | ").slice(0, 900) } },
      { upsert: true },
    );
    return { ok, listings: listings.length, proxyOk, notes };
  });
}

let timer = null;
function start() {
  if (timer) return;
  const loop = async () => {
    try {
      await tick();
    } catch (e) {
      console.error("[epicSales] tick failed:", (e && e.message) || e);
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

// Called by utils/buyerSessionWatcher when a LISTED unit's inbox received
// Epic's "email changed" mail: a buyer has it (the sale is not recorded yet),
// or someone else got in. Page, and run the sale sync soon.
async function onListedEmailChanged(rows) {
  // Stock mail sessions have no Eldorado listing ID. Hand them to each
  // market by session ID so an email change cannot release a live account.
  await require("./epicPa").onStockEmailChanged(rows);
  const g2gRows = (rows || []).filter((r) => !r.listingId && r.marketplace !== "playerauctions");
  if (g2gRows.length) {
    try {
      await require("./epicG2g").onStockEmailChanged(g2gRows);
    } catch (e) {
      console.error("[epicSales] G2G email-change hand-off:", (e && e.message) || e);
    }
  }
  rows = (rows || []).filter((r) => r.listingId);
  if (!rows.length) return;
  for (const r of rows) {
    const listing = r.listingId ? await EpicListing.findById(r.listingId).lean() : null;
    const unit = listing && (listing.accounts || []).find((u) => String(u.sessionId) === String(r.id));
    await notify(
      "⚠️ Epic account " + ((unit && unit.label) || "?") + " on sale in “" + ((listing && listing.title) || "?") +
        "” had its email changed. If no Eldorado order shows up for it in a few minutes, someone else is in this account.",
    );
  }
  setTimeout(() => tick({ force: true }).catch(() => {}), 5000).unref?.();
}

// A fresh mail-page password for a sold account (a buyer who lost it or whose
// window ran out). Replaces any open session for that inbox.
async function resendAccess(orderId, actor, days) {
  const sale = await EpicSale.findOne({ orderId: String(orderId || "") });
  if (!sale) throw userError("Sale not found", 404);
  if (!sale.accounts.length) throw userError("This sale has no matched account yet");
  const cfg = await getConfig();
  const d = Math.min(14, Math.max(1, Math.round(Number(days) || cfg.sessionDays)));
  const purl = providerUrl();
  const out = [];
  for (const a of sale.accounts) {
    const acc = await EpicAccount.findById(a.epicAccountId).lean();
    const email = dec(acc && acc.email).trim().toLowerCase();
    if (!email) throw userError(a.label + " has no saved email");
    await BuyerMailSession.updateMany(
      { inboxAddress: email, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: "replaced" } },
    );
    const password = mintPassword();
    const now = new Date();
    const row = await BuyerMailSession.create({
      epicAccountId: acc._id,
      inboxAddress: email,
      passwordHash: await bcrypt.hash(password, 10),
      expiresAt: new Date(now.getTime() + d * DAY_MS),
      stage: "sold",
      soldAt: now,
      listingId: sale.listingId,
      marketplace: sale.market || "eldorado",
      orderRef: sale.orderId,
      createdByUserId: String(actor || ""),
      note: "re-sent access",
    });
    a.sessionId = row._id;
    out.push({ label: a.label, email, password, loginUrl: purl, expiresAt: row.expiresAt });
  }
  await sale.save();
  return {
    days: d,
    accounts: out,
    message: out
      .map(
        (o) =>
          "Mail page for your Epic codes: " + o.loginUrl + "\nEmail login: " + o.email + "\nNew email password: " + o.password +
          "\n(open until " + fmtUtc(o.expiresAt) + ". Please change the Epic account email to your own.)",
      )
      .join("\n\n"),
  };
}

// ---------------------------------------------------------------------------
// Views for the panel
// ---------------------------------------------------------------------------

function listingView(l) {
  const units = (l.accounts || []).map((u) => ({
    epicAccountId: String(u.epicAccountId),
    label: u.label,
    login: u.login,
    state: u.state,
    addedAt: u.addedAt,
    soldAt: u.soldAt,
    orderId: u.orderId,
    missingSince: u.missingSince,
    hasEntry: !!u.entryId,
    removedReason: u.removedReason,
  }));
  return {
    _id: String(l._id),
    market: l.market,
    externalId: l.externalId,
    url: l.url,
    status: l.status,
    title: l.title,
    description: l.description,
    priceUsd: l.priceUsd,
    hasOriginalEmail: !!l.hasOriginalEmail,
    games: l.games || [],
    remote: l.remote || {},
    lastSyncAt: l.lastSyncAt,
    lastRenewedAt: l.lastRenewedAt,
    lastError: l.lastError,
    lastErrorAt: l.lastErrorAt,
    createdAt: l.createdAt,
    units,
    counts: {
      listed: units.filter((u) => u.state === "listed").length,
      sold: units.filter((u) => u.state === "sold").length,
      removed: units.filter((u) => u.state === "removed").length,
      missing: units.filter((u) => u.state === "listed" && u.missingSince).length,
    },
  };
}

async function salesView(limit = 100) {
  const rows = await EpicSale.find({}).sort({ orderCreatedAt: -1, createdAt: -1 }).limit(limit).lean();
  const ids = rows.flatMap((r) => (r.accounts || []).map((a) => a.sessionId)).filter(Boolean);
  const sessions = ids.length ? await BuyerMailSession.find({ _id: { $in: ids } }).lean() : [];
  const byId = new Map(sessions.map((s) => [String(s._id), s]));
  const now = Date.now();
  return rows.map((r) => ({
    orderId: r.orderId,
    market: r.market || "eldorado",
    submittedAt: r.submittedAt || null,
    deliveredAt: r.deliveredAt || null,
    releasedAt: r.releasedAt || null,
    offerId: r.offerId,
    listingId: r.listingId ? String(r.listingId) : "",
    title: r.title,
    priceUsd: r.priceUsd,
    quantity: r.quantity,
    buyerUsername: r.buyerUsername,
    orderState: r.orderState,
    orderCreatedAt: r.orderCreatedAt,
    matchedBy: r.matchedBy,
    needsAttention: !!r.needsAttention,
    note: r.note,
    accounts: (r.accounts || []).map((a) => {
      const s = a.sessionId ? byId.get(String(a.sessionId)) : null;
      return {
        label: a.label,
        login: a.login,
        mail: s
          ? {
              live: !s.revokedAt && new Date(s.expiresAt).getTime() > now,
              revokedReason: s.revokedReason || "",
              expiresAt: s.expiresAt,
              viewCount: s.viewCount || 0,
              firstViewAt: s.firstViewAt,
              lastViewAt: s.lastViewAt,
            }
          : null,
      };
    }),
  }));
}

function groupsOf(rows, cfg) {
  const m = new Map();
  for (const r of rows) {
    if (r.state !== "ready") continue;
    const k = gameKey(r.games);
    if (!m.has(k)) m.set(k, { gameKey: k, games: r.games, accounts: [] });
    m.get(k).accounts.push({ _id: r._id, label: r.label, warnings: r.warnings });
  }
  return [...m.values()]
    .map((g) => ({
      ...g,
      count: g.accounts.length,
      suggestedTitle: suggestTitle(g.games),
      suggestedDescription: suggestDescription(g.games, cfg.sessionDays),
    }))
    .sort((a, b) => b.games.length - a.games.length || b.count - a.count);
}

function eldoradoLogin() {
  try {
    const s = require("./settings").loadSettings();
    const stored = ((s && s.marketplaces) || {}).eldorado || {};
    const cookie = stored.cookie ? dec(stored.cookie) : "";
    if (!cookie) return { configured: false };
    const w = require("./eldoradoSessionWatch");
    const auth = w.authTimeMs(cookie);
    return { configured: true, signedInAt: auth ? new Date(auth) : null, expiresAt: auth ? new Date(w.limitMs(auth)) : null };
  } catch (e) {
    return { configured: false, error: (e && e.message) || String(e) };
  }
}

let otherOffersCache = { at: 0, value: null };
async function otherEpicOffers(listings) {
  if (otherOffersCache.value && Date.now() - otherOffersCache.at < 2 * 60 * 1000) {
    return filterOthers(otherOffersCache.value, listings);
  }
  try {
    const mine = await eld.myAccountOffers({ pageSize: 50 });
    otherOffersCache = { at: Date.now(), value: mine };
    return filterOthers(mine, listings);
  } catch (e) {
    return { error: (e && e.message) || String(e), offers: [] };
  }
}

function filterOthers(mine, listings) {
  const known = new Set((listings || []).map((l) => l.externalId).filter(Boolean));
  return {
    offers: (mine || [])
      .filter((o) => !known.has(String(o.id)))
      .map((o) => ({
        id: String(o.id),
        title: o.offerTitle || "",
        state: o.offerState || "",
        quantity: o.quantity,
        priceUsd: o.pricePerUnitInUSD ? o.pricePerUnitInUSD.amount : o.pricePerUnit ? o.pricePerUnit.amount : null,
        url: eld.offerUrl(o.id),
      })),
  };
}

async function overview({ withOthers = true } = {}) {
  const ctx = await stockContext();
  const stock = ctx.accounts.map((a) => stockRow(a, readinessOf(a, ctx)));
  const listings = await EpicListing.find({}).sort({ createdAt: -1 }).limit(50).lean();
  const [sales, proxy, state, permission, g2g, playerauctions] = await Promise.all([
    salesView(),
    outlook.proxyHealth(),
    EpicSalesState.findById("main").lean(),
    eldoradoPermission(),
    // G2G offers delivered by utils/epicG2g. Loaded here, not at the top:
    // that module requires this one.
    Promise.resolve()
      .then(() => require("./epicG2g").panelView(ctx))
      .catch((e) => ({ error: (e && e.message) || String(e), offers: [] })),
    require("./epicPa").overview(),
  ]);
  return {
    config: { syncEnabled: ctx.cfg.syncEnabled, sessionDays: ctx.cfg.sessionDays, allowSharedInbox: ctx.cfg.allowSharedInbox },
    health: {
      providerUrl: providerUrl(),
      proxy: proxy ? { ok: true, inboxes: proxy.inboxes } : { ok: false },
      eldorado: { ...eldoradoLogin(), permission, noPermissionText: NO_PERMISSION_TEXT },
      sync: {
        enabled: ctx.cfg.syncEnabled,
        lastTickAt: state && state.lastTickAt,
        lastTickOk: state ? state.lastTickOk : null,
        lastTickNote: (state && state.lastTickNote) || "",
        lastOrderScanAt: state && state.lastOrderScanAt,
        everyMinutes: Math.round(TICK_MS / 60000),
      },
    },
    stock,
    groups: groupsOf(stock, ctx.cfg),
    listings: listings.map(listingView),
    sales,
    g2g,
    playerauctions,
    others: withOthers ? await otherEpicOffers(listings) : { offers: [] },
  };
}

// Cheapest live Epic account offers on Eldorado matching a search, for the
// "lowest price for the same set" check before pricing. Public read, cached.
const marketCache = new Map();
async function marketCheck(query) {
  const q = String(query || "").trim().slice(0, 60);
  const hit = marketCache.get(q.toLowerCase());
  if (hit && Date.now() - hit.at < MARKET_CACHE_MS) return hit.value;
  const qs = new URLSearchParams({
    gameId: eld.EPIC_GAME_ID,
    category: "Account",
    searchQuery: q,
    pageIndex: "1",
    pageSize: "20",
    offerSortingCriterion: "Price",
    isAscending: "true",
  });
  const r = await axios.get("https://www.eldorado.gg/api/flexibleOffers?" + qs, {
    timeout: 20000,
    headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0" },
  });
  const rows = ((r.data && r.data.results) || []).map((x) => {
    const o = (x && x.offer) || {};
    const u = (x && x.user) || {};
    return {
      title: o.offerTitle || "",
      priceUsd: o.pricePerUnitInUSD ? Number(o.pricePerUnitInUSD.amount) : null,
      quantity: o.quantity,
      seller: u.username || "",
      instant: o.guaranteedDeliveryTime === "Instant",
      originalEmail: !!o.hasOriginalEmail,
    };
  });
  const value = { query: q, total: (r.data && r.data.recordCount) || rows.length, offers: rows.slice(0, 10) };
  marketCache.set(q.toLowerCase(), { at: Date.now(), value });
  return value;
}

// The live listing an account sits on, or null. Used by the manual Deliver
// and Mark sold paths so a listed account can't be sold twice.
// G2G stock units (loading or listed). Required lazily: the model is new and
// this module must keep loading on a server that does not have it yet.
async function g2gStockUnits(query = {}) {
  let EpicG2gUnit;
  try {
    EpicG2gUnit = require("../models/EpicG2gUnit");
  } catch {
    return [];
  }
  return EpicG2gUnit.find({ ...query, state: { $in: ["loading", "listed"] } })
    .select("epicAccountId offerId state")
    .lean();
}

function g2gListingRef(u) {
  return { id: "g2g:" + u.offerId, title: "G2G stock (offer " + u.offerId + ")", status: "active", market: "g2g" };
}

async function paStockUnits(query = {}) {
  return require("../models/EpicPaUnit").find({ ...query, state: { $ne: "sold" } })
    .select("epicAccountId offerId state").lean();
}
function paListingRef(u) {
  return { id: "pa:" + (u.offerId || u._id), title: "PlayerAuctions Epic stock", status: u.state, market: "playerauctions" };
}

async function listingForAccount(accountId) {
  const id = String(accountId || "");
  if (!/^[a-f\d]{24}$/i.test(id)) return null;
  const inPa = await paStockUnits({ epicAccountId: new (require("mongoose").Types.ObjectId)(id) });
  if (inPa.length) return paListingRef(inPa[0]);
  const inG2g = await g2gStockUnits({ epicAccountId: new (require("mongoose").Types.ObjectId)(id) });
  if (inG2g.length) return g2gListingRef(inG2g[0]);
  const l = await EpicListing.findOne({
    status: { $in: [...LIVE_LISTING, "draft", "error"] },
    accounts: { $elemMatch: { epicAccountId: new (require("mongoose").Types.ObjectId)(id), state: "listed" } },
  })
    .select("title status")
    .lean();
  return l ? { id: String(l._id), title: l.title, status: l.status } : null;
}

module.exports = {
  start,
  stop,
  tick,
  getConfig,
  setConfig,
  overview,
  previewListing,
  createListing,
  addAccounts,
  removeAccount,
  updateText,
  setPrice,
  pauseListing,
  resumeListing,
  deleteListing,
  linkOffer,
  resendAccess,
  marketCheck,
  listingForAccount,
  inboxVerdict,
  onListedEmailChanged,
  providerUrl,
  // utils/epicG2g picks its accounts with the same readiness rules.
  stockContext,
  // pure, for tests
  gameTitles,
  gameKey,
  suggestTitle,
  suggestDescription,
  additionalInfoText,
  entryFor,
  readinessOf,
  deriveStatus,
  sizedEpicImage,
  mintPassword,
  parseEldDate,
  _internals: {
    recordSale,
    scanOrders,
    readBack,
    markUnitSold,
    withLock,
    resetPermissionCache: () => {
      permissionCache = { at: 0, value: null };
    },
  },
};
