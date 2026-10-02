// Tiny JSON-backed settings store for small site-wide flags (currently just the
// "require two-factor for all admins" switch). Kept separate from admins.json so
// toggling a setting never rewrites credential data.
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

// SETTINGS_FILE is for tests only (tests/settingsSafeWrite.test.js runs the
// store against a temp dir); production never sets it.
const settingsFile = process.env.SETTINGS_FILE
  ? path.resolve(process.env.SETTINGS_FILE)
  : path.join(__dirname, "settings.json");

const AUTO_FARM_DEFAULTS = {
  enabled: false, // master switch — ships OFF
  dryRun: true, // plan + alert only until the owner flips this off
  hostId: "", // which host auto-bots run on (empty = auto-pick first SSH host, i.e. the Pi)
  maxPerGame: 30, // hard cap of accounts spent on one game (user requirement)
  accountsPerBot: 10, // accounts per container
  poolReserve: 20, // never draw the pool below this many ready accounts
  pristineReserve: 150, // pristine pool accounts farms must leave for rent-farm orders (0 = off)
  probeSize: 5, // batch size for unknown games (market test)
  // Cold-start probing (utils/autoFarmer.js). Ships OFF. When on, a game that
  // research scores below the demand floor is still farmed as a small probe
  // batch IF its low score comes from an UNTESTED market (≈0 rival sellers) —
  // a brand-new release nobody sells yet, not a proven dud. A game that scores
  // low WITH real sellers keeps skipping. A winning probe graduates on its own
  // (one real sale lifts it over the floor via salesBoost); a losing one is
  // torn down by the stop-loss sweep and won't re-probe until the cooldown.
  probeColdStart: false, // master switch for cold-start probing + stop-loss
  probeMaxSellers: 1, // "untested" = at most this many distinct rival sellers
  probeMaxGames: 8, // global cap on concurrent probe tasks (runaway guard)
  probeMaxDays: 30, // stop-loss: expire a probe with 0 real sales after N days
  probeCooldownDays: 90, // after a probe expires for a game, don't re-probe it for N days
  maxAutoBots: 20, // max auto containers on the host at once (total supply is
  // gated by the pool + reserve, NOT by this — raise it if the Pi can handle more)
  hostMinFreeMb: 1500, // new containers only while the host has this much MemAvailable (0 = off)
  minHoursLeft: 12, // skip campaigns ending sooner than this
  // Games that CANNOT be sold via the normal click-claim-then-sell flow
  // (Overwatch, Rainbow Six, Call of Duty): the auto-farmer must NOT farm OR
  // list them — they are handled by the standalone no-claim farming system
  // instead. These are loose keywords matched as a SUBSTRING of the normalised
  // game label (see isNoClaimGame), so "overwatch" also catches "Overwatch 2",
  // "rainbow six" catches "Tom Clancy's Rainbow Six Siege", and "call of duty"
  // catches every CoD title (e.g. "Call of Duty: Warzone", "Call of Duty: Black
  // Ops 6"). Editable from that tab.
  noClaimGames: ["overwatch", "rainbow six", "call of duty"],
  // Unclaimed-farms auto-listing (utils/unclaimedAutoList.js): auto-list and
  // auto-sell accounts from the no-claim farm + web-token farm on the same
  // marketplaces the auto-farmer uses. Ships ON per the owner's build request;
  // pause from the Unclaimed farms tab (writes unclaimedAutoListPaused).
  unclaimedAutoList: true,
  // Unclaimed-farms v3 pricing / bundles / bulk knobs (docs/UNCLAIMED-BUNDLES-
  // CONTRACT.md). Read through getUnclaimedPricing(); all live-editable.
  unclaimedPriceFloorUsd: 0.75,
  // Per-game floors keyed like noClaimGames (substring of the normalised
  // label): { "overwatch": 1.5 }. Empty = only the absolute floor applies.
  unclaimedGameFloors: {},
  unclaimedItemStepPct: 15,
  unclaimedItemCapMult: 2.5,
  unclaimedFullEventBonusPct: 25,
  // Periodic repricing of EXISTING live unclaimed rows. Ships OFF; the
  // Bundles panel has a dry-run "Reprice" button either way.
  unclaimedRepriceExisting: false,
  unclaimedRepriceDriftPct: 20,
  // Automatic campaign-scoped rebundle: every check tick, retitle any live
  // gameflip/ggsel/eldorado no-claim listing that now under-advertises (its
  // accounts farmed more items of the events it already sells), at the SAME
  // price, with a 1-hour per-listing cooldown. Kill switch — ships OFF; the
  // "Apply rebundle fixes" button in the Auto-list tab is the manual path.
  unclaimedAutoRebundle: false,
  // Gameflip "lot of N accounts" listings (utils/unclaimedLots.js). Ships OFF.
  unclaimedGameflipLots: false,
  unclaimedLotSize: 5,
  unclaimedLotDiscountPct: 10,
  // Consecutive empty inventory reads (>= 20 min apart) before a listed
  // account counts as expired — one empty read used to delist + release.
  unclaimedExpiryConfirmPasses: 2,
  // Per-game marketplace restriction for unclaimed auto-listing, keyed like
  // noClaimGames (substring of the normalised label): { "overwatch":
  // ["gameflip"] } lists Overwatch ONLY on Gameflip and leaves the other
  // accounts unlisted for manual bulk sale. Empty = every enabled market.
  unclaimedGameMarkets: {},
  // Per-game cap on auto-listed accounts (overrides the engine's default 70):
  // { "overwatch": 25 }. Accounts above the cap stay unlisted = available for
  // hand sales. 0 / missing = default cap.
  unclaimedGameCaps: {},

  // ---- Demand-driven fleet sizing (utils/farmSizing.js) --------------------
  //
  // Both farming systems used to size a game by a flat number: the auto-farmer
  // capped every game at maxPerGame*2 no matter how well it sold, and the
  // no-claim farm had no sizing at all (the operator typed the account count
  // into a form). These keys turn on a coverage model instead — a game that
  // sells N a week is sized to hold N * coverageDays/7 accounts, because a sold
  // account is CONSUMED by the buyer.
  //
  // BOTH SWITCHES SHIP OFF. With them off every number below is inert and both
  // systems behave exactly as they did before.

  // Auto-farm: replace capForGame's flat `maxPerGame * 2` ceiling with the
  // coverage target. The old cap becomes the FLOOR, so turning this on can only
  // ever raise a game's ceiling, never lower it.
  coverageSizing: false,
  // Days of demand to keep on the shelf. 28 = four weeks (operator's choice
  // 2026-09-08). Drop inventory is time-sensitive, so a long cover buys
  // availability at the risk of holding stock that goes stale.
  coverageDays: 28,
  // Flat buffer on top of the computed cover, so a game that sells slowly but
  // reliably keeps a few units on the shelf instead of rounding to nothing.
  coverageSafetyStock: 6,
  // Absolute ceiling the coverage model may ask for, per game. A blast-radius
  // limit, not a business one: a corrupted sales count must not be able to
  // drain the pool into a single game.
  coverageMaxPerGame: 250,
  // Per-game hard overrides on the auto-farm ceiling, keyed like noClaimGames
  // (substring of the normalised label): { "rocket league": 120 }. An override
  // WINS over both the legacy cap and the coverage model, in either direction —
  // it is the operator saying "this many, I mean it". 0 / missing = automatic.
  gameAccountCaps: {},

  // No-claim farm: the fleet allocator (utils/unclaimedAllocator.js). OFF ships
  // the whole thing in advisory mode — it computes and displays a plan and does
  // nothing else. Turning it on lets the scheduler create and top up no-claim
  // bots to close the gap on its own.
  noclaimAutoSize: false,
  // How often the allocator acts when noclaimAutoSize is on (minutes).
  noclaimSizeIntervalMin: 60,
  // The most accounts one allocator pass may claim, across all games. A rate
  // limit, so a mis-measured game cannot empty the pool in one cycle.
  noclaimSizeMaxPerRun: 60,
  noclaimMaxBots: 40, // most no-claim containers (any state) the allocator may own (0 = off)
  noclaimBurstGuard: false, // dark: one-day hand/bulk sale bursts stop reading as weekly demand
  // Per-game overrides on the no-claim target, keyed like noClaimGames:
  //   { "overwatch": { coverageDays: 21, safetyStock: 10, min: 40, max: 300 } }
  // Any field may be omitted and falls back to the global value above.
  noclaimGameSizing: {},

  // Games the auto-farmer may keep farming but must NEVER spend a FRESH pool
  // account on — World of Tanks and UFL sell too thin to be worth burning new
  // accounts. For these, the brain only ever REUSES accounts it has already
  // used for that same game: it restarts the game's existing auto-bots and,
  // when it wants more, re-claims ONLY the pool accounts it previously farmed
  // this game on (the "recycled after <game>" ones written back on retirement).
  // It never draws a brand-new account from the pool for them; if none of the
  // game's own accounts are free it simply waits (a retryable skip). Matched by
  // EXACT normalised label (see isReuseOnlyGame) — the list carries short tokens
  // like "ufl" that a substring test could catch inside an unrelated game name.
  // Editable via GET/POST /api/noclaim-farm/reuse-only-games (superadmin).
  reuseOnlyGames: ["world of tanks", "ufl"],
  // Suspended-account retirement (utils/suspendedAccounts.js). Classifying and
  // releasing runs every tick and is reversible, so it has no switch; the
  // permanent delete does, and ships OFF. Turning it on removes every account
  // Twitch has deleted that is unsold and not on a listing, plus its drop rows.
  purgeSuspended: false,
  // Cap on how many bad-token accounts are re-probed per tick (0 = all). A first
  // sweep faces thousands of rows; a cap spreads them over several ticks.
  suspendCheckLimit: 0,
  // Take SOLD accounts whose Twitch token died out of their bot configs each
  // tick (utils/deadTokenRetire.js). A token that dies after the sale is the
  // buyer securing the account, so re-auth is impossible; the entry only makes
  // its bot retry a dead login. Rows, drops and sales are kept; unsold dead
  // accounts are left in place for re-auth. Ships OFF.
  retireSoldDeadTokens: false,
  // How long the token must have been dead, and re-confirmed by a later scan,
  // before a sold account is retired (clamped 24..720).
  deadTokenRetireHours: 48,
  // Multi-market auto-listing categories.
  // Plati (Digiseller) cataloguer placement for Twitch-drop accounts:
  //   Digital Goods and Access > Services and social networks > Twitch,
  //   with the required "Content type" attribute = "Twitch Drops Accounts".
  //   Category 34187 + attribute 91328->183570 lands products in the
  //   plati.market storefront section 203508 (verified live 2026-07-28).
  //   GOTCHA: 203508 is the STOREFRONT section id, NOT a cataloguer id — the
  //   create API rejects it ("category 203508 does not exist"). The cataloguer
  //   id is 34187 and it REQUIRES the Content-type attribute below, or the
  //   create fails "marketplace-1: you can not add goods".
  // GGSel picks per game automatically; this is only a manual override.
  platiCategoryId: "34187",
  platiAttributes: [{ attributeId: 91328, attributeValueId: 183570 }],
  // Plati (Digiseller) on/off for every AUTOMATIC lister — the auto-farm
  // lister, the no-claim auto-lister, the guardian's auto-feed and the
  // no-claim top-up. OFF = no new product and no new account goes to Plati;
  // listings already there are left exactly as they are. A blank category
  // above can never turn Plati off (it falls back to the default), so this is
  // the switch. Set false on prod 2026-09-28 while the seller account is
  // blocked ("продавец товара заблокирован"): nothing listed there can sell.
  // A blocked seller also stops new listings on its own (marketplaces.js
  // digisellerTakesNewStock), whatever this says. The DEFAULT is off since
  // 2026-10-03: a settings file that loses the key (or a fresh install) must
  // not quietly start feeding a blocked market again.
  platiEnabled: false,
  ggselCategoryId: "",
  // GGSel on/off for every AUTOMATIC lister — same reach and meaning as
  // platiEnabled above: OFF = no new offer and no new product goes to GGSel;
  // offers already there are left as they are. Set false on prod 2026-09-28:
  // the owner took Plati and GGSel out ("use the accounts on the others, we
  // will renovate there later").
  ggselEnabled: true,
  // ZeusX auto-listing. Off unless the owner turns it on; a game only
  // lists when zeusxGames has its category, e.g.
  //   { overwatch: { serviceCategoryId: "1", serviceCategoryBaseId: "269" } }
  zeusxAuto: false,
  zeusxGames: {},
  // Deliver ZeusX sales automatically (native "Automatic" delivery: the account
  // credential rides on the offer and ZeusX hands it to the buyer the instant
  // they pay). ZeusX only carries ONE credential per offer, so each farmed
  // account becomes its own single-stock listing. OFF => the legacy behaviour:
  // one "Coordinated" offer for the whole share, handed over by hand and marked
  // sold from the Drop Archive. Only matters when zeusxAuto is also on.
  zeusxAutoDeliver: false,

  // --- Eldorado.gg (utils/marketplaces.js + utils/eldoradoFulfiller.js) ---
  // Publishes farmed bundles into Eldorado's native "Twitch Drops" category
  // (gameId 235 / CustomItem) as ONE offer whose quantity is the account count.
  // OFF by default.
  eldoradoAuto: false,
  // Auto-delivery. Eldorado has no credential vault for this category, so the
  // fulfiller posts the login into the order's TalkJS chat and then marks the
  // order delivered. Only matters when eldoradoAuto is also on.
  eldoradoAutoDeliver: false,
  // Safety valve for the delivery bot: when true it does everything except
  // actually send the message and mark the order delivered, and logs what it
  // WOULD have sent. Leave true until a live order has been watched end to end.
  eldoradoDeliverDryRun: true,

  // --- PlayerAuctions (utils/marketplaces.js + utils/playerauctionsFulfiller.js) ---
  // Publishes farmed bundles as PlayerAuctions "Item" offers, one offer per
  // event wave per game, totalUnit = the account count. OFF by default.
  playerauctionsAuto: false,
  // Auto-delivery. PlayerAuctions has no credential vault for Item offers
  // (deliveryMethod is "Face to Face"), so the fulfiller posts the login into
  // the order's message thread and then confirms delivery with a generated
  // proof image. Only matters when playerauctionsAuto is also on.
  playerauctionsAutoDeliver: false,
  // Safety valve: when true the fulfiller does everything except send the
  // message and confirm delivery, and logs what it WOULD have sent. Leave true
  // until a live order has been watched end to end.
  playerauctionsDeliverDryRun: true,
  // Keep each offer's advertised totalUnit in step with stock we can actually
  // ship. PlayerAuctions penalises late/failed delivery directly, so overselling
  // is more expensive here than on other marketplaces.
  playerauctionsSyncStock: true,

  // --- G2G (utils/marketplaces.js + utils/g2gFulfiller.js) ---
  // Publishes farmed bundles into G2G's Game Items category as ONE offer whose
  // actual_qty is the account count. OFF by default.
  g2gAuto: false,
  // Auto-delivery. G2G's credential vault is a Game Accounts feature and is
  // closed to Game Items, so the fulfiller drives G2G's manual-delivery state
  // machine itself (start_deliver -> mark_as_delivering -> delivered_qty) and
  // hands the credential over in buyer chat, which is SendBird. Sending needs
  // the optional @sendbird/chat SDK; without it the fulfiller pushes the
  // rendered credential to the operator on Telegram and waits, rather than
  // telling G2G an order shipped when it has not. INDEPENDENT of g2gAuto — the
  // 78 offers already on the account were made by hand and still need
  // delivering.
  g2gAutoDeliver: false,
  // Safety valve: when true the fulfiller does everything except touch the
  // order and hand the credential over, and logs what it WOULD have done. Leave
  // true until a live order has been watched end to end.
  g2gDeliverDryRun: true,
  // Keep each offer's actual_qty in step with stock we can actually ship. G2G
  // reserves against actual_qty during checkout, so a stale count sells
  // accounts that are already gone.
  g2gSyncStock: true,
  // RAM saver (Raspberry Pi): pack new accounts into free seats of already-
  // running auto-bots (per-account FavouriteGames) before creating another
  // container, and delete a bot's container+compose service once its campaign
  // ends and no other task shares it (config is renamed, never deleted, so
  // tokens survive; accounts return to the pool for the next event).
  consolidate: true,
  deleteFinishedBots: true,
  // Park a running bot once every one of its accounts has finished its
  // ASSIGNED games (utils/farmCompletion.js), instead of waiting for the
  // campaign to expire — accounts finish drops in hours but campaigns run for
  // weeks, so the container idles fully paid-for in between. Measured on prod
  // 2026-07-29: 15 of 35 running containers were in exactly that state, about
  // 2 GB of RAM held by bots with nothing left to do.
  //
  // ON by default. The verdict is deliberately hard to obtain — it refuses
  // while any account is unscanned, stale (>6h), still working or not yet
  // started, when the config names no games at all, and when a campaign for one
  // of its games started after the scan the verdict rests on. Waking is NOT
  // gated by this and always runs — see utils/botWaker.js.
  stopFinishedBots: true,
  // Stock floor: keep at least this many sellable accounts per ENABLED market
  // (gameflip + plati + ggsel). The planner doubles it so the 50% post-event
  // holdback stays intact. 3 markets x 3 x 2 = 18 accounts on a full-market
  // game - the pool (180+ ready) supports this comfortably.
  perMarketStock: 3,
  // Auto-farm EVENT bundles (utils/autoFarmBundles.js): a game's campaigns are
  // waves of an event ("CAH Championship Week 1" then "Finals"), and the
  // accounts that farmed several waves hold the whole event. When on, the
  // stacked-bundle sweep sells that event as ONE complete bundle — titled with
  // its event and waves, priced by the shared pricing engine with the
  // full-event bonus and a sold floor — instead of the older blind union of
  // every campaign the game ever ran. ON by default: the union it replaces was
  // almost always refused by the holdings gate ("no free account holds the full
  // stack"), so this is a strictly better use of the same sweep. Turn it OFF to
  // get exactly the previous behaviour back.
  // See docs/AUTOFARM-BUNDLES-CONTRACT.md.
  autoFarmEventBundles: true,
  // Recycle sold-out accounts back into farming. OFF by default (opt-in): a
  // sold account's login:password is in the buyer's hands, so it is only reused
  // once it is fully spent, every drop the buyer bought is connected, the
  // cooldown has passed AND a fresh rescan confirms the token still works (a
  // buyer who changed the password fails the rescan and is skipped, never
  // recycled). See utils/recycleEligibility.js + recycleSoldOutAccounts.
  recycleSoldAccounts: false,
  recycleCooldownDays: 14,
  // Reap dead-token accounts out of a task's assignedAccounts each tick so the
  // backfill sweep can refill the freed slots with healthy farmers (a dead
  // token can't farm, so left in place it silently pins the task at target and
  // it stops producing sellable stock). Only accounts holding NO drops for the
  // task's game are unassigned; ones that already farmed drops are kept and the
  // owner is nudged by Telegram to re-mint their token. Never deletes anything.
  // ON by default. See reapDeadTokenAssignments in utils/autoFarmer.js.
  reapDeadAssignments: true,
  // Stream Scout (utils/streamScout.js): gate bot wake/park on whether a
  // qualifying stream is actually LIVE right now, not just the campaign
  // calendar. Ships OFF. When on, a campaign whose game matches a
  // streamGatedGames key is only farmed while one of its allowed channels is
  // live — and the allow-list comes from the campaign's OWN ACL, so the signal
  // matches exactly what the .NET bot watches (confirmed: it self-steers to
  // campaign.Allow.Channels — see docs/STREAM-SCOUT-PLAN.md §13a). Fail toward
  // farming everywhere: any uncertainty (Scout down/stale, no ACL) is treated
  // as watchable, so a missing signal never blocks a wake or forces a park.
  streamGate: false,
  // Which games to gate. Keyed by a keyword matched as a SUBSTRING of the
  // normalised game label (exactly like noClaimGames): { "rainbow six": {} }
  // opts the game in and gates on the campaign's real ACL channels. Add
  // { "channels": ["login", ...] } to force an explicit channel list instead of
  // (or in addition to) the ACL. An EMPTY map means nothing is gated — zero
  // behaviour change even with streamGate on.
  streamGatedGames: {},
  // Verify-earned before park: make the "finished" verdict require that each
  // account actually HOLDS a drop for every one of its assigned games (checked
  // against DropLog by game), not just that it earned SOME drop globally
  // (rec.dropCount) — the correctness hole where a bot that never farmed its
  // assigned game (e.g. no stream was ever live) could still be parked as
  // "finished". Ships OFF: with it off the verdict is exactly as before. When
  // on, the park bar is strictly higher, so the only failure direction is
  // keeping a truly-finished bot up a bit longer (safe) — never stranding one.
  // See docs/STREAM-SCOUT-PLAN.md §9 Phase 3 and utils/farmCompletion.js.
  verifyEarnedBeforePark: false,
  // Idle-no-campaign park (utils/botWaker.js parkIdleNoCampaignBots): park a
  // RUNNING bot whose assigned games have NO active drop campaign at all — it
  // has literally nothing to farm, so it is pure idle RAM. This is distinct from
  // stopFinishedBots (which needs a FINISHED verdict and refuses to touch a
  // never-started bot) and from the stream gate (which needs an active-but-dark
  // campaign): it is the "deployed, nothing to farm" case, e.g. 50 fresh Rocket
  // League accounts sitting idle after the RL campaign ended. Wakes via the
  // normal new-campaign trigger. Ships OFF. Campaign presence is matched
  // INCLUSIVELY (bidirectional substring, e.g. config "overwatch" ↔ campaign
  // "Overwatch 2") so a farming bot is never mistaken for idle; no-claim games
  // are excluded (they are owned by the no-claim system and wakeFinishedBots
  // won't wake them). Fail toward farming: any uncertainty keeps the bot up.
  parkIdleNoCampaignBots: false,
  // No-claim auto power (utils/noclaimWatcher.js): the RAM-saving equivalent of
  // the Stream Scout, but for the STANDALONE no-claim system's own containers
  // (noclaim-bot-* on the Pi) rather than the managed bots. When on, it starts
  // a game's no-claim bots only while a qualifying stream for that game (OW /
  // R6) is actually live, and stops them (docker stop) during broadcast gaps or
  // when the game has no active campaign at all — the biggest RAM win, since OW
  // is dark most of the time. Which games it manages = noClaimGames (shared).
  // Ships OFF: zero container activity until flipped on. Fail toward farming
  // everywhere (any Twitch/catalog uncertainty keeps the bots up), stops only
  // after a confident-dark hysteresis window, and it only auto-starts a bot it
  // itself stopped (an operator Stop stays stopped) — so it never fights manual
  // control. See utils/noclaimWatcher.js.
  noClaimStreamGate: false,
  // Master switch for the AI coworker's AUTONOMOUS actions (utils/coworkerActs.js).
  // OFF by default: while false the coworker executes nothing itself and can only
  // investigate and propose, exactly as before. Turning it on lets it perform the
  // "auto"-tier capabilities (reversible, blast-radius-capped, fully audited);
  // "confirm"-tier work always still goes through operator approval.
  coworkerAutonomy: false,
  // Master switch for the new lane engine (utils/farm2/*), the reorganised
  // farm + list pipeline that replaces the legacy single-tick autoFarmer for
  // the games it owns. OFF by default, so a deploy changes nothing: with it
  // false the engine runs no cycles and utils/farm2/ownership.js reports that
  // farm2 owns no game, leaving utils/autoFarmer.js in charge of everything
  // exactly as before. Turning it on only activates the lanes that exist in
  // the FarmLane collection, and only a lane in mode "live" takes a game away
  // from the legacy engine — a "shadow" lane just observes and compares.
  farm2Enabled: false,
  // The lane engine is the MAIN engine: the supervisor creates a live lane for
  // every game with a live campaign, so the legacy engine's per-campaign
  // decision path decides nothing and its tick runs only the fleet-wide
  // maintenance sweeps (completion, backfill, park/wake, reaping, recycling,
  // repack, refill, stacked bundles). Requires farm2Enabled. OFF by default;
  // flipped from the Auto farm engine page once the lanes have been trusted.
  farm2Main: false,

  // --- Public catalog v2 (routes/catalogRoutes.js + public/catalog.html) ---
  // Storefront contact shown to catalog visitors (footer + the quote dialog's
  // "Message on Telegram" button) and the preorder re-stamp cadence. Read
  // through getCatalogConfig(), written ONLY through setCatalogConfig() from
  // the catalog admin page (PUT /catalog/admin/config); all live-editable.
  // Frozen shape: docs/CATALOG-V2-CONTRACT.md §6.
  catalogContactTelegram: "", // public handle, no leading @ (empty = no link)
  catalogContactDiscord: "", // Discord handle or invite (empty = hidden)
  catalogReplyTime: "within a few hours", // quote-dialog reply-time promise
  // How often the preorder sync loop re-stamps farm2 preorder sets with their
  // task's accounts + the campaign's watch minutes, so a new pre-order card
  // gets its ETA within minutes instead of the 6-hour variant sync. 0 = off.
  catalogPreorderSyncMinutes: 10,

  // --- Bulk packs (utils/bulkPacks/*, docs/bulk-packs/CONTRACT.md §6) ---
  // A separate subsystem that PROPOSES bulk offers — N+ accounts at a tier
  // discount — and publishes one only when the owner clicks Send; its loop
  // then looks after the live offers. Read ONLY through getBulkPacks(), which
  // clamps every value below.
  //
  // SHIPS DARK. While bulkPacksEnabled is false, send / refill / resume are
  // refused and the loop only does safety maintenance on offers that already
  // exist (reconcile, sold / expired detection, pausing, releasing).
  bulkPacksEnabled: false,
  // Markets a bulk offer may go to (subset of eldorado / g2g / gameflip).
  // Plati/Digiseller and GGSel are not bulk-pack markets at all — owner block
  // since 2026-09-28 — and getBulkPacks drops them whatever is stored here.
  bulkPacksMarkets: ["eldorado", "g2g", "gameflip"],
  // Quantity tiers. On eldorado/g2g one unit is ALWAYS one account and the tier
  // is the offer's minimum order; on gameflip one listing is one pack of
  // exactly minQty accounts. No multiplier anywhere (CONTRACT §2).
  bulkPackTiers: [
    { minQty: 5, discountPct: 5 },
    { minQty: 10, discountPct: 10 },
  ],
  // Free accounts per bundle always kept back for the ordinary single listings.
  bulkPackReserveSingles: 5,
  // Default accounts reserved behind one eldorado/g2g account offer.
  bulkPackUnitsPerOffer: 20,
  // Farming packs: price per account (USD) by market and term in days.
  bulkFarmPrices: {
    eldorado: { "120": 3, "180": 4, "365": 7 },
    g2g: { "120": 3, "180": 4, "365": 7 },
  },
  // Farming terms (days) the bundler proposes.
  bulkFarmDurations: [120, 180, 365],
  // Bot slots and pristine pool accounts a farming offer never advertises —
  // kept for single farm orders.
  bulkFarmReserveSlots: 20,
  bulkFarmReservePristine: 20,
  // The most accounts one farming offer advertises.
  bulkFarmMaxQty: 20,
  // Maintenance loop interval, and how often a farming offer's advertised
  // quantity is re-checked against live capacity (minutes).
  bulkPacksLoopMinutes: 5,
  bulkFarmSyncMinutes: 15,
};

