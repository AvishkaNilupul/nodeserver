const mongoose = require("mongoose");

// The marketplace money trail: one row per thing that happened to a BUYER on a
// selling platform — the order landing, what sold, the exact bytes we sent them,
// the delivered mark, a price move, a failure.
//
// It exists because four delivery bugs in one week were all found by the owner
// noticing rather than by the system reporting, and the worst of them —
// PlayerAuctions order 16474028, eleven accounts shipped for a $5 sale — wrote
// no SystemEvent at all. Nothing anywhere recorded what we actually SENT to a
// buyer, so debugging started from a script every time.
//
// This is deliberately NOT a few more fields on SystemEvent:
//
//  1. Size. SystemEvent is documented as "kept small" and every subsystem in the
//     app shares it. These rows carry a verbatim (redacted) delivery message up
//     to 2000 chars, which is an order of magnitude bigger than a SystemEvent
//     row — putting them in the shared collection would push accounts, bots,
//     scanner and settings history out of a bytes-bound Atlas shared tier.
//  2. Indexes. The console pages by {market, at, _id} and {market, kind, at},
//     and pulls a whole order by {orderId, at}. Three compound indexes that only
//     the console would ever use, paid for on every write of every other
//     subsystem's audit row — they do not earn their keep on SystemEvent.
//  3. Retention and shape. SystemEvent has no `market` field, which is exactly
//     why per-market filtering is impossible today, and it expires at 90 days.
//     A sale dispute is opened later than that; this trail keeps 120.
//
// SystemEvent keeps its job (system-wide audit). Rows here are DIAGNOSTIC only:
// writing one must NEVER break the delivery it records — see
// utils/marketplaceLog.js, where every write is best-effort, the same contract
// as utils/systemLog.js. A delivery that works and logs nothing is bad; a
// delivery that fails because logging threw is catastrophic.
//
// NO PASSWORDS EVER REACH THIS COLLECTION. Message bodies are redacted by the
// logger before they get here, and `accounts` holds logins only.

// The string caps below are enforced twice on purpose. `maxlength` is the
// schema's hard guarantee that a runaway string cannot bloat a bytes-bound
// collection — but a Mongoose validator REJECTS the save, and a rejected save in
// a best-effort logger is a silently lost row. So each capped field also
// truncates in a setter, which means an oversized body costs us the tail of a
// message instead of the whole audit record. The ellipsis is kept so a reader
// can tell a truncated message from a short one.
const cap = (max) => (v) => {
  if (typeof v !== "string") return v;
  return v.length <= max ? v : v.slice(0, max - 1) + "…";
};

