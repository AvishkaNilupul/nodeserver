// Z2U shelf keeper + auto-delivery.
//
// Z2U differs from every other target we sell on in one way that matters: an
// offer has a DURATION (7/14/30 days) and Z2U takes it off sale when that runs
// out. Nothing announces it — the offer just stops being visible, keeps its
// stock, and sits there. A shelf nobody tends therefore goes dark on its own,
// and on 2026-09-08 that is exactly what had happened: 34 of 47 offers were off
// sale while only 2 of them were genuinely empty, and 11 of the 16 games the
// account sells in had ZERO live offers.
//
// So this module has two jobs, not one:
//   1. keepShelfAlive() — extend what is about to lapse, put back what lapsed,
//      and pull down what we can no longer honour.
//   2. deliverPendingOrders() — hand over the credential the moment an order
//      is waiting, the same way the Eldorado fulfiller does.
//
// Both refuse to act on an offer we cannot back with real, claimable stock.
// Advertising stock we cannot ship is how a marketplace account gets a dispute
// (Z2U already carries one), and the memory of every other integration here is
// emphatic that the advertised number and the claimable number are different
// numbers. Real stock is counted the way the delivery path counts it, never
// the way the listing claims it.
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const UnclaimedAccount = require("../models/UnclaimedAccount");
const { availableAccountsForSet } = require("../routes/shopRoutes");
const { loginsOnActiveListings, notListed } = require("./listedLogins");
const { getAutoFarm } = require("./settings");
const mp = require("./marketplaces");
// The claim paths are Eldorado's on purpose: they are the ones that have been
// proven against real orders, and a second copy would drift. The only thing
// Z2U changes is which marketplace the claim is stamped with.
const eld = require("./eldoradoFulfiller");

// Distinct from every other platform's tag so one account can never be handed
// out twice across shops. Already present in utils/marketClaimTags.
const Z2U_CLAIM_TAG = "z2u";

// How close to its expiry an offer may get before we extend it. Z2U gives no
// warning of its own, and an offer that lapses stops earning silently.
const EXTEND_WITHIN_DAYS = 5;

// Never advertise more than this on one offer, however deep the ledger is —
// the same ceiling the Eldorado bundles use.
const STOCK_MAX = 200;

// How long to wait between writes.
//
// Z2U throttles seller actions with "Operation too frequent, please try again
// one hour later!" — and it is NOT an honest error. Measured on a real sweep at
// 1.2s spacing: 20 actions produced 9 of those messages, and the read-back
// proved the change had been applied anyway in 7 of them; only 2 genuinely did
// not happen. So the message means neither "applied" nor "rejected", which is
// precisely why every write here is verified by reading the offer back instead
// of by its status. Wider spacing keeps the honest failures rare.
const WRITE_SPACING_MS = 4000;

// Do not extend the same offer again within this window. Z2U keeps the original
// publish date after an extend, so the "expires in -24d" reading never moves — it
// stays overdue forever and the keeper would re-extend it every single tick.
const EXTEND_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000;

// Z2U rejects a re-save of any offer whose Platform/Area selection is
// incomplete: "Please refine attributes such as Platform,Area". No retry fixes
// that — the offer has to be corrected by hand in the seller panel — so once
// seen, stop asking. Clearing the row's lastError re-enables it.
const ATTR_INCOMPLETE = /refine attributes/i;

