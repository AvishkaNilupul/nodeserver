// ---------------------------------------------------------------------------
// No-claim Shop listings — the ROW lifecycle
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §4).
//
// A listing the owner builds on Listings → Shop listings from No-claim farm
// items (DropSet.stockSource "noclaim") sells whole farm accounts with their
// drops still UNCLAIMED. utils/noclaimStock.js is the one claim layer — which
// account may be sold, and the ledger state that says so. This module owns the
// MarketplaceListing rows those accounts sit on:
//   * publishNoclaim — the per-market publish the route delegates to. Vault
//     markets (Gameflip, GGSel, Plati) get their accounts at publish time;
//     claim-at-sale markets (Eldorado, PlayerAuctions, G2G) advertise the free
//     stock and their fulfillers claim an account when a paid order lands.
//   * the delist and Gameflip hooks that settle, sell or release a row's units;
//   * removeUnit / removeForPoolAccount — taking one account off sale;
//   * runPass — the periodic pass: post-sale bookkeeping, quantity sales,
//     manual-sold removal, conflicts, unit health and top-up.
//
// The rule every path here keeps: an account whose credential may still be in
// a marketplace vault, or may already be with a buyer, is NEVER handed back to
// stock. A release only follows a removal the platform confirmed; when that
// cannot be proven the account stays committed — a unit of stock lost at worst
// — rather than risk selling one account to two buyers.
// ---------------------------------------------------------------------------
const fsp = require("fs/promises");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const DropSet = require("../models/DropSet");
const AvailableAccount = require("../models/AvailableAccount");
const mp = require("./marketplaces");
const settings = require("./settings");
const { logEvent } = require("./systemLog");
const ncs = require("./noclaimStock");
const noclaimHoldings = require("./noclaimHoldings");
const { digisellerDeliveryCode } = require("./digisellerFulfiller");
const { ggselDeliveryCode } = require("./ggselFulfiller");

// Required lazily. gameflipFulfiller calls back into this module from its sold
// and retire paths, unclaimedAutoList from its manual-sold tick, and the engine
// drags half the codebase in at load — none of which the publish route needs
// just to require this file.
let _gf;
function gf() {
  if (!_gf) _gf = require("./gameflipFulfiller");
  return _gf;
}
let _ual;
function ual() {
  if (!_ual) _ual = require("./unclaimedAutoList");
  return _ual;
}

// GGSel / Plati sell out of a stock pile; Gameflip is one account per listing.
const QTY_MARKETS = ["ggsel", "digiseller"];
// Digiseller's content-add only commits the first ~17 lines of a big batch
// (verified live, see unclaimedAutoList.publishDigisellerProduct), so units go
// in chunks of 12 and every contentId is recorded in order — the only handle
// that can ever delete one unit again.
const DS_CHUNK = 12;
const TOPUP_MAX_PER_ROW = 5;
// Unit health: this many short reads, spanning at least this long, before an
// account whose drops look gone is taken off sale. One empty read is far more
// often a transient Twitch/Pi failure than a real expiry.
const STRIKES_TO_EXPIRE = 2;
const STRIKE_GAP_MS = 20 * 60 * 1000;
const HEALTH_CONCURRENCY = 2;
const FIRST_PASS_MS = 90 * 1000;
// lastError prefix of a delisted quantity row whose units were kept committed
// because the platform's stock could not be read (see releaseDownRow).
const HOLD_PREFIX = "no-claim hold: ";
// Ledger note prefix of an account whose credential sits in an offer we could
// not record (the platform took the publish, our row did not save). No path
// here ever releases such a ledger: only the owner, after delisting by hand.
const UNRECORDED_PREFIX = "unrecorded publish — ";
// A "manual" ledger still unattached this long after its claim belongs to a
// publish that never finished (a crash or throw between claimForSet and
// attachListing) — nothing is still publishing it.
const ORPHAN_AFTER_MS = 30 * 60 * 1000;

let running = false;
let lastPass = null;
let timer = null;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The kill switches (contract §0). Fail CLOSED: an unreadable accessor means
// no publishing and no pass — the safe way to be wrong next to live markets.
function shopSettings() {
  try {
    const s = settings.getNoclaimShopSettings();
    if (s && typeof s === "object") return s;
  } catch (e) {
    console.error("noclaimListings: no-claim shop settings unreadable:", e && e.message);
  }
  return {
    enabled: false,
    autoDeliver: false,
    topUp: false,
    healthPerPass: 0,
    passEveryMin: 10,
    sweepPerTick: 30,
  };
}

