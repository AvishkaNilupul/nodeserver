const mongoose = require("mongoose");

// One row per external marketplace listing created from the site, so we can
// show where a drop set is published and delist/update it later.
const marketplaceListingSchema = new mongoose.Schema(
  {
    set: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DropSet",
      // Required for every listing whose stock is the Drop Archive — the set IS
      // what gets claimed at delivery. A row backed by the no-claim farm has no
      // DropSet at all: it claims by GAME out of UnclaimedAccount, and pointing
      // it at some near-enough set would just mislabel what the buyer receives.
      required: function () {
        return !this.unclaimedGame;
      },
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
        "eldorado",
        "playerauctions",
        "z2u",
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
    // The lowest price this listing is KNOWN to hold on this marketplace —
    // learned from a refusal, not configured.
    //
    // It is an upper bound on the platform's true minimum, not the minimum
    // itself: all a rejection proves is that the price we asked for was too low
    // and the one the offer already carries is not. That is the useful bound
    // anyway, since the point is to stop asking for something impossible.
    //
    // GGSel enforces a per-CATEGORY minimum price and publishes it nowhere: it
    // is absent from the offers payload and from /categories (whose fields are
    // id, title, content_type, fee, payment_fee, tree, has_children — checked
    // live 2026-09-09). The only way to find it is to be told no, as a
    // FAILED_TO_SAVE / "Cannot set price less than the category minimum price"
    // on the write. Recording it here stops the next price sweep re-attempting a
    // price the platform has already rejected, and — more importantly — stops a
    // healthy listing carrying a permanent lastError, which is how a real error
    // ends up buried among fake ones.
    //
    // 0 means "nothing has been refused yet", not "no minimum exists".
    venueMinPriceUsd: { type: Number, default: 0 },
    currency: { type: String, default: "USD" },
    status: {
      type: String,
      // "removed" is written by utils/gameflipFulfiller's retire path when a
      // listing is gone from the marketplace for good (404 / expired /
      // cancelled). It was missing here: findOneAndUpdate skips validation so
      // the value landed in the DB fine — 33 rows carry it — and then every
      // later doc.save() on one of those rows threw. Exactly the shape of the
      // AvailableAccount "spent" enum bug, which made 172 accounts unsaveable.
      enum: ["active", "sold", "delisted", "error", "removed"],
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
          // Eldorado stock bookkeeping: one unit = one reserved account behind
          // the offer's quantity. Stamped when that unit is actually handed to
          // a buyer, which is what makes redelivery of an order impossible.
          deliveredAt: { type: Date, default: null },
          orderId: { type: String, default: "" },
          // PlayerAuctions only: a hand-over there can be SEVERAL messages plus
          // a separate confirm-delivery call, so "credential sent" and "order
          // marked delivered" are distinct states. Stamped once the messages
          // have landed, so a retry whose confirm-delivery failed re-confirms
          // instead of sending the buyer their credentials a second time.
          messagedAt: { type: Date, default: null },
        },
      ],
      default: [],
    },
    note: { type: String, default: "" },
    // Eldorado listings whose stock is NOT the auto-farm pool but the unclaimed
    // / no-claim farm ledger (models/UnclaimedAccount). When set, the Eldorado
    // fulfiller claims a sellable account for THIS game out of that ledger at
    // delivery time instead of consuming a pre-reserved `units[]` entry. This is
    // how the no-claim Overwatch bots feed an Eldorado offer directly.
    unclaimedGame: { type: String, default: "", index: true },
    // What this listing ADVERTISES, with counts — the contract the buyer agreed
    // to. A no-claim-backed row picks its stock by game at delivery time, so
    // without this there is nothing to check the picked account against: Eldorado
    // order 99d443eb was filled from a 10-item CAH listing with a 7-item account
    // carrying ONE of the two advertised Esports Loot Boxes. When set, the
    // fulfillers refuse any account that does not hold every entry (counts
    // included) unclaimed, and the stock sync advertises only accounts that do.
    // Empty = undeclared, and delivery keeps its pre-gate behaviour, so this can
    // be turned on one listing at a time as each item list is confirmed.
    requiredDrops: {
      type: [
        {
          _id: false,
          name: { type: String, default: "" },
          qty: { type: Number, default: 1 },
        },
      ],
      default: [],
    },
    // Bundle listings whose stock is the Drop Archive rather than the no-claim
    // farm: claim accounts holding this row's `set` at delivery time instead of
    // consuming a pre-reserved unit. Mutually exclusive with `unclaimedGame`.
    autoClaimSet: { type: Boolean, default: false, index: true },
    // Paused by the stock sync because nothing claimable was left, as opposed to
    // paused deliberately by the operator. Only rows carrying this flag are ever
    // resumed automatically.
    autoPaused: { type: Boolean, default: false },
    // When the Z2U shelf keeper last extended this offer's duration.
    //
    // Z2U does NOT move the publish date when an offer is extended, and the
    // published date plus the duration is the only expiry signal the seller
    // panel gives. So an extended offer keeps computing as overdue forever, and
    // without this the keeper re-extends the same offers on every tick —
    // hammering a rate-limited endpoint to no effect. Ours to remember, because
    // Z2U will not tell us.
    lastExtendedAt: { type: Date, default: null },
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
    // Unclaimed Gameflip LOT rows (utils/unclaimedLots.js): one listing that
    // delivers lotSize separate accounts (units[] holds their logins). 0 = a
    // normal single-unit / quantity row.
    lotSize: { type: Number, default: 0 },
    lotId: { type: String, default: "", index: true },
    // Gameflip rent-farm buffer: this row is a pre-provisioned "Automatic
    // Farming" offer. It sells a rental WINDOW, not stock — it has no DropSet
    // to claim against and must never reach the ordinary stock fulfiller.
    //
    // Gameflip has no post-sale hook: the account is baked into the listing as
    // an auto-delivered digital code and handed over the instant the buyer pays,
    // so unlike Eldorado / PlayerAuctions / G2G there is nothing to provision
    // INTO at sale time. The account is claimed and attached BEFORE the sale and
    // waits in the buffer; the window is stamped when the buyer PAYS, never at
    // publish, so an offer that sat unsold for six days still delivers its full
    // term (docs/GAMEFLIP-RENT-FARM-CONTRACT.md).
    //
    // WHY THIS IS AN EXPLICIT FLAG AND NOT A TITLE REGEX
    // The other three rent-farm services match on the title (FARM_TITLE,
    // /\bAutomatic\s+Farming\b/i, in utils/eldoradoFarmService.js) because they
    // are reading an ORDER off a marketplace and the title is genuinely all they
    // are given — they then need a GAME_ALIASES table to undo the storefront's
    // spelling. Here we CREATE the row ourselves, so we can record what it is
    // instead of inferring it back out of a string we wrote.
    //
    // It also has to be a flag because it is a routing decision, and a regex is
    // wrong in both directions. A false positive: the owner hand-makes a listing
    // named "… Automatic Farming …" and an ordinary bundle sale is diverted into
    // the buffered-sale lane, which would re-stamp a rental window on an account
    // nobody rented — the same class of mistake as repricing a manual listing,
    // which is why `origin` exists a few fields up. A false negative: a rent-farm
    // sale falls through to publishAutoDelivery, which demands one account
    // holding a whole DropSet and fails "Out of stock — no unsold account holds
    // this whole bundle". That is exactly how the five original Gameflip
    // rent-farm offers became unsellable and had to be taken down.
    rentFarm: { type: Boolean, default: false, index: true },
    // The single game the buffered account is pinned to, and the term the buyer
    // is BUYING, in days (120 / 180 / 365). The term is stored because it cannot
    // be recovered at sale time from the account: a buffered account is
    // provisioned with a deliberately long placeholder window (365d) purely so
    // renterExpiry never tears it down while its offer is live, and on sale
    // farmUntil is re-stamped to now + rentFarmDays — DOWN, for every term
    // shorter than the placeholder. The buyer paid for N days from purchase, not
    // for whatever was left of our placeholder.
    rentFarmGame: { type: String, default: "" },
    rentFarmDays: { type: Number, default: 0 },
    // The pool account (AvailableAccount _id) parked behind this offer, so an
    // unsold offer that is delisted, expires or 404s hands back exactly THAT
    // account and nothing else. Releasing by anything broader — the set, the
    // game, a tag — is how this codebase once freed drops a buyer had already
    // paid for; a release must name its account. Empty on any row that is not a
    // buffered offer.
    rentFarmPoolId: { type: String, default: "" },
    // Sale-handling lease. The sale claim used to be taken by CLEARING
    // rentFarmPoolId — which destroyed the only pointer to the account before
    // any of the work had happened, so a transient Atlas rejection mid-sale left
    // farmUntil at publish+365 (a straight shortfall on the term the buyer
    // bought) with no way to retry and nothing naming the account. The claim is
    // now a lease that keeps the pointer; the pointer is cleared only once the
    // window is actually stamped.
    rentFarmSaleClaimedAt: { type: Date, default: null },
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
