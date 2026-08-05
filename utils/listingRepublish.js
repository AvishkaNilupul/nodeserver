// Replace a whole quantity-fed product (Plati / GGSel) with a fresh one.
//
// This is the last resort for a product that contains a delivery unit we cannot
// target. Both platforms take content by the batch and hand it out per buyer,
// but neither can enumerate what a product currently holds:
//   Digiseller — GET /product/content answers 405, every list shape 404s. The
//                content_id returned by the add call is the ONLY handle for
//                deleting a single unit, so a unit fed before that id was
//                recorded is unreachable forever.
//   GGSel      — there is no /offers/{id}/products read at all, and every unit
//                delete shape is rejected.
// (Both re-verified live 2026-08-05.)
//
// So when the account behind an untargetable unit must stop being delivered —
// Twitch deleted it, and a buyer paying for it receives a login that cannot be
// logged into — the product itself has to come down, and a fresh one takes its
// place. The cost is the product's URL and its accumulated sales stats; the
// alternative is knowingly selling a dead account.
//
// The new product is published EMPTY and stocked by the guardian's own feed
// rather than by a second publish path: the feed already claims accounts that
// hold the whole bundle, records each unit against its account (the bookkeeping
// whose absence caused this in the first place), and does GGSel's
// autoselling/quantity dance. A product that ends up live but unstocked is
// reported as a warning and topped up by the guardian on its next pass.
const AutoFarmTask = require("../models/AutoFarmTask");
const MarketplaceListing = require("../models/MarketplaceListing");
const DropSet = require("../models/DropSet");
const mp = require("./marketplaces");
const guardian = require("./marketplaceGuardian");
const settings = require("./settings");
const { buildSetGridImage } = require("./setImage");
const fsp = require("fs").promises;

// Point the auto-farm task at the replacement product. Without this the
// refiller keeps topping up the product we just took off sale, and the task's
// links in the UI lead to a dead page.
async function repointTask(setId, marketplace, oldId, next) {
  if (!setId) return false;
  const key = marketplace === "digiseller" ? "plati" : "ggsel";
  const task = await AutoFarmTask.findOne({
    "listing.setId": setId,
    ["listing." + key + ".externalId"]: String(oldId),
  });
  if (!task) return false;
  task.listing[key].externalId = next.externalId;
  task.listing[key].url = next.url || "";
  task.listing[key].qty = next.qty || 0;
  task.markModified("listing");
  await task.save();
  return true;
}

async function publishEmptyProduct(marketplace, row, set, img) {
  if (marketplace === "digiseller") {
    const af = settings.getAutoFarm();
    const categoryId = Number(af.platiCategoryId) || 0;
    if (!categoryId) {
      throw new Error("no Plati category id in auto-farm settings");
    }
    const r = await mp.digisellerPublish({
      title: row.title,
      description: row.description,
      priceUsd: row.price,
      categories: [
        { owner: 1, categoryId, attributes: af.platiAttributes || [] },
      ],
    });
    if (img) await mp.digisellerUploadImage(r.externalId, img).catch(() => {});
    return r;
  }
  const categoryId = await mp.ggselResolveCategoryId(
    (set && set.coverGame) || row.title,
  );
  if (!categoryId) throw new Error("no GGSel category for this listing");
  return mp.ggselPublish({
    title: row.title,
    description: row.description,
    priceUsd: row.price,
    categoryId,
    delivery: "auto",
    coverImagePath: img,
  });
}

// Take `row` off sale and publish a replacement in its place.
// Returns { delisted, replacement, fed, warnings } — never throws for expected
// marketplace failures, so a caller repairing many products in a row always
// learns how far each one got.
async function republishQtyListing(row, { reason = "replaced" } = {}) {
  const out = { delisted: false, replacement: null, fed: 0, warnings: [] };
  const label = row.marketplace + " " + row.externalId;
  const set = row.set ? await DropSet.findById(row.set).lean() : null;

  try {
    if (row.marketplace === "digiseller") {
      await mp.digisellerDelist(row.externalId);
    } else {
      await mp.ggselDelist(row.externalId);
    }
  } catch (e) {
    // The product is still on sale with the bad unit in it, so stop here rather
    // than marking our row delisted and losing sight of it.
    out.warnings.push(
      label + ": could not take the product off sale (" + e.message + ")",
    );
    return out;
  }
  await MarketplaceListing.updateOne(
    { _id: row._id },
    {
      $set: {
        status: "delisted",
        note: reason + " — delisted, unit could not be removed individually",
      },
    },
  );
  out.delisted = true;

  if (!set) {
    out.warnings.push(
      label + " is off sale, but its drop set is gone — nothing to republish.",
    );
    return out;
  }

  let img = "";
  try {
    img = await buildSetGridImage(set);
  } catch {
    img = "";
  }
  try {
    const fresh = await publishEmptyProduct(row.marketplace, row, set, img);
    const created = await MarketplaceListing.create({
      set: set._id,
      marketplace: row.marketplace,
      externalId: fresh.externalId,
      url: fresh.url || "",
      title: row.title,
      description: row.description,
      price: row.price,
      status: "active",
      origin: row.origin || "auto",
      autoDeliver: true,
      note: "republished in place of " + row.externalId + " (" + reason + ")",
      qtyTarget: Math.max(1, Number(row.qtyTarget) || 0),
    });
    out.replacement = {
      id: String(created._id),
      externalId: fresh.externalId,
      url: fresh.url || "",
    };
    try {
      out.fed = await guardian.feedOne(String(created._id));
    } catch (e) {
      out.warnings.push(
        label + " was republished but not stocked: " + e.message,
      );
    }
    if (!out.fed) {
      out.warnings.push(
        label +
          " was republished as " +
          fresh.externalId +
          " but nothing could be fed into it yet — the guardian tops it up as " +
          "soon as an account holds the whole bundle.",
      );
    }
    await repointTask(set._id, row.marketplace, row.externalId, {
      externalId: fresh.externalId,
      url: fresh.url || "",
      qty: out.fed,
    });
  } catch (e) {
    out.warnings.push(
      label + " is off sale but could not be republished: " + e.message,
    );
  } finally {
    if (img) await fsp.unlink(img).catch(() => {});
  }
  return out;
}

module.exports = { republishQtyListing };
