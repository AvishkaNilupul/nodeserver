const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const AutoFarmTask = require("../models/AutoFarmTask");
const TwitchCampaign = require("../models/TwitchCampaign");
const Renter = require("../models/Renter");
const hosts = require("./botHosts");

const FRESH_MS = 36 * 60 * 60 * 1000;
const HIGH_CONFIDENCE_MS = 24 * 60 * 60 * 1000;
const CACHE_MS = 60 * 1000;
const MAX_PROGRESS_PER_ACCOUNT = 100;
const MAX_ITEMS = 250;

let cache = { at: 0, value: null };

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

function display(value, fallback = "") {
  return String(value || fallback).trim();
}

function fileForContainer(file) {
  const m = String(file || "").match(/^config_0*(\d+)\.json$/);
  if (m) return "twitchbotx" + parseInt(m[1], 10);
  return file === "config.json" ? "twitchbot" : "";
}

function gamesForUser(user, configGames, onlyFavorites) {
  if (!onlyFavorites) return { games: [], wildcard: true };
  const own = Array.isArray(user?.FavouriteGames) ? user.FavouriteGames : [];
  const values = (own.length ? own : configGames)
    .map(norm)
    .filter(Boolean);
  return { games: values, wildcard: values.length === 0 };
}

// Read the same config/runtime signals used by the superadmin Bots page, but
// keep the result internal. A reseller sees only the aggregate forecast.
async function readFleetRuntime() {
  // Key by auth token internally, not login. Login is not unique in the
  // historical fleet and duplicate-login rows must never borrow another
  // account's farming assignment.
  const index = new Map();
  let available = true;
  let configsSeen = 0;
  await Promise.all(
    hosts.listHosts().map(async (meta) => {
      const host = hosts.resolveHost(meta.id);
      let states;
      let files;
      try {
        [states, files] = await Promise.all([
          hosts.dockerPs(host),
          hosts.readdir(host),
        ]);
      } catch {
        available = false;
        return;
      }
      const configFiles = files
        .filter((f) => /^config(?:_\d{1,3})?\.json$/.test(f))
        .sort();
      const raws = await hosts.readFiles(host, configFiles).catch(() => ({}));
      for (const file of configFiles) {
        const raw = raws[file];
        if (!raw?.ok) continue;
        let data;
        try {
          data = JSON.parse(raw.text);
        } catch {
          continue;
        }
        configsSeen++;
        const container = fileForContainer(file);
        const running = !!(states[container] && /^running/i.test(states[container].state || ""));
        if (!running) continue;
        const ts = data.TwitchSettings || {};
        const users = Array.isArray(ts.TwitchUsers) ? ts.TwitchUsers : [];
        const configGames = Array.isArray(data.FavouriteGames) ? data.FavouriteGames : [];
        for (const user of users) {
          if (!user || user.Enabled === false) continue;
          const token = String(user.ClientSecret || "").trim();
          if (!token) continue;
          const assignment = gamesForUser(user, configGames, ts.OnlyFavouriteGames !== false);
          const current = index.get(token) || { active: false, games: new Set(), wildcard: false, host: meta.id, file };
          current.active = true;
          current.wildcard ||= assignment.wildcard;
          for (const game of assignment.games) current.games.add(game);
          index.set(token, current);
        }
      }
    }),
  );
  return { index, available, configsSeen, checkedAt: new Date() };
}

async function taskRuntimeFallback() {
  const tasks = await AutoFarmTask.find(
    { status: "active" },
    { game: 1, assignedAccounts: 1 },
  ).lean();
  const index = new Map();
  for (const task of tasks) {
    const game = norm(task.game);
    if (!game) continue;
    for (const login of task.assignedAccounts || []) {
      const key = norm(login);
      if (!key) continue;
      const current = index.get(key) || { active: false, games: new Set(), wildcard: false };
      current.games.add(game);
      index.set(key, current);
    }
  }
  return index;
}

