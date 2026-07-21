const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const AuditFinding = require("../models/AuditFinding");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const dsFulfiller = require("../utils/digisellerFulfiller");
const gfFulfiller = require("../utils/gameflipFulfiller");
const ggFulfiller = require("../utils/ggselFulfiller");
const fpFulfiller = require("../utils/funpayFulfiller");
const guardian = require("../utils/marketplaceGuardian");
const mp = require("../utils/marketplaces");
const { buildG2gBulkFile } = require("../utils/g2gBulk");
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
    else if (name === "funpay") r = await mp.funpayTest();
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
    ...(set.items || []).map(
      (i) => "- " + i.name + (i.game ? " (" + i.game + ")" : ""),
    ),
  ];
  return lines.join("\n").trim();
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

router.post("/marketplaces/publish", requireSuperadmin, async (req, res) => {
  try {
    const body = req.body || {};
    const set = await DropSet.findById(body.setId).lean();
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
    const description = String(body.description || buildDescription(set));
    const priceUsd = Number(body.price != null ? body.price : set.price);
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
      targets.includes("digiseller")
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
        let r;
        if (name === "gameflip") {
          const gfOpts = body.gameflip || {};
          if (gfOpts.autoDeliver) {
            // Auto-delivery chain: one live listing per unit, relisted by the
            // background watcher after each sale until qty is sold.
            const qty = Math.max(1, parseInt(gfOpts.qty, 10) || 1);
            const doc = await gfFulfiller.publishAutoDelivery({
              set,
              title,
              description,
              priceUsd,
              imagePath: gridImage || coverImagePath(set),
              qtyRemaining: qty - 1,
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
            const claimed = await dsFulfiller.claimAccountsForSet(
              set,
              qtyWanted,
            );
            if (!claimed.length) {
              results[name] = {
                success: false,
                message:
                  "Out of stock — no unsold account holds this whole " +
                  "bundle, so there is nothing to auto-deliver",
              };
              continue;
            }
            try {
              r = await mp.digisellerPublish({
                title,
                description,
                priceUsd,
                categories: ds.categories,
              });
              try {
                await mp.digisellerAddContent(
                  r.externalId,
                  claimed.map((c) => c.code),
                );
              } catch (err) {
                // The product exists but got no delivery content — disable it
                // so an empty listing doesn't sit live on Plati.
                await mp.digisellerDelist(r.externalId).catch(() => {});
                throw err;
              }
            } catch (err) {
              await dsFulfiller.releaseAccounts(
                claimed.map((c) => c.accountId),
              );
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
              price: priceUsd,
              status: "active",
              note: dsNote,
              autoDeliver: true,
              accountId: claimed.map((c) => c.accountId).join(","),
              accountLogin: claimed.map((c) => c.login).join(", "),
              qtyTarget: qtyWanted,
            });
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
            categories: ds.categories,
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
          r = await mp.g2gPublish({
            productId: g.productId,
            title,
            description,
            priceUsd,
            qty: g.qty,
            minQty: g.minQty,
            currency: g.currency,
            offerAttributes: g.offerAttributes,
            deliveryMethodIds: g.deliveryMethodIds,
          });
        } else if (name === "ggsel") {
          const gg = body.ggsel || {};
          const ggCover = gridImage || coverImagePath(set);
          if (gg.delivery === "auto") {
            // Real GGSel auto-delivery: reserve up to `quantity` farmed
            // accounts that hold the whole bundle, attach each as an
            // auto-delivered product, and let GGSel fulfil sales itself.
            const qtyWanted = Math.max(1, parseInt(gg.quantity, 10) || 1);
            const claimed = await ggFulfiller.claimAccountsForSet(
              set,
              qtyWanted,
            );
            if (!claimed.length) {
              results[name] = {
                success: false,
                message:
                  "Out of stock — no unsold account holds this whole " +
                  "bundle, so there is nothing to auto-deliver",
              };
              continue;
            }
            try {
              r = await mp.ggselPublish({
                title,
                description,
                priceUsd,
                priceRub: gg.priceRub,
                categoryId: gg.categoryId,
                delivery: "auto",
                instructions: gg.instructions,
                coverImagePath: ggCover,
                products: claimed.map((c) => c.code),
              });
            } catch (err) {
              await ggFulfiller.releaseAccounts(
                claimed.map((c) => c.accountId),
              );
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
            });
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
            categoryId: gg.categoryId,
            quantity: gg.quantity,
            delivery: gg.delivery,
            instructions: gg.instructions,
            coverImagePath: ggCover,
          });
        } else if (name === "funpay") {
          const fp = body.funpay || {};
          if (!fp.nodeId) {
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
            const claimed = await fpFulfiller.claimAccountsForSet(
              set,
              qtyWanted,
            );
            if (!claimed.length) {
              results[name] = {
                success: false,
                message:
                  "Out of stock — no unsold account holds this whole " +
                  "bundle, so there is nothing to auto-deliver",
              };
              continue;
            }
            try {
              r = await mp.funpayPublish({
                nodeId: fp.nodeId,
                title,
                description,
                priceUsd,
                currency: fp.currency,
                priceOverride: fp.priceOverride,
                amount: claimed.length,
                active: fp.active !== false,
                autoDelivery: true,
                secrets: claimed.map((c) => c.line),
                paymentMsg: fpFulfiller.funpayPaymentGuide(),
              });
            } catch (err) {
              await fpFulfiller.releaseAccounts(
                claimed.map((c) => c.accountId),
              );
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
            });
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
            nodeId: fp.nodeId,
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
          price: priceUsd,
          status: "active",
          note: r.note || "",
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

// External listings, optionally for one set.
router.get("/marketplaces/listings", requireSuperadmin, async (req, res) => {
  try {
    const q = {};
    if (req.query.setId) q.set = String(req.query.setId);
    const rows = await MarketplaceListing.find(q)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();
    res.json({
      success: true,
      listings: rows.map((r) => ({
        id: String(r._id),
        setId: String(r.set),
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
        }
      } catch (err) {
        row.lastError = err.message.slice(0, 400);
        await row.save();
        return res.json({ success: false, message: err.message });
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
          await gfFulfiller.releaseAccount(row.accountId);
        }
      }
      res.json({ success: true });
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
        retired = await dsFulfiller.retireManualAccounts(
          String(body.accounts)
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
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
      const rows = await AuditFinding.find(q)
        .sort({ status: 1, severity: 1, lastSeenAt: -1 })
        .limit(300)
        .lean();
      res.json({
        success: true,
        findings: rows.map((f) => ({
          id: String(f._id),
          type: f.type,
          severity: f.severity,
          marketplace: f.marketplace,
          listingId: f.listing ? String(f.listing) : "",
          accountId: f.accountId,
          accountLogin: f.accountLogin,
          message: f.message,
          status: f.status,
          resolution: f.resolution,
          detectedAt: f.detectedAt,
          lastSeenAt: f.lastSeenAt,
        })),
      });
    } catch (err) {
      console.error("guardian findings error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
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

module.exports = router;
