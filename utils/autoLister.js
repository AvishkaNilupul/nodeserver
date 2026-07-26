// Auto-listing: the moment auto-farm bots start on a campaign, publish a
// Gameflip auto-delivery listing for the bundle — mirroring the owner's manual
// "create the listing while it's still farming" early-bird flow. Buyers who
// purchase early receive an account that finishes farming within hours (the
// exact trade-off the owner already makes by hand).
//
// Title/description follow the seller's house style (verified against their
// live Gameflip profile), price comes from market research, and the existing
// gameflipFulfiller relist chain takes over after the first sale.
const AutoFarmTask = require("../models/AutoFarmTask");
const AvailableAccount = require("../models/AvailableAccount");
const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const MarketResearch = require("../models/MarketResearch");
const TwitchCampaign = require("../models/TwitchCampaign");
const { gameflipDeliveryCode } = require("./gameflipFulfiller");
const mp = require("./marketplaces");
const { decrypt } = require("./secretBox");
const { buildSetGridImage } = require("./setImage");

const fsp = require("fs/promises");

/* --------------------------- campaign details --------------------------- */

// Borrow a healthy bot-account token (same trick campaignWatcher uses) to ask
// Twitch what items this campaign actually gives, before anything is farmed.
async function campaignItems(campaignId, game) {
  const { fetchCampaignDetails } = require("./twitchInventory");
  const candidates = await BotAccount.find({
    clientSecret: { $exists: true, $ne: "" },
  })
    .sort({ lastScanAt: -1 })
    .limit(5)
    .lean();
  const ordered = [
    ...candidates.filter((a) => a.lastScanStatus === "ok"),
    ...candidates.filter((a) => a.lastScanStatus !== "ok"),
  ];
  let lastErr = null;
  for (const acc of ordered) {
    try {
      const camp = await fetchCampaignDetails(acc.clientSecret, campaignId);
      const items = [];
      const seen = new Set();
      for (const d of camp.timeBasedDrops || []) {
        for (const e of d.benefitEdges || []) {
          const b = e && e.benefit;
          if (!b || !b.name) continue;
          const g = (b.game && b.game.name) || game || "";
          const key =
            String(b.name).trim().toLowerCase() +
            "|" +
            String(g).trim().toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          items.push({
            itemKey: key,
            name: String(b.name),
            game: g,
            image: "",
            qty: 1,
            requiredMinutes: Number(d.requiredMinutesWatched) || 0,
          });
        }
      }
      if (items.length) return items;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) throw lastErr;
  throw new Error("No bot tokens available for campaign details");
}

/* ------------------------- title / description -------------------------- */

// House title style (matches the seller's live listings):
//   "{Game} Twitch Drops ({N} Items) — {Item A} + {Item B} +{N-2} more"
// with graceful truncation to Gameflip's 120-char limit. Post-event listings
// lead with the scarcity hook instead.
function buildTitle({ game, items, campaignName, postEvent }) {
  const n = items.length;
  const names = items.map((i) => i.name);
  const prefix = postEvent
    ? "[EVENT ENDED] " + game + " Twitch Drops"
    : game + " Twitch Drops";
  const countBit = " (" + n + " Item" + (n === 1 ? "" : "s") + ")";
  let tail = "";
  if (names.length) {
    const first = names.slice(0, 2).join(" + ");
    const more = n > 2 ? " +" + (n - 2) + " more" : "";
    tail = " — " + first + more;
  } else if (campaignName) {
    tail = " — " + campaignName;
  }
  let title = prefix + countBit + tail;
  if (title.length > 120) {
    const one = names[0] ? " — " + names[0] + " +" + (n - 1) + " more" : "";
    title = prefix + countBit + one;
  }
  if (title.length > 120) title = (prefix + countBit).slice(0, 120);
  return title;
}

// House description: item list first, then the seller's standard sections
// (check before buying / multi-purchase warning / activation window / pitch).
function buildDescription({ game, items, campaignName, endAt, postEvent }) {
  const lines = [];
  if (postEvent) {
    lines.push(
      "THE " +
        (campaignName || game) +
        " DROP EVENT IS OVER — these items can no longer be obtained by " +
        "watching streams. Limited stock from accounts farmed during the event.",
      "",
    );
  } else if (campaignName) {
    lines.push(game + " — " + campaignName + " Twitch Drops.", "");
  }
  lines.push("Includes:");
  for (const i of items) {
    lines.push(
      "- " +
        ((i.qty || 1) > 1 ? i.qty + "\u00d7 " : "") +
        i.name +
        (i.game ? " (" + i.game + ")" : ""),
    );
  }
  lines.push(
    "",
    "You receive a Twitch account with ALL of the above drops sitting " +
      "unclaimed in its inventory. Log in, press Connect, and claim " +
      "everything to YOUR OWN game account.",
    "",
    "\ud83d\udc8e Please check the item list carefully before buying.",
    "",
    "\ud83d\udca1 Buying more than one? Each purchase delivers a different " +
      "account — every bundle can be claimed once per game account.",
    "",
    "\u269c\ufe0f Please redeem the drops within the first hour after " +
      "delivery. The account is guaranteed at the moment of delivery.",
    "",
    "\ud83d\ude80 Seller's comment: instant auto-delivery, farmed by me, " +
      "clean accounts. Check my profile for more Twitch drop bundles.",
    "",
    "\ud83d\udcac Any issue or question — message me here on Gameflip " +
      "before opening a dispute. I reply fast and always make it right.",
  );
  if (!postEvent && endAt) {
    lines.push(
      "",
      "\u23f3 Event ends " +
        new Date(endAt).toISOString().slice(0, 10) +
        " — after that these drops become unobtainable.",
    );
  }
  return lines.join("\n").slice(0, 5000);
}

/* ------------------------------ hold-back split -------------------------- */

// "Farm 6, list 3 now, save the rest": half the farmed accounts (rounded up)
// go on sale immediately at the early-bird price; the remainder is held back
// and only released into the listing AFTER the event ends, at the +50%
// post-event price — when supply is frozen and each account is worth more.
function computeSplit(qty) {
  const n = Math.max(0, Number(qty) || 0);
  if (n <= 1) return { listNow: n, holdBack: 0 };
  const listNow = Math.ceil(n / 2);
  return { listNow, holdBack: n - listNow };
}

/* --------------------------------- price -------------------------------- */

function round25(x) {
  return Math.round(x * 4) / 4;
}

// Price from market research: what buyers actually PAID on Gameflip beats
// asking prices; competitor floors (GGSel/Plati/Gameflip active) refine it.
// postEventMultiplier applies the scarcity markup once farming is impossible.
function derivePrice(research, { postEventMultiplier = 1 } = {}) {
  const m = (research && research.markets) || {};
  const gf = m.gameflip || {};
  const candidates = [];
  if (Number(gf.avgSoldPrice) > 0) candidates.push(Number(gf.avgSoldPrice));
  if (Number(gf.lowest) > 0) candidates.push(Number(gf.lowest));
  if (m.ggsel && Number(m.ggsel.lowest) > 0)
    candidates.push(Number(m.ggsel.lowest));
  if (m.plati && Number(m.plati.lowest) > 0)
    candidates.push(Number(m.plati.lowest));
  let base;
  if (Number(gf.avgSoldPrice) > 0) {
    // Anchor on real sold prices, but never above the cheapest live competitor
    // (undercut slightly to be the one that sells).
    const floor = Math.min(
      ...candidates.filter((x) => x > 0).concat([Number(gf.avgSoldPrice)]),
    );
    base = Math.min(Number(gf.avgSoldPrice), floor * 0.95);
  } else if (candidates.length) {
    base = Math.min(...candidates) * 0.95;
  } else {
    base = 1.0; // unknown market — probe price
  }
  const priced = round25(base * postEventMultiplier);
  return Math.max(0.75, priced);
}

/* ------------------------------- publishing ------------------------------ */

// Pick a delivery account from the task's assigned pool accounts: needs a
// decryptable password (buyer logs in with it). Skips ones already used by
// another listing.
async function pickDeliveryAccount(task) {
  const used = new Set(
    (
      await MarketplaceListing.find(
        { marketplace: "gameflip", status: "active" },
        { accountLogin: 1 },
      ).lean()
    ).map((r) => (r.accountLogin || "").toLowerCase()),
  );
  for (const username of task.assignedAccounts || []) {
    if (used.has(String(username).toLowerCase())) continue;
    const acc = await AvailableAccount.findOne({
      usernameLower: String(username).toLowerCase(),
    }).lean();
    if (!acc) continue;
    const password = decrypt(acc.password);
    if (!password) continue;
    return { login: username, password };
  }
  return null;
}

// Main entry: called by the auto-farmer right after a task's bots start (and
// re-tried on later ticks while no listing exists). Dry-run stores a preview.
async function listActivatedTask(taskId, { dryRun = false } = {}) {
  const task = await AutoFarmTask.findById(taskId);
  if (!task) return { skipped: "task gone" };
  if (task.listing && task.listing.externalId) {
    return { skipped: "already listed" };
  }
  const campaign = await TwitchCampaign.findOne({
    campaignId: task.campaignId,
  }).lean();

  const items = await campaignItems(task.campaignId, task.game);
  const research = await MarketResearch.findOne({ game: task.game }).lean();
  const price = derivePrice(research);
  const qty = Math.max(1, (task.assignedAccounts || []).length);
  const split = computeSplit(qty);
  const title = buildTitle({
    game: task.game,
    items,
    campaignName: task.campaignName,
    postEvent: false,
  });
  const description = buildDescription({
    game: task.game,
    items,
    campaignName: task.campaignName,
    endAt: campaign ? campaign.endAt : task.campaignEndAt,
    postEvent: false,
  });

  if (dryRun) {
    task.wouldList = { title, price, qty: split.listNow };
    await task.save();
    return { wouldList: { title, price, qty: split.listNow } };
  }

  const account = await pickDeliveryAccount(task);
  if (!account) {
    task.listing = task.listing || {};
    task.listing.error = "no delivery account with a readable password";
    await task.save();
    throw new Error(
      "Auto-list " + task.game + ": no assigned account has a usable password",
    );
  }

  // The DropSet makes the listing part of the normal machinery: the relist
  // chain, the Shop and the drop archive all understand sets.
  const set = await DropSet.create({
    name: task.game + " — " + (task.campaignName || task.campaignId),
    note: "Auto-farmed Twitch drops (" + (task.campaignName || task.game) + ")",
    items: items.map(({ itemKey, name, game, image, qty: q }) => ({
      itemKey,
      name,
      game,
      image,
      qty: q,
    })),
    price,
    listed: false,
    custom: true,
    coverGame: task.game,
  });

  let img = "";
  try {
    img = await buildSetGridImage(set);
  } catch {
    img = "";
  }
  let published;
  try {
    published = await mp.gameflipPublish({
      title,
      description,
      priceUsd: price,
      imagePath: img,
      autoDeliverCode: gameflipDeliveryCode(account.login, account.password),
    });
  } finally {
    if (img) await fsp.unlink(img).catch(() => {});
  }

  await MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: published.externalId,
    url: published.url || "",
    title,
    description,
    price,
    status: "active",
    autoDeliver: true,
    accountLogin: account.login,
    // First unit is the pool account itself; the remaining list-now units
    // relist through the farmed-archive chain. Held-back units are NOT
    // counted here — they join qtyRemaining after the event ends, at the
    // post-event price.
    qtyRemaining: Math.max(0, split.listNow - 1),
  });

  task.listing = {
    setId: String(set._id),
    externalId: published.externalId,
    url: published.url || "",
    title,
    price,
    qty: split.listNow,
    heldBack: split.holdBack,
    listedAt: new Date(),
    repricedAt: null,
    postEvent: false,
    error: "",
  };
  await task.save();
  return { listed: task.listing };
}

