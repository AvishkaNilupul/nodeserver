// One document per Discord account in the farm pipeline. Starts life as a
// "test batch" entry — the probe + burn-in validation run against it decides
// whether this seller's stock is viable. Promoted accounts (role !== 'test')
// are the ones we actually farm against at scale.
//
// Sensitive credentials use the shared secretBox format; legacy plaintext is
// readable and is encrypted on its next save.

const mongoose = require("mongoose");
const { encrypt } = require("../utils/secretBox");

const probeSchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    state: String,
    httpStatus: Number,
    identity: {
      id: String,
      username: String,
      globalName: String,
      discriminator: String,
      email: String,
      emailVerified: Boolean,
      phone: String,
      locale: String,
      mfaEnabled: Boolean,
      publicFlags: Number,
      flags: Number,
      premiumType: Number,
      nsfwAllowed: Boolean,
      ageVerificationStatus: Number,
      storeCountry: String,
      snowflakeCreatedAt: Date,
    },
    trace: {
      guildCount: Number,
      connectionCount: Number,
      subscriptionCount: Number,
      affinityCount: Number,
    },
    quests: {
      enrollmentBlockedUntil: Date,
      accessSuspendedUntil: Date,
      liveCount: Number,
      liveIds: [String],
    },
    probeDurationMs: Number,
  },
  { _id: false },
);

const questLogSchema = new mongoose.Schema(
  {
    questId: { type: String, required: true },
    questName: String,
    rewardName: String,
    rewardType: Number, // 3 = cosmetic, 4 = orbs
    enrolledAt: Date,
    completedAt: Date,
    claimedAt: Date,
    orbsClaimed: Number,
    attempts: { type: Number, default: 1 },
    error: String,
    startedAt: Date,
    finishedAt: Date,
    hostId: String, // which Pi did the farming
  },
  { _id: false },
);

const discordTestAccountSchema = new mongoose.Schema(
  {
    // Primary key = Discord user ID (snowflake). Decoded on intake.
    userId: { type: String, required: true, unique: true, index: true },
    purchasedFrom: {
      marketplace: String, // 'eldorado' | 'funpay' | 'accsmarket' | ...
      seller: String,
      offerId: String,
      offerUrl: String,
    },
    purchasedAt: Date,
    pricePaidUSD: Number,
    credentials: {
      email: String,
      password: String,
      inboxUrl: String, // disposable mail access URL from the seller
      token: String, // Discord session token (expires on password change / logout)
      tokenAcquiredAt: Date,
    },
    // Role in the test matrix (see docs/discord-farm-plan).
    role: {
      type: String,
      enum: ["intake", "idle", "light-human", "quest", "selfbot-light", "selfbot-heavy", "farm", "retired"],
      default: "intake",
    },
    state: {
      type: String,
      enum: ["unknown", "alive", "email-unverified", "phone-unverified", "flagged-spammer", "quest-blocked", "quest-suspended", "captcha-wall", "banned", "disabled-or-token-invalid"],
      default: "unknown",
      index: true,
    },
    // All historical probes (append-only). First one is the intake snapshot.
    probes: { type: [probeSchema], default: [] },
    // Per-quest farming log.
    questLog: { type: [questLogSchema], default: [] },
    // Running totals (updated as questLog grows — cheap to recompute).
    totals: {
      questsCompleted: { type: Number, default: 0 },
      orbsClaimed: { type: Number, default: 0 },
      cosmeticsClaimed: { type: Number, default: 0 },
    },
    // When we're done evaluating this account.
    finalVerdict: {
      type: String,
      enum: [null, "pass", "fail", "pending"],
      default: "pending",
    },
    notes: { type: String, default: "" },
  },
  { timestamps: true, optimisticConcurrency: true },
);

// Helper to append a probe + reconcile state at the top level.
discordTestAccountSchema.methods.applyProbe = function (probe) {
  this.probes.push(probe);
  if (probe.state) this.state = probe.state;
  if (probe.identity && probe.identity.snowflakeCreatedAt) {
    // Nothing to update at top level — keep for history
  }
  return this;
};

// One result per quest: retries reconcile the existing entry and totals.
discordTestAccountSchema.methods.recordQuestResult = function (rec) {
  let entry = this.questLog.find((q) => q.questId === rec.questId);
  if (!entry) {
    this.questLog.push({ questId: rec.questId, attempts: 0 });
    entry = this.questLog[this.questLog.length - 1];
  }
  const attempts = (entry.attempts || 0) + 1;
  for (const [key, value] of Object.entries(rec)) {
    if (value != null && key !== "ok" && key !== "attempts") entry.set(key, value);
  }
  entry.attempts = attempts;
  if (rec.ok) entry.error = undefined;
  const claimed = this.questLog.filter((q) => q.claimedAt);
  this.totals = {
    questsCompleted: claimed.length,
    orbsClaimed: claimed.reduce((n, q) => n + (Number(q.orbsClaimed) || 0), 0),
    cosmeticsClaimed: claimed.filter((q) => q.rewardType === 3).length,
  };
  return this;
};

discordTestAccountSchema.pre("save", function () {
  for (const field of ["password", "token", "inboxUrl"]) {
    if (this.credentials?.[field]) this.credentials[field] = encrypt(this.credentials[field]);
  }
});

module.exports = mongoose.models.DiscordTestAccount
  || mongoose.model("DiscordTestAccount", discordTestAccountSchema);
