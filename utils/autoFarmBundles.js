// Auto-farm event bundles — group a game's farmed waves into ONE sellable
// event bundle, title it, and price it on evidence.
//
// Frozen spec: docs/AUTOFARM-BUNDLES-CONTRACT.md.
//
// WHY THIS EXISTS
// The auto-farm publishes one listing per CAMPAIGN. Twitch ships events in
// waves ("CAH Championship Week 1" then "Finals", "EWC 2026 DAY 1..10"), so an
// account that farmed three waves holds the whole event while three thin
// listings sell one wave each. The only bundling path that existed
// (autoLister.listStackedBundle) unioned EVERY prior set for the game
// regardless of event, which the holdings gate then correctly refused to back
// — the usual outcome was "no free account holds the full stack yet".
//
// The unclaimed farm already solved the same problem for its own stock
// (utils/unclaimedBundles.js). Everything reusable is reused from there rather
// than reimplemented: the wave parser, the event catalog, the title builder and
// the description lines. What is genuinely different lives here — the auto-farm
// keeps its stock on AutoFarmTask.assignedAccounts and its per-wave item lists
// on published DropSets, so waves are placed from TASKS, not from live Twitch
// inventory.
//
// Everything above `loadCatalogForGames` is pure (no Mongo, no network, no
// settings write) so tests/autoFarmBundles.test.js runs under node:test alone.

const settings = require("./settings");
const unclaimedBundles = require("./unclaimedBundles");
const { mergeWaveItems } = require("./radarEventListings");

const { parseWave, eventKeyFor, bundleTitle, bundleDescriptionLines } =
  unclaimedBundles;

// The shared pricing engine is required lazily. It is the newest module in the
// tree and this one is required at server boot through autoLister; a lazy
// require means a missing or broken pricer degrades the bundle price to the
// caller's fallback instead of taking the whole process down at startup.
let pricingMod = null;
let pricingEvidenceMod = null;
function pricing() {
  if (pricingMod === null) {
    try {
      pricingMod = require("./pricing");
    } catch (e) {
      console.error("autoFarmBundles: pricing engine unavailable:", e.message);
      pricingMod = false;
    }
  }
  return pricingMod || null;
}
function pricingEvidence() {
  if (pricingEvidenceMod === null) {
    try {
      pricingEvidenceMod = require("./pricingEvidence");
    } catch (e) {
      console.error(
        "autoFarmBundles: pricing evidence unavailable:",
        e.message,
      );
      pricingEvidenceMod = false;
    }
  }
  return pricingEvidenceMod || null;
}

/* ------------------------------- text utils ------------------------------ */

function text(value) {
  return String(value == null ? "" : value).trim();
}

function lower(value) {
  return text(value).replace(/\s+/g, " ").toLowerCase();
}

