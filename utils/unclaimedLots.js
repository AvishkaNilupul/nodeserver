// ---------------------------------------------------------------------------
// UNCLAIMED-FARMS Gameflip LOTS (docs/UNCLAIMED-BUNDLES-CONTRACT.md, "Lots").
//
// Gameflip has no quantity, so the unclaimed engine sells one account per
// listing and relists the next waiting unit when it sells (a relist chain).
// Bulk buyers on Gameflip therefore had no path at all. A LOT is ONE Gameflip
// listing that delivers N accounts of the same item-set in one order:
//   * the row is a normal origin:"unclaimed" MarketplaceListing with
//     lotSize:N, a fresh lotId, units:[{login,accountId}] and
//     accountLogin = the logins joined ", " — so every existing "which rows
//     carry this login" sweep (rowsForLogin, activeListingsForLogin, the
//     spent scans) sees the members without any special case;
//   * the delivery code is N gameflipDeliveryCode blocks joined by a divider;
//   * the members are N WAITING gameflip ledgers (listed, market gameflip,
//     not the live single unit, not already in a lot), oldest listedAt first.
//     They stay status:"listed" / market:"gameflip" and get lotId stamped so
//     the relist chain never publishes one of them as a single unit while the
//     lot is live (agent E's waitingGameflipLedgers filters lotId:"").
//
// Lifecycle (checkLots, once per engine check pass, runs even when the flag
// is OFF so live lots are still maintained):
//   sold   — the Gameflip fulfiller marked the lot row "sold" (and recorded
//            the sale signal itself): spend every listed member.
//   broken — any member is no longer listed (manual-sold removed, expired,
//            sold elsewhere) or its owner is ticked manual-sold: delist the
//            lot row, clear lotId on the remaining members (back to waiting).
//   orphan — listed ledgers carrying a lotId that no active/sold lot row
//            owns (delisted by hand, crash mid-publish): clear the lotId.
//
// Publishing is gated by settings.getUnclaimedPricing().lots (default OFF).
// unclaimedAutoList is required lazily inside functions (it will require this
// module for the lot hooks — a top-level require would be circular).
// SECURITY: titles/descriptions never carry a login; credentials travel only
// in the platform's auto-delivery code.
// ---------------------------------------------------------------------------
const fsp = require("fs/promises");
const mongoose = require("mongoose");
const settings = require("./settings");
const mp = require("./marketplaces");
const { buildSetGridImage } = require("./setImage");
const { gameflipDeliveryCode } = require("./gameflipFulfiller");
const { logEvent } = require("./systemLog");
const DropSet = require("../models/DropSet");
const MarketplaceListing = require("../models/MarketplaceListing");
const UnclaimedAccount = require("../models/UnclaimedAccount");

const ORIGIN = "unclaimed";
const MARKET = "gameflip";
const LOT_SEPARATOR = "\n\n=====\n\n";
const GF_TITLE_MAX = 120; // marketplaces.gameflipPublish slices name to 120
const LOT_NOTE = "unclaimed auto-list — lot";
const MEMBER_NOTE = "unclaimed auto-list — lot member";

function engine() {
  return require("./unclaimedAutoList");
}

// Sibling module (agent B). Required lazily; if it is not on disk yet the
// contract formula below stands in so a missing file never breaks a pass.
function lotPriceFor(unitPrice, n, pricing, game) {
  try {
    const bundles = require("./unclaimedBundles");
    if (typeof bundles.lotPrice === "function") {
      return Number(bundles.lotPrice(unitPrice, n, pricing, game)) || 0;
    }
  } catch (e) {
    if (!e || e.code !== "MODULE_NOT_FOUND") throw e;
  }
  const p = pricing || {};
  const unit = Number(unitPrice) || 0;
  const disc = Math.min(100, Math.max(0, Number(p.lotDiscountPct) || 0));
  const floor = Math.max(0, Number(p.floorUsd) || 0) * n;
  const raw = unit * n * (1 - disc / 100);
  const rounded = Math.round(raw / 0.25) * 0.25;
  return Math.max(floor, Number(rounded.toFixed(2)));
}

