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
const SystemEvent = require("../models/SystemEvent");
const FleetSnapshot = require("../models/FleetSnapshot");

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