function toTime(value) {
  if (!value) return 0;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Statuses whose accounts still hold sellable stock. `planned` never had
// accounts; `skipped`/`failed` released theirs. A `stopped` task's accounts
// keep the drops they already farmed, so its wave still counts.
const STOCK_STATUSES = new Set(["active", "completed", "stopped"]);

function taskHasStock(task) {
  if (!task) return false;
  if (!STOCK_STATUSES.has(text(task.status))) return false;
  return (task.assignedAccounts || []).some((u) => text(u));
}

/* ---------------------------- wave placement ----------------------------- */

// A wave counts toward "is this event complete" once it has STARTED. An
// announced-but-unstarted wave is not a hole in the bundle — nobody could have
// farmed it yet — so it neither blocks `full` nor is advertised.
// (Same rule as unclaimedBundles' internal waveStarted; duplicated rather than
// exported across the module boundary because it is three lines and the two
// modules are meant to stay independently testable.)
function waveStarted(wave, now = Date.now()) {
  const start = toTime(wave && wave.startAt);
  const end = toTime(wave && wave.endAt);
  if (!start && !end) return true; // unknown dates: assume it ran
  if (start && start <= now) return true;
  if (end && end < now) return true;
  return false;
}

// Wave display labels for a whole plan, in wave order.
//
// unclaimedBundles' rule — an unmarked campaign next to marked siblings is the
// event's "Main" wave — only holds when there is exactly ONE unmarked wave.
// Live data (2026-09-08) is full of events whose campaigns carry no wave marker
// at all: Black Desert's "New Class: Agent" ran six of them, and labelling each
// one "Main" produced the title "… New Class: Agent Main + Main + Main + Main +
// Main + Main (12 Items)". When the labels cannot tell the waves apart they say
// nothing, and the title falls back to naming the event and its contents.
function waveLabels(waves) {
  const raw = (waves || []).map((w) => text(w && w.waveLabel));
  const labelled = raw.filter(Boolean).length;
  const unlabelled = raw.length - labelled;
  return raw.map((label) => {
    if (label) return label;
    return labelled > 0 && unlabelled === 1 ? "Main" : "";
  });
}

// Twitch campaign names are hand-written, and parseWave strips a terminal wave
// marker together with any bracket around it — "Hunt 1896 (Week 2, Pt. 1)"
// leaves the event named "Hunt 1896 (Week 2,". That is a display problem only
// (the event KEY is built from the raw parse, so grouping is untouched), so it
// is fixed here rather than in the shared parser: drop trailing separators and
// cut at any bracket that was left open.
function tidyEventName(name) {
  let out = text(name);
  const trim = (v) => v.replace(/[\s,;:_\-\u2013\u2014|/]+$/, "").trim();
  out = trim(out);
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ]) {
    let cut = out.lastIndexOf(open);
    while (cut >= 0) {
      if (out.indexOf(close, cut) >= 0) break; // balanced — leave it alone
      out = trim(out.slice(0, cut));
      cut = out.lastIndexOf(open);
    }
  }
  return out || text(name);
}

// Index the catalog by campaignId so a task finds its wave without re-parsing.
function indexCatalog(catalog) {
  const byCampaign = new Map();
  const byGameEvent = new Map();
  if (!catalog || typeof catalog.values !== "function") {
    return { byCampaign, byGameEvent };
  }
  for (const event of catalog.values()) {
    if (!event) continue;
    byGameEvent.set(event.key, event);
    for (const wave of event.waves || []) {
      const id = text(wave.campaignId);
      if (id && !byCampaign.has(id)) byCampaign.set(id, { event, wave });
    }
  }
  return { byCampaign, byGameEvent };
}

// Where does this task's campaign sit? The catalog wins (it carries the
// manifest, the real dates and the sibling waves); a campaign the catalog has
// never seen — an old task whose TwitchCampaign row aged out of the 120-day
// window — is still placed by parsing its own recorded name, so a long-running
// event never loses its early waves.
function placeTask(task, index, catalogFallback = true) {
  const id = text(task && task.campaignId);
  const hit = id ? index.byCampaign.get(id) : null;
  if (hit) {
    return {
      eventKey: hit.event.key,
      eventName: hit.event.name,
      game: hit.event.game || text(task.game),
      wave: hit.wave,
      known: true,
    };
  }
  if (!catalogFallback) return null;
  const game = text(task && task.game);
  const name = text(task && task.campaignName);
  if (!game || !name) return null;
  const parsed = parseWave(name);
  return {
    eventKey: eventKeyFor(game, parsed.eventName),
    eventName: parsed.eventName,
    game,
    wave: {
      campaignId: id,
      name,
      waveLabel: parsed.waveLabel,
      order: parsed.order,
      // A task carries only the END of its campaign, so an unknown campaign is
      // dated by that alone; waveStarted then reads it as started once it has
      // passed, and as started-unknown while it has not.
      startAt: null,
      endAt: (task && task.campaignEndAt) || null,
      items: [],
    },
    known: false,
  };
}

/* ------------------------------ the planner ------------------------------ */

function itemsFromSet(set) {
  if (!set || !Array.isArray(set.items)) return [];
  return set.items
    .filter((i) => i && text(i.itemKey))
    .map((i) => ({
      itemKey: text(i.itemKey),
      name: text(i.name) || "Reward",
      game: text(i.game),
      image: text(i.image),
      qty: Math.max(1, Math.floor(Number(i.qty) || 1)),
    }));
}

