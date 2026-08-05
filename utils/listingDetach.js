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
  const reason = opts.reason || "removed";
  const republish = opts.republish !== false;
  const detached = [];
  const warnings = [];
  const label = row.marketplace + " " + (row.externalId || row._id);
  const login = String((acc && acc.login) || "").trim();
  const accId = acc && acc._id ? String(acc._id) : "";

  try {
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
      await mp.gameflipDelist(row.externalId).catch(() => {});
      await MarketplaceListing.updateOne(
        { _id: row._id },
        { $set: { status: "delisted", note: "account " + reason + " — delisted" } },
      );
      detached.push(label + " (delisted)");
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
      if (opts.hardRepublish) {
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
    } else {
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
