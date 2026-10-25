#!/usr/bin/env node
// Listings board dev harness (docs/code-shop/08-LISTINGS-BOARD.md):
//
//   node scripts/shop-board-harness.js [port=4610]
//       -> http://127.0.0.1:4610/soop.html#listings   and   /chzzk.html#listings
//   node scripts/shop-board-harness.js 4610 --snapshot=<file.json>
//       serves a saved GET /api/code-shop/board answer instead of the seeded one
//       (keep such a file outside the repository: it holds order ids)
//
// The real code shop router (the page only calls GET /board) on an in-memory
// MongoDB seeded with made-up games, campaigns, listings and sales. Every
// picture is an SVG drawn here. The SOOP and CHZZK page cores get a minimal
// /state so both pages load; their other tabs have nothing to show. Nothing
// here reads .env or reaches a real database or market.
const fs = require("fs");
const path = require("path");

delete process.env.MONGO_URI;
delete process.env.CODE_SHOP;

const express = require("express");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const PORT = Number(process.argv[2]) || 4610;
const SNAPSHOT = (process.argv.find((a) => a.startsWith("--snapshot=")) || "").slice(11);
const BASE = "http://127.0.0.1:" + PORT;
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ObjectId = mongoose.Types.ObjectId;

// Deterministic "random" numbers, so every start looks the same.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = prng(20261025);
const pick = (list) => list[Math.floor(rnd() * list.length)];

// ---- pictures ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
function hue(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
function svg(kind, name) {
  const h = hue(name);
  const label = esc(name.replace(/-\d+x\d+$/, "").replace(/[-_]/g, " "));
  if (kind === "cover") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="285" height="380" viewBox="0 0 285 380">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${h},70%,52%)"/><stop offset="1" stop-color="hsl(${(h + 70) % 360},70%,22%)"/></linearGradient></defs>
<rect width="285" height="380" fill="url(#g)"/><circle cx="220" cy="80" r="120" fill="rgba(255,255,255,.12)"/>
<text x="20" y="330" font-family="Helvetica,Arial" font-size="34" font-weight="800" fill="#fff">${label}</text></svg>`;
  }
  if (kind === "banner") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="360" viewBox="0 0 960 360">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="hsl(${h},65%,40%)"/><stop offset="1" stop-color="hsl(${(h + 120) % 360},65%,30%)"/></linearGradient></defs>
<rect width="960" height="360" fill="url(#g)"/>
<g fill="rgba(255,255,255,.10)"><circle cx="760" cy="40" r="210"/><circle cx="120" cy="330" r="160"/><rect x="420" y="60" width="160" height="160" rx="30" transform="rotate(20 500 140)"/></g>
<text x="40" y="90" font-family="Helvetica,Arial" font-size="44" font-weight="800" fill="rgba(255,255,255,.9)">${label}</text></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
<defs><radialGradient id="g" cx=".35" cy=".3" r=".9"><stop offset="0" stop-color="hsl(${h},85%,70%)"/><stop offset="1" stop-color="hsl(${(h + 40) % 360},75%,38%)"/></radialGradient></defs>
<rect x="8" y="8" width="80" height="80" rx="22" fill="url(#g)"/><path d="M48 24l7 15 16 2-12 11 3 16-14-8-14 8 3-16-12-11 16-2z" fill="rgba(255,255,255,.85)"/></svg>`;
}
const img = (kind, name) => `${BASE}/harness-img/${kind}/${encodeURIComponent(name)}.svg`;

// ---- seed ----------------------------------------------------------------------------------
const GAMES = [
  { gameNo: "12", name: "Overwatch 2", soopName: "Overwatch", twitch: "Overwatch", cfg: { sell: true, displayName: "Overwatch 2", marketGame: "Overwatch" } },
  { gameNo: "429", name: "Dokkaebi World", cfg: { sell: true, displayName: "Dokkaebi World", marketGame: "Dokkaebi World" } },
  { gameNo: "910003", name: "Stella Sora", twitch: "Stella Sora", cfg: { sell: true } },
  { gameNo: "18", name: "Eternal Return", twitch: "Eternal Return", cfg: { sell: true, displayName: "Eternal Return" } },
  { gameNo: "9217747", name: "Black Survival Eternal Return", cfg: { sell: true, displayName: "Eternal Return" } },
  { gameNo: "200", name: "Delta Force", twitch: "Delta Force", cfg: { sell: true } },
  { gameNo: "910004", name: "Once Human", twitch: "Once Human", cfg: { sell: true } },
  { gameNo: "32", name: "Sudden Attack", cfg: { sell: true, displayName: "Sudden Attack" } },
  { gameNo: "910002", name: "World of Warcraft: Midnight", twitch: "World of Warcraft", cfg: { sell: true } },
  { gameNo: "910005", name: "FC Online", cfg: { sell: false } },
];
const gameByNo = new Map(GAMES.map((g) => [g.gameNo, g]));