function todayIsoDays(dateStr) {
  // Z2U prints the publish date as yyyy/mm/dd.
  const m = /(\d{4})\/(\d{2})\/(\d{2})/.exec(String(dateStr || ""));
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// Days until Z2U pulls this offer for running out its duration, or null when
// the page did not give us both halves of the sum.
function daysUntilExpiry(offer, now = Date.now()) {
  const start = todayIsoDays(offer && offer.publishedAt);
  const days = Number(offer && offer.expiryDays);
  if (start == null || !Number.isFinite(days) || days <= 0) return null;
  return Math.round((start + days * 86400000 - now) / 86400000);
}

// What the delivery path would actually be able to claim right now.
//
// Returns null — NOT 0 — for a row with no stock source, because "we do not
// know" and "there is none" must lead to different actions: the first is left
// alone, the second is taken off sale.
async function realStockFor(row, listedElsewhere) {
  if (!row) return null;
  if (row.unclaimedGame) {
    const picked = await eld
      .claimUnclaimedForGame(row.unclaimedGame, STOCK_MAX, {
        dryRun: true,
        offerId: row.externalId,
        requiredDrops: row.requiredDrops,
        market: Z2U_CLAIM_TAG,
      })
      .catch(() => []);
    return picked.length;
  }
  if (row.set) {
    const set = await DropSet.findById(row.set).lean();
    if (!set) return null;
    const avail = await availableAccountsForSet(set).catch(() => []);
    return notListed(avail, listedElsewhere || new Set()).length;
  }
  return null;
}

// The whole shelf, joined to whatever our DB knows about each offer. This is
// the read model behind both the audit script and keepShelfAlive, so the two
// can never disagree about what is on sale.
async function shelf({ withStock = true } = {}) {
  const offers = await mp.z2uAllOffers();
  const rows = await MarketplaceListing.find({ marketplace: "z2u" }).lean();
  const byPk = new Map(rows.map((r) => [String(r.externalId), r]));
  const listedElsewhere = withStock ? await loginsOnActiveListings() : new Set();
  const out = [];
  for (const offer of offers) {
    const row = byPk.get(String(offer.pk)) || null;
    out.push({
      offer,
      row,
      linked: !!row,
      daysLeft: daysUntilExpiry(offer),
      realStock: withStock ? await realStockFor(row, listedElsewhere) : null,
    });
  }
  return out;
}

// Decide what one offer needs, without doing it. Split out so the whole policy
// is testable without a session or a database.
//
// The order of the checks is the policy:
//  * an offer we cannot back comes DOWN before anything else — an oversold
//    offer costs a dispute, a dark offer only costs a sale;
//  * an expired offer must be extended before it is relisted, or Z2U drops it
//    straight back off;
//  * stock is corrected last, once the offer is in the right state.
function planForOffer(
  entry,
  { now = Date.now(), extendWithin = EXTEND_WITHIN_DAYS, resumeSellerPaused = false } = {},
) {
  const { offer, row, realStock } = entry;
  const actions = [];
  if (!row) {
    return { actions, note: "not linked to any listing row — left alone" };
  }
  const known = realStock != null;
  if (known && realStock <= 0) {
    if (offer.online) {
      actions.push({ action: "off_line", why: "no claimable stock" });
    }
    return { actions, note: known ? "out of stock" : "" };
  }
  const daysLeft = entry.daysLeft != null ? entry.daysLeft : daysUntilExpiry(offer, now);
  // Suppress a repeat extend: the publish date does not move, so the offer will
  // still read as overdue on the next tick and every tick after it.
  const extendedRecently =
    row.lastExtendedAt && now - new Date(row.lastExtendedAt).getTime() < EXTEND_COOLDOWN_MS;
  if (offer.status === "expired" && !extendedRecently) {
    actions.push({ action: "extend", why: "duration ran out" });
    actions.push({ action: "on_line", why: "back on sale after extending" });
  } else if (offer.status === "expired") {
    // Extended recently but Z2U still shows it off sale — relist without
    // burning another extend on it.
    if (row.autoPaused || resumeSellerPaused) {
      actions.push({ action: "on_line", why: "relist after a recent extend" });
    }
  } else if (!offer.online) {
    // Only ever resume what this module paused. A deliberate pause by the
    // operator has to survive the tick, or the shelf keeper becomes a way to
    // silently undo a decision someone made on purpose.
    if (row.autoPaused) {
      actions.push({ action: "on_line", why: "back in stock" });
    } else if (resumeSellerPaused) {
      // Opt-in only. An offer at status 4 was paused by a person, and there is
      // no way to tell "paused because it was out of stock" from "paused on
      // purpose" — so reviving it is a decision an operator makes explicitly,
      // never something a background tick does on its own.
      actions.push({
        action: "on_line",
        why: "revive: seller-paused with " + realStock + " in stock",
      });
    }
  } else if (daysLeft != null && daysLeft <= extendWithin && !extendedRecently) {
    actions.push({
      action: "extend",
      why: "expires in " + daysLeft + "d",
    });
  }
  // Correct the advertised number only on an offer that will actually be
  // VISIBLE — either it is on sale now, or this plan is about to put it back.
  // Fixing the stock on an offer that stays dark changes nothing a buyer can
  // see, and it is not free: a stock change re-submits the whole editor form,
  // so doing it for ~30 dark offers every sweep would hammer a shared-hosting
  // PHP site forever to no effect. When such an offer is later revived, the
  // same pass corrects it in the same breath.
  const willBeVisible =
    offer.online || actions.some((a) => a.action === "on_line");
  const stockLocked = ATTR_INCOMPLETE.test(String(row.lastError || ""));
  if (known && realStock > 0 && offer.stock !== realStock && willBeVisible && !stockLocked) {
    actions.push({
      action: "stock",
      value: realStock,
      why: "advertised " + offer.stock + " -> real " + realStock,
    });
  }
  return { actions, note: "" };
}

// What the offer should look like once an action has been applied. This is
// what makes read-back verification possible rather than hopeful.
function expectedAfter(action, value) {
  if (action === "off_line") return { online: false };
  if (action === "on_line") return { online: true };
  if (action === "extend") return { notExpired: true };
  if (action === "stock") return { stock: value };
  return {};
}

// One pass over the shelf.
//
// Writes are VERIFIED BY READ-BACK, never trusted. Two of this codebase's other
// marketplaces lie about whether an update succeeded — ZeusX returns a 500 for
// updates it HAS applied, GGSel a 504 for ones it has NOT — and both were
// caught by a canary rather than by reasoning. Z2U is a shared-hosting PHP site
// answering with a hand-rolled envelope, so it gets the same distrust: after
// acting on a game group, the group is re-read once and each action is marked
// verified or mismatched against what the offer actually looks like now.
//
// Re-reading per group rather than per offer is what keeps that affordable —
// a group page is ~500KB, and one re-read covers every action in it.
async function keepShelfAlive({
  dryRun = true,
  limit = 0,
  resumeSellerPaused = false,
  // Drop actions that would take an offer OFF sale. Pausing an offer we cannot
  // back is the right default, but it is a different decision from putting
  // stocked offers back on sale, and an operator may know about stock this
  // database does not model (hand-filled from a stash, say). So a run can be
  // additive-only: relist, extend, correct quantities, touch nothing else.
  publishOnly = false,
} = {}) {
  const entries = await shelf();
  const done = [];
  let acted = 0;

  // Plan everything first, so the work can be grouped by the page it lives on.
  const work = [];
  for (const entry of entries) {
    let { actions, note } = planForOffer(entry, { resumeSellerPaused });
    if (publishOnly) {
      // A stock correction only makes sense alongside the action that keeps the
      // offer visible; on its own here it would be the only change to an offer
      // we just declined to pause.
      actions = actions.filter((a) => a.action !== "off_line");
      if (!actions.some((a) => a.action !== "stock")) {
        const keep = actions.filter((a) => a.action === "stock");
        actions = entry.offer.online ? keep : [];
      }
    }
    if (!actions.length) {
      if (note) done.push({ pk: entry.offer.pk, title: entry.offer.title, skipped: note });
      continue;
    }
    if (limit && acted >= limit) break;
    acted++;
    work.push({ entry, actions });
  }

  const groups = new Map();
  for (const w of work) {
    const key = w.entry.offer.service + ":" + w.entry.offer.game;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }

  for (const [key, items] of groups) {
    const applied = [];
    for (const { entry, actions } of items) {
      for (const a of actions) {
        const record = {
          pk: entry.offer.pk,
          title: entry.offer.title,
          action: a.action + (a.value != null ? " " + a.value : ""),
          why: a.why,
          applied: false,
        };
        if (dryRun) {
          done.push(record);
          continue;
        }
        try {
          if (a.action === "stock") {
            await mp.z2uUpdateOffer(entry.offer.pk, { stock: a.value });
          } else {
            await mp.z2uSetOfferStatus(entry.offer.pk, a.action);
          }
          record.applied = true;
        } catch (e) {
          // NOT a failure yet: the read-back below decides. A platform that
          // reports an error for a write it applied would otherwise leave the
          // database disagreeing with the live offer.
          record.error = String((e && e.message) || e).slice(0, 200);
          // ...except this one, which is a permanent property of the offer.
          if (ATTR_INCOMPLETE.test(record.error) && entry.row) {
            await MarketplaceListing.updateOne(
              { _id: entry.row._id },
              { $set: { lastError: record.error } },
            ).catch(() => {});
            record.verifyNote =
              "offer's Platform/Area is incomplete on Z2U — fix it by hand; " +
              "this listing's quantity will not be touched again until then";
          }
        }
        record.expected = expectedAfter(a.action, a.value);
        record.wasExpired = entry.offer.status === "expired";
        applied.push({ record, entry });
        done.push(record);
        await new Promise((r) => setTimeout(r, WRITE_SPACING_MS));
      }
    }
    if (dryRun || !applied.length) continue;

    // ---- read-back ----
    const [service, game] = key.split(":");
    let after = [];
    try {
      after = await mp.z2uOffers(service, game);
    } catch (e) {
      for (const { record } of applied) {
        record.verified = null;
        record.verifyNote = "could not re-read the group: " + String((e && e.message) || e).slice(0, 80);
      }
      continue;
    }
    const byPk = new Map(after.map((o) => [String(o.pk), o]));
    for (const { record, entry } of applied) {
      const now = byPk.get(String(record.pk));
      if (!now) {
        record.verified = false;
        record.verifyNote = "offer vanished from its group page";
        continue;
      }
      const exp = record.expected || {};
      let ok = true;
      if (exp.online != null && now.online !== exp.online) ok = false;
      if (exp.stock != null && now.stock !== exp.stock) ok = false;
      if (exp.notExpired && now.status === "expired") ok = false;
      record.verified = ok;
      // The whole point: an error the read-back contradicts was not a failure.
      if (ok && record.error) {
        record.verifyNote = "reported an error but the change IS live: " + record.error;
        record.applied = true;
        delete record.error;
      }
      if (!ok && !record.error) {
        record.verifyNote = "reported success but the offer did not change";
      }
      // Persist the pause/resume flag only once the change is real.
      if (ok && entry.row) {
        const row = await MarketplaceListing.findById(entry.row._id);
        if (row) {
          if (exp.notExpired) {
            // Remember the extend; Z2U's own dates will not show it.
            row.lastExtendedAt = new Date();
            await row.save();
          }
          if (exp.online === false) {
            row.autoPaused = true;
            row.lastError = "paused: no claimable stock";
            await row.save();
          } else if (exp.online === true) {
            row.autoPaused = false;
            row.lastError = "";
            await row.save();
          }
        }
      }
    }
  }
  return done;
}

// Put a claim back when the hand-over did not happen.
//
// This is the difference between a retryable hiccup and a burned account.
// Claiming marks the account SOLD before the credential is sent, because the
// alternative — send first, claim after — can hand the same account to two
// buyers. So when the send fails, the claim MUST be undone, or the account is
// marked sold to a buyer who never received it and no later pass will ever
// offer it again.
//
// Guarded on our own claim tag both ways: a row claimed by another marketplace
// is never touched, however the delivery failed.
async function releaseClaim(row, acct) {
  try {
    if (row.unclaimedGame && acct.ledgerId) {
      await UnclaimedAccount.findOneAndUpdate(
        { _id: acct.ledgerId, market: Z2U_CLAIM_TAG },
        {
          $set: {
            status: "released",
            soldAt: null,
            market: "",
            note: "z2u delivery failed — returned to stock",
          },
        },
      );
      return true;
    }
    if (acct.accountId) {
      await eld.releaseAccounts([acct.accountId], Z2U_CLAIM_TAG);
      return true;
    }
  } catch (e) {
    console.error("z2u fulfiller: RELEASE FAILED for order — account may be stranded:", (e && e.message) || e);
  }
  return false;
}

// Match a sold order back to the offer it came from.
//
// Z2U's order list gives the product TITLE but not the offer id, so the title
// is the join key. It is exact-match first and normalised second; anything
// that still does not match is reported rather than guessed at, because
// delivering the wrong bundle is worse than delivering late.
function normaliseTitle(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function matchRowForOrder(order, rows) {
  const exact = rows.find((r) => String(r.title || "").trim() === String(order.title || "").trim());
  if (exact) return exact;
  const want = normaliseTitle(order.title);
  if (!want) return null;
  const near = rows.filter((r) => normaliseTitle(r.title) === want);
  return near.length === 1 ? near[0] : null;
}

// One pass over every order waiting for delivery.
async function deliverPendingOrders({ dryRun = true } = {}) {
  const orders = await mp.z2uOrders("WAIT_DELIVERY");
  if (!orders.length) return { orders: 0, delivered: [], skipped: [] };
  const rows = await MarketplaceListing.find({ marketplace: "z2u" });
  const delivered = [];
  const skipped = [];
  for (const order of orders) {
    const row = matchRowForOrder(order, rows);
    if (!row) {
      skipped.push([order.orderId, "no listing row matches " + JSON.stringify(order.title)]);
      continue;
    }
    // Delivering the same order twice is the one unrecoverable mistake here:
    // it hands a second account away for free. The unit ledger on the row is
    // the guard, exactly as on Eldorado.
    if ((row.units || []).some((u) => u.orderId === order.orderId)) {
      skipped.push([order.orderId, "already delivered"]);
      continue;
    }
    // Check the order can actually be delivered BEFORE claiming anything.
    // Claiming marks an account sold; doing that for an order whose delivery
    // form does not exist would spend stock on a hand-over that cannot happen,
    // and then rely on the release path to undo it. Not claiming at all is
    // strictly safer than claiming and giving back.
    if (!dryRun) {
      let form = null;
      try {
        form = await mp.z2uDeliveryForm(order.orderId);
      } catch (e) {
        skipped.push([order.orderId, "could not read the order page: " + String((e && e.message) || e).slice(0, 90)]);
        continue;
      }
      if (!form) {
        skipped.push([
          order.orderId,
          "no delivery form on the order page — not awaiting delivery " +
            "(already delivered, cancelled, or under dispute)",
        ]);
        continue;
      }
    }
    let picked = [];
    try {
      if (row.unclaimedGame) {
        picked = await eld.claimUnclaimedForGame(row.unclaimedGame, 1, {
          orderId: order.orderId,
          offerId: row.externalId,
          dryRun,
          requiredDrops: row.requiredDrops,
          market: Z2U_CLAIM_TAG,
        });
      } else if (row.set) {
        const set = await DropSet.findById(row.set).lean();
        if (!set) {
          skipped.push([order.orderId, "listing points at a DropSet that is gone"]);
          continue;
        }
        picked = dryRun
          ? notListed(
              await availableAccountsForSet(set).catch(() => []),
              await loginsOnActiveListings(),
            ).slice(0, 1)
          : await eld.claimAccountsForSet(set, 1, { claimTag: Z2U_CLAIM_TAG });
      } else {
        skipped.push([order.orderId, "listing has no stock source (manual offer)"]);
        continue;
      }
    } catch (e) {
      skipped.push([order.orderId, "claim failed: " + String((e && e.message) || e).slice(0, 120)]);
      continue;
    }
    if (!picked.length) {
      skipped.push([order.orderId, "nothing claimable left for this offer"]);
      continue;
    }
    const acct = picked[0];
    const message = eld.eldoradoDeliveryCode(acct.login, acct.password);
    if (dryRun) {
      delivered.push({
        orderId: order.orderId,
        title: order.title,
        login: acct.login,
        chars: message.length,
        dryRun: true,
      });
      continue;
    }
    try {
      await mp.z2uDeliver(order.orderId, message);
    } catch (e) {
      // The account was claimed a moment ago and nobody got it — give it back
      // before moving on, or it is spent for nothing.
      const back = await releaseClaim(row, acct);
      skipped.push([
        order.orderId,
        "deliver failed: " +
          String((e && e.message) || e).slice(0, 140) +
          (back ? " (account returned to stock)" : " (ACCOUNT MAY BE STRANDED)"),
      ]);
      continue;
    }
    row.units = row.units || [];
    row.units.push({
      accountId: String(acct.accountId || acct.ledgerId || ""),
      login: acct.login,
      orderId: order.orderId,
      deliveredAt: new Date(),
    });
    await row.save();
    delivered.push({ orderId: order.orderId, title: order.title, login: acct.login });
  }
  return { orders: orders.length, delivered, skipped };
}

// Delivery runs often and costs one small page; the shelf sweep reads ~16
// pages of ~500KB and runs rarely. Keeping them on separate clocks is what
// makes it safe to poll for orders every couple of minutes.
const DELIVER_TICK_MS = 2 * 60 * 1000;
const SHELF_TICK_MS = 30 * 60 * 1000;
let started = false;

async function deliverTick() {
  const af = getAutoFarm() || {};
  try {
    if (!af.z2uAutoDeliver) return;
    if (!(mp.keyStatus().z2u || {}).configured) return;
    const dryRun = af.z2uDeliverDryRun !== false;
    const res = await deliverPendingOrders({ dryRun });
    if (res.delivered && res.delivered.length) {
      console.log(
        "z2u fulfiller: delivered " +
          res.delivered.length +
          (dryRun ? " (DRY RUN)" : "") +
          " — " +
          res.delivered.map((d) => d.orderId).join(", "),
      );
    }
    for (const [id, why] of res.skipped || []) {
      console.log("z2u fulfiller: order " + id + " skipped — " + why);
    }
  } catch (e) {
    console.error("z2u fulfiller (deliver):", (e && e.message) || e);
  }
}

async function shelfTick() {
  const af = getAutoFarm() || {};
  try {
    if (!af.z2uAuto) return;
    if (!(mp.keyStatus().z2u || {}).configured) return;
    const dryRun = af.z2uShelfDryRun !== false;
    const done = await keepShelfAlive({ dryRun });
    const acts = done.filter((d) => d.action);
    if (acts.length) {
      // Report the VERIFIED outcome, not just what was attempted. Without this
      // an unattended loop that is silently failing every write looks identical
      // in the logs to one that is working.
      const ok = acts.filter((a) => a.verified === true).length;
      const bad = acts.filter((a) => a.verified === false);
      console.log(
        "z2u shelf keeper: " +
          acts.length +
          " action(s)" +
          (dryRun ? " (DRY RUN)" : " — verified " + ok + "/" + acts.length) +
          (bad.length ? ", FAILED " + bad.length : "") +
          " — " +
          acts.slice(0, 6).map((a) => a.pk + ":" + a.action).join(", "),
      );
      for (const a of bad.slice(0, 5)) {
        console.log(
          "  z2u FAILED " + a.pk + " " + a.action + ": " +
            (a.error || a.verifyNote || "offer did not change"),
        );
      }
    }
  } catch (e) {
    console.error("z2u shelf keeper:", (e && e.message) || e);
  }
}

function start() {
  if (started) return;
  started = true;
  const loop = (fn, ms, firstDelay) => {
    const run = async () => {
      await fn();
      const t = setTimeout(run, ms);
      if (t.unref) t.unref();
    };
    const t = setTimeout(run, firstDelay);
    if (t.unref) t.unref();
  };
  loop(deliverTick, DELIVER_TICK_MS, 90 * 1000);
  loop(shelfTick, SHELF_TICK_MS, 5 * 60 * 1000);
}

module.exports = {
  Z2U_CLAIM_TAG,
  EXTEND_COOLDOWN_MS,
  WRITE_SPACING_MS,
  releaseClaim,
  expectedAfter,
  EXTEND_WITHIN_DAYS,
  STOCK_MAX,
  start,
  shelf,
  realStockFor,
  daysUntilExpiry,
  planForOffer,
  keepShelfAlive,
  matchRowForOrder,
  normaliseTitle,
  deliverPendingOrders,
};
