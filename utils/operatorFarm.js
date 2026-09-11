// Operator self-farm: take a PRISTINE account out of the pool and put it to work
// farming one named game for a fixed window — the operator's own accounts, not a
// paying renter's.
//
// WHY IT LIVES HERE
// Two existing renter paths each solve half of this and neither solves it alone:
//   * `POST /renters/:id/accounts/from-pool` auto-picks pristine, unentangled
//     pool accounts (utils/renterPoolEligibility) — but pins them to the
//     renter's DEFAULT games and sets no farming window.
//   * `POST /renters/:id/accounts` (quick:true) sets a specific game + window —
//     but the caller must already hold the username/token/password.
// This module composes the two. It does NOT reimplement either: it calls the
// same `gatherPoolEligibility` / `movePoolAccountToRenter` helpers the routes
// use, so every safety property they carry (claim-before-place, release-on-
// failure, auto-farm detachment, capacity assert, atomic config write) holds
// here unchanged.
//
// SELF-TERMINATING BY CONSTRUCTION
// The window is stamped as `RenterAccount.farmUntil`, which utils/renterExpiry
// already sweeps ("pull just the lapsed account"). So "farm Apex for 180 days"
// tears itself down on day 180 with no new machinery and no scheduler.
//
// THE HOLDER RENTER
// Self-farmed accounts hang off ONE reserved internal renter so they reuse all
// the lease/teardown plumbing while staying clearly separate from real paying
// renters. It is created with `accessEnd: null`, and utils/renterExpiry only
// expires renters whose accessEnd is non-null — so the holder itself is never
// torn down; only its individual accounts lapse on their own windows.
//
// CREDENTIALS ARE NOT RETURNED HERE. This returns logins only. The password is
// read separately by the operator's own authenticated browser via the existing
// `GET /account-pool/:id/password` (superadmin), so account passwords never pass
// through an LLM's context or a third-party model provider.
const Renter = require("../models/Renter");
const RenterAccount = require("../models/RenterAccount");
const AvailableAccount = require("../models/AvailableAccount");
const hosts = require("./botHosts");
const crypto = require("crypto");
const { pickCount } = require("./renterPoolEligibility");
const { placeFirstFresh } = require("./poolStock");
const { normGame } = require("./gameLabel");
const { createRenter } = require("./renters");
const { logEvent } = require("./systemLog");

// The reserved holder. Chosen to be obviously internal and unlikely to collide
// with a real renter username.
const OPERATOR_USERNAME = "operator-selffarm";
const OPERATOR_MAX_ACCOUNTS = 200;

// Lazy requires: these live on the renter-admin router (attached to its exports)
// and on the bot-config router. Requiring them at call time keeps module load
// order irrelevant and avoids any circular-require surprise at boot.
function renterAdmin() {
  return require("../routes/renterAdminRoutes");
}
function botConfig() {
  return require("../routes/botConfigRoutes");
}

// True when this pool row was already sold on the game we are about to farm.
function spentOnGame(account, game) {
  const want = normGame(game);
  if (!want) return false;
  return (Array.isArray(account && account.soldGames) ? account.soldGames : [])
    .map(normGame)
    .filter(Boolean)
    .some((sold) => sold === want || sold.includes(want) || want.includes(sold));
}

