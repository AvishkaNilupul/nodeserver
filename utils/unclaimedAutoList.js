// ---------------------------------------------------------------------------
// UNCLAIMED-FARMS AUTO-LISTING engine.
//
// Lists + sells accounts from the TWO unclaimed-drops farms on the same
// marketplaces the auto-farmer uses:
//   * no-claim farm  — accounts live in Pi configs (noclaim-bot-*) and farm
//     with Android tokens; ground truth = twitchInventory.fetchInventory.
//   * web-token farm — accounts live in the WebBotAccount registry and farm
//     with web tokens; ground truth = webbotTwitch.fetchInventory.
//
// A drop is sellable ONLY when live inventory shows 100% watched + unclaimed.
// The account (login+password, unclaimed drops intact) is the deliverable, so
// the buyer connects their own game account and claims — that is the whole
// no-claim model.
//
// Lifecycle per account (ledger: models/UnclaimedAccount.js):
//   candidate -> listed (rows published, origin:"unclaimed") ->
//     sold   (buyer paid / a listed drop flipped to claimed) -> spent path
//     expired (all drops gone) -> delist all rows -> released back to pool
// Rules: never claim, never reprice, never touch origin "auto"/"manual" rows,
// one account = one buyer, pool return only after ALL drops expired.
// ---------------------------------------------------------------------------
const fsp = require("fs/promises");
const hosts = require("./botHosts");
const settings = require("./settings");
const twitchInventory = require("./twitchInventory");
const webbotTwitch = require("./webbotTwitch");
const mp = require("./marketplaces");
const { decrypt } = require("./secretBox");
const { buildSetGridImage } = require("./setImage");
const { derivePrice } = require("./autoLister");
const { digisellerDeliveryCode } = require("./digisellerFulfiller");
const { ggselDeliveryCode } = require("./ggselFulfiller");
const { gameflipDeliveryCode } = require("./gameflipFulfiller");
const { recordListingSale } = require("./saleLearning");
const { sendTelegram } = require("./telegram");
const { logEvent } = require("./systemLog");
const { recordPoolUsage } = require("./poolUsageLog");
const AvailableAccount = require("../models/AvailableAccount");
const WebBotAccount = require("../models/WebBotAccount");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const MarketResearch = require("../models/MarketResearch");
const NoclaimSpentAccount = require("../models/NoclaimSpentAccount");

const ORIGIN = "unclaimed";
const HOST_ID = "pi";
const BASE = "/home/avishka/twitchbot-noclaim";
const BOTS_DIR = BASE + "/bots";
const CONTAINER_PREFIX = "noclaim-bot-";
const CONFIG_PATH = (id) => BOTS_DIR + "/" + id + "/Configuration/config.json";
const containerFor = (id) => CONTAINER_PREFIX + id;

const TICK_MS = 10 * 60 * 1000;
const SCAN_LIMIT = 60; // candidate inventory checks per scan pass
const CHECK_LIMIT = 30; // listed accounts re-verified per expiry/sale pass
const RETRY_LIMIT = 5; // secondary-market retries per scan pass
const CONCURRENCY = 5;

let running = false;
let lastRun = null;
let lastCheck = null;
let timer = null;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// No-claim inventory: in-progress time-based drops at 100% and unclaimed.
function sellableDropsFromNoClaimInv(inv) {
  const out = [];
  for (const d of (inv && inv.inProgress) || []) {
    if (d.percent >= 100 && !d.claimed) {
      out.push({
        name: d.name || "Reward",
        game: d.game || "",
        campaign: d.campaign || "",
        imageURL: d.imageURL || "",
        itemKey:
          String(d.name || "")
            .trim()
            .toLowerCase() +
          "|" +
          String(d.game || "")
            .trim()
            .toLowerCase(),
      });
    }
  }
  return out;
}

// Webbot inventory: farmed-unclaimed drops from webbotTwitch.fetchInventory.
function sellableDropsFromWebbotInv(inv) {
  const out = [];
  for (const d of (inv && inv.drops) || []) {
    if (d.farmedUnclaimed) {
      out.push({
        name: d.name || "Reward",
        game: d.game || "",
        campaign: d.campaign || "",
        imageURL: "",
        itemKey:
          String(d.name || "")
            .trim()
            .toLowerCase() +
          "|" +
          String(d.game || "")
            .trim()
            .toLowerCase(),
      });
    }
  }
  return out;
}

// Stored credentials are secretBox-encrypted, except legacy webbot rows which
// carry a "plain:" prefix. Return the usable plaintext or "".
function plainPassword(enc) {
  const p = decrypt(enc);
  return String(p || "").replace(/^plain:/i, "");
}

// A pool row's sellable Twitch password. Historically the pool kept it in
// `password` (secretBox-encrypted); newer rows use `credPasswordEnc`. The
// no-claim console reads `password` the same way (routes/noclaimFarmRoutes.js
// per-bot accounts), so both are checked, password first.
// Numeric-friendly bot sort key ("3" < "10" < webbot-bot-1 < idle "").
function padBot(id) {
  const n = parseInt(String(id || ""), 10);
  if (Number.isFinite(n)) return String(n).padStart(8, "0");
  return "zz" + String(id || "");
}

function poolPassword(poolRow) {
  if (!poolRow) return "";
  let pw = "";
  try {
    pw = decrypt(poolRow.password || "");
  } catch {
    pw = "";
  }
  if (!pw) pw = plainPassword(poolRow.credPasswordEnc);
  return pw || "";
}

// Listing copy — the account and its unclaimed drops, with the connect-and-
// claim instructions that make the no-claim model work for the buyer.
function listingTitle(game) {
  return (game ? String(game).trim() : "Twitch") + " drop account — unclaimed";
}