// Campaigns: [gameNo, source, idx, title, startDays, endDays, rewards]
const CAMPAIGNS = [
  ["12", "soop", "13787", "OWCS Korea Stage 3 In-game Item Drops (W3&4)", -15, 0.2, ["Autumn Vibes Name Card", "Banana Cat Icon", "Prost Spray", "Skal Spray"]],
  ["12", "soop", "13337", "OWCS Korea Stage 3 In-game Item Drops (W1&2)", -30, -14, ["Sun Tea Player Icon", "Refreshing Spray", "Esports Loot Box"]],
  ["12", "chzzk", "chzzk-1954", "러너리그 시즌5", -4, 1.5, ["특급 전리품 상자"]],
  ["429", "soop", "14121", "Dokkaebi World Launch Drops Week 3", -6, 4, ["Blessing Pouch x1 (30 min)", "Blessing Pouch x1 (60 min)", "Blessing Pouch x3 (120 min)"]],
  ["429", "soop", "13715", "Dokkaebi World Launch Drops Week 1", -20, -12, ["Blessing Pouch x1 (tier 1)", "Blessing Pouch x3 (tier 3)"]],
  ["429", "chzzk", "chzzk-1981", "도깨비 월드 런칭 드롭스", -6, 3, ["Blessing Pouch x1 (30 min reward)"]],
  ["910003", "chzzk", "chzzk-1962", "스텔라 소라 시청 이벤트", -5, 0.8, ["Gems + Bonus Item I", "Gems + Bonus Item II", "Gems + Bonus Item III"]],
  ["18", "soop", "14197", "[10/25] ERM S12 FINALS LCQ", -2, -0.4, ["Drops Token", "Esports Shard"]],
  ["9217747", "chzzk", "chzzk-1992", "로드 투 마스터즈 [10/25]", -2, -0.3, ["Drops Token"]],
  ["200", "soop", "13603", "RISE Series Drops", -40, -20, ["QBZ95-1 Skin", "Lucky Pack", "Gear Tickets"]],
  ["910004", "chzzk", "chzzk-1982", "원스 휴먼 3시간 시청 보상", -8, 2, ["Cool Summer Sandals", "Nightmare Night Headwear"]],
  ["32", "soop", "14227", "Sudden Attack Championship Season 2 Week 1", -3, 5, ["Container x1 + Key Card x1"]],
  ["910002", "chzzk", "chzzk-1939", "와우 한밤 드롭스", -10, 3, ["Cuddly Gold-Colored Grrgle"]],
  ["910005", "chzzk", "chzzk-1990", "FC 온라인 시청 이벤트", -1, 6, ["Coupon Pack"]],
];