function isRunnable(progress, runtime, fallback, runtimeAvailable, duplicateLogin) {
  const token = String(progress.clientSecret || "").trim();
  const login = norm(progress.login);
  const live = token ? runtime.index.get(token) : null;
  if (live?.active) return { ok: true, confidence: "high" };
  // Login is not a unique identity in this fleet. Never attach an auto-task
  // fallback to an ambiguous duplicate-login row during a host outage.
  if (!runtimeAvailable && !duplicateLogin) {
    const task = fallback.get(login);
    if (task) return { ok: true, confidence: "estimated" };
  }
  return { ok: false, confidence: "unknown" };
}

function gameAllowed(game, runtimeEntry, progressGame) {
  if (!runtimeEntry) return false;
  if (runtimeEntry.wildcard) return true;
  const key = norm(progressGame || game);
  return runtimeEntry.games.has(key);
}

function itemKey(row) {
  return [norm(row.name), norm(row.game)].join("|");
}

function confidenceFor(scannedAt, runtimeConfidence) {
  const age = Date.now() - new Date(scannedAt || 0).getTime();
  if (runtimeConfidence === "estimated") return "estimated";
  if (age <= HIGH_CONFIDENCE_MS) return "high";
  if (age <= FRESH_MS) return "medium";
  return "low";
}

