// Auto-listing: the moment auto-farm bots start on a campaign, publish a
// Gameflip auto-delivery listing for the bundle — mirroring the owner's manual
// "create the listing while it's still farming" early-bird flow. Buyers who
// purchase early receive an account that finishes farming within hours (the
// exact trade-off the owner already makes by hand).
//
// Title/description follow the seller's house style (verified against their
// live Gameflip profile), price comes from market research, and the existing
// gameflipFulfiller relist chain takes over after the first sale.
const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");
const DropLog = require("../models/DropLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const MarketResearch = require("../models/MarketResearch");
const { gameflipDeliveryCode, GF_CLAIM_TAG } = require("./gameflipFulfiller");
const {
  digisellerDeliveryCode,
  DS_CLAIM_TAG,
} = require("./digisellerFulfiller");
const { ggselDeliveryCode, GG_CLAIM_TAG } = require("./ggselFulfiller");
// ZeusX sells the same accounts, so its reservations need their own tag or a
// release on one market would free stock another market is selling.
const ZX_CLAIM_TAG = "zeusx";
const {
  reserveSetOnAccount,
  releaseSetForAccounts,
  AVAILABLE_DROP,
} = require("./dropReservation");
const settings = require("./settings");
const mp = require("./marketplaces");
const { decrypt } = require("./secretBox");
const { buildSetGridImage } = require("./setImage");
const accountState = require("./twitchAccountState");

const fsp = require("fs/promises");

/* --------------------------- campaign details --------------------------- */

// Normalise a label to bare alphanumerics for placeholder comparison
// ("AC Black Flag Resynced" -> "acblackflagresynced").
function normLabel(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

// A benefit whose name is really just the game or campaign title is NOT a real
// drop item — it's Twitch handing back an unresolved/placeholder benefit
// (observed: a campaign whose only "drop" was named "AC Black Flag Resynced",
// the campaign title itself). Real drops have specific reward names
// ("Rustborne Swords", "Cheetah Claw Cat"). Refuse to treat a title as an item
// so we never build a set around a fake itemKey that no account can ever hold.
function looksLikeTitlePlaceholder(name, { game, campaignName }) {
  const n = normLabel(name);
  if (!n) return true;
  const g = normLabel(game);
  const c = normLabel(campaignName);
  return (!!g && n === g) || (!!c && n === c);
}

// Turn a fetched campaign-details object into deduped item rows, dropping any
// benefit that is really just the game/campaign title. Pure (no I/O) so the
// placeholder guard is unit-testable. `rawBenefits` counts benefits seen
// BEFORE filtering, so the caller can tell "campaign resolved but every benefit
// was a placeholder" (don't publish) apart from "campaign didn't resolve at
// all" (try another token).
function resolveCampaignItems(camp, { game, campaignName }) {
  const items = [];
  const seen = new Set();
  let rawBenefits = 0;
  for (const d of (camp && camp.timeBasedDrops) || []) {
    for (const e of d.benefitEdges || []) {
      const b = e && e.benefit;
      if (!b || !b.name) continue;
      rawBenefits++;
      if (looksLikeTitlePlaceholder(b.name, { game, campaignName })) continue;
      const g = (b.game && b.game.name) || game || "";
      const key =
        String(b.name).trim().toLowerCase() +
        "|" +
        String(g).trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        itemKey: key,
        name: String(b.name),
        game: g,
        // Real Twitch item artwork — setImage downloads it for the cover
        // grid, exactly like the manually created listings.
        image: String(b.imageAssetURL || ""),
        qty: 1,
        requiredMinutes: Number(d.requiredMinutesWatched) || 0,
      });
    }
  }
  return { items, rawBenefits };
}

// Borrow a healthy bot-account token (same trick campaignWatcher uses) to ask
// Twitch what items this campaign actually gives, before anything is farmed.
// Refuses to return a set built only from a title placeholder (the AC bug).
async function campaignItems(campaignId, game, campaignName) {
  const { fetchCampaignDetails } = require("./twitchInventory");
  // fetchCampaignDetails is integrity-gated: a token whose last scan failed
  // integrity will throw "Campaign details unavailable". So prefer known-good
  // (lastScanStatus:"ok") tokens FIRST — pulled in their own query so the
  // limit doesn't fill up with recently-scanned-but-integrity-failed tokens
  // before the ok ones are even considered (the old code did .limit(5) BEFORE
  // the ok-first sort, so a relist could fail with healthy tokens sitting
  // right there). Fall back to any token if no ok one works.
  const okC = await BotAccount.find({
    clientSecret: { $exists: true, $ne: "" },
    lastScanStatus: "ok",
  })
    .sort({ lastScanAt: -1 })
    .limit(8)
    .lean();
  const anyC = await BotAccount.find({
    clientSecret: { $exists: true, $ne: "" },
  })
    .sort({ lastScanAt: -1 })
    .limit(8)
    .lean();
  const seen = new Set();
  const ordered = [];
  for (const a of [...okC, ...anyC]) {
    const s = String(a.clientSecret || "");
    if (s && !seen.has(s)) {
      seen.add(s);
      ordered.push(a);
    }
  }
  let lastErr = null;
  let sawPlaceholderOnly = false;
  for (const acc of ordered) {
    try {
      const camp = await fetchCampaignDetails(acc.clientSecret, campaignId);
      const { items, rawBenefits } = resolveCampaignItems(camp, {
        game,
        campaignName,
      });
      if (items.length) return items;
      // The campaign resolved, but every benefit it returned was a title
      // placeholder (or there were none). There is nothing real to sell here —
      // probing another token won't change that, and publishing would create
      // the exact fake-item listing we're guarding against.
      if (rawBenefits > 0) sawPlaceholderOnly = true;
    } catch (e) {
      lastErr = e;
    }
  }
  if (sawPlaceholderOnly) {
    throw new Error(
      "Campaign " +
        campaignId +
        " (" +
        (campaignName || game) +
        ") has no resolvable drop items — only the campaign/game title. " +
        "Not publishing.",
    );
  }
  if (lastErr) throw lastErr;
  throw new Error("No bot tokens available for campaign details");
}

/* ------------------------- title / description -------------------------- */

// House title style (matches the seller's live listings):
//   "{Game} Twitch Drops ({N} Items) — {Item A} + {Item B} +{N-2} more"
// with graceful truncation to Gameflip's 120-char limit.
//
// The title is the same before and after a campaign ends. An earlier version
// prefixed post-event listings with "[EVENT ENDED]"; it burns characters of a
// 120-char limit, and the buyer is shopping for the drops, not the campaign.
function buildTitle({ game, items, campaignName }) {
  const n = items.length;
  const names = items.map((i) => i.name);
  const prefix = game + " Twitch Drops";
  const countBit = " (" + n + " Item" + (n === 1 ? "" : "s") + ")";
  let tail = "";
  if (names.length) {
    const first = names.slice(0, 2).join(" + ");
    const more = n > 2 ? " +" + (n - 2) + " more" : "";
    tail = " — " + first + more;
  } else if (campaignName) {
    tail = " — " + campaignName;
  }
  let title = prefix + countBit + tail;
  if (title.length > 120) {
    const one = names[0] ? " — " + names[0] + " +" + (n - 1) + " more" : "";
    title = prefix + countBit + one;
  }
  if (title.length > 120) title = (prefix + countBit).slice(0, 120);
  return title;
}

// House description: item list first, then the seller's standard sections
// (check before buying / multi-purchase warning / activation window / pitch).
function buildDescription({ game, items, campaignName, postEvent }) {
  const lines = [];
  if (postEvent) {
    lines.push(
      "THE " +
        (campaignName || game) +
        " DROP EVENT IS OVER — these items can no longer be earned by " +
        "watching streams. Accounts farmed during the event are the only " +
        "remaining supply, and the drops still redeem instantly when you " +
        "connect the account.",
      "",
    );
  } else if (campaignName) {
    lines.push(game + " — " + campaignName + " Twitch Drops.", "");
  }
  lines.push("Includes:");
  for (const i of items) {
    lines.push(
      "- " +
        ((i.qty || 1) > 1 ? i.qty + "\u00d7 " : "") +
        i.name +
        (i.game ? " (" + i.game + ")" : ""),
    );
  }
  // NB: the item list above is the whole advertised bundle \u2014 deliberately just
  // the set. A delivered account carries far more (this one held 87 extra
  // drops), and an earlier version enumerated those in a "Bonus" block. Don't
  // reintroduce it: it made a 5-item listing read as a 56-item one, and it
  // advertised drops that are often reserved to OTHER buyers, inviting the
  // buyer to claim them (the cross-buyer theft dropReservation exists to stop).
  lines.push(
    "",
    "You receive a Twitch account with ALL of the above drops sitting " +
      "unclaimed in its inventory. Log in, press Connect, and claim " +
      "everything to YOUR OWN game account.",
    "",
    "\ud83d\udc8e Please check the item list carefully before buying.",
    "",
    "\ud83d\udca1 Buying more than one? Each purchase delivers a different " +
      "account — every bundle can be claimed once per game account.",
    "",
    "\u269c\ufe0f Please redeem the drops within the first hour after " +
      "delivery. The account is guaranteed at the moment of delivery.",
    "",
    "\ud83d\ude80 Seller's comment: instant auto-delivery, farmed by me, " +
      "clean accounts. Check my profile for more Twitch drop bundles.",
    "",
    "\ud83d\udcac Any issue or question — message me here on Gameflip " +
      "before opening a dispute. I reply fast and always make it right.",
  );
  return lines.join("\n").slice(0, 5000);
}