function itemsFromManifest(wave, game) {
  return (wave && wave.items ? wave.items : [])
    .filter((i) => i && text(i.itemKey))
    .map((i) => ({
      itemKey: text(i.itemKey),
      name: text(i.name) || "Reward",
      game,
      image: "",
      qty: Math.max(1, Math.floor(Number(i.qty) || 1)),
    }));
}

// Per-wave items, preferring what we actually PUBLISHED for that wave. A task's
// own DropSet is the strongest source: it carries images (the cover grid needs
// them), the copy counts the live listing already promises, and it is what the
// holdings gate has been verifying against all along. The campaign manifest is
// the fallback for a wave that never got listed.
function waveItems(wave, game, tasks, setsById) {
  for (const task of tasks || []) {
    const setId = task && task.listing && text(task.listing.setId);
    const set = setId && setsById ? setsById.get(String(setId)) : null;
    const items = itemsFromSet(set);
    if (items.length) return { items, source: "listing" };
  }
  const manifest = itemsFromManifest(wave, game);
  if (manifest.length) return { items: manifest, source: "manifest" };
  return { items: [], source: "" };
}

function signatureOf(items) {
  return (items || [])
    .map((i) => lower(i.itemKey) + "x" + Math.max(1, Number(i.qty) || 1))
    .sort()
    .join("|");
}

function loginsOf(tasks) {
  const out = new Set();
  for (const task of tasks || []) {
    for (const login of (task && task.assignedAccounts) || []) {
      const k = lower(login);
      if (k) out.add(k);
    }
  }
  return [...out];
}

/**
 * Group a game's tasks into event bundle plans.
 *
 * Pure: everything it needs is passed in. `catalog` is an
 * unclaimedBundles.buildEventCatalog map, `setsById` a Map(setId → DropSet).
 *
 * Returns plans sorted best-first (complete events before partial ones, then
 * the most waves, then the most recent), one per event with ≥ `minWaves`
 * farmed waves. A single-wave event is not a bundle — that IS the solo
 * listing — so it is never returned.
 */
