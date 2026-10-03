// The listing brain, rule by rule (docs/LISTING-BRAIN-PLAN.md, the owner's brief §1, §3a, §4, §9).
//
// Every rule the brief binds has a test here that FAILS when the rule is removed, and every planted truth
// of scripts/listing-brain-fixture.js (PLANTED) is asserted to be RECOVERED by the model within its stated
// tolerance. tests/listingBrainCore.test.js holds the model's first tests; the RULES table below names, per
// rule, the tests that pin it — here, in the core file ("core: …") or in the safety scan ("safety: …").
// The last test checks the table itself: every name in it exists, every rule has a test in this file, and
// no test here is missing from the table.
//
// Synthetic data only (invented game names, prices and ids). Run:
//   CRED_SECRET=x node --test tests/listingBrainModel.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../utils/listingBrain/model");
const U = require("../utils/listingBrain/model/util");
const E = require("../utils/listingBrain/model/evidence");
const RF = require("../utils/listingBrain/model/ref");
const H = require("../utils/listingBrain/model/hazard");
const P = require("../utils/listingBrain/model/price");
const PL = require("../utils/listingBrain/model/place");
const FX = require("../scripts/listing-brain-fixture");

const { PLANTED } = FX;

/* ------------------------------------------------------------------------------------------------------ */
/* RULES: id → the rule in plain words (where the brief / plan states it) → the tests that pin it          */
/* ------------------------------------------------------------------------------------------------------ */

const RULES = [
  // ---- brief §1: the money rules -------------------------------------------------------------------------
  {
    id: "R1",
    rule: "Hand-made rows (origin manual, the default) are never advised; their sales are price evidence and demand; they join the system-made sell-speed curve only when they are the very same items (brief §1 table; plan §3)",
    tests: [
      "R1 hand-made rows are never advised, yet their sales are price evidence and demand",
      "R1 hand-made rows join the system curve only when they are the very same items as a system row on that market",
      "core: hazard: ZeusX never enters a fit; hand-made rows only when they are the same items as a system row",
    ],
  },
  {
    id: "R2",
    rule: "Claim-at-sale offers (noclaimStock, autoClaimSet — including the G2G operator-script rows that are origin auto) are never advised, their quantities are never summed as stock, the script rows are counted apart, and their sales count as price evidence and demand (brief §1; plan §1.3 #4)",
    tests: [
      "R2 claim-at-sale rows of any origin are never advised, never in the curve, never summed; their sales still price",
      "core: claim-at-sale quantities are never summed as stock; script rows are counted apart",
    ],
  },
  {
    id: "R3",
    rule: "Bulk packs and lots are never advised; their sales are demand only, never a single-unit price (brief §1, §3a b; plan §3)",
    tests: [
      "R3 packs and lots are never advised; their sales are demand only, never a price, not even through the translator",
      "core: orders: a rent-farm row's sales count as nothing; a pack's sales are demand, never a price",
    ],
  },
  {
    id: "R4",
    rule: "Rent-farm windows are never advised and count for nothing (brief §1; plan §3)",
    tests: ["R4 rent-farm windows count for nothing: planted G's run is identical with them removed"],
  },
  {
    id: "R5",
    rule: "Account listings are never advised; their sales count as the tracker's ledger keeps them (price evidence and demand); shop sales are demand only (brief §1)",
    tests: ["R5 account listings are never advised and stay out of the curve; their sales count as the ledger keeps them"],
  },
  {
    id: "R6",
    rule: "A blocked market (Digiseller; the owner's Plati and GGSel switches) gets no stock and no price; its history describes only itself and never teaches another market's price (brief §1)",
    tests: [
      "R6 the owner's GGSel switch off blocks like Digiseller: no price, no shelf, no fit, and its orders never teach another market",
      "R54 planted E: Digiseller is history only — closed, unpriced, and its prices never reach another market",
      "core: a blocked market never teaches another: Digiseller orders never move Gameflip's reference",
    ],
  },
  {
    id: "R7",
    rule: "Both farms live in one brain: every row carries its farm (claim / noclaim) and the two are fitted apart (brief §1, §3a)",
    tests: ["R7 every row carries its farm and the two farms are fitted apart"],
  },
  {
    id: "R8",
    rule: "No-claim system rows (origin unclaimed) get a full verdict, compared with today's bundlePrice, inside the owner's no-claim limits: the floor, the per-game floors, the ceiling (applied before the floors) and the 30-day sold floor (the only thing allowed above the ceiling) (brief §1; unclaimedBundles.bundlePrice)",
    tests: [
      "R8 a no-claim system row gets a full verdict and is compared with today's bundlePrice",
      "R8 no-claim limits: never under the owner's no-claim floor",
      "R8 no-claim limits: never under the game's own no-claim floor (settings' substring rule)",
      "R8 no-claim limits: never over the no-claim ceiling (0 or missing reads $4.50); claim offers ignore it",
      "R8 no-claim limits: the 30-day sold floor is the one thing allowed above the ceiling",
      "R8 no-claim limits: a cut-back raise's test unit never goes over the ceiling",
    ],
  },
  {
    id: "R9",
    rule: "An explicit no-claim shelf cap is the owner's: shown, classed managed, never advised; a game on the default cap is advised (brief §1; plan §1.3 #12)",
    tests: [
      "R9 an explicit no-claim cap is the owner's (managed); a game on the default cap is advised (planted R)",
      "core: no-claim placement: only Gameflip/Digiseller/GGSel; an explicit cap is the owner's (managed)",
    ],
  },
  {
    id: "R10",
    rule: "A deliberate ladder (one exact offer live at two or more prices with a hand-made rung) is reported as ladder, never corrected, and its rungs are read as evidence (brief §1, §3a)",
    tests: [
      "R10 a ladder's rungs are read as evidence even with no system row of those items",
      "R55 planted F: the hand-made Eldorado ladder is reported, never corrected, its rungs in the curve",
      "R66 planted Q: the no-claim Gameflip ladder is reported, never corrected",
      "core: live action: a deliberate ladder is reported, never corrected",
    ],
  },
  {
    id: "R11",
    rule: "No price under the platform floor or the row's own venueMinPriceUsd (for a new GGSel listing, the game's highest GGSel minimum); the floor is applied last (brief §1; plan §4.2)",
    tests: [
      "R11 the floor is applied last: a step limit never leaves a price under the floor",
      "R11 a live row is never advised under its own venueMinPriceUsd",
      "R11 a new GGSel listing is never priced under the game's hidden GGSel minimum",
      "R68 planted V and U: a new GGSel listing honours the game's hidden minimum; an unmapped G2G game is unknown",
      "core: price: GGSel is raise-only, and the floor (with the row's own minimum) is applied last",
    ],
  },
  {
    id: "R12",
    rule: "GGSel may only be raised, never lowered (it enforces an unpublished per-category minimum) (brief §1)",
    tests: [
      "R12 GGSel is raise-only across a whole run: no GGSel row is ever advised under its ask",
      "core: price: GGSel is raise-only, and the floor (with the row's own minimum) is applied last",
      "core: live action: a stale row comes down one rung (rule 5's missing half); on GGSel it holds",
    ],
  },
  {
    id: "R13",
    rule: "A raise needs real sale evidence on that market — our orders here at or above the price, or repeated stock-outs — never a venue median, the engine's fallback or a rival's asking price (brief §1; plan §4.4 gate 2)",
    tests: [
      "R13 a raise needs our own orders on THIS market at or above it; elsewhere, rivals and the engine never lift a price",
      "R13 repeated stock-outs open a raise without orders at the higher price",
      "core: price: a raise needs orders here at or above it — else it is cut back to the base, with a test unit",
      "core: price: the venue median never raises a price",
    ],
  },
  {
    id: "R14",
    rule: "Fail-safe: a missing farm-brain row, or one older than maxDemandAgeH (configurable), makes the game unknown — no price, no move, no shelf, never a guess (brief §1; plan §2)",
    tests: [
      "R14 no farm-brain row makes the game unknown: no price, no move, no shelf, today's answers",
      "R14 a farm-brain row older than maxDemandAgeH is stale; the age is configurable",
      "R58 planted I: the game with no farm-brain row and the stale one are unknown and held",
      "core: fail-safe: no fresh farm-brain row → regime unknown, every row hold, no shelf advice",
    ],
  },
  // ---- brief §3a: the two farms ----------------------------------------------------------------------
  {
    id: "R15",
    rule: "No-claim stock is perishable: never held back for a later price (no regime and no value threshold keeps a unit back); little time left is overstock; time left caps the horizon of the price and of the shelf (brief §3a)",
    tests: [
      "R15 no-claim stock is never held back: its shelf ignores the regime and any value threshold",
      "R15 little time left is overstock, and time left caps the no-claim horizon of the price and the shelf",
      "R63 planted N: the ending wave perishes (overstock, ~36 h left); the claim window is learned to within 6 h",
      "core: no-claim: stock close to expiry is overstock and its horizon is cut to the time left",
      "core: no-claim perish is read per stock: overstock (perishing) only when half the listed units expire within perishHours",
      "core: no-claim placement has no value threshold (perishable stock); the claim farm keeps minMarginalUsd",
    ],
  },
  {
    id: "R16",
    rule: "The sell-through horizon is chosen per farm (claim 7 d, no-claim 2 d by default) and each farm's p7 is read over its own (brief §3a; plan §4.3)",
    tests: ["R16 the horizon is set per farm and each farm's sell chance uses its own"],
  },
  {
    id: "R17",
    rule: "Bulk first: what the bulk channel is expected to take over the horizon is set aside before any single shelf is filled, as its own line (brief §3a d; plan §4.5)",
    tests: [
      "R17 bulk's expected take is set aside before any single shelf is filled",
      "R64 planted O: the bulk game's take is set aside first; its per-account prices never price a single",
      "core: placement: bulk is taken first, the greedy shelf follows Poisson marginal value, the rest is reserve",
    ],
  },
  {
    id: "R18",
    rule: "Bulk's per-account price is its own series, never single-unit price evidence (brief §3a b)",
    tests: ["R18 bulk's per-account prices are their own series and never move a single-unit price"],
  },
  {
    id: "R19",
    rule: "On a bulk market with a pack of the game live or sent in the window, the cell carries the bulk-anchor flag and its offers show the pack prices they would produce (brief §3a c)",
    tests: ["R19 a bulk market with a live or recently sent pack carries bulk-anchor and shows the pack prices"],
  },
  {
    id: "R20",
    rule: "An offer is what it held at the time: a rebundled row's sales and exposure before rebundledAt never count for its new contents (brief §3a; plan §4.1)",
    tests: [
      "R65 planted P: a rebundled row's earlier $3 sales never price its new contents",
      "core: exposure: live rows count their exposure; a rebundle splits it; Eldorado dies at 21 days unsold",
    ],
  },
  {
    id: "R21",
    rule: "Within one event a bundle that contains another is never priced below it; offers of other events or with no recorded bundle are never compared; no price under the 30-day sold floor (brief §3a)",
    tests: [
      "R21 within one event a bundle that contains another is never priced below it; other events are never compared",
      "core: no-claim bundle order: within one event a bundle is lifted to any bundle it contains (bundleKey, U.lids)",
      "core: no-claim: a bundle whose units disagree on their bundleKey (rebundled since) gets no bundle order",
      "core: no-claim: the 30-day Gameflip sold floor of the exact offer is never undercut",
    ],
  },
  {
    id: "R22",
    rule: "Where a no-claim bundle's evidence is thin the brain starts from bundlePrice's answer, not from nothing (brief §3a)",
    tests: [
      "R22 a thin no-claim cell starts from today's bundlePrice answer, logged as the cell's new-listing price",
      "core: no-claim: a thin bundle starts from today's bundlePrice answer, not from nothing",
      "core: no-claim: a thin live bundle starts from today's bundlePrice answer, not from its own ask",
    ],
  },
  {
    id: "R23",
    rule: "One row, one pricer: the brain never moves a row — no write but its own two log models, no marketplace call, no connector outside realDeps() (brief §1, §3a)",
    tests: [
      "safety: no write call anywhere but the runner's own two log inserts",
      "safety: no marketplace connector is required outside the body of inputs.realDeps()",
    ],
  },
  // ---- plan §4 / brief §4: the model ---------------------------------------------------------------------
  {
    id: "R24",
    rule: "The unit of decision is a cell (game × farm × market); inside it price is decided per offer (exact items): two sets of one game are different offers (brief §4)",
    tests: ["R24 two sets of one game on one market are two offers with their own references"],
  },
  {
    id: "R25",
    rule: "Reference price cascade, first step that gives a price wins: exact-here (≥ 3 orders, high; medium at best where the price is the listing price now), band-here (low, medium from 8), translated (medium from two markets), rivals (low), venue (none) (plan §4.2)",
    tests: [
      "R25 the reference cascade takes the first step that gives a price, in order, with its confidence",
      "core: ref cascade: exact here is high; on a listing-now market medium at best",
      "core: ref cascade: band here is low under 8 orders, medium from 8",
      "core: ref cascade: translated is medium from two markets, low from one, never from a blocked one",
    ],
  },
  {
    id: "R26",
    rule: "Only a price paid here may sit in the market's top tail: a translated, rival or venue anchor is capped at the market's p75; the ceiling of the grid is the market's highest order (plan §4.2, brief §4.3)",
    tests: [
      "R26 exact-here is never capped; a rivals anchor is cut to the p75; the ceiling is the market's highest order",
      "core: ref: the p75 cap binds a translated anchor and says so",
      "core: ref cascade: rivals (Gameflip/GGSel only, same radar band) then venue; both capped at the market p75",
    ],
  },
  {
    id: "R27",
    rule: "Each exposure sits at x = price ÷ ref in the six buckets (≤0.80 … >2.00): a sold single unit at the price it sold for, the rest at its ask (plan §4.3)",
    tests: ["R27 every exposure is placed at x = price ÷ ref: a sold unit at its sale price, the rest at the ask", "core: buckets, tiers and the $0.05 grid"],
  },
  {
    id: "R28",
    rule: "Hazard, not resolved rows: live listings count their exposure too (the tracker's resolved-only curve drops unsold live rows and flatters high prices) (brief §4.2)",
    tests: ["R28 live rows count their exposure: where the resolved-only curve flatters a high price, the brain does not"],
  },
  {
    id: "R29",
    rule: "Exposure starts at createdAt and ends at the sale (never updatedAt); Gameflip exposure is capped 30 days after createdAt (brief §4.2; plan §1.3 #10)",
    tests: [
      "R29 a later edit never moves a sale; a sold row with no sale record ends at its last write, flagged",
      "core: exposure: a sold row ends at its sale, never at updatedAt",
      "core: exposure: Gameflip is capped 30 days after createdAt and an expired row is not live",
    ],
  },
  {
    id: "R30",
    rule: "On quantity and order-unit markets the hazard is units sold per in-stock day of an offer, its exposure starting at its first unit's addedAt (never a claim-at-sale delivery record) (brief §4.2)",
    tests: ["R30 on quantity markets a row is one offer: units sold per in-stock day from its first unit"],
  },
  {
    id: "R31",
    rule: "Shrinkage market × bucket × tier → market × bucket → market, with a named, configurable strength shrinkK (brief §4.2)",
    tests: ["R31 shrinkK is the shrinkage strength: a larger one pulls a thin bucket toward its market"],
  },
  {
    id: "R32",
    rule: "Monotone: a higher price never gets a higher hazard, at every level (bucket, tier, between buckets) (brief §4.2)",
    tests: [
      "R32 monotone at every level on the large fixture: no higher price ever sells faster",
      "core: hazard: shrunk, non-increasing in price, interpolated log-linearly and flat beyond the ends",
    ],
  },
  {
    id: "R33",
    rule: "Fewer than 3 samples is no estimate; a thin bucket is flagged and never picked as a price (brief §4.2)",
    tests: [
      "R33 no offer's price is ever taken from a thin bucket, and minSales is the estimate's threshold",
      "core: hazard: under minSales a market has no estimate at all; every bucket is unpickable",
      "core: price: a thin bucket is never picked, however well it scores",
    ],
  },
  {
    id: "R34",
    rule: "weekly value(p) = pH(p ÷ ref) × net(p), net after the market's fee; a fee scales a market's values alike, so it never moves the best price there (brief §4.3, §4.1)",
    tests: ["R34 value is the sell chance times the net after the fee; a fee never moves the best price on its market"],
  },
  {
    id: "R35",
    rule: "Regime per game × farm from the farm brain's row: scarce / balanced / overstock with each trigger, and the pick per regime (highest price keeping minP7Scarce; highest value; fastest not under p25) (brief §4.3)",
    tests: [
      "R52 planted B, B2, C, C2: the four regime triggers are read from the farm brain's rows",
      "core: regime table: scarce, balanced, overstock (cover, skip, fading), unknown (missing or stale)",
      "core: regime precedence: an ended campaign with the rivals gone outranks fading; perishing stock outranks all",
      "core: price: each regime picks by its own rule (balanced max value, overstock fastest ≥ p25, scarce highest with pH ≥ min)",
    ],
  },
  {
    id: "R36",
    rule: "Gates in a fixed order: confidence → raise rule → step limit (35 %) → GGSel raise-only → floor last; the order changes answers (brief §4.3)",
    tests: [
      "R36 the raise rule judges the regime's pick before the step limit: the other order gives another price",
      "R36 a low-confidence price still passes every later gate; only its action is hold",
      "R11 the floor is applied last: a step limit never leaves a price under the floor",
      "core: price: the gate order is confidence → raise rule → step → GGSel raise-only → floor last",
    ],
  },
  {
    id: "R37",
    rule: "A live system-made row gets hold / lower / raise / test; a stale row (far past the time-to-sale its price implies) comes down one rung — rule 5's missing half; a cool-down (72 h) holds a different move on one row (brief §4.3)",
    tests: [
      "R37 every advised move on the large fixture stays inside its floor and step, and is one of the five actions",
      "R37 the cool-down holds a different move advised within cooldownH, run-wide; it is configurable",
      "core: live action: a stale row comes down one rung (rule 5's missing half); on GGSel it holds",
      "core: live action: cool-down holds a different move advised within cooldownH; the same move repeats",
    ],
  },
  {
    id: "R38",
    rule: "Eligibility per market without any marketplace call: closed (blocked, switch off, floor above what the offer sells for — PlayerAuctions), open, unknown (unproven mapping), unmeasured (ZeusX: no exploration, ever) (brief §4.4)",
    tests: [
      "R38 ZeusX is unmeasured: never a shelf, never the exploration unit, even as the only unproven market",
      "R61 planted L: ZeusX is unmeasured — no fit, no shelf, no exploration",
      "R62 planted M: PlayerAuctions is closed where its floor is above what the offer sells for",
      "core: eligibility classes: closed (blocked, switch off, floor above ref), unmeasured, open, unknown, managed",
      "core: eligibility: a market with no evidence of its own is closed when its floor beats any translation of the offer's price",
    ],
  },
  {
    id: "R39",
    rule: "Gameflip anchors today's listing flow: a brain shelf of 0 there is logged and flagged anchor (brief §4.4)",
    tests: ["R39 a Gameflip shelf of zero is flagged anchor on the cell", "core: placement flags: anchor when Gameflip gets nothing; fee-assumed with the equal-fee shelf logged"],
  },
  {
    id: "R40",
    rule: "Markets today's flow cannot top up (ZeusX, PlayerAuctions, G2G, Eldorado) are sized over a longer, configurable horizon than refillable ones (brief §4.4)",
    tests: ["R40 markets that cannot be topped up are sized over the longer horizon; both horizons are configurable"],
  },
  {
    id: "R41",
    rule: "Platform limits are named constants with their source beside them (Eldorado 100 offers, Gameflip 30-day expiry, PlayerAuctions mapping, GGSel cannot remove a unit), and they bind (brief §4.4)",
    tests: ["R41 platform limits are named constants with their source, and they bind on the shelf"],
  },
  {
    id: "R42",
    rule: "No-claim placement is only the capped shelf on Gameflip, Digiseller and GGSel; its Eldorado, PlayerAuctions and G2G offers are claim-at-sale cells, classed managed (brief §4.4)",
    tests: [
      "R59 planted J: claim-at-sale rows are never advised, never summed, and their sales still price",
      "core: no-claim placement: only Gameflip/Digiseller/GGSel; an explicit cap is the owner's (managed)",
      "core: eligibility classes: closed (blocked, switch off, floor above ref), unmeasured, open, unknown, managed",
    ],
  },
  {
    id: "R43",
    rule: "Market rate λ = the farm brain's weekly forecast split by the shrunk in-stock rate, so a market that was out of stock is not read as one that does not sell (brief §4.4)",
    tests: ["R53 planted D: a market stocked half the window keeps its share (in-stock rate, not raw sales)"],
  },
  {
    id: "R44",
    rule: "The k-th unit on a market is worth P(D ≥ k) × net with Poisson demand; units go greedily to the highest marginal value until stock runs out or a unit is worth under minMarginalUsd; the rest is the reserve (brief §4.4)",
    tests: [
      "R44 the greedy shelf is the best split there is, checked against brute force",
      "core: placement: bulk is taken first, the greedy shelf follows Poisson marginal value, the rest is reserve",
    ],
  },
  {
    id: "R45",
    rule: "Exploration: at most one unit on at most one eligible unproven market per game, only when the game has surplus stock, preferring a market where the radar shows rivals selling (brief §4.4)",
    tests: [
      "R45 exploration needs surplus stock, takes one unit on one unproven market, and prefers where rivals sell",
      "core: placement: at most one exploration unit, on an open market we never sold on, rivals first",
    ],
  },
  {
    id: "R46",
    rule: "Every cell whose fee is assumed is flagged fee-assumed, and the placement with all fees equal is logged beside the brain's (brief §4.1)",
    tests: [
      "R46 an assumed fee is flagged, a settings fee is not, and the equal-fee placement is logged — here it flips a unit",
      "R60 planted K: the five assumed fees are flagged on their cells; the equal-fee shelf is logged on every open cell",
    ],
  },
  {
    id: "R47",
    rule: "All four price policies (old, tracker, curve, clear) and all four placement policies (flat, share30, instock, newsvendor) are logged on every cell row (brief §4.5)",
    tests: [
      "R47 every cell row logs all four price policies and all four placement forecasts",
      "R47 the log keeps both policy blocks: nothing a run writes is dropped by the log models' schemas",
    ],
  },
  {
    id: "R48",
    rule: "Price classes and shelf classes as the plan lists them; totals compare like with like and a cell with no evidence is counted apart, never as zero (brief §4.6)",
    tests: [
      "R48 a run's own summary adds up from its rows, like with like, no-evidence apart",
      "core: price and shelf classes",
      "core: summary totals compare like with like: unknown cells are counted apart, never as zero",
    ],
  },
  {
    id: "R49",
    rule: "priceFor / shelfFor / valueFor have the agreed shapes and fail safe (today's price / no shelf advice / no value) on no run, an unknown game or market, a blocked market, or an error (brief §4.7)",
    tests: [
      "R49 priceFor, shelfFor and valueFor answer in their agreed shapes and fail safe on anything broken",
      "core: outputs fail safe: no run, unknown market, blocked market, unknown game",
      "core: outputs answer from the run: a measured offer gets the brain's price; shelf and value per account",
    ],
  },
  {
    id: "R50",
    rule: "An ask is what buyers see: max(stored price, floor) — the ZeusX publisher stores the price before the connector lifts it (brief §4.1 traps)",
    tests: ["R50 an ask is max(stored price, floor): a ZeusX row stored under its floor asks the floor"],
  },
  // ---- brief §9: planted truths (scripts/listing-brain-fixture.js PLANTED) -------------------------------
  {
    id: "R51",
    rule: "PLANTED.A: the Gameflip claim elasticity h(x) = h0·exp(−β(x − 1)) — recovered as h(0.9)/h(1.5) within tolPct 35 (15 % on the large bundle), h0 within h0TolPct, every planted offer's reference exact-here at its R",
    tests: ["R51 planted A: the Gameflip claim elasticity is recovered within its tolerance"],
  },
  { id: "R52", rule: "PLANTED.B, B2, C, C2: overstock (cover), overstock (fading), scarce (cover), scarce (ended campaign, rivals gone)", tests: ["R52 planted B, B2, C, C2: the four regime triggers are read from the farm brain's rows"] },
  { id: "R53", rule: "PLANTED.D: GGSel stocked half the window keeps a share near Gameflip's (ratio 1 within tolPct 35; a raw 30-day share would read 0.5)", tests: ["R53 planted D: a market stocked half the window keeps its share (in-stock rate, not raw sales)"] },
  { id: "R54", rule: "PLANTED.E: Digiseller blocked with 3× history — closed, unpriced, never teaching; the probe offer translated near $1.50, never $4.50", tests: ["R54 planted E: Digiseller is history only — closed, unpriced, and its prices never reach another market"] },
  { id: "R55", rule: "PLANTED.F: the hand-made Eldorado ladder — class ladder, no correction, rungs read as evidence", tests: ["R55 planted F: the hand-made Eldorado ladder is reported, never corrected, its rungs in the curve"] },
  { id: "R56", rule: "PLANTED.G: the rent-farm row at $12 — no order, no row, no exposure, no effect", tests: ["R4 rent-farm windows count for nothing: planted G's run is identical with them removed"] },
  { id: "R57", rule: "PLANTED.H: the mass-close burst at a fake $8 and the hand sales at $9.50 — never a price", tests: ["R57 planted H: the burst and the hand sales are never priced"] },
  { id: "R58", rule: "PLANTED.I: no farm-brain row / a 9 h old row — unknown, hold", tests: ["R58 planted I: the game with no farm-brain row and the stale one are unknown and held"] },
  { id: "R59", rule: "PLANTED.J: the no-claim Eldorado noclaimStock row and the G2G script row — never advised, quantities never summed, sales price evidence", tests: ["R59 planted J: claim-at-sale rows are never advised, never summed, and their sales still price"] },
  { id: "R60", rule: "PLANTED.K: five assumed fees flagged; the fee near-tie's equal-fee placement logged", tests: ["R60 planted K: the five assumed fees are flagged on their cells; the equal-fee shelf is logged on every open cell"] },
  { id: "R61", rule: "PLANTED.L: ZeusX unmeasured — no fit, shelf 0, no exploration", tests: ["R61 planted L: ZeusX is unmeasured — no fit, no shelf, no exploration"] },
  { id: "R62", rule: "PLANTED.M: PlayerAuctions closed — its $5 floor is above the $1.50 the offer sells for", tests: ["R62 planted M: PlayerAuctions is closed where its floor is above what the offer sells for"] },
  { id: "R63", rule: "PLANTED.N: claim window 1 d ± 0.25; the wave ending in 12 h is overstock with ~36 h left; the ended wave's straggler never makes a game perish", tests: ["R63 planted N: the ending wave perishes (overstock, ~36 h left); the claim window is learned to within 6 h"] },
  { id: "R64", rule: "PLANTED.O: the game sold mostly in bulk — bulk weekly units ≫ singles, its take set aside first, per-account prices never single-unit evidence", tests: ["R64 planted O: the bulk game's take is set aside first; its per-account prices never price a single"] },
  { id: "R65", rule: "PLANTED.P: the GGSel row rebundled 12 days ago — reference $1.25 ± 0.10 (a leak would give $3)", tests: ["R65 planted P: a rebundled row's earlier $3 sales never price its new contents"] },
  { id: "R66", rule: "PLANTED.Q: the no-claim Gameflip ladder — class ladder, never corrected", tests: ["R66 planted Q: the no-claim Gameflip ladder is reported, never corrected"] },
  { id: "R67", rule: "PLANTED.R: the explicit cap of 40 is managed; the others use 70", tests: ["R9 an explicit no-claim cap is the owner's (managed); a game on the default cap is advised (planted R)"] },
  { id: "R68", rule: "PLANTED.V and U: the GGSel hidden minimum is a floor; an unmapped G2G game is unknown with shelf 0", tests: ["R68 planted V and U: a new GGSel listing honours the game's hidden minimum; an unmapped G2G game is unknown"] },
];

