const fsp = require("fs/promises");
const path = require("path");

const express = require("express");

const { requireSuperadmin } = require("../middleware/auth");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const gfFulfiller = require("../utils/gameflipFulfiller");
const mp = require("../utils/marketplaces");
const { buildSetGridImage } = require("../utils/setImage");

const router = express.Router();

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
// G2G catalog browsing (service -> brand -> product -> attributes)
// ------------------------------------------------------------------
router.get("/marketplaces/g2g/services", requireSuperadmin, async (req, res) => {
  try {
    res.json({ success: true, data: await mp.g2gServices() });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

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

router.get("/marketplaces/g2g/products", requireSuperadmin, async (req, res) => {
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
});

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

// ------------------------------------------------------------------
// Publish / list / delist
// ------------------------------------------------------------------

// Resolve a set's cover image (a locally-cached drop image) to a file path so
// Gameflip gets a photo. Only serves files inside public/.
function coverImagePath(set) {
  const img = ((set.items || [])[0] || {}).image || "";
  if (!img || !img.startsWith("/")) return "";
  const publicDir = path.join(__dirname, "..", "public");
  const p = path.normalize(path.join(publicDir, img));
  if (!p.startsWith(publicDir)) return "";
  return p;
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
    let gridImage = "";
    if (targets.includes("gameflip")) {
      try {
        gridImage = await buildSetGridImage(set);
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
          r = await mp.digisellerPublish({
            title,
            description,
            priceUsd,
            categories: ds.categories,
          });
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
        } else {
          results[name] = { success: false, message: "Unknown marketplace" };
          continue;
        }
        const doc = await MarketplaceListing.create({
          set: set._id,
          marketplace: name,
          externalId: r.externalId,
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
    if (req.query.setId) q.set = req.query.setId;
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
        }
      } catch (err) {
        row.lastError = err.message.slice(0, 400);
        await row.save();
        return res.json({ success: false, message: err.message });
      }
      row.status = "delisted";
      row.lastError = "";
      await row.save();
      // A delisted auto-delivery listing frees its reserved account.
      if (row.autoDeliver && row.accountId) {
        await gfFulfiller.releaseAccount(row.accountId);
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
      res.json({ success: true, added: r.added });
    } catch (err) {
      res.json({ success: false, message: err.message });
    }
  },
);

module.exports = router;