/* --------------------------- campaign end flow --------------------------- */

// Once the drop event ends the items become unobtainable — supply is fixed.
// Two things happen to this task's listing:
//   1. +50% scarcity markup (the user-approved post-event repricing), with the
//      title/description rewritten to lead with "EVENT ENDED".
//   2. STACKING: auto-bots are reused across a game's campaigns, so the same
//      accounts hold drops from EVERY campaign farmed so far. The listing's
//      set is rebuilt as the union of all completed auto-farm sets for the
//      game, so the bundle (and its value) grows with each ended event.
const POST_EVENT_MARKUP = 1.5;

function stackItems(sets) {
  const out = [];
  const seen = new Set();
  for (const set of sets) {
    for (const i of set.items || []) {
      if (!i || !i.itemKey || seen.has(i.itemKey)) continue;
      seen.add(i.itemKey);
      out.push({
        itemKey: i.itemKey,
        name: i.name,
        game: i.game,
        image: i.image || "",
        qty: i.qty || 1,
      });
    }
  }
  return out;
}

function stackedPrice(prices, { markup = POST_EVENT_MARKUP } = {}) {
  const valid = prices.filter((x) => Number(x) > 0);
  const sum = valid.reduce((a, b) => a + b, 0);
  const base = sum > 0 ? sum : 1.0;
  return Math.max(0.75, round25(base * markup));
}