/* ------------------------------ hold-back split -------------------------- */

// "Farm 6, list 3 now, save the rest": half the farmed accounts (rounded up)
// go on sale immediately at the early-bird price; the remainder is held back
// and only released into the listing AFTER the event ends, at the +50%
// post-event price — when supply is frozen and each account is worth more.
function computeSplit(qty) {
  const n = Math.max(0, Number(qty) || 0);
  if (n <= 1) return { listNow: n, holdBack: 0 };
  const listNow = Math.ceil(n / 2);
  return { listNow, holdBack: n - listNow };
}

/* --------------------------------- price -------------------------------- */

function round25(x) {
  return Math.round(x * 4) / 4;
}

// Price from market research: what buyers actually PAID on Gameflip beats
// asking prices; competitor floors (GGSel/Plati/Gameflip active) refine it.
// postEventMultiplier applies the scarcity markup once farming is impossible.
// Minimum verified sales before avgSoldPrice is trusted as an anchor. Below
// this the mean is one or two rows and can be a bundle: Hunt: Showdown shows
// $28.20 over 5 sales while its cheapest live listing is $0.75.
const MIN_SOLD_SAMPLES = 3;
// Hard ceiling on the anchor, for the same reason. Realised own price is $1.25;
// anything above this is a multi-account bundle, not our single-account product.
const MAX_ANCHOR_USD = 10;

function derivePrice(research, { postEventMultiplier = 1 } = {}) {
  const m = (research && research.markets) || {};
  const gf = m.gameflip || {};

  // Price against the marketplace we are actually selling on, and NOTHING else.
  //
  // This used to take Math.min across Gameflip, GGSel and Plati. GGSel and Plati
  // are Russian, ruble-denominated marketplaces: live prod shows ggsel.lowest at
  // $0.38 and plati.lowest at $1.28 (Plati's ~100 RUB platform floor) while the
  // cheapest live GAMEFLIP competitor for the same game is $1.20. Taking the min
  // let a ruble floor set the price of a USD listing, undercut it 5%, and hit
  // Gameflip's $0.75 clamp — so Rocket League, with 20 verified sales averaging
  // $7.93, was listed at $0.75. Different marketplace, different currency,
  // different buyer; it is not competition for this listing.
  //
  // The old shape was also unreachable: `candidates` already contained
  // avgSoldPrice, so `floor` was <= avgSoldPrice by construction and
  // `Math.min(avgSoldPrice, floor * 0.95)` always collapsed to floor * 0.95.
  // The "anchor on real sold prices" branch could never anchor on anything.
  const soldEnough = Number(gf.soldRecent) >= MIN_SOLD_SAMPLES;
  const sold = soldEnough
    ? Math.min(Number(gf.avgSoldPrice) || 0, MAX_ANCHOR_USD)
    : 0;
  const rival = Number(gf.lowest) > 0 ? Number(gf.lowest) : 0;

  let base;
  if (rival > 0 && sold > 0) {
    // Undercut the cheapest live Gameflip listing to be the one that sells, but
    // never price above what buyers have actually paid.
    base = Math.min(sold, rival * 0.95);
  } else if (rival > 0) {
    base = rival * 0.95;
  } else if (sold > 0) {
    // No live competition — the proven sold price stands on its own.
    base = sold;
  } else {
    // No Gameflip signal of any kind. Only here do the other marketplaces get a
    // say: a ruble floor is a poor guide for a USD listing, but it beats
    // guessing. (The bug this replaces let them override Gameflip evidence
    // rather than merely stand in for its absence.)
    const others = [];
    if (m.ggsel && Number(m.ggsel.lowest) > 0)
      others.push(Number(m.ggsel.lowest));
    if (m.plati && Number(m.plati.lowest) > 0)
      others.push(Number(m.plati.lowest));
    base = others.length ? Math.min(...others) * 0.95 : 1.0;
  }
  let priced = round25(base * postEventMultiplier);
  // Rounding to the nearest quarter can undo the undercut: a $1.20 rival gives
  // base $1.14, which round25 lifts back to $1.25 — above the listing we were
  // trying to beat. Step to the first quarter strictly below the rival so the
  // "be the one that sells" intent survives. Only when we are not applying the
  // post-event scarcity markup, which is deliberately meant to price high.
  if (postEventMultiplier === 1 && rival > 0 && priced >= rival) {
    priced = Math.floor((rival - 0.01) * 4) / 4;
  }
  return Math.max(0.75, priced);
}

/* ------------------------------- publishing ------------------------------ */

// Pick a delivery account from the task's assigned pool accounts: needs a
// ---- Holdings gate (the fix for wrong/incomplete auto-delivered content) ----
//
// The initial auto-list path used to attach accounts straight from
// task.assignedAccounts after only checking "exists + has password + not
// already listed" — it NEVER verified the account actually holds the promised
// drops. Accounts still mid-farm (partial bundle), accounts that farmed a
// DIFFERENT campaign of the same game, or accounts holding none of the promised
// itemKeys all sailed through, so buyers received wrong/incomplete accounts.
//
// The Shop path (routes/shopRoutes.js availableAccountsForSet) already does the
// right thing: only accounts holding EVERY item in the set, unconnected and
// unsold, with the required per-item copy count. This gate applies that same
// verification to the initial path, intersected with the task's own accounts.
// (Mirrors shopRoutes.holdingsForKeys/sellableAccountMap deliberately rather
// than importing the routes layer into a util; keep the two in sync — a shared
// utils/holdings module is the natural future refactor.)

// Pure: given holdings-aggregation rows (account -> { have, items:[{k,count}] }),
// a map accId -> { login, password }, the per-key required copy counts, and the
// set of assigned logins (lowercased), return the deliverable, verified
// accounts. Exported for unit tests — this is the load-bearing decision.
function filterVerifiedHolders(rows, accById, { needByKey, assignedLower }) {
  const out = [];
  for (const r of rows || []) {
    const acc = accById.get(String(r._id));
    if (!acc) continue; // no BotAccount resolved / not deliverable
    // Must be one of THIS task's assigned accounts (an assigned-scoped sale).
    if (
      assignedLower &&
      assignedLower.size &&
      !assignedLower.has(String(acc.login || "").toLowerCase())
    ) {
      continue;
    }
    if (!acc.password) continue; // buyer needs a usable password
    // A dead token means the credentials likely changed — the drops are on
    // the account but the delivered login may not work. Never sell those. A
    // suspended account is worse still: there is nothing on the other end of
    // the login at all.
    if (accountState.isUnusableScanStatus(acc.scanStatus)) continue;
    // Holds at least the required number of copies of EVERY promised item.
    const enough = (r.items || []).every(
      (it) => (it.count || 0) >= (needByKey.get(it.k) || 1),
    );
    if (!enough) continue;
    out.push({ login: acc.login, password: acc.password, accountId: r._id });
  }
  return out;
}