function lower(s) {
  return String(s || "").trim().toLowerCase();
}

function ledgerLogin(l) {
  return lower(l && (l.loginLower || l.login));
}

// ---------------------------------------------------------------------------
// Pure helpers (tested in tests/unclaimedLots.test.js)
// ---------------------------------------------------------------------------

// The lot's public title: the set's title plus the lot suffix. Gameflip cuts
// names at 120 chars, so the BASE is trimmed to make room — the suffix is the
// part a bulk buyer must see, it can never be the part that falls off.
function lotTitle(baseTitle, n) {
  const suffix = " — LOT OF " + Number(n) + " ACCOUNTS";
  let base = String(baseTitle || "Twitch Drops").trim();
  const room = GF_TITLE_MAX - suffix.length;
  if (base.length > room) base = base.slice(0, Math.max(0, room - 1)).trimEnd() + "…";
  return base + suffix;
}

function lotDescription(baseDescription, n) {
  return (
    String(baseDescription || "").trimEnd() +
    "\n\nThis lot delivers " +
    Number(n) +
    " separate accounts, each holding the full item set."
  );
}

// Delivery code: one gameflipDeliveryCode block per account, divided so the
// buyer sees where one account ends and the next begins.
// creds: [{ login, password }]
function buildLotCode(creds) {
  return (creds || [])
    .filter((c) => c && c.login && c.password)
    .map((c) => gameflipDeliveryCode(c.login, c.password))
    .join(LOT_SEPARATOR);
}

// Ordered, eligible lot candidates from a set's gameflip ledgers:
//   * status "listed", market "gameflip" (when the fields are present);
//   * not already in a lot (lotId "");
//   * not the live single unit (opts.liveLogin / opts.liveLogins);
//   * not in opts.excludeLogins (manual-sold owners, no password, …);
//   * one entry per login (duplicate ledgers collapse onto the oldest);
//   sorted oldest listedAt first, then _id, for a stable FIFO.
function eligibleLotLedgers(ledgers, opts = {}) {
  const live = new Set();
  if (opts.liveLogin) live.add(lower(opts.liveLogin));
  for (const l of opts.liveLogins || []) live.add(lower(l));
  const excluded = new Set([...(opts.excludeLogins || [])].map(lower));
  const sorted = [...(ledgers || [])]
    .filter((l) => l && (l.status == null || l.status === "listed"))
    .filter((l) => l.market == null || l.market === MARKET)
    .filter((l) => !l.lotId)
    .filter((l) => {
      const login = ledgerLogin(l);
      return login && !live.has(login) && !excluded.has(login);
    })
    .sort((a, b) => {
      const ta = a.listedAt ? new Date(a.listedAt).getTime() : 0;
      const tb = b.listedAt ? new Date(b.listedAt).getTime() : 0;
      return ta - tb || String(a._id || "").localeCompare(String(b._id || ""));
    });
  const seen = new Set();
  const out = [];
  for (const l of sorted) {
    const login = ledgerLogin(l);
    if (seen.has(login)) continue;
    seen.add(login);
    out.push(l);
  }
  return out;
}

