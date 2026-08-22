const AutoFarmSnapshot = require("../models/AutoFarmSnapshot");
const AutoFarmTask = require("../models/AutoFarmTask");
const BotAccount = require("../models/BotAccount");
const AvailableAccount = require("../models/AvailableAccount");
const hosts = require("./botHosts");
const settings = require("./settings");
const autoFarmer = require("./autoFarmer");
const botWaker = require("./botWaker");
const botHealthMonitor = require("./botHealthMonitor");
const { PARK_FRESH_MS, classifyBotCompletion } = require("./farmCompletion");

const KEY = "auto-farm";
const FAST_INTERVAL_MS = 45 * 1000;
const HOST_INTERVAL_MS = 5 * 60 * 1000;
const HOST_STALE_MS = 15 * 60 * 1000;
const WATCHER_FRESH_MS = PARK_FRESH_MS;
const BOT_PROJECTION = {
  clientSecret: 1,
  login: 1,
  lastScanAt: 1,
  lastScanStatus: 1,
  inProgressCount: 1,
  inProgressGames: 1,
  dropCount: 1,
  // Real watch-minute progress toward each drop, written per inventory scan by
  // utils/dropScanner.js. Rolled up per bot by farmingRollup() below so the
  // watcher can show "% avg · ETA · N items" instead of only account counts.
  farmingProgress: 1,
  farmingSnapshotAt: 1,
  farmingCompleteAt: 1,
};

const state = {
  snapshot: null,
  hostData: new Map(),
  // Raw configs are kept only in process memory so fast DB-only refreshes can
  // reclassify fresh scan signals. They are never copied into the snapshot.
  topology: new Map(),
  started: false,
  fastBuilding: null,
  fullBuilding: null,
  fastTimer: null,
  fullTimer: null,
  dbLoad: null,
};

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

// Roll a container's per-account BotAccount.farmingProgress[] up into one
// watcher-friendly summary. Returns null when no account has any in-progress
// item (so the UI can fall back to the plain "N/M progressing" account count).
// `percent`/`current`/`required` are watch-minute progress toward each drop;
// watch-minutes accrue ~1/min, so (required - current) ≈ minutes remaining.
function farmingRollup(mine, { now = new Date() } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  let items = 0;
  let percentSum = 0;
  let readySoon = 0;
  let eta = null;
  let newestSnap = 0;
  for (const acc of mine || []) {
    if (acc && acc.farmingSnapshotAt) {
      const t = new Date(acc.farmingSnapshotAt).getTime();
      if (!Number.isNaN(t) && t > newestSnap) newestSnap = t;
    }
    const progress =
      acc && Array.isArray(acc.farmingProgress) ? acc.farmingProgress : [];
    for (const it of progress) {
      if (!it) continue;
      const pct = Math.max(0, Math.min(100, Number(it.percent) || 0));
      items += 1;
      percentSum += pct;
      if (pct >= 75) readySoon += 1;
      const remain =
        Math.max(0, (Number(it.required) || 0) - (Number(it.current) || 0));
      // Only items not yet complete contribute to "time to first ready".
      if (pct < 100 && remain > 0 && (eta === null || remain < eta)) eta = remain;
    }
  }
  if (!items) return null;
  return {
    items,
    avgPercent: Math.round(percentSum / items),
    readySoon,
    etaMinutes: eta === null ? 0 : Math.round(eta),
    snapshotAt: newestSnap ? new Date(newestSnap).toISOString() : null,
    stale: !newestSnap || nowMs - newestSnap > WATCHER_FRESH_MS,
  };
}

function botKey(hostId, container) {
  return String(hostId || "") + "|" + String(container || "");
}