// Assigned accounts that ACTUALLY hold EVERY item in `items`, unconnected and
// unsold (per-drop reservation via AVAILABLE_DROP), with a usable password.
// Same verification as the Shop's availableAccountsForSet, intersected with the
// task's assigned accounts.
async function verifiedHoldersForItems(task, items) {
  const keys = [
    ...new Set((items || []).map((i) => i.itemKey).filter(Boolean)),
  ];
  if (!keys.length) return [];
  const needByKey = new Map(
    (items || [])
      .filter((i) => i.itemKey)
      .map((i) => [i.itemKey, Math.max(1, Number(i.qty) || 1)]),
  );
  const assignedLower = new Set(
    (task.assignedAccounts || []).map((u) => String(u).toLowerCase()),
  );
  if (!assignedLower.size) return [];
  // Accounts holding ALL keys, counting only available (unconnected + unsold)
  // drops. `have === keys.length` is the "holds the WHOLE bundle" gate.
  const rows = await DropLog.aggregate([
    { $match: { itemKey: { $in: keys }, ...AVAILABLE_DROP } },
    {
      $group: {
        _id: { account: "$account", k: "$itemKey" },
        count: { $sum: "$count" },
      },
    },
    {
      $group: {
        _id: "$_id.account",
        have: { $sum: 1 },
        items: { $push: { k: "$_id.k", count: "$count" } },
      },
    },
    { $match: { have: keys.length } },
  ]);
  if (!rows.length) return [];
  const accs = await BotAccount.find(
    { _id: { $in: rows.map((r) => r._id) } },
    { login: 1, credPassword: 1, lastScanStatus: 1 },
  ).lean();
  const accById = new Map(
    accs.map((a) => [
      String(a._id),
      {
        login: a.login,
        password: decrypt(a.credPassword),
        scanStatus: a.lastScanStatus || "",
      },
    ]),
  );
  return filterVerifiedHolders(rows, accById, { needByKey, assignedLower });
}

// Up to `max` VERIFIED delivery accounts for this task's bundle. Every returned
// account provably holds the full set (unconnected + unsold), belongs to the
// task, has a usable password, and isn't already attached to another active
// listing (one account sells once). Returns { login, password, accountId }.
//
// `items` is REQUIRED — it's what the holdings gate verifies against. An
// assigned account that hasn't finished farming the whole bundle is simply not
// eligible yet: 0 eligible => list nothing this sweep, retry next (the honest
// early-bird behaviour — only list accounts that have actually completed).
async function pickDeliveryAccounts(task, max, items) {
  const verified = await verifiedHoldersForItems(task, items);
  if (!verified.length) return [];
  // Exclude any login already live on another active listing (accountLogin can
  // be a comma/space-separated list on Plati/GGSel rows). Per-drop reservation
  // covers committed sales; this also guards the window before a concurrent
  // listing commits its reservation.
  const used = new Set();
  for (const r of await MarketplaceListing.find(
    { status: "active" },
    { accountLogin: 1 },
  ).lean()) {
    for (const l of String(r.accountLogin || "").split(/[,\s]+/)) {
      if (l) used.add(l.toLowerCase());
    }
  }
  const out = [];
  for (const acc of verified) {
    if (out.length >= max) break;
    if (used.has(String(acc.login).toLowerCase())) continue;
    out.push(acc);
  }
  return out;
}

// Reserve every account's drops for this set before its credentials go out
// as a real delivery code — the actual commit point, not pickDeliveryAccounts
// (see the comment there). Filters out any account that lost the race (e.g.
// a Shop sale claimed it a moment earlier); the caller ends up delivering
// fewer units than requested rather than handing out drops twice.
async function reserveAccountsForPublish(accounts, set, tag) {
  const out = [];
  for (const a of accounts) {
    const ok = await reserveSetOnAccount(a.accountId, set, {
      soldToUsername: tag,
      soldSetId: String(set._id),
    });
    if (ok) out.push(a);
  }
  return out;
}

// Same idea, for Gameflip's single immediately-shipped unit: try candidates
// in order and reserve+return the first one that still holds the bundle.
async function reserveOneForDelivery(accounts, set, tag) {
  for (const a of accounts) {
    const ok = await reserveSetOnAccount(a.accountId, set, {
      soldToUsername: tag,
      soldSetId: String(set._id),
    });
    if (ok) return a;
  }
  return null;
}

// Release the reservation made for THIS attempt on `set` from `accounts`. Keyed
// on set._id (not the market tag) so it frees exactly this attempt's drops and
// can never overreach into another set the same account may be reserved for
// under the same tag. `accounts` may be one {accountId} or an array of them.
async function releaseReservedForSet(accounts, set) {
  const list = Array.isArray(accounts) ? accounts : [accounts];
  const ids = list
    .map((a) => a && a.accountId)
    .filter(Boolean)
    .map(String);
  if (!ids.length || !set || !set._id) return;
  await releaseSetForAccounts(ids, String(set._id));
}

// Run `doPublish` after a reservation is already held for `reserved` on `set`;
// if it throws, release that reservation before rethrowing so a failed publish
// never strands stock (a Gameflip 429 after reserving, a Digiseller timeout,
// etc.). A failure of the release itself is swallowed — the ORIGINAL publish
// error is always what surfaces, never masked by rollback trouble.
async function withReservationRollback(
  reserved,
  set,
  doPublish,
  { release = releaseReservedForSet } = {},
) {
  try {
    return await doPublish();
  } catch (err) {
    try {
      await release(reserved, set);
    } catch {
      /* never let a rollback failure hide the real publish error */
    }
    throw err;
  }
}

// ---- Secondary-market publishers, shared by the initial listing and the
// sweep retry. Each returns { externalId, url, qty } on success and throws
// on failure; the caller records the error without touching other markets.
async function publishPlatiShare({
  set,
  title,
  description,
  price,
  img,
  accounts,
  categoryId,
}) {
  // The Plati "Twitch" cataloguer category (34187) has a REQUIRED "Content
  // type" attribute; without it the create is rejected ("marketplace-1: you
  // can not add goods"). Auto-farm only ever lists Twitch-drop accounts, so
  // pass the configured attribute (default: Content type = Twitch Drops
  // Accounts, 91328 -> 183570) alongside the category.
  accounts = await reserveAccountsForPublish(accounts, set, DS_CLAIM_TAG);
  if (!accounts.length) {
    throw new Error(
      "no account still held the full bundle unclaimed at publish time",
    );
  }
  // reserve → publish → (on throw) release the reservation so a failed publish
  // never strands the account's drops.
  return withReservationRollback(accounts, set, async () => {
    const attributes = settings.getAutoFarm().platiAttributes || [];
    const r = await mp.digisellerPublish({
      title,
      description,
      priceUsd: price,
      categories: [{ owner: 1, categoryId, attributes }],
    });
    let contentIds = [];
    try {
      const added = await mp.digisellerAddContent(
        r.externalId,
        accounts.map((a) => digisellerDeliveryCode(a.login, a.password)),
      );
      contentIds = (added && added.contentIds) || [];
    } catch (err) {
      await mp.digisellerDelist(r.externalId).catch(() => {});
      throw err;
    }
    if (img) {
      await mp.digisellerUploadImage(r.externalId, img).catch(() => {});
    }
    await MarketplaceListing.create({
      set: set._id,
      marketplace: "digiseller",
      externalId: r.externalId,
      url: r.url || "",
      title,
      description,
      // What Plati actually charges: the connector lifts anything under the
      // platform floor, so the published price can differ from the model's.
      price: r.price || price,
      status: "active",
      origin: "auto",
      note: "auto-farm: " + accounts.length + " account(s)",
      autoDeliver: true,
      accountLogin: accounts.map((a) => a.login).join(", "),
      qtyTarget: accounts.length,
      // Record which unit belongs to which account. Digiseller has no endpoint
      // that lists a product's content, so an id not captured here can NEVER be
      // targeted again — a single bad unit then has no remedy but delisting the
      // whole product (which is exactly what the EA FC listings needed on
      // 2026-07-30, having been fed before this bookkeeping existed).
      units: accounts.map((a, i) => ({
        accountId: String(a.accountId || ""),
        login: a.login,
        contentId: contentIds[i] || "",
      })),
    });
    return { externalId: r.externalId, url: r.url || "", qty: accounts.length };
  });
}

async function publishGgselShare({
  set,
  title,
  description,
  price,
  img,
  accounts,
  categoryId,
}) {
  accounts = await reserveAccountsForPublish(accounts, set, GG_CLAIM_TAG);
  if (!accounts.length) {
    throw new Error(
      "no account still held the full bundle unclaimed at publish time",
    );
  }
  // reserve → publish → (on throw) release the reservation.
  return withReservationRollback(accounts, set, async () => {
    const r = await mp.ggselPublish({
      title,
      description,
      priceUsd: price,
      categoryId,
      delivery: "auto",
      coverImagePath: img,
      products: accounts.map((a) => ggselDeliveryCode(a.login, a.password)),
    });
    await MarketplaceListing.create({
      set: set._id,
      marketplace: "ggsel",
      externalId: r.externalId,
      url: r.url || "",
      title,
      description,
      price,
      status: "active",
      origin: "auto",
      note:
        (r.note ? r.note + " " : "") +
        "auto-farm: " +
        accounts.length +
        " account(s)",
      autoDeliver: true,
      accountLogin: accounts.map((a) => a.login).join(", "),
      qtyTarget: accounts.length,
    });
    return { externalId: r.externalId, url: r.url || "", qty: accounts.length };
  });
}

