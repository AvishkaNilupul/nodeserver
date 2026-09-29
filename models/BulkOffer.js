const mongoose = require("mongoose");
const { OPEN_STATES, CLOSED_STATES } = require("../utils/bulkPacks/config");

// One bulk offer sent by the owner from the Bulk packs page
// (docs/bulk-packs/CONTRACT.md §5): N+ accounts of one bundle at a tier
// discount (kind "accounts", source dropset / noclaim) or N+ fresh accounts
// farming one game for D days (kind "farming", source farm), on ONE market.
//
// dropset/noclaim offers also own an ordinary MarketplaceListing row (`listing`,
// whose bulkOfferId points back here) so the existing fulfillers deliver them
// unchanged. Farming offers have no row: the farm services parse the title.
//
// `reserved[]` is the AUTHORITY on which accounts this offer holds — the row's
// `units[]` is written concurrently by the fulfillers, so the loop reconciles
// the two every pass and heals the row, never the other way round (CONTRACT I3).
//
// `open` is true exactly while `state` is one of OPEN_STATES, and it is what
// the partial unique index on slotKey keys off (CONTRACT I6): one open offer
// per slot, any number of closed ones. Writers set `open` (and `closedAt` when
// closing) with every state write; the hooks at the bottom enforce the same
// rule for any write that forgets.

const STATES = [...OPEN_STATES, ...CLOSED_STATES];
// History entries kept per offer (CONTRACT §5: last 60, via $slice).
const HISTORY_KEEP = 60;

function isOpenState(s) {
  return OPEN_STATES.includes(s);
}

// One reserved account behind the offer.
//   on_offer   reserved and on sale
//   retiring   pulled off the row (phase 1 of CONTRACT I10), waiting for the
//              re-read that proves it did not sell before it is released
//   released   reservation handed back (only after stock.isStillOurs)
//   delivered  sold to a buyer — never released, never pulled
const reservedSchema = new mongoose.Schema(
  {
    accountId: { type: String, default: "" },
    login: { type: String, default: "" },
    state: {
      type: String,
      enum: ["on_offer", "retiring", "released", "delivered"],
      default: "on_offer",
    },
    orderId: { type: String, default: "" },
    at: { type: Date, default: Date.now },
    changedAt: { type: Date, default: null },
    reason: { type: String, default: "" },
    // The owner spent this account elsewhere (hand sale, renter): it leaves the
    // pack but its reservation is NEVER handed back — releasing would put a
    // spent account's drops back on sale. The safe direction is a kept hold.
    keepReserved: { type: Boolean, default: false },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    action: { type: String, default: "" },
    detail: { type: String, default: "" },
    actor: { type: String, default: "" },
  },
  { _id: false },
);

const bulkOfferSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      enum: ["accounts", "farming"],
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ["dropset", "noclaim", "farm"],
      required: true,
    },
    // Never digiseller/plati or ggsel (owner block since 2026-09-28), never
    // playerauctions or zeusx: an offer for any of them cannot even be saved.
    market: {
      type: String,
      enum: ["eldorado", "g2g", "gameflip"],
      required: true,
      index: true,
    },
    set: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "DropSet",
      default: null,
      index: true,
    },
    setName: { type: String, default: "" },
    game: { type: String, default: "" },
    // Farming term in days (farm offers only).
    days: { type: Number, default: 0 },
    // eldorado/g2g: the offer's minimum order, in ACCOUNTS (one unit is always
    // one account). gameflip: the pack size. No multiplier anywhere (§2).
    minQty: { type: Number, required: true },
    discountPct: { type: Number, default: 0 },
    // The single price the discount was taken off, and where it came from:
    // "listing" | "set" | "engine" | "farm-table".
    anchorPrice: { type: Number, default: 0 },
    anchorBasis: { type: String, default: "" },
    // Fixed when sent; the system never reprices a live bulk offer.
    unitPrice: { type: Number, default: 0 },
    packPrice: { type: Number, default: 0 }, // gameflip only
    title: { type: String, default: "" },
    description: { type: String, default: "" },
    listing: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MarketplaceListing",
      default: null,
    },
    externalId: { type: String, default: "", index: true },
    url: { type: String, default: "" },
    state: {
      type: String,
      enum: STATES,
      default: "sending",
      index: true,
    },
    open: { type: Boolean, default: true },
    slotKey: { type: String, required: true },
    // Paused by the loop (farm capacity short), as opposed to by the owner.
    // Only an autoPaused offer is ever resumed automatically.
    autoPaused: { type: Boolean, default: false },
    lowStock: { type: Boolean, default: false },
    reserved: { type: [reservedSchema], default: [] },
    advertisedQty: { type: Number, default: 0 },
    unitsDelivered: { type: Number, default: 0 },
    ordersCount: { type: Number, default: 0 },
    revenueUsd: { type: Number, default: 0 },
    lastOrderAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
    lastCheckAt: { type: Date, default: null },
    lastError: { type: String, default: "" },
    // A standing problem the owner must look at ("Needs attention (key): …"),
    // raised once by the loop and cleared only by the check that raised it
    // (docs/bulk-packs/FIXES-1.md L8). Separate from lastError, which carries
    // transient loop errors and send failures: one must never wipe the other.
    attention: { type: String, default: "" },
    history: { type: [historySchema], default: [] },
    createdBy: { type: String, default: "" },
    closedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// CONTRACT I6: one OPEN offer per slot. Partial, so closed offers accumulate
