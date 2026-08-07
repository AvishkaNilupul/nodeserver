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
const { sendTelegram } = require("./telegram");
const accountState = require("./twitchAccountState");

const CLAIM_TAGS = {
  ggsel: ggFulfiller.GG_CLAIM_TAG,
  digiseller: dsFulfiller.DS_CLAIM_TAG,
  gameflip: "gameflip",
  funpay: fpFulfiller.FP_CLAIM_TAG,
};

// Last pass summary for the UI ("checking… found N").
let lastRun = null;
let running = false;

// Findings first raised during the current pass, and units auto-fed, collected
// so one pass sends at most one Telegram of each kind instead of a message per
// row. Reset at the start of every pass.
let freshFindings = [];
let freshFeeds = [];

function accountIdsOf(row) {
  return String(row.accountId || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function upsertFinding(f) {
  const now = new Date();
  const res = await AuditFinding.findOneAndUpdate(
    { dedupeKey: f.dedupeKey },
    {
      $set: {
        type: f.type,
        severity: f.severity || "medium",
        marketplace: f.marketplace || "",
        listing: f.listing || null,
        listings: f.listings || [],
        accountId: f.accountId || "",
        accountLogin: f.accountLogin || "",
        message: f.message || "",
        lastSeenAt: now,
      },
      $setOnInsert: { status: "open", detectedAt: now },
    },
    // includeResultMetadata tells us whether this pass CREATED the finding or
    // merely re-saw a known one — only brand-new problems are worth a push.
    // `res.value` is the document as it was BEFORE this update (null on insert).
    { upsert: true, includeResultMetadata: true },
  );
  const isNew = !!(res && res.lastErrorObject && res.lastErrorObject.upserted);
  const prev = res && res.value;
  // A condition that cleared and came back: autoResolveStale had closed it, and
  // the upsert above only refreshes fields — without this the row would stay
  // "resolved", so a returning problem would be invisible in the tab and would
  // never alert. Only rows the system auto-resolved are reopened; one a human
  // resolved or ignored stays that way.
  const returned =
    !isNew &&
    prev &&
    prev.status === "resolved" &&
    String(prev.resolution || "").startsWith("auto-resolved");
  if (returned) {
    await AuditFinding.updateOne(
      { _id: prev._id },
      { $set: { status: "open", resolution: "", resolvedAt: null } },
    );
  }
  if (isNew || returned) {
    freshFindings.push(f);
  }
  return isNew || returned;
}

// Findings of the "condition" types that were NOT re-detected this pass have
// cleared — mark them resolved so the tab doesn't show stale alarms.
const CONDITION_TYPES = [
  "duplicate-account",
  "claim-mismatch",
  "redeemed-drops",
  "dead-token",
  "account-gone",
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

  // The login recorded next to `id` on any of `listings`: units carry the pair
  // directly, and the top-level CSVs are positional (accountId[i] <-> the i-th
  // login).
  const loginForId = (listings, id) => {
    for (const l of listings) {
      for (const u of l.units || []) {
        if (u && String(u.accountId) === String(id) && u.login) {
          return String(u.login);
        }
      }
      const ids = accountIdsOf(l);
      const logins = String(l.accountLogin || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const at = ids.indexOf(String(id));
      if (at >= 0 && logins[at]) return logins[at];
    }
    return "";
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
  const dupPairs = new Set();
  const dupCheck = async (key, listings, label) => {
    if (listings.length < 2) return;
    const uniq = [...new Set(listings.map((l) => String(l._id)))];
    if (uniq.length < 2) return;
    if (dupSeen.has(key)) return;
    dupSeen.add(key);
    // The by-id and by-login passes see the same conflict whenever both rows
    // track the account with its id, and raised two findings for it. One
    // real-world conflict, one finding: the by-id pass runs first and its
    // accountId makes the fix actionable, so the by-login twin is dropped
    // (and any earlier duplicate auto-resolves for not being seen again).
    const pairKey =
      uniq.slice().sort().join(",") + "|" + String(label || key).toLowerCase();
    if (dupPairs.has(pairKey)) return;
    dupPairs.add(pairKey);
    const where = listings
      .map((l) => l.marketplace + " " + (l.externalId || ""))
      .join(", ");
    await flag({
      type: "duplicate-account",
      severity: "high",
      dedupeKey: "dup:" + key,
      accountId: byAccount.has(key) ? key : "",
      accountLogin: label,
      // The conflicting rows, so the Integrity tab can offer the one-click fix
      // (this finding is about an account, not about one listing, so `listing`
      // alone cannot say where the account has to come off).
      listings: uniq,
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
    // The login that goes with THIS account id, not simply the first login on
    // the first listing: a Plati/GGSel row tracks several accounts, so taking
    // listings[0]'s first login named the wrong account in the finding.
    const login = loginForId(listings, id);
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
      // 4. Dead token — credentials likely changed; delivery MAY not work. A
      // suspended account is a different alarm, not a worse token: the login is
      // gone from Twitch, so delivery certainly fails and "the password may have
      // changed" reads as something a re-auth could fix. The suspension sweep
      // takes these off their listings on its own, so a finding that stays open
      // means that surgery could not be completed and needs a human.
      const gone = acc.lastScanStatus === "suspended";
      if (gone || accountState.isUnusableScanStatus(acc.lastScanStatus)) {
        await flag({
          type: gone ? "account-gone" : "dead-token",
          severity: gone ? "high" : "medium",
          marketplace: row.marketplace,
          listing: row._id,
          accountId: id,
          accountLogin: acc.login || "",
          dedupeKey: (gone ? "gone:" : "token:") + id + ":" + row._id,
          message:
            "Account " +
            (acc.login || id) +
            " in a live " +
            row.marketplace +
            " listing " +
            (gone
              ? "no longer exists on Twitch (suspended or deleted) — a buyer " +
                "cannot use it. Replace the unit or delist."
              : "has an invalid Twitch token — the password may have " +
                "changed, so the delivered login may not work."),
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
      const res = await mp.digisellerAddContent(
        row.externalId,
        claimed.map((c) => c.code),
      );
      // Record each unit's content_id against the account it carries, in the
      // order they were sent (Digiseller answers in that order). Without this
      // the unit can never be removed individually — see the `units` comment
      // on models/MarketplaceListing.js. Best-effort: a bookkeeping failure
      // must not undo a feed that the platform already accepted.
      const ids = (res && res.contentIds) || [];
      if (ids.length) {
        const units = claimed
          .map((c, i) => ({
            contentId: ids[i] || "",
            accountId: String(c.accountId || ""),
            login: c.login || "",
            addedAt: new Date(),
          }))
          .filter((u) => u.contentId);
        if (units.length) {
          await MarketplaceListing.updateOne(
            { _id: row._id },
            { $push: { units: { $each: units } } },
          ).catch(() => {});
        }
      }
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
    // An offer archived on the platform's side can never accept products
    // again, but our row stayed "active" — so every pass re-tried the feed and
    // refreshed the same alarm forever. Mirror the platform: mark the listing
    // delisted and close its findings, so it leaves the live set entirely.
    if (!partial && /\barchived\b/i.test(e.message || "")) {
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { status: "delisted" } },
      );
      await AuditFinding.updateMany(
        { listing: row._id, status: "open" },
        {
          $set: {
            status: "resolved",
            resolution:
              "auto-resolved: offer is archived on " +
              row.marketplace +
              " — listing marked delisted",
            resolvedAt: new Date(),
          },
        },
      );
      console.log(
        "guardian: " +
          row.marketplace +
          " offer " +
          row.externalId +
          " is archived — marked delisted",
      );
      return 0;
    }
    await upsertFinding({
      type: "restock-failed",
      severity: partial ? "high" : "medium",
      marketplace: row.marketplace,
      listing: row._id,
      // One finding per listing, NOT one per pass. Date.now() made this key
      // unique every time, so the dedupe above never matched: each pass
      // inserted a brand-new row and, because an insert counts as isNew, sent
      // another Telegram. A permanently-failing listing therefore re-alerted
      // forever — one archived GGSel offer produced 38 identical open findings.
      // Keyed on the listing, a repeat now just refreshes lastSeenAt.
      dedupeKey: "restock-err:" + row._id,
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
  freshFeeds.push({
    marketplace: row.marketplace,
    externalId: row.externalId,
    title: row.title || "",
    units: claimed.length,
    remaining,
    target,
  });
  // A successful feed clears any standing failure for this listing. Now that
  // the failure finding is keyed on the listing rather than the moment, it
  // would otherwise stay open forever once a listing had failed even once:
  // "restock-err:" is not one of the CONDITION_TYPES autoResolveStale sweeps,
  // so nothing else would ever close it. Resolving it here also lets the
  // reopen-on-return path treat a recurrence as genuinely new.
  await AuditFinding.updateMany(
    { dedupeKey: "restock-err:" + row._id, status: "open" },
    {
      $set: {
        status: "resolved",
        resolution: "auto-resolved: a later restock succeeded",
        resolvedAt: new Date(),
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

// One Telegram per pass, at most: a restock digest (units auto-fed, which
// means those units SOLD on Plati/GGSel — the closest thing those platforms
// give us to a sale event) and a digest of problems first seen this pass.
// Re-seen findings stay silent so a persistent issue can't spam the chat.
const NOTIFY_LINES = 5;

async function notifyPass() {
  if (freshFeeds.length) {
    const total = freshFeeds.reduce((n, f) => n + f.units, 0);
    const lines = freshFeeds
      .slice(0, NOTIFY_LINES)
      .map(
        (f) =>
          "• " +
          f.marketplace +
          " " +
          (f.title ? f.title.slice(0, 60) : f.externalId) +
          " — fed " +
          f.units +
          " (was " +
          f.remaining +
          "/" +
          f.target +
          ")",
      );
    if (freshFeeds.length > NOTIFY_LINES) {
      lines.push("…and " + (freshFeeds.length - NOTIFY_LINES) + " more");
    }
    await sendTelegram(
      "📦 RESTOCKED " +
        total +
        " unit(s) — those units sold\n\n" +
        lines.join("\n"),
    );
  }
  // "restocked" is the success side of a feed, already covered above.
  const problems = freshFindings.filter((f) => f.severity !== "info");
  if (problems.length) {
    const lines = problems
      .slice(0, NOTIFY_LINES)
      .map((f) => "• [" + (f.severity || "medium") + "] " + f.message);
    if (problems.length > NOTIFY_LINES) {
      lines.push("…and " + (problems.length - NOTIFY_LINES) + " more");
    }
    await sendTelegram(
      "⚠️ GUARDIAN found " +
        problems.length +
        " new issue(s)\n\n" +
        lines.join("\n") +
        "\n\nReview them in the app under More → Integrity.",
    );
  }
}

// ------------------------------------------------------------------
// One guardian pass
// ------------------------------------------------------------------
async function runOnce() {
  if (running) return lastRun;
  running = true;
  const startedAt = new Date();
  freshFindings = [];
  freshFeeds = [];
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
    notifyPass().catch((e) =>
      console.error("guardian notify error:", e.message),
    );
    return lastRun;
  } finally {
    running = false;
  }
}

function status() {
  return { running, lastRun };
}

// Run the auto-feed for ONE listing right now (the Integrity tab's
// "Retry restock" fix). Same feedListing path as a pass, so a success also
// clears the standing restock-err finding and logs the restock activity row.
async function feedOne(listingId) {
  const row = await MarketplaceListing.findOne({
    _id: listingId,
    status: "active",
    autoDeliver: true,
  }).lean();
  if (!row) {
    throw new Error("Listing is not an active auto-delivery listing");
  }
  return feedListing(row, new Set());
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

module.exports = { runOnce, status, start, feedOne, CLAIM_TAGS };