/* ------------------------------------------------------------------------------------------------------ */
/* helpers                                                                                                */
/* ------------------------------------------------------------------------------------------------------ */

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const G = "alpha quest";
const CK = "s:aaa111";
const BK = G + "|1";
const TAKES = { gameflip: true, digiseller: false, ggsel: true, zeusx: true, eldorado: true, playerauctions: true, g2g: true };

// Every test of this file is registered through T, so the RULES check can see its name.
const NAMES = new Set();
function T(name, fn) {
  NAMES.add(name);
  return test(name, fn);
}

let seq = 0;
const nid = (p) => p + String(++seq).padStart(6, "0");

/** A bundle listing (plan §2.1 L): a system-made claim Gameflip row unless told otherwise. */
function L(o = {}) {
  return Object.assign(
    { id: nid("l"), g: G, gl: "Alpha Quest", m: "gameflip", o: "auto", f: "claim", kind: "single", script: false, ck: CK, bk: BK, ex: true, n: 1, p: 1.5, vmin: null, smin: null, st: "active", c: NOW - 5 * DAY, u: NOW - DAY, units: [], qty: 1, qr: 0, rb: null, pack: null },
    o,
  );
}
/** A unit sale (plan §2.1 S). */
function S(o = {}) {
  return Object.assign({ lid: "", g: G, m: "gameflip", o: "auto", f: "claim", ck: CK, bk: BK, ex: true, n: 1, p: 1.5, t: NOW - 3 * DAY, grp: nid("o"), basis: "reported", src: "unit" }, o);
}
/** A fresh farm-brain row. */
function DR(o = {}) {
  return Object.assign({ k: G, f: "claim", at: NOW - HOUR, live: true, hl: 48, c: "farm", w: 3, t: 20, on: 12, fl: 0, a30: 3, a45: 3 }, o);
}
function bundle(o = {}) {
  const b = {
    kind: "listing-brain-bundle",
    v: 1,
    now: NOW,
    af: { listingBrain: {}, perMarketStock: 3, takes: Object.assign({}, TAKES), mapped: {}, noClaimGames: [], noclaimAutoSize: false, capDefault: 70, caps: {} },
    sizing: { coverageDays: 28, safetyStock: 6, maxPerGame: 250 },
    fees: {},
    pricing: { floorUsd: 0.75, ceilingUsd: 4.5, gameFloors: {}, itemStepPct: 15, itemCapMult: 2.5, fullEventBonusPct: 25 },
    bulk: { markets: [], tiers: [], reserveSingles: 0 },
    listings: [],
    sales: [],
    demandOnly: [],
    bulkPrices: [],
    radar: { at: NOW, games: [], feed: [] },
    demand: [],
    noclaim: { units: [], waves: [] },
    old: { games: {}, offers: {} },
    notes: [],
    counts: {},
  };
  for (const [k, v] of Object.entries(o)) {
    if (k === "af") b.af = Object.assign(b.af, v);
    else b[k] = v;
  }
  return b;
}
const CFG = (over = {}) => Object.assign(U.readConfig({}), over);

/**
 * A measured market: `nSold` rows of one offer that sold `sellDays` after listing at `soldP` (the
 * reference price, exact-here), created `start` … `start + nSold − 1` days ago, plus `nLive` live rows
 * asking `liveP` for `liveAge` days.
 */
function curve({ m = "gameflip", g = G, gl = "Alpha Quest", ck = CK, bk = BK, n = 1, f = "claim", o = "auto", nSold = 10, soldP = 1.5, sellDays = 2, nLive = 5, liveP = 2.5, liveAge = 20, start = 30 } = {}) {
  const listings = [];
  const sales = [];
  const single = m === "gameflip" || m === "zeusx";
  for (let i = 0; i < nSold; i++) {
    const c = NOW - (start + i) * DAY;
    const row = L({ m, g, gl, ck, bk, n, f, o, p: soldP, st: single ? "sold" : "delisted", c, u: single ? NOW - DAY : c + sellDays * DAY });
    listings.push(row);
    sales.push(S({ lid: row.id, m, g, ck, bk, n, f, o, p: soldP, t: c + sellDays * DAY }));
  }
  for (let i = 0; i < nLive; i++) listings.push(L({ m, g, gl, ck, bk, n, f, o, p: liveP, st: "active", c: NOW - liveAge * DAY }));
  return { listings, sales };
}
function ctxOf(b, cfg = CFG(), prior = new Map()) {
  const ev = E.buildEvidence(b, { cfg, cut: b.now });
  const hz = { claim: H.fitHazard(ev, "claim"), noclaim: H.fitHazard(ev, "noclaim") };
  return { ev, hz, prior };
}
const cellOf = (run, g, f, m) => run.rows.find((r) => r.k === g && r.f === f && r.m === m);
const sum = (o) => Object.values(o || {}).reduce((a, n) => a + (Number(n) || 0), 0);
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, (msg || "") + " got " + a + ", want " + b + " ± " + tol);
const within = (a, b, pct, msg) => assert.ok(Math.abs(a - b) <= (pct / 100) * Math.abs(b), (msg || "") + " got " + a + ", want " + b + " ± " + pct + "%");
/** Translator filler: twelve orders of another game on each market, so its venue-median fallback has data. */
function filler(markets = ["gameflip", "ggsel", "eldorado"], p = 1.5) {
  const out = [];
  for (const m of markets) for (let i = 0; i < 12; i++) out.push(S({ m, g: "beta", ck: "s:fill" + i, bk: "beta|1", p }));
  return out;
}
/** A bare offer verdict for the gate chain. */
function V(o = {}) {
  return Object.assign({ k: G, f: "claim", m: "gameflip", ck: CK, bk: BK, n: 1, conf: "high", basis: "exact-here", cands: [], ref: 1.5, floor: 0.75, tier: 0, H: 7, ladder: false }, o);
}

// The fixture runs are built once (the large one takes a few hundred ms).
const memo = new Map();
const once = (k, fn) => {
  if (!memo.has(k)) memo.set(k, fn());
  return memo.get(k);
};
const smallBundle = () => once("sb", () => FX.generate({}));
const largeBundle = () => once("lb", () => FX.generate({ large: true }));
const smallRun = () => once("sr", () => M.buildRun(smallBundle()));
const largeRun = () => once("lr", () => M.buildRun(largeBundle()));

/* ------------------------------------------------------------------------------------------------------ */
/* brief §1: the money rules                                                                              */
/* ------------------------------------------------------------------------------------------------------ */

