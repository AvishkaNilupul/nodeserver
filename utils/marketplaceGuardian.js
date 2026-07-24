// Marketplace guardian: the background integrity checker + auto-feeder.
//
// Every pass does two jobs across all live auto-delivery listings:
//
// 1. AUTO-FEED — for quantity-based listings (Plati / GGSel) with a qtyTarget,
//    read how many units the platform still has and top the listing up with
//    freshly claimed farmed accounts when units sold, so stock never runs dry
//    while the server has accounts. (Gameflip is fed by its own relist chain.)
//
// 2. INTEGRITY CHECKS — find situations that would burn a buyer and surface
//    them as AuditFinding rows for human review (the Integrity tab):
//      - duplicate-account: the same account attached to 2+ active listings
//        (i.e. sellable on more than one platform at once)
//      - claim-mismatch: an account in a live listing that is no longer
//        reserved for that platform (released, or sold to someone else)
//      - redeemed-drops: an account in a live listing whose drops for that
//        set are already connected/redeemed
//      - dead-token: an account in a live listing whose Twitch token is
//        invalid (credentials likely changed — delivery may not work)
//    Findings are upserted by a stable dedupeKey and auto-resolve when the
//    underlying condition clears, so the tab always reflects reality.
const AuditFinding = require("../models/AuditFinding");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const dsFulfiller = require("./digisellerFulfiller");
const ggFulfiller = require("./ggselFulfiller");
const fpFulfiller = require("./funpayFulfiller");
const mp = require("./marketplaces");

const CLAIM_TAGS = {
  ggsel: ggFulfiller.GG_CLAIM_TAG,
  digiseller: dsFulfiller.DS_CLAIM_TAG,
  gameflip: "gameflip",
  funpay: fpFulfiller.FP_CLAIM_TAG,
};

// Last pass summary for the UI ("checking… found N").
let lastRun = null;
let running = false;

