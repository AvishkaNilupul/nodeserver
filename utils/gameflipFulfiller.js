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
const { loginsOnActiveListings, notListed } = require("./listedLogins");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const mp = require("./marketplaces");
const { decrypt } = require("./secretBox");
const { buildSetGridImage } = require("./setImage");
const { recordListingSale } = require("./saleLearning");
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
  let candidates = await availableAccountsForSet(set);
  // Skip accounts already attached to another active listing (as its
  // auto-delivery account or a fed Plati/GGSel unit): the buyer gets the whole
  // account, so its other listing's promised drops would ship with it. One
  // implementation for every claimer (utils/listedLogins.js).
  candidates = notListed(candidates, await loginsOnActiveListings());
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
async function accountListingText(
  set,
  accountId,
  fallbackTitle,
  fallbackDescription,
) {
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
    if (!rows.length)
      return { title: fallbackTitle, description: fallbackDescription };
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
    if (!items.length)
      return { title: fallbackTitle, description: fallbackDescription };
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
// `origin` is carried through so a relisted unit stays whatever its
// predecessor was: the successor of an auto-farmed listing is still auto stock
// (and so still in scope for the post-event markup), while a chain the owner
// started by hand stays manual. Defaults to "manual" — the same fail-safe the
// model uses, since an unmarked chain must not become repriceable by accident.
async function publishAutoDelivery({
  set,
  title,
  description,
  priceUsd,
  imagePath,
  qtyRemaining,
  origin,
}) {
  // A set can carry a price floor the owner set by hand. Relists inherit the
  // price of the row that sold, and the auto-lister derives its own from live
  // competition, so without this a floored bundle drifts back down to the
  // market price on the next unit.
  const floor = Number(set && set.minPriceUsd) || 0;
  if (floor > 0 && (Number(priceUsd) || 0) < floor) priceUsd = floor;
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
    origin: origin === "auto" ? "auto" : "manual",
    note: "auto-delivery: " + (login || "account"),
    autoDeliver: true,
    accountId: String(account._id),
    accountLogin: login,
    qtyRemaining: Math.max(0, Number(qtyRemaining) || 0),
  });
}

// How long to wait before trying a failed relist again: 5 minutes doubling per
// consecutive failure, capped at 12 hours. A transient 429 or timeout is back on
// the market within minutes, while a chain nothing can fulfil settles into two
// attempts a day instead of one a minute. Pure — exported for tests.
const RELIST_RETRY_BASE_MS = 5 * 60 * 1000;
const RELIST_RETRY_MAX_MS = 12 * 60 * 60 * 1000;
function relistRetryDelayMs(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(RELIST_RETRY_MAX_MS, RELIST_RETRY_BASE_MS * 2 ** (n - 1));
}

// A relist failure that means "there is no stock left to sell" is not going to
// fix itself: the units the chain still owes are unsellable until the farmer
// produces another account holding the whole bundle. The operator has to know,
// because the alternative is silence while the debt sits there.
function isOutOfStockError(message) {
  return /out of stock/i.test(String(message || ""));
}

// The attempt at which an out-of-stock chain is escalated to the owner. Late
// enough that a sale racing the watcher (the account claimed a second earlier)
// resolves itself first, early enough to be same-hour news.
const RELIST_ALERT_AT_ATTEMPT = 3;

// Record a failed relist: keep the reason, count the attempt and push the next
// one out by the backoff. Called from both relist paths so a chain can never be
// left with a stale deadline.
async function noteRelistFailure(row, err) {
  const attempts = (Number(row.relistAttempts) || 0) + 1;
  const message = (err && err.message) || String(err);
  await MarketplaceListing.updateOne(
    { _id: row._id },
    {
      $set: {
        lastError: ("auto-relist failed: " + message).slice(0, 400),
        relistAttempts: attempts,
        relistRetryAt: new Date(Date.now() + relistRetryDelayMs(attempts)),
      },
    },
  ).catch(() => {});
  console.error(
    "gameflip relist failed (attempt " +
      attempts +
      ", next in " +
      Math.round(relistRetryDelayMs(attempts) / 60000) +
      "m):",
    message,
  );
  if (attempts === RELIST_ALERT_AT_ATTEMPT && isOutOfStockError(message)) {
    await sendTelegram(
      "⚠️ Gameflip chain out of stock\n\n" +
        (row.title || "(untitled listing)") +
        "\n" +
        (Number(row.qtyRemaining) || 0) +
        " unit(s) still owed, but no unsold account holds the whole bundle — " +
        "the chain is paused until the farmer produces one." +
        (row.url ? "\n\n" + row.url : ""),
    ).catch(() => {});
  }
}

// How many rows one pass may poll individually when the bulk status sweep is
// unavailable. Only ever applies to that fallback: the normal path reads the
// whole fleet in two calls and must never be capped.
const FALLBACK_POLL_LIMIT = 100;

