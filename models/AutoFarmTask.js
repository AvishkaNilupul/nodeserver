const mongoose = require("mongoose");

// One document per (game, campaignId) decision made by the auto-farmer
// (utils/autoFarmer.js). This is BOTH the audit log (every skip is recorded
// with its reason) AND the registry of which bots are auto-created — the Bots
// page uses the `bots` arrays here as the single source of truth for keeping
// auto-bots out of the manual host tabs and inside the separate Auto-farm tab.
const autoFarmTaskSchema = new mongoose.Schema(
  {
    game: { type: String, required: true, index: true },
    campaignId: { type: String, required: true, index: true },
    campaignName: { type: String, default: "" },
    campaignEndAt: { type: Date, default: null },

    // What the brain decided and why (human-readable, shown in UI + Telegram).
    decision: {
      type: String,
      enum: [
        "farm", // new bot(s) created / planned
        "probe", // unknown game -> small market-test batch
        "reuse_existing", // weekly campaign -> restarted the game's existing auto-bot
        "skip_low_demand", // research says items don't sell
        "skip_ends_soon", // campaign too close to its end to be worth accounts
        "skip_no_accounts", // pool at/below reserve floor, nothing to spend
        "skip_no_capacity", // Pi at max auto containers (may be retried later)
        "skip_host_offline", // the Pi was unreachable at decision time
        "skip_already_covered", // manual bots / archived accounts already cover this game's demand
      ],
      required: true,
    },
    reason: { type: String, default: "" },

    // Decision inputs, kept so the log explains itself later.
    demandScore: { type: Number, default: null },
    hadResearch: { type: Boolean, default: false },
    // Own sales history for this game (SaleSignal + reserved drops, last 45d)
    // — the training-data signal that boosts demand beyond external markets.
    internalSales: { type: Number, default: 0 },
    // How many accounts already cover this game before we add anything:
    // manual-bot farmers + unsold archive accounts holding this campaign.
    coverage: {
      manualFarmers: { type: Number, default: 0 },
      archiveHolders: { type: Number, default: 0 },
    },

    // Allocation.
    plannedAccounts: { type: Number, default: 0 },
    // Full tier target (before the pool fair-share trim). Backfill keeps
    // topping the task up toward this as the pool refills.
    targetAccounts: { type: Number, default: 0 },
    assignedAccounts: { type: [String], default: [] }, // pool usernames actually deployed

    // Bots created (or reused) for this task, all on the configured host (Pi).
    bots: {
      type: [
        {
          _id: false,
          host: { type: String, default: "" },
          file: { type: String, default: "" },
          container: { type: String, default: "" },
          reused: { type: Boolean, default: false },
        },
      ],
      default: [],
    },

    status: {
      type: String,
      enum: [
        "planned", // dry-run: decided but not executed; waiting for approval or live mode
        "active", // bots running, farming this campaign
        "completed", // campaign ended, bots stopped, accounts kept as inventory
        "stopped", // manually stopped from the UI
        "skipped", // terminal state for skip_* decisions
        "failed", // execution failed (claimed accounts were released back)
      ],
      default: "planned",
      index: true,
    },
    dryRun: { type: Boolean, default: false },
    error: { type: String, default: "" },

    executedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },

    // Gameflip auto-listing created for this task (published the moment the
    // bots started, mirroring the owner's manual early-bird flow).
    listing: {
      setId: { type: String, default: "" },
      externalId: { type: String, default: "" },
      url: { type: String, default: "" },
      title: { type: String, default: "" },
      price: { type: Number, default: 0 },
      qty: { type: Number, default: 0 },
      heldBack: { type: Number, default: 0 },
      // Secondary markets (Plati / GGSel) created alongside the Gameflip
      // listing. Each holds its own external id + share of the accounts.
      plati: {
        externalId: { type: String, default: "" },
        url: { type: String, default: "" },
        qty: { type: Number, default: 0 },
        error: { type: String, default: "" },
      },
      ggsel: {
        externalId: { type: String, default: "" },
        url: { type: String, default: "" },
        qty: { type: Number, default: 0 },
        error: { type: String, default: "" },
      },
      listedAt: { type: Date, default: null },
      repricedAt: { type: Date, default: null },
      postEvent: { type: Boolean, default: false },
      error: { type: String, default: "" },
    },
    // Dry-run preview: what WOULD have been listed (no real listing made).
    wouldList: {
      title: { type: String, default: "" },
      price: { type: Number, default: 0 },
      qty: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

// One decision per game+campaign — the brain never double-plans a campaign.
autoFarmTaskSchema.index({ game: 1, campaignId: 1 }, { unique: true });

module.exports = mongoose.model("AutoFarmTask", autoFarmTaskSchema);