function taskProjection() {
  return {
    game: 1,
    campaignId: 1,
    campaignName: 1,
    campaignEndAt: 1,
    decision: 1,
    reason: 1,
    plannedAccounts: 1,
    targetAccounts: 1,
    assignedAccounts: 1,
    bots: 1,
    status: 1,
    dryRun: 1,
    error: 1,
    createdAt: 1,
    updatedAt: 1,
    decidedAt: 1,
    executedAt: 1,
    completedAt: 1,
    "listing.externalId": 1,
    "listing.title": 1,
    "listing.error": 1,
    "listing.postEvent": 1,
    "listing.plati": 1,
    "listing.ggsel": 1,
    "listing.zeusx": 1,
    "listing.url": 1,
    "listing.price": 1,
    "listing.qty": 1,
    "listing.heldBack": 1,
    "stackListing.externalId": 1,
    "stackListing.title": 1,
    "stackListing.error": 1,
    "stackListing.plati": 1,
    "stackListing.ggsel": 1,
    "stackListing.zeusx": 1,
    "stackListing.url": 1,
    "stackListing.price": 1,
    "stackListing.qty": 1,
    "stackListing.heldBack": 1,
  };
}

function historyProjection() {
  return {
    game: 1,
    campaignId: 1,
    campaignName: 1,
    campaignEndAt: 1,
    decision: 1,
    reason: 1,
    status: 1,
    error: 1,
    createdAt: 1,
    updatedAt: 1,
    decidedAt: 1,
    bots: 1,
  };
}

function compactListing(listing) {
  if (!listing) return null;
  const market = (row) =>
    row
      ? {
          externalId: row.externalId || "",
          url: row.url || "",
          qty: Number(row.qty) || 0,
          error: row.error || "",
        }
      : null;
  return {
    externalId: listing.externalId || "",
    url: listing.url || "",
    price: Number(listing.price) || 0,
    qty: Number(listing.qty) || 0,
    heldBack: Number(listing.heldBack) || 0,
    title: listing.title || "",
    error: listing.error || "",
    postEvent: !!listing.postEvent,
    plati: market(listing.plati),
    ggsel: market(listing.ggsel),
    zeusx: market(listing.zeusx),
  };
}

function compactCompletion(completion) {
  if (!completion) return null;
  return {
    onlyFavourites: completion.onlyFavourites !== false,
    assignedGames: Array.isArray(completion.assignedGames)
      ? completion.assignedGames
      : [],
    oldestScanAt: iso(completion.oldestScanAt),
    total: Number(completion.total) || 0,
    working: Number(completion.working) || 0,
    finished: Number(completion.finished) || 0,
    unknown: Number(completion.unknown) || 0,
    notStarted: Number(completion.notStarted) || 0,
    stoppable: !!completion.stoppable,
    reason: completion.reason || "",
  };
}

function allAutoBotKeys(tasks) {
  const keys = new Set();
  for (const task of tasks || []) {
    for (const bot of task.bots || []) {
      if (bot && bot.host && bot.file) keys.add(bot.host + "|" + bot.file);
    }
  }
  return [...keys];
}

function activeTaskBots(tasks) {
  const out = new Map();
  for (const task of tasks || []) {
    if (task.status !== "active") continue;
    if (!Array.isArray(task.bots)) continue;
    for (const bot of task.bots) {
      const host = String(bot.host || "");
      const container = String(bot.container || "");
      if (!host || !container) continue;
      const key = botKey(host, container);
      let row = out.get(key);
      if (!row) {
        row = {
          key,
          host,
          container,
          file: bot.file || "",
          taskIds: [],
          games: [],
          assignedCount: 0,
        };
        out.set(key, row);
      }
      if (task._id) row.taskIds.push(String(task._id));
      if (task.game && !row.games.includes(task.game))
        row.games.push(task.game);
      row.assignedCount += Array.isArray(task.assignedAccounts)
        ? task.assignedAccounts.length
        : 0;
    }
  }
  return out;
}

function healthByKey() {
  const status = botHealthMonitor.status();
  const out = new Map();
  for (const row of status.containers || []) {
    const parts = String(row.key || "").split(":");
    if (parts.length < 2) continue;
    const host = parts.shift();
    out.set(botKey(host, parts.join(":")), row);
  }
  for (const row of (status.decay && status.decay.containers) || []) {
    const parts = String(row.key || "").split(":");
    if (parts.length < 2) continue;
    const host = parts.shift();
    const key = botKey(host, parts.join(":"));
    out.set(key, { ...(out.get(key) || {}), decay: row });
  }
  return { status, byKey: out };
}

