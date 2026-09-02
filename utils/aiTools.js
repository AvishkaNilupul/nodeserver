// Read-only tools for the AI coworker (analyst mode).
//
// Every tool here is STRICTLY read-only — it queries data the system already
// logs (SystemEvent audit trail, FleetSnapshot time series) or reads process
// health (pm2). Nothing here mutates state, touches secrets, or runs
// user-supplied shell input. The analyst endpoint exposes ONLY this set, so the
// model cannot act on prod even if it "wanted" to — new capabilities are opt-in
// by adding a tool, never implicit.
//
// Results are kept compact on purpose: prod Mongo is a bytes-bound Atlas shared
// tier, and every byte returned also spends model context.
const { execFile } = require("child_process");
const path = require("path");
const fs = require("fs");
const SystemEvent = require("../models/SystemEvent");
const FleetSnapshot = require("../models/FleetSnapshot");
const store = require("./coworkerStore");

// The repo root — code tools are sandboxed to this tree.
const ROOT = path.resolve(__dirname, "..");

const clamp = (n, lo, hi, dflt) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
};
const trunc = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);

// ---- Tool implementations ---------------------------------------------------

// Query the unified audit trail. The workhorse: "what errored today", "why did
// farming stop on <game>", "who changed settings", "what happened on <host>".
async function query_events(args = {}) {
  const match = {};
  for (const k of ["category", "action", "actor", "subject", "game", "host", "container", "severity"]) {
    if (args[k]) match[k] = String(args[k]);
  }
  const sinceMin = clamp(args.since_minutes, 1, 60 * 24 * 90, 1440);
  match.at = { $gte: new Date(Date.now() - sinceMin * 60000) };
  if (args.search) {
    const rx = new RegExp(String(args.search).slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    match.$or = [{ detail: rx }, { subject: rx }, { game: rx }, { route: rx }];
  }
  const limit = clamp(args.limit, 1, 200, 50);
  const rows = await SystemEvent.find(match).sort({ at: -1 }).limit(limit).lean();
  return {
    window_minutes: sinceMin,
    matched: rows.length,
    events: rows.map((e) => ({
      at: e.at,
      category: e.category,
      action: e.action,
      actor: e.actor,
      severity: e.severity,
      subject: e.subject || undefined,
      game: e.game || undefined,
      host: e.host || undefined,
      container: e.container || undefined,
      count: e.count || undefined,
      route: e.route || undefined,
      status: e.status || undefined,
      detail: trunc(e.detail, 220) || undefined,
    })),
  };
}

// A dashboard the model can read first to decide where to drill: per-category
// volume + how many were warn/error in the window, plus the top error actions.
async function event_summary(args = {}) {
  const sinceMin = clamp(args.since_minutes, 1, 60 * 24 * 30, 1440);
  const since = new Date(Date.now() - sinceMin * 60000);
  const byCat = await SystemEvent.aggregate([
    { $match: { at: { $gte: since } } },
    {
      $group: {
        _id: "$category",
        total: { $sum: 1 },
        warn: { $sum: { $cond: [{ $eq: ["$severity", "warn"] }, 1, 0] } },
        error: { $sum: { $cond: [{ $eq: ["$severity", "error"] }, 1, 0] } },
      },
    },
    { $sort: { total: -1 } },
    { $limit: 40 },
  ]);
  const topErrors = await SystemEvent.aggregate([
    { $match: { at: { $gte: since }, severity: "error" } },
    { $group: { _id: { category: "$category", action: "$action" }, n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 15 },
  ]);
  return {
    window_minutes: sinceMin,
    by_category: byCat.map((c) => ({ category: c._id || "(none)", total: c.total, warn: c.warn, error: c.error })),
    top_error_actions: topErrors.map((t) => ({ category: t._id.category, action: t._id.action, count: t.n })),
  };
}

// Fleet/pool/marketplace counts over time — answers "did the account count
// drop", "is the pool draining", "are listings shrinking". Reports first vs last
// snapshot plus min/max per metric so a dip mid-window is visible.
async function fleet_trend(args = {}) {
  const hours = clamp(args.hours, 1, 24 * 90, 24);
  const since = new Date(Date.now() - hours * 3600000);
  const snaps = await FleetSnapshot.find({ at: { $gte: since } }).sort({ at: 1 }).lean();
  if (!snaps.length) return { hours, snapshots: 0, note: "no snapshots in window" };
  const first = snaps[0].metrics || {};
  const last = snaps[snaps.length - 1].metrics || {};
  const keys = new Set([...Object.keys(first), ...Object.keys(last)]);
  const metrics = {};
  for (const k of keys) {
    let mn = Infinity, mx = -Infinity;
    for (const s of snaps) {
      const v = s.metrics?.[k];
      if (typeof v === "number") { mn = Math.min(mn, v); mx = Math.max(mx, v); }
    }
    metrics[k] = {
      first: first[k] ?? null,
      last: last[k] ?? null,
      delta: typeof first[k] === "number" && typeof last[k] === "number" ? last[k] - first[k] : null,
      min: mn === Infinity ? null : mn,
      max: mx === -Infinity ? null : mx,
    };
  }
  return { hours, snapshots: snaps.length, from: snaps[0].at, to: snaps[snaps.length - 1].at, metrics };
}

// Known-routine prod log lines that are NOT failures — filtered out so the model
// doesn't cry wolf. (Curated from operating experience.)
const NOISE = [
  /campaignWatcher error: failed integrity check/i,
  /DeprecationWarning/i,
  /telegramBot poll error/i,
  /new.*option.*deprecat/i,
];

// Process health via pm2: status, restart count, uptime, memory + a noise-
// filtered tail of the error log. Read-only; fixed args, no shell interpolation.
function pm2_status(args = {}) {
  const lines = clamp(args.lines, 5, 120, 40);
  return new Promise((resolve) => {
    execFile("pm2", ["jlist"], { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ available: false, note: "pm2 not reachable from this process" });
      let apps = [];
      try {
        apps = JSON.parse(stdout).map((p) => ({
          name: p.name,
          status: p.pm2_env?.status,
          restarts: p.pm2_env?.restart_time,
          unstable_restarts: p.pm2_env?.unstable_restarts,
          uptime_min: p.pm2_env?.pm_uptime ? Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000) : null,
          cpu: p.monit?.cpu,
          mem_mb: p.monit?.memory ? Math.round(p.monit.memory / 1048576) : null,
        }));
      } catch { /* fall through */ }
      execFile("pm2", ["logs", "redeemer", "--lines", String(lines), "--nostream", "--err"],
        { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (e2, out2) => {
          const raw = (out2 || "").split("\n").map((l) => l.trim())
            .filter((l) => l && !l.startsWith("/root/.pm2") && !NOISE.some((r) => r.test(l)));
          resolve({ available: true, apps, recent_errors: raw.slice(-15) });
        });
    });
  });
}

