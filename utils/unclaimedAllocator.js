// The no-claim farm's fleet allocator: how many accounts each no-claim game
// should be farming, and how many of them should be on sale.
//
// WHY THIS EXISTS
//
// The auto-farmer has had a sizing brain since the beginning — demandAllocation
// blends market research with our own sales and hands each game a target. The
// no-claim farm has had NOTHING. Its account count was a number the operator
// typed into a form, so the fleet drifted away from demand in both directions at
// once, and nobody could see it.
//
// Measured on prod 2026-09-08, which is what this module is shaped by:
//
//   Overwatch   ~35 sales/week — the biggest line on the whole business, 2.4x
//               the next game. Fleet ~350 accounts. Sellable stock: 33.
//               139 ledger rows sat parked as "cap release (70/game)".
//   Rainbow Six 30 units sold in days at a 45-hour median time-to-sale, then
//               ZERO stock for three days while two campaigns ran.
//
// Overwatch's problem is NOT that it needs more accounts. It has ten times the
// fleet it needs and 5x too small a SHELF: unclaimedGameCaps.overwatch is 28.
// Rainbow Six's problem is the opposite. A sizing system that only knew how to
// create bots would have made Overwatch worse.
//
// So this module reports on TWO levers and never conflates them:
//
//   fleet  — accounts farming the game (create a bot / top one up)
//   shelf  — accounts allowed on auto-listings (settings.unclaimedGameCaps)
//
// SAFETY
//
// It ships in ADVISORY mode: `plan()` measures and recommends, `apply()` only
// runs when called, and the scheduler only acts when `noclaimAutoSize` is on
// (default false). Every write goes through utils/noclaimFleet.js, so the pool
// reserve, the atomic claim, the rollback and the config permissions are the
// ones the operator's own form has always used.

const settings = require("./settings");
const farmDemand = require("./farmDemand");
const farmSizing = require("./farmSizing");
const fleet = require("./noclaimFleet");
const { logEvent } = require("./systemLog");
const { sendTelegram } = require("./telegram");

const MIN_TICK_MS = 5 * 60000;

const state = {
  timer: null,
  stopped: true,
  running: false,
  lastRun: null,
  lastPlan: null,
  lastError: "",
  lastApplied: null,
};

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

