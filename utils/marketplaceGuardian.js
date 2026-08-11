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
// Auto-heal summary for the pass, so the digest can report what was repaired.
let freshHeals = null;

// Which claim tag holds this drop, or null when it is free. A drop the
// account never farmed has no row at all and is likewise unheld.
function reservedBy(log) {
  return log && log.soldAt ? log.soldToUsername || "" : null;
}

// Pure: how one attached account stands against the set its listing sells.
// `logs` maps itemKey -> that account's DropLog row; a key with no row is a
// drop the account never farmed. `tag` is the listing's claim tag.
//
// Both answers hinge on WHO holds each drop rather than on which marketplace
// the listing is on, because the same on-disk state means opposite things
// depending on ownership: drops redeemed while still reserved to this listing
// are a delivered sale, the very same drops redeemed under someone else's tag
// are a burned unit.
// An account can hold SEVERAL copies of the same drop, and reserving a unit
// only marks the copies it needs. Collapse each item's copies into one verdict
// that prefers the copy reserved for THIS listing, so a spare unreserved copy
// sitting next to a reserved one cannot make a properly reserved unit look
// released.
function summarizeDrops(rows, tag) {
  const out = new Map();
  for (const d of rows) {
    const s = out.get(d.itemKey) || {
      held: false,
      otherTag: "",
      otherSet: "",
      connected: false,
      connectedForeign: false,
      name: "",
    };
    const by = reservedBy(d);
    if (by === tag) s.held = true;
    else if (by && !s.otherTag) {
      s.otherTag = by;
      // WHICH product holds it decides what the owner has to do, so carry the
      // set id: a rival claim on the same set is two listings double-selling
      // one unit, while a claim from a different set means this set was edited
      // to include drops the account had already committed to another product.
      s.otherSet = String(d.soldSetId || "");
    }
    if (d.connected) {
      s.connected = true;
      if (by !== tag) s.connectedForeign = true;
      s.name = s.name || d.name || "item";
    }
    out.set(d.itemKey, s);
  }
  return out;
}

function classifyUnit(uniqKeys, drops) {
  const at = (k) => drops.get(k) || null;
  const held = uniqKeys.filter((k) => at(k) && at(k).held).length;
  let reservation = null;
  if (held !== uniqKeys.length) {
    const clash = uniqKeys
      .map((k) => (at(k) && !at(k).held ? at(k) : null))
      .find((s) => s && s.otherTag);
    const otherTag = clash ? clash.otherTag : "";
    reservation = {
      kind: otherTag ? "conflict" : held ? "partial" : "released",
      held,
      total: uniqKeys.length,
      otherSet: clash ? clash.otherSet : "",
      // Never farmed here, so no reservation can conjure it: the unit cannot
      // deliver what the listing advertises.
      absent: uniqKeys.filter((k) => !drops.has(k)).length,
      otherTag: otherTag || "",
    };
  }
  const conn = uniqKeys.map(at).filter((s) => s && s.connected);
  return {
    reservation,
    redeemed: conn.length
      ? {
          items: [...new Set(conn.map((s) => s.name || "item"))],
          delivered: !conn.some((s) => s.connectedForeign),
        }
      : null,
  };
}

// Pure: turn a stuck listing's stock census into the sentence explaining it.
// "Nothing to feed" has two completely different meanings — the drops were
// never farmed, or they were farmed onto accounts that can't be sold — and
// only the first is fixed by farming more.
function nothingToFeedReason(c) {
  if (!c.holders) return "";
  const parts = [];
  if (c.suspended) parts.push(c.suspended + " suspended or dead-token");
  if (c.noPassword) parts.push(c.noPassword + " with no stored password");
  if (c.deleted) parts.push(c.deleted + " deleted");
  const other = c.holders - c.suspended - c.noPassword - c.deleted;
  if (other > 0) parts.push(other + " short of the copies the set asks for");
  if (!parts.length) return "";
  return (
    c.holders +
    " account(s) hold this bundle but none can be delivered: " +
    parts.join(", ")
  );
}

