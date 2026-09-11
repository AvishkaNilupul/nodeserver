// What a pool account's Twitch inventory actually HOLDS, and what that means for
// whether it is fresh supply or somebody's farmed stock.
//
// WHY THIS EXISTS (2026-09-11)
// An Eldorado rent-farm buyer (order 7b34bc70, "Fortnite Twitch Drops Automatic
// Farming 1 Year") was handed mbryixwcgf as a clean, fresh account and found six
// Overwatch drops in it waiting to be claimed. It was one of the 500 web-token
// farm accounts: that farm watched drops to 100% but could never claim them, and
// after it was removed (2026-09-07) all 500 were re-imported into the pool on
// 2026-09-08 as `manual-import` — brand-new rows with no history at all.
//
// Every "has this account been used?" signal the pool had was a DB trace
// (BotAccount, DropLog, listings, farm tasks) and a re-import carries none. The
// one field that looks at Twitch, `dropCount`, counts CLAIMED rewards only
// (`inv.drops`). A drop watched to 100% and never claimed lives in
// `inv.inProgress`, which nothing recorded — so an account holding six sellable
// Overwatch items read `dropCount: 0` and passed as pristine.
//
// It costs more than the one sale. A CLAIMING bot — a renter/rent-farm stack or
// an auto-farm container — claims every claimable drop in an account the moment
// it starts, and a claimed Overwatch/R6/CoD item can no longer be sold. Measured
// on prod: 15 of those accounts went to an auto-farm Solasta II bot, which
// claimed 90 Overwatch items inside a minute; 33 more went to renter stacks.
//
// So this module decides two things from the LIVE inventory:
//   * does the account hold unclaimed farmed drops (stock)? If so it is held out
//     of the pool — every claim path requires `status: "available"`, so one
//     status flip protects auto-farm, farm2, rent-farm, renters and no-claim
//     alike, without touching each of their queries;
//   * is it FRESH (nothing claimed, nothing waiting to be claimed)? Only a fresh
//     account may be handed to a renter or a rent-farm buyer.
const AvailableAccount = require("../models/AvailableAccount");
const { recordPoolUsage } = require("./poolUsageLog");

// Written onto a held account's claimedNote. A PREFIX, because other code keys
// off note prefixes ("spent — ", "rented to", "recycled", "deployed to ") and
// this one must never be mistaken for any of them.
const STOCK_NOTE_PREFIX = "unclaimed stock — ";