// What each no-claim game should look like, and what it would take to get there.
//
// `readFleet` is one SSH round trip to the Pi. It is the authoritative count of
// what is actually farming — the database proxy (pool rows still carrying a
// "noclaim-farm:<game>" note) misses every account that was hand-migrated into a
// no-claim bot from a managed one, which on prod is most of the Overwatch fleet.
// When the Pi is unreachable the plan still returns, marked `fleetKnown: false`,
// and REFUSES to recommend growth: not knowing how many accounts a game already
// has is exactly the condition under which "farm more" is dangerous.
async function plan({ days = 30, withFleet = true } = {}) {
  const cfg = settings.getFarmSizing();
  const rows = await farmDemand.unclaimedDemandSnapshot({ days });

  let fleetState = null;
  let fleetError = "";
  if (withFleet) {
    try {
      fleetState = await fleet.readFleet();
    } catch (e) {
      fleetError = e.message || String(e);
    }
  } else {
    fleetError = "fleet read skipped by the caller";
  }
  const fleetKnown = !!fleetState;

  // Accounts per game currently in a no-claim bot config, and which bots have
  // room. A bot's config game is the label the container actually farms, so it
  // is bucketed the same way every sale is.
  const assigned = new Map();
  const roomBots = new Map();
  if (fleetState) {
    for (const b of fleetState.bots) {
      const key = farmDemand.bucketFor(b.game);
      if (!key) continue;
      assigned.set(key, (assigned.get(key) || 0) + b.accounts);
      const room = Math.max(0, fleet.MAX_PER_BOT - b.accounts);
      if (room > 0) {
        (roomBots.get(key) || roomBots.set(key, []).get(key)).push({
          id: b.id,
          game: b.game,
          accounts: b.accounts,
          room,
          running: b.running,
        });
      }
    }
    // Fill the emptiest bots first, so top-ups even the fleet out instead of
    // repeatedly topping whichever bot the listing happened to return first.
    for (const list of roomBots.values()) list.sort((a, b) => b.room - a.room);
  }

  const supply = await fleet.spendable("").catch(() => ({ ready: 0, reserve: 0, spendable: 0 }));

  const games = rows.map((r) => {
    const have = fleetKnown ? assigned.get(r.key) || 0 : r.onHand + r.stock.inFlight;
    const fleetNeed = fleetKnown ? Math.max(0, r.target - have) : 0;

    // The shelf. `unclaimedGameCaps` limits how many of a game's farmed accounts
    // may sit on auto-listings; over the cap they are held for hand sales. When
    // the cap is below the coverage target it is the binding constraint, and no
    // amount of farming will put more stock in front of a buyer.
    const shelfCap = settings.gameCapFor(r.label) || settings.gameCapFor(r.key) || 0;
    const effectiveCap = shelfCap > 0 ? shelfCap : UNCLAIMED_DEFAULT_CAP;
    const shelfNeed = Math.max(0, r.target - effectiveCap);

    const notes = [];
    if (!fleetKnown)
      notes.push(
        (withFleet ? "Pi unreachable" : "fleet not read") +
          " — fleet size unknown, growth withheld",
      );
    if (r.sales.count === 0) notes.push("no recorded sales in the window — target is the floor");
    if (shelfNeed > 0)
      notes.push(
        `shelf cap ${effectiveCap} is below the ${r.target} the sell rate justifies — ` +
          "raising the cap puts existing stock on sale and costs no accounts",
      );
    if (fleetKnown && have > r.target * 2 && r.target > 0)
      notes.push(`fleet is ${have} for a target of ${r.target} — over-supplied, do not grow`);
    if (r.daysOfCover != null && r.daysOfCover < 3 && r.sales.perWeek > 0)
      notes.push(`only ${r.daysOfCover} days of stock left at the current sell rate`);
    // A price the model never saw is a price the weighting cannot use.
    if (r.sales.count > 0 && !r.sales.priced)
      notes.push("no sale in this window recorded a price — weighting falls back to unit count");

    // farmDemand computed need/spare from its database proxy for what is
    // farming. When the live fleet read succeeded, THAT is the authoritative
    // number, so the gap is recomputed against it — otherwise the row would
    // show a "spare" that disagrees with its own fleetNeed.
    const gap = farmSizing.stockGap({ target: r.target, onHand: have, inFlight: 0 });

    return {
      ...r,
      need: gap.need,
      spare: gap.spare,
      fleet: {
        known: fleetKnown,
        assigned: have,
        bots: fleetKnown ? (roomBots.get(r.key) || []).length : null,
        roomBots: roomBots.get(r.key) || [],
      },
      shelf: { cap: effectiveCap, explicit: shelfCap > 0, need: shelfNeed, suggested: Math.max(effectiveCap, r.target) },
      fleetNeed,
      notes,
    };
  });

  // Share what the pool can spare between the games that want it, weighted by
  // the money each shortfall represents rather than by how many accounts it
  // asked for — a game selling at $4 outranks one selling at $0.75 that wants
  // twice as many.
  const budget = Math.min(supply.spendable, cfg.maxPerRun);
  const grants = farmSizing.weightedSplit(
    games.map((g) => ({ key: g.key, need: g.fleetNeed, weight: g.weight })),
    budget,
  );
  for (const g of games) g.grant = grants.get(g.key) || 0;

  const out = {
    at: new Date(),
    windowDays: days,
    fleetKnown,
    fleetError,
    supply,
    budget,
    policy: {
      coverageDays: cfg.coverageDays,
      safetyStock: cfg.safetyStock,
      maxPerGame: cfg.maxPerGame,
      maxPerRun: cfg.maxPerRun,
      autoSize: cfg.autoSize,
    },
    games,
    totals: {
      salesPerWeek: round1(games.reduce((s, g) => s + g.sales.perWeek, 0)),
      onHand: games.reduce((s, g) => s + g.onHand, 0),
      assigned: games.reduce((s, g) => s + (g.fleet.assigned || 0), 0),
      target: games.reduce((s, g) => s + g.target, 0),
      fleetNeed: games.reduce((s, g) => s + g.fleetNeed, 0),
      granted: games.reduce((s, g) => s + g.grant, 0),
    },
  };
  state.lastPlan = out;
  return out;
}

// The unclaimed engine's own default when no per-game cap is configured
// (utils/unclaimedAutoList.js GAME_CAP). Mirrored rather than imported: pulling
// in that 4,000-line engine to read one constant would make this module load the
// whole listing stack, and the test in tests/unclaimedAllocator.test.js pins the
// two together.
const UNCLAIMED_DEFAULT_CAP = 70;

const round1 = (n) => Math.round(num(n) * 10) / 10;

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

