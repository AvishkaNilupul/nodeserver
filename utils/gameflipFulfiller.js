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

// Account listings (docs/ACCOUNT-LISTINGS-CONTRACT.md). A plain model with no
// requires of its own, so it is safe beside the others; utils/suppliedStock is
// required lazily inside the functions that use it instead, because it reaches
// back into the listing/guardian side of the tree and this file is already the
// wrong end of one real require cycle (see the autoLister note below).
const AccountOffer = require("../models/AccountOffer");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const { loginsOnActiveListings, notListed } = require("./listedLogins");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const mp = require("./marketplaces");
// Module-level, not lazy: gameflipFarmService's own top-level closure is 23
// modules (models, marketplaces, operatorFarm, rentFarmCapacity, setImage,
// botHosts …) and gameflipFulfiller is in none of them — its only reference to
// this file is in comments, and the one path that reaches back here
// (operatorFarm -> routes/renterAdminRoutes -> listingDetach) is a lazy require
// inside a function, so it never runs at load time. That is checked, not
// assumed: the lazy `require("./autoLister")` further down exists because
// autoLister DOES require this file at module level, and that cycle is real.
const gfFarm = require("./gameflipFarmService");
const { decrypt } = require("./secretBox");
const { buildSetGridImage, buildPromoCoverImage } = require("./setImage");
const { recordListingSale } = require("./saleLearning");
const { gameflipGone } = require("./gameflipGone");
const { sendTelegram } = require("./telegram");
const {
  reserveSetOnAccount,
  releaseAccountsForTag,
  releaseSetForAccounts,
} = require("./dropReservation");

const GF_CLAIM_TAG = "gameflip";

// Gameflip refuses a delivery code that one of our listings still holds ("code
// for digital goods already exists"), and the code is nothing but the account's
// login and password (gameflipDeliveryCode). A SOLD listing keeps its code for
// good, so an account already sold here once can never be listed here again
// with the same password — while the per-game reservation keeps its other
// games in stock, and leanest-first puts exactly those accounts at the FRONT
// (their sold drops no longer count). On 2026-10-01 the Hunt: Showdown renewal
// (187 units owed) picked one of them on every attempt and failed eight times
// in a row, with 119 accounts Gameflip would take queued behind it.
//
// A holder the database cannot name — a half-built draft whose discard the
// limiter swallowed — is learned from the refusal itself and skipped for a
// day, so the next attempt tries someone else instead of the same account.
const CODE_REFUSED_TTL_MS = 24 * 60 * 60 * 1000;
const codeRefusedAt = new Map(); // lower-case login -> ms Gameflip refused its code
const CODE_EXISTS_RE = /code for digital goods already exists/i;

// Remember `login` when `err` is Gameflip refusing its code. Every publish path
// that puts an account's code on Gameflip calls this from its failure path.
function noteIfCodeRefused(login, err) {
  const l = String(login || "").toLowerCase();
  if (l && CODE_EXISTS_RE.test(String((err && err.message) || err || ""))) {
    codeRefusedAt.set(l, Date.now());
  }
}

// An auto-lister head row names its WHOLE Gameflip share (accountLogin = every
// share login, autoLister.listActivatedTask), yet only ONE of those accounts'
// code went out on it: the one it reserved for the set. Reading every name as
// held fenced 47 accounts off Gameflip whose codes were never there (27 sold
// head rows, measured 2026-10-02). So per row: the named accounts holding a
// gameflip reservation on its set, or — none found — the first name (true on
// 25 of those 27). Lower-case logins out.
async function codeLoginsOfShareRows(shareRows) {
  const out = new Set();
  if (!shareRows.length) return out;
  const reservedBySet = new Map(); // set id -> Set(lower login)
  try {
    const names = [...new Set(shareRows.flatMap((r) => r.logins))];
    const accounts = await BotAccount.find({ login: { $in: names } }, { login: 1 }).lean();
    const loginOf = new Map(accounts.map((a) => [String(a._id), String(a.login).toLowerCase()]));
    const reserved = await DropLog.find(
      {
        account: { $in: accounts.map((a) => a._id) },
        soldToUsername: GF_CLAIM_TAG,
        soldAt: { $ne: null },
      },
      { account: 1, soldSetId: 1 },
    ).lean();
    for (const d of reserved) {
      const key = String(d.soldSetId || "");
      if (!reservedBySet.has(key)) reservedBySet.set(key, new Set());
      reservedBySet.get(key).add(loginOf.get(String(d.account)));
    }
  } catch (e) {
    console.error("gameflip: reservation read for the code check failed:", e.message);
  }
  for (const r of shareRows) {
    const onSet = reservedBySet.get(r.set);
    const hits = r.logins.filter((l) => onSet && onSet.has(l.toLowerCase()));
    for (const l of hits.length ? hits : r.logins.slice(0, 1)) out.add(l.toLowerCase());
  }
  return out;
}

// Logins whose code a Gameflip listing of ours still holds. A failed read holds
// nothing back: the claim then behaves exactly as it did before this check —
// unless the caller asks `strict`, for which a failed read THROWS (a caller
// about to put an auto-farm account's login on Gameflip under a differently
// worded code: for it, "not known" must be "no").
async function gameflipCodeHeldLogins({ strict = false } = {}) {
  const held = new Set();
  const now = Date.now();
  for (const [l, at] of codeRefusedAt) {
    if (now - at < CODE_REFUSED_TTL_MS) held.add(l);
    else codeRefusedAt.delete(l);
  }
  try {
    const rows = await MarketplaceListing.find(
      { marketplace: "gameflip", status: "sold", autoDeliver: true },
      { accountLogin: 1, set: 1 },
    ).lean();
    const shareRows = [];
    for (const r of rows) {
      const logins = String(r.accountLogin || "").split(/[,\s]+/).filter(Boolean);
      if (logins.length === 1) held.add(logins[0].toLowerCase());
      else if (logins.length > 1) shareRows.push({ set: String(r.set || ""), logins });
    }
    for (const l of await codeLoginsOfShareRows(shareRows)) held.add(l);
  } catch (e) {
    console.error("gameflip: sold-listing read for the code check failed:", e.message);
    if (strict) throw e;
  }
  return held;
}