// Find (or create) the internal holder renter, and make sure it has a bot slot.
// Idempotent: safe to call on every request.
async function ensureOperatorRenter({ actor = "operator-farm" } = {}) {
  let renter = await Renter.findOne({ usernameLower: OPERATOR_USERNAME });
  if (!renter) {
    // A long random password: this account is a container for self-farmed
    // accounts, never a login. It is stored hashed (and encrypted, like every
    // renter) so the operator could still reveal it if they ever wanted to.
    const password = crypto.randomBytes(24).toString("base64url");
    await createRenter({
      username: OPERATOR_USERNAME,
      password,
      displayName: "Operator (self-farm)",
      createdBy: actor,
      maxAccounts: OPERATOR_MAX_ACCOUNTS,
      // accessEnd null => utils/renterExpiry never expires the holder itself.
      accessEnd: null,
      notes:
        "Internal holder for the operator's own self-farmed pool accounts " +
        "(utils/operatorFarm.js). Not a paying renter. Individual accounts " +
        "lapse on their own farmUntil window; this renter never expires.",
    });
    renter = await Renter.findOne({ usernameLower: OPERATOR_USERNAME });
    logEvent({
      category: "renter",
      action: "operator_renter_created",
      actor,
      subject: OPERATOR_USERNAME,
      detail: "internal holder for operator self-farming",
    });
  }
  if (!renter) throw new Error("Could not create the operator holder renter");

  // Needs a bot slot to farm on. Reuses the same stack picker the Quick-farm
  // auto-assign uses, so capacity rules are identical.
  if (!renter.botFile) {
    const stack = await renterAdmin().availableRentalStack();
    if (!stack) {
      const e = new Error(
        "No rental bot stack has room right now — free a slot or raise a stack's capacity.",
      );
      e.status = 409;
      throw e;
    }
    renter.botHost = stack.host;
    renter.botFile = stack.file;
    renter.botStoppedAt = null;
    await renter.save();
  }
  return renter;
}

// Make sure the holder is sitting on a stack that can actually take `needed`
// more accounts, moving it to one that can if not.
//
// This is the fix for the failure that cancelled Eldorado order e69b19d3 (Black
// Desert, 1 Year). A stack is chosen ONCE, when `botFile` is first empty, and
// was then never re-examined — so the holder stayed pinned to config_31.json
// long after it filled. Capacity is asserted against the LIVE config at write
// time, deep inside movePoolAccountToRenter, so the order failed at the last
// possible moment with "Rental stack capacity exceeded (10/10)" while six other
// stacks sat on 137 free slots the holder structurally could not reach.
//
// Raising a capacity only moves that wall. Re-checking here removes it: the
// holder follows the free space.
//
// Repointing is safe for accounts already placed. Every RenterAccount carries
// its OWN `configFile`, and utils/renterExpiry removes a lapsed lease using
// `a.configFile` — never the renter's current `botFile` — so previously placed
// accounts keep expiring out of the config they actually live in.
async function ensureStackWithRoom(renter, needed, actor = "operator-farm") {
  const want = Math.max(1, Math.floor(Number(needed) || 1));
  const { bots = [], offlineHosts = [] } = await renterAdmin().rentalStackOptions();
  const key = (h, f) => String(h || "local") + "|" + String(f || "");
  const current = bots.find((b) => key(b.host, b.file) === key(renter.botHost, renter.botFile));

  if (current && Number(current.remaining) >= want) {
    return { renter, stack: current, moved: false };
  }

  // An unreadable host is not a full stack. Saying "no room" because the Pi
  // blinked would take offers off sale for a network hiccup, so the distinction
  // is kept in the error the caller surfaces.
  const target = renterAdmin().chooseStackWithRoom(bots, want);
  if (!target) {
    const detail = current
      ? "the holder's stack " + renter.botFile + " is full (" +
        current.accounts + "/" + current.capacity + ")"
      : "the holder's stack " + renter.botFile + " could not be read";
    const e = new Error(
      "No rental bot stack has room for " + want + " more account(s) — " + detail +
        " and no other stack has a free slot" +
        (offlineHosts.length
          ? " (host(s) offline and therefore unusable: " +
            offlineHosts.map((h) => h.label || h.id).join(", ") + ")"
          : "") +
        ". Raise a stack's capacity or free a slot.",
    );
    e.status = 409;
    e.code = "no_stack_room";
    e.offlineHosts = offlineHosts.map((h) => h.id);
    throw e;
  }

  const from = renter.botFile;
  renter.botHost = target.host;
  renter.botFile = target.file;
  renter.botStoppedAt = null;
  await renter.save();
  logEvent({
    category: "renter",
    action: "operator_stack_moved",
    actor,
    subject: OPERATOR_USERNAME,
    detail:
      "holder moved from " + (from || "(none)") + " to " + target.host + "/" +
      target.file + " (" + target.remaining + " slot(s) free) — previous stack full",
  });
  return { renter, stack: target, moved: true };
}