// The census behind nothingToFeedReason: accounts carrying every one of the
// set's drops free and unconnected, broken down by what makes them unsellable.
async function censusForSet(set) {
  const keys = [
    ...new Set((set.items || []).map((i) => i.itemKey).filter(Boolean)),
  ];
  const empty = { holders: 0, suspended: 0, noPassword: 0, deleted: 0 };
  if (!keys.length) return empty;
  const rows = await DropLog.aggregate([
    {
      $match: {
        itemKey: { $in: keys },
        connected: { $ne: true },
        soldAt: null,
      },
    },
    { $group: { _id: { a: "$account", k: "$itemKey" } } },
    { $group: { _id: "$_id.a", n: { $sum: 1 } } },
    { $match: { n: keys.length } },
  ]);
  if (!rows.length) return empty;
  const ids = rows.map((r) => r._id);
  const accs = await BotAccount.find(
    { _id: { $in: ids } },
    { credPassword: 1, lastScanStatus: 1 },
  ).lean();
  const c = {
    ...empty,
    holders: ids.length,
    deleted: ids.length - accs.length,
  };
  for (const a of accs) {
    if (accountState.isUnusableScanStatus(a.lastScanStatus)) c.suspended++;
    else if (!(a.credPassword && String(a.credPassword).length)) c.noPassword++;
  }
  return c;
}

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
      {
        $set: {
          status: "open",
          resolution: "",
          resolvedAt: null,
          // A condition that cleared and came back is a fresh problem, so give
          // the healer its full attempt budget again rather than leaving it
          // exhausted from the previous episode.
          healAttempts: 0,
          healLastError: "",
        },
      },
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
  "orphaned-reservation",
];