function listingDescription(game, drops, login) {
  const lines = [
    "Twitch account with unclaimed Twitch Drops ready to claim. The drops are " +
      "already earned (100%) and left UNCLAIMED so you can connect your own game " +
      "account and receive them yourself.",
  ];
  if (game) lines.push("Game: " + game);
  const names = (drops || [])
    .map((d) => (d && d.name ? d.name : ""))
    .filter(Boolean);
  if (names.length) {
    lines.push("Unclaimed drops (" + names.length + "):");
    lines.push(names.join(", "));
  }
  lines.push(
    "Delivery: you receive the Twitch account login + password. Log in, go to " +
      "twitch.tv/drops/inventory, scroll to Received, click Connect on each item " +
      "and follow the instructions to add it to your account.",
  );
  if (login) lines.push("Account: " + login);
  return lines.join("\n");
}

// Which active-listing logins would block a fresh listing (one account, one
// buyer). Mirrors autoLister.pickDeliveryAccounts.
async function activeListingsForLogin(login) {
  const l = String(login || "").trim().toLowerCase();
  if (!l) return [];
  const esc = l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rows = await MarketplaceListing.find(
    { status: "active", accountLogin: new RegExp(esc, "i") },
    { marketplace: 1, externalId: 1, origin: 1, accountLogin: 1 },
  ).lean();
  return rows.filter((r) =>
    String(r.accountLogin || "")
      .split(/[,\s]+/)
      .some((x) => x.toLowerCase() === l),
  );
}

// Which of the given clientSecrets are already sold, keyed by clientSecret —
// the same markers the no-claim spent scan uses (BotAccount sale beats a pool
// marker; soldGames / "sold" claimedNote on the pool row).
async function soldMapForSecrets(secrets) {
  const map = new Map();
  const uniq = [...new Set((secrets || []).filter(Boolean))];
  if (!uniq.length) return map;
  const [bots, pool] = await Promise.all([
    BotAccount.find(
      { clientSecret: { $in: uniq } },
      { clientSecret: 1, soldAt: 1, soldBulkOrderId: 1, resellerId: 1 },
    ).lean(),
    AvailableAccount.find(
      { clientSecret: { $in: uniq } },
      { clientSecret: 1, soldGames: 1, claimedNote: 1 },
    ).lean(),
  ]);
  for (const b of bots) {
    let why = "";
    if (b.soldAt) why = "shop sale";
    else if (b.resellerId) why = "reseller";
    else if (b.soldBulkOrderId) why = "bulk order";
    if (why) map.set(b.clientSecret, { sold: true, why });
  }
  for (const p of pool) {
    if (map.has(p.clientSecret)) continue;
    if (Array.isArray(p.soldGames) && p.soldGames.length) {
      map.set(p.clientSecret, { sold: true, why: "sold-game marker" });
    } else if (/^sold/i.test(String(p.claimedNote || ""))) {
      map.set(p.clientSecret, { sold: true, why: "sold note" });
    }
  }
  return map;
}

function pi() {
  const host = hosts.resolveHost(HOST_ID);
  if (!host) {
    const e = new Error('Pi host "' + HOST_ID + '" is not configured.');
    e.status = 503;
    throw e;
  }
  return host;
}

async function sh(script, { timeout = 30000, input } = {}) {
  try {
    const { stdout } = await hosts.runShell(pi(), script, { timeout, input });
    return (stdout || "").trim();
  } catch (err) {
    if (err && err.unreachable) {
      const e = new Error("Raspberry Pi is unreachable over SSH.");
      e.status = 503;
      throw e;
    }
    throw err;
  }
}

async function readConfigRaw(id) {
  return await sh(
    `[ -f ${hosts.shq(CONFIG_PATH(id))} ] && cat ${hosts.shq(CONFIG_PATH(id))} || echo ''`,
    { timeout: 15000 },
  );
}

// Bounded mapLimit: run `fn(item)` for up to `n` items concurrently.
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, worker),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Candidate collection
// ---------------------------------------------------------------------------

// All no-claim bot configs in ONE batched Pi round trip: enumerate the config
// paths, then read them all (gzip/base64 batched). Returns flat account rows.
async function collectNoClaimCandidates() {
  const host = pi();
  const listOut = await sh(
    `ls -1d ${hosts.shq(BOTS_DIR)}/*/Configuration/config.json 2>/dev/null || true`,
    { timeout: 20000 },
  );
  const paths = listOut
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paths.length) return [];
  const files = await hosts.readFiles(host, paths);
  const out = [];
  for (const p of paths) {
    const f = files[p];
    if (!f || !f.ok || !f.text) continue;
    let cfg;
    try {
      cfg = JSON.parse(f.text);
    } catch {
      continue; // corrupt config — the bots page already flags those
    }
    const id = String(p.split("/")[5] || "").replace(/[^0-9]/g, "");
    const game = (cfg.FavouriteGames || [])[0] || "";
    const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
    for (const u of users) {
      if (!u || !u.ClientSecret) continue;
      out.push({
        source: "noclaim",
        login: u.Login || "",
        twitchId: String(u.Id || ""),
        clientSecret: u.ClientSecret || "",
        game,
        botId: id,
        container: containerFor(id),
      });
    }
  }
  return out;
}

// Every enabled, non-dead web-token account. The botId field is not a
// requirement — an idle account can still hold farmed-unclaimed drops, and the
// live-inventory check decides sellability either way.
async function collectWebbotCandidates() {
  const rows = await WebBotAccount.find(
    { enabled: true, lastStatus: { $ne: "dead" } },
    {
      _id: 1,
      login: 1,
      twitchId: 1,
      webToken: 1,
      credPasswordEnc: 1,
      hasPassword: 1,
      currentGame: 1,
      pinnedGame: 1,
      botId: 1,
      dropsReadyUnclaimed: 1,
    },
  ).lean();
  const out = [];
  for (const a of rows) {
    if (!a.webToken) continue;
    out.push({
      source: "webbot",
      id: String(a._id),
      login: a.login || "",
      twitchId: a.twitchId || "",
      webToken: a.webToken,
      password: plainPassword(a.credPasswordEnc),
      hasPassword: !!a.hasPassword,
      game: a.pinnedGame || a.currentGame || "",
      botId: a.botId || "",
    });
  }
  return out;
}

