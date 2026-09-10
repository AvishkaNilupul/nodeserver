const mongoose = require("mongoose");

// An ACCOUNT LISTING (docs/ACCOUNT-LISTINGS-CONTRACT.md, Feature B): a product
// the owner defines by hand and backs with an explicit, pasted list of
// accounts. Those exact accounts are the stock (models/SuppliedAccount, one row
// per account); one sale hands over one account and the offer pauses itself
// when the list runs dry.
//
// This is deliberately NOT a DropSet. It has no items, no DropLog rows and no
// reservation, because reserveSetOnAccount (utils/dropReservation.js:44-57)
// returns false unless the account already holds a DropLog row for every
// itemKey — a pasted external account can never be reserved, is invisible to
// availableAccountsForSet, and cannot use any existing claim path. Reusing
// DropSet would have meant a product the archive believes it owns.
//
// There is deliberately NO `publicCatalog` and NO `listed` field: DropSet's
// publicCatalog defaults to TRUE, so shaping this on DropSet would have leaked
// owner-supplied accounts onto the public storefront the moment a row was
// created. An AccountOffer can only ever be published where the owner
// explicitly publishes it.
const accountOfferSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    // The canonical game for this listing. Feature A resolves every
    // marketplace's category from it (utils/listingGame.js reads it as
    // `offer.game`), which is why it is a first-class field here — DropSet has
    // no `game` at all and "what game is this listing" had four spellings.
    game: { type: String, default: "", index: true },
    note: { type: String, default: "" },
    priceUsd: { type: Number, default: 0, min: 0 },
    // Never publish or relist below this (0 = no floor). A relist inherits its
    // predecessor's price, so a floor stored on the product is the only thing
    // that survives a repricing chain.
    minPriceUsd: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "draft",
      index: true,
    },
    // Per-offer kill switch. Delivery is gated on
    // settings.accountListings.enabled && .autoDeliver && this flag, so one bad
    // offer can be stopped without touching any other market.
    autoDeliver: { type: Boolean, default: true },
    // Delivery text handed to the buyer. Placeholders: {login} {password}
    // {token} {email} {extra} {line} {title} {game}. Empty means
    // utils/suppliedStock.DEFAULT_TEMPLATE — stored empty rather than
    // pre-filled so a later change to the default reaches offers that never
    // customised it.
    deliveryTemplate: { type: String, default: "" },

    // Promo cover, reusing the Custom-listings cover generator verbatim (the
    // same fields DropSet carries at :52-56) so a cover can be regenerated
    // identically on a relist without re-entering it.
    coverStyle: { type: String, default: "promo" },
    coverServiceText: { type: String, default: "" },
    coverBullets: { type: [String], default: [] },
    coverImages: { type: [String], default: [] },

    createdBy: { type: String, default: "" },
  },
  { timestamps: true },
);

module.exports = mongoose.model("AccountOffer", accountOfferSchema);
