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
const { gameflipDeliveryCode } = require("./gameflipFulfiller");
const { digisellerDeliveryCode } = require("./digisellerFulfiller");
const { ggselDeliveryCode } = require("./ggselFulfiller");
const settings = require("./settings");
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
            // Real Twitch item artwork — setImage downloads it for the cover
            // grid, exactly like the manually created listings.
            image: String(b.imageAssetURL || ""),
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
function buildDescription({ game, items, campaignName, postEvent }) {
  const lines = [];
  if (postEvent) {
    lines.push(
      "THE " +
        (campaignName || game) +
        " DROP EVENT IS OVER — these items can no longer be earned by " +
        "watching streams. Accounts farmed during the event are the only " +
        "remaining supply, and the drops still redeem instantly when you " +
        "connect the account.",
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
// Up to `max` deliverable accounts from the task, skipping any login already
// attached to an active listing on ANY marketplace (accountLogin can be a
// comma-separated list on Plati/GGSel rows) — one account is only ever sold
// on one market.
async function pickDeliveryAccounts(task, max) {
  const used = new Set();
  for (const r of await MarketplaceListing.find(
    { status: "active" },
    { accountLogin: 1 },
  ).lean()) {
    for (const l of String(r.accountLogin || "").split(/[,\s]+/)) {
      if (l) used.add(l.toLowerCase());
    }
  }
  const out = [];
  for (const username of task.assignedAccounts || []) {
    if (out.length >= max) break;
    if (used.has(String(username).toLowerCase())) continue;
    const acc = await AvailableAccount.findOne({
      usernameLower: String(username).toLowerCase(),
    }).lean();
    if (!acc) continue;
    const password = decrypt(acc.password);
    if (!password) continue;
    out.push({ login: username, password });
  }
  return out;
}

// Main entry: called by the auto-farmer right after a task's bots start (and
// re-tried on later ticks while no listing exists). Dry-run stores a preview.
async function listActivatedTask(taskId, { dryRun = false } = {}) {
  const task = await AutoFarmTask.findById(taskId);
  if (!task) return { skipped: "task gone" };
  if (task.listing && task.listing.externalId) {
    // Verify the listing still exists on Gameflip — if the seller deleted it
    // manually, forget it and fall through to create a fresh one.
    try {
      const status = await mp.gameflipListingStatus(task.listing.externalId);
      if (status && status !== "expired") {
        return { skipped: "already listed" };
      }
    } catch (e) {
      const msg = String(e.message || "");
      // Anything other than "not found" (auth trouble, timeouts) keeps the
      // record — we only relist when Gameflip confirms the listing is gone.
      if (!/404|not.?found/i.test(msg)) {
        return { skipped: "already listed (status check failed: " + msg + ")" };
      }
    }
    // Also retire the stale DB listing row so the fulfiller stops watching it.
    try {
      await MarketplaceListing.updateOne(
        {
          set: task.listing.setId,
          marketplace: "gameflip",
          externalId: task.listing.externalId,
        },
        { $set: { status: "removed" } },
      );
    } catch {
      /* best-effort */
    }
    task.listing = undefined;
    task.wouldList = undefined;
    await task.save();
  }
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
    postEvent: false,
  });

  if (dryRun) {
    task.wouldList = { title, price, qty: split.listNow };
    await task.save();
    return { wouldList: { title, price, qty: split.listNow } };
  }

  const accounts = await pickDeliveryAccounts(task, split.listNow);
  if (!accounts.length) {
    task.listing = task.listing || {};
    task.listing.error = "no delivery account with a readable password";
    await task.save();
    throw new Error(
      "Auto-list " + task.game + ": no assigned account has a usable password",
    );
  }

  // Split the sellable accounts across the markets round-robin — Gameflip
  // first (it always gets at least one), then Plati, then GGSel. One account
  // is only ever attached to one market, so a sale on one platform can never
  // hand out an account a buyer on another platform already received.
  const af = settings.getAutoFarm();
  const platiEnabled = !!af.platiCategoryId;
  // Per-game category: own-history match first, then catalog search for the
  // game's "Twitch Drops" section, then its Accounts section. The settings
  // value is only a manual override / last resort.
  let ggselCategoryId = "";
  try {
    ggselCategoryId = await mp.ggselResolveCategoryId(task.game);
  } catch {
    ggselCategoryId = "";
  }
  if (!ggselCategoryId) ggselCategoryId = String(af.ggselCategoryId || "");
  const marketOrder = ["gameflip"];
  if (platiEnabled) marketOrder.push("plati");
  if (ggselCategoryId) marketOrder.push("ggsel");
  const shares = { gameflip: [], plati: [], ggsel: [] };
  accounts.forEach((acc, i) => {
    shares[marketOrder[i % marketOrder.length]].push(acc);
  });

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

  const gfAccounts = shares.gameflip;
  let published;
  const plati = { externalId: "", url: "", qty: 0, error: "" };
  const ggsel = { externalId: "", url: "", qty: 0, error: "" };
  try {
    published = await mp.gameflipPublish({
      title,
      description,
      priceUsd: price,
      imagePath: img,
      autoDeliverCode: gameflipDeliveryCode(
        gfAccounts[0].login,
        gfAccounts[0].password,
      ),
    });

    // ---- Plati (Digiseller): same flow as the manual Shop route — create
    // the product in the configured cataloguer category, attach one delivery
    // code per account, upload the cover. A Plati failure never rolls back
    // the Gameflip listing; it is recorded and retried by hand if needed.
    if (platiEnabled && shares.plati.length) {
      try {
        const r = await mp.digisellerPublish({
          title,
          description,
          priceUsd: price,
          categories: [{ owner: 1, categoryId: af.platiCategoryId }],
        });
        try {
          await mp.digisellerAddContent(
            r.externalId,
            shares.plati.map((a) =>
              digisellerDeliveryCode(a.login, a.password),
            ),
          );
        } catch (err) {
          await mp.digisellerDelist(r.externalId).catch(() => {});
          throw err;
        }
        if (img) {
          await mp.digisellerUploadImage(r.externalId, img).catch(() => {});
        }
        await MarketplaceListing.create({
          set: set._id,
          marketplace: "digiseller",
          externalId: r.externalId,
          url: r.url || "",
          title,
          description,
          price,
          status: "active",
          note: "auto-farm: " + shares.plati.length + " account(s)",
          autoDeliver: true,
          accountLogin: shares.plati.map((a) => a.login).join(", "),
          qtyTarget: shares.plati.length,
        });
        plati.externalId = r.externalId;
        plati.url = r.url || "";
        plati.qty = shares.plati.length;
      } catch (err) {
        plati.error = err.message;
      }
    } else if (!platiEnabled) {
      plati.error = "no Plati category id in auto-farm settings";
    } else {
      plati.error = "no spare account for this market yet";
    }

    // ---- GGSel: publish with autoselling + one product line per account,
    // in the configured category (or the one copied from the newest live
    // offer). Same isolation: failures are recorded, not fatal.
    if (ggselCategoryId && shares.ggsel.length) {
      try {
        const r = await mp.ggselPublish({
          title,
          description,
          priceUsd: price,
          categoryId: ggselCategoryId,
          delivery: "auto",
          coverImagePath: img,
          products: shares.ggsel.map((a) =>
            ggselDeliveryCode(a.login, a.password),
          ),
        });
        await MarketplaceListing.create({
          set: set._id,
          marketplace: "ggsel",
          externalId: r.externalId,
          url: r.url || "",
          title,
          description,
          price,
          status: "active",
          note:
            (r.note ? r.note + " " : "") +
            "auto-farm: " +
            shares.ggsel.length +
            " account(s)",
          autoDeliver: true,
          accountLogin: shares.ggsel.map((a) => a.login).join(", "),
          qtyTarget: shares.ggsel.length,
        });
        ggsel.externalId = r.externalId;
        ggsel.url = r.url || "";
        ggsel.qty = shares.ggsel.length;
      } catch (err) {
        ggsel.error = err.message;
      }
    } else if (!ggselCategoryId) {
      ggsel.error =
        "no GGSel category found for " +
        task.game +
        " (set an override in auto-farm settings)";
    } else {
      ggsel.error = "no spare account for this market yet";
    }
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
    accountLogin: gfAccounts.map((a) => a.login).join(", "),
    // First unit is the pool account itself; the rest of Gameflip's SHARE
    // relists through the farmed-archive chain. Accounts given to Plati and
    // GGSel are excluded — they sell on those platforms. Held-back units
    // join qtyRemaining after the event ends, at the post-event price.
    qtyRemaining: Math.max(0, gfAccounts.length - 1),
  });

  task.listing = {
    setId: String(set._id),
    externalId: published.externalId,
    url: published.url || "",
    title,
    price,
    qty: gfAccounts.length,
    heldBack: split.holdBack,
    plati,
    ggsel,
    listedAt: new Date(),
    repricedAt: null,
    postEvent: false,
    error: "",
  };
  await task.save();
  return { listed: task.listing };
}

/* --------------------------- campaign end flow --------------------------- */

// Once the drop event ends the items can no longer be earned — supply is fixed.
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
