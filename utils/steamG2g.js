// Steam accounts on G2G, Auto delivery ("Instant"): one offer per country in
// Game Accounts › Steam Accounts, created through our seller-API connection.
// G2G hands the buyer a stored account row the moment they pay; this module
// creates the offers, loads accounts into their stock, and records the sales.
// Contract: docs/STEAM-SALES.md (v2). Modelled on the live Epic Instant offer
// (utils/epicG2g.js), whose form helpers it reuses.
//
// What a buyer receives (G2G's account form, on the order page):
//   Account ID = the Steam account name, Password = the Steam password,
//   Account Country = the signup country, Account Email = the Outlook address,
//   Email Password = a password for OUR mail page (never the Outlook one),
//   Additional Note = how to reach the mail page + the owner's region warning.
// The mail page shows only Steam's emails, for 14 days from the purchase.

const bcrypt = require("bcrypt");

const SteamAccount = require("../models/SteamAccount");
const SteamG2gUnit = require("../models/SteamG2gUnit");
const SteamSale = require("../models/SteamSale");
const SteamSalesState = require("../models/SteamSalesState");
const BuyerMailSession = require("../models/BuyerMailSession");
const { encrypt } = require("./secretBox");
const sales = require("./steamSales");

const S = sales._shared;

// Replaceable for tests (_setDeps).
const deps = {
  mp: require("./marketplaces"),
  form: () => require("./epicG2g"), // buildRow / checkTemplate / countryName
  notify: async (text) => {
    try {
      await require("./telegram").sendTelegram(text);
    } catch (e) {
      console.error("[steamG2g] telegram:", (e && e.message) || e);
    }
  },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const SERVICE = "f6a1aba5-473a-4044-836a-8968bbab16d7"; // G2G Game Accounts
const BRAND = "lgc_game_20647"; // Steam Accounts
const RELATION = "5af4ff27-6f89-4f5f-97f9-f703e51cc4e4";
// The brand's one required attribute. Empty accounts own no games.
const GAMES_OWNED = Object.freeze({ collection_id: "b7811700", dataset_id: "a5be43d2", value: "4 or below", is_subscription: false });
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 14;
const DEFAULT_PRICE = 1;
const TEMPLATE_CACHE_MS = 6 * 60 * 60 * 1000;
const CONFIRM_POLLS = 12;
const CONFIRM_GAP_MS = Number(process.env.STEAM_G2G_CONFIRM_GAP_MS) || 5000;
const LOAD_PAGE_AFTER_MS = 20 * 60 * 1000;
const STUCK_MS = 15 * 60 * 1000;
const REPAGE_MS = 3 * 60 * 60 * 1000;
const SWEEP_MS = Number(process.env.STEAM_G2G_SWEEP_MS) || 3 * 60 * 1000;
const SCAN_PAGES = 2;
const SCAN_STATUSES = ["preparing", "delivering", "completed"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function siteUrl() {
  const base = String(process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^/\s]+$/i.test(base) ? base : "";
}

function saleIdFor(orderItemId) {
  return "g2g:" + String(orderItemId || "");
}

const keyLocks = new Map();
function withKeyLock(key, fn) {
  const prev = keyLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  keyLocks.set(key, tail);
  tail.then(() => {
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  });
  return run;
}

const paged = new Map();
async function pageOnce(key, text) {
  const last = paged.get(key) || 0;
  if (Date.now() - last < REPAGE_MS) return;
  paged.set(key, Date.now());
  await deps.notify(text);
}

function orderPlacedAt(order) {
  const raw = (order && order.raw) || {};
  for (const v of [raw.created_at, raw.payment_success_at]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 1e12 && n < 4e12) return new Date(n);
  }
  const m = /^(\d{13})/.exec(String((order && order.orderItemId) || ""));
  return m ? new Date(Number(m[1])) : new Date();
}

function cancelledOrRefunded(item) {
  const status = String((item && (item.order_item_status || item.status)) || "").toLowerCase();
  return (Number(item && item.refunded_qty) || 0) > 0 || /cancel|refund/.test(status);
}

function refOf(inv) {
  return String((inv && (inv.upload_reference || inv.account_id || inv.reference)) || "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Offer text
// ---------------------------------------------------------------------------

function titleFor(region) {
  return ("[Steam] " + S.regionName(region) + " Region | Fresh New Account | Email Change Supported | Instant Delivery").slice(0, 128);
}

function descriptionFor(region, days) {
  const name = S.regionName(region);
  return [
    "You get a fresh, new Steam account made in " + name + " (" + region + "). No games on it.",
    "",
    S.REGION_WARNING,
    "",
    "About the account",
    "- Created by us in " + name + " and never sold before. Its Steam store region is " + name + ".",
    "- No phone number, social account or payment method linked.",
    "- Email change supported: you move the account to your own email.",
    "- New Steam accounts are limited (no friends list, trading or market) until $5 is spent on Steam. That is Valve's rule for every new account.",
    "",
    "What you receive (on the G2G order page, the moment you pay)",
    "- Steam account name and password",
    "- The account's country",
    "- A login for our private mail page, where you read the emails Steam sends to this account (Steam Guard and email change codes). It stays open for " +
      days + " days after your purchase.",
    "",
    "Please change the account email to your own right after you log in (Steam > Account details > Change email).",
  ].join("\n");
}

// The note stored with every row (G2G takes no link with a path in it, so it
// names the bare site, whose front page has the "Steam account emails" button).
function noteText(days) {
  return [
    "Email Password is NOT an Outlook password. It signs in to our mail page, which shows the emails Steam sends to this account " +
      "(Steam Guard and email change codes) for " + days + " days.",
    "Mail page: " + siteUrl() + " , press \"Steam account emails\", then sign in with Account Email + Email Password.",
    "Please change the account email to your own right after you log in (Steam > Account details > Change email).",
    S.REGION_WARNING,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Links (one offer per country)
// ---------------------------------------------------------------------------

async function links() {
  const doc = await SteamSalesState.findById("main").select("g2gOffers").lean();
  return (doc && doc.g2gOffers) || [];
}

async function linkFor(offerId) {
  const id = String(offerId || "");
  return id ? (await links()).find((l) => l.offerId === id) || null : null;
}

async function linkForRegion(region) {
  const cc = String(region || "").toUpperCase();
  return (await links()).find((l) => l.region === cc && l.enabled !== false) || null;
}

// Create the country's offer on G2G through the seller API and remember it.
async function createRegionOffer(region, actor) {
  const cc = String(region || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) throw S.userError("Choose a region");
  return withKeyLock("create:" + cc, async () => {
    const have = await linkForRegion(cc);
    if (have) return have;
    if (!siteUrl()) throw S.userError("PUBLIC_BASE_URL is not an https address, so the mail page can't be named");
    // Refuse a form we can't fill before an offer exists.
    deps.form().checkTemplate(await formTemplate());
    const days = DEFAULT_DAYS;
    const r = await deps.mp.g2gCreateInstantAccountOffer({
      serviceId: SERVICE,
      brandId: BRAND,
      relationId: RELATION,
      title: titleFor(cc),
      description: descriptionFor(cc, days),
      priceUsd: DEFAULT_PRICE,
      minQty: 1,
      offerAttributes: [{ ...GAMES_OWNED }],
      collectionTree: [GAMES_OWNED.collection_id],
    });
    const offer = r.offer || {};
    if (String(offer.delivery_speed || "") !== "instant") {
      await deps.notify(
        "⚠️ G2G Steam offer " + r.offerId + " (" + S.regionName(cc) + ") was created but G2G shows its delivery as \"" +
          offer.delivery_speed + "\", not Instant. Set it to Auto delivery on g2g.com.",
      );
    }
    const row = {
      offerId: r.offerId,
      region: cc,
      serviceId: SERVICE,
      brandId: BRAND,
      relationId: String(offer.relation_id || RELATION),
      title: String(offer.title || titleFor(cc)).slice(0, 200),
      priceUsd: DEFAULT_PRICE,
      sessionDays: days,
      enabled: true,
      createdAt: new Date(),
      createdBy: String(actor || ""),
    };
    await SteamSalesState.updateOne({ _id: "main" }, { $push: { g2gOffers: row } }, { upsert: true });
    await deps.notify("🟢 G2G Steam offer created: " + row.title + " — $" + DEFAULT_PRICE.toFixed(2) + ", Instant.\nhttps://www.g2g.com/offer/" + r.offerId);
    return row;
  });
}

const templateCache = { at: 0, value: null };
async function formTemplate() {
  if (templateCache.value && Date.now() - templateCache.at < TEMPLATE_CACHE_MS) return templateCache.value;
  const value = await deps.mp.g2gFormTemplate(SERVICE, BRAND);
  templateCache.at = Date.now();
  templateCache.value = value;
  return value;
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

async function mintStockSession(acc, email, offerId, days) {
  await BuyerMailSession.updateMany(
    { inboxAddress: email, revokedAt: null, stage: "listed" },
    { $set: { revokedAt: new Date(), revokedReason: "replaced" } },
  );
  const password = S.mintPassword();
  const row = await BuyerMailSession.create({
    kind: "steam",
    steamAccountId: acc._id,
    inboxAddress: email,
    passwordHash: await bcrypt.hash(password, 10),
    passwordEnc: encrypt(password),
    expiresAt: new Date(Date.now() + 365 * DAY_MS),
    stage: "listed",
    marketplace: "g2g",
    note: "G2G stock " + offerId + " (" + days + " days after sale)",
  });
  return { row, password };
}

async function stockCount(offerId) {
  const stats = await deps.mp.g2gStockStats(offerId).catch(() => null);
  return stats && Number.isFinite(Number(stats.active_inventory)) ? Number(stats.active_inventory) : null;
}

// Load these accounts into the link's G2G stock. Each one is reserved
// (stock → listed) first; anything that fails before the upload goes back.
async function loadAccounts(link, accountIds, actor) {
  if (!link || link.enabled === false) throw S.userError("That G2G offer is switched off");
  return withKeyLock("offer:" + link.offerId, async () => {
    const vetted = await S.vetAccounts({ region: link.region, accountIds });
    const reserved = await S.reserve(vetted.map((v) => v.acc._id));
    const take = vetted.filter((v) => reserved.includes(String(v.acc._id)));
    if (!take.length) throw S.userError("Those accounts were just taken by another action", 409);
    const template = await formTemplate();
    const form = deps.form();
    const days = Math.min(14, Math.max(1, Number(link.sessionDays) || DEFAULT_DAYS));
    const rows = [];
    const unitIds = [];
    const sessionIds = [];
    try {
      for (const v of take) {
        const unit = await SteamG2gUnit.create({
          offerId: link.offerId,
          region: link.region,
          steamAccountId: v.acc._id,
          login: String(v.acc.accountName).toLowerCase(),
          label: v.acc.accountName,
          state: "loading",
        });
        unitIds.push(unit._id);
        const { row, password } = await mintStockSession(v.acc, v.email, link.offerId, days);
        sessionIds.push(row._id);
        await SteamG2gUnit.updateOne({ _id: unit._id }, { $set: { sessionId: row._id } });
        rows.push(
          form.buildRow(template, {
            login: v.acc.accountName,
            password: v.password,
            email: v.email,
            mailPassword: password,
            firstName: "",
            lastName: "",
            country: form.countryName(S.regionOf(v.acc)),
            dob: "",
            note: noteText(days),
          }),
        );
      }
    } catch (e) {
      await undo(unitIds, sessionIds, reserved, "load failed before upload: " + ((e && e.message) || e));
      throw e;
    }
    const offer = await deps.mp.g2gGetOwnOffer(link.offerId);
    if (String((offer && offer.delivery_speed) || "") !== "instant") {
      await undo(unitIds, sessionIds, reserved, "offer is not on Auto delivery");
      throw S.userError("G2G offer " + link.offerId + " is not on Auto delivery");
    }
    const before = await stockCount(link.offerId);
    try {
      await deps.mp.g2gUploadStock(offer, rows.join(""));
    } catch (e) {
      // Not sent (or G2G refused it outright): give the accounts back.
      await undo(unitIds, sessionIds, reserved, "upload refused: " + ((e && e.message) || e));
      throw e;
    }
    // From here the rows may be in G2G's stock: the accounts stay reserved
    // whatever happens, and the sweep confirms them.
    await SteamG2gUnit.updateMany({ _id: { $in: unitIds } }, { $set: { uploadedAt: new Date() } });
    for (let i = 0; i < CONFIRM_POLLS; i++) {
      await deps.sleep(CONFIRM_GAP_MS);
      const n = await stockCount(link.offerId);
      if (n != null && n >= (before || 0) + rows.length) {
        await SteamG2gUnit.updateMany({ _id: { $in: unitIds }, state: "loading" }, { $set: { state: "listed", listedAt: new Date() } });
        await recordStock(link.offerId, n);
        await deps.notify(
          "G2G Steam offer (" + S.regionName(link.region) + "): " + rows.length + " account" + (rows.length > 1 ? "s" : "") +
            " loaded into its stock (" + n + " in stock now).",
        );
        return { loaded: rows.length, confirmed: true, stock: n, accounts: take.map((v) => v.acc.accountName) };
      }
    }
    return { loaded: rows.length, confirmed: false, accounts: take.map((v) => v.acc.accountName) };
  });
}

async function undo(unitIds, sessionIds, reserved, why) {
  const now = new Date();
  if (unitIds.length) {
    await SteamG2gUnit.updateMany({ _id: { $in: unitIds } }, { $set: { state: "removed", removedAt: now, removedReason: String(why).slice(0, 200) } });
  }
  if (sessionIds.length) {
    await BuyerMailSession.updateMany(
      { _id: { $in: sessionIds }, revokedAt: null, stage: "listed" },
      { $set: { revokedAt: now, revokedReason: "unlisted", passwordEnc: "" } },
    );
  }
  await S.release(reserved);
}

async function recordStock(offerId, n) {
  await SteamSalesState.updateOne(
    { _id: "main", "g2gOffers.offerId": offerId },
    { $set: { "g2gOffers.$.lastStock": n, "g2gOffers.$.lastStockSyncAt": new Date() } },
  );
}

// Units sent but not seen in G2G's stock yet.
async function confirmLoading(link) {
  const loading = await SteamG2gUnit.find({ offerId: link.offerId, state: "loading", uploadedAt: { $ne: null } }).lean();
  if (!loading.length) return 0;
  const listed = await SteamG2gUnit.countDocuments({ offerId: link.offerId, state: "listed" });
  const n = await stockCount(link.offerId);
  if (n != null && n >= listed + loading.length) {
    await SteamG2gUnit.updateMany({ _id: { $in: loading.map((u) => u._id) }, state: "loading" }, { $set: { state: "listed", listedAt: new Date() } });
    await recordStock(link.offerId, n);
    return loading.length;
  }
  const oldest = Math.min(...loading.map((u) => new Date(u.uploadedAt).getTime()));
  if (Date.now() - oldest > LOAD_PAGE_AFTER_MS) {
    await pageOnce(
      "load:" + link.offerId,
      "⚠️ G2G Steam offer " + link.offerId + " (" + S.regionName(link.region) + "): " + loading.length + " account(s) were sent to its stock " +
        Math.round((Date.now() - oldest) / 60000) + " min ago, but G2G shows " + (n == null ? "no stock count" : n + " in stock") +
        " (expected " + (listed + loading.length) + "). Check the offer's stock on G2G. Those accounts stay set aside meanwhile.",
    );
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------

async function scanSales(link) {
  return withKeyLock("scan:" + link.offerId, async () => {
    const since = link.createdAt ? new Date(link.createdAt).getTime() - DAY_MS : Date.now() - 7 * DAY_MS;
    const seen = new Map();
    for (const status of SCAN_STATUSES) {
      for (let page = 1; page <= SCAN_PAGES; page++) {
        let rows;
        try {
          rows = await deps.mp.g2gOrders({ page, pageSize: 30, status });
        } catch {
          break;
        }
        for (const o of rows || []) if (String(o.offerId) === String(link.offerId)) seen.set(String(o.orderItemId), o);
        if (!rows || rows.length < 30) break;
      }
    }
    let recorded = 0;
    for (const order of seen.values()) {
      if (orderPlacedAt(order).getTime() < since) continue;
      if (await SteamSale.exists({ orderId: saleIdFor(order.orderItemId) })) continue;
      if (await recordOrder(link, order)) recorded++;
    }
    await SteamSalesState.updateOne({ _id: "main", "g2gOffers.offerId": link.offerId }, { $set: { "g2gOffers.$.lastSaleScanAt": new Date() } });
    return { orders: seen.size, recorded };
  });
}

async function recordOrder(link, order) {
  const id = String(order.orderItemId || "");
  let item;
  try {
    item = await deps.mp.g2gOrder(id);
  } catch {
    return false;
  }
  const refs = [...new Set((Array.isArray(item && item.order_inventories) ? item.order_inventories : []).map(refOf).filter(Boolean))];
  if (!refs.length) {
    if (cancelledOrRefunded(item)) return false;
    if (Date.now() - orderPlacedAt(order).getTime() > STUCK_MS) {
      await pageOnce(
        "noref:" + id,
        "G2G order " + id + " on the Steam offer (" + S.regionName(link.region) + ") shows no delivered Account ID after " +
          Math.round((Date.now() - orderPlacedAt(order).getTime()) / 60000) + " min. Open the order on G2G: deliver or refund it there.",
      );
    }
    return false;
  }
  const units = await SteamG2gUnit.find({ offerId: link.offerId, login: { $in: refs } });
  const byLogin = new Map();
  for (const u of units) {
    const cur = byLogin.get(u.login);
    if (!cur || (cur.state !== "listed" && cur.state !== "loading")) byLogin.set(u.login, u);
  }
  const matched = refs.map((r) => byLogin.get(r)).filter(Boolean);
  const unknown = refs.filter((r) => !byLogin.has(r));
  const placed = orderPlacedAt(order);
  const days = Math.min(14, Math.max(1, Number(link.sessionDays) || DEFAULT_DAYS));
  let sale;
  try {
    sale = await SteamSale.create({
      market: "g2g",
      orderId: saleIdFor(id),
      offerId: String(link.offerId),
      title: String(order.title || link.title || "").slice(0, 300),
      region: link.region,
      priceUsd: Number(order.amount) || 0,
      quantity: Math.max(1, Number(order.purchasedQty) || refs.length),
      buyerUsername: String(order.buyerId || ""),
      orderState: String((item && item.order_item_status) || ""),
      orderCreatedAt: placed,
      matchedBy: "g2g-stock",
      needsAttention: unknown.length > 0,
      note: unknown.length ? "G2G handed out Account ID(s) we have no record of: " + unknown.join(", ") : "",
      accounts: matched.map((u) => ({ steamAccountId: u.steamAccountId, sessionId: u.sessionId, label: u.label, login: u.login })),
    });
  } catch (e) {
    if (e && e.code === 11000) return false;
    throw e;
  }
  for (const u of matched) {
    await SteamG2gUnit.updateOne({ _id: u._id }, { $set: { state: "sold", soldAt: placed, orderId: id } });
    await SteamAccount.updateOne(
      { _id: u.steamAccountId },
      { $set: { stage: "sold", soldAt: placed, soldNote: ("G2G order " + id).slice(0, 300) } },
    );
    if (u.sessionId) {
      await BuyerMailSession.updateOne(
        { _id: u.sessionId },
        { $set: { stage: "sold", soldAt: placed, expiresAt: new Date(placed.getTime() + days * DAY_MS), passwordEnc: "", orderRef: id } },
      );
    }
  }
  await deps.notify(
    (unknown.length ? "⚠️ " : "💰 ") + "Steam account sold on G2G (" + S.regionName(link.region) + "): " +
      (matched.map((u) => u.label).join(", ") || "?") + " ($" + (Number(order.amount) || 0).toFixed(2) + ", order " + id + "). " +
      "G2G gave the buyer the login; the mail page is open " + days + " days." + (unknown.length ? " " + sale.note + "." : ""),
  );
  return true;
}

// The G2G order handler (utils/g2gFulfiller) asks this first for every paid
// order: null = not a Steam offer. G2G delivers ours from the stock itself.
async function deliverOrder(order) {
  let link;
  try {
    link = await linkFor(order && order.offerId);
  } catch {
    return null;
  }
  if (!link) return null;
  const id = String((order && order.orderItemId) || "");
  const waited = Date.now() - orderPlacedAt(order).getTime();
  if (waited > STUCK_MS) {
    await pageOnce(
      "stuck:" + id,
      "G2G order " + id + " on the Steam offer (" + S.regionName(link.region) + ") has waited " + Math.round(waited / 60000) +
        " min and G2G has not handed out an account (out of stock?). Open the order on G2G and deliver or refund it.",
    );
  }
  return { orderId: id, skipped: "Steam account order: Instant offer, G2G delivers it from our stock" };
}

// ---------------------------------------------------------------------------
// Sweep
// ---------------------------------------------------------------------------

let sweeping = false;
async function sweep() {
  if (sweeping) return { skipped: "busy" };
  sweeping = true;
  const notes = [];
  try {
    for (const link of await links()) {
      try {
        const s = await scanSales(link);
        if (s.recorded) notes.push(link.region + ": " + s.recorded + " sale(s)");
      } catch (e) {
        notes.push(link.region + ": sale scan failed (" + ((e && e.message) || e) + ")");
      }
      try {
        const c = await confirmLoading(link);
        if (c) notes.push(link.region + ": " + c + " confirmed in stock");
      } catch (e) {
        notes.push(link.region + ": stock check failed (" + ((e && e.message) || e) + ")");
      }
    }
  } finally {
    sweeping = false;
    await SteamSalesState.updateOne(
      { _id: "main" },
      { $set: { g2gLastSweepAt: new Date(), g2gLastSweepNote: notes.join(" | ").slice(0, 900) } },
      { upsert: true },
    ).catch(() => {});
  }
  return { notes };
}

let timer = null;
function start() {
  if (timer) return;
  const run = async () => {
    try {
      const r = await sweep();
      if (r && r.notes && r.notes.length) console.log("[steamG2g] sweep:", r.notes.join("; "));
    } catch (e) {
      console.error("[steamG2g] sweep error:", (e && e.message) || e);
    }
    timer = setTimeout(run, SWEEP_MS);
    if (timer.unref) timer.unref();
  };
  timer = setTimeout(run, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}

// For the page.
async function panelView() {
  const list = await links();
  const counts = await SteamG2gUnit.aggregate([{ $group: { _id: { offerId: "$offerId", state: "$state" }, n: { $sum: 1 } } }]);
  const by = (offerId, state) => (counts.find((c) => c._id.offerId === offerId && c._id.state === state) || {}).n || 0;
  return list.map((l) => ({
    offerId: l.offerId,
    region: l.region,
    regionName: S.regionName(l.region),
    title: l.title,
    priceUsd: l.priceUsd,
    enabled: l.enabled !== false,
    url: "https://www.g2g.com/offer/" + l.offerId,
    listed: by(l.offerId, "listed"),
    loading: by(l.offerId, "loading"),
    sold: by(l.offerId, "sold"),
    lastStock: l.lastStock,
    lastSaleScanAt: l.lastSaleScanAt,
    lastError: l.lastError || "",
  }));
}

// Unsold accounts in each region's G2G stock (for the distributor).
async function stockByRegion() {
  const rows = await SteamG2gUnit.aggregate([
    { $match: { state: { $in: ["loading", "listed"] } } },
    { $group: { _id: "$region", n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

async function isLiveUnit(steamAccountId) {
  return !!(await SteamG2gUnit.exists({ steamAccountId, state: { $in: ["loading", "listed"] } }));
}

module.exports = {
  SERVICE,
  BRAND,
  RELATION,
  GAMES_OWNED,
  links,
  linkFor,
  linkForRegion,
  createRegionOffer,
  loadAccounts,
  scanSales,
  confirmLoading,
  deliverOrder,
  sweep,
  start,
  stop,
  panelView,
  stockByRegion,
  isLiveUnit,
  _setDeps(over) {
    Object.assign(deps, over || {});
    templateCache.at = 0;
    templateCache.value = null;
    paged.clear();
  },
  _internal: { titleFor, descriptionFor, noteText, saleIdFor, orderPlacedAt },
};