// Reserve this set's drops (per game) on an account that holds the whole
// bundle, so a Shop buyer and a Gameflip listing can never get the same drops
// while the account's other games stay sellable. Returns the account doc.
// `info`, when given, is filled with { codeHeld, left }: how many holders were
// skipped because Gameflip holds their code, and how many were left to try.
async function claimAccountForSet(set, info = null) {
  let candidates = await availableAccountsForSet(set);
  // Skip accounts already attached to another active listing (as its
  // auto-delivery account or a fed Plati/GGSel unit): the buyer gets the whole
  // account, so its other listing's promised drops would ship with it. One
  // implementation for every claimer (utils/listedLogins.js).
  candidates = notListed(candidates, await loginsOnActiveListings());
  // And accounts Gameflip would refuse (see CODE_REFUSED_TTL_MS above).
  const held = await gameflipCodeHeldLogins();
  const before = candidates.length;
  candidates = candidates.filter(
    (c) => !held.has(String((c && c.login) || "").toLowerCase()),
  );
  if (info) {
    info.codeHeld = before - candidates.length;
    info.left = candidates.length;
  }
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

// Put THIS SET's reserved drops back in the sellable pool.
//
// Keyed on the SET, not merely on the market tag. The old version called
// `releaseAccountsForTag([accountId], "gameflip")`, which clears EVERY DropLog
// row on that account whose soldToUsername is "gameflip" — and one account can
// legitimately hold two Gameflip reservations at once: an Overwatch bundle
// already delivered to a buyer, and a Rainbow Six bundle just claimed for a
// relist. The account is eligible for the second because the first row is
// "sold", so it has dropped out of loginsOnActiveListings.
//
// Then gameflipPublish throws — a 429 from Gameflip's silent rate limiter is the
// documented common case — and the release wiped BOTH sets. The Overwatch drops
// a buyer had already paid for went back into the sellable pool, and the next
// claim sold them to a second buyer. First to click Connect wins; the other gets
// an account whose items are gone.
//
// utils/autoLister.releaseReservedForSet has always done this correctly, with a
// comment naming this exact hazard ("can never overreach into another set the
// same account may be reserved for under the same tag"). This path simply never
// adopted it.
async function releaseAccount(accountId, setId) {
  if (!accountId) return;
  if (!setId) {
    // Nothing to scope the release to. A tag-wide release could free drops a
    // buyer already owns, so refuse: a leaked reservation costs a sale and is
    // fixable by hand, a double-sold account is neither.
    console.error(
      "gameflip releaseAccount: refusing to release account " +
        accountId +
        " with no set id — a tag-wide release can free drops a buyer already " +
        "paid for. The reservation is left in place for manual review.",
    );
    return;
  }
  await releaseSetForAccounts([String(accountId)], String(setId), GF_CLAIM_TAG);
}

// The rent-farm sibling of the release above, for a BUFFERED offer.
//
// A buffered row is not stock: it carries ONE pristine pool account and no
// DropSet at all (utils/gameflipFarmService creates it with `set` unset and
// `accountId` unset — only `rentFarmPoolId`). So the DropSet-scoped release
// would hit its own `if (!setId)` refusal and log instead of releasing, and the
// `row.accountId` guard on both retire paths means it would not even be
// reached. Either way the account is LEAKED: nothing revisits a retired row —
// the watcher reads `status: "active"` only — so it stays out of the pool AND
// holds a rental slot, farming for nobody. That leak is what lost the slots
// behind order 4b20765f, and it is non-negotiable 5 of the contract.
//
// Best-effort, matching the release calls it sits beside: the row is already
// terminal by the time this runs, and a hand-back that fails puts the pool id
// back on the row for gameflipFarmService's stranded-row sweep to retry.
async function releaseBufferedRow(row, reason, opts = {}) {
  try {
    const r = await gfFarm.releaseBuffered(row, { reason, ...opts });
    if (!r || !r.released) {
      // A refusal here is not noise. "Nothing happened" with no reason is how a
      // leaked pristine account stays invisible for weeks.
      console.error(
        "gameflip rent-farm release did not fire for listing " +
          (row.externalId || row._id) +
          ": " +
          ((r && (r.skipped || r.error)) || "no answer"),
      );
    }
  } catch (e) {
    console.error(
      "gameflip rent-farm release threw for listing " +
        (row.externalId || row._id) +
        ":",
      e.message,
    );
  }
}

// `opts.unclaimed`: an auto-farm account sold for its UNCLAIMED drops — the
// buyer connects first, then claims (utils/farmHandover.UNCLAIMED_CODE_STEPS,
// never longer than the steps below). Without it the code is, byte for byte,
// what it always was: Gameflip refusing a code it has already seen is the
// last guard against listing one login twice, and that guard is the text.
function gameflipDeliveryCode(login, password, opts = {}) {
  const steps = require("./farmHandover");
  return (
    "TWITCH DROP ACCOUNT\n\n" +
    "Login: " +
    login +
    "\nPassword: " +
    password +
    "\n\n" +
    (opts && opts.unclaimed ? steps.UNCLAIMED_CODE_STEPS : steps.CLAIMED_CODE_STEPS) +
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
      {
        $match: {
          account: accountId,
          connected: { $ne: true },
          // An expired drop can't be connected, so never advertise it.
          ...require("./dropReservation").notExpiredMatch(),
        },
      },
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
    // A set spanning several games (a whole-account bundle) is not "<game>
    // Twitch Drops": the house title names only the first item's game over the
    // WHOLE count — "Rocket League Twitch Drops (58 Items)" for an account with
    // 22 Rocket League drops. Keep the caller's title instead (the set name on
    // publish, the previous unit's title on relist); the description still
    // lists every item with its game.
    const multiGame =
      new Set(items.map((i) => i.game).filter(Boolean)).size > 1;
    return {
      title:
        multiGame && fallbackTitle
          ? fallbackTitle
          : buildTitle({ game: primaryGame, items }),
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
  offer,
  title,
  description,
  priceUsd,
  imagePath,
  qtyRemaining,
  origin,
  noclaim,
}) {
  // An account listing carries no DropSet at all, and nothing below applies to
  // one. Routed out whole rather than branched through, so a row without an
  // `offer` behaves byte-for-byte as it did before this mode existed.
  if (offer) {
    return publishSuppliedAutoDelivery({
      offer,
      title,
      description,
      priceUsd,
      imagePath,
      qtyRemaining,
    });
  }
  // A set can carry a price floor the owner set by hand. Relists inherit the
  // price of the row that sold, and the auto-lister derives its own from live
  // competition, so without this a floored bundle drifts back down to the
  // market price on the next unit.
  const floor = Number(set && set.minPriceUsd) || 0;
  if (floor > 0 && (Number(priceUsd) || 0) < floor) priceUsd = floor;
  // No-claim Shop listings (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8a): the
  // stock is the no-claim farm's UNCLAIMED drops, so this is decided before
  // claimAccountForSet can run — the Drop Archive holds only claimed drops,
  // which are worthless to a buyer who was promised unclaimed ones. Either
  // signal routes it out: the caller's flag (a no-claim row's own
  // `noclaimStock` on relist) or the set's stockSource, so a set that somehow
  // lost its flag still can never relist a no-claim chain out of the archive.
  if (noclaim || (set && set.stockSource === "noclaim")) {
    return publishNoclaimAutoDelivery({
      set,
      title,
      description,
      priceUsd,
      imagePath,
      qtyRemaining,
      origin,
    });
  }
  const claim = {};
  const account = await claimAccountForSet(set, claim);
  if (!account) {
    // Still "Out of stock" first, so every out-of-stock path (backoff, the one
    // alert) treats it the same — but say when the accounts exist and it is
    // Gameflip refusing them, or the owner goes looking for stock that is there.
    throw new Error(
      claim.codeHeld && !claim.left
        ? "Out of stock — every account that holds this whole bundle (" +
            claim.codeHeld + ") was already sold on Gameflip, and Gameflip " +
            "refuses the same login twice"
        : "Out of stock — no unsold account holds this whole bundle, " +
            "so there is nothing to auto-deliver",
    );
  }
  const login = account.login || account.credUsername || "";
  const password = decrypt(account.credPassword);
  if (!password) {
    await releaseAccount(account._id, set && set._id);
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
    await releaseAccount(account._id, set && set._id);
    noteIfCodeRefused(login, e);
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

// The account-listing half of publishAutoDelivery
// (docs/ACCOUNT-LISTINGS-CONTRACT.md): the stock is an explicit list of
// accounts the owner pasted in, held in models/SuppliedAccount, one account per
// listing. Its own lane rather than branches through the one above, because
// almost nothing above applies — there is no DropSet, no DropLog row and so no
// reservation to take (utils/dropReservation refuses any account without a
// DropLog row per itemKey, which is the whole reason supplied stock is a
// separate mode).
//
// It also must NOT regenerate the title and description. accountListingText
// rewrites both from the claimed account's real DropLog contents; a supplied
// account has none, so at best the rewrite silently falls back and at worst —
// if a pasted login collides with an archived one — the listing advertises
// somebody else's drops. Supplied stock is trusted, not verified: the owner's
// typed text IS the contract.
async function publishSuppliedAutoDelivery({
  offer,
  title,
  description,
  priceUsd,
  imagePath,
  qtyRemaining,
}) {
  const supplied = require("./suppliedStock");
  const offerId = offer && offer._id ? String(offer._id) : "";
  if (!offerId) throw new Error("This account listing has no id to sell from");
  // The owner's per-offer switch and the global one (utils/settings). Gameflip
  // delivery happens at PUBLISH — the credentials go into the listing's code
  // and Gameflip hands them over the instant somebody pays — so the kill
  // switch has to be honoured here or it does not cover Gameflip at all.
  // Both an explicit `false` and a `{ ok: false }` are read as a refusal;
  // anything else publishes, so a shape this file guessed wrong can only fail
  // open on the owner's own click, never gate a live listing by accident.
  const gate = await supplied.deliveryEnabled(offer);
  if (gate === false || (gate && gate.ok === false)) {
    throw new Error(
      "Account-listing delivery is switched off" +
        (gate && gate.reason ? " (" + gate.reason + ")" : ""),
    );
  }
  const floor = Number(offer.minPriceUsd) || 0;
  if (floor > 0 && (Number(priceUsd) || 0) < floor) priceUsd = floor;
  // Unique per ATTEMPT, never per offer. suppliedStock resumes rows already
  // carrying the orderId before it claims anything new, so a stable id would
  // hand the second unit of a relist chain the very account the first unit is
  // still selling.
  const orderId =
    "gameflip-publish:" +
    offerId +
    ":" +
    Date.now() +
    ":" +
    Math.random().toString(36).slice(2, 8);
  const claimed = await supplied.claimForListing({ accountOffer: offerId }, 1, {
    orderId,
    market: "gameflip",
  });
  // A short claim is not a success: claimForListing returns FEWER than asked
  // when stock runs out and the caller has to check the length itself.
  if (!claimed || !claimed.length) {
    throw new Error(
      "Out of stock — this account listing has no available account left to " +
        "auto-deliver",
    );
  }
  const acc = claimed[0];
  const ledgerIds = claimed.map((c) => c.ledgerId);
  const login = acc.login || "";
  // Refuse to sell credentials we cannot read. The archive lane above does the
  // same with its decrypted password: a listing published with a blank
  // password is a paid buyer holding half a login.
  if (!acc.password && !acc.clientSecret) {
    await supplied.releaseClaim(ledgerIds, { orderId });
    throw new Error(
      "Account " + (login || "(no login)") + " has no readable password — " +
        "cannot auto-deliver",
    );
  }
  // Awaited and stringified deliberately: gameflipPublish decides a listing is
  // auto-delivery by `typeof autoDeliverCode === "string"`, so handing it a
  // pending promise (or anything else) would quietly publish a listing with NO
  // delivery code — an offer that takes money and hands over nothing.
  const code = String((await supplied.deliveryText(acc, offer)) || "");
  if (!code.trim()) {
    await supplied.releaseClaim(ledgerIds, { orderId });
    throw new Error(
      "The delivery template rendered nothing for " + (login || "this account"),
    );
  }
  let r;
  try {
    r = await mp.gameflipPublish({
      title,
      description,
      priceUsd,
      imagePath,
      autoDeliverCode: code,
    });
  } catch (e) {
    // Matching release, exactly as the archive lane releases its reservation:
    // a publish that threw must not leave the account out of sellable stock.
    await supplied.releaseClaim(ledgerIds, { orderId });
    throw e;
  }
  const doc = await MarketplaceListing.create({
    accountOffer: offerId,
    // Never a set, never an archive claim. Spelled out rather than left to the
    // schema so a reader of this row can see the mode at a glance.
    set: null,
    autoClaimSet: false,
    unclaimedGame: "",
    marketplace: "gameflip",
    externalId: r.externalId,
    url: r.url || "",
    title,
    description: String(description || ""),
    price: priceUsd,
    status: "active",
    // Explicit, never the schema default: owner-supplied stock must stay out of
    // the auto-farmer's post-event repricing whatever that default becomes.
    origin: "manual",
    note: "account listing: " + (login || "account"),
    autoDeliver: true,
    // accountId / accountLogin stay EMPTY on purpose — see the accountOffer
    // comment in models/MarketplaceListing.js. The login belongs in units[],
    // which is where utils/listedLogins.js reads it, so this supplied login
    // still cannot also be sold by an archive-backed listing.
    units: [
      {
        contentId: String(acc.ledgerId),
        accountId: "",
        login,
        addedAt: new Date(),
        deliveredAt: null,
        orderId,
      },
    ],
    qtyRemaining: Math.max(0, Number(qtyRemaining) || 0),
  }).catch((e) => {
    // NO release here, deliberately — unlike every failure above this line.
    // The Gameflip listing is already live and already carries these
    // credentials, so handing the account back to the shelf would put it on
    // sale a second time. What is missing is the row, not the stock.
    console.error(
      "gameflip account listing " +
        r.externalId +
        " IS LIVE but its row could not be written — " +
        (login || "the account") +
        " stays claimed on purpose:",
      e.message,
    );
    throw e;
  });
  // Gameflip holds the credentials from this moment. Best-effort and AFTER the
  // row exists: throwing here would leave a live offer carrying an account no
  // row points at, which is the worse of the two failures.
  try {
    await supplied.markFed(ledgerIds, {
      listing: doc._id,
      market: "gameflip",
    });
  } catch (e) {
    console.error(
      "gameflip account listing " +
        r.externalId +
        ": could not mark " +
        (login || "the supplied account") +
        " as fed:",
      e.message,
    );
  }
  return doc;
}

// Put an offer-backed row's supplied accounts back on the shelf. The archive
// lane has releaseAccount and the rent-farm lane releaseBufferedRow; without
// this third one a retired account listing leaves its account stuck at "fed"
// with no live listing behind it — stock the owner paid for and can no longer
// sell. Best-effort, like both of its siblings.
// Resolves true when the hand-back went through (or there was nothing to hand
// back), false when it failed — the existing callers ignore it.
async function releaseSuppliedUnits(row, reason) {
  const ids = (row.units || [])
    .map((u) => (u && u.contentId ? String(u.contentId) : ""))
    .filter(Boolean);
  if (!ids.length) return true;
  try {
    const supplied = require("./suppliedStock");
    await supplied.releaseClaim(ids, {
      orderId: (row.units[0] && row.units[0].orderId) || "",
    });
    return true;
  } catch (e) {
    console.error(
      "gameflip account listing " +
        (row.externalId || row._id) +
        " (" +
        reason +
        "): could not hand its accounts back:",
      e.message,
    );
    return false;
  }
}

// No-claim Shop listings (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §8a). Both
// modules reach back into this file (noclaimListings publishes through
// publishAutoDelivery), so they are required lazily, inside the functions that
// use them — the same reason ./autoLister and ./suppliedStock are.
function noclaimStock() {
  return require("./noclaimStock");
}
function noclaimListings() {
  return require("./noclaimListings");
}

// The no-claim half of publishAutoDelivery. The account comes from
// utils/noclaimStock.claimForSet — the one claim layer for no-claim stock,
// which re-reads the account's live Twitch inventory before committing it and
// parks its ledger at "manual" so the no-claim auto-lister can never list it
// too — and never from the archive.
//
// The title and description are the caller's set-built text and are NOT
// rewritten by accountListingText, for the account-listing lane's reason: that
// reads the Drop Archive by BotAccount id, and a no-claim account has neither
// archive rows nor a BotAccount, so at best the rewrite falls back and at
// worst it advertises somebody else's drops. The bundle is exactly the set.
async function publishNoclaimAutoDelivery({
  set,
  title,
  description,
  priceUsd,
  imagePath,
  qtyRemaining,
  origin,
}) {
  if (!set || !set._id) {
    throw new Error("This no-claim listing has no drop set to sell from");
  }
  const ncs = noclaimStock();
  const [acc] = await ncs.claimForSet(set, 1, {
    market: "gameflip",
    mode: "fed",
  });
  if (!acc) {
    throw new Error(
      "Out of stock — no free no-claim account holds this whole bundle",
    );
  }
  const login = acc.login || "";
  // claimForSet already skips an account whose password it cannot read, but
  // this is the last line before the credentials go on sale: a listing
  // published with a blank password is a paid buyer holding half a login.
  if (!acc.password) {
    // Nothing has been sent to Gameflip yet: no listing can carry this login.
    await releaseNoclaimClaim(acc, "no readable password", { listingGone: true });
    throw new Error(
      "Account " + (login || "(no login)") + " has no readable password — " +
        "cannot auto-deliver",
    );
  }
  let fields;
  let r;
  try {
    // Pure, and built BEFORE the publish on purpose: once Gameflip holds the
    // credentials nothing may throw between the publish and the row, or the
    // listing is live with no row naming it.
    fields = ncs.rowFields(set, "gameflip", [acc]);
    r = await mp.gameflipPublish({
      title,
      description,
      priceUsd,
      imagePath,
      // An auto-farm account's drops are unclaimed: its buyer connects, then
      // claims. A no-claim account's code is what it always was.
      autoDeliverCode: gameflipDeliveryCode(login, acc.password, { unclaimed: acc.farm === "autofarm" }),
    });
  } catch (e) {
    // An account Gameflip refuses is remembered, as on every other lane, so
    // the next attempt tries someone else.
    noteIfCodeRefused(login, e);
    // An AUTO-FARM account is sold whole, on any market, the moment it is
    // free again — so it goes back only when the listing this publish built
    // is provably gone. gameflipPublish bins a half-built listing best-effort,
    // and under Gameflip's limiter that delete fails like everything else.
    // Kept, the account stays held — and the listing it may still be in is
    // put on the books (trackFailedListing), so the maintenance pass keeps
    // asking Gameflip about it and hands the account back, or books its sale,
    // by itself. Only when even that row cannot be written is it left for the
    // owner: the pass then pins the claim.
    const remains = acc.farm === "autofarm" ? await failedPublishRemains(e) : "";
    if (remains === "there") {
      const what = String((e && e.message) || e);
      const tracked = await trackFailedListing({ acc, set, fields, title, description, priceUsd, origin, error: what });
      console.error(
        "gameflip no-claim: " + (login || "the account") + " stays HELD — the listing its failed publish " +
          "built may still exist on Gameflip with its login" + (tracked ? " (tracked as " + tracked.externalId + ")" : "") +
          ": " + what,
      );
      sendTelegram(
        "⚠️ Gameflip: a publish of an auto-farm unclaimed account failed, and the listing it had " +
          "built could not be confirmed deleted.\n" + what.slice(0, 300) +
          "\nThe account (" + (login || "?") + ") stays held so it cannot be sold elsewhere. " +
          (tracked
            ? "That listing is on the books now: it is taken down automatically and the account comes back " +
              "by itself once Gameflip confirms it is gone (or its sale is booked, should it have sold). " +
              "Nothing to do unless this repeats."
            : "Check Gameflip for that draft/listing and delete it, then release the account: " +
              'POST /noclaim-stock/ledgers/' + String(acc.ledgerId) + '/release with { "confirmGone": true }'),
      ).catch(() => {});
      // Said in the error too, so a caller that lists by itself (utils/
      // autofarmOffers) does not simply try again with another account — and
      // whether the listing is on the books: tracked, nothing of it is "live
      // with no row", so that caller need not hold the whole set for a human.
      e.message = what + HELD_MARK + (tracked ? TRACKED_MARK : "");
      throw e;
    }
    // Matching release, exactly as the other lanes release theirs: a publish
    // that threw must not leave the account committed to a listing that does
    // not exist. For an auto-farm account that is now KNOWN — the publish
    // built no listing, or Gameflip answered 404 for the one it built — and
    // said so: its claim is attached to no row, and such a claim is otherwise
    // never handed back (nobody could say which listing holds its login).
    await releaseNoclaimClaim(acc, "gameflip publish failed", { listingGone: remains === "none" || remains === "gone" });
    throw e;
  }
  const doc = await MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: r.externalId,
    url: r.url || "",
    title,
    description: String(description || ""),
    price: priceUsd,
    status: "active",
    origin: origin === "auto" ? "auto" : "manual",
    note: "no-claim auto-delivery — " + (login || "account"),
    autoDeliver: true,
    qtyRemaining: Math.max(0, Number(qtyRemaining) || 0),
    // LAST, so the no-claim invariants win over anything above: the
    // `noclaimStock` flag every consumer checks first, origin "manual" (never
    // repriced), accountId "" and the login in units[] — which is where
    // utils/listedLogins.js reads it, so no other listing can take it too.
    ...fields,
  }).catch((e) => {
    // NO release here, deliberately, as in the account-listing lane: the
    // Gameflip listing is already live and carries these credentials, so
    // handing the account back would put it on sale a second time.
    console.error(
      "gameflip no-claim listing " +
        r.externalId +
        " IS LIVE but its row could not be written — " +
        (login || "the account") +
        " stays claimed on purpose:",
      e.message,
    );
    // The words every "live without a row" failure uses (noclaimListings
    // .orphanedPublish), so whoever asked for the listing knows it exists.
    const live = new Error(
      "published on Gameflip but the row could not be saved — delist it by hand: " +
        r.externalId + " (" + ((e && e.message) || e) + ")",
    );
    live.cause = e;
    throw live;
  });
  // Best-effort and AFTER the row exists, like the account-listing lane's
  // markFed: throwing here would report a failed publish for a listing that
  // is live, and a second click would put a second account on sale.
  try {
    await ncs.attachListing([acc.ledgerId], doc._id);
  } catch (e) {
    console.error(
      "gameflip no-claim listing " +
        r.externalId +
        ": could not attach " +
        (login || "its account") +
        " to the row:",
      e.message,
    );
  }
  return doc;
}

// A failed publish left a listing on Gameflip that could not be confirmed
// deleted, and its (auto-farm) account stays held. Put that listing on the
// books — a row that was never on sale ("removed"), naming the listing and the
// account, with the claim attached to it. From then on it is an ordinary held
// unit whose row is off sale: the lifecycle pass (utils/noclaimListings, its
// limbo step) asks Gameflip about it every pass, finishes the take-down,
// hands the account back on Gameflip's own 404, or books the sale should the
// "failed" listing have gone live and sold. Without the row nobody could ever
// ask, and the account waited for a human. Returns the row, or null when it
// could not be written (the caller then says so). Never throws.
async function trackFailedListing({ acc, set, fields, title, description, priceUsd, origin, error }) {
  const m = FAILED_LISTING_RE.exec(String(error || ""));
  const id = m && (m[1] || m[2]);
  if (!id || !fields) return null;
  try {
    const doc = await MarketplaceListing.create({
      set: set._id,
      marketplace: "gameflip",
      externalId: id,
      url: "",
      title,
      description: String(description || ""),
      price: priceUsd,
      origin: origin === "auto" ? "auto" : "manual",
      note: "no-claim auto-delivery — " + (acc.login || "account") + " — publish failed",
      autoDeliver: true,
      ...fields,
      // After `fields`: this unit never went on sale and owes nothing.
      status: "removed",
      qtyRemaining: 0,
      lastError: ("publish failed — its listing may still exist on Gameflip, being taken down: " + String(error || "")).slice(0, 400),
    });
    // Attached, or it is not tracked: a row the claim does not point at is
    // one the pass never connects to this account.
    const n = Number(await noclaimStock().attachListing([acc.ledgerId], doc._id)) || 0;
    return n ? doc : null;
  } catch (err) {
    console.error(
      "gameflip no-claim: the listing a failed publish left behind (" + id + ") could not be put on the books:",
      err && err.message,
    );
    return null;
  }
}

// Hand a claimed-but-never-published no-claim account back. A release that
// fails leaves the account committed ("manual") to a listing that does not
// exist, so it is loud — and it is never allowed to mask the error that made
// the publish fail in the first place.
async function releaseNoclaimClaim(acc, reason, { listingGone = false } = {}) {
  try {
    await noclaimStock().releaseClaim([acc.ledgerId], listingGone ? { reason, listingGone: true } : { reason });
  } catch (e) {
    console.error(
      "gameflip no-claim: could not hand " +
        (acc.login || "the account") +
        " back after '" +
        reason +
        "':",
      e.message,
    );
  }
}

// A failed publish names the listing it had built: "… (draft <id> discarded)"
// when the code would not attach, "Gameflip created <id> but could not put it
// on sale (draft discarded)" when it would not go on sale. "Discarded" is what
// gameflipPublish TRIED. What Gameflip really holds now:
//   "none"   the publish failed before any listing existed
//   "gone"   Gameflip no longer has it
//   "there"  it still exists, or Gameflip would not say
// A listing found still there is ended once more before the second look —
// from the status just read (mp.gameflipEndListing): a draft is deleted
// outright, with no off-sale patch for it to refuse first, and one a buyer has
// or is paying for is never touched. The verdict is always the second look,
// never the end call's own report.
// On the error of a failed publish whose auto-farm account was NOT handed back.
const HELD_MARK = " [account kept held]";
// …and, after it, when the listing that publish left behind was put on the
// books (trackFailedListing): the pass finishes it without anybody.
const TRACKED_MARK = " [listing tracked]";
const FAILED_LISTING_RE = /\(draft ([0-9a-f][0-9a-f-]{7,}) discarded\)|Gameflip created ([0-9a-f][0-9a-f-]{7,}) but/i;
const FAILED_LISTING_SAID_RE = /\(draft \S* ?discarded\)|Gameflip created \S+ but/i;
async function failedPublishRemains(err) {
  const text = String((err && err.message) || err || "");
  const m = FAILED_LISTING_RE.exec(text);
  const id = m && (m[1] || m[2]);
  // "None" is the ABSENCE of the two forms that say a listing was built — not
  // a failure to read its id out of one of them: a listing that was created
  // and cannot be named cannot be asked about, which is "there", not "none".
  if (!id) return FAILED_LISTING_SAID_RE.test(text) ? "there" : "none";
  for (let look = 0; look < 2; look++) {
    let status = "";
    try {
      status = await mp.gameflipListingStatus(id);
    } catch (e) {
      // Gone is Gameflip's own 404 (utils/gameflipGone), never an error's
      // words or somebody else's 404: an unreadable answer proves nothing.
      return gameflipGone(e) ? "gone" : "there";
    }
    if (look === 0) {
      try {
        // `confirmed`: its own read-back was Gameflip's 404 for the listing.
        const ended = await mp.gameflipEndListing(id, { status });
        if (ended && ended.confirmed === true) return "gone";
      } catch {
        /* whatever it threw, the second look is the verdict */
      }
    }
  }
  return "there";
}

// The no-claim sibling of the retire-path releases above (archive reservation,
// rent-farm buffer, supplied units). A no-claim row carries accountId "" by
// design — its account is a no-claim ledger, not an archive reservation — so
// none of those can reach its stock, and without this the account would stay
// committed behind a listing that no longer exists. onGameflipRetired releases
// only a still-"manual" ledger, so a unit a buyer paid for is never handed
// back. Best-effort like its siblings: the row is already terminal.
// `gone`: Gameflip itself answered 404 for the listing — the one thing an
// auto-farm account held for it is handed back on (utils/autofarmStock
// .releaseBlocked); retired as "expired" or "cancelled" it still exists there.
async function retireNoclaimUnit(row, reason, { gone = false, burned = false } = {}) {
  try {
    await noclaimListings().onGameflipRetired(row, { reason, gone: gone === true, burned: burned === true });
  } catch (e) {
    console.error(
      "gameflip no-claim listing " +
        (row.externalId || row._id) +
        " (" +
        reason +
        "): could not hand its account back:",
      e.message,
    );
  }
}

// What a relist republishes FROM. A DropSet-backed chain rebuilds its cover
// from the set's item grid; an account listing has no set at all, so it
// rebuilds the promo cover from the offer's own text — the same generator the
// Listings page used to publish the first unit. Throws with a reason when the
// source is gone, which is what noteRelistFailure records on the row.
async function relistSource(row) {
  if (row.accountOffer) {
    const offer = await AccountOffer.findById(row.accountOffer).lean();
    if (!offer) throw new Error("the account listing no longer exists");
    let imagePath = "";
    try {
      imagePath = await buildPromoCoverImage({
        title: offer.title || row.title,
        serviceText: offer.coverServiceText || "",
        bullets: Array.isArray(offer.coverBullets) ? offer.coverBullets : [],
      });
    } catch {
      imagePath = "";
    }
    return { set: null, offer, imagePath };
  }
  const set = await DropSet.findById(row.set).lean();
  if (!set) throw new Error("the drop set no longer exists");
  let imagePath = "";
  try {
    imagePath = await buildSetGridImage(set);
  } catch {
    imagePath = "";
  }
  return { set, offer: null, imagePath };
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

// A chain failing for any OTHER reason — relist after a sale, or renewal after
// expiry — was only ever logged: on 2026-09-28 nine sold chains failed to
// relist up to 8 times each on "code for digital goods already exists", one
// (Metin2, 21 units owed) for four days and 14 attempts, and the Hunt: Showdown
// renewal (187 owed) failed eight times on 10-01; nobody was told. Said once a
// row reaches this many misses — the 5th try comes 75 min after the first
// (5 + 10 + 20 + 40), well past a rate-limit storm, which resets in minutes —
// and at most once an hour per lane, as one summary.
const STUCK_ALERT_AT_ATTEMPT = 5;
const STUCK_ALERT_EVERY_MS = 60 * 60 * 1000;
let relistStuckAlertAt = 0;
let renewalStuckAlertAt = 0;

// Record a failed relist: keep the reason, count the attempt and push the next
// one out by the backoff. Called from both relist paths so a chain can never be
// left with a stale deadline.
// A publish that kept an auto-farm account HELD (the listing it built could
// not be confirmed deleted), or went live without a row. Trying again would put
// ANOTHER account out there next to a listing nobody is tracking — three in
// half an hour at these lanes' pace. Whichever lane asked for it stops there:
// the chain owes nothing more, and the publish itself has told the owner.
function relistMustStop(message) {
  const m = String(message || "");
  return m.includes(HELD_MARK) || /row could not be saved/i.test(m);
}
// Returns true when it stopped the chain. Every lane that republishes a unit
// (the sold lane, its retry, the renewal of a lapsed listing) asks it first.
async function stopRelistChain(row, message) {
  if (!relistMustStop(message)) return false;
  await MarketplaceListing.updateOne(
    { _id: row._id },
    { $set: { lastError: ("auto-relist stopped: " + message).slice(0, 400), qtyRemaining: 0, relistRetryAt: null } },
  ).catch(() => {});
  console.error("gameflip relist STOPPED for " + (row.externalId || row._id) + ":", message);
  return true;
}

async function noteRelistFailure(row, err) {
  const attempts = (Number(row.relistAttempts) || 0) + 1;
  const message = (err && err.message) || String(err);
  if (await stopRelistChain(row, message)) return;
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
  // Named, so a failure in the log can be traced to its chain (it could not).
  console.error(
    "gameflip relist failed for " +
      (row.externalId || row._id) +
      " (attempt " +
      attempts +
      ", next in " +
      Math.round(relistRetryDelayMs(attempts) / 60000) +
      "m):",
    message,
  );
  if (
    !isOutOfStockError(message) &&
    attempts === STUCK_ALERT_AT_ATTEMPT &&
    Date.now() - relistStuckAlertAt >= STUCK_ALERT_EVERY_MS
  ) {
    relistStuckAlertAt = Date.now();
    const stuck = await MarketplaceListing.countDocuments({
      marketplace: "gameflip",
      status: "sold",
      qtyRemaining: { $gt: 0 },
      relistAttempts: { $gte: STUCK_ALERT_AT_ATTEMPT },
      lastError: /^auto-relist failed: (?!Out of stock)/,
    }).catch(() => 0);
    await sendTelegram(
      "⚠️ Gameflip relists keep FAILING\n\n" +
        Math.max(1, stuck) + " sold chain(s) have failed to relist " +
        STUCK_ALERT_AT_ATTEMPT + "+ times for a reason other than stock, so the " +
        "units they owe are not on sale (e.g. " + (row.title || "an untitled listing") +
        ", " + (Number(row.qtyRemaining) || 0) + " unit(s) owed). Last error:\n" +
        String(message).slice(0, 300) +
        "\n\nThey keep retrying, up to 12 h apart. At most one of these an hour.",
    ).catch(() => {});
  }
  if (attempts === RELIST_ALERT_AT_ATTEMPT && isOutOfStockError(message)) {
    await sendTelegram(
      "⚠️ Gameflip chain out of stock\n\n" +
        (row.title || "(untitled listing)") +
        "\n" +
        (Number(row.qtyRemaining) || 0) +
        " unit(s) still owed, but " +
        // An account listing is stocked by hand, so "wait for the farmer" would
        // send the owner to watch a farm that will never fill it.
        (row.accountOffer
          ? "this account listing has no supplied account left — paste more " +
            "into it in the Account listings tab."
          : // A no-claim chain is stocked by the no-claim farm, not the
            // archive farmer — same reason as above, wrong farm to watch.
            row.noclaimStock
            ? "no free no-claim account holds this bundle — the chain is " +
              "paused until the no-claim farm has one free."
            : "no unsold account holds the whole bundle — the chain is paused " +
              "until the farmer produces one.") +
        (row.url ? "\n\n" + row.url : ""),
    ).catch(() => {});
  }
}

// Replace the live unit of a no-claim chain after `row` was taken down UNSOLD
// (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §4 removeUnit: drops expired,
// manual-sold, conflict). Nobody bought that unit, so the chain still owes
// exactly what `row` owed — one live unit plus row.qtyRemaining queued: the
// replacement carries the queue and `row` gives it up, so the same units are
// never listed twice. The cover is rebuilt exactly as the sold-path relist
// does (relistSource). Never throws: out of stock just ends the chain (logged,
// null), and so does any other failure, which the caller logs as well.
async function relistNoclaimSuccessor(row) {
  if (!row || !row._id) return null;
  let img = "";
  try {
    // Only ever AFTER the take-down. delistRowVerified leaves a row "active"
    // when the platform would not confirm the delist, and replacing a unit
    // that is still on sale puts two units up for one owed.
    const current = await MarketplaceListing.findById(row._id).lean();
    if (current && current.status === "active") {
      console.error(
        "gameflip no-claim successor for listing " +
          (row.externalId || row._id) +
          " not published — that listing is still active, so nothing was " +
          "taken down to replace",
      );
      return null;
    }
    const src = await relistSource(row);
    img = src.imagePath;
    const doc = await publishAutoDelivery({
      set: src.set,
      title: row.title,
      description: row.description,
      priceUsd: row.price,
      imagePath: img,
      qtyRemaining: row.qtyRemaining || 0,
      origin: row.origin || "manual",
      noclaim: true,
    });
    await MarketplaceListing.updateOne(
      { _id: row._id },
      { $set: { qtyRemaining: 0 } },
    ).catch((e) => {
      console.error(
        "gameflip no-claim listing " +
          (row.externalId || row._id) +
          ": replaced by " +
          doc.externalId +
          " but its queue could not be cleared:",
        e.message,
      );
    });
    return doc;
  } catch (e) {
    const message = (e && e.message) || String(e);
    console.error(
      "gameflip no-claim successor for listing " +
        (row.externalId || row._id) +
        (isOutOfStockError(message)
          ? " not published — out of stock, the chain ends here: "
          : " failed: ") +
        message,
    );
    return null;
  } finally {
    if (img) await fsp.unlink(img).catch(() => {});
  }
}

// How many rows one pass may poll individually when the bulk status sweep is
// unavailable. Only ever applies to that fallback: the normal path reads the
// whole fleet in two calls and must never be capped.
const FALLBACK_POLL_LIMIT = 100;
// Where the degraded pass resumes. Module scope on purpose: it has to
// survive between ticks, which is the whole point of rotating.
let fallbackCursor = 0;

// How long a stalled-relist row is held while its republish runs.
// publishAutoDelivery can spend minutes inside gameflipPublish's rate-limit
// backoff, so the lease must comfortably outlast that on a 60s tick.
const RELIST_LEASE_MS = 10 * 60 * 1000;

// How many rows one pass may read one by one when they sit in NEITHER bulk
// sweep. Normally that is a handful — a sale the sold sweep has not caught up
// with, a 404 — and every one of them is read. On 2026-10-01 it was 98 EXPIRED
// listings (see readUnplacedStatus), read individually on every 60s tick: about
// a hundred status GETs a minute, the request storm that kept Gameflip answering
// 429 to everything else this process does — relists ("Too many attempts"),
// publishes, the health page's probe. Rotated like the fallback lane above, so
// a long tail is still covered in ceil(n / limit) passes rather than starved.
// Kept well under what trips the limiter: "a handful of calls in a minute earns
// 429 for several minutes" (reference_gameflip_api_limits).
const UNPLACED_POLL_LIMIT = 15;
let unplacedCursor = 0;

// Lapsed listings ended per pass. Each one costs two writes (off sale, delete),
// so a backlog is worked off over a few minutes instead of in one burst, with a
// gap between ends because Gameflip's limiter counts writes too.
const LAPSED_END_LIMIT = 3;
const LAPSED_END_GAP_MS = 2000;
// How long a lapsed listing whose end just failed stands aside for the others
// (in memory: a restart simply tries it again).
const LAPSED_END_RETRY_MS = 60 * 60 * 1000;
const lapsedEndFailedAt = new Map(); // row id -> ms of its last failed end

// RENEWAL. An auto-delivery listing that expired UNSOLD has not used up its
// unit: retiring it ended the chain, and on 2026-10-01 that would have dropped
// 63 chains still owing 2,104 units (one Rocket League chain alone 520). The
// owner chose renewal: once the expired listing is gone from Gameflip and its
// stock handed back, the row waits as "renewal pending" and the renewal lane at
// the end of syncOnce publishes a fresh 30-day listing for the SAME unit — the
// same publishAutoDelivery a sale's relist uses, so the account is picked and
// checked exactly as it is after a sale, and a bundle nothing still holds ends
// there. qtyRemaining carries over unchanged: nothing sold. One renewal per
// pass — each is a full publish, and Gameflip's limiter is what started this.
// Hand-made listings (autoDeliver false) are never republished on the owner's
// behalf, rent-farm offers renew through their own buffer, and a bulk pack is
// never relisted (docs/bulk-packs/CONTRACT.md H9). Switch:
// autoFarm.gameflipRenewExpired = false parks renewals (rows stay pending, so
// switching back on resumes them).
const LAPSED_RENEW_PER_PASS = 1;
const RENEWAL_PENDING = "expired on Gameflip — renewal pending";
const RENEWAL_PENDING_RE = /^expired on Gameflip — renewal pending/;
// Written onto the row BEFORE its listing is ended, so a pass that dies (or an
// overlapping manual /marketplaces/sync) between Gameflip applying the delete
// and the retirement being recorded still knows, on the 404 that follows, that
// this was a lapsed listing to settle and renew — not a stray 404 to retire.
const LAPSED_ENDING = "expired on Gameflip — ending (";
const LAPSED_ENDING_RE = /^expired on Gameflip — ending \(([^)]*)\)/;
// readUnplacedStatus's answer for a row it has fully settled itself.
const LAPSED_DONE = "\u0000lapsed-settled";

// Did the hand-back of `accountId`'s reservation for `setId` take? releaseAccount
// swallows its own write errors, so the reservations are counted instead. A
// failed count reads as "not released": the link is then kept, never lost.
async function setReleased(accountId, setId) {
  if (!accountId || !setId) return false;
  try {
    const left = await DropLog.countDocuments({
      account: accountId,
      soldSetId: String(setId),
      soldToUsername: GF_CLAIM_TAG,
      soldAt: { $ne: null },
    });
    return left === 0;
  } catch {
    return false;
  }
}

// A 404 for a listing that is NOT in Gameflip's own voice (utils/gameflipGone)
// retires nothing — the safe side. But should Gameflip ever change the body of
// its 404, EVERY deleted or expired listing would read that way: rows would
// stay active, read again every tick, with retirement and renewal stopped for
// the whole Gameflip fleet and not a word about it. So it is said: one log
// line and one message, at most every six hours.
const FOREIGN_404_EVERY_MS = 6 * 60 * 60 * 1000;
let foreign404At = 0;
function noteForeign404(row, e) {
  if (Date.now() - foreign404At < FOREIGN_404_EVERY_MS) return;
  foreign404At = Date.now();
  const body = String((e && e.message) || e).slice(0, 220);
  console.error(
    "gameflip listing " + (row && row.externalId) + " answered 404 in a form that is not Gameflip's own — " +
      "nothing retired: " + body,
  );
  sendTelegram(
    "⚠️ Gameflip: a listing answered 404, but not in Gameflip's own words\n\n" +
      "Listing " + ((row && row.externalId) || "?") + ": " + body +
      "\n\nNothing was retired or handed back (a 404 from something in between says nothing about the " +
      "listing). If this keeps coming, Gameflip may have changed its error format — then deleted and " +
      "expired listings stay 'active' here until utils/gameflipGone.js is updated. At most one of these " +
      "every six hours.",
  ).catch(() => {});
}

// Out-of-stock renewals page the owner at most once an hour, as one summary:
// a fleet-wide dip during a backlog would otherwise send one message per row.
const RENEWAL_ALERT_EVERY_MS = 60 * 60 * 1000;
let renewalAlertAt = 0;
// Every alert latch in this file (the stuck-chain ones: STUCK_ALERT_AT_ATTEMPT).
function resetRenewalAlert() {
  renewalAlertAt = 0;
  renewalStuckAlertAt = 0;
  relistStuckAlertAt = 0;
  foreign404At = 0;
  lapsedEndFailedAt.clear();
}

// Drop an "ending" stamp from a row whose listing is live again. Conditional on
// the stamp still being there, so it can never clear anything else.
async function clearStaleEndingStamp(row) {
  if (!LAPSED_ENDING_RE.test(String((row && row.lastError) || ""))) return;
  await MarketplaceListing.updateOne(
    { _id: row._id, status: "active", lastError: LAPSED_ENDING_RE },
    { $set: { lastError: "" } },
  ).catch(() => {});
}

function renewsLapsedListings() {
  try {
    return require("./settings").getAutoFarm().gameflipRenewExpired !== false;
  } catch {
    return true; // a settings read failing must not strand a chain
  }
}

// Renewal is for this fulfiller's OWN chains only. Never for the unclaimed
// engine's units or lots: they say so themselves ("the engine relists; the
// fulfiller must never (archive stock differs)", unclaimedAutoList; "one lot,
// one buyer", unclaimedLots) and the engine's repairGameflipChains publishes
// their successor — a second one from here would come out of the CLAIMED
// archive at the engine's price.
function renewable(row) {
  return !!(
    row &&
    row.autoDeliver &&
    !row.rentFarm &&
    !row.bulkOfferId &&
    row.origin !== "unclaimed" &&
    !(Number(row.lotSize) > 0) &&
    !row.lotId
  );
}

// An auto-lister HEAD row (autoLister.listActivatedTask) records no accountId:
// its code belongs to the one account reserveOneForDelivery took for this set
// under the "gameflip" tag. While the head is unsold no other Gameflip listing
// can hold that set's reservation, so exactly one account carries it — that
// one is handed back. Anything else (none, several, or one the row does not
// name) is left reserved and logged: a sold unit's reservation is its sale
// record, and releasing it would sell the account twice.
async function releaseHeadAccount(row) {
  if (!row || !row.set) return false;
  const ids = await DropLog.distinct("account", {
    soldSetId: String(row.set),
    soldToUsername: GF_CLAIM_TAG,
    soldAt: { $ne: null },
  });
  const named = String(row.accountLogin || "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  if (ids.length !== 1) {
    if (ids.length) {
      console.error(
        "gameflip head row " + row.externalId + ": " + ids.length +
          " accounts hold this set's gameflip reservation — none released",
      );
    }
    return false;
  }
  // The login comes off the reserved drop itself: the account may be a
  // BotAccount or a pool AvailableAccount (DropLog.accountModel).
  const drop = await DropLog.findOne(
    { account: ids[0], soldSetId: String(row.set), soldToUsername: GF_CLAIM_TAG },
    { login: 1 },
  ).lean();
  if (!drop || !named.includes(String(drop.login || "").toLowerCase())) {
    console.error(
      "gameflip head row " + row.externalId + ": the reserved account is not " +
        "one the row names — left reserved",
    );
    return false;
  }
  const headId = String(ids[0]);
  await releaseAccount(headId, row.set);
  return true;
}

// Settle a listing that expired while Gameflip still called it onsale/ready,
// once it has been ended on Gameflip: retire the row, hand its stock back with
// the same release calls as every other retirement (retire FIRST, release
// second), clear the now-stale account linkage, and — for one of this
// fulfiller's own chains — queue it for the renewal lane.
//
// Clearing the linkage matters because the Listings page offers Delist on any
// row that is not sold, and that route releases `row.accountId` for the row's
// set whatever its status: after a renewal re-claims the same account for the
// same set, a Delist click on the old row would free the reservation the NEW
// listing is selling. The old row keeps the login in its lastError instead.
async function settleLapsed(row, { expiration } = {}) {
  const date = String(expiration || "").slice(0, 10) || "?";
  const renewIt = renewable(row);
  let keep = false; // a rent-farm offer keeps its account for the buffer's renewal
  if (row.rentFarm) {
    try {
      keep = !!row.rentFarmPoolId && gfFarm.renewsOnExpiry();
    } catch {
      keep = false;
    }
  }
  // The old account goes into `note`, which later status writes leave alone,
  // because the linkage itself is cleared below.
  const was = String(row.accountLogin || "").slice(0, 120);
  const note =
    (row.note ? String(row.note) + " " : "") +
    "— expired on Gameflip " + date + (was ? "; account " + was + " handed back" : "");
  const retired = await MarketplaceListing.findOneAndUpdate(
    { _id: row._id, status: "active" },
    {
      $set: {
        status: "removed",
        relistAttempts: 0,
        relistRetryAt: null,
        note,
        lastError: renewIt
          ? RENEWAL_PENDING + " (expired " + date + ")"
          : "expired on Gameflip " + date + " — ended there and retired by the watcher" +
            (keep ? "; account kept for a same-account renewal" : ""),
        ...(keep ? { rentFarmExpiredAt: new Date() } : {}),
      },
    },
  ).catch(() => null);
  if (!retired) return false;
  const why = "listing expired on Gameflip " + date;
  // `released` gates the clearing below: the link is the only handle left on
  // a reservation whose hand-back failed, so it stays until one succeeds
  // (a leaked reservation can be found and freed; a cleared one cannot).
  let released = true;
  if (row.rentFarm) {
    if (!keep) await releaseBufferedRow(row, why);
  } else if (row.accountId) {
    await releaseAccount(row.accountId, row.set).catch(() => {});
    released = await setReleased(row.accountId, row.set);
  } else if (row.accountOffer) {
    released = (await releaseSuppliedUnits(row, why)) !== false;
  } else if (
    row.autoDeliver &&
    !row.noclaimStock &&
    !row.bulkOfferId &&
    !row.lotId &&
    !(Number(row.lotSize) > 0)
  ) {
    // A bulk pack or a lot is handed back by its own loop, never from here.
    await releaseHeadAccount(row).catch((e) =>
      console.error("gameflip head row " + row.externalId + " release:", e.message),
    );
  }
  // The listing was ended first — but "ended" here is this file's own reading
  // of status codes, so no answer is passed on: the claim layer asks Gameflip
  // itself before an auto-farm account goes back (one read, for a lapse that a
  // week-long drop never reaches anyway).
  if (row.noclaimStock) await retireNoclaimUnit(row, why);
  if (!row.rentFarm && released) {
    await MarketplaceListing.updateOne(
      { _id: row._id },
      { $set: { accountId: "", units: [] } },
    ).catch(() => {});
  } else if (!row.rentFarm) {
    console.error(
      "gameflip listing " + row.externalId + ": its stock could not be handed back — " +
        "the account link is kept on the row for a retry by hand",
    );
  }
  console.error(
    "gameflip listing " + row.externalId + " expired " + date +
      " — ended on Gameflip; " +
      (renewIt
        ? "queued for renewal (" + (Number(row.qtyRemaining) || 0) + " more unit(s) owed after it)"
        : "retired"),
  );
  return true;
}

// One watcher pass: mark sold listings sold and relist the next unit of any
// chain that still has quantity left. `publishFn` / `relistSourceFn` exist only
// so the renewal lane can be tested without a real publish; production always
// passes nothing.
async function syncOnce({
  publishFn = publishAutoDelivery,
  relistSourceFn = relistSource,
} = {}) {
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
  //
  // `autoDeliver: true` used to be part of this filter, and it was the same
  // class of bug as the `.limit(100)` above: a condition that silently excluded
  // a whole population. The owner's HAND-MADE listings carry autoDeliver false
  // (68 rows) or nothing at all (3), so they were never polled — their sales
  // were never seen, `status` stayed "active" for months, the sale price never
  // reached the pricing evidence, and they kept counting as live stock.
  // Measured 2026-09-09: 26 of them had already sold, worth $51.80 of revenue
  // this system had no record of, the oldest sitting unnoticed since 14 July.
  // Reconciling a sale costs one entry in a bulk sweep that was already paid
  // for, so there is no reason to look only at half the fleet.
  const rows = await MarketplaceListing.find({
    marketplace: "gameflip",
    status: "active",
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
  // ROTATED, not sliced from the front. `rows` comes from an unsorted find, so
  // natural order is stable across passes — taking the first N every time is
  // exactly the `.limit(100)` bug the comment above spent a paragraph on, just
  // moved into the degraded lane. While the bulk sweep is down (a 429 anywhere
  // in its paging aborts it, and the unclaimed engine shares the same endpoint)
  // the tail beyond N was never polled AT ALL — not this pass, not any pass —
  // so sales there went unseen for the whole outage.
  //
  // A cursor that advances by the window each pass covers the whole fleet in
  // ceil(rows/N) passes instead of never.
  let due = rows;
  if (!(soldIds && liveIds) && rows.length > FALLBACK_POLL_LIMIT) {
    const start = fallbackCursor % rows.length;
    due = rows.slice(start, start + FALLBACK_POLL_LIMIT);
    if (due.length < FALLBACK_POLL_LIMIT) {
      due = due.concat(rows.slice(0, FALLBACK_POLL_LIMIT - due.length));
    }
    fallbackCursor = (start + FALLBACK_POLL_LIMIT) % rows.length;
  }
  if (due.length < rows.length) {
    console.error(
      "gameflip bulk sweep unavailable — polling " +
        due.length +
        " of " +
        rows.length +
        " rows this pass",
    );
  }
  // Rows neither bulk sweep could place each cost a live read below. Bound and
  // rotate that lane (UNPLACED_POLL_LIMIT) so a backlog of them can never turn
  // every tick into a burst of individual GETs again.
  let unplacedSkip = null;
  if (soldIds && liveIds) {
    const unplaced = due.filter(
      (r) => !soldIds.has(r.externalId) && !liveIds.has(r.externalId),
    );
    if (unplaced.length > UNPLACED_POLL_LIMIT) {
      const start = unplacedCursor % unplaced.length;
      let pick = unplaced.slice(start, start + UNPLACED_POLL_LIMIT);
      if (pick.length < UNPLACED_POLL_LIMIT) {
        pick = pick.concat(unplaced.slice(0, UNPLACED_POLL_LIMIT - pick.length));
      }
      unplacedCursor = (start + UNPLACED_POLL_LIMIT) % unplaced.length;
      const keep = new Set(pick.map((r) => String(r._id)));
      unplacedSkip = new Set(
        unplaced.filter((r) => !keep.has(String(r._id))).map((r) => String(r._id)),
      );
      console.error(
        "gameflip watcher: " + unplaced.length + " row(s) in neither sweep — " +
          "reading " + pick.length + " this pass",
      );
    }
  }
  // A row Gameflip still calls onsale/ready whose 30-day expiry has passed
  // (mp.gameflipIsExpired): out of search, so no buyer can reach it, yet a bare
  // status read says "onsale" and the row stayed active forever — its account
  // reserved, its owed units never relisted, one GET into the limiter every
  // tick. It is stamped, then ended on Gameflip (off sale, delete, delete
  // confirmed), and only then settled by settleLapsed — so its stock goes back
  // only once nothing can sell it. Releasing an account behind a listing a
  // buyer could still pay for is the double sale this file exists to prevent:
  // an end that throws leaves the row active (stamped) for the next pass, and a
  // row past this pass's budget answers "" and waits. A listing Gameflip itself
  // reports "expired" keeps the branch it always had below. Nothing is ended
  // while the bulk sweep is down: that is the moment Gameflip is throttling us.
  let lapsedEnded = 0;
  const bulkSwept = !!(soldIds && liveIds);
  async function readUnplacedStatus(row) {
    if (typeof mp.gameflipListingState !== "function") {
      return mp.gameflipListingStatus(row.externalId);
    }
    let st;
    try {
      st = (await mp.gameflipListingState(row.externalId)) || {};
    } catch (e) {
      // A 404 on a row this watcher had stamped as ending: the delete went
      // through but its settlement was never recorded. Finish it here instead
      // of letting the plain 404 branch end the chain. The stamp is re-read
      // from the database when this pass's copy lacks it: an overlapping pass
      // (a manual /marketplaces/sync beside the tick) may have stamped and
      // ended it after this pass loaded its rows.
      if (gameflipGone(e)) {
        let m = LAPSED_ENDING_RE.exec(String(row.lastError || ""));
        if (!m) {
          const fresh = await MarketplaceListing.findById(row._id, { lastError: 1 })
            .lean()
            .catch(() => null);
          m = LAPSED_ENDING_RE.exec(String((fresh && fresh.lastError) || ""));
        }
        if (m) {
          await settleLapsed(row, { expiration: m[1] });
          return LAPSED_DONE;
        }
      }
      throw e;
    }
    const stamp = LAPSED_ENDING_RE.exec(String(row.lastError || ""));
    // OUR OWN half-done end: the off-sale patch landed (draft) but the delete
    // did not — a 429, a timeout, or a 200 Gameflip's limiter swallowed. A draft
    // is never "expired", so without this the row would sit active for good,
    // its account reserved and its chain never renewed. Resume the end.
    const resumeEnd = !!stamp && st.status === "draft";
    if (!resumeEnd && (!st.expired || st.status === "expired")) {
      // A stamp left by an end that failed, on a listing that is LIVE again
      // (renewed by hand on Gameflip): clear it, or a later 404 — the owner
      // deleting it — would be read as ours to renew.
      if (!st.expired && (st.status === "onsale" || st.status === "ready")) {
        await clearStaleEndingStamp(row);
      }
      return st.status || "";
    }
    if (!bulkSwept || lapsedEnded >= LAPSED_END_LIMIT) return "";
    // A listing whose end failed a moment ago is not this pass's first choice
    // again: three that will not end (the limiter answering and changing
    // nothing) would otherwise take the whole budget every tick, and the
    // lapsed listings behind them would never get their turn.
    const failedAt = lapsedEndFailedAt.get(String(row._id)) || 0;
    if (failedAt && Date.now() - failedAt < LAPSED_END_RETRY_MS) return "";
    if (lapsedEnded > 0) {
      await new Promise((r) => setTimeout(r, LAPSED_END_GAP_MS));
    }
    lapsedEnded += 1;
    const date = resumeEnd
      ? stamp[1]
      : String(st.expiration || "").slice(0, 10) || "?";
    if (!resumeEnd) {
      await MarketplaceListing.updateOne(
        { _id: row._id, status: "active" },
        { $set: { lastError: LAPSED_ENDING + date + ")" } },
      ).catch(() => {});
    }
    try {
      await mp.gameflipEndListing(row.externalId, { status: st.status });
    } catch (e) {
      // Whatever the end call threw is NOT the listing's own answer — not even
      // a 404 (its off-sale patch can answer one, with nothing deleted and
      // nothing read). So nothing is settled here, and the error goes up
      // without a status, so the caller's 404 branch cannot retire the row on
      // it either: the row waits, stamped, and the next tick's own read of the
      // listing finishes it through the stamp branch above.
      lapsedEndFailedAt.set(String(row._id), Date.now());
      throw new Error(
        "gameflip end of lapsed listing " + row.externalId + " did not complete: " + ((e && e.message) || e),
      );
    }
    lapsedEndFailedAt.delete(String(row._id));
    await settleLapsed(row, { expiration: resumeEnd ? date : st.expiration });
    return LAPSED_DONE;
  }
  let renewed = 0;
  for (const row of due) {
    if (unplacedSkip && unplacedSkip.has(String(row._id))) continue;
    if (liveIds && liveIds.has(row.externalId)) await clearStaleEndingStamp(row);
    let status;
    try {
      // A row in neither sweep is unaccounted for (deleted, expired, still a
      // draft), so it still gets its own status call — that is the only path
      // that can retire a 404'd row or a lapsed one.
      status =
        soldIds && liveIds
          ? soldIds.has(row.externalId)
            ? "sold"
            : liveIds.has(row.externalId)
              ? "onsale"
              : await readUnplacedStatus(row)
          : await readUnplacedStatus(row);
      if (status === LAPSED_DONE) continue;
    } catch (e) {
      // A 404 means the listing is gone from Gameflip for good. Plain `continue`
      // leaves the row active forever: the watcher re-reads it every tick, the
      // units it still owes are never relisted, and its account stays reserved
      // out of the sellable pool. Retire the row and hand the account back.
      // Every other error (timeout, 429, 5xx) really is transient — skip those.
      // And only Gameflip's OWN 404 (utils/gameflipGone): a 404 from something
      // in between says nothing about the listing, and retiring on it hands
      // the account back behind a listing that may be on sale.
      if (gameflipGone(e)) {
        const retired = await MarketplaceListing.findOneAndUpdate(
          { _id: row._id, status: "active" },
          {
            $set: {
              status: "removed",
              lastError: "gone from Gameflip (404) — retired by the watcher",
            },
          },
        ).catch(() => null);
        // A rent-farm row takes the buffered lane: it has a pool account, not a
        // set. Retire FIRST, release second — the order both branches already
        // use, and the one releaseBuffered enforces on its own side by refusing
        // to act while the row still says "active", because an offer that is
        // still purchasable sells credentials we have just handed back.
        if (retired && row.rentFarm) {
          await releaseBufferedRow(row, "listing 404 on Gameflip");
        } else if (retired && row.accountId) {
          await releaseAccount(row.accountId, row.set).catch(() => {});
        } else if (retired && row.accountOffer) {
          // An account listing carries no accountId (deliberately), so the
          // branch above can never reach its stock.
          await releaseSuppliedUnits(row, "listing 404 on Gameflip");
        }
        // Nor can it reach a no-claim row's (accountId is always ""). Its own
        // `if` rather than one more `else`, so no branch above can skip it.
        if (retired && row.noclaimStock) {
          await retireNoclaimUnit(row, "listing 404 on Gameflip", { gone: true });
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
      } else if (e && e.status === 404) {
        noteForeign404(row, e);
      }
      continue;
    }
    // "sold" is not the only terminal state, and treating it as the only one is
    // how a row lives forever.
    //
    // Every Gameflip listing is created with expire_in_days: 30
    // (utils/marketplaces.js), and an expired listing answers GET /listing with
    // 200 + status "expired" — no 404, so the retire path above never fires. It
    // appears in neither bulk sweep either, so it costs one individual status
    // call into the rate limiter every 60 seconds, forever, and the answer is
    // never "sold" so nothing ever changes. Meanwhile the row stays "active":
    // its account's drops stay reserved out of the sellable pool, its owed units
    // are never relisted, and every consumer that counts active rows as live
    // stock keeps counting it. With continuously published stock on a 30-day
    // expiry, this accumulates on a fixed schedule.
    //
    // utils/autoLister.js already treats "expired" as gone (`if (status &&
    // status !== "expired")`); this watcher simply never learned it.
    //
    // A buffered rent-farm offer that simply EXPIRED unsold keeps its account
    // for a renewal: the next buffer pass relists that same account instead of
    // returning it and burning a fresh pristine one on the replacement (after a
    // month on a claiming stack it is not pristine any more anyway). Never for
    // "cancelled" — a paid-then-refunded listing's credentials have been seen —
    // and only while the buffer is really running to renew it. A "cancelled"
    // rent-farm row's account is BURNED on release (the refunded buyer saw it).
    let renew = false;
    try {
      renew =
        status === "expired" && !!row.rentFarm && !!row.rentFarmPoolId &&
        gfFarm.renewsOnExpiry();
    } catch {
      renew = false; // a settings read failing must not stop the sale watcher
    }
    if (status === "expired" || status === "cancelled") {
      const retired = await MarketplaceListing.findOneAndUpdate(
        { _id: row._id, status: "active" },
        {
          $set: {
            status: "removed",
            lastError:
              "gameflip reports \"" + status + "\" — retired by the watcher" +
              (renew ? "; account kept for a same-account renewal" : ""),
            ...(renew ? { rentFarmExpiredAt: new Date() } : {}),
          },
        },
      ).catch(() => null);
      // Same split as the 404 branch: a rent-farm row has no set.
      if (retired && row.rentFarm) {
        if (!renew) {
          await releaseBufferedRow(row, "gameflip reports \"" + status + "\"", {
            burned: status === "cancelled",
          });
        }
      } else if (retired && row.accountId) {
        await releaseAccount(row.accountId, row.set).catch(() => {});
      } else if (retired && row.accountOffer) {
        await releaseSuppliedUnits(row, "gameflip reports \"" + status + "\"");
      }
      if (retired && row.noclaimStock) {
        // Expired, the listing still exists (and still holds the login); and
        // CANCELLED means paid, then refunded — the buyer has seen the login,
        // which is why the rent-farm branch above burns its account. A
        // no-claim account is the same: retired, never handed back.
        await retireNoclaimUnit(row, "gameflip reports \"" + status + "\"", { burned: status === "cancelled" });
      }
      if (retired) {
        console.error(
          "gameflip listing " + row.externalId + " is " + status + " — retired, " +
            (Number(row.qtyRemaining) || 0) + " unit(s) were still owed",
        );
      }
      continue;
    }
    // "ready" and "draft" are RECOVERABLE, not dead: the listing exists and is
    // public but not purchasable, usually because a status patch was answered
    // 200 by a rate-limited API and silently not applied. Retiring it would
    // throw away a listing that one patch would revive, and releasing its
    // account would put stock back that the listing still names. So record it
    // where a human and the health page can see it, and leave the row alone.
    if (status === "ready" || status === "draft") {
      if (!/not purchasable/.test(String(row.lastError || ""))) {
        await MarketplaceListing.updateOne(
          { _id: row._id },
          {
            $set: {
              lastError:
                "gameflip reports \"" + status + "\" — public but NOT purchasable; " +
                "needs its status patched back to onsale",
            },
          },
        ).catch(() => {});
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
    // An account listing's stock ledger only ever learns about a sale here:
    // Gameflip released the credentials itself when the buyer paid, and this
    // poller is the one thing that finds out. Without it the row stays "fed"
    // forever and the owner's stock table never shows a single sale. Inside
    // the claimed guard so it can only run once, and best-effort — a ledger
    // write must never break the relist chain below.
    if (row.accountOffer) {
      const unit = (row.units || [])[0];
      const ledgerIds = (row.units || [])
        .map((u) => (u && u.contentId ? String(u.contentId) : ""))
        .filter(Boolean);
      if (ledgerIds.length) {
        try {
          const supplied = require("./suppliedStock");
          await supplied.markDelivered(ledgerIds, {
            orderId: (unit && unit.orderId) || "",
            market: "gameflip",
          });
        } catch (e) {
          console.error(
            "gameflip account listing " +
              row.externalId +
              ": could not mark its account sold:",
            e.message,
          );
        }
      }
    }
    // The no-claim twin of the block above (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md
    // §8a): the account's ledger goes "manual" -> "sold" and its unit is
    // stamped delivered. Same rules — inside the claimed guard so it runs once,
    // before learning and the relist, and best-effort: a ledger write must
    // never break the chain. A failure leaves the ledger "manual", which still
    // keeps the account out of every claim, so the relist below cannot hand
    // the sold account out again.
    if (row.noclaimStock) {
      try {
        await noclaimListings().onGameflipSold(row, { priceUsd: row.price });
      } catch (e) {
        console.error(
          "gameflip no-claim listing " +
            row.externalId +
            ": could not mark its account sold:",
          e.message,
        );
      }
    }
    // Demand learning: this poller is the only thing that ever learns a
    // Gameflip listing was bought, and for years it kept that to itself. One
    // signal per game in the bundle, carrying the price the buyer actually
    // paid. Best-effort — a learning write must never break the relist chain.
    try {
      const soldSet = await DropSet.findById(row.set).lean();
      if (soldSet) {
        // A bulk pack (docs/bulk-packs/CONTRACT.md) is ONE listing holding N
        // accounts: N units at the per-account price, one login each, flagged
        // bulk so the discounted price never anchors single listings.
        const packLogins = row.bulkOfferId
          ? (row.units || []).map((u) => (u && u.login) || "").filter(Boolean)
          : null;
        // The account behind each of those logins, same order (FIXES-1 R3-1):
        // a pack unit its buyer later connects is then one sale, not two.
        const packAccountIds = row.bulkOfferId
          ? (row.units || [])
              .filter((u) => u && u.login)
              .map((u) => String(u.accountId || ""))
          : null;
        const packSize = row.bulkOfferId
          ? Math.max(1, (row.units || []).length)
          : 1;
        await recordListingSale({
          listing: row,
          set: soldSet,
          units: packSize,
          priceUsd: row.bulkOfferId
            ? Math.round(((Number(row.price) || 0) / packSize) * 100) / 100
            : Number(row.price) || 0,
          bulk: !!row.bulkOfferId,
          logins: packLogins,
          accountIds: packAccountIds,
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
    // A rent-farm row is a BUFFERED offer, and this is where its buyer's clock
    // starts. It sells a farming WINDOW, not stock: one pool account already
    // provisioned before the sale, no DropSet, and Gameflip released the
    // credentials the instant the buyer paid. So it must be routed away from
    // the auto-delivery lane below, which asks for an unsold account holding a
    // whole bundle and answers "Out of stock — no unsold account holds this
    // whole bundle" for a row that has no bundle at all. That is the failure
    // that took the five original Gameflip rent-farm offers down: the buyer
    // pays, waits for a delivery nothing can produce, and cancels.
    //
    // ABOVE the autoDeliver guard, deliberately. A buffered offer IS an
    // auto-delivery listing (gameflipFarmService writes autoDeliver: true), so
    // that guard would wave it straight through to the relist lane.
    //
    // Reconciling and learning from the sale above still applies to it; only
    // relisting does not. onBufferedSale takes its own atomic claim (on
    // rentFarmPoolId, not on status — this lane has already flipped status to
    // "sold" by now), so routing here twice cannot start two windows.
    if (row.rentFarm) {
      try {
        const r = await gfFarm.onBufferedSale(row);
        // onBufferedSale alerts the owner itself on every failure it can name,
        // because a paid order that cannot be honoured is not a log line. Echo
        // it to the console too so a pass reads straight.
        if (r && (r.error || r.skipped)) {
          console.error(
            "gameflip rent-farm sale " +
              row.externalId +
              ": " +
              (r.error || r.skipped),
          );
        }
      } catch (e) {
        // The money is taken and the credentials are already with the buyer, so
        // there is nothing here to roll back — only something to shout about.
        // Swallowing it keeps the rest of the fleet's sales being reconciled
        // this pass; letting it out of syncOnce would abandon every row after
        // this one, which is how one bad sale hides ten good ones.
        console.error(
          "gameflip rent-farm sale " + row.externalId + " threw:",
          e.message,
        );
      }
      continue;
    }
    // Reconciling and learning from a sale is for EVERY row; relisting is only
    // ever for the auto-delivery chain. A hand-made listing must never be
    // republished on the owner's behalf — that is their stock and their
    // decision. Today every non-autoDeliver row sits at qtyRemaining 0 so this
    // is belt-and-braces, but the guard is explicit rather than relying on data
    // that a future import could change.
    if (!row.autoDeliver) continue;
    if (row.bulkOfferId) continue; // a bulk pack is never relisted (docs/bulk-packs/CONTRACT.md H9)
    if ((Number(row.qtyRemaining) || 0) <= 0) continue;
    let img = "";
    try {
      const src = await relistSource(row);
      img = src.imagePath;
      await publishAutoDelivery({
        set: src.set,
        offer: src.offer,
        title: row.title,
        description: row.description,
        priceUsd: row.price,
        imagePath: img,
        qtyRemaining: row.qtyRemaining - 1,
        origin: row.origin,
        // A no-claim chain relists from the no-claim farm on the row's own
        // flag as well as its set's, never out of the archive.
        noclaim: row.noclaimStock === true,
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
    // Never a rent-farm row. Its replacement comes from topUpBuffer, which
    // publishes a NEW offer against a freshly provisioned account; republishing
    // the sold row would advertise the buyer's own credentials a second time.
    // Filtered in the QUERY rather than skipped in the loop below, because this
    // lane is capped at five and rows are taken oldest-deadline-first: a
    // buffered row can never succeed here (no set to rebuild the listing from),
    // so it would sit at the head of the window forever and starve exactly the
    // transient failures the retry exists for — the same starvation this file
    // already documents twice.
    rentFarm: { $ne: true },
    bulkOfferId: null, // a bulk pack is never relisted (docs/bulk-packs/CONTRACT.md H9)
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
    // CLAIM IT FIRST. The sold-row lane above takes its row with a conditional
    // findOneAndUpdate and says why ("so two overlapping passes can't both
    // relist"); this lane read with .lean(), published, and only THEN cleared
    // qtyRemaining. A pass that overlapped the previous one — trivial here,
    // because publishAutoDelivery can spend minutes inside gameflipPublish's
    // rate-limit backoff on a 60-second tick — read the same still-owing row and
    // published the same units a second time. Two live listings, one debt, and
    // the second one's account is spent for nothing.
    //
    // Pushing relistRetryAt into the future IS the claim: it is exactly the
    // field the `stalled` query filters on, so a concurrent pass stops seeing
    // the row. A crash mid-publish costs one lease of delay, not a lost chain,
    // and both exits below overwrite it anyway (success clears it,
    // noteRelistFailure sets its own backoff).
    const claimed = await MarketplaceListing.findOneAndUpdate(
      {
        _id: row._id,
        qtyRemaining: { $gt: 0 },
        $or: [
          { relistRetryAt: null },
          { relistRetryAt: { $exists: false } },
          { relistRetryAt: { $lte: new Date() } },
        ],
      },
      { $set: { relistRetryAt: new Date(Date.now() + RELIST_LEASE_MS) } },
    ).catch(() => null);
    if (!claimed) continue;
    let img = "";
    try {
      const src = await relistSource(row);
      img = src.imagePath;
      await publishAutoDelivery({
        set: src.set,
        offer: src.offer,
        title: row.title,
        description: row.description,
        priceUsd: row.price,
        imagePath: img,
        qtyRemaining: row.qtyRemaining - 1,
        origin: row.origin,
        noclaim: row.noclaimStock === true,
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

  // THE RENEWAL LANE (see LAPSED_RENEW_PER_PASS). A row settleLapsed queued
  // gets a fresh listing for its unit; qtyRemaining carries over unchanged
  // because nothing sold. Claimed first by pushing relistRetryAt into the
  // future — the same lease the stalled lane uses, so an overlapping pass can
  // never publish the same unit twice. Every failure backs off on the stalled
  // lane's schedule (5 min doubling, 12 h cap) and the row stays pending:
  // "out of stock" is often a dip — accounts on other listings, a token-scan
  // flap — and ending a 520-unit chain on one is a loss nothing would undo, so
  // like the stalled lane it is retried and the owner is told once, at the
  // RELIST_ALERT_AT_ATTEMPT-th miss. Not while the bulk sweep is down: that is
  // when Gameflip is throttling us, and a publish there only makes it worse.
  if (bulkSwept && renewsLapsedListings()) {
    const pending = await MarketplaceListing.find({
      marketplace: "gameflip",
      status: "removed",
      autoDeliver: true,
      rentFarm: { $ne: true },
      bulkOfferId: null,
      lastError: RENEWAL_PENDING_RE,
      $or: [
        { relistRetryAt: null },
        { relistRetryAt: { $exists: false } },
        { relistRetryAt: { $lte: new Date() } },
      ],
    })
      .sort({ relistRetryAt: 1, _id: 1 })
      .limit(LAPSED_RENEW_PER_PASS)
      .lean();
    for (const row of pending) {
      const claimed = await MarketplaceListing.findOneAndUpdate(
        {
          _id: row._id,
          status: "removed",
          lastError: RENEWAL_PENDING_RE,
          $or: [
            { relistRetryAt: null },
            { relistRetryAt: { $exists: false } },
            { relistRetryAt: { $lte: new Date() } },
          ],
        },
        { $set: { relistRetryAt: new Date(Date.now() + RELIST_LEASE_MS) } },
      ).catch(() => null);
      if (!claimed) continue;
      let img = "";
      try {
        const src = await relistSourceFn(row);
        img = src.imagePath;
        const fresh = await publishFn({
          set: src.set,
          offer: src.offer,
          title: row.title,
          description: row.description,
          priceUsd: row.price,
          imagePath: img,
          qtyRemaining: Math.max(0, Number(row.qtyRemaining) || 0),
          origin: row.origin,
          noclaim: row.noclaimStock === true,
        });
        // The unit and the chain's debt now live on the new row; clearing them
        // here is what stops this lane ever publishing the same unit again.
        await MarketplaceListing.updateOne(
          { _id: row._id },
          {
            $set: {
              qtyRemaining: 0,
              relistAttempts: 0,
              relistRetryAt: null,
              lastError:
                "expired on Gameflip — renewed as " +
                ((fresh && fresh.externalId) || "a new listing"),
            },
          },
        ).catch(() => {});
        renewed++;
        console.log(
          "gameflip renewal: " + row.externalId + " -> " +
            ((fresh && fresh.externalId) || "?") + " (" + (row.title || "") + ")",
        );
      } catch (e) {
        // The same stop as the sold lanes: a renewal that kept an account
        // held, or went live without a row, is not tried again with another
        // account five minutes later (the row no longer reads "renewal
        // pending", so this lane never picks it up again).
        if (await stopRelistChain(row, String((e && e.message) || e))) continue;
        const msg = String((e && e.message) || e).slice(0, 200);
        const attempts = (Number(row.relistAttempts) || 0) + 1;
        const dry = isOutOfStockError(msg);
        await MarketplaceListing.updateOne(
          { _id: row._id },
          {
            $set: {
              relistAttempts: attempts,
              relistRetryAt: new Date(Date.now() + relistRetryDelayMs(attempts)),
              lastError:
                RENEWAL_PENDING + " (attempt " + attempts + " failed: " + msg + ")",
            },
          },
        ).catch(() => {});
        console.error("gameflip renewal " + row.externalId + " failed: " + msg);
        // Only when a row FIRST reaches its RELIST_ALERT_AT_ATTEMPT-th miss —
        // a chain stuck for days must not page every hour, nor after every
        // restart — and at most once an hour across rows, as one summary.
        if (
          dry &&
          attempts === RELIST_ALERT_AT_ATTEMPT &&
          Date.now() - renewalAlertAt >= RENEWAL_ALERT_EVERY_MS
        ) {
          renewalAlertAt = Date.now();
          const waiting = await MarketplaceListing.countDocuments({
            marketplace: "gameflip",
            status: "removed",
            lastError: /^expired on Gameflip — renewal pending \(attempt \d+ failed: Out of stock/,
          }).catch(() => 0);
          sendTelegram(
            "⚠️ Gameflip renewals are OUT OF STOCK\n\n" +
              Math.max(1, waiting) + " expired listing(s) cannot be renewed yet — no " +
              "unsold account holds the whole bundle right now (e.g. " +
              (row.title || "an untitled listing") + ", " +
              (Number(row.qtyRemaining) || 0) + " more unit(s) owed).\n" +
              "They retry on their own, up to 12 h apart. At most one of these an hour.",
          ).catch((err) => console.error("gameflip renewal alert:", err.message));
        } else if (
          !dry &&
          attempts === STUCK_ALERT_AT_ATTEMPT &&
          Date.now() - renewalStuckAlertAt >= STUCK_ALERT_EVERY_MS
        ) {
          renewalStuckAlertAt = Date.now();
          const stuck = await MarketplaceListing.countDocuments({
            marketplace: "gameflip",
            status: "removed",
            relistAttempts: { $gte: STUCK_ALERT_AT_ATTEMPT },
            lastError: /^expired on Gameflip — renewal pending \(attempt \d+ failed: (?!Out of stock)/,
          }).catch(() => 0);
          sendTelegram(
            "⚠️ Gameflip renewals keep FAILING\n\n" +
              Math.max(1, stuck) + " expired listing(s) have failed renewal " +
              STUCK_ALERT_AT_ATTEMPT + "+ times for a reason other than stock, " +
              "so the units they owe are not on sale (e.g. " +
              (row.title || "an untitled listing") + ", " +
              (Number(row.qtyRemaining) || 0) + " more unit(s) owed). Last error:\n" + msg +
              "\n\nThey keep retrying, up to 12 h apart. At most one of these an hour.",
          ).catch((err) => console.error("gameflip renewal alert:", err.message));
        }
      } finally {
        if (img) await fsp.unlink(img).catch(() => {});
      }
    }
  }
  return { checked: due.length, sold, relisted, renewed };
}

// Background watcher so sales are picked up (and the next unit relisted)
// without anyone opening the admin page. No-op when Gameflip keys are unset
// or nothing is listed — syncOnce just finds zero rows / fails quietly.
const TICK_MS = 60 * 1000;
let started = false;

// The rent-farm buffer tops up on its own, slower, clock.
//
// It has to be CALLED by something or the shelf never fills — and until this
// existed nothing in the repo called topUpBuffer at all, so the service was
// inert while the health check happily reported "0 live of 100 target" as ok.
//
// Its own pass is bounded (perPass, default 5) and every publish is a
// rate-limited Gameflip create, so it runs on a much slower clock than the
// 60-second sale watcher: sale detection is time-critical for a buyer who has
// already paid, restocking a shelf is not, and both share one rate limiter.
//
// It self-guards on autoFarm.gameflipRentFarm (OFF by default) and on
// gfBufferDryRun (dry run by default), so starting it unconditionally is safe:
// nothing publishes until both are deliberately set.
const BUFFER_TICK_MS = 15 * 60 * 1000;

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

  const bufferTick = async () => {
    // Sales that died half-way are finished first (a buyer has paid for them).
    try {
      const s = await gfFarm.retryUnfinishedSales();
      if (s && s.retried) {
        console.log("gameflip rent-farm: retried " + s.retried + " unfinished sale(s), finished " + s.finished);
      }
    } catch (e) {
      console.error("gameflip rent-farm sale retry error:", e.message);
    }
    // Live offers whose account cannot deliver are paged (never delisted here).
    try {
      await gfFarm.alertBadLiveOffers();
    } catch (e) {
      console.error("gameflip rent-farm bad-offer check error:", e.message);
    }
    try {
      const r = await gfFarm.topUpBuffer();
      if (r && (r.published || r.stopped)) {
        console.log(
          "gameflip rent-farm buffer: published " + (r.published || 0) +
            (r.stopped ? " — stopped: " + r.stopped : ""),
        );
      }
    } catch (e) {
      console.error("gameflip rent-farm buffer error:", e.message);
    }
    const b = setTimeout(bufferTick, BUFFER_TICK_MS);
    if (b.unref) b.unref();
  };
  // First pass one tick in, not at boot: let the sale watcher and the session
  // refreshers settle before adding publishes to the same rate limiter.
  const b = setTimeout(bufferTick, BUFFER_TICK_MS);
  if (b.unref) b.unref();
}

module.exports = {
  GF_CLAIM_TAG,
  claimAccountForSet,
  releaseAccount,
  gameflipDeliveryCode,
  accountListingText,
  publishAutoDelivery,
  relistNoclaimSuccessor,
  syncOnce,
  start,
  // The Gameflip code check, for every other path that puts a code on Gameflip
  // (autoLister's first unit of a campaign).
  gameflipCodeHeldLogins,
  noteIfCodeRefused,
  failedPublishRemains,
  HELD_MARK,
  TRACKED_MARK,
  // exported for tests
  noteRelistFailure,
  relistRetryDelayMs,
  UNPLACED_POLL_LIMIT,
  LAPSED_END_LIMIT,
  LAPSED_RENEW_PER_PASS,
  resetRenewalAlert,
  isOutOfStockError,
  RELIST_RETRY_MAX_MS,
  STUCK_ALERT_AT_ATTEMPT,
  CODE_REFUSED_TTL_MS,
  resetCodeRefused: () => codeRefusedAt.clear(),
};