function planEventBundles({
  game = "",
  tasks = [],
  catalog = null,
  setsById = null,
  now = Date.now(),
  minWaves = 2,
} = {}) {
  const index = indexCatalog(catalog);
  const gameKey = settings.normGameName(game);

  // task → wave, grouped by event.
  const events = new Map();
  for (const task of tasks) {
    if (!taskHasStock(task)) continue;
    if (gameKey && settings.normGameName(task.game) !== gameKey) continue;
    const placed = placeTask(task, index);
    if (!placed) continue;
    let entry = events.get(placed.eventKey);
    if (!entry) {
      entry = {
        key: placed.eventKey,
        game: placed.game || game,
        name: placed.eventName,
        waves: new Map(), // campaignId (or lowered name) → { wave, tasks: [] }
        catalogEvent: index.byGameEvent.get(placed.eventKey) || null,
      };
      events.set(placed.eventKey, entry);
    }
    const waveId = text(placed.wave.campaignId) || lower(placed.wave.name);
    let slot = entry.waves.get(waveId);
    if (!slot) {
      slot = { wave: placed.wave, tasks: [] };
      entry.waves.set(waveId, slot);
    }
    slot.tasks.push(task);
  }

  const plans = [];
  for (const entry of events.values()) {
    const held = [...entry.waves.values()];
    held.sort(
      (a, b) =>
        (a.wave.order || 0) - (b.wave.order || 0) ||
        toTime(a.wave.startAt) - toTime(b.wave.startAt) ||
        String(a.wave.name).localeCompare(String(b.wave.name)),
    );

    // How many waves this event is KNOWN to have run. Taken from the catalog
    // (which sees waves we never farmed); when the event is not in the catalog
    // at all, the waves we hold are all we know about.
    const catalogWaves = entry.catalogEvent
      ? (entry.catalogEvent.waves || []).filter((w) => waveStarted(w, now))
      : [];
    const wavesTotal = Math.max(catalogWaves.length, held.length);

    const waves = [];
    let unknownItems = 0;
    for (const slot of held) {
      const resolved = waveItems(slot.wave, entry.game, slot.tasks, setsById);
      if (!resolved.items.length) {
        unknownItems += 1;
        continue;
      }
      waves.push({
        campaignId: text(slot.wave.campaignId),
        name: text(slot.wave.name),
        waveLabel: text(slot.wave.waveLabel),
        label: "",
        order: slot.wave.order || 0,
        startAt: slot.wave.startAt || null,
        endAt: slot.wave.endAt || null,
        game: entry.game,
        items: resolved.items,
        source: resolved.source,
        tasks: slot.tasks,
      });
    }
    if (waves.length < Math.max(2, minWaves)) continue;

    const labels = waveLabels(waves);
    waves.forEach((wave, i) => {
      wave.label = labels[i];
    });

    const items = mergeWaveItems(waves);
    if (!items.length) continue;

    const tasksInPlan = waves.flatMap((w) => w.tasks);
    // "Complete" means every started wave of the event is in the bundle. A
    // wave we farmed but whose items we could not resolve counts against it —
    // advertising COMPLETE while a wave's contents are unknown is exactly the
    // over-promise the holdings gate exists to prevent.
    const full = waves.length >= wavesTotal && unknownItems === 0;

    plans.push({
      key: entry.key,
      game: entry.game,
      eventName: tidyEventName(entry.name),
      eventNameRaw: entry.name,
      waves: waves.map(({ tasks: _tasks, ...rest }) => rest),
      labels: labels.filter(Boolean),
      wavesHeld: waves.length,
      wavesTotal,
      wavesUnresolved: unknownItems,
      full,
      items,
      totalQty: items.reduce((n, i) => n + Math.max(1, Number(i.qty) || 1), 0),
      campaignIds: waves.map((w) => w.campaignId).filter(Boolean),
      taskIds: [...new Set(tasksInPlan.map((t) => String(t._id)))],
      logins: loginsOf(tasksInPlan),
      signature: signatureOf(items),
      latestEndAt: waves.reduce(
        (max, w) => (toTime(w.endAt) > toTime(max) ? w.endAt : max),
        null,
      ),
    });
  }

  plans.sort(
    (a, b) =>
      Number(b.full) - Number(a.full) ||
      b.wavesHeld - a.wavesHeld ||
      b.items.length - a.items.length ||
      toTime(b.latestEndAt) - toTime(a.latestEndAt),
  );
  return plans;
}

// The plan a given task belongs to, or null. Used by the publisher: a task is
// swept, and the question is "is this task part of a multi-wave event we could
// be selling as one bundle?".
function planForTask(task, plans) {
  if (!task) return null;
  const id = String(task._id || "");
  const campaignId = text(task.campaignId);
  for (const plan of plans || []) {
    if (id && plan.taskIds.includes(id)) return plan;
    if (campaignId && plan.campaignIds.includes(campaignId)) return plan;
  }
  return null;
}

/* ------------------------------ presentation ----------------------------- */