// Live inventory for one candidate, plus the sellable drops in it.
async function inventoryForCandidate(cand) {
  if (cand.source === "noclaim") {
    const inv = await twitchInventory.fetchInventory(cand.clientSecret, {
      host: pi(),
    });
    return { inv, sellable: sellableDropsFromNoClaimInv(inv), login: inv.login || cand.login };
  }
  const inv = await webbotTwitch.fetchInventory(cand.webToken);
  return { inv, sellable: sellableDropsFromWebbotInv(inv), login: cand.login };
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

async function marketsForGame(game) {
  const af = settings.getAutoFarm();
  const markets = ["gameflip"];
  if (af.platiCategoryId) markets.push("digiseller");
  let ggselCategoryId = "";
  try {
    ggselCategoryId = await mp.ggselResolveCategoryId(game);
  } catch {
    ggselCategoryId = "";
  }
  if (!ggselCategoryId) ggselCategoryId = String(af.ggselCategoryId || "");
  if (ggselCategoryId) markets.push("ggsel");
  let zeusxEnabled = false;
  if (af.zeusxAuto) {
    try {
      zeusxEnabled = !!(await mp.zeusxResolveCategory(game).catch(() => null));
    } catch {
      zeusxEnabled = false;
    }
  }
  if (zeusxEnabled) markets.push("zeusx");
  return { markets, ggselCategoryId, zeusxEnabled };
}

async function createAccountSet(cand, drops, price) {
  const game = cand.game || (drops[0] && drops[0].game) || "";
  return DropSet.create({
    name: (game || "Twitch") + " — unclaimed (" + (cand.login || cand.id || "acct") + ")",
    note: "Unclaimed auto-list — " + cand.source + " farm",
    items: drops.map((d) => ({
      itemKey: d.itemKey || d.name,
      name: d.name,
      game: d.game || game,
      image: d.imageURL || "",
      qty: 1,
    })),
    price,
    listed: false,
    custom: true,
    coverGame: game,
    accountScopeLogins: [cand.login || ""].filter(Boolean),
  });
}

// Publish one account to one market. Returns { externalId, url } or throws.
async function publishOneMarket({
  marketplace,
  cand,
  drops,
  price,
  img,
  ggselCategoryId,
}) {
  const game = cand.game || (drops[0] && drops[0].game) || "";
  const login = cand.login || "";
  const password = cand.password || "";
  const title = listingTitle(game, login);
  const description = listingDescription(game, drops, login);

  if (marketplace === "gameflip") {
    const r = await mp.gameflipPublish({
      title,
      description,
      priceUsd: price,
      imagePath: img || undefined,
      autoDeliverCode: gameflipDeliveryCode(login, password),
    });
    return { externalId: r.externalId, url: r.url || "" };
  }
  if (marketplace === "digiseller") {
    const af = settings.getAutoFarm();
    const attributes = af.platiAttributes || [];
    const r = await mp.digisellerPublish({
      title,
      description,
      priceUsd: price,
      categories: [{ owner: 1, categoryId: af.platiCategoryId, attributes }],
    });
    let contentIds = [];
    try {
      const added = await mp.digisellerAddContent(
        r.externalId,
        [digisellerDeliveryCode(login, password)],
      );
      contentIds = (added && added.contentIds) || [];
    } catch (err) {
      await mp.digisellerDelist(r.externalId).catch(() => {});
      throw err;
    }
    if (img) await mp.digisellerUploadImage(r.externalId, img).catch(() => {});
    return {
      externalId: r.externalId,
      url: r.url || "",
      units: [
        {
          contentId: contentIds[0] || "",
          accountId: cand.id || "",
          login,
          addedAt: new Date(),
        },
      ],
    };
  }
  if (marketplace === "ggsel") {
    const r = await mp.ggselPublish({
      title,
      description,
      priceUsd: price,
      categoryId: ggselCategoryId,
      delivery: "auto",
      coverImagePath: img || undefined,
      products: [ggselDeliveryCode(login, password)],
    });
    return { externalId: r.externalId, url: r.url || "" };
  }
  if (marketplace === "zeusx") {
    const af = settings.getAutoFarm();
    const r = await mp.zeusxPublish({
      title,
      description,
      priceUsd: price,
      game,
      coverImagePath: img || undefined,
      autoDeliverAccounts: af.zeusxAutoDeliver
        ? [{ login, password, email: "" }]
        : undefined,
      quantity: af.zeusxAutoDeliver ? undefined : 1,
    });
    return { externalId: r.externalId, url: r.url || "" };
  }
  throw new Error("unknown marketplace " + marketplace);
}

function rowForMarket(marketplace, set, cand, price, r, extra) {
  const base = {
    set: set._id,
    marketplace,
    externalId: r.externalId,
    url: r.url || "",
    title: listingTitle(cand.game || (cand.drops && cand.drops[0] && cand.drops[0].game) || "", cand.login),
    description: listingDescription(
      cand.game || (cand.drops && cand.drops[0] && cand.drops[0].game) || "",
      cand.drops || [],
      cand.login,
    ),
    price,
    status: "active",
    origin: ORIGIN,
    note: "unclaimed auto-list — " + cand.source + " farm",
    autoDeliver: marketplace !== "zeusx" || (settings.getAutoFarm().zeusxAutoDeliver ? true : false),
    accountId: cand.id || "",
    accountLogin: cand.login || "",
    qtyRemaining: 0, // one account per listing — never relist another account
    qtyTarget: 0, // the guardian must not feed/top-up these
  };
  if (extra && extra.units) base.units = extra.units;
  return base;
}

// Publish the account on every configured market, creating the ledger + rows.
// Returns { set, rows, errors }.
async function listAccount(cand, drops) {
  const game = cand.game || (drops[0] && drops[0].game) || "";
  const research = await MarketResearch.findOne({ game }).lean().catch(() => null);
  const price = derivePrice(research);
  const set = await createAccountSet(cand, drops, price);

  let img = "";
  try {
    img = await buildSetGridImage(set);
  } catch {
    img = "";
  }

  const { markets, ggselCategoryId } = await marketsForGame(game);
  const rows = [];
  const errors = {};

  // Gameflip first — it is the anchor market; a Gameflip failure aborts the
  // account so nothing is published half-way.
  const gfIndex = markets.indexOf("gameflip");
  if (gfIndex >= 0) {
    try {
      const r = await publishOneMarket({
        marketplace: "gameflip",
        set,
        cand: { ...cand, drops },
        drops,
        price,
        img,
        ggselCategoryId,
      });
      const row = await MarketplaceListing.create(
        rowForMarket("gameflip", set, { ...cand, drops }, price, r),
      );
      rows.push(row);
      markets.splice(gfIndex, 1);
    } catch (e) {
      errors.gameflip = e.message;
    }
  }
  if (!rows.length) {
    // Anchor publish failed — no partial state: remove the set and retry next
    // pass (the account is untouched).
    await DropSet.deleteOne({ _id: set._id }).catch(() => {});
    if (img) await fsp.unlink(img).catch(() => {});
    throw new Error("Gameflip publish failed: " + (errors.gameflip || "no market"));
  }

  for (const marketplace of markets) {
    try {
      const r = await publishOneMarket({
        marketplace,
        set,
        cand: { ...cand, drops },
        drops,
        price,
        img,
        ggselCategoryId,
      });
      const extra = r.units ? { units: r.units } : {};
      const row = await MarketplaceListing.create(
        rowForMarket(marketplace, set, { ...cand, drops }, price, r, extra),
      );
      rows.push(row);
    } catch (e) {
      errors[marketplace] = e.message;
    }
  }
  if (img) await fsp.unlink(img).catch(() => {});

  // Record stock baselines for the quantity markets we will sale-detect from.
  for (const row of rows) {
    if (row.marketplace === "digiseller" || row.marketplace === "ggsel") {
      try {
        const stock =
          row.marketplace === "digiseller"
            ? await mp.digisellerProductStockDetailed(row.externalId)
            : await mp.ggselOfferStockDetailed(row.externalId);
        await MarketplaceListing.updateOne(
          { _id: row._id },
          { $set: { lastStock: stock && stock.stock != null ? stock.stock : 1 } },
        ).catch(() => {});
      } catch {
        /* baseline read is best-effort */
      }
    }
  }

  const ledger = await UnclaimedAccount.findOneAndUpdate(
    { loginLower: String(cand.login || "").toLowerCase(), source: cand.source },
    {
      $set: {
        source: cand.source,
        login: cand.login || "",
        loginLower: String(cand.login || "").toLowerCase(),
        twitchId: cand.twitchId || "",
        game,
        poolAccountId: cand.poolAccountId || "",
        webBotAccountId: cand.source === "webbot" ? cand.id || "" : "",
        botId: cand.botId || "",
        container: cand.container || "",
        drops: drops.map((d) => ({
          name: d.name,
          game: d.game || game,
          campaign: d.campaign || "",
          itemKey: d.itemKey || d.name,
        })),
        status: "listed",
        note: Object.keys(errors).length
          ? "listed; secondary errors: " + JSON.stringify(errors)
          : "",
        listingIds: rows.map((r) => String(r._id)),
        listingExternalIds: rows.map((r) => r.externalId),
        listedAt: new Date(),
        lastCheckedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  logEvent({
    category: "unclaimed",
    action: "listed",
    actor: "unclaimedAutoList",
    subject: cand.login || cand.id || "",
    game: game || "",
    count: rows.length,
    detail:
      cand.source +
      " account " +
      (cand.login || cand.id || "") +
      " auto-listed on " +
      rows.map((r) => r.marketplace).join(", ") +
      " ($" +
      price +
      ")",
  });
  return { set, rows, errors, ledger };
}

// Retry secondary markets that failed at publish time for an already-listed
// account (same price/title/set — only the missing markets are attempted).
async function retrySecondaries(ledger) {
  if (ledger.status !== "listed") return { retried: 0 };
  const existing = await MarketplaceListing.find(
    { _id: { $in: (ledger.listingIds || []).filter(Boolean) }, origin: ORIGIN },
    { marketplace: 1, status: 1, set: 1 },
  ).lean();
  if (!existing.length) return { retried: 0 };
  const have = new Set(existing.map((r) => r.marketplace));
  const set = await DropSet.findById(existing[0].set).lean();
  if (!set) return { retried: 0 };
  const game = ledger.game || (set.items && set.items[0] && set.items[0].game) || "";
  const { markets, ggselCategoryId } = await marketsForGame(game);
  const missing = markets.filter((m) => !have.has(m));
  const failed = new Set();
  let retried = 0;
  for (const marketplace of missing) {
    const cand = {
      source: ledger.source,
      id: ledger.source === "webbot" ? ledger.webBotAccountId : ledger.poolAccountId,
      login: ledger.login,
      password: "", // filled below from the stored account
      game,
    };
    if (ledger.source === "noclaim") {
      const pool = await AvailableAccount.findById(ledger.poolAccountId).lean();
      if (pool) cand.password = poolPassword(pool);
    } else {
      const wb = await WebBotAccount.findById(ledger.webBotAccountId).lean();
      if (wb) cand.password = plainPassword(wb.credPasswordEnc);
    }
    if (!cand.password) continue;
    try {
      const drops = set.items.map((i) => ({
        name: i.name,
        game: i.game,
        campaign: "",
        imageURL: i.image,
        itemKey: i.itemKey,
      }));
      const r = await publishOneMarket({
        marketplace,
        set,
        cand: { ...cand, drops },
        drops,
        price: Number(set.price) || 0,
        img: "",
        ggselCategoryId,
      });
      await MarketplaceListing.create(
        rowForMarket(marketplace, set, { ...cand, drops }, Number(set.price) || 0, r),
      );
      await MarketplaceListing.updateOne(
        { _id: existing[0]._id },
        { $set: { lastError: "" } },
      ).catch(() => {});
      have.add(marketplace);
      retried++;
    } catch (e) {
      failed.add(marketplace);
      await MarketplaceListing.updateOne(
        { _id: existing[0]._id },
        { $set: { lastError: "secondary " + marketplace + ": " + e.message } },
      ).catch(() => {});
    }
  }
  const stillMissing = markets.filter((m) => !have.has(m) && !failed.has(m));
  await UnclaimedAccount.updateOne(
    { _id: ledger._id },
    {
      $set: {
        note: stillMissing.length
          ? "listed; secondary errors: " + JSON.stringify(stillMissing)
          : "",
      },
    },
  ).catch(() => {});
  return { retried };
}

// ---------------------------------------------------------------------------
// Lifecycle: expiry, pool return, spent
// ---------------------------------------------------------------------------

async function delistRowsForAccount(rows) {
  const results = [];
  for (const row of rows) {
    if (row.status !== "active") {
      results.push({ row, ok: true });
      continue;
    }
    let ok = true;
    try {
      if (row.marketplace === "gameflip") await mp.gameflipDelist(row.externalId);
      else if (row.marketplace === "digiseller") await mp.digisellerDelist(row.externalId);
      else if (row.marketplace === "ggsel") await mp.ggselDelist(row.externalId);
      else if (row.marketplace === "zeusx") await mp.zeusxDelist(row.externalId);
    } catch (e) {
      ok = false;
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { lastError: "auto-delist: " + e.message } },
      ).catch(() => {});
    }
    if (ok) {
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { status: "delisted" } },
      ).catch(() => {});
    }
    results.push({ row, ok });
  }
  return results;
}