// True when the ZeusX game map covers this game (exact or fuzzy, matching the
// connector's own lookup).
function zeusxGameMapped(af, game) {
  const map = (af && af.zeusxGames) || {};
  const key = String(game || "")
    .trim()
    .toLowerCase();
  if (!key) return false;
  return Object.keys(map).some(
    (k) => k === key || key.includes(k) || k.includes(key),
  );
}

// ZeusX share. Two modes, chosen by the zeusxAutoDeliver switch:
//
//  • OFF (default): one "Coordinated" offer for the whole share (quantity N).
//    Accounts are reserved so they're never sold twice on another market, then
//    handed over by hand in ZeusX chat and marked sold from the Drop Archive.
//
//  • ON: native ZeusX "Automatic" delivery — ZeusX carries the credential and
//    hands it to the buyer the instant they pay (no chat, no manual step, like
//    the Gameflip/FunPay auto-delivery here). ZeusX only accepts ONE credential
//    per offer (game_account is a single object — verified live), so each
//    reserved account becomes its own single-stock listing.
async function publishZeusxShare({
  set,
  title,
  description,
  price,
  img,
  accounts,
  game,
}) {
  const autoDeliver = !!settings.getAutoFarm().zeusxAutoDeliver;
  accounts = await reserveAccountsForPublish(accounts, set, ZX_CLAIM_TAG);
  if (!accounts.length) {
    throw new Error(
      "no account still held the full bundle unclaimed at publish time",
    );
  }

  if (!autoDeliver) {
    return withReservationRollback(accounts, set, async () => {
      const r = await mp.zeusxPublish({
        title,
        description,
        priceUsd: price,
        quantity: accounts.length,
        game,
        coverImagePath: img,
      });
      await MarketplaceListing.create({
        set: set._id,
        marketplace: "zeusx",
        externalId: r.externalId,
        url: r.url || "",
        title,
        description,
        price,
        status: "active",
        origin: "auto",
        note: "auto-farm: " + accounts.length + " account(s), manual hand-over",
        accountLogin: accounts.map((a) => a.login).join(", "),
        qtyTarget: accounts.length,
      });
      return {
        externalId: r.externalId,
        url: r.url || "",
        qty: accounts.length,
      };
    });
  }

  // Automatic: one instant-delivery listing per reserved account. A single
  // account failing to list frees only its own reservation and never sinks the
  // rest of the share; the whole share throwing (nothing listed) rolls every
  // reservation back.
  const listed = [];
  for (const acc of accounts) {
    try {
      const r = await mp.zeusxPublish({
        title,
        description,
        priceUsd: price,
        game,
        coverImagePath: img,
        autoDeliverAccounts: [
          { login: acc.login, password: acc.password, email: "" },
        ],
      });
      await MarketplaceListing.create({
        set: set._id,
        marketplace: "zeusx",
        externalId: r.externalId,
        url: r.url || "",
        title,
        description,
        price,
        status: "active",
        origin: "auto",
        note: "auto-farm: automatic delivery — " + acc.login,
        autoDeliver: true,
        accountId: String(acc.accountId),
        accountLogin: acc.login,
        qtyTarget: 1,
      });
      listed.push({ acc, r });
    } catch (e) {
      await releaseReservedForSet([acc], set).catch(() => {});
      console.error(
        "zeusx auto-delivery listing failed for",
        acc.login,
        "-",
        e.message,
      );
    }
  }
  if (!listed.length) {
    // Everything failed — release the whole share so nothing is stranded.
    await releaseReservedForSet(accounts, set).catch(() => {});
    throw new Error("ZeusX auto-delivery: no account could be listed");
  }
  return {
    externalId: listed[0].r.externalId,
    url: listed[0].r.url || "",
    qty: listed.length,
  };
}

// A transient failure (e.g. a Digiseller login timeout) must not permanently
// cost a market. On every sweep tick where the Gameflip listing is alive,
// try to publish any secondary market that has no externalId yet, using
// accounts not attached to any active listing. Title/description/price come
// from the stored Gameflip listing row so all markets stay identical.
async function retryMissingSecondaries(task) {
  const L = task.listing || {};
  const platiMissing = !(L.plati && L.plati.externalId);
  const ggselMissing = !(L.ggsel && L.ggsel.externalId);
  // ZeusX was added after this retry existed, so it was only ever attempted in
  // the same second as the initial publish: a task listed before ZeusX was
  // switched on, or whose ZeusX publish failed once, never got an offer there
  // again (24 live tasks were in exactly that state, most with no error to
  // explain it). It retries on the same terms as the other secondaries.
  const zeusxMissing = !(L.zeusx && L.zeusx.externalId);
  if (!platiMissing && !ggselMissing && !zeusxMissing) return null;

  const gfRow = await MarketplaceListing.findOne({
    marketplace: "gameflip",
    externalId: L.externalId,
  }).lean();
  const set = L.setId ? await DropSet.findById(L.setId) : null;
  if (!gfRow || !set) return null;

  // Verify against the set's items — a retry must not attach an account that
  // doesn't hold the full bundle any more than the initial publish may.
  const spare = await pickDeliveryAccounts(task, 6, set.items || []);
  if (!spare.length) return null;

  const af = settings.getAutoFarm();
  const targets = [];
  if (platiMissing && af.platiCategoryId) targets.push("plati");
  if (ggselMissing) {
    let cat = "";
    try {
      cat = await mp.ggselResolveCategoryId(task.game);
    } catch {
      cat = "";
    }
    if (!cat) cat = String(af.ggselCategoryId || "");
    if (cat) targets.push("ggsel:" + cat);
  }
  if (zeusxMissing && af.zeusxAuto) {
    const mapped =
      zeusxGameMapped(af, task.game) ||
      !!(await mp.zeusxResolveCategory(task.game).catch(() => null));
    if (mapped) targets.push("zeusx");
  }
  if (!targets.length) return null;

  const shares = {};
  spare.forEach((acc, i) => {
    const t = targets[i % targets.length];
    (shares[t] = shares[t] || []).push(acc);
  });

  let img = "";
  try {
    img = await buildSetGridImage(set);
  } catch {
    img = "";
  }
  const base = {
    set,
    title: gfRow.title,
    description: gfRow.description,
    price: gfRow.price,
    img,
  };
  const retried = [];
  try {
    for (const t of targets) {
      const accounts = shares[t] || [];
      if (!accounts.length) continue;
      if (t === "plati") {
        try {
          const r = await publishPlatiShare({
            ...base,
            accounts,
            categoryId: af.platiCategoryId,
          });
          task.listing.plati = { ...r, error: "" };
          retried.push("plati");
        } catch (err) {
          task.listing.plati = {
            externalId: "",
            url: "",
            qty: 0,
            error: err.message,
          };
        }
      } else if (t === "zeusx") {
        try {
          const r = await publishZeusxShare({
            ...base,
            accounts,
            game: task.game,
          });
          task.listing.zeusx = { ...r, error: "" };
          retried.push("zeusx");
        } catch (err) {
          task.listing.zeusx = {
            externalId: "",
            url: "",
            qty: 0,
            error: err.message,
          };
        }
      } else {
        try {
          const r = await publishGgselShare({
            ...base,
            accounts,
            categoryId: t.slice("ggsel:".length),
          });
          task.listing.ggsel = { ...r, error: "" };
          retried.push("ggsel");
        } catch (err) {
          task.listing.ggsel = {
            externalId: "",
            url: "",
            qty: 0,
            error: err.message,
          };
        }
      }
    }
  } finally {
    if (img) await fsp.unlink(img).catch(() => {});
  }
  task.markModified("listing");
  await task.save();
  return retried.length ? retried : null;
}

/* ------------------------------- refiller ------------------------------- */

function splitCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Record who is behind each unit a refill just fed into a quantity product.
// Without this a top-up leaves no trace on the listing but a counter, and the
// consequences are silent: the guardian's integrity pass reads the row's
// accounts, so an account that later gets suspended is never flagged and the
// buyer receives a login that no longer exists (449 units on prod were in this
// state), and on Digiseller the content_id is the only handle for deleting that
// one unit later, so losing it means the whole product has to be delisted.
// Best-effort by design: the platform already accepted the codes, so a
// bookkeeping failure must not look like a failed feed.
async function recordFedUnits(marketplace, externalId, accounts, contentIds) {
  const row = await MarketplaceListing.findOne({
    marketplace,
    externalId: String(externalId),
    status: "active",
  });
  if (!row) return;
  const ids = splitCsv(row.accountId);
  const logins = splitCsv(row.accountLogin);
  const seen = new Set(logins.map((l) => l.toLowerCase()));
  accounts.forEach((a, i) => {
    const id = String(a.accountId || "");
    const login = String(a.login || "");
    if (id && !ids.includes(id)) ids.push(id);
    if (login && !seen.has(login.toLowerCase())) {
      logins.push(login);
      seen.add(login.toLowerCase());
    }
    row.units.push({
      accountId: id,
      login,
      contentId: String((contentIds && contentIds[i]) || ""),
    });
  });
  row.accountId = ids.join(",");
  row.accountLogin = logins.join(", ");
  await row.save();
}