// The shape unclaimedBundles' title/description builders expect. Building it
// here (rather than a second title implementation) is what keeps both farms
// speaking the same house style, including the 120-char Gameflip clamping and
// the "(1 Item)" singular fix.
function classificationFor(plan) {
  if (!plan) return null;
  // Campaigns that carry no event or wave marker at all are named after the
  // game itself ("Halo: Campaign Evolved" x3). Grouping them is still right —
  // an account that farmed all three holds three copies — but calling that
  // "Halo: Campaign Evolved COMPLETE BUNDLE" says the game's name twice and
  // claims an event that never existed. With nothing to add, make no event
  // claim: the house title then describes the contents, which is the honest
  // thing it has to sell.
  const namesTheGameOnly =
    !plan.labels.length &&
    settings.normGameName(plan.eventName) === settings.normGameName(plan.game);
  if (namesTheGameOnly) {
    return {
      game: plan.game,
      event: null,
      events: [],
      waves: plan.waves,
      wavesHeld: plan.wavesHeld,
      wavesTotal: plan.wavesTotal,
      heldLabels: [],
      full: !!plan.full,
      items: plan.items,
      bundleKey: plan.key,
      bundleLabel:
        plan.game + " (" + (plan.full ? "complete" : "partial") + ")",
    };
  }
  return {
    game: plan.game,
    event: { key: plan.key, name: plan.eventName },
    events: [{ key: plan.key, name: plan.eventName, complete: !!plan.full }],
    waves: plan.waves,
    wavesHeld: plan.wavesHeld,
    wavesTotal: plan.wavesTotal,
    heldLabels: plan.labels,
    full: !!plan.full,
    items: plan.items,
    bundleKey: plan.key + "|" + plan.labels.map((l) => lower(l)).join("+"),
    bundleLabel:
      plan.eventName +
      (plan.labels.length ? " — " + plan.labels.join(" + ") : "") +
      " (" +
      (plan.full ? "complete" : "partial") +
      ")",
  };
}

function bundleTitleFor(plan) {
  return bundleTitle({
    game: plan.game,
    items: plan.items,
    classification: classificationFor(plan),
  });
}

// Extra description lines for the house template: the event/wave claim and the
// duplicate-copies note. `bundleDescriptionLines` also emits a bulk line for
// quantity marketplaces, which is exactly right here too — the auto-farm's
// Plati/GGSel shares are quantity products.
function bundleDescriptionLinesFor(plan, marketplace) {
  return bundleDescriptionLines({
    game: plan.game,
    items: plan.items,
    classification: classificationFor(plan),
    marketplace,
  });
}

// DropSet.name — an operator-facing label, not a marketplace title.
function bundleSetName(plan) {
  return (
    plan.game +
    " — " +
    plan.eventName +
    (plan.full ? " complete event bundle" : " event bundle") +
    " (" +
    plan.wavesHeld +
    (plan.wavesTotal > plan.wavesHeld ? " of " + plan.wavesTotal : "") +
    " wave" +
    (plan.wavesHeld === 1 ? "" : "s") +
    ")"
  );
}

function bundleSetNote(plan) {
  const lines = [
    plan.game + " Twitch Drops from " + plan.eventName + ".",
    "Waves: " +
      plan.waves.map((w) => w.label || w.name).join(" + ") +
      (plan.full
        ? " — every wave of the event."
        : " — " + plan.wavesHeld + " of " + plan.wavesTotal + " waves."),
    "Auto-farmed by the auto-farm engine; stock is restricted to the accounts " +
      "assigned to this event's waves and verified to hold the whole bundle.",
  ];
  return lines.join("\n");
}

/* -------------------------------- pricing -------------------------------- */

/**
 * Price one event bundle with the shared engine.
 *
 * Deliberately NOT autoLister.derivePrice: that pricer anchors on
 * `gameflip.lowest`, which is frequently our own listing (the self-undercut
 * that pinned every unclaimed row at $0.75), and it has no notion of bundle
 * size, event completeness or what this exact bundle has already sold for.
 * The engine takes all three, and reports the basis so a surprising price is
 * explainable rather than mysterious.
 *
 * Returns null when the engine is unavailable — the caller keeps its own
 * fallback rather than publishing an invented number.
 */
async function priceBundle({
  plan,
  game = "",
  marketplace = "gameflip",
  research = null,
  soldFloorUsd = 0,
  opts = {},
} = {}) {
  const engine = pricing();
  const evidenceMod = pricingEvidence();
  if (!engine || !plan) return null;
  let evidence = {};
  if (evidenceMod && typeof evidenceMod.evidenceFor === "function") {
    try {
      evidence = await evidenceMod.evidenceFor({
        game: game || plan.game,
        marketplace,
        research,
      });
    } catch (e) {
      console.error("autoFarmBundles: evidence lookup failed:", e.message);
      evidence = {};
    }
  }
  try {
    // itemCount is the TOTAL qty, matching the unclaimed pricer: two copies of
    // an item from two waves really is more than one. The engine's sqrt curve
    // and 2.5x cap keep that from running away.
    return engine.priceListing({
      evidence,
      itemCount: plan.totalQty || plan.items.length || 1,
      fullEvent: !!plan.full,
      soldFloorUsd,
      marketplace,
      opts,
    });
  } catch (e) {
    console.error("autoFarmBundles: priceListing failed:", e.message);
    return null;
  }
}

