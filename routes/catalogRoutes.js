const crypto = require("crypto");
const express = require("express");

const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const CatalogEvent = require("../models/CatalogEvent");
const CatalogInquiry = require("../models/CatalogInquiry");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const Purchase = require("../models/Purchase");
const SaleSignal = require("../models/SaleSignal");
const { stockForSets } = require("./shopRoutes");
const {
  ensureThumbnail,
  SAFE_FILE,
  thumbnailUrl,
} = require("../utils/catalogImage");
const {
  buildCatalogProfilePlan,
  DEFAULT_MIN_STOCK,
  DEFAULT_MAX_PROFILES_PER_GAME,
} = require("../utils/catalogProfiles");
const {
  catalogReadLimiter,
  catalogEventLimiter,
  catalogInquiryLimiter,
} = require("../utils/rateLimit");

const router = express.Router();
// Stock aggregation spans the complete DropLog archive and can take tens of
// seconds on production data. Keep a bounded snapshot and refresh it in the
// background so public visitors never queue behind the aggregation after the
// first warm-up.
const CACHE_TTL_MS = 5 * 60 * 1000;
let publicCache = { at: 0, data: null };
let publicRefresh = null;

function invalidateCatalogCache() {
  publicCache.at = 0;
  if (publicCache.data) refreshPublicCatalog().catch(() => {});
}

function cleanText(value, max = 120) {
  return String(value || "")
    .split("")
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127 ? " " : char;
    })
    .join("")
    .trim()
    .slice(0, max);
}

function categoryFor(set) {
  const counts = new Map();
  for (const item of set.items || []) {
    const game = cleanText(item.game, 80);
    if (game) counts.set(game, (counts.get(game) || 0) + 1);
  }
  return (
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0] || "Other"
  );
}

function median(values) {
  const rows = values
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!rows.length) return 0;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : (rows[mid - 1] + rows[mid]) / 2;
}

function publicPriceFor(set, marketMedian = 0) {
  const override = Number(set.publicPrice) || 0;
  if (override > 0) return Math.round(override * 100) / 100;
  const retail = Number(set.price) || marketMedian || 0;
  const rawDiscount = Number(set.bulkDiscountPct);
  const discount = Math.max(
    0,
    Math.min(60, Number.isFinite(rawDiscount) ? rawDiscount : 8),
  );
  const floor = Math.max(0, Number(set.minPriceUsd) || 0);
  return Math.round(Math.max(floor, retail * (1 - discount / 100)) * 100) / 100;
}

function inquiryQuantity(value) {
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 1000
    ? quantity
    : 0;
}

function publicListing(set, stock, marketMedian = 0) {
  const category = categoryFor(set);
  const items = (set.items || []).slice(0, 120).map((item) => ({
    name: cleanText(item.name, 120),
    game: cleanText(item.game, 80),
    image: thumbnailUrl(item.image),
    qty: Math.max(1, Math.min(99, Number(item.qty) || 1)),
  }));
  return {
    id: String(set._id),
    category,
    title: cleanText(set.publicTitle || set.name, 140),
    description: cleanText(set.publicDescription || set.note, 600),
    price: publicPriceFor(set, marketMedian),
    retailPrice: Math.round((Number(set.price) || 0) * 100) / 100,
    stock: Math.max(0, Number(stock) || 0),
    minQty: Math.max(1, Math.min(1000, Number(set.bulkMinQty) || 5)),
    featured: !!set.publicFeatured,
    exactProfile: set.sourceType === "catalog_profile",
    itemCount: items.reduce((sum, item) => sum + item.qty, 0),
    items,
    updatedAt: set.updatedAt,
  };
}

function recommendedProfilePrice(
  profile,
  marketMedian = 0,
  catalogPricePerReward = 0,
) {
  const rewards = Math.max(1, Number(profile.totalRewards) || 1);
  const observed = Number(marketMedian) || 0;
  const catalogRate = Number(catalogPricePerReward) || 0;
  const base = catalogRate
    ? catalogRate * rewards
    : observed
      ? observed * Math.max(0.45, Math.min(1.6, rewards / 30))
      : Math.max(0.75, rewards * 0.1);
  return Math.round(Math.max(0.5, base * 0.94) * 100) / 100;
}