// Read-only: what WOULD happen, without touching anything. Lets the coworker
// (or the UI) check availability before committing.
async function previewFreshAccounts({ count = 1 } = {}) {
  const renter = await Renter.findOne({ usernameLower: OPERATOR_USERNAME });
  // The stack is the constraint that actually bit, and the one this preview used
  // to be blind to — it answered `willAdd: 1` while config_31.json was at 10/10
  // and every order was failing. A preflight that cannot see the real limit is
  // worse than none, because it is believed.
  let stack = null;
  let stackRoom = 0;
  let offlineHosts = [];
  try {
    const opts = await renterAdmin().rentalStackOptions();
    offlineHosts = (opts.offlineHosts || []).map((h) => h.label || h.id);
    const key = (h, f) => String(h || "local") + "|" + String(f || "");
    const cur = renter
      ? (opts.bots || []).find((b) => key(b.host, b.file) === key(renter.botHost, renter.botFile))
      : null;
    const best = renterAdmin().chooseStackWithRoom(opts.bots || [], 1);
    stack = cur && Number(cur.remaining) > 0 ? cur : best || cur;
    stackRoom = Math.max(0, Number(stack && stack.remaining) || 0);
  } catch (e) {
    stack = null;
    stackRoom = 0;
    offlineHosts = ["(stack read failed: " + e.message + ")"];
  }
  const used = renter
    ? await RenterAccount.countDocuments({ renter: renter._id })
    : 0;
  const quotaRemaining = renter
    ? Math.max(0, (Number(renter.maxAccounts) || 0) - used)
    : OPERATOR_MAX_ACCOUNTS;
  const { eligible } = await renterAdmin().gatherPoolEligibility();
  const willAdd = Math.min(
    stackRoom,
    pickCount({
      requested: Math.floor(Number(count) || 0),
      quotaRemaining,
      eligibleTotal: eligible.length,
    }),
  );
  return {
    eligibleTotal: eligible.length,
    quotaRemaining,
    stackHost: stack ? stack.host : null,
    stackFile: stack ? stack.file : null,
    stackUsed: stack ? stack.accounts : null,
    stackCapacity: stack ? stack.capacity : null,
    stackRoom,
    offlineHosts,
    blockedBy: willAdd > 0 ? null : (stackRoom <= 0 ? "stack-full" : (eligible.length ? "quota" : "no-eligible-accounts")),
    willAdd,
    holderExists: !!renter,
    preview: eligible.slice(0, willAdd).map((a) => ({
      username: a.username,
      lastCheckStatus: a.lastCheckStatus || "",
      dropCount: a.dropCount || 0,
    })),
  };
}