// Auto-refiller: top up markets that sold out (or were shorted at listing
// time) WITHOUT delisting anything. Stock sources in order: free spare
// accounts (assigned but not tied to any active listing), then the 50%
// post-event holdback (decrementing the counter so the post-event release
// stays honest), and when both run dry the task's target is raised so the
// farmer's backfill pass grows the supply. Gameflip refills bump the relist
// chain counter; Plati/GGSel refills add delivery codes to the SAME product.
async function refillMarkets(task, { perMarketStock = 3 } = {}) {
  const L = task.listing || {};
  if (!L.externalId) return null; // not listed yet — nothing to refill
  const actions = [];
  const per = Math.max(1, Number(perMarketStock) || 3);

  // Refill stock must pass the same holdings gate — never top a market up with
  // an account that doesn't hold the full bundle. Verify against the listing's
  // set items.
  const set = L.setId ? await DropSet.findById(L.setId).lean() : null;
  if (!set) return null;

  // How many accounts are free right now, and how many of those belong to
  // the post-event holdback reserve.
  const spare = await pickDeliveryAccounts(
    task,
    (task.assignedAccounts || []).length,
    set.items || [],
  );
  let heldBack = Math.max(0, Number(L.heldBack) || 0);
  let freeSpare = Math.max(0, spare.length - heldBack);
  let holdbackUsed = 0;
  let cursor = 0;

  function takeAccounts(n) {
    // freeSpare first, then dip into the holdback reserve.
    const take = Math.min(n, spare.length - cursor);
    if (take < 1) return [];
    const fromFree = Math.min(take, freeSpare);
    const fromHold = take - fromFree;
    freeSpare -= fromFree;
    heldBack -= fromHold;
    holdbackUsed += fromHold;
    const out = spare.slice(cursor, cursor + take);
    cursor += take;
    return out;
  }

  // --- Gameflip: the relist chain sells while qtyRemaining > 0. Accounts
  // are reserved from the archive at delivery time, so a refill is just a
  // counter bump backed by real spare accounts.
  try {
    const row = await MarketplaceListing.findOne({
      marketplace: "gameflip",
      externalId: L.externalId,
      status: "active",
    });
    if (row) {
      const stock = Math.max(0, Number(row.qtyRemaining) || 0);
      if (stock < per) {
        const add = takeAccounts(per - stock).length;
        if (add > 0) {
          row.qtyRemaining = stock + add;
          await row.save();
          task.listing.qty = (Number(task.listing.qty) || 0) + add;
          actions.push("gameflip +" + add);
        }
      }
    }
  } catch {
    /* refill is best-effort per market */
  }

  // --- Plati (Digiseller): live stock read, then add codes to the product.
  if (L.plati && L.plati.externalId) {
    try {
      const stock = await mp.digisellerProductStock(L.plati.externalId);
      if (stock !== null && stock < per) {
        let accs = takeAccounts(per - stock);
        if (accs.length)
          accs = await reserveAccountsForPublish(accs, set, DS_CLAIM_TAG);
        if (accs.length) {
          // reserve → add → (on throw, into the surrounding catch) release.
          const added = await withReservationRollback(accs, set, () =>
            mp.digisellerAddContent(
              L.plati.externalId,
              accs.map((a) => digisellerDeliveryCode(a.login, a.password)),
            ),
          );
          await recordFedUnits(
            "digiseller",
            L.plati.externalId,
            accs,
            (added && added.contentIds) || [],
          ).catch(() => {});
          task.listing.plati.qty =
            (Number(task.listing.plati.qty) || 0) + accs.length;
          actions.push("plati +" + accs.length);
        }
      }
    } catch {
      /* stock read or add failed — retried next sweep */
    }
  }

  // --- GGSel: live stock read, add products, resync sellable quantity.
  if (L.ggsel && L.ggsel.externalId) {
    try {
      const stock = await mp.ggselOfferStock(L.ggsel.externalId);
      if (stock !== null && stock < per) {
        let accs = takeAccounts(per - stock);
        if (accs.length)
          accs = await reserveAccountsForPublish(accs, set, GG_CLAIM_TAG);
        if (accs.length) {
          // reserve → add → (on throw, into the surrounding catch) release.
          await withReservationRollback(accs, set, () =>
            mp.ggselAddProducts(
              L.ggsel.externalId,
              accs.map((a) => ggselDeliveryCode(a.login, a.password)),
            ),
          );
          await mp.ggselFinalizeStock(L.ggsel.externalId).catch(() => {});
          // GGSel returns no per-unit id (and rejects every unit delete), so
          // only the account is recorded — enough for the guardian to see it.
          await recordFedUnits("ggsel", L.ggsel.externalId, accs, []).catch(
            () => {},
          );
          task.listing.ggsel.qty =
            (Number(task.listing.ggsel.qty) || 0) + accs.length;
          actions.push("ggsel +" + accs.length);
        }
      }
    } catch {
      /* retried next sweep */
    }
  }

  // Bookkeeping: holdback we consumed is no longer waiting for post-event.
  if (holdbackUsed > 0) {
    task.listing.heldBack = Math.max(
      0,
      (Number(task.listing.heldBack) || 0) - holdbackUsed,
    );
    actions.push("holdback -" + holdbackUsed);
  }

  // Supply ran dry mid-refill? Raise the target so the farmer's backfill
  // pass claims more pool accounts for this game ("farm more" leg).
  if (cursor >= spare.length && actions.length === 0 && heldBack === 0) {
    const target =
      Number(task.targetAccounts) || Number(task.plannedAccounts) || 0;
    const have = (task.assignedAccounts || []).length;
    if (have >= target) {
      task.targetAccounts = have + per;
      actions.push("target raised to " + task.targetAccounts);
    }
  }

  if (!actions.length) return null;
  task.markModified("listing");
  await task.save();
  return actions;
}