async function profilePrices(profiles) {
  const games = [
    ...new Set(profiles.map((profile) => profile.game.toLowerCase())),
  ];
  const [signals, approvedSets] = games.length
    ? await Promise.all([
        SaleSignal.find({
          gameKey: { $in: games },
          source: "listing_sold",
          priceUsd: { $gt: 0 },
        })
          .select("gameKey priceUsd")
          .sort({ at: -1 })
          .limit(5000)
          .lean(),
        DropSet.find({
          listed: true,
          publicCatalog: { $ne: false },
          custom: { $ne: true },
          sourceType: { $ne: "catalog_profile" },
          $or: [{ price: { $gt: 0 } }, { publicPrice: { $gt: 0 } }],
        }).lean(),
      ])
    : [[], []];
  const byGame = new Map();
  for (const signal of signals) {
    const key = String(signal.gameKey || "");
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key).push(Number(signal.priceUsd) || 0);
  }
  const ratesByGame = new Map();
  for (const set of approvedSets) {
    const game = categoryFor(set).toLowerCase();
    const rewards = (set.items || []).reduce(
      (sum, item) => sum + Math.max(1, Number(item.qty) || 1),
      0,
    );
    const price = publicPriceFor(set);
    if (!games.includes(game) || !rewards || !price) continue;
    if (!ratesByGame.has(game)) ratesByGame.set(game, []);
    ratesByGame.get(game).push(price / rewards);
  }
  return new Map(
    profiles.map((profile) => {
      const game = profile.game.toLowerCase();
      const observed = median(byGame.get(game) || []);
      const catalogRate = median(ratesByGame.get(game) || []);
      return [
        profile.sourceEventKey,
        {
          observed,
          catalogRate,
          recommended: recommendedProfilePrice(profile, observed, catalogRate),
        },
      ];
    }),
  );
}

function boundedInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