function lower(s) {
  return String(s || "").trim().toLowerCase();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function marketLabel(market) {
  return (ncs.MARKET_LABELS && ncs.MARKET_LABELS[market]) || market;
}

// Pool ids come from AvailableAccount._id; anything else would make an $in
// over _id throw a CastError and take the whole step down with it.
function isObjectIdLike(id) {
  return /^[a-f0-9]{24}$/i.test(String(id || ""));
}

function ms(d) {
  const t = d ? new Date(d).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

// A plain copy of one units[] entry, built field by field: spreading a
// Mongoose sub-document copies its internals, not its fields, and the delist
// route hands us a live document.
function plainUnit(u) {
  return {
    contentId: String((u && u.contentId) || ""),
    accountId: String((u && u.accountId) || ""),
    login: String((u && u.login) || ""),
    addedAt: (u && u.addedAt) || null,
    deliveredAt: (u && u.deliveredAt) || null,
    orderId: String((u && u.orderId) || ""),
  };
}

// The units still waiting for a buyer, oldest first — the FIFO order every
// quantity-sale attribution uses (stable when addedAt ties or is missing).
function undeliveredUnits(row) {
  return ((row && row.units) || [])
    .map(plainUnit)
    .filter((u) => u.login && !u.deliveredAt)
    .sort((a, b) => ms(a.addedAt) - ms(b.addedAt));
}

async function freshRow(row) {
  if (!row || !row._id) return null;
  return MarketplaceListing.findById(row._id).lean().catch(() => null);
}

// The no-claim ledger per lowercased login. There is one per account by
// construction (noclaimStock deletes a racing duplicate); should two ever
// exist, the one a listing can act on — "manual", then "sold" — wins.
async function ledgersForLogins(logins) {
  const keys = [...new Set((logins || []).map(lower).filter(Boolean))];
  const map = new Map();
  if (!keys.length) return map;
  const rows = await UnclaimedAccount.find({
    source: "noclaim",
    loginLower: { $in: keys },
  }).lean();
  const rank = (l) => (l.status === "manual" ? 0 : l.status === "sold" ? 1 : 2);
  for (const l of rows) {
    const k = lower(l.loginLower || l.login);
    const cur = map.get(k);
    if (!cur || rank(l) < rank(cur)) map.set(k, l);
  }
  return map;
}

// The ledgers (a ledgersForLogins map) committed to THIS row: "manual" and
// pointing at it, at nothing yet — a claim whose publish had not attached; the
// login sitting on the row is what ties it here, since a claim refuses any
// login already on an active listing — or at a row that is no longer active (a
// rebuild or publish whose attachListing did not land). A pointer at another
// ACTIVE row is someone else's commitment and never ours, and when that cannot
// be checked only an exact match counts.
async function ownedLedgers(ledgers, rowId, { strict = false } = {}) {
  const id = String(rowId);
  const manual = [...ledgers.values()].filter((l) => l && l.status === "manual");
  const ptrs = [
    ...new Set(manual.map((l) => String(l.manualListing || "")).filter((p) => p && p !== id)),
  ];
  let active = null;
  if (!ptrs.length) {
    active = new Set();
  } else {
    try {
      const rows = await MarketplaceListing.find(
        { _id: { $in: ptrs }, status: "active" },
        { _id: 1 },
      ).lean();
      active = new Set(rows.map((r) => String(r._id)));
    } catch {
      active = null;
    }
  }
  const owned = new Map();
  for (const [k, l] of ledgers) {
    if (!l || l.status !== "manual" || isUnrecorded(l)) continue;
    const p = String(l.manualListing || "");
    // strict: only an exact pointer. An empty or stale pointer proves
    // ownership only while the row was live — once it is off sale its logins
    // no longer block new claims, so another publish may hold that ledger now.
    if (strict ? p === id : !p || p === id || (active && !active.has(p))) owned.set(k, l);
  }
  return owned;
}

function isUnrecorded(ledger) {
  return String((ledger && ledger.note) || "").startsWith(UNRECORDED_PREFIX);
}

// Pin claims whose credentials went into an offer no row of ours records, so
// that neither a delist nor the orphan sweep can ever hand them back.
async function markUnrecorded(ids, market, externalId) {
  const list = (ids || []).filter(Boolean).map(String);
  if (!list.length) return;
  await UnclaimedAccount.updateMany(
    { _id: { $in: list }, status: "manual" },
    {
      $set: {
        note:
          UNRECORDED_PREFIX + marketLabel(market) + " " + String(externalId || "?") +
          " holds this account but no listing row records it — delist it by hand, then release",
      },
    },
  ).catch((e) =>
    console.error("noclaimListings: could not pin " + list.length + " unrecorded claim(s):", e.message),
  );
}

async function releaseIds(ids, reason) {
  const list = (ids || []).filter(Boolean).map(String);
  if (!list.length) return 0;
  try {
    return Number(await ncs.releaseClaim(list, { reason })) || 0;
  } catch (e) {
    console.error("noclaimListings: release failed (" + reason + "):", e.message);
    return 0;
  }
}

async function markSoldIds(ids, opts) {
  const list = (ids || []).filter(Boolean).map(String);
  if (!list.length) return 0;
  try {
    return Number(await ncs.markSold(list, opts)) || 0;
  } catch (e) {
    console.error("noclaimListings: markSold failed:", e.message);
    return 0;
  }
}

async function attachIds(ids, listingId) {
  const list = (ids || []).filter(Boolean).map(String);
  if (!list.length) return 0;
  try {
    return Number(await ncs.attachListing(list, String(listingId))) || 0;
  } catch (e) {
    // The ledgers stay "manual" with manualListing "" — still committed, and
    // the conflict step re-attaches them on the next pass.
    console.error("noclaimListings: attachListing failed:", e.message);
    return 0;
  }
}

async function readStock(market, externalId) {
  try {
    let s = null;
    if (market === "digiseller") s = await mp.digisellerProductStock(externalId);
    else if (market === "ggsel") s = await mp.ggselOfferStock(externalId);
    if (s == null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function mapLimit(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

// Did a failed vault write possibly land? A 4xx is the platform saying no, and
// an error raised before any request (missing keys, nothing to send) never
// reached it. A 5xx, a timeout or a dropped connection may have been applied —
// GGSel answers 504 for writes it went on to apply — so those count as "maybe
// in the vault": treating the credential as fed costs a unit of stock at
// worst, where handing it back could sell the account twice.
function writeMaybeLanded(e) {
  const st = Number(e && e.status) || 0;
  if (st >= 400 && st < 500) return false;
  if (st >= 500) return true;
  return /timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up|network/i.test(
    String((e && e.message) || ""),
  );
}

// Rows the DELETE route is taking down right now: row id -> { at, wasActive }.
// beforeDelist sets it, afterDelist clears it. While set, nothing else may add
// stock to the row, rebuild it or replace its Gameflip unit — the route's
// platform delist and its save run outside the row lock, and a top-up or a
// rebuild landing in that gap put a delisted offer back on sale (GGSel's
// finalize re-activates any paused offer that has stock). A TTL, because a
// refused delist never reaches afterDelist and the row is still live.
// `wasActive` is what afterDelist trusts to decide ownership.
const delisting = new Map();
const DELISTING_TTL_MS = 5 * 60 * 1000;

function delistingState(row) {
  const st = delisting.get(String((row && row._id) || ""));
  if (!st) return null;
  if (Date.now() - st.at >= DELISTING_TTL_MS) {
    delisting.delete(String(row._id));
    return null;
  }
  return st;
}

// One edit at a time per set+market. The pass, a delist click and the
// engine's manual-sold tick can all reach the same row, and GGSel's
// "delist + republish" rebuild run twice over one snapshot publishes two
// replacement offers (the engine's withSetMarketLock exists for exactly this).
// Keyed by set+market, not row id, so a rebuild's replacement row shares the
// lock with the row it replaces. In-process only, like the pass flag.
const rowLocks = new Map();
async function withRowLock(row, fn) {
  const key = String((row && row.set) || "") + ":" + String((row && row.marketplace) || "");
  const prev = rowLocks.get(key) || Promise.resolve();
  let release;
  const mine = prev.then(() => new Promise((r) => (release = r)));
  rowLocks.set(key, mine);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (rowLocks.get(key) === mine) rowLocks.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Vault feeding
// ---------------------------------------------------------------------------

// Take down an offer no row of ours records (a publish that failed half way).
// True only when the platform accepted it or says it is already off sale.
async function takeDownUnsaved(market, externalId) {
  try {
    if (market === "digiseller") await mp.digisellerDelist(externalId);
    else if (market === "ggsel") await mp.ggselDelist(externalId);
    else return false;
    return true;
  } catch (e) {
    return !!mp.delistOutcome((e && e.message) || String(e));
  }
}

// Feed claimed accounts to a Plati product in chunks. Returns
// { fed: [{ claim, contentId }], unfed: [claim], error }. A chunk whose write
// may have landed counts as fed (with no contentId when the platform named
// none); what was never sent is unfed and safe to hand back.
async function feedDigiseller(externalId, claims) {
  const fed = [];
  let next = 0;
  let error = "";
  while (next < claims.length) {
    const slice = claims.slice(next, next + DS_CHUNK);
    next += slice.length;
    let ids;
    try {
      const added = await mp.digisellerAddContent(
        externalId,
        slice.map((c) => digisellerDeliveryCode(c.login, c.password)),
      );
      ids = (added && added.contentIds) || [];
    } catch (e) {
      error = (e && e.message) || String(e);
      if (writeMaybeLanded(e)) {
        for (const c of slice) fed.push({ claim: c, contentId: "" });
      } else {
        next -= slice.length;
      }
      break;
    }
    slice.forEach((c, i) => fed.push({ claim: c, contentId: ids[i] ? String(ids[i]) : "" }));
    if (ids.length !== slice.length) {
      error =
        "digiseller content add returned " + ids.length + " ids for " + slice.length +
        " lines (product " + externalId + ")";
      break;
    }
  }
  return { fed, unfed: claims.slice(next), error };
}

async function feedGgsel(externalId, claims) {
  const all = claims.map((c) => ({ claim: c, contentId: "" }));
  try {
    await mp.ggselAddProducts(
      externalId,
      claims.map((c) => ggselDeliveryCode(c.login, c.password)),
    );
    return { fed: all, unfed: [], error: "" };
  } catch (e) {
    const error = (e && e.message) || String(e);
    return writeMaybeLanded(e)
      ? { fed: all, unfed: [], error }
      : { fed: [], unfed: claims.slice(), error };
  }
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

// The per-market result the publish route stores in results[name]:
// { success:true, id, externalId, url, note } or { success:false, message }.
// ctx = { set, body, title, description, priceUsd, gridImage, coverPath, cat, pubGame }.
async function publishNoclaim(name, ctx = {}) {
  const c = ctx || {};
  if (!shopSettings().enabled) {
    return { success: false, message: "No-claim listings are switched off" };
  }
  if (!ncs.deliveryEnabled()) {
    return { success: false, message: "No-claim auto-delivery is switched off" };
  }
  if (!ncs.SUPPORTED_MARKETS.includes(name)) {
    return { success: false, message: ncs.unsupportedMessage(name) };
  }
  if (!ncs.isNoclaimSet(c.set)) {
    return { success: false, message: "Not a no-claim listing — it has no no-claim stock to deliver" };
  }
  const p = {
    set: c.set,
    body: c.body || {},
    title: c.title,
    description: c.description,
    priceUsd: c.priceUsd,
    cover: c.gridImage || c.coverPath || "",
    cat: c.cat || {},
    pubGame: c.pubGame,
  };
  try {
    if (name === "gameflip") return await publishGameflip(p);
    if (QTY_MARKETS.includes(name)) return await publishVault(name, p);
    return await publishClaimAtSale(name, p);
  } catch (e) {
    console.error("no-claim publish to " + name + " failed:", e && e.message);
    return { success: false, message: (e && e.message) || String(e) };
  }
}

// Gameflip has no quantity: one live listing per account, relisted by the
// fulfiller after each sale until `qty` have sold. Its no-claim branch claims,
// publishes and releases on failure itself.
async function publishGameflip({ set, body, title, description, priceUsd, cover }) {
  const qty = Math.max(1, parseInt((body.gameflip || {}).qty, 10) || 1);
  let doc;
  try {
    doc = await gf().publishAutoDelivery({
      set,
      title,
      description,
      priceUsd,
      imagePath: cover,
      qtyRemaining: qty - 1,
      origin: "manual",
      noclaim: true,
    });
  } catch (e) {
    return { success: false, message: (e && e.message) || String(e) };
  }
  return {
    success: true,
    id: String(doc._id),
    externalId: doc.externalId,
    url: doc.url || "",
    note: "no-claim auto-delivery: 1 live, " + (qty - 1) + " queued",
  };
}

// GGSel / Plati: the accounts are claimed now and their credentials go into
// the platform's own vault, which hands one to each buyer.
async function publishVault(name, { set, body, title, description, priceUsd, cover, cat }) {
  const opts = (name === "ggsel" ? body.ggsel : body.digiseller) || {};
  const qty = Math.max(1, parseInt(opts.quantity, 10) || 1);
  const ggCategory = name === "ggsel" ? String(opts.categoryId || cat.categoryId || "") : "";
  const dsCategories = name === "digiseller" ? opts.categories || cat.categories : null;
  // Refused before the claim: a publish that cannot happen must not spend
  // live inventory reads and ledger commits first.
  if (name === "ggsel" && !ggCategory) {
    return { success: false, message: "Pick a GGSel category first" };
  }
  if (name === "digiseller" && !(Array.isArray(dsCategories) && dsCategories.length)) {
    return { success: false, message: "Pick a Plati catalog category first" };
  }
  const claimed = (await ncs.claimForSet(set, qty, { market: name, mode: "fed" })) || [];
  if (!claimed.length) {
    let stale = 0;
    try {
      stale = Math.max(0, Number((await ncs.stockForSet(set)).stale) || 0);
    } catch {
      stale = 0;
    }
    return {
      success: false,
      message:
        "Out of stock — no free no-claim account holds this whole bundle right now (" +
        stale + " stale snapshot(s) — try Refresh stock)",
    };
  }
  const ids = claimed.map((x) => x.ledgerId);
  let r;
  try {
    if (name === "ggsel") {
      r = await mp.ggselPublish({
        title,
        description,
        priceUsd,
        priceRub: opts.priceRub,
        categoryId: ggCategory,
        delivery: "auto",
        instructions: opts.instructions,
        coverImagePath: cover || undefined,
        products: claimed.map((x) => ggselDeliveryCode(x.login, x.password)),
      });
      await mp.ggselEnableAutoselling(r.externalId).catch(() => {});
    } else {
      r = await mp.digisellerPublish({ title, description, priceUsd, categories: dsCategories });
    }
  } catch (e) {
    await releaseIds(ids, name + " publish failed");
    return { success: false, message: (e && e.message) || String(e) };
  }
  let fed = claimed.map((x) => ({ claim: x, contentId: "" }));
  if (name === "digiseller") {
    const feed = await feedDigiseller(r.externalId, claimed);
    if (feed.error) {
      // The product must come down before any claim goes back; a half-fed
      // product left live would sell accounts that are back on the shelf.
      const down = await takeDownUnsaved("digiseller", r.externalId);
      if (down || !feed.fed.length) {
        await releaseIds(ids, "plati content upload failed");
        return { success: false, message: feed.error };
      }
      await releaseIds(feed.unfed.map((x) => x.ledgerId), "plati content upload failed");
      await markUnrecorded(feed.fed.map((f) => f.claim.ledgerId), "digiseller", r.externalId);
      console.error(
        "noclaimListings: plati product " + r.externalId + " is half-fed and could not be taken down: " +
          feed.fed.length + " account(s) kept committed",
      );
      logEvent({
        category: "noclaim_shop",
        action: "publish_orphan",
        actor: "noclaimListings",
        severity: "error",
        subject: "Plati " + r.externalId,
        count: feed.fed.length,
        detail:
          "content upload failed half way and the product could not be taken down — " +
          "delist it by hand (" + feed.error + ")",
      });
      return {
        success: false,
        message:
          "Plati product " + r.externalId + " got part of its stock before the upload failed and " +
          "could not be taken down — delist it by hand: " + r.externalId + " (" + feed.error + ")",
      };
    }
    fed = feed.fed;
    if (cover) {
      await mp.digisellerUploadImage(r.externalId, cover).catch((e) =>
        console.error("noclaim plati image upload failed:", e.message),
      );
    }
  }
  let row;
  try {
    row = await MarketplaceListing.create({
      marketplace: name,
      externalId: r.externalId,
      // GGSel rows only: the category the offer was filed under. GGSel cannot
      // drop a single product, so taking one unit off republishes the offer
      // (rebuildGgsel) and needs the owner's category back. The field is
      // FunPay's category node elsewhere; nothing reads it off a GGSel row.
      externalNode: ggCategory,
      url: r.url || "",
      title,
      description,
      price: r.price || priceUsd,
      status: "active",
      autoDeliver: false,
      qtyTarget: qty,
      qtyRemaining: 0,
      // The settle baseline is what we FED, never a read taken now: GGSel
      // attaches products in the background and can still answer 0 (or a
      // partial count) right after the publish, and a sale made before the
      // first settle would then vanish into the baseline — leaving FIFO one
      // unit behind for good, so a delist or rebuild hands a sold account back.
      // The guardian's rule (remaining + fed), for the same reason.
      lastStock: fed.length,
      note: "no-claim auto-delivery: " + claimed.length + " account(s)",
      ...ncs.rowFields(
        set,
        name,
        fed.map((f) => ({ login: f.claim.login, contentId: f.contentId })),
      ),
    });
  } catch (e) {
    await markUnrecorded(ids, name, r.externalId);
    return orphanedPublish(name, r.externalId, e, claimed.length);
  }
  await attachIds(ids, String(row._id));
  if (name === "ggsel") {
    try {
      await ual().finalizeGgselOffer(r.externalId, row._id);
    } catch (e) {
      console.error("noclaimListings ggsel finalize failed:", e.message);
    }
  }
  return {
    success: true,
    id: String(row._id),
    externalId: r.externalId,
    url: r.url || "",
    note: (r.note ? r.note + " " : "") + row.note,
  };
}

// The platform has the offer but we could not record it. Nothing is released:
// on a vault market the credentials are live inside it, and on a claim-at-sale
// market an order against it would reach no row — either way the owner must
// take it down by hand, so say so as loudly as possible.
function orphanedPublish(name, rawId, err, accounts) {
  const msg = (err && err.message) || String(err);
  const externalId = String(rawId || "(the platform returned no id)");
  console.error(
    "noclaimListings: " + name + " offer " + externalId +
      " is LIVE but its row could not be saved: " + msg,
  );
  logEvent({
    category: "noclaim_shop",
    action: "publish_orphan",
    actor: "noclaimListings",
    severity: "error",
    subject: marketLabel(name) + " " + externalId,
    count: accounts || 0,
    detail: "published but the listing row could not be saved — delist it by hand (" + msg + ")",
  });
  return {
    success: false,
    message:
      "published on " + marketLabel(name) + " but the row could not be saved — delist it by hand: " +
      externalId,
  };
}

// Eldorado / PlayerAuctions / G2G: nothing is claimed now. The offer
// advertises what the farm can really hand over (capped), and the market's
// fulfiller claims one account per unit when a paid order lands.
async function publishClaimAtSale(
  name,
  { set, body, title, description, priceUsd, cover, cat, pubGame },
) {
  const st = await ncs.stockForSet(set);
  const free = Math.max(0, Math.floor(Number(st && st.free) || 0));
  if (!free) {
    return {
      success: false,
      message: "Out of stock — no free no-claim account holds this whole bundle right now",
    };
  }
  const raw =
    name === "eldorado"
      ? (body.eldorado || {}).quantity
      : name === "playerauctions"
        ? (body.playerauctions || {}).quantity
        : (body.g2g || {}).qty;
  const requested = Math.max(1, parseInt(raw, 10) || 1);
  // This offer's SHARE of the free stock, counting itself as one more sharer
  // (the same split every stock sync applies): advertising min(requested,
  // free) while the set's other claim-at-sale offers already advertise their
  // shares would put more units on sale than exist until the next sync, and a
  // paid order past the real stock comes up short.
  let share = 0;
  try {
    share = Math.max(
      0,
      Math.floor(
        Number(
          await ncs.stockForListing({ noclaimStock: true, marketplace: name, set: set._id }),
        ) || 0,
      ),
    );
  } catch (e) {
    return { success: false, message: "Could not count the no-claim stock right now: " + e.message };
  }
  if (!share) {
    return {
      success: false,
      message:
        "All " + free + " free account(s) for this bundle are already advertised by your other " +
        "no-claim listings — delist one first, or wait for more stock",
    };
  }
  const quantity = Math.max(1, Math.min(requested, share, ncs.ADVERTISE_MAX));
  // A minimum order above what is advertised would be refused (or unsellable)
  // once the quantity is capped to the free stock.
  const minOf = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.min(quantity, Math.max(1, n)) : undefined;
  };
  let r;
  let externalId;
  let price = priceUsd;
  if (name === "eldorado") {
    const el = body.eldorado || {};
    r = await mp.eldoradoPublish({
      title,
      description,
      priceUsd,
      quantity,
      minQuantity: minOf(el.minQuantity),
      game: el.game || pubGame,
      coverImagePath: cover,
      deliveryTime: el.deliveryTime,
      volumeDiscounts: el.volumeDiscounts,
    });
    externalId = r.externalId;
    price = r.price || priceUsd;
  } else if (name === "playerauctions") {
    const pa = body.playerauctions || {};
    price = Math.max(mp.PA_MIN_PRICE, Number(priceUsd) || 0);
    r = await mp.playerauctionsPublish({
      game: pa.game || pubGame,
      title,
      description,
      instruction: pa.instruction || require("./playerauctionsCopy").bundleInstruction(),
      priceUsd: price,
      itemsPerUnit: (set.items || []).length || 1,
      totalUnit: quantity,
      minUnitPerOrder: 1,
      deliveryGuarantee: mp.PA_DELIVERY.min20,
      coverImagePath: cover,
    });
    // playerauctionsPublish answers { offerId, id, url } — no externalId.
    externalId = r.offerId;
  } else {
    const g = body.g2g || {};
    // Same all-or-nothing rule as the route: the owner's own pick supplies
    // service, brand, product and attributes together, or none of them do.
    const picked = !!g.brandId;
    r = await mp.g2gPublish({
      serviceId: picked ? g.serviceId : cat.serviceId,
      brandId: picked ? g.brandId : cat.brandId,
      productId: picked ? g.productId : undefined,
      title,
      description,
      priceUsd,
      qty: quantity,
      minQty: minOf(g.minQty),
      currency: g.currency,
      offerAttributes: picked ? g.offerAttributes : undefined,
      deliveryMethodIds: picked ? g.deliveryMethodIds : undefined,
    });
    externalId = r.externalId;
    price = r.price || priceUsd;
  }
  let row;
  try {
    row = await MarketplaceListing.create({
      marketplace: name,
      externalId: String(externalId || ""),
      url: r.url || "",
      title,
      description,
      price,
      status: "active",
      qtyTarget: quantity,
      autoDeliver: false,
      note:
        (r.note ? r.note + " " : "") +
        "no-claim auto-delivery: an account is claimed when an order lands (" + quantity +
        " advertised)",
      ...ncs.rowFields(set, name, []),
    });
  } catch (e) {
    return orphanedPublish(name, externalId, e, 0);
  }
  return {
    success: true,
    id: String(row._id),
    externalId: String(externalId),
    url: r.url || "",
    note: row.note,
  };
}

// ---------------------------------------------------------------------------
// Quantity sales (GGSel / Plati)
// ---------------------------------------------------------------------------

// Plati and GGSel hand units out of the pile themselves and never say which;
// the pile is just smaller than we left it. Each unit of the drop is
// attributed FIFO — the oldest undelivered unit — exactly like the engine's
// quantity-sale detection. Returns { sold, read }; `read` is false when the
// stock could not be read, which is different from "nothing sold".
async function settleCore(row) {
  const cur = await freshRow(row);
  if (!cur || !cur.noclaimStock || !QTY_MARKETS.includes(cur.marketplace)) {
    return { sold: 0, read: false };
  }
  const stock = await readStock(cur.marketplace, cur.externalId);
  if (stock == null) return { sold: 0, read: false };
  const prev = cur.lastStock == null ? null : Number(cur.lastStock);
  // No baseline recorded (a write that failed): what our books say is still
  // in the vault is the right one. Adopting today's read instead would swallow
  // every sale since the last settle.
  const last = prev == null || !Number.isFinite(prev) ? undeliveredUnits(cur).length : prev;
  const dropped = last - stock;
  // Compare-and-set on the baseline: of two settlers that read the same drop
  // (the pass and a delist, or two processes) only the one that moves
  // lastStock attributes it, so no sale is counted twice.
  const w = await MarketplaceListing.updateOne(
    { _id: cur._id, lastStock: cur.lastStock == null ? null : cur.lastStock },
    { $set: { lastStock: stock } },
  ).catch(() => null);
  if (dropped <= 0 || !w || !w.modifiedCount) return { sold: 0, read: true };
  const now = new Date();
  let sold = 0;
  for (const u of undeliveredUnits(cur)) {
    if (sold >= dropped) break;
    // The stamp is the claim on the victim: only a unit still undelivered in
    // the database can be the one this drop sold.
    const s = await MarketplaceListing.updateOne(
      { _id: cur._id, units: { $elemMatch: { login: u.login, deliveredAt: null } } },
      { $set: { "units.$.deliveredAt": now, "units.$.orderId": "qty-sale" } },
    ).catch(() => null);
    if (!s || !s.modifiedCount) continue;
    sold++;
    const ledger = (await ledgersForLogins([u.login])).get(lower(u.login));
    if (ledger) {
      await markSoldIds([ledger._id], {
        market: cur.marketplace,
        priceUsd: Number(cur.price) || 0,
        reason: cur.marketplace + " sale",
      });
    } else {
      console.error(
        "noclaimListings: sold unit " + u.login + " on " + cur.externalId + " has no ledger",
      );
    }
  }
  if (sold < dropped) {
    console.error(
      "noclaimListings: " + cur.marketplace + " " + cur.externalId + " stock fell by " + dropped +
        " but only " + sold + " unit(s) were on the books",
    );
  }
  return { sold, read: true };
}

async function settleQuantitySales(row) {
  if (!row || !row._id) return 0;
  const r = await withRowLock(row, () => settleCore(row));
  return r.sold;
}

// ---------------------------------------------------------------------------
// Delist + Gameflip hooks
// ---------------------------------------------------------------------------

// When beforeDelist last READ the platform's stock, per row id, so the
// matching afterDelist knows whether the pre-delist settle can be trusted. A
// read older than this is not "just before the delist" any more.
const preDelistReads = new Map();
const PRE_DELIST_TRUST_MS = 10 * 60 * 1000;

async function beforeDelist(row) {
  if (!row || !row._id || !row.noclaimStock) return { sold: 0 };
  delisting.set(String(row._id), { at: Date.now(), wasActive: row.status === "active" });
  if (!QTY_MARKETS.includes(row.marketplace)) return { sold: 0 };
  try {
    const r = await withRowLock(row, () => settleCore(row));
    if (r.read) preDelistReads.set(String(row._id), Date.now());
    else preDelistReads.delete(String(row._id));
    return { sold: r.sold };
  } catch (e) {
    console.error("noclaimListings beforeDelist settle failed:", e && e.message);
    return { sold: 0 };
  }
}

// A vault row that is off sale for good: hand its undelivered units back.
// Quantity rows are settled once more first — a paused GGSel offer and a
// disabled Plati product still report their stock, and this closes the window
// between beforeDelist and the platform delist. When the stock could not be
// read before OR after, a unit sold since the last settle looks exactly like
// an unsold one, so the units are HELD (lastError says why) and the pass
// retries the release once the platform answers.
async function releaseDownRow(row, { readBefore = false, strict = false } = {}) {
  let cur = row;
  let sold = 0;
  if (QTY_MARKETS.includes(cur.marketplace)) {
    const s = await settleCore(cur);
    sold = s.sold;
    cur = (await freshRow(cur)) || cur;
    if (!s.read && !readBefore) {
      const held = undeliveredUnits(cur).length;
      if (held) {
        await MarketplaceListing.updateOne(
          { _id: cur._id },
          {
            $set: {
              lastError:
                HOLD_PREFIX + held + " account(s) kept committed — " + marketLabel(cur.marketplace) +
                " stock could not be read to tell sold units from unsold; the no-claim pass releases " +
                "them once it can",
            },
          },
        ).catch(() => {});
      }
      return { released: 0, sold, held };
    }
  }
  const pending = undeliveredUnits(cur);
  let released = 0;
  if (pending.length) {
    const owned = await ownedLedgers(
      await ledgersForLogins(pending.map((u) => u.login)),
      cur._id,
      { strict },
    );
    const ids = pending.map((u) => owned.get(lower(u.login))).filter(Boolean).map((l) => l._id);
    released = await releaseIds(ids, "listing delisted");
  }
  if (String(cur.lastError || "").startsWith(HOLD_PREFIX)) {
    await MarketplaceListing.updateOne({ _id: cur._id }, { $set: { lastError: "" } }).catch(() => {});
  }
  return { released, sold, held: 0 };
}

// Called by the delist route after the platform delist. `outcome` is the
// route's verdict: "sold" (the platform said it already sold), "gone", or ""
// (delisted). Returns { released, sold, held }.
async function afterDelist(row, { outcome = "" } = {}) {
  const out = { released: 0, sold: 0, held: 0 };
  if (!row || !row._id || !row.noclaimStock) return out;
  const readAt = preDelistReads.get(String(row._id)) || 0;
  const readBefore = Date.now() - readAt < PRE_DELIST_TRUST_MS;
  preDelistReads.delete(String(row._id));
  // Was the row live when the owner clicked Delist? Unknown (no beforeDelist)
  // or already off sale → only ledgers pointing exactly at this row are its.
  const st = delistingState(row);
  const strict = !(st && st.wasActive);
  try {
    await withRowLock(row, async () => {
      const cur = (await freshRow(row)) || row;
      if (outcome === "sold" && cur.marketplace === "gameflip") {
        // Gameflip's "sold" names the one account the listing carried.
        out.sold = (await onGameflipSold(cur, { priceUsd: cur.price })).sold;
      } else if (ncs.VAULT_MARKETS.includes(cur.marketplace)) {
        // On GGSel / Plati the stock count, not the delist call's wording, says
        // how many units sold, so every outcome settles and hands back the rest.
        // Claim-at-sale rows only ever carry delivered units — nothing to return.
        const r = await releaseDownRow(cur, { readBefore, strict });
        out.released = r.released;
        out.sold = r.sold;
        out.held = r.held;
      }
      logEvent({
        category: "noclaim_shop",
        action: "delisted",
        actor: "noclaimListings",
        subject: marketLabel(cur.marketplace) + " " + (cur.externalId || ""),
        subjectId: cur._id,
        count: out.released,
        detail:
          "no-claim listing delisted" + (outcome ? " (" + outcome + ")" : "") + ": " + out.released +
          " account(s) released, " + out.sold + " sold" + (out.held ? ", " + out.held + " held" : ""),
      });
    });
  } finally {
    delisting.delete(String(row._id));
  }
  return out;
}

// gameflipFulfiller's sold path: the listing's one account went to a buyer.
async function onGameflipSold(row, { priceUsd = 0 } = {}) {
  const out = { sold: 0 };
  if (!row || !row._id || !row.noclaimStock) return out;
  const cur = (await freshRow(row)) || row;
  // The live unit — or, on a retry after the stamp landed, the unit this very
  // sale already stamped, so a failed markSold is finished instead of skipped.
  const unit =
    undeliveredUnits(cur)[0] ||
    ((cur.units || []).map(plainUnit).find((u) => u.login && u.orderId === "gameflip-sale") || null);
  if (!unit) return out;
  const ledger = (await ledgersForLogins([unit.login])).get(lower(unit.login));
  // The ledger first: it is what every release decision reads, so a stamp that
  // then fails leaves a sold account that can never be handed back.
  if (ledger) {
    out.sold = await markSoldIds([ledger._id], {
      market: "gameflip",
      priceUsd: Number(priceUsd) || Number(cur.price) || 0,
      reason: "gameflip sale",
    });
  } else {
    console.error("noclaimListings: gameflip sale of " + unit.login + " has no ledger");
  }
  if (!unit.deliveredAt) {
    await MarketplaceListing.updateOne(
      { _id: cur._id, units: { $elemMatch: { login: unit.login, deliveredAt: null } } },
      { $set: { "units.$.deliveredAt": new Date(), "units.$.orderId": "gameflip-sale" } },
    ).catch((e) => console.error("noclaimListings gameflip sale stamp failed:", e.message));
  }
  return out;
}

// gameflipFulfiller's retire path (404 / expired / cancelled): the listing
// never sold, so its account goes back — "manual" only; a sold ledger is never
// released.
async function onGameflipRetired(row, { reason = "" } = {}) {
  const out = { released: 0 };
  if (!row || !row._id || !row.noclaimStock) return out;
  const cur = (await freshRow(row)) || row;
  const pending = undeliveredUnits(cur);
  if (!pending.length) return out;
  const owned = await ownedLedgers(await ledgersForLogins(pending.map((u) => u.login)), cur._id);
  const ids = pending.map((u) => owned.get(lower(u.login))).filter(Boolean).map((l) => l._id);
  out.released = await releaseIds(ids, reason || "gameflip listing retired");
  return out;
}

// ---------------------------------------------------------------------------
// Unit removal
// ---------------------------------------------------------------------------

// Take ONE undelivered unit off a vault row. Returns { ok, removed, error? }:
// ok:false means the account may still be on sale (nothing may be released);
// removed:false with ok:true means there was nothing of ours to take off. The
// removed unit's ledger is the CALLER's to decide (release / removed / sold).
async function removeUnit(row, login, { reason = "" } = {}) {
  if (!row || !row._id) return { ok: true, removed: false };
  return withRowLock(row, () => removeUnitLocked(row, login, String(reason || "")));
}

async function removeUnitLocked(row, login, reason) {
  const l = lower(login);
  if (!l) return { ok: true, removed: false };
  let cur = await freshRow(row);
  if (!cur || cur.status !== "active") return { ok: true, removed: false };
  // The owner is delisting this row right now: its delist settles and hands
  // back every unit itself, and a rebuild or replacement here would put it
  // back on sale. ok:false so no caller releases anything; the next pass
  // finds the row gone and acts on the ledger then.
  if (delistingState(cur)) return { ok: false, removed: false, error: "listing is being delisted" };
  if (cur.marketplace === "gameflip") return removeGameflipUnit(cur, l, reason);
  if (!QTY_MARKETS.includes(cur.marketplace)) return { ok: true, removed: false };
  // Settle first: a unit the platform already sold must be stamped sold
  // before anything decides it was not.
  await settleCore(cur).catch((e) =>
    console.error("noclaimListings pre-removal settle failed:", e.message),
  );
  cur = (await freshRow(cur)) || cur;
  if (cur.status !== "active") return { ok: true, removed: false };
  const pending = undeliveredUnits(cur);
  const unit = pending.find((u) => lower(u.login) === l);
  if (!unit) return { ok: true, removed: false };
  const keep = pending.filter((u) => u !== unit);
  if (cur.marketplace === "digiseller") return removeDigisellerUnit(cur, unit, keep, reason);
  if (!keep.length) {
    const d = await ual().delistRowVerified(cur, reason || "last unit removed");
    if (!d || !d.ok) return { ok: false, removed: false, error: (d && d.error) || "delist failed" };
    return { ok: true, removed: true };
  }
  return rebuildGgsel(cur, keep, reason);
}

// A Gameflip no-claim row IS its unit: take the listing down, then publish a
// successor so the chain still owes the same number of units (the removed one
// never sold). The successor claims a free account; the removed one is still
// "manual" at that point, so it can never be picked again.
async function removeGameflipUnit(cur, l, reason) {
  if (!undeliveredUnits(cur).some((u) => lower(u.login) === l)) return { ok: true, removed: false };
  // Only a listing Gameflip says is ON SALE is ours to take down. A sold one
  // belongs to the fulfiller's sold path; an unreadable status (Gameflip
  // rate-limits readily) proves nothing — and delistRowVerified would count a
  // "(sold)" refusal or any non-onsale status as "down", flip the row to
  // delisted where the sold path never looks again, and the caller would hand
  // back an account a buyer holds. So: unreadable or not onsale = not now.
  let before = "";
  try {
    before = String((await mp.gameflipListingStatus(cur.externalId)) || "");
  } catch (e) {
    return { ok: false, removed: false, error: "gameflip status unreadable: " + ((e && e.message) || e) };
  }
  if (before === "sold") return { ok: true, removed: false, sold: true };
  if (before !== "onsale") {
    return { ok: false, removed: false, error: "gameflip listing is " + (before || "unknown") + " — not taking it down now" };
  }
  const d = await ual().delistRowVerified(cur, reason);
  if (!d || !d.ok) return { ok: false, removed: false, error: (d && d.error) || "delist failed" };
  // Someone else took it down between our read and the delist; whoever did
  // owns the outcome (and its successor).
  if (!d.changed) return { ok: true, removed: false };
  // A sale that landed between the read and the delist: the delist answers
  // "(sold)" and the row now says delisted. Put the sale back on the books
  // (the sold path only watches active rows, so it would never see it) and
  // carry the chain on as a sale would.
  let after = "";
  try {
    after = String((await mp.gameflipListingStatus(cur.externalId)) || "");
  } catch {
    after = "";
  }
  if (after === "sold") {
    await MarketplaceListing.updateOne(
      { _id: cur._id, status: "delisted" },
      { $set: { status: "sold", lastError: "" } },
    ).catch(() => {});
    await onGameflipSold(cur, { priceUsd: cur.price });
    const owed = Math.max(0, (Number(cur.qtyRemaining) || 0) - 1);
    if (Number(cur.qtyRemaining) > 0) {
      await MarketplaceListing.updateOne({ _id: cur._id }, { $set: { qtyRemaining: owed } }).catch(() => {});
      try {
        await gf().relistNoclaimSuccessor({ ...cur, status: "sold", qtyRemaining: owed });
      } catch (e) {
        console.error("noclaimListings gameflip successor after a late sale failed:", e.message);
      }
    }
    return { ok: true, removed: false, sold: true };
  }
  let successor = null;
  try {
    successor = await gf().relistNoclaimSuccessor(cur);
  } catch (e) {
    console.error("noclaimListings gameflip successor failed for " + cur.externalId + ":", e.message);
  }
  return { ok: true, removed: true, successor: successor || null };
}

async function removeDigisellerUnit(cur, unit, keep, reason) {
  if (!unit.contentId) {
    return {
      ok: false,
      removed: false,
      error:
        "no Plati content id recorded for " + unit.login + " — pull it by hand from product " +
        cur.externalId,
    };
  }
  try {
    await mp.digisellerRemoveContent(cur.externalId, unit.contentId);
  } catch (e) {
    return { ok: false, removed: false, error: (e && e.message) || String(e) };
  }
  await MarketplaceListing.updateOne(
    { _id: cur._id },
    { $pull: { units: { login: unit.login, deliveredAt: null } } },
  ).catch((e) => console.error("noclaimListings unit pull failed:", e.message));
  // The deleted line leaves the platform's count too: fold it into the
  // baseline, or the next settle reads our own removal as a sale.
  await MarketplaceListing.updateOne(
    { _id: cur._id, lastStock: { $gt: 0 } },
    { $inc: { lastStock: -1 } },
  ).catch(() => {});
  if (!keep.length) {
    await ual()
      .delistRowVerified(cur, reason || "last unit removed")
      .catch((e) => console.error("noclaimListings plati delist failed:", e.message));
  }
  return { ok: true, removed: true };
}

async function ggselCategoryFor(row, set) {
  if (row && row.externalNode) return String(row.externalNode);
  const game =
    (set && (set.coverGame || (set.items && set.items[0] && set.items[0].game))) || "";
  let id = "";
  if (game) {
    try {
      id = String((await mp.ggselResolveCategoryId(game)) || "");
    } catch {
      id = "";
    }
  }
  if (!id) {
    try {
      id = String(settings.getAutoFarm().ggselCategoryId || "");
    } catch {
      id = "";
    }
  }
  return id;
}

// GGSel cannot delete one product, so removing a unit republishes the offer
// with the units that stay. The old offer comes down FIRST, and only the
// caller whose delist actually flipped it may publish the replacement — the
// engine's rebuild order. Publishing first would leave two live offers holding
// the same credentials whenever the old one then refused to come down.
async function rebuildGgsel(cur, keep, reason) {
  const set = await DropSet.findById(cur.set).lean().catch(() => null);
  const owned = await ownedLedgers(await ledgersForLogins(keep.map((u) => u.login)), cur._id);
  const usable = [];
  const orphaned = [];
  for (const u of keep) {
    const ledger = owned.get(lower(u.login));
    // Not committed to this row (a conflict): left out of the new offer, and
    // its ledger is not ours to touch.
    if (!ledger) continue;
    let cred = null;
    try {
      cred = await ual().credentialForLedger(ledger);
    } catch {
      cred = null;
    }
    if (cred && cred.password) {
      usable.push({ unit: u, ledger, login: cred.login || u.login, password: cred.password });
    } else {
      orphaned.push(ledger._id);
    }
  }
  // What the offer sells for NOW, in roubles: republishing from the USD price
  // at today's rate would quietly reprice an owner's manual listing.
  let priceRub = null;
  try {
    priceRub = await mp.ggselOfferPrice(cur.externalId);
  } catch {
    priceRub = null;
  }
  const categoryId = await ggselCategoryFor(cur, set);
  const down = await ual().delistRowVerified(
    cur,
    "rebuilt after unit removal" + (reason ? " — " + reason : ""),
  );
  if (!down || !down.ok) {
    return { ok: false, removed: false, error: (down && down.error) || "delist failed" };
  }
  if (!down.changed) return { ok: true, removed: false };
  // From here the old offer is paused: every credential left in it is off sale.
  if (orphaned.length) await releaseIds(orphaned, "ggsel rebuild — no password to republish");
  if (!usable.length) return { ok: true, removed: true };
  const fail = async (msg) => {
    await releaseIds(usable.map((x) => x.ledger._id), "ggsel rebuild failed");
    logEvent({
      category: "noclaim_shop",
      action: "rebuild_failed",
      actor: "noclaimListings",
      severity: "warn",
      subject: "GGSel " + cur.externalId,
      count: usable.length,
      detail:
        "no-claim GGSel offer could not be republished after a unit removal — its accounts " +
        "were released: " + msg,
    });
    return { ok: true, removed: true, error: "ggsel rebuild failed: " + msg };
  };
  if (!categoryId) return fail("no GGSel category to republish into");
  let img = "";
  if (set) {
    try {
      img = await require("./setImage").buildSetGridImage(set);
    } catch {
      img = "";
    }
  }
  let r;
  try {
    r = await mp.ggselPublish({
      title: cur.title || "",
      description: cur.description || "",
      priceUsd: Number(cur.price) || 0,
      priceRub: priceRub || undefined,
      categoryId,
      delivery: "auto",
      coverImagePath: img || undefined,
      products: usable.map((x) => ggselDeliveryCode(x.login, x.password)),
    });
  } catch (e) {
    if (img) await fsp.unlink(img).catch(() => {});
    return fail((e && e.message) || String(e));
  }
  if (img) await fsp.unlink(img).catch(() => {});
  await mp.ggselEnableAutoselling(r.externalId).catch(() => {});
  let fresh;
  try {
    fresh = await MarketplaceListing.create({
      set: cur.set,
      marketplace: "ggsel",
      externalId: r.externalId,
      externalNode: categoryId,
      url: r.url || "",
      title: cur.title || "",
      description: cur.description || "",
      price: Number(cur.price) || 0,
      status: "active",
      origin: cur.origin || "manual",
      noclaimStock: true,
      autoDeliver: false,
      accountId: "",
      accountLogin: "",
      requiredDrops: (cur.requiredDrops || []).map((d) => ({
        name: String((d && d.name) || ""),
        qty: Number(d && d.qty) || 1,
      })),
      qtyTarget: Number(cur.qtyTarget) || 0,
      qtyRemaining: 0,
      // Baseline = what was fed into the new offer (see publishVault).
      lastStock: usable.length,
      note: cur.note || "",
      // Original addedAt kept, so FIFO attribution survives the rebuild.
      units: usable.map((x) => ({
        contentId: "",
        accountId: "",
        login: x.unit.login,
        addedAt: x.unit.addedAt || new Date(),
        deliveredAt: null,
        orderId: "",
      })),
    });
  } catch (e) {
    await markUnrecorded(usable.map((x) => x.ledger._id), "ggsel", r.externalId);
    const o = orphanedPublish("ggsel", r.externalId, e, usable.length);
    return { ok: true, removed: true, error: o.message };
  }
  await attachIds(usable.map((x) => x.ledger._id), String(fresh._id));
  try {
    await ual().finalizeGgselOffer(r.externalId, fresh._id);
  } catch (e) {
    console.error("noclaimListings ggsel finalize failed:", e.message);
  }
  return { ok: true, removed: true, replacement: fresh };
}

// Every ACTIVE no-claim row with this login among its units (delivered or not).
async function activeRowsWithLogin(login) {
  const l = lower(login);
  if (!l) return [];
  return MarketplaceListing.find({
    noclaimStock: true,
    status: "active",
    "units.login": new RegExp("^" + escapeRe(l) + "$", "i"),
  }).lean();
}

// Every ACTIVE no-claim row still offering this login.
async function activeRowsCarrying(login) {
  const l = lower(login);
  return (await activeRowsWithLogin(l)).filter((r) =>
    undeliveredUnits(r).some((u) => lower(u.login) === l),
  );
}

// The owner ticked this pool account manual-sold: every account of it on a
// no-claim listing comes off sale, and its ledger becomes "removed" — NOT
// released (it was sold by hand; it keeps farming). A ledger whose removal
// failed stays "manual" so the next pass tries again.
async function removeForPoolAccount(poolAccountId, { actor = "" } = {}) {
  const out = { units: 0, rows: 0, ledgers: 0, errors: [] };
  const id = String(poolAccountId || "").trim();
  if (!id) return out;
  const ledgers = await UnclaimedAccount.find({
    source: "noclaim",
    status: "manual",
    poolAccountId: id,
  }).lean();
  const touched = new Set();
  for (const ledger of ledgers) {
    const login = ledger.login || ledger.loginLower || "";
    // A claim whose publish is still in flight has no row to take it off yet;
    // parking it "removed" now would let that publish go live with a sold
    // account. The pass's manual-sold step retries it once the row exists.
    if (
      !String(ledger.manualListing || "") &&
      Date.now() - ms(ledger.manualAt) < ORPHAN_AFTER_MS
    ) {
      out.deferred = (out.deferred || 0) + 1;
      continue;
    }
    try {
      let failed = "";
      for (const row of await activeRowsCarrying(login)) {
        const r = await removeUnit(row, login, { reason: "manual sold" });
        if (!r.ok) {
          failed = r.error || "removal failed";
          continue;
        }
        if (r.removed) {
          out.units++;
          touched.add(String(row._id));
        }
      }
      if (failed) {
        out.errors.push(login + ": " + failed);
        continue;
      }
      const w = await UnclaimedAccount.updateOne(
        { _id: ledger._id, status: "manual" },
        {
          $set: {
            status: "removed",
            // An unrecorded-offer pin keeps its "delist by hand" note.
            note: isUnrecorded(ledger) ? ledger.note : "manual sold — removed from manual listing",
            lastCheckedAt: new Date(),
          },
        },
      );
      if (!w || !w.modifiedCount) continue;
      out.ledgers++;
      try {
        await ual().markOwnerUnlisted(ledger);
      } catch (e) {
        console.error("noclaimListings markOwnerUnlisted failed:", e.message);
      }
      logEvent({
        category: "noclaim_shop",
        action: "manual_sold_removed",
        actor: actor || "noclaimListings",
        subject: login,
        game: ledger.game || "",
        count: 1,
        detail: "manual-sold account taken off its no-claim listing — kept farming",
      });
    } catch (e) {
      out.errors.push(login + ": " + ((e && e.message) || String(e)));
      console.error("noclaimListings manual-sold removal failed:", e && e.message);
    }
  }
  out.rows = touched.size;
  return out;
}

// ---------------------------------------------------------------------------
// Lifecycle pass
// ---------------------------------------------------------------------------

// Strike rule for unit health (pure): { expire, strikes, firstAt }.
function healthStrike(ledger, now = Date.now()) {
  const t = Number(now);
  const nowMs = Number.isFinite(t) ? t : Date.now();
  const prev = Math.max(0, Math.floor(Number(ledger && ledger.emptyReads) || 0));
  const strikes = prev + 1;
  let first = ledger && ledger.firstEmptyAt ? new Date(ledger.firstEmptyAt) : null;
  if (!first || Number.isNaN(first.getTime())) first = new Date(nowMs);
  return {
    expire: strikes >= STRIKES_TO_EXPIRE && nowMs - first.getTime() >= STRIKE_GAP_MS,
    strikes,
    firstAt: first,
  };
}

// login -> Set(active row ids) over EVERY active listing, with the same two
// fields utils/listedLogins reads (accountLogin tokens + units[].login).
async function loginRowIndex() {
  const rows = await MarketplaceListing.find(
    { status: "active" },
    { accountLogin: 1, "units.login": 1 },
  ).lean();
  const byLogin = new Map();
  const activeIds = new Set();
  const add = (login, id) => {
    const l = lower(login);
    if (!l) return;
    if (!byLogin.has(l)) byLogin.set(l, new Set());
    byLogin.get(l).add(id);
  };
  for (const r of rows) {
    const id = String(r._id);
    activeIds.add(id);
    for (const t of String(r.accountLogin || "").split(/[,\s]+/)) add(t, id);
    for (const u of r.units || []) add(u && u.login, id);
  }
  return { byLogin, activeIds };
}

async function activeVaultRows() {
  return MarketplaceListing.find({
    noclaimStock: true,
    status: "active",
    marketplace: { $in: ncs.VAULT_MARKETS },
  }).lean();
}

// Step "orphans": a "manual" ledger with no listing, claimed over 30 minutes
// ago, belongs to a publish that died between claimForSet and attachListing.
// If an active no-claim row carries the login, that row is its home. If none
// does, it is NEVER released here: whether the platform already holds the
// credential is exactly the thing nobody recorded (a crash mid-publish, a row
// save that failed after Gameflip accepted the listing), and handing it back
// could sell it twice. It is pinned as unrecorded and the owner is told — a
// held account costs one unit of stock, a double sale costs a buyer.
// "sold" is never touched.
async function orphansStep(tally, errors) {
  const ledgers = await UnclaimedAccount.find({
    source: "noclaim",
    status: "manual",
    manualListing: { $in: ["", null] },
    manualAt: { $lt: new Date(Date.now() - ORPHAN_AFTER_MS) },
  }).lean();
  for (const ledger of ledgers) {
    if (isUnrecorded(ledger)) continue;
    const login = ledger.login || ledger.loginLower || "";
    try {
      const l = lower(login);
      const rows = await activeRowsWithLogin(l);
      const home =
        rows.find((r) => undeliveredUnits(r).some((u) => lower(u.login) === l)) || rows[0];
      if (home) {
        if (await attachIds([ledger._id], String(home._id))) tally.attached++;
        continue;
      }
      await markUnrecorded([ledger._id], ledger.market, "(offer unknown)");
      tally.pinned = (tally.pinned || 0) + 1;
      logEvent({
        category: "noclaim_shop",
        action: "orphan_pinned",
        actor: "noclaimListings",
        severity: "error",
        subject: login,
        game: ledger.game || "",
        count: 1,
        detail:
          "a no-claim claim for " + marketLabel(ledger.market) + " never reached a listing row — " +
          "check " + marketLabel(ledger.market) + " for an offer carrying this account, delist it, " +
          "then release it (POST /noclaim-stock/ledgers/" + String(ledger._id) + "/release)",
      });
    } catch (e) {
      errors.push("orphan " + login + ": " + ((e && e.message) || String(e)));
    }
  }
}

// Step 4: an undelivered unit must be backed by a "manual" ledger committed to
// its row, and its login must be on no other active listing. Anything else is
// taken off this row; only a ledger that was ours is then released. Stale
// pointers are re-attached for the whole row BEFORE anything is removed, so a
// GGSel rebuild triggered by one conflict never drops a healthy unit whose
// pointer had simply not been fixed yet.
async function conflictsStep(tally, errors) {
  const vault = await activeVaultRows();
  if (!vault.length) return;
  const index = await loginRowIndex();
  const ledgers = await ledgersForLogins(
    vault.flatMap((r) => undeliveredUnits(r).map((u) => u.login)),
  );
  for (const row of vault) {
    const rowId = String(row._id);
    const conflicts = [];
    for (const u of undeliveredUnits(row)) {
      try {
        const l = lower(u.login);
        const ledger = ledgers.get(l);
        const elsewhere = [...(index.byLogin.get(l) || [])].some((id) => id !== rowId);
        const ptr = ledger ? String(ledger.manualListing || "") : "";
        // A pointer at a row that is no longer active is stale, not foreign:
        // a GGSel rebuild (or a publish) whose attachListing did not land.
        const ours =
          !!ledger &&
          ledger.status === "manual" &&
          !isUnrecorded(ledger) &&
          (!ptr || ptr === rowId || !index.activeIds.has(ptr));
        if (ours && !elsewhere) {
          if (ptr !== rowId && (await attachIds([ledger._id], rowId))) tally.reattached++;
          continue;
        }
        const why = !ledger
          ? "no ledger"
          : elsewhere
            ? "login on another active listing"
            : "ledger " + ledger.status + (ptr ? " for listing " + ptr : "");
        conflicts.push({ u, ledger, ours, why });
      } catch (e) {
        errors.push("conflict " + u.login + ": " + ((e && e.message) || String(e)));
      }
    }
    // A GGSel removal republishes the offer; later removals in this row must
    // act on the replacement, not on the row it replaced.
    let target = row;
    for (const { u, ledger, ours, why } of conflicts) {
      try {
        const r = await removeUnit(target, u.login, { reason: "conflict: " + why });
        if (r.replacement) target = r.replacement;
        if (!r.ok) {
          errors.push("conflict " + u.login + ": " + (r.error || "removal failed"));
          continue;
        }
        if (!r.removed) continue;
        tally.removed++;
        if (ours) await releaseIds([ledger._id], "conflict — " + why);
        logEvent({
          category: "noclaim_shop",
          action: "conflict_removed",
          actor: "noclaimListings",
          subject: u.login,
          count: 1,
          detail: marketLabel(row.marketplace) + " " + row.externalId + ": unit taken off (" + why + ")",
        });
      } catch (e) {
        errors.push("conflict " + u.login + ": " + ((e && e.message) || String(e)));
      }
    }
  }
}

// Step 5 for one committed account: one live read decides between still
// good, sold (a buyer claimed an advertised drop), or a strike toward expiry.
async function checkUnitHealth(ledger, row, set, tally, errors) {
  const now = new Date();
  const l = lower(ledger.login || ledger.loginLower);
  const mine = ((row.units || []).map(plainUnit)).filter((u) => lower(u.login) === l);
  const unit = mine.find((u) => !u.deliveredAt);
  if (!unit) {
    // Its unit already went to a buyer but the ledger missed the news (a
    // failed markSold) — finish it. Otherwise the row no longer carries it
    // and the conflict step owns it; just rotate it out of the queue.
    if (mine.some((u) => u.deliveredAt)) {
      tally.sold += await markSoldIds([ledger._id], {
        market: row.marketplace,
        priceUsd: Number(row.price) || 0,
        reason: row.marketplace + " sale",
      });
    } else {
      await UnclaimedAccount.updateOne(
        { _id: ledger._id, status: "manual" },
        { $set: { lastCheckedAt: now } },
      ).catch(() => {});
    }
    return;
  }
  const pool = isObjectIdLike(ledger.poolAccountId)
    ? await AvailableAccount.findById(ledger.poolAccountId, { clientSecret: 1 }).lean().catch(() => null)
    : null;
  let res = null;
  if (pool && pool.clientSecret) {
    try {
      res = await ual().inventoryForCandidate({
        source: "noclaim",
        login: ledger.login || "",
        clientSecret: pool.clientSecret,
        twitchId: ledger.twitchId || "",
        game: ledger.game || "",
        botId: ledger.botId || "",
        container: ledger.container || "",
      });
    } catch {
      res = null;
    }
  }
  if (!res) {
    // A failed read proves nothing either way: no strike, no sale, no
    // removal. Only the check time moves, so an account that cannot be read
    // goes to the back of the queue instead of eating the budget every pass.
    tally.failed++;
    await UnclaimedAccount.updateOne(
      { _id: ledger._id, status: "manual" },
      { $set: { lastCheckedAt: now } },
    ).catch(() => {});
    return;
  }
  tally.checked++;
  try {
    await noclaimHoldings.recordRead(l, {
      sellable: res.sellable || [],
      login: res.login || ledger.login,
    });
  } catch {
    /* the snapshot refresh is best-effort */
  }
  // Our farm never claims, so an advertised drop now claimed means someone
  // holding the credentials claimed it: the buyer. Matched by NAME, the wide
  // net — missing a claim would let the expiry path below hand back an
  // account a buyer holds.
  const names = new Set((set.items || []).map((i) => lower(i && i.name)).filter(Boolean));
  const claimedNow = ((res.inv && res.inv.inProgress) || []).some(
    (d) => d && d.claimed && names.has(lower(d.name)),
  );
  if (claimedNow) {
    tally.sold += await markSoldIds([ledger._id], {
      market: row.marketplace,
      priceUsd: Number(row.price) || 0,
      reason: "buyer claimed a listed drop",
    });
    await MarketplaceListing.updateOne(
      { _id: row._id, units: { $elemMatch: { login: unit.login, deliveredAt: null } } },
      { $set: { "units.$.deliveredAt": now, "units.$.orderId": "buyer-claimed" } },
    ).catch(() => {});
    logEvent({
      category: "noclaim_shop",
      action: "buyer_claimed",
      actor: "noclaimListings",
      subject: unit.login,
      game: ledger.game || "",
      count: 1,
      detail: "a listed drop was claimed — " + marketLabel(row.marketplace) + " unit counted sold",
    });
    return;
  }
  if (ncs.covers(ncs.heldCounts(res.sellable || []), ncs.requiredFromSet(set))) {
    tally.ok++;
    await UnclaimedAccount.updateOne(
      { _id: ledger._id, status: "manual" },
      { $set: { lastCheckedAt: now, emptyReads: 0, firstEmptyAt: null } },
    ).catch(() => {});
    return;
  }
  const strike = healthStrike(ledger, now.getTime());
  await UnclaimedAccount.updateOne(
    { _id: ledger._id, status: "manual" },
    { $set: { lastCheckedAt: now, emptyReads: strike.strikes, firstEmptyAt: strike.firstAt } },
  ).catch(() => {});
  if (!strike.expire) {
    tally.strikes++;
    return;
  }
  const r = await removeUnit(row, unit.login, { reason: "drops expired" });
  if (!r.ok) {
    errors.push("expire " + unit.login + ": " + (r.error || "removal failed"));
    return;
  }
  if (!r.removed) return;
  tally.expired++;
  await releaseIds([ledger._id], "drops expired");
  logEvent({
    category: "noclaim_shop",
    action: "expired",
    actor: "noclaimListings",
    subject: unit.login,
    game: ledger.game || "",
    count: 1,
    detail: "no longer holds the bundle — taken off " + marketLabel(row.marketplace) + " and released",
  });
}

async function healthStep(budget, tally, errors) {
  if (!budget) return;
  const vault = await activeVaultRows();
  if (!vault.length) return;
  const byId = new Map(vault.map((r) => [String(r._id), r]));
  const ledgers = await UnclaimedAccount.find({
    source: "noclaim",
    status: "manual",
    manualListing: { $in: [...byId.keys()] },
  })
    .sort({ lastCheckedAt: 1, _id: 1 })
    .limit(budget)
    .lean();
  const sets = new Map();
  await mapLimit(ledgers, HEALTH_CONCURRENCY, async (ledger) => {
    try {
      const row = byId.get(String(ledger.manualListing));
      if (!row) return;
      const key = String(row.set);
      if (!sets.has(key)) sets.set(key, DropSet.findById(row.set).lean().catch(() => null));
      const set = await sets.get(key);
      if (!set) return;
      await checkUnitHealth(ledger, row, set, tally, errors);
    } catch (e) {
      errors.push("health " + (ledger.login || ledger._id) + ": " + ((e && e.message) || String(e)));
    }
  });
}

// Step 6 for one row: refill a GGSel / Plati row back to its qtyTarget.
async function topUpRow(row) {
  return withRowLock(row, async () => {
    const cur = await freshRow(row);
    if (!cur || cur.status !== "active" || !cur.noclaimStock || !QTY_MARKETS.includes(cur.marketplace)) {
      return 0;
    }
    if (delistingState(cur)) return 0;
    const want = Math.min(
      TOPUP_MAX_PER_ROW,
      (Number(cur.qtyTarget) || 0) - undeliveredUnits(cur).length,
    );
    if (want <= 0) return 0;
    const set = await DropSet.findById(cur.set).lean().catch(() => null);
    if (!set || !ncs.isNoclaimSet(set)) return 0;
    const rowId = String(cur._id);
    const claimed =
      (await ncs.claimForSet(set, want, {
        market: cur.marketplace,
        listingId: rowId,
        mode: "fed",
      })) || [];
    if (!claimed.length) return 0;
    // The claim takes live reads; the owner may have delisted the row in the
    // meantime. Feeding (and finalizing) a row that is off sale would put a
    // paused offer back on sale with stock we then hand back.
    const still = await freshRow(cur);
    if (!still || still.status !== "active" || delistingState(cur)) {
      await releaseIds(claimed.map((x) => x.ledgerId), "top-up cancelled — listing went off sale");
      return 0;
    }
    let feed;
    if (cur.marketplace === "digiseller") {
      feed = await feedDigiseller(cur.externalId, claimed);
    } else {
      // Products attach only to an autoselling offer; a no-op when it is on.
      await mp.ggselEnableAutoselling(cur.externalId).catch(() => {});
      feed = await feedGgsel(cur.externalId, claimed);
    }
    if (feed.unfed.length) {
      await releaseIds(feed.unfed.map((x) => x.ledgerId), cur.marketplace + " top-up failed");
    }
    if (feed.error) {
      console.error(
        "noclaimListings top-up of " + cur.marketplace + " " + cur.externalId + ": " + feed.error,
      );
    }
    if (!feed.fed.length) return 0;
    const now = new Date();
    const units = feed.fed.map((f) => ({
      contentId: String(f.contentId || ""),
      accountId: "",
      login: f.claim.login,
      addedAt: now,
      deliveredAt: null,
      orderId: "",
    }));
    await MarketplaceListing.updateOne({ _id: cur._id }, { $push: { units: { $each: units } } });
    // Ours, not a buyer's: fold the fed units into the baseline so the next
    // settle measures sales from the topped-up level (the guardian's rule).
    await MarketplaceListing.updateOne(
      { _id: cur._id, lastStock: { $ne: null } },
      { $inc: { lastStock: units.length } },
    ).catch(() => {});
    await attachIds(feed.fed.map((f) => f.claim.ledgerId), rowId);
    // Finalize re-activates a paused offer that has stock — only ever on a row
    // that is still live.
    const live = await freshRow(cur);
    if (cur.marketplace === "ggsel" && live && live.status === "active" && !delistingState(cur)) {
      try {
        await ual().finalizeGgselOffer(cur.externalId, cur._id);
      } catch (e) {
        console.error("noclaimListings ggsel finalize failed:", e.message);
      }
    }
    return units.length;
  });
}

// The lifecycle pass. Each step is isolated: one failing never stops the
// steps after it. `sweep` also runs a holdings sweep at the end.
async function runPass({ sweep = false } = {}) {
  if (running) return { skipped: "running", lastPass };
  const cfg = shopSettings();
  if (!cfg.enabled) return { skipped: "disabled" };
  running = true;
  const startedAt = Date.now();
  const out = {
    spend: null,
    settled: 0,
    heldReleased: 0,
    manualSold: { units: 0, ledgers: 0 },
    orphans: { attached: 0, pinned: 0 },
    conflicts: { removed: 0, reattached: 0 },
    health: { checked: 0, ok: 0, sold: 0, strikes: 0, expired: 0, failed: 0 },
    toppedUp: 0,
    sweep: null,
    errors: [],
  };
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      out.errors.push(name + ": " + ((e && e.message) || String(e)));
      console.error("noclaimListings pass step " + name + " failed:", e && e.message);
    }
  };
  try {
    // 1. Post-sale bookkeeping (bot removal + pool stamps) for sold accounts.
    await step("spend", async () => {
      out.spend = await ncs.spendPending({ limit: 10 });
    });
    // 2. Quantity sales on every live GGSel / Plati row, then any delisted
    // row whose release was held because its stock could not be read.
    await step("settle", async () => {
      const rows = await MarketplaceListing.find({
        noclaimStock: true,
        status: "active",
        marketplace: { $in: QTY_MARKETS },
      }).lean();
      for (const row of rows) {
        try {
          out.settled += await settleQuantitySales(row);
        } catch (e) {
          out.errors.push("settle " + row.externalId + ": " + ((e && e.message) || String(e)));
        }
      }
      const held = await MarketplaceListing.find({
        noclaimStock: true,
        status: { $ne: "active" },
        marketplace: { $in: QTY_MARKETS },
        lastError: new RegExp("^" + escapeRe(HOLD_PREFIX)),
      }).lean();
      for (const row of held) {
        try {
          const r = await withRowLock(row, () => releaseDownRow(row, { readBefore: false }));
          out.heldReleased += r.released;
          out.settled += r.sold;
        } catch (e) {
          out.errors.push("held " + row.externalId + ": " + ((e && e.message) || String(e)));
        }
      }
    });
    // 3. Accounts the owner ticked manual-sold come off every listing.
    await step("manual-sold", async () => {
      const manual = await UnclaimedAccount.find(
        { source: "noclaim", status: "manual" },
        { poolAccountId: 1 },
      ).lean();
      const poolIds = [...new Set(manual.map((l) => String(l.poolAccountId || "")))].filter(
        isObjectIdLike,
      );
      if (!poolIds.length) return;
      const marked = await AvailableAccount.find(
        { _id: { $in: poolIds }, manualSold: true },
        { _id: 1 },
      ).lean();
      for (const p of marked) {
        const r = await removeForPoolAccount(String(p._id), { actor: "noclaimListings" });
        out.manualSold.units += r.units;
        out.manualSold.ledgers += r.ledgers;
        for (const e of r.errors) out.errors.push("manual-sold " + e);
      }
    });
    // Claims whose publish never finished: re-homed, or handed back.
    await step("orphans", () => orphansStep(out.orphans, out.errors));
    // 4. Units whose ledger or login disagrees with the row.
    await step("conflicts", () => conflictsStep(out.conflicts, out.errors));
    // 5. Live re-checks of committed vault units.
    const healthBudget = Math.max(0, Math.min(100, Math.floor(Number(cfg.healthPerPass) || 0)));
    await step("health", () => healthStep(healthBudget, out.health, out.errors));
    // 6. Refill GGSel / Plati rows back to their quantity.
    if (cfg.topUp) {
      await step("top-up", async () => {
        const rows = await MarketplaceListing.find({
          noclaimStock: true,
          status: "active",
          marketplace: { $in: QTY_MARKETS },
        }).lean();
        for (const row of rows) {
          if (undeliveredUnits(row).length >= (Number(row.qtyTarget) || 0)) continue;
          try {
            out.toppedUp += await topUpRow(row);
          } catch (e) {
            out.errors.push("top-up " + row.externalId + ": " + ((e && e.message) || String(e)));
          }
        }
      });
    }
    // 7. Gameflip chains whose successor failed are gameflipFulfiller's own
    // stalled-lane retry — nothing to do here.
    // 8. Optional holdings sweep.
    if (sweep) {
      await step("sweep", async () => {
        out.sweep = await noclaimHoldings.sweepOnce({ budget: cfg.sweepPerTick });
      });
    }
  } finally {
    running = false;
  }
  out.tookMs = Date.now() - startedAt;
  lastPass = { at: new Date(startedAt), ...out };
  return out;
}

function passEveryMs() {
  const m = Math.floor(Number(shopSettings().passEveryMin) || 10);
  return Math.min(120, Math.max(2, m)) * 60 * 1000;
}

function start() {
  if (timer) return;
  timer = true;
  try {
    noclaimHoldings.start();
  } catch (e) {
    console.error("noclaimListings: holdings sweep did not start:", e.message);
  }
  const schedule = (delay) => {
    const t = setTimeout(tick, delay);
    if (t.unref) t.unref();
  };
  const tick = async () => {
    try {
      await runPass();
    } catch (e) {
      console.error("noclaimListings pass error:", e && e.message);
    } finally {
      schedule(passEveryMs());
    }
  };
  schedule(FIRST_PASS_MS);
}

function status() {
  return { running, lastPass };
}

module.exports = {
  publishNoclaim,
  beforeDelist,
  afterDelist,
  onGameflipSold,
  onGameflipRetired,
  settleQuantitySales,
  removeUnit,
  removeForPoolAccount,
  runPass,
  start,
  status,
  // pure, exported for tests
  undeliveredUnits,
  healthStrike,
  writeMaybeLanded,
};
