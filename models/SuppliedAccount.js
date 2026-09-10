const mongoose = require("mongoose");

// The stock ledger for an ACCOUNT LISTING (docs/ACCOUNT-LISTINGS-CONTRACT.md,
// Feature B): one row per owner-supplied account pasted onto an AccountOffer.
//
// Deliberately mirrors models/UnclaimedAccount.js, because that model already
// solved this exact problem: the row's STATUS TRANSITION is the claim. There
// are no DropLog rows and no reservation behind a supplied account, so nothing
// else can stop two concurrent orders taking the same credentials —
// utils/suppliedStock.claimForListing flips available -> fed/sold with a single
// findOneAndUpdate({ _id, status: "available" }), and the loser of the race
// gets nothing instead of a second copy of the same login.
//
// Credentials are stored ENCRYPTED (utils/secretBox) and are decrypted only at
// the moment of delivery. Nothing may persist a decrypted password onto
// MarketplaceListing.
const suppliedAccountSchema = new mongoose.Schema(
  {
    // The product these accounts are the stock for.
    offer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountOffer",
      required: true,
      index: true,
    },
    login: { type: String, required: true },
    // Lowercased mirror, ALWAYS written (see the pre-validate hook below): it
    // is half of the unique index that stops the same login being pasted onto
    // one offer twice, and marketplaces echo logins back in whatever case the
    // owner typed them.
    loginLower: { type: String, default: "", index: true },

    // Encrypted via utils/secretBox. Read through the document's getters at
    // delivery time — NEVER by spreading the sub-document: `{...doc}` on a
    // Mongoose doc yields undefined fields, and that shipped
    // "Username: undefined" to a paying buyer.
    password: { type: String, default: "" },
    clientSecret: { type: String, default: "" },
    email: { type: String, default: "" },
    // Anything past field 4 of the pasted line, kept VERBATIM. A supplied line
    // can carry a recovery code or a note we have no column for, and guessing
    // at its meaning would hand the buyer a mislabelled field.
    extra: { type: String, default: "" },

    // Lifecycle. available -> fed | sold; removed = withdrawn by the owner.
    //
    // "fed"  = handed to a platform's own vault (a Digiseller content unit, a
    //          GGSel content unit, a FunPay secret, a Gameflip code, a ZeusX
    //          field). The platform will hand it to the next buyer without ever
    //          calling us back, so the row is no longer sellable ANYWHERE else —
    //          but it is not yet known to have reached a buyer, which is why it
    //          is a distinct state and not "sold".
    // "sold" = confirmed handed to a buyer.
    status: {
      type: String,
      enum: ["available", "fed", "sold", "removed"],
      default: "available",
      index: true,
    },

    // Which marketplace took this row. "" while it is still free stock.
    market: {
      type: String,
      enum: [
        "",
        "gameflip",
        "digiseller",
        "ggsel",
        "funpay",
        "zeusx",
        "eldorado",
        "playerauctions",
        "g2g",
        "z2u",
      ],
      default: "",
      index: true,
    },
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MarketplaceListing",
      default: null,
      index: true,
    },
    // Digiseller returns a content_id on add and offers no endpoint to list a
    // product's content afterwards, so an id not captured at feed time is
    // unreachable forever and the unit can only be pulled by delisting.
    contentId: { type: String, default: "" },
    // The order this row was claimed for. Indexed because it is the RESUME key:
    // a retry after a failed send re-reads the rows already carrying this
    // orderId instead of burning a second account (the missing block at
    // utils/playerauctionsFulfiller.js:166 burned 25 retries of ledger on
    // Eldorado order e69b19d3).
    orderId: { type: String, default: "", index: true },

    // "" = clean stock. Anything else EXCLUDES the row from claimable stock
    // until the owner clears it from the Accounts panel ("Allow anyway").
    //
    // "in-archive" = the login also exists as a BotAccount or an
    //   AvailableAccount, so the Drop Archive claim path could sell the very
    //   same account to somebody else. This is the double-sell guard: supplied
    //   stock has no DropLog reservation and no claim tag, so nothing else
    //   would catch the overlap. It is not optional.
    // "duplicate"  = flagged at ingest rather than silently dropped, so the
    //   owner sees what their paste actually contained.
    conflict: { type: String, default: "" },

    fedAt: { type: Date, default: null },
    soldAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);

// The same login cannot be added to one offer twice — the backstop behind
// suppliedStock's ingest-time duplicate check, so a double-submit of the same
// paste cannot create a second row that would later be handed to a second
// buyer.
suppliedAccountSchema.index({ offer: 1, loginLower: 1 }, { unique: true });
// Every claim asks the same question: free, conflict-free stock for this offer.
suppliedAccountSchema.index({ offer: 1, status: 1, conflict: 1 });

// Keep the mirror honest at the source. loginLower is half of the unique index,
// so a row written without it would collide with every other mirror-less row on
// the same offer ("" === ""), and a caller that forgot the mirror would silently
// defeat the duplicate guard instead of failing loudly.
//
// Mongoose 9 (kareem 3) dropped callback-style middleware: a pre hook is never
// passed a `next` — it must be synchronous or return a promise. The old
// `function (next) { …; next(); }` form threw on EVERY save.
suppliedAccountSchema.pre("validate", function () {
  if (typeof this.login === "string" && this.login) {
    this.loginLower = this.login.trim().toLowerCase();
  }
});

module.exports = mongoose.model("SuppliedAccount", suppliedAccountSchema);
