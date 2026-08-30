const mongoose = require("mongoose");

// One row per external marketplace listing created from the site, so we can
// show where a drop set is published and delist/update it later.
const marketplaceListingSchema = new mongoose.Schema(
  {
    set: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DropSet",
      required: true,
      index: true,
    },
    marketplace: {
      type: String,
      enum: [
        "gameflip",
        "digiseller",
        "g2g",
        "ggsel",
        "funpay",
        "epicnpc",
        "zeusx",
      ],
      required: true,
      index: true,
    },
    externalId: { type: String, required: true },
    // Who created this listing. "auto" = published by the auto-farmer
    // (utils/autoLister.js) or by the relist chain succeeding an auto listing;
    // "manual" = published by the owner from the Listings page;
    // "unclaimed" = published by the unclaimed-farms auto-lister
    // (utils/unclaimedAutoList.js) for a no-claim / web-token farm account.
    // Only "auto" rows are ever repriced.
    //
    // This is what scopes automatic price changes: the post-event scarcity
    // markup only ever touches origin:"auto" rows, so the owner's own hand-made
    // listings keep the price they were given. The default is deliberately
    // "manual" — an unmarked row is treated as the owner's and left alone,
    // which is the safe way to be wrong.
    origin: {
      type: String,
      enum: ["auto", "manual", "unclaimed"],
      default: "manual",
      index: true,
    },
    // FunPay has no per-offer API: delisting re-saves the offer's editor form,
    // which needs the category node id. Stored here at publish time.
    externalNode: { type: String, default: "" },
    url: { type: String, default: "" },
    title: { type: String, default: "" },
    // Kept so a sold auto-delivery listing can be relisted identically.
    description: { type: String, default: "" },
    price: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    status: {
      type: String,
      enum: ["active", "sold", "delisted", "error"],
      default: "active",
      index: true,
    },
    // Digiseller delivery units, one row per unit we fed, so a single BAD unit
    // can be pulled later. Digiseller returns each unit's content_id on add
    // and offers no endpoint to list a product's content afterwards (verified
    // live 2026-07-29), so an id not captured here is unreachable forever —
    // which is exactly why the 36 units already on live products cannot be
    // removed individually and had to be handled by delisting.
    units: {
      type: [
        {
          _id: false,
          contentId: { type: String, default: "" },
          accountId: { type: String, default: "" },
          login: { type: String, default: "" },
          addedAt: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    note: { type: String, default: "" },
    lastError: { type: String, default: "" },
    // Gameflip auto-delivery: the farmed account attached to this listing as
    // an auto-delivered digital code. The account is reserved (soldAt) while
    // the listing is live and released again if the listing is delisted.
    autoDeliver: { type: Boolean, default: false },
    accountId: { type: String, default: "" },
    accountLogin: { type: String, default: "" },
    // How many more units to relist (one at a time) after this one sells.
    qtyRemaining: { type: Number, default: 0 },
    // Relist-retry backoff for a sold chain whose successor failed to publish.
    // `relistRetryAt` is the earliest moment the fulfiller may try again and
    // `relistAttempts` how many consecutive failures it has seen — together
    // they stop a permanently unfulfillable chain (nothing in stock holds the
    // bundle) from being retried every single tick forever.
    relistRetryAt: { type: Date, default: null },
    relistAttempts: { type: Number, default: 0 },
    // Quantity-based auto-delivery (Plati / GGSel): how many units the
    // guardian keeps available on the platform, topping the listing up with
    // freshly claimed accounts as units sell. 0 disables auto-feeding.
    qtyTarget: { type: Number, default: 0 },
    // Units this listing has SOLD, cumulative. On a quantity listing the
    // platform never tells us "a sale happened" — it just reports less stock
    // than we left there, so the guardian infers sales from the drop and adds
    // them here (see recordQuantitySale in utils/saleLearning.js). Doubles as
    // the sequence number that keeps each unit's SaleSignal distinct.
    unitsSold: { type: Number, default: 0 },
    // Remaining stock as of the end of the last guardian pass (what we read,
    // plus whatever we fed afterwards). null = never read. The next pass
    // subtracts the fresh reading from this to learn how many units sold in
    // between; without the "plus what we fed" part a top-up would read as
    // negative sales, and without persisting it at all a failed feed would
    // make the same shortfall count as a new sale on every single pass.
    lastStock: { type: Number, default: null },
  },
  { timestamps: true },
);

// Best-effort audit: log every listing CREATION into the unified activity log
// (utils/systemLog.js), in one place, covering all publish paths (auto-lister +
// relist chain + manual). All listing creates go through .create()/.save(), so a
// save hook catches them; insertMany is never used for listings. pre-save stashes
// isNew; post-save fires AFTER the write, never throws and is never awaited — a
// logging failure can never affect the listing. systemLog is required lazily to
// avoid any model load-order cycle.
// Mongoose 9 (kareem 3) dropped callback-style middleware: a pre("save") hook is
// never passed a `next` — it must be synchronous (return undefined) or async
// (return a promise). The old `function (next) { …; next(); }` form threw
// `TypeError: next is not a function` on EVERY MarketplaceListing.save()/.create(),
// which silently broke all auto-listing publishes and post-event reprices (doc
// saves), while query updates (updateOne/findOneAndUpdate) kept working and hid it.
marketplaceListingSchema.pre("save", function () {
  try {
    this.$locals.wasNew = this.isNew;
  } catch {
    /* ignore */
  }
});
marketplaceListingSchema.post("save", function (doc) {
  try {
    if (!doc.$locals || !doc.$locals.wasNew) return;
    require("../utils/systemLog").logEvent({
      category: "listings",
      action: "published",
      actor: doc.origin === "auto" ? "autoLister" : "system",
      subject: doc.marketplace || "",
      subjectId: doc._id,
      count: 1,
      detail:
        (doc.origin || "manual") +
        " " +
        (doc.marketplace || "") +
        " listing" +
        (doc.price ? " $" + doc.price : "") +
        (doc.accountLogin ? " (" + doc.accountLogin + ")" : ""),
      meta: {
        marketplace: doc.marketplace,
        origin: doc.origin,
        externalId: doc.externalId,
        setId: String(doc.set || ""),
        price: doc.price,
      },
    });
  } catch {
    /* audit is best-effort */
  }
});

module.exports = mongoose.model("MarketplaceListing", marketplaceListingSchema);