function aggregateForecast({ accounts, runtime, fallback = new Map(), campaigns = [], available = [] }) {
  const now = Date.now();
  const items = new Map();
  const games = new Map();
  const eligibleIds = [];
  let activeAccounts = 0;
  let estimatedAccounts = 0;
  const loginCounts = new Map();
  for (const account of accounts || []) {
    const key = norm(account.login);
    if (key) loginCounts.set(key, (loginCounts.get(key) || 0) + 1);
  }

  function gameRecord(game, confidence) {
    const key = norm(game);
    if (!key) return null;
    const current = games.get(key) || {
      game: display(game, "Other"),
      accounts: new Set(),
      items: new Set(),
      readySoon: 0,
      confidence: "high",
    };
    if (["low", "estimated", "medium", "high"].indexOf(confidence) < ["low", "estimated", "medium", "high"].indexOf(current.confidence)) current.confidence = confidence;
    games.set(key, current);
    return current;
  }

  for (const account of accounts || []) {
    const runnable = isRunnable(account, runtime, fallback, runtime.available, (loginCounts.get(norm(account.login)) || 0) > 1);
    if (!runnable.ok) continue;
    const entry = runtime.index.get(String(account.clientSecret || "").trim()) || fallback.get(norm(account.login));
    const progress = Array.isArray(account.farmingProgress)
      ? account.farmingProgress.slice(0, MAX_PROGRESS_PER_ACCOUNT)
      : [];
    const seen = new Set();
    let accountContributed = false;
    const entryConfidence = confidenceFor(account.farmingSnapshotAt, runnable.confidence);
    for (const gameName of account.inProgressGames || []) {
      if (!gameAllowed(gameName, entry, gameName)) continue;
      const game = gameRecord(gameName, entryConfidence);
      if (!game) continue;
      game.accounts.add(String(account._id));
      accountContributed = true;
    }
    for (const row of progress) {
      if (!row || row.connected === true || !row.name || !row.game) continue;
      if (!gameAllowed(row.game, entry, row.game)) continue;
      const key = itemKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      accountContributed = true;
      const confidence = confidenceFor(row.scannedAt || account.farmingSnapshotAt, runnable.confidence);
      const item = items.get(key) || {
        key,
        name: display(row.name, "Reward"),
        game: display(row.game, "Other"),
        campaign: display(row.campaign),
        imageURL: display(row.imageURL),
        accounts: new Set(),
        percents: [],
        remaining: [],
        confidence: "high",
        lastScannedAt: null,
      };
      item.accounts.add(String(account._id));
      item.percents.push(Math.max(0, Math.min(100, Number(row.percent) || 0)));
      if (row.required > 0) item.remaining.push(Math.max(0, Number(row.required) - (Number(row.current) || 0)));
      item.confidence = ["low", "estimated", "medium", "high"].indexOf(confidence) < ["low", "estimated", "medium", "high"].indexOf(item.confidence) ? confidence : item.confidence;
      const scanned = row.scannedAt || account.farmingSnapshotAt;
      if (scanned && (!item.lastScannedAt || new Date(scanned) > new Date(item.lastScannedAt))) item.lastScannedAt = scanned;
      items.set(key, item);
      const game = gameRecord(row.game, confidence);
      game.accounts.add(String(account._id));
      game.items.add(key);
      games.set(norm(row.game), game);
    }
    if (accountContributed) {
      eligibleIds.push(account._id);
      if (runnable.confidence === "estimated") estimatedAccounts++;
      else activeAccounts++;
    }
  }

  const availableItems = Array.isArray(available) ? available : available.items || [];
  const stockByKey = new Map();
  const stockByGame = new Map();
  for (const row of availableItems) {
    const units = Math.max(0, Number(row.units || row.accounts || 0));
    stockByKey.set(itemKey(row), {
      accounts: Number(row.accounts || 0),
      units,
    });
    const gameKey = norm(row.game);
    if (gameKey) stockByGame.set(gameKey, (stockByGame.get(gameKey) || 0) + Number(row.accounts || 0));
  }
  if (!Array.isArray(available)) {
    for (const row of available.games || []) {
      const key = norm(row.game);
      if (key) stockByGame.set(key, Math.max(0, Number(row.accounts || 0)));
    }
  }
  const campaignByGame = new Map();
  for (const campaign of campaigns || []) {
    const key = norm(campaign.game);
    if (!key) continue;
    const current = campaignByGame.get(key);
    if (!current || new Date(campaign.endAt || 0) > new Date(current.endAt || 0)) campaignByGame.set(key, campaign);
  }

  const outItems = [...items.values()].map((item) => {
    const avg = item.percents.length ? Math.round(item.percents.reduce((a, b) => a + b, 0) / item.percents.length) : 0;
    const stock = stockByKey.get(item.key) || { accounts: 0, units: 0 };
    const campaign = campaignByGame.get(norm(item.game));
    return {
      name: item.name,
      game: item.game,
      campaign: item.campaign,
      imageURL: item.imageURL,
      farmingAccounts: item.accounts.size,
      averagePercent: avg,
      readySoon: avg >= 75,
      estimatedMinutesRemaining: item.remaining.length ? Math.round(item.remaining.reduce((a, b) => a + b, 0) / item.remaining.length) : null,
      availableNow: stock,
      campaignEndAt: campaign?.endAt || null,
      campaignImage: campaign?.image || campaign?.boxArt || "",
      confidence: item.confidence,
      lastScannedAt: item.lastScannedAt,
    };
  }).sort((a, b) => (b.readySoon - a.readySoon) || (b.averagePercent - a.averagePercent) || (b.farmingAccounts - a.farmingAccounts));

  const outGames = [...games.values()].map((game) => {
    const matching = outItems.filter((item) => norm(item.game) === norm(game.game));
    const campaign = campaignByGame.get(norm(game.game));
    return {
      game: game.game,
      farmingAccounts: game.accounts.size,
      items: matching.length,
      itemSnapshotReady: matching.length > 0,
      readySoon: matching.filter((item) => item.readySoon).length,
      // Stock exists independently of the new item-progress snapshot. Use the
      // DropLog rollup directly so the warm-up game view does not say zero
      // while the scanner is still learning item-level progress.
      availableNow: stockByGame.get(norm(game.game)) || 0,
      campaignEndAt: campaign?.endAt || null,
      // Preserve the least-trustworthy evidence represented by this game.
      // A fresh item snapshot must not make a game look high-confidence when
      // its other active accounts are stale or only estimated from tasks.
      confidence: game.confidence || matching[0]?.confidence || "unknown",
    };
  }).sort((a, b) => b.readySoon - a.readySoon || b.farmingAccounts - a.farmingAccounts);

  const scans = accounts.map((a) => a.farmingSnapshotAt).filter(Boolean).map((v) => new Date(v).getTime()).filter(Number.isFinite);
  const oldest = scans.length ? new Date(Math.min(...scans)) : null;
  const newest = scans.length ? new Date(Math.max(...scans)) : null;
  return {
    generatedAt: new Date(),
    freshness: { oldestScanAt: oldest, newestScanAt: newest, stale: !newest || now - newest.getTime() > FRESH_MS },
    runtime: { available: runtime.available, checkedAt: runtime.checkedAt, configsSeen: runtime.configsSeen },
    summary: { activeAccounts, estimatedAccounts, games: outGames.length, items: outItems.length, readySoon: outItems.filter((i) => i.readySoon).length, availableNow: Array.isArray(available) ? availableItems.reduce((sum, row) => sum + Number(row.accounts || 0), 0) : Math.max(0, Number(available.accounts || 0)) },
    games: outGames,
    items: outItems.slice(0, MAX_ITEMS),
  };
}