// ---- Tool registry (schemas sent to the model + dispatch) -------------------

const TOOLS = [
  {
    schema: {
      type: "function",
      function: {
        name: "query_events",
        description:
          "Search the unified system audit trail (accounts, autofarm, bots, noclaim, listings, sales, pool, scanner, settings, requests, errors). Use to investigate what happened and when. Filter by any combination; leave filters off to widen.",
        parameters: {
          type: "object",
          properties: {
            category: { type: "string", description: "e.g. autofarm, bots, scanner, listings, sales, pool, settings, error, request" },
            action: { type: "string", description: "e.g. started, stopped, parked, reaped, suspended, published, sold, token_invalid" },
            actor: { type: "string", description: "e.g. system, scanner, tick, noclaim, admin:<id>" },
            subject: { type: "string", description: "the thing acted on: a login, game, or container label" },
            game: { type: "string" },
            host: { type: "string", description: "e.g. server, pi" },
            container: { type: "string", description: "e.g. twitchbotx7" },
            severity: { type: "string", enum: ["info", "warn", "error"] },
            search: { type: "string", description: "case-insensitive text to match in detail/subject/game/route" },
            since_minutes: { type: "number", description: "how far back to look; default 1440 (24h)" },
            limit: { type: "number", description: "max rows, default 50, cap 200" },
          },
        },
      },
    },
    impl: query_events,
  },
  {
    schema: {
      type: "function",
      function: {
        name: "event_summary",
        description:
          "High-level counts across the audit trail for a time window: events per category with warn/error tallies, plus the top error actions. Call this FIRST to see where the problems are, then drill in with query_events.",
        parameters: {
          type: "object",
          properties: { since_minutes: { type: "number", description: "window, default 1440 (24h)" } },
        },
      },
    },
    impl: event_summary,
  },
  {
    schema: {
      type: "function",
      function: {
        name: "fleet_trend",
        description:
          "Fleet/pool/marketplace counts over time (bot totals, suspended/invalid, pool available/claimed, drop-log entries, listings). Reports first vs last plus min/max so dips are visible. Use for 'did X drop / is the pool draining'.",
        parameters: {
          type: "object",
          properties: { hours: { type: "number", description: "window in hours, default 24" } },
        },
      },
    },
    impl: fleet_trend,
  },
  {
    schema: {
      type: "function",
      function: {
        name: "pm2_status",
        description:
          "Process health of the running apps (redeemer, marketplace): status, restart count, uptime, memory, and a noise-filtered tail of the error log. Use for 'is the app healthy / did it crash / recent errors'.",
        parameters: {
          type: "object",
          properties: { lines: { type: "number", description: "error-log lines to scan, default 40" } },
        },
      },
    },
    impl: pm2_status,
  },
];