async function syncInventoryVariants({
  apply = false,
  games = null,
  minStock,
  maxProfilesPerGame,
} = {}) {
  const effectiveMinStock = boundedInt(minStock, 1, 100, DEFAULT_MIN_STOCK);
  const effectiveMaxPerGame = boundedInt(
    maxProfilesPerGame,
    1,
    500,
    DEFAULT_MAX_PROFILES_PER_GAME,
  );
  let targetGames = games;
  if (!Array.isArray(targetGames)) {
    const approvedSets = await DropSet.find(
      {
        listed: true,
        publicCatalog: { $ne: false },
        custom: { $ne: true },
        sourceType: { $ne: "catalog_profile" },
      },
      { items: 1 },
    ).lean();
    targetGames = [
      ...new Set(
        approvedSets.flatMap((set) =>
          (set.items || [])
            .map((item) => String(item.game || "").trim())
            .filter(Boolean),
        ),
      ),
    ];
  }
  const profiles = await buildCatalogProfilePlan({
    games: targetGames,
    minStock: effectiveMinStock,
    maxProfilesPerGame: effectiveMaxPerGame,
  });
  const prices = await profilePrices(profiles);
  const existing = await DropSet.find({ sourceType: "catalog_profile" }).lean();
  const existingByKey = new Map(
    existing.map((set) => [String(set.sourceEventKey || ""), set]),
  );
  const plan = profiles.map((profile) => {
    const current = existingByKey.get(profile.sourceEventKey);
    const price = prices.get(profile.sourceEventKey) || {
      observed: 0,
      catalogRate: 0,
      recommended: recommendedProfilePrice(profile),
    };
    return {
      sourceEventKey: profile.sourceEventKey,
      name: profile.name,
      category: profile.game,
      stock: profile.stock,
      itemCount: profile.totalRewards,
      distinctRewards: profile.distinctRewards,
      observedMedian: Math.round(price.observed * 100) / 100,
      catalogPricePerReward: Math.round(price.catalogRate * 10000) / 10000,
      recommendedPrice: price.recommended,
      currentPrice: Number(current?.publicPrice || current?.price) || 0,
      action: current ? "refresh profile" : "create profile",
      profile,
    };
  });
  if (apply) {
    for (const row of plan) {
      const current = existingByKey.get(row.sourceEventKey);
      const currentPublicPrice = Number(current?.publicPrice) || 0;
      const currentRetailPrice = Number(current?.price) || 0;
      const priceLocked =
        currentPublicPrice > 0 &&
        currentRetailPrice > 0 &&
        Math.abs(currentPublicPrice - currentRetailPrice) > 0.001;
      const publicPrice = priceLocked
        ? currentPublicPrice
        : row.recommendedPrice;
      const retailPrice = priceLocked
        ? currentRetailPrice
        : row.recommendedPrice;
      await DropSet.updateOne(
        { sourceType: "catalog_profile", sourceEventKey: row.sourceEventKey },
        {
          $set: {
            name: row.profile.name,
            note: row.profile.description,
            items: row.profile.items.map((item) => ({
              itemKey: item.itemKey,
              name: item.name,
              game: item.game,
              image: item.image,
              qty: item.count,
            })),
            price: retailPrice,
            listed: true,
            publicCatalog: true,
            publicTitle: row.profile.name,
            publicDescription: row.profile.description,
            publicPrice,
            bulkMinQty: Math.max(1, Math.min(5, row.profile.stock)),
            bulkDiscountPct: 6,
            accountScopeLogins: row.profile.logins,
            accountScopeIds: row.profile.accountIds,
            sourceType: "catalog_profile",
            sourceEventKey: row.sourceEventKey,
            sourceEventName: row.profile.game,
            custom: false,
          },
          $setOnInsert: { publicFeatured: false, publicSort: 0 },
        },
        { upsert: true },
      );
    }
    const activeKeys = plan.map((row) => row.sourceEventKey);
    await DropSet.updateMany(
      {
        sourceType: "catalog_profile",
        sourceEventKey: { $nin: activeKeys },
      },
      { $set: { listed: false, publicCatalog: false } },
    );
    invalidateCatalogCache();
  }
  return {
    applied: apply,
    minStock: effectiveMinStock,
    maxProfilesPerGame: effectiveMaxPerGame,
    count: plan.length,
    games: new Set(plan.map((row) => row.category)).size,
    plan: plan.map(({ profile: _profile, ...row }) => row),
  };
}

router.get("/catalog/thumb/:file", async (req, res) => {
  try {
    const file = String(req.params.file || "");
    if (!SAFE_FILE.test(file)) return res.status(404).end();
    const thumbnail = await ensureThumbnail(file);
    if (!thumbnail) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.type("image/webp").sendFile(thumbnail);
  } catch (err) {
    if (err && err.code !== "ENOENT")
      console.error("catalog thumbnail error:", err.message);
    res.status(404).end();
  }
});