// Commit: claim `count` pristine pool accounts and start them farming `game`
// for `days` days. Returns the logins added (never passwords) plus the pool
// document ids, so the operator's browser can reveal credentials itself.
async function farmFreshAccounts({
  game,
  days,
  count = 1,
  actor = "operator-farm",
} = {}) {
  const gameName = String(game || "").trim();
  if (!gameName) throw badRequest("A game is required (e.g. 'Apex Legends').");
  const nDays = Math.floor(Number(days));
  if (!Number.isFinite(nDays) || nDays <= 0) {
    throw badRequest("A positive farming window in days is required.");
  }
  const want = Math.floor(Number(count) || 0);
  if (!(want > 0)) throw badRequest("count must be a positive number.");

  const renter = await ensureOperatorRenter({ actor });
  // Re-check capacity EVERY time, and follow the free space if the holder's
  // stack has filled up since it was chosen. Without this the whole provision
  // runs — pool query, eligibility, claim — only to die at the config write.
  const { stack: targetStack } = await ensureStackWithRoom(renter, want, actor);
  const host = hosts.resolveHost(renter.botHost);
  if (!host) throw badRequest("The holder renter's host is unknown.");

  const used = await RenterAccount.countDocuments({ renter: renter._id });
  const quotaRemaining = Math.max(0, (Number(renter.maxAccounts) || 0) - used);
  if (quotaRemaining <= 0) {
    throw conflict(
      "The operator holder is at its account limit (" + renter.maxAccounts + ").",
    );
  }

  const { eligible: pristine } = await renterAdmin().gatherPoolEligibility();
  // A recycled account carries the games it was already sold on (soldGames) and
  // must never farm one of them again — the buyer still holds that login, so a
  // second sale of the same game would hand two people the same drops. Every
  // other claim path enforces this (autoFarmer.claimPoolAccounts,
  // farm2/steps/decide, noclaim readyPoolQuery); gatherPoolEligibility cannot,
  // because it does not know the game, so the exclusion belongs here. Substring
  // semantics match the no-claim exclusion, so "rainbow six" also blocks an
  // account spent on "rainbow six siege".
  const eligible = pristine.filter((a) => !spentOnGame(a, gameName));
  // Three independent ceilings, and the stack is the one that used to be
  // invisible: pool supply, the holder's own quota, and the physical slots left
  // in the bot config we are about to write to.
  const stackRoom = Math.max(0, Number(targetStack && targetStack.remaining) || 0);
  const n = Math.min(
    stackRoom,
    pickCount({ requested: want, quotaRemaining, eligibleTotal: eligible.length }),
  );
  if (n <= 0) {
    throw conflict(
      eligible.length
        ? "No quota room to add accounts."
        : "No eligible pristine pool accounts right now (need: available, " +
            "verified token, has password, no drops in it (claimed or " +
            "unclaimed), not deployed/sold/listed/assigned, and not already " +
            "sold on this game).",
    );
  }

  const farmUntil = new Date(Date.now() + nDays * 86400000);
  const move = renterAdmin().movePoolAccountToRenter;

  // movePoolAccountToRenter re-reads each account's Twitch inventory live and
  // refuses one that holds anything — the buyer is promised a clean, empty
  // account. placeFirstFresh then moves on to the next eligible account rather
  // than leaving a paid order short, and re-validates each at move time to
  // close the select→move race, exactly as the from-pool route does.
  const { added, skipped } = await placeFirstFresh(eligible, {
    want: n,
    recheck: (doc) => AvailableAccount.findById(doc._id).lean(),
    place: async (fresh) => {
      const login = await move(renter, host, fresh, {
        games: [gameName],
        farmUntil,
      });
      return { login, poolId: String(fresh._id) };
    },
  });

  // Restart the holder's bot once so it picks up the new accounts (best effort:
  // a stopped bot stays stopped until the operator starts it).
  let restarted = false;
  if (added.length) {
    try {
      const { containerForFile, restartConfigContainer } = botConfig();
      const container = containerForFile(renter.botFile);
      const states = await hosts.dockerPs(host);
      const st = container && states[container];
      if (st && st.state === "running") {
        await restartConfigContainer(host, renter.botFile);
        restarted = true;
      }
    } catch {
      /* best effort */
    }
  }

  if (added.length) {
    logEvent({
      category: "renter",
      action: "operator_selffarm_started",
      actor,
      subject: gameName,
      count: added.length,
      detail:
        "self-farm " +
        added.length +
        " account(s) on " +
        gameName +
        " for " +
        nDays +
        "d (until " +
        farmUntil.toISOString().slice(0, 10) +
        ")",
    });
  }

  return {
    game: gameName,
    days: nDays,
    farmUntil,
    added,
    skipped,
    restarted,
    host: renter.botHost,
    botFile: renter.botFile,
    renterId: String(renter._id),
    // How the operator gets the credentials — deliberately NOT returned here.
    credentialsVia: added.map((a) => `GET /account-pool/${a.poolId}/password`),
  };
}

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}
function conflict(msg) {
  const e = new Error(msg);
  e.status = 409;
  return e;
}

module.exports = {
  OPERATOR_USERNAME,
  OPERATOR_MAX_ACCOUNTS,
  ensureOperatorRenter,
  ensureStackWithRoom,
  previewFreshAccounts,
  farmFreshAccounts,
};