// ===========================================================================
// Generic read-only DB access over a whitelist of collections.
//
// SECURITY: each collection lists ONLY safe fields to project — secrets
// (passwords, clientSecret/tokens, access tokens, emails) are never in the
// allow-list, so they cannot be returned or filtered on. Adding a collection is
// one registry entry; nothing is queryable unless it's here.
// ===========================================================================
const M = (name) => require(`../models/${name}`);
const REGISTRY = {
  market_research: {
    model: () => M("MarketResearch"),
    desc: "Per-game market research: demand/competition/opportunity scores, sellers, offers, sales/week, revenue, and a recommendation. Best source for pricing & marketing decisions.",
    fields: "game term campaign active upcoming count endAt farmedAccounts farmedItems ownActive ownSold observedRevenue sellers offers salesPerWeek demandTrend ownSales ownRevenue markets ownByMarket demandScore competitionScore opportunityScore recommendation scannedAt",
    date: "scannedAt",
  },
  drop_sets: {
    model: () => M("DropSet"),
    desc: "Sellable bundles/sets: pricing (price, minPriceUsd floor), whether listed, catalog config, bulk discount. The price source of truth per set.",
    fields: "itemKey name game qty price minPriceUsd listed publicCatalog publicFeatured publicPrice bulkMinQty bulkDiscountPct custom sourceType sourceEventName",
    date: "",
  },
  marketplace_listings: {
    model: () => M("MarketplaceListing"),
    desc: "Live listings across marketplaces (plati, ggsel, zeusx, digiseller, g2g…): price, currency, status, stock (qtyRemaining/qtyTarget/unitsSold), auto-delivery, relist attempts, last error. Compare pricing & stock across marketplaces here.",
    fields: "set marketplace origin externalId url title price currency status qtyRemaining qtyTarget unitsSold lastStock autoDelivery autoDeliver relistAttempts relistRetryAt lastError addedAt",
    date: "addedAt",
  },
  autofarm_tasks: {
    model: () => M("AutoFarmTask"),
    desc: "Per-event auto-farm decisions: whether/why a game is being farmed, demand score, coverage, planned vs assigned accounts, status, per-marketplace listing state, errors.",
    fields: "game campaignName campaignEndAt decision reason demandScore coverage plannedAccounts targetAccounts assignedAccounts status dryRun error decidedAt executedAt completedAt listing plati ggsel zeusx listedAt repricedAt postEvent",
    date: "decidedAt",
  },
  drop_logs: {
    model: () => M("DropLog"),
    desc: "Individual farmed drops per account: game, item, when awarded, whether connected, sold status (soldAt/soldToUsername). Identified by login, never token.",
    fields: "login name game itemKey count awardedAt connected state source soldAt soldToUsername firstSeenAt lastSeenAt",
    date: "awardedAt",
  },
  pool_accounts: {
    model: () => M("AvailableAccount"),
    desc: "The shared account pool: status (available/claimed/suspended…), whether it has a stored password, which games it has sold, source, listed flag, drop count, last check. NO credentials.",
    fields: "usernameLower status hasPassword soldGames source manualSold listed dropCount claimedAt claimedNote lastCheckAt lastCheckStatus suspendedAt",
    date: "claimedAt",
  },
  bot_accounts: {
    model: () => M("BotAccount"),
    desc: "Deployed bot fleet: login, container, host (server/pi), enabled, scan status, drops in progress, sold status, suspension. NO credentials.",
    fields: "login container host enabled status soldAt soldToUsername dropCount inProgressCount inProgressGames lastScanAt lastScanStatus lastScanError suspendedAt resellerId",
    date: "lastScanAt",
  },
  sale_signals: {
    model: () => M("SaleSignal"),
    desc: "Confirmed real sales signals: game, item, marketplace, price (USD), when. The ground-truth demand signal for pricing/marketing.",
    fields: "game gameKey itemKey name login source marketplace priceUsd at",
    date: "at",
  },
  purchases: {
    model: () => M("Purchase"),
    desc: "Internal purchases/fulfilment: item, set, price, buyer, account login, refund status.",
    fields: "itemKey name game count setId setName price buyerUsername accountLogin balanceAfter refundedAt",
    date: "",
  },
  bulk_orders: {
    model: () => M("BulkOrder"),
    desc: "Bulk orders: account login, status, health, order number, set, quantity ordered, price, guarantee window. NO access tokens.",
    fields: "accountLogin status dropCount orderNo setName qtyOrdered price buyerLabel guaranteeUntil active revealedAt",
    date: "",
  },
};