/* ------------------------------ DB loaders ------------------------------- */

const TASK_FIELDS = {
  game: 1,
  campaignId: 1,
  campaignName: 1,
  campaignEndAt: 1,
  status: 1,
  assignedAccounts: 1,
  "listing.setId": 1,
  "stackListing.setId": 1,
  completedAt: 1,
  updatedAt: 1,
};

async function loadCatalogForGames(games) {
  const list = (Array.isArray(games) ? games : [games]).filter(Boolean);
  if (!list.length) return new Map();
  return unclaimedBundles.loadCatalog({ games: list });
}

// The catalog for EVERY game the auto-farm holds stock for, built once and
// shared.
//
// The obvious shape — load the catalog per game — is a trap here:
// unclaimedBundles.loadCatalog fetches the whole 120-day TwitchCampaign window
// and filters it in memory, so asking it per game re-reads that window once
// per game. With fifty stock-bearing games that is fifty full-window reads on
// a shared-tier Atlas whose real cost is bytes returned. One read, cached, is
// the same answer: planEventBundles already filters by game itself, so a
// catalog carrying other games' events changes nothing it decides.
const CATALOG_TTL_MS = 10 * 60 * 1000;
let fleetCatalogCache = { at: 0, catalog: null };

async function fleetEventCatalog({ fresh = false } = {}) {
  if (
    !fresh &&
    fleetCatalogCache.catalog &&
    Date.now() - fleetCatalogCache.at < CATALOG_TTL_MS
  ) {
    return fleetCatalogCache.catalog;
  }
  const AutoFarmTask = require("../models/AutoFarmTask");
  const games = (
    await AutoFarmTask.distinct("game", {
      status: { $in: [...STOCK_STATUSES] },
    })
  ).filter(Boolean);
  const catalog = games.length ? await loadCatalogForGames(games) : new Map();
  fleetCatalogCache = { at: Date.now(), catalog };
  return catalog;
}

// Every stock-bearing task for a game, plus the DropSets their listings point
// at (one keyed query, not one per task — Atlas shared tier bills bytes).
async function loadTasksAndSets(game, { AutoFarmTask, DropSet } = {}) {
  const Tasks = AutoFarmTask || require("../models/AutoFarmTask");
  const Sets = DropSet || require("../models/DropSet");
  const mongoose = require("mongoose");
  const tasks = await Tasks.find(
    { game, status: { $in: [...STOCK_STATUSES] } },
    TASK_FIELDS,
  ).lean();
  const setIds = [
    ...new Set(
      tasks
        .map((t) => t.listing && text(t.listing.setId))
        .filter((id) => id && mongoose.isValidObjectId(id)),
    ),
  ];
  const sets = setIds.length
    ? await Sets.find({ _id: { $in: setIds } }, { items: 1 }).lean()
    : [];
  return {
    tasks,
    setsById: new Map(sets.map((s) => [String(s._id), s])),
  };
}

/**
 * Every stock-bearing task in the fleet and every DropSet they point at, in
 * TWO queries.
 *
 * The per-game loader below is right for the publisher, which only ever asks
 * about one game. It is wrong for anything that sweeps the fleet: prod has 82
 * stock-bearing games, so asking per game is 164 round trips, each dragging
 * whole `assignedAccounts` arrays (up to 144 logins) across a shared-tier
 * Atlas that bills bytes returned. Same lesson as fleetEventCatalog.
 */