// Main entry: called by the auto-farmer right after a task's bots start (and
// re-tried on later ticks while no listing exists). Dry-run stores a preview.
async function listActivatedTask(taskId, { dryRun = false } = {}) {
  const task = await AutoFarmTask.findById(taskId);
  if (!task) return { skipped: "task gone" };
  if (task.listing && task.listing.externalId) {
    // Verify the listing still exists on Gameflip — if the seller deleted it
    // manually, forget it and fall through to create a fresh one.
    try {
      const status = await mp.gameflipListingStatus(task.listing.externalId);
      if (status && status !== "expired") {
        // Gameflip is alive — use this tick to fill in any secondary market
        // that failed transiently on the original attempt (e.g. Digiseller
        // login timeout).
        if (!dryRun) {
          try {
            const retried = await retryMissingSecondaries(task);
            if (retried) return { skipped: "already listed", retried };
          } catch {
            /* never let a retry error break the sweep */
          }
        }
        return { skipped: "already listed" };
      }
    } catch (e) {
      const msg = String(e.message || "");
      // Anything other than "not found" (auth trouble, timeouts) keeps the
      // record — we only relist when Gameflip confirms the listing is gone.
      if (!/404|not.?found/i.test(msg)) {
        return { skipped: "already listed (status check failed: " + msg + ")" };
      }
    }
    // Also retire the stale DB listing row so the fulfiller stops watching it.
    try {
      await MarketplaceListing.updateOne(
        {
          set: task.listing.setId,
          marketplace: "gameflip",
          externalId: task.listing.externalId,
        },
        { $set: { status: "removed" } },
      );
    } catch {
      /* best-effort */
    }
    task.listing = undefined;
    task.wouldList = undefined;
    await task.save();
  }
  const items = await campaignItems(
    task.campaignId,
    task.game,
    task.campaignName,
  );
  const research = await MarketResearch.findOne({ game: task.game }).lean();
  const price = derivePrice(research);
  const qty = Math.max(1, (task.assignedAccounts || []).length);
  const split = computeSplit(qty);
  const title = buildTitle({
    game: task.game,
    items,
    campaignName: task.campaignName,
    postEvent: false,
  });
  const description = buildDescription({
    game: task.game,
    items,
    campaignName: task.campaignName,
    postEvent: false,
  });

  if (dryRun) {
    task.wouldList = { title, price, qty: split.listNow };
    await task.save();
    return { wouldList: { title, price, qty: split.listNow } };
  }

  const accounts = await pickDeliveryAccounts(task, split.listNow, items);
  if (!accounts.length) {
    // No assigned account holds the COMPLETE bundle yet (still farming, or the
    // finished ones are already listed). This is the honest early-bird state —
    // publish nothing rather than ship a partial/wrong account, and let the
    // next sweep pick it up once an account completes. Not an error, so it
    // doesn't spam the task error field every tick.
    task.listing = task.listing || {};
    task.listing.error =
      "waiting: no assigned account holds the full bundle yet";
    await task.save();
    return { skipped: "no verified holder yet", waiting: true };
  }

  // Split the sellable accounts across the markets round-robin — Gameflip
  // first (it always gets at least one), then Plati, then GGSel. One account
  // is only ever attached to one market, so a sale on one platform can never
  // hand out an account a buyer on another platform already received.
  const af = settings.getAutoFarm();
  const platiEnabled = !!af.platiCategoryId;
  // Per-game category: own-history match first, then catalog search for the
  // game's "Twitch Drops" section, then its Accounts section. The settings
  // value is only a manual override / last resort.
  let ggselCategoryId = "";
  try {
    ggselCategoryId = await mp.ggselResolveCategoryId(task.game);
  } catch {
    ggselCategoryId = "";
  }
  if (!ggselCategoryId) ggselCategoryId = String(af.ggselCategoryId || "");
  // ZeusX only joins the split when the owner has it switched on AND the
  // game has a ZeusX category mapped.
  let zeusxEnabled = false;
  if (af.zeusxAuto) {
    zeusxEnabled =
      zeusxGameMapped(af, task.game) ||
      !!(await mp.zeusxResolveCategory(task.game).catch(() => null));
  }
  const marketOrder = ["gameflip"];
  if (platiEnabled) marketOrder.push("plati");
  if (ggselCategoryId) marketOrder.push("ggsel");
  if (zeusxEnabled) marketOrder.push("zeusx");
  const shares = { gameflip: [], plati: [], ggsel: [], zeusx: [] };
  accounts.forEach((acc, i) => {
    shares[marketOrder[i % marketOrder.length]].push(acc);
  });

  // The DropSet makes the listing part of the normal machinery: the relist
  // chain, the Shop and the drop archive all understand sets.
  const set = await DropSet.create({
    name: task.game + " — " + (task.campaignName || task.campaignId),
    note: "Auto-farmed Twitch drops (" + (task.campaignName || task.game) + ")",
    items: items.map(({ itemKey, name, game, image, qty: q }) => ({
      itemKey,
      name,
      game,
      image,
      qty: q,
    })),
    price,
    listed: false,
    custom: true,
    coverGame: task.game,
  });

  let img = "";
  try {
    img = await buildSetGridImage(set);
  } catch {
    img = "";
  }

  const gfAccounts = shares.gameflip;
  const gfDeliver = await reserveOneForDelivery(gfAccounts, set, GF_CLAIM_TAG);
  if (!gfDeliver) {
    await DropSet.deleteOne({ _id: set._id }).catch(() => {});
    throw new Error(
      "Auto-list " +
        task.game +
        ": no account still held the full bundle unclaimed at publish time",
    );
  }
  let published;
  const plati = { externalId: "", url: "", qty: 0, error: "" };
  const ggsel = { externalId: "", url: "", qty: 0, error: "" };
  const zeusx = { externalId: "", url: "", qty: 0, error: "" };
  try {
    // reserve → publish → (on throw) release the gameflip unit AND delete the
    // now-empty set (mirrors the no-deliver path above) so a failed publish
    // strands neither the account's drops nor an orphan DropSet.
    published = await withReservationRollback(
      gfDeliver,
      set,
      () =>
        mp.gameflipPublish({
          title,
          description,
          priceUsd: price,
          imagePath: img,
          autoDeliverCode: gameflipDeliveryCode(
            gfDeliver.login,
            gfDeliver.password,
          ),
        }),
      {
        release: async (acct, s) => {
          await releaseReservedForSet(acct, s);
          await DropSet.deleteOne({ _id: s._id }).catch(() => {});
        },
      },
    );

    // ---- Plati (Digiseller): same flow as the manual Shop route — create
    // the product in the configured cataloguer category, attach one delivery
    // code per account, upload the cover. A Plati failure never rolls back
    // the Gameflip listing; it is recorded and retried by hand if needed.
    if (platiEnabled && shares.plati.length) {
      try {
        const r = await publishPlatiShare({
          set,
          title,
          description,
          price,
          img,
          accounts: shares.plati,
          categoryId: af.platiCategoryId,
        });
        plati.externalId = r.externalId;
        plati.url = r.url;
        plati.qty = r.qty;
      } catch (err) {
        plati.error = err.message;
      }
    } else if (!platiEnabled) {
      plati.error = "no Plati category id in auto-farm settings";
    } else {
      plati.error = "no spare account for this market yet";
    }

    // ---- GGSel: publish with autoselling + one product line per account,
    // in the configured category (or the one copied from the newest live
    // offer). Same isolation: failures are recorded, not fatal.
    if (ggselCategoryId && shares.ggsel.length) {
      try {
        const r = await publishGgselShare({
          set,
          title,
          description,
          price,
          img,
          accounts: shares.ggsel,
          categoryId: ggselCategoryId,
        });
        ggsel.externalId = r.externalId;
        ggsel.url = r.url;
        ggsel.qty = r.qty;
      } catch (err) {
        ggsel.error = err.message;
      }
    } else if (!ggselCategoryId) {
      ggsel.error =
        "no GGSel category found for " +
        task.game +
        " (set an override in auto-farm settings)";
    } else {
      ggsel.error = "no spare account for this market yet";
    }

    // ---- ZeusX: coordinated offer for its share (see publishZeusxShare).
    if (zeusxEnabled && shares.zeusx.length) {
      try {
        const r = await publishZeusxShare({
          set,
          title,
          description,
          price,
          img,
          accounts: shares.zeusx,
          game: task.game,
        });
        zeusx.externalId = r.externalId;
        zeusx.url = r.url;
        zeusx.qty = r.qty;
      } catch (err) {
        zeusx.error = err.message;
      }
    } else if (!af.zeusxAuto) {
      zeusx.error = "ZeusX auto-listing is switched off";
    } else if (!zeusxEnabled) {
      zeusx.error = "no ZeusX category for " + task.game;
    } else {
      zeusx.error = "no spare account for this market yet";
    }
  } finally {
    if (img) await fsp.unlink(img).catch(() => {});
  }

  await MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: published.externalId,
    url: published.url || "",
    title,
    description,
    price,
    status: "active",
    origin: "auto",
    autoDeliver: true,
    accountLogin: gfAccounts.map((a) => a.login).join(", "),
    // First unit is the pool account itself; the rest of Gameflip's SHARE
    // relists through the farmed-archive chain. Accounts given to Plati and
    // GGSel are excluded — they sell on those platforms. Held-back units
    // join qtyRemaining after the event ends, at the post-event price.
    qtyRemaining: Math.max(0, gfAccounts.length - 1),
  });

  task.listing = {
    setId: String(set._id),
    externalId: published.externalId,
    url: published.url || "",
    title,
    price,
    qty: gfAccounts.length,
    heldBack: split.holdBack,
    plati,
    ggsel,
    zeusx,
    listedAt: new Date(),
    repricedAt: null,
    postEvent: false,
    error: "",
  };
  await task.save();
  return { listed: task.listing };
}

/* --------------------------- stacked-bundle listing ---------------------- */

// Price for a stacked (multi-event) bundle. Anchored to the CURRENT event's
// market price (derivePrice already undercuts live competition) with only a
// modest premium for the extra items — competitors sell stacked accounts
// cheap, so summing bundle prices would price ours out of the market. The
// premium is +25%, capped at +$1.00, and never above the two bundles' prices
// combined. Read once at publish time, so it cannot compound tick over tick.
const STACK_PREMIUM = 1.25;
const STACK_PREMIUM_MAX_ADD = 1.0;
function stackedBundlePrice(basePrice, priorPrice) {
  const base = Number(basePrice) > 0 ? Number(basePrice) : 1.0;
  const prior = Number(priorPrice) > 0 ? Number(priorPrice) : 0;
  let bumped = Math.min(base * STACK_PREMIUM, base + STACK_PREMIUM_MAX_ADD);
  if (prior > 0) bumped = Math.min(bumped, base + prior);
  return Math.max(base, round25(bumped));
}