function deriveBotState({
  docker,
  completion,
  parked,
  health,
  degraded = 0,
  observedAt,
  now = Date.now(),
}) {
  const stale =
    !observedAt || now - new Date(observedAt).getTime() > HOST_STALE_MS;
  if (stale)
    return { state: "UNKNOWN", reason: "host data unavailable or stale" };
  // The registry is authoritative for an intentional stop. Docker may omit a
  // stopped container entirely on some host adapters, so PARKED must precede
  // the generic missing-container DOWN verdict.
  if (parked && (!docker || docker.state !== "running")) {
    return {
      state: "PARKED",
      reason: parked.reason || "parked by auto-farm",
      parkedAt: parked.parkedAt || null,
      wakeCondition: "new live campaign for an assigned game",
    };
  }
  if (!docker)
    return { state: "DOWN", reason: "expected container is missing" };
  if (docker.state !== "running") {
    return {
      state: "DOWN",
      reason: docker.status || "container is not running",
    };
  }
  if (
    health &&
    (health.stuck || health.crashing || (health.decay && health.decay.decayed))
  ) {
    return {
      state: "STALLED",
      reason: health.crashing
        ? "known-bad pattern in recent logs"
        : health.decay && health.decay.decayed
          ? "thread decay"
          : "no log output",
    };
  }
  // No verdict at all — the container is up but its config was unreadable or
  // absent from this host pass (collectHost passes `byFile[file] || null`).
  // This MUST be handled before any completion.* dereference below: a running
  // container with no readable config is a real, reachable state, and reading
  // through null here threw a TypeError that aborted the whole host collection.
  if (!completion)
    return { state: "UNKNOWN", reason: "completion data unavailable" };
  if (completion.working && degraded) {
    return {
      state: "DEGRADED",
      reason: degraded + " assigned account(s) have bad scan status",
    };
  }
  if (completion.working)
    return {
      state: "FARMING",
      reason: "assigned accounts have in-progress work",
    };
  if (completion.unknown || completion.notStarted) {
    return {
      state: "UNKNOWN",
      reason: completion.reason,
    };
  }
  if (completion.stoppable)
    return { state: "DONE_IDLE", reason: completion.reason };
  return {
    state: "UNKNOWN",
    reason: completion.reason || "no completion verdict",
  };
}

// The operator is in Japan; the server process runs on UTC. Using the server's
// own midnight made "today" roll over at 09:00 JST, so every morning the panel
// read ~0 decisions until mid-morning and then reset in the middle of the
// working day. Anchor the day to midnight Asia/Tokyo instead — same convention
// (and same no-DST reasoning) as utils/poolUsageWatcher.js#usageSince.
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function startOfJstDay(now = new Date()) {
  const jst = new Date(new Date(now).getTime() + JST_OFFSET_MS);
  jst.setUTCHours(0, 0, 0, 0);
  return new Date(jst.getTime() - JST_OFFSET_MS);
}

function decisionSummary(tasks, now = new Date()) {
  const start = startOfJstDay(now);
  const rows = (tasks || []).filter((task) => {
    const at = task.decidedAt || task.createdAt;
    return at && new Date(at) >= start;
  });
  const byDecision = {};
  for (const task of rows) {
    const key = String(task.decision || "unknown");
    byDecision[key] = (byDecision[key] || 0) + 1;
  }
  return {
    since: start.toISOString(),
    total: rows.length,
    farm: rows.filter((r) =>
      ["farm", "probe", "reuse_existing"].includes(r.decision),
    ).length,
    skipped: rows.filter((r) => String(r.decision || "").startsWith("skip_"))
      .length,
    byDecision,
  };
}

function hostHeader(hostData) {
  return [...hostData.entries()].map(([id, row]) => ({
    id,
    observedAt: row.observedAt || null,
    lastAttemptAt: row.lastAttemptAt || null,
    error: row.error || "",
    stale:
      !row.observedAt ||
      Date.now() - new Date(row.observedAt).getTime() > HOST_STALE_MS,
  }));
}

