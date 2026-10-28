const mongoose = require("mongoose");

// One document per in-flight extension-driven Epic Games signup.
// Created by POST /api/epic/signup/start, terminal on POST
// /api/epic/accounts/from-extension (or on TTL expiry after 24h if the
// extension crashed / LO abandoned the tab). Holds the mailbox handle we
// need to fetch the OTP and the bcrypt hash of a per-session bearer the
// extension carries to authenticate its follow-up calls without needing
// the superadmin session cookie in a chrome-extension:// origin.
const epicSignupSessionSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    // bcrypt(bearer). Bearer itself is returned to the extension once and
    // never persisted plaintext anywhere.
    bearerHash: { type: String, required: true },

    // Identity handed to the extension. Password is encrypted at rest.
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    displayName: { type: String, default: "" },
    dateOfBirth: { type: String, default: "" }, // YYYY-MM-DD
    country: { type: String, default: "US" },
    email: { type: String, default: "", index: true },
    password: { type: String, default: "" }, // encrypted via secretBox

    // Local Outlook provider metadata; contains no mailbox credentials.
    provider: { type: String, default: "outlook-local" },
    providerMeta: { type: mongoose.Schema.Types.Mixed, default: {} },

    // Wizard state machine.
    //   identity_ready -> wizard_open -> awaiting_captcha -> awaiting_otp
    //   -> otp_delivered -> awaiting_totp -> verified
    // Terminal errors: failed, sms_required, otp_timeout, throttled.
    status: {
      type: String,
      default: "identity_ready",
      index: true,
    },
    lastError: { type: String, default: "" },

    // OTP once retrieved from the mailbox (short-lived cache so the
    // compatibility with older sessions).
    otpCode: { type: String, default: "" },
    otpReceivedAt: { type: Date, default: null },

    // TOTP secret harvested from Epic's 2FA enrollment page (only set if the
    // extension successfully enabled Authenticator App).
    totpSecret: { type: String, default: "" },

    // Populated after /from-extension successfully upserts the account.
    epicAccountId: { type: String, default: "", index: true },

    // Self-clean 24h after creation so the collection doesn't grow forever
    // from abandoned or errored sessions.
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { timestamps: true },
);

epicSignupSessionSchema.index({ provider: 1, email: 1 });

module.exports = mongoose.model("EpicSignupSession", epicSignupSessionSchema);