// Publish a SECOND listing for a task whose accounts were reused across this
// game's earlier campaigns: those accounts hold every prior bundle PLUS the
// current one, so the stack sells as its own combined-bundle listing at a
// combined price — while the task's main listing keeps selling the current
// event solo from its other accounts.
//
// Only accounts that verifiably hold EVERY item of the combined stack qualify
// (the same holdings gate the solo listing uses), and pickDeliveryAccounts
// already excludes anything attached to a live listing — so the stack is fed
// exactly by the reused/held-back accounts, never by stock the solo listing
// (or any other listing) is selling. Half of the qualifying stack is listed
// now; the rest stays unlisted so the NEXT event can stack on top of it again.
async function listStackedBundle(taskId, { dryRun = false } = {}) {
  const task = await AutoFarmTask.findById(taskId);
  if (!task) return { skipped: "task not found" };
  if (task.stackListing && task.stackListing.externalId) {
    return { skipped: "already listed" };
  }
  // The solo listing goes first — it anchors the current event's stock split.
  if (!task.listing || !task.listing.externalId) {
    return { skipped: "no solo listing yet" };
  }

  // Prior bundles: every OTHER auto-farm set this game has published.
  const siblings = await AutoFarmTask.find(
    {
      game: task.game,
      _id: { $ne: task._id },
      "listing.setId": { $nin: ["", null] },
    },
    { "listing.setId": 1 },
  ).lean();
  const setIds = [
    ...new Set(
      siblings.map((t) => t.listing && t.listing.setId).filter(Boolean),
    ),
  ];
  if (!setIds.length) return { skipped: "no prior campaign bundles" };
  const priorSets = await DropSet.find({ _id: { $in: setIds } }).lean();
  if (!priorSets.length) return { skipped: "prior sets gone" };

  const current = await campaignItems(
    task.campaignId,
    task.game,
    task.campaignName,
  );
  const items = stackItems([...priorSets, { items: current }]);
  // The stack must actually be BIGGER than the solo bundle, or it's the same
  // listing twice.
  if (items.length <= current.length) {
    return { skipped: "nothing extra to stack" };
  }

  const research = await MarketResearch.findOne({ game: task.game }).lean();
  const priorPrice = priorSets.reduce(
    (m, s) => Math.max(m, Number(s.price) || 0),
    0,
  );
  const price = stackedBundlePrice(derivePrice(research), priorPrice);
  const title = buildTitle({
    game: task.game,
    items,
    campaignName: task.campaignName,
  });
  const description = buildDescription({
    game: task.game,
    items,
    campaignName: task.campaignName,
    postEvent: false,
  });

  // Candidate accounts: everything this GAME's auto-farm tasks ever assigned
  // (the previous events' held-back stash lives on older tasks, not this one),
  // minus anything currently assigned to a DIFFERENT game's live plan (its
  // solo listing counts on those accounts). Deliberately never the manual
  // fleet — that stash is the owner's to sell by hand.
  const gameTasks = await AutoFarmTask.find(
    { game: task.game },
    { assignedAccounts: 1 },
  ).lean();
  const candidates = new Set();
  for (const t of gameTasks) {
    for (const u of t.assignedAccounts || []) {
      const k = String(u).toLowerCase();
      if (k) candidates.add(k);
    }
  }
  for (const t of await AutoFarmTask.find(
    { game: { $ne: task.game }, status: { $in: ["active", "planned"] } },
    { assignedAccounts: 1 },
  ).lean()) {
    for (const u of t.assignedAccounts || []) {
      candidates.delete(String(u).toLowerCase());
    }
  }
  if (!candidates.size) return { skipped: "no candidate accounts" };

  // Everyone who provably holds the WHOLE stack and isn't already on a live
  // listing. List half, keep half for the next event's stack.
  const eligible = await pickDeliveryAccounts(
    { assignedAccounts: [...candidates] },
    candidates.size,
    items,
  );
  if (!eligible.length) {
    return {
      skipped: "no free account holds the full stack yet",
      waiting: true,
    };
  }
  const split = computeSplit(eligible.length);
  const accounts = eligible.slice(0, split.listNow);

  if (dryRun) {
    return {
      wouldList: { title, price, qty: accounts.length, items: items.length },
    };
  }

  // Same market split as the solo flow: Gameflip first, then Plati, then GGSel.
  const af = settings.getAutoFarm();
  const platiEnabled = !!af.platiCategoryId;
  let ggselCategoryId = "";
  try {
    ggselCategoryId = await mp.ggselResolveCategoryId(task.game);
  } catch {
    ggselCategoryId = "";
  }
  if (!ggselCategoryId) ggselCategoryId = String(af.ggselCategoryId || "");
  const marketOrder = ["gameflip"];
  if (platiEnabled) marketOrder.push("plati");
  if (ggselCategoryId) marketOrder.push("ggsel");
  const shares = { gameflip: [], plati: [], ggsel: [] };
  accounts.forEach((acc, i) => {
    shares[marketOrder[i % marketOrder.length]].push(acc);
  });

  const set = await DropSet.create({
    name:
      task.game +
      " — stacked bundle (" +
      (task.campaignName || task.campaignId) +
      " + " +
      priorSets.length +
      " earlier event" +
      (priorSets.length === 1 ? "" : "s") +
      ")",
    note:
      "Auto-farmed Twitch drops, stacked across campaigns (" + task.game + ")",
    items: items.map(({ itemKey, name, game, image, qty: q }) => ({
      itemKey,
      name,
      game,
      image,
      qty: q,
    })),
    price,
    listed: false,
    custom: true,
    coverGame: task.game,
  });

  let img = "";
  try {
    img = await buildSetGridImage(set);
  } catch {
    img = "";
  }

  const gfAccounts = shares.gameflip;
  const gfDeliver = await reserveOneForDelivery(gfAccounts, set, GF_CLAIM_TAG);
  if (!gfDeliver) {
    await DropSet.deleteOne({ _id: set._id }).catch(() => {});
    if (img) await fsp.unlink(img).catch(() => {});
    return {
      skipped: "stack holder lost the race at publish time",
      waiting: true,
    };
  }
  let published;
  const plati = { externalId: "", url: "", qty: 0, error: "" };
  const ggsel = { externalId: "", url: "", qty: 0, error: "" };
  try {
    published = await withReservationRollback(
      gfDeliver,
      set,
      () =>
        mp.gameflipPublish({
          title,
          description,
          priceUsd: price,
          imagePath: img,
          autoDeliverCode: gameflipDeliveryCode(
            gfDeliver.login,
            gfDeliver.password,
          ),
        }),
      {
        release: async (acct, s) => {
          await releaseReservedForSet(acct, s);
          await DropSet.deleteOne({ _id: s._id }).catch(() => {});
        },
      },
    );

    if (platiEnabled && shares.plati.length) {
      try {
        const r = await publishPlatiShare({
          set,
          title,
          description,
          price,
          img,
          accounts: shares.plati,
          categoryId: af.platiCategoryId,
        });
        plati.externalId = r.externalId;
        plati.url = r.url;
        plati.qty = r.qty;
      } catch (err) {
        plati.error = err.message;
      }
    } else if (!platiEnabled) {
      plati.error = "no Plati category id in auto-farm settings";
    } else {
      plati.error = "no spare account for this market yet";
    }

    if (ggselCategoryId && shares.ggsel.length) {
      try {
        const r = await publishGgselShare({
          set,
          title,
          description,
          price,
          img,
          accounts: shares.ggsel,
          categoryId: ggselCategoryId,
        });
        ggsel.externalId = r.externalId;
        ggsel.url = r.url;
        ggsel.qty = r.qty;
      } catch (err) {
        ggsel.error = err.message;
      }
    } else if (!ggselCategoryId) {
      ggsel.error =
        "no GGSel category found for " +
        task.game +
        " (set an override in auto-farm settings)";
    } else {
      ggsel.error = "no spare account for this market yet";
    }
  } finally {
    if (img) await fsp.unlink(img).catch(() => {});
  }

  await MarketplaceListing.create({
    set: set._id,
    marketplace: "gameflip",
    externalId: published.externalId,
    url: published.url || "",
    title,
    description,
    price,
    status: "active",
    origin: "auto",
    autoDeliver: true,
    accountLogin: gfAccounts.map((a) => a.login).join(", "),
    qtyRemaining: Math.max(0, gfAccounts.length - 1),
  });

  task.stackListing = {
    setId: String(set._id),
    externalId: published.externalId,
    url: published.url || "",
    title,
    price,
    qty: gfAccounts.length,
    heldBack: split.holdBack,
    plati,
    ggsel,
    listedAt: new Date(),
    error: "",
  };
  await task.save();
  return { listed: task.stackListing };
}

/* --------------------------- campaign end flow --------------------------- */

