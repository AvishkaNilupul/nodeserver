// Pull ONE account off ONE active marketplace listing, keeping the rest of the
// listing (its other accounts / undelivered pool lines) intact. This is the
// per-account, per-listing surgery shared by:
//   - drop-archive "mark sold": the sold account leaves the listings that sell
//     the sold game, the rest of the listing keeps selling.
//   - renter manual-add: an account promised to a listing is reclaimed for a
//     renter's bot, so it must first come off the market — but only that one
//     account, never the whole listing.
//
// Each marketplace needs different handling because "the account is on this
// listing" means different things:
//   funpay      — a login:password line in the offer's auto-delivery pool.
//   gameflip    — the account's credentials are baked into the live auto-
//                 delivery code, so the whole offer must come down (and can be
//                 republished with a fresh account to keep the sale slot).
//   digiseller  — one delivery "unit" (contentId) per account.
//   ggsel       — row-tracked; the guardian auto-feed reconciles the platform.
//   zeusx       — either one credential baked into the offer (automatic
//                 delivery) or a bare quantity we hand over in chat.
//
// On the quantity platforms a unit whose content_id we never recorded cannot be
// deleted (see utils/listingRepublish.js). Detaching our bookkeeping alone would
// then leave the credentials on sale while the row claims the listing is clean —
// tolerable when the account merely changed hands, fatal when the account no
// longer exists. `hardRepublish` is how the caller says which case it has.
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const mp = require("./marketplaces");
const guardian = require("./marketplaceGuardian");
const gfFulfiller = require("./gameflipFulfiller");
const { republishQtyListing } = require("./listingRepublish");
const { buildSetGridImage } = require("./setImage");
const fsp = require("fs").promises;