function projection(fields) {
  const p = { _id: 0 };
  for (const f of fields.split(/\s+/).filter(Boolean)) p[f] = 1;
  return p;
}
function safeFilter(entry, where) {
  const allowed = new Set(entry.fields.split(/\s+/).filter(Boolean));
  const OPS = { gte: "$gte", lte: "$lte", gt: "$gt", lt: "$lt", ne: "$ne", in: "$in" };
  const out = {};
  for (const [k, v] of Object.entries(where || {})) {
    if (!allowed.has(k)) continue; // silently ignore non-whitelisted (incl. secrets)
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sub = {};
      for (const [op, val] of Object.entries(v)) {
        if (op === "regex") sub.$regex = new RegExp(String(val).slice(0, 60).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        else if (OPS[op]) sub[OPS[op]] = val;
      }
      if (Object.keys(sub).length) out[k] = sub;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function db_query(args = {}) {
  const entry = REGISTRY[args.collection];
  if (!entry) return { error: `unknown collection. available: ${Object.keys(REGISTRY).join(", ")}` };
  const filter = safeFilter(entry, args.where);
  if (args.since_minutes && entry.date) {
    filter[entry.date] = { $gte: new Date(Date.now() - clamp(args.since_minutes, 1, 60 * 24 * 400, 1440) * 60000) };
  }
  const limit = clamp(args.limit, 1, 50, 20);
  let q = entry.model().find(filter, projection(entry.fields));
  if (args.sort) { const dir = args.sort_desc === false ? 1 : -1; q = q.sort({ [args.sort]: dir }); }
  else if (entry.date) q = q.sort({ [entry.date]: -1 });
  const rows = await q.limit(limit).lean();
  // truncate any long strings to keep the payload lean
  for (const r of rows) for (const k of Object.keys(r)) if (typeof r[k] === "string") r[k] = trunc(r[k], 200);
  return { collection: args.collection, matched: rows.length, rows };
}

async function db_count(args = {}) {
  const entry = REGISTRY[args.collection];
  if (!entry) return { error: `unknown collection. available: ${Object.keys(REGISTRY).join(", ")}` };
  const filter = safeFilter(entry, args.where);
  if (args.since_minutes && entry.date) {
    filter[entry.date] = { $gte: new Date(Date.now() - clamp(args.since_minutes, 1, 60 * 24 * 400, 1440) * 60000) };
  }
  return { collection: args.collection, count: await entry.model().countDocuments(filter) };
}

async function db_group(args = {}) {
  const entry = REGISTRY[args.collection];
  if (!entry) return { error: `unknown collection. available: ${Object.keys(REGISTRY).join(", ")}` };
  const allowed = new Set(entry.fields.split(/\s+/).filter(Boolean));
  if (!allowed.has(args.group_by)) return { error: `group_by must be one of: ${entry.fields}` };
  const filter = safeFilter(entry, args.where);
  if (args.since_minutes && entry.date) {
    filter[entry.date] = { $gte: new Date(Date.now() - clamp(args.since_minutes, 1, 60 * 24 * 400, 1440) * 60000) };
  }
  const rows = await entry.model().aggregate([
    { $match: filter },
    { $group: { _id: `$${args.group_by}`, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 40 },
  ]);
  return { collection: args.collection, group_by: args.group_by, groups: rows.map((r) => ({ value: r._id, count: r.count })) };
}

// ---- Code tools (read-only, sandboxed to the repo, secrets blocked) ---------
const CODE_BLOCK = /(^|\/)(node_modules|\.git|public\/uploads|public\/drop-images|_deploy_backup)/;
const SECRET_FILE = /(\.env|\.pem$|\.key$|keystore|id_bothost|botHosts\.json|admins\.json)/i;
function resolveInRepo(p) {
  const abs = path.resolve(ROOT, String(p || "").replace(/^\/+/, ""));
  if (!abs.startsWith(ROOT + path.sep)) return null; // escaped the repo
  if (CODE_BLOCK.test(abs) || SECRET_FILE.test(abs)) return null;
  return abs;
}

function read_code(args = {}) {
  const abs = resolveInRepo(args.path);
  if (!abs) return { error: "path not allowed (outside repo, or a secret/ignored file)" };
  let text;
  try { text = fs.readFileSync(abs, "utf8"); } catch (e) { return { error: "cannot read: " + e.message }; }
  const all = text.split("\n");
  const start = Math.max(1, clamp(args.start, 1, all.length, 1));
  const count = clamp(args.lines, 1, 400, 200);
  const slice = all.slice(start - 1, start - 1 + count);
  return {
    path: path.relative(ROOT, abs),
    total_lines: all.length,
    from: start,
    to: start - 1 + slice.length,
    content: slice.map((l, i) => `${start + i}\t${l}`).join("\n").slice(0, 12000),
  };
}

function search_code(args = {}) {
  const query = String(args.query || "").slice(0, 120);
  if (!query) return { error: "query required" };
  return new Promise((resolve) => {
    const gArgs = [
      "-rniE", query, ROOT,
      "--include=*.js", "--include=*.html", "--include=*.json", "--include=*.md",
      "--exclude-dir=node_modules", "--exclude-dir=.git", "--exclude-dir=_deploy_backup",
      "--exclude=.env*", "-m", "3",
    ];
    execFile("grep", gArgs, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const lines = (stdout || "").split("\n").filter(Boolean)
        .filter((l) => !SECRET_FILE.test(l))
        .slice(0, 40)
        .map((l) => l.replace(ROOT + "/", "").slice(0, 240));
      resolve({ query, matches: lines.length, results: lines });
    });
  });
}

// ---- Memory / log / proposal tools -----------------------------------------
const recall_memory = (a = {}) => store.recallMemory(a.query, a.limit);
const save_memory = (a = {}) => store.saveMemory(a);
const read_log = (a = {}) => store.readLog(a.limit, a.query);
const list_proposals = (a = {}) => store.readProposals(a.status, a.limit);
async function propose(a = {}) {
  return store.addProposal({
    kind: a.kind, title: a.title, detail: a.detail,
    targets: a.targets, severity: a.severity,
  });
}

// Register the expanded tool set.
TOOLS.push(
  { schema: { type: "function", function: {
    name: "db_query",
    description: "Read rows from any whitelisted collection (marketplaces, pricing, listings, farming, drops, pool, bots, sales, research). Returns only safe fields. Call list_collections mentally via the descriptions here.",
    parameters: { type: "object", properties: {
      collection: { type: "string", enum: Object.keys(REGISTRY), description: Object.entries(REGISTRY).map(([k, v]) => `${k}: ${v.desc}`).join(" || ") },
      where: { type: "object", description: "field→value equality, or field→{gte|lte|gt|lt|ne|in|regex: value}. Only whitelisted fields work." },
      since_minutes: { type: "number", description: "restrict to rows newer than this (uses the collection's date field)" },
      sort: { type: "string", description: "field to sort by (default: newest first)" },
      sort_desc: { type: "boolean" },
      limit: { type: "number", description: "max rows, default 20, cap 50" },
    }, required: ["collection"] },
  } }, impl: db_query },
  { schema: { type: "function", function: {
    name: "db_count",
    description: "Count rows matching a filter in a whitelisted collection (e.g. how many listings are 'onsale' on plati). Cheap; use liberally.",
    parameters: { type: "object", properties: {
      collection: { type: "string", enum: Object.keys(REGISTRY) },
      where: { type: "object" }, since_minutes: { type: "number" },
    }, required: ["collection"] },
  } }, impl: db_count },
  { schema: { type: "function", function: {
    name: "db_group",
    description: "Group-and-count a collection by one field — the tool for COMPARING (listings per marketplace, sales per game, bots per host, pool per status).",
    parameters: { type: "object", properties: {
      collection: { type: "string", enum: Object.keys(REGISTRY) },
      group_by: { type: "string", description: "a whitelisted field to group on" },
      where: { type: "object" }, since_minutes: { type: "number" },
    }, required: ["collection", "group_by"] },
  } }, impl: db_group },
  { schema: { type: "function", function: {
    name: "read_code",
    description: "Read a source file from the repo (read-only, secrets blocked). Use to investigate HOW something works or to prepare a code fix proposal.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "repo-relative path, e.g. routes/marketplaceRoutes.js" },
      start: { type: "number", description: "1-based start line" },
      lines: { type: "number", description: "lines to read, default 200, cap 400" },
    }, required: ["path"] },
  } }, impl: read_code },
  { schema: { type: "function", function: {
    name: "search_code",
    description: "Grep the repo for a pattern (case-insensitive regex). Returns file:line matches. Use to locate where logic lives before read_code.",
    parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  } }, impl: search_code },
  { schema: { type: "function", function: {
    name: "recall_memory",
    description: "Search your own long-term memory (facts you've learned about this operation). Call early to reuse what you already know.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
  } }, impl: recall_memory },
  { schema: { type: "function", function: {
    name: "save_memory",
    description: "Save a durable fact about this operation for future sessions (e.g. a recurring failure pattern, a pricing quirk). Use a stable short key so re-learning updates in place.",
    parameters: { type: "object", properties: {
      key: { type: "string", description: "short stable slug, e.g. plati-underprices-cod" },
      topic: { type: "string", description: "pricing|listings|bots|farming|marketplaces|pool|sales|ops|code|domain" },
      text: { type: "string", description: "the fact, concise" },
      pinned: { type: "boolean", description: "pin if it should always be loaded" },
    }, required: ["key", "text"] },
  } }, impl: save_memory },
  { schema: { type: "function", function: {
    name: "read_log",
    description: "Read your recent past investigations (question + tools + answer). Use for continuity — 'what did we find last time about X'.",
    parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } },
  } }, impl: read_log },
  { schema: { type: "function", function: {
    name: "list_proposals",
    description: "List change proposals you've filed (open by default). Avoid filing a duplicate of something already open.",
    parameters: { type: "object", properties: { status: { type: "string", enum: ["open", "applied", "dismissed", "all"] }, limit: { type: "number" } } },
  } }, impl: list_proposals },
  { schema: { type: "function", function: {
    name: "propose",
    description: "File a concrete change recommendation for the operator to review and apply (you cannot change prod yourself). For a code fix, put the exact file + a before/after or diff in detail. This is how you 'do' things.",
    parameters: { type: "object", properties: {
      kind: { type: "string", enum: ["code", "pricing", "listings", "bots", "ops", "marketing", "other"] },
      title: { type: "string" },
      detail: { type: "string", description: "what to change, why, and exactly how (file+diff for code)" },
      targets: { type: "array", items: { type: "string" }, description: "short labels: file paths, logins, marketplaces, ids (never secrets)" },
      severity: { type: "string", enum: ["low", "medium", "high"] },
    }, required: ["title", "detail"] },
  } }, impl: propose },
);

const SCHEMAS = TOOLS.map((t) => t.schema);
const BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.schema.function.name, t.impl]));

// Execute one tool call by name; always returns a JSON-serializable value and
// never throws (a tool error becomes data the model can reason about).
async function runTool(name, args) {
  const fn = BY_NAME[name];
  if (!fn) return { error: `unknown tool: ${name}` };
  try {
    return await fn(args || {});
  } catch (err) {
    return { error: String(err && err.message ? err.message : err).slice(0, 300) };
  }
}

module.exports = { SCHEMAS, runTool, toolNames: Object.keys(BY_NAME) };
