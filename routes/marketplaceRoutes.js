const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const AccountOffer = require("../models/AccountOffer");
const AuditFinding = require("../models/AuditFinding");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const MarketResearch = require("../models/MarketResearch");
const dsFulfiller = require("../utils/digisellerFulfiller");
const gfFulfiller = require("../utils/gameflipFulfiller");
const ggFulfiller = require("../utils/ggselFulfiller");
const fpFulfiller = require("../utils/funpayFulfiller");
const guardian = require("../utils/marketplaceGuardian");
const guardianFixes = require("../utils/guardianFixes");
const marketResearch = require("../utils/marketResearch");
const mp = require("../utils/marketplaces");
const epicnpc = require("../utils/epicnpcCatalog");
const paCopy = require("../utils/playerauctionsCopy");
const suppliedStock = require("../utils/suppliedStock");
const { isNoClaimGame } = require("../utils/settings");
const { listingGame } = require("../utils/listingGame");
const { logEvent } = require("../utils/systemLog");
const {
  resolveCategory,
  MARKETS_NEEDING_CATEGORY,
} = require("../utils/listingCategory");
const { buildG2gBulkFile } = require("../utils/g2gBulk");
const { competitorPrices } = require("../utils/priceScout");
const { recordListingSale } = require("../utils/saleLearning");
const {
  buildSetGridImage,
  buildPromoCoverImage,
} = require("../utils/setImage");

const router = express.Router();

const PROMO_BULLETS_DEFAULT = [
  "Fully Automated Farming",
  "Account-Safe and Undetectable",
  "Reliable Daily Rewards",
];
const PROMO_SERVICE_DEFAULT = "180 Days Service";

// The most-cached-first drop images for a game, for a promo cover's grid.
async function gameDropImages(game, limit) {
  const g = String(game || "").trim();
  if (!g) return [];
  const re = new RegExp(
    "^" + g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
    "i",
  );
  const rows = await DropLog.aggregate([
    { $match: { game: re, imageLocal: { $ne: "" } } },
    { $group: { _id: "$imageLocal", accounts: { $sum: 1 } } },
    { $sort: { accounts: -1 } },
    { $limit: Math.max(1, Math.min(60, limit || 30)) },
  ]);
  return rows.map((r) => r._id).filter(Boolean);
}

// Resolve the tile images for a promo cover: caller-supplied custom images win,
// otherwise the selected game's cached drop images.
async function promoTileImages(opts) {
  const custom = (Array.isArray(opts.coverImages) ? opts.coverImages : [])
    .map((i) => String(i || "").trim())
    .filter(Boolean);
  if (custom.length) return custom;
  return gameDropImages(opts.coverGame, 30);
}

function promoOptsFromBody(body, fallbackTitle) {
  const bullets = Array.isArray(body.coverBullets)
    ? body.coverBullets.map((b) => String(b || "").trim()).filter(Boolean)
    : PROMO_BULLETS_DEFAULT;
  return {
    title: String(body.coverTitle || fallbackTitle || "").trim(),
    serviceText: String(
      body.coverServiceText != null
        ? body.coverServiceText
        : PROMO_SERVICE_DEFAULT,
    ).trim(),
    bullets: bullets.length ? bullets : PROMO_BULLETS_DEFAULT,
    coverGame: String(body.coverGame || "").trim(),
    coverImages: body.coverImages,
    twitchTiles: body.twitchTiles !== false,
  };
}

// ------------------------------------------------------------------
// API keys (stored encrypted; only masked values ever leave the server)
// ------------------------------------------------------------------
router.get("/marketplaces/keys", requireSuperadmin, (req, res) => {
  res.json({ success: true, marketplaces: mp.keyStatus() });
});