async function onCampaignEnded(taskId) {
  const task = await AutoFarmTask.findById(taskId);
  if (!task || !task.listing || !task.listing.externalId) {
    return { skipped: "no listing" };
  }
  if (task.listing.postEvent) return { skipped: "already repriced" };

  // Union of every completed auto-farm set for this game (incl. this one).
  const siblings = await AutoFarmTask.find({
    game: task.game,
    "listing.setId": { $ne: "" },
  }).lean();
  const setIds = [
    ...new Set(
      siblings.map((t) => t.listing && t.listing.setId).filter(Boolean),
    ),
  ];
  const sets = await DropSet.find({ _id: { $in: setIds } });
  const mySet = sets.find((x) => String(x._id) === task.listing.setId);
  if (!mySet) return { skipped: "set gone" };

  const items = stackItems(sets);
  const price = stackedPrice(
    siblings.map((t) => (t.listing && t.listing.price) || 0),
  );
  const title = buildTitle({
    game: task.game,
    items,
    campaignName: task.campaignName,
    postEvent: true,
  });
  const description = buildDescription({
    game: task.game,
    items,
    campaignName: task.campaignName,
    endAt: null,
    postEvent: true,
  });

  // Grow this task's set into the stacked bundle so delivery checks demand
  // accounts holding EVERYTHING in it.
  mySet.items = items;
  mySet.price = price;
  await mySet.save();

  const row = await MarketplaceListing.findOne({
    set: mySet._id,
    marketplace: "gameflip",
    status: "active",
  });
  const heldBack = Math.max(0, Number(task.listing.heldBack) || 0);
  if (row) {
    await mp.gameflipReprice(row.externalId, {
      priceUsd: price,
      title,
      description,
    });
    row.title = title;
    row.description = description;
    row.price = price;
    // Release the held-back accounts into the chain: they sell at the new
    // marked-up price — the whole point of saving them for after the event.
    row.qtyRemaining = (Number(row.qtyRemaining) || 0) + heldBack;
    await row.save();
  }

  task.listing.title = title;
  task.listing.price = price;
  task.listing.repricedAt = new Date();
  task.listing.postEvent = true;
  if (row && heldBack > 0) {
    task.listing.qty = (Number(task.listing.qty) || 0) + heldBack;
    task.listing.heldBack = 0;
  }
  await task.save();
  return {
    repriced: {
      title,
      price,
      items: items.length,
      live: !!row,
      released: row ? heldBack : 0,
    },
  };
}

module.exports = {
  listActivatedTask,
  onCampaignEnded,
  // exported for tests
  buildTitle,
  buildDescription,
  derivePrice,
  stackItems,
  stackedPrice,
  computeSplit,
};
