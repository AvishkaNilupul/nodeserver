"use strict";
// Code shop scheduler (docs/code-shop/04-OPS.md, "service.js"): builds every
// code-shop module once from ONE shared deps object and runs them in order on
// a timer inside the live server process.
//
// It runs next to the marketplace fulfillers, so three rules shape it:
// - nothing here may throw out of a timer, a factory or start(): a step that
//   fails is logged and recorded, the next step still runs, and a module whose
//   file fails to load becomes a stub that answers every call with an error
//   (the server keeps running, the panel shows why);
// - never two ticks at once, and never a manual step or an owner's action on
//   top of a tick: ticks, runStep() calls and exclusive(fn) share one queue; a
//   tick() asked for while one is queued or running gets that same promise back;
// - the scheduler never re-creates a listing: publishPending only puts up a
//   product's first one per market (05-REVIEW-FIXES.md R2);
// - start() never blocks startup: it returns at once and never rejects; the
//   first tick waits for the shop's models to finish init() (their unique
//   indexes are what keep one code in one unit).
//
// Test hooks (all optional, none needed in production):
//   overrides.modules.<name> — a ready-made module used instead of building it
//     (also accepted at the top level, e.g. overrides.config, as in 01-DATA.md);
//   overrides.factories.<name> — (deps) => module, called with the shared deps;
//   overrides.models.<Name> — a model used instead of the real (lazy) one;
//   overrides.now / timers / firstTickMs / tickMs, and any other deps entry
//   (secret, mp, stock, category, setImage, farm, telegram, fetch, sleep, guideFor).
//
// Nothing here reads a code: summaries carry counts, ids and names only.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const FIRST_TICK_MS = 90 * 1000;
const TICK_MS = 5 * MINUTE_MS;
const ADOPTABLE_EVERY_MS = 30 * MINUTE_MS;
const DEFAULT_SCAN_HOURS = 12;
const ERROR_MAX = 300;

// The tick, in the contract's order; "foreign" (the guard against codes that
// already sit in another listing's stock) runs right after ingest, and
// "adoptable" (the panel's count of hand-made offers that could be adopted)
// rides at the end.
const STEPS = Object.freeze([
  "ingest",
  "foreign",
  "reconcile",
  "expiry",
  "claimAlert",
  "fill",
  "plan",
  "publishPending",
  "autoPublish",
  "pricing",
  "scan",
  "digest",
  "farmPriority",
  "adoptable",
]);
const STEP_SET = new Set(STEPS);
// Steps that put free codes into bundles, drafts or listings. They run only
// after the foreign guard succeeded in the same run: a code that is already on
// sale in a stock row the shop does not own must never reach them.
const GUARDED_STEPS = new Set(["fill", "plan", "publishPending", "autoPublish"]);
const FOREIGN_FAILED = "foreign guard failed";

// The modules, in the order `modules` lists them.
const MODULE_NAMES = Object.freeze([
  "config",
  "events",
  "ingest",
  "foreign",
  "reconcile",
  "expiry",
  "units",
  "fill",
  "planner",
  "cover",
  "publisher",
  "competitors",
  "pricing",
  "claimAlert",
  "digest",
  "afterSale",
  "farmPriority",
  "views",
  "adopt",
]);

// What a stub answers to, when a module could not be built.
const SURFACE = {
  config: ["get", "set", "forget"],
  events: ["log", "recent", "stamp", "has"],
  ingest: ["run"],
  foreign: ["run"],
  reconcile: ["run"],
  expiry: ["run"],
  units: ["build", "dissolve", "pull"],
  fill: ["run"],
  planner: ["run"],
  cover: ["build"],
  publisher: ["problems", "approve", "publishProduct", "pause", "resume", "retire"],
  competitors: ["scan"],
  pricing: ["run"],
  claimAlert: ["run"],
  digest: ["run"],
  afterSale: ["sold", "report", "replace"],
  farmPriority: ["run"],
  views: ["state", "product", "stock", "logins"],
  adopt: ["candidates", "adopt"],
};