async function loadFleetTasksAndSets() {
  const AutoFarmTask = require("../models/AutoFarmTask");
  const DropSet = require("../models/DropSet");
  const mongoose = require("mongoose");
  const tasks = await AutoFarmTask.find(
    { status: { $in: [...STOCK_STATUSES] } },
    TASK_FIELDS,
  ).lean();
  const setIds = [
    ...new Set(
      tasks
        .map((t) => t.listing && text(t.listing.setId))
        .filter((id) => id && mongoose.isValidObjectId(id)),
    ),
  ];
  const sets = setIds.length
    ? await DropSet.find({ _id: { $in: setIds } }, { items: 1 }).lean()
    : [];
  const byGame = new Map();
  for (const task of tasks) {
    const game = text(task.game);
    if (!game) continue;
    if (!byGame.has(game)) byGame.set(game, []);
    byGame.get(game).push(task);
  }
  return { byGame, setsById: new Map(sets.map((s) => [String(s._id), s])) };
}

/**
 * Bundle plans for the WHOLE fleet, keyed by game — the read path behind the
 * dry-run script and the /auto-farm/bundles route. Games with no bundle are
 * omitted. No-claim games are skipped for the reason given in plansForGame.
 */
async function plansForAllGames({ now = Date.now(), minWaves = 2 } = {}) {
  const [catalog, loaded] = await Promise.all([
    fleetEventCatalog(),
    loadFleetTasksAndSets(),
  ]);
  const out = new Map();
  for (const [game, tasks] of loaded.byGame) {
    try {
      if (settings.isNoClaimGame(game)) continue;
    } catch {
      /* a settings read must never decide this by throwing */
    }
    const plans = planEventBundles({
      game,
      tasks,
      catalog,
      setsById: loaded.setsById,
      now,
      minWaves,
    });
    if (plans.length) out.set(game, plans);
  }
  return out;
}

/**
 * The whole read-only pipeline for one game: catalog → tasks → plans.
 * Used by the publisher, the dry-run script and the read-only route, so all
 * three describe exactly the same bundles.
 */
async function plansForGame(game, { now = Date.now(), minWaves = 2 } = {}) {
  const g = text(game);
  if (!g) return [];
  // No-claim games belong to the standalone no-claim/unclaimed system, which
  // sells the same accounts through its OWN bundler. Two systems listing one
  // account is the cross-listing collision this codebase keeps having to
  // clean up, so the auto-farm never bundles them — the same rule
  // publishEldoradoShare and publishPlayerAuctionsShare already enforce at
  // publish time. Prod still carries legacy Overwatch auto-farm tasks (102
  // assigned accounts on 2026-09-08) that would otherwise qualify.
  try {
    if (settings.isNoClaimGame(g)) return [];
  } catch {
    /* a settings read must never decide this by throwing */
  }
  const [catalog, loaded] = await Promise.all([
    fleetEventCatalog(),
    loadTasksAndSets(g),
  ]);
  return planEventBundles({
    game: g,
    tasks: loaded.tasks,
    catalog,
    setsById: loaded.setsById,
    now,
    minWaves,
  });
}

const SOURCE_TYPE = "autofarm-bundle";

// The best price this event's own bundle actually sold at recently. A bundle
// that sold for $3 is not relisted at $1.50 because the anchor moved — the same
// sold-floor rule the unclaimed pricer uses.
async function soldFloorForEvent(eventKey, { days = 30 } = {}) {
  if (!eventKey) return 0;
  const DropSet = require("../models/DropSet");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const since = new Date(Date.now() - Math.max(0, days) * 86400000);
  try {
    const sets = await DropSet.find(
      { sourceType: SOURCE_TYPE, sourceEventKey: eventKey },
      { _id: 1 },
    ).lean();
    if (!sets.length) return 0;
    const rows = await MarketplaceListing.find(
      {
        set: { $in: sets.map((s) => s._id) },
        origin: "auto",
        status: "sold",
        updatedAt: { $gte: since },
      },
      { price: 1 },
    ).lean();
    let max = 0;
    for (const r of rows) {
      const v = Number(r && r.price) || 0;
      if (v > max) max = v;
    }
    return max;
  } catch (e) {
    console.error("autoFarmBundles: sold floor lookup failed:", e.message);
    return 0;
  }
}