// One watcher pass: mark sold listings sold and relist the next unit of any
// chain that still has quantity left.
async function syncOnce() {
  // EVERY active auto-delivery row, uncapped: the two bulk status queries below
  // answer for the whole fleet in two API calls, so one more row costs nothing
  // unless Gameflip reports it in neither sweep.
  //
  // This used to be `.limit(100)` with no sort, which silently became a
  // correctness bug the moment the fleet outgrew it: natural order meant the
  // SAME tail fell off the end of every single tick, so those listings were
  // never polled at all. Their sales were never seen, so `status` stayed
  // "active", the relist below never ran, the units they still owed were never
  // republished and their accounts stayed reserved out of the sellable pool —
  // and because each relist publishes a BRAND-NEW row, a chain that crossed the
  // cap died at its next sale. At 135 rows it hid 35 listings owing 171 units,
  // 4 of which Gameflip had already marked sold.
  const rows = await MarketplaceListing.find({
    marketplace: "gameflip",
    status: "active",
    autoDeliver: true,
  }).lean();
  let sold = 0;
  let relisted = 0;
  // One query for every sold listing we own, instead of one per row. Falls
  // back to per-listing polling if the bulk query fails, so a Gameflip API
  // change can only make this slower, never blind.
  let soldIds = null;
  let liveIds = null;
  try {
    soldIds = await mp.gameflipListingIdsByStatus("sold");
    liveIds = await mp.gameflipListingIdsByStatus("onsale");
  } catch (e) {
    console.error("gameflip listing sweep failed:", e.message);
    soldIds = null;
    liveIds = null;
  }
  // In the degraded path every row costs its own status call, so bound the pass
  // rather than firing the whole fleet into Gameflip's rate limiter (which
  // stalls sale detection for everyone). Only this path is capped — never the
  // bulk one above, which is what starved the tail before.
  const due = soldIds && liveIds ? rows : rows.slice(0, FALLBACK_POLL_LIMIT);
  if (due.length < rows.length) {
    console.error(
      "gameflip bulk sweep unavailable — polling " +
        due.length +
        " of " +
        rows.length +
        " rows this pass",
    );
  }
  for (const row of due) {
    let status;
    try {
      // A row in neither sweep is unaccounted for (deleted, expired, still a
      // draft), so it still gets its own status call — that is the only path
      // that can retire a 404'd row, and there are only ever a handful.
      status =
        soldIds && liveIds
          ? soldIds.has(row.externalId)
            ? "sold"
            : liveIds.has(row.externalId)
              ? "onsale"
              : await mp.gameflipListingStatus(row.externalId)
          : await mp.gameflipListingStatus(row.externalId);
    } catch (e) {
      // A 404 means the listing is gone from Gameflip for good. Plain `continue`
      // leaves the row active forever: the watcher re-reads it every tick, the
      // units it still owes are never relisted, and its account stays reserved
      // out of the sellable pool. Retire the row and hand the account back.
      // Every other error (timeout, 429, 5xx) really is transient — skip those.
      if (e && e.status === 404) {
        const retired = await MarketplaceListing.findOneAndUpdate(
          { _id: row._id, status: "active" },
          {
            $set: {
              status: "removed",
              lastError: "gone from Gameflip (404) — retired by the watcher",
            },
          },
        ).catch(() => null);
        if (retired && row.accountId) {
          await releaseAccount(row.accountId).catch(() => {});
        }
        if (retired) {
          console.error(
            "gameflip listing " +
              row.externalId +
              " is 404 — retired, " +
              (Number(row.qtyRemaining) || 0) +
              " unit(s) were still owed",
          );
        }
      }
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
    // Demand learning: this poller is the only thing that ever learns a
    // Gameflip listing was bought, and for years it kept that to itself. One
    // signal per game in the bundle, carrying the price the buyer actually
    // paid. Best-effort — a learning write must never break the relist chain.
    try {
      const soldSet = await DropSet.findById(row.set).lean();
      if (soldSet) {
        await recordListingSale({
          listing: row,
          set: soldSet,
          units: 1,
          priceUsd: Number(row.price) || 0,
        });
      }
    } catch (e) {
      console.error("gameflip sale learning error:", e.message);
    }
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
        origin: row.origin,
      });
      relisted++;
    } catch (e) {
      await noteRelistFailure(row, e);
    } finally {
      if (img) await fsp.unlink(img).catch(() => {});
    }
  }
  // Retry chains whose relist failed on an earlier pass. The row is already
  // marked sold by then, so the loop above never looks at it again: a single
  // transient error (Gameflip's 429 limiter, a timeout) silently ended a chain
  // that still owed units, leaving the stock unlisted and its accounts idle.
  //
  // Only rows whose backoff has elapsed are due, oldest deadline first. Without
  // both of those a chain that can NEVER be fulfilled (nothing unsold holds the
  // bundle any more) was republished-attempted every single tick — thousands of
  // identical errors an hour — and, because the lane is capped at a handful of
  // rows, five such chains would sit at the head of it forever and starve the
  // genuinely transient failures the retry exists for.
  const stalled = await MarketplaceListing.find({
    marketplace: "gameflip",
    status: "sold",
    qtyRemaining: { $gt: 0 },
    lastError: /^auto-relist failed/,
    $or: [
      { relistRetryAt: null },
      { relistRetryAt: { $exists: false } },
      { relistRetryAt: { $lte: new Date() } },
    ],
  })
    .sort({ relistRetryAt: 1 })
    .limit(5)
    .lean();
  for (const row of stalled) {
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
        origin: row.origin,
      });
      // The debt now lives on the new row — clear it here so the retry can
      // never double-list the same units.
      await MarketplaceListing.updateOne(
        { _id: row._id },
        {
          $set: {
            qtyRemaining: 0,
            lastError: "",
            relistAttempts: 0,
            relistRetryAt: null,
          },
        },
      ).catch(() => {});
      relisted++;
    } catch (e) {
      await noteRelistFailure(row, e);
    } finally {
      if (img) await fsp.unlink(img).catch(() => {});
    }
  }
  return { checked: due.length, sold, relisted };
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
  GF_CLAIM_TAG,
  claimAccountForSet,
  releaseAccount,
  gameflipDeliveryCode,
  accountListingText,
  publishAutoDelivery,
  syncOnce,
  start,
  // exported for tests
  relistRetryDelayMs,
  isOutOfStockError,
  RELIST_RETRY_MAX_MS,
};
