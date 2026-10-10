// ---------------------------------------------------------------------------
// AUTO-FARM UNCLAIMED STOCK (docs/UNCLAIMED-SELLING-PLAN.md, Stage 2)
//
// Since 2026-10-05 Twitch refuses a drop claim from an account that is not
// linked to the game (twitchdev/issues #1216). An auto-farm account is never
// linked, so it now ends a campaign with every drop at 100% and UNCLAIMED —
// exactly what the no-claim farm sells, except that the account sits in an
// auto-farm bot config, on an AutoFarmTask, with a Drops Archive record.
//
// This module lets the ONE claim layer (utils/noclaimStock.js) sell those
// accounts too. It adds four things and owns nothing else:
//
//   candidates  which auto-farm accounts may hold such stock. Database only —
//               no SSH: the pool row, the task and the archive already say who
//               is deployed and who is clean.
//   sellable    which finished drops on such an account are stock: the ones a
//               CLAIMING bot cannot claim (the campaign needs a link, and the
//               account is not connected to it). Anything else is claimed by
//               its bot within a minute and is not there to sell.
//   free rules  what an auto-farm account must be, on top of the claim layer's
//               own rules, before a buyer may have it (see blockReason).
//   retire      what a sale does that the no-claim clean-up cannot: the account
//               comes out of the AUTO-FARM bot configs, off its tasks and out
//               of the Drops Archive, and only then is its pool row "spent".
//               unclaimedAutoList.spendAccount looks in no-claim configs only;
//               given one of these it would find nothing to remove, call that
//               proof, and mark an account that is still farming as spent.
//
// One account, one buyer: the buyer gets the whole account, so it leaves the
// farm. Everything is behind autoFarm.autofarmStock (default OFF); with the
// switch off this module reads nothing and the claim layer behaves exactly as
// it did. The post-sale pass runs regardless — a sale already made is owed its
// clean-up whatever the switch says now.
// ---------------------------------------------------------------------------
const settings = require("./settings");

const FARM = "autofarm";
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTO_FARM_NOTE = /^auto-farm( backfill)?:/i;
const STOCK_NOTE = /^unclaimed stock — /;
const DEAD_SCAN = new Set(["suspended", "token_invalid"]);
const CONFIG_RE = /^config(_[A-Za-z0-9-]+)?\.json$/;
// Twitch's own placeholder for "this campaign needs no account link".
const NO_LINK_RE = /^https?:\/\/(www\.)?twitch\.tv\/?$/i;
// What the pool row says once the account has left farming for its buyer.
const SPENT_LABEL = "auto-farm unclaimed sale";
// DropLog.soldToUsername of the claimed drops that left with a sold account.
// Not a marketplace tag (utils/marketClaimTags), so it reads as a real sale.
const SOLD_TAG = "unclaimed-sale";

const lower = (s) => String(s || "").trim().toLowerCase();
const str = (v) => (v == null ? "" : String(v));