// The N members of the next lot, or [] when fewer than N are eligible (a lot
// is all-or-nothing: never publish a short lot).
function pickLotMembers(ledgers, n, opts = {}) {
  const size = Math.floor(Number(n) || 0);
  if (size < 1) return [];
  const eligible = eligibleLotLedgers(ledgers, opts);
  if (eligible.length < size) return [];
  return eligible.slice(0, size);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function isLotRow(row) {
  return !!row && (Number(row.lotSize) || 0) > 0;
}

// The set's live SINGLE unit (the relist chain's head) — never a lot row.
async function liveSingleRow(setId) {
  const rows = await MarketplaceListing.find({
    origin: ORIGIN,
    set: setId,
    marketplace: MARKET,
    status: "active",
  })
    .select({ accountLogin: 1, lotSize: 1 })
    .lean();
  return rows.find((r) => !isLotRow(r)) || null;
}

async function waitingLedgers(setId) {
  return UnclaimedAccount.find({
    set: setId,
    market: MARKET,
    status: "listed",
    $or: [{ lotId: "" }, { lotId: { $exists: false } }, { lotId: null }],
  })
    .sort({ listedAt: 1, _id: 1 })
    .lean();
}

function dropsOfSet(set) {
  return (set.items || []).map((i) => ({
    name: i.name,
    game: i.game,
    campaign: "",
    imageURL: i.image || "",
    itemKey: i.itemKey,
    qty: i.qty || 1,
  }));
}

async function clearLotId(ledgerIds, lotId) {
  if (!ledgerIds.length) return;
  await UnclaimedAccount.updateMany(
    { _id: { $in: ledgerIds }, lotId },
    { $set: { lotId: "" } },
  ).catch(() => {});
}

// ---------------------------------------------------------------------------
// publishLotIfReady — at most ONE lot per set per call
// ---------------------------------------------------------------------------

async function publishLotIfReady(setOrId, opts = {}) {
  const pricing = opts.pricing || settings.getUnclaimedPricing();
  if (!pricing || !pricing.lots) return { published: false, reason: "lots off" };
  const n = Math.floor(Number(pricing.lotSize) || 0);
  // A "lot" of one account is the single-unit chain by another name — and it
  // would collide with the chain's own accountLogin match. Refuse it.
  if (n < 2) return { published: false, reason: "lotSize < 2" };

  let set = setOrId;
  if (set && !set.items) set = await DropSet.findById(set._id || set).lean();
  if (!set || !set._id) return { published: false, reason: "no set" };
  const unitPrice = Number(set.price) || 0;
  if (unitPrice <= 0) return { published: false, reason: "no set price" };

  const eng = engine();
  const live = await liveSingleRow(set._id);
  const waiting = await waitingLedgers(set._id);
  // Never hand a manual-sold account to a second buyer.
  const marked = await eng.manualSoldOwnerKeys(waiting);
  const clean = eng.filterManualSoldLedgers(waiting, marked);
  const eligible = eligibleLotLedgers(clean, {
    liveLogin: live ? live.accountLogin : "",
  });
  if (eligible.length < n) {
    return { published: false, reason: "not enough waiting units", waiting: eligible.length };
  }

  // Credentials on demand; a ledger without a stored password cannot be
  // delivered, so it is skipped and the next in line takes its place.
  const members = [];
  const creds = [];
  for (const ledger of eligible) {
    if (members.length >= n) break;
    const cred = await eng.credentialForLedger(ledger);
    if (!cred || !cred.password) continue;
    members.push(ledger);
    creds.push({ login: cred.login || ledger.login, password: cred.password });
  }
  if (members.length < n) {
    return { published: false, reason: "not enough deliverable units", waiting: members.length };
  }

  const game = set.coverGame || (set.items && set.items[0] && set.items[0].game) || "";
  const drops = dropsOfSet(set);
  const baseTitle = eng.listingTitle(game, drops);
  const baseDesc = eng.listingDescription(game, drops, MARKET);
  const title = lotTitle(baseTitle, n);
  const description = lotDescription(baseDesc, n);
  const price = lotPriceFor(unitPrice, n, pricing, game);
  const lotId = new mongoose.Types.ObjectId().toString();
  const memberIds = members.map((m) => m._id);

  // Reserve the members FIRST (conditional on still being free) so a
  // concurrent pass cannot lot the same account twice; roll back on any miss.
  const reserved = await UnclaimedAccount.updateMany(
    {
      _id: { $in: memberIds },
      status: "listed",
      market: MARKET,
      $or: [{ lotId: "" }, { lotId: { $exists: false } }, { lotId: null }],
    },
    { $set: { lotId } },
  );
  const reservedN = Number(reserved && (reserved.modifiedCount ?? reserved.nModified)) || 0;
  if (reservedN !== n) {
    await clearLotId(memberIds, lotId);
    return { published: false, reason: "members changed under us" };
  }

  let img = "";
  try {
    img = await buildSetGridImage(set);
  } catch {
    img = "";
  }
  let r;
  try {
    r = await mp.gameflipPublish({
      title,
      description,
      priceUsd: price,
      imagePath: img || undefined,
      autoDeliverCode: buildLotCode(creds),
    });
  } catch (e) {
    await clearLotId(memberIds, lotId);
    if (img) await fsp.unlink(img).catch(() => {});
    throw e;
  }
  if (img) await fsp.unlink(img).catch(() => {});

  const logins = creds.map((c) => c.login);
  const row = await MarketplaceListing.create({
    set: set._id,
    marketplace: MARKET,
    externalId: r.externalId,
    url: r.url || "",
    title,
    description,
    price,
    status: "active",
    origin: ORIGIN,
    autoDeliver: true,
    lotSize: n,
    lotId,
    units: members.map((m, i) => ({
      login: logins[i],
      accountId: m.poolAccountId || m.webBotAccountId || "",
    })),
    accountId: "",
    accountLogin: logins.join(", "),
    qtyRemaining: 0, // one lot, one buyer; the fulfiller must never relist it
    qtyTarget: 0,
    note: LOT_NOTE + " of " + n,
  });
  for (const m of members) {
    await UnclaimedAccount.updateOne(
      { _id: m._id },
      {
        $set: { note: MEMBER_NOTE },
        $addToSet: {
          listingIds: String(row._id),
          listingExternalIds: String(r.externalId),
        },
      },
    ).catch(() => {});
  }
  logEvent({
    category: "unclaimed",
    action: "lot_published",
    actor: "unclaimedLots",
    subject: String(set._id),
    game,
    count: n,
    detail:
      "gameflip lot of " + n + " published for " + (game || "?") +
      " ($" + price.toFixed(2) + " = " + n + " × $" + unitPrice.toFixed(2) +
      " − " + (Number(pricing.lotDiscountPct) || 0) + "%)",
    meta: { lotId, externalId: r.externalId, setId: String(set._id), price, members: logins },
  });
  return { published: true, row, lotId, logins, price };
}

// ---------------------------------------------------------------------------
// checkLots — lifecycle of every live/sold lot row
// ---------------------------------------------------------------------------

async function breakLot(row, members, why) {
  const listed = members.filter((m) => m.status === "listed");
  let delisted = true;
  if (row.status === "active") {
    try {
      await mp.gameflipDelist(row.externalId);
    } catch (e) {
      // The lot is still live on Gameflip and still promises an account we
      // no longer control: keep the row active with the error so the next
      // pass retries the delist, and keep lotId on the members so the chain
      // does not re-sell one of them meanwhile.
      delisted = false;
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { lastError: "lot delist: " + e.message } },
      ).catch(() => {});
      return { ok: false };
    }
    await MarketplaceListing.updateOne(
      { _id: row._id, status: "active" },
      { $set: { status: "delisted", lastError: "", note: LOT_NOTE + " — broken: " + why } },
    ).catch(() => {});
  }
  if (delisted) {
    await clearLotId(listed.map((m) => m._id), row.lotId);
    await UnclaimedAccount.updateMany(
      { _id: { $in: listed.map((m) => m._id) }, note: MEMBER_NOTE },
      { $set: { note: "" } },
    ).catch(() => {});
  }
  logEvent({
    category: "unclaimed",
    action: "lot_broken",
    actor: "unclaimedLots",
    subject: String(row.set || ""),
    count: listed.length,
    detail:
      "gameflip lot of " + row.lotSize + " delisted (" + why + "); " +
      listed.length + " member(s) back to waiting",
    meta: { lotId: row.lotId, externalId: row.externalId, setId: String(row.set || "") },
  });
  return { ok: true };
}