function buildPayload({
  tasks,
  hostData,
  now = new Date(),
  settingsValue,
  pool,
}) {
  const botRows = activeTaskBots(tasks);
  const health = healthByKey();
  const bots = [...botRows.values()].map((row) => {
    const host = hostData.get(row.host);
    const detail = host && host.bots ? host.bots[row.container] : null;
    const derived = deriveBotState({
      docker: detail && detail.docker,
      completion: detail && detail.completion,
      parked: detail && detail.parked,
      health: health.byKey.get(row.key),
      degraded: detail && detail.degraded,
      observedAt: host && host.observedAt,
      now: now.getTime(),
    });
    const completion = compactCompletion(detail && detail.completion);
    const healthRow = health.byKey.get(row.key) || null;
    return {
      ...row,
      ...derived,
      assignedCount: completion ? completion.total : row.assignedCount,
      accounts: completion
        ? {
            total: completion.total,
            progressing: completion.working,
            finished: completion.finished,
            unknown: completion.unknown + completion.notStarted,
            deadToken: Number(detail && detail.deadToken) || 0,
            suspended: Number(detail && detail.suspended) || 0,
            scanError: Number(detail && detail.scanError) || 0,
          }
        : null,
      file: row.file || (detail && detail.file) || "",
      containerState: detail && detail.docker ? detail.docker.state : null,
      status: detail && detail.docker ? detail.docker.status : null,
      uptimeMs:
        detail && detail.docker
          ? botHealthMonitor.parseUptimeMs(detail.docker.status)
          : null,
      completion,
      degraded: detail && detail.degraded ? detail.degraded : 0,
      farming: detail && detail.farming ? detail.farming : null,
      health: healthRow,
      hostObservedAt: host && host.observedAt ? host.observedAt : null,
      actions: {
        restart: !!(detail && detail.docker),
        wake: derived.state === "PARKED",
      },
    };
  });

  const botsByKey = new Map(bots.map((bot) => [bot.key, bot]));

  const games = [];
  for (const task of tasks || []) {
    if (task.status !== "active") continue;
    const game = {
      id: String(task._id || ""),
      taskId: String(task._id || ""),
      game: task.game,
      campaignId: task.campaignId,
      campaignName: task.campaignName,
      campaignEndAt: iso(task.campaignEndAt),
      status: task.status,
      decision: task.decision,
      reason: task.reason,
      dryRun: !!task.dryRun,
      error: task.error || "",
      assignedCount: Array.isArray(task.assignedAccounts)
        ? task.assignedAccounts.length
        : 0,
      targetAccounts:
        Number(task.targetAccounts) || Number(task.plannedAccounts) || 0,
      listing: compactListing(task.listing),
      stackListing: compactListing(task.stackListing),
      actions: {
        stop: true,
        delist: !!(task.listing && task.listing.externalId),
      },
      bots: [],
    };
    for (const bot of task.bots || []) {
      const key = botKey(bot.host, bot.container);
      const snapshotBot = botsByKey.get(key);
      if (snapshotBot) game.bots.push(snapshotBot);
    }
    games.push(game);
  }

  const attention = [];
  for (const task of tasks || []) {
    if (task.status === "planned")
      attention.push({
        severity: "warn",
        type: "plan",
        taskId: String(task._id),
        game: task.game,
        reason: task.reason,
      });
    const campaignLive =
      !task.campaignEndAt || new Date(task.campaignEndAt) > now;
    if (task.status === "failed" && campaignLive)
      attention.push({
        severity: "error",
        type: "failed",
        taskId: String(task._id),
        game: task.game,
        reason: task.error || task.reason,
      });
    if (
      campaignLive &&
      ["skip_no_capacity", "skip_no_accounts"].includes(task.decision) &&
      task.status === "skipped"
    ) {
      attention.push({
        severity: "warn",
        type: task.decision,
        taskId: String(task._id),
        game: task.game,
        reason: task.reason,
      });
    }
  }
  for (const bot of bots) {
    if (["STALLED", "DOWN", "DEGRADED"].includes(bot.state)) {
      attention.push({
        severity: bot.state === "DOWN" ? "error" : "warn",
        type: bot.state.toLowerCase(),
        bot: bot.key,
        game: bot.games.join(", "),
        reason: bot.reason,
      });
    }
    if (bot.degraded && bot.state !== "DEGRADED") {
      attention.push({
        type: "bad_accounts",
        bot: bot.key,
        game: bot.games.join(", "),
        reason: bot.degraded + " assigned account(s) have bad scan status",
      });
    }
  }

  const af = settingsValue || settings.getAutoFarm();
  const engine = autoFarmer.status();
  // Match the planner's capacity gate: every distinct container owned by an
  // active task counts, including a temporarily parked one.
  const capacityUsed = bots.length;
  return {
    header: {
      mode: !af.enabled ? "OFF" : af.dryRun ? "DRY-RUN" : "LIVE",
      engine,
      settings: {
        maxPerGame: af.maxPerGame,
        accountsPerBot: af.accountsPerBot,
        maxAutoBots: af.maxAutoBots,
        poolReserve: af.poolReserve,
        stopFinishedBots: af.stopFinishedBots !== false,
        consolidate: af.consolidate !== false,
        deleteFinishedBots: af.deleteFinishedBots !== false,
      },
      host: (() => {
        const host = autoFarmer.resolveFarmHost(af);
        return host ? { id: host.id, label: host.label } : null;
      })(),
      pool: pool || { ready: 0, reserve: af.poolReserve, spendable: 0 },
      capacity: {
        used: capacityUsed,
        max: af.maxAutoBots,
        pct: af.maxAutoBots ? capacityUsed / af.maxAutoBots : 0,
        activeAutoBots: capacityUsed,
        maxAutoBots: af.maxAutoBots,
        usedPct: af.maxAutoBots ? (capacityUsed / af.maxAutoBots) * 100 : 0,
      },
      hosts: hostHeader(hostData),
      nextScanAt: engine.nextRunAt || null,
      lastScanAt: engine.lastRun || null,
    },
    bots,
    games,
    attention,
    decisionSummary: decisionSummary(tasks, now),
    autoBotKeys: allAutoBotKeys(tasks),
  };
}

