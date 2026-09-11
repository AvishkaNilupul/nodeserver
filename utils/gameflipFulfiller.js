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
const { sendTelegram } = require("./telegram");
const {
  reserveSetOnAccount,
  releaseAccountsForTag,
  releaseSetForAccounts,
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
async function releaseBufferedRow(row, reason) {
  try {
    const r = await gfFarm.releaseBuffered(row, { reason });
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
async function releaseSuppliedUnits(row, reason) {
  const ids = (row.units || [])
    .map((u) => (u && u.contentId ? String(u.contentId) : ""))
    .filter(Boolean);
  if (!ids.length) return;
  try {
    const supplied = require("./suppliedStock");
    await supplied.releaseClaim(ids, {
      orderId: (row.units[0] && row.units[0].orderId) || "",
    });
  } catch (e) {
    console.error(
      "gameflip account listing " +
        (row.externalId || row._id) +
        " (" +
        reason +
        "): could not hand its accounts back:",
      e.message,
    );
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
    await releaseNoclaimClaim(acc, "no readable password");
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
      autoDeliverCode: gameflipDeliveryCode(login, acc.password),
    });
  } catch (e) {
    // Matching release, exactly as the other lanes release theirs: a publish
    // that threw must not leave the account committed to a listing that does
    // not exist.
    await releaseNoclaimClaim(acc, "gameflip publish failed");
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
    throw e;
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

// Hand a claimed-but-never-published no-claim account back. A release that
// fails leaves the account committed ("manual") to a listing that does not
// exist, so it is loud — and it is never allowed to mask the error that made
// the publish fail in the first place.
async function releaseNoclaimClaim(acc, reason) {
  try {
    await noclaimStock().releaseClaim([acc.ledgerId], { reason });
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

// The no-claim sibling of the retire-path releases above (archive reservation,
// rent-farm buffer, supplied units). A no-claim row carries accountId "" by
// design — its account is a no-claim ledger, not an archive reservation — so
// none of those can reach its stock, and without this the account would stay
// committed behind a listing that no longer exists. onGameflipRetired releases
// only a still-"manual" ledger, so a unit a buyer paid for is never handed
// back. Best-effort like its siblings: the row is already terminal.
async function retireNoclaimUnit(row, reason) {
  try {
    await noclaimListings().onGameflipRetired(row, { reason });
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
          await retireNoclaimUnit(row, "listing 404 on Gameflip");
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
    if (status === "expired" || status === "cancelled") {
      const retired = await MarketplaceListing.findOneAndUpdate(
        { _id: row._id, status: "active" },
        {
          $set: {
            status: "removed",
            lastError:
              "gameflip reports \"" + status + "\" — retired by the watcher",
          },
        },
      ).catch(() => null);
      // Same split as the 404 branch: a rent-farm row has no set.
      if (retired && row.rentFarm) {
        await releaseBufferedRow(row, "gameflip reports \"" + status + "\"");
      } else if (retired && row.accountId) {
        await releaseAccount(row.accountId, row.set).catch(() => {});
      } else if (retired && row.accountOffer) {
        await releaseSuppliedUnits(row, "gameflip reports \"" + status + "\"");
      }
      if (retired && row.noclaimStock) {
        await retireNoclaimUnit(row, "gameflip reports \"" + status + "\"");
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
  return { checked: due.length, sold, relisted };
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
  // exported for tests
  relistRetryDelayMs,
  isOutOfStockError,
  RELIST_RETRY_MAX_MS,
};
