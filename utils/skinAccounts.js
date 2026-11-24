// Whole Epic + linked Twitch products. All mutations share the Epic sales
// lock; the lifetime SkinAccount ledger fences both stock systems.
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const Skin = require("../models/SkinAccount");
const Epic = require("../models/EpicAccount");
const Bot = require("../models/BotAccount");
const Pool = require("../models/AvailableAccount");
const Drops = require("../models/DropLog");
const Listing = require("../models/EpicListing");
const Session = require("../models/BuyerMailSession");
const sales = require("./epicSales");
const eld = require("./eldoradoAccountOffers");
const farm = require("./skinAccountFarm");
const inventoryApi = require("./twitchInventory");
const content = require("./skinAccountContent");
const { encrypt, decrypt } = require("./secretBox");
const DAY = 86400000;
const worker = { running: false, lastTickAt: null, lastError: "" };
let timer;
function fail(message, status = 409) {
  const e = new Error(message);
  e.user = true;
  e.status = status;
  throw e;
}
function id(v) {
  return String(v || "");
}
function objectId(v) {
  if (!/^[a-f0-9]{24}$/i.test(id(v)))
    fail("Invalid account or listing reference", 400);
  return id(v);
}
function dec(v) {
  try {
    return v ? String(decrypt(v) || "") : "";
  } catch {
    return "";
  }
}
function safeError(e) {
  return e?.user
    ? e.message
    : "A dependency check failed. The pair remains reserved; refresh to retry.";
}
async function patch(skin, fields, event, message) {
  const update = { $set: fields };
  if (event)
    update.$push = {
      history: { $each: [{ at: new Date(), event, message }], $slice: -60 },
    };
  await Skin.updateOne({ _id: skin._id }, update);
  return Skin.findById(skin._id).lean();
}
async function get(key) {
  const s = await Skin.findById(objectId(key)).lean();
  if (!s) fail("Skin account not found", 404);
  return s;
}
function available(s) {
  if (s.ownershipStatus !== "owned" || s.soldAt || s.state === "sold")
    fail("This pair is sold or quarantined and cannot be offered or farmed");
}
async function finishQuarantinePause(s) {
  const offerId = s.pendingPauseOfferId;
  if (!offerId) return;
  const listing = await Listing.findById(s.listingId)
    .select("externalId managedBy")
    .lean();
  if (
    listing?.managedBy !== "skin-account" ||
    listing.externalId !== offerId ||
    s.remoteOfferId !== offerId
  )
    fail("The quarantined marketplace offer identity changed");
  let offer = await eld.getAccountOffer(offerId);
  if (offer?.offerState === "Active") {
    await eld.pauseAccountOffer(offerId);
    offer = await eld.getAccountOffer(offerId);
  }
  if (offer?.offerState !== "Paused")
    fail("Marketplace quarantine pause could not be verified");
  await patch(s, { pendingPauseOfferId: "" });
}
async function quarantine(
  s,
  message,
  farmReadRecovery = "",
  pauseNeeded = true,
) {
  const next = await patch(
    s,
    {
      ownershipStatus: "quarantined",
      farmReadRecovery,
      pendingPauseOfferId: pauseNeeded ? s.remoteOfferId || "" : "",
      state: "attention",
      "farm.allowed": false,
      lastError: message,
    },
    s.ownershipStatus === "quarantined" && s.lastError === message
      ? null
      : "quarantined",
    message,
  );
  try {
    await finishQuarantinePause(next);
  } finally {
    await farm.stopFarm(next, message);
  }
  return next;
}
async function markSkinSold(
  epicAccountId,
  { soldAt = new Date(), orderId = "" } = {},
) {
  const s = await Skin.findOne({ epicAccountId }).lean();
  if (!s) return;
  const next = await patch(
    s,
    {
      state: "sold",
      ownershipStatus: "sold",
      farmReadRecovery: "",
      pendingPauseOfferId: "",
      soldAt,
      "farm.allowed": false,
      lastError: "",
    },
    s.soldAt ? null : "sold",
    "Marketplace sale recorded; linked pair permanently retired",
  );
  try {
    await farm.stopFarm(next, "Account sold");
  } catch {
    await Skin.updateOne(
      { _id: s._id },
      {
        $set: {
          "farm.status": "stopping",
          "farm.needsReload": true,
          "farm.lastError": "Sold account stop is pending; retrying",
        },
      },
    );
  }
}
async function assertEpicOwnership(epicId, ownListingId = null) {
  const [acc, refs, g2g, pa, sessions] = await Promise.all([
    Epic.findById(epicId).lean(),
    Listing.find({
      accounts: {
        $elemMatch: { epicAccountId: epicId, state: { $ne: "removed" } },
      },
    })
      .select("_id accounts externalId status")
      .lean(),
    require("../models/EpicG2gUnit").countDocuments({
      epicAccountId: epicId,
      state: { $ne: "removed" },
    }),
    require("../models/EpicPaUnit").countDocuments({ epicAccountId: epicId }),
    Session.find({ epicAccountId: epicId, revokedAt: null })
      .select("listingId stage")
      .lean(),
  ]);
  if (!acc || acc.sold) fail("Epic account is missing or already sold");
  if (
    refs.some((l) => id(l._id) !== id(ownListingId)) ||
    g2g ||
    pa ||
    sessions.some((s) => id(s.listingId) !== id(ownListingId))
  )
    fail(
      "Epic account is already held by another listing, sale or mail session",
    );
  if (!dec(acc.email) || !dec(acc.password))
    fail("Epic delivery credentials are missing");
  return acc;
}
async function twitchPair(login, { holdTag = "", adopting = false } = {}) {
  const normalized = String(login || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(normalized))
    fail("Enter a valid Twitch login", 400);
  const bots = await Bot.find({
    login: new RegExp("^" + normalized + "$", "i"),
  }).lean();
  if (bots.length !== 1)
    fail(
      "Twitch login must have exactly one inventory identity; resolve duplicate or missing accounts first",
    );
  const bot = bots[0];
  if (
    !bot.twitchId ||
    !bot.clientSecret ||
    !bot.hasPassword ||
    !dec(bot.credPassword)
  )
    fail("Twitch identity, token and delivery password are required");
  const aliases = await Bot.countDocuments({ twitchId: bot.twitchId });
  if (aliases !== 1)
    fail("Duplicate Twitch identities must be resolved before enrollment");
  if (
    bot.soldPurchaseId ||
    bot.soldBulkOrderId ||
    bot.resellerId ||
    bot.copiedCount
  )
    fail("Twitch account was sold, leased or copied for delivery");
  const pool = await Pool.findOne({ usernameLower: normalized }).lean();
  if (!pool) fail("The Twitch account needs its pool ownership record");
  const existingOwnerHold =
    adopting &&
    /^owner:rl-epic-link-test:/.test(bot.soldToUsername || "") &&
    pool.manualSold &&
    pool.claimedNote === bot.soldToUsername;
  const ours =
    holdTag && bot.soldToUsername === holdTag && pool.claimedNote === holdTag;
  if ((bot.soldAt || pool.manualSold) && !existingOwnerHold && !ours)
    fail("Twitch account is reserved outside this product");
  if (
    pool.listed ||
    (pool.soldGames || []).length ||
    (pool.usageHistory || []).some((x) =>
      ["sold", "spent", "rented", "recycled"].includes(x.event),
    )
  )
    fail("Twitch account has a listing, buyer or rental history");
  await require("./skinAccountOwnership").assertUnspent(bot, pool);
  const foreign = await Drops.countDocuments({
    account: bot._id,
    soldAt: { $ne: null },
    soldToUsername: { $ne: existingOwnerHold ? bot.soldToUsername : holdTag },
  });
  if (foreign)
    fail("Some Twitch rewards already belong to another reservation");
  if (
    !adopting &&
    !ours &&
    (await Drops.countDocuments({ account: bot._id, connected: true }))
  )
    fail(
      "Twitch account already has redeemed rewards; use the verified adoption flow for an existing product",
    );
  return {
    bot,
    pool,
    holdTag: existingOwnerHold ? bot.soldToUsername : holdTag,
  };
}
async function scan(s, { baseline = false } = {}) {
  const bot = await Bot.findById(s.botAccountId).lean();
  if (!bot) fail("Twitch inventory identity is missing");
  const host = require("./botHosts").resolveHost(bot.host || "local");
  if (!host) fail("Twitch farm host is unknown");
  const result = await inventoryApi.fetchInventory(bot.clientSecret, { host });
  const snapshot = content.claimedSnapshot(result, s);
  const inv = content.reconcileRewards(s.inventory, snapshot, { baseline });
  const policy = farm.derivePolicy(s);
  await require("./dropScanner").upsertDrops(
    bot._id,
    "BotAccount",
    bot.login,
    result.drops || [],
    policy,
  );
  const now = new Date();
  const pending = (result.inProgress || []).filter(inventoryApi.isPendingDrop);
  const farmingProgress = pending
    .filter((d) => d.name && d.game)
    .sort((a, b) => (b.percent || 0) - (a.percent || 0))
    .slice(0, 100)
    .map((d) => ({
      name: String(d.name).slice(0, 240),
      game: String(d.game).slice(0, 160),
      campaign: String(d.campaign || "").slice(0, 240),
      imageURL: String(d.imageURL || "").slice(0, 1000),
      current: Math.max(0, +d.current || 0),
      required: Math.max(0, +d.required || 0),
      percent: Math.max(0, Math.min(100, +d.percent || 0)),
      connected: d.connected === true,
      scannedAt: now,
    }));
  await Bot.updateOne(
    { _id: bot._id, clientSecret: bot.clientSecret },
    {
      $set: {
        lastScanAt: now,
        lastScanStatus: "ok",
        lastScanError: "",
        dropCount: await Drops.countDocuments({ account: bot._id }),
        inProgressCount: pending.length,
        inProgressGames: [
          ...new Set(pending.map((d) => d.game).filter(Boolean)),
        ],
        farmingProgress,
        farmingSnapshotAt: now,
        farmingCompleteAt: pending.length ? null : bot.farmingCompleteAt || now,
      },
    },
  );
  return patch(s, { inventory: inv });
}
function sectionFor(s) {
  const sec = content.marketplaceSection(s.profile);
  // Preserve the offer's real title/tag selection while updating level/rank
  // from the explicitly observed profile.
  const prior = (s.listingMeta?.section?.offerAttributes || []).find(
    (a) => a.id === "rocket-league-tags-titles",
  );
  if (prior)
    sec.offerAttributes = sec.offerAttributes.map((a) =>
      a.id === prior.id ? prior : a,
    );
  return sec;
}