T("R1 hand-made rows are never advised, yet their sales are price evidence and demand", () => {
  const sold = [0, 1, 2].map((i) => L({ o: "manual", p: 2, st: "sold", c: NOW - (10 + i) * DAY }));
  const live = L({ o: "manual", p: 2.2, c: NOW - 3 * DAY });
  const sales = sold.map((r) => S({ lid: r.id, o: "manual", p: 2, t: r.c + DAY }));
  const run = M.buildRun(bundle({ listings: sold.concat([live]), sales, demand: [DR()] }));
  const ev = run.ctx.ev;
  assert.equal(ev.byId.get(live.id).advisable, false);
  assert.ok(!run.fc.some((f) => f.l === live.id), "no forecast logged for a hand-made row");
  for (const o of run.offers) for (const l of o.live) assert.notEqual(l.id, live.id, "never a live entry");
  const ref = RF.refFor(ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.deepEqual([ref.basis, ref.ref, ref.n], ["exact-here", 2, 3], "its sales are the offer's orders");
  assert.equal(PL.marketShares(ev, G, "claim", ["gameflip"]).S.gameflip, 3, "and its demand on the market");
  const gf = cellOf(run, G, "claim", "gameflip");
  assert.equal(gf.old.n, 0, "a hand-made row is not system stock");
  assert.equal(sum(gf.br.a), 0, "no action on any of its rows");
});

T("R1 hand-made rows join the system curve only when they are the very same items as a system row on that market", () => {
  const hand = Array.from({ length: 5 }, (_, i) => L({ o: "manual", p: 1.5, st: "sold", c: NOW - (20 + i) * DAY }));
  const handSales = hand.map((r) => S({ lid: r.id, o: "manual", p: 1.5, t: r.c + DAY }));
  const fit = (sysCk) => {
    const sys = L({ ck: sysCk, p: 1.5, c: NOW - 10 * DAY });
    return ctxOf(bundle({ listings: hand.concat([sys]), sales: handSales, demand: [DR()] })).hz.claim.markets.gameflip;
  };
  const same = fit(CK);
  assert.equal(same.S, 5, "the same items: the hand-made sales teach the curve");
  near(same.D, 15, 1e-6, "5 sold days + 10 live days");
  const other = fit("s:other");
  assert.equal(other.S, 0, "other items: hand-made rows stay out");
  near(other.D, 10, 1e-6, "only the system row's exposure");
  assert.equal(other.h, null);
});

T("R2 claim-at-sale rows of any origin are never advised, never in the curve, never summed; their sales still price", () => {
  const ncPool = L({ kind: "cas", o: "manual", f: "noclaim", m: "eldorado", qty: 35, p: 2 });
  const archive = L({ kind: "cas", o: "manual", f: "claim", m: "g2g", ck: "s:arch", qty: 20, p: 2.5 });
  const script = L({ kind: "cas", o: "auto", script: true, m: "g2g", qty: 60, p: 2 });
  const listings = [ncPool, archive, script];
  const sales = [];
  for (const r of listings) for (let i = 0; i < 3; i++) sales.push(S({ lid: r.id, m: r.m, f: r.f, o: r.o, ck: r.ck, p: r.p, basis: "listing-now", t: NOW - (5 + i) * DAY }));
  const run = M.buildRun(bundle({ listings, sales, demand: [DR(), DR({ f: "noclaim", w: 3, on: 5 })] }));
  const ev = run.ctx.ev;
  for (const r of listings) {
    const R = ev.byId.get(r.id);
    assert.equal(R.cas, true);
    assert.equal(R.advisable, false, r.m + " " + r.o);
    assert.equal(H.fitRow(ev, R, "claim") || H.fitRow(ev, R, "noclaim"), false, "never in the sell-through curve");
    assert.ok(!run.fc.some((f) => f.l === r.id));
  }
  for (const f of ["claim", "noclaim"]) {
    for (const r of run.rows.filter((x) => x.k === G && x.f === f)) {
      if (r.m === "all") assert.equal(r.old.cur, 0, "no claim-at-sale quantity on any shelf");
      else assert.equal(r.old.n, 0, r.m);
    }
  }
  const g2g = cellOf(run, G, "claim", "g2g");
  assert.equal(g2g.ev.scr, 1, "the operator-script row is counted apart");
  assert.ok(g2g.fl.includes("script"));
  assert.equal(cellOf(run, G, "noclaim", "eldorado").pc, "managed");
  // their delivered units are price evidence (listing price now: medium at best) and demand
  const el = RF.refFor(ev, { g: G, m: "eldorado", ck: CK, bk: BK, ex: true, n: 1 });
  assert.deepEqual([el.basis, el.conf, el.ref], ["exact-here", "medium", 2]);
  const ar = RF.refFor(ev, { g: G, m: "g2g", ck: "s:arch", bk: BK, ex: true, n: 1 });
  assert.deepEqual([ar.basis, ar.ref], ["exact-here", 2.5]);
  assert.equal(ev.salesBefore.length, 9);
});

T("R3 packs and lots are never advised; their sales are demand only, never a price, not even through the translator", () => {
  const pack = L({ kind: "bulk", pack: 5, m: "eldorado", p: 6, qty: 5 });
  const lot = L({ kind: "lot", m: "ggsel", p: 4, qty: 1 });
  const sales = filler();
  for (let i = 0; i < 3; i++) {
    sales.push(S({ lid: pack.id, m: "eldorado", p: 6, t: NOW - (4 + i) * DAY }));
    sales.push(S({ lid: lot.id, m: "ggsel", p: 4, t: NOW - (4 + i) * DAY }));
  }
  const run = M.buildRun(bundle({ listings: [pack, lot], sales, demand: [DR()] }));
  const ev = run.ctx.ev;
  assert.ok(!ev.orders.some((o) => o.lid === pack.id || o.lid === lot.id), "no order from a pack or a lot");
  assert.equal(ev.salesBefore.filter((s) => s.lid === pack.id || s.lid === lot.id).length, 6, "every unit is still demand");
  for (const m of ["gameflip", "ggsel", "eldorado"]) {
    const r = RF.refFor(ev, { g: G, m, ck: CK, bk: BK, ex: true, n: 1 });
    assert.ok(!["exact-here", "band-here", "translated"].includes(r.basis), m + " priced from a pack or a lot: " + r.basis);
  }
  for (const r of [pack, lot]) {
    assert.equal(ev.byId.get(r.id).advisable, false);
    assert.ok(!run.fc.some((f) => f.l === r.id));
  }
  assert.equal(cellOf(run, G, "claim", "all").old.cur, 0, "a pack's quantity is not single-unit stock");
  assert.ok(!run.rows.some((r) => r.k === G && r.m === "eldorado"), "a pack alone opens no cell to advise");
});

T("R4 rent-farm windows count for nothing: planted G's run is identical with them removed", () => {
  const b = smallBundle();
  const farmIds = new Set(b.listings.filter((l) => l.kind === "farm").map((l) => l.id));
  assert.ok(farmIds.size > 0 && b.listings.some((l) => l.kind === "farm" && l.g === PLANTED.G.game));
  assert.equal(b.sales.filter((s) => farmIds.has(s.lid)).length, PLANTED.G.sales);
  const run = smallRun();
  const ev = run.ctx.ev;
  assert.ok(!ev.rows.some((r) => farmIds.has(r.id)), "no row");
  assert.ok(!ev.orders.some((o) => farmIds.has(o.lid) || o.p === PLANTED.G.price), "no order");
  assert.ok(!ev.salesBefore.some((s) => farmIds.has(s.lid)), "no demand");
  const without = Object.assign({}, b, { listings: b.listings.filter((l) => !farmIds.has(l.id)), sales: b.sales.filter((s) => !farmIds.has(s.lid)) });
  const run2 = M.buildRun(without);
  assert.equal(JSON.stringify(run2.rows), JSON.stringify(run.rows), "the run does not change at all");
  assert.equal(JSON.stringify(run2.fc), JSON.stringify(run.fc));
});

T("R5 account listings are never advised and stay out of the curve; their sales count as the ledger keeps them", () => {
  const acc = [0, 1, 2].map((i) => L({ kind: "account", p: 2.5, st: "sold", c: NOW - (10 + i) * DAY }));
  const live = L({ kind: "account", p: 2.5, c: NOW - 2 * DAY });
  const sales = acc.map((r) => S({ lid: r.id, p: 2.5, t: r.c + DAY }));
  sales.push(S({ p: 9, src: "shop" }));
  const run = M.buildRun(bundle({ listings: acc.concat([live]), sales, demand: [DR()] }));
  const ev = run.ctx.ev;
  for (const r of acc.concat([live])) {
    assert.equal(ev.byId.get(r.id).advisable, false);
    assert.ok(!run.fc.some((f) => f.l === r.id));
  }
  assert.equal(run.ctx.hz.claim.markets.gameflip, undefined, "no exposure of an account row in the curve");
  const ref = RF.refFor(ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.deepEqual([ref.basis, ref.ref, ref.n], ["exact-here", 2.5, 3], "the ledger keeps their sales: price evidence");
  assert.ok(!ev.orders.some((o) => o.p === 9), "a shop sale is demand only");
  assert.equal(ev.salesBefore.length, 4);
});

T("R6 the owner's GGSel switch off blocks like Digiseller: no price, no shelf, no fit, and its orders never teach another market", () => {
  const gg = curve({ m: "ggsel", soldP: 3, sellDays: 1, nLive: 1, liveP: 3, liveAge: 3 });
  const mk = (on) => bundle({ listings: gg.listings, sales: filler().concat(gg.sales), demand: [DR()], af: { takes: Object.assign({}, TAKES, { ggsel: on }) } });
  const live = gg.listings[gg.listings.length - 1];
  const on = M.buildRun(mk(true));
  assert.equal(RF.refFor(on.ctx.ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 }).basis, "translated", "control: GGSel's orders translate while it is on");
  assert.ok(on.ctx.hz.claim.markets.ggsel, "control: GGSel is fitted while on");
  assert.ok(on.fc.some((f) => f.l === live.id), "control: its live row is advised while on");
  const off = M.buildRun(mk(false));
  const ev = off.ctx.ev;
  assert.equal(ev.markets.ggsel.blocked, true);
  const gf = RF.refFor(ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.notEqual(gf.basis, "translated", "a switched-off market never teaches another");
  assert.ok(!(gf.ref > 1.6), "GGSel's $3 never reaches Gameflip: " + gf.ref);
  assert.equal(RF.refFor(ev, { g: G, m: "ggsel", ck: CK, bk: BK, ex: true, n: 1 }).basis, "exact-here", "history describes only itself");
  assert.equal(off.ctx.hz.claim.markets.ggsel, undefined, "never fitted");
  assert.ok(!off.fc.some((f) => f.l === live.id), "its live row is history, not advised");
  const cell = cellOf(off, G, "claim", "ggsel");
  assert.deepEqual([cell.pc, cell.sc, cell.br.p, cell.br.sh], ["managed", "closed", null, 0]);
  assert.ok(cell.fl.includes("blocked"));
  assert.equal(off.ctx.placements.get(G + "|claim").elig.ggsel, "closed");
  assert.equal(M.priceForRun(off, { marketplace: "ggsel", basePriceUsd: 1.2, game: "Alpha Quest" }).confidence, "none");
  // each layer refuses on its own: the offer pricer, asked directly, prices nothing on a blocked market
  const direct = P.priceOffer(off.ctx, { g: G, f: "claim", m: "ggsel", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: null, base: 1.2 });
  assert.deepEqual([direct.p, direct.raw, direct.action], [null, null, "none"]);
  assert.ok(direct.gates.includes("closed"));
  const dig = P.priceOffer(on.ctx, { g: G, f: "claim", m: "digiseller", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: null, base: 1.3 });
  assert.deepEqual([dig.p, dig.action], [null, "none"], "Digiseller too");
});

T("R7 every row carries its farm and the two farms are fitted apart", () => {
  const claim = curve({ soldP: 1.5, sellDays: 1, nLive: 3, liveP: 1.5, liveAge: 3 });
  const nc = curve({ f: "noclaim", o: "unclaimed", ck: "s:nc", soldP: 1.5, sellDays: 0.25, nSold: 8, nLive: 3, liveP: 1.5, liveAge: 1, start: 3 });
  const demand = [DR(), DR({ f: "noclaim", w: 9, on: 9 })];
  const both = M.buildRun(bundle({ listings: claim.listings.concat(nc.listings), sales: claim.sales.concat(nc.sales), demand }));
  const only = M.buildRun(bundle({ listings: claim.listings, sales: claim.sales, demand }));
  assert.deepEqual(both.ctx.hz.claim, only.ctx.hz.claim, "the no-claim farm's rows never move the claim farm's curve");
  assert.equal(only.ctx.hz.noclaim.markets.gameflip, undefined);
  assert.equal(both.ctx.hz.noclaim.markets.gameflip.S, 8);
  assert.ok(both.ctx.hz.noclaim.markets.gameflip.h > 3 * both.ctx.hz.claim.markets.gameflip.h, "each farm keeps its own speed");
  for (const r of both.rows) assert.ok(r.f === "claim" || r.f === "noclaim");
  assert.ok(cellOf(both, G, "claim", "gameflip") && cellOf(both, G, "noclaim", "gameflip"), "one game, one cell per farm");
  for (const f of both.fc) assert.equal(f.f, both.ctx.ev.byId.get(f.l).f);
});

/** A no-claim world on one market: `nSold` exact sales of CK at `soldP` inside the last 30 days. */
function ncWorld({ m = "gameflip", soldP = 1.5, nSold = 10, pricing = {}, dr = {}, extraSales = [], ck = CK, f = "noclaim", nLive = 0, dearP = null } = {}) {
  const o = f === "noclaim" ? "unclaimed" : "auto";
  const c = curve({ m, f, o, ck, soldP, sellDays: 0.5, nSold, nLive, liveP: soldP, liveAge: 1, start: 3 });
  // `dearP`: four rows that sold at that price too, so the curve is evidenced up there
  const d = dearP ? curve({ m, f, o, ck, soldP: dearP, sellDays: 1, nSold: 4, nLive: 0, start: 14 }) : { listings: [], sales: [] };
  const p = Object.assign({ floorUsd: 0.75, ceilingUsd: 4.5, gameFloors: {}, itemStepPct: 15, itemCapMult: 2.5, fullEventBonusPct: 25 }, pricing);
  return ctxOf(bundle({ listings: c.listings.concat(d.listings), sales: c.sales.concat(d.sales, extraSales), demand: [DR(Object.assign({ f, w: 4, on: 12 }, dr))], pricing: p }));
}
const newOffer = (ctx, o = {}) => P.priceOffer(ctx, Object.assign({ g: G, f: "noclaim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: null, base: null, np: null }, o));

T("R8 a no-claim system row gets a full verdict and is compared with today's bundlePrice", () => {
  const c = curve({ f: "noclaim", o: "unclaimed", soldP: 1.5, sellDays: 0.5, nSold: 10, nLive: 2, liveP: 1.5, liveAge: 2, start: 3 });
  const old = { games: {}, offers: { ["gameflip|" + CK]: { np: 1.25 } } };
  const run = M.buildRun(bundle({ listings: c.listings, sales: c.sales, demand: [DR({ f: "noclaim", w: 6, on: 12 })], old }));
  const cell = cellOf(run, G, "noclaim", "gameflip");
  assert.equal(cell.old.np, 1.25, "today's bundlePrice answer sits beside the brain");
  assert.equal(cell.pol.old, 1.5, "and today's live ask is the old policy");
  assert.equal(cell.br.cf, "high");
  assert.ok(cell.br.p > 0 && cell.br.p7 !== null, "a full verdict: a price and a sell chance");
  assert.ok(!["managed", "no-evidence"].includes(cell.pc), cell.pc);
  const fc = run.fc.filter((x) => x.f === "noclaim");
  assert.equal(fc.length, 2, "every live no-claim system row is forecast");
  for (const x of fc) assert.ok(["hold", "lower", "raise", "test"].includes(x.a));
});

// Overstock on GGSel evidence at $1.00 (fast) and $1.35 (slower): the brain alone asks $1.00. (GGSel:
// no Gameflip sale, so no sold floor; a new listing, so no GGSel base to hold.)
const lowWorld = (pricing = {}, f = "noclaim") => ncWorld({ m: "ggsel", f, soldP: 1.0, dearP: 1.35, dr: { w: 1, on: 40 }, pricing });
const lowOffer = (ctx, o = {}) => newOffer(ctx, Object.assign({ m: "ggsel" }, o));

T("R8 no-claim limits: never under the owner's no-claim floor", () => {
  const free = lowOffer(lowWorld());
  assert.equal(free.p, 1, "control: the brain alone asks the fastest price");
  const v = lowOffer(lowWorld({ floorUsd: 1.2 }));
  assert.ok(v.p !== null && v.p >= 1.2, "never under the no-claim floor: " + v.p);
  assert.equal(v.floor, 1.2);
  // a claim offer never reads the no-claim pricing
  const claim = lowOffer(lowWorld({ floorUsd: 1.2 }, "claim"), { f: "claim" });
  assert.equal(claim.p, 1, "the claim farm ignores it");
});

T("R8 no-claim limits: never under the game's own no-claim floor (settings' substring rule)", () => {
  const v = lowOffer(lowWorld({ gameFloors: { Zeta: 3, "ALPHA quest": 1.3 } }));
  assert.ok(v.p !== null && v.p >= 1.3, "the floor of the key the game's label contains: " + v.p);
  assert.equal(P.noclaimLimits(ncWorld({ pricing: { gameFloors: { "Alpha Quest": 1.3 } } }).ev, G).gameFloor, 1.3);
  const other = lowOffer(lowWorld({ gameFloors: { "Beta Arena": 3 } }));
  assert.equal(other.p, 1, "another game's floor never applies");
});

T("R8 no-claim limits: never over the no-claim ceiling (0 or missing reads $4.50); claim offers ignore it", () => {
  // GGSel evidence (no Gameflip sale, so no sold floor) for a new listing
  const free = newOffer(ncWorld({ m: "ggsel", soldP: 2 }), { m: "ggsel" });
  assert.ok(free.p > 1.6, "control: the brain alone asks " + free.p);
  const v = newOffer(ncWorld({ m: "ggsel", soldP: 2, pricing: { ceilingUsd: 1.6 } }), { m: "ggsel" });
  assert.ok(v.p > 0 && v.p <= 1.6, "never over the ceiling: " + v.p);
  const zero = newOffer(ncWorld({ m: "ggsel", soldP: 2, pricing: { ceilingUsd: 0 } }), { m: "ggsel" });
  assert.equal(zero.p, free.p, "a ceiling of 0 is unset, not $0");
  const big = newOffer(ncWorld({ m: "ggsel", soldP: 6, pricing: { ceilingUsd: 0 } }), { m: "ggsel" });
  assert.ok(big.p > 0 && big.p <= 4.5, "unset reads bundlePrice's $4.50: " + big.p);
  const claim = newOffer(ncWorld({ m: "ggsel", f: "claim", soldP: 2, pricing: { ceilingUsd: 1.6 } }), { m: "ggsel", f: "claim" });
  assert.ok(claim.p > 1.6, "the claim farm ignores the no-claim ceiling: " + claim.p);
  // a GGSel row already over the ceiling is held there, never advised down: GGSel is raise-only
  const gctx = ncWorld({ m: "ggsel", soldP: 2, nLive: 1, pricing: { ceilingUsd: 1.6 } });
  const R = gctx.ev.rows.find((r) => r.activeAtCut);
  const lv = P.priceOffer(gctx, { g: G, f: "noclaim", m: "ggsel", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: [R] });
  assert.notEqual(lv.live[0].a, "lower");
  assert.ok(lv.live[0].p === null || lv.live[0].p >= R.ask, "GGSel " + lv.live[0].p + " vs ask " + R.ask);
});

T("R8 no-claim limits: the 30-day sold floor is the one thing allowed above the ceiling", () => {
  // the evidence is the band's (other items): our offer has no Gameflip sale of its own to start with
  const world = (extraSales) => ncWorld({ ck: "s:band", soldP: 1.5, pricing: { ceilingUsd: 1.2 }, extraSales });
  const w = newOffer(world([]));
  assert.ok(w.p > 0 && w.p <= 1.2, "control: with no sold floor the ceiling binds: " + w.p);
  const sale = S({ f: "noclaim", o: "unclaimed", p: 2.4, t: NOW - 5 * DAY });
  const v = newOffer(world([sale]));
  assert.ok(v.p >= 2.4, "these exact items sold at $2.40 on Gameflip this month: " + v.p);
  assert.ok(v.gates.includes("ceiling") && v.gates.includes("sold-floor"), v.gates.join(","));
  assert.ok(v.gates.indexOf("ceiling") < v.gates.indexOf("sold-floor"), "the ceiling first, then the sold floor");
  const x = newOffer(world([Object.assign({}, sale, { grp: "old", t: NOW - 40 * DAY })]));
  assert.ok(x.p <= 1.2, "a sale older than 30 days is no sold floor: " + x.p);
});

T("R8 no-claim limits: a cut-back raise's test unit never goes over the ceiling", () => {
  // the band sells fast at $1.00 (no order of it at $1.50): a raise to $1.50 is cut back, and the one-unit
  // test the brain would suggest instead must stay inside the owner's ceiling
  const band = curve({ f: "noclaim", o: "unclaimed", ck: "s:band", soldP: 1, sellDays: 0.5, nSold: 10, nLive: 0, start: 3 });
  const live = L({ f: "noclaim", o: "unclaimed", ck: CK, p: 1, c: NOW - 0.5 * DAY });
  const at = (ceilingUsd) => {
    const ctx = ctxOf(bundle({ listings: band.listings.concat([live]), sales: band.sales, demand: [DR({ f: "noclaim", w: 4, on: 12 })], pricing: { floorUsd: 0.75, ceilingUsd, gameFloors: {} } }));
    const v = V({ f: "noclaim", raw: 1.5, ref: 1, H: 2, cands: [{ p: 1, evid: true }, { p: 1.5, evid: true }] });
    return P.liveAction(ctx, v, ctx.ev.byId.get(live.id));
  };
  const free = at(4.5);
  assert.deepEqual([free.a, free.p], ["test", 1.35], "control: one unit tested a step up");
  const capped = at(1.2);
  assert.equal(capped.a, "test");
  assert.ok(capped.p <= 1.2, "the test unit stays under the ceiling: " + capped.p);
});

T("R9 an explicit no-claim cap is the owner's (managed); a game on the default cap is advised (planted R)", () => {
  const run = smallRun();
  const [g] = Object.keys(PLANTED.R.explicit);
  const all = cellOf(run, g, "noclaim", "all");
  assert.equal(all.old.cap, PLANTED.R.explicit[g]);
  assert.equal(all.old.capExplicit, true);
  assert.ok(all.fl.includes("managed"));
  for (const m of ["gameflip", "ggsel"]) {
    const c = cellOf(run, g, "noclaim", m);
    if (c) assert.equal(c.sc, "managed", m);
  }
  const d = cellOf(run, PLANTED.R.defaultGame, "noclaim", "all");
  assert.equal(d.old.cap, PLANTED.R.capDefault);
  assert.equal(d.old.capExplicit, false);
  assert.ok(!d.fl.includes("managed"));
  const shelfCells = ["gameflip", "ggsel"].map((m) => cellOf(run, PLANTED.R.defaultGame, "noclaim", m)).filter(Boolean);
  assert.ok(shelfCells.length && shelfCells.every((c) => c.sc !== "managed"), "the default cap is the brain's to advise");
});

T("R10 a ladder's rungs are read as evidence even with no system row of those items", () => {
  const rung = (p, sold) => {
    const r = L({ o: "manual", m: "eldorado", p, qty: 5, c: NOW - 20 * DAY });
    const s = Array.from({ length: sold }, (_, i) => S({ lid: r.id, m: "eldorado", o: "manual", p, basis: "listing-now", t: NOW - (3 + 2 * i) * DAY }));
    return { r, s };
  };
  const a = rung(1, 3);
  const b = rung(2, 1);
  const sys = L({ m: "eldorado", ck: "s:other", p: 1.5, qty: 3, c: NOW - 4 * DAY });
  const fit = (rungs) => ctxOf(bundle({ listings: rungs.map((x) => x.r).concat([sys]), sales: rungs.flatMap((x) => x.s), demand: [DR()] }));
  const lad = fit([a, b]);
  assert.ok(lad.ev.ladders.has("eldorado|" + CK));
  assert.equal(lad.hz.claim.markets.eldorado.S, 4, "both rungs' units teach the curve");
  const one = fit([a]);
  assert.equal(one.ev.ladders.size, 0, "one price is no ladder");
  assert.ok(!one.hz.claim.markets.eldorado || one.hz.claim.markets.eldorado.S === 0, "a lone hand-made offer stays out");
});

T("R11 the floor is applied last: a step limit never leaves a price under the floor", () => {
  const orders = [S({ p: 3 }), S({ p: 3 })];
  const ev = E.buildEvidence(bundle({ sales: orders }), { cfg: CFG(), cut: NOW });
  const c = P.gateChain({ ev, hz: {} }, V({ cands: [{ p: 3, evid: true }], ref: 3 }), { raw: 3, base: 1, floor: 2 });
  // raise allowed (two orders at $3) → step to $1.35 → the floor lifts it to $2; the floor before the
  // step would have ended at $1.35, under the floor
  assert.equal(c.p, 2);
  assert.deepEqual(c.gates, ["step", "floor"]);
});

T("R11 a live row is never advised under its own venueMinPriceUsd", () => {
  const R = L({ p: 1.7, vmin: 1.4, c: NOW - 2 * DAY });
  const ev = E.buildEvidence(bundle({ listings: [R], demand: [DR()] }), { cfg: CFG(), cut: NOW });
  const row = ev.byId.get(R.id);
  assert.equal(row.floor, 1.4);
  const v = V({ raw: 1, ref: 1, cands: [{ p: 1, evid: true }] });
  const out = P.liveAction({ ev, hz: {}, prior: new Map() }, v, row);
  // the step limit alone would say $1.15 (35 % under $1.70); the row's own minimum says $1.40
  assert.equal(out.a, "lower");
  assert.equal(out.p, 1.4);
  assert.ok(out.gates.includes("floor"));
  const plain = P.liveAction({ ev, hz: {}, prior: new Map() }, v, Object.assign({}, row, { floor: 0.75 }));
  assert.equal(plain.p, 1.15, "control: without the row's minimum the step decides");
});

T("R11 a new GGSel listing is never priced under the game's hidden GGSel minimum", () => {
  const cheap = curve({ m: "ggsel", soldP: 1, sellDays: 1, nSold: 10, nLive: 0, start: 5 });
  const dear = curve({ m: "ggsel", soldP: 1.75, sellDays: 2, nSold: 4, nLive: 0, start: 20 });
  const hit = L({ m: "ggsel", p: 1.6, vmin: 1.6, st: "removed", c: NOW - 40 * DAY, u: NOW - 39 * DAY });
  const at = (extra) => {
    const ctx = ctxOf(bundle({ listings: cheap.listings.concat(dear.listings, extra), sales: cheap.sales.concat(dear.sales), demand: [DR({ w: 1, on: 40 })] }));
    return P.priceOffer(ctx, { g: G, f: "claim", m: "ggsel", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: null, base: null });
  };
  const free = at([]);
  assert.ok(free.p !== null && free.p < 1.6, "control: overstock alone sells at " + free.p);
  const v = at([hit]);
  assert.equal(v.floor, 1.6, "a GGSel row of this game once hit a $1.60 minimum");
  assert.ok(v.p !== null && v.p >= 1.6, "so a new listing starts there: " + v.p);
});

T("R12 GGSel is raise-only across a whole run: no GGSel row is ever advised under its ask", () => {
  const run = largeRun();
  let ggLive = 0;
  let wantedLower = 0;
  for (const o of run.offers) {
    if (o.m !== "ggsel") continue;
    for (const l of o.live) {
      ggLive++;
      assert.notEqual(l.a, "lower", "a GGSel row advised down");
      if (l.p !== null) assert.ok(l.p >= l.ask - 1e-9, "GGSel " + l.p + " under its ask " + l.ask);
      if (o.raw !== null && o.raw < l.ask - 0.1) wantedLower++;
    }
  }
  assert.ok(ggLive > 10, "the large fixture has live GGSel rows: " + ggLive);
  assert.ok(wantedLower > 0, "and the curve wanted some of them lower (the rule binds): " + wantedLower);
  const gfLower = run.offers.filter((o) => o.m === "gameflip").flatMap((o) => o.live).filter((l) => l.a === "lower").length;
  assert.ok(gfLower > 0, "control: Gameflip rows do come down");
});

T("R13 a raise needs our own orders on THIS market at or above it; elsewhere, rivals and the engine never lift a price", () => {
  const sales = [3, 3, 3].map((p) => S({ p }));
  const ev = E.buildEvidence(bundle({ sales }), { cfg: CFG(), cut: NOW });
  const ctx = { ev, hz: {} };
  const cands = [
    { p: 1.5, evid: true },
    { p: 3, evid: true },
  ];
  const here = P.gateChain(ctx, V({ m: "gameflip", cands }), { raw: 3, base: 1.5, floor: 0.75 });
  assert.ok(!here.gates.includes("raise-rule"), "control: three orders at $3 here allow the raise");
  assert.equal(here.p, 2, "then the step limit takes it");
  const there = P.gateChain(ctx, V({ m: "eldorado", basis: "translated", conf: "medium", cands }), { raw: 3, base: 1.5, floor: 0.5 });
  assert.equal(there.p, 1.5, "Gameflip's orders never lift Eldorado's price");
  assert.ok(there.gates.includes("raise-rule"));
  for (const basis of ["rivals", "venue", "none"]) {
    const c = P.gateChain(ctx, V({ basis, conf: "medium", cands }), { raw: 3, base: 1.5, floor: 0.75 });
    assert.equal(c.p, 1.5, basis + " never raises");
    assert.ok(c.gates.includes("raise-rule"));
  }
});

T("R13 repeated stock-outs open a raise without orders at the higher price", () => {
  const mk = (soldElsewhere) => {
    const r1 = L({ st: "sold", c: NOW - 20 * DAY });
    const r2 = L({ st: "sold", c: NOW - 10 * DAY });
    const sales = [S({ lid: r1.id, t: NOW - 19 * DAY }), S({ lid: r2.id, t: NOW - 9 * DAY })];
    if (soldElsewhere) sales.push(S({ m: "ggsel", p: 1.3, t: NOW - 5 * DAY }));
    const ev = E.buildEvidence(bundle({ listings: [r1, r2], sales }), { cfg: CFG(), cut: NOW });
    return { so: P.stockoutsOf(ev, G, "claim", "gameflip"), c: P.gateChain({ ev, hz: {} }, V({ cands: [{ p: 3, evid: true }] }), { raw: 3, base: 1.5, floor: 0.75 }) };
  };
  const yes = mk(true);
  assert.equal(yes.so.ok, true, JSON.stringify(yes.so));
  assert.ok(yes.so.empty >= 0.3 && yes.so.here >= 2);
  assert.ok(!yes.c.gates.includes("raise-rule"));
  assert.equal(yes.c.p, 2, "the raise goes through, one step at a time");
  const no = mk(false);
  assert.equal(no.so.ok, false, "an empty shelf while nobody bought elsewhere is not a stock-out");
  assert.equal(no.c.p, 1.5);
});

T("R14 no farm-brain row makes the game unknown: no price, no move, no shelf, today's answers", () => {
  const c = curve({ soldP: 1.5, sellDays: 0.5, nLive: 3, liveP: 2.5, liveAge: 20 });
  const run = M.buildRun(bundle({ listings: c.listings, sales: c.sales, demand: [] }));
  const cells = run.rows.filter((r) => r.k === G && r.m !== "all");
  assert.ok(cells.length);
  for (const r of cells) {
    assert.equal(r.br.rg, "unknown");
    assert.equal(r.br.p, null, "no price is guessed");
    assert.equal(r.br.a.lower + r.br.a.raise + r.br.a.test, 0, "no move");
    assert.ok(["unknown", "closed", "managed", "unmeasured"].includes(r.sc), r.m + " " + r.sc);
  }
  assert.ok(run.fc.length > 0 && run.fc.every((f) => f.a === "hold"), "the stale rows are held, not lowered");
  const pl = run.ctx.placements.get(G + "|claim");
  assert.equal(pl.unknown, true);
  assert.equal(pl.reserve, pl.stock);
  assert.deepEqual(M.shelfForRun(run, { game: "Alpha Quest", stock: 6 }).shelf, {});
  const p = M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 1.25, game: "Alpha Quest" });
  assert.deepEqual([p.price, p.confidence], [1.25, "none"]);
  assert.equal(M.valueForRun(run, G).value, null);
});

T("R14 a farm-brain row older than maxDemandAgeH is stale; the age is configurable", () => {
  const gs = (ageH, cfg = CFG()) => P.gameState(E.buildEvidence(bundle({ demand: [DR({ at: NOW - ageH * HOUR })] }), { cfg, cut: NOW }), G, "claim");
  assert.notEqual(gs(5.9).regime, "unknown");
  assert.equal(gs(6.1).regime, "unknown");
  assert.notEqual(gs(6.1, CFG({ maxDemandAgeH: 12 })).regime, "unknown", "a longer configured age keeps it");
  assert.equal(gs(-1).regime, "unknown", "a row from the future is not fresh either");
});

/* ------------------------------------------------------------------------------------------------------ */
/* brief §3a: the two farms                                                                               */
/* ------------------------------------------------------------------------------------------------------ */

/** Gameflip and GGSel evidence for one farm, recent enough for the no-claim fit. */
function twoMarkets(f, extra = {}) {
  const o = f === "noclaim" ? "unclaimed" : "auto";
  const a = curve({ f, o, soldP: 1.5, sellDays: 0.5, nSold: 8, nLive: 1, liveP: 1.5, liveAge: 1, start: 3 });
  const b = curve({ f, o, m: "ggsel", soldP: 1.4, sellDays: 1, nSold: 6, nLive: 1, liveP: 1.4, liveAge: 1, start: 3 });
  return bundle(Object.assign({ listings: a.listings.concat(b.listings), sales: a.sales.concat(b.sales) }, extra));
}
const placeQ = (f, stock) => ({ g: G, f, stock, nets: { gameflip: 1.38, ggsel: 1.26 }, prices: { gameflip: 1.5, ggsel: 1.4 }, cur: {}, oldShelf: null });

T("R15 no-claim stock is never held back: its shelf ignores the regime and any value threshold", () => {
  const at = (on, cfg = CFG(), f = "noclaim") => {
    const ctx = ctxOf(twoMarkets(f, { demand: [DR({ f, w: 9, on })] }), cfg);
    return { gs: P.gameState(ctx.ev, G, f), pl: PL.placeGame(ctx, placeQ(f, 12)) };
  };
  const scarce = at(1);
  const over = at(80);
  assert.equal(scarce.gs.regime, "scarce");
  assert.equal(over.gs.regime, "overstock");
  assert.deepEqual(scarce.pl.shelf, over.pl.shelf, "scarce never means listing fewer");
  assert.equal(scarce.pl.reserve, over.pl.reserve);
  // no value threshold keeps a perishable unit back: every unit is on a shelf or in the pool
  const strict = at(9, CFG({ minMarginalUsd: 5 }));
  const loose = at(9, CFG({ minMarginalUsd: 0.1 }));
  assert.deepEqual(strict.pl.shelf, loose.pl.shelf);
  assert.ok(sum(strict.pl.shelf) > 0, "the shelf is filled whatever a unit is worth");
  assert.equal(sum(strict.pl.shelf) + strict.pl.reserve + strict.pl.bulkTake, 12);
  assert.ok(strict.pl.pool && strict.pl.pool.units === strict.pl.reserve + strict.pl.bulkTake, "what is not shelved is the pool claim-at-sale offers sell from");
  // control: the claim farm does hold back a unit worth less than the threshold
  const claim = at(9, CFG({ minMarginalUsd: 5 }), "claim");
  assert.equal(sum(claim.pl.shelf), 0);
  assert.equal(claim.pl.reserve, 12);
});

T("R15 little time left is overstock, and time left caps the no-claim horizon of the price and the shelf", () => {
  const at = (endInH) => {
    const waves = [{ g: G, ev: "Ev", wave: "Week 1", startAt: NOW - 5 * DAY, endAt: NOW + endInH * HOUR }];
    const units = Array.from({ length: 6 }, () => ({ g: G, m: "gameflip", st: "listed", l: NOW - 2 * DAY, s: null, p: 0, sm: null, x: null, lids: [], bk: "", camps: ["Ev Week 1"] }));
    const ctx = ctxOf(twoMarkets("noclaim", { demand: [DR({ f: "noclaim", w: 9, on: 1 })], noclaim: { units, waves } }));
    const gs = P.gameState(ctx.ev, G, "noclaim");
    const v = newOffer(ctx);
    const pl = PL.placeGame(ctx, placeQ("noclaim", 6));
    return { gs, v, pl };
  };
  const soon = at(12);
  assert.equal(soon.gs.regime, "overstock", "it sells now or it expires, however thin the shelf");
  near(soon.gs.perishDays, 0.5, 1e-9);
  near(soon.v.H, 0.5, 1e-9, "the price is judged over the 12 h left");
  near(soon.pl.horizon.gameflip, 0.5, 1e-3, "the shelf's horizon too");
  near(soon.pl.horizon.ggsel, 0.5, 1e-3);
  const later = at(720);
  assert.equal(later.gs.regime, "scarce", "control: with time left the thin shelf is scarce");
  assert.equal(later.v.H, 2, "and the price horizon is the farm's own");
  assert.equal(later.pl.horizon.gameflip, 14);
});

T("R16 the horizon is set per farm and each farm's sell chance uses its own", () => {
  const claim = curve({ soldP: 1.5, sellDays: 0.5, nSold: 8, nLive: 2, liveP: 1.5, liveAge: 1, start: 3 });
  const nc = curve({ f: "noclaim", o: "unclaimed", ck: "s:nc", soldP: 1.5, sellDays: 0.5, nSold: 8, nLive: 2, liveP: 1.5, liveAge: 1, start: 3 });
  const b = bundle({ listings: claim.listings.concat(nc.listings), sales: claim.sales.concat(nc.sales), demand: [DR({ w: 4, on: 12 }), DR({ f: "noclaim", w: 4, on: 12 })] });
  const run = M.buildRun(b);
  assert.equal(run.ctx.hz.claim.horizon, 7);
  assert.equal(run.ctx.hz.noclaim.horizon, 2);
  const fcOf = (r, f) => r.fc.filter((x) => x.f === f);
  assert.ok(fcOf(run, "claim").length === 2 && fcOf(run, "claim").every((x) => x.h === 7));
  assert.ok(fcOf(run, "noclaim").length === 2 && fcOf(run, "noclaim").every((x) => x.h === 2));
  const run4 = M.buildRun(b, { cfg: { horizonDaysNoclaim: 4 } });
  assert.ok(fcOf(run4, "noclaim").every((x) => x.h === 4));
  assert.ok(fcOf(run4, "noclaim")[0].p > fcOf(run, "noclaim")[0].p, "a longer horizon, a higher sell chance");
  assert.deepEqual(fcOf(run4, "claim"), fcOf(run, "claim"), "the claim farm's horizon is its own");
});

T("R17 bulk's expected take is set aside before any single shelf is filled", () => {
  const c = curve({ soldP: 1.5, sellDays: 1, nSold: 10, nLive: 0, start: 5 });
  const bulk = Array.from({ length: 30 }, (_, i) => ({ g: G, m: "eldorado", f: "claim", t: NOW - (i + 0.5) * DAY, src: "bulk" }));
  const mk = (demandOnly, on) => M.buildRun(bundle({ listings: c.listings, sales: c.sales, demandOnly, demand: [DR({ w: 20, on })] })).ctx.placements.get(G + "|claim");
  const none = mk([], 6);
  assert.ok(sum(none.shelf) > 0, "control: without bulk the stock goes on the shelves");
  const all = mk(bulk, 6);
  assert.equal(all.bulkTake, 6, "bulk's 14-day take (7/wk) covers the whole stock");
  assert.equal(sum(all.shelf), 0, "so no single shelf gets a unit, however strong single demand is");
  assert.equal(all.reserve, 0);
  assert.ok(all.why.some((w) => /^Bulk takes about/.test(w)), "logged as its own line");
  const part = mk(bulk, 20);
  assert.equal(part.bulkTake, 14);
  assert.equal(sum(part.shelf) + part.reserve, 6, "only what bulk leaves is placed");
});

T("R18 bulk's per-account prices are their own series and never move a single-unit price", () => {
  const c = curve({ soldP: 1.5, sellDays: 1, nLive: 2, liveP: 1.5, liveAge: 3 });
  const base = { listings: c.listings, sales: c.sales, demand: [DR()] };
  const series = Array.from({ length: 5 }, (_, i) => ({ g: G, m: "gameflip", t: NOW - (i + 1) * DAY, pa: 0.3, size: 5 }));
  const run = M.buildRun(bundle(Object.assign({ bulkPrices: series }, base)));
  const plain = M.buildRun(bundle(base));
  assert.deepEqual(run.ctx.ev.bulk.perAccount.get(G), [0.3, 0.3, 0.3, 0.3, 0.3], "kept as its own series");
  assert.ok(!run.ctx.ev.orders.some((o) => o.p === 0.3));
  assert.equal(JSON.stringify(run.rows), JSON.stringify(plain.rows), "and nothing a single listing is told changes");
});

T("R19 a bulk market with a live or recently sent pack carries bulk-anchor and shows the pack prices", () => {
  const el = curve({ m: "eldorado", soldP: 2, sellDays: 2, nLive: 1, liveP: 2, liveAge: 3 });
  const gf = curve({ soldP: 1.5, sellDays: 1, nLive: 1, liveP: 1.5, liveAge: 3 });
  const g2 = curve({ m: "g2g", soldP: 2, sellDays: 2, nLive: 1, liveP: 2, liveAge: 3 });
  const bulkCfg = { markets: ["eldorado", "gameflip"], tiers: [{ size: 5, discountPct: 10 }, { size: 10, discountPct: 20 }], reserveSingles: 0 };
  const mk = (extraListings, bulkPrices = []) =>
    M.buildRun(bundle({ listings: el.listings.concat(gf.listings, g2.listings, extraListings), sales: el.sales.concat(gf.sales, g2.sales), bulk: bulkCfg, bulkPrices, demand: [DR()] }));
  const packOn = (m, st = "active") => L({ kind: "bulk", pack: 5, m, p: 9, qty: 5, st });
  const live = mk([packOn("eldorado")]);
  const cell = cellOf(live, G, "claim", "eldorado");
  assert.ok(cell.fl.includes("bulk-anchor"), "a pack of the game is live on this bulk market");
  const offers = live.offers.filter((o) => o.k === G && o.m === "eldorado" && o.p !== null);
  assert.ok(offers.length > 0);
  for (const o of offers) assert.deepEqual(o.packs, [{ size: 5, pa: U.round2(o.p * 0.9) }, { size: 10, pa: U.round2(o.p * 0.8) }], "the packs this single price would produce");
  assert.ok(!cellOf(live, G, "claim", "gameflip").fl.includes("bulk-anchor"), "no pack on Gameflip: no anchor there");
  assert.ok(cellOf(mk([], [{ g: G, m: "eldorado", t: NOW - 10 * DAY, pa: 1.6, size: 5 }]), G, "claim", "eldorado").fl.includes("bulk-anchor"), "a pack sent in the window");
  assert.ok(!cellOf(mk([], [{ g: G, m: "eldorado", t: NOW - 40 * DAY, pa: 1.6, size: 5 }]), G, "claim", "eldorado").fl.includes("bulk-anchor"), "a pack sent long ago is not");
  assert.ok(!cellOf(mk([packOn("eldorado", "sold")]), G, "claim", "eldorado").fl.includes("bulk-anchor"), "nor a pack no longer live");
  assert.ok(!cellOf(mk([packOn("g2g")]), G, "claim", "g2g").fl.includes("bulk-anchor"), "G2G is not a bulk market here");
});

T("R21 within one event a bundle that contains another is never priced below it; other events are never compared", () => {
  const row = (ck, n, p) => L({ f: "noclaim", o: "unclaimed", ck, bk: G + "|" + (n === 1 ? "1" : n <= 3 ? "2-3" : "4-6"), n, p, c: NOW - DAY });
  const A = row("s:a", 1, 2);
  const B = row("s:b", 3, 1);
  const C = row("s:c", 5, 1);
  const unit = (r, bk) => ({ g: G, m: "gameflip", st: "listed", l: NOW - DAY, s: null, p: 0, sm: null, x: null, lids: [r.id], bk, camps: [] });
  const units = [unit(A, "ev one|week 1"), unit(B, "ev one|week 1+week 2"), unit(C, "ev two|week 1")];
  const ctx = ctxOf(bundle({ listings: [A, B, C], noclaim: { units, waves: [] }, demand: [DR({ f: "noclaim", w: 4, on: 12 })] }));
  const v = [A, B, C].map((r) => {
    const R = ctx.ev.byId.get(r.id);
    return P.priceOffer(ctx, { g: G, f: "noclaim", m: "gameflip", ck: R.ck, bk: R.bk, ex: true, n: R.n, band: R.band, live: [R], defer: true });
  });
  P.applyContainment(ctx, v);
  const [a, b, c] = v;
  assert.equal(a.p, 2);
  assert.ok(b.p >= a.p, "the week 1+2 bundle contains week 1: never cheaper (" + b.p + " vs " + a.p + ")");
  assert.ok(b.gates.includes("containment"));
  assert.equal(c.p, 1, "another event's bundle is never compared");
  assert.ok(!c.gates.includes("containment"));
});

T("R22 a thin no-claim cell starts from today's bundlePrice answer, logged as the cell's new-listing price", () => {
  const r = L({ f: "noclaim", o: "unclaimed", p: 1.25, c: NOW - DAY });
  const old = { games: {}, offers: { ["gameflip|" + CK]: { np: 1.75 } } };
  const run = M.buildRun(bundle({ listings: [r], old, demand: [DR({ f: "noclaim", w: 4, on: 12 })] }));
  const o = run.offers.find((x) => x.k === G && x.f === "noclaim" && x.m === "gameflip");
  assert.equal(o.thin, true);
  assert.equal(o.raw, 1.75, "not from nothing, and not from its own ask");
  assert.equal(o.np, 1.75);
  assert.equal(cellOf(run, G, "noclaim", "gameflip").old.np, 1.75);
});

/* ------------------------------------------------------------------------------------------------------ */
/* plan §4: the model                                                                                     */
/* ------------------------------------------------------------------------------------------------------ */

T("R24 two sets of one game on one market are two offers with their own references", () => {
  const one = curve({ ck: CK, soldP: 1, sellDays: 1, nSold: 5, nLive: 1, liveP: 1, liveAge: 2 });
  const two = curve({ ck: "s:two", soldP: 3, sellDays: 1, nSold: 5, nLive: 1, liveP: 3, liveAge: 2 });
  const run = M.buildRun(bundle({ listings: one.listings.concat(two.listings), sales: one.sales.concat(two.sales), demand: [DR()] }));
  const offers = run.offers.filter((o) => o.k === G && o.f === "claim" && o.m === "gameflip");
  assert.equal(offers.length, 2, "same game, same size, different items: two offers");
  const by = Object.fromEntries(offers.map((o) => [o.ck, o]));
  assert.equal(by[CK].ref, 1);
  assert.equal(by["s:two"].ref, 3);
  assert.equal(by[CK].basis, "exact-here");
  const ids = (ck) => new Set(by[ck].live.map((l) => l.id));
  assert.ok(ids(CK).has(one.listings[one.listings.length - 1].id) && !ids(CK).has(two.listings[two.listings.length - 1].id), "each live row is judged against its own offer");
  assert.equal(run.rows.filter((r) => r.k === G && r.f === "claim" && r.m === "gameflip").length, 1, "one cell");
});

T("R25 the reference cascade takes the first step that gives a price, in order, with its confidence", () => {
  const q = { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 };
  const band = (n, p) => Array.from({ length: n }, (_, i) => S({ ck: "s:band" + i, p }));
  const ref = (b, qq = q) => RF.refFor(ctxOf(b).ev, qq);
  const exact3 = ref(bundle({ sales: band(10, 1).concat([2, 2, 2].map((p) => S({ p }))) }));
  assert.deepEqual([exact3.basis, exact3.conf, exact3.ref], ["exact-here", "high", 2], "3 exact orders beat 10 of the band");
  const exact2 = ref(bundle({ sales: band(10, 1).concat([2, 2].map((p) => S({ p }))) }));
  assert.deepEqual([exact2.basis, exact2.conf, exact2.ref], ["band-here", "medium", 1], "2 exact orders are not enough");
  const feed = [9, 9, 9, 9, 9].map((p, i) => ({ g: G, m: "gameflip", p, u: 1, n: 1, t: NOW - (i + 1) * DAY }));
  const tr = ref(bundle({ sales: filler().concat([S({ m: "ggsel", p: 1.4 }), S({ m: "eldorado", p: 1.6 })]), radar: { at: NOW, games: [], feed } }));
  assert.deepEqual([tr.basis, tr.conf], ["translated", "medium"], "a translation beats the rivals");
  const feed3 = [1.2, 1.3, 1.4].map((p, i) => ({ g: G, m: "gameflip", p, u: 1, n: 1, t: NOW - (i + 1) * DAY }));
  const rv = ref(bundle({ sales: filler(["gameflip"]), radar: { at: NOW, games: [], feed: feed3 } }));
  assert.deepEqual([rv.basis, rv.conf, rv.ref], ["rivals", "low", 1.3], "rivals beat the venue");
  const vn = ref(bundle({ sales: filler(["gameflip"]), radar: { at: NOW, games: [], feed: feed3.slice(0, 2) } }));
  assert.deepEqual([vn.basis, vn.conf], ["venue", "none"], "two rival sales are no estimate");
  const none = ref(bundle({ sales: [S({ p: 1 }), S({ p: 1 })] }));
  assert.deepEqual([none.basis, none.conf, none.ref], ["none", "none", null], "under 3 orders anywhere: nothing");
});

T("R26 exact-here is never capped; a rivals anchor is cut to the p75; the ceiling is the market's highest order", () => {
  const sales = filler(["gameflip"], 1).concat([3, 3, 3].map((p) => S({ p })));
  const feed = [3, 3, 3].map((p, i) => ({ g: "delta", m: "gameflip", p, u: 1, n: 1, t: NOW - (i + 1) * DAY }));
  const { ev } = ctxOf(bundle({ sales, radar: { at: NOW, games: [], feed } }));
  assert.equal(RF.marketP75(ev, "gameflip"), 1);
  const ex = RF.refFor(ev, { g: G, m: "gameflip", ck: CK, bk: BK, ex: true, n: 1 });
  assert.deepEqual([ex.basis, ex.ref, ex.capped], ["exact-here", 3, false], "paid here: may sit in the top tail");
  const rv = RF.refFor(ev, { g: "delta", m: "gameflip", ck: null, bk: "delta|1", ex: false, n: 1 });
  assert.deepEqual([rv.basis, rv.ref, rv.capped], ["rivals", 1, true], "a rival's price is cut to what this market pays");
  assert.equal(ex.ceiling, 3);
  assert.equal(rv.ceiling, 3);
  assert.ok(P.candidates(ex, 0.75).every((p) => p <= 3), "no candidate over the market's highest order");
});

T("R27 every exposure is placed at x = price ÷ ref: a sold unit at its sale price, the rest at the ask", () => {
  const c = curve({ soldP: 1, sellDays: 2, nSold: 10, nLive: 0 });
  const dear = L({ p: 2.5, st: "sold", c: NOW - 20 * DAY });
  const live = L({ p: 2.5, c: NOW - 10 * DAY });
  const sales = c.sales.concat([S({ lid: dear.id, p: 1.9, t: NOW - 19 * DAY })]);
  const { hz } = ctxOf(bundle({ listings: c.listings.concat([dear, live]), sales, demand: [DR()] }));
  const b = hz.claim.markets.gameflip.buckets;
  assert.equal(b[1].S, 10, "the reference sales sit at x = 1");
  assert.equal(b[4].S, 1, "the $2.50 row that sold at $1.90 is judged at x = 1.9");
  near(b[4].D, 1, 1e-3);
  assert.equal(b[5].S, 0);
  near(b[5].D, 10, 1e-3, "the unsold $2.50 row is judged at its ask, x = 2.5");
});

T("R28 live rows count their exposure: where the resolved-only curve flatters a high price, the brain does not", () => {
  const listings = [];
  const sales = [];
  for (let i = 0; i < 10; i++) {
    const r = L({ p: 1.5, st: "sold", c: NOW - (40 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, p: 1.5, t: r.c + 2 * DAY }));
  }
  for (let i = 0; i < 2; i++) {
    const r = L({ p: 2.6, st: "sold", c: NOW - 25 * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, p: 2.6, t: r.c + DAY }));
  }
  for (let i = 0; i < 8; i++) listings.push(L({ p: 2.6, c: NOW - 20 * DAY }));
  const ctx = ctxOf(bundle({ listings, sales, demand: [DR()] }), CFG({ shrinkK: 0 }));
  // what a resolved-only count says: the two dear rows that sold, sold in a day
  const resolved = [0, 0, 0, 0, 0, 0].map(() => ({ S: 0, D: 0 }));
  for (const r of ctx.ev.rows) {
    if (r.activeAtCut) continue;
    const bi = U.bucketOf(H.judgedPrice(r) / 1.5);
    resolved[bi].S += r.expo.units;
    resolved[bi].D += r.expo.days;
  }
  const rh = (i) => resolved[i].S / resolved[i].D;
  assert.ok(rh(4) > rh(1), "resolved-only, the dearer price looks FASTER (" + rh(4) + " vs " + rh(1) + ")");
  const mk = ctx.hz.claim.markets.gameflip;
  near(mk.buckets[1].hRaw, 10 / 20, 1e-9);
  near(mk.buckets[4].hRaw, 2 / (2 + 8 * 20), 1e-9, "the 8 unsold live rows' 160 days are counted");
  assert.ok(H.hazardAt(ctx.hz.claim, "gameflip", null, 1.75) < 0.1 * H.hazardAt(ctx.hz.claim, "gameflip", null, 1.0), "the brain sees the dear price is slow");
});

T("R29 a later edit never moves a sale; a sold row with no sale record ends at its last write, flagged", () => {
  const r1 = L({ st: "sold", c: NOW - 40 * DAY, u: NOW - 37 * DAY });
  const r2 = L({ st: "sold", c: NOW - 40 * DAY, u: NOW - 5 * DAY });
  const r3 = L({ st: "sold", c: NOW - 35 * DAY, u: NOW - 30 * DAY });
  const q = L({ m: "ggsel", st: "delisted", c: NOW - 20 * DAY, u: NOW - 8 * DAY, qty: 3 });
  const sales = [S({ lid: r1.id, t: NOW - 38 * DAY }), S({ lid: r2.id, t: NOW - 38 * DAY })];
  const ev = E.buildEvidence(bundle({ listings: [r1, r2, r3, q], sales }), { cfg: CFG(), cut: NOW });
  const e = (r) => ev.byId.get(r.id).expo;
  near(e(r1).days, 2, 1e-9);
  near(e(r2).days, 2, 1e-9, "edited 33 days after it sold: still a 2-day sale");
  assert.equal(e(r2).units, 1);
  assert.equal(e(r2).endApprox, false);
  near(e(r3).days, 5, 1e-9);
  assert.deepEqual([e(r3).units, e(r3).endApprox], [1, true], "sold, at an approximate moment");
  near(e(q).days, 12, 1e-9);
  assert.equal(e(q).endApprox, true, "a delisted row's updatedAt is only an approximation");
});

T("R30 on quantity markets a row is one offer: units sold per in-stock day from its first unit", () => {
  const gg = L({ m: "ggsel", p: 1.5, c: NOW - 20 * DAY, qty: 4, units: [{ a: NOW - 15 * DAY }, { a: NOW - 10 * DAY }] });
  const cas = L({ kind: "cas", o: "manual", m: "eldorado", c: NOW - 20 * DAY, units: [{ a: NOW - 2 * DAY, d: NOW - 2 * DAY }] });
  const gf = L({ c: NOW - 6 * DAY, units: [{ a: NOW - 2 * DAY }] });
  const sales = [12, 8, 4].map((d) => S({ lid: gg.id, m: "ggsel", p: 1.5, t: NOW - d * DAY }));
  const ctx = ctxOf(bundle({ listings: [gg, cas, gf], sales, demand: [DR()] }));
  const e = ctx.ev.byId.get(gg.id).expo;
  near(e.days, 15, 1e-9, "from its first unit's addedAt, not createdAt");
  assert.equal(e.units, 3, "three units sold from one offer");
  near(ctx.ev.byId.get(cas.id).expo.days, 20, 1e-9, "a claim-at-sale addedAt is a delivery record, not a start");
  near(ctx.ev.byId.get(gf.id).expo.days, 6, 1e-9, "a single-unit row starts at createdAt");
  const mk = ctx.hz.claim.markets.ggsel;
  assert.equal(mk.S, 3);
  near(mk.h, 3 / 15, 1e-9, "units per in-stock day");
});

T("R31 shrinkK is the shrinkage strength: a larger one pulls a thin bucket toward its market", () => {
  const listings = [];
  const sales = [];
  for (let i = 0; i < 20; i++) {
    const r = L({ p: 1, st: "sold", c: NOW - (30 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, p: 1, t: r.c + 2 * DAY }));
  }
  const thin = L({ p: 1.35, st: "sold", c: NOW - 10 * DAY });
  listings.push(thin);
  sales.push(S({ lid: thin.id, p: 1.35, t: thin.c + DAY }));
  const b = bundle({ listings, sales, demand: [DR()] });
  const at = (K) => ctxOf(b, CFG({ shrinkK: K })).hz.claim.markets.gameflip;
  const hm = at(30).h;
  near(hm, 21 / 41, 1e-9);
  const gap = (K) => Math.abs(at(K).buckets[3].hRaw - hm);
  assert.equal(at(30).buckets[3].evid, false, "one sale, one day: a thin bucket");
  near(at(0).buckets[3].hRaw, 1, 1e-9, "K = 0: the bucket's own rate");
  near(at(30).buckets[3].hRaw, (1 + 30 * hm) / 31, 1e-9);
  assert.ok(gap(0) > gap(30) && gap(30) > gap(1000), "a larger K, closer to the market");
  assert.equal(M.readConfig({ listingBrain: { shrinkK: 5000 } }).shrinkK, 1000, "clamped");
});

T("R32 monotone at every level on the large fixture: no higher price ever sells faster", () => {
  const run = largeRun();
  let checked = 0;
  for (const f of ["claim", "noclaim"]) {
    const hz = run.ctx.hz[f];
    for (const m of Object.keys(hz.markets)) {
      const mk = hz.markets[m];
      if (mk.h === null) continue;
      for (let i = 1; i < 6; i++) {
        assert.ok(mk.buckets[i].h <= mk.buckets[i - 1].h + 1e-12, f + " " + m + " bucket " + i);
        for (let t = 0; t < 3; t++) assert.ok(mk.buckets[i].tiers[t].h <= mk.buckets[i - 1].tiers[t].h + 1e-12, f + " " + m + " tier " + t);
      }
      for (const tier of [null, 0, 1, 2]) {
        let prev = Infinity;
        for (let x = 0.4; x <= 3.01; x += 0.05) {
          const h = H.hazardAt(hz, m, tier, x);
          assert.ok(h <= prev + 1e-12, f + " " + m + " tier " + tier + " x " + x.toFixed(2));
          prev = h;
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 1000, "checked " + checked + " points");
});

T("R33 no offer's price is ever taken from a thin bucket, and minSales is the estimate's threshold", () => {
  const run = largeRun();
  let picked = 0;
  for (const o of run.offers) {
    if (o.raw === null || o.thin || !(o.ref > 0)) continue;
    assert.ok(H.evidenced(run.ctx.hz[o.f], o.m, o.raw / o.ref), o.k + " " + o.m + " raw " + o.raw + " / ref " + o.ref);
    picked++;
  }
  assert.ok(picked > 100, "picked prices checked: " + picked);
  const c = curve({ nSold: 2, nLive: 3 });
  const refOrders = Array.from({ length: 5 }, () => S({ p: 1.5, t: NOW - 60 * DAY }));
  const b = bundle({ listings: c.listings, sales: c.sales.concat(refOrders) });
  assert.equal(ctxOf(b).hz.claim.markets.gameflip.h, null, "two sales: no estimate");
  assert.ok(ctxOf(b, CFG({ minSales: 2 })).hz.claim.markets.gameflip.h > 0, "minSales is the threshold");
});

/** Evidence at x ≈ 1.0 (fast) and x ≈ 1.5 (slower, priced), the market ceiling lifted to $3. */
function slopeCtx(dr, fees = {}) {
  const listings = [];
  const sales = [];
  for (let i = 0; i < 10; i++) {
    const r = L({ p: 1.5, st: "sold", c: NOW - (30 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, p: 1.5, t: r.c + DAY }));
  }
  for (let i = 0; i < 4; i++) {
    const r = L({ p: 2.25, st: "sold", c: NOW - (20 + i) * DAY });
    listings.push(r);
    sales.push(S({ lid: r.id, p: 2.25, t: r.c + 3 * DAY }));
  }
  sales.push(S({ g: "other", ck: "s:other", bk: "other|1", p: 3 }));
  return ctxOf(bundle({ listings, sales, demand: [DR(dr)], fees }));
}

T("R34 value is the sell chance times the net after the fee; a fee never moves the best price on its market", () => {
  const price = (fees) => {
    const ctx = slopeCtx({ w: 4, on: 12 }, fees);
    return P.priceOffer(ctx, { g: G, f: "claim", m: "gameflip", ck: CK, bk: BK, ex: true, n: 1, band: "1", live: null, base: null });
  };
  const a = price({});
  const evid = a.cands.filter((c) => c.evid);
  assert.ok(evid.length >= 3);
  for (const c of evid) {
    assert.equal(c.net, U.netOf(c.p, "gameflip", {}));
    near(c.value, c.pH * c.net, 1e-12);
  }
  const b = price({ gameflip: 30 });
  assert.equal(b.raw, a.raw, "the best price is the same at an 8 % or a 30 % fee");
  for (const c of b.cands.filter((x) => x.evid)) near(c.value, c.pH * U.netOf(c.p, "gameflip", { gameflip: 30 }), 1e-12);
  assert.ok(b.value < a.value, "only what we keep changes");
});

T("R36 the raise rule judges the regime's pick before the step limit: the other order gives another price", () => {
  const ev = E.buildEvidence(bundle({ sales: [S({ p: 1.4 }), S({ p: 1.4 })] }), { cfg: CFG(), cut: NOW });
  const cands = [1, 1.3, 1.4, 2, 3].map((p) => ({ p, evid: true }));
  const v = V({ cands });
  const c = P.gateChain({ ev, hz: {} }, v, { raw: 3, base: 1, floor: 0.75 });
  // raise rule on $3: the highest price with two orders at or above it is $1.40; the step then caps it
  assert.equal(c.p, 1.35);
  assert.deepEqual(c.gates, ["raise-rule", "step"]);
  // step first would hand the raise rule $1.35, which it cuts to $1.30 — a different answer
  assert.equal(P.gateChain({ ev, hz: {} }, v, { raw: 1.35, base: 1, floor: 0.75 }).p, 1.3);
});

T("R36 a low-confidence price still passes every later gate; only its action is hold", () => {
  const ev = E.buildEvidence(bundle({ sales: [S({ p: 3 }), S({ p: 3 })] }), { cfg: CFG(), cut: NOW });
  const c = P.gateChain({ ev, hz: {} }, V({ conf: "low", basis: "band-here", cands: [{ p: 3, evid: true }] }), { raw: 3, base: 1, floor: 0.75 });
  assert.equal(c.gates[0], "confidence", "the first gate");
  assert.equal(c.p, 1.35, "the logged price is still step-limited");
  assert.ok(c.gates.includes("step"));
});

T("R37 every advised move on the large fixture stays inside its floor and step, and is one of the five actions", () => {
  const run = largeRun();
  const ev = run.ctx.ev;
  const step = run.ctx.cfg.maxStepPct / 100;
  const seen = { hold: 0, lower: 0, raise: 0, test: 0, ladder: 0 };
  for (const o of run.offers) {
    for (const l of o.live) {
      assert.ok(l.a in seen, l.a);
      seen[l.a]++;
      if (l.a === "hold" || l.a === "ladder") continue;
      const R = ev.byId.get(l.id);
      assert.ok(R.advisable);
      assert.ok(l.p >= R.floor - 1e-9, o.m + " " + l.a + " " + l.p + " under its floor " + R.floor);
      if (l.p > R.floor + 1e-9) assert.ok(Math.abs(l.p - l.ask) <= step * l.ask + 0.05 + 1e-9, o.m + " " + l.a + " " + l.ask + " → " + l.p + " is more than one step");
      if (l.a === "lower") assert.ok(l.p < l.ask);
      else assert.ok(l.p > l.ask);
    }
  }
  assert.ok(seen.hold > 0 && seen.lower > 0 && seen.raise > 0, JSON.stringify(seen));
  for (const f of run.fc) assert.ok(f.a in seen);
});

T("R37 the cool-down holds a different move advised within cooldownH, run-wide; it is configurable", () => {
  const b = smallBundle();
  const run = smallRun();
  const moved = run.fc.filter((f) => f.a === "lower" || f.a === "raise" || f.a === "test");
  assert.ok(moved.length >= 3, "the small fixture advises some moves: " + moved.length);
  const flip = { lower: "raise", raise: "lower", test: "lower" };
  const prior = (hoursAgo) => new Map(moved.map((f) => [f.l, { a: flip[f.a], at: b.now - hoursAgo * HOUR }]));
  const act = (r) => new Map(r.fc.map((f) => [f.l, f.a]));
  const held = act(M.buildRun(b, { prior: prior(10) }));
  for (const f of moved) assert.equal(held.get(f.l), "hold", "a flip 10 h after the last advice is held");
  const past = act(M.buildRun(b, { prior: prior(100) }));
  for (const f of moved) assert.equal(past.get(f.l), f.a, "after 72 h the move is advised again");
  const short = act(M.buildRun(b, { prior: prior(10), cfg: { cooldownH: 5 } }));
  for (const f of moved) assert.equal(short.get(f.l), f.a, "cooldownH 5: 10 h is long enough");
});

T("R38 ZeusX is unmeasured: never a shelf, never the exploration unit, even as the only unproven market", () => {
  const c = curve({ soldP: 1.5, sellDays: 1, nSold: 10, nLive: 0, start: 5 });
  const old = { games: { [G]: { base: 1.5, ggsel: 1.4, flat: { gameflip: 3, zeusx: 3 } } }, offers: {} };
  const only = { gameflip: true, digiseller: false, ggsel: false, zeusx: true, eldorado: false, playerauctions: false, g2g: false };
  const mk = (takes) => M.buildRun(bundle({ listings: c.listings, sales: c.sales, old, demand: [DR({ w: 1, on: 30 })], af: { takes } })).ctx.placements.get(G + "|claim");
  const z = mk(only);
  assert.equal(z.elig.zeusx, "unmeasured");
  assert.ok(z.reserve > 0, "there is surplus to explore with");
  assert.equal(z.explore, null, "ZeusX can never earn evidence: no exploration unit");
  assert.ok(!(z.shelf.zeusx > 0));
  const e = mk(Object.assign({}, only, { eldorado: true }));
  assert.equal(e.explore, "eldorado", "control: an open unproven market does get the unit");
});

T("R39 a Gameflip shelf of zero is flagged anchor on the cell", () => {
  const c = curve({ soldP: 1.5, sellDays: 1, nSold: 10, nLive: 0, start: 5 });
  const bulk = Array.from({ length: 30 }, (_, i) => ({ g: G, m: "eldorado", f: "claim", t: NOW - (i + 0.5) * DAY, src: "bulk" }));
  const run = M.buildRun(bundle({ listings: c.listings, sales: c.sales, demandOnly: bulk, demand: [DR({ w: 20, on: 6 })] }));
  assert.equal(run.ctx.placements.get(G + "|claim").shelf.gameflip, 0);
  assert.ok(cellOf(run, G, "claim", "gameflip").fl.includes("anchor"), "today's path cannot list with no Gameflip unit");
  const run2 = M.buildRun(bundle({ listings: c.listings, sales: c.sales, demand: [DR({ w: 20, on: 6 })] }));
  assert.ok(run2.ctx.placements.get(G + "|claim").shelf.gameflip > 0);
  assert.ok(!cellOf(run2, G, "claim", "gameflip").fl.includes("anchor"));
});

T("R40 markets that cannot be topped up are sized over the longer horizon; both horizons are configurable", () => {
  const ev = E.buildEvidence(bundle({ demand: [DR()] }), { cfg: CFG(), cut: NOW });
  const el = PL.eligibility(ev, G, "claim", {});
  for (const m of ["gameflip", "digiseller", "ggsel"]) assert.deepEqual([el[m].refillable, el[m].horizonDays], [true, 14], m);
  for (const m of ["zeusx", "eldorado", "playerauctions", "g2g"]) assert.deepEqual([el[m].refillable, el[m].horizonDays], [false, 28], m);
  const el2 = PL.eligibility(E.buildEvidence(bundle(), { cfg: CFG({ shelfHorizonDays: 7, nonRefillHorizonDays: 42 }), cut: NOW }), G, "claim", {});
  assert.deepEqual([el2.gameflip.horizonDays, el2.eldorado.horizonDays], [7, 42]);
  // the same demand on Gameflip and Eldorado: the one that cannot be topped up holds more
  const a = curve({ soldP: 1.5, sellDays: 1, nSold: 6, nLive: 0, start: 5 });
  const b = curve({ m: "eldorado", ck: CK, soldP: 1.5, sellDays: 1, nSold: 6, nLive: 0, start: 5 });
  const ctx = ctxOf(bundle({ listings: a.listings.concat(b.listings), sales: a.sales.concat(b.sales), demand: [DR({ w: 4, on: 30 })] }));
  const pl = PL.placeGame(ctx, { g: G, f: "claim", stock: 30, nets: { gameflip: 1.38, eldorado: 1.38 }, prices: { gameflip: 1.5, eldorado: 1.5 }, cur: {}, oldShelf: null });
  assert.deepEqual([pl.horizon.gameflip, pl.horizon.eldorado], [14, 28]);
  near(pl.lambda.gameflip, pl.lambda.eldorado, 0.05, "equal demand");
  assert.ok(pl.shelf.eldorado > pl.shelf.gameflip, JSON.stringify(pl.shelf));
});

T("R41 platform limits are named constants with their source, and they bind on the shelf", () => {
  assert.deepEqual(PL.PLATFORM_LIMITS, { eldoradoMaxActiveOffers: 100, gameflipExpiryDays: 30, playerauctionsMappingAssumed: false, ggselCanRemoveUnit: false });
  assert.ok(Object.isFrozen(PL.PLATFORM_LIMITS));
  const src = fs.readFileSync(path.join(__dirname, "..", "utils", "listingBrain", "model", "place.js"), "utf8");
  const block = src.slice(src.indexOf("const PLATFORM_LIMITS"), src.indexOf("});", src.indexOf("const PLATFORM_LIMITS")));
  for (const s of ["ELD_LIMIT_RE", "expire_in_days", "new id", "single unit"]) assert.ok(block.includes(s), "the source is beside the constant: " + s);
  // Eldorado's 100 active offers of a game: no new offer there
  const el = curve({ m: "eldorado", soldP: 1.5, sellDays: 1, nSold: 6, nLive: 0, start: 5 });
  const hundred = Array.from({ length: 100 }, () => L({ o: "manual", m: "eldorado", ck: "s:h", p: 2, c: NOW - DAY }));
  const run = M.buildRun(bundle({ listings: el.listings.concat(hundred), sales: el.sales, demand: [DR({ w: 6, on: 20 })] }));
  const pl = run.ctx.placements.get(G + "|claim");
  assert.ok(pl.flags.includes("eld-limit"));
  assert.equal(pl.shelf.eldorado, 0);
  assert.ok(cellOf(run, G, "claim", "eldorado").fl.includes("eld-limit"));
  // a Gameflip row left "active" past its 30-day expiry is not on sale, and the cell says so
  const stale = M.buildRun(bundle({ listings: [L({ c: NOW - 31 * DAY })], demand: [DR()] }));
  assert.ok(cellOf(stale, G, "claim", "gameflip").fl.includes("expired"));
  // GGSel cannot drop one unit: a brain shelf under today's is flagged
  const gg = curve({ m: "ggsel", soldP: 1.5, sellDays: 3, nSold: 6, nLive: 1, liveP: 1.5, liveAge: 2, start: 5 });
  gg.listings[gg.listings.length - 1].qty = 12;
  const run3 = M.buildRun(bundle({ listings: gg.listings, sales: gg.sales, demand: [DR({ w: 1, on: 12 })] }));
  assert.ok(run3.ctx.placements.get(G + "|claim").shelf.ggsel < 12);
  assert.ok(cellOf(run3, G, "claim", "ggsel").fl.includes("noRemove"));
});

T("R44 the greedy shelf is the best split there is, checked against brute force", () => {
  const rnd = FX.mulberry32(44);
  const markets = ["gameflip", "ggsel", "eldorado"];
  const marg = (mu, net, k) => U.poissonTail(mu, k) * net;
  for (let trial = 0; trial < 200; trial++) {
    const mu = {};
    const nets = {};
    for (const m of markets) {
      mu[m] = 0.1 + rnd() * 4;
      nets[m] = 0.3 + rnd() * 2.5;
    }
    const avail = Math.floor(rnd() * 7);
    const minMarginal = 0.1;
    const g = PL.greedyFill({ markets, mu, nets, avail, minMarginal });
    // brute force: every split whose units are each worth ≥ minMarginal
    const cap = {};
    for (const m of markets) {
      cap[m] = 0;
      while (cap[m] < avail && marg(mu[m], nets[m], cap[m] + 1) >= minMarginal) cap[m]++;
    }
    let best = 0;
    for (let a = 0; a <= cap.gameflip; a++)
      for (let b = 0; b <= cap.ggsel; b++)
        for (let c = 0; c <= cap.eldorado && a + b + c <= avail; c++) {
          let v = 0;
          for (let k = 1; k <= a; k++) v += marg(mu.gameflip, nets.gameflip, k);
          for (let k = 1; k <= b; k++) v += marg(mu.ggsel, nets.ggsel, k);
          for (let k = 1; k <= c; k++) v += marg(mu.eldorado, nets.eldorado, k);
          best = Math.max(best, v);
        }
    let got = 0;
    for (const m of markets) for (let k = 1; k <= g.shelf[m]; k++) got += marg(mu[m], nets[m], k);
    near(got, best, 1e-9, "trial " + trial);
    assert.equal(sum(g.shelf) + g.left, avail, "the rest is the reserve");
  }
});

T("R45 exploration needs surplus stock, takes one unit on one unproven market, and prefers where rivals sell", () => {
  const el = curve({ m: "eldorado", soldP: 1.5, sellDays: 1, nSold: 8, nLive: 0, start: 5 });
  const old = { games: { [G]: { base: 1.5, ggsel: 1.4, flat: {} } }, offers: {} };
  const takes = { gameflip: true, digiseller: false, ggsel: true, zeusx: false, eldorado: true, playerauctions: false, g2g: false };
  const mk = (on, w, radarGames = []) =>
    M.buildRun(bundle({ listings: el.listings, sales: el.sales, old, demand: [DR({ w, on })], af: { takes, mapped: { [G]: { ggsel: true } } }, radar: { at: NOW, games: radarGames, feed: [] } })).ctx.placements.get(G + "|claim");
  const plain = mk(30, 1);
  assert.ok(plain.reserve > 0);
  assert.equal(plain.explore, "gameflip", "the first unproven open market");
  assert.equal(plain.shelf.gameflip, 1, "one unit");
  assert.ok(!(plain.shelf.ggsel > 0), "on one market only");
  const rivals = mk(30, 1, [{ key: G, perWeek: 3, rivalSellers: 4, byMarket: { gameflip: { perWeek: 0 }, ggsel: { perWeek: 3 } } }]);
  assert.equal(rivals.explore, "ggsel", "where the radar shows rivals selling");
  assert.equal(rivals.shelf.ggsel, 1);
  const tight = mk(2, 30);
  assert.equal(tight.reserve, 0);
  assert.equal(tight.explore, null, "no surplus, no exploration");
});

T("R46 an assumed fee is flagged, a settings fee is not, and the equal-fee placement is logged — here it flips a unit", () => {
  const a = curve({ soldP: 2, sellDays: 2, nSold: 6, nLive: 0, start: 5 });
  const b = curve({ m: "eldorado", soldP: 2.03, sellDays: 2, nSold: 6, nLive: 0, start: 5 });
  const base = { listings: a.listings.concat(b.listings), sales: a.sales.concat(b.sales), demand: [DR({ w: 3, on: 1 })] };
  const ctx = ctxOf(bundle(base), CFG({ nonRefillHorizonDays: 14 }));
  const pl = PL.placeGame(ctx, { g: G, f: "claim", stock: 1, nets: { gameflip: U.netOf(2, "gameflip", {}), eldorado: U.netOf(2.03, "eldorado", {}) }, prices: { gameflip: 2, eldorado: 2.03 }, cur: {}, oldShelf: null });
  near(pl.lambda.gameflip, pl.lambda.eldorado, 1e-6, "the same demand on both");
  assert.deepEqual([pl.shelf.gameflip, pl.shelf.eldorado], [1, 0], "Gameflip's assumed 8 % fee wins the last unit");
  assert.deepEqual([pl.shEq.gameflip, pl.shEq.eldorado], [0, 1], "with every fee equal, Eldorado's higher price would");
  assert.ok(pl.flags.includes("fee-assumed"));
  const run = M.buildRun(bundle(base));
  assert.ok(cellOf(run, G, "claim", "gameflip").fl.includes("fee-assumed"));
  assert.ok(!cellOf(run, G, "claim", "eldorado").fl.includes("fee-assumed"), "Eldorado's fee is documented");
  for (const m of ["gameflip", "eldorado"]) assert.equal(typeof cellOf(run, G, "claim", m).br.she, "number", "the equal-fee shelf sits on the cell");
  const set = M.buildRun(bundle(Object.assign({ fees: { gameflip: 8 } }, base)));
  assert.ok(!cellOf(set, G, "claim", "gameflip").fl.includes("fee-assumed"), "a fee the owner set is no assumption");
  assert.equal(cellOf(set, G, "claim", "gameflip").ev.fee, "verified");
});

T("R47 every cell row logs all four price policies and all four placement forecasts", () => {
  const run = smallRun();
  let n = 0;
  for (const r of run.rows) {
    if (r.m === "all") continue;
    n++;
    assert.deepEqual(Object.keys(r.pol).sort(), M.PRICE_POLICIES.slice().sort(), r.k + " " + r.m);
    assert.deepEqual(Object.keys(r.pf).sort(), M.PLACE_POLICIES.slice().sort(), r.k + " " + r.m);
  }
  assert.ok(n > 50);
  for (const pl of run.ctx.placements.values()) assert.deepEqual(Object.keys(pl.policies).sort(), M.PLACE_POLICIES.slice().sort());
  // and they differ where they should: the curve is not just today's ask
  assert.ok(run.rows.some((r) => r.pol.curve !== null && r.pol.old !== null && Math.abs(r.pol.curve - r.pol.old) > 0.1));
  assert.ok(run.rows.some((r) => r.pf.newsvendor !== null && r.pf.flat !== null && Math.abs(r.pf.newsvendor - r.pf.flat) > 0.1));
});

T("R47 the log keeps both policy blocks: nothing a run writes is dropped by the log models' schemas", () => {
  // exactly what utils/listingBrain/index.js inserts: compact(row) (sparse: no reasons, no empty values)
  // plus run, at and exp; and one run document
  const mongoose = require("mongoose");
  const Row = require("../models/ListingBrainRow");
  const Run = require("../models/ListingBrainRun");
  const { compact } = require("../utils/listingBrain/index");
  assert.equal(typeof compact, "function", "the runner exports the row compaction it writes with");
  const meaningful = (v) => v !== null && v !== undefined && v !== false && !(Array.isArray(v) && !v.length) && !(v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && !Object.keys(v).length);
  const run = smallRun();
  const runId = new mongoose.Types.ObjectId();
  const at = new Date(NOW);
  let policyRows = 0;
  for (const r of run.rows) {
    const doc = Object.assign({}, compact(r), { run: runId, at, exp: new Date(NOW + 21 * DAY) });
    assert.ok(!("why" in doc), "reasons stay in memory");
    const kept = new Row(doc).toObject();
    for (const k of Object.keys(doc)) if (meaningful(doc[k])) assert.ok(k in kept, "the row schema drops `" + k + "`");
    if (r.m === "all") continue;
    policyRows++;
    assert.deepEqual(kept.pol, doc.pol, "the price policies survive");
    assert.deepEqual(kept.pf, doc.pf, "the placement forecasts survive");
    for (const p of M.PRICE_POLICIES) if (r.pol[p] !== null) assert.equal(kept.pol[p], r.pol[p], p);
    for (const p of M.PLACE_POLICIES) if (r.pf[p] !== null) assert.equal(kept.pf[p], r.pf[p], p);
  }
  assert.ok(policyRows > 50);
  const doc = { at, v: M.MODEL_VERSION, ms: 1, cfg: run.ctx.cfg, summary: run.summary, counts: {}, notes: ["n"], rowsN: run.rows.length, day: "2026-10-03", fcN: run.fc.length, fc: run.fc };
  const kept = new Run(doc).toObject();
  for (const k of Object.keys(doc)) assert.ok(k in kept, "the run schema drops `" + k + "`");
  assert.equal(kept.fc.length, run.fc.length);
});

T("R48 a run's own summary adds up from its rows, like with like, no-evidence apart", () => {
  const run = smallRun();
  const s = run.summary;
  for (const f of ["claim", "noclaim"]) {
    const rows = run.rows.filter((r) => r.f === f && r.m !== "all");
    assert.equal(sum(s.byPrice[f]), rows.length);
    assert.equal(sum(s.byShelf[f]), rows.length);
    const cmp = rows.filter((r) => ["agree", "brain-more", "brain-fewer", "brain-add", "brain-drop"].includes(r.sc));
    assert.equal(s.shelf[f].compared, cmp.length);
    assert.equal(s.shelf[f].old, cmp.reduce((a, r) => a + (r.old.sh || 0), 0));
    assert.equal(s.shelf[f].brain, cmp.reduce((a, r) => a + (r.br.sh || 0), 0));
    assert.equal(s.shelf[f].unknownCells, rows.filter((r) => r.sc === "unknown").length);
    for (const r of rows.filter((x) => x.pc === "no-evidence")) assert.ok(r.br.p === null || r.old.a === null || r.pol.old === null, "no-evidence means a side has no number");
    for (const r of rows) {
      assert.ok(M.PRICE_CLASSES.includes(r.pc), r.pc);
      assert.ok(M.SHELF_CLASSES.includes(r.sc), r.sc);
    }
  }
  assert.ok(s.byPrice.claim["no-evidence"] > 0, "the fixture has cells with no evidence, counted apart");
});

T("R49 priceFor, shelfFor and valueFor answer in their agreed shapes and fail safe on anything broken", () => {
  const run = smallRun();
  const keys = (o) => Object.keys(o).sort();
  const pf = M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 1.5, game: "Alpha Quest", title: "Alpha Quest Twitch Drops (3 Items)", itemCount: 3, items: [] });
  assert.deepEqual(keys(pf), ["basis", "confidence", "price", "reasons", "regime"]);
  const sf = M.shelfForRun(run, { game: "Alpha Quest", farm: "claim", stock: 10 });
  assert.deepEqual(keys(sf), ["basis", "bulkTake", "explore", "reasons", "reserve", "shelf"]);
  assert.equal(sum(sf.shelf) + sf.reserve + sf.bulkTake, 10);
  const vf = M.valueForRun(run, "alpha quest");
  assert.deepEqual(keys(vf), ["basis", "nets", "reasons", "shares", "value"]);
  assert.ok(vf.value > 0);
  const broken = { ctx: { ev: { markets: null }, placements: { get: () => { throw new Error("boom"); } }, cfg: {} } };
  const bp = M.priceForRun(broken, { marketplace: "gameflip", basePriceUsd: 1.1, game: "Alpha Quest" });
  assert.deepEqual([bp.price, bp.confidence], [1.1, "none"], "an error inside is today's price");
  const bs = M.shelfForRun(broken, { game: "x", stock: 4 });
  assert.deepEqual([bs.shelf, bs.reserve], [{}, 4]);
  assert.equal(M.valueForRun(broken, "x").value, null);
  for (const q of [undefined, null, {}, { marketplace: 7 }]) assert.equal(M.priceForRun(run, q).confidence, "none");
});

T("R50 an ask is max(stored price, floor): a ZeusX row stored under its floor asks the floor", () => {
  const z = L({ m: "zeusx", p: 0.6 });
  const g = L({ m: "ggsel", p: 0.9, vmin: 1.1 });
  const run = M.buildRun(bundle({ listings: [z, g], demand: [DR()] }));
  assert.equal(run.ctx.ev.byId.get(z.id).ask, U.floorFor("zeusx"));
  assert.equal(run.ctx.ev.byId.get(z.id).ask, 1);
  assert.equal(cellOf(run, G, "claim", "zeusx").old.a, 1, "today's ask is what buyers see");
  assert.equal(run.ctx.ev.byId.get(g.id).ask, 1.1, "a learned GGSel minimum lifts the ask the same way");
});

/* ------------------------------------------------------------------------------------------------------ */
/* brief §9: the brain recovers what was planted (scripts/listing-brain-fixture.js PLANTED)               */
/* ------------------------------------------------------------------------------------------------------ */

/** The exact offer of a planted game on a market, by item count: its { ck, bk, n, band }. */
function plantedOffer(run, g, m, n) {
  const R = run.ctx.ev.rows.find((r) => r.g === g && r.m === m && r.n === n && r.ex && r.system);
  assert.ok(R, "planted offer " + g + " " + m + " n=" + n);
  return { g, m, ck: R.ck, bk: R.bk, ex: true, n: R.n, band: R.band, f: R.f };
}

T("R51 planted A: the Gameflip claim elasticity is recovered within its tolerance", () => {
  const A = PLANTED.A;
  // the stated tolerance on the small bundle; a tight one (10 %) on the large one, as PLANTED.A's notes ask
  for (const [name, run, tol] of [
    ["small", smallRun(), A.ratio.tolPct],
    ["large", largeRun(), 10],
  ]) {
    const hz = run.ctx.hz.claim;
    const ratio = H.hazardAt(hz, "gameflip", null, A.ratio.x1) / H.hazardAt(hz, "gameflip", null, A.ratio.x2);
    within(ratio, A.ratio.value, tol, name + " h(" + A.ratio.x1 + ")/h(" + A.ratio.x2 + ")");
    within(H.hazardAt(hz, "gameflip", null, 1), A.h0, A.h0TolPct, name + " h0");
    for (const o of A.offers) {
      const r = RF.refFor(run.ctx.ev, plantedOffer(run, o.game, "gameflip", o.n));
      assert.equal(r.basis, A.refBasis, name + " " + o.game + " n=" + o.n);
      within(r.ref, o.R, 10, name + " ref of " + o.game + " n=" + o.n);
    }
  }
});

T("R52 planted B, B2, C, C2: the four regime triggers are read from the farm brain's rows", () => {
  const run = smallRun();
  const gs = (g) => run.ctx.gameStates.get(g + "|claim");
  for (const [k, re] of [
    ["B", /covers .* over/],
    ["B2", /Fading/],
    ["C", /covers .* under/],
    ["C2", /campaign has ended/],
  ]) {
    const s = gs(PLANTED[k].game);
    assert.equal(s.regime, PLANTED[k].expectRegime, k + " " + PLANTED[k].game);
    assert.match(s.regimeWhy[0], re, k);
  }
  // and each regime picks its own price: overstock sells faster than its ask, scarce asks more
  const verdict = (g) => run.offers.find((o) => o.k === g && o.f === "claim" && o.m === "gameflip" && o.raw !== null);
  const over = verdict(PLANTED.B.game);
  if (over && over.pHask !== null && over.pH !== null) assert.ok(over.pH >= over.pHask - 1e-9, "overstock: a price that sells at least as fast");
});

T("R53 planted D: a market stocked half the window keeps its share (in-stock rate, not raw sales)", () => {
  const D = PLANTED.D;
  for (const run of [smallRun(), largeRun()]) {
    const pl = run.ctx.placements.get(D.game + "|claim");
    within(pl.shares.ggsel / pl.shares.gameflip, D.shareRatio.value, D.shareRatio.tolPct, "ggsel / gameflip share");
    const ms = PL.marketShares(run.ctx.ev, D.game, "claim", ["gameflip", "ggsel"]);
    assert.equal(ms.S.ggsel / ms.S.gameflip, D.shareRatio.naive, "raw 30-day sales would read half");
    near(ms.D.ggsel, D.markets.ggsel.inStockDays30, 0.5, "GGSel was in stock half the window");
    assert.ok(pl.lambda.ggsel > 0.8 * pl.lambda.gameflip);
  }
});

T("R54 planted E: Digiseller is history only — closed, unpriced, and its prices never reach another market", () => {
  const E0 = PLANTED.E;
  const b = smallBundle();
  const run = smallRun();
  const dig = run.rows.filter((r) => r.m === E0.market);
  assert.ok(dig.length >= E0.games.length - 1, "its history is still shown: " + dig.length + " cells");
  for (const r of dig) {
    assert.deepEqual([r.sc, r.br.p, r.br.sh], ["closed", null, 0], r.k);
    assert.equal(r.pc, "managed");
  }
  assert.ok(!run.fc.some((f) => f.m === E0.market), "no Digiseller row is advised");
  const pr = E0.probe;
  const ref = RF.refFor(run.ctx.ev, plantedOffer(run, pr.game, pr.market, pr.n));
  assert.equal(ref.basis, pr.expectBasis);
  within(ref.ref, pr.expectRef.value, pr.expectRef.tolPct, "the probe's translated reference");
  assert.ok(ref.ref <= pr.expectRef.max && ref.ref !== pr.expectRef.never);
  // the strongest form: double every Digiseller price and nothing on any other market moves
  const dear = JSON.parse(JSON.stringify(b));
  for (const s of dear.sales) if (s.m === E0.market && s.p > 0) s.p = Math.min(24, s.p * 2);
  for (const l of dear.listings) if (l.m === E0.market) l.p = Math.min(24, l.p * 2);
  const run2 = M.buildRun(dear);
  const others = (r) => JSON.stringify(r.rows.filter((x) => x.m !== E0.market));
  assert.equal(others(run2), others(run), "Digiseller's prices teach no other market");
});

T("R55 planted F: the hand-made Eldorado ladder is reported, never corrected, its rungs in the curve", () => {
  const F = PLANTED.F;
  const run = smallRun();
  const cell = cellOf(run, F.game, F.farm, F.market);
  assert.equal(cell.pc, "ladder");
  assert.ok(cell.fl.includes("ladder"));
  assert.equal(cell.br.a.lower + cell.br.a.raise + cell.br.a.test, 0, "never corrected");
  assert.ok(cell.br.a.ladder >= 1);
  const rungs = run.ctx.ev.rows.filter((r) => r.g === F.game && r.m === F.market && r.activeAtCut && r.ex);
  assert.deepEqual([...new Set(rungs.map((r) => r.p))].sort((a, b) => a - b), F.rungs.map((r) => r.p).sort((a, b) => a - b));
  for (const r of rungs) assert.ok(H.fitRow(run.ctx.ev, r, F.farm), "rung $" + r.p + " is evidence");
  const units = rungs.reduce((a, r) => a + r.expo.units, 0);
  assert.equal(units, F.rungs.reduce((a, r) => a + r.sold, 0), "every rung's sold units are read");
});

T("R57 planted H: the burst and the hand sales are never priced", () => {
  const Hh = PLANTED.H;
  const b = smallBundle();
  const run = smallRun();
  const ev = run.ctx.ev;
  assert.equal(b.demandOnly.filter((d) => d.src === "burst" && d.g === Hh.game).length, Hh.n, "the burst is kept as demand");
  assert.ok(!ev.orders.some((o) => o.p === Hh.fakePrice), "no order at the burst's fake price");
  assert.ok(!ev.orders.some((o) => o.p === Hh.handHigh.price), "no order at the hand sales' price");
  assert.equal(ev.salesBefore.filter((s) => s.src === "hand" && s.p === Hh.handHigh.price).length, Hh.handHigh.n, "hand sales are demand");
  for (const o of run.offers.filter((x) => x.k === Hh.game && x.m === Hh.market)) assert.ok(!(o.ref >= Hh.fakePrice), "ref " + o.ref);
  for (const o of run.offers.filter((x) => x.k === Hh.handHigh.game && x.m === Hh.handHigh.market)) assert.ok(!(o.ref >= 5), "ref " + o.ref);
});

T("R58 planted I: the game with no farm-brain row and the stale one are unknown and held", () => {
  const I = PLANTED.I;
  const run = smallRun();
  for (const g of [I.noDemand, I.staleGame]) {
    const gs = run.ctx.gameStates.get(g + "|claim");
    assert.equal(gs.regime, I.expectRegime, g);
    const cells = run.rows.filter((r) => r.k === g && r.m !== "all");
    assert.ok(cells.length, g);
    for (const r of cells) {
      assert.equal(r.br.p, null);
      assert.equal(r.br.a.lower + r.br.a.raise + r.br.a.test, 0);
    }
    for (const f of run.fc.filter((x) => x.k === g)) assert.equal(f.a, I.expectAction);
    assert.equal(run.ctx.placements.get(g + "|claim").unknown, true);
    assert.equal(M.priceForRun(run, { marketplace: "gameflip", basePriceUsd: 1.4, game: g }).confidence, "none");
  }
  assert.ok(run.fc.some((f) => f.k === I.staleGame), "the stale game has live rows, and they are held");
});

T("R59 planted J: claim-at-sale rows are never advised, never summed, and their sales still price", () => {
  const J = PLANTED.J;
  const run = smallRun();
  const ev = run.ctx.ev;
  for (const j of [J.cas, J.script]) {
    const R = ev.rows.find((r) => r.g === j.game && r.m === j.market && r.cas && r.qty === j.qty);
    assert.ok(R, j.game);
    assert.equal(R.advisable, false);
    assert.equal(R.script, !!j.script);
    assert.ok(!run.fc.some((f) => f.l === R.id));
    const all = cellOf(run, j.game, j.f, "all");
    assert.ok(all.old.cur < j.qty, j.game + ": the advertised " + j.qty + " are not stock (" + all.old.cur + ")");
    assert.equal(cellOf(run, j.game, j.f, j.market).old.n, 0);
    const ref = RF.refFor(ev, { g: j.game, f: j.f, m: j.market, ck: R.ck, bk: R.bk, ex: R.ex, n: R.n, band: R.band });
    assert.ok(ref.n >= 3 && ["exact-here", "band-here"].includes(ref.basis), j.game + ": its " + j.sold + " delivered units price the offer (" + ref.basis + ")");
    assert.ok(U.CONF_RANK[ref.conf] <= U.CONF_RANK.medium, "listing price now: medium at best");
  }
  const cas = cellOf(run, J.cas.game, J.cas.f, J.cas.market);
  assert.deepEqual([cas.pc, cas.sc], ["managed", "managed"]);
  const script = cellOf(run, J.script.game, J.script.f, J.script.market);
  assert.ok(script.fl.includes("script"));
  assert.equal(script.ev.scr, 1);
});

T("R60 planted K: the five assumed fees are flagged on their cells; the equal-fee shelf is logged on every open cell", () => {
  const K = PLANTED.K;
  const run = smallRun();
  for (const r of run.rows) {
    if (r.m === "all") continue;
    assert.equal(r.fl.includes("fee-assumed"), K.assumed.includes(r.m), r.k + " " + r.m);
    assert.equal(r.ev.fee, K.assumed.includes(r.m) ? "assumed" : "verified");
    if (r.ev.el === "open" && r.br.rg !== "unknown") assert.equal(typeof r.br.she, "number", r.k + " " + r.m);
  }
  const pl = run.ctx.placements.get(K.game + "|claim");
  assert.ok(pl.flags.includes("fee-assumed"));
  assert.ok(pl.shEq && typeof pl.shEq === "object");
  for (const m of Object.keys(pl.shelf)) assert.equal(typeof pl.shEq[m], "number", m);
  assert.equal(sum(pl.shEq), sum(pl.shelf), "the same stock, placed with equal fees");
});

T("R61 planted L: ZeusX is unmeasured — no fit, no shelf, no exploration", () => {
  const Lz = PLANTED.L;
  for (const run of [smallRun(), largeRun()]) {
    assert.equal(run.ctx.hz.claim.markets.zeusx, undefined);
    const cell = cellOf(run, Lz.game, "claim", Lz.market);
    assert.deepEqual([cell.sc, cell.ev.el, cell.br.sh], ["unmeasured", "unmeasured", 0]);
    for (const pl of run.ctx.placements.values()) {
      assert.notEqual(pl.explore, "zeusx");
      assert.ok(!(pl.shelf.zeusx > 0));
    }
  }
});

T("R62 planted M: PlayerAuctions is closed where its floor is above what the offer sells for", () => {
  const Mm = PLANTED.M;
  const run = smallRun();
  const cell = cellOf(run, Mm.game, "claim", Mm.market);
  assert.deepEqual([cell.sc, cell.ev.el, cell.br.sh], ["closed", "closed", 0]);
  assert.match(run.ctx.placements.get(Mm.game + "|claim").input.elig.playerauctions.why, /floor \$5\.00 is above/);
});

T("R63 planted N: the ending wave perishes (overstock, ~36 h left); the claim window is learned to within 6 h", () => {
  const N = PLANTED.N;
  for (const run of [smallRun(), largeRun()]) {
    const ev = run.ctx.ev;
    near(ev.noclaim.claimWindowDays, N.claimWindowDays.value, N.claimWindowDays.tolDays, "claim window (days)");
    const p = run.ctx.gameStates.get(N.perish.game + "|noclaim");
    assert.equal(p.regime, N.perish.expectRegime);
    near(p.perishDays * 24, N.perish.endsInHours + 24 * N.claimWindowDays.value, 24 * N.claimWindowDays.tolDays, "hours of stock left");
    assert.ok(P.horizonFor(ev, "noclaim", p) <= p.perishDays + 1e-9, "the horizon never outlives the stock");
    // the ended wave: its units read as expired, and one straggler listed past its expiry never makes
    // the whole game "expire in 0 h"
    const e = run.ctx.gameStates.get(N.ended.game + "|noclaim");
    const units = ev.noclaim.units.filter((u) => u.g === N.ended.game && (u.camps || []).includes(N.ended.event + " " + N.ended.wave));
    assert.ok(units.filter((u) => u.stc === "expired").length > units.filter((u) => u.stc === "sold").length, "expired outnumber sold");
    assert.notEqual(e.perishDays, 0);
    assert.notEqual(e.regime, "unknown");
    assert.ok(!e.regimeWhy.some((w) => /expires in about 0 h|Perishing: 100%/.test(w)), e.regimeWhy.join(" | "));
  }
});

T("R64 planted O: the bulk game's take is set aside first; its per-account prices never price a single", () => {
  const O = PLANTED.O;
  const run = smallRun();
  const ev = run.ctx.ev;
  const bw = ev.bulk.weekly.get(O.game);
  const singles = (ev.salesBefore.filter((s) => s.g === O.game && s.t >= ev.cut - 30 * DAY).length * 7) / 30;
  assert.ok(bw > 3 * singles, "bulk " + bw.toFixed(1) + "/wk ≫ singles " + singles.toFixed(1) + "/wk");
  const pl = run.ctx.placements.get(O.game + "|noclaim");
  assert.equal(pl.bulkTake, Math.min(pl.stock, Math.round((bw * run.ctx.cfg.shelfHorizonDays) / 7)));
  assert.ok(pl.bulkTake > 0);
  assert.equal(cellOf(run, O.game, "noclaim", "all").br.bt, pl.bulkTake, "logged as its own line");
  const per = Object.values(O.perAccount);
  assert.ok(!ev.orders.some((o) => o.g === O.game && per.includes(o.p)), "a per-account bulk price is never a single-unit order");
  for (const r of ev.rows.filter((x) => x.g === O.game && x.rk === "bulk")) {
    assert.equal(r.advisable, false);
    assert.ok(!run.fc.some((f) => f.l === r.id));
  }
  for (const o of run.offers.filter((x) => x.k === O.game)) assert.ok(!(o.ref > 0 && o.ref < 1), "no single priced at a bulk per-account level: " + o.ref);
});

T("R65 planted P: a rebundled row's earlier $3 sales never price its new contents", () => {
  const Pp = PLANTED.P;
  const run = smallRun();
  const ev = run.ctx.ev;
  const R = ev.rows.find((r) => r.g === Pp.game && r.m === Pp.market && r.rb !== null);
  assert.ok(R);
  near((ev.cut - R.rb) / DAY, Pp.rbDaysAgo, 0.01);
  const ref = RF.refFor(ev, { g: R.g, f: R.f, m: R.m, ck: R.ck, bk: R.bk, ex: R.ex, n: R.n, band: R.band });
  near(ref.ref, Pp.expectRef.value, Pp.expectRef.tolAbs, "the after price");
  assert.notEqual(ref.ref, Pp.expectRef.leakWouldGive);
  assert.equal(R.expo.units, Pp.after.n, "only the units sold after the rebundle are its exposure's");
  assert.equal(R.sales.length, Pp.before.n + Pp.after.n, "the earlier sales are still the game's demand");
});

T("R66 planted Q: the no-claim Gameflip ladder is reported, never corrected", () => {
  const Q = PLANTED.Q;
  const run = smallRun();
  const ladder = run.offers.filter((o) => o.k === Q.game && o.f === Q.farm && o.m === Q.market && run.ctx.ev.ladders.has(o.m + "|" + o.ck));
  assert.equal(ladder.length, 1);
  assert.equal(ladder[0].action, "ladder");
  for (const l of ladder[0].live) assert.equal(l.a, "ladder");
  const cell = cellOf(run, Q.game, Q.farm, Q.market);
  assert.equal(cell.pc, Q.expect);
  const rungs = run.ctx.ev.rows.filter((r) => r.g === Q.game && r.m === Q.market && r.activeAtCut && r.ck === ladder[0].ck);
  assert.deepEqual([...new Set(rungs.map((r) => r.p))].sort((a, b) => a - b), [Q.autoPrice].concat(Q.manualPrices));
});

T("R68 planted V and U: a new GGSel listing honours the game's hidden minimum; an unmapped G2G game is unknown", () => {
  const run = smallRun();
  const Vv = PLANTED.V;
  assert.equal(run.ctx.ev.ggselVmin.get(Vv.game), Vv.vmin);
  const nw = run.offers.find((o) => o.k === Vv.game && o.m === Vv.market && o.isNew);
  assert.ok(nw && nw.p !== null);
  assert.ok(nw.p >= Vv.vmin, "new GGSel listing at " + nw.p);
  assert.ok(nw.base < Vv.vmin, "even though today's price (" + nw.base + ") is under it");
  const Uu = PLANTED.U;
  const pl = run.ctx.placements.get(Uu.game + "|claim");
  assert.equal(pl.elig[Uu.market], "unknown");
  assert.ok(!(pl.shelf[Uu.market] > 0));
});

/* ------------------------------------------------------------------------------------------------------ */
/* the table itself                                                                                       */
/* ------------------------------------------------------------------------------------------------------ */

test("RULES: every rule has a test here, every named test exists, every test here is in the table", () => {
  const core = fs.readFileSync(path.join(__dirname, "listingBrainCore.test.js"), "utf8");
  const safetyFile = path.join(__dirname, "listingBrainSafety.test.js");
  const safety = fs.existsSync(safetyFile) ? fs.readFileSync(safetyFile, "utf8") : "";
  const ids = new Set();
  const listed = new Set();
  for (const r of RULES) {
    assert.ok(/^R\d+$/.test(r.id) && !ids.has(r.id), "rule id " + r.id);
    ids.add(r.id);
    assert.ok(r.rule && r.tests.length, r.id);
    let here = 0;
    for (const t of r.tests) {
      if (t.startsWith("core: ")) assert.ok(core.includes('test("' + t.slice(6) + '"'), r.id + ": no core test named " + t);
      else if (t.startsWith("safety: ")) assert.ok(safety.includes('"' + t.slice(8) + '"'), r.id + ": no safety test named " + t);
      else {
        assert.ok(NAMES.has(t), r.id + ": no test here named " + t);
        listed.add(t);
        here++;
      }
    }
    if (!r.tests.some((t) => t.startsWith("safety: "))) assert.ok(here > 0, r.id + " has no test in this file");
  }
  for (const n of NAMES) assert.ok(listed.has(n), "test missing from RULES: " + n);
});