// Once the drop event ends the items can no longer be earned — supply is fixed.
// Two things happen to this task's listing:
//   1. +50% scarcity markup (the user-approved post-event repricing). The
//      TITLE is left alone — it reads the same before and after the event.
//   2. STACKING: auto-bots are reused across a game's campaigns, so the same
//      accounts hold drops from EVERY campaign farmed so far. The listing's
//      set is rebuilt as the union of all completed auto-farm sets for the
//      game, so the bundle (and its value) grows with each ended event.
const POST_EVENT_MARKUP = 1.5;

// The one rule that decides whether the auto-farmer is allowed to change a
// listing's price. Positive-only on purpose: only a row explicitly marked
// origin:"auto" is auto-farmed stock. Everything else is the owner's — listings
// made by hand from the Listings page, and rows that predate the field — and
// their prices are theirs to set, so an unknown row is never repriced.
function isAutoOwned(row) {
  return !!row && row.origin === "auto";
}

function stackItems(sets) {
  const out = [];
  const seen = new Set();
  for (const set of sets) {
    for (const i of set.items || []) {
      if (!i || !i.itemKey || seen.has(i.itemKey)) continue;
      seen.add(i.itemKey);
      out.push({
        itemKey: i.itemKey,
        name: i.name,
        game: i.game,
        image: i.image || "",
        qty: i.qty || 1,
      });
    }
  }
  return out;
}

// The scarcity markup: +50% on what this listing already charges.
//
// It used to sum EVERY past campaign price for the game and mark that up, on
// the theory that a stacked bundle is worth the sum of its campaigns. Two
// things made that produce nonsense. The item union is de-duplicated while the
// sum is not, so price grew with the number of campaigns a game had run even
// when the bundle did not: The Quinfall stacked to a SINGLE item and priced at
// $12.50. And each sibling's recorded price already includes its own markup
// once it has ended, so the markup compounded on itself every campaign.
//
// Basing it on the listing's own price is the literal reading of "+50%", cannot
// compound, and cannot outrun the bundle. Items still stack — the bundle really
// does grow — only its price stays tied to what the listing was actually
// selling for.
function postEventPrice(basePrice, { markup = POST_EVENT_MARKUP } = {}) {
  const base = Number(basePrice) > 0 ? Number(basePrice) : 1.0;
  return Math.max(0.75, round25(base * markup));
}

async function onCampaignEnded(taskId) {
  const task = await AutoFarmTask.findById(taskId);
  if (!task || !task.listing || !task.listing.externalId) {
    return { skipped: "no listing" };
  }
  if (task.listing.postEvent) return { skipped: "already repriced" };

  // Union of every completed auto-farm set for this game (incl. this one).
  const siblings = await AutoFarmTask.find({
    game: task.game,
    "listing.setId": { $ne: "" },
  }).lean();
  const setIds = [
    ...new Set(
      siblings.map((t) => t.listing && t.listing.setId).filter(Boolean),
    ),
  ];
  const sets = await DropSet.find({ _id: { $in: setIds } });
  const mySet = sets.find((x) => String(x._id) === task.listing.setId);
  if (!mySet) return { skipped: "set gone" };

  const items = stackItems(sets);
  // Base the markup on the price recorded ON THE TASK, not on the live row.
  // task.listing.price and postEvent are written together in the same save at
  // the end, so a retry after a partial failure recomputes from the identical
  // base — marking up the live row's (already raised) price would compound.
  const price = postEventPrice(task.listing.price);
  const title = buildTitle({
    game: task.game,
    items,
    campaignName: task.campaignName,
    postEvent: true,
  });
  const description = buildDescription({
    game: task.game,
    items,
    campaignName: task.campaignName,
    postEvent: true,
  });

  // Grow this task's set into the stacked bundle so delivery checks demand
  // accounts holding EVERYTHING in it.
  mySet.items = items;
  mySet.price = price;
  await mySet.save();

  // Rebuild the cover from the stacked set so the Gameflip photo shows every
  // item in the grown bundle, not the pre-stack picture with items missing.
  // Best-effort: a failed image build falls back to the text/price-only reprice
  // rather than blocking the markup. Temp file is cleaned up after the reprice.
  let stackedImg = "";
  try {
    stackedImg = await buildSetGridImage(mySet);
  } catch {
    stackedImg = "";
  }

  // Find the live Gameflip row by SET rather than by the id recorded on the
  // task: after the first sale the relist chain publishes a successor with a
  // brand-new external id, so the task's own id is stale and only the set still
  // identifies the live listing.
  //
  // origin:"auto" is the hard boundary on that widened lookup. The markup must
  // only ever move an auto-farmed price — anything the owner listed by hand is
  // their own stock at their own price and is never touched, even if it happens
  // to sit on the same drop set.
  const found = await MarketplaceListing.findOne({
    set: mySet._id,
    marketplace: "gameflip",
    status: "active",
    origin: "auto",
  });
  // Belt and braces: the query already excludes the owner's listings, but the
  // block below moves a real price on a real marketplace, so the rule is
  // re-checked here at the point of use rather than trusted from a filter that
  // a later refactor could widen.
  const row = isAutoOwned(found) ? found : null;
  const heldBack = Math.max(0, Number(task.listing.heldBack) || 0);
  if (row) {
    try {
      await mp.gameflipReprice(row.externalId, {
        priceUsd: price,
        title,
        description,
        imagePath: stackedImg,
      });
      row.title = title;
      row.description = description;
      row.price = price;
      // Release the held-back accounts into the chain: they sell at the new
      // marked-up price — the whole point of saving them for after the event.
      row.qtyRemaining = (Number(row.qtyRemaining) || 0) + heldBack;
      await row.save();
    } finally {
      if (stackedImg) await fsp.unlink(stackedImg).catch(() => {});
    }
  } else if (stackedImg) {
    await fsp.unlink(stackedImg).catch(() => {});
  }

  // Stacking regenerated title/description, but the reprice above only touched
  // the Gameflip row. The GGSel/Plati secondary rows for the same set kept
  // their pre-stack text, so they under-list the (now larger) bundle. Bring
  // them in line. origin:"auto" is the same hard owner-boundary the reprice
  // uses. Best-effort per row: a secondary hiccup must not undo the Gameflip
  // reprice or block the postEvent save.
  let secondaryUpdated = 0;
  const secondaryTextStale = [];
  const secondaries = await MarketplaceListing.find({
    set: mySet._id,
    origin: "auto",
    status: "active",
    marketplace: { $in: ["ggsel", "digiseller"] },
  });
  for (const s of secondaries) {
    if (s.marketplace === "ggsel") {
      try {
        // Text-only PATCH — omitting priceRub leaves the GGSel price untouched.
        await mp.ggselUpdateOffer(s.externalId, { title, description });
        s.title = title;
        s.description = description;
        await s.save();
        secondaryUpdated++;
      } catch (e) {
        secondaryTextStale.push({
          marketplace: "ggsel",
          externalId: s.externalId,
          error: e.message,
        });
      }
    } else {
      // Digiseller has no edit-text API (publish/add-content/delist only), and
      // a republish would churn contentIds + the per-unit bookkeeping. The text
      // under-lists (content is correct — the account holds everything), so it
      // is left live and reported rather than republished.
      secondaryTextStale.push({
        marketplace: "digiseller",
        externalId: s.externalId,
        reason: "no edit-text API",
      });
    }
  }

  task.listing.title = title;
  task.listing.price = price;
  task.listing.repricedAt = new Date();
  task.listing.postEvent = true;
  if (row && heldBack > 0) {
    task.listing.qty = (Number(task.listing.qty) || 0) + heldBack;
    task.listing.heldBack = 0;
  }
  await task.save();
  return {
    repriced: {
      title,
      price,
      items: items.length,
      live: !!row,
      released: row ? heldBack : 0,
      secondaryUpdated,
      secondaryTextStale,
    },
  };
}

module.exports = {
  listActivatedTask,
  listStackedBundle,
  stackedBundlePrice,
  onCampaignEnded,
  refillMarkets,
  retryMissingSecondaries,
  isAutoOwned,
  // exported for tests
  buildTitle,
  buildDescription,
  derivePrice,
  stackItems,
  postEventPrice,
  computeSplit,
  // holdings gate + placeholder guard (the wrong-content fix)
  normLabel,
  looksLikeTitlePlaceholder,
  resolveCampaignItems,
  filterVerifiedHolders,
  // reserve→publish rollback (release stranded reservations on publish failure)
  withReservationRollback,
  // secondary-market publishing (used by ops scripts to rebuild bad products)
  publishPlatiShare,
  publishGgselShare,
  pickDeliveryAccounts,
};
