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

// unusableBots()' reason for a bot with a config and no container, and neither
// operator marker: a provision that never finished — STUCK, not parked.
const NO_CONTAINER = "no container";

// Stuck bots already reported in this process, keyed by bot id AND config
// mtime: one SystemEvent and one Telegram per bot, not one per hourly pass —
// while a later bot that reuses the id is a new bot and is reported again.
const stuckReported = new Set();

// A .provisioning lock older than this is no provision in flight: the detached
// script removes it when it ends, so one this old was left by a crash or a
// reboot mid-build. Stuck bots are reported despite it.
const PROVISION_STALE_MS = 30 * 60000;

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
      // A `docker ps` that failed lists no containers, so every bot would read
      // as stuck. Its container states are unknown, and so is the fleet.
      if (fleetState && fleetState.psOk === false)
        throw new Error("docker ps failed on the fleet host — container states unknown");
      fleetState.unusable = await unusableBots(fleetState.bots);
    } catch (e) {
      fleetState = null;
      fleetError = e.message || String(e);
    }
  } else {
    fleetError = "fleet read skipped by the caller";
  }
  const fleetKnown = !!fleetState;

  // Which games have a drop campaign running right now. Farming more of a dark
  // game only strands accounts (CoD, 2026-09-27); an unreadable list withholds
  // growth everywhere rather than guessing.
  let campaignGames = null;
  try {
    campaignGames = await activeCampaignBuckets();
  } catch (e) {
    campaignGames = null;
  }

  // Accounts per game in a no-claim bot that can FARM, and which of those bots
  // have room. A bot's config game is the label the container actually farms,
  // so it is bucketed the same way every sale is. A personal bot and one the
  // operator stopped are not supply: counting them made the fleet look bigger
  // than what farms, and a game whose only bots are like that (CoD bot 10,
  // parked by the owner 2026-09-20) is parked — never grown, which would mean
  // building it a new container.
  //
  // A bot with a config and no container (and neither marker) is STUCK
  // (2026-10-03, defect 6): a provision that never finished. Its accounts ARE
  // counted — they are claimed, and farm the moment it gets a container — so
  // the game's need does not grow; it is never topped up, and the game gets no
  // second container until it is fixed. Leaving it out of `have` is what made a
  // provision that kept failing build a new 60-account bot every pass.
  const assigned = new Map();
  const botsByGame = new Map(); // key -> { all, usable, stuck: [bot] }
  const roomBots = new Map();
  if (fleetState) {
    for (const b of fleetState.bots) {
      const key = farmDemand.bucketFor(b.game);
      if (!key) continue;
      const tally =
        botsByGame.get(key) || botsByGame.set(key, { all: 0, usable: 0, stuck: [] }).get(key);
      tally.all++;
      const why = fleetState.unusable ? fleetState.unusable.get(String(b.id)) : "";
      if (why === NO_CONTAINER) {
        tally.stuck.push({ id: String(b.id), accounts: b.accounts, configMtime: b.configMtime || 0 });
        assigned.set(key, (assigned.get(key) || 0) + b.accounts);
        continue;
      }
      // A bot that cannot farm what it is given never gets a top-up.
      if (why) continue;
      tally.usable++;
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

  // May a NEW container be created this pass at all? The container cap (from
  // the count this fleet read already holds) and the host's free RAM — the
  // checks noclaimFleet.createBot enforces — asked once per plan (the RAM read
  // is cached 60 s and asked again, free, at create). A game that cannot get a
  // container then asks the budget only for the room its bots have, and the
  // rest of the budget goes to games that can use it. A check that throws
  // blocks creates, as it does at create.
  const maxBots = fleet.maxBots();
  const containers =
    fleetState && Number.isFinite(fleetState.containers) ? fleetState.containers : null;
  let gateBlocked = "";
  if (fleetKnown) {
    try {
      const gate = await fleet.newContainerGate({ containers });
      if (gate && gate.ok === false) gateBlocked = gate.reason || "a new container is refused right now";
    } catch (e) {
      gateBlocked = `could not check whether a new container is allowed (${e.message || e})`;
    }
  }

  const games = rows.map((r) => {
    const have = fleetKnown ? assigned.get(r.key) || 0 : r.onHand + r.stock.inFlight;
    const hasCampaign = !!(campaignGames && campaignGames.has(r.key));
    const tally = botsByGame.get(r.key) || { all: 0, usable: 0, stuck: [] };
    const stuckBots = tally.stuck.slice();
    const stuck = stuckBots.map((b) => b.id);
    // Parked = every bot is the operator's own or stopped by them. A game with
    // a stuck bot is not parked — its need is real — but gets no new container
    // either (createBlocked below).
    const parked = fleetKnown && tally.all > 0 && tally.usable === 0 && stuck.length === 0;
    const fleetNeed = fleetKnown && hasCampaign && !parked ? Math.max(0, r.target - have) : 0;
    const room = (roomBots.get(r.key) || []).reduce((s, b) => s + b.room, 0);
    const createBlocked = stuck.length
      ? `bot ${stuck.join(", ")} has no container — not creating another`
      : gateBlocked;

    // The shelf. `unclaimedGameCaps` limits how many of a game's farmed accounts
    // may sit on auto-listings (Gameflip/GGSel); over the cap they stay free for
    // Eldorado and hand sales. The shelf is sized by what the SHELF sells: the
    // old rule compared the cap with the whole game's target, so a game selling
    // on Eldorado was told to commit more accounts to its slowest markets.
    const shelfCap = settings.gameCapFor(r.label) || settings.gameCapFor(r.key) || 0;
    const effectiveCap = shelfCap > 0 ? shelfCap : UNCLAIMED_DEFAULT_CAP;
    const shelfPerWeek = (r.sales && r.sales.shelfPerWeek) || 0;
    const shelfTarget =
      shelfPerWeek > 0
        ? Math.ceil((shelfPerWeek * cfg.coverageDaysFor(r.key)) / 7) + cfg.safetyStockFor(r.key)
        : 0;
    const shelfNeed = Math.max(0, shelfTarget - effectiveCap);

    const notes = [];
    const parts = r.targetParts;
    if (parts && r.target > 0)
      notes.push(
        `target ${r.target} = ${parts.shelf} on the Gameflip/GGSel shelf (sells ` +
          `${shelfPerWeek}/wk) + ${parts.other} for ${(r.sales && r.sales.otherPerWeek) || 0}/wk ` +
          `elsewhere over ${r.policy.coverageDays}d + ${parts.safety} safety` +
          (parts.shelf + parts.other + parts.safety !== r.target ? ` (held to ${r.target} by the per-game limit)` : ""),
      );
    if (r.sales && r.sales.undated > 0)
      notes.push(
        `${r.sales.undated} older sale(s) have no sale date (swept or ticked sold by hand) — not counted`,
      );
    if (parked)
      notes.push(`every ${r.label} bot is stopped by you or is your own — not grown`);
    if (stuck.length)
      notes.push(
        `bot ${stuck.join(", ")} has a config but no container (a provision that never ` +
          "finished) — its accounts are counted and never topped up, and no new bot is " +
          "built for this game until it is fixed or released",
      );
    if (gateBlocked && !stuck.length && fleetNeed > room)
      notes.push(`no new bot this pass: ${gateBlocked} — only bots with room are topped up`);
    if (fleetKnown && !hasCampaign)
      notes.push(
        campaignGames
          ? "no active drop campaign — growth withheld"
          : "campaign list unreadable — growth withheld",
      );
    if (!fleetKnown)
      notes.push(
        (withFleet ? "Pi unreachable" : "fleet not read") +
          " — fleet size unknown, growth withheld",
      );
    if (r.sales.count === 0) notes.push("no recorded sales in the window — target is the floor");
    if (shelfNeed > 0)
      notes.push(
        `shelf cap ${effectiveCap} is below the ${shelfTarget} its own sales justify — ` +
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
        room,
        parked,
        botGame: botGameFor(r.key, fleetState && fleetState.bots, campaignGames, r.label),
      },
      shelf: { cap: effectiveCap, explicit: shelfCap > 0, need: shelfNeed, suggested: Math.max(effectiveCap, shelfTarget) },
      fleetNeed,
      stuck,
      stuckBots,
      createBlocked,
      notes,
    };
  });

  // Share what the pool can spare between the games that want it, weighted by
  // the money each shortfall represents rather than by how many accounts it
  // asked for — a game selling at $4 outranks one selling at $0.75 that wants
  // twice as many. A game that cannot get a new container can only use the room
  // its bots have, so that is all it asks for: a grant it cannot spend would
  // only be taken from a game that can.
  const budget = Math.min(supply.spendable, cfg.maxPerRun);
  const grants = farmSizing.weightedSplit(
    games.map((g) => ({
      key: g.key,
      need: g.createBlocked ? Math.min(g.fleetNeed, g.fleet.room) : g.fleetNeed,
      weight: g.weight,
    })),
    budget,
  );
  for (const g of games) g.grant = grants.get(g.key) || 0;

  const out = {
    at: new Date(),
    windowDays: days,
    fleetKnown,
    fleetError,
    // Container count against the cap, and whether a provision was in flight
    // when the fleet was read (a bot it is building has no container yet) —
    // or a lock so old it is not one (provisioningStale).
    containers: { count: containers, max: maxBots },
    provisioning: fleetState ? !!fleetState.provisioning : null,
    provisioningAgeSec: fleetState && fleetState.provisioning ? fleetState.provisioningAgeSec : null,
    provisioningStale:
      !!(fleetState && fleetState.provisioning) &&
      Number.isFinite(fleetState.provisioningAgeSec) &&
      fleetState.provisioningAgeSec * 1000 > PROVISION_STALE_MS,
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

// Bots a top-up must never feed, as Map<bot id, why> (owner, 2026-09-28): one
// with no container, one the operator stopped (.operatoroff — auto power leaves
// it off), and a personal "my own" bot. On 2026-09-27 seven fresh pool accounts
// went into CoD bot 10: no container, stopped, and no CoD campaign. Throws when
// the markers cannot be read, so the caller withholds growth.
//
// The markers win over the container state (2026-10-03): the operator's own or
// stopped bot is parked whatever its container, while a container-less bot with
// neither marker is NO_CONTAINER, which plan() counts as stuck.
async function unusableBots(bots) {
  const out = new Map();
  const hosts = require("./botHosts");
  const raw = await fleet.sh(
    `for d in ${hosts.shq(fleet.BOTS_DIR)}/*/; do id=$(basename "$d"); ` +
      `[ -f "$d.operatoroff" ] && echo "$id off"; [ -f "$d.personal" ] && echo "$id personal"; done; true`,
    { timeout: 20000 },
  );
  for (const line of String(raw || "").split("\n")) {
    const [id, what] = line.trim().split(/\s+/);
    if (!id || !what) continue;
    if (!out.has(id)) out.set(id, what === "off" ? "stopped by the operator" : "personal bot");
  }
  for (const b of bots || []) {
    const id = String(b.id);
    if (b.containerState === "none" && !out.has(id)) out.set(id, NO_CONTAINER);
  }
  return out;
}

// Normalised games (farmDemand buckets) with a drop campaign running now — the
// catalog query the auto-power watcher uses — mapped to that campaign's own game
// label ("Rainbow Six Siege"), which is what a new bot must watch.
async function activeCampaignBuckets(now = new Date()) {
  const TwitchCampaign = require("../models/TwitchCampaign");
  const rows = await TwitchCampaign.find(
    { active: true, status: "ACTIVE", $or: [{ endAt: null }, { endAt: { $gt: now } }] },
    { game: 1 },
  ).lean();
  const out = new Map();
  for (const c of rows) {
    const k = farmDemand.bucketFor(c && c.game);
    if (k && !out.has(k)) out.set(k, String(c.game || "").trim());
  }
  return out;
}

// The exact game string a NEW bot for bucket `key` must farm. The bucket label
// is a keyword ("Rainbow Six") and a bot whose FavouriteGames does not name the
// real Twitch game watches nothing, so take the label the game's existing bots
// already farm, else the live campaign's own game name, else the keyword.
function botGameFor(key, bots, campaignGames, fallback) {
  const counts = new Map();
  for (const b of bots || []) {
    if (farmDemand.bucketFor(b.game) !== key || !String(b.game || "").trim()) continue;
    counts.set(b.game, (counts.get(b.game) || 0) + 1);
  }
  let best = "";
  for (const [label, n] of counts) {
    if (!best || n > counts.get(best)) best = label;
  }
  if (best) return best;
  const live = campaignGames && typeof campaignGames.get === "function" ? campaignGames.get(key) : "";
  return live || fallback;
}

// Why a new container must not be created for game row `g` right now, or "".
// A stuck bot first; then the two checks noclaimFleet.createBot enforces (the
// container cap, the host's RAM), asked BEFORE trying so a refusal is recorded
// as a reason rather than an error. A check that throws blocks the create.
async function createBlockReason(g, p) {
  if (Array.isArray(g.stuck) && g.stuck.length)
    return `bot ${g.stuck.join(", ")} has no container — not creating another`;
  try {
    const gate = await fleet.newContainerGate({
      containers: p && p.containers ? p.containers.count : null,
    });
    return gate && gate.ok === false ? gate.reason || "a new container is refused right now" : "";
  } catch (e) {
    return `could not check whether a new container is allowed (${e.message || e})`;
  }
}

// One SystemEvent + one Telegram per stuck bot per process — a bot being its
// id AND its config's mtime, so a later bot that reuses the id is reported
// again. `staleLockMin` > 0 says the .provisioning lock that would otherwise
// have held the report back has been there that long.
function reportStuck(g, actor, { staleLockMin = 0 } = {}) {
  const bots =
    Array.isArray(g.stuckBots) && g.stuckBots.length ? g.stuckBots : g.stuck.map((id) => ({ id }));
  const lock = staleLockMin
    ? ` A provision lock has been held for ${staleLockMin} min and looks stale.`
    : "";
  for (const b of bots) {
    const id = String(b.id);
    const key = id + "@" + (b.configMtime || "?");
    if (stuckReported.has(key)) continue;
    stuckReported.add(key);
    logEvent({
      category: "noclaim",
      action: "provision_stuck",
      severity: "warn",
      actor,
      subject: fleet.containerFor(id),
      game: g.label,
      detail:
        `no-claim bot ${id} (${g.label}) has a config but no container — not creating ` +
        "another. Its accounts stay claimed and counted until it is fixed or released." +
        lock,
    });
    sendTelegram(
      `⚠️ No-claim bot ${id} (${g.label}) has no container — not creating another. ` +
        "Fix or release it on the No-claim farm page." +
        lock,
    );
  }
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
//
// No bot is created for a game with a stuck bot (one with no container), at the
// container cap, or while the host is short of RAM (2026-10-03): each is
// recorded as the result's `createBlocked`, not as an error. Nor after a write
// on the host failed this pass: a create whose outcome is unknown counts as the
// pass's one create, and a failed top-up write stops creates for the rest of it.
//
// A row is put back in the pool ONLY when it is known not to be in a config
// (2026-10-03, defect 1). topUpBot says which rows the config holds; a write
// whose outcome cannot be read back releases nothing and is reported as
// topup_state_unknown — a claimed row in no bot is an orphan an operator can
// find by its note, an available row in a bot is a double-home nobody sees.
async function apply(input = {}) {
  const { actor = "allocator", dryRun = false, games: only = null } = input;
  const p = input.plan || (await plan({ days: input.days || 30 }));
  const results = [];
  let created = 0;
  // A write on the fleet host failed this pass (its outcome unreadable, or it
  // threw before a re-read could confirm it): no further creates this pass.
  let passHostTrouble = false;

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
    const r = {
      key: g.key,
      label: g.label,
      want,
      toppedUp: 0,
      createdBot: null,
      shelf: null,
      passwordUnreadable: 0,
      errors: [],
    };

    // A bot with a config and no container is a provision that never finished.
    // Say so once per bot per process — but not while a provision is running,
    // when a bot it is still building has no container yet; a lock older than
    // PROVISION_STALE_MS is no running provision, and is reported as stale.
    if (!dryRun && Array.isArray(g.stuck) && g.stuck.length && (!p.provisioning || p.provisioningStale))
      reportStuck(g, actor, {
        staleLockMin: p.provisioning ? Math.round((Number(p.provisioningAgeSec) || 0) / 60) : 0,
      });

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
      // A write on this game's host just failed: no more writes for this game
      // this pass, on to the next game (whose bots may still be topped up, but
      // which gets no create either — passHostTrouble).
      let hostTrouble = false;
      // Top up existing bots first.
      for (const bot of g.fleet.roomBots) {
        if (left <= 0) break;
        const take = Math.min(bot.room, left);
        let claimed;
        try {
          // claimForGame puts back whatever it claimed if it fails part-way.
          claimed = await fleet.claimForGame(bot.game, take, { actor });
        } catch (e) {
          r.errors.push(`top-up bot ${bot.id}: ${e.message}`);
          break;
        }
        r.passwordUnreadable += claimed.unreadablePasswords || 0;
        if (!claimed.length) break; // pool ran dry mid-pass
        let res;
        try {
          res = await fleet.topUpBot(bot.id, claimed, bot.game);
        } catch (e) {
          if (e && e.unknownState) {
            // The write may have landed: release nothing. The event says how to
            // find every one of these rows (noclaimFleet.logStateUnknown).
            hostTrouble = true;
            passHostTrouble = true;
            r.errors.push(
              `top-up bot ${bot.id}: ${e.message} — ${claimed.length} account(s) left claimed`,
            );
            fleet.logStateUnknown({
              actor,
              id: bot.id,
              game: bot.game,
              docs: claimed,
              why: `top-up failed (${e.message})`,
            });
            break;
          }
          // Thrown before any write: none of these reached the config through
          // this call, so all of them go back.
          await fleet.release(claimed, { actor }).catch(() => {});
          r.errors.push(`top-up bot ${bot.id}: ${e.message}`);
          break;
        }
        r.toppedUp += res.added;
        left -= res.added;
        // Only what the config does NOT hold goes back. A duplicate it already
        // had is in the bot and stays claimed; the old `claimed.slice(added)`
        // released the wrong rows after a skipped duplicate.
        const absent = new Set((Array.isArray(res.absentIds) ? res.absentIds : []).map(String));
        const back = claimed.filter((d) => absent.has(String(d._id)));
        if (back.length) await fleet.release(back, { actor }).catch(() => {});
        if (res.writeError) {
          hostTrouble = true;
          passHostTrouble = true;
          r.errors.push(
            `top-up bot ${bot.id}: the write failed (${res.writeError}); a re-read found ` +
              `${res.added} of the new account(s) in its config`,
          );
        }
        if (res.restartError)
          r.errors.push(
            `top-up bot ${bot.id}: accounts written, restart failed (${res.restartError}) — ` +
              "they farm from the bot's next start",
          );
        logEvent({
          category: "noclaim",
          action: "bot_topped_up",
          actor,
          subject: fleet.containerFor(bot.id),
          game: bot.game,
          count: res.added,
          detail: `topped bot ${bot.id} up to ${res.total} account(s) for ${bot.game}`,
        });
        if (hostTrouble) break;
      }

      // Still short and no room left: one new container, once per pass.
      if (left > 0 && created === 0 && !hostTrouble && !passHostTrouble) {
        const blocked = await createBlockReason(g, p);
        if (blocked) {
          r.createBlocked = blocked;
        } else {
          try {
            const out = await fleet.createBot({
              game: (g.fleet && g.fleet.botGame) || g.label,
              count: Math.min(left, fleet.MAX_PER_BOT),
              actor,
            });
            r.createdBot = out;
            created++;
            left -= out.claimed;
            r.passwordUnreadable += out.passwordUnreadable || 0;
            logEvent({
              category: "noclaim",
              action: "bot_created",
              actor,
              subject: fleet.containerFor(out.id),
              game: out.game,
              count: out.claimed,
              detail:
                `allocator created no-claim bot ${out.id} with ${out.claimed} account(s)` +
                (out.provisionError ? ` — its container did not launch (${out.provisionError})` : ""),
            });
            // The config landed, so its accounts stay claimed; the bot shows up
            // as stuck on the next pass if it never gets a container.
            if (out.provisionError)
              r.errors.push(
                `create: bot ${out.id} written but its container did not launch (${out.provisionError})`,
              );
          } catch (e) {
            r.errors.push("create: " + e.message);
            r.passwordUnreadable += (e && e.passwordUnreadable) || 0;
            if (e && e.unknownState) {
              // Its config write may have landed (createBot logged where the
              // accounts are): that is this pass's one create, and the host
              // takes no other create this pass.
              created++;
              passHostTrouble = true;
              r.createUnknown = true;
            }
          }
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
      if (sim > 0) {
        const blocked = await createBlockReason(g, p);
        if (blocked) r.createBlocked = blocked;
        else r.plannedCreate = Math.min(sim, fleet.MAX_PER_BOT);
      }
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
    createsBlocked: results
      .filter((r) => r.createBlocked)
      .map((r) => ({ game: r.label, why: r.createBlocked })),
    // Pool rows claimed and put straight back because no seller can decrypt
    // their password (noclaimFleet.claimForGame); each is skipped from then on.
    passwordUnreadable: results.reduce((s, r) => s + (r.passwordUnreadable || 0), 0),
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

    // HEARTBEAT. One line per pass, always — including the passes that decide
    // to do nothing, which is most of them.
    //
    // Without this the loop is invisible: an idle pass writes no SystemEvent,
    // sends no Telegram and touches no row, so "running fine and finding
    // nothing to do" and "never started" look identical from outside the
    // process. `status().lastRun` only helps a caller inside the same process.
    // A system whose health cannot be read is the same failure as the
    // Telegram "0 accounts" line that sent us looking here in the first place.
    // Per game: accounts farming / target, the grant this pass, parked games.
    console.log(
      "unclaimedAllocator: " +
        (cfg.autoSize ? "auto" : "advisory") +
        " pass — " +
        p.games
          .map(
            (g) =>
              `${g.label} ${g.fleet.assigned}/${g.target}` +
              (g.grant > 0 ? ` +${g.grant}` : "") +
              (g.fleet.parked ? " (parked)" : "") +
              (g.stuck && g.stuck.length ? ` (stuck bot ${g.stuck.join(",")})` : ""),
          )
          .join(", ") +
        (p.fleetKnown ? "" : " (fleet unknown: " + (p.fleetError || "?") + ")") +
        " | short by " +
        p.totals.fleetNeed +
        ", budget " +
        p.budget,
    );

    if (!cfg.autoSize && !force) return { planned: true, applied: false, plan: p };
    const applied = await apply({ plan: p, actor: force ? "operator" : "allocator" });
    if (applied && !applied.skipped) {
      console.log(
        "unclaimedAllocator: applied — +" +
          applied.toppedUp +
          " account(s), " +
          applied.created +
          " bot(s), " +
          applied.shelvesRaised +
          " shelf cap(s)" +
          (applied.errors.length ? ", " + applied.errors.length + " error(s)" : "") +
          (applied.passwordUnreadable
            ? ", " + applied.passwordUnreadable + " put back (password does not decrypt)"
            : "") +
          (applied.createsBlocked && applied.createsBlocked.length
            ? "; new bot withheld: " +
              applied.createsBlocked.map((b) => `${b.game} (${b.why})`).join("; ")
            : ""),
      );
    } else if (applied && applied.skipped) {
      console.log("unclaimedAllocator: apply skipped — " + applied.skipped);
    }
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
    // the same live-edit contract as maxAutoBots. An unreadable value falls
    // back to the hour: a throw here would end the loop for good, silently.
    const delay = Math.max(MIN_TICK_MS, intervalMin() * 60000);
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

// The pass interval in minutes, as the loop applies it.
function intervalMin() {
  let v = NaN;
  try {
    v = Number(settings.getFarmSizing().intervalMin);
  } catch {
    v = NaN;
  }
  return Math.max(MIN_TICK_MS / 60000, Number.isFinite(v) ? v : 60);
}

// Synchronous and never throws — the health page reads `lastRun` against
// `intervalMin` to tell a live loop from a dead one (docs/LIVE-FIXES-1003.md §3).
function status() {
  let cfg = {};
  try {
    cfg = settings.getFarmSizing() || {};
  } catch {
    cfg = {};
  }
  return {
    autoSize: !!cfg.autoSize,
    intervalMin: intervalMin(),
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
  botGameFor,
  plan,
  apply,
  runOnce,
  start,
  stop,
  status,
};
