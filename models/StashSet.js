const mongoose = require("mongoose");

// A named holding folder for Twitch accounts you're NOT ready to put to work
// yet — a staging area that sits completely apart from the Account Pool
// (models/AvailableAccount.js). Nothing in the bot / drop-scanner / pool code
// ever reads StashSet or StashAccount, so accounts parked here are invisible to
// everything until you explicitly "Move set -> Account Pool" (see
// routes/stashRoutes.js). That isolation is the whole point: you can hoard,
// group, and live-check accounts over time without any of them leaking into a
// live bot config the way a pool account can.
//
// The aging system (utils/stashAging.js) is the one thing that acts on stashed
// accounts, and it deliberately stays on the stash's side of that line: it
// never writes a bot config, never touches the Drops Archive, and only ever
// hands an account onward through the same promote helper the manual "Move ->
// pool" button uses. It is off for every set until switched on individually.
// Per-set aging policy. Every field is inert until `enabled` flips true, which
// is why an existing set picks these defaults up without changing behaviour: a
// set that nobody opts in stays exactly the passive holding folder it was.
// Aging is configured per SET rather than globally because a set is already the
// unit you batch by (see the move-to-set route) — one set can be halfway through
// a slow 30-day soak while another runs a quick 7-day pass.
const agingPolicySchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },

    // Days an account sits doing NOTHING after it lands, before its first
    // session. A brand-new account that starts watching within minutes of
    // creation is its own signal; real ones have a gap.
    settleDays: { type: Number, default: 2, min: 0, max: 60 },

    // Graduation gate. All three must be satisfied before an account is
    // considered mature (age is necessary but not sufficient — an account
    // that sat untouched for a month has no history to show for it).
    minDays: { type: Number, default: 14, min: 0, max: 365 },
    minSessions: { type: Number, default: 10, min: 0, max: 500 },
    minWatchMinutes: { type: Number, default: 240, min: 0, max: 100000 },

    // Session cadence and shape. sessionsPerWeek drives the gap between
    // sessions; the runner jitters each gap heavily so a set doesn't tick in
    // lockstep. Session length is drawn uniformly from the min/max window.
    sessionsPerWeek: { type: Number, default: 5, min: 1, max: 50 },
    minSessionMinutes: { type: Number, default: 15, min: 1, max: 600 },
    maxSessionMinutes: { type: Number, default: 45, min: 1, max: 600 },

    // How many channels form an account's stable "taste". Sessions are drawn
    // from this list, so an account's history reads as a person with a few
    // haunts rather than uniform-random draws across the directory (which is
    // itself a fingerprint across a fleet this size).
    tasteSize: { type: Number, default: 4, min: 1, max: 12 },

    // Total follows to accumulate over the whole aging window, only ever
    // against channels this account actually watched. 0 disables following.
    followTarget: { type: Number, default: 3, min: 0, max: 50 },

    // Skip channels whose game currently has an active drop campaign. On by
    // default and the single most important knob here: sessions that land on
    // drop-enabled channels produce history identical to what the farm already
    // generates, which is exactly what aging is supposed to avoid.
    avoidDropChannels: { type: Boolean, default: true },

    // Explicit channel logins to draw from. Empty means "discover live
    // channels from Twitch's own directory", which is the intended mode —
    // a hand-pinned list ages the whole set against the same few channels.
    channelPool: { type: [String], default: [] },

    // Which egress hosts sessions may run from (same ids as
    // botHosts.listHosts()). Empty means local only — deliberately NOT "all
    // hosts", so enabling aging can never quietly add load to the Pi.
    hostIds: { type: [String], default: [] },

    // Concurrent live sessions for this set. The global cap in
    // utils/stashAging.js applies on top of this.
    maxConcurrent: { type: Number, default: 3, min: 1, max: 25 },

    // When true, a matured account is moved into the Account Pool by the
    // runner using the same helper the manual button calls. Off by default:
    // graduation should be something you turn on deliberately.
    autoGraduate: { type: Boolean, default: false },

    // Plan-only mode. The runner picks channels, computes schedules and writes
    // the timeline exactly as it would live, but fires no Twitch requests.
    // This is how you watch the flow before letting it touch anything.
    dryRun: { type: Boolean, default: true },
  },
  { _id: false },
);

const stashSetSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    // Lowercased mirror for case-insensitive uniqueness (no two sets named
    // "Prime" / "prime").
    nameLower: { type: String, required: true, unique: true, index: true },
    note: { type: String, default: "" },

    aging: { type: agingPolicySchema, default: () => ({}) },
  },
  { timestamps: true },
);

module.exports = mongoose.model("StashSet", stashSetSchema);