// ---------------------------------------------------------------------------
// Account listings (docs/ACCOUNT-LISTINGS-CONTRACT.md §B8)
// ---------------------------------------------------------------------------
// TOP LEVEL, deliberately NOT inside autoFarm: an account listing's stock is an
// explicit list of accounts the owner pasted in, not farmed stock, so it must
// not be reachable from the Auto-farm tab's patch surface — a setAutoFarm write
// must never be able to switch owner-supplied delivery on or off as a side
// effect. Read through getAccountListingSettings().
const ACCOUNT_LISTING_DEFAULTS = {
  enabled: true, // the tab + routes
  autoDeliver: true, // global kill switch over every offer's own toggle
  lowStockWarnAt: 2, // Telegram warning when an offer drops to this
};

// ---------------------------------------------------------------------------
// No-claim Shop listings (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §1e)
// ---------------------------------------------------------------------------
// TOP LEVEL, deliberately NOT inside autoFarm, for the same reason as
// accountListings above: these switches gate the owner's hand-made no-claim
// listings and a paid buyer's delivery, so a setAutoFarm write from the
// Auto-farm tab must never be able to flip them as a side effect — even though
// the stock is the no-claim farm. Read through getNoclaimShopSettings().
const NOCLAIM_SHOP_DEFAULTS = {
  enabled: true, // routes, UI, publishing, the lifecycle pass
  autoDeliver: true, // kill switch over every no-claim claim
  sweep: true, // background holding sweep
  sweepPerTick: 30, // live inventory reads per sweep tick (1..200)
  sweepEveryMin: 10, // (2..240)
  maxAgeHours: 8, // snapshot older than this is "stale" (1..72)
  refreshBudget: 120, // reads for an on-demand refresh (1..400)
  topUp: true, // refill GGSel/Plati rows back to their quantity
  healthPerPass: 20, // live re-checks of committed vault units per pass (0..100)
  passEveryMin: 10, // lifecycle pass interval (2..120)
};