const marketplaceEventSchema = new mongoose.Schema({
  at: { type: Date, default: Date.now },
  // gameflip | digiseller | ggsel | zeusx | eldorado | playerauctions | g2g |
  // funpay. Z2U is excluded by the console contract — no capture, no tab.
  //
  // Deliberately a plain String and not an enum: an enum rejects the save, and
  // this logger swallows its own failures, so the first event from a market
  // someone adds next month would vanish without a trace. A row filed under an
  // unknown market name is visible and fixable; a row that never existed is not.
  market: { type: String, default: "" },
  // order_seen | sold | message_sent | delivered | price_changed | listed |
  // delisted | stock_synced | error. Plain String for the same reason as above.
  kind: { type: String, default: "" },
  severity: { type: String, enum: ["info", "warn", "error"], default: "info" },
  // "playerauctions-fulfiller" | "eldorado-farm-service" | "autolister" |
  // "reprice-listings" | "admin:<id>" | …
  actor: { type: String, default: "system" },

  // The marketplace's own order id, stored EXACTLY as the marketplace writes it
  // (G2G's "1788892037419NTQU", PlayerAuctions' "16474028"). Never normalised,
  // never lowercased: this is the string the owner will paste from a buyer's
  // complaint into the order-trail view, and it has to match byte for byte.
  orderId: { type: String, default: "" },
  externalId: { type: String, default: "" },
  listing: { type: mongoose.Schema.Types.ObjectId, ref: "MarketplaceListing" },
  game: { type: String, default: "" },
  title: { type: String, default: "", maxlength: 160, set: cap(160) },

  // ACCOUNTS HANDED OVER. Never an item count.
  //
  // PlayerAuctions order 16474028 ("Sea of Thieves Twitch Drops (11 Items)",
  // $5.00) reported purchased: { amount: 11, suffix: "Ship Skins" } and the
  // fulfiller read that 11 as a unit count. It was an ITEM count — eleven ship
  // skins on ONE account — and ten accounts were given away on a five dollar
  // sale. The suffix names the offer's unit, and that unit is never "accounts".
  // If you are about to write an item count into this field, read
  // tests/paQuantity.test.js first: the only honest route to a unit count is
  // money, what the buyer paid against what one unit costs.
  qty: { type: Number, default: 0 },
  priceUsd: { type: Number, default: 0 },
  paidUsd: { type: Number, default: 0 },
  // What we actually receive after the marketplace's fees, only when the market
  // tells us. Left 0 rather than guessed — an invented net figure would quietly
  // corrupt every margin comparison drawn from this collection.
  netUsd: { type: Number, default: 0 },

  // LOGINS ONLY. Never a password, never a token, never a ClientSecret.
  //
  // This collection is rendered in a browser: the console prints the message
  // body and this array straight onto a page, so anything stored here is a
  // credential dump one screenshot away from leaving the machine. Logins are
  // safe to keep and are half the debugging value — they are what tells you
  // WHICH account went to WHICH buyer — and they are not secret in the first
  // place, they are printed on the listing. The full password stays recoverable
  // from the account record, so nothing is lost by leaving it out of the log.
  //
  // Deliberately uncapped in length: the over-delivery above is only visible
  // because all eleven logins are listed. Truncating this array would hide the
  // exact bug this collection was built to catch.
  accounts: { type: [String], default: [] },
  // How it reached the buyer: chat | order-message | attached-content | api.
  channel: { type: String, default: "" },
  // The REDACTED body, verbatim otherwise — this is the "what did the buyer
  // actually receive" record. Redaction happens in the logger, before the value
  // arrives here; the model is not a second chance to catch a password.
  message: { type: String, default: "", maxlength: 2000, set: cap(2000) },
  // Whether the thing this row records actually SUCCEEDED — and left undefined
  // on purpose when the kind does not assert success (a listed/price_changed row
  // has nothing to be true or false about).
  //
  // No default, because the obvious default is the dangerous one. G2G's
  // sendUserMessage resolved happily on messages that never arrived, which is
  // why __g2gChatDropped exists; a row defaulting to ok:true would render an
  // unverified send as a confirmed delivery on the very page built to catch
  // that. For a send, ok means the read-back verification passed, not that the
  // call returned.
  ok: { type: Boolean },
  // The failure reason kept WHOLE where it fits — a half-written error message
  // is worse than a named short one (same rule as farmServiceAlert's reason
  // list). 400 chars is what FarmServiceOrder.lastError's consumers already cap.
  error: { type: String, default: "", maxlength: 400, set: cap(400) },
  // Small. A few scalars of context (before/after price, suspect unit counts,
  // the marketplace's status code) — never a response body, never an account
  // document. Mixed is unindexed and unbounded, so it is the easiest way to
  // accidentally make this collection expensive.
  meta: { type: mongoose.Schema.Types.Mixed },
});

// EXACTLY these four indexes, and no per-field `index: true` above.
//
// Every extra index is paid on every insert and in storage on a shared tier, and
// this collection is written on the delivery path, so index count is latency the
// buyer eventually feels. Each of the four below answers one query the console
// actually issues; anything not in this list is a query that should be rewritten
// to use one of them instead.
//
// _id is part of the first index because paging is by cursor (<at>|<_id>), never
// skip() — skip makes Mongo walk everything it skips, which is the exact
// bytes-bound cost this codebase keeps hitting.
marketplaceEventSchema.index({ market: 1, at: -1, _id: -1 }); // console main list
marketplaceEventSchema.index({ market: 1, kind: 1, at: -1 }); // a category inside a market
marketplaceEventSchema.index({ orderId: 1, at: -1 }); // "everything about this order"
// Auto-expire after 120 days (this {at:1} index doubles as the ascending index,
// the same convention as SystemEvent's 90-day TTL). Longer than SystemEvent
// because a buyer dispute or a chargeback can land months after the sale, and
// the only record of what we sent them is here.
marketplaceEventSchema.index(
  { at: 1 },
  { expireAfterSeconds: 120 * 24 * 60 * 60 },
);

module.exports = mongoose.model("MarketplaceEvent", marketplaceEventSchema);