async function buildPublicCatalog() {
  const sets = await DropSet.find({
    listed: true,
    publicCatalog: { $ne: false },
    custom: { $ne: true },
    $or: [{ price: { $gt: 0 } }, { publicPrice: { $gt: 0 } }],
  })
    .sort({ publicFeatured: -1, publicSort: -1, updatedAt: -1 })
    .lean();
  const stockMap = await stockForSets(sets);
  const games = [...new Set(sets.map(categoryFor).map((g) => g.toLowerCase()))];
  const signals = games.length
    ? await SaleSignal.find({
        gameKey: { $in: games },
        source: "listing_sold",
        priceUsd: { $gt: 0 },
      })
        .select("gameKey priceUsd")
        .sort({ at: -1 })
        .limit(1000)
        .lean()
    : [];
  const pricesByGame = new Map();
  for (const signal of signals) {
    const key = String(signal.gameKey || "");
    if (!pricesByGame.has(key)) pricesByGame.set(key, []);
    pricesByGame.get(key).push(Number(signal.priceUsd) || 0);
  }
  const listings = sets.map((set) => {
    const category = categoryFor(set);
    const stock = stockMap.get(String(set._id))?.stock || 0;
    return publicListing(
      set,
      stock,
      median(pricesByGame.get(category.toLowerCase()) || []),
    );
  });
  const categoryMap = new Map();
  for (const listing of listings) {
    if (!categoryMap.has(listing.category)) {
      categoryMap.set(listing.category, {
        name: listing.category,
        listingCount: 0,
        stock: 0,
        fromPrice: 0,
        images: [],
      });
    }
    const row = categoryMap.get(listing.category);
    row.listingCount++;
    row.stock += listing.stock;
    if (listing.price > 0 && (!row.fromPrice || listing.price < row.fromPrice))
      row.fromPrice = listing.price;
    for (const item of listing.items) {
      if (
        item.image &&
        !row.images.includes(item.image) &&
        row.images.length < 4
      )
        row.images.push(item.image);
    }
  }
  const data = {
    generatedAt: new Date().toISOString(),
    categories: [...categoryMap.values()].sort(
      (a, b) => b.stock - a.stock || a.name.localeCompare(b.name),
    ),
    listings,
  };
  return data;
}

function refreshPublicCatalog() {
  if (publicRefresh) return publicRefresh;
  publicRefresh = buildPublicCatalog()
    .then((data) => {
      publicCache = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      publicRefresh = null;
    });
  return publicRefresh;
}

async function loadPublicCatalog() {
  if (publicCache.data) {
    if (Date.now() - publicCache.at < CACHE_TTL_MS) return publicCache.data;
    refreshPublicCatalog().catch((err) =>
      console.error("public catalog refresh error:", err.message),
    );
    return publicCache.data;
  }
  return refreshPublicCatalog();
}

router.get("/catalog/categories", catalogReadLimiter, async (req, res) => {
  try {
    const data = await loadPublicCatalog();
    res.set("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    res.json({
      success: true,
      generatedAt: data.generatedAt,
      categories: data.categories,
    });
  } catch (err) {
    console.error("public catalog categories error:", err.message);
    res
      .status(500)
      .json({ success: false, message: "Catalog is temporarily unavailable" });
  }
});

router.get("/catalog/listings", catalogReadLimiter, async (req, res) => {
  try {
    const data = await loadPublicCatalog();
    const category = cleanText(req.query.category, 80).toLowerCase();
    const q = cleanText(req.query.q, 80).toLowerCase();
    const limit = Math.max(1, Math.min(250, Number(req.query.limit) || 60));
    let listings = data.listings;
    if (category)
      listings = listings.filter(
        (row) => row.category.toLowerCase() === category,
      );
    if (q)
      listings = listings.filter((row) =>
        `${row.title} ${row.description} ${row.items.map((i) => i.name).join(" ")}`
          .toLowerCase()
          .includes(q),
      );
    res.set("Cache-Control", "public, max-age=10, stale-while-revalidate=30");
    res.json({
      success: true,
      listings: listings.slice(0, limit),
      total: listings.length,
    });
  } catch (err) {
    console.error("public catalog listings error:", err.message);
    res
      .status(500)
      .json({ success: false, message: "Catalog is temporarily unavailable" });
  }
});