function clampInt(v, d, lo, hi) {
  if (v == null || (typeof v === "string" && !v.trim())) return d;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

// Read fresh on every call, so one settings edit turns it on or off without a
// restart. A settings module without getAutoFarm (a partial deploy, a test
// stub) reads as OFF.
function cfg() {
  let af = null;
  try {
    if (typeof settings.getAutoFarm === "function") af = settings.getAutoFarm();
  } catch (e) {
    console.error("autofarmStock: auto-farm settings unreadable:", e && e.message);
  }
  af = af && typeof af === "object" ? af : {};
  const norm = typeof settings.normGameName === "function" ? settings.normGameName : lower;
  return {
    on: af.autofarmStock === true,
    // Live inventory reads per holdings tick, on top of the no-claim farm's
    // own quota — its cadence is never diluted.
    perTick: clampInt(af.autofarmStockPerTick, 15, 0, 60),
    // Most unsold CLAIMED drops an account may carry and still be sold whole:
    // they go to the buyer with it, and the claimed archive loses them.
    maxLeftover: clampInt(af.autofarmStockMaxLeftover, 5, 0, 200),
    // A task that ended this long ago still supplies candidates (a drop lives
    // 7 days past its campaign).
    taskDays: clampInt(af.autofarmStockTaskDays, 8, 1, 30),
    // Optional allow-list of games (normalised); empty = every game.
    games: (Array.isArray(af.autofarmStockGames) ? af.autofarmStockGames : [])
      .map((g) => norm(g))
      .filter(Boolean),
  };
}

function gameAllowed(game, games) {
  if (!games || !games.length) return true;
  const norm = typeof settings.normGameName === "function" ? settings.normGameName : lower;
  const g = norm(game);
  return !!g && games.some((w) => g === w || g.includes(w) || w.includes(g));
}

// ---------------------------------------------------------------------------
// Sellable drops
// ---------------------------------------------------------------------------

// True only when the campaign is KNOWN to need a link. An empty URL is
// unknown, and unknown is not stock: a drop a bot can still claim will not be
// in the inventory by the time a buyer logs in.
function linkRequired(accountLinkURL) {
  const u = str(accountLinkURL).trim();
  if (!u) return false;
  return !NO_LINK_RE.test(u);
}

// The finished drops of an auto-farm account a buyer can claim: in progress,
// at 100%, unclaimed, from a campaign that needs a link the account does not
// have. Same entry shape as unclaimedAutoList.sellableDropsFromNoClaimInv.
function sellableFromInv(inv) {
  const out = [];
  for (const d of (inv && inv.inProgress) || []) {
    if (!d || !(Number(d.percent) >= 100) || d.claimed) continue;
    if (d.connected) continue;
    if (!linkRequired(d.accountLinkURL)) continue;
    out.push({
      name: d.name || "Reward",
      game: d.game || "",
      campaign: d.campaign || "",
      imageURL: d.imageURL || "",
      itemKey: lower(d.name) + "|" + lower(d.game),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Free rules
// ---------------------------------------------------------------------------

// Pure. `f` is one account's facts (factsFor); "" = an auto-farm account that
// may be sold whole, else the first reason it may not.
function blockReason(f, { maxLeftover = 5 } = {}) {
  if (!f) return "not checked";
  if (!f.noteOk) return "not an auto-farm account";
  if (!f.token) return "no token";
  if (!f.bots) return "no bot record";
  // Two records for one token, or one login under two tokens: which of them a
  // drop, a sale or a config entry belongs to is a guess (the duplicate-login
  // population), and a guess here is a second buyer for one account.
  if (f.bots > 1) return "two bot records for one token";
  if (f.twins) return "login used by another token";
  if (DEAD_SCAN.has(f.scan)) return "dead token or suspended";
  if (f.reseller) return "reseller account";
  if (f.botSold) return "sold or reserved (bot record)";
  if (f.rented) return "in a renter stack";
  // A connected game means a buyer (or we) linked it: its bot can claim, and
  // someone already has this login.
  if (f.connected > 0) return "a game is connected";
  // Any reserved drop: a real sale, or a listing that holds this account.
  if (f.sold > 0) return "a drop is sold or reserved";
  if (f.leftover > maxLeftover) return "holds " + f.leftover + " unsold claimed drops";
  return "";
}

function defaultDeps() {
  return {
    AvailableAccount: require("../models/AvailableAccount"),
    BotAccount: require("../models/BotAccount"),
    DropLog: require("../models/DropLog"),
    AutoFarmTask: require("../models/AutoFarmTask"),
    TwitchCampaign: require("../models/TwitchCampaign"),
    UnclaimedAccount: require("../models/UnclaimedAccount"),
    SaleSignal: require("../models/SaleSignal"),
    MarketplaceListing: require("../models/MarketplaceListing"),
    RenterBotStack: require("../models/RenterBotStack"),
    rentedAccounts: require("./rentedAccounts"),
    listedLogins: require("./listedLogins"),
    hosts: require("./botHosts"),
    recordPoolUsage: (...a) => require("./poolUsageLog").recordPoolUsage(...a),
    logEvent: (...a) => require("./systemLog").logEvent(...a),
    // Lazily: routes/botConfigRoutes pulls in the whole route stack.
    removeAccountFromConfig: (...a) =>
      require("../routes/botConfigRoutes").removeAccountFromConfig(...a),
    reloadConfig: (...a) => require("./farmControl").reloadConfig(...a),
    containerForFile: (f) => require("./botFactory").containerForFile(f),
  };
}

// Every token each login is known under, lowercased: Map(login -> Set(token)).
// A login under two tokens is the duplicate-login population, and BotAccount
// keeps the case a login was scanned with — "Twin" and "twin" are one login —
// so this cannot be an indexed $in. One projected read of the collection (a
// few thousand small rows), kept for five minutes: a twin is made by an
// import, not in the seconds between a snapshot and a claim.
const TWIN_TTL_MS = 5 * 60 * 1000;
let twinCache = { at: 0, model: null, map: null };
async function loginSecrets(d) {
  if (twinCache.map && twinCache.model === d.BotAccount && Date.now() - twinCache.at < TWIN_TTL_MS) {
    return twinCache.map;
  }
  const rows = await d.BotAccount.find({}, { login: 1, clientSecret: 1 }).lean();
  const map = new Map();
  for (const r of rows) {
    const k = lower(r.login);
    if (!k) continue;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(str(r.clientSecret));
  }
  twinCache = { at: Date.now(), model: d.BotAccount, map };
  return map;
}

// Facts for a list of accounts, in a handful of batched reads.
//   accounts  [{ loginLower, login, clientSecret, note }]
// Returns Map(loginLower -> { noteOk, token, bots, botId, twins, scan, botSold,
//   reseller, rented, connected, sold, leftover, reason }).
async function factsFor(accounts, { maxLeftover, deps } = {}) {
  const d = deps || defaultDeps();
  const max = maxLeftover == null ? cfg().maxLeftover : maxLeftover;
  const list = (accounts || []).filter((a) => a && a.loginLower);
  const out = new Map();
  if (!list.length) return out;

  const secrets = [...new Set(list.map((a) => str(a.clientSecret)).filter(Boolean))];
  const bots = secrets.length
    ? await d.BotAccount.find(
        { clientSecret: { $in: secrets } },
        {
          login: 1, clientSecret: 1, lastScanStatus: 1, soldAt: 1, soldToUsername: 1,
          soldBulkOrderId: 1, resellerId: 1,
        },
      ).lean()
    : [];
  const botsBySecret = new Map();
  for (const b of bots) {
    const k = str(b.clientSecret);
    if (!botsBySecret.has(k)) botsBySecret.set(k, []);
    botsBySecret.get(k).push(b);
  }
  const secretsByLogin = await loginSecrets(d);

  const ids = bots.map((b) => b._id);
  const [connectedIds, soldIds, leftRows, rentedIdx] = await Promise.all([
    ids.length ? d.DropLog.distinct("account", { account: { $in: ids }, connected: true }) : [],
    ids.length ? d.DropLog.distinct("account", { account: { $in: ids }, soldAt: { $ne: null } }) : [],
    ids.length
      ? d.DropLog.aggregate([
          { $match: { account: { $in: ids }, connected: { $ne: true }, soldAt: null } },
          { $group: { _id: "$account", n: { $sum: 1 } } },
        ])
      : [],
    d.rentedAccounts.rentedIndex(),
  ]);
  const connected = new Set((connectedIds || []).map(String));
  const sold = new Set((soldIds || []).map(String));
  const leftover = new Map((leftRows || []).map((r) => [String(r._id), Number(r.n) || 0]));

  for (const a of list) {
    const secret = str(a.clientSecret);
    const mine = botsBySecret.get(secret) || [];
    const bot = mine[0] || null;
    const id = bot ? String(bot._id) : "";
    const others = secretsByLogin.get(a.loginLower) || new Set();
    const f = {
      noteOk: AUTO_FARM_NOTE.test(str(a.note)) || STOCK_NOTE.test(str(a.note)),
      token: !!secret,
      bots: mine.length,
      botId: id,
      twins: [...others].some((s) => s && s !== secret),
      scan: bot ? str(bot.lastScanStatus) : "",
      botSold: !!(bot && (bot.soldAt || bot.soldBulkOrderId)),
      reseller: !!(bot && bot.resellerId),
      rented: d.rentedAccounts.isRented(rentedIdx, { clientSecret: secret, login: a.login || a.loginLower }),
      connected: id && connected.has(id) ? 1 : 0,
      sold: id && sold.has(id) ? 1 : 0,
      leftover: id ? leftover.get(id) || 0 : 0,
    };
    f.reason = blockReason(f, { maxLeftover: max });
    out.set(a.loginLower, f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

// The auto-farm accounts worth a live inventory read: deployed on a task whose
// campaign needs a link (running, or ended inside the claim window), or held
// out of the pool as unclaimed stock — and free by every rule the database can
// answer. [] with the switch off. Shaped like the engine's no-claim candidates
// (inventoryForCandidate reads `clientSecret`), plus `farm`.
async function collectCandidates({ deps } = {}) {
  const c = cfg();
  if (!c.on) return [];
  const d = deps || defaultDeps();
  const since = new Date(Date.now() - c.taskDays * DAY_MS);
  const tasks = await d.AutoFarmTask.find(
    {
      dryRun: { $ne: true },
      $or: [
        { status: "active" },
        { status: { $in: ["completed", "stopped"] }, completedAt: { $gte: since } },
        { status: { $in: ["completed", "stopped"] }, campaignEndAt: { $gte: since } },
      ],
    },
    { game: 1, campaignId: 1, assignedAccounts: 1, status: 1 },
  ).lean();
  const campaignIds = [...new Set(tasks.map((t) => str(t.campaignId)).filter(Boolean))];
  const campaigns = campaignIds.length
    ? await d.TwitchCampaign.find(
        { campaignId: { $in: campaignIds } },
        { campaignId: 1, accountLinkURL: 1 },
      ).lean()
    : [];
  const needsLink = new Set(
    campaigns.filter((x) => linkRequired(x.accountLinkURL)).map((x) => str(x.campaignId)),
  );
  // login -> the game it is (or was last) farming; an active task wins.
  const gameByLogin = new Map();
  for (const t of tasks) {
    if (!needsLink.has(str(t.campaignId))) continue;
    if (!gameAllowed(t.game, c.games)) continue;
    for (const u of t.assignedAccounts || []) {
      const l = lower(u);
      if (!l) continue;
      if (!gameByLogin.has(l) || t.status === "active") gameByLogin.set(l, str(t.game));
    }
  }

  const fields = { username: 1, usernameLower: 1, clientSecret: 1, twitchId: 1, claimedNote: 1 };
  const base = { status: "claimed", manualSold: { $ne: true }, listed: { $ne: true } };
  const [deployed, held] = await Promise.all([
    gameByLogin.size
      ? d.AvailableAccount.find(
          { ...base, usernameLower: { $in: [...gameByLogin.keys()] }, claimedNote: AUTO_FARM_NOTE },
          fields,
        ).lean()
      : [],
    // Recycled after its campaign and held by the pool check (utils/poolStock).
    // A game allow-list is a first-rollout narrowing; held rows name no task,
    // so they wait until it is lifted.
    c.games.length ? [] : d.AvailableAccount.find({ ...base, claimedNote: STOCK_NOTE }, fields).lean(),
  ]);
  const rows = new Map();
  for (const p of deployed.concat(held)) {
    const l = lower(p.usernameLower || p.username);
    if (!l || !p.clientSecret || rows.has(l)) continue;
    rows.set(l, p);
  }
  if (!rows.size) return [];

  const listed = await d.listedLogins.loginsOnActiveListings();
  const accounts = [];
  for (const [l, p] of rows) {
    if (listed.has(l)) continue;
    accounts.push({ loginLower: l, login: str(p.username), clientSecret: str(p.clientSecret), note: str(p.claimedNote) });
  }
  const facts = await factsFor(accounts, { maxLeftover: c.maxLeftover, deps: d });
  const out = [];
  for (const a of accounts) {
    const f = facts.get(a.loginLower);
    if (!f || f.reason) continue;
    const p = rows.get(a.loginLower);
    out.push({
      source: "noclaim",
      farm: FARM,
      login: a.login || a.loginLower,
      twitchId: str(p.twitchId),
      clientSecret: a.clientSecret,
      game: gameByLogin.get(a.loginLower) || "",
      botId: "",
      container: "",
    });
  }
  return out;
}

// The facts of the auto-farm holdings in a snapshot, for noclaimHoldings'
// freeReason: { on, facts: Map(loginLower -> facts) }. `holdings` are
// NoclaimHolding rows with farm "autofarm".
async function baseFacts(holdings, { deps } = {}) {
  const c = cfg();
  const list = (holdings || []).filter((h) => h && h.farm === FARM);
  if (!list.length) return { on: c.on, facts: new Map() };
  const d = deps || defaultDeps();
  const ids = [...new Set(list.map((h) => str(h.poolAccountId)).filter((x) => /^[0-9a-f]{24}$/i.test(x)))];
  const pools = ids.length
    ? await d.AvailableAccount.find(
        { _id: { $in: ids } },
        { username: 1, usernameLower: 1, clientSecret: 1, claimedNote: 1 },
      ).lean()
    : [];
  const poolById = new Map(pools.map((p) => [String(p._id), p]));
  const accounts = [];
  for (const h of list) {
    const p = poolById.get(str(h.poolAccountId));
    if (!p) continue;
    accounts.push({
      loginLower: str(h.loginLower),
      login: str(p.username || h.login),
      clientSecret: str(p.clientSecret),
      note: str(p.claimedNote),
    });
  }
  return { on: c.on, facts: await factsFor(accounts, { maxLeftover: c.maxLeftover, deps: d }) };
}

// The one account a claim is about to take, straight from the database — the
// snapshot is up to 30 s old, and in that time the auto-lister can have put
// this login on a listing or a buyer can have connected a game. "" = go on.
async function claimBlockReason(cand, pool, { deps } = {}) {
  const c = cfg();
  if (!c.on) return "auto-farm stock is switched off";
  if (!pool) return "no pool row";
  const loginLower = lower(cand && (cand.loginLower || cand.login));
  if (!loginLower) return "no login";
  const facts = await factsFor(
    [{ loginLower, login: str(pool.username || (cand && cand.login)), clientSecret: str(pool.clientSecret), note: str(pool.claimedNote) }],
    { maxLeftover: c.maxLeftover, deps },
  );
  const f = facts.get(loginLower);
  return f ? f.reason : "not checked";
}

// ---------------------------------------------------------------------------
// The claimed drops that leave with the account
// ---------------------------------------------------------------------------
// The buyer gets the whole account, so whatever CLAIMED drops still sit on it
// go too. They must leave the Drops Archive in the same breath as the claim:
// until they do, a claimed-bundle order could be handed this very login.
//
// Compare-and-set, like dropReservation.reserveSetOnAccount: stamp what is
// free, then look for anyone else's reservation on the account. One means a
// listing or a buyer took a drop a moment ago — ours are released and the
// claim backs off. Writes no sale signal: nobody bought these.

function soldTag(market, orderId) {
  return SOLD_TAG + ":" + str(market) + (orderId ? ":" + str(orderId) : "");
}

// Returns { ok, botId, reserved } — ok:false means the caller must undo its
// ledger commit and move on.
async function reserveLeftovers(pool, { market = "", orderId = "", setId = "", deps } = {}) {
  const d = deps || defaultDeps();
  const secret = str(pool && pool.clientSecret);
  if (!secret) return { ok: false, botId: "", reserved: 0, why: "no token" };
  const bots = await d.BotAccount.find({ clientSecret: secret }, { _id: 1 }).lean();
  if (bots.length !== 1) return { ok: false, botId: "", reserved: 0, why: "bot record changed" };
  const botId = bots[0]._id;
  const tag = soldTag(market, orderId);
  const now = new Date();
  const r = await d.DropLog.updateMany(
    { account: botId, connected: { $ne: true }, soldAt: null },
    { $set: { soldAt: now, soldToUsername: tag, soldToAdminId: "", soldSetId: str(setId), soldBulkOrderId: "" } },
  );
  const reserved = Number(r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
  const foreign = await d.DropLog.countDocuments({
    account: botId,
    $or: [{ connected: true }, { soldAt: { $ne: null }, soldToUsername: { $ne: tag } }],
  });
  if (foreign) {
    await releaseLeftovers(botId, tag, { deps: d });
    return { ok: false, botId: String(botId), reserved: 0, why: "a drop was reserved or connected meanwhile" };
  }
  // The account's own "sold" shadow, from this moment: it is what keeps the
  // auto-farm from recycling the login into the pool (unrecyclableLogins) or
  // re-arming it for the next wave (reuseRearm) before the post-sale pass has
  // taken it out of its bot — and an account with no claimed drop at all has
  // nothing else to say it is sold. First reservation wins, as everywhere.
  const shadow = await d.BotAccount.updateOne(
    { _id: botId, soldAt: null },
    { $set: { soldAt: now, soldToUsername: tag, soldToAdminId: "", soldSetId: str(setId), soldBulkOrderId: "" } },
  );
  if (!(shadow && (shadow.modifiedCount || shadow.nModified))) {
    // Somebody stamped the record between the facts check and now.
    await releaseLeftovers(botId, tag, { deps: d });
    return { ok: false, botId: String(botId), reserved: 0, why: "the bot record was sold or reserved meanwhile" };
  }
  return { ok: true, botId: String(botId), reserved, tag };
}

// Undo reserveLeftovers: only what carries `tag`.
async function releaseLeftovers(botId, tag, { deps } = {}) {
  const d = deps || defaultDeps();
  if (!botId || !tag) return 0;
  const empty = { soldAt: null, soldToUsername: "", soldToAdminId: "", soldSetId: "", soldBulkOrderId: "" };
  const r = await d.DropLog.updateMany({ account: botId, soldToUsername: tag }, { $set: empty });
  await d.BotAccount.updateOne({ _id: botId, soldToUsername: tag }, { $set: empty });
  return Number(r && (r.modifiedCount != null ? r.modifiedCount : r.nModified)) || 0;
}

// The same undo for a caller that only has the pool row (a claim that failed
// part-way and never learned the bot id). Never throws.
async function releaseForPool(pool, { market = "", orderId = "", deps } = {}) {
  const d = deps || defaultDeps();
  const secret = str(pool && pool.clientSecret);
  if (!secret) return 0;
  const tag = soldTag(market, orderId);
  let n = 0;
  try {
    const bots = await d.BotAccount.find({ clientSecret: secret }, { _id: 1 }).lean();
    for (const b of bots) n += await releaseLeftovers(b._id, tag, { deps: d });
  } catch (e) {
    console.error("autofarmStock: archive release failed:", e && e.message);
  }
  return n;
}

// ---------------------------------------------------------------------------
// After the sale
// ---------------------------------------------------------------------------

const usersOf = (c) =>
  c && c.TwitchSettings && Array.isArray(c.TwitchSettings.TwitchUsers) ? c.TwitchSettings.TwitchUsers : [];

// Every operator config on every bot host, read in one batched round trip per
// host. Returns { configs: [{ hostId, host, file, users }], unreadable: [..] }.
// A host or a file that cannot be read is named in `unreadable`: it may hold
// the account, so nothing is proven while the list is not empty.
async function readOperatorConfigs(d) {
  const configs = [];
  const unreadable = [];
  for (const meta of d.hosts.listHosts() || []) {
    const hostId = str(meta && meta.id);
    const host = d.hosts.resolveHost(hostId);
    if (!host) continue;
    let names;
    try {
      names = (await d.hosts.readdir(host)).map((f) => (f && f.name) || f).filter((f) => CONFIG_RE.test(str(f)));
    } catch (e) {
      unreadable.push(hostId + " (" + ((e && e.message) || "unreachable") + ")");
      continue;
    }
    if (!names.length) continue;
    let raw;
    try {
      raw = await d.hosts.readFiles(host, names);
    } catch (e) {
      unreadable.push(hostId + " (" + ((e && e.message) || "unreadable") + ")");
      continue;
    }
    for (const file of names) {
      const f = raw[file];
      if (!f || !f.ok) {
        unreadable.push(hostId + "/" + file);
        continue;
      }
      try {
        configs.push({ hostId, host, file, users: usersOf(JSON.parse(f.text)) });
      } catch {
        unreadable.push(hostId + "/" + file + " (does not parse)");
      }
    }
  }
  return { configs, unreadable };
}

// Take sold auto-farm accounts out of farming. For each DELIVERED sale not yet
// cleaned up (oldest first):
//   1. its claimed drops are already out of the archive (reserveLeftovers ran
//      at the claim) — re-stamped here in case a scan logged more since;
//   2. active tasks release the login;
//   3. it is REMOVED from every operator config that holds its token — an
//      entry that no longer exists cannot be re-armed for the next wave — and
//      each bot it was enabled in reloads (only if running; one left with no
//      enabled account is stopped: farmControl.reloadConfig);
//   4. its bot record leaves its bot, and the sale becomes a sale signal the
//      auto-farm's demand model can see (it reads SaleSignal, which the
//      claim-at-sale markets never write);
//   5. the pool row says "spent — …" with the sold game — only once every
//      config on every host was read and none holds the token any more. Until
//      then the sale stays queued and the pass comes back to it.
// One failure never blocks the rest. Never throws.
async function retirePending({ limit = 10, deps } = {}) {
  const d = deps || defaultDeps();
  const out = { pending: 0, retired: 0, waiting: 0, removed: 0, reloaded: [], errors: [] };
  // `limit` sales are finished a pass; three times as many are looked at, so a
  // sale that cannot be finished (a human's to look at) never holds up the
  // ones behind it.
  const max = clampInt(limit, 10, 1, 50);
  let rows;
  try {
    rows = await d.UnclaimedAccount.find({
      source: "noclaim",
      farm: FARM,
      status: "sold",
      manualDeliveredAt: { $ne: null },
      manualSpentAt: null,
    })
      .sort({ soldAt: 1, _id: 1 })
      .limit(max * 3)
      .lean();
  } catch (e) {
    out.errors.push("could not read the sold ledgers: " + ((e && e.message) || e));
    return out;
  }
  out.pending = rows.length;
  if (!rows.length) return out;

  // Renter stacks are never edited here, and an account found in one is a
  // human's to look at.
  let stackKeys = new Set();
  try {
    const stacks = await d.RenterBotStack.find({}, { host: 1, file: 1 }).lean();
    stackKeys = new Set(stacks.map((s) => lower(s.host || "local") + "|" + lower(s.file)));
  } catch (e) {
    out.errors.push("could not read the renter stacks: " + ((e && e.message) || e));
    return out;
  }
  const { configs, unreadable } = await readOperatorConfigs(d);
  const touched = new Map(); // "hostId|file" -> { host, file, hostId }

  for (const l of rows) {
    if (out.retired >= max) break;
    const login = str(l.login);
    try {
      const pool = l.poolAccountId
        ? await d.AvailableAccount.findById(l.poolAccountId, {
            username: 1, clientSecret: 1, status: 1, claimedNote: 1, soldGames: 1,
          }).lean()
        : null;
      const secret = str(pool && pool.clientSecret);
      if (!pool || !secret) {
        out.errors.push(login + ": no pool row or token — left for a human");
        continue;
      }
      const bots = await d.BotAccount.find({ clientSecret: secret }, { _id: 1, login: 1, host: 1, configFile: 1 }).lean();
      const tag = soldTag(l.soldMarket || l.market, orderIdOf(l));

      // 1. Claimed drops logged since the claim leave the archive too.
      for (const b of bots) {
        await d.DropLog.updateMany(
          { account: b._id, connected: { $ne: true }, soldAt: null },
          { $set: { soldAt: l.soldAt || new Date(), soldToUsername: tag, soldToAdminId: "", soldSetId: str(l.set || ""), soldBulkOrderId: "" } },
        );
        await d.BotAccount.updateOne(
          { _id: b._id, soldAt: null },
          { $set: { soldAt: l.soldAt || new Date(), soldToUsername: tag, soldToAdminId: "", soldSetId: str(l.set || ""), soldBulkOrderId: "" } },
        );
      }

      // 2. Tasks.
      const variants = [...new Set([login, lower(login), str(pool.username), lower(pool.username)].filter(Boolean))];
      if (variants.length) {
        await d.AutoFarmTask.updateMany(
          { status: "active", assignedAccounts: { $in: variants } },
          { $pull: { assignedAccounts: { $in: variants } } },
        );
      }

      // 3. Configs.
      const holding = configs.filter((c) =>
        c.users.some((u) => u && str(u.ClientSecret) === secret),
      );
      let inStack = false;
      for (const c of holding) {
        const key = c.hostId + "|" + c.file;
        if (stackKeys.has(lower(c.hostId) + "|" + lower(c.file))) {
          inStack = true;
          continue;
        }
        const wasEnabled = c.users.some((u) => u && str(u.ClientSecret) === secret && u.Enabled !== false);
        const removed = await d.removeAccountFromConfig(c.host, c.file, { clientSecret: secret, login: "" });
        if (removed) {
          out.removed += removed;
          c.users = c.users.filter((u) => !(u && str(u.ClientSecret) === secret));
          if (wasEnabled) touched.set(key, { host: c.host, hostId: c.hostId, file: c.file });
        }
      }
      if (inStack) {
        out.errors.push(login + ": its token is in a renter stack config — left for a human");
        continue;
      }

      // 4. Bot record + sale signal.
      for (const b of bots) {
        await d.BotAccount.updateOne({ _id: b._id }, { $set: { enabled: false, configFile: "", container: "" } });
      }
      await writeSaleSignal(d, l, bots[0] || null);

      // 5. Proof, then the pool row.
      if (unreadable.length) {
        out.waiting++;
        continue;
      }
      const game = settings.normGameName ? settings.normGameName(l.game) : lower(l.game);
      const games = new Set((Array.isArray(pool.soldGames) ? pool.soldGames : []).filter(Boolean));
      if (game) games.add(game);
      const note = ("spent — " + SPENT_LABEL + " (" + (l.note || l.soldMarket || "sold") + ")").slice(0, 200);
      await d.AvailableAccount.updateOne(
        { _id: pool._id },
        { $set: { status: "claimed", claimedNote: note, soldGames: [...games] } },
      );
      await Promise.resolve(
        d.recordPoolUsage([pool._id], { event: "spent", actor: "autofarmStock", note, game: game || "" }),
      ).catch(() => {});
      const done = await d.UnclaimedAccount.updateOne(
        { _id: l._id, status: "sold", manualSpentAt: null },
        { $set: { manualSpentAt: new Date() } },
      );
      if (done && (done.modifiedCount || done.nModified)) out.retired++;
      await Promise.resolve(
        d.logEvent({
          category: "noclaim_shop",
          action: "autofarm_retired",
          actor: "autofarmStock",
          severity: "info",
          subject: login,
          game: str(l.game),
          detail:
            "sold auto-farm account taken out of farming (" + (l.note || l.soldMarket || "sold") +
            "): removed from " + holding.length + " config(s), off its tasks, pool row spent",
        }),
      ).catch(() => {});
    } catch (e) {
      out.errors.push(login + ": " + ((e && e.message) || e));
    }
  }

  // One reload per touched config, after every edit to it.
  const allowRestart = process.env.TWITCHBOT_ALLOW_RESTART !== "0";
  for (const t of touched.values()) {
    const container = d.containerForFile(t.file);
    if (!container) continue;
    try {
      const r = await d.reloadConfig(t.host, t.file, container, { restorePolicy: true, allowRestart });
      out.reloaded.push(container + ": " + ((r && r.outcome) || "?"));
    } catch (e) {
      out.errors.push(t.hostId + "/" + t.file + " reload: " + ((e && e.message) || e));
    }
  }
  if (unreadable.length && out.waiting) {
    out.errors.push(
      out.waiting + " sale(s) wait for an unreadable config before the pool row says spent: " +
        unreadable.slice(0, 5).join(", "),
    );
  }
  return out;
}

// "eldorado order 1234" -> "1234" (noclaimStock.orderNote).
function orderIdOf(ledger) {
  const m = /\border\s+(\S+)/i.exec(str(ledger && ledger.note));
  return m ? m[1] : "";
}

// One real sale, once: the auto-farm's demand model counts SaleSignal rows
// ("connected" + "listing_sold"), and Eldorado / G2G / PlayerAuctions write
// none. Keyed by the ledger, so a repeated pass adds nothing.
async function writeSaleSignal(d, ledger, bot) {
  const game = str(ledger.game).trim();
  if (!game) return;
  let bulk = false;
  try {
    const lid = str(ledger.manualListing);
    if (/^[0-9a-f]{24}$/i.test(lid)) {
      const row = await d.MarketplaceListing.findById(lid, { bulkOfferId: 1 }).lean();
      bulk = !!(row && row.bulkOfferId);
    }
  } catch {
    bulk = false;
  }
  try {
    await d.SaleSignal.updateOne(
      { dedupeKey: "afstock:" + String(ledger._id) },
      {
        $setOnInsert: {
          game,
          gameKey: game.toLowerCase(),
          itemKey: "",
          name: "",
          login: str(ledger.login),
          account: bot ? bot._id : null,
          source: "listing_sold",
          marketplace: str(ledger.soldMarket || ledger.market),
          priceUsd: Math.max(0, Number(ledger.soldPriceUsd) || 0),
          bulk,
          at: ledger.soldAt || new Date(),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    console.error("autofarmStock: sale signal for " + str(ledger.login) + " failed:", e && e.message);
  }
}

// ---------------------------------------------------------------------------
// THE UNCLAIMED ERA — which accounts the auto-farm farms, and how many
// (docs/UNCLAIMED-SELLING-PLAN.md, Stage 3; switch autoFarm.unclaimedEra,
// default OFF)
// ---------------------------------------------------------------------------
// A campaign that needs a link no longer produces claimed drops, so nothing it
// farms can be stockpiled: what an account earns is stock for the campaign's
// remaining days plus the seven Twitch keeps it, sold whole to one buyer, and
// only if the account is free to hand over. Two things follow for the engine's
// top-up (autoFarmer.backfillActiveTasks) and its claims:
//
//   WHO   an account already promised elsewhere (on a claimed listing, a drop
//         sold or reserved, a connected game, rented) can farm such a campaign
//         all month and yield nothing we can sell. So a task's accounts are
//         counted by what could be SOLD, and new accounts are claimed clean
//         (few or no claimed drops), so the whole account is the bundle.
//   HOW MANY  enough to cover what the game sells in that window, with
//         headroom, and never more than the engine's own target: the rate is
//         the demand model's (utils/demandBrain, clean counting over every
//         market), or the engine's own 45-day count when it has none.
// Unsold accounts are not lost: their drops expire and they return to the pool.

function clampNum(v, d, lo, hi) {
  if (v == null || (typeof v === "string" && !v.trim())) return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}

function eraCfg() {
  let af = null;
  try {
    if (typeof settings.getAutoFarm === "function") af = settings.getAutoFarm();
  } catch (e) {
    console.error("autofarmStock: auto-farm settings unreadable:", e && e.message);
  }
  af = af && typeof af === "object" ? af : {};
  return {
    on: af.unclaimedEra === true,
    // Expected sales in the window are multiplied by this before the safety
    // stock is added: a sale needs an account that finished EVERY drop.
    headroom: clampNum(af.unclaimedEraHeadroom, 2, 1, 5),
    safety: clampInt(af.unclaimedEraSafety, 3, 0, 20),
    // The least a farmed campaign gets, so a game with no sales on record is
    // still tested on a handful of accounts.
    minAccounts: clampInt(af.unclaimedEraMinAccounts, 6, 1, 30),
    claimWindowDays: clampInt(af.unclaimedEraClaimDays, 7, 0, 14),
    maxWindowDays: clampInt(af.unclaimedEraMaxWindowDays, 28, 7, 60),
    // A fresh account may carry at most this many claimed drops (the same
    // ceiling a sale applies): they would go to the buyer with it.
    cleanMax: cfg().maxLeftover,
  };
}

// Pure. How many SELLABLE accounts a link-needed campaign should have.
//   ratePerWeek   accounts of this game sold per week
//   hoursLeft     until the campaign ends (Infinity / NaN = unknown: long)
//   engineTarget  what the engine would farm — a ceiling, never raised
function eraTarget({ ratePerWeek, hoursLeft, engineTarget, cfg: c } = {}) {
  const e = c || eraCfg();
  const rate = Math.max(0, Number(ratePerWeek) || 0);
  const hrs = Number(hoursLeft);
  const left = Number.isFinite(hrs) ? Math.max(0, hrs) / 24 : e.maxWindowDays;
  // The buyer needs time to claim: an offer stops a day before the copies go.
  const windowDays = Math.min(e.maxWindowDays, Math.max(1, left + e.claimWindowDays - 1));
  const expected = (rate * windowDays) / 7;
  let t = Math.ceil(expected * e.headroom) + e.safety;
  t = Math.max(t, e.minAccounts);
  const ceiling = Math.floor(Number(engineTarget));
  if (Number.isFinite(ceiling) && ceiling >= 0) t = Math.min(t, ceiling);
  return { target: t, windowDays: Math.round(windowDays * 10) / 10, expected: Math.round(expected * 10) / 10 };
}

// true / false, or null when the campaign is not on record (unknown is never
// treated as "needs a link": the engine then does exactly what it always did).
const LINK_TTL_MS = 10 * 60 * 1000;
const linkCache = new Map(); // campaignId -> { at, v }
async function campaignNeedsLink(campaignId, { deps } = {}) {
  const id = str(campaignId);
  if (!id) return null;
  const hit = linkCache.get(id);
  if (hit && !deps && Date.now() - hit.at < LINK_TTL_MS) return hit.v;
  const d = deps || defaultDeps();
  const c = await d.TwitchCampaign.findOne({ campaignId: id }, { accountLinkURL: 1 }).lean();
  const v = c ? (str(c.accountLinkURL).trim() ? linkRequired(c.accountLinkURL) : null) : null;
  if (!deps) linkCache.set(id, { at: Date.now(), v });
  return v;
}

// Accounts of this game sold per week: { rate, basis }. The demand model's
// clean count when it has a recent row for the game, else the engine's own
// 45-day count (`sales` = autoFarmer.internalSalesForGame's answer).
const BRAIN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
async function weeklyRate(game, sales, { brain } = {}) {
  const count = Math.max(0, Number(sales && typeof sales === "object" ? sales.count : sales) || 0);
  const engine = { rate: Math.round(((count * 7) / 45) * 100) / 100, basis: "engine" };
  try {
    const b = brain || require("./demandBrain");
    if (!b || typeof b.gameHistory !== "function") return engine;
    const rows = await b.gameHistory(lower(game), "claim", 1);
    const row = rows && rows[0];
    if (!row || !row.est || !(Date.now() - new Date(row.at).getTime() < BRAIN_MAX_AGE_MS)) return engine;
    const r = Number(row.est.avg45);
    if (!Number.isFinite(r) || r < 0) return engine;
    return { rate: r, basis: "brain" };
  } catch {
    return engine;
  }
}

// Which of these logins the auto-farm could NOT sell whole, and why:
// Map(loginLower -> reason). A login that is not in the map counts as sellable
// — including one with no bot record yet (deployed a moment ago): an unknown
// must never read as a gap, or every tick would fill it again.
async function unsellableLogins(logins, { deps } = {}) {
  const d = deps || defaultDeps();
  const wanted = [...new Set((logins || []).map(lower).filter(Boolean))];
  const out = new Map();
  if (!wanted.length) return out;
  const [pools, listed] = await Promise.all([
    d.AvailableAccount.find(
      { usernameLower: { $in: wanted } },
      { username: 1, usernameLower: 1, clientSecret: 1, claimedNote: 1, status: 1, manualSold: 1, listed: 1 },
    ).lean(),
    d.listedLogins.loginsOnActiveListings(),
  ]);
  const accounts = [];
  for (const p of pools) {
    const l = lower(p.usernameLower || p.username);
    if (p.manualSold === true) out.set(l, "hand-sold");
    else if (p.listed === true) out.set(l, "ticked listed");
    else if (p.status !== "claimed") out.set(l, "back in the pool");
    else if (listed.has(l)) out.set(l, "on an active listing");
    else accounts.push({ loginLower: l, login: str(p.username), clientSecret: str(p.clientSecret), note: str(p.claimedNote) });
  }
  const facts = await factsFor(accounts, { maxLeftover: cfg().maxLeftover, deps: d });
  for (const a of accounts) {
    const f = facts.get(a.loginLower);
    if (f && f.reason && f.reason !== "no bot record") out.set(a.loginLower, f.reason);
  }
  return out;
}

// What the era says about one ACTIVE task: null when it does not apply (switch
// off, campaign needs no link or is unknown), else
//   { target, sellable, unsellable, cleanMax, rate, basis, windowDays }.
//   engineTarget  the target the engine computed for this task (the ceiling)
//   sales         internalSalesForGame(task.game)
async function eraForTask(task, { engineTarget, sales, deps, brain } = {}) {
  const e = eraCfg();
  if (!e.on || !task) return null;
  if ((await campaignNeedsLink(task.campaignId, { deps })) !== true) return null;
  const hrs = task.campaignEndAt ? (new Date(task.campaignEndAt).getTime() - Date.now()) / 3600000 : Infinity;
  const { rate, basis } = await weeklyRate(task.game, sales, { brain });
  const t = eraTarget({ ratePerWeek: rate, hoursLeft: hrs, engineTarget, cfg: e });
  const logins = [...new Set((task.assignedAccounts || []).map(lower).filter(Boolean))];
  const bad = await unsellableLogins(logins, { deps });
  return {
    target: t.target,
    sellable: logins.filter((l) => !bad.has(l)).length,
    unsellable: bad.size,
    cleanMax: e.cleanMax,
    rate,
    basis,
    windowDays: t.windowDays,
  };
}

module.exports = {
  FARM,
  SPENT_LABEL,
  SOLD_TAG,
  cfg,
  // the unclaimed era
  eraCfg,
  eraTarget,
  campaignNeedsLink,
  weeklyRate,
  unsellableLogins,
  eraForTask,
  // pure, tested
  linkRequired,
  sellableFromInv,
  blockReason,
  gameAllowed,
  soldTag,
  orderIdOf,
  // reads
  factsFor,
  collectCandidates,
  baseFacts,
  claimBlockReason,
  // writes
  reserveLeftovers,
  releaseLeftovers,
  releaseForPool,
  retirePending,
};