// Products: [name, gameNo, campaignIdxs, status, markets, price, available, soldUnits, listingStates]
const PRODUCTS = [
  ["Overwatch - OWCS Stage 3 (W3&4) 4 codes", "12", ["13787"], "active", ["eldorado", "playerauctions"], 1, 62, 9, { eldorado: "live", playerauctions: "live" }],
  ["Overwatch - OWCS Stage 3 (W3&4) 3 codes", "12", ["13787"], "active", ["eldorado", "playerauctions"], 1, 41, 6, { eldorado: "live", playerauctions: "live" }],
  ["Overwatch 2 | OWCS 6 Codes Bundle", "12", ["13337"], "active", ["eldorado"], 1, 0, 8, { eldorado: "paused" }],
  ["Overwatch Epic Loot Box code - one login", "12", ["chzzk-1954"], "active", ["eldorado"], 1, 1, 1, { eldorado: "live" }],
  // A custom bundle holding both farms' codes: each farm's view counts it with its share.
  ["Overwatch 2 custom mix (SOOP + CHZZK codes)", "12", ["13337", "chzzk-1954"], "active", ["eldorado"], 2, 2, 3, { eldorado: "live" }],
  ["Dokkaebi World - Launch Drops Week 3 (3 codes)", "429", ["14121"], "active", ["eldorado"], 1, 70, 4, { eldorado: "live" }],
  ["Dokkaebi World - Launch Drops Week 1 (2 codes)", "429", ["13715"], "active", ["eldorado"], 1, 29, 2, { eldorado: "live" }],
  ["Dokkaebi World week 3 codes - one login", "429", ["chzzk-1981"], "active", ["eldorado", "playerauctions"], 1, 1, 0, { eldorado: "live", playerauctions: "error" }],
  ["Stella Sora test bundle (3 codes, one login)", "910003", ["chzzk-1962"], "active", ["eldorado"], 1, 1, 2, { eldorado: "live" }],
  ["Black Survival Eternal Return - Road to Masters (3 codes)", "9217747", ["chzzk-1992"], "active", ["eldorado"], 1, 1, 0, { eldorado: "live" }],
  ["Delta Force | 3 Redeem Codes Bundle", "200", ["13603"], "active", ["eldorado"], 1, 0, 3, { eldorado: "paused" }],
  ["Once Human codes (2) - one login", "910004", ["chzzk-1982"], "active", ["eldorado"], 1, 1, 1, { eldorado: "live" }],
  ["Sudden Attack Championship Week 1 (1 code)", "32", ["14227"], "active", ["eldorado"], 1, 70, 0, { eldorado: "live" }],
  ["World of Warcraft Grrgle code - one login", "910002", ["chzzk-1939"], "draft", ["eldorado"], 1, 0, 0, {}],
  ["Overwatch - OWCS Stage 3 (W1&2) old bundle", "12", ["13337"], "retired", ["eldorado"], 1, 0, 5, { eldorado: "down" }],
];