// Batched forms of the two lookups above: one DropSet read and one
// MarketplaceListing read for MANY events, rather than a pair per event. The
// route and the dry-run script ask about every planned bundle at once, and
// per-event queries there were the second-largest cost after the task load.
async function bundleSetsByEvent(eventKeys) {
  const keys = [...new Set((eventKeys || []).filter(Boolean))];
  const byEvent = new Map();
  if (!keys.length) return { byEvent, setIds: [], eventBySet: new Map() };
  const DropSet = require("../models/DropSet");
  const sets = await DropSet.find(
    { sourceType: SOURCE_TYPE, sourceEventKey: { $in: keys } },
    { sourceEventKey: 1 },
  ).lean();
  const eventBySet = new Map();
  for (const set of sets) {
    const key = text(set.sourceEventKey);
    if (!byEvent.has(key)) byEvent.set(key, []);
    byEvent.get(key).push(set._id);
    eventBySet.set(String(set._id), key);
  }
  return { byEvent, setIds: sets.map((s) => s._id), eventBySet };
}

async function liveBundlesForEvents(eventKeys) {
  const out = new Map();
  const { setIds, eventBySet } = await bundleSetsByEvent(eventKeys);
  if (!setIds.length) return out;
  const MarketplaceListing = require("../models/MarketplaceListing");
  const rows = await MarketplaceListing.find(
    { set: { $in: setIds }, status: "active", origin: "auto" },
    { set: 1, externalId: 1, marketplace: 1, price: 1, title: 1 },
  ).lean();
  for (const row of rows) {
    const key = eventBySet.get(String(row.set));
    if (key && !out.has(key)) out.set(key, row);
  }
  return out;
}

async function soldFloorsForEvents(eventKeys, { days = 30 } = {}) {
  const out = new Map();
  const { setIds, eventBySet } = await bundleSetsByEvent(eventKeys);
  if (!setIds.length) return out;
  const MarketplaceListing = require("../models/MarketplaceListing");
  const since = new Date(Date.now() - Math.max(0, days) * 86400000);
  const rows = await MarketplaceListing.find(
    {
      set: { $in: setIds },
      origin: "auto",
      status: "sold",
      updatedAt: { $gte: since },
    },
    { set: 1, price: 1 },
  ).lean();
  for (const row of rows) {
    const key = eventBySet.get(String(row.set));
    if (!key) continue;
    const v = Number(row.price) || 0;
    if (v > (out.get(key) || 0)) out.set(key, v);
  }
  return out;
}

// Is this event already being sold as a bundle right now? One live bundle per
// event: republishing the same event under a second set is the duplicate-set
// sprawl that made three Halo sets compete over one account pool.
async function liveBundleForEvent(eventKey) {
  if (!eventKey) return null;
  const DropSet = require("../models/DropSet");
  const MarketplaceListing = require("../models/MarketplaceListing");
  const sets = await DropSet.find(
    { sourceType: SOURCE_TYPE, sourceEventKey: eventKey },
    { _id: 1 },
  ).lean();
  if (!sets.length) return null;
  const row = await MarketplaceListing.findOne(
    {
      set: { $in: sets.map((s) => s._id) },
      status: "active",
      origin: "auto",
    },
    { set: 1, externalId: 1, marketplace: 1, price: 1, title: 1 },
  ).lean();
  return row || null;
}

module.exports = {
  SOURCE_TYPE,
  STOCK_STATUSES,
  // pure
  waveStarted,
  waveLabels,
  tidyEventName,
  placeTask,
  indexCatalog,
  waveItems,
  signatureOf,
  planEventBundles,
  planForTask,
  classificationFor,
  bundleTitleFor,
  bundleDescriptionLinesFor,
  bundleSetName,
  bundleSetNote,
  // db
  priceBundle,
  loadCatalogForGames,
  fleetEventCatalog,
  loadTasksAndSets,
  loadFleetTasksAndSets,
  plansForGame,
  plansForAllGames,
  liveBundlesForEvents,
  soldFloorsForEvents,
  soldFloorForEvent,
  liveBundleForEvent,
};