async function autoResolveStale(seenKeys) {
  await AuditFinding.updateMany(
    {
      // needs-human rows are included on purpose: a finding the healer parked
      // still describes a condition, and when that condition goes away (someone
      // fixed it by hand, the listing sold out, the account came back) it must
      // clear like any other — otherwise the tab keeps showing a problem that
      // no longer exists and the parked row is immortal.
      status: { $in: ["open", "needs-human"] },
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

    const tag = CLAIM_TAGS[row.marketplace] || row.marketplace;
    const uniqKeys = [...new Set(keys)];
    const logs = await DropLog.find(
      { account: { $in: ids }, itemKey: { $in: keys } },
      {
        account: 1,
        itemKey: 1,
        soldAt: 1,
        soldToUsername: 1,
        soldSetId: 1,
        connected: 1,
        name: 1,
      },
    ).lean();
    const logsByAcc = new Map();
    for (const d of logs) {
      const k = String(d.account);
      if (!logsByAcc.has(k)) logsByAcc.set(k, []);
      logsByAcc.get(k).push(d);
    }

    for (const accId of ids) {
      const km = summarizeDrops(logsByAcc.get(accId) || [], tag);
      const acc = accMap.get(accId);
      const label = (acc && acc.login) || accId;

      const { reservation, redeemed } = classifyUnit(uniqKeys, km);

      // 2. Per-game reservation: every one of this set's drops on each
      // attached account should be reserved by THIS listing's tag.
      if (reservation) {
        const { kind, held, total, absent, otherTag, otherSet } = reservation;
        // Naming the product that holds the drops is the difference between a
        // finding the owner can act on and one they have to go dig out by
        // hand. A set id with no set behind it is itself the answer: the drops
        // are frozen by a product that no longer exists.
        const rival =
          otherSet && String(otherSet) !== String(row.set)
            ? setMap.get(String(otherSet)) ||
              (await DropSet.findById(otherSet, { name: 1 }).lean())
            : null;
        const rivalName = otherSet
          ? String(otherSet) === String(row.set)
            ? "this same set"
            : rival
              ? '"' + rival.name + '"'
              : "a set that has since been DELETED"
          : "";
        await flag({
          type: "claim-mismatch",
          // Only a cross-tag conflict or a wholly-unreserved unit is about to
          // burn a buyer. A unit that holds SOME of the set is the ordinary
          // result of adding drops to a set after units were reserved — the
          // new drops are merely unclaimed, which is worth fixing but is not
          // an emergency, and calling it one buried the real conflicts.
          severity: kind === "partial" ? "medium" : "high",
          marketplace: row.marketplace,
          listing: row._id,
          accountId: accId,
          accountLogin: (acc && acc.login) || "",
          dedupeKey: "claim:" + accId + ":" + row._id,
          message:
            kind === "conflict"
              ? "Account " +
                label +
                " on a live " +
                row.marketplace +
                " listing: " +
                (total - held) +
                " of this set's " +
                total +
                ' drops are reserved as "' +
                otherTag +
                '"' +
                (rivalName ? " for " + rivalName : "") +
                " — the same drops are committed twice, so whichever sells " +
                "first leaves the other buyer with nothing."
              : kind === "released"
                ? "Account " +
                  label +
                  " on a live " +
                  row.marketplace +
                  " listing holds no reservation for this game's drops — " +
                  "they were released and could be sold again elsewhere."
                : "Account " +
                  label +
                  " on a live " +
                  row.marketplace +
                  " listing covers only " +
                  held +
                  " of this set's " +
                  total +
                  " drops — the set gained drops after the unit was " +
                  "reserved." +
                  (absent
                    ? " " +
                      absent +
                      " of them were never farmed on this account, so a " +
                      "buyer would not receive them; the rest can be " +
                      "re-reserved."
                    : " Re-reserve to cover the whole set, or they could be " +
                      "sold again elsewhere."),
        });
      }

      // 3. Redeemed drops: the set's items are already connected on this
      // account, so they can no longer be delivered to anyone new.
      if (!redeemed) continue;
      const delivered = redeemed.delivered;
      await flag({
        type: "redeemed-drops",
        severity: delivered ? "low" : "high",
        marketplace: row.marketplace,
        listing: row._id,
        accountId: accId,
        accountLogin: (acc && acc.login) || "",
        dedupeKey: "redeemed:" + accId + ":" + row._id,
        message:
          "Account " +
          label +
          " in a live " +
          row.marketplace +
          " listing already redeemed: " +
          redeemed.items.slice(0, 5).join(", ") +
          (delivered
            ? " — likely a completed sale (the buyer connected it). Only " +
              "act if this unit was never sold."
            : " — the buyer could not redeem these. Replace the account or " +
              "delist."),
      });
    }
  }

  // 4. Drops reserved for a set that no longer exists. Every release is keyed
  // on soldSetId, so once the set is gone nothing can ever hand these back:
  // they read as unavailable to every listing, forever, and until now did so
  // completely silently. Reporting is all the guardian may do — a reservation
  // looks the same whether the unit is still on the shelf or already sold and
  // awaiting redemption, and freeing the latter would sell it twice.
  found += await reportOrphanedReservations(flag);
  return found;
}

// Reservations whose set has been deleted, grouped by set: one finding each,
// carrying the count so the size of the frozen inventory is visible.
async function reportOrphanedReservations(flag) {
  const referenced = await DropLog.distinct("soldSetId", {
    soldAt: { $ne: null },
    connected: { $ne: true },
    soldSetId: { $nin: [null, ""] },
  });
  if (!referenced.length) return 0;
  const alive = new Set(
    (await DropSet.find({ _id: { $in: referenced } }, { _id: 1 }).lean()).map(
      (s) => String(s._id),
    ),
  );
  let n = 0;
  for (const id of referenced) {
    if (alive.has(String(id))) continue;
    const frozen = await DropLog.countDocuments({
      soldSetId: id,
      soldAt: { $ne: null },
      connected: { $ne: true },
    });
    if (!frozen) continue;
    await flag({
      type: "orphaned-reservation",
      // Unsellable stock, but nothing is being mis-delivered to a buyer.
      severity: "medium",
      marketplace: "",
      dedupeKey: "orphan-set:" + id,
      message:
        frozen +
        " unredeemed drop(s) are still reserved for a drop set that was " +
        "deleted (" +
        id +
        "). Nothing can sell or release them — the release path needs the " +
        "set that made the reservation. Recover them from the Drop Archive " +
        "once you have confirmed no buyer is waiting on them.",
    });
    n++;
  }
  return n;
}

// Consecutive passes on which a given GGSel offer needed re-activating. A
// healthy heal fires once and the offer stays active (entry deleted); an offer
// that GGSel keeps re-pausing climbs until it crosses the threshold and gets a
// finding instead of an endless run of "re-activated" log lines. Keyed by
// externalId and process-local — a restart re-learns the streak within a few
// passes, which is the right trade for not persisting churn to the DB.
const reactivateStreak = new Map();
const REACTIVATE_LOOP_THRESHOLD = 3;

// ------------------------------------------------------------------
// Auto-feed (Plati / GGSel quantity listings)
// ------------------------------------------------------------------

// Did the marketplace refuse the stock read outright, rather than merely
// answer with something we couldn't parse? A refusal is account-wide (the
// seller is blocked, the key was revoked or lost its rights), so it hits every
// listing on that market at once and only a human can clear it.
//
// The match is deliberately tight: it names the account-level failure modes
// (blocked seller, revoked/rights-less key, HTTP 401/403) and nothing else.
// In particular it does NOT match the generic "refused the read" prefix that
// digisellerProductStockDetailed prefixes onto EVERY unreadable-product error
// ("товар не найден" — a deleted SKU). One dead product is a single-listing
// problem, not an account outage, and treating it as a platform-wide refusal
// raised a "whole marketplace is down" finding off one stale SKU.
function platformRefusedRead(reason) {
  return /заблокирован|blocked|suspended|HTTP 401|HTTP 403|access denied|auth-0|недостаточно прав/i.test(
    String(reason || ""),
  );
}

// A finalize failure is recorded one-shot (it describes a moment, not a
// standing condition), so autoResolveStale never sweeps it — a single GGSel
// 504 left a high finding open indefinitely. A later finalize that actually
// succeeded is proof the offer is fine, so close it there, mirroring how a
// successful restock closes "restock-err:".
async function clearFinalizeFinding(row) {
  await AuditFinding.updateMany(
    { dedupeKey: "autosell-sync:" + row._id, status: "open" },
    {
      $set: {
        status: "resolved",
        resolution: "auto-resolved: a later finalize succeeded",
        resolvedAt: new Date(),
      },
    },
  );
}

// The reactivate-loop finding is raised from the self-heal branch, not from a
// check, so autoResolveStale never sweeps it: its type is "restock-failed"
// (not a CONDITION_TYPE) and its dedupeKey is "reactivate-loop:", not the
// "restock-empty:" prefix the sweep whitelists. Left to that, the finding
// would outlive the condition forever — the same immortal-finding bug already
// fixed twice in this file (the 504 "autosell-sync:" row, and the archived
// offer that produced 38 identical rows). So it is resolved explicitly, the
// way clearFinalizeFinding does, the moment a pass proves the offer is active.
//
// Resolving here rather than adding the prefix to autoResolveStale's $or is
// deliberate: feedOne() runs feedListing with a throwaway seenKeys Set and
// never calls autoResolveStale, so a sweep-based clear would leave the finding
// open on that path.
async function clearReactivateLoopFinding(row) {
  await AuditFinding.updateMany(
    {
      dedupeKey: "reactivate-loop:" + row._id,
      status: { $in: ["open", "needs-human"] },
    },
    {
      $set: {
        status: "resolved",
        resolution:
          "auto-resolved: the offer was found already active — GGSel is no " +
          "longer re-pausing it",
        resolvedAt: new Date(),
      },
    },
  );
}

async function feedListing(row, seenKeys, refusals) {
  const target = Number(row.qtyTarget) || 0;
  if (!target) return 0;
  let read;
  if (row.marketplace === "ggsel") {
    read = await mp.ggselOfferStockDetailed(row.externalId);
  } else if (row.marketplace === "digiseller") {
    read = await mp.digisellerProductStockDetailed(row.externalId);
  } else {
    return 0;
  }
  const remaining = read.stock;
  if (remaining === null) {
    const key = "stock:" + row._id;
    seenKeys.add(key);
    // A platform refusing the read outright (a blocked seller, a revoked key)
    // takes the WHOLE market offline, so it is reported once per marketplace
    // below rather than once per listing — one blocked seller raising a high
    // on each of 159 listings buries every other finding in the tab.
    if (refusals && platformRefusedRead(read.reason)) {
      const r = refusals.get(row.marketplace) || { n: 0, reason: read.reason };
      r.n++;
      refusals.set(row.marketplace, r);
    }
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
        " — auto-feed skipped this pass." +
        (read.reason ? " " + row.marketplace + " said: " + read.reason : ""),
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
          // A re-activation that has to happen again every pass is not a
          // heal, it is a loop: GGSel accepts batch_activate (HTTP 2xx) and
          // the offer is paused again by the next tick, so the "success" log
          // repeated forever and nothing ever escalated. Count consecutive
          // re-activations per offer and raise a finding once the same offer
          // needs it repeatedly — the heal keeps running, it just stops being
          // silent. The counter is cleared below the moment a pass finds the
          // offer already active.
          const n = (reactivateStreak.get(row.externalId) || 0) + 1;
          reactivateStreak.set(row.externalId, n);
          // Two independent signals that the activation isn't taking:
          //   - activationStuck: finalize re-read the offer right after
          //     batch_activate and it was STILL paused/draft. Direct proof,
          //     available on the very first pass.
          //   - n >= threshold: the offer went active but was paused again
          //     before the next tick. Only visible across passes.
          // Either one means the offer is off sale despite a "successful"
          // heal, so either one raises the finding.
          if (fin.activationStuck || n >= REACTIVATE_LOOP_THRESHOLD) {
            const key = "reactivate-loop:" + row._id;
            if (seenKeys) seenKeys.add(key);
            await upsertFinding({
              type: "restock-failed",
              severity: "medium",
              marketplace: row.marketplace,
              listing: row._id,
              dedupeKey: key,
              message: fin.activationStuck
                ? "ggsel offer " +
                  row.externalId +
                  " still reads " +
                  (fin.activationStatus || "paused/draft") +
                  " immediately after GGSel accepted the activate call, so it" +
                  " is stocked but off sale. GGSel is rejecting the activation" +
                  " without reporting an error — needs a look on the GGSel" +
                  " side." +
                  (fin.activationStatus === "draft"
                    ? " A draft offer was published but never went live at" +
                      " all, which usually means something incomplete on the" +
                      " listing itself (moderation, a missing required field)" +
                      " rather than anything this end can retry."
                    : "")
                : "ggsel offer " +
                  row.externalId +
                  " has needed re-activation on " +
                  n +
                  " consecutive passes — GGSel accepts the activate call but" +
                  " the offer keeps returning to paused, so it is off sale" +
                  " between passes. Needs a look on the GGSel side.",
            });
          }
        } else if (!fin.pending) {
          // Verified active: finalize read the offer, found it neither paused
          // nor draft, and had nothing to re-activate. Whatever was pausing it
          // has stopped, so drop the streak and close any standing finding.
          //
          // The !fin.pending guard matters. reactivated is ALSO false on the
          // pending early return, where finalize saw in_stock_products_count
          // <= 0 and returned WITHOUT ever reading offer.status. That is not
          // evidence of health. And the two stock reads disagree by design:
          // the upstream gate uses ggselStockField, which prefers
          // in_stock_splitted_products_count on a splitted offer, while
          // finalize reads only in_stock_products_count. So a splitted offer
          // can be stocked upstream, reach this branch, come back pending, and
          // — without this guard — wipe its streak every pass, making the loop
          // detection permanently unreachable for that whole class of offer.
          reactivateStreak.delete(row.externalId);
          await clearReactivateLoopFinding(row);
        }
        if (!fin.pending) await clearFinalizeFinding(row);
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
    // Say WHICH kind of empty. Reporting "no unsold account holds this
    // bundle" when 15 accounts hold it and are merely suspended sends the
    // owner off to farm drops they already have.
    const reason = nothingToFeedReason(await censusForSet(set));
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
        (reason
          ? " — " + reason + "."
          : " but no unsold account holds this bundle — nothing to feed."),
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
      // Deliberately does NOT touch reactivateStreak. A re-activation here is
      // the expected end of a feed — enabling autoselling on a then-empty
      // offer pauses it, so the offer we just filled is *supposed* to need
      // activating, exactly once, right now. The streak counts the pathological
      // case instead: an offer needing re-activation on consecutive passes when
      // nothing fed it (the need <= 0 self-heal branch above). Counting this
      // call site would make every normal restock look like a loop; clearing it
      // would reset a genuine streak the moment a feed landed mid-loop.
      if (!fin.pending) await clearFinalizeFinding(row);
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
  // What the healer repaired by itself. Reported separately from the findings
  // digest so "fixed itself" never reads as "needs your attention"; anything it
  // gave up on is called out, because those are the only ones left for a human.
  if (
    freshHeals &&
    (freshHeals.healed || freshHeals.parked || freshHeals.escalated)
  ) {
    const lines = (freshHeals.notes || [])
      .slice(0, NOTIFY_LINES)
      .map((n) => "• " + n);
    if ((freshHeals.notes || []).length > NOTIFY_LINES) {
      lines.push("…and " + (freshHeals.notes.length - NOTIFY_LINES) + " more");
    }
    await sendTelegram(
      "🔧 AUTO-HEAL fixed " +
        freshHeals.healed +
        " issue(s)" +
        (freshHeals.parked
          ? ", " + freshHeals.parked + " need(s) a human"
          : "") +
        (freshHeals.escalated
          ? ", " + freshHeals.escalated + " escalated (stuck)"
          : "") +
        "\n\n" +
        lines.join("\n"),
    );
  }
}

// A marketplace that refused every stock read is ONE problem — the account is
// blocked or the key is revoked — so it gets one high finding naming how much
// of the market it took down, instead of one per affected listing.
async function reportRefusals(refusals, seenKeys) {
  for (const [marketplace, r] of refusals) {
    const key = "platform-refused:" + marketplace;
    seenKeys.add(key);
    await upsertFinding({
      type: "stock-unknown",
      severity: "high",
      marketplace,
      dedupeKey: key,
      message:
        marketplace +
        " refused every stock read this pass (" +
        r.n +
        " listing(s) skipped) — " +
        r.reason +
        ". Auto-feed for this marketplace is down until the account is restored.",
    });
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
  freshHeals = null;
  try {
    const rows = await MarketplaceListing.find({
      status: "active",
      autoDeliver: true,
    })
      .limit(500)
      .lean();
    const seenKeys = new Set();
    const refusals = new Map();
    let fed = 0;
    for (const row of rows) {
      try {
        fed += await feedListing(row, seenKeys, refusals);
      } catch (e) {
        console.error("guardian feed error:", e.message);
      }
    }
    await reportRefusals(refusals, seenKeys);
    const found = await runChecks(rows, seenKeys);
    await autoResolveStale(seenKeys);
    // Repair what this pass (and earlier ones) turned up. Runs last so it acts
    // on a settled picture: conditions that cleared by themselves have already
    // been auto-resolved and are never "fixed" with needless marketplace calls.
    // Isolated because a healer failure must not cost us the pass's detection.
    let healResult = null;
    try {
      // Required lazily: guardianAutoHeal -> guardianFixes -> this module, so a
      // top-level require would be a cycle and hand the healer a half-built
      // exports object.
      const { healOpenFindings } = require("./guardianAutoHeal");
      healResult = await healOpenFindings();
    } catch (e) {
      console.error("guardian auto-heal error:", e.message);
    }
    const open = await AuditFinding.countDocuments({ status: "open" });
    lastRun = {
      at: startedAt,
      tookMs: Date.now() - startedAt.getTime(),
      listingsChecked: rows.length,
      accountsFed: fed,
      issuesDetected: found,
      openFindings: open,
      autoHealed: healResult ? healResult.healed : 0,
      autoHealFailed: healResult ? healResult.failed : 0,
      autoHealParked: healResult ? healResult.parked : 0,
      autoHealEscalated: healResult ? healResult.escalated || 0 : 0,
    };
    if (
      healResult &&
      (healResult.healed || healResult.parked || healResult.escalated)
    ) {
      freshHeals = healResult;
    }
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

module.exports = {
  runOnce,
  status,
  start,
  feedOne,
  classifyUnit,
  summarizeDrops,
  nothingToFeedReason,
  platformRefusedRead,
  CLAIM_TAGS,
};