async function seed(models, now) {
  const { CodeStock, CodeProduct, SuppliedAccount, MarketplaceListing, SoopCampaign, ChzzkCampaign, TwitchCampaign } = models;
  const soopLogins = Array.from({ length: 12 }, (_, i) => "soopfarm" + String(i + 1).padStart(2, "0"));
  const chzzkLogins = Array.from({ length: 3 }, () => "chzzk:" + new ObjectId());
  const campByIdx = new Map();
  const rows = [];
  let seq = 0;

  for (const [gameNo, source, idx, title, startD, endD, rewards] of CAMPAIGNS) {
    const g = gameByNo.get(gameNo);
    const groupKey = gameNo + ":" + idx;
    const slug = g.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + idx;
    const c = { gameNo, source, idx, title, groupKey, endAt: new Date(now + endD * DAY), rewards: [] };
    rewards.forEach((r, i) => c.rewards.push({ name: r, slotKey: groupKey + ":" + (1e9 + i * 7919 + Number(String(idx).replace(/\D/g, ""))).toString(16).slice(0, 10) + ":1", image: img("reward", slug + "-" + i) }));
    campByIdx.set(idx, c);
    if (source === "soop") {
      await SoopCampaign.collection.insertOne({ dropsIdx: idx, title, image: img("banner", slug), gameNo, startDate: new Date(now + startD * DAY), endDate: c.endAt });
    } else {
      await ChzzkCampaign.collection.insertOne({ campaignNo: Number(idx.slice(6)), title, categoryId: g.name, imageUrl: img("banner", slug), startAt: new Date(now + startD * DAY), endAt: c.endAt, rewards: [] });
    }
  }
  for (const g of GAMES) {
    if (!g.twitch) continue;
    const slug = g.twitch.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await TwitchCampaign.collection.insertOne({ campaignId: "tw-" + slug, game: g.twitch, boxArt: `${BASE}/harness-img/cover/${slug}-{width}x{height}.svg` });
  }

  const code = (c, reward, loginId, over) => {
    seq += 1;
    const g = gameByNo.get(c.gameNo);
    return {
      loginId, itemKey: "k" + seq, gameNo: c.gameNo, gameName: c.source === "soop" ? g.soopName || g.name : g.name, groupKey: c.groupKey,
      campaignIdx: c.idx, campaignTitle: c.title, campaignEndAt: c.endAt, slotKey: reward.slotKey, nameRaw: reward.name, name: reward.name,
      image: reward.image, codeHash: "harness-" + seq, codeShape: "25:4-4-5-4-4", earnedAt: new Date(now - rnd() * 5 * DAY),
      useBy: new Date(Math.max(now + 6 * HOUR, c.endAt.getTime() + 10 * DAY)), state: "in_stock", unit: null, product: null, offer: null,
      unitStatus: "", soldAt: null, market: "", orderId: "", saleUsd: 0, problem: "", history: [],
      createdAt: new Date(now - 6 * DAY), updatedAt: new Date(now - rnd() * 3 * DAY), ...over,
    };
  };
  const loginFor = (c) => (c.source === "soop" ? pick(soopLogins) : pick(chzzkLogins));

  for (const [name, gameNo, idxs, status, markets, price, available, soldUnits, listingStates] of PRODUCTS) {
    const camps = idxs.map((i) => campByIdx.get(i));
    const slots = camps.flatMap((c) => c.rewards.map((r) => ({ c, r })));
    const pid = new ObjectId();
    const offer = status === "draft" ? null : new ObjectId();
    const g = gameByNo.get(gameNo);
    await CodeProduct.collection.insertOne({
      _id: pid, name, gameNo, gameName: g.name, marketGame: (g.cfg && g.cfg.marketGame) || g.name, groupKeys: camps.map((c) => c.groupKey),
      slots: slots.map(({ r }) => ({ slotKey: r.slotKey, label: /[^\x20-\x7e]/.test(r.name) ? "Epic Loot Box" : r.name, image: r.image, nameRaw: r.name })),
      status, origin: "auto", kind: "full", edited: false, stale: false, offer,
      texts: { title: g.name + " | " + slots.length + " Codes Bundle | " + slots.map(({ r }) => r.name).join(" + ").slice(0, 80) + " | Redeem Codes | Instant Auto Delivery" },
      pricing: { mode: "fixed", priceUsd: price }, markets, useBy: new Date(now + 9 * DAY), createdAt: new Date(now - 7 * DAY), updatedAt: new Date(now - DAY),
    });
    if (!offer) {
      for (const { c, r } of slots) rows.push(code(c, r, loginFor(c), {}));
      continue;
    }
    const units = [];
    for (let i = 0; i < available; i++) units.push({ status: "available" });
    for (let i = 0; i < soldUnits; i++) units.push({ status: "sold" });
    for (const u of units) {
      u._id = new ObjectId();
      await SuppliedAccount.collection.insertOne({ _id: u._id, offer, login: "harness-unit-" + u._id, loginLower: "harness-unit-" + u._id, status: u.status, password: "" });
      const sold = u.status === "sold";
      const market = sold ? pick(markets.filter((m) => listingStates[m] !== "error").concat(markets.includes("playerauctions") ? ["eldorado"] : [])) : "";
      const soldAt = sold ? new Date(now - Math.pow(rnd(), 1.6) * 13.5 * DAY) : null;
      const unitPrice = market === "playerauctions" ? 5 : price;
      for (const { c, r } of slots) {
        rows.push(code(c, r, loginFor(c), sold
          ? { state: rnd() < 0.04 ? "dead" : "sold", unit: u._id, product: pid, offer, market, saleUsd: unitPrice / slots.length, soldAt, orderId: (market === "eldorado" ? "e" : "pa") + Math.floor(rnd() * 1e9) }
          : { state: "in_unit", unit: u._id, product: pid, offer, unitStatus: "available" }));
      }
    }
    for (const m of markets) {
      const state = listingStates[m];
      if (!state) continue;
      const ext = m === "eldorado" ? new ObjectId().toString() : String(298000000 + Math.floor(rnd() * 999999));
      await MarketplaceListing.collection.insertOne({
        accountOffer: offer, marketplace: m, externalId: ext, origin: "manual",
        status: state === "live" || state === "paused" ? "active" : state === "error" ? "error" : "delisted", autoPaused: state === "paused",
        price: m === "playerauctions" ? 5 : price, lastError: state === "error" ? "PlayerAuctions said: the item category is closed for new offers" : "",
        url: m === "eldorado" ? "https://www.eldorado.gg/twitch-drops/i/235?offerId=" + ext : "https://www.playerauctions.com/i/" + ext + "/",
        createdAt: new Date(now - 6 * DAY),
      });
    }
  }
  // Codes nobody bundled yet, codes taken off sale near their use-by, expired ones.
  for (const c of campByIdx.values()) {
    for (const r of c.rewards) {
      const ended = c.endAt.getTime() < now;
      const extra = c.gameNo === "910005" ? 3 : ended ? 0 : Math.floor(rnd() * 4);
      for (let i = 0; i < extra; i++) rows.push(code(c, r, loginFor(c), { useBy: new Date(now + (c.gameNo === "910003" ? 20 * HOUR : 8 * DAY)) }));
      if (ended || c.gameNo === "18") {
        for (let i = 0; i < 6; i++) rows.push(code(c, r, loginFor(c), { state: i < 4 ? "expired" : "expiring", useBy: new Date(now - DAY) }));
      }
    }
  }
  await CodeStock.collection.insertMany(rows);
  return { codes: rows.length, products: PRODUCTS.length, campaigns: CAMPAIGNS.length };
}