function remoteProof(s, l, acc, offer, entries) {
  const unit = l?.accounts?.find(
    (u) => id(u.epicAccountId) === id(s.epicAccountId),
  );
  if (
    !unit ||
    unit.state !== "listed" ||
    acc.sold ||
    entries.length !== 1 ||
    Number(offer?.quantity) !== 1
  )
    fail("The account is no longer proven unsold on Eldorado");
  const e = entries[0],
    email = dec(acc.email).toLowerCase();
  if (
    !e.id ||
    e.id !== unit.entryId ||
    e.accountLogin.toLowerCase() !== email ||
    e.accountPassword !== dec(acc.password)
  )
    fail("Marketplace delivery identity changed; review before continuing");
  if (
    !e.additionalInfo.includes(s.twitchLogin) ||
    !e.emailProviderUrl ||
    !e.emailPassword
  )
    fail("Linked Twitch or mail delivery details are missing");
  return e;
}
async function verifyMailEntry(unit, entry, acc) {
  const session = unit?.sessionId
    ? await Session.findById(unit.sessionId).lean()
    : null;
  const email = dec(acc.email).trim().toLowerCase();
  if (
    !session ||
    session.kind !== "epic" ||
    id(session.epicAccountId) !== id(acc._id) ||
    String(session.inboxAddress || "").toLowerCase() !== email ||
    session.revokedAt ||
    session.stage !== "listed" ||
    !dec(session.passwordEnc) ||
    entry.emailLogin.toLowerCase() !== email ||
    entry.emailPassword !== dec(session.passwordEnc) ||
    entry.emailProviderUrl !== sales.providerUrl()
  )
    fail(
      "The private mail delivery identity changed; review before continuing",
    );
}