const MODEL_NAMES = [
  "CodeStock",
  "CodeProduct",
  "CodeShopConfig",
  "CodeShopEvent",
  "SoopInventoryItem",
  "SoopCampaign",
  "SoopAccount",
  "SoopFarmTask",
  "AccountOffer",
  "SuppliedAccount",
  "MarketplaceListing",
];
// Their unique / TTL indexes must exist before the first tick writes.
const INIT_MODELS = ["CodeStock", "CodeProduct", "CodeShopConfig", "CodeShopEvent"];

const DEP_KEYS = ["secret", "mp", "stock", "category", "setImage", "farm", "telegram", "fetch", "sleep", "guideFor"];

const text = (v) => (v === undefined || v === null ? "" : String(v));
const errText = (err) => text((err && err.message) || err || "unknown error").slice(0, ERROR_MAX);
const leanOf = (q) => (q && typeof q.lean === "function" ? q.lean() : q);
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);

function toMs(v) {
  if (v === undefined || v === null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
}

function unref(t) {
  try {
    if (t && typeof t.unref === "function") t.unref();
  } catch {
    // a timer that cannot be unref'd still works
  }
  return t;
}

// Real models, each required on first use only.
function lazyModels(given) {
  const out = {};
  for (const name of MODEL_NAMES) {
    if (hasOwn(given, name) && given[name]) {
      out[name] = given[name];
      continue;
    }
    let cached = null;
    Object.defineProperty(out, name, {
      enumerable: true,
      configurable: true,
      get: () => cached || (cached = require("../../models/" + name)),
    });
  }
  for (const k of Object.keys(given || {})) if (!hasOwn(out, k)) out[k] = given[k];
  return out;
}

// Every call is lazy: a test that never decrypts never loads the real box.
const lazySecret = {
  encrypt: (...a) => require("../secretBox").encrypt(...a),
  decrypt: (...a) => require("../secretBox").decrypt(...a),
  isEncrypted: (...a) => require("../secretBox").isEncrypted(...a),
};

function stubModule(name, err) {
  const why = "the code shop " + name + " module did not load: " + errText(err);
  const stub = {};
  for (const fn of SURFACE[name] || []) {
    stub[fn] = async () => {
      const e = new Error(why);
      e.status = 503;
      throw e;
    };
  }
  return stub;
}

function createService(overrides = {}) {
  const o = overrides || {};
  const givenModules = o.modules || {};
  const factories = o.factories || {};
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const T = o.timers || {
    setTimeout: (...a) => setTimeout(...a),
    setInterval: (...a) => globalThis.setInterval(...a),
    clearTimeout: (t) => clearTimeout(t),
    clearInterval: (t) => globalThis.clearInterval(t),
  };
  const firstTickMs = Number.isFinite(Number(o.firstTickMs)) ? Math.max(0, Number(o.firstTickMs)) : FIRST_TICK_MS;
  const tickMs = Number.isFinite(Number(o.tickMs)) && Number(o.tickMs) > 0 ? Number(o.tickMs) : TICK_MS;

  // --- service state (read by views through deps.extras) ---------------------
  let lastTickRecord = null;
  let adoptable = null;

  // --- deps --------------------------------------------------------------------
  let telegramSend = null;
  const deps = {
    models: lazyModels(o.models || {}),
    secret: lazySecret,
    mp: () => require("../marketplaces"),
    stock: () => require("../suppliedStock"),
    category: () => require("../listingCategory"),
    setImage: () => require("../setImage"),
    farm: () => require("../soopFarm"),
    telegram: {
      // Throws when no chat took the message, so alerts are retried.
      send: async (msg) => {
        if (!telegramSend) telegramSend = require("../soop/loginAlert").createTelegramSend();
        return telegramSend(msg);
      },
    },
    fetch: (...a) => globalThis.fetch(...a),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    guideFor: (...a) => require("./games").guideFor(...a),
    now,
  };
  for (const k of DEP_KEYS) if (hasOwn(o, k) && o[k] !== undefined) deps[k] = o[k];

  const givenModel = (name) => (hasOwn(o.models, name) ? o.models[name] : undefined);
  const BUILD = {
    config: () => require("./config").createConfig({ model: givenModel("CodeShopConfig"), now }),
    events: () => require("./events").createEvents({ model: givenModel("CodeShopEvent"), now }),
    units: (d) => require("./units").createUnits(d),
    ingest: (d) => require("./ingest").createIngest(d),
    foreign: (d) => require("./foreign").createForeignGuard(d),
    reconcile: (d) => require("./reconcile").createReconcile(d),
    expiry: (d) => require("./expiry").createExpiry(d),
    fill: (d) => require("./fill").createFill(d),
    cover: (d) => require("./cover").createCover(d),
    publisher: (d) => require("./publish").createPublisher(d),
    planner: (d) => require("./planner").createPlanner(d),
    competitors: (d) => require("./competitors").createCompetitors(d),
    pricing: (d) => require("./pricing").createPricing(d),
    claimAlert: (d) => require("./claimAlert").createClaimAlert(d),
    digest: (d) => require("./digest").createDigest(d),
    afterSale: (d) => require("./afterSale").createAfterSale(d),
    farmPriority: (d) => require("./farmPriority").createFarmPriority(d),
    views: (d) => require("./views").createViews(d),
    adopt: (d) => require("./adopt").createAdopt(d),
  };
  // Modules that other modules take from deps (units -> fill/reconcile/expiry,
  // fill/cover -> publisher, ingest/reconcile -> adopt) are built first, so
  // every module shares one instance of each.
  const BUILD_ORDER = [
    "config",
    "events",
    "units",
    "ingest",
    "foreign",
    "reconcile",
    "expiry",
    "fill",
    "cover",
    "publisher",
    "planner",
    "competitors",
    "pricing",
    "claimAlert",
    "digest",
    "afterSale",
    "farmPriority",
    "views",
    "adopt",
  ];

  const built = {};
  for (const name of BUILD_ORDER) {
    if (name === "views") {
      // The views ask the publisher what keeps a product off sale, and the
      // service for what only it knows.
      deps.problems = (p) => built.publisher.problems(p);
      deps.extras = () => ({ adoptable, lastTick: lastTickRecord });
    }
    let mod = hasOwn(givenModules, name) ? givenModules[name] : hasOwn(o, name) ? o[name] : undefined;
    if (!mod) {
      try {
        mod = typeof factories[name] === "function" ? factories[name](deps) : BUILD[name](deps);
        if (!mod || typeof mod !== "object") throw new Error("its factory returned nothing");
      } catch (err) {
        console.error("[code-shop] " + name + " module not built: " + errText(err));
        mod = stubModule(name, err);
      }
    }
    built[name] = mod;
    deps[name] = mod;
  }
  const modules = {};
  for (const name of MODULE_NAMES) modules[name] = built[name];
  const { config, events } = modules;

  async function note(entry) {
    try {
      if (events && typeof events.log === "function") await events.log(entry);
    } catch (err) {
      console.error("[code-shop] event not saved: " + errText(err));
    }
  }

  async function getConfig() {
    const cfg = await config.get();
    if (!cfg || typeof cfg !== "object") throw new Error("the code shop settings could not be read");
    return cfg;
  }

  // --- model init ----------------------------------------------------------------
  let initDone = false;
  let initJob = null;
  let initFailures = 0;

  // Resolves once every shop model has its indexes. A failure is not cached:
  // the next tick tries again (with ensureIndexes, since Mongoose keeps a
  // failed init() promise for good).
  function ensureInit() {
    if (initDone) return Promise.resolve(true);
    if (!initJob) {
      const retry = initFailures > 0;
      initJob = (async () => {
        for (const name of INIT_MODELS) {
          const m = deps.models[name];
          if (!m) continue;
          if (retry && typeof m.ensureIndexes === "function") await m.ensureIndexes();
          else if (typeof m.init === "function") await m.init();
        }
        initDone = true;
        return true;
      })();
      initJob.then(
        () => {
          initJob = null;
        },
        () => {
          initFailures += 1;
          initJob = null;
        },
      );
    }
    return initJob;
  }

  // --- gates ---------------------------------------------------------------------
  const lastRunAt = {}; // step -> ms of its last start (hourly / 30-min gates)

  async function gated(name, everyMs, force, fn) {
    const t = now();
    const last = lastRunAt[name];
    if (!force && last !== undefined && t - last < everyMs && t >= last) {
      return { skipped: "ran " + Math.round((t - last) / MINUTE_MS) + " min ago; runs every " + Math.round(everyMs / MINUTE_MS) + " min" };
    }
    lastRunAt[name] = t;
    return fn();
  }

  // --- publishPending --------------------------------------------------------------

  // The scheduler only ever puts up a product's FIRST listing on a market
  // (05-REVIEW-FIXES.md R2). It publishes a market of an active product when:
  // - the product was not adopted (an adopted offer's listings are the owner's);
  // - its publish.lastError is empty (a failed or unsure attempt waits for the
  //   owner's Publish button: a lost answer may have left an offer up);
  // - the market is a code shop market and switched on;
  // - the offer has NEVER had a MarketplaceListing on that market, whatever its
  //   status (a delisted, sold or expired row is never re-created by itself);
  // - at least one bundle is on the shelf.
  // A product whose scheduled attempt failed is also never tried again by
  // this process, in case the failure could not be written to lastError.
  const autoFailed = new Set();

  async function publishPending() {
    const { ALLOWED_MARKETS } = require("./publish");
    const out = { checked: 0, attempted: 0, published: 0, failed: 0, products: [] };
    const cfg = await getConfig();
    const enabled = cfg.markets || {};

    const rows =
      (await leanOf(deps.models.CodeProduct.find({ status: "active" }, { name: 1, status: 1, offer: 1, markets: 1, publish: 1, origin: 1 }))) || [];
    const products = rows.filter((p) => p && p.status === "active" && p.offer);
    out.checked = products.length;

    const due = [];
    for (const p of products) {
      if (text(p.origin) === "adopted") continue;
      if (text(p.publish && p.publish.lastError).trim()) continue;
      if (autoFailed.has(text(p._id))) continue;
      const markets = [...new Set((Array.isArray(p.markets) ? p.markets : []).map(text))].filter(
        (m) => ALLOWED_MARKETS.includes(m) && enabled[m] === true,
      );
      if (markets.length) due.push({ p, markets });
    }
    if (!due.length) return out;

    // Every row of these offers, whatever its status: "ever had one" is the rule.
    const had = await leanOf(
      deps.models.MarketplaceListing.find({ accountOffer: { $in: due.map((d) => d.p.offer) } }, { accountOffer: 1, marketplace: 1 }),
    );
    const hadKeys = new Set((had || []).map((r) => text(r.accountOffer) + "|" + text(r.marketplace)));

    for (const { p, markets } of due) {
      const name = text(p.name) || text(p._id);
      let attempting = false;
      try {
        const missing = markets.filter((m) => !hadKeys.has(text(p.offer) + "|" + m));
        if (!missing.length) continue;
        const shelf = Number(await deps.stock().shelfFor(p.offer)) || 0;
        if (shelf < 1) continue;

        out.attempted += 1;
        attempting = true;
        const res = (await modules.publisher.publishProduct(p._id, { actor: "auto" })) || {};
        const results = Array.isArray(res.results) ? res.results : [];
        const ok = results.filter((r) => r && r.ok).length;
        out.published += ok;
        if (res.error || results.some((r) => r && r.error)) {
          out.failed += 1;
          autoFailed.add(text(p._id));
        }
        out.products.push({
          id: text(p._id),
          name,
          markets: missing,
          results: results.map((r) => ({
            market: text(r && r.market),
            ok: !!(r && r.ok),
            ...(r && r.skipped ? { skipped: text(r.skipped) } : {}),
            ...(r && r.error ? { error: text(r.error).slice(0, ERROR_MAX) } : {}),
          })),
          ...(res.error ? { error: text(res.error).slice(0, ERROR_MAX) } : {}),
        });
      } catch (err) {
        out.failed += 1;
        // A publish that threw part-way is as unsure as one that failed.
        if (attempting) autoFailed.add(text(p._id));
        out.products.push({ id: text(p._id), name, error: errText(err) });
        await note({ level: "warn", kind: "publish", product: p._id, msg: "Scheduled publish of " + name + " stopped: " + errText(err) });
      }
    }
    return out;
  }

  // --- autoPublish -----------------------------------------------------------------

  // Only with config.autoPublish: drafts with no problems, enough proposed
  // bundles and still proposed by the planner -> approve (which publishes).
  async function autoPublish() {
    const cfg = await getConfig();
    if (cfg.autoPublish !== true) return { skipped: "auto-publish is off" };
    const minUnits = Number(cfg.drafts && cfg.drafts.minUnits);
    const need = Number.isFinite(minUnits) && minUnits >= 0 ? minUnits : 0;
    const out = { checked: 0, approved: 0, refused: 0, failed: 0, products: [] };

    const drafts = ((await leanOf(deps.models.CodeProduct.find({ status: "draft" }))) || []).filter(
      (p) => p && p.status === "draft",
    );
    for (const p of drafts) {
      out.checked += 1;
      if (p.stale === true) continue;
      const units = Number(p.proposed && p.proposed.units);
      if (!(Number.isFinite(units) && units >= need)) continue;
      const name = text(p.name) || text(p._id);
      try {
        const found = await modules.publisher.problems(p);
        if (!Array.isArray(found) || found.length) continue;
        const res = (await modules.publisher.approve(p._id, { actor: "auto" })) || {};
        if (res.ok) {
          out.approved += 1;
          out.products.push({ id: text(p._id), name, approved: true });
        } else {
          out.refused += 1;
          out.products.push({ id: text(p._id), name, approved: false, problems: (res.problems || []).map(text).slice(0, 10) });
        }
      } catch (err) {
        out.failed += 1;
        out.products.push({ id: text(p._id), name, error: errText(err) });
        await note({ level: "warn", kind: "approve", product: p._id, msg: "Auto-approving " + name + " failed: " + errText(err) });
      }
    }
    return out;
  }

  // --- scan ------------------------------------------------------------------------

  // When THIS process last asked for a product's scan: a scan that fails keeps
  // the stored scannedAt, and without this the same product would be picked
  // (and fail) every tick while the others wait.
  const scanTriedAt = new Map();

  async function scanOne({ force = false } = {}) {
    const cfg = await getConfig();
    const cs = cfg.competitorScan || {};
    if (cs.enabled !== true) return { skipped: "competitor scan is off" };
    const hours = Number(cs.everyHours);
    const everyMs = (Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_SCAN_HOURS) * HOUR_MS;
    const t = now();

    const products = ((await leanOf(deps.models.CodeProduct.find({ status: "active" }))) || []).filter(
      (p) => p && p.status === "active" && Array.isArray(p.markets) && p.markets.map(text).includes("eldorado"),
    );
    let pick = null;
    let pickAt = Infinity;
    for (const p of products) {
      const id = text(p._id);
      const stored = toMs(p.competitors && p.competitors.scannedAt);
      const tried = scanTriedAt.has(id) ? scanTriedAt.get(id) : null;
      const at = Math.max(stored === null ? -Infinity : stored, tried === null ? -Infinity : tried);
      if (!force && at !== -Infinity && t - at < everyMs) continue;
      if (at < pickAt || (at === pickAt && pick && id < text(pick._id))) {
        pick = p;
        pickAt = at;
      }
    }
    if (!pick) return { skipped: force ? "no active Eldorado product" : "no product is due a scan" };
    scanTriedAt.set(text(pick._id), t);
    const result = await modules.competitors.scan(pick);
    const lowest = result && result.lowestSameSetUsd !== undefined ? result.lowestSameSetUsd : null;
    return { product: text(pick._id), name: text(pick.name), lowestSameSetUsd: lowest };
  }

  // --- steps -----------------------------------------------------------------------

  const HANDLERS = {
    ingest: () => modules.ingest.run(),
    foreign: () => modules.foreign.run(),
    reconcile: () => modules.reconcile.run(),
    expiry: () => modules.expiry.run(),
    claimAlert: () => modules.claimAlert.run(),
    fill: () => modules.fill.run(),
    plan: () => modules.planner.run(),
    publishPending: () => publishPending(),
    autoPublish: () => autoPublish(),
    pricing: ({ force }) => gated("pricing", HOUR_MS, force, () => modules.pricing.run()),
    scan: ({ force }) => scanOne({ force }),
    // A digest asked for by hand is sent even when one went out today.
    digest: ({ force }) => modules.digest.run({ force }),
    farmPriority: ({ force }) => gated("farmPriority", HOUR_MS, force, () => modules.farmPriority.run()),
    adoptable: ({ force }) =>
      gated("adoptable", ADOPTABLE_EVERY_MS, force, async () => {
        const list = await modules.adopt.candidates();
        adoptable = Array.isArray(list) ? list.length : 0;
        return { adoptable };
      }),
  };

  let currentStep = "";

  // Never rejects. -> { at, ms, steps: { name: summary | { error } | { skipped } } }
  // A guarded step runs only when the foreign guard succeeded earlier in the
  // SAME run (the tick runs it right after ingest; a manual guarded step runs
  // it first), so the rule holds without any state carried between runs.
  async function runSteps(names, { force = false } = {}) {
    const started = now();
    const steps = {};
    try {
      await ensureInit();
    } catch (err) {
      steps.init = { error: "the code shop models are not ready: " + errText(err) };
      await note({ level: "error", kind: "tick", msg: "Code shop did not run: its models are not ready (" + errText(err) + ")" });
      return { at: new Date(started), ms: Math.max(0, now() - started), steps };
    }
    let foreignOk = false;
    for (const name of names) {
      if (GUARDED_STEPS.has(name) && !foreignOk) {
        steps[name] = { skipped: FOREIGN_FAILED };
        continue;
      }
      currentStep = name;
      try {
        const r = await HANDLERS[name]({ force });
        steps[name] = r === undefined ? null : r;
        if (name === "foreign") foreignOk = true;
      } catch (err) {
        steps[name] = { error: errText(err) };
        await note({ level: "error", kind: "tick", msg: "Code shop step " + name + " failed: " + errText(err), data: { step: name } });
      }
    }
    currentStep = "";
    return { at: new Date(started), ms: Math.max(0, now() - started), steps };
  }

  // Ticks, manual steps and the owner's actions (the routes pass approve,
  // publish, resume, retire, adopt and held-release through `exclusive`) run
  // one at a time, in the order asked: an owner's approve never runs its fill
  // or foreign guard on top of a tick's. -> fn()'s own result or rejection.
  // `fn` must not call tick(), runStep() or exclusive(): it would wait on itself.
  let queue = Promise.resolve();
  function exclusive(fn) {
    if (typeof fn !== "function") return Promise.reject(new TypeError("exclusive() needs a function"));
    const run = queue.then(() => fn());
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  let ticking = null;
  let tickAskedAt = null;
  let stuckWarned = false;

  function tick() {
    if (ticking) return ticking;
    tickAskedAt = now();
    stuckWarned = false;
    const job = exclusive(async () => {
      const record = await runSteps(STEPS);
      lastTickRecord = record;
      return record;
    });
    ticking = job.then(
      (r) => {
        ticking = null;
        return r;
      },
      (err) => {
        // runSteps never rejects; this is the belt to its braces.
        ticking = null;
        console.error("[code-shop] tick failed: " + errText(err));
        return null;
      },
    );
    return ticking;
  }

  async function runStep(name) {
    const key = text(name);
    if (key === "all") return tick();
    if (!STEP_SET.has(key)) {
      const err = new Error("Unknown code shop step \"" + key.slice(0, 40) + "\" (one of: all, " + STEPS.join(", ") + ")");
      err.status = 400;
      throw err;
    }
    // fill / plan / publishPending / autoPublish asked for by hand run the
    // foreign guard first, as a tick does: the record then holds both.
    const names = GUARDED_STEPS.has(key) ? ["foreign", key] : [key];
    return exclusive(() => runSteps(names, { force: true }));
  }

  // --- timers ------------------------------------------------------------------------
  let started = false;
  let generation = 0;
  let startJob = null;
  let firstTimer = null;
  let intervalTimer = null;

  function onTimer() {
    try {
      if (ticking && tickAskedAt !== null && !stuckWarned && now() - tickAskedAt > 3 * tickMs) {
        stuckWarned = true;
        note({
          level: "warn",
          kind: "tick",
          msg:
            "Code shop tick has been running for " +
            Math.round((now() - tickAskedAt) / MINUTE_MS) +
            " min" +
            (currentStep ? " (in step " + currentStep + ")" : "") +
            "; the next one waits for it",
        });
      }
      tick().catch((err) => console.error("[code-shop] tick failed: " + errText(err)));
    } catch (err) {
      console.error("[code-shop] tick not started: " + errText(err));
    }
  }

  function schedule() {
    firstTimer = unref(
      T.setTimeout(() => {
        firstTimer = null;
        if (!started) return;
        try {
          intervalTimer = unref(T.setInterval(onTimer, tickMs));
        } catch (err) {
          console.error("[code-shop] tick timer not set: " + errText(err));
        }
        onTimer();
      }, firstTickMs),
    );
  }

  // -> Promise<boolean>: true once the timers are set. Never rejects.
  function start() {
    if (text(process.env.CODE_SHOP).trim() === "0") return Promise.resolve(false);
    if (startJob) return startJob;
    started = true;
    const gen = ++generation;
    startJob = (async () => {
      try {
        await ensureInit();
      } catch (err) {
        // Not fatal: every tick tries the init again before it does anything.
        await note({ level: "error", kind: "tick", msg: "Code shop models not ready at start (" + errText(err) + "); the ticks will retry" });
      }
      if (!started || gen !== generation) return false;
      try {
        schedule();
        return true;
      } catch (err) {
        console.error("[code-shop] not started: " + errText(err));
        return false;
      }
    })().catch((err) => {
      console.error("[code-shop] not started: " + errText(err));
      return false;
    });
    return startJob;
  }

  // Clears the timers; a tick already running finishes on its own.
  function stop() {
    started = false;
    generation += 1;
    startJob = null;
    try {
      if (firstTimer) T.clearTimeout(firstTimer);
      if (intervalTimer) T.clearInterval(intervalTimer);
    } catch (err) {
      console.error("[code-shop] timers not cleared: " + errText(err));
    }
    firstTimer = null;
    intervalTimer = null;
  }

  return {
    start,
    stop,
    tick,
    runStep,
    exclusive,
    modules,
    deps,
    lastTick: () => lastTickRecord,
  };
}

let singleton = null;

module.exports = { createService, STEPS };
// The shared service is built on first use, so requiring this file starts,
// builds and loads nothing.
Object.defineProperty(module.exports, "service", {
  enumerable: true,
  get() {
    if (!singleton) singleton = createService();
    return singleton;
  },
});