// Release an account whose drops all expired. No-claim -> pool row back to
// available; webbot -> idle in its own registry.
async function releaseToPool(ledger) {
  if (ledger.source === "noclaim" && ledger.poolAccountId) {
    const r = await AvailableAccount.updateOne(
      { _id: ledger.poolAccountId, status: "claimed" },
      {
        $set: {
          status: "available",
          claimedNote: "expired — unclaimed auto-list release",
        },
      },
    );
    const cur = await AvailableAccount.findById(ledger.poolAccountId, {
      status: 1,
    }).lean();
    if ((r.matchedCount || 0) > 0 || (cur && cur.status !== "claimed")) {
      await recordPoolUsage([ledger.poolAccountId], {
        event: "released",
        actor: "unclaimedAutoList",
        note: "expired — unclaimed auto-list release",
        game: ledger.game || "",
      }).catch(() => {});
      return true;
    }
    return false;
  }
  if (ledger.source === "webbot" && ledger.webBotAccountId) {
    await WebBotAccount.updateOne(
      { _id: ledger.webBotAccountId },
      { $set: { botId: "", pinnedGame: "", lastStatus: "idle" } },
    );
    return true;
  }
  return false;
}

// SPENT path: the buyer owns it (a sale was detected, or a listed drop flipped
// to claimed). Stop farming it, stamp the pool row so the recycler sees it,
// NEVER return it to the pool.
async function spendAccount(ledger, reason, { rows = [] } = {}) {
  const at = new Date();
  // The buyer owns this account now — every OTHER live row for it must come
  // down so no second buyer can ever be handed the same account.
  const activeOthers = (rows || []).filter((r) => r.status === "active");
  if (activeOthers.length) {
    await delistRowsForAccount(activeOthers);
  }
  if (ledger.source === "noclaim") {
    const secrets = [];
    let game = ledger.game || "";
    if (ledger.botId && ledger.container) {
      try {
        const raw = await readConfigRaw(ledger.botId);
        if (raw) {
          const cfg = JSON.parse(raw);
          const users = (cfg.TwitchSettings && cfg.TwitchSettings.TwitchUsers) || [];
          game = game || (cfg.FavouriteGames || [])[0] || "";
          const victim = users.find(
            (u) => String(u.Login || "").toLowerCase() === String(ledger.login || "").toLowerCase(),
          );
          if (victim && victim.ClientSecret) secrets.push(victim.ClientSecret);
          const kept = victim
            ? users.filter((u) => u.ClientSecret !== victim.ClientSecret)
            : users;
          cfg.TwitchSettings.TwitchUsers = kept;
          await sh(
            `cat > ${hosts.shq(CONFIG_PATH(ledger.botId))} && chmod 600 ${hosts.shq(CONFIG_PATH(ledger.botId))}`,
            { timeout: 20000, input: JSON.stringify(cfg, null, 2) },
          );
          if (kept.length > 0) {
            await sh(`docker restart ${hosts.shq(ledger.container)} 2>/dev/null || true`, {
              timeout: 40000,
            });
          } else {
            await sh(`docker stop ${hosts.shq(ledger.container)} 2>/dev/null || true`, {
              timeout: 25000,
            });
          }
        }
      } catch (e) {
        // Config surgery must never block the sale bookkeeping.
        console.error("unclaimedAutoList: no-claim bot cleanup failed:", e.message);
      }
    }
    if (secrets.length) {
      const rowsPool = await AvailableAccount.find(
        { clientSecret: { $in: secrets } },
        { clientSecret: 1, soldGames: 1 },
      ).lean();
      const rowBySecret = new Map(rowsPool.map((r) => [r.clientSecret, r]));
      const stampGame = settings.normGameName(game);
      const writes = [];
      const stampedIds = [];
      for (const cs of secrets) {
        const r = rowBySecret.get(cs);
        if (!r) continue;
        const games = new Set(
          (Array.isArray(r.soldGames) ? r.soldGames : []).filter(Boolean),
        );
        if (stampGame) games.add(stampGame);
        writes.push({
          updateOne: {
            filter: { _id: r._id, status: "claimed" },
            update: {
              $set: {
                claimedNote: "spent — unclaimed auto-listed (" + reason + ")",
                soldGames: [...games],
              },
            },
          },
        });
        stampedIds.push(r._id);
      }
      if (writes.length) {
        await AvailableAccount.bulkWrite(writes).catch(() => {});
        await recordPoolUsage(stampedIds, {
          event: "spent",
          actor: "unclaimedAutoList",
          note: "spent — unclaimed auto-listed (" + reason + ")",
          game: stampGame || "",
        }).catch(() => {});
      }
    }
    // Also log into the no-claim spent view so the No-claim section shows it.
    const loginLower = String(ledger.login || "").toLowerCase();
    await NoclaimSpentAccount.updateOne(
      loginLower ? { loginLower } : { twitchId: ledger.twitchId || "", login: ledger.login || "" },
      {
        $set: {
          login: ledger.login || "",
          loginLower,
          twitchId: ledger.twitchId || "",
          game,
          botId: ledger.botId || "",
          container: ledger.container || "",
          sold: true,
          connected: false,
          soldWhy: "unclaimed auto-list: " + reason,
          tokenStatus: "ok",
          actor: "unclaimedAutoList",
          sweptAt: at,
        },
      },
      { upsert: true },
    ).catch(() => {});
  } else if (ledger.source === "webbot" && ledger.webBotAccountId) {
    await WebBotAccount.updateOne(
      { _id: ledger.webBotAccountId },
      {
        $set: {
          enabled: false,
          botId: "",
          pinnedGame: "",
          lastStatus: "idle",
          note: "auto-sold via unclaimed auto-list (" + reason + ")",
        },
      },
    ).catch(() => {});
  }

  await UnclaimedAccount.updateOne(
    { _id: ledger._id, status: "listed" },
    { $set: { status: "sold", soldAt: at, note: reason, lastCheckedAt: at } },
  ).catch(() => {});

  logEvent({
    category: "unclaimed",
    action: "sold",
    actor: "unclaimedAutoList",
    subject: ledger.login || ledger._id || "",
    game: ledger.game || "",
    count: rows.length || 1,
    detail:
      "sold (" + reason + ") — " + (ledger.source || "") + " account " + (ledger.login || ""),
  });
  sendTelegram(
    "💰 SOLD (unclaimed auto-list)\n\n" +
      (ledger.login || "?") +
      "\nGame: " +
      (ledger.game || "?") +
      "\nSource: " +
      (ledger.source || "?") +
      "\nReason: " +
      reason,
  ).catch((e) => console.error("unclaimed sale notify error:", e.message));
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

// Scan candidates + list new sellable accounts, and retry failed secondaries.
async function scanAndListPass() {
  const cands = [];
  try {
    const [noClaim, webbot] = await Promise.all([
      collectNoClaimCandidates(),
      collectWebbotCandidates(),
    ]);
    cands.push(...noClaim, ...webbot);
  } catch (e) {
    return { skipped: true, error: e.message };
  }
  if (!cands.length) return { candidates: 0, listed: 0 };

  // Resolve passwords for no-claim candidates (pool row) and record which pool
  // row each maps to, so the ledger can release it later.
  const secrets = cands
    .filter((c) => c.source === "noclaim")
    .map((c) => c.clientSecret)
    .filter(Boolean);
  const poolBySecret = new Map();
  if (secrets.length) {
    const poolRows = await AvailableAccount.find(
      { clientSecret: { $in: secrets } },
      { clientSecret: 1, password: 1, credPasswordEnc: 1, status: 1 },
    ).lean();
    for (const p of poolRows) poolBySecret.set(p.clientSecret, p);
  }
  for (const c of cands) {
    if (c.source === "noclaim") {
      const p = poolBySecret.get(c.clientSecret);
      c.poolAccountId = p ? String(p._id) : "";
      c.id = c.poolAccountId;
      c.password = poolPassword(p);
    }
  }

  // Accounts already listed/sold are skipped (their drops are committed).
  const ledgered = await UnclaimedAccount.find(
    { status: { $in: ["listed", "sold"] } },
    { loginLower: 1, source: 1 },
  ).lean();
  const already = new Set(
    ledgered.map((l) => l.source + ":" + (l.loginLower || "")),
  );
  const soldBySecret = await soldMapForSecrets(secrets);

  const work = [];
  for (const c of cands) {
    const key = c.source + ":" + String(c.login || "").toLowerCase();
    if (already.has(key)) continue;
    if (!c.login && c.source === "noclaim") continue; // config without login
    if (c.source === "noclaim" && soldBySecret.get(c.clientSecret)) continue;
    if (c.password === "" && c.source === "webbot") continue; // nothing to sell
    work.push(c);
  }
  // Ready no-claim bot accounts scan first (numeric bot id, so bot 3-6 come
  // before bot 10), then webbot accounts on a bot, then idle webbot accounts.
  work.sort((a, b) => {
    const ka = (a.source === "webbot" ? 1 : 0) + ":" + padBot(a.botId);
    const kb = (b.source === "webbot" ? 1 : 0) + ":" + padBot(b.botId);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const batch = work.slice(0, SCAN_LIMIT);

  let listed = 0;
  const skipped = [];
  await mapLimit(batch, CONCURRENCY, async (cand) => {
    try {
      if (cand.source === "webbot" && !cand.password) return;
      if (cand.source === "webbot" && !cand.login) {
        try {
          const v = await webbotTwitch.validateToken(cand.webToken);
          cand.login = v.login || "";
          cand.twitchId = v.twitchId || "";
        } catch {
          return; // dead token — not listable
        }
      }
      const active = await activeListingsForLogin(cand.login);
      if (active.length) {
        await noteSkipped(cand, "already on active listing(s)");
        return;
      }
      let inv;
      try {
        inv = await inventoryForCandidate(cand);
      } catch {
        // token trouble / transport — leave it for next pass, don't churn the
        // ledger with per-pass noise
        return;
      }
      const sellable = inv.sellable || [];
      if (!sellable.length) return; // still farming / nothing ready
      if (!inv.login && cand.source === "noclaim") return;
      const login = inv.login || cand.login;
      const password = cand.source === "noclaim" ? cand.password : cand.password;
      if (!password) {
        await noteSkipped({ ...cand, login }, "no stored password — cannot sell");
        return;
      }
      const withLogin = { ...cand, login, password };
      const existing = await UnclaimedAccount.findOne({
        source: withLogin.source,
        loginLower: String(login).toLowerCase(),
      }).lean();
      if (existing && (existing.status === "listed" || existing.status === "sold")) return;
      await listAccount(withLogin, sellable);
      listed++;
    } catch (e) {
      skipped.push({ login: cand.login || cand.id || "", error: e.message });
    }
  });

  // Retry secondaries for a few listed accounts with missing markets.
  let retried = 0;
  const pendingSecondaries = await UnclaimedAccount.find(
    { status: "listed", note: /secondary errors|listed; secondary/i },
    { login: 1, source: 1, poolAccountId: 1, webBotAccountId: 1, game: 1, _id: 1, loginLower: 1 },
  )
    .sort({ listedAt: 1 })
    .limit(RETRY_LIMIT)
    .lean();
  for (const led of pendingSecondaries) {
    const r = await retrySecondaries(led).catch(() => ({ retried: 0 }));
    retried += r.retried || 0;
  }

  return { candidates: work.length, scanned: batch.length, listed, retried, skipped };
}

async function noteSkipped(cand, note) {
  await UnclaimedAccount.updateOne(
    {
      source: cand.source,
      loginLower: String(cand.login || "").toLowerCase(),
    },
    {
      $set: {
        source: cand.source,
        login: cand.login || "",
        loginLower: String(cand.login || "").toLowerCase(),
        twitchId: cand.twitchId || "",
        game: cand.game || "",
        poolAccountId: cand.poolAccountId || "",
        webBotAccountId: cand.source === "webbot" ? cand.id || "" : "",
        botId: cand.botId || "",
        container: cand.container || "",
        status: "skipped",
        note,
        lastCheckedAt: new Date(),
      },
    },
    { upsert: true },
  ).catch(() => {});
}

// Verify listed accounts against live inventory: detect sales on the quantity
// markets, flip spent accounts (buyer took a drop), delist + pool-return
// accounts whose drops all expired.
async function expirySalePass() {
  const listed = await UnclaimedAccount.find({ status: "listed" })
    .sort({ listedAt: 1 })
    .limit(CHECK_LIMIT)
    .lean();
  let checked = 0;
  let sold = 0;
  let expired = 0;
  let released = 0;

  await mapLimit(listed, CONCURRENCY, async (ledger) => {
    try {
      // Load the account credential + live inventory.
      let cand = null;
      if (ledger.source === "noclaim") {
        const pool = ledger.poolAccountId
          ? await AvailableAccount.findById(ledger.poolAccountId).lean()
          : null;
        if (!pool || !pool.clientSecret) return;
        cand = {
          source: "noclaim",
          login: ledger.login,
          clientSecret: pool.clientSecret,
          password: poolPassword(pool),
        };
      } else {
        const wb = ledger.webBotAccountId
          ? await WebBotAccount.findById(ledger.webBotAccountId).lean()
          : null;
        if (!wb || !wb.webToken) return;
        cand = {
          source: "webbot",
          login: ledger.login,
          webToken: wb.webToken,
          password: plainPassword(wb.credPasswordEnc),
        };
      }
      let sellable = [];
      let inv = null;
      try {
        inv = await inventoryForCandidate(cand);
        sellable = inv.sellable || [];
      } catch (e) {
        // Pi/network trouble — do not delist or sell on a failed read.
        await UnclaimedAccount.updateOne(
          { _id: ledger._id },
          { $set: { lastCheckedAt: new Date(), note: "check failed: " + e.message } },
        ).catch(() => {});
        return;
      }

      // Rows for this account.
      const rows = await MarketplaceListing.find(
        { origin: ORIGIN, accountLogin: ledger.login },
        {
          _id: 1,
          marketplace: 1,
          externalId: 1,
          status: 1,
          price: 1,
          lastStock: 1,
          set: 1,
          qtyTarget: 1,
        },
      ).lean();
      const activeRows = rows.filter((r) => r.status === "active");

      // 1) Quantity-market sale detection (Digiseller/GGSel sell natively).
      for (const row of activeRows) {
        if (row.marketplace !== "digiseller" && row.marketplace !== "ggsel") continue;
        try {
          const stock =
            row.marketplace === "digiseller"
              ? await mp.digisellerProductStockDetailed(row.externalId)
              : await mp.ggselOfferStockDetailed(row.externalId);
          const remaining = stock && stock.stock != null ? stock.stock : null;
          if (remaining !== null) {
            const last = row.lastStock == null ? remaining : Number(row.lastStock);
            if (remaining < last) {
              const set = await DropSet.findById(row.set).lean();
              await MarketplaceListing.updateOne(
                { _id: row._id, status: "active" },
                { $set: { status: "sold" } },
              );
              if (set) {
                await recordListingSale({
                  listing: row,
                  set,
                  units: 1,
                  priceUsd: Number(row.price) || 0,
                }).catch(() => {});
              }
              sendTelegram(
                "💰 SOLD on " + row.marketplace + " (unclaimed auto-list)\n\n" +
                  (ledger.login || "?") + "\n$" + (Number(row.price) || 0).toFixed(2),
              ).catch(() => {});
              sold++;
              await spendAccount(ledger, row.marketplace + " sale", { rows });
              return;
            }
            await MarketplaceListing.updateOne(
              { _id: row._id },
              { $set: { lastStock: remaining } },
            ).catch(() => {});
          }
        } catch {
          /* platform read failed — leave the row alone this pass */
        }
      }

      // 2) A marketplace already marked one of our rows sold (Gameflip's
      // fulfiller, or a manual ZeusX hand-over marked from the panel) — the
      // buyer owns this account now.
      const soldRow = rows.find((r) => r.status === "sold");
      if (soldRow) {
        sold++;
        await spendAccount(ledger, soldRow.marketplace + " sale", { rows });
        return;
      }

      // 3) A listed drop flipped to claimed = the buyer connected and took it
      // (spent — never pool-return a claimed account).
      const ledgerKeys = new Set(
        (ledger.drops || []).map((d) => String(d.name || "").toLowerCase()),
      );
      let claimedNow = false;
      if (cand.source === "noclaim") {
        claimedNow = (inv.inProgress || []).some(
          (d) => d.claimed && ledgerKeys.has(String(d.name || "").toLowerCase()),
        );
      } else {
        claimedNow = (inv.drops || []).some(
          (d) => d.claimed && ledgerKeys.has(String(d.name || "").toLowerCase()),
        );
      }
      if (claimedNow) {
        sold++;
        await spendAccount(ledger, "buyer claimed a listed drop", { rows });
        return;
      }

      // 4) Everything expired -> delist + release to pool.
      if (!sellable.length) {
        const results = await delistRowsForAccount(activeRows);
        const allOk = results.every((r) => r.ok);
        await UnclaimedAccount.updateOne(
          { _id: ledger._id },
          { $set: { status: "expired", expiredAt: new Date(), note: allOk ? "drops expired — delisted" : "drops expired — delist pending" } },
        ).catch(() => {});
        expired++;
        if (allOk) {
          const ok = await releaseToPool(ledger);
          if (ok) {
            await UnclaimedAccount.updateOne(
              { _id: ledger._id, status: "expired" },
              { $set: { status: "released", releasedAt: new Date() } },
            ).catch(() => {});
            released++;
          }
        }
        logEvent({
          category: "unclaimed",
          action: "expired",
          actor: "unclaimedAutoList",
          subject: ledger.login || ledger._id || "",
          game: ledger.game || "",
          count: activeRows.length,
          detail: "drops expired — delisted + returned to pool (" + ledger.source + ")",
        });
        return;
      }

      checked++;
      await UnclaimedAccount.updateOne(
        { _id: ledger._id },
        {
          $set: {
            lastCheckedAt: new Date(),
            drops: sellable.map((d) => ({
              name: d.name,
              game: d.game || ledger.game,
              campaign: d.campaign || "",
              itemKey: d.itemKey || d.name,
            })),
            note: "",
          },
        },
      ).catch(() => {});
    } catch (e) {
      console.error("unclaimedAutoList expiry pass error:", e.message);
    }
  });

  return { checked, sold, expired, released };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function runOnce(opts = {}) {
  if (running) return { skipped: "already running", lastRun };
  running = true;
  const startedAt = new Date();
  try {
    const scan = opts.scan !== false ? await scanAndListPass() : null;
    const check = opts.check !== false ? await expirySalePass() : null;
    lastRun = {
      at: startedAt,
      scan,
      check,
      tookMs: Date.now() - startedAt.getTime(),
    };
    return lastRun;
  } finally {
    running = false;
  }
}

function isPaused() {
  return !!settings.getAutoFarm().unclaimedAutoListPaused;
}

function status() {
  const af = settings.getAutoFarm();
  return {
    enabled: !!af.unclaimedAutoList,
    paused: !!af.unclaimedAutoListPaused,
    running,
    lastRun,
    lastCheck,
    tickMs: TICK_MS,
  };
}

function start() {
  if (timer) return;
  timer = true;
  const tick = async () => {
    try {
      if (!settings.getAutoFarm().unclaimedAutoList) return;
      if (settings.getAutoFarm().unclaimedAutoListPaused) return;
      const r = await runOnce({});
      if (r && r.check) lastCheck = r.check;
    } catch (e) {
      console.error("unclaimedAutoList tick error:", e.message);
    } finally {
      const t = setTimeout(tick, TICK_MS);
      if (t.unref) t.unref();
    }
  };
  const t = setTimeout(tick, TICK_MS);
  if (t.unref) t.unref();
}

module.exports = {
  // pure, tested
  sellableDropsFromNoClaimInv,
  sellableDropsFromWebbotInv,
  plainPassword,
  listingTitle,
  listingDescription,
  activeListingsForLogin,
  soldMapForSecrets,
  // engine
  listAccount,
  retrySecondaries,
  spendAccount,
  releaseToPool,
  delistRowsForAccount,
  collectNoClaimCandidates,
  collectWebbotCandidates,
  inventoryForCandidate,
  runOnce,
  status,
  start,
  isPaused,
  ORIGIN,
  TICK_MS,
  SCAN_LIMIT,
  CHECK_LIMIT,
};
