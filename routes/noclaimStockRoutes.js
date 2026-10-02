// ---------------------------------------------------------------------------
// No-claim Shop listings API (superadmin) —
// docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §9.
//
// Backs the Listings page's "No-claim farm" picker: the holdings snapshot it
// browses (utils/noclaimHoldings), the owner's no-claim sets (a DropSet with
// stockSource "noclaim" — never sold by the Shop, never backed by the Drop
// Archive), their live stock (utils/noclaimStock) and a hand-run of the
// lifecycle pass (utils/noclaimListings).
//
// A thin layer on purpose: every claim, release and credential read lives in
// those modules. Nothing here claims an account, and no response carries a
// password, token or pool id — GET .../accounts whitelists its five fields.
// ---------------------------------------------------------------------------
const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const { logEvent, actorFromReq } = require("../utils/systemLog");
const settings = require("../utils/settings");
const engine = require("../utils/unclaimedAutoList");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const MarketResearch = require("../models/MarketResearch");

const router = express.Router();

// The feature's own modules are required lazily inside the handlers, the way
// accountListingRoutes.js does it: a missing or broken sibling then answers
// 503 on these endpoints instead of stopping the whole server from booting
// with live markets on sale.
const MODULES = {
  holdings: "../utils/noclaimHoldings",
  stock: "../utils/noclaimStock",
  listings: "../utils/noclaimListings",
};

function moduleUnavailable(res, name, err) {
  return res.status(503).json({
    success: false,
    code: "module_unavailable",
    module: name,
    message:
      name + " is not available: " + (err && err.message ? err.message : String(err)),
  });
}

// The background holding sweep only reads while the snapshot is wanted
// (utils/noclaimHoldings sweepWanted): any superadmin request to these routes
// says it is. Best-effort — a missing module or an older one without the hook
// never blocks a request.
router.use("/noclaim-stock", (req, _res, next) => {
  const admin = req.session && req.session.admin;
  if (admin && admin.role === "superadmin") {
    try {
      const h = require(MODULES.holdings);
      if (h && typeof h.noteInterest === "function") h.noteInterest();
    } catch {
      /* the handler answers 503 for a missing module itself */
    }
  }
  next();
});

// The module, or null after answering 503.
function dep(res, key) {
  try {
    return require(MODULES[key]);
  } catch (err) {
    moduleUnavailable(res, MODULES[key], err);
    return null;
  }
}

// settings.noclaimShop — a top-level block, read fresh on every request so one
// live settings edit takes effect without a restart. A read that throws counts
// as the defaults, like accountListingRoutes' switch: the publish and claim
// layers check the same switch themselves, and those are what stand between a
// buyer and an account, so a broken read must not also take the panel down.
function shopSettings() {
  try {
    const s = settings.getNoclaimShopSettings();
    return s && typeof s === "object" ? s : {};
  } catch {
    return {};
  }
}

// Writes only. Reads keep answering while the feature is off, so the page can
// still show what the farm holds and why nothing is being listed.
function requireEnabled(req, res, next) {
  if (shopSettings().enabled !== false) return next();
  return res.status(503).json({
    success: false,
    code: "noclaim_shop_disabled",
    message: "No-claim listings are switched off",
  });
}

// A no-claim bundle is ONE account holding every item, so a real set is a
// handful of items; the cap only stops a runaway request.
const MAX_ITEMS = 100;
const MAX_ACCOUNTS = 200;
const REFRESH_BUDGET_DEFAULT = 120;

function isId(v) {
  return /^[a-f0-9]{24}$/i.test(String(v || ""));
}
function num(v, d = 0) {
  const n = typeof v === "string" ? Number(v.trim()) : Number(v);
  return Number.isFinite(n) ? n : d;
}
function round2(n) {
  return Math.round(num(n, 0) * 100) / 100;
}
// Copies of one item: a whole number, at least 1.
function qtyOf(v) {
  const n = Math.floor(num(v, 1));
  return n >= 1 ? n : 1;
}
// Item keys are stored lowercased (noclaimHoldings folds by the lowercased
// "name|game" key), so every lookup lowercases too.
function keyOf(v) {
  return String(v == null ? "" : v)
    .trim()
    .toLowerCase();
}
function text(v, max) {
  return String(v == null ? "" : v)
    .trim()
    .slice(0, max);
}
function isNoclaimSet(set) {
  return !!set && set.stockSource === "noclaim";
}