// Epic auto-claim (utils/epicAutoClaim.js). Ships OFF by default; when the
// operator flips `enabled`, the Epic claimer will try the direct-API checkout
// for every missing (account, freebie) pair before falling back to the current
// Telegram tap-link. captchaKey is stored encrypted via secretBox; if it's
// blank the auto path still handles claims Talon doesn't gate (which is
// most of the time for warm accounts on quiet weeks).
const EPIC_AUTO_CLAIM_DEFAULTS = {
  enabled: false,
  captchaProvider: "", // "" = auto-detect from key ("2captcha" or "capsolver")
  captchaKey: "", // encrypted at rest via secretBox
  perAccountCooldownH: 24,
  dailyCap: 5,
};

const DEFAULTS = {
  require2fa: false,
  autoFarm: AUTO_FARM_DEFAULTS,
  accountListings: ACCOUNT_LISTING_DEFAULTS,
  noclaimShop: NOCLAIM_SHOP_DEFAULTS,
  epicAutoClaim: EPIC_AUTO_CLAIM_DEFAULTS,
};

// ---------------------------------------------------------------------------
// The settings file: saves that cannot tear or wipe (docs/LIVE-FIXES-1003.md A1)
// ---------------------------------------------------------------------------
// Until 2026-10-03 every save wrote "settings.json.tmp-<pid>" and renamed it,
// rewriting the WHOLE file from the caller's copy. Two saves in one process —
// a G2G/ZeusX/Eldorado token refresh landing during an operator's toggle, the
// allocator's shelf caps — shared that one temp file and could install a torn
// settings.json, or the later save silently undid the earlier one. loadSettings
// answered a parse error with DEFAULTS, and the next save wrote those defaults
// back: every marketplace credential gone and every switch at its default.
//
// Since 2026-10-03:
//   - saves run one at a time, in call order (one promise chain); a failed
//     save rejects its own caller and never blocks the next one;
//   - saveSettings(s) re-reads the CURRENT file and applies only what its
//     caller changed since the loadSettings() that produced `s` (a three-way
//     merge), so writers that loaded the same file all land; the setters in
//     this file edit the current file directly, inside the chain;
//   - every write goes to its own temp file (pid + counter + random), is
//     fsync'd and renamed over the target; on any error the temp is removed;
//   - the last text that parsed is kept in memory and every save refreshes
//     settings.json.bak. An unreadable file is served from the memory copy,
//     then the .bak, and only then from DEFAULTS (logged). A save never writes
//     over an unreadable file without one of those good copies to build on
//     (SETTINGS_CORRUPT), and before it does, the unreadable bytes are kept as
//     settings.json.bak-corrupt-<time>: they may be a hand edit with a typo.
const backupFile = settingsFile + ".bak";
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const noop = () => {};

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Set a key without ever running the __proto__ setter: JSON.parse makes
// "__proto__" an ordinary own key, and a merge must carry it as one.
function put(o, k, v) {
  if (k === "__proto__")
    Object.defineProperty(o, k, {
      value: v,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  else o[k] = v;
}

// Each DEFAULTS block as JSON, taken once. Every object handed out gets its
// own copy, so a caller editing s.autoFarm in place can never change the
// defaults for the rest of the process, and a merge base rebuilt from text at
// save time is exactly the object loadSettings handed out.
const DEFAULT_KEYS = Object.keys(DEFAULTS);
const DEFAULT_TEXT = {};
for (const k of DEFAULT_KEYS) DEFAULT_TEXT[k] = JSON.stringify(DEFAULTS[k]);
function freshDefault(k) {
  return JSON.parse(DEFAULT_TEXT[k]);
}

// What a parsed file stands for: { ...DEFAULTS, ...file }, in that key order.
function materialize(obj) {
  const out = {};
  for (const k of DEFAULT_KEYS)
    out[k] = hasOwn(obj, k) ? obj[k] : freshDefault(k);
  for (const k of Object.keys(obj)) if (!hasOwn(out, k)) put(out, k, obj[k]);
  return out;
}

// Throws unless the text is a JSON object. A leading BOM (an editor's hand
// edit) is not corruption; an empty or truncated file is.
function parseSettingsText(text) {
  const obj = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (!isPlainObject(obj)) throw new SyntaxError("not a JSON object");
  return obj;
}

// Object loadSettings handed out -> the text it was parsed from, or
// FROM_DEFAULTS when it was built from DEFAULTS alone: its next save's base.
const bases = new WeakMap();
const FROM_DEFAULTS = Symbol("settings:defaults");
let lastGoodText = null; // the last settings text that parsed, read or written here
let saveChain = Promise.resolve();
let tmpSeq = 0;

function remember(obj, base) {
  bases.set(obj, base);
  return obj;
}

function why(err) {
  return String((err && (err.code || err.message)) || "unknown error").slice(0, 200);
}

// One console line per kind per minute, plus a SystemEvent when `meta` is
// given: loadSettings runs on every settings read, so an unreadable file would
// otherwise flood both. systemLog is required lazily and best-effort —
// settings.js loads before everything, and a log must never break a read.
const reportedAt = new Map();
function report(kind, message, meta) {
  const now = Date.now();
  if (now - (reportedAt.get(kind) || 0) < 60 * 1000) return;
  reportedAt.set(kind, now);
  try {
    console.error("[settings] " + message);
  } catch {
    /* ignore */
  }
  if (!meta) return;
  try {
    const p = require("./systemLog").logEvent({
      category: "settings",
      action: "settings_corrupt",
      severity: meta.served === "last-good" || meta.served === "bak" ? "warn" : "error",
      subject: path.basename(settingsFile),
      detail: message,
      meta,
    });
    if (p && typeof p.catch === "function") p.catch(noop);
  } catch {
    /* ignore */
  }
}

function reportUnreadable(served, err) {
  const head = `settings.json is unreadable (${why(err)})`;
  const tail = {
    "last-good": ": serving the last good copy held in memory; the next save rewrites the file from it",
    bak: ": serving settings.json.bak; the next save rewrites the file from it",
    defaults:
      " and there is no good copy (none in memory, no readable settings.json.bak): " +
      "serving DEFAULTS, and every save is refused until the file is restored by hand",
  };
  report(served, head + tail[served], { served, error: why(err) });
}

function readBackupSync() {
  try {
    const text = fs.readFileSync(backupFile, "utf8");
    return { text, obj: parseSettingsText(text) };
  } catch {
    return null;
  }
}

async function readBackup() {
  try {
    const text = await fsp.readFile(backupFile, "utf8");
    return { text, obj: parseSettingsText(text) };
  } catch {
    return null;
  }
}

function loadSettings() {
  let failure;
  try {
    const text = fs.readFileSync(settingsFile, "utf8");
    const obj = parseSettingsText(text);
    lastGoodText = text;
    return remember(materialize(obj), text);
  } catch (e) {
    failure = e;
  }
  if (lastGoodText !== null) {
    reportUnreadable("last-good", failure);
    return remember(materialize(parseSettingsText(lastGoodText)), lastGoodText);
  }
  const bak = readBackupSync();
  if (bak) {
    reportUnreadable("bak", failure);
    return remember(materialize(bak.obj), bak.text);
  }
  // No good copy anywhere. A MISSING file is a fresh install (silent); any
  // other failure is a corrupt file, and saveSettings refuses to replace it.
  if (!failure || failure.code !== "ENOENT") reportUnreadable("defaults", failure);
  return remember(materialize({}), FROM_DEFAULTS);
}

// The CURRENT settings a save builds on, materialized, read inside the chain.
// `unreadable` = the bytes of a file that exists but does not parse; commit()
// keeps them before it writes over them.
async function readCurrent() {
  let failure;
  let text = null;
  try {
    text = await fsp.readFile(settingsFile, "utf8");
    const obj = parseSettingsText(text);
    lastGoodText = text;
    return { current: materialize(obj), unreadable: null };
  } catch (e) {
    failure = e;
  }
  if (lastGoodText !== null) {
    reportUnreadable("last-good", failure);
    return {
      current: materialize(parseSettingsText(lastGoodText)),
      unreadable: text,
    };
  }
  const bak = await readBackup();
  if (bak) {
    reportUnreadable("bak", failure);
    return { current: materialize(bak.obj), unreadable: text };
  }
  if (failure && failure.code === "ENOENT")
    return { current: materialize({}), unreadable: null }; // fresh install
  // The file is there but unreadable, and nothing good is left to rebuild it
  // from: writing now would replace it with DEFAULTS — the credential wipe this
  // section exists to stop.
  const msg =
    `settings.json is unreadable (${why(failure)}) and there is no good copy ` +
    "to rebuild it from, so nothing was saved (saving would replace it with " +
    "defaults). Restore utils/settings.json from a backup or fix it by hand.";
  report("refused", "save refused: " + msg, {
    served: "none",
    refusedSave: true,
    error: why(failure),
  });
  const err = new Error(msg);
  err.code = "SETTINGS_CORRUPT";
  throw err;
}

// Write `text` to `file` atomically: a temp file of our own (pid + counter +
// random, created exclusively), fsync'd, then renamed over the target. On any
// error the temp file is removed and the target is left as it was.
async function writeAtomic(file, text) {
  const rand = crypto.randomBytes(4).toString("hex");
  const tmp = `${file}.tmp-${process.pid}-${++tmpSeq}-${rand}`;
  let fh = null;
  let created = false;
  try {
    fh = await fsp.open(tmp, "wx");
    created = true;
    await fh.writeFile(text, "utf8");
    await fh.sync();
    const h = fh;
    fh = null;
    await h.close();
    await fsp.rename(tmp, file);
  } catch (err) {
    if (fh) await fh.close().catch(noop);
    if (created) await fsp.unlink(tmp).catch(noop);
    throw err;
  }
}

// Once per distinct unreadable content: a save that keeps failing after this
// (a full disk) must not leave a new copy behind on every retry.
let keptText = null;
async function keepUnreadable(text) {
  if (!text || text === keptText) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${settingsFile}.bak-corrupt-${stamp}`;
  try {
    await fsp.writeFile(file, text, { flag: "wx" });
    keptText = text;
    console.error(`[settings] kept the unreadable settings.json as ${file}`);
  } catch (e) {
    console.error(
      `[settings] could not keep the unreadable settings.json (${why(e)}); rebuilding it anyway`,
    );
  }
}

// Write a whole settings object (DEFAULTS filled in, as before), then refresh
// the in-memory good copy and settings.json.bak. A .bak that cannot be written
// is logged, never thrown: the save itself landed.
async function commit(next, unreadable) {
  const text = JSON.stringify(materialize(next), null, 2);
  await keepUnreadable(unreadable);
  await writeAtomic(settingsFile, text);
  lastGoodText = text;
  try {
    await writeAtomic(backupFile, text);
  } catch (e) {
    report("bak-write", `could not refresh settings.json.bak (${why(e)}); the save itself landed`);
  }
}

// Deep equality of two JSON values; object key order is ignored.
function jsonEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
    return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (!hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
  return true;
}

// Three-way merge of JSON values: apply OUR edits (ours − base) onto THEIRS
// (the file as it is now). Plain objects merge key by key, recursively; an
// array or a scalar is one leaf, and if ours differs from base, ours replaces
// it whole. A key in base that ours lacks is our deletion. `base` undefined =
// the key did not exist when we loaded it, so two writers that both added it
// (two credentials saved into a fresh `marketplaces`) keep both sides' keys.
function merge3(base, ours, theirs) {
  if (base !== undefined && jsonEqual(ours, base)) return theirs; // untouched
  if (
    !isPlainObject(ours) ||
    !isPlainObject(theirs) ||
    (base !== undefined && !isPlainObject(base))
  )
    return ours;
  const b = base === undefined ? {} : base;
  const out = { ...theirs };
  for (const k of Object.keys(b)) if (!hasOwn(ours, k)) delete out[k];
  for (const k of Object.keys(ours)) {
    const inBase = hasOwn(b, k);
    if (hasOwn(theirs, k)) put(out, k, merge3(inBase ? b[k] : undefined, ours[k], theirs[k]));
    // Gone from the file since we loaded it: it stays gone unless we changed it.
    else if (!inBase || !jsonEqual(ours[k], b[k])) put(out, k, ours[k]);
  }
  return out;
}

function baseObject(ref) {
  return ref === FROM_DEFAULTS ? materialize({}) : materialize(parseSettingsText(ref));
}

// Saves run one at a time, in call order. The chain never rejects, so a
// failed save rejects only its own caller.
function enqueue(job) {
  const run = saveChain.then(job);
  saveChain = run.then(noop, noop);
  return run;
}

async function saveSettings(settings) {
  // The old `{ ...DEFAULTS, ...settings }` turned a null or undefined into a
  // file of pure defaults — a wipe. Refuse anything that is not an object.
  const oursText = isPlainObject(settings) ? JSON.stringify(settings) : undefined;
  // Snapshot NOW, as the old synchronous stringify did: whatever the caller
  // does to its object after this call cannot change what this save writes.
  const parsed = oursText === undefined ? null : JSON.parse(oursText);
  if (!isPlainObject(parsed))
    throw new TypeError(
      "saveSettings needs a settings object, got " +
        (settings === null ? "null" : Array.isArray(settings) ? "an array" : typeof settings),
    );
  // DEFAULTS filled in, exactly as it will be written: a DEFAULTS block the
  // object never carried is "the default", not a deletion that would reset
  // another writer's change to it.
  const ours = materialize(parsed);
  return enqueue(async () => {
    const { current, unreadable } = await readCurrent();
    // An object loadSettings did not hand out has no known base, so it is
    // written whole, as before.
    const base = bases.get(settings);
    const next = base === undefined ? ours : merge3(baseObject(base), ours, current);
    await commit(next, unreadable);
    // The caller's object now descends from what it just saved: saving it
    // again applies only its newer edits, never re-asserting these.
    bases.set(settings, oursText);
  });
}

// Exact read-modify-write for this file's own setters: `mutate` edits the
// CURRENT settings inside the save chain, so no merge is needed.
function updateSettings(mutate) {
  return enqueue(async () => {
    const { current, unreadable } = await readCurrent();
    mutate(current);
    await commit(current, unreadable);
  });
}

// A setter's patch as it is NOW (the old setters applied it synchronously),
// each value copied the way JSON writes it. A value JSON cannot hold
// (undefined, a function) stays undefined, which — as before — drops the key.
function snapshotPatch(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const k of Object.keys(patch)) {
    const t = JSON.stringify(patch[k]);
    put(out, k, t === undefined ? undefined : JSON.parse(t));
  }
  return out;
}

function getRequire2fa() {
  return !!loadSettings().require2fa;
}

async function setRequire2fa(value) {
  const on = !!value;
  await updateSettings((s) => {
    s.require2fa = on;
  });
  return on;
}

// autoFarm block accessors. Deep-merged over defaults so a settings.json
// written before a new knob existed still yields every field.
function getAutoFarm() {
  const s = loadSettings();
  const cur = s.autoFarm && typeof s.autoFarm === "object" ? s.autoFarm : {};
  const out = { ...AUTO_FARM_DEFAULTS, ...cur };
  // A saved empty Plati category means "use the default" — Plati's Twitch
  // drops section is fixed, so blank should never silently disable Plati.
  if (!out.platiCategoryId)
    out.platiCategoryId = AUTO_FARM_DEFAULTS.platiCategoryId;
  return out;
}

async function setAutoFarm(patch, opts = {}) {
  const p = snapshotPatch(patch);
  // Applied to the CURRENT autoFarm block inside the save chain, so two
  // setAutoFarm calls (or one racing a credential write) both land.
  let cur = {};
  let next = null;
  await updateSettings((s) => {
    cur = s.autoFarm && typeof s.autoFarm === "object" ? s.autoFarm : {};
    next = { ...freshDefault("autoFarm"), ...cur, ...p };
    s.autoFarm = next;
  });
  // Audit which settings actually changed (before→after) — this is the record
  // that was missing when purgeSuspended was found flipped with no trace of who.
  // Best-effort and lazily-required so it can never break a settings write or
  // fight module load order (settings.js is required very early).
  try {
    const changed = {};
    for (const k of Object.keys(p)) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(next[k]))
        changed[k] = { from: cur[k], to: next[k] };
    }
    if (Object.keys(changed).length) {
      require("./systemLog").logEvent({
        category: "settings",
        action: "settings_changed",
        actor: opts.actor || "system",
        subject: Object.keys(changed).join(","),
        detail: "changed: " + Object.keys(changed).join(", "),
        meta: changed,
      });
    }
  } catch (e) {
    /* never block a settings write on its audit */
  }
  return next;
}

// Normalise a game label for tolerant comparison ("Rainbow Six Siege",
// "rainbow-six siege", "RainbowSix  Siege" all collapse to the same key).
function normGameName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// True when a game is on the no-claim list — i.e. it must be excluded from the
// normal auto-farmer's farm + list paths and handled by the standalone no-claim
// farming system instead. Single source of truth for both systems. Each entry
// is a keyword matched as a SUBSTRING of the normalised label, so "rainbow six"
// catches "Tom Clancy's Rainbow Six Siege" and "overwatch" catches "Overwatch 2".
function isNoClaimGame(game) {
  const list = getAutoFarm().noClaimGames || [];
  const g = normGameName(game);
  if (!g) return false;
  return list.some((x) => {
    const key = normGameName(x);
    return key && g.includes(key);
  });
}

// True when a game is on the reuse-only list — the auto-farmer may farm it but
// ONLY by reusing accounts it has already used for that same game (its existing
// auto-bots, plus its own "recycled after <game>" pool accounts). It must never
// claim a fresh pool account for it. Single source of truth for the claim gate
// in utils/autoFarmer.js. Unlike isNoClaimGame this matches by EXACT normalised
// label, not substring: the list carries short tokens like "ufl" that a
// substring test could catch inside an unrelated game name.
function isReuseOnlyGame(game) {
  const list = getAutoFarm().reuseOnlyGames || [];
  const g = normGameName(game);
  if (!g) return false;
  return list.some((x) => normGameName(x) === g);
}

// Stream-gate master switch + the opted-in game map, read fresh each call so a
// live settings edit takes effect without a restart (the maxAutoBots pattern).
function getStreamGate() {
  const af = getAutoFarm();
  return {
    enabled: !!af.streamGate,
    games:
      af.streamGatedGames && typeof af.streamGatedGames === "object"
        ? af.streamGatedGames
        : {},
  };
}

// The gate entry for a game, or null if the game is not opted into
// stream-gating. Keyword matched as a SUBSTRING of the normalised label (like
// isNoClaimGame), so "rainbow six" catches "Tom Clancy's Rainbow Six Siege".
// The entry may carry an explicit { channels: [...] } override; an empty entry
// ({}) means "gate on the campaign's own ACL channels".
function streamGatedGameEntry(game) {
  const games = getStreamGate().games;
  const g = normGameName(game);
  if (!g) return null;
  for (const key of Object.keys(games)) {
    const k = normGameName(key);
    if (k && g.includes(k)) {
      const val = games[key];
      return val && typeof val === "object" ? val : {};
    }
  }
  return null;
}

function isStreamGatedGame(game) {
  return streamGatedGameEntry(game) != null;
}

// No-claim auto-power master switch, read fresh each call (live-editable, like
// getStreamGate). The games it manages are noClaimGames — no separate list.
function getNoClaimGate() {
  return { enabled: !!getAutoFarm().noClaimStreamGate };
}

// AI coworker autonomy master switch, read fresh each call (live-editable), so
// it can be revoked instantly without a restart if the coworker misbehaves.
// Unclaimed-farms v3 pricing/bundle/bulk knobs, read fresh each call with the
// seed defaults merged under the live values (a settings.json written before
// v3 has none of these keys). Frozen shape: docs/UNCLAIMED-BUNDLES-CONTRACT.md.
const UNCLAIMED_PRICING_DEFAULTS = {
  floorUsd: 0.75,
  // The highest price this business has EVER realised, across 217 sales, every
  // marketplace and every bundle size (min $0.75, median $1.25, max $4.50).
  // Above it a listing is not ambitious, it is unsold — a $11.75 Rainbow Six row
  // went live on 2026-09-08 because the bundle pricer had a floor and no
  // ceiling. Raise it only when a real sale proves a higher price.
  ceilingUsd: 4.5,
  gameFloors: {},
  itemStepPct: 15,
  itemCapMult: 2.5,
  fullEventBonusPct: 25,
  repriceExisting: false,
  repriceDriftPct: 20,
  lots: false,
  lotSize: 5,
  lotDiscountPct: 10,
  expiryConfirmPasses: 2,
  gameMarkets: {},
  gameCaps: {},
};
function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}
function getUnclaimedPricing() {
  const af = getAutoFarm() || {};
  const D = UNCLAIMED_PRICING_DEFAULTS;
  return {
    floorUsd: Math.max(0, num(af.unclaimedPriceFloorUsd, D.floorUsd)),
    ceilingUsd: Math.max(0, num(af.unclaimedPriceCeilingUsd, D.ceilingUsd)),
    gameFloors:
      af.unclaimedGameFloors && typeof af.unclaimedGameFloors === "object"
        ? af.unclaimedGameFloors
        : {},
    itemStepPct: Math.max(0, num(af.unclaimedItemStepPct, D.itemStepPct)),
    itemCapMult: Math.max(1, num(af.unclaimedItemCapMult, D.itemCapMult)),
    fullEventBonusPct: Math.max(0, num(af.unclaimedFullEventBonusPct, D.fullEventBonusPct)),
    repriceExisting: af.unclaimedRepriceExisting == null ? D.repriceExisting : !!af.unclaimedRepriceExisting,
    repriceDriftPct: Math.max(1, num(af.unclaimedRepriceDriftPct, D.repriceDriftPct)),
    lots: af.unclaimedGameflipLots == null ? D.lots : !!af.unclaimedGameflipLots,
    lotSize: Math.max(2, Math.floor(num(af.unclaimedLotSize, D.lotSize))),
    lotDiscountPct: Math.min(90, Math.max(0, num(af.unclaimedLotDiscountPct, D.lotDiscountPct))),
    expiryConfirmPasses: Math.max(1, Math.floor(num(af.unclaimedExpiryConfirmPasses, D.expiryConfirmPasses))),
    gameMarkets:
      af.unclaimedGameMarkets && typeof af.unclaimedGameMarkets === "object"
        ? af.unclaimedGameMarkets
        : {},
    gameCaps:
      af.unclaimedGameCaps && typeof af.unclaimedGameCaps === "object"
        ? af.unclaimedGameCaps
        : {},
  };
}

// First matching key of a substring-keyed per-game map (same rule as
// noClaimGames / gameFloorFor). Returns the value or undefined.
function gameMapLookup(map, game) {
  const g = normGameName(game);
  if (!g || !map) return undefined;
  for (const k of Object.keys(map)) {
    const key = normGameName(k);
    if (key && g.includes(key)) return map[k];
  }
  return undefined;
}

const UNCLAIMED_MARKETS = ["gameflip", "digiseller", "ggsel"];

// Marketplaces an unclaimed game may be auto-listed on, or null for "every
// enabled market" (no restriction configured).
function gameMarketsFor(game) {
  const v = gameMapLookup(getUnclaimedPricing().gameMarkets, game);
  if (!Array.isArray(v)) return null;
  const list = v
    .map((m) => String(m || "").trim().toLowerCase())
    .filter((m) => UNCLAIMED_MARKETS.includes(m));
  return list.length ? [...new Set(list)] : null;
}

// Per-game auto-list cap, or 0 for "engine default".
function gameCapFor(game) {
  const v = gameMapLookup(getUnclaimedPricing().gameCaps, game);
  const n = Math.floor(num(v, 0));
  return n > 0 ? n : 0;
}

// Per-game unclaimed price floor: the first unclaimedGameFloors key that is a
// SUBSTRING of the normalised game label (same matching rule as noClaimGames).
// 0 when no key matches.
function gameFloorFor(game) {
  const floors = getUnclaimedPricing().gameFloors || {};
  const g = normGameName(game);
  if (!g) return 0;
  for (const k of Object.keys(floors)) {
    const key = normGameName(k);
    if (key && g.includes(key)) return Math.max(0, num(floors[k], 0));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Demand-driven fleet sizing
// ---------------------------------------------------------------------------

// Typed, clamped view of the sizing keys — the same read-side convention as
// getUnclaimedPricing: engines never touch the raw `coverage*` / `noclaim*`
// keys, so a hand-edited settings.json holding a string or a negative number
// degrades to the default instead of poisoning an account count.
//
// The per-game accessors take a RAW game label and match it the noClaimGames
// way (substring of the normalised label), so one "overwatch" entry covers
// "Overwatch", "Overwatch 2" and the lowercase spellings all at once.
// `af` is optional: callers that already hold the auto-farm settings object
// (capForGame is handed one on every call) pass it in rather than making this
// re-read settings.json, which loadSettings does from disk EVERY time. It also
// makes the sizing policy a pure function of its input, so a test can hand it a
// settings object instead of writing to the live file.
function getFarmSizing(afIn) {
  const af = afIn || getAutoFarm() || {};
  const gameSizing =
    af.noclaimGameSizing && typeof af.noclaimGameSizing === "object"
      ? af.noclaimGameSizing
      : {};
  const perGame = (game, field, dflt) => {
    const entry = gameMapLookup(gameSizing, game);
    if (!entry || typeof entry !== "object") return dflt;
    const n = num(entry[field], NaN);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };

  const coverageDays = Math.max(1, num(af.coverageDays, 28));
  const safetyStock = Math.max(0, num(af.coverageSafetyStock, 6));
  const maxPerGame = Math.max(1, Math.floor(num(af.coverageMaxPerGame, 250)));

  return {
    // Auto-farm side
    enabled: af.coverageSizing == null ? false : !!af.coverageSizing,
    coverageDays,
    safetyStock,
    maxPerGame,
    gameCaps:
      af.gameAccountCaps && typeof af.gameAccountCaps === "object"
        ? af.gameAccountCaps
        : {},

    // No-claim side
    autoSize: af.noclaimAutoSize == null ? false : !!af.noclaimAutoSize,
    intervalMin: Math.max(5, Math.floor(num(af.noclaimSizeIntervalMin, 60))),
    maxPerRun: Math.max(1, Math.floor(num(af.noclaimSizeMaxPerRun, 60))),
    gameSizing,

    // Per-game accessors the demand snapshot reads. Each falls back to the
    // global value, so a partial override ({ "overwatch": { max: 300 } }) leaves
    // every other field alone.
    coverageDaysFor: (game) => perGame(game, "coverageDays", coverageDays),
    safetyStockFor: (game) => perGame(game, "safetyStock", safetyStock),
    minFor: (game) => perGame(game, "min", 0),
    maxFor: (game) => perGame(game, "max", maxPerGame),
  };
}

// Explicit per-game account ceiling for the AUTO-FARM, or 0 for "automatic".
// Unlike every other per-game map here this one overrides in BOTH directions:
// it is the operator naming a number, so it beats the legacy cap and the
// coverage model alike.
function gameAccountCapFor(game, afIn) {
  const v = gameMapLookup(getFarmSizing(afIn).gameCaps, game);
  const n = Math.floor(num(v, 0));
  return n > 0 ? n : 0;
}

// Alias kept deliberately short because the demand snapshot passes this object
// around as `cfg`; see utils/farmDemand.js unclaimedDemandSnapshot.
function getNoclaimSizing() {
  return getFarmSizing();
}

// Public catalog v2 storefront config (docs/CATALOG-V2-CONTRACT.md §6), read
// fresh each call with the seed defaults under the live values, and normalised
// on BOTH the read and the write path so the routes and the page never see a
// raw "@handle ", an over-long string or a NaN interval.
//   telegram: leading @ stripped, [A-Za-z0-9_] only, <= 64 chars
//   discord / replyTime: trimmed, <= 80 chars; an empty replyTime falls back
//     to the default
//   preorderSyncMinutes: integer clamped 0..1440 (0 = loop off); blank or
//     non-numeric = the default 10
function catalogString(v) {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}
function catalogText(v, max) {
  return catalogString(v).trim().slice(0, max).trim();
}
function catalogHandle(v) {
  return catalogString(v)
    .trim()
    .replace(/^@+/, "")
    .replace(/[^A-Za-z0-9_]/g, "")
    .slice(0, 64);
}
function catalogMinutes(v) {
  const d = AUTO_FARM_DEFAULTS.catalogPreorderSyncMinutes;
  if (v == null || (typeof v === "string" && !v.trim())) return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1440, Math.max(0, Math.floor(n))) : d;
}
function getCatalogConfig() {
  const af = getAutoFarm() || {};
  return {
    contactTelegram: catalogHandle(af.catalogContactTelegram),
    contactDiscord: catalogText(af.catalogContactDiscord, 80),
    replyTime:
      catalogText(af.catalogReplyTime, 80) || AUTO_FARM_DEFAULTS.catalogReplyTime,
    preorderSyncMinutes: catalogMinutes(af.catalogPreorderSyncMinutes),
  };
}

// Apply a storefront-config patch. Accepts the public field names the admin
// route receives (contactTelegram, contactDiscord, replyTime,
// preorderSyncMinutes) — or their catalog* settings names — and writes ONLY
// those four autoFarm keys through setAutoFarm (audited like any settings
// write; pass opts.actor for the "who did it"). Keys absent from the patch are
// left untouched, so a partial patch never resets the others. Resolves to the
// normalised getCatalogConfig().
async function setCatalogConfig(patch, opts = {}) {
  const p = patch && typeof patch === "object" ? patch : {};
  const pick = (pub, key) => (p[pub] !== undefined ? p[pub] : p[key]);
  const upd = {};
  const tg = pick("contactTelegram", "catalogContactTelegram");
  if (tg !== undefined) upd.catalogContactTelegram = catalogHandle(tg);
  const dc = pick("contactDiscord", "catalogContactDiscord");
  if (dc !== undefined) upd.catalogContactDiscord = catalogText(dc, 80);
  const rt = pick("replyTime", "catalogReplyTime");
  if (rt !== undefined)
    upd.catalogReplyTime =
      catalogText(rt, 80) || AUTO_FARM_DEFAULTS.catalogReplyTime;
  const mins = pick("preorderSyncMinutes", "catalogPreorderSyncMinutes");
  if (mins !== undefined) upd.catalogPreorderSyncMinutes = catalogMinutes(mins);
  if (Object.keys(upd).length) await setAutoFarm(upd, opts);
  return getCatalogConfig();
}

function getCoworkerAutonomy() {
  return { enabled: !!getAutoFarm().coworkerAutonomy };
}

// Account-listing switches (docs/ACCOUNT-LISTINGS-CONTRACT.md §B8), read fresh
// each call so the owner can stop every account-listing delivery with one live
// settings edit, without a restart and without touching any other market
// (the getAutoFarm/maxAutoBots pattern).
//
// The merge is load-bearing, not decoration: loadSettings merges DEFAULTS only
// SHALLOWLY, so a settings.json carrying a partial block — the shape a
// hand-edit or a future single-key write produces — replaces the whole default
// object and every unwritten key would come back undefined. `enabled` and
// `autoDeliver` are the gates on a paid buyer's delivery, and undefined reads
// as OFF, so a one-key edit could silently stop delivering. Defaults go under
// the live values, and each value is clamped the getUnclaimedPricing way so a
// hand-typed string degrades to the default instead of poisoning the gate.
function getAccountListingSettings() {
  const s = loadSettings();
  const cur =
    s.accountListings && typeof s.accountListings === "object"
      ? s.accountListings
      : {};
  const D = ACCOUNT_LISTING_DEFAULTS;
  return {
    enabled: cur.enabled == null ? D.enabled : !!cur.enabled,
    autoDeliver: cur.autoDeliver == null ? D.autoDeliver : !!cur.autoDeliver,
    lowStockWarnAt: Math.max(
      0,
      Math.floor(num(cur.lowStockWarnAt, D.lowStockWarnAt)),
    ),
  };
}

// No-claim Shop switches (docs/NOCLAIM-SHOP-LISTINGS-CONTRACT.md §1e), read
// fresh each call exactly the getAccountListingSettings way, for the same
// reasons: one live settings edit stops every no-claim claim without a
// restart, and the merge is load-bearing — loadSettings merges DEFAULTS only
// SHALLOWLY, so a partial `noclaimShop` block would read every unwritten key
// back as undefined, and an undefined `enabled` / `autoDeliver` reads as OFF on
// a paid buyer's claim-at-sale delivery. Defaults go under the live values.
//
// Every number is clamped into the range the contract names, and a blank, null
// or non-numeric value degrades to the default (the catalogMinutes rule above —
// `num` alone would read a null as 0, because Number(null) is 0). These are
// read budgets and timer intervals: a hand-typed 0 must not become a sweep that
// reads nothing or a timer that fires continuously, and a hand-typed string
// must not poison the gate.
function noclaimShopInt(v, d, lo, hi) {
  if (v == null || (typeof v === "string" && !v.trim())) return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d;
}
function getNoclaimShopSettings() {
  const s = loadSettings();
  const cur =
    s.noclaimShop && typeof s.noclaimShop === "object" ? s.noclaimShop : {};
  const D = NOCLAIM_SHOP_DEFAULTS;
  return {
    enabled: cur.enabled == null ? D.enabled : !!cur.enabled,
    autoDeliver: cur.autoDeliver == null ? D.autoDeliver : !!cur.autoDeliver,
    sweep: cur.sweep == null ? D.sweep : !!cur.sweep,
    sweepPerTick: noclaimShopInt(cur.sweepPerTick, D.sweepPerTick, 1, 200),
    sweepEveryMin: noclaimShopInt(cur.sweepEveryMin, D.sweepEveryMin, 2, 240),
    maxAgeHours: noclaimShopInt(cur.maxAgeHours, D.maxAgeHours, 1, 72),
    refreshBudget: noclaimShopInt(cur.refreshBudget, D.refreshBudget, 1, 400),
    topUp: cur.topUp == null ? D.topUp : !!cur.topUp,
    healthPerPass: noclaimShopInt(cur.healthPerPass, D.healthPerPass, 0, 100),
    passEveryMin: noclaimShopInt(cur.passEveryMin, D.passEveryMin, 2, 120),
  };
}

// ---------------------------------------------------------------------------
// Bulk packs (docs/bulk-packs/CONTRACT.md §6)
// ---------------------------------------------------------------------------
// Typed, clamped view of the bulkPack* / bulkFarm* keys — the getFarmSizing
// convention: `afIn` is optional, so a caller (or a test) that already holds
// the auto-farm object passes it in instead of re-reading settings.json.
//
// A key that is ABSENT (undefined / null) reads as its shipped default. A key
// that is present but unusable is not quietly swapped for the default where
// that could publish something the owner did not ask for:
//   enabled        strictly `=== true` — "true" as a string stays OFF
//   markets        subset of eldorado/g2g/gameflip, order kept, deduped;
//                  empty -> [] (no market), never the default list
//   tiers          integer minQty 2..100 and discountPct 0..60, else the entry
//                  is dropped (never clamped into a discount nobody set);
//                  first entry per minQty wins; sorted; at most 4;
//                  nothing valid left -> the default tiers
//   farmPrices     eldorado/g2g only, days 1..730, price > 0, else dropped
//   farmDurations  integers 1..730, deduped, sorted; empty -> []
//   counts         integers, clamped into their range; blank or non-numeric
//                  -> default (Number(null) is 0, so null is not a number here)
// Every array and object returned is a fresh copy: a caller mutating its `bp`
// can never corrupt AUTO_FARM_DEFAULTS for the rest of the process.
//
// The two market lists mirror utils/bulkPacks/config.js (SUPPORTED_MARKETS and
// SOURCE_MARKETS.farm) rather than requiring it: settings.js is loaded very
// early and stays free of subsystem imports. tests/bulkPacksConfig.test.js
// pins the pair.
const BULK_PACK_MARKETS = ["eldorado", "g2g", "gameflip"];
const BULK_FARM_MARKETS = ["eldorado", "g2g"];

function bulkNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim()) return Number(v);
  return NaN;
}
function bulkInt(v, d, lo, hi) {
  const n = bulkNum(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : d;
}
function bulkMarkets(v) {
  if (v == null) return [...AUTO_FARM_DEFAULTS.bulkPacksMarkets];
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const m = typeof x === "string" ? x.trim().toLowerCase() : "";
    if (BULK_PACK_MARKETS.includes(m) && !out.includes(m)) out.push(m);
  }
  return out;
}
function bulkTiers(v) {
  const out = [];
  for (const t of Array.isArray(v) ? v : []) {
    if (!t || typeof t !== "object") continue;
    const minQty = bulkNum(t.minQty);
    const discountPct = bulkNum(t.discountPct);
    if (!Number.isInteger(minQty) || minQty < 2 || minQty > 100) continue;
    if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 60) continue;
    if (out.some((x) => x.minQty === minQty)) continue;
    out.push({ minQty, discountPct });
  }
  out.sort((a, b) => a.minQty - b.minQty);
  if (out.length) return out.slice(0, 4);
  return AUTO_FARM_DEFAULTS.bulkPackTiers.map((t) => ({
    minQty: t.minQty,
    discountPct: t.discountPct,
  }));
}
function bulkFarmPriceTable(v) {
  const src = v == null ? AUTO_FARM_DEFAULTS.bulkFarmPrices : v;
  const isMap = (o) => !!o && typeof o === "object" && !Array.isArray(o);
  const out = {};
  for (const market of BULK_FARM_MARKETS) {
    out[market] = {};
    const table = isMap(src) ? src[market] : null;
    if (!isMap(table)) continue;
    for (const [key, raw] of Object.entries(table)) {
      if (!/^\d+$/.test(key.trim())) continue;
      const days = Number(key);
      if (days < 1 || days > 730) continue;
      const price = bulkNum(raw);
      if (!Number.isFinite(price) || price <= 0) continue;
      if (out[market][String(days)] === undefined) out[market][String(days)] = price;
    }
  }
  return out;
}
function bulkDurations(v) {
  if (v == null) return [...AUTO_FARM_DEFAULTS.bulkFarmDurations];
  if (!Array.isArray(v)) return [];
  const days = new Set();
  for (const x of v) {
    const n = bulkNum(x);
    if (Number.isInteger(n) && n >= 1 && n <= 730) days.add(n);
  }
  return [...days].sort((a, b) => a - b);
}
function getBulkPacks(afIn) {
  const af = afIn && typeof afIn === "object" ? afIn : getAutoFarm() || {};
  const D = AUTO_FARM_DEFAULTS;
  return {
    enabled: af.bulkPacksEnabled === true,
    markets: bulkMarkets(af.bulkPacksMarkets),
    tiers: bulkTiers(af.bulkPackTiers),
    reserveSingles: bulkInt(af.bulkPackReserveSingles, D.bulkPackReserveSingles, 0, 100),
    unitsPerOffer: bulkInt(af.bulkPackUnitsPerOffer, D.bulkPackUnitsPerOffer, 1, 80),
    farmPrices: bulkFarmPriceTable(af.bulkFarmPrices),
    farmDurations: bulkDurations(af.bulkFarmDurations),
    farmReserveSlots: bulkInt(af.bulkFarmReserveSlots, D.bulkFarmReserveSlots, 0, 500),
    farmReservePristine: bulkInt(af.bulkFarmReservePristine, D.bulkFarmReservePristine, 0, 500),
    farmMaxQty: bulkInt(af.bulkFarmMaxQty, D.bulkFarmMaxQty, 1, 100),
    loopMinutes: bulkInt(af.bulkPacksLoopMinutes, D.bulkPacksLoopMinutes, 2, 60),
    farmSyncMinutes: bulkInt(af.bulkFarmSyncMinutes, D.bulkFarmSyncMinutes, 5, 120),
  };
}

// Epic auto-claim block accessors. captchaKey is encrypted at rest — the
// getter returns the ciphertext (decrypted by callers with secretBox), the
// setter re-encrypts any plaintext key the operator pastes in.
function getEpicAutoClaim() {
  const s = loadSettings();
  const cur = s.epicAutoClaim && typeof s.epicAutoClaim === "object"
    ? s.epicAutoClaim
    : {};
  return { ...EPIC_AUTO_CLAIM_DEFAULTS, ...cur };
}

async function setEpicAutoClaim(patch, opts = {}) {
  const secretBox = require("./secretBox");
  const p = snapshotPatch(patch);
  // Encrypt before queueing: a missing CRED_SECRET throws here, with nothing
  // written, exactly as before.
  const setsKey = hasOwn(p, "captchaKey");
  const key = setsKey ? String(patch.captchaKey || "").trim() : "";
  const encryptedKey = key ? secretBox.encrypt(key) : "";
  // Applied to the CURRENT block inside the save chain (see setAutoFarm).
  let cur = {};
  let next = null;
  await updateSettings((s) => {
    cur = s.epicAutoClaim && typeof s.epicAutoClaim === "object"
      ? s.epicAutoClaim
      : {};
    next = { ...freshDefault("epicAutoClaim"), ...cur, ...p };
    if (setsKey) next.captchaKey = encryptedKey;
    next.perAccountCooldownH = Math.max(
      0,
      Math.floor(Number(next.perAccountCooldownH) || 0),
    );
    next.dailyCap = Math.max(0, Math.floor(Number(next.dailyCap) || 0));
    s.epicAutoClaim = next;
  });
  try {
    const changed = {};
    for (const k of Object.keys(p)) {
      const before = k === "captchaKey" ? (cur[k] ? "***" : "") : cur[k];
      const after = k === "captchaKey" ? (next[k] ? "***" : "") : next[k];
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        changed[k] = { from: before, to: after };
      }
    }
    if (Object.keys(changed).length) {
      require("./systemLog").logEvent({
        category: "settings",
        action: "epic_auto_claim_changed",
        actor: opts.actor || "system",
        subject: Object.keys(changed).join(","),
        meta: changed,
      });
    }
  } catch {
    /* never block a settings write on its audit */
  }
  return next;
}

module.exports = {
  loadSettings,
  saveSettings,
  getRequire2fa,
  setRequire2fa,
  getAutoFarm,
  setAutoFarm,
  getEpicAutoClaim,
  setEpicAutoClaim,
  normGameName,
  isNoClaimGame,
  isReuseOnlyGame,
  getStreamGate,
  streamGatedGameEntry,
  isStreamGatedGame,
  getNoClaimGate,
  getCoworkerAutonomy,
  getUnclaimedPricing,
  gameFloorFor,
  gameMarketsFor,
  gameCapFor,
  getFarmSizing,
  getNoclaimSizing,
  gameAccountCapFor,
  getCatalogConfig,
  setCatalogConfig,
  getAccountListingSettings,
  getNoclaimShopSettings,
  getBulkPacks,
  UNCLAIMED_MARKETS,
  UNCLAIMED_PRICING_DEFAULTS,
  ACCOUNT_LISTING_DEFAULTS,
  NOCLAIM_SHOP_DEFAULTS,
  EPIC_AUTO_CLAIM_DEFAULTS,
};