async function loadAvailableStock(accountIds) {
  if (!accountIds.length) return { items: [], games: [], accounts: 0 };
  const match = { account: { $in: accountIds }, connected: { $ne: true }, soldAt: null };
  const [items, games, accounts] = await Promise.all([
    DropLog.aggregate([
      { $match: match },
      { $group: { _id: { name: "$name", game: "$game", itemKey: "$itemKey", image: { $ifNull: ["$imageLocal", "$imageURL"] } }, accounts: { $addToSet: "$account" }, units: { $sum: { $ifNull: ["$count", 1] } } } },
      { $project: { _id: 0, name: "$_id.name", game: "$_id.game", itemKey: "$_id.itemKey", imageURL: "$_id.image", accounts: { $size: "$accounts" }, units: 1 } },
    ]),
    DropLog.aggregate([
      { $match: match },
      { $group: { _id: "$game", accounts: { $addToSet: "$account" } } },
      { $project: { _id: 0, game: "$_id", accounts: { $size: "$accounts" } } },
    ]),
    DropLog.distinct("account", match),
  ]);
  return { items, games, accounts: accounts.length };
}

async function getForecast() {
  if (cache.value && Date.now() - cache.at < CACHE_MS) return cache.value;
  const [runtime, fallback, accounts, campaigns] = await Promise.all([
    readFleetRuntime(),
    taskRuntimeFallback(),
    // BotAccount.soldAt is only a shadow for per-game reservations and must not
    // hide the account's other unsold games. DropLog.soldAt is the authoritative
    // per-item availability gate below.
    BotAccount.find({ enabled: true, resellerId: { $in: ["", null] }, configFile: { $nin: ["", null] } }, { clientSecret: 1, login: 1, host: 1, configFile: 1, inProgressGames: 1, farmingProgress: 1, farmingSnapshotAt: 1 }).lean(),
    TwitchCampaign.find({ active: true, endAt: { $gt: new Date() } }, { game: 1, endAt: 1, image: 1, boxArt: 1 }).sort({ endAt: -1 }).limit(200).lean(),
  ]);
  // Do not count accounts on active renter configs as operator supply.
  const rented = new Set((await Renter.find({ botHost: { $exists: true }, botFile: { $gt: "" } }, { botHost: 1, botFile: 1 }).lean()).map((r) => (r.botHost || "local") + "|" + r.botFile));
  const eligible = accounts.filter((a) => !rented.has((a.host || "local") + "|" + (a.configFile || "")));
  const available = await loadAvailableStock(eligible.map((a) => a._id));
  const value = aggregateForecast({ accounts: eligible, runtime, fallback, campaigns, available });
  cache = { at: Date.now(), value };
  return value;
}

function clearCache() {
  cache = { at: 0, value: null };
}

module.exports = { getForecast, aggregateForecast, readFleetRuntime, clearCache, FRESH_MS };