router.post("/catalog/events", catalogEventLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const allowed = new Set([
      "catalog_view",
      "category_view",
      "listing_view",
      "inquiry_click",
    ]);
    const event = cleanText(body.event, 30);
    const visitor = cleanText(body.visitorId, 80);
    if (!allowed.has(event) || !/^[a-zA-Z0-9_-]{12,80}$/.test(visitor)) {
      return res.status(400).json({ success: false, message: "Invalid event" });
    }
    const category = cleanText(body.category, 80);
    const listingId = /^[a-f0-9]{24}$/i.test(String(body.listingId || ""))
      ? String(body.listingId)
      : "";
    const day = new Date().toISOString().slice(0, 10);
    const secret = process.env.SESSION_SECRET || "catalog-event-fallback";
    const visitorHash = crypto
      .createHmac("sha256", secret)
      .update(visitor)
      .digest("hex");
    const dedupeKey = crypto
      .createHash("sha256")
      .update(
        [day, event, category.toLowerCase(), listingId, visitorHash].join("|"),
      )
      .digest("hex");
    await CatalogEvent.updateOne(
      { dedupeKey },
      {
        $setOnInsert: {
          event,
          category,
          listingId,
          visitorHash,
          dedupeKey,
          at: new Date(),
        },
      },
      { upsert: true },
    );
    res.status(202).json({ success: true });
  } catch (err) {
    if (err && err.code === 11000)
      return res.status(202).json({ success: true });
    console.error("catalog event error:", err.message);
    res.status(500).json({ success: false, message: "Event not recorded" });
  }
});

router.post("/catalog/inquiries", catalogInquiryLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const listingId = String(body.listingId || "");
    const quantity = inquiryQuantity(body.quantity);
    const contact = cleanText(body.contact, 180);
    const note = cleanText(body.note, 800);
    if (
      !/^[a-f0-9]{24}$/i.test(listingId) ||
      contact.length < 3 ||
      quantity < 1
    ) {
      return res.status(400).json({
        success: false,
        message: "Listing, quantity, and contact are required",
      });
    }
    const set = await DropSet.findOne({
      _id: listingId,
      listed: true,
      publicCatalog: { $ne: false },
      custom: { $ne: true },
    }).lean();
    if (!set)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    if (quantity < Math.max(1, Number(set.bulkMinQty) || 5)) {
      return res.status(400).json({
        success: false,
        message: `Minimum order is ${Math.max(1, Number(set.bulkMinQty) || 5)}`,
      });
    }
    const inquiry = await CatalogInquiry.create({
      listing: set._id,
      listingTitle: cleanText(set.publicTitle || set.name, 140),
      category: categoryFor(set),
      quantity,
      contact,
      note,
    });
    res.status(201).json({
      success: true,
      reference: `RQ-${String(inquiry._id).slice(-8).toUpperCase()}`,
    });
  } catch (err) {
    console.error("catalog inquiry error:", err.message);
    res
      .status(500)
      .json({ success: false, message: "Quote request could not be sent" });
  }
});

async function adminOverview() {
  const data = await loadPublicCatalog();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [events, purchases, external, inquiries, adminSets] = await Promise.all(
    [
      CatalogEvent.aggregate([
        { $match: { at: { $gte: since } } },
        { $group: { _id: "$event", count: { $sum: 1 } } },
      ]),
      Purchase.find({ createdAt: { $gte: since }, refundedAt: null })
        .select("setId price")
        .lean(),
      MarketplaceListing.find({
        updatedAt: { $gte: since },
        $or: [{ status: "sold" }, { unitsSold: { $gt: 0 } }],
      })
        .select("set status unitsSold price marketplace")
        .lean(),
      CatalogInquiry.find().sort({ createdAt: -1 }).limit(50).lean(),
      DropSet.find({ listed: true, custom: { $ne: true } })
        .sort({ publicFeatured: -1, publicSort: -1, updatedAt: -1 })
        .lean(),
    ],
  );
  const adminStock = await stockForSets(adminSets);
  const adminListings = adminSets.map((set) => ({
    ...publicListing(set, adminStock.get(String(set._id))?.stock || 0),
    visible: set.publicCatalog !== false,
    publicTitle: cleanText(set.publicTitle, 140),
    publicDescription: cleanText(set.publicDescription, 600),
    publicPrice: Number(set.publicPrice) || 0,
    bulkDiscountPct: Number(set.bulkDiscountPct) || 0,
    publicSort: Number(set.publicSort) || 0,
  }));
  const eventCounts = Object.fromEntries(
    events.map((row) => [row._id, row.count]),
  );
  return {
    generatedAt: data.generatedAt,
    totals: {
      categories: data.categories.length,
      listings: data.listings.length,
      inStockListings: data.listings.filter((row) => row.stock > 0).length,
      units: data.listings.reduce((sum, row) => sum + row.stock, 0),
      views30d:
        (eventCounts.catalog_view || 0) +
        (eventCounts.category_view || 0) +
        (eventCounts.listing_view || 0),
      inquiries30d: eventCounts.inquiry_click || 0,
      shopSales30d: purchases.length,
      shopRevenue30d:
        Math.round(
          purchases.reduce((sum, row) => sum + (Number(row.price) || 0), 0) *
            100,
        ) / 100,
      marketplaceSales30d: external.reduce(
        (sum, row) =>
          sum +
          Math.max(row.status === "sold" ? 1 : 0, Number(row.unitsSold) || 0),
        0,
      ),
      openInquiries: inquiries.filter(
        (row) => row.status === "new" || row.status === "contacted",
      ).length,
    },
    categories: data.categories,
    listings: adminListings,
    inquiries: inquiries.map((row) => ({
      id: String(row._id),
      listingTitle: row.listingTitle,
      category: row.category,
      quantity: row.quantity,
      contact: row.contact,
      note: row.note,
      status: row.status,
      createdAt: row.createdAt,
    })),
  };
}