function distinctGames(list) {
  const out = [];
  for (const d of list) {
    const g = String((d && d.game) || "").trim();
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

// Pure. `inv` is utils/twitchInventory.fetchInventory's result:
//   drops[]      rewards already claimed (what `dropCount` has always counted)
//   inProgress[] every time-based drop in a started campaign, with `percent`
//                and `claimed`; percent >= 100 && !claimed is farmed stock —
//                the exact rule unclaimedAutoList.sellableDropsFromNoClaimInv
//                sells by.
// Partial watch progress is deliberately NOT counted: it is not an item, and a
// claiming bot farming a different game does not destroy it.
function inventoryHoldings(inv) {
  const drops = inv && Array.isArray(inv.drops) ? inv.drops : [];
  const inProgress = inv && Array.isArray(inv.inProgress) ? inv.inProgress : [];
  const unclaimed = inProgress.filter(
    (d) => d && !d.claimed && Number(d.percent) >= 100,
  );
  return {
    claimed: drops.length,
    unclaimed: unclaimed.length,
    claimedGames: distinctGames(drops),
    unclaimedGames: distinctGames(unclaimed),
  };
}

function gamesSuffix(games) {
  return games && games.length ? " (" + games.join(", ") + ")" : "";
}

// Pure. Fresh = the buyer opens the Twitch inventory and finds nothing in it.
function freshnessVerdict(h) {
  if (!h) return { fresh: false, reason: "inventory not read" };
  if (h.unclaimed > 0) {
    return {
      fresh: false,
      reason:
        "holds " + h.unclaimed + " unclaimed farmed drop(s)" +
        gamesSuffix(h.unclaimedGames) + " — stock, not a fresh account",
    };
  }
  if (h.claimed > 0) {
    return {
      fresh: false,
      reason:
        "already has " + h.claimed + " claimed drop(s)" +
        gamesSuffix(h.claimedGames) + " — not a fresh account",
    };
  }
  return { fresh: true, reason: "" };
}

function stockNote(h) {
  return (
    STOCK_NOTE_PREFIX +
    h.unclaimed +
    " drop(s)" +
    gamesSuffix(h.unclaimedGames) +
    " held out of the pool until sold"
  ).slice(0, 200);
}

function isStockNote(note) {
  return String(note || "").startsWith(STOCK_NOTE_PREFIX);
}

// Take an AVAILABLE account holding unclaimed stock out of the pool. Guarded on
// `status: "available"` so it can never overwrite a claim another path just
// made (a rented, deployed or no-claim account keeps its own note). A
// hand-sold account is left alone: every claim path already refuses it, and
// what it holds went to its buyer, so "held until sold" would be a lie.
// Returns true only when this call actually held it.
async function holdForStock(id, h, { actor = "pool-check" } = {}) {
  if (!id || !h || !(h.unclaimed > 0)) return false;
  const note = stockNote(h);
  const r = await AvailableAccount.updateOne(
    { _id: id, status: "available", manualSold: { $ne: true } },
    { $set: { status: "claimed", claimedAt: new Date(), claimedNote: note } },
  );
  const held = !!(r && (r.modifiedCount || r.nModified));
  if (held) {
    await recordPoolUsage(id, {
      event: "held",
      actor,
      game: h.unclaimedGames[0] || "",
      note,
    });
  }
  return held;
}

function saveCounts(id, h) {
  return AvailableAccount.updateOne(
    { _id: id },
    { $set: { dropCount: h.claimed, unclaimedDropCount: h.unclaimed } },
  );
}

function requeueForCheck(id) {
  // Let the pool checker record it — it also tells a dead token apart from a
  // suspended account, which this read cannot.
  require("./accountPoolChecker").enqueue([id]);
}

// Live re-read right before a pool account is handed to a renter or a rent-farm
// buyer. The stored counts come from the pool checker's last look, which can be
// days old; this is the look that decides. Never throws. `code` says why an
// account was refused, so a caller can move on to the next candidate:
//   not_fresh      it holds drops (the finding is saved, and stock is held)
//   token_invalid  Twitch rejected the token (queued for a proper pool re-check)
//   unverifiable   the read failed — nothing is written, because a Twitch hiccup
//                  says nothing about the account
// `fetch` defaults to the real inventory read made from this server; it and the
// three side effects (`persist`, `hold`, `requeue`) are injectable for tests.
async function verifyFreshLive(doc, opts = {}) {
  const {
    fetch,
    actor = "fresh-check",
    persist = saveCounts,
    hold = holdForStock,
    requeue = requeueForCheck,
  } = opts;
  const read = fetch || require("./twitchInventory").fetchInventory;
  let inv;
  try {
    inv = await read(doc.clientSecret);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 160);
    if (e && e.code === "token_invalid") {
      try {
        requeue(doc._id);
      } catch {
        /* best effort */
      }
      return {
        fresh: false,
        code: "token_invalid",
        reason: "Twitch rejected the token just now (" + msg + ")",
      };
    }
    return {
      fresh: false,
      code: "unverifiable",
      reason: "could not read the Twitch inventory to confirm it is empty (" + msg + ")",
    };
  }
  const h = inventoryHoldings(inv);
  const v = freshnessVerdict(h);
  // Save what was just learned so the next pick skips it without another read.
  await Promise.resolve()
    .then(() => persist(doc._id, h))
    .catch(() => {});
  if (!v.fresh) {
    if (h.unclaimed > 0) {
      await Promise.resolve()
        .then(() => hold(doc._id, h, { actor }))
        .catch(() => {});
    }
    return { fresh: false, code: "not_fresh", reason: v.reason, holdings: h };
  }
  return { fresh: true, code: "", reason: "", holdings: h };
}

// Walk `candidates` in order and hand the first `want` that `place` accepts.
// `place` runs the live freshness check itself (movePoolAccountToRenter does),
// and a refusal for a reason that is about THAT account moves on to the next
// one instead of leaving the order short:
//   no longer available / claimed_elsewhere / not_fresh / token_invalid → next
//   unverifiable → next, but stop after `maxUnreadable` of them: Twitch is
//     probably down and hammering it account by account helps nobody
//   anything else (a stack write, capacity, a host) → counts as one of the
//     `want` attempts, exactly as before, so a failing host is not retried
//     against every account in the pool.
// `budget` caps how many accounts get a live read in one call.
async function placeFirstFresh(
  candidates,
  { want, recheck, place, budget, maxUnreadable = 3 } = {},
) {
  const n = Math.max(0, Math.floor(Number(want) || 0));
  const cap = Math.max(1, Math.floor(Number(budget) || Math.max(10, n * 4)));
  const added = [];
  const skipped = [];
  let failed = 0;
  let tried = 0;
  let unreadable = 0;
  const NEXT = new Set(["not_fresh", "token_invalid", "claimed_elsewhere"]);
  for (const doc of candidates || []) {
    if (added.length + failed >= n) break;
    const username = (doc && doc.username) || "";
    if (tried >= cap) {
      skipped.push({
        username: "(stopped)",
        reason:
          "checked " + tried + " account(s) live and stopped there; the rest " +
          "wait for the next attempt",
      });
      break;
    }
    const fresh = recheck ? await recheck(doc) : doc;
    if (!fresh || fresh.status !== "available") {
      skipped.push({ username, reason: "no longer available" });
      continue;
    }
    tried++;
    try {
      added.push(await place(fresh));
    } catch (e) {
      skipped.push({ username, reason: (e && e.message) || String(e) });
      const code = e && e.code;
      if (NEXT.has(code)) continue;
      if (code === "unverifiable") {
        unreadable++;
        if (unreadable >= maxUnreadable) break;
        continue;
      }
      failed++;
    }
  }
  return { added, skipped };
}

module.exports = {
  STOCK_NOTE_PREFIX,
  inventoryHoldings,
  freshnessVerdict,
  stockNote,
  isStockNote,
  holdForStock,
  verifyFreshLive,
  placeFirstFresh,
};
