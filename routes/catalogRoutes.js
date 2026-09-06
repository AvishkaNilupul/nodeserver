const crypto = require("crypto");
const express = require("express");

const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const CatalogEvent = require("../models/CatalogEvent");
const CatalogInquiry = require("../models/CatalogInquiry");
const CatalogSnapshot = require("../models/CatalogSnapshot");
const DropSet = require("../models/DropSet");
const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const MarketplaceListing = require("../models/MarketplaceListing");
const MarketResearch = require("../models/MarketResearch");
const Purchase = require("../models/Purchase");
const SaleSignal = require("../models/SaleSignal");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const { stockForSets } = require("./shopRoutes");
const { stockForSetFromHoldings } = require("./shopRoutes");
const { AVAILABLE_DROP } = require("../utils/dropReservation");
const accountState = require("../utils/twitchAccountState");
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
const {
  computePreorderEta,
  syncActivePreorders,
  syncHistoricalEventSets,
} = require("../utils/catalogPreorder");
const {
  getCatalogConfig,
  setCatalogConfig,
  getUnclaimedPricing,
  gameFloorFor,
} = require("../utils/settings");
const { sendTelegram } = require("../utils/telegram");
const {
  deriveTitle,
  dedupeListings,
  unclaimedSummary,
  buyLinksFor,
  scheduleEta,
  assertPublicShape,
} = require("../utils/catalogPublic");

// The unclaimed-farms engine (utils/unclaimedAutoList.js) pulls in the host
// bridge, marketplaces and fulfillers. It is only needed to price unclaimed
// sets for the public catalog, so it is required lazily on first use — never
// at module load — and a missing/broken module just means "no engine price".
function loadUnclaimedAutoList() {
  try {
    return require("../utils/unclaimedAutoList");
  } catch (err) {
    console.error("catalog unclaimed engine unavailable:", err.message);
    return null;
  }
}