// The body's picked items as [{ itemKey, qty, name, game }], one per item.
// The contract's shape is items:[{itemKey, qty}]; the Drop-archive editor's
// itemKeys + itemQuantities is accepted as well so the page can reuse its save
// payload. The same item twice adds up (each entry means "N copies of it").
// null = the body carries no item list at all (an edit that keeps the items).
function pickedItems(body) {
  let list = null;
  if (Array.isArray(body.items)) {
    list = body.items;
  } else if (Array.isArray(body.itemKeys)) {
    const q =
      body.itemQuantities && typeof body.itemQuantities === "object"
        ? body.itemQuantities
        : {};
    list = body.itemKeys.map((k) => ({ itemKey: k, qty: q[k] }));
  }
  if (!list) return null;
  const byKey = new Map();
  for (const raw of list) {
    const it = raw && typeof raw === "object" ? raw : { itemKey: raw };
    const itemKey = keyOf(it.itemKey);
    if (!itemKey) continue;
    const prev = byKey.get(itemKey);
    if (prev) {
      prev.qty += qtyOf(it.qty);
      continue;
    }
    byKey.set(itemKey, {
      itemKey,
      qty: qtyOf(it.qty),
      name: text(it.name, 200),
      game: text(it.game, 200),
    });
  }
  return [...byKey.values()];
}

// What the holdings snapshot knows about each item: first-seen name/game, the
// first image, and the most copies any one in-config account holds — the
// ceiling for a set's qty, since a bundle promising more copies than any
// account has could never be handed over.
async function heldIndex(holdings) {
  const base = await holdings.snapshotBase();
  const byKey = new Map();
  for (const h of (base && base.holdings) || []) {
    for (const it of (h && h.items) || []) {
      const itemKey = keyOf(it && it.itemKey);
      if (!itemKey) continue;
      const qty = qtyOf(it.qty);
      const cur = byKey.get(itemKey);
      if (!cur) {
        byKey.set(itemKey, {
          itemKey,
          name: String(it.name || ""),
          game: String(it.game || ""),
          image: String(it.image || ""),
          maxQty: qty,
        });
        continue;
      }
      if (qty > cur.maxQty) cur.maxQty = qty;
      if (!cur.image && it.image) cur.image = String(it.image);
    }
  }
  return byKey;
}

// Picked items -> DropSet items. name/game/image come from the snapshot, never
// from the page. `prevItems` (an edit) keeps an item the set already has when
// no account holds it right now, and never lowers a qty the set already
// promises: an edit must not 400, or quietly shrink the bundle, because a drop
// expired off the farm after the set was made.
function resolveItems(picked, held, prevItems) {
  const prev = new Map((prevItems || []).map((i) => [keyOf(i.itemKey), i]));
  const items = [];
  const unknown = [];
  for (const p of picked) {
    const h = held.get(p.itemKey);
    const old = prev.get(p.itemKey);
    if (!h && !old) {
      unknown.push(p.itemKey);
      continue;
    }
    const ceiling = Math.max(h ? h.maxQty : 1, old ? qtyOf(old.qty) : 1);
    items.push({
      itemKey: h ? h.itemKey : keyOf(old.itemKey),
      name: (h && h.name) || (old && old.name) || p.itemKey.split("|")[0],
      game: (h && h.game) || (old && old.game) || p.itemKey.split("|")[1] || "",
      image: (h && h.image) || (old && old.image) || "",
      qty: Math.min(p.qty, ceiling),
    });
  }
  return { items, unknown };
}

function notHeldMessage(keys) {
  const more = keys.length > 5 ? " (+" + (keys.length - 5) + " more)" : "";
  return (
    "No account on the no-claim farm holds " +
    keys.slice(0, 5).join(", ") +
    more +
    " right now — refresh stock and pick again"
  );
}

// One game -> that game; a mixed bundle -> the first item's (contract §9). The
// title, description and pricing helpers all key off it.
function coverGameFor(items) {
  const games = items.map((i) => String(i.game || "").trim()).filter(Boolean);
  if (!games.length) return "";
  const single = new Set(games.map((g) => settings.normGameName(g))).size === 1;
  if (single) return games[0];
  return String((items[0] && items[0].game) || "").trim() || games[0];
}

// Order-free identity of an item list (key + copies), so an edit that re-sends
// the items it already has is not mistaken for an items change.
function itemsSignature(items) {
  return (items || [])
    .map((i) => keyOf(i.itemKey) + "×" + qtyOf(i.qty))
    .sort()
    .join("\n");
}