router.put("/marketplaces/keys/:name", requireSuperadmin, async (req, res) => {
  try {
    const name = req.params.name;
    if (!mp.MARKETPLACES.includes(name)) {
      return res
        .status(400)
        .json({ success: false, message: "Unknown marketplace" });
    }
    await mp.setKeys(name, req.body || {});
    res.json({ success: true, marketplaces: mp.keyStatus() });
  } catch (err) {
    console.error("marketplace keys error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Verify credentials actually work before trying to publish with them.
router.post("/marketplaces/test/:name", requireSuperadmin, async (req, res) => {
  try {
    const name = req.params.name;
    let r;
    if (name === "gameflip") r = await mp.gameflipTest();
    else if (name === "digiseller") r = await mp.digisellerTest();
    else if (name === "g2g") r = await mp.g2gTest();
    else if (name === "ggsel") r = await mp.ggselTest();
    else if (name === "zeusx") r = await mp.zeusxTest();
    else if (name === "funpay") r = await mp.funpayTest();
    else if (name === "eldorado") r = await mp.eldoradoTest();
    else if (name === "playerauctions") r = await mp.playerauctionsTest();
    else if (name === "z2u") r = await mp.z2uTest();
    else {
      return res
        .status(400)
        .json({ success: false, message: "Unknown marketplace" });
    }
    res.json({ success: true, detail: r.detail || "OK" });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ------------------------------------------------------------------
// Digiseller marketplace catalog (for placing products on Plati / GGsell)
// ------------------------------------------------------------------
router.get(
  "/marketplaces/digiseller/categories",
  requireSuperadmin,
  async (req, res) => {
    try {
      const rootId = String(req.query.rootId || "");
      res.json({ success: true, data: await mp.digisellerCategories(rootId) });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  },
);

router.get(
  "/marketplaces/digiseller/attributes",
  requireSuperadmin,
  async (req, res) => {
    try {
      const id = String(req.query.categoryId || "");
      if (!id) {
        return res
          .status(400)
          .json({ success: false, message: "categoryId required" });
      }
      res.json({
        success: true,
        data: await mp.digisellerCategoryAttributes(id),
      });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  },
);

// ------------------------------------------------------------------
// GGSel catalog browsing (drill down the category tree one level at a time)
// ------------------------------------------------------------------
router.get(
  "/marketplaces/ggsel/categories",
  requireSuperadmin,
  async (req, res) => {
    try {
      const parentId = String(req.query.parentId || "");
      res.json({ success: true, data: await mp.ggselCategories(parentId) });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  },
);

// ------------------------------------------------------------------
// G2G catalog browsing (service -> brand -> product -> attributes)
// ------------------------------------------------------------------
router.get(
  "/marketplaces/g2g/services",
  requireSuperadmin,
  async (req, res) => {
    try {
      res.json({ success: true, data: await mp.g2gServices() });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  },
);

router.get("/marketplaces/g2g/brands", requireSuperadmin, async (req, res) => {
  try {
    const serviceId = String(req.query.serviceId || "");
    if (!serviceId) {
      return res
        .status(400)
        .json({ success: false, message: "serviceId required" });
    }
    res.json({ success: true, data: await mp.g2gBrands(serviceId) });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

router.get(
  "/marketplaces/g2g/products",
  requireSuperadmin,
  async (req, res) => {
    try {
      const { serviceId, brandId, categoryId } = req.query;
      if (!serviceId || !brandId) {
        return res
          .status(400)
          .json({ success: false, message: "serviceId and brandId required" });
      }
      res.json({
        success: true,
        data: await mp.g2gProducts(
          String(serviceId),
          String(brandId),
          String(categoryId || ""),
        ),
      });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  },
);

router.get(
  "/marketplaces/g2g/attributes",
  requireSuperadmin,
  async (req, res) => {
    try {
      const productId = String(req.query.productId || "");
      if (!productId) {
        return res
          .status(400)
          .json({ success: false, message: "productId required" });
      }
      res.json({ success: true, data: await mp.g2gAttributes(productId) });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  },
);

// Generate a G2G "Bulk Upload for Items" .xlsx for offers G2G's API can't
// create (non-instant item delivery). The Offer Attributes reference sheet is
// pulled live from the product's attributes, so no blank template download is
// needed — the seller just uploads this file on g2g.com. Returns the file as a
// download, or JSON on error.
router.post(
  "/marketplaces/g2g/bulk-file",
  requireSuperadmin,
  async (req, res) => {
    try {
      const body = req.body || {};
      const productId = String(body.productId || "").trim();
      if (!productId) {
        return res
          .status(400)
          .json({ success: false, message: "productId required" });
      }
      const offers = Array.isArray(body.offers) ? body.offers : [];
      if (!offers.length) {
        return res
          .status(400)
          .json({ success: false, message: "No offers to export" });
      }
      // Best-effort: the Offers tab is still valid without the reference sheet,
      // so a failed attributes lookup shouldn't block the export.
      let attributesApi = null;
      try {
        attributesApi = await mp.g2gAttributes(productId);
      } catch (e) {
        console.error("g2g bulk: attributes fetch failed:", e.message);
      }
      const buf = buildG2gBulkFile({
        productId,
        productName: String(body.productName || ""),
        attributesApi,
        offers,
        defaults: body.defaults || {},
      });
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="' + productId + '.xlsx"',
      );
      res.send(buf);
    } catch (err) {
      console.error("g2g bulk-file error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// List the seller's live G2G offers (id, title, price, game) so the price
// updater can show them grouped by game and update prices in bulk.
router.get("/marketplaces/g2g/offers", requireSuperadmin, async (req, res) => {
  try {
    const offers = await mp.g2gListOffers();
    res.json({ success: true, offers });
  } catch (err) {
    console.error("g2g list offers error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// Update price/stock (etc.) of an existing G2G offer by its offer id. This is
// the "bulk update" path: G2G's file importer and Open API both refuse to
// *create* non-instant item offers, but updating an offer that already exists
// is allowed. Body: { unitPrice?, stock?, status?, title?, description? }.
router.put(
  "/marketplaces/g2g/offers/:offerId",
  requireSuperadmin,
  async (req, res) => {
    try {
      const offerId = String(req.params.offerId || "").trim();
      if (!offerId) {
        return res
          .status(400)
          .json({ success: false, message: "offerId required" });
      }
      const result = await mp.g2gUpdateOffer(offerId, req.body || {});
      res.json({ success: true, result });
    } catch (err) {
      console.error("g2g update offer error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ------------------------------------------------------------------
// Publish / list / delist
// ------------------------------------------------------------------

// Resolve a set's cover image (a locally-cached drop image) to a file path so
// Gameflip gets a photo. Only serves files inside public/.
function coverImagePath(set) {
  const publicDir = path.join(__dirname, "..", "public");
  // First item that actually has a locally-cached image, not just items[0] —
  // one item's image download may have failed while others succeeded.
  const withImg = (set.items || []).find(
    (i) => i && typeof i.image === "string" && i.image.startsWith("/"),
  );
  const img = withImg ? withImg.image : "";
  if (img) {
    const p = path.normalize(path.join(publicDir, img));
    if (p.startsWith(publicDir) && fs.existsSync(p)) return p;
  }
  // No usable item image (e.g. a hand-entered set) — fall back to a bundled
  // default cover so Gameflip still gets a cover_photo instead of rejecting the
  // listing with "must have active cover_photo".
  const def = path.join(publicDir, "listing-default-cover.png");
  return fs.existsSync(def) ? def : "";
}

function buildDescription(set) {
  const lines = [
    set.note || "",
    "",
    "Includes:",
    // qty > 1 = the same reward at several watch-time tiers (buyer gets N
    // copies), so say "4× Supply Crate" instead of hiding the count.
    ...(set.items || []).map(
      (i) =>
        "- " +
        ((i.qty || 1) > 1 ? i.qty + "× " : "") +
        i.name +
        (i.game ? " (" + i.game + ")" : ""),
    ),
  ];
  return lines.join("\n").trim();
}

// EpicNPC listings follow a house style (verified against the seller's own
// live listings): a "<Game> Twitch Drops Account | N+ Unclaimed Rewards" title
// and a body with Featured/Full reward lists, an Information checklist and a
// Payment section. Built as HTML because the bridge drops it straight into the
// XenForo (Froala) editor, which converts it to BBCode on submit. Returns
// { title, descHtml }.
function buildEpicListing(set, game) {
  const escHtml = (s) =>
    String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const items = (set.items || []).filter((i) => i && i.name);
  const count = items.length;
  const label = (i) => ((i.qty || 1) > 1 ? i.qty + "× " : "") + i.name;
  const li = (arr) =>
    "<ul>" + arr.map((t) => "<li>" + escHtml(t) + "</li>").join("") + "</ul>";

  const gameLabel = game || set.name || "Twitch Drops";
  // Nothing to count — an account listing made by hand has no items — keeps
  // its own title rather than announcing "0+ Unclaimed Rewards".
  const title = count
    ? gameLabel + " Twitch Drops Account | " + count + "+ Unclaimed Rewards"
    : String(set.name || gameLabel + " Twitch Drops Account");

  const parts = [];
  // Line breaks kept: a description is usually a multi-line item list, and
  // the editor collapses a bare newline into one run-on paragraph.
  if (set.note) {
    parts.push("<p>" + escHtml(set.note).replace(/\r?\n/g, "<br>") + "</p>");
  }
  // A short "Featured" teaser (first items) only when the full list is long
  // enough to warrant it, mirroring the seller's own listings.
  if (count > 10) {
    parts.push("<b>Featured Rewards</b>");
    parts.push(li(items.slice(0, 8).map(label)));
  }
  if (count) {
    parts.push("<b>Full Reward List (" + count + ")</b>");
    parts.push(li(items.map(label)));
  }
  parts.push("<b>Information</b>");
  parts.push(
    li([
      "✔ Instant delivery",
      "✔ Original Twitch account included",
      "✔ Rewards are unclaimed — simply connect your own linked account",
      "✔ Change the account details after purchase if you wish",
      "✔ Safe and easy redemption",
    ]),
  );
  parts.push("<b>Payment</b>");
  parts.push(
    "<p>PayPal Friends &amp; Family / Crypto (USDT, LTC, etc.)<br>" +
      "Middleman accepted (buyer covers MM fees if requested)</p>",
  );
  parts.push(
    "<p>Feel free to message me if you have any questions or would like " +
      "screenshots before purchasing.</p>",
  );
  return { title, descHtml: parts.join("") };
}

// Render a promo cover for the custom-listing form and return it inline as a
// data URL. Nothing is persisted; the temp file is removed after encoding.
router.post(
  "/marketplaces/custom/preview",
  requireSuperadmin,
  async (req, res) => {
    try {
      const body = req.body || {};
      const promo = promoOptsFromBody(body, "");
      if (!promo.title) {
        return res
          .status(400)
          .json({ success: false, message: "Title required" });
      }
      const file = await buildPromoCoverImage({
        title: promo.title,
        serviceText: promo.serviceText,
        bullets: promo.bullets,
        itemImages: await promoTileImages(promo),
        twitchTiles: promo.twitchTiles,
      });
      const buf = await fsp.readFile(file);
      await fsp.unlink(file).catch(() => {});
      res.json({
        success: true,
        dataUrl: "data:image/png;base64," + buf.toString("base64"),
      });
    } catch (err) {
      console.error("custom cover preview error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Market research: which games' twitch drops actually sell
// ------------------------------------------------------------------
router.get("/marketplaces/research", requireSuperadmin, async (req, res) => {
  try {
    const rows = await MarketResearch.find({})
      .sort({ opportunityScore: -1 })
      .limit(300)
      .lean();
    res.json({ success: true, rows, status: marketResearch.status() });
  } catch (err) {
    console.error("research list error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

router.post(
  "/marketplaces/research/refresh",
  requireSuperadmin,
  async (req, res) => {
    try {
      // The operator clicking "Scan now" is asking for a full refresh, not for
      // the scheduler's view of what has gone stale — so this forces every
      // game, while the hourly tick scans only what is due.
      const r = await Promise.race([
        marketResearch.runScan({ all: true }),
        new Promise((resolve) =>
          setTimeout(() => resolve({ started: true, background: true }), 500),
        ),
      ]);
      res.json({ success: true, ...r, status: marketResearch.status() });
    } catch (err) {
      console.error("research refresh error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Competitor price research: searches other sellers' live listings on
// Gameflip / Plati / GGSel (and G2G when a service+brand is picked) and
// returns per-market stats plus a recommended undercut price.
router.post(
  "/marketplaces/price-check",
  requireSuperadmin,
  async (req, res) => {
    try {
      const body = req.body || {};
      const term = String(body.term || "").trim();
      if (!term) {
        return res
          .status(400)
          .json({ success: false, message: "Search term required" });
      }
      const g2g =
        body.g2g && body.g2g.serviceId && body.g2g.brandId
          ? {
              serviceId: String(body.g2g.serviceId),
              brandId: String(body.g2g.brandId),
            }
          : null;
      const results = await competitorPrices({ term, g2g });
      res.json({ success: true, term, results });
    } catch (err) {
      console.error("price-check error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// ------------------------------------------------------------------
// Account listings + auto-picked categories
// (docs/ACCOUNT-LISTINGS-CONTRACT.md)
// ------------------------------------------------------------------

// A publish is either DropSet-backed or AccountOffer-backed, and everything
// past the id lookup (title, description, cover, all nine market branches) is
// shared. Rather than fork the route, an offer is handed to it in the shape the
// body already reads off a set — with no items and no _id, because an account
// listing has no Drop Archive rows behind it at all.
function setLikeFromOffer(offer) {
  return {
    _id: null,
    name: offer.title || "",
    note: offer.description || "",
    price: Number(offer.priceUsd) || 0,
    minPriceUsd: Number(offer.minPriceUsd) || 0,
    items: [],
    coverStyle: offer.coverStyle || "promo",
    coverServiceText: offer.coverServiceText || "",
    coverBullets: Array.isArray(offer.coverBullets) ? offer.coverBullets : [],
    coverImages: Array.isArray(offer.coverImages) ? offer.coverImages : [],
    coverGame: offer.game || "",
  };
}

// The fields that mark a MarketplaceListing as backed by owner-supplied stock.
// `origin` is passed EXPLICITLY rather than leaning on the schema default, so
// no later default change can enrol the owner's own pasted accounts into the
// auto-farmer's post-event repricing. `accountId`/`accountLogin` stay empty on
// purpose: marketplaceGuardian.runChecks indexes duplicates off exactly those
// two fields and would raise one on every pass. `units[].contentId` is the
// SuppliedAccount id (the ledger row IS the unit here) and `units[].login` is
// what utils/listedLogins.js reads to stop one login being sold twice.
function offerRowFields(offer, accounts) {
  return {
    set: null,
    accountOffer: offer._id,
    origin: "manual",
    accountId: "",
    accountLogin: "",
    units: (accounts || []).map((a) => ({
      contentId: String(a.ledgerId || ""),
      accountId: "",
      login: a.login || "",
      addedAt: new Date(),
      deliveredAt: null,
      orderId: "",
    })),
  };
}

// G7: why did the claim come back empty? suppliedStock.claimForListing answers
// [] for two very different reasons — an empty shelf, and account-listing
// delivery being switched off (F1d moved that gate inside the claim layer).
// These three publish sites reported "Out of stock" for both, so a PAUSED offer
// with a full shelf sent the owner hunting for accounts they had already added.
// A dryRun claim is exempt from the kill switch precisely so it can tell the
// two apart, and it writes nothing.
async function suppliedClaimRefusal(offer, want, market) {
  let onShelf = 0;
  try {
    const probe = await suppliedStock.claimForListing(offer._id, want, {
      market,
      dryRun: true,
    });
    onShelf = probe.length;
  } catch (err) {
    // A failed probe must not invent a diagnosis. Fall through to the
    // stock-shaped message, which is exactly what this site said before.
    console.error("supplied dry claim (" + market + "):", err.message);
  }
  if (onShelf) {
    return (
      "Auto-delivery is switched off for this account listing, so nothing " +
      "could be claimed — at least " +
      onShelf +
      " account(s) are still on the shelf. Turn delivery back on for the " +
      "offer (or globally in Settings) and publish again."
    );
  }
  return (
    "Out of stock — this account listing has no available accounts left to " +
    "hand over"
  );
}

// Account listings on ZeusX. ZeusX's native "Automatic" delivery carries exactly
// ONE credential per offer (game_account validates as a single object — the
// auto-farm sells farmed accounts the same way, autoLister.publishZeusxShare),
// so a quantity of N is N single-stock offers holding one account each. The
// accounts leave the shelf here, at publish, like every market that holds the
// credential itself: ZeusX hands one over the moment a buyer pays, with nothing
// on our side in the loop.
//
// Before this an account listing went out as a plain "Coordinated" ZeusX offer
// — nothing claimed, nothing delivered — so a ZeusX sale had to be handed over
// by hand while the very same accounts stayed on sale everywhere else.
//
// One rule decides every failure: an account must never be on sale twice.
//  - Stopped BEFORE the create call (no such ZeusX game, no price, no keys):
//    nothing was sent, so every untried account goes back on the shelf.
//  - Refused BY the create call (a 4xx, or ZeusX's own isSuccess:false): no
//    offer was made, so the same.
//  - Anything else from the create call (a 5xx, a timeout, no offer id):
//    create-offer is known to answer 500 and STILL create the offer, so the
//    credential may be live on ZeusX. That one account is held out of stock
//    ("fed") and named, for the owner to check on ZeusX.
// And the first failure of any kind stops the run: whatever broke one publish
// (a rate limit, a revoked session) breaks the next, and each further attempt
// risks another held account.
function zeusxCreateMayHaveHappened(err) {
  const msg = String((err && err.message) || "");
  if (!/^ZeusX create/i.test(msg)) return false; // failed before the create
  if (err && err.__zeusx) return false; // isSuccess:false — a clean refusal
  const status = Number(err && err.status) || 0;
  return !(status >= 400 && status < 500);
}

async function publishSuppliedZeusx({
  offer,
  zx,
  title,
  description,
  priceUsd,
  game,
  cover,
}) {
  const qtyWanted = Math.max(1, parseInt(zx.quantity, 10) || 1);
  const claimed = await suppliedStock.claimForListing(
    String(offer._id),
    qtyWanted,
    { market: "zeusx" },
  );
  if (!claimed.length) {
    return {
      success: false,
      message: await suppliedClaimRefusal(offer, qtyWanted, "zeusx"),
    };
  }
  const listed = [];
  const held = [];
  let stopped = "";
  for (const acc of claimed) {
    if (stopped) break;
    let r;
    try {
      r = await mp.zeusxPublish({
        title,
        description,
        priceUsd,
        game,
        serviceCategoryId: zx.serviceCategoryId,
        serviceCategoryBaseId: zx.serviceCategoryBaseId,
        attributes: zx.attributes,
        tags: zx.tags,
        coverImagePath: cover,
        deliveryDays: zx.deliveryDays,
        deliveryHours: zx.deliveryHours,
        // Email left empty exactly as the auto-farm's ZeusX share sends it:
        // the pasted address is the account's recovery mail, which the
        // default delivery text never hands a buyer either.
        autoDeliverAccounts: [
          { login: acc.login, password: acc.password, email: "" },
        ],
      });
    } catch (err) {
      stopped = err.message;
      // Otherwise nothing reached ZeusX for this one, and it goes back on the
      // shelf with the untried ones below.
      if (zeusxCreateMayHaveHappened(err)) held.push(acc);
      console.error(
        "zeusx supplied publish failed for " + acc.login + ":",
        err.message,
      );
      continue;
    }
    let doc = null;
    try {
      doc = await MarketplaceListing.create({
        marketplace: "zeusx",
        externalId: r.externalId,
        url: r.url || "",
        title,
        description,
        price: priceUsd,
        status: "active",
        note:
          (r.note ? r.note + " " : "") +
          "account listing: automatic delivery — " +
          acc.login,
        autoDeliver: true,
        qtyTarget: 1,
        ...offerRowFields(offer, [acc]),
      });
    } catch (e) {
      // The ZeusX offer is live with this credential; only our row is
      // missing. Handing the account back would put it on sale twice.
      console.error("zeusx supplied row create failed:", e.message);
    }
    try {
      await suppliedStock.markFed([acc.ledgerId], {
        listing: doc ? doc._id : null,
        market: "zeusx",
      });
    } catch (e) {
      console.error("supplied markFed (zeusx):", e.message);
    }
    listed.push({ acc, r, doc });
  }
  // Held accounts are fed with no listing: out of stock, never handed back.
  if (held.length) {
    await suppliedStock
      .markFed(
        held.map((a) => a.ledgerId),
        { market: "zeusx" },
      )
      .catch((e) => console.error("supplied markFed (zeusx held):", e.message));
  }
  // Every account the loop never sent (or that provably did not reach ZeusX)
  // goes back on the shelf.
  const sentIds = new Set(
    listed.map((l) => String(l.acc.ledgerId)).concat(
      held.map((a) => String(a.ledgerId)),
    ),
  );
  const back = claimed
    .map((c) => String(c.ledgerId))
    .filter((id) => !sentIds.has(id));
  if (back.length) {
    await suppliedStock
      .releaseClaim(back)
      .catch((e) => console.error("supplied release (zeusx):", e.message));
  }
  const heldNote = held.length
    ? " Held out of stock until you check ZeusX (the create answered an " +
      "error but may have gone through): " +
      held.map((a) => a.login).join(", ") +
      "."
    : "";
  if (!listed.length) {
    return {
      success: false,
      message: (stopped || "ZeusX listed nothing") + "." + heldNote,
    };
  }
  const first = listed.find((l) => l.doc) || listed[0];
  return {
    success: true,
    id: first.doc ? String(first.doc._id) : "",
    externalId: first.r.externalId,
    url: first.r.url || "",
    note:
      listed.length +
      " automatic ZeusX offer(s), one account each" +
      (stopped
        ? " — stopped at " +
          listed.length +
          " of " +
          claimed.length +
          ": " +
          stopped
        : "") +
      heldNote,
  };
}

// Did a ZeusX account-listing offer's one unit reach a buyer? We run no sale
// poller for ZeusX (it delivers an automatic offer on its own), so this is asked
// once, at delist, before the account could be handed back to the shelf.
//   "unsold"  only on positive evidence: the unit is still listed (quantity
//             >= 1), no purchase is recorded when ZeusX sends that list, and
//             the status is not a sale state;
//   "sold"    on positive evidence the other way: quantity 0, or a purchase;
//   "unknown" for anything else — a failed read included.
// Measured on prod 2026-09-11: a live, unsold automatic offer reads
// offer_status "CREATED", quantity 1 and, on the list endpoint,
// offer_purchases [].
async function zeusxUnitVerdict(offerId) {
  let o = null;
  try {
    o = await mp.zeusxOffer(offerId);
  } catch {
    return "unknown";
  }
  if (!o || typeof o !== "object") return "unknown";
  const qty =
    o.quantity == null || o.quantity === "" ? NaN : Number(o.quantity);
  const p = o.offer_purchases;
  const bought = Array.isArray(p) ? p.length > 0 : Number(p) > 0;
  if (bought || (Number.isFinite(qty) && qty <= 0)) return "sold";
  const status = String(o.offer_status || "").toUpperCase();
  const saleState =
    /SOLD|COMPLET|DELIVER|PURCHAS|ORDER|CANCEL|CLOS|EXPIR|DELET|REMOV/.test(
      status,
    );
  if (Number.isFinite(qty) && qty >= 1 && !saleState) return "unsold";
  return "unknown";
}

// A ZeusX account-listing unit that reached a buyer: settle its ledger row as
// sold, so it can never come back to the shelf and the panel counts it sold
// instead of parked. Best-effort — the row's own status already says sold.
async function markZeusxUnitsDelivered(row) {
  const ids = (row.units || [])
    .filter((u) => u && u.contentId)
    .map((u) => String(u.contentId));
  if (!ids.length) return 0;
  try {
    return await suppliedStock.markDelivered(ids, { market: "zeusx" });
  } catch (e) {
    console.error("supplied markDelivered (zeusx):", e.message);
    return 0;
  }
}

// G1: render the hand-over text BEFORE anything goes live, and refuse the
// publish when any unit renders empty.
//
// The implementation is utils/marketplaceGuardian.suppliedUnitsOrRefuse, not a
// copy of it. The guardian's GGSel/Plati top-up needs the identical check on
// the identical shape, and this codebase has already paid for the alternative:
// utils/marketClaimTags.js exists because the same list was pasted into every
// consumer and each copy drifted, so a merely-listed drop read as a real sale.
// One implementation, two callers.
//
// (Why it has to exist at all: the owner's deliveryTemplate can be all
// placeholders the pasted accounts have none of, and both vault helpers
// .filter(Boolean) the unit list — utils/marketplaces.js:1401 for Digiseller,
// :1793/:1864 for GGSel. By then claimForListing has taken the accounts and
// markFed has moved them out of sellable stock.)
const suppliedUnitsOrRefuse = guardian.suppliedUnitsOrRefuse;

// Did the owner pick this market's category by hand? A body-supplied category
// always wins — that is what the modal's "Change" link produces — and only its
// absence triggers the server-side resolution.
//
// G2G is the odd one out. Its picker used to send only `productId`, so this
// answered false for every hand-picked G2G placement: the auto-resolved brand
// overrode the owner's choice while their product still supplied relation_id
// and the offer attributes, and the offer went live assembled from two
// different games (F4). The picker now sends the serviceId + brandId it
// drilled through, and on G2G the brand IS the game — so brandId present means
// "the owner picked this one". It is also the field g2gPublish refuses to work
// without ("G2G brand_id is required (the game)",
// utils/marketplaces.js:3004), which is why a body carrying no brandId must
// still be resolved; serviceId alone is not a pick, because g2gPublish
// defaults the service to Game Items (utils/marketplaces.js:3002) and a
// service without a game is not a placement.
function bodyCategoryGiven(name, body) {
  if (name === "ggsel") return !!(body.ggsel && body.ggsel.categoryId);
  if (name === "digiseller") {
    const cats = (body.digiseller || {}).categories;
    return Array.isArray(cats) && cats.length > 0;
  }
  if (name === "funpay") return !!(body.funpay && body.funpay.nodeId);
  if (name === "g2g") return !!(body.g2g && body.g2g.brandId);
  return true;
}

// Feature A: the category picks itself. We only sell Twitch drops, so the modal
// asks here (on open, and again after the light set row hydrates its items) and
// only falls back to the old drill-down picker when a market genuinely has
// nowhere to file the game.
//
// A resolver miss is a 200 with ok:false, never a 500 — a blocked modal is
// worse than an unmapped market. Every resolver is individually bounded inside
// utils/listingCategory (GGSel's category history is a serial axios loop that
// would otherwise hold this request open for minutes), so resolving in
// parallel costs the slowest market's latency and no more.
router.get(
  "/marketplaces/suggest-category",
  requireSuperadmin,
  async (req, res) => {
    try {
      const q = req.query || {};
      const asked = String(q.marketplaces || "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      // De-duplicated and capped: this is a superadmin route, but a repeated
      // name would fan out the same bounded resolver several times over.
      const targets = [
        ...new Set(asked.length ? asked : MARKETS_NEEDING_CATEGORY),
      ].slice(0, 12);
      let set = null;
      let offer = null;
      if (q.setId) set = await DropSet.findById(String(q.setId)).lean();
      if (q.offerId) {
        offer = await AccountOffer.findById(String(q.offerId)).lean();
      }
      const game = listingGame({ game: q.game, set, offer });
      const entries = await Promise.all(
        targets.map(async (name) => {
          try {
            return [name, await resolveCategory(name, game)];
          } catch (err) {
            // resolveCategory documents that it never throws; if it ever does,
            // one broken market must still not take the modal down.
            return [
              name,
              {
                ok: false,
                marketplace: name,
                value: {},
                label: "",
                source: "none",
                reason: err.message,
              },
            ];
          }
        }),
      );
      const results = {};
      for (const [name, r] of entries) results[name] = r;
      res.json({ success: true, game, results });
    } catch (err) {
      console.error("suggest-category error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.post("/marketplaces/publish", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    // Feature B: an account listing is backed by an AccountOffer and an
    // explicit, owner-pasted list of accounts instead of a DropSet, so exactly
    // one of the two ids says what is being sold. When `offerId` is absent
    // every line below behaves exactly as it did before.
    const offerId = String(body.offerId || "").trim();
    let offer = null;
    if (offerId) {
      offer = await AccountOffer.findById(offerId).lean();
      if (!offer) {
        return res
          .status(404)
          .json({ success: false, message: "Account listing not found" });
      }
    }
    const set = offer
      ? setLikeFromOffer(offer)
      : await DropSet.findById(body.setId).lean();
    if (!set) {
      return res.status(404).json({ success: false, message: "Set not found" });
    }
    const targets = Array.isArray(body.marketplaces) ? body.marketplaces : [];
    if (!targets.length) {
      return res
        .status(400)
        .json({ success: false, message: "Pick at least one marketplace" });
    }
    const title = String(body.title || set.name).trim();
    // An account listing has no items, so buildDescription's "Includes:" list
    // would be an empty heading — the owner's own text is the whole contract.
    const description = String(
      body.description ||
        (offer ? offer.description || "" : buildDescription(set)),
    );
    let priceUsd = Number(body.price != null ? body.price : set.price);
    // The offer's floor is the ONLY floor an account listing has (there is no
    // DropSet behind it for the usual minPriceUsd guard to read).
    if (offer && Number(offer.minPriceUsd) > 0) {
      priceUsd = Math.max(priceUsd, Number(offer.minPriceUsd));
    }
    // The canonical game for this publish. `set.game` does not exist on
    // DropSet, so the four spellings scattered through the branches below all
    // funnel through utils/listingGame instead.
    const pubGame = listingGame({ set, offer, game: body.game });
    // A numbered grid collage of every item in the set makes a much better
    // cover photo than a single item's icon; fall back to the first item.
    // Custom listings use the promo-template cover instead (game drop images
    // or the user's custom images, Twitch accents, title/service/bullets).
    const wantPromo =
      String(body.coverStyle || set.coverStyle || "") === "promo";
    let gridImage = "";
    if (
      targets.includes("gameflip") ||
      targets.includes("ggsel") ||
      targets.includes("digiseller") ||
      targets.includes("zeusx") ||
      // Eldorado rejects an offer with no main image ("Offer main image is
      // missing."), so it always needs a cover built.
      targets.includes("eldorado")
    ) {
      try {
        if (wantPromo) {
          const promo = promoOptsFromBody(
            {
              coverTitle: body.coverTitle,
              coverServiceText:
                body.coverServiceText != null
                  ? body.coverServiceText
                  : set.coverServiceText || undefined,
              coverBullets: Array.isArray(body.coverBullets)
                ? body.coverBullets
                : (set.coverBullets || []).length
                  ? set.coverBullets
                  : undefined,
              coverGame: body.coverGame || set.coverGame,
              coverImages: Array.isArray(body.coverImages)
                ? body.coverImages
                : set.coverImages,
              twitchTiles: body.twitchTiles,
            },
            title,
          );
          gridImage = await buildPromoCoverImage({
            title: promo.title,
            serviceText: promo.serviceText,
            bullets: promo.bullets,
            itemImages: await promoTileImages(promo),
            twitchTiles: promo.twitchTiles,
          });
        } else {
          gridImage = await buildSetGridImage(set);
        }
      } catch (err) {
        console.error("set grid image failed:", err.message);
      }
    }
    const results = {};
    for (const name of targets) {
      try {
        // Feature A's load-bearing half: when the body omits this market's
        // category, resolve one server-side instead of refusing the publish.
        // A failure is scoped to this market — the loop is per-market and the
        // others still publish.
        let auto = null;
        if (MARKETS_NEEDING_CATEGORY.includes(name)) {
          if (!bodyCategoryGiven(name, body)) {
            auto = await resolveCategory(name, pubGame);
            if (!auto.ok) {
              results[name] = {
                success: false,
                message:
                  auto.reason ||
                  "No " + name + " category could be resolved for this listing",
              };
              continue;
            }
          }
        }
        const cat = (auto && auto.value) || {};
        let r;
        if (name === "gameflip") {
          const gfOpts = body.gameflip || {};
          if (gfOpts.autoDeliver) {
            // Auto-delivery chain: one live listing per unit, relisted by the
            // background watcher after each sale until qty is sold.
            const qty = Math.max(1, parseInt(gfOpts.qty, 10) || 1);
            const doc = await gfFulfiller.publishAutoDelivery({
              set,
              // Null for a Drop Archive publish; an account listing hands the
              // fulfiller the offer so it takes one supplied account per unit
              // instead of claiming from the archive.
              offer,
              title,
              description,
              priceUsd,
              imagePath: gridImage || coverImagePath(set),
              qtyRemaining: qty - 1,
              // Published from the Listings page: the owner's own stock, so it
              // (and every unit its relist chain publishes after it) is exempt
              // from the auto-farmer's post-event repricing.
              origin: "manual",
            });
            results[name] = {
              success: true,
              id: String(doc._id),
              externalId: doc.externalId,
              url: doc.url || "",
              note: doc.note || "",
            };
            continue;
          }
          r = await mp.gameflipPublish({
            title,
            description,
            priceUsd,
            imagePath: gridImage || coverImagePath(set),
          });
        } else if (name === "digiseller") {
          const ds = body.digiseller || {};
          const dsCover = gridImage || coverImagePath(set);
          if (ds.delivery === "auto") {
            // Auto-delivery: reserve up to `quantity` farmed accounts that
            // hold the whole bundle and attach each as delivery content, so
            // Digiseller/Plati fulfils sales itself. The manual "Add stock"
            // flow still works for accounts not tracked on the server.
            const qtyWanted = Math.max(1, parseInt(ds.quantity, 10) || 1);
            // Offer-backed rows take their stock from the owner's pasted list
            // through the one shared claim layer — reserveSetOnAccount cannot
            // represent an account that has no DropLog rows, so the archive
            // path could never claim one of these.
            const claimed = offer
              ? await suppliedStock.claimForListing(
                  String(offer._id),
                  qtyWanted,
                  { market: "digiseller" },
                )
              : await dsFulfiller.claimAccountsForSet(set, qtyWanted);
            if (!claimed.length) {
              results[name] = {
                success: false,
                message: offer
                  ? await suppliedClaimRefusal(offer, qtyWanted, "digiseller")
                  : "Out of stock — no unsold account holds this whole " +
                    "bundle, so there is nothing to auto-deliver",
              };
              continue;
            }
            // G1. Rendered here rather than inline at the add-content call so
            // an empty template costs neither a claim nor a junk Plati product.
            let dsUnits = claimed.map((c) => c.code);
            if (offer) {
              const rendered = await suppliedUnitsOrRefuse(offer, claimed);
              if (rendered.message) {
                results[name] = { success: false, message: rendered.message };
                continue;
              }
              dsUnits = rendered.units;
            }
            let dsContentIds = [];
            try {
              r = await mp.digisellerPublish({
                title,
                description,
                priceUsd,
                categories: ds.categories || cat.categories,
              });
              try {
                const added = await mp.digisellerAddContent(
                  r.externalId,
                  dsUnits,
                );
                dsContentIds = (added && added.contentIds) || [];
              } catch (err) {
                // The product exists but got no delivery content — disable it
                // so an empty listing doesn't sit live on Plati.
                await mp.digisellerDelist(r.externalId).catch(() => {});
                throw err;
              }
            } catch (err) {
              if (offer) {
                await suppliedStock.releaseClaim(
                  claimed.map((c) => c.ledgerId),
                );
              } else {
                await dsFulfiller.releaseAccounts(
                  claimed.map((c) => c.accountId),
                );
              }
              throw err;
            }
            let dsNote = "auto-delivery: " + claimed.length + " account(s)";
            if (dsCover && fs.existsSync(dsCover)) {
              try {
                await mp.digisellerUploadImage(r.externalId, dsCover);
              } catch (err) {
                console.error("digiseller image upload failed:", err.message);
                dsNote += " — image upload failed: " + err.message;
              }
            }
            const doc = await MarketplaceListing.create({
              set: set._id,
              marketplace: "digiseller",
              externalId: r.externalId,
              url: r.url || "",
              title,
              description,
              // Plati lifts anything under its platform floor; record what it
              // actually charges, not what was asked for.
              price: r.price || priceUsd,
              status: "active",
              note: dsNote,
              autoDeliver: true,
              accountId: claimed.map((c) => c.accountId).join(","),
              accountLogin: claimed.map((c) => c.login).join(", "),
              qtyTarget: qtyWanted,
              ...(offer ? offerRowFields(offer, claimed) : {}),
            });
            if (offer) {
              // The credentials now sit inside Plati's own vault, so the ledger
              // rows must leave "sold" for "fed": a later release would
              // otherwise put an account a buyer can already be handed back on
              // the shelf. Digiseller has no endpoint that lists a product's
              // content, so the content ids it answered with are recorded here
              // or lost forever.
              try {
                await suppliedStock.markFed(
                  claimed.map((c) => c.ledgerId),
                  {
                    listing: doc._id,
                    market: "digiseller",
                    contentIds: dsContentIds,
                  },
                );
              } catch (e) {
                console.error("supplied markFed (digiseller):", e.message);
              }
            }
            results[name] = {
              success: true,
              id: String(doc._id),
              externalId: r.externalId,
              url: r.url || "",
              note: doc.note,
            };
            continue;
          }
          r = await mp.digisellerPublish({
            title,
            description,
            priceUsd,
            categories: ds.categories || cat.categories,
          });
          if (dsCover && fs.existsSync(dsCover)) {
            try {
              await mp.digisellerUploadImage(r.externalId, dsCover);
            } catch (err) {
              console.error("digiseller image upload failed:", err.message);
              r.note =
                (r.note ? r.note + " " : "") +
                "Image upload failed: " +
                err.message;
            }
          }
        } else if (name === "g2g") {
          const g = body.g2g || {};
          // A G2G placement is ONE unit: service, brand, product and the
          // product's attributes all have to describe the same game. Merging
          // them field by field (`g.brandId || cat.brandId`) did not — the
          // owner's product supplied relation_id and offer_attributes while
          // the brand came from the auto resolution, so the offer went live
          // filed under one game carrying another game's product (F4). So it
          // is all of the owner's pick or none of it.
          const picked = bodyCategoryGiven("g2g", body);
          r = await mp.g2gPublish({
            // The manual G2G path forwarded only productId, so every publish
            // from this page died on "G2G brand_id is required (the game)"
            // (utils/marketplaces.js:3004). The brand IS the game, which is
            // exactly what the resolver answers — and what the owner's own
            // pick overrides, since drilling to a product by hand is the only
            // way to publish a game brandForGame() calls NOT_LISTABLE.
            serviceId: picked ? g.serviceId : cat.serviceId,
            brandId: picked ? g.brandId : cat.brandId,
            // With no pick, a leftover productId belongs to whatever the modal
            // last drilled to, not to the resolved brand, so it is dropped
            // together with its attributes: g2gPublish resolves the relation
            // and the required attributes from the brand itself
            // (utils/marketplaces.js:3019-3024), which is the same path an
            // auto-resolved publish already takes.
            productId: picked ? g.productId : undefined,
            title,
            description,
            priceUsd,
            qty: g.qty,
            minQty: g.minQty,
            currency: g.currency,
            offerAttributes: picked ? g.offerAttributes : undefined,
            // Same reason: the product dictates which delivery methods are
            // legal, and keeping another game's ids would stop g2gPublish
            // asking the resolved brand for its own (marketplaces.js:3027).
            deliveryMethodIds: picked ? g.deliveryMethodIds : undefined,
          });
        } else if (name === "ggsel") {
          const gg = body.ggsel || {};
          const ggCover = gridImage || coverImagePath(set);
          if (gg.delivery === "auto") {
            // Real GGSel auto-delivery: reserve up to `quantity` farmed
            // accounts that hold the whole bundle, attach each as an
            // auto-delivered product, and let GGSel fulfil sales itself.
            const qtyWanted = Math.max(1, parseInt(gg.quantity, 10) || 1);
            // Same split as Digiseller: an offer-backed row's stock is the
            // owner's pasted list, claimed through the shared ledger layer.
            const claimed = offer
              ? await suppliedStock.claimForListing(
                  String(offer._id),
                  qtyWanted,
                  { market: "ggsel" },
                )
              : await ggFulfiller.claimAccountsForSet(set, qtyWanted);
            if (!claimed.length) {
              results[name] = {
                success: false,
                message: offer
                  ? await suppliedClaimRefusal(offer, qtyWanted, "ggsel")
                  : "Out of stock — no unsold account holds this whole " +
                    "bundle, so there is nothing to auto-deliver",
              };
              continue;
            }
            // G1, and it bites hardest here: with every unit empty GGSel still
            // creates the offer, silently with autoselling OFF and the asked-for
            // quantity live.
            let ggUnits = claimed.map((c) => c.code);
            if (offer) {
              const rendered = await suppliedUnitsOrRefuse(offer, claimed);
              if (rendered.message) {
                results[name] = { success: false, message: rendered.message };
                continue;
              }
              ggUnits = rendered.units;
            }
            try {
              r = await mp.ggselPublish({
                title,
                description,
                priceUsd,
                priceRub: gg.priceRub,
                categoryId: gg.categoryId || cat.categoryId,
                delivery: "auto",
                instructions: gg.instructions,
                coverImagePath: ggCover,
                products: ggUnits,
              });
            } catch (err) {
              if (offer) {
                await suppliedStock.releaseClaim(
                  claimed.map((c) => c.ledgerId),
                );
              } else {
                await ggFulfiller.releaseAccounts(
                  claimed.map((c) => c.accountId),
                );
              }
              throw err;
            }
            const doc = await MarketplaceListing.create({
              set: set._id,
              marketplace: "ggsel",
              externalId: r.externalId,
              url: r.url || "",
              title,
              description,
              price: priceUsd,
              status: "active",
              note:
                (r.note ? r.note + " " : "") +
                "auto-delivery: " +
                claimed.length +
                " account(s)",
              autoDeliver: true,
              accountId: claimed.map((c) => c.accountId).join(","),
              accountLogin: claimed.map((c) => c.login).join(", "),
              qtyTarget: qtyWanted,
              ...(offer ? offerRowFields(offer, claimed) : {}),
            });
            if (offer) {
              // Inside GGSel's own vault now — see the Digiseller note above.
              try {
                await suppliedStock.markFed(
                  claimed.map((c) => c.ledgerId),
                  { listing: doc._id, market: "ggsel" },
                );
              } catch (e) {
                console.error("supplied markFed (ggsel):", e.message);
              }
            }
            results[name] = {
              success: true,
              id: String(doc._id),
              externalId: r.externalId,
              url: r.url || "",
              note: doc.note,
            };
            continue;
          }
          r = await mp.ggselPublish({
            title,
            description,
            priceUsd,
            priceRub: gg.priceRub,
            categoryId: gg.categoryId || cat.categoryId,
            quantity: gg.quantity,
            delivery: gg.delivery,
            instructions: gg.instructions,
            coverImagePath: ggCover,
          });
        } else if (name === "funpay") {
          const fp = body.funpay || {};
          // FunPay's picker is a bare numeric box typed from memory, so the
          // resolved node from the settings map is usually the better answer;
          // a typed one still wins.
          const fpNode = fp.nodeId || cat.node || cat.nodeId || "";
          if (!fpNode) {
            results[name] = {
              success: false,
              message: "Pick a FunPay category (node id) first",
            };
            continue;
          }
          if (fp.delivery === "auto") {
            // Real auto-delivery: reserve up to `amount` farmed accounts that
            // hold the whole bundle, attach each as one FunPay secret line
            // (login:password), and let FunPay hand one to each buyer. The
            // connect guide is sent as the offer's after-payment message.
            const qtyWanted = Math.max(1, parseInt(fp.amount, 10) || 1);
            const claimed = offer
              ? await suppliedStock.claimForListing(
                  String(offer._id),
                  qtyWanted,
                  { market: "funpay" },
                )
              : await fpFulfiller.claimAccountsForSet(set, qtyWanted);
            if (!claimed.length) {
              results[name] = {
                success: false,
                message: offer
                  ? await suppliedClaimRefusal(offer, qtyWanted, "funpay")
                  : "Out of stock — no unsold account holds this whole " +
                    "bundle, so there is nothing to auto-deliver",
              };
              continue;
            }
            // No G1 guard here on purpose: FunPay is fed funpayDeliveryLine(),
            // not the offer's template (a multi-line render would be split into
            // several bogus secrets), and that line always carries the login.
            try {
              r = await mp.funpayPublish({
                nodeId: fpNode,
                title,
                description,
                priceUsd,
                currency: fp.currency,
                priceOverride: fp.priceOverride,
                amount: claimed.length,
                active: fp.active !== false,
                autoDelivery: true,
                // FunPay joins its secrets with "\n" and hands ONE LINE to
                // each buyer (utils/marketplaces.js:3786), so a supplied
                // account is fed as the same login:password line the archive
                // path uses — the offer's multi-line delivery template would
                // be split into several bogus secrets.
                secrets: offer
                  ? claimed.map((c) =>
                      fpFulfiller.funpayDeliveryLine(c.login, c.password),
                    )
                  : claimed.map((c) => c.line),
                paymentMsg: fpFulfiller.funpayPaymentGuide(),
              });
            } catch (err) {
              if (offer) {
                await suppliedStock.releaseClaim(
                  claimed.map((c) => c.ledgerId),
                );
              } else {
                await fpFulfiller.releaseAccounts(
                  claimed.map((c) => c.accountId),
                );
              }
              throw err;
            }
            const doc = await MarketplaceListing.create({
              set: set._id,
              marketplace: "funpay",
              externalId: r.externalId,
              externalNode: r.externalNode || "",
              url: r.url || "",
              title,
              description,
              price: priceUsd,
              status: "active",
              note:
                (r.note ? r.note + " " : "") +
                "auto-delivery: " +
                claimed.length +
                " account(s)",
              autoDeliver: true,
              accountId: claimed.map((c) => c.accountId).join(","),
              accountLogin: claimed.map((c) => c.login).join(", "),
              ...(offer ? offerRowFields(offer, claimed) : {}),
            });
            if (offer) {
              // The lines are inside FunPay's secret pool now — see the
              // Digiseller note above.
              try {
                await suppliedStock.markFed(
                  claimed.map((c) => c.ledgerId),
                  { listing: doc._id, market: "funpay" },
                );
              } catch (e) {
                console.error("supplied markFed (funpay):", e.message);
              }
            }
            results[name] = {
              success: true,
              id: String(doc._id),
              externalId: r.externalId,
              url: r.url || "",
              note: doc.note,
            };
            continue;
          }
          r = await mp.funpayPublish({
            nodeId: fpNode,
            title,
            description,
            priceUsd,
            currency: fp.currency,
            priceOverride: fp.priceOverride,
            amount: fp.amount,
            active: fp.active !== false,
            autoDelivery: false,
            paymentMsg: fp.paymentMsg,
          });
        } else if (name === "zeusx") {
          const zx = body.zeusx || {};
          if (offer) {
            // An account listing: one automatic offer per pasted account,
            // taken off the shelf now (publishSuppliedZeusx above).
            results[name] = await publishSuppliedZeusx({
              offer,
              zx,
              title,
              description,
              priceUsd,
              game: zx.game || pubGame,
              cover: gridImage || coverImagePath(set),
            });
            continue;
          }
          r = await mp.zeusxPublish({
            title,
            description,
            priceUsd,
            quantity: zx.quantity,
            // `set.game` never existed on DropSet, so this used to fall
            // through to coverGame by accident; listingGame is the canonical
            // answer now.
            game: zx.game || pubGame,
            serviceCategoryId: zx.serviceCategoryId,
            serviceCategoryBaseId: zx.serviceCategoryBaseId,
            attributes: zx.attributes,
            tags: zx.tags,
            coverImagePath: gridImage || coverImagePath(set),
            deliveryDays: zx.deliveryDays,
            deliveryHours: zx.deliveryHours,
          });
        } else if (name === "eldorado") {
          const el = body.eldorado || {};
          r = await mp.eldoradoPublish({
            title,
            description,
            priceUsd,
            quantity: el.quantity,
            minQuantity: el.minQuantity,
            game: el.game || pubGame,
            coverImagePath: gridImage || coverImagePath(set),
            deliveryTime: el.deliveryTime,
            volumeDiscounts: el.volumeDiscounts,
          });
        } else if (name === "playerauctions") {
          const pa = body.playerauctions || {};
          const paGame = pa.game || pubGame;
          // utils/autoLister.js:1118-1126, verbatim in intent: Overwatch /
          // Rainbow Six / Call of Duty drops have to reach the buyer
          // UNCLAIMED, and every account the Drop Archive can offer was
          // claimed as it was farmed — such a listing could never be honoured.
          // An account listing is exempt: its stock is the owner's own, and
          // whatever state those accounts are in is what the owner advertised.
          if (!offer && isNoClaimGame(paGame)) {
            results[name] = {
              success: false,
              message:
                paGame +
                " is a no-claim game — sellable only from the unclaimed " +
                "farm, not the auto-farm's claimed archive",
            };
            continue;
          }
          // S5 (docs/ACCOUNT-LISTINGS-FIXES-3.md): this branch used to write a
          // DropSet-backed row with no units[] and no autoClaimSet — neither of
          // the two stock modes utils/playerauctionsFulfiller understands for
          // an archive-backed row (:935) — so every PAID order against it was
          // skipped as a "manual-delivery listing" while the offer stayed live
          // at full quantity. An archive bundle sells here the way the bundle
          // rows in scripts/g2g-bundle-listings.js:260 do: claim the accounts
          // at delivery time, and advertise only what the archive can really
          // hand over. Offer-backed publishing is untouched — its stock is the
          // ledger, and autoClaimSet must stay false there (contract B5).
          //
          // Required lazily: utils/playerauctionsFulfiller pulls in
          // routes/shopRoutes, the proof renderer and the farm service at load,
          // and only this one branch needs any of it.
          let paQty = Math.max(1, parseInt(pa.quantity, 10) || 1);
          if (!offer) {
            const paFulfiller = require("../utils/playerauctionsFulfiller");
            // The very number the stock sync and the delivery claim will use
            // (stockFor's autoClaimSet branch, :519): accounts still holding
            // the whole set, unclaimed, and not already on another live
            // listing. Zero is a refusal, not a live offer — nothing behind it
            // means the first buyer pays for something we cannot ship.
            const paStock = await paFulfiller.stockFor({
              autoClaimSet: true,
              set: set._id,
            });
            if (!paStock) {
              results[name] = {
                success: false,
                message:
                  "Out of stock — no unsold account still holds this whole " +
                  "bundle unclaimed, so a PlayerAuctions order could not be " +
                  "filled",
              };
              continue;
            }
            paQty = Math.min(paQty, paStock);
          }
          r = await mp.playerauctionsPublish({
            game: paGame,
            title,
            description,
            // PlayerAuctions caps an order message at 300 characters, so the
            // long claim guide goes in the offer's instruction field instead
            // (utils/playerauctionsCopy explains the split).
            instruction: pa.instruction || paCopy.bundleInstruction(),
            priceUsd: Math.max(mp.PA_MIN_PRICE, priceUsd),
            itemsPerUnit: (set.items || []).length || 1,
            totalUnit: paQty,
            minUnitPerOrder: 1,
            deliveryGuarantee: mp.PA_DELIVERY.min20,
            coverImagePath: gridImage || coverImagePath(set),
          });
          // playerauctionsPublish answers { offerId, id, url, raw } — NOT
          // { externalId }. externalId is required:true, so the generic tail
          // below would throw a ValidationError AFTER a live offer exists with
          // nothing on our side recording it. utils/autoLister.js:1148 writes
          // r.offerId for exactly this reason.
          const doc = await MarketplaceListing.create({
            set: set._id,
            marketplace: "playerauctions",
            externalId: r.offerId,
            url: r.url || "",
            title,
            description,
            price: Math.max(mp.PA_MIN_PRICE, priceUsd),
            status: "active",
            note: r.note || "",
            qtyTarget: paQty,
            // S5: the stock mode. An archive-backed row claims its accounts
            // when the order lands; an offer-backed one claims from the
            // supplied ledger instead, so this stays false there.
            autoClaimSet: !offer,
            ...(offer ? offerRowFields(offer, []) : {}),
          });
          results[name] = {
            success: true,
            id: String(doc._id),
            externalId: r.offerId,
            url: r.url || "",
            note: r.note || "",
          };
          continue;
        } else if (name === "z2u") {
          // z2uBulkPublish answers { reply, rows, gameName } with NO offer id,
          // and externalId is what every later sale poll, stock sync and
          // delist joins on. A row with an empty externalId is worse than no
          // row: it can never be reconciled and can never be delisted, so it
          // would sit "active" forever over stock nothing is holding.
          results[name] = {
            success: false,
            message:
              "Z2U publishing has no offer id to record — use the Z2U shelf " +
              "keeper",
          };
          logEvent({
            category: "marketplace",
            action: "z2u-publish-refused",
            severity: "warn",
            subject: title,
            detail:
              "manual publish to Z2U refused: z2uBulkPublish returns no " +
              "offer id to store as externalId",
          });
          continue;
        } else {
          results[name] = { success: false, message: "Unknown marketplace" };
          continue;
        }
        const doc = await MarketplaceListing.create({
          set: set._id,
          marketplace: name,
          externalId: r.externalId,
          externalNode: r.externalNode || "",
          url: r.url || "",
          title,
          description,
          price: r.price || priceUsd,
          status: "active",
          note: r.note || "",
          // An offer-backed row carries no set, so without this the schema's
          // widened `set` requirement would refuse it. The claim-at-sale
          // markets (Eldorado, PlayerAuctions, G2G, Z2U) take their supplied
          // account when the order arrives, so units[] is empty here.
          ...(offer ? offerRowFields(offer, []) : {}),
        });
        results[name] = {
          success: true,
          id: String(doc._id),
          externalId: r.externalId,
          url: r.url || "",
          note: r.note || "",
        };
      } catch (err) {
        console.error("publish to " + name + " failed:", err.message);
        results[name] = { success: false, message: err.message };
      }
    }
    if (gridImage) await fsp.unlink(gridImage).catch(() => {});
    res.json({ success: true, results });
  } catch (err) {
    console.error("marketplace publish error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// EpicNPC Filler browser extension download. The extension packages the same
// fill logic as the bookmarklet but runs automatically when a compose tab
// opened from "Sell on EpicNPC" loads — no bookmark click needed. Served as a
// stored zip built from the checked-in extension/ sources so it can never
// drift from the repo.
router.get(
  "/marketplaces/epicnpc/extension.zip",
  requireSuperadmin,
  async (req, res) => {
    try {
      const { buildStoredZip } = require("../utils/storedZip");
      const dir = path.join(__dirname, "..", "extension", "epicnpc-filler");
      const files = [];
      for (const name of await fsp.readdir(dir)) {
        files.push({
          name: "epicnpc-filler/" + name,
          data: await fsp.readFile(path.join(dir, name)),
        });
      }
      const zip = buildStoredZip(files);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="epicnpc-filler.zip"',
      );
      res.send(zip);
    } catch (err) {
      console.error("epicnpc extension zip error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// EpicNPC bridge: EpicNPC has no seller API and is bot-protected, so the server
// can't post the listing. Instead it resolves the game's forum node and builds
// the compose deep-link with the listing payload in the URL hash; the frontend
// opens it in a new tab and the one-time bookmarklet fills the form in the
// seller's own logged-in EpicNPC session. Optionally records the listing so it
// shows in the "published on marketplaces" list.
router.post(
  "/marketplaces/epicnpc/prepare",
  requireSuperadmin,
  async (req, res) => {
    try {
      const body = req.body || {};
      // An account listing posts as well as a set. EpicNPC is a hand-delivered
      // forum thread either way — nothing is claimed from the offer's shelf
      // (utils/suppliedStock NON_SHARING_MARKETS) — so all the offer needs is
      // its own text, plus the drops of the Shop / Custom listing it was
      // copied from, when it was, for the reward lists.
      const offerId = String(body.offerId || "").trim();
      let offer = null;
      let set = null;
      if (offerId) {
        offer = /^[a-f0-9]{24}$/i.test(offerId)
          ? await AccountOffer.findById(offerId).lean()
          : null;
        if (!offer) {
          return res
            .status(404)
            .json({ success: false, message: "Account listing not found" });
        }
        const source = offer.sourceSet
          ? await DropSet.findById(offer.sourceSet).lean()
          : null;
        set = {
          ...setLikeFromOffer(offer),
          items: source && Array.isArray(source.items) ? source.items : [],
        };
      } else {
        set = await DropSet.findById(body.setId).lean();
      }
      if (!set) {
        return res
          .status(404)
          .json({ success: false, message: "Set not found" });
      }
      const game = String(
        body.game || (offer ? offer.game : set.game) || "",
      ).trim();
      const hit = epicnpc.nodeForGame(game);
      if (!hit) {
        return res.status(422).json({
          success: false,
          message: game
            ? '"' +
              game +
              '" has no EpicNPC forum — pick another game or skip EpicNPC for this listing.'
            : "No game given for this listing, so EpicNPC has nowhere to post it.",
        });
      }
      let priceUsd = Number(body.price != null ? body.price : set.price) || 0;
      // An account listing's own floor, as in the /publish route: there is no
      // DropSet behind it for any other guard to read.
      if (offer && Number(offer.minPriceUsd) > 0) {
        priceUsd = Math.max(priceUsd, Number(offer.minPriceUsd));
      }
      const service = body.service === "mm" ? "mm" : "free"; // default TG Free
      // EpicNPC gets its own house-style title + rich (HTML) body rather than
      // the generic set title/description.
      const epic = buildEpicListing(set, game);
      const title = epic.title;
      const payload = {
        title,
        priceUsd,
        descHtml: epic.descHtml,
        description: buildDescription(set), // plain-text fallback
        tier: String(body.tier || "account"),
        tags: String(body.tags || game).slice(0, 200),
        service,
        owner: "Yes",
      };
      const url = epicnpc.buildComposeUrl(hit.node, payload);

      let listingId = "";
      if (body.record) {
        // Bridge posts are manual, so there's no real external id yet; record a
        // placeholder so the row is trackable and dedupable by set+game+node.
        const doc = await MarketplaceListing.create({
          set: set._id,
          marketplace: "epicnpc",
          externalId: "epicnpc:" + hit.node + ":" + Date.now(),
          externalNode: String(hit.node),
          url: "https://www.epicnpc.com/forums/x." + hit.node + "/",
          title,
          description: payload.description,
          price: priceUsd,
          status: "active",
          note:
            "bridge post to " +
            hit.name +
            " (node " +
            hit.node +
            ") — posted manually via bookmarklet" +
            (offer
              ? "; hand the account over yourself and remove it from the " +
                "account listing's stock"
              : ""),
          // An account listing's row: no set, the offer instead, and no units
          // — nothing is claimed for a hand-delivered forum post.
          ...(offer ? offerRowFields(offer, []) : {}),
        });
        listingId = String(doc._id);
      }

      res.json({
        success: true,
        node: hit.node,
        epicName: hit.name,
        game,
        url,
        listingId,
      });
    } catch (err) {
      console.error("epicnpc prepare error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// External listings, optionally for one set.
router.get("/marketplaces/listings", requireSuperadmin, async (req, res) => {
  try {
    const q = {};
    if (req.query.setId) q.set = String(req.query.setId);
    // Account listings are addressed by their offer instead of a set.
    if (req.query.offerId) q.accountOffer = String(req.query.offerId);
    const rows = await MarketplaceListing.find(q)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    res.json({
      success: true,
      listings: rows.map((r) => ({
        id: String(r._id),
        // A set-less row (an account listing) used to serialise the literal
        // string "undefined" here, which the page then sent back as a set id.
        setId: r.set ? String(r.set) : "",
        offerId: r.accountOffer ? String(r.accountOffer) : "",
        marketplace: r.marketplace,
        externalId: r.externalId,
        url: r.url,
        title: r.title,
        price: r.price,
        currency: r.currency,
        status: r.status,
        note: r.note,
        lastError: r.lastError,
        autoDeliver: !!r.autoDeliver,
        qtyRemaining: Number(r.qtyRemaining) || 0,
        // Auto-farmed or the owner's own. Sent so the page can show which rows
        // the post-event markup is allowed to reprice — anything not marked
        // "auto" keeps whatever price it was given.
        origin: r.origin === "auto" ? "auto" : "manual",
        createdAt: r.createdAt,
      })),
    });
  } catch (err) {
    console.error("marketplace listings error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Delist on the marketplace, then mark the row delisted.
router.delete(
  "/marketplaces/listings/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      const row = await MarketplaceListing.findById(req.params.id);
      if (!row) {
        return res
          .status(404)
          .json({ success: false, message: "Listing not found" });
      }
      try {
        if (row.marketplace === "gameflip") {
          await mp.gameflipDelist(row.externalId);
        } else if (row.marketplace === "digiseller") {
          await mp.digisellerDelist(row.externalId);
        } else if (row.marketplace === "g2g") {
          await mp.g2gDelist(row.externalId);
        } else if (row.marketplace === "ggsel") {
          await mp.ggselDelist(row.externalId);
        } else if (row.marketplace === "funpay") {
          await mp.funpayDelist(row.externalId, row.externalNode);
        } else if (row.marketplace === "zeusx") {
          await mp.zeusxDelist(row.externalId);
        } else if (row.marketplace === "eldorado") {
          await mp.eldoradoDelist(row.externalId);
        } else if (row.marketplace === "playerauctions") {
          // Hide, not Cancel: hiding keeps the offer so it can be relisted,
          // while Cancel is permanent.
          await mp.playerauctionsDelist(row.externalId);
        } else if (row.marketplace === "z2u") {
          // off_line, not delete: Z2U keeps a deactivated offer (and its stock)
          // so the shelf keeper can put it back when stock returns, while a
          // delete is permanent and loses the offer id the row is joined on.
          await mp.z2uDelist(row.externalId);
        }
      } catch (err) {
        // Already gone or already sold is not a failed delist: the listing is off
        // sale, which is what was asked. Resolving the row here is what keeps it
        // from sitting active with an error forever, holding an account reserved.
        let outcome = mp.delistOutcome(err.message);
        // A ZeusX account-listing offer that already sold may refuse to be
        // hidden in words delistOutcome does not know. ZeusX's own reading of
        // the offer is the better witness there: if it shows the sale, the
        // delist is answered, and the row must not sit active forever holding
        // up the offer's archive.
        const zxSupplied = row.marketplace === "zeusx" && !!row.accountOffer;
        if (!outcome && zxSupplied) {
          if ((await zeusxUnitVerdict(row.externalId)) === "sold") {
            outcome = "sold";
          }
        }
        if (!outcome) {
          row.lastError = err.message.slice(0, 400);
          await row.save();
          return res.json({ success: false, message: err.message });
        }
        // Sold: the buyer holds that account, so it is NOT handed back to stock.
        if (outcome === "sold") {
          row.status = "sold";
          row.qtyRemaining = 0;
          row.lastError = "";
          await row.save();
          // The ledger learns it too, so the panel counts the account sold
          // rather than parked in ZeusX's vault.
          if (zxSupplied) await markZeusxUnitsDelivered(row);
          // Finding out this way is still finding out it sold — the auto-farmer
          // should learn from it exactly as it would from the sale poller.
          try {
            const soldSet = await DropSet.findById(row.set).lean();
            if (soldSet) {
              await recordListingSale({
                listing: row,
                set: soldSet,
                units: 1,
                priceUsd: Number(row.price) || 0,
              });
            }
          } catch (e) {
            console.error("delist sale learning error:", e.message);
          }
          return res.json({
            success: true,
            message: "Already sold on the marketplace — marked sold here",
          });
        }
        row.note =
          (row.note ? row.note + " " : "") + "gone from the marketplace";
      }
      row.status = "delisted";
      row.lastError = "";
      await row.save();
      // A delisted auto-delivery listing frees its reserved account(s).
      if (row.autoDeliver && row.accountId) {
        if (row.marketplace === "ggsel") {
          await ggFulfiller.releaseAccounts(row.accountId.split(","));
        } else if (row.marketplace === "digiseller") {
          await dsFulfiller.releaseAccounts(row.accountId.split(","));
        } else if (row.marketplace === "funpay") {
          await fpFulfiller.releaseAccounts(row.accountId.split(","));
        } else {
          // Scoped to THIS row's set: a tag-wide Gameflip release frees every
          // "gameflip"-reserved drop on the account, including a different
          // set a buyer has already paid for.
          await gfFulfiller.releaseAccount(row.accountId, row.set);
        }
      }
      // S1 (docs/ACCOUNT-LISTINGS-FIXES-3.md): the release above can never
      // reach owner-supplied stock. An account-listing row leaves `accountId`
      // empty on purpose (contract B5), so that gate is unreachable for it, and
      // the accounts fed to a GGSel/Plati/FunPay vault at publish time stay
      // "fed" forever: excluded from stockFor, with no UI control to bring them
      // back and no other path that ever would. Twenty accounts published to
      // GGSel and then delisted were silently destroyed.
      //
      // F1e widened releaseClaim to accept "fed" rows for exactly this. It
      // still refuses anything with `deliveredAt` set, so a credential that has
      // reached a buyer is never resold — and units carrying an orderId are
      // skipped here too: those belong to a PAID order still mid-delivery, and
      // the fulfillers' resume path claims them back by that id.
      let returned = 0;
      // ZeusX account listings only: why an account did NOT come back.
      let zxVerdict = "";
      if (row.accountOffer) {
        const ledgerIds = [];
        for (const u of row.units || []) {
          // Delivered units are gone for good; everything else is a candidate
          // and the LEDGER decides. This used to also skip any unit carrying an
          // orderId, reading that as "a sale owns this" — but gameflipFulfiller
          // stamps a synthetic publish-attempt orderId on its unit, so a
          // vault-parked Gameflip account was skipped and stranded at "fed"
          // forever (seen live on prod 2026-09-10: delist returned=0). The real
          // question is the ledger status, which releaseClaim now asks below.
          if (!u || !u.contentId || u.deliveredAt) continue;
          ledgerIds.push(String(u.contentId));
        }
        // ZeusX hands an automatic offer's credential over by itself and no
        // poller of ours watches for it, so on ZeusX "fed" cannot tell a parked
        // account from one a buyer already holds — handing it back blind would
        // sell it a second time. Ask ZeusX first. The hide above has already
        // run, so no purchase can land between that answer and this decision.
        if (row.marketplace === "zeusx" && ledgerIds.length) {
          zxVerdict = await zeusxUnitVerdict(row.externalId);
        }
        if (zxVerdict === "sold") {
          row.status = "sold";
          row.note = (row.note ? row.note + " " : "") + "— sold on ZeusX";
          await row.save();
          await markZeusxUnitsDelivered(row);
        } else if (zxVerdict === "unknown") {
          row.note =
            (row.note ? row.note + " " : "") +
            "— account kept out of stock: ZeusX could not confirm it unsold";
          await row.save();
        } else {
          try {
            // "fed" only: a credential parked in a marketplace vault dies with
            // the offer and comes home. One committed to a buyer's order does
            // NOT — delisting an offer does not cancel a sale someone paid for.
            returned = await suppliedStock.releaseClaim(ledgerIds, {
              statuses: ["fed"],
            });
          } catch (err) {
            // The listing IS delisted by now; a failed hand-back must not turn
            // that into a 500 the owner retries against a marketplace that no
            // longer has the offer. The count then answers 0, which is the
            // honest number, and the log line below records the miss.
            console.error("supplied releaseClaim (delist):", err.message);
          }
        }
        logEvent({
          category: "account-listings",
          action: "delist-release",
          subject: String(row.accountOffer),
          count: returned,
          detail:
            returned +
            " supplied account(s) returned to the shelf after delisting " +
            row.marketplace +
            (zxVerdict === "sold"
              ? " (ZeusX shows it sold — kept with its buyer)"
              : zxVerdict === "unknown"
                ? " (ZeusX could not confirm it unsold — kept out of stock)"
                : ""),
        });
      }
      res.json({
        success: true,
        // How many went back on the shelf — the owner's only signal that the
        // stock behind a delisted account listing survived.
        ...(row.accountOffer
          ? {
              returned,
              message:
                zxVerdict === "sold"
                  ? "Already sold on ZeusX — the account stays with its buyer"
                  : zxVerdict === "unknown"
                    ? "Delisted — the account was kept out of stock because " +
                      "ZeusX could not confirm it unsold"
                    : returned + " account(s) returned to this shelf",
            }
          : {}),
      });
    } catch (err) {
      console.error("marketplace delist error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Check every live Gameflip auto-delivery listing against Gameflip, mark the
// ones that sold and relist the next unit of any chain with quantity left.
// (The background watcher does the same every minute; this makes the admin
// page reflect sales immediately.)
router.post("/marketplaces/sync", requireSuperadmin, async (req, res) => {
  try {
    const r = await gfFulfiller.syncOnce();
    res.json({ success: true, ...r });
  } catch (err) {
    console.error("marketplace sync error:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// Push delivery content (account credential lines) to a Digiseller product so
// it becomes sellable/auto-deliverable.
router.post(
  "/marketplaces/listings/:id/content",
  requireSuperadmin,
  async (req, res) => {
    try {
      const row = await MarketplaceListing.findById(req.params.id).lean();
      if (!row) {
        return res
          .status(404)
          .json({ success: false, message: "Listing not found" });
      }
      if (row.marketplace !== "digiseller") {
        return res.status(400).json({
          success: false,
          message: "Content upload is only for Digiseller products",
        });
      }
      const body = req.body || {};
      let lines;
      if (body.accounts != null) {
        // One delivery unit per account line; a template (with {account})
        // wraps each one so buyers also get the redemption instructions.
        const template = String(body.template || "{account}");
        lines = String(body.accounts)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((acc) =>
            template.indexOf("{account}") !== -1
              ? template.split("{account}").join(acc)
              : acc + "\n\n" + template,
          );
      } else {
        lines = String(body.lines || "")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const r = await mp.digisellerAddContent(row.externalId, lines);
      // Manually-added accounts that are also tracked on the server are
      // retired from the sellable pool so they can't be sold twice across
      // platforms.
      let retired = 0;
      if (body.accounts != null) {
        // Reserve the listing's set's drops (per game) on the matched accounts.
        const manualSet = await DropSet.findById(row.set).lean();
        retired = await dsFulfiller.retireManualAccounts(
          String(body.accounts)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
          manualSet,
        );
      }
      res.json({ success: true, added: r.added, retired });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  },
);

// ------------------------------------------------------------------
// Integrity guardian (auto-feed + cross-platform checks + review queue)
// ------------------------------------------------------------------
router.get("/marketplaces/guardian/status", requireSuperadmin, (req, res) => {
  res.json({ success: true, ...guardian.status() });
});

router.post(
  "/marketplaces/guardian/run",
  requireSuperadmin,
  async (req, res) => {
    try {
      const r = await guardian.runOnce();
      res.json({ success: true, lastRun: r });
    } catch (err) {
      console.error("guardian run error:", err.message);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

router.get(
  "/marketplaces/guardian/findings",
  requireSuperadmin,
  async (req, res) => {
    try {
      const q = {};
      const st = String(req.query.status || "");
      if (st) q.status = st;
      const limit = Math.min(
        1000,
        Math.max(1, parseInt(req.query.limit, 10) || 300),
      );
      const rows = await AuditFinding.find(q)
        .sort({ status: 1, severity: 1, lastSeenAt: -1 })
        .limit(limit)
        .lean();
      // Join the referenced listings once, so the tab can group findings per
      // listing and label which ones have a one-click fix.
      const listingIds = [
        ...new Set(rows.map((f) => String(f.listing || "")).filter(Boolean)),
      ];
      const listings = listingIds.length
        ? await MarketplaceListing.find(
            { _id: { $in: listingIds } },
            {
              marketplace: 1,
              externalId: 1,
              title: 1,
              url: 1,
              status: 1,
              qtyTarget: 1,
              // fixPlanFor needs these to decide whether a dead-token unit on
              // a Digiseller product can actually be targeted individually.
              units: 1,
            },
          ).lean()
        : [];
      const lmap = new Map(listings.map((l) => [String(l._id), l]));
      res.json({
        success: true,
        findings: rows.map((f) => {
          const lst = lmap.get(String(f.listing || "")) || null;
          return {
            id: String(f._id),
            type: f.type,
            severity: f.severity,
            marketplace: f.marketplace,
            listingId: f.listing ? String(f.listing) : "",
            listing: lst
              ? {
                  id: String(lst._id),
                  marketplace: lst.marketplace,
                  externalId: lst.externalId,
                  title: lst.title,
                  url: lst.url,
                  status: lst.status,
                  qtyTarget: lst.qtyTarget,
                }
              : null,
            fix: guardianFixes.fixPlanFor(f, lst),
            accountId: f.accountId,
            accountLogin: f.accountLogin,
            message: f.message,
            status: f.status,
            resolution: f.resolution,
            healAttempts: f.healAttempts || 0,
            healLastError: f.healLastError || "",
            detectedAt: f.detectedAt,
            lastSeenAt: f.lastSeenAt,
          };
        }),
      });
    } catch (err) {
      console.error("guardian findings error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// One-click fix: replace the account / re-reserve / detach / retry restock,
// depending on the finding (see utils/guardianFixes.js). Resolves the finding
// on success and answers with a human-readable summary of what was done.
router.post(
  "/marketplaces/guardian/findings/:id/fix",
  requireSuperadmin,
  async (req, res) => {
    try {
      const r = await guardianFixes.fixFinding(req.params.id);
      res.json({ success: true, message: r.message, action: r.action });
    } catch (err) {
      console.error("guardian fix error:", err.message);
      res
        .status(err.status || 500)
        .json({ success: false, message: err.message });
    }
  },
);

// Mark a finding ignored / resolved / open again (human review actions).
router.post(
  "/marketplaces/guardian/findings/:id",
  requireSuperadmin,
  async (req, res) => {
    try {
      const action = String((req.body || {}).action || "");
      if (["ignore", "resolve", "reopen"].indexOf(action) === -1) {
        return res
          .status(400)
          .json({ success: false, message: "Unknown action" });
      }
      const f = await AuditFinding.findById(req.params.id);
      if (!f) {
        return res
          .status(404)
          .json({ success: false, message: "Finding not found" });
      }
      if (action === "reopen") {
        f.status = "open";
        f.resolution = "";
        f.resolvedAt = null;
      } else {
        f.status = action === "ignore" ? "ignored" : "resolved";
        f.resolution = "manually " + f.status;
        f.resolvedAt = new Date();
      }
      await f.save();
      res.json({ success: true });
    } catch (err) {
      console.error("guardian finding update error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// Kick off the periodic market-research scanner (first pass ~1 min after
// boot, then every 12h). Started here so server.js needs no changes.
marketResearch.start();

module.exports = router;