router.get(
  "/catalog/admin/overview",
  requireSuperadmin,
  enforce2fa,
  async (req, res) => {
    try {
      res.json({ success: true, ...(await adminOverview()) });
    } catch (err) {
      console.error("catalog admin overview error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.put(
  "/catalog/admin/listings/:id",
  requireSuperadmin,
  enforce2fa,
  async (req, res) => {
    try {
      const set = await DropSet.findById(req.params.id);
      if (!set)
        return res
          .status(404)
          .json({ success: false, message: "Listing not found" });
      const body = req.body || {};
      if (body.publicCatalog !== undefined)
        set.publicCatalog = !!body.publicCatalog;
      if (body.publicFeatured !== undefined)
        set.publicFeatured = !!body.publicFeatured;
      if (body.publicTitle !== undefined)
        set.publicTitle = cleanText(body.publicTitle, 140);
      if (body.publicDescription !== undefined)
        set.publicDescription = cleanText(body.publicDescription, 600);
      const numericRules = {
        publicPrice: [0, 1000000],
        bulkMinQty: [1, 1000],
        bulkDiscountPct: [0, 60],
        publicSort: [-1000000, 1000000],
      };
      for (const [field, [min, max]] of Object.entries(numericRules)) {
        if (body[field] === undefined) continue;
        const value = Number(body[field]);
        if (!Number.isFinite(value) || value < min || value > max)
          return res
            .status(400)
            .json({ success: false, message: `Invalid ${field}` });
        set[field] = value;
      }
      await set.save();
      invalidateCatalogCache();
      res.json({ success: true });
    } catch (err) {
      console.error("catalog listing update error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

router.put(
  "/catalog/admin/inquiries/:id",
  requireSuperadmin,
  enforce2fa,
  async (req, res) => {
    try {
      const status = cleanText(req.body && req.body.status, 20);
      if (!["new", "contacted", "closed", "spam"].includes(status)) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid status" });
      }
      const inquiry = await CatalogInquiry.findByIdAndUpdate(
        req.params.id,
        { status },
        { new: true },
      );
      if (!inquiry)
        return res
          .status(404)
          .json({ success: false, message: "Inquiry not found" });
      res.json({ success: true });
    } catch (err) {
      console.error("catalog inquiry update error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

// The variant sync scans the whole DropLog archive and can run ~1 minute —
// well past proxy/browser timeouts. Run it in the background and let the admin
// page poll for the result instead of holding the HTTP request open (a stuck
// synchronous request was why applied syncs never committed).
let variantSyncJob = {
  running: false,
  apply: false,
  startedAt: 0,
  finishedAt: 0,
  result: null,
  error: null,
};
function publicVariantJob() {
  return { ...variantSyncJob };
}

router.post(
  "/catalog/admin/sync-variants",
  requireSuperadmin,
  enforce2fa,
  (req, res) => {
    if (variantSyncJob.running) {
      return res.status(409).json({
        success: false,
        message: "A variant sync is already running.",
        job: publicVariantJob(),
      });
    }
    const body = req.body || {};
    const apply = body.apply === true;
    const games = Array.isArray(body.games) ? body.games : null;
    variantSyncJob = {
      running: true,
      apply,
      startedAt: Date.now(),
      finishedAt: 0,
      result: null,
      error: null,
    };
    (async () => {
      try {
        variantSyncJob.result = await syncInventoryVariants({
          apply,
          games,
          minStock: body.minStock,
          maxProfilesPerGame: body.maxProfilesPerGame,
        });
      } catch (err) {
        console.error("catalog inventory variant sync error:", err.message);
        variantSyncJob.error = err.message || "Sync failed";
      } finally {
        variantSyncJob.running = false;
        variantSyncJob.finishedAt = Date.now();
      }
    })();
    res
      .status(202)
      .json({ success: true, started: true, apply, job: publicVariantJob() });
  },
);

router.get(
  "/catalog/admin/sync-variants/status",
  requireSuperadmin,
  enforce2fa,
  (req, res) => {
    res.json({ success: true, job: publicVariantJob() });
  },
);

router.post(
  "/catalog/admin/auto-list",
  requireSuperadmin,
  enforce2fa,
  async (req, res) => {
    try {
      const apply = req.body && req.body.apply === true;
      const sets = await DropSet.find({ custom: { $ne: true } }).sort({
        updatedAt: -1,
      });
      const stockMap = await stockForSets(sets);
      const games = [
        ...new Set(sets.map(categoryFor).map((g) => g.toLowerCase())),
      ];
      const signals = await SaleSignal.find({
        gameKey: { $in: games },
        source: "listing_sold",
        priceUsd: { $gt: 0 },
      })
        .select("gameKey priceUsd")
        .sort({ at: -1 })
        .limit(2000)
        .lean();
      const byGame = new Map();
      for (const row of signals) {
        if (!byGame.has(row.gameKey)) byGame.set(row.gameKey, []);
        byGame.get(row.gameKey).push(Number(row.priceUsd) || 0);
      }
      const plan = [];
      for (const set of sets) {
        const stock = stockMap.get(String(set._id))?.stock || 0;
        if (!stock || !(set.items || []).length) continue;
        const category = categoryFor(set);
        const observed = median(byGame.get(category.toLowerCase()) || []);
        const base = observed || Number(set.price) || 0;
        if (!base) continue;
        const recommended =
          Math.round(
            Math.max(Number(set.minPriceUsd) || 0, base * 0.94) * 100,
          ) / 100;
        plan.push({
          id: String(set._id),
          name: set.name,
          category,
          stock,
          currentPrice: Number(set.publicPrice) || 0,
          recommendedPrice: recommended,
          observedMedian: Math.round(observed * 100) / 100,
          action:
            set.listed && set.publicCatalog !== false ? "update" : "publish",
        });
        if (apply) {
          set.listed = true;
          set.publicCatalog = true;
          set.publicPrice = recommended;
          if (!(Number(set.price) > 0)) set.price = recommended;
          if (!set.bulkMinQty) set.bulkMinQty = 5;
          await set.save();
        }
      }
      if (apply) invalidateCatalogCache();
      res.json({ success: true, applied: apply, count: plan.length, plan });
    } catch (err) {
      console.error("catalog auto-list error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
  },
);

module.exports = router;
module.exports.categoryFor = categoryFor;
module.exports.publicPriceFor = publicPriceFor;
module.exports.recommendedProfilePrice = recommendedProfilePrice;
module.exports.inquiryQuantity = inquiryQuantity;
module.exports.invalidateCatalogCache = invalidateCatalogCache;
module.exports.warmPublicCatalog = refreshPublicCatalog;
module.exports.syncInventoryVariants = syncInventoryVariants;