// The publicSet shape (routes/dropArchiveRoutes.js) plus stockSource. Field by
// field, never a spread: {...doc} on a Mongoose document yields undefined for
// every schema field.
function setOut(s) {
  const items = (s.items || []).map((i) => ({
    itemKey: i.itemKey || "",
    name: i.name || "",
    game: i.game || "",
    image: i.image || "",
    qty: qtyOf(i.qty),
  }));
  return {
    id: String(s._id),
    name: s.name || "",
    note: s.note || "",
    items,
    itemCount: items.length,
    price: num(s.price, 0),
    listed: !!s.listed,
    custom: !!s.custom,
    stockSource: s.stockSource || "",
    coverGame: s.coverGame || "",
    createdAt: s.createdAt || null,
    updatedAt: s.updatedAt || null,
  };
}

// The no-claim set named by :id, or null after answering 400/404.
async function loadNoclaimSet(req, res) {
  const id = String(req.params.id || "");
  if (!isId(id)) {
    res.status(400).json({ success: false, message: "bad id" });
    return null;
  }
  const set = await DropSet.findById(id).lean();
  if (!set) {
    res.status(404).json({ success: false, message: "Listing not found" });
    return null;
  }
  if (!isNoclaimSet(set)) {
    res.status(400).json({
      success: false,
      code: "not_noclaim",
      message: "Not a no-claim listing",
    });
    return null;
  }
  return set;
}

// The Listings page reads its sets through /drops-archive/sets, a cache that
// dropArchiveRoutes only clears for writes passing through its own router —
// these don't, so a new or edited no-claim set would stay invisible there
// until the cache expired. Required lazily: that router is heavy and
// server.js loads it after this one. A failed bust never fails the save.
function bustSetsCache() {
  try {
    const archive = require("../routes/dropArchiveRoutes");
    if (archive && typeof archive.bustSetsCache === "function") archive.bustSetsCache();
  } catch (err) {
    console.error("noclaim-stock: sets cache bust failed:", err.message);
  }
}

// MarketResearch keys a game by its display label; match it case-insensitively
// the way the engine's researchByGame does, so "overwatch 2" finds
// "Overwatch 2".
async function researchFor(game) {
  const g = String(game || "").trim();
  if (!g) return null;
  const esc = g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return MarketResearch.findOne({ game: new RegExp("^" + esc + "$", "i") }).lean();
}

// Listing copy from the item names alone, for when the engine's helpers throw:
// the form must always get something to start from.
function fallbackCopy(game, items) {
  const g = String(game || "").trim() || "Twitch";
  const names = items.map(
    (i) => (i.qty > 1 ? i.qty + "× " : "") + (i.name || "Reward"),
  );
  const total = items.reduce((n, i) => n + i.qty, 0);
  const more = names.length > 2 ? " +" + (names.length - 2) + " more" : "";
  const title =
    g + " Twitch Drops (" + total + " Item" + (total === 1 ? "" : "s") + ") — " +
    names.slice(0, 2).join(" + ") + more;
  return {
    title: title.slice(0, 120),
    description: [
      "Twitch account with unclaimed Twitch Drops for " + g + ":",
      ...names.map((n) => "- " + n),
      "",
      "Every drop is already earned (100%) and left unclaimed — you connect " +
        "your own game account and claim them yourself.",
    ].join("\n"),
  };
}

