// Gameflip auto-delivery + auto-relist.
//
// A published Gameflip listing carries ONE farmed account as an auto-delivered
// digital code (login + password + connect guide) — Gameflip hands it to the
// buyer the moment they pay, no manual fulfilment. Gameflip listings have no
// quantity, so "sell 10 of these" is implemented as a relist chain: when the
// background watcher sees the live listing sold, it claims the next unsold
// account from the bundle's pool and publishes an identical listing, until the
// requested count is sold or the pool runs dry.
const fsp = require("fs/promises");

const BotAccount = require("../models/BotAccount");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const mp = require("./marketplaces");
const { decrypt } = require("./secretBox");
const { buildSetGridImage } = require("./setImage");

const GF_CLAIM_TAG = "gameflip";

// Atomically reserve an unsold account that holds the whole bundle (same
// claim pattern as the internal Shop, so a Shop buyer and a Gameflip listing
// can never get the same account).
async function claimAccountForSet(set) {
  const candidates = await availableAccountsForSet(set);
  for (const c of candidates) {
    const claimed = await BotAccount.findOneAndUpdate(
      { _id: c.accountId, soldAt: null },
      {
        $set: {
          soldAt: new Date(),
          soldToAdminId: "",
          soldToUsername: GF_CLAIM_TAG,
          soldSetId: String(set._id),
        },
      },
      { new: true },
    );
    if (claimed) return claimed;
  }
  return null;
}

// Put a reserved account back in the sellable pool (only if it is still just
// reserved for Gameflip — never touches accounts sold through the Shop).
async function releaseAccount(accountId) {
  if (!accountId) return;
  await BotAccount.updateOne(
    { _id: accountId, soldToUsername: GF_CLAIM_TAG },
    {
      $set: {
        soldAt: null,
        soldToAdminId: "",
        soldToUsername: "",
        soldSetId: "",
      },
    },
  ).catch(() => {});
}

function gameflipDeliveryCode(login, password) {
  return (
    "TWITCH DROP ACCOUNT\n\n" +
    "Login: " +
    login +
    "\nPassword: " +
    password +
    "\n\n" +
    "1. Log in to the received Twitch account, then go to " +
    "https://www.twitch.tv/drops/inventory and scroll to the bottom of the " +
    'page, to the "Received" section.\n\n' +
    '2. Click on the purple "Connect" button, which is located below the ' +
    "item you want to add to your account.\n\n" +
    "3. Connect the account by following the instructions shown on the site " +
    "where the connection is made.\n\n" +
    "If you have any issue please message me here on Gameflip."
  );
}

// Claim an account, publish one auto-delivery listing for it and record the
// listing row. `qtyRemaining` is how many more units should be relisted after
// this one sells. Releases the account again if publishing fails.
async function publishAutoDelivery({
  set,
  title,
  description,
  priceUsd,
  imagePath,
  qtyRemaining,
}) {
  const account = await claimAccountForSet(set);
  if (!account) {
    throw new Error(
      "Out of stock — no unsold account holds this whole bundle, " +
        "so there is nothing to auto-deliver",
    );
  }
  const login = account.login || account.credUsername || "";
  const password = decrypt(account.credPassword);
  if (!password) {
    await releaseAccount(account._id);
    throw new Error(
      "Account " + login + " has no readable password — cannot auto-deliver",
    );
  }
  let r;
  try {
    r = await mp.gameflipPublish({
      title,
      description,
      priceUsd,
      imagePath,
      autoDeliverCode: gameflipDeliveryCode(login, password),
    });
  } catch (e) {
    await releaseAccount(account._id);
    throw e;
  }
  return MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: r.externalId,
    url: r.url || "",
    title,
    description: String(description || ""),
    price: priceUsd,
    status: "active",
    note: "auto-delivery: " + (login || "account"),
    autoDeliver: true,
    accountId: String(account._id),
    accountLogin: login,
    qtyRemaining: Math.max(0, Number(qtyRemaining) || 0),
  });
}

// One watcher pass: mark sold listings sold and relist the next unit of any
// chain that still has quantity left.
async function syncOnce() {
  const rows = await MarketplaceListing.find({
    marketplace: "gameflip",
    status: "active",
    autoDeliver: true,
  })
    .limit(100)
    .lean();
  let sold = 0;
  let relisted = 0;
  for (const row of rows) {
    let status;
    try {
      status = await mp.gameflipListingStatus(row.externalId);
    } catch {
      continue;
    }
    if (status !== "sold") continue;
    // Conditional update so two overlapping passes can't both relist.
    const claimed = await MarketplaceListing.findOneAndUpdate(
      { _id: row._id, status: "active" },
      { $set: { status: "sold" } },
    );
    if (!claimed) continue;
    sold++;
    if ((Number(row.qtyRemaining) || 0) <= 0) continue;
    let img = "";
    try {
      const set = await DropSet.findById(row.set).lean();
      if (!set) throw new Error("the drop set no longer exists");
      try {
        img = await buildSetGridImage(set);
      } catch {
        img = "";
      }
      await publishAutoDelivery({
        set,
        title: row.title,
        description: row.description,
        priceUsd: row.price,
        imagePath: img,
        qtyRemaining: row.qtyRemaining - 1,
      });
      relisted++;
    } catch (e) {
      await MarketplaceListing.updateOne(
        { _id: row._id },
        {
          $set: {
            lastError: ("auto-relist failed: " + e.message).slice(0, 400),
          },
        },
      ).catch(() => {});
      console.error("gameflip auto-relist failed:", e.message);
    } finally {
      if (img) await fsp.unlink(img).catch(() => {});
    }
  }
  return { checked: rows.length, sold, relisted };
}

// Background watcher so sales are picked up (and the next unit relisted)
// without anyone opening the admin page. No-op when Gameflip keys are unset
// or nothing is listed — syncOnce just finds zero rows / fails quietly.
const TICK_MS = 60 * 1000;
let started = false;

function start() {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      await syncOnce();
    } catch (e) {
      console.error("gameflip fulfiller error:", e.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, TICK_MS);
  if (t.unref) t.unref();
}

module.exports = {
  claimAccountForSet,
  releaseAccount,
  gameflipDeliveryCode,
  publishAutoDelivery,
  syncOnce,
  start,
};