async function checkLots(opts = {}) {
  const out = { checked: 0, sold: 0, broken: 0, orphansCleared: 0, errors: 0 };
  const eng = engine();
  const rows = await MarketplaceListing.find({
    origin: ORIGIN,
    marketplace: MARKET,
    lotSize: { $gt: 0 },
    status: { $in: ["active", "sold"] },
  }).lean();
  const liveLotIds = new Set();
  for (const row of rows) {
    if (!row.lotId) continue;
    liveLotIds.add(row.lotId);
    out.checked++;
    try {
      const members = await UnclaimedAccount.find({ lotId: row.lotId }).lean();
      const listed = members.filter(
        (m) => m.status === "listed" && m.market === MARKET,
      );
      if (row.status === "sold") {
        // The buyer got every member's credentials in one delivery code —
        // spend them all. Idempotent: already-sold members are not "listed".
        if (!listed.length) continue;
        for (const m of listed) {
          await eng.spendAccount(m, "gameflip lot sale", { removeFromProduct: false });
        }
        out.sold++;
        logEvent({
          category: "unclaimed",
          action: "lot_sold",
          actor: "unclaimedLots",
          subject: String(row.set || ""),
          count: listed.length,
          detail:
            "gameflip lot of " + row.lotSize + " sold ($" +
            (Number(row.price) || 0).toFixed(2) + "); " + listed.length + " account(s) spent",
          meta: { lotId: row.lotId, externalId: row.externalId, setId: String(row.set || "") },
        });
        continue;
      }
      // Active lot: every member must still be a waiting gameflip unit whose
      // owner is not ticked manual-sold, or the code promises an account we
      // cannot deliver.
      let why = "";
      if (listed.length < (Number(row.lotSize) || 0)) {
        why = listed.length + "/" + row.lotSize + " members still listed";
      } else {
        const marked = await eng.manualSoldOwnerKeys(listed);
        if (marked && marked.size) why = "member marked manual-sold";
      }
      if (why) {
        const r = await breakLot(row, members, why);
        if (r.ok) out.broken++;
        else out.errors++;
      }
    } catch (e) {
      out.errors++;
      console.error("unclaimedLots check failed for lot " + row.lotId + ":", e.message);
    }
  }

  // Orphans: listed ledgers stamped with a lotId no active/sold lot row owns
  // (hand-delisted row, or a crash between reserve and publish).
  try {
    const stamped = await UnclaimedAccount.find(
      { status: "listed", lotId: { $nin: ["", null] } },
      { lotId: 1 },
    ).lean();
    const orphanIds = [...new Set(stamped.map((s) => s.lotId))].filter(
      (id) => id && !liveLotIds.has(id),
    );
    if (orphanIds.length) {
      const r = await UnclaimedAccount.updateMany(
        { status: "listed", lotId: { $in: orphanIds } },
        { $set: { lotId: "", note: "" } },
      );
      out.orphansCleared = Number(r && (r.modifiedCount ?? r.nModified)) || 0;
    }
  } catch (e) {
    out.errors++;
    console.error("unclaimedLots orphan sweep failed:", e.message);
  }
  return out;
}

// ---------------------------------------------------------------------------
// lotsSummary — for GET /api/unclaimed-auto/lots (agent R)
// ---------------------------------------------------------------------------

async function lotsSummary() {
  const rows = await MarketplaceListing.find({
    origin: ORIGIN,
    marketplace: MARKET,
    lotSize: { $gt: 0 },
  })
    .sort({ createdAt: -1, _id: -1 })
    .select({
      set: 1, title: 1, lotSize: 1, price: 1, externalId: 1, status: 1,
      lotId: 1, url: 1, createdAt: 1, lastError: 1,
    })
    .lean();
  return rows.map((r) => ({
    setId: String(r.set || ""),
    title: r.title || "",
    lotSize: Number(r.lotSize) || 0,
    price: Number(r.price) || 0,
    externalId: r.externalId || "",
    status: r.status || "",
    lotId: r.lotId || "",
    url: r.url || "",
    createdAt: r.createdAt || null,
    lastError: r.lastError || "",
  }));
}

module.exports = {
  publishLotIfReady,
  checkLots,
  lotsSummary,
  buildLotCode,
  pickLotMembers,
  eligibleLotLedgers,
  lotTitle,
  lotDescription,
  lotPriceFor,
  LOT_SEPARATOR,
};
