const mongoose = require("mongoose");

// One row per paid Epic-account delivery that uses the "buyer-facing mail
// viewer" flow. The buyer never gets the real Outlook/Microsoft credentials —
// instead we hand them a URL on our server, the Epic email address, and a
// freshly generated password that only works on OUR viewer page. The viewer
// then proxies ONLY mail from Epic to that address, received after the sale,
// so there is no way to pivot into the shared SOOP recovery inbox the Outlook
// address usually doubles as.
//
// Why the password is bcrypt-hashed (not symmetric like MailAccount.passwordEnc):
// we don't need to recover it. It's a one-shot buyer-only secret. If a buyer
// loses it we revoke and mint a new one.
//
// Memory refs: project_epic_store_el9in_scan_1028 (the design), project_epic_
// account_generator (where EpicAccount comes from), reference_outlook_pool_
// and_proxies (why we can't just hand the inbox over).
const buyerMailSessionSchema = new mongoose.Schema(
  {
    // The Epic account this session delivers. One EpicAccount can accumulate
    // several sessions over time (we don't force unique) — only the newest
    // non-revoked one is honored at /mail/login.
    epicAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EpicAccount",
      required: true,
      index: true,
    },
    // Optional pointer to a prod MailAccount row. Only populated when prod has
    // its own Outlook fleet; the Mac-tunnelled design (see
    // project_epic_worker_on_mac_1022 pattern + utils/outlookGraphReader) does
    // not create a local MailAccount, so this stays null and the inboxAddress
    // below is the authoritative key.
    mailAccountId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MailAccount",
      default: null,
      index: true,
    },
    // Lowercased copy of the Outlook address we're exposing. Duplicated from
    // MailAccount so a listing query doesn't have to populate — and so we
    // notice if the MailAccount's email changes mid-flight (treated as a
    // revocation reason).
    inboxAddress: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    // bcrypt hash of the random password shown to the buyer on delivery.
    // The plaintext is NEVER stored — the admin endpoint returns it exactly
    // once in the response, operator pastes it into the delivery message.
    passwordHash: { type: String, required: true },

    expiresAt: { type: Date, required: true, index: true },
    revokedAt: { type: Date, default: null, index: true },
    revokedReason: {
      type: String,
      enum: ["", "manual", "email_changed", "expired", "replaced", "unlisted", "refunded"],
      default: "",
    },

    // Where the session is in a sale (utils/epicSales.js):
    //   "listed" — minted when the account was put on an instant-delivery
    //              listing. Its password sits in the marketplace's delivery
    //              entry, so the buyer has it the moment they pay. No expiry
    //              clock yet (expiresAt is far out).
    //   "sold"   — the sale was seen: soldAt is set and expiresAt = soldAt +
    //              the access window.
    //   ""       — minted by hand at delivery time (the Deliver button):
    //              already a sold session, created at the sale.
    stage: { type: String, enum: ["", "listed", "sold"], default: "", index: true },
    // The buyer password, encrypted (utils/secretBox) — only kept for listed
    // sessions, whose password has to be re-sent whenever the listing's stock
    // is rewritten. The bcrypt hash above is still what /mail/login checks.
    passwordEnc: { type: String, default: "" },
    listingId: { type: mongoose.Schema.Types.ObjectId, ref: "EpicListing", default: null, index: true },
    soldAt: { type: Date, default: null },

    // Delivery bookkeeping — operator records which marketplace order spawned
    // this session so a complaint later can be traced to one row.
    marketplace: { type: String, default: "" }, // "eldorado" | "manual" | ...
    orderRef: { type: String, default: "" },

    // Pure stats — the viewer page updates them on every GET /mail/inbox hit
    // so the admin can see "did the buyer actually log in?".
    firstViewAt: { type: Date, default: null },
    lastViewAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },

    // Who minted the session (admin userId, if any) — purely for the audit
    // trail on the Epic accounts tab.
    createdByUserId: { type: String, default: "" },
    note: { type: String, default: "" },
  },
  { timestamps: true },
);

// Convenience: a session is live iff it was never revoked and the clock is
// still before expiresAt. The route code calls this on every request so the
// shape must stay cheap.
buyerMailSessionSchema.methods.isLive = function isLive(now) {
  const t = now instanceof Date ? now : new Date();
  if (this.revokedAt) return false;
  return this.expiresAt instanceof Date && this.expiresAt.getTime() > t.getTime();
};

// The earliest mail the buyer may see: mail from before their purchase is
// never theirs. A listed session whose sale has not been recorded yet falls
// back to its creation (the listing time).
function mailCutoff(row) {
  const t = (row && (row.soldAt || row.createdAt)) || null;
  const d = t ? new Date(t) : null;
  return d && Number.isFinite(d.getTime()) ? d : new Date(0);
}
buyerMailSessionSchema.methods.mailCutoff = function () {
  return mailCutoff(this);
};
buyerMailSessionSchema.statics.mailCutoff = mailCutoff;

module.exports = mongoose.model("BuyerMailSession", buyerMailSessionSchema);