// The lifecycle pass's last result, for the summary strip. Optional: a broken
// listings module must not blank the snapshot numbers the picker needs.
function lastPass() {
  try {
    const st = require(MODULES.listings).status();
    return (st && st.lastPass) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Snapshot (the picker)
// ---------------------------------------------------------------------------

router.get("/noclaim-stock/summary", requireSuperadmin, async (req, res) => {
  const holdings = dep(res, "holdings");
  if (!holdings) return;
  try {
    const summary = (await holdings.summary()) || {};
    res.json({ success: true, ...summary, lastPass: lastPass() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/noclaim-stock/games", requireSuperadmin, async (req, res) => {
  const holdings = dep(res, "holdings");
  if (!holdings) return;
  try {
    const games = await holdings.pickerGames();
    res.json({ success: true, games: Array.isArray(games) ? games : [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/noclaim-stock/items", requireSuperadmin, async (req, res) => {
  const holdings = dep(res, "holdings");
  if (!holdings) return;
  try {
    const items = await holdings.pickerItems({
      game: text(req.query.game, 200),
      search: text(req.query.search, 200),
    });
    res.json({ success: true, items: Array.isArray(items) ? items : [] });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Starts an on-demand read of the farm's inventories and answers at once: a
// refresh is up to refreshBudget live Twitch reads — minutes, far past any
// proxy timeout. The page polls /noclaim-stock/summary until `sweeping` clears.
router.post("/noclaim-stock/refresh", requireSuperadmin, requireEnabled, (req, res) => {
  const holdings = dep(res, "holdings");
  if (!holdings) return;
  try {
    if (holdings.isSweeping())
      return res.status(409).json({
        success: false,
        code: "sweeping",
        message: "A stock refresh is already running",
      });
    const game = text((req.body || {}).game, 200);
    const budget = Math.min(
      400,
      Math.max(1, Math.floor(num(shopSettings().refreshBudget, REFRESH_BUDGET_DEFAULT))),
    );
    const run = holdings.sweepOnce({ budget, game, reason: "refresh" });
    // Never awaited, so it must never reject unhandled.
    Promise.resolve(run).catch((err) =>
      console.error("noclaim-stock refresh failed:", err && err.message),
    );
    res.json({ success: true, started: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Suggested title / description / price for the picked items, from the same
// helpers the auto-lister titles and prices its own no-claim listings with.
// Read-only (it writes nothing, so the kill switch does not gate it) and it
// never fails: whatever throws falls back to copy built from the item names.
router.post("/noclaim-stock/copy", requireSuperadmin, async (req, res) => {
  const picked = pickedItems(req.body || {}) || [];
  let held = new Map();
  try {
    held = await heldIndex(require(MODULES.holdings));
  } catch (err) {
    console.error("noclaim-stock copy: snapshot unavailable:", err.message);
  }
  // An item the snapshot does not know still gets copy (the page's name, else
  // the key itself): this only writes text, and a sweep can land between the
  // picker's read and this call.
  const items = picked.slice(0, MAX_ITEMS).map((p) => {
    const h = held.get(p.itemKey);
    return {
      itemKey: h ? h.itemKey : p.itemKey,
      name: (h && h.name) || p.name || p.itemKey.split("|")[0],
      game: (h && h.game) || p.game || p.itemKey.split("|")[1] || "",
      image: (h && h.image) || "",
      qty: h ? Math.min(p.qty, h.maxQty) : p.qty,
    };
  });
  if (!items.length)
    return res.json({ success: true, title: "", description: "", price: 0, floor: 0 });

  const setLike = { items, coverGame: coverGameFor(items) };
  const game = setLike.coverGame;
  const fallback = fallbackCopy(game, items);
  let title = fallback.title;
  let description = fallback.description;
  let price = 0;
  let floor = 0;
  let cls = null;
  try {
    cls = await engine.classificationForSet(setLike);
  } catch (err) {
    cls = null;
  }
  try {
    const drops = engine.dropsFromSet(setLike);
    title = String(engine.listingTitle(game, drops, cls) || "").trim() || fallback.title;
    description =
      String(engine.listingDescription(game, drops, undefined, cls) || "").trim() ||
      fallback.description;
  } catch (err) {
    console.error("noclaim-stock copy: listing copy failed:", err.message);
  }
  try {
    const priced = engine.priceForItems({
      research: await researchFor(game),
      game,
      items,
      cls,
      pricing: settings.getUnclaimedPricing(),
    });
    price = round2(priced && priced.price);
    floor = round2(priced && priced.floor);
  } catch (err) {
    console.error("noclaim-stock copy: pricing failed:", err.message);
  }
  res.json({ success: true, title, description, price, floor });
});

// ---------------------------------------------------------------------------
// No-claim sets
// ---------------------------------------------------------------------------

router.post("/noclaim-stock/sets", requireSuperadmin, requireEnabled, async (req, res) => {
  const holdings = dep(res, "holdings");
  if (!holdings) return;
  try {
    const body = req.body || {};
    const name = text(body.name, 200);
    if (!name) return res.status(400).json({ success: false, message: "Name required" });
    let price = 0;
    if (body.price !== undefined && body.price !== null && body.price !== "") {
      const p = num(body.price, NaN);
      if (!Number.isFinite(p) || p < 0)
        return res.status(400).json({ success: false, message: "Invalid price" });
      price = round2(p);
    }
    const picked = pickedItems(body) || [];
    if (!picked.length)
      return res.status(400).json({ success: false, message: "Pick at least one item" });
    if (picked.length > MAX_ITEMS)
      return res
        .status(400)
        .json({ success: false, message: "Too many items (max " + MAX_ITEMS + ")" });
    const { items, unknown } = resolveItems(picked, await heldIndex(holdings));
    if (unknown.length)
      return res
        .status(400)
        .json({ success: false, message: notHeldMessage(unknown), unknown });

    const doc = await DropSet.create({
      name,
      note: text(body.note, 8000),
      price,
      items,
      // Contract §0: a no-claim set is never on the Shop, never in the public
      // catalog (whose schema default is ON), never a Custom listing, never an
      // event bundle.
      stockSource: "noclaim",
      listed: false,
      publicCatalog: false,
      custom: false,
      sourceType: "",
      coverGame: coverGameFor(items),
    });
    // A server whose models/DropSet.js predates stockSource drops the field
    // without a word (Mongoose strict mode), and the set would be born an
    // ordinary Drop-archive listing — one "Sell on…" would then sell it from
    // the archive. Refuse rather than keep a set that is not what it says.
    if (doc.stockSource !== "noclaim") {
      await DropSet.deleteOne({ _id: doc._id }).catch(() => {});
      return res.status(503).json({
        success: false,
        code: "model_outdated",
        message:
          "This server's DropSet model has no stockSource field, so the set would " +
          "have become a Drop-archive listing — nothing was saved",
      });
    }
    bustSetsCache();
    logEvent({
      category: "noclaim_shop",
      action: "set_created",
      actor: actorFromReq(req),
      subject: doc.name || String(doc._id),
      subjectId: doc._id,
      game: doc.coverGame || "",
      count: items.length,
      detail:
        "no-claim listing created: " + items.length + " item(s) at $" + price.toFixed(2),
    });
    res.json({ success: true, set: setOut(doc) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Name, note and price always; items only while no active marketplace row
// sells this set — a live listing's buyers were promised the current items,
// and vault markets (Gameflip / GGSel / Plati) already hold accounts that were
// picked for them.
router.put("/noclaim-stock/sets/:id", requireSuperadmin, requireEnabled, async (req, res) => {
  try {
    const set = await loadNoclaimSet(req, res);
    if (!set) return;
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) {
      const name = text(body.name, 200);
      if (!name) return res.status(400).json({ success: false, message: "Name required" });
      patch.name = name;
    }
    if (body.note !== undefined) patch.note = text(body.note, 8000);
    if (body.price !== undefined) {
      const p = num(body.price, NaN);
      if (!Number.isFinite(p) || p < 0)
        return res.status(400).json({ success: false, message: "Invalid price" });
      patch.price = round2(p);
    }
    const picked = pickedItems(body);
    // Re-sent unchanged (the form always posts its items) is not an items
    // change: renaming a set with live listings must not answer 409.
    if (picked && itemsSignature(picked) !== itemsSignature(set.items)) {
      if (!picked.length)
        return res.status(400).json({ success: false, message: "Pick at least one item" });
      if (picked.length > MAX_ITEMS)
        return res
          .status(400)
          .json({ success: false, message: "Too many items (max " + MAX_ITEMS + ")" });
      const holdings = dep(res, "holdings");
      if (!holdings) return;
      const { items, unknown } = resolveItems(picked, await heldIndex(holdings), set.items);
      if (unknown.length)
        return res
          .status(400)
          .json({ success: false, message: notHeldMessage(unknown), unknown });
      if (itemsSignature(items) !== itemsSignature(set.items)) {
        const live = await MarketplaceListing.find(
          { set: set._id, status: "active" },
          { marketplace: 1, externalId: 1 },
        )
          .limit(20)
          .lean();
        if (live.length)
          return res.status(409).json({
            success: false,
            code: "listing_active",
            message: "Delist it first — live listings advertise the current items",
            listings: live.map((r) => ({
              id: String(r._id),
              marketplace: r.marketplace || "",
              externalId: r.externalId || "",
            })),
          });
        patch.items = items;
        patch.coverGame = coverGameFor(items);
      }
    }
    const edited = Object.keys(patch);
    // Contract §0 invariants, re-asserted on every save so no other path can
    // have left a no-claim set on the Shop or in the public catalog.
    Object.assign(patch, {
      listed: false,
      publicCatalog: false,
      custom: false,
      sourceType: "",
    });
    const updated = await DropSet.findOneAndUpdate(
      { _id: set._id, stockSource: "noclaim" },
      { $set: patch },
      { returnDocument: "after", runValidators: true },
    ).lean();
    if (!updated) return res.status(404).json({ success: false, message: "Listing not found" });
    bustSetsCache();
    logEvent({
      category: "noclaim_shop",
      action: "set_updated",
      actor: actorFromReq(req),
      subject: updated.name || String(updated._id),
      subjectId: updated._id,
      game: updated.coverGame || "",
      detail: "no-claim listing edited: " + (edited.join(", ") || "no change"),
    });
    res.json({ success: true, set: setOut(updated) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get("/noclaim-stock/sets/:id/stock", requireSuperadmin, async (req, res) => {
  const stock = dep(res, "stock");
  if (!stock) return;
  try {
    const set = await loadNoclaimSet(req, res);
    if (!set) return;
    const st = (await stock.stockForSet(set)) || {};
    res.json({ success: true, ...st });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Which free accounts could fill this set right now (?fresh=0 adds the free
// ones whose snapshot is stale), leanest first — the order a claim takes them
// in. Five whitelisted fields per account: never a password, token, email or
// pool id, whatever the candidate objects happen to carry.
router.get("/noclaim-stock/sets/:id/accounts", requireSuperadmin, async (req, res) => {
  const stock = dep(res, "stock");
  if (!stock) return;
  try {
    const set = await loadNoclaimSet(req, res);
    if (!set) return;
    const fresh = !["0", "false"].includes(text(req.query.fresh, 10).toLowerCase());
    const cands = (await stock.freeCandidates(set, { fresh })) || [];
    const required = stock.requiredFromSet(set);
    res.json({
      success: true,
      fresh,
      total: cands.length,
      accounts: cands.slice(0, MAX_ACCOUNTS).map((c) => ({
        login: String(c.login || c.loginLower || ""),
        botId: String(c.botId || ""),
        game: String(c.game || ""),
        readAt: c.readAt || null,
        extra: stock.extraLoad(stock.heldCounts(c.items || []), required),
      })),
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Hand-run of the lifecycle pass (sales, conflicts, unit health, top-up). The
// pass holds its own single-run flag, so a double click cannot run it twice.
router.post("/noclaim-stock/run", requireSuperadmin, requireEnabled, async (req, res) => {
  const listings = dep(res, "listings");
  if (!listings) return;
  try {
    const result = await listings.runPass({ sweep: false });
    logEvent({
      category: "noclaim_shop",
      action: "pass_run",
      actor: actorFromReq(req),
      subject: "no-claim listings",
      detail: "operator ran the no-claim listing pass by hand",
    });
    res.json({ success: true, result: result || null });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Hand back ONE committed ("manual") no-claim account by hand — the way out for
// a claim the lifecycle pass pinned because its publish never reached a
// listing row (it never releases those itself: nobody knows whether the
// platform got the credential). The owner checks the marketplace first; this
// still refuses while any live listing carries the login.
router.post(
  "/noclaim-stock/ledgers/:id/release",
  requireSuperadmin,
  requireEnabled,
  async (req, res) => {
    const stock = dep(res, "stock");
    if (!stock) return;
    try {
      const id = String(req.params.id || "");
      if (!/^[0-9a-f]{24}$/i.test(id)) {
        return res.status(400).json({ success: false, message: "Invalid ledger id" });
      }
      const UnclaimedAccount = require("../models/UnclaimedAccount");
      const ledger = await UnclaimedAccount.findById(id).lean();
      if (!ledger || ledger.source !== "noclaim") {
        return res.status(404).json({ success: false, message: "Ledger not found" });
      }
      if (ledger.status !== "manual") {
        return res.status(409).json({
          success: false,
          message: "Only a committed (manual) account can be released — this one is " + ledger.status,
        });
      }
      const live = await engine.activeListingsForLogin(ledger.login);
      if (live && live.length) {
        return res.status(409).json({
          success: false,
          message:
            "Still on sale: " +
            live.map((r) => r.marketplace + " " + r.externalId).join(", ") +
            " — delist it first",
        });
      }
      const released = await stock.releaseClaim([id], { reason: "released by hand" });
      logEvent({
        category: "noclaim_shop",
        action: "released_by_hand",
        actor: actorFromReq(req),
        subject: ledger.login || id,
        count: released,
        detail: "operator released a committed no-claim account",
      });
      res.json({ success: true, released });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