async function remoteCheck(s) {
  const [l, acc] = await Promise.all([
    Listing.findById(s.listingId),
    Epic.findById(s.epicAccountId).lean(),
  ]);
  if (!l || !acc) fail("The linked Epic listing or account is missing");
  if (
    !s.remoteOfferId ||
    l.externalId !== s.remoteOfferId ||
    l.managedBy !== "skin-account"
  )
    fail("Marketplace offer identity changed; review before continuing");
  if (
    acc.sold ||
    l.accounts.some(
      (u) => id(u.epicAccountId) === id(s.epicAccountId) && u.state === "sold",
    )
  ) {
    await markSkinSold(s.epicAccountId, { soldAt: new Date() });
    return { sold: true };
  }
  const [offer, entries] = await Promise.all([
    eld.getAccountOffer(l.externalId),
    eld.getAccountEntries(l.externalId),
  ]);
  const entry = remoteProof(s, l, acc, offer, entries);
  await verifyMailEntry(
    l.accounts.find((u) => id(u.epicAccountId) === id(s.epicAccountId)),
    entry,
    acc,
  );
  const bot = await Bot.findById(s.botAccountId).lean();
  if (
    !bot ||
    !entry.additionalInfo.includes(dec(bot.credPassword)) ||
    !dec(bot.credPassword)
  )
    fail("The private Twitch delivery password needs review");
  const state = String(offer.offerState || "");
  if (!["Active", "Paused"].includes(state))
    fail("Marketplace offer is not active or paused");
  await Listing.updateOne(
    { _id: l._id },
    {
      $set: {
        "remote.offerState": state,
        "remote.quantity": 1,
        "remote.entries": 1,
        "remote.readAt": new Date(),
        status: state === "Active" ? "active" : "paused",
      },
    },
  );
  s = await patch(s, {
    lastSaleCheckAt: new Date(),
    listingPriceUsd: require("./skinAccountMarketplace").usdPrice(offer),
  });
  return {
    skin: s,
    listing: l,
    acc,
    offer,
    entries,
    entry,
    privateValues: [
      entry.accountLogin,
      entry.accountPassword,
      entry.emailPassword,
      dec(bot.credPassword),
    ],
    active: state === "Active",
  };
}
async function overview() {
  const skins = await Skin.find({}).sort({ createdAt: -1 }).lean();
  const rows = await Promise.all(skins.map(publicRow));
  return {
    rows,
    summary: {
      total: rows.length,
      listed: rows.filter((r) => r.state === "listed").length,
      farming: rows.filter((r) => r.farm.status === "farming").length,
      attention: rows.filter((r) => r.state === "attention").length,
      sold: rows.filter((r) => r.state === "sold").length,
    },
    worker: { ...worker },
  };
}
async function publicRow(s) {
  const [a, l] = await Promise.all([
    Epic.findById(s.epicAccountId)
      .select("accountId displayName country")
      .lean(),
    s.listingId
      ? Listing.findById(s.listingId)
          .select("url title status priceUsd remote")
          .lean()
      : null,
  ]);
  return {
    id: id(s._id),
    gameKey: s.gameKey,
    gameName: s.gameName,
    state: s.state,
    ownershipStatus: s.ownershipStatus,
    profile: s.profile,
    epic: {
      id: id(s.epicAccountId),
      accountId: a?.accountId || "",
      displayName: a?.displayName || "",
      region: s.profile?.region || "",
    },
    twitch: {
      id: id(s.botAccountId),
      login: s.twitchLogin,
      twitchId: s.twitchId,
    },
    link: s.link,
    farm: {
      enabled: s.farm?.enabled,
      allowed: s.farm?.allowed,
      status: s.farm?.status,
      lastCheckedAt: s.farm?.lastCheckedAt,
      lastError: s.farm?.lastError,
      needsReload: s.farm?.needsReload,
    },
    listing: {
      id: id(s.listingId),
      url: l?.url || "",
      status: l?.status || "",
      title: l?.title || "",
      priceUsd: s.listingPriceUsd,
      remoteQuantity: l?.remote?.quantity,
    },
    inventory: {
      verified: s.inventory?.verified || [],
      pending: s.inventory?.pending || [],
      verifiedAt: s.inventory?.verifiedAt,
      lastScanAt: s.inventory?.lastScanAt,
      scanError: s.inventory?.scanError || "",
    },
    pricing: s.pricing,
    recovery: {
      required: s.mutation?.kind === "create",
      listingId: id(s.listingId),
    },
    lastError: s.lastError,
    history: (s.history || []).slice(-20),
  };
}
async function reservePair(
  { epicAccountId, twitchLogin, listingId },
  actor = "superadmin",
) {
  return sales._internals.withLock(async () => {
    let listing = null;
    if (listingId) {
      listing = await Listing.findById(objectId(listingId));
      if (
        !listing ||
        listing.section !== "rocket-league" ||
        !["active", "paused"].includes(listing.status) ||
        listing.accounts.length !== 1 ||
        listing.accounts[0].state !== "listed"
      )
        fail("Choose an existing one-account Rocket League offer");
      epicAccountId = listing.accounts[0].epicAccountId;
    }
    objectId(epicAccountId);
    const acc = await assertEpicOwnership(epicAccountId, listing?._id);
    const prior = await Skin.findOne({
      $or: [
        { epicAccountId },
        { twitchLogin: String(twitchLogin || "").toLowerCase() },
      ],
    }).lean();
    if (prior)
      fail("One of these accounts is already enrolled; open its existing row");
    const newId = new mongoose.Types.ObjectId();
    const pair = await twitchPair(twitchLogin, {
      adopting: !!listing,
      holdTag: "skin-account:" + newId,
    });
    const s = {
      _id: newId,
      epicAccountId: acc._id,
      botAccountId: pair.bot._id,
      twitchLogin: pair.bot.login.toLowerCase(),
      twitchId: pair.bot.twitchId,
      holdTag: pair.holdTag,
      heldAt: new Date(),
      listingId: listing?._id || null,
      remoteOfferId: listing?.externalId || "",
      listingPriceUsd: listing?.priceUsd || 4.99,
      profile: {
        region: require("./epicRegion").accountCountry(acc).country || "",
        level: 0,
        credits: 0,
        rank: "Unranked",
        platform: "PC",
      },
      pricing: {
        mode: "growth",
        floorUsd: listing?.priceUsd || 4.99,
        basePriceUsd: listing?.priceUsd || 4.99,
        ceilingUsd: 100,
      },
    };
    const ownership = await farm.validateOwnership(s);
    if (!ownership.ok) fail(ownership.reason);
    let remote;
    if (listing) {
      const [offer, entries] = await Promise.all([
        eld.getAccountOffer(listing.externalId),
        eld.getAccountEntries(listing.externalId),
      ]);
      const entry = remoteProof(s, listing, acc, offer, entries);
      await verifyMailEntry(listing.accounts[0], entry, acc);
      if (!entry.additionalInfo.includes(dec(pair.bot.credPassword)))
        fail(
          "The chosen Twitch password is not in this offer’s private delivery",
        );
      remote = { offer, entries };
      const sec = JSON.parse(JSON.stringify(eld.SECTIONS["rocket-league"]));
      // Preserve every exact marketplace attribute, never replace a progressed
      // account with the generic fresh-account section defaults.
      if (Array.isArray(offer.attributes) && offer.attributes.length)
        sec.offerAttributes = offer.attributes.map((a) => ({
          id: a.id,
          type: a.type,
          ...(a.type === "Numeric"
            ? { value: a.value }
            : {
                values: (a.values || []).map((v) =>
                  typeof v === "object" ? v.id : v,
                ),
              }),
        }));
      // Existing app offers can expose attributes with display labels only;
      // accept the known verified first-profile level and require inventory confirmation.
      if (
        !sec.offerAttributes.every(
          (a) =>
            a.id &&
            a.type &&
            (a.type === "Numeric"
              ? Number.isFinite(+a.value)
              : Array.isArray(a.values)),
        )
      )
        fail(
          "Marketplace attributes could not be preserved; review the offer before adoption",
        );
      s.listingMeta = {
        mainOfferImage: offer.mainOfferImage || listing.mainOfferImage,
        offerImages: offer.offerImages || [],
        section: sec,
        coverSource: listing.coverSource,
      };
      s.state = offer.offerState === "Active" ? "listed" : "paused";
    }
    let row = await Skin.create(s);
    try {
      const stamp = {
        soldAt: row.heldAt,
        soldToUsername: row.holdTag,
        soldSetId: "skin-account:" + row._id,
      };
      const cas = await Bot.updateOne(
        {
          _id: pair.bot._id,
          soldAt: pair.bot.soldAt || null,
          soldToUsername: pair.bot.soldToUsername || "",
        },
        { $set: stamp },
      );
      if (cas.matchedCount !== 1)
        fail("Twitch ownership changed during enrollment");
      const held = await Pool.updateOne(
        {
          _id: pair.pool._id,
          claimedNote: pair.pool.claimedNote || "",
          manualSold: !!pair.pool.manualSold,
          listed: { $ne: true },
        },
        {
          $set: {
            manualSold: true,
            status: "claimed",
            claimedAt: row.heldAt,
            claimedNote: row.holdTag,
          },
          $push: {
            usageHistory: {
              $each: [
                {
                  at: new Date(),
                  event: "held",
                  note: "Whole skin-account product",
                  actor,
                },
              ],
              $slice: -50,
            },
          },
        },
      );
      if (held.matchedCount !== 1)
        fail("Twitch pool ownership changed during enrollment");
      await Drops.updateMany(
        {
          account: pair.bot._id,
          $or: [{ soldAt: null }, { soldToUsername: row.holdTag }],
        },
        { $set: stamp },
      );
      const foreign = await Drops.countDocuments({
        account: pair.bot._id,
        soldAt: { $ne: null },
        soldToUsername: { $ne: row.holdTag },
      });
      if (foreign)
        fail("A competing reward reservation appeared; pair quarantined");
      if (listing)
        await Listing.updateOne(
          { _id: listing._id },
          { $set: { managedBy: "skin-account" } },
        );
      row = await patch(
        row,
        {},
        listing ? "adopted" : "enrolled",
        listing
          ? "Existing account offer and private delivery verified"
          : "Epic and Twitch identities reserved as one product",
      );
      return publicRow(row);
    } catch (e) {
      await quarantine(row, safeError(e));
      throw e;
    }
  });
}
async function candidates(q = "") {
  const search = String(q || "")
    .trim()
    .slice(0, 40);
  const re = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const held = await Skin.find({})
    .select("epicAccountId botAccountId twitchLogin twitchId")
    .lean();
  const ctx = await sales.stockContext();
  const epicAccounts = ctx.accounts
    .filter(
      (a) =>
        !held.some((s) => id(s.epicAccountId) === id(a._id)) &&
        sales.readinessOf(a, ctx).state === "ready" &&
        (!search || re.test(a.displayName || "")),
    )
    .slice(0, 30)
    .map((a) => ({
      id: id(a._id),
      displayName: a.displayName,
      accountId: a.accountId,
      region: require("./epicRegion").accountCountry(a).country,
      games: sales.gameTitles(a),
    }));
  const bots = await Bot.find({
    soldAt: null,
    hasPassword: true,
    copiedCount: 0,
    login: re,
  })
    .select("_id login twitchId")
    .limit(60)
    .lean();
  const twitchAccounts = [];
  for (const b of bots) {
    if (
      held.some(
        (s) =>
          s.twitchId === b.twitchId || s.twitchLogin === b.login.toLowerCase(),
      )
    )
      continue;
    if (
      await Drops.exists({
        account: b._id,
        $or: [{ soldAt: { $ne: null } }, { connected: true }],
      })
    )
      continue;
    twitchAccounts.push({
      id: id(b._id),
      login: b.login,
      twitchId: b.twitchId,
    });
    if (twitchAccounts.length === 30) break;
  }
  return { epicAccounts, twitchAccounts };
}
async function verifyLink(key, body) {
  return sales._internals.withLock(async () => {
    let s = await get(key);
    available(s);
    const a = await assertEpicOwnership(s.epicAccountId, s.listingId);
    if (
      body.confirm !== true ||
      body.epicAccountId !== a.accountId ||
      String(body.twitchId) !== s.twitchId
    )
      fail(
        "Confirm the exact external Epic and Twitch IDs shown in Connections",
        400,
      );
    const evidence = content.clean(body.evidence, 400);
    if (evidence.length < 12)
      fail("Record how the exact account pairing was checked", 400);
    if (
      s.link?.status === "verified" &&
      (s.link.epicAccountId !== a.accountId || s.link.twitchId !== s.twitchId)
    )
      fail("An enrolled pair cannot be reassigned");
    await require("./skinAccountLink").verify(s, a);
    s = await scan(s, { baseline: !s.inventory?.baselineAt });
    s = await patch(
      s,
      {
        "link.status": "verified",
        "link.verifiedAt": new Date(),
        "link.lastCheckedAt": new Date(),
        "link.epicAccountId": a.accountId,
        "link.twitchId": s.twitchId,
        "link.detail": evidence,
        lastError: "",
      },
      "link-verified",
      "Exact Epic and Twitch identities confirmed",
    );
    return publicRow(s);
  });
}
async function confirmInventory(key, body) {
  return sales._internals.withLock(async () => {
    let s = await get(key);
    available(s);
    if (body.confirm !== true)
      fail(
        "Confirm that all pending claims are accounted for in the observed game inventory",
        400,
      );
    const items = content.validateItems(body.items),
      profile = content.validateProfile(body.profile);
    const evidence = content.clean(body.evidence, 400);
    if (evidence.length < 12) fail("Record the in-game inventory check", 400);
    if (s.link?.status !== "verified") fail("Verify the account link first");
    s = await scan(s, { baseline: true });
    const fields = {
      "inventory.verified": items,
      "inventory.verifiedAt": new Date(),
      "inventory.evidence": evidence,
      profile,
      lastError: "",
    };
    if (!s.pricing?.growthBaselineAt) {
      fields["pricing.growthBaseline"] = s.inventory.highWater;
      fields["pricing.growthBaselineAt"] = new Date();
    }
    if (!s.listingId) fields.state = "ready";
    s = await patch(
      s,
      fields,
      "inventory-confirmed",
      "Full observed game inventory and reward baseline recorded",
    );
    return publicRow(s);
  });
}
async function setPricing(key, body) {
  return sales._internals.withLock(async () => {
    let s = await get(key);
    available(s);
    const { mode } = body;
    if (!["manual", "market", "growth"].includes(mode))
      fail("Choose manual, comparable-market or reward-growth pricing", 400);
    const min = Number(body.floorUsd),
      max = Number(body.ceilingUsd),
      base = Number(body.basePriceUsd);
    if (
      ![min, max, base].every(Number.isFinite) ||
      min < 0.05 ||
      max < min ||
      max > 10000 ||
      base < min ||
      base > max
    )
      fail("Set a valid starting price and bounds", 400);
    const rates = {
      basicDropUsd: 0.1,
      premiumDropUsd: 0.2,
      cosmeticUsd: 0.5,
      duplicateCosmeticUsd: 0.1,
      apexUsd: 1,
      ...s.pricing?.growthRates,
      ...(body.growthRates || body.rates || {}),
    };
    for (const k of [
      "basicDropUsd",
      "premiumDropUsd",
      "cosmeticUsd",
      "duplicateCosmeticUsd",
      "apexUsd",
    ])
      if (!Number.isFinite(+rates[k]) || +rates[k] < 0 || +rates[k] > 100)
        fail("Reward additions must be between $0 and $100", 400);
      else rates[k] = +rates[k];
    s = await patch(
      s,
      {
        "pricing.mode": mode,
        "pricing.floorUsd": min,
        "pricing.ceilingUsd": max,
        "pricing.basePriceUsd": base,
        "pricing.growthRates": rates,
        "pricing.checkedAt": null,
      },
      "pricing-saved",
      "Bundle pricing rule updated",
    );
    return publicRow(s);
  });
}
async function refreshUnlocked(key, { manual = false } = {}) {
  let s = await get(key);
  if (s.soldAt || s.state === "sold") {
    await farm.stopFarm(s, "Account sold");
    return publicRow(await get(key));
  }
  let remote, ownershipFailure;
  try {
    const [soldEpic, soldListing] = await Promise.all([
      Epic.findById(s.epicAccountId).select("sold").lean(),
      s.listingId
        ? Listing.findById(s.listingId).select("accounts").lean()
        : null,
    ]);
    if (
      soldEpic?.sold ||
      soldListing?.accounts?.some(
        (u) =>
          id(u.epicAccountId) === id(s.epicAccountId) && u.state === "sold",
      )
    ) {
      await markSkinSold(s.epicAccountId);
      return publicRow(await get(key));
    }
    await finishQuarantinePause(s);
    if (s.ownershipStatus === "quarantined" && !s.farmReadRecovery && !manual) {
      await farm.stopFarm(s, "Ownership needs review");
      return publicRow(await get(key));
    }
    const currentEpic = await assertEpicOwnership(s.epicAccountId, s.listingId);
    if (s.link?.status === "verified") {
      await require("./skinAccountLink").verify(s, currentEpic);
      s = await patch(s, { "link.lastCheckedAt": new Date() });
    }
    await twitchPair(s.twitchLogin, { holdTag: s.holdTag });
    if (s.mutation?.kind === "create")
      fail(
        "The last publish outcome is uncertain. Inspect the seller offer before attaching or retrying it",
      );
    if (s.listingId) {
      remote = await remoteCheck(s);
      if (remote.sold) return publicRow(await get(key));
      s = remote.skin;
    }
    s = await scan(s);
    const own = await farm.validateOwnership(s, {
      requireHold: true,
      requireScan: true,
    });
    if (!own.ok) {
      ownershipFailure = own;
      fail(own.reason);
    }
    const canFarm =
      s.link?.status === "verified" &&
      !!s.inventory?.verifiedAt &&
      !!s.inventory?.baselineAt;
    const nextState = s.listingId
      ? remote.active
        ? "listed"
        : "paused"
      : canFarm
        ? "ready"
        : "preparing";
    s = await patch(s, {
      ownershipStatus: "owned",
      state: nextState,
      lastError: "",
      "farm.allowed": canFarm,
    });
    if (s.mutation?.kind === "edit") {
      // An interrupted edit is deliberately left paused. Refresh verifies
      // ownership but only the explicit Resume action restores availability.
      s = await patch(s, {
        state: "paused",
        farmReadRecovery: "",
        mutation: {},
        lastError:
          "The interrupted update was recovered paused. Review its preview, then resume.",
      });
    }
    if (canFarm) {
      const quote =
        s.pricing?.mode === "manual"
          ? {
              currentUsd: s.listingPriceUsd,
              proposedUsd: s.pricing.basePriceUsd,
              reason: "Explicit manual bundle price",
              checkedAt: new Date(),
            }
          : await require("./skinAccountPricing").quotePrice(s);
      s = await patch(s, {
        "pricing.currentUsd": quote.currentUsd,
        "pricing.proposedUsd": quote.proposedUsd,
        "pricing.reason": quote.reason,
        "pricing.checkedAt": quote.checkedAt,
      });
      if (!s.listingId)
        s = await patch(s, { listingPriceUsd: quote.proposedUsd });
      const preview = content.content(s);
      if (s.listingId && preview.canPublish) {
        await require("./skinAccountMarketplace").updateListed(
          { skin: s, preview, priceUsd: quote.proposedUsd },
          {
            eld,
            read: () => remoteCheck(s),
            record: (fields) => patch(s, fields),
            section: sectionFor,
            saveListing: (fields) =>
              Listing.updateOne({ _id: s.listingId }, { $set: fields }),
          },
        );
        s = await get(key);
        if (s.soldAt) return publicRow(s);
        s = await patch(
          s,
          { "farm.allowed": true },
          "reconciled",
          "Ownership, reward claims and listing checked",
        );
      }
    }
    const farmResult = await farm.reconcileFarm(s);
    if (farmResult?.locationFailure) {
      ownershipFailure = farmResult;
      fail(farmResult.reason);
    }
    if (farmResult?.ok === false)
      s = await patch(s, {
        state: "attention",
        "farm.allowed": false,
        lastError:
          farmResult.reason || "The farm needs attention; inspect its status",
      });
    else if (s.farmReadRecovery) {
      if (s.farmReadRecovery === "resume" && canFarm && s.remoteOfferId)
        await resumeVerified(s);
      else await patch(s, { farmReadRecovery: "" });
    }
    return publicRow(await get(key));
  } catch (e) {
    const message = safeError(e);
    const fresh = await get(key);
    if (fresh.soldAt) {
      await farm.stopFarm(fresh, "Account sold");
      return publicRow(fresh);
    }
    if (fresh.pendingPauseOfferId) {
      await farm.stopFarm(fresh, message);
    } else if (
      ownershipFailure ||
      (e.user &&
        /ownership|another|already|no longer proven|identity changed|password needs|missing|reserved|leased|copied|different identity|disconnected/i.test(
          message,
        ))
    ) {
      let recovery = "";
      if (ownershipFailure?.unreadableHomes && !fresh.mutation?.kind) {
        if (fresh.farmReadRecovery) recovery = fresh.farmReadRecovery;
        else if (fresh.ownershipStatus === "owned")
          recovery = remote?.active ? "resume" : "recheck";
      }
      await quarantine(fresh, message, recovery, remote?.active !== false);
    } else {
      const fields = {
        state: "attention",
        "farm.allowed": false,
        lastError: message,
        "inventory.scanError": message,
      };
      if (fresh.mutation?.kind) fields.farmReadRecovery = "";
      const next = await patch(fresh, fields, "check-failed", message);
      await farm.stopFarm(next, message);
      if (fresh.mutation?.kind === "edit" && fresh.remoteOfferId)
        await eld.pauseAccountOffer(fresh.remoteOfferId).catch(() => {});
    }
    if (manual) throw e;
    return publicRow(await get(key));
  }
}
async function refresh(key) {
  return sales._internals.withLock(() =>
    refreshUnlocked(key, { manual: true }),
  );
}
async function setFarm(key, { enabled }) {
  if (typeof enabled !== "boolean")
    fail("Choose whether farming is enabled", 400);
  return sales._internals.withLock(async () => {
    let s = await get(key);
    if (enabled) available(s);
    s = await patch(
      s,
      { "farm.enabled": enabled },
      enabled ? "farm-enabled" : "farm-disabled",
      enabled ? "Farming requested until sale" : "Farming switched off",
    );
    if (!enabled) {
      await farm.stopFarm(s, "Farming switched off");
      return publicRow(await get(key));
    }
    return refreshUnlocked(key, { manual: true });
  });
}
async function preview(key) {
  const s = await get(key);
  return content.content(s);
}
async function pause(key) {
  return sales._internals.withLock(async () => {
    let s = await get(key);
    if (!s.remoteOfferId) fail("No marketplace offer is attached");
    if (s.soldAt) fail("The account has already sold");
    if (s.farmReadRecovery === "resume")
      s = await patch(s, { farmReadRecovery: "recheck" });
    await eld.pauseAccountOffer(s.remoteOfferId);
    s = await patch(
      s,
      { state: "paused" },
      "paused",
      "Marketplace offer paused; ownership hold retained",
    );
    const r = await remoteCheck(s);
    if (!r.sold && r.active) fail("Marketplace pause could not be verified");
    return publicRow(await get(key));
  });
}
async function resumeVerified(s) {
  available(s);
  if (s.state === "attention" || s.mutation?.kind)
    fail("Resolve the outstanding account check before resuming");
  const p = content.content(s);
  if (!p.canPublish) fail(p.problems.join("; "));
  const r = await remoteCheck(s);
  if (r.sold) return publicRow(await get(s._id));
  if (!r.active) {
    await eld.resumeAccountOffer(s.remoteOfferId);
    const after = await remoteCheck(s);
    if (after.sold) return publicRow(await get(s._id));
    if (!after.active) fail("Marketplace resume could not be verified");
  }
  s = await patch(
    s,
    { state: "listed", farmReadRecovery: "", lastError: "" },
    "resumed",
    "Marketplace listing resumed after unsold-stock check",
  );
  return publicRow(s);
}
async function resume(key) {
  return sales._internals.withLock(async () => {
    let s = await get(key);
    available(s);
    if (!s.remoteOfferId) fail("No offer is attached");
    await refreshUnlocked(key, { manual: true });
    s = await get(key);
    return resumeVerified(s);
  });
}
async function uploadCover(url) {
  const parsed = new URL(String(url || ""));
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    require("net").isIP(parsed.hostname)
  )
    fail("Use a public HTTPS JPEG or PNG image URL", 400);
  const https = require("https"),
    dns = require("dns");
  const agent = new https.Agent({
    lookup: (host, opts, cb) =>
      dns.lookup(host, { family: 4 }, (err, address) => {
        if (err) return cb(err);
        const p = address.split(".").map(Number);
        if (
          p[0] === 0 ||
          p[0] === 10 ||
          p[0] === 127 ||
          p[0] >= 224 ||
          (p[0] === 169 && p[1] === 254) ||
          (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
          (p[0] === 192 && p[1] === 168) ||
          (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
        )
          return cb(new Error("Private image host rejected"));
        cb(null, opts.all ? [{ address, family: 4 }] : address, 4);
      }),
  });
  const fs = require("fs/promises"),
    path = require("path");
  let dir;
  try {
    const r = await require("axios").get(parsed.href, {
      httpsAgent: agent,
      responseType: "arraybuffer",
      timeout: 20000,
      maxContentLength: 8 * 1024 * 1024,
      maxRedirects: 0,
      proxy: false,
    });
    const type = String(r.headers["content-type"] || "");
    if (!/^image\/(png|jpeg)/i.test(type))
      fail("Cover image must be PNG or JPEG", 400);
    await require("sharp")(r.data).metadata();
    dir = await fs.mkdtemp(path.join(require("os").tmpdir(), "skin-cover-"));
    const file = path.join(
      dir,
      type.includes("png") ? "image.png" : "image.jpg",
    );
    await fs.writeFile(file, r.data);
    return await eld.uploadImage(file);
  } finally {
    agent.destroy();
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
}
async function publish(key, body, actor = "superadmin") {
  return sales._internals.withLock(async () => {
    let s = await get(key);
    available(s);
    if (body.confirm !== true)
      fail("Preview and confirm this listing first", 400);
    if (s.listingId || s.remoteOfferId || s.mutation?.kind)
      fail(
        "This product already has a listing or an unresolved publish attempt",
      );
    await refreshUnlocked(key, { manual: true });
    s = await get(key);
    available(s);
    const p = content.content(s);
    if (!p.canPublish) fail(p.problems.join("; "));
    const a = await assertEpicOwnership(s.epicAccountId);
    const permission = await sales._internals.eldoradoPermission({
      fresh: true,
      section: "rocket-league",
    });
    if (permission.canSell !== true)
      fail("The marketplace has not confirmed account-selling availability");
    const email = dec(a.email).trim().toLowerCase();
    const mailCheck = await require("./outlookGraphReader").checkInbox(email);
    const verdict = sales.inboxVerdict(mailCheck, await sales.getConfig());
    if (!verdict?.ok)
      fail("Epic email-code access must be ready before publishing");
    // Skin-product sale hook activates the promised 14-day mail window.
    const purl = sales.providerUrl();
    if (!purl) fail("The HTTPS email-code viewer is not configured");
    const image = await uploadCover(body.coverUrl);
    const mailPassword = sales.mintPassword();
    const bot = await Bot.findById(s.botAccountId).lean();
    const e = sales.entryFor({
      email,
      epicPassword: dec(a.password),
      mailPassword,
      purl,
      days: 14,
    });
    e.additionalInfo +=
      "\nLinked Twitch login: " +
      s.twitchLogin +
      "\nTwitch password: " +
      dec(bot.credPassword) +
      "\nOriginal mailboxes are not included. No future rewards or farming service included.";
    if (!dec(bot.credPassword) || e.additionalInfo.length > 1000)
      fail("Private delivery details cannot be prepared");
    if (
      [email, dec(a.password), dec(bot.credPassword), mailPassword].some(
        (secret) => secret && (p.title + "\n" + p.description).includes(secret),
      )
    )
      fail("Public listing text contains a private delivery value");
    const l = await Listing.create({
      market: "eldorado",
      section: "rocket-league",
      managedBy: "skin-account",
      region: s.profile.region,
      status: "draft",
      title: p.title,
      description: p.description,
      priceUsd: p.priceUsd,
      hasOriginalEmail: false,
      gameKey: "skin-account:rocket-league",
      games: ["Rocket League"],
      mainOfferImage: image,
      coverSource: String(body.coverUrl),
      createdBy: actor,
      accounts: [
        {
          epicAccountId: a._id,
          login: email,
          label: a.displayName,
          state: "listed",
        },
      ],
    });
    s = await patch(
      s,
      {
        listingId: l._id,
        listingMeta: {
          mainOfferImage: image,
          offerImages: [],
          section: sectionFor(s),
          coverSource: String(body.coverUrl),
        },
        mutation: { kind: "create", at: new Date() },
      },
      "publish-started",
      "Publishing one reserved whole-account product",
    );
    try {
      const session = await Session.create({
        epicAccountId: a._id,
        inboxAddress: email,
        passwordHash: await bcrypt.hash(mailPassword, 10),
        passwordEnc: encrypt(mailPassword),
        expiresAt: new Date(Date.now() + 365 * DAY),
        stage: "listed",
        listingId: l._id,
        marketplace: "eldorado",
        createdByUserId: actor,
        note: "Whole skin account: linked Twitch private delivery must be preserved",
      });
      l.accounts[0].sessionId = session._id;
      await l.save();
      const created = await eld.createAccountOffer({
        ...p,
        recoverByTitle: false,
        hasOriginalEmail: false,
        mainOfferImage: image,
        offerImages: [],
        entries: [e],
        section: sectionFor(s),
      });
      if (!created.id)
        fail(
          "Publish outcome uncertain; inspect seller offers before any retry",
        );
      l.externalId = created.id;
      l.url = eld.offerUrl(created.id, "rocket-league");
      l.status = "active";
      await l.save();
      s = await patch(s, { remoteOfferId: created.id, state: "listed" });
      const result = await sales._internals.readBack(l);
      await l.save();
      if (
        result.entries.length !== 1 ||
        !result.entries[0].id ||
        [
          "accountLogin",
          "accountPassword",
          "emailProviderUrl",
          "emailLogin",
          "emailPassword",
          "additionalInfo",
        ].some((k) => result.entries[0][k] !== e[k])
      )
        fail("Published private delivery could not be verified");
      if (JSON.stringify(result.offer.mainOfferImage) !== JSON.stringify(image))
        fail("Published inventory photo could not be verified");
      await remoteCheck(s);
      s = await patch(
        s,
        {
          mutation: {},
          "listingMeta.lastContentHash": content.contentHash(p),
          lastError: "",
        },
        "published",
        "Published and verified one account with linked Twitch delivery",
      );
      return publicRow(s);
    } catch (err) {
      if (l.externalId)
        await eld.pauseAccountOffer(l.externalId).catch(() => {});
      await patch(s, {
        state: "attention",
        "farm.allowed": false,
        lastError:
          "Publish did not finish verification; reservation retained. Inspect the seller offer before retrying.",
      });
      await farm.stopFarm(s, "Publish requires review");
      throw err;
    }
  });
}
async function recover(key, body) {
  return sales._internals.withLock(async () => {
    let s = await get(key);
    if (
      s.soldAt ||
      s.ownershipStatus === "sold" ||
      s.mutation?.kind !== "create" ||
      !s.listingId
    )
      fail("This row has no interrupted publish to recover");
    const offerId = String(body.offerId || "");
    if (
      body.confirm !== true ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        offerId,
      )
    )
      fail("Confirm the existing Eldorado offer ID", 400);
    const acc = await assertEpicOwnership(s.epicAccountId, s.listingId);
    await twitchPair(s.twitchLogin, { holdTag: s.holdTag });
    await require("./skinAccountLink").verify(s, acc);
    if (
      (await Listing.exists({
        _id: { $ne: s.listingId },
        externalId: offerId,
      })) ||
      (await Skin.exists({ _id: { $ne: s._id }, remoteOfferId: offerId }))
    )
      fail("That offer belongs to another listing");
    const l = await Listing.findById(s.listingId);
    const sess = l?.accounts?.[0]?.sessionId
      ? await Session.findById(l.accounts[0].sessionId).lean()
      : null;
    if (
      !sess ||
      sess.revokedAt ||
      sess.stage !== "listed" ||
      !dec(sess.passwordEnc)
    )
      fail("The original prepared mail delivery is unavailable");
    const [offer, entries, bot] = await Promise.all([
      eld.getAccountOffer(offerId),
      eld.getAccountEntries(offerId),
      Bot.findById(s.botAccountId).lean(),
    ]);
    const entry = entries[0],
      email = dec(acc.email).toLowerCase();
    const expected = sales.entryFor({
      email,
      epicPassword: dec(acc.password),
      mailPassword: dec(sess.passwordEnc),
      purl: sales.providerUrl(),
      days: 14,
    });
    expected.additionalInfo +=
      "\nLinked Twitch login: " +
      s.twitchLogin +
      "\nTwitch password: " +
      dec(bot.credPassword) +
      "\nOriginal mailboxes are not included. No future rewards or farming service included.";
    if (
      String(offer.gameId) !== "1" ||
      offer.category !== "Account" ||
      Number(offer.quantity) !== 1 ||
      entries.length !== 1 ||
      !entry?.id ||
      [
        "accountLogin",
        "accountPassword",
        "emailProviderUrl",
        "emailLogin",
        "emailPassword",
        "additionalInfo",
      ].some((k) => entry[k] !== expected[k]) ||
      offer.offerTitle !== l.title ||
      offer.description !== l.description
    )
      fail(
        "The existing offer does not exactly match this prepared product and private delivery",
      );
    // Pause only after proving this is our exact prepared unit.
    await eld.pauseAccountOffer(offerId);
    l.externalId = offerId;
    l.url = eld.offerUrl(offerId, "rocket-league");
    l.accounts[0].entryId = entry.id;
    l.status = "paused";
    await l.save();
    s = await patch(
      s,
      {
        remoteOfferId: offerId,
        state: "paused",
        ownershipStatus: "owned",
        mutation: {},
        "farm.allowed": false,
        lastError: "Recovered paused. Refresh and review before resuming.",
      },
      "publish-recovered",
      "Existing exact delivery verified and attached without creating stock",
    );
    const checked = await remoteCheck(s);
    if (checked.sold) return publicRow(await get(key));
    if (checked.active) fail("Recovered offer pause was not verified");
    return publicRow(await get(key));
  });
}

async function tick() {
  if (worker.running) return;
  worker.running = true;
  try {
    const rows = await Skin.find({
      $or: [
        { state: { $ne: "sold" } },
        { "farm.needsReload": true },
        { "farm.status": { $ne: "stopped" } },
      ],
    })
      .select("_id")
      .lean();
    worker.lastError = "";
    for (const row of rows) {
      try {
        await sales._internals.withLock(() => refreshUnlocked(row._id));
      } catch {
        worker.lastError =
          "A skin-account check could not finish and will be retried";
      }
    }
  } catch {
    worker.lastError =
      "Skin-account worker could not finish; reserved pairs will be rechecked";
  } finally {
    worker.running = false;
    worker.lastTickAt = new Date();
  }
}
function start() {
  if (timer) return;
  const loop = async () => {
    await tick();
    timer = setTimeout(loop, 60000);
    timer.unref?.();
  };
  timer = setTimeout(loop, 15000);
  timer.unref?.();
}
function stop() {
  if (timer) clearTimeout(timer);
  timer = null;
}
module.exports = {
  overview,
  candidates,
  enroll: (body, actor) => reservePair(body, actor),
  adopt: (body, actor) => reservePair(body, actor),
  verifyLink,
  confirmInventory,
  setPricing,
  setFarm,
  preview,
  publish,
  recover,
  pause,
  resume,
  refresh,
  markSkinSold,
  start,
  stop,
  tick,
  _internals: {
    remoteProof,
    sectionFor,
    refreshUnlocked,
    safeError,
    publicRow,
    scan,
    uploadCover,
  },
};