async function loadTasks() {
  const [live, history] = await Promise.all([
    AutoFarmTask.find(
      { status: { $in: ["planned", "active"] } },
      taskProjection(),
    )
      .sort({ updatedAt: -1 })
      .lean(),
    AutoFarmTask.find(
      { status: { $nin: ["planned", "active"] } },
      historyProjection(),
    )
      .sort({ updatedAt: -1 })
      .limit(500)
      .lean(),
  ]);
  return live.concat(history);
}

async function loadPool(af) {
  const ready = await AvailableAccount.countDocuments({
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
  });
  return {
    ready,
    reserve: af.poolReserve,
    spendable: Math.max(0, ready - af.poolReserve),
  };
}

async function collectHost(hostId, taskMap, now, registry) {
  const host = hosts.resolveHost(hostId);
  if (!host) return { error: "unknown host" };
  const lastAttemptAt = now.toISOString();
  let docker;
  try {
    docker = await hosts.dockerPs(host);
  } catch (error) {
    return { error: error.message || String(error), lastAttemptAt };
  }
  const files = [...taskMap.values()]
    .filter((b) => b.host === hostId && b.file)
    .map((b) => b.file)
    .filter((file, i, all) => all.indexOf(file) === i);
  let configs = {};
  try {
    configs = await hosts.readFiles(host, files);
  } catch (error) {
    return { error: error.message || String(error), lastAttemptAt };
  }
  const secrets = [];
  const parsed = {};
  for (const file of files) {
    const item = configs[file];
    if (!item || !item.ok) continue;
    try {
      parsed[file] = JSON.parse(item.text);
      for (const user of (parsed[file].TwitchSettings &&
        parsed[file].TwitchSettings.TwitchUsers) ||
        []) {
        if (user && user.Enabled !== false && user.ClientSecret)
          secrets.push(String(user.ClientSecret).trim());
      }
    } catch {
      parsed[file] = null;
    }
  }
  const rows = secrets.length
    ? await BotAccount.find(
        { clientSecret: { $in: [...new Set(secrets)] } },
        BOT_PROJECTION,
      ).lean()
    : [];
  const byFile = {};
  for (const file of files) {
    const data = parsed[file];
    if (!data) continue;
    const users =
      (data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [];
    const wanted = new Set(
      users
        .map((u) => String((u && u.ClientSecret) || "").trim())
        .filter(Boolean),
    );
    const mine = rows.filter((r) => wanted.has(String(r.clientSecret)));
    const container = [...taskMap.values()].find(
      (b) => b.host === hostId && b.file === file,
    );
    byFile[file] = classifyBotCompletion(data, mine, {
      freshMs: WATCHER_FRESH_MS,
      now,
    });
    if (container) byFile[file].file = file;
  }
  const health = healthByKey().byKey;
  const bots = {};
  for (const row of taskMap.values()) {
    if (row.host !== hostId) continue;
    const completion = byFile[row.file] || null;
    const dockerRow = docker[row.container] || null;
    const parked = registry[botKey(hostId, row.container)] || null;
    const h = health.get(row.key);
    const stateRow = deriveBotState({
      docker: dockerRow,
      completion,
      parked,
      health: h,
      observedAt: now,
      now: now.getTime(),
    });
    const data = parsed[row.file];
    const userSecrets = new Set(
      ((data && data.TwitchSettings && data.TwitchSettings.TwitchUsers) || [])
        .map((u) => String((u && u.ClientSecret) || "").trim())
        .filter(Boolean),
    );
    const mine = rows.filter((r) => userSecrets.has(String(r.clientSecret)));
    const degraded = mine.filter((r) =>
      ["token_invalid", "error", "suspended"].includes(r.lastScanStatus),
    ).length;
    bots[row.container] = {
      file: row.file,
      docker: dockerRow,
      completion,
      parked,
      degraded,
      deadToken: mine.filter((r) => r.lastScanStatus === "token_invalid").length,
      suspended: mine.filter((r) => r.lastScanStatus === "suspended").length,
      scanError: mine.filter((r) => r.lastScanStatus === "error").length,
      farming: farmingRollup(mine, { now }),
      state: stateRow.state,
      stateReason: stateRow.reason,
    };
  }
  state.topology.set(hostId, parsed);
  return { observedAt: now.toISOString(), lastAttemptAt, error: "", bots };
}

function mergeHostResult(previous, result) {
  if (result && result.error && previous) {
    return {
      ...previous,
      lastAttemptAt: result.lastAttemptAt || previous.lastAttemptAt,
      error: result.error,
    };
  }
  return result;
}

function hydrateHostData(snapshot) {
  if (!snapshot || state.hostData.size) return;
  const headers = new Map(
    ((snapshot.header && snapshot.header.hosts) || []).map((row) => [
      row.id,
      row,
    ]),
  );
  for (const bot of snapshot.bots || []) {
    if (!bot.host || !bot.container) continue;
    let host = state.hostData.get(bot.host);
    if (!host) {
      const head = headers.get(bot.host) || {};
      host = {
        observedAt: head.observedAt || bot.hostObservedAt || null,
        lastAttemptAt: head.lastAttemptAt || null,
        error: head.error || "",
        bots: {},
      };
      state.hostData.set(bot.host, host);
    }
    host.bots[bot.container] = {
      file: bot.file || "",
      docker: bot.containerState
        ? { state: bot.containerState, status: bot.status || "" }
        : null,
      completion: bot.completion || null,
      farming: bot.farming || null,
      degraded: Number(bot.degraded) || 0,
      deadToken: Number(bot.accounts && bot.accounts.deadToken) || 0,
      suspended: Number(bot.accounts && bot.accounts.suspended) || 0,
      scanError: Number(bot.accounts && bot.accounts.scanError) || 0,
      parked:
        bot.state === "PARKED"
          ? {
              parkedAt: bot.parkedAt || null,
              reason: bot.reason || "parked by auto-farm",
            }
          : null,
    };
  }
}

async function refreshCompletionFromTopology(tasks, now) {
  const taskMap = activeTaskBots(tasks);
  for (const [hostId, parsed] of state.topology.entries()) {
    const hostRow = state.hostData.get(hostId);
    if (!hostRow || !hostRow.bots) continue;
    const files = [...taskMap.values()]
      .filter((b) => b.host === hostId && parsed[b.file])
      .map((b) => b.file);
    const secrets = [];
    for (const file of files) {
      const users =
        (parsed[file].TwitchSettings &&
          parsed[file].TwitchSettings.TwitchUsers) ||
        [];
      for (const user of users) {
        if (user && user.Enabled !== false && user.ClientSecret)
          secrets.push(String(user.ClientSecret).trim());
      }
    }
    const rows = secrets.length
      ? await BotAccount.find(
          { clientSecret: { $in: [...new Set(secrets)] } },
          BOT_PROJECTION,
        ).lean()
      : [];
    for (const row of taskMap.values()) {
      if (
        row.host !== hostId ||
        !parsed[row.file] ||
        !hostRow.bots[row.container]
      )
        continue;
      const users =
        (parsed[row.file].TwitchSettings &&
          parsed[row.file].TwitchSettings.TwitchUsers) ||
        [];
      const wanted = new Set(
        users
          .map((u) => String((u && u.ClientSecret) || "").trim())
          .filter(Boolean),
      );
      const mine = rows.filter((r) => wanted.has(String(r.clientSecret)));
      hostRow.bots[row.container].completion = classifyBotCompletion(
        parsed[row.file],
        mine,
        {
          freshMs: WATCHER_FRESH_MS,
          now,
        },
      );
      hostRow.bots[row.container].degraded = mine.filter((r) =>
        ["token_invalid", "error", "suspended"].includes(r.lastScanStatus),
      ).length;
      hostRow.bots[row.container].deadToken = mine.filter(
        (r) => r.lastScanStatus === "token_invalid",
      ).length;
      hostRow.bots[row.container].suspended = mine.filter(
        (r) => r.lastScanStatus === "suspended",
      ).length;
      hostRow.bots[row.container].scanError = mine.filter(
        (r) => r.lastScanStatus === "error",
      ).length;
      hostRow.bots[row.container].farming = farmingRollup(mine, { now });
    }
  }
}

async function buildSnapshot() {
  const started = Date.now();
  const tasks = await loadTasks();
  const af = settings.getAutoFarm();
  const pool = await loadPool(af);
  await refreshCompletionFromTopology(tasks, new Date());
  const payload = buildPayload({
    tasks,
    hostData: state.hostData,
    settingsValue: af,
    pool,
    now: new Date(),
  });
  const newestHostAt = [...state.hostData.values()]
    .map((row) => row.observedAt && new Date(row.observedAt))
    .filter((at) => at && !Number.isNaN(at.getTime()))
    .sort((a, b) => b - a)[0];
  const built = {
    key: KEY,
    schemaVersion: 1,
    builtAt: new Date(),
    buildMs: Date.now() - started,
    hostBuiltAt:
      newestHostAt || (state.snapshot && state.snapshot.hostBuiltAt) || null,
    ...payload,
  };
  state.snapshot = built;
  await AutoFarmSnapshot.updateOne(
    { key: KEY },
    { $set: built },
    { upsert: true },
  ).catch((error) =>
    console.error("[autoFarmSnapshot] persist failed:", error.message),
  );
  return built;
}

async function refreshFast() {
  if (state.fastBuilding) return state.fastBuilding;
  state.fastBuilding = buildSnapshot().finally(() => {
    state.fastBuilding = null;
  });
  return state.fastBuilding;
}

async function refreshFull() {
  if (state.fullBuilding) return state.fullBuilding;
  state.fullBuilding = (async () => {
    const tasks = await loadTasks();
    const taskMap = activeTaskBots(tasks);
    const hostIds = [
      ...new Set([...taskMap.values()].map((b) => b.host).filter(Boolean)),
    ];
    const registry = await botWaker.readRegistry().catch(() => ({}));
    const results = await Promise.all(
      hostIds.map(async (id) => [
        id,
        await collectHost(id, taskMap, new Date(), registry),
      ]),
    );
    for (const [id, result] of results) {
      const old = state.hostData.get(id);
      state.hostData.set(id, mergeHostResult(old, result));
    }
    // Host polling is deliberately independent of the fast cadence. If a fast
    // build is already publishing, the next scheduled fast pass will pick up
    // these last-good host results instead of making either cycle wait.
    if (state.fastBuilding) return state.snapshot;
    return buildSnapshot();
  })().finally(() => {
    state.fullBuilding = null;
  });
  return state.fullBuilding;
}

// Manual refresh semantics: cover writes that happened before this call even
// when a scheduled build was already in flight.
async function refresh() {
  if (state.fullBuilding) await state.fullBuilding.catch(() => {});
  if (state.fastBuilding) await state.fastBuilding.catch(() => {});
  return refreshFull();
}

async function read() {
  if (state.snapshot) return state.snapshot;
  if (!state.dbLoad) {
    state.dbLoad = AutoFarmSnapshot.findOne({ key: KEY })
      .lean()
      .then((doc) => {
        if (doc && !state.snapshot) {
          state.snapshot = doc;
          hydrateHostData(doc);
        }
        return state.snapshot;
      })
      .catch(() => null)
      .finally(() => {
        state.dbLoad = null;
      });
  }
  return state.dbLoad;
}

function schedule() {
  clearTimeout(state.fastTimer);
  clearTimeout(state.fullTimer);
  state.fastTimer = setTimeout(() => {
    refreshFast()
      .catch(() => {})
      .finally(scheduleFast);
  }, FAST_INTERVAL_MS);
  state.fullTimer = setTimeout(() => {
    refreshFull()
      .catch(() => {})
      .finally(scheduleFull);
  }, HOST_INTERVAL_MS);
  if (state.fastTimer.unref) state.fastTimer.unref();
  if (state.fullTimer.unref) state.fullTimer.unref();
}
function scheduleFast() {
  if (!state.started) return;
  state.fastTimer = setTimeout(() => {
    refreshFast()
      .catch(() => {})
      .finally(scheduleFast);
  }, FAST_INTERVAL_MS);
  if (state.fastTimer.unref) state.fastTimer.unref();
}
function scheduleFull() {
  if (!state.started) return;
  state.fullTimer = setTimeout(() => {
    refreshFull()
      .catch(() => {})
      .finally(scheduleFull);
  }, HOST_INTERVAL_MS);
  if (state.fullTimer.unref) state.fullTimer.unref();
}

function start() {
  if (state.started) return;
  state.started = true;
  read()
    .then(() =>
      refreshFull().catch((error) =>
        console.error("[autoFarmSnapshot] initial build:", error.message),
      ),
    )
    .catch(() => {});
  schedule();
}

function stop() {
  state.started = false;
  clearTimeout(state.fastTimer);
  clearTimeout(state.fullTimer);
  state.fastTimer = null;
  state.fullTimer = null;
}

function _reset() {
  stop();
  state.snapshot = null;
  state.hostData.clear();
  state.topology.clear();
  state.fastBuilding = null;
  state.fullBuilding = null;
  state.dbLoad = null;
}

module.exports = {
  FAST_INTERVAL_MS,
  HOST_INTERVAL_MS,
  HOST_STALE_MS,
  WATCHER_FRESH_MS,
  botKey,
  farmingRollup,
  deriveBotState,
  decisionSummary,
  buildPayload,
  mergeHostResult,
  allAutoBotKeys,
  refreshFast,
  refreshFull,
  refresh,
  read,
  getStoredSnapshot: read,
  start,
  stop,
  _reset,
};