function accountIdsOf(row) {
  return String(row.accountId || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function upsertFinding(f) {
  const now = new Date();
  await AuditFinding.findOneAndUpdate(
    { dedupeKey: f.dedupeKey },
    {
      $set: {
        type: f.type,
        severity: f.severity || "medium",
        marketplace: f.marketplace || "",
        listing: f.listing || null,
        accountId: f.accountId || "",
        accountLogin: f.accountLogin || "",
        message: f.message || "",
        lastSeenAt: now,
      },
      $setOnInsert: { status: "open", detectedAt: now },
    },
    { upsert: true },
  );
}

// Findings of the "condition" types that were NOT re-detected this pass have
// cleared — mark them resolved so the tab doesn't show stale alarms.
const CONDITION_TYPES = [
  "duplicate-account",
  "claim-mismatch",
  "redeemed-drops",
  "dead-token",
  "stock-unknown",
];

async function autoResolveStale(seenKeys) {
  await AuditFinding.updateMany(
    {
      status: "open",
      dedupeKey: { $nin: [...seenKeys] },
      $or: [
        { type: { $in: CONDITION_TYPES } },
        // "Nothing to feed" restock findings are condition-based too (stable
        // dedupe key, re-flagged every pass while stock is short) — once the
        // listing gets fed or delisted they must clear, or the tab shows a
        // stale alarm forever. One-shot "restock-err:<ts>" events stay.
        { type: "restock-failed", dedupeKey: /^restock-empty:/ },
      ],
    },
    {
      $set: {
        status: "resolved",
        resolution: "auto-resolved: condition no longer detected",
        resolvedAt: new Date(),
      },
    },
  );
}

// ------------------------------------------------------------------
// Integrity checks
// ------------------------------------------------------------------
async function runChecks(rows, seenKeys) {
  let found = 0;
  const flag = async (f) => {
    seenKeys.add(f.dedupeKey);
    await upsertFinding(f);
    found++;
  };

  // Account -> the active listings it is attached to (by id and by login so
  // manually-fed accounts are caught too).
  const byAccount = new Map();
  const byLogin = new Map();
  for (const row of rows) {
    for (const id of accountIdsOf(row)) {
      if (!byAccount.has(id)) byAccount.set(id, []);
      byAccount.get(id).push(row);
    }
    for (const login of String(row.accountLogin || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)) {
      if (!byLogin.has(login)) byLogin.set(login, []);
      byLogin.get(login).push(row);
    }
  }

  // 1. Same account on more than one live listing / platform.
  const dupSeen = new Set();
  const dupCheck = async (key, listings, label) => {
    if (listings.length < 2) return;
    const uniq = [...new Set(listings.map((l) => String(l._id)))];
    if (uniq.length < 2) return;
    if (dupSeen.has(key)) return;
    dupSeen.add(key);
    const where = listings
      .map((l) => l.marketplace + " " + (l.externalId || ""))
      .join(", ");
    await flag({
      type: "duplicate-account",
      severity: "high",
      dedupeKey: "dup:" + key,
      accountId: byAccount.has(key) ? key : "",
      accountLogin: label,
      message:
        "Account " +
        (label || key) +
        " is attached to " +
        uniq.length +
        " live listings (" +
        where +
        ") — a second buyer would receive an already-sold account. Delist " +
        "one of them or replace the account.",
    });
  };
  // Per-game reservation means the SAME account on two listings for DIFFERENT
  // sets (games) is fine — only two listings of the SAME set on one account is
  // a real double-sell. So group an account's listings by set before flagging.
  const bySet = (listings) => {
    const m = new Map();
    for (const l of listings) {
      const k = String(l.set || "");
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(l);
    }
    return m;
  };
  for (const [id, listings] of byAccount) {
    const login = (listings[0].accountLogin || "").split(",")[0].trim();
    for (const [setId, ls] of bySet(listings)) {
      await dupCheck(id + "|" + setId, ls, login);
    }
  }
  for (const [login, listings] of byLogin) {
    for (const [setId, ls] of bySet(listings)) {
      await dupCheck("login:" + login + "|" + setId, ls, login);
    }
  }

  // Load every referenced account once.
  const allIds = [...byAccount.keys()];
  const accounts = allIds.length
    ? await BotAccount.find(
        { _id: { $in: allIds } },
        { login: 1, soldAt: 1, soldToUsername: 1, lastScanStatus: 1 },
      ).lean()
    : [];
  const accMap = new Map(accounts.map((a) => [String(a._id), a]));

  for (const [id, listings] of byAccount) {
    const acc = accMap.get(id);
    if (!acc) continue;
    for (const row of listings) {
      // 4. Dead token — credentials likely changed; delivery may not work.
      if (acc.lastScanStatus === "token_invalid") {
        await flag({
          type: "dead-token",
          severity: "medium",
          marketplace: row.marketplace,
          listing: row._id,
          accountId: id,
          accountLogin: acc.login || "",
          dedupeKey: "token:" + id + ":" + row._id,
          message:
            "Account " +
            (acc.login || id) +
            " in a live " +
            row.marketplace +
            " listing has an invalid Twitch token — the password may have " +
            "changed, so the delivered login may not work.",
        });
      }
    }
  }

  // 3. Redeemed drops: for each listing's set, accounts whose drops for the
  // set's items are already connected can no longer deliver those rewards.
  const setIds = [...new Set(rows.map((r) => String(r.set)))];
  const sets = setIds.length
    ? await DropSet.find({ _id: { $in: setIds } }, { items: 1, name: 1 }).lean()
    : [];
  const setMap = new Map(sets.map((s) => [String(s._id), s]));
  for (const row of rows) {
    const set = setMap.get(String(row.set));
    if (!set) continue;
    const keys = (set.items || []).map((i) => i.itemKey).filter(Boolean);
    const ids = accountIdsOf(row);
    if (!keys.length || !ids.length) continue;

    // 2. Per-game reservation: every one of this set's drops on each attached
    // account should be reserved by THIS listing's tag. If a key isn't reserved
    // (could be sold again) or is reserved by another platform (a real
    // conflict on the same drops), flag it.
    const tag = CLAIM_TAGS[row.marketplace] || row.marketplace;
    const resv = await DropLog.find(
      { account: { $in: ids }, itemKey: { $in: keys }, soldAt: { $ne: null } },
      { account: 1, itemKey: 1, soldToUsername: 1 },
    ).lean();
    const resByAcc = new Map();
    for (const d of resv) {
      const k = String(d.account);
      if (!resByAcc.has(k)) resByAcc.set(k, new Map());
      resByAcc.get(k).set(d.itemKey, d.soldToUsername || "");
    }
    for (const accId of ids) {
      const km = resByAcc.get(accId) || new Map();
      const mine = keys.filter((k) => km.get(k) === tag).length;
      if (mine === keys.length) continue; // fully reserved for this game
      const acc = accMap.get(accId);
      const otherTag = keys.map((k) => km.get(k)).find((t) => t && t !== tag);
      await flag({
        type: "claim-mismatch",
        severity: "high",
        marketplace: row.marketplace,
        listing: row._id,
        accountId: accId,
        accountLogin: (acc && acc.login) || "",
        dedupeKey: "claim:" + accId + ":" + row._id,
        message:
          "Account " +
          ((acc && acc.login) || accId) +
          " on a live " +
          row.marketplace +
          " listing: this game's drops are " +
          (otherTag
            ? 'reserved as "' +
              otherTag +
              '" — another listing grabbed the same drops.'
            : "not fully reserved, so they could be sold again elsewhere."),
      });
    }

    const redeemed = await DropLog.find(
      { account: { $in: ids }, itemKey: { $in: keys }, connected: true },
      { account: 1, name: 1 },
    ).lean();
    const byAcc = new Map();
    for (const d of redeemed) {
      const k = String(d.account);
      if (!byAcc.has(k)) byAcc.set(k, []);
      byAcc.get(k).push(d.name || "item");
    }
    // On quantity listings (Plati / GGSel) the platform hands the delivery
    // codes out itself, and delivered accounts stay attached to the row — so
    // redeemed drops there usually just mean a completed sale whose buyer
    // already connected the game. Flag it lower and say so, instead of
    // raising a false "buyer would be burned" alarm after every sale.
    const qtyListing =
      (row.marketplace === "digiseller" || row.marketplace === "ggsel") &&
      Number(row.qtyTarget) > 0;
    for (const [accId, items] of byAcc) {
      const acc = accMap.get(accId);
      await flag({
        type: "redeemed-drops",
        severity: qtyListing ? "low" : "high",
        marketplace: row.marketplace,
        listing: row._id,
        accountId: accId,
        accountLogin: (acc && acc.login) || "",
        dedupeKey: "redeemed:" + accId + ":" + row._id,
        message:
          "Account " +
          ((acc && acc.login) || accId) +
          " in a live " +
          row.marketplace +
          " listing already redeemed: " +
          [...new Set(items)].slice(0, 5).join(", ") +
          (qtyListing
            ? " — likely a completed sale (the buyer connected it). Only " +
              "act if this unit was never sold."
            : " — the buyer could not redeem these. Replace the account or " +
              "delist."),
      });
    }
  }
  return found;
}

// ------------------------------------------------------------------
// Auto-feed (Plati / GGSel quantity listings)
// ------------------------------------------------------------------
async function feedListing(row, seenKeys) {
  const target = Number(row.qtyTarget) || 0;
  if (!target) return 0;
  let remaining = null;
  if (row.marketplace === "ggsel") {
    remaining = await mp.ggselOfferStock(row.externalId);
  } else if (row.marketplace === "digiseller") {
    remaining = await mp.digisellerProductStock(row.externalId);
  } else {
    return 0;
  }
  if (remaining === null) {
    const key = "stock:" + row._id;
    seenKeys.add(key);
    await upsertFinding({
      type: "stock-unknown",
      severity: "low",
      marketplace: row.marketplace,
      listing: row._id,
      dedupeKey: key,
      message:
        "Could not read remaining stock for " +
        row.marketplace +
        " listing " +
        row.externalId +
        " — auto-feed skipped this pass.",
    });
    return 0;
  }
  const need = target - remaining;
  if (need <= 0) {
    // Self-heal: a GGSel offer can be fully stocked yet still paused if a
    // prior feed's async product-add settled after finalize ran (so activate
    // was skipped). Re-finalize is idempotent and re-activates a paused,
    // stocked offer — so a stuck-paused listing recovers on the next tick
    // without needing a fresh feed.
    if (row.marketplace === "ggsel") {
      try {
        const fin = await mp.ggselFinalizeStock(row.externalId);
        if (fin.reactivated) {
          console.log(
            "guardian: re-activated stuck-paused ggsel offer " + row.externalId,
          );
        }
      } catch (e) {
        console.error(
          "guardian ggsel reconcile error " + row.externalId + ": " + e.message,
        );
      }
    }
    return 0;
  }
  const set = await DropSet.findById(row.set).lean();
  if (!set) return 0;
  const fulfiller = row.marketplace === "ggsel" ? ggFulfiller : dsFulfiller;
  const claimed = await fulfiller.claimAccountsForSet(set, need);
  if (!claimed.length) {
    const key = "restock-empty:" + row._id;
    seenKeys.add(key);
    await upsertFinding({
      type: "restock-failed",
      severity: "medium",
      marketplace: row.marketplace,
      listing: row._id,
      dedupeKey: key,
      message:
        row.marketplace +
        " listing " +
        row.externalId +
        " is " +
        need +
        " unit(s) below its target of " +
        target +
        " but no unsold account holds this bundle — nothing to feed.",
    });
    return 0;
  }
  try {
    if (row.marketplace === "ggsel") {
      // GGSel rejects /products unless the offer is already autoselling, so
      // enable it BEFORE the add (a no-op once on). An offer published empty
      // starts non-autoselling; this is what makes the first feed stick.
      await mp.ggselEnableAutoselling(row.externalId);
      await mp.ggselAddProducts(
        row.externalId,
        claimed.map((c) => c.code),
      );
    } else {
      await mp.digisellerAddContent(
        row.externalId,
        claimed.map((c) => c.code),
      );
    }
  } catch (e) {
    // The bulk add call can fail as a whole even though the platform already
    // accepted some of the lines — both APIs return one error code for the
    // entire batch, with no per-line status. Blindly releasing every claimed
    // account back to the pool in that case risks a second buyer being
    // handed an account whose code is already live on the listing. Re-check
    // stock first: if it moved, leave the accounts reserved and flag for a
    // human instead of guessing which ones are safe to release.
    let stockAfter = null;
    try {
      stockAfter =
        row.marketplace === "ggsel"
          ? await mp.ggselOfferStock(row.externalId)
          : await mp.digisellerProductStock(row.externalId);
    } catch {
      stockAfter = null;
    }
    const partial = stockAfter !== null && stockAfter > remaining;
    if (!partial) {
      await fulfiller.releaseAccounts(claimed.map((c) => c.accountId));
    }
    await upsertFinding({
      type: "restock-failed",
      severity: partial ? "high" : "medium",
      marketplace: row.marketplace,
      listing: row._id,
      dedupeKey: "restock-err:" + row._id + ":" + Date.now(),
      message:
        "Auto-feed of " +
        row.marketplace +
        " listing " +
        row.externalId +
        " failed: " +
        e.message +
        (partial
          ? " — stock moved despite the error, so the claimed account(s) " +
            "were kept reserved instead of released (avoids risking a " +
            "double-delivered account); check manually."
          : ""),
    });
    return 0;
  }
  // Enabling autoselling on an empty offer (above) also pauses it, so after
  // the products are attached, sync the sellable quantity to the real stock
  // and re-activate. Without this a freshly-fed offer sits paused — stocked
  // but off sale.
  if (row.marketplace === "ggsel") {
    try {
      const fin = await mp.ggselFinalizeStock(row.externalId);
      if (fin.reactivated) {
        console.log(
          "guardian: re-activated ggsel offer " +
            row.externalId +
            " with " +
            fin.stock +
            " in stock",
        );
      }
    } catch (e) {
      await upsertFinding({
        type: "restock-failed",
        severity: "high",
        marketplace: row.marketplace,
        listing: row._id,
        dedupeKey: "autosell-sync:" + row._id,
        message:
          "GGSel listing " +
          row.externalId +
          " was fed products but could not be finalized (quantity/activate): " +
          e.message +
          " — the offer may be paused with stock; check it.",
      });
    }
  }
  await MarketplaceListing.updateOne(
    { _id: row._id },
    {
      $set: {
        accountId: accountIdsOf(row)
          .concat(claimed.map((c) => c.accountId))
          .join(","),
        accountLogin: [
          ...String(row.accountLogin || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
          ...claimed.map((c) => c.login),
        ].join(", "),
      },
    },
  );
  // Log the restock as an already-resolved finding so it shows as activity.
  await AuditFinding.create({
    type: "restocked",
    severity: "info",
    marketplace: row.marketplace,
    listing: row._id,
    accountLogin: claimed.map((c) => c.login).join(", "),
    dedupeKey: "restocked:" + row._id + ":" + Date.now(),
    status: "resolved",
    resolution: "auto-fed",
    resolvedAt: new Date(),
    message:
      "Auto-fed " +
      claimed.length +
      " fresh account(s) to " +
      row.marketplace +
      " listing " +
      row.externalId +
      " (was " +
      remaining +
      "/" +
      target +
      " in stock).",
  });
  return claimed.length;
}

// ------------------------------------------------------------------
// One guardian pass
// ------------------------------------------------------------------
async function runOnce() {
  if (running) return lastRun;
  running = true;
  const startedAt = new Date();
  try {
    const rows = await MarketplaceListing.find({
      status: "active",
      autoDeliver: true,
    })
      .limit(500)
      .lean();
    const seenKeys = new Set();
    let fed = 0;
    for (const row of rows) {
      try {
        fed += await feedListing(row, seenKeys);
      } catch (e) {
        console.error("guardian feed error:", e.message);
      }
    }
    const found = await runChecks(rows, seenKeys);
    await autoResolveStale(seenKeys);
    const open = await AuditFinding.countDocuments({ status: "open" });
    lastRun = {
      at: startedAt,
      tookMs: Date.now() - startedAt.getTime(),
      listingsChecked: rows.length,
      accountsFed: fed,
      issuesDetected: found,
      openFindings: open,
    };
    return lastRun;
  } finally {
    running = false;
  }
}

function status() {
  return { running, lastRun };
}

const TICK_MS = 5 * 60 * 1000;
let started = false;

function start() {
  if (started) return;
  started = true;
  const tick = async () => {
    try {
      await runOnce();
    } catch (e) {
      console.error("marketplace guardian error:", e.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, TICK_MS);
  if (t.unref) t.unref();
}

module.exports = { runOnce, status, start };
