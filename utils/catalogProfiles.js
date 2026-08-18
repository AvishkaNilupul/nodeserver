const crypto = require("crypto");

const DropLog = require("../models/DropLog");
const BotAccount = require("../models/BotAccount");
const accountState = require("./twitchAccountState");

const DEFAULT_MIN_STOCK = 2;
// Bundles now group by item TYPE (not exact copy counts), so far fewer distinct
// bundles form per game — this cap can be generous without flooding the
// catalog. Lower it if a game produces more public bundles than you want.
const DEFAULT_MAX_PROFILES_PER_GAME = 40;

// Group accounts by the SET OF ITEM TYPES they hold, independent of how many
// copies of each they farmed. Accounts farmed at different times accumulate
// different counts of the same drops; keying the signature on counts shattered
// them into near-duplicate singletons that never met the minimum stock. The
// per-item copy count a bundle promises is decided later (the minimum held
// across the grouped accounts), not here.
function signatureForItems(items) {
  return [
    ...new Set(
      (items || [])
        .map((item) =>
          String(item.itemKey || "")
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    ),
  ]
    .sort((a, b) => a.localeCompare(b))
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
  return `Bundle of ${items.length} reward types — every account delivers at least ${totalRewards} rewards. ${preview}${items.length > 5 ? ", and more" : ""}. Live stock is verified against deliverable inventory before a quote.`;
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
  // The prod Atlas shared tier ignores allowDiskUse — a $group that exceeds
  // 100MB in memory just throws (see the atlas-no-diskuse note). Carrying
  // name/image strings through a group keyed per drop (game, account, itemKey)
  // is the pattern that blows that limit, and it made this whole sync throw for
  // large games like Rainbow Six. Split it: keep the per-account roll-up
  // numeric-only, and pull item metadata from a separate group keyed by item
  // alone (few groups, tiny), then merge in JS.
  const match = {
    game: gameMatch,
    connected: { $ne: true },
    soldAt: null,
    itemKey: { $ne: "" },
  };
  const [rows, metaRows] = await Promise.all([
    DropLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: { game: "$game", account: "$account", itemKey: "$itemKey" },
          count: { $sum: "$count" },
        },
      },
      {
        $group: {
          _id: { game: "$_id.game", account: "$_id.account" },
          items: { $push: { itemKey: "$_id.itemKey", count: "$count" } },
          totalRewards: { $sum: "$count" },
        },
      },
    ]),
    DropLog.aggregate([
      { $match: match },
      {
        $group: {
          _id: { game: "$game", itemKey: "$itemKey" },
          name: { $first: "$name" },
          image: { $first: { $ifNull: ["$imageLocal", "$imageURL"] } },
        },
      },
    ]),
  ]);
  if (!rows.length) return [];
  const metaByKey = new Map(
    metaRows.map((row) => [
      `${String(row._id.game || "")
        .trim()
        .toLowerCase()}||${String(row._id.itemKey || "")
        .trim()
        .toLowerCase()}`,
      {
        name: String(row.name || "").trim(),
        image: String(row.image || "").trim(),
      },
    ]),
  );

  const accounts = await BotAccount.find(
    {
      _id: { $in: [...new Set(rows.map((row) => String(row._id.account)))] },
      credPassword: { $nin: [null, ""] },
      lastScanStatus: { $nin: ["token_invalid", "suspended"] },
    },
    { _id: 1, login: 1, credPassword: 1, lastScanStatus: 1 },
  ).lean();
  const accountById = new Map(
    accounts
      .filter(
        (account) =>
          account.credPassword &&
          !accountState.isUnusableScanStatus(account.lastScanStatus) &&
          String(account.login || "").trim(),
      )
      .map((account) => [
        String(account._id),
        { id: String(account._id), login: String(account.login).trim() },
      ]),
  );
  const profilesByGame = new Map();
  for (const row of rows) {
    const game = String(row._id.game || "").trim();
    const account = accountById.get(String(row._id.account));
    if (!game || !account) continue;
    const gameKey = game.toLowerCase();
    const items = (row.items || [])
      .map((item) => {
        const itemKey = String(item.itemKey || "")
          .trim()
          .toLowerCase();
        const meta = metaByKey.get(`${gameKey}||${itemKey}`) || {};
        return {
          itemKey,
          count: Math.max(1, Number(item.count) || 1),
          name: String(meta.name || "").trim(),
          image: String(meta.image || "").trim(),
          game,
        };
      })
      .filter((item) => item.itemKey)
      .sort((a, b) => a.itemKey.localeCompare(b.itemKey));
    const signature = signatureForItems(items);
    if (!signature) continue;
    if (!profilesByGame.has(game)) profilesByGame.set(game, new Map());
    const profiles = profilesByGame.get(game);
    // Accounts sharing this signature hold the same item TYPES but possibly
    // different copy counts. Track the MINIMUM count per item so the bundle
    // only ever promises what every grouped account can actually deliver.
    const profile = profiles.get(signature) || {
      game,
      signature,
      itemsByKey: new Map(),
      logins: [],
      accountIds: [],
    };
    for (const item of items) {
      const existing = profile.itemsByKey.get(item.itemKey);
      if (!existing) {
        profile.itemsByKey.set(item.itemKey, { ...item });
      } else {
        existing.count = Math.min(existing.count, item.count);
        if (!existing.name && item.name) existing.name = item.name;
        if (!existing.image && item.image) existing.image = item.image;
      }
    }
    profile.logins.push(account.login);
    profile.accountIds.push(account.id);
    profiles.set(signature, profile);
  }

  const plan = [];
  for (const [, profiles] of [...profilesByGame.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    // Turn each signature's min-count accumulator into a concrete item list and
    // de-duplicate the account membership (duplicate-login rows are distinct
    // BotAccounts, so scoping is by account id — stock is the id count).
    const materialized = [...profiles.values()].map((profile) => {
      const items = [...profile.itemsByKey.values()]
        .map((item) => ({
          itemKey: item.itemKey,
          count: Math.max(1, Number(item.count) || 1),
          name: item.name,
          image: item.image,
          game: item.game,
        }))
        .sort((a, b) => a.itemKey.localeCompare(b.itemKey));
      const logins = [...new Set(profile.logins)].sort((a, b) =>
        a.localeCompare(b),
      );
      const accountIds = [...new Set(profile.accountIds)].sort((a, b) =>
        a.localeCompare(b),
      );
      return {
        game: profile.game,
        signature: profile.signature,
        items,
        totalRewards: items.reduce((sum, item) => sum + item.count, 0),
        logins,
        accountIds,
      };
    });
    const ranked = materialized
      .filter((profile) => profile.accountIds.length >= minStock)
      .sort(
        (a, b) =>
          b.accountIds.length - a.accountIds.length ||
          b.totalRewards - a.totalRewards ||
          a.signature.localeCompare(b.signature),
      )
      .slice(0, maxProfilesPerGame);
    for (const profile of ranked) {
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
      profile.stock = profile.accountIds.length;
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
