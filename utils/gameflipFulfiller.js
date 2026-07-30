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
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const mp = require("./marketplaces");
const { decrypt } = require("./secretBox");
const { buildSetGridImage } = require("./setImage");
const { sendTelegram } = require("./telegram");
const {
  reserveSetOnAccount,
  releaseAccountsForTag,
} = require("./dropReservation");

const GF_CLAIM_TAG = "gameflip";

// Reserve this set's drops (per game) on an account that holds the whole
// bundle, so a Shop buyer and a Gameflip listing can never get the same drops
// while the account's other games stay sellable. Returns the account doc.
async function claimAccountForSet(set) {
  const candidates = await availableAccountsForSet(set);
  // Hand out an account whose Twitch token still scans before one flagged
  // token_invalid / integrity_failed. A dead token does not always mean the
  // buyer cannot log in — the password is separate, and the guardian's own
  // notes call these often-transient — but it is the best signal we have that
  // an account's credentials moved, and it is what the guardian raises a
  // "dead-token" finding on. When healthy stock exists there is no reason to
  // ship a flagged account: the live Overwatch bundle went out on a
  // token_invalid account while all 111 other candidates were clean.
  // Flagged accounts are still used as a last resort rather than failing the
  // sale, so this can only improve which account is picked, never lose stock.
  const ids = candidates.map((c) => c.accountId);
  const healthy = new Set();
  if (ids.length) {
    const rows = await BotAccount.find(
      { _id: { $in: ids }, lastScanStatus: { $in: ["", "ok", null] } },
      { _id: 1 },
    ).lean();
    for (const r of rows) healthy.add(String(r._id));
  }
  const ordered = candidates
    .filter((c) => healthy.has(String(c.accountId)))
    .concat(candidates.filter((c) => !healthy.has(String(c.accountId))));

  for (const c of ordered) {
    const ok = await reserveSetOnAccount(c.accountId, set, {
      soldToUsername: GF_CLAIM_TAG,
      soldSetId: String(set._id),
    });
    if (!ok) continue;
    const account = await BotAccount.findById(c.accountId);
    if (account) return account;
  }
  return null;
}

// Put a reserved set's drops back in the sellable pool (only ones still
// reserved for Gameflip — never touches drops sold through the Shop).
async function releaseAccount(accountId) {
  if (!accountId) return;
  await releaseAccountsForTag([accountId], GF_CLAIM_TAG);
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

// Title + description for the listing that carries one specific account.
//
// The advertised bundle is ALWAYS the set: same items, same order, same count
// as the cover-image grid and the other marketplaces' listings. The delivered
// account holds far more than that, and earlier versions leaked those extras
// into the text — first by counting them in the title ("(56 Items)" over a
// 5-item picture), then by enumerating them in a bonus block (87 lines under a
// 5-item heading). Both made the listing misdescribe the bundle, so the account
// now influences exactly one thing: per-item quantity, when it holds more
// copies than the set advertises. Falls back to the caller's static text if the
// account's drops can't be read.
async function accountListingText(set, accountId, fallbackTitle, fallbackDescription) {
  try {
    const { buildTitle, buildDescription } = require("./autoLister");
    const setItems = (set.items || []).filter((i) => i.itemKey);
    const primaryGame = (setItems.find((i) => i.game) || {}).game || "";
    const rows = await DropLog.aggregate([
      { $match: { account: accountId, connected: { $ne: true } } },
      {
        $group: {
          _id: { key: "$itemKey", name: "$name", game: "$game" },
          qty: { $sum: "$count" },
        },
      },
    ]);
    if (!rows.length) return { title: fallbackTitle, description: fallbackDescription };
    const byKey = new Map();
    for (const r of rows) {
      byKey.set(r._id.key, {
        itemKey: r._id.key,
        name: r._id.name,
        game: r._id.game,
        qty: r.qty,
      });
    }
    const items = setItems.map((si) => {
      const hit = byKey.get(si.itemKey);
      return {
        itemKey: si.itemKey,
        name: si.name,
        game: si.game,
        qty: Math.max(Number(si.qty) || 1, (hit && Number(hit.qty)) || 0),
      };
    });
    if (!items.length) return { title: fallbackTitle, description: fallbackDescription };
    return {
      title: buildTitle({ game: primaryGame, items }),
      description: buildDescription({ game: primaryGame, items }),
    };
  } catch {
    return { title: fallbackTitle, description: fallbackDescription };
  }
}

// Claim an account, publish one auto-delivery listing for it and record the
// listing row. `qtyRemaining` is how many more units should be relisted after
// this one sells. Releases the account again if publishing fails. Title and
// description are regenerated from the claimed account's real contents so the
// listing matches what the buyer actually gets.
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
  const { title: liveTitle, description: liveDesc } = await accountListingText(
    set,
    account._id,
    title,
    description,
  );
  let r;
  try {
    r = await mp.gameflipPublish({
      title: liveTitle,
      description: liveDesc,
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
    title: liveTitle,
    description: String(liveDesc || ""),
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
    // A marketplace sale is the one event an operator always wants pushed to
    // their phone — the poller is the only thing that knows it happened.
    sendTelegram(
      "💰 SOLD on Gameflip\n\n" +
        (row.title || "(untitled listing)") +
        "\n$" +
        (Number(row.price) || 0).toFixed(2) +
        "\nAccount: " +
        (row.accountLogin || "?") +
        "\n" +
        ((Number(row.qtyRemaining) || 0) > 0
          ? "Relisting the next unit (" + row.qtyRemaining + " left)."
          : "Last unit — nothing left to relist.") +
        (row.url ? "\n\n" + row.url : ""),
    ).catch((e) => console.error("gameflip sale notify error:", e.message));
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
  accountListingText,
  publishAutoDelivery,
  syncOnce,
  start,
};
