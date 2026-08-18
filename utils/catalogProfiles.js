const crypto = require("crypto");

const DropLog = require("../models/DropLog");
const BotAccount = require("../models/BotAccount");
const accountState = require("./twitchAccountState");

const DEFAULT_MIN_STOCK = 2;
const DEFAULT_MAX_PROFILES_PER_GAME = 8;

function signatureForItems(items) {
  return (items || [])
    .map((item) => ({
      itemKey: String(item.itemKey || "")
        .trim()
        .toLowerCase(),
      count: Math.max(1, Number(item.count) || 1),
    }))
    .filter((item) => item.itemKey)
    .sort((a, b) => a.itemKey.localeCompare(b.itemKey))
    .map((item) => `${item.itemKey}:${item.count}`)
    .join("|");
}

function sourceEventKeyFor(game, signature) {
  return `catalog-profile:${crypto
    .createHash("sha256")
    .update(
      `${String(game || "")
        .trim()
        .toLowerCase()}|${signature}`,
    )
    .digest("hex")}`;
}

function profileTitle(game, items, totalRewards) {
  const names = (items || []).map((item) => String(item.name || "").trim());
  const highlighted = names.find((name) => /rlcs|drop|collection/i.test(name));
  const label = highlighted
    ? highlighted.replace(/\s+(drop|collection drop)$/i, "")
    : `${items.length} reward types`;
  return `${game} ${label} bundle - ${totalRewards} rewards`;
}

function profileDescription(items, totalRewards) {
  const preview = (items || [])
    .slice(0, 5)
    .map((item) => `${item.count > 1 ? `${item.count}x ` : ""}${item.name}`)
    .join(", ");
  return `Exact inventory profile with ${totalRewards} rewards across ${items.length} distinct items. ${preview}${items.length > 5 ? ", and more" : ""}. Live stock is checked against deliverable inventory before a quote.`;
}

async function buildCatalogProfilePlan({
  minStock = DEFAULT_MIN_STOCK,
  maxProfilesPerGame = DEFAULT_MAX_PROFILES_PER_GAME,
  games = null,
} = {}) {
  const requestedGames = Array.isArray(games)
    ? games.map((game) => String(game || "").trim()).filter(Boolean)
    : null;
  const gameMatch = requestedGames?.length
    ? { $in: [...new Set(requestedGames)] }
    : { $nin: [null, ""] };
  const rows = await DropLog.aggregate(
    [
      {
        $match: {
          game: gameMatch,
          connected: { $ne: true },
          soldAt: null,
          itemKey: { $ne: "" },
        },
      },
      {
        $group: {
          _id: { game: "$game", account: "$account", itemKey: "$itemKey" },
          count: { $sum: "$count" },
          name: { $first: "$name" },
          image: { $first: { $ifNull: ["$imageLocal", "$imageURL"] } },
        },
      },
      {
        $group: {
          _id: { game: "$_id.game", account: "$_id.account" },
          items: {
            $push: {
              itemKey: "$_id.itemKey",
              count: "$count",
              name: "$name",
              image: "$image",
            },
          },
          totalRewards: { $sum: "$count" },
        },
      },
    ],
    { allowDiskUse: true },
  );
  if (!rows.length) return [];

  const accounts = await BotAccount.find(
    {
      _id: { $in: [...new Set(rows.map((row) => String(row._id.account)))] },
      credPassword: { $nin: [null, ""] },
      lastScanStatus: { $nin: ["token_invalid", "suspended"] },
    },
    { _id: 1, login: 1, credPassword: 1, lastScanStatus: 1 },
  ).lean();
  const loginById = new Map(
    accounts
      .filter(
        (account) =>
          account.credPassword &&
          !accountState.isUnusableScanStatus(account.lastScanStatus) &&
          String(account.login || "").trim(),
      )
      .map((account) => [String(account._id), String(account.login).trim()]),
  );
  const profilesByGame = new Map();
  for (const row of rows) {
    const game = String(row._id.game || "").trim();
    const login = loginById.get(String(row._id.account));
    if (!game || !login) continue;
    const items = (row.items || [])
      .map((item) => ({
        itemKey: String(item.itemKey || "")
          .trim()
          .toLowerCase(),
        count: Math.max(1, Number(item.count) || 1),
        name: String(item.name || "").trim(),
        image: String(item.image || "").trim(),
        game,
      }))
      .filter((item) => item.itemKey)
      .sort((a, b) => a.itemKey.localeCompare(b.itemKey));
    const signature = signatureForItems(items);
    if (!signature) continue;
    if (!profilesByGame.has(game)) profilesByGame.set(game, new Map());
    const profiles = profilesByGame.get(game);
    const profile = profiles.get(signature) || {
      game,
      signature,
      items,
      totalRewards: Number(row.totalRewards) || 0,
      logins: [],
    };
    profile.logins.push(login);
    profiles.set(signature, profile);
  }

  const plan = [];
  for (const [, profiles] of [...profilesByGame.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const ranked = [...profiles.values()]
      .filter((profile) => profile.logins.length >= minStock)
      .sort(
        (a, b) =>
          b.logins.length - a.logins.length ||
          b.totalRewards - a.totalRewards ||
          a.signature.localeCompare(b.signature),
      )
      .slice(0, maxProfilesPerGame);
    for (const profile of ranked) {
      profile.logins = [...new Set(profile.logins)].sort((a, b) =>
        a.localeCompare(b),
      );
      profile.sourceEventKey = sourceEventKeyFor(
        profile.game,
        profile.signature,
      );
      profile.name = profileTitle(
        profile.game,
        profile.items,
        profile.totalRewards,
      );
      profile.description = profileDescription(
        profile.items,
        profile.totalRewards,
      );
      profile.stock = profile.logins.length;
      profile.distinctRewards = profile.items.length;
      plan.push(profile);
    }
  }
  return plan;
}

module.exports = {
  DEFAULT_MIN_STOCK,
  DEFAULT_MAX_PROFILES_PER_GAME,
  signatureForItems,
  sourceEventKeyFor,
  buildCatalogProfilePlan,
};