// ---- the app ----------------------------------------------------------------------------------
async function main() {
  const now = Date.now();
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri("shopboardharness"));
  const models = {
    CodeStock: require("../models/CodeStock"),
    CodeProduct: require("../models/CodeProduct"),
    SuppliedAccount: require("../models/SuppliedAccount"),
    MarketplaceListing: require("../models/MarketplaceListing"),
    SoopCampaign: require("../models/SoopCampaign"),
    ChzzkCampaign: require("../models/ChzzkCampaign"),
    TwitchCampaign: require("../models/TwitchCampaign"),
  };
  await Promise.all(Object.values(models).map((m) => m.init()));
  const seeded = await seed(models, now);

  const { DEFAULTS, deepMerge } = require("../utils/codeShop/config");
  const cfg = deepMerge(DEFAULTS, {
    markets: { eldorado: true, playerauctions: true },
    autoPublish: true,
    games: Object.fromEntries(GAMES.map((g) => [g.gameNo, g.cfg || {}])),
  });
  const service = { deps: { models, now: () => Date.now() }, modules: { config: { get: async () => cfg } } };
  const snapshot = SNAPSHOT ? JSON.parse(fs.readFileSync(SNAPSHOT, "utf8")) : null;

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { admin: { id: "harness", role: "superadmin", username: "harness" } };
    next();
  });
  app.get("/harness-img/:kind/:name.svg", (req, res) => {
    res.type("image/svg+xml").send(svg(req.params.kind, req.params.name));
  });
  if (snapshot) {
    app.get("/api/code-shop/board", (req, res) => res.json({ success: true, ...(snapshot.board || snapshot) }));
  }
  app.use(require("../routes/codeShopRoutes")({ service }));
  // Just enough for the two page cores to load.
  app.get("/api/soop/state", (req, res) => res.json({ success: true, now: new Date(), totals: { accounts: 12, farming: 0, dead: 0, botsActive: 0, bots: 0 }, accounts: [], bots: [], farm: { on: true } }));
  app.get("/api/soop/campaigns", (req, res) => res.json({ success: true, campaigns: [], games: [], scan: {} }));
  app.get("/api/chzzk/state", (req, res) => res.json({ success: true, now: new Date(), accounts: [], totals: {}, egress: { ok: true, country: "FR" }, farm: { on: true } }));
  app.get("/api/chzzk/campaigns", (req, res) => res.json({ success: true, campaigns: [] }));
  app.get("/whoami", (req, res) => res.json({ admin: req.session.admin }));
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use((req, res) => res.status(404).json({ success: false, message: "Not in the harness: " + req.path }));

  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`shop-board harness: ${seeded.codes} codes, ${seeded.products} products, ${seeded.campaigns} campaigns${snapshot ? " (serving the snapshot " + SNAPSHOT + ")" : ""}`);
    console.log(`  SOOP panel:  ${BASE}/soop.html#listings`);
    console.log(`  CHZZK panel: ${BASE}/chzzk.html#listings`);
  });
  const stop = async () => {
    server.close();
    await mongoose.disconnect();
    await mem.stop();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