// Execute a plan. Returns what it did, per game, and never throws for one game's
// failure — a Pi hiccup on Overwatch must not stop Rainbow Six being restocked.
//
// Order of preference is deliberate: TOP UP an existing bot before creating a
// new one. Containers are the scarce resource (~130MB of Pi RAM each, and a hard
// `maxAutoBots`-shaped ceiling on the box), while adding 30 accounts to a bot
// that holds 20 costs nothing at all. Only when every bot for a game is full
// does this create a container.
//
// At most ONE bot is created per pass, because provisioning takes a global lock
// on the Pi (BASE/.provisioning) and a second create would simply 409. The next
// pass creates the next one.
async function apply(input = {}) {
  const { actor = "allocator", dryRun = false, games: only = null } = input;
  const p = input.plan || (await plan({ days: input.days || 30 }));
  const results = [];
  let created = 0;

  if (!p.fleetKnown) {
    return {
      at: new Date(),
      dryRun,
      skipped: "fleet size unknown (Pi unreachable) — growth withheld",
      results,
    };
  }

  for (const g of p.games) {
    if (only && !only.includes(g.key)) continue;
    const want = Math.max(0, Math.min(g.grant, g.fleetNeed));
    const r = { key: g.key, label: g.label, want, toppedUp: 0, createdBot: null, shelf: null, errors: [] };

    // --- The shelf. Free, instant, and usually the actual bottleneck. --------
    //
    // An EXPLICIT cap is never raised automatically. `unclaimedGameCaps` is how
    // the operator says "hold this game back" — Overwatch's cap of 28 exists
    // because they hand-sell Overwatch in bulk from the held pile, and the
    // coverage model, which only sees automated sales, would read that as a
    // shortage and put 170 accounts they wanted in hand onto Gameflip. The
    // recommendation is still reported; acting on it needs `raiseExplicit`.
    const shelfLocked = g.shelf.explicit && !input.raiseExplicit;
    if (g.shelf.need > 0 && shelfLocked) {
      r.shelf = {
        from: g.shelf.cap,
        to: g.shelf.suggested,
        applied: false,
        blocked: "cap was set by hand — raise it yourself, or re-run with raiseExplicit",
      };
    } else if (g.shelf.need > 0) {
      if (dryRun) {
        r.shelf = { from: g.shelf.cap, to: g.shelf.suggested, applied: false };
      } else {
        try {
          const caps = { ...(settings.getUnclaimedPricing().gameCaps || {}) };
          caps[g.key] = g.shelf.suggested;
          await settings.setAutoFarm({ unclaimedGameCaps: caps }, { actor });
          r.shelf = { from: g.shelf.cap, to: g.shelf.suggested, applied: true };
          logEvent({
            category: "noclaim",
            action: "shelf_cap_raised",
            actor,
            subject: g.key,
            game: g.label,
            count: g.shelf.suggested,
            detail:
              `auto-list cap for ${g.label} raised ${g.shelf.cap} -> ${g.shelf.suggested} ` +
              `(${g.sales.perWeek}/week, ${p.policy.coverageDays}d cover)`,
          });
        } catch (e) {
          r.errors.push("shelf cap: " + e.message);
        }
      }
    }

    // --- The fleet. -------------------------------------------------------
    let left = want;
    if (left > 0 && !dryRun) {
      // Top up existing bots first.
      for (const bot of g.fleet.roomBots) {
        if (left <= 0) break;
        const take = Math.min(bot.room, left);
        let claimed = [];
        try {
          claimed = await fleet.claimForGame(bot.game, take, { actor });
          if (!claimed.length) break; // pool ran dry mid-pass
          const res = await fleet.topUpBot(bot.id, claimed, bot.game);
          r.toppedUp += res.added;
          left -= res.added;
          // Anything the config rejected as a duplicate was claimed and never
          // used — put it straight back rather than leaving it stranded.
          if (res.added < claimed.length) {
            await fleet.release(claimed.slice(res.added), { actor }).catch(() => {});
          }
          logEvent({
            category: "noclaim",
            action: "bot_topped_up",
            actor,
            subject: fleet.containerFor(bot.id),
            game: bot.game,
            count: res.added,
            detail: `topped bot ${bot.id} up to ${res.total} account(s) for ${bot.game}`,
          });
        } catch (e) {
          await fleet.release(claimed, { actor }).catch(() => {});
          r.errors.push(`top-up bot ${bot.id}: ${e.message}`);
          break;
        }
      }

      // Still short and no room left: one new container, once per pass.
      if (left > 0 && created === 0) {
        try {
          const out = await fleet.createBot({
            game: g.label,
            count: Math.min(left, fleet.MAX_PER_BOT),
            actor,
          });
          r.createdBot = out;
          created++;
          left -= out.claimed;
          logEvent({
            category: "noclaim",
            action: "bot_created",
            actor,
            subject: fleet.containerFor(out.id),
            game: out.game,
            count: out.claimed,
            detail: `allocator created no-claim bot ${out.id} with ${out.claimed} account(s)`,
          });
        } catch (e) {
          r.errors.push("create: " + e.message);
        }
      }
    } else if (left > 0 && dryRun) {
      // Show the same split a real run would take, without touching anything.
      let sim = left;
      r.plannedTopUps = [];
      for (const bot of g.fleet.roomBots) {
        if (sim <= 0) break;
        const take = Math.min(bot.room, sim);
        r.plannedTopUps.push({ id: bot.id, add: take });
        sim -= take;
      }
      if (sim > 0) r.plannedCreate = Math.min(sim, fleet.MAX_PER_BOT);
    }

    r.shortfall = Math.max(0, left);
    results.push(r);
  }

  const summary = {
    at: new Date(),
    dryRun,
    actor,
    toppedUp: results.reduce((s, r) => s + r.toppedUp, 0),
    created: results.filter((r) => r.createdBot).length,
    shelvesRaised: results.filter((r) => r.shelf && r.shelf.applied).length,
    errors: results.flatMap((r) => r.errors),
    results,
  };
  if (!dryRun) {
    state.lastApplied = summary;
    if (summary.toppedUp || summary.created || summary.shelvesRaised) {
      logEvent({
        category: "noclaim",
        action: "fleet_sized",
        actor,
        count: summary.toppedUp,
        detail:
          `fleet sizing: +${summary.toppedUp} account(s), ` +
          `${summary.created} new bot(s), ${summary.shelvesRaised} shelf cap(s) raised`,
        meta: summary.results.map((r) => ({
          game: r.label,
          toppedUp: r.toppedUp,
          created: r.createdBot ? r.createdBot.id : null,
          shelf: r.shelf,
        })),
      });
      sendTelegram(
        "📈 No-claim fleet sizing\n\n" +
          summary.results
            .filter((r) => r.toppedUp || r.createdBot || (r.shelf && r.shelf.applied))
            .map(
              (r) =>
                `${r.label}: +${r.toppedUp} acct` +
                (r.createdBot ? `, new bot ${r.createdBot.id}` : "") +
                (r.shelf && r.shelf.applied ? `, shelf ${r.shelf.from}→${r.shelf.to}` : ""),
            )
            .join("\n"),
      );
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

// One pass. Measures always; acts only when the operator has turned auto-sizing
// on. Measuring unconditionally is the point — the panel and the history are
// worth having whether or not anything is allowed to act on them.
async function runOnce({ force = false } = {}) {
  if (state.running) return { skipped: "already running" };
  state.running = true;
  try {
    const cfg = settings.getFarmSizing();
    const p = await plan({ days: 30 });
    state.lastRun = new Date();
    state.lastError = "";
    if (!cfg.autoSize && !force) return { planned: true, applied: false, plan: p };
    const applied = await apply({ plan: p, actor: force ? "operator" : "allocator" });
    return { planned: true, applied: true, plan: p, result: applied };
  } catch (e) {
    state.lastError = e.message || String(e);
    console.error("unclaimedAllocator:", state.lastError);
    return { error: state.lastError };
  } finally {
    state.running = false;
  }
}

function start() {
  if (state.timer || state.stopped === false) return;
  state.stopped = false;
  const loop = async () => {
    try {
      await runOnce();
    } catch {
      /* runOnce already records lastError; never let a pass kill the loop */
    }
    if (state.stopped) return;
    // Interval is re-read from settings EVERY pass, so an operator changing
    // noclaimSizeIntervalMin takes effect on the next tick with no restart —
    // the same live-edit contract as maxAutoBots.
    const cfg = settings.getFarmSizing();
    const delay = Math.max(MIN_TICK_MS, cfg.intervalMin * 60000);
    state.timer = setTimeout(loop, delay);
    if (state.timer.unref) state.timer.unref();
  };
  // First pass deliberately late. The Pi read is seconds of RTT and boot is the
  // worst moment to spend it; the demand snapshot is not time-critical.
  state.timer = setTimeout(loop, 3 * 60000);
  if (state.timer.unref) state.timer.unref();
}

function stop() {
  state.stopped = true;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

function status() {
  const cfg = settings.getFarmSizing();
  return {
    autoSize: cfg.autoSize,
    intervalMin: cfg.intervalMin,
    maxPerRun: cfg.maxPerRun,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastApplied: state.lastApplied,
    started: !!state.timer,
  };
}

module.exports = {
  UNCLAIMED_DEFAULT_CAP,
  plan,
  apply,
  runOnce,
  start,
  stop,
  status,
};