const router = express.Router();
// Stock aggregation spans the complete DropLog archive and can take tens of
// seconds on production data. Keep a bounded snapshot and refresh it in the
// background so public visitors never queue behind the aggregation after the
// first warm-up.
const CACHE_TTL_MS = 5 * 60 * 1000;
const NEW_LISTING_MS = 24 * 60 * 60 * 1000;
const PUBLIC_PRICE_MIN_USD = 1.01;
const PUBLIC_PRICE_MAX_USD = 2.99;
// Ceiling for an admin-entered publicPrice override. Farmed bundles are still
// clamped to PUBLIC_PRICE_MAX_USD when displayed; unclaimed sets are not, so
// the override must be able to carry a real marketplace price.
const PUBLIC_PRICE_ADMIN_MAX_USD = 500;
const PUBLIC_STOCK_BATCH_SIZE = 25;
const PUBLIC_STOCK_KEY_BATCH_SIZE = 10;
const PUBLIC_STOCK_KEY_CONCURRENCY = 12;
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
    if (!game) continue;
    const key = game.toLowerCase();
    const row = counts.get(key) || { count: 0, labels: new Map() };
    row.count++;
    row.labels.set(game, (row.labels.get(game) || 0) + 1);
    counts.set(key, row);
  }
  return (
    [...counts.values()]
      .map((row) => ({
        count: row.count,
        label: [...row.labels.entries()].sort(
          (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
        )[0][0],
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))[0]
      ?.label || "Other"
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

function clampPublicPrice(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return PUBLIC_PRICE_MIN_USD;
  return Math.min(
    PUBLIC_PRICE_MAX_USD,
    Math.max(PUBLIC_PRICE_MIN_USD, Math.round(amount * 100) / 100),
  );
}

// Price options shared by publicPriceFor / publicPriceTiers (contract §7.1):
//   clamp  — default true: the owner's $1.01–$2.99 rule for farmed bundles and
//            pre-orders. false = unclaimed sets, whose engine price + sold
//            floor must never be capped below the marketplace price.
//   floor  — extra floor folded into the set's own minPriceUsd (default 0).
//   retail — overrides `Number(set.price) || marketMedian` when > 0.
// Without options every helper is byte-identical to the original behaviour.
const UNCLAMPED_PRICE_MIN_USD = 0.25;

function priceOptions(opts) {
  return opts && typeof opts === "object" ? opts : {};
}

function priceRetail(set, marketMedian, opts) {
  const custom = Number(priceOptions(opts).retail);
  if (Number.isFinite(custom) && custom > 0) return custom;
  return Number(set.price) || marketMedian || 0;
}

function priceFloor(set, opts) {
  return Math.max(
    0,
    Number(set.minPriceUsd) || 0,
    Number(priceOptions(opts).floor) || 0,
  );
}

// Final rounding: the owner's clamp by default; with clamp:false round to
// cents and only enforce `>= max(floor, 0.25)` so an unclaimed set is never
// advertised at $0.
function finishPublicPrice(value, opts) {
  const options = priceOptions(opts);
  if (options.clamp !== false) return clampPublicPrice(value);
  const amount = Number(value);
  const rounded = Number.isFinite(amount) ? Math.round(amount * 100) / 100 : 0;
  const floor = Math.max(Number(options.floor) || 0, UNCLAMPED_PRICE_MIN_USD);
  return Math.round(Math.max(rounded, floor) * 100) / 100;
}

function publicPriceFor(set, marketMedian = 0, opts = {}) {
  const override = Number(set.publicPrice) || 0;
  if (override > 0) return finishPublicPrice(override, opts);
  const retail = priceRetail(set, marketMedian, opts);
  const rawDiscount = Number(set.bulkDiscountPct);
  const discount = Math.max(
    0,
    Math.min(60, Number.isFinite(rawDiscount) ? rawDiscount : 8),
  );
  const floor = priceFloor(set, opts);
  return finishPublicPrice(
    Math.max(floor, retail * (1 - discount / 100)),
    opts,
  );
}

function publicPriceTiers(set, marketMedian = 0, opts = {}) {
  const minQty = Math.max(1, Math.min(1000, Number(set.bulkMinQty) || 5));
  const retail = priceRetail(set, marketMedian, opts);
  const override = Math.max(0, Number(set.publicPrice) || 0);
  const floor = priceFloor(set, opts);
  const rawDiscount = Number(set.bulkDiscountPct);
  const discount = Math.max(
    0,
    Math.min(60, Number.isFinite(rawDiscount) ? rawDiscount : 8),
  );
  const quantities = [
    minQty,
    Math.max(minQty * 5, 50),
    Math.max(minQty * 10, 100),
  ];
  return quantities
    .filter((quantity, index) => !index || quantity > quantities[index - 1])
    .map((quantity, index) => ({
      quantity,
      price:
        index === 0
          ? publicPriceFor(set, marketMedian, opts)
          : override
            ? finishPublicPrice(Math.max(floor, override), opts)
            : finishPublicPrice(
                Math.max(
                  floor,
                  retail * (1 - Math.min(60, discount + index * 5) / 100),
                ),
                opts,
              ),
    }));
}

function inquiryQuantity(value) {
  const quantity = Number(value);
  return Number.isInteger(quantity) && quantity >= 1 && quantity <= 1000
    ? quantity
    : 0;
}

async function stockForSetsBatched(
  sets,
  stockReader = null,
  batchSize = PUBLIC_STOCK_BATCH_SIZE,
) {
  if (!stockReader) {
    const result = new Map();
    const keys = [
      ...new Set(
        sets.flatMap((set) =>
          (set.items || []).map((item) => item.itemKey).filter(Boolean),
        ),
      ),
    ];
    if (!keys.length) {
      for (const set of sets)
        result.set(String(set._id), { stock: 0, topItems: [] });
      return result;
    }
    const rows = [];
    for (
      let index = 0;
      index < keys.length;
      index += PUBLIC_STOCK_KEY_BATCH_SIZE * PUBLIC_STOCK_KEY_CONCURRENCY
    ) {
      const chunk = keys.slice(
        index,
        index + PUBLIC_STOCK_KEY_BATCH_SIZE * PUBLIC_STOCK_KEY_CONCURRENCY,
      );
      const parts = await Promise.all(
        Array.from({ length: PUBLIC_STOCK_KEY_CONCURRENCY }, (_, offset) => {
          const keyBatch = chunk.slice(
            offset * PUBLIC_STOCK_KEY_BATCH_SIZE,
            (offset + 1) * PUBLIC_STOCK_KEY_BATCH_SIZE,
          );
          if (!keyBatch.length) return [];
          return DropLog.aggregate([
            { $match: { itemKey: { $in: keyBatch }, ...AVAILABLE_DROP } },
            {
              $group: {
                _id: { account: "$account", k: "$itemKey" },
                count: { $sum: "$count" },
              },
            },
          ]);
        }),
      );
      rows.push(...parts.flat());
    }
    const byAccount = new Map();
    for (const row of rows) {
      const accountId = String(row._id?.account || "");
      if (!accountId) continue;
      if (!byAccount.has(accountId)) byAccount.set(accountId, new Map());
      const counts = byAccount.get(accountId);
      counts.set(String(row._id.k), Number(row.count) || 0);
    }
    const accounts = await BotAccount.find(
      { _id: { $in: [...byAccount.keys()] } },
      { login: 1, credPassword: 1, hasPassword: 1, lastScanStatus: 1 },
    ).lean();
    const holdings = accounts
      .filter(
        (account) =>
          account.credPassword &&
          String(account.credPassword).length > 0 &&
          !accountState.isUnusableScanStatus(account.lastScanStatus),
      )
      .map((account) => ({
        accountId: String(account._id),
        login: account.login || "",
        counts: byAccount.get(String(account._id)) || new Map(),
      }));
    for (const set of sets) {
      result.set(String(set._id), stockForSetFromHoldings(set, holdings));
    }
    return result;
  }
  const result = new Map();
  const size = Math.max(1, Number(batchSize) || PUBLIC_STOCK_BATCH_SIZE);
  for (let index = 0; index < sets.length; index += size) {
    const batch = await stockReader(sets.slice(index, index + size));
    for (const [setId, stock] of batch) result.set(setId, stock);
  }
  return result;
}

const LISTING_KINDS = new Set(["bundle", "preorder", "unclaimed"]);

// Public single-unit buy links, re-shaped so only the four public fields ever
// reach the payload whatever the caller hands in.
function publicBuyLinks(links) {
  return (Array.isArray(links) ? links : [])
    .filter((link) => link && typeof link === "object")
    .map((link) => ({
      marketplace: cleanText(link.marketplace, 40),
      label: cleanText(link.label, 60),
      url: String(link.url || ""),
      price: Math.max(0, Math.round((Number(link.price) || 0) * 100) / 100),
    }));
}

// `extra` (contract §7.2) = { kind, delivery, eventLabel, buyLinks,
// mergedCount, priceOpts } plus an optional `category` override used when an
// unclaimed set's items carry no game (categoryFor → "Other") and the caller
// resolved a better label from the set cover / ledger. Absent extras keep the
// original output, plus the always-present kind/delivery/buyLinks/mergedCount.
function publicListing(
  set,
  stock,
  marketMedian = 0,
  preorder = null,
  extra = {},
) {
  const ext = extra && typeof extra === "object" ? extra : {};
  const category = cleanText(ext.category, 80) || categoryFor(set);
  const items = (set.items || []).slice(0, 120).map((item) => ({
    name: cleanText(item.name, 120),
    game: cleanText(item.game, 80),
    image: thumbnailUrl(item.image),
    qty: Math.max(1, Math.min(99, Number(item.qty) || 1)),
  }));
  const kind = LISTING_KINDS.has(ext.kind)
    ? ext.kind
    : set.catalogState === "preorder"
      ? "preorder"
      : "bundle";
  const unclaimed = kind === "unclaimed";
  const delivery =
    ext.delivery === "unclaimed" || ext.delivery === "claimed"
      ? ext.delivery
      : unclaimed
        ? "unclaimed"
        : "claimed";
  const eventLabel = cleanText(ext.eventLabel, 180);
  const priceOpts = priceOptions(ext.priceOpts);
  const state = unclaimed
    ? stock > 0
      ? "instock"
      : "soldout"
    : set.catalogState === "preorder"
      ? "preorder"
      : stock > 0
        ? "instock"
        : "soldout";
  const createdAt = set.createdAt || set.farmStartedAt || set.updatedAt || null;
  const createdMs = createdAt ? new Date(createdAt).getTime() : 0;
  return {
    id: String(set._id),
    category,
    kind,
    delivery,
    title: cleanText(deriveTitle({ set, category, kind, eventLabel }), 140),
    // An unclaimed set's note is the engine's internal marker ("Unclaimed
    // auto-list"), never buyer copy: describe the product instead unless the
    // owner wrote a public description.
    description: cleanText(
      set.publicDescription ||
        (unclaimed
          ? `${items.length} unclaimed Twitch drop${items.length === 1 ? "" : "s"} for ${category}${eventLabel ? ` (${eventLabel})` : ""}. You log in, link your own game account, then claim the rewards yourself.`
          : set.note),
      600,
    ),
    price: publicPriceFor(set, marketMedian, priceOpts),
    // For unclaimed sets the reference price is the engine price the public
    // price was derived from, not the set's stale marketplace price.
    retailPrice:
      Math.round(
        (unclaimed && Number(priceOpts.retail) > 0
          ? Number(priceOpts.retail)
          : Number(set.price) || 0) * 100,
      ) / 100,
    stock: Math.max(0, Number(stock) || 0),
    minQty: Math.max(1, Math.min(1000, Number(set.bulkMinQty) || 5)),
    bulkDiscountPct: Math.max(
      0,
      Math.min(60, Number(set.bulkDiscountPct) || 0),
    ),
    priceTiers: publicPriceTiers(set, marketMedian, priceOpts),
    featured: !!set.publicFeatured,
    exactProfile: unclaimed ? false : set.sourceType === "catalog_profile",
    itemCount: items.reduce((sum, item) => sum + item.qty, 0),
    items,
    createdAt,
    updatedAt: set.updatedAt,
    isNew:
      Number.isFinite(createdMs) && createdMs > Date.now() - NEW_LISTING_MS,
    state,
    eventName: unclaimed
      ? eventLabel
      : cleanText(set.sourceEventName || set.name, 180),
    campaignEndsAt: set.campaignEndAt || null,
    buyLinks: publicBuyLinks(ext.buyLinks),
    mergedCount: Math.max(0, Number(ext.mergedCount) || 0),
    ...(state === "preorder"
      ? {
          preorder: {
            expectedUnits: Math.max(0, Number(set.expectedUnits) || 0),
            startedAt: set.farmStartedAt || null,
            ...(preorder || {}),
          },
        }
      : {}),
  };
}

async function updateAutofarmCatalogStates() {
  const sets = await DropSet.find({
    sourceType: "autofarm_event",
    listed: true,
    catalogState: "preorder",
  }).lean();
  if (!sets.length) return 0;
  // Atlas shared-tier aggregations cannot spill to disk. Keeping one logical
  // stock read while bounding each aggregation prevents a large catalog from
  // crossing MongoDB's 100 MB $group ceiling as historical event sets grow.
  const stockMap = await stockForSetsBatched(sets);
  const tasks = await AutoFarmTask.find(
    { _id: { $in: sets.map((set) => set.autoFarmTaskId).filter(Boolean) } },
    { status: 1 },
  ).lean();
  const taskStatus = new Map(
    tasks.map((task) => [String(task._id), task.status]),
  );
  let changed = 0;
  for (const set of sets) {
    const stock = stockMap.get(String(set._id))?.stock || 0;
    const status = taskStatus.get(String(set.autoFarmTaskId));
    let next = set.catalogState;
    let listed = set.listed;
    if (stock > 0) next = "instock";
    else if (["completed", "stopped"].includes(status)) next = "soldout";
    if (
      stock === 0 &&
      set.campaignEndAt &&
      new Date(set.campaignEndAt) < new Date()
    )
      listed = false;
    if (next !== set.catalogState || listed !== set.listed) {
      await DropSet.updateOne(
        { _id: set._id },
        { $set: { catalogState: next, listed } },
      );
      changed++;
    }
  }
  if (changed) invalidateCatalogCache();
  return changed;
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
        ? clampPublicPrice(currentPublicPrice)
        : clampPublicPrice(row.recommendedPrice);
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

const OBJECT_ID = /^[a-f0-9]{24}$/i;

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Per-build memo for the unclaimed engine lookups: one event catalog and one
// MarketResearch read per category, however many sets share that game.
function unclaimedPriceMemo() {
  return { catalog: new Map(), research: new Map() };
}

// Engine price for an unclaimed set — the same analytics price the unclaimed
// auto-lister publishes at (event classification + market research + the
// set's recent sold floor). Returns { price, soldFloor } or null on ANY
// failure, so the catalog still builds without the engine.
async function unclaimedSuggestedPrice(
  set,
  category,
  memo = unclaimedPriceMemo(),
) {
  try {
    const engine = loadUnclaimedAutoList();
    if (!engine) return null;
    const key = String(category || "").toLowerCase();
    if (!memo.catalog.has(key)) {
      memo.catalog.set(
        key,
        Promise.resolve(engine.catalogForGames([category])).catch(
          () => new Map(),
        ),
      );
    }
    if (!memo.research.has(key)) {
      memo.research.set(
        key,
        Promise.resolve(
          MarketResearch.findOne({
            game: new RegExp(`^${escapeRegExp(category)}$`, "i"),
          }).lean(),
        ).catch(() => null),
      );
    }
    const [catalog, research] = await Promise.all([
      memo.catalog.get(key),
      memo.research.get(key),
    ]);
    const cls = await engine.classificationForSet(set, catalog);
    const soldFloor = Math.max(
      0,
      Number(await engine.soldFloorForSet(set._id)) || 0,
    );
    const priced = engine.priceForItems({
      research,
      game: category,
      items: set.items || [],
      cls,
      pricing: getUnclaimedPricing(),
      soldFloorUsd: soldFloor,
    });
    const price = Number(priced && priced.price);
    return {
      price: Number.isFinite(price) && price > 0 ? price : 0,
      soldFloor,
    };
  } catch (err) {
    console.error("catalog unclaimed price error:", err.message);
    return null;
  }
}

// Pre-order ETA (contract §7.3c): live farmingProgress rows first; when they
// yield no readyInMinutes (no rows yet, or a stale snapshot) fall back to the
// schedule estimate from farmStartedAt + the campaign's top-tier watch
// minutes, keeping a progress-derived progressPercent when there is one.
// expectedUnits comes from the task's assigned accounts, else the set.
function preorderEtaFor(set, task, accountsByLogin) {
  const progress = task
    ? computePreorderEta(
        (task.assignedAccounts || [])
          .map((login) => accountsByLogin.get(String(login).toLowerCase()))
          .filter(Boolean),
        task.campaignName,
      )
    : null;
  let eta = progress && typeof progress === "object" ? { ...progress } : {};
  if (Number.isFinite(Number(eta.readyInMinutes))) {
    eta.etaSource = "progress";
  } else {
    const schedule = scheduleEta({
      farmStartedAt: set.farmStartedAt,
      requiredWatchMinutes: set.requiredWatchMinutes,
    });
    if (schedule) {
      const percent = Number(eta.progressPercent);
      eta = {
        ...eta,
        ...schedule,
        ...(Number.isFinite(percent) ? { progressPercent: percent } : {}),
      };
    }
  }
  const assigned = Array.isArray(task?.assignedAccounts)
    ? task.assignedAccounts.length
    : 0;
  eta.expectedUnits = assigned || Math.max(0, Number(set.expectedUnits) || 0);
  return eta;
}

// Which DropSet's MarketplaceListing rows are this catalog set's single-unit
// buy links (contract §7.3d): orphan mirrors name their source set in the
// key, stack mirrors use the task's stack listing, event mirrors and
// pre-orders the task's main listing. Anything without a usable task id
// (manual and catalog_profile sets) falls back to its own id — marketplace
// rows for those reference the set directly.
function buySourceIdFor(set, task) {
  const key = String(set.sourceEventKey || "");
  let source = "";
  if (key.startsWith("autofarm:set:")) {
    source = key.slice("autofarm:set:".length);
  } else if (key.startsWith("autofarm-stack:")) {
    source = String(task?.stackListing?.setId || "");
  } else {
    source = String(task?.listing?.setId || "");
  }
  return OBJECT_ID.test(source) ? source : String(set._id);
}

async function buildPublicCatalog() {
  const t0 = Date.now();
  const sets = await DropSet.find({
    listed: true,
    publicCatalog: { $ne: false },
    custom: { $ne: true },
    $or: [{ price: { $gt: 0 } }, { publicPrice: { $gt: 0 } }],
  })
    .sort({ publicFeatured: -1, publicSort: -1, updatedAt: -1 })
    .lean();
  const stockMap = await stockForSetsBatched(sets);
  const preorderSets = sets.filter((set) => set.catalogState === "preorder");
  // (b) ONE task read for every set that names a task: pre-orders need the
  // assigned accounts for their ETA, and every autofarm mirror needs the
  // task's listing / stack-listing set id to find its marketplace buy links.
  const taskIds = [
    ...new Set(
      sets
        .map((set) => String(set.autoFarmTaskId || ""))
        .filter((id) => OBJECT_ID.test(id)),
    ),
  ];
  const tasks = taskIds.length
    ? await AutoFarmTask.find(
        { _id: { $in: taskIds } },
        "assignedAccounts campaignName status listing.setId stackListing.setId",
      ).lean()
    : [];
  const taskById = new Map(tasks.map((task) => [String(task._id), task]));
  // Accounts (farmingProgress) are only read for pre-order tasks, as before.
  const preorderTaskIds = new Set(
    preorderSets.map((set) => String(set.autoFarmTaskId || "")),
  );
  const accountLogins = [
    ...new Set(
      tasks
        .filter((task) => preorderTaskIds.has(String(task._id)))
        .flatMap((task) => task.assignedAccounts || []),
    ),
  ];
  const accounts = accountLogins.length
    ? await BotAccount.find(
        { login: { $in: accountLogins }, enabled: true },
        { login: 1, farmingProgress: 1, farmingSnapshotAt: 1 },
      ).lean()
    : [];
  const accountsByLogin = new Map();
  for (const account of accounts) {
    const key = String(account.login || "").toLowerCase();
    const current = accountsByLogin.get(key);
    if (
      !current ||
      new Date(account.farmingSnapshotAt || 0) >
        new Date(current.farmingSnapshotAt || 0)
    ) {
      accountsByLogin.set(key, account);
    }
  }
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
  // (e) Unclaimed source: sellable no-claim / web-token accounts grouped by
  // their item-set. Those DropSets are custom:true, so the query above never
  // sees them — the ledger rows ARE the stock. A failure here only loses this
  // section; the DropLog-backed catalog still builds.
  const unclaimedLedgersBySet = new Map();
  let unclaimedSets = [];
  try {
    const ledgers = await UnclaimedAccount.find(
      { status: { $in: ["listed", "skipped"] }, set: { $ne: null } },
      { set: 1, status: 1, game: 1, "drops.campaign": 1, bundleLabel: 1 },
    ).lean();
    for (const ledger of ledgers) {
      const id = String(ledger.set || "");
      if (!OBJECT_ID.test(id)) continue;
      if (!unclaimedLedgersBySet.has(id)) unclaimedLedgersBySet.set(id, []);
      unclaimedLedgersBySet.get(id).push(ledger);
    }
    unclaimedSets = unclaimedLedgersBySet.size
      ? await DropSet.find({
          _id: { $in: [...unclaimedLedgersBySet.keys()] },
          publicCatalog: { $ne: false },
        })
          .sort({ publicFeatured: -1, publicSort: -1, updatedAt: -1 })
          .lean()
      : [];
  } catch (err) {
    console.error("public catalog unclaimed source error:", err.message);
    unclaimedLedgersBySet.clear();
    unclaimedSets = [];
  }

  // (d) Buy links: ONE MarketplaceListing read over every source set id
  // (bundle sources + the unclaimed sets, whose rows reference them directly).
  const buySourceBySet = new Map(
    sets.map((set) => [
      String(set._id),
      buySourceIdFor(set, taskById.get(String(set.autoFarmTaskId))),
    ]),
  );
  const marketRowsBySet = new Map();
  const buyIds = [
    ...new Set([
      ...buySourceBySet.values(),
      ...unclaimedSets.map((set) => String(set._id)),
    ]),
  ];
  if (buyIds.length) {
    try {
      const rows = await MarketplaceListing.find(
        { set: { $in: buyIds }, status: "active" },
        { set: 1, marketplace: 1, url: 1, price: 1, status: 1 },
      ).lean();
      for (const row of rows) {
        const id = String(row.set || "");
        if (!marketRowsBySet.has(id)) marketRowsBySet.set(id, []);
        marketRowsBySet.get(id).push(row);
      }
    } catch (err) {
      console.error("public catalog buy links error:", err.message);
    }
  }
  // Links for a folded group come from every member's source set, so the
  // representative card can offer the cheapest live unit wherever it sits.
  const buyLinksForSets = (ids) =>
    buyLinksFor(ids.flatMap((id) => marketRowsBySet.get(String(id)) || []));

  // (f) Fold identical items×qty in the same category BEFORE building the
  // listings, so 140 mirrors of one shop bundle become one card. Mirrors
  // carry no account scope and share the archive-wide stock, so the group's
  // stock is the max over its members, never the sum.
  const mergedIds = [];
  const bundleRows = dedupeListings(
    sets.map((set) => ({
      set,
      stock: stockMap.get(String(set._id))?.stock || 0,
      category: categoryFor(set),
    })),
    { stockMode: "max" },
  );
  const bundleListings = bundleRows.map((row) => {
    const set = row.set;
    const task = taskById.get(String(set.autoFarmTaskId));
    // (c) pre-order ETA: progress rows, else the schedule estimate.
    const preorder =
      set.catalogState === "preorder"
        ? preorderEtaFor(set, task, accountsByLogin)
        : null;
    const memberIds = [String(set._id), ...(row.mergedIds || [])];
    mergedIds.push(...(row.mergedIds || []));
    const listing = publicListing(
      set,
      row.stock,
      median(pricesByGame.get(row.category.toLowerCase()) || []),
      preorder,
      {
        buyLinks: buyLinksForSets(
          memberIds.map((id) => buySourceBySet.get(id) || id),
        ),
        mergedCount: row.mergedCount,
      },
    );
    if (row.updatedAt) listing.updatedAt = row.updatedAt;
    listing.isNew = listing.isNew || !!row.isNewAny;
    return listing;
  });

  // Unclaimed listings: stock = listed + held ledgers; price = the engine
  // price, never clamped, floored at the owner's unclaimed floors and the
  // set's recent sold price. Duplicates fold with SUMMED stock — every ledger
  // row is a distinct account.
  const priceMemo = unclaimedPriceMemo();
  const unclaimedPricing = getUnclaimedPricing();
  const unclaimedRows = [];
  for (const set of unclaimedSets) {
    const ledgers = unclaimedLedgersBySet.get(String(set._id)) || [];
    const summary = unclaimedSummary({ set, ledgers });
    if (!summary.stock) continue;
    let category = categoryFor(set);
    if (category === "Other") {
      category =
        cleanText(set.coverGame, 80) ||
        cleanText(ledgers[0]?.game, 80) ||
        "Other";
    }
    const suggested = await unclaimedSuggestedPrice(set, category, priceMemo);
    const retail = Math.max(
      Number(set.price) || 0,
      Number(suggested?.price) || 0,
    );
    const floor = Math.max(
      Number(set.minPriceUsd) || 0,
      Number(unclaimedPricing.floorUsd) || 0,
      Number(gameFloorFor(category)) || 0,
      Number(suggested?.soldFloor) || 0,
    );
    unclaimedRows.push({
      set,
      stock: summary.stock,
      category,
      summary,
      retail,
      floor,
    });
  }
  const unclaimedListings = dedupeListings(unclaimedRows, {
    stockMode: "sum",
  }).map((row) => {
    const memberIds = [String(row.set._id), ...(row.mergedIds || [])];
    mergedIds.push(...(row.mergedIds || []));
    const listing = publicListing(row.set, row.stock, 0, null, {
      kind: "unclaimed",
      delivery: "unclaimed",
      category: row.category,
      eventLabel: row.summary.eventLabel,
      buyLinks: buyLinksForSets(memberIds),
      mergedCount: row.mergedCount,
      priceOpts: { clamp: false, floor: row.floor, retail: row.retail },
    });
    if (row.updatedAt) listing.updatedAt = row.updatedAt;
    listing.isNew = listing.isNew || !!row.isNewAny;
    return listing;
  });

  // (g)
  const listings = [...bundleListings, ...unclaimedListings];
  const categoryMap = new Map();
  for (const listing of listings) {
    const key = listing.category.toLowerCase();
    if (!categoryMap.has(key)) {
      categoryMap.set(key, {
        name: listing.category,
        labels: new Map([[listing.category, 1]]),
        listingCount: 0,
        newListingCount: 0,
        preorderCount: 0,
        expectedUnits: 0,
        unclaimedCount: 0,
        unclaimedUnits: 0,
        stock: 0,
        fromPrice: 0,
        images: [],
      });
    }
    const row = categoryMap.get(key);
    row.labels.set(
      listing.category,
      (row.labels.get(listing.category) || 0) + 1,
    );
    row.name = [...row.labels.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0][0];
    row.listingCount++;
    if (listing.isNew) row.newListingCount++;
    if (listing.state === "preorder") {
      row.preorderCount++;
      row.expectedUnits += Number(listing.preorder?.expectedUnits) || 0;
    }
    if (listing.kind === "unclaimed") {
      row.unclaimedCount++;
      row.unclaimedUnits += listing.stock;
    }
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
    categories: [...categoryMap.values()]
      .filter((row) => row.stock > 0 || row.preorderCount > 0)
      .map(({ labels: _labels, ...row }) => row)
      .sort(
        (a, b) =>
          Number(b.newListingCount > 0) - Number(a.newListingCount > 0) ||
          b.stock - a.stock ||
          a.name.localeCompare(b.name),
      ),
    listings,
    // (h) Build diagnostics for the admin overview; the public routes never
    // send this object (mergedIds lets the admin skip folded-away sets).
    meta: {
      buildMs: Date.now() - t0,
      setsScanned: sets.length + unclaimedSets.length,
      merged: mergedIds.length,
      mergedIds,
      unclaimedSets: unclaimedListings.length,
      unclaimedUnits: unclaimedListings.reduce(
        (sum, row) => sum + row.stock,
        0,
      ),
      preorders: listings.filter((row) => row.state === "preorder").length,
    },
  };
  // (i) Privacy guard: a leak is logged loudly, never takes the storefront
  // down (the field lists in publicListing are the real barrier).
  try {
    assertPublicShape(data);
  } catch (err) {
    console.error("public catalog privacy check failed:", err.message);
  }
  // (j) Persist for the next boot — fire-and-forget, never fails the build.
  savePublicSnapshot(data).catch(() => {});
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

// Persisted public snapshot (contract §7.4) — the cure for the ~46 s cold
// build after a restart. The last good payload is stored under key "public"
// and restored into the cache at boot with `at: 0`, so it is served at once
// while the stale-while-revalidate path rebuilds it in the background.
async function savePublicSnapshot(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.listings))
    return false;
  try {
    await CatalogSnapshot.updateOne(
      { key: "public" },
      { $set: { generatedAt: new Date(), data } },
      { upsert: true },
    );
    return true;
  } catch (err) {
    console.error("catalog snapshot save error:", err.message);
    return false;
  }
}

async function restorePublicCatalog() {
  try {
    const row = await CatalogSnapshot.findOne({ key: "public" }).lean();
    const data = row && row.data;
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray(data.listings) ||
      !Array.isArray(data.categories)
    )
      return false;
    // Only ever fills an EMPTY cache: every build persists its own result, so
    // whatever is already in memory is at least as fresh as the stored copy.
    if (publicCache.data) return false;
    publicCache = { at: 0, data };
    return true;
  } catch (err) {
    console.error("catalog snapshot restore error:", err.message);
    return false;
  }
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
    const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 60));
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

// Storefront contact details (contract §7.5): only the three public fields of
// the catalog config, never the sync interval or anything else from settings.
router.get("/catalog/config", catalogReadLimiter, (req, res) => {
  try {
    const config = getCatalogConfig();
    res.set("Cache-Control", "public, max-age=60");
    res.json({
      success: true,
      contact: {
        telegram: config.contactTelegram || "",
        discord: config.contactDiscord || "",
        replyTime: config.replyTime || "",
      },
    });
  } catch (err) {
    console.error("public catalog config error:", err.message);
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

// Owner alert for a quote request (contract §7.6). Plain text — the telegram
// util sends without a parse mode. Stamps notifiedAt once the send has been
// attempted with a configured bot (sendTelegram never throws, so the attempt
// is the best signal there is). Never awaited by the request handler.
async function notifyInquiry({
  inquiry,
  listing,
  reference,
  title,
  category,
  kind,
  quantity,
  unitPrice,
  contact,
  note,
  base,
}) {
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT_IDS) return false;
  const total = Math.round(quantity * unitPrice * 100) / 100;
  const stock =
    listing.state === "preorder"
      ? `~${Math.max(0, Number(listing.preorder?.expectedUnits) || 0)} expected`
      : String(Math.max(0, Number(listing.stock) || 0));
  const text = [
    `🛒 Catalog request ${reference}`,
    title,
    `Kind: ${kind} · Category: ${category}`,
    `Qty: ${quantity} × $${unitPrice.toFixed(2)} ≈ $${total.toFixed(2)}`,
    `Contact: ${contact}`,
    `Note: ${note || "-"}`,
    `Stock now: ${stock}`,
    `Admin: ${base}/catalog-admin.html`,
  ].join("\n");
  try {
    await sendTelegram(text);
    await CatalogInquiry.updateOne(
      { _id: inquiry._id },
      { $set: { notifiedAt: new Date() } },
    );
    return true;
  } catch (err) {
    console.error("catalog inquiry telegram error:", err.message);
    return false;
  }
}

router.post("/catalog/inquiries", catalogInquiryLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const listingId = String(body.listingId || "");
    const quantity = inquiryQuantity(body.quantity);
    const contact = cleanText(body.contact, 180);
    const note = cleanText(body.note, 800);
    const requestedPreorder = body.preorder === true;
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
    // The public snapshot decides what can be requested: it already covers
    // unclaimed sets (custom:true) and merged representatives, both of which
    // the old listed/custom DropSet gate rejected.
    const publicData = await loadPublicCatalog();
    const listing = (publicData.listings || []).find(
      (row) => row.id === listingId,
    );
    const set = listing ? await DropSet.findById(listingId).lean() : null;
    if (!listing || !set)
      return res
        .status(404)
        .json({ success: false, message: "Listing not found" });
    const minQty = Math.max(1, Number(listing.minQty) || 1);
    if (quantity < minQty) {
      return res.status(400).json({
        success: false,
        message: `Minimum order is ${minQty}`,
      });
    }
    const kind = LISTING_KINDS.has(listing.kind) ? listing.kind : "bundle";
    const unitPrice = Math.max(0, Number(listing.price) || 0);
    const preorder = kind === "preorder" && requestedPreorder;
    let expectedReadyAt = null;
    if (preorder) {
      const minutes = Number(listing.preorder?.readyInMinutes);
      if (Number.isFinite(minutes) && minutes >= 0) {
        expectedReadyAt = new Date(Date.now() + minutes * 60000);
      }
    }
    const title = cleanText(listing.title || set.publicTitle || set.name, 140);
    const category = cleanText(listing.category, 80) || categoryFor(set);
    const inquiry = await CatalogInquiry.create({
      listing: set._id,
      listingTitle: title,
      category,
      kind,
      unitPrice,
      quantity,
      contact,
      note,
      preorder,
      expectedReadyAt,
    });
    const reference = `RQ-${String(inquiry._id).slice(-8).toUpperCase()}`;
    res.status(201).json({ success: true, reference });
    // Owner alert AFTER the response: a slow or failing Telegram call must
    // never delay or block the buyer's 201.
    const base = (
      process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`
    ).replace(/\/+$/, "");
    notifyInquiry({
      inquiry,
      listing,
      reference,
      title,
      category,
      kind,
      quantity,
      unitPrice,
      contact,
      note,
      base,
    }).catch(() => {});
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
  // Reuse the stock already computed for the (cached, boot-warmed) public
  // catalog instead of re-running the whole-archive aggregation on every admin
  // load — with ~200 listed sets that second aggregation took ~a minute and
  // stalled this page. Only sets that are listed but hidden from the public
  // catalog (publicCatalog:false) need a fresh, and much smaller, stock pass.
  const publicStockById = new Map(
    data.listings.map((listing) => [listing.id, listing.stock]),
  );
  // Sets folded into another card are represented, not hidden: they must not
  // trigger the (expensive) stock pass reserved for listed-but-hidden sets.
  const mergedIds = new Set(
    Array.isArray(data.meta?.mergedIds)
      ? data.meta.mergedIds.map((id) => String(id))
      : [],
  );
  const hiddenSets = adminSets.filter(
    (set) =>
      !publicStockById.has(String(set._id)) && !mergedIds.has(String(set._id)),
  );
  const hiddenStock = hiddenSets.length
    ? await stockForSets(hiddenSets)
    : new Map();
  // Every snapshot listing (all kinds: bundles, pre-orders, unclaimed sets,
  // merged representatives) enriched from ONE DropSet read with the editable
  // public fields; hidden listed sets are appended as before.
  const snapshotIds = data.listings
    .map((listing) => String(listing.id || ""))
    .filter((id) => OBJECT_ID.test(id));
  const snapshotSets = snapshotIds.length
    ? await DropSet.find(
        { _id: { $in: snapshotIds } },
        {
          publicCatalog: 1,
          publicTitle: 1,
          publicDescription: 1,
          publicPrice: 1,
          bulkDiscountPct: 1,
          publicSort: 1,
        },
      ).lean()
    : [];
  const snapshotSetById = new Map(
    snapshotSets.map((set) => [String(set._id), set]),
  );
  const adminFields = (set) => ({
    visible: !set || set.publicCatalog !== false,
    publicTitle: cleanText(set && set.publicTitle, 140),
    publicDescription: cleanText(set && set.publicDescription, 600),
    publicPrice: Number(set && set.publicPrice) || 0,
    bulkDiscountPct: Number(set && set.bulkDiscountPct) || 0,
    publicSort: Number(set && set.publicSort) || 0,
  });
  const adminListings = [
    ...data.listings.map((listing) => ({
      ...listing,
      ...adminFields(snapshotSetById.get(String(listing.id))),
      kind: LISTING_KINDS.has(listing.kind) ? listing.kind : "bundle",
      buyLinkCount: Array.isArray(listing.buyLinks)
        ? listing.buyLinks.length
        : 0,
      mergedCount: Number(listing.mergedCount) || 0,
    })),
    ...hiddenSets.map((set) => ({
      ...publicListing(set, hiddenStock.get(String(set._id))?.stock || 0),
      ...adminFields(set),
      buyLinkCount: 0,
      mergedCount: 0,
    })),
  ];
  const unclaimedPublic = data.listings.filter(
    (row) => row.kind === "unclaimed",
  );
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
      unclaimedListings: unclaimedPublic.length,
      unclaimedUnits: unclaimedPublic.reduce((sum, row) => sum + row.stock, 0),
      mergedDuplicates: Number(data.meta?.merged) || 0,
      preorders: data.listings.filter((row) => row.state === "preorder").length,
    },
    meta: data.meta || null,
    preorderSync: preorderSyncStatus(),
    config: getCatalogConfig(),
    categories: data.categories,
    listings: adminListings,
    inquiries: inquiries.map((row) => ({
      id: String(row._id),
      listingTitle: row.listingTitle,
      category: row.category,
      kind: row.kind || "bundle",
      unitPrice: Number(row.unitPrice) || 0,
      quantity: row.quantity,
      contact: row.contact,
      note: row.note,
      status: row.status,
      notifiedAt: row.notifiedAt || null,
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
        publicPrice: [0, PUBLIC_PRICE_ADMIN_MAX_USD],
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
        if (
          field === "publicPrice" &&
          value > 0 &&
          value < PUBLIC_PRICE_MIN_USD
        ) {
          return res.status(400).json({
            success: false,
            message: `publicPrice must be between $${PUBLIC_PRICE_MIN_USD.toFixed(2)} and $${PUBLIC_PRICE_ADMIN_MAX_USD.toFixed(2)}`,
          });
        }
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

function startVariantSync({
  apply = false,
  games = null,
  minStock,
  maxProfilesPerGame,
  source = "admin",
  syncEventSets = false,
  onFinish = null,
} = {}) {
  if (variantSyncJob.running) return false;
  variantSyncJob = {
    running: true,
    apply,
    source,
    startedAt: Date.now(),
    finishedAt: 0,
    result: null,
    error: null,
  };
  (async () => {
    try {
      const autoLister = require("../utils/autoLister");
      const MarketResearch = require("../models/MarketResearch");
      const activePreorders = syncEventSets
        ? await syncActivePreorders({
            AutoFarmTask,
            DropSet,
            campaignItems: autoLister.campaignItems,
            derivePrice: autoLister.derivePrice,
            researchForGame: (game) => MarketResearch.findOne({ game }).lean(),
            apply,
          })
        : null;
      const eventSets = syncEventSets
        ? await syncHistoricalEventSets({
            AutoFarmTask,
            DropSet,
            stockForSets,
            apply,
          })
        : null;
      const variants = await syncInventoryVariants({
        apply,
        games,
        minStock,
        maxProfilesPerGame,
      });
      variantSyncJob.result = { ...variants, eventSets, activePreorders };
      if (eventSets && (eventSets.published || eventSets.retired)) {
        invalidateCatalogCache();
      }
    } catch (err) {
      console.error("catalog inventory variant sync error:", err.message);
      variantSyncJob.error = err.message || "Sync failed";
    } finally {
      variantSyncJob.running = false;
      variantSyncJob.finishedAt = Date.now();
      if (typeof onFinish === "function") {
        try {
          onFinish(publicVariantJob());
        } catch {
          /* audit callback must not affect sync completion */
        }
      }
    }
  })();
  return true;
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
    startVariantSync({
      apply,
      games,
      minStock: body.minStock,
      maxProfilesPerGame: body.maxProfilesPerGame,
      source: "admin",
    });
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

// Pre-order sync loop (contract §7.7): stamps a catalog pre-order set for
// every active farm2 task within ~catalogPreorderSyncMinutes of its deploy
// instead of waiting for the 6-hourly variant sync, which lagged 1–46 h.
let preorderSync = {
  running: false,
  lastRunAt: null,
  lastResult: null,
  lastError: null,
  intervalMinutes: 0,
  firstTimer: null,
  timer: null,
};

function preorderSyncStatus() {
  return {
    running: preorderSync.running,
    lastRunAt: preorderSync.lastRunAt,
    lastResult: preorderSync.lastResult,
    lastError: preorderSync.lastError,
    intervalMinutes: preorderSync.intervalMinutes,
  };
}

async function runPreorderSync() {
  // The variant sync runs syncActivePreorders itself — never overlap it, and
  // never overlap our own previous run (catalogPreorder also guards this).
  if (preorderSync.running || variantSyncJob.running) return null;
  preorderSync.running = true;
  try {
    const autoLister = require("../utils/autoLister");
    const result = await syncActivePreorders({
      AutoFarmTask,
      DropSet,
      campaignItems: autoLister.campaignItems,
      derivePrice: autoLister.derivePrice,
      researchForGame: (game) => MarketResearch.findOne({ game }).lean(),
      apply: true,
    });
    preorderSync.lastResult = result || null;
    preorderSync.lastError = null;
    if ((Number(result?.stamped) || 0) > 0 || (Number(result?.filled) || 0) > 0)
      invalidateCatalogCache();
    return result;
  } catch (err) {
    preorderSync.lastError = err.message || "Pre-order sync failed";
    console.error("catalog preorder sync error:", err.message);
    return null;
  } finally {
    preorderSync.running = false;
    preorderSync.lastRunAt = new Date();
  }
}

// Idempotent: re-reads catalogPreorderSyncMinutes and replaces any timers, so
// it runs at boot and again whenever the admin changes the interval. 0 = off.
// First run 60 s after start, then every `minutes`. Timers are unref'd so
// they never keep a shutting-down process alive.
function startPreorderSyncLoop() {
  if (preorderSync.firstTimer) clearTimeout(preorderSync.firstTimer);
  if (preorderSync.timer) clearInterval(preorderSync.timer);
  preorderSync.firstTimer = null;
  preorderSync.timer = null;
  const minutes = Math.max(
    0,
    Math.floor(Number(getCatalogConfig().preorderSyncMinutes) || 0),
  );
  preorderSync.intervalMinutes = minutes;
  if (!minutes) {
    console.log(
      "[catalog] preorder sync loop off (catalogPreorderSyncMinutes = 0)",
    );
    return false;
  }
  const tick = () => {
    runPreorderSync().catch(() => {});
  };
  preorderSync.firstTimer = setTimeout(tick, 60 * 1000);
  preorderSync.firstTimer.unref();
  preorderSync.timer = setInterval(tick, minutes * 60 * 1000);
  preorderSync.timer.unref();
  return true;
}

// Storefront contact + sync interval (contract §7.8). Only the four catalog
// keys ever reach settings; a changed interval takes effect immediately.
router.put(
  "/catalog/admin/config",
  requireSuperadmin,
  enforce2fa,
  async (req, res) => {
    try {
      const body = req.body || {};
      const patch = {};
      for (const key of [
        "contactTelegram",
        "contactDiscord",
        "replyTime",
        "preorderSyncMinutes",
      ]) {
        if (body[key] !== undefined) patch[key] = body[key];
      }
      const config = await setCatalogConfig(patch, {
        actor:
          (req.session && req.session.admin && req.session.admin.username) ||
          "admin",
      });
      if (patch.preorderSyncMinutes !== undefined) startPreorderSyncLoop();
      invalidateCatalogCache();
      res.json({ success: true, config });
    } catch (err) {
      console.error("catalog config update error:", err.message);
      res.status(500).json({ success: false, message: "Server error" });
    }
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
        const recommended = clampPublicPrice(
          Math.max(Number(set.minPriceUsd) || 0, base * 0.94),
        );
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
module.exports.publicListing = publicListing;
module.exports.publicPriceFor = publicPriceFor;
module.exports.publicPriceTiers = publicPriceTiers;
module.exports.clampPublicPrice = clampPublicPrice;
module.exports.PUBLIC_PRICE_MIN_USD = PUBLIC_PRICE_MIN_USD;
module.exports.PUBLIC_PRICE_MAX_USD = PUBLIC_PRICE_MAX_USD;
module.exports.stockForSetsBatched = stockForSetsBatched;
module.exports.recommendedProfilePrice = recommendedProfilePrice;
module.exports.inquiryQuantity = inquiryQuantity;
module.exports.invalidateCatalogCache = invalidateCatalogCache;
module.exports.warmPublicCatalog = refreshPublicCatalog;
module.exports.syncInventoryVariants = syncInventoryVariants;
module.exports.startVariantSync = startVariantSync;
module.exports.variantSyncStatus = publicVariantJob;
module.exports.updateAutofarmCatalogStates = updateAutofarmCatalogStates;
// Catalog v2 (docs/CATALOG-V2-CONTRACT.md §7.11)
module.exports.restorePublicCatalog = restorePublicCatalog;
module.exports.savePublicSnapshot = savePublicSnapshot;
module.exports.startPreorderSyncLoop = startPreorderSyncLoop;
module.exports.preorderSyncStatus = preorderSyncStatus;