// freely and a slot can be re-sent once its offer closes; a duplicate click
// while one is open fails E11000, which send.js turns into a 409.
bulkOfferSchema.index(
  { slotKey: 1 },
  { unique: true, partialFilterExpression: { open: true } },
);
bulkOfferSchema.index({ open: 1, kind: 1 });
bulkOfferSchema.index({ market: 1, state: 1 });

bulkOfferSchema.statics.OPEN_STATES = OPEN_STATES;
bulkOfferSchema.statics.CLOSED_STATES = CLOSED_STATES;
bulkOfferSchema.statics.isOpenState = isOpenState;

// ---------------------------------------------------------------------------
// Consistency hooks
// ---------------------------------------------------------------------------
// A closed offer left with open:true would hold its slot forever (every re-send
// answers "already live") and be picked up as open by every loop pass; an open
// one with open:false would let a second offer onto the same slot. So the rule
// "open exactly while the state is open" is enforced here as well as by the
// writers, and the history cap with it.
//
// Mongoose 9 (kareem 3) passes no `next`: these hooks are synchronous, and a
// throw rejects the write.

// Document writes (create / save): `open` is DERIVED from `state`.
bulkOfferSchema.pre("validate", function () {
  const open = isOpenState(this.state);
  if (this.open !== open) this.open = open;
  if (!open && !this.closedAt) this.closedAt = new Date();
  if (Array.isArray(this.history) && this.history.length > HISTORY_KEEP) {
    this.history.splice(0, this.history.length - HISTORY_KEEP);
  }
});

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlainMap = (o) => !!o && typeof o === "object" && !Array.isArray(o);

// True when the update already writes `path` through any operator.
function updateWrites(update, path) {
  if (own(update, path)) return true;
  return Object.keys(update).some(
    (op) =>
      op.startsWith("$") && isPlainMap(update[op]) && own(update[op], path),
  );
}

// Query writes: an update does not run validators (the AvailableAccount
// "spent" enum trap — an unlisted value lands silently and every later save()
// of that document throws), so an invalid state is refused here, and a state
// write that leaves out `open` / `closedAt` has them filled in. Values a
// writer set explicitly are never overridden. Pipeline updates are left alone.
function normaliseUpdate() {
  const update = this.getUpdate();
  if (!isPlainMap(update)) return;
  // An undefined value is stripped from the update by Mongoose (a no-op write),
  // so it is not a state write and must not become a refusal.
  let hasState = false;
  let state;
  if (own(update, "state") && update.state !== undefined) {
    hasState = true;
    state = update.state;
  }
  if (
    isPlainMap(update.$set) &&
    own(update.$set, "state") &&
    update.$set.state !== undefined
  ) {
    hasState = true;
    state = update.$set.state;
  }
  if (hasState) {
    if (!STATES.includes(state)) {
      throw new Error(
        'BulkOffer: "' + String(state) + '" is not a valid state',
      );
    }
    const open = isOpenState(state);
    if (!isPlainMap(update.$set)) update.$set = {};
    if (!updateWrites(update, "open")) update.$set.open = open;
    if (!open && !updateWrites(update, "closedAt"))
      update.$set.closedAt = new Date();
  }
  // "keep last 60": a bare $push of one entry becomes $each + $slice.
  if (isPlainMap(update.$push) && own(update.$push, "history")) {
    const v = update.$push.history;
    if (isPlainMap(v) && own(v, "$each")) {
      if (!own(v, "$slice")) v.$slice = -HISTORY_KEEP;
    } else {
      update.$push.history = { $each: [v], $slice: -HISTORY_KEEP };
    }
  }
  this.setUpdate(update);
}
bulkOfferSchema.pre("updateOne", normaliseUpdate);
bulkOfferSchema.pre("updateMany", normaliseUpdate);
bulkOfferSchema.pre("findOneAndUpdate", normaliseUpdate);

module.exports = mongoose.model("BulkOffer", bulkOfferSchema);