function splitCsv(v) {
  return String(v || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

// What removing `login` means for a ZeusX offer. Pure so the decision is
// testable without ZeusX: "delist" takes the whole offer down (its credentials
// are the account's, or it has nothing left to sell), "shrink" leaves it on sale
// with one unit fewer. Exported for tests.
function zeusxDetachPlan({ autoDeliver, logins, login }) {
  const kept = (logins || []).filter(
    (x) => !login || String(x).toLowerCase() !== String(login).toLowerCase(),
  );
  if (autoDeliver)
    return { action: "delist", kept: [], reason: "auto-deliver" };
  if (!kept.length) return { action: "delist", kept, reason: "emptied" };
  return { action: "shrink", kept, quantity: kept.length };
}

// Digiseller refuses to delete a delivery unit a buyer has already taken
// ("Can't delete sold content" / код content-2). That refusal is good news: the
// unit is spent, so nobody else can be handed those credentials and the only
// thing left to do is stop tracking it. Treating it as a failure instead makes
// the suspension sweep retry the same product every pass and, with
// hardRepublish, throw away a perfectly good product's URL over a unit that is
// no longer on sale. Exported for tests.
function isSoldContentError(err) {
  const msg = String((err && err.message) || err || "");
  return (
    /content-2/.test(msg) ||
    /can'?t delete sold content/i.test(msg) ||
    /проданное содержимое/i.test(msg)
  );
}

// Remove one account from a listing row's comma-separated account fields.
async function detachAccountFromRow(listing, accountId, login) {
  const ids = splitCsv(listing.accountId).filter(
    (x) => !accountId || x !== String(accountId),
  );
  const lower = String(login || "").trim().toLowerCase();
  const logins = splitCsv(listing.accountLogin).filter(
    (x) => !lower || x.toLowerCase() !== lower,
  );
  await MarketplaceListing.updateOne(
    { _id: listing._id },
    { $set: { accountId: ids.join(","), accountLogin: logins.join(", ") } },
  );
}

// Settle an ACCOUNT LISTING's stock ledger for one account, and drop the
// matching units[] entries from the listing row. Returns how many ledger rows
// were marked removed.
//
// Account listings (docs/ACCOUNT-LISTINGS-CONTRACT.md) are the fourth stock
// mode: the accounts are an explicit list the owner pasted in, held in
// models/SuppliedAccount and keyed from `units[].contentId`. Such a row keeps
// `accountId` / `accountLogin` EMPTY on purpose, so every branch below can only
// reach the platform side of the detach — nothing there would ever stop the
// account being claimed by the next publish, and the same login would go on
// sale again the moment stock was topped up.
//
// This writes models/SuppliedAccount directly, which utils/suppliedStock
// otherwise owns, because the shared claim layer has no "remove": its
// releaseClaim puts a row BACK on the shelf, which is the exact opposite of
// what a detach means — the account has just been sold, suspended or reclaimed.
// Scoped to this offer, and never to a row already marked sold, so it cannot
// rewrite sale evidence.
async function removeSuppliedUnits(row, accId, login) {
  const SuppliedAccount = require("../models/SuppliedAccount");
  const lower = String(login || "").trim().toLowerCase();
  const ids = [];
  for (const u of row.units || []) {
    if (!u || !u.contentId) continue;
    const byLogin = lower && String(u.login || "").toLowerCase() === lower;
    const byId = accId && String(u.contentId) === accId;
    if (byLogin || byId) ids.push(String(u.contentId));
  }
  if (!ids.length) return { matched: 0, removed: 0 };
  const r = await SuppliedAccount.updateMany(
    {
      _id: { $in: ids },
      offer: row.accountOffer,
      status: { $in: ["available", "fed"] },
    },
    { $set: { status: "removed" } },
  );
  // Pull the units whatever the ledger said: an already-sold row is not stock
  // either, and utils/listedLogins.js reads units[].login to decide whether a
  // login is still on sale somewhere.
  await MarketplaceListing.updateOne(
    { _id: row._id },
    { $pull: { units: { contentId: { $in: ids } } } },
  );
  return {
    matched: ids.length,
    removed: Number(r && (r.modifiedCount || r.nModified)) || 0,
  };
}

// Detach `acc` ({ _id, login }) from a single active listing `row`.
// Options:
//   reason    — short phrase stamped into the row's note ("sold manually",
//               "reclaimed for a renter"). Default "removed".
//   republish — after delisting a gameflip auto-delivery offer, publish a fresh
//               one so the sale slot survives. Default true (mark-sold's
//               behaviour); pass false to just take it down.
//   hardRepublish — when the account's Plati/GGSel unit cannot be deleted
//               individually, replace the whole product instead of only
//               detaching the row. Default false: it costs the product's URL and
//               its sales stats, so only a caller that knows the credentials are
//               unusable (the suspension sweep, the "account gone" fix) asks.
// Returns { detached: string[], warnings: string[] } — human-readable notes for
// the caller to surface. Never throws for expected marketplace failures; those
// become warnings so a partial detach still reports what it could do.
async function detachAccountFromListing(row, acc, opts = {}) {
  // A no-claim listing (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §6) holds
  // no-claim farm accounts whose units utils/noclaimListings owns. Every branch
  // below is archive surgery — a republish would rebuild the product from the
  // set's DropLog stock — so none of it may run on one.
  if (row && row.noclaimStock) {
    return {
      detached: [],
      warnings: [
        "no-claim listing — units are managed by utils/noclaimListings",
      ],
    };
  }
  const reason = opts.reason || "removed";
  const republish = opts.republish !== false;
  const detached = [];
  const warnings = [];
  const label = row.marketplace + " " + (row.externalId || row._id);
  const login = String((acc && acc.login) || "").trim();
  const accId = acc && acc._id ? String(acc._id) : "";

  try {
    // The ledger first, before any marketplace branch and whatever the
    // marketplace is — it is the only half of an account listing's detach that
    // is the same everywhere, and the only one that stops the account being
    // sold a second time. The platform side still runs below: delisting a
    // Gameflip/ZeusX offer whose code carries these credentials, or pulling a
    // FunPay pool line, is right for a supplied account too.
    if (row.accountOffer) {
      try {
        const res = await removeSuppliedUnits(row, accId, login);
        if (res.matched) {
          detached.push(
            label +
              " (account listing: " +
              (login || "the account") +
              (res.removed
                ? " marked removed — it can no longer be claimed)"
                : " was already sold — its unit was dropped)"),
          );
        } else {
          warnings.push(
            label +
              ": nothing in this account listing's stock references " +
              (login || "that account") +
              " — its ledger was left alone.",
          );
        }
      } catch (e) {
        warnings.push(
          label +
            ": could not update the account listing's stock ledger (" +
            (e.message || e) +
            ") — " +
            (login || "the account") +
            " may still be claimable, check the Account listings tab.",
        );
      }
    }
    if (row.marketplace === "funpay") {
      // Pull only this account's line out of the undelivered pool. FunPay has no
      // update API, so this reloads the editor and re-saves every field with the
      // account's line dropped; an emptied pool is saved off sale.
      const keptIds = splitCsv(row.accountId).filter((x) => !accId || x !== accId);
      const keptLogins = splitCsv(row.accountLogin).filter(
        (x) => !login || x.toLowerCase() !== login.toLowerCase(),
      );
      let upd = null;
      try {
        upd = await mp.funpayUpdateSecrets(row.externalId, row.externalNode, {
          removeLogins: login ? [login] : [],
          activate: null, // keep current state; goes off sale if pool empties
        });
      } catch (e) {
        // Leave the row referencing the account: our tracking must keep
        // matching the still-live offer so it isn't silently double-sold.
        warnings.push(
          label +
            ": could not pull the FunPay delivery line (" +
            (e.message || e) +
            ") — remove it on FunPay manually.",
        );
        return { detached, warnings };
      }
      const emptied = upd.pool === 0;
      const set = {
        accountId: keptIds.join(","),
        accountLogin: keptLogins.join(", "),
      };
      if (emptied) {
        set.status = "delisted";
        set.note = "account " + reason + " — FunPay pool emptied, off sale";
      }
      await MarketplaceListing.updateOne({ _id: row._id }, { $set: set });
      if (!upd.removed) {
        warnings.push(
          label +
            ": " +
            (login || "the account") +
            "'s delivery line was already handed to a buyer — it may already be sold there.",
        );
      }
      detached.push(
        label +
          (emptied
            ? " (delisted — pool emptied)"
            : " (line pulled, pool now " + upd.pool + ")"),
      );
    } else if (row.marketplace === "gameflip" && row.autoDeliver) {
      // The live Gameflip listing carries this account's credentials in its
      // delivery code — it must come down, then the chain optionally continues
      // with a fresh account if one exists.
      //
      // THE FAILURE MUST NOT BE SWALLOWED. This used to be
      // `.catch(() => {})` followed by an unconditional `status: "delisted"`.
      // gameflipDelist throws on any error — and a 429 from Gameflip's silent
      // rate limiter is the documented common case — so a delist that failed
      // left the offer LIVE on Gameflip, still selling the credentials of an
      // account we had just banned, suspended or sold elsewhere, while our side
      // recorded it as down. Nothing retries a row that is already "delisted",
      // so it stayed live until somebody noticed by hand.
      //
      // Now: only a delist that actually succeeded is recorded as one. A failed
      // one leaves the row ACTIVE and stamps the reason, so the watcher keeps
      // seeing it, the health page counts it, and the next pass tries again.
      let delisted = true;
      let delistErr = "";
      try {
        await mp.gameflipDelist(row.externalId);
      } catch (e) {
        delisted = false;
        delistErr = String((e && e.message) || e).slice(0, 200);
      }
      if (delisted) {
        await MarketplaceListing.updateOne(
          { _id: row._id },
          { $set: { status: "delisted", note: "account " + reason + " — delisted" } },
        );
        detached.push(label + " (delisted)");
      } else {
        await MarketplaceListing.updateOne(
          { _id: row._id },
          {
            $set: {
              lastError:
                "STILL LIVE — delist failed for an account that is " + reason +
                ": " + delistErr,
            },
          },
        );
        warnings.push(
          label +
            " — COULD NOT DELIST. The Gameflip listing is STILL LIVE and still " +
            "carries this account's credentials: " + delistErr,
        );
        // Return rather than fall through: republishing a replacement while the
        // original is still up would put TWO live listings on the same set, one
        // of them still selling the credentials of the account we are removing.
        return { detached, warnings };
      }
      const set = row.set ? await DropSet.findById(row.set).lean() : null;
      if (set && republish) {
        let img = "";
        try {
          img = await buildSetGridImage(set);
        } catch {
          img = "";
        }
        try {
          const fresh = await gfFulfiller.publishAutoDelivery({
            set,
            title: row.title,
            description: row.description,
            priceUsd: row.price,
            imagePath: img,
            qtyRemaining: Number(row.qtyRemaining) || 0,
            origin: row.origin,
          });
          detached.push(
            "republished on gameflip as " +
              fresh.externalId +
              " with " +
              (fresh.accountLogin || "a fresh account"),
          );
        } catch (e) {
          warnings.push(
            label + " was delisted but could not be republished: " + e.message,
          );
        } finally {
          if (img) await fsp.unlink(img).catch(() => {});
        }
      }
    } else if (
      row.marketplace === "digiseller" &&
      // Never an account listing: its units[].contentId is a SuppliedAccount
      // id, not a Digiseller content_id (the real one lives on the ledger row),
      // so this would ask Digiseller to delete content that does not exist.
      !row.accountOffer &&
      (row.units || []).some(
        (u) => u && String(u.accountId) === accId && u.contentId,
      )
    ) {
      const unit = (row.units || []).find(
        (u) => u && String(u.accountId) === accId && u.contentId,
      );
      let sold = false;
      try {
        await mp.digisellerRemoveContent(row.externalId, unit.contentId);
      } catch (e) {
        if (!isSoldContentError(e)) throw e;
        sold = true;
      }
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $pull: { units: { contentId: String(unit.contentId) } } },
      );
      await detachAccountFromRow(row, accId, login);
      detached.push(
        label +
          (sold
            ? " (delivery unit already sold — reference dropped)"
            : " (delivery unit removed)"),
      );
      try {
        await guardian.feedOne(String(row._id));
      } catch {
        /* auto-feed refills on its next pass */
      }
    } else if (
      row.marketplace === "digiseller" ||
      row.marketplace === "ggsel"
    ) {
      await detachAccountFromRow(row, accId, login);
      // republishQtyListing rebuilds the product from the row's DropSet and
      // refills it from ARCHIVE stock. An account listing has neither, so a
      // hard republish would trade a live product's URL and sales history for a
      // replacement it cannot fill. The ledger surgery above is the whole
      // detach here; the fed unit is reported below instead.
      if (opts.hardRepublish && !row.accountOffer) {
        const res = await republishQtyListing(row, { reason });
        for (const w of res.warnings) warnings.push(w);
        if (res.delisted) {
          detached.push(
            label +
              (res.replacement
                ? " (replaced by " + res.replacement.externalId + ")"
                : " (delisted)"),
          );
        }
        return { detached, warnings };
      }
      detached.push(label + " (detached)");
      warnings.push(
        label +
          ": " +
          (login || "the account") +
          "'s delivery unit stays on the product — neither platform can delete a " +
          "unit whose id we never recorded, so remove it there manually if it " +
          "must not reach a buyer.",
      );
      try {
        await guardian.feedOne(String(row._id));
      } catch {
        /* auto-feed refills on its next pass */
      }
    } else if (row.marketplace === "zeusx") {
      // ZeusX sells one of two ways (see publishZeusxShare):
      //   automatic — ZeusX holds this one account's credentials and hands them
      //     over on payment, so the offer must come down whole, exactly like
      //     Gameflip. The auto-lister's missing-secondary retry republishes it
      //     from live stock on a later sweep.
      //   coordinated — the offer is just a quantity we hand over in chat, and
      //     the accounts behind it live only in our row. One account leaving is
      //     one unit fewer on sale; an emptied offer goes off sale rather than
      //     promising stock we cannot deliver.
      const plan = zeusxDetachPlan({
        autoDeliver: row.autoDeliver,
        logins: splitCsv(row.accountLogin),
        login,
      });
      const keptLogins = plan.kept;
      if (plan.action === "delist" && plan.reason === "auto-deliver") {
        await mp.zeusxDelist(row.externalId);
        await MarketplaceListing.updateOne(
          { _id: row._id },
          {
            $set: {
              status: "delisted",
              note: "account " + reason + " — delisted",
            },
          },
        );
        detached.push(label + " (delisted)");
      } else if (plan.action === "delist") {
        await mp.zeusxDelist(row.externalId);
        await MarketplaceListing.updateOne(
          { _id: row._id },
          {
            $set: {
              accountId: "",
              accountLogin: "",
              status: "delisted",
              note: "account " + reason + " — no accounts left, off sale",
            },
          },
        );
        detached.push(label + " (delisted — last account removed)");
      } else {
        // Shrink the offer BEFORE our row, so a failed update leaves the row
        // still matching what ZeusX is selling.
        await mp.zeusxUpdateOffer(row.externalId, {
          quantity: plan.quantity,
        });
        await detachAccountFromRow(row, accId, login);
        await MarketplaceListing.updateOne(
          { _id: row._id },
          { $set: { qtyTarget: keptLogins.length } },
        );
        detached.push(label + " (quantity now " + keptLogins.length + ")");
      }
    } else if (!row.accountOffer) {
      // Not for an account listing on a claim-at-sale market (Eldorado,
      // PlayerAuctions, G2G, Z2U): the offer there is a bare quantity, the
      // credentials never left our side, and the ledger row is "removed" by
      // now, so no delivery can pick it. This warning would send the owner
      // hunting on the platform for something that is not there.
      warnings.push(
        label + " still references this account — remove it there manually",
      );
    }
  } catch (e) {
    warnings.push(label + ": " + (e.message || e));
  }

  return { detached, warnings };
}

module.exports = {
  detachAccountFromRow,
  detachAccountFromListing,
  zeusxDetachPlan,
  isSoldContentError,
};
