// AUTO-FARMER — the brain that turns new Twitch drop campaigns into running
// bots without a human in the loop.
//
// Decision pipeline per campaign (see docs in the PR description):
//   master switch -> sellability (MarketResearch demandScore) -> time-left
//   gate -> reuse-first (weekly campaigns restart the game's existing
//   auto-bot) -> allocation math (30/game hard cap, pool reserve floor,
//   fair-share across simultaneous campaigns) -> host capacity gate ->
//   execute (or just plan + Telegram in dry-run mode).
//
// Every decision — including every skip — is stored as an AutoFarmTask and
// alerted via Telegram, so the owner can audit exactly why the system did or
// didn't spend accounts on a game.
const AutoFarmTask = require("../models/AutoFarmTask");
const TwitchCampaign = require("../models/TwitchCampaign");
const MarketResearch = require("../models/MarketResearch");
const AvailableAccount = require("../models/AvailableAccount");
const hosts = require("./botHosts");
const botFactory = require("./botFactory");
const settings = require("./settings");
const { sendTelegram } = require("./telegram");

const TICK_MS = 30 * 60 * 1000; // backstop interval; campaigns move slowly
const FIRST_TICK_DELAY_MS = 90 * 1000; // let the campaign watcher seed first

// Demand tiers (demandScore is 0-100 from utils/marketResearch.js).
const DEMAND_FULL = 40; // proven seller -> full allocation
const DEMAND_HALF = 15; // some demand -> half allocation; below -> skip

// Skips that may be retried when conditions change (pool refills, a
// container slot frees up, the Pi comes back online).
const RETRYABLE = new Set([
  "skip_no_accounts",
  "skip_no_capacity",
  "skip_host_offline",
]);

const state = {
  started: false,
  running: false,
  lastRun: null,
  lastError: "",
  lastSummary: null,
};

/* ------------------------------ helpers ------------------------------- */

function cfg() {
  return settings.getAutoFarm();
}

// Resolve the host auto-bots run on. Explicit hostId wins; otherwise the
// first SSH-transport host (the Raspberry Pi in this deployment). Never
// auto-picks the local server: auto-bots must not compete with the main
// host's workload unless the owner explicitly configures it.
function resolveFarmHost(af) {
  if (af.hostId) return hosts.resolveHost(af.hostId);
  const remote = hosts.listHosts().find((h) => h.transport === "ssh");
  return remote ? hosts.resolveHost(remote.id) : null;
}

// Ready = claimable right now with a working token. integrity_failed /
// token_invalid accounts can't farm, so they don't count as supply.
function readyPoolQuery() {
  return {
    status: "available",
    clientSecret: { $gt: "" },
    lastCheckStatus: { $in: ["", "ok"] },
  };
}

async function countReadyPool() {
  return AvailableAccount.countDocuments(readyPoolQuery());
}

// Case-insensitive MarketResearch lookup (campaign names and research rows
// both come from Twitch's game names, but hedge against case drift).
async function researchForGame(game) {
  const doc = await MarketResearch.findOne({
    game: new RegExp(
      "^" + game.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$",
      "i",
    ),
  }).lean();
  return doc || null;
}

function hoursLeft(endAt) {
  if (!endAt) return Infinity;
  return (new Date(endAt).getTime() - Date.now()) / 3600000;
}

// How many accounts a game deserves based on its demand tier.
// Returns { target, tierNote, skip } — skip=true means proven low demand.
function demandAllocation(research, af) {
  if (!research || research.scannedAt == null) {
    return {
      target: Math.min(af.probeSize, af.maxPerGame),
      tierNote: "no market data — probe batch",
      probe: true,
    };
  }
  const d = Number(research.demandScore || 0);
  if (d >= DEMAND_FULL) {
    return {
      target: af.maxPerGame,
      tierNote: "demand " + d + " (proven seller) — full allocation",
    };
  }
  if (d >= DEMAND_HALF) {
    return {
      target: Math.max(1, Math.ceil(af.maxPerGame / 2)),
      tierNote: "demand " + d + " (moderate) — half allocation",
    };
  }
  return { skip: true, demand: d };
}

// Split a limited budget across several campaigns proportionally to their
// demand weight, never giving any campaign more than it asked for. Leftover
// from capped campaigns is re-distributed greedily by weight.
function fairShare(requests, budget) {
  const out = new Map(requests.map((r) => [r.key, 0]));
  let remaining = Math.max(0, budget);
  let pending = requests.filter((r) => r.want > 0);
  while (remaining > 0 && pending.length) {
    const totalW = pending.reduce((s, r) => s + Math.max(1, r.weight), 0);
    let gaveAny = false;
    for (const r of pending) {
      const share = Math.max(
        1,
        Math.floor((remaining * Math.max(1, r.weight)) / totalW),
      );
      const need = r.want - out.get(r.key);
      const give = Math.min(share, need, remaining);
      if (give > 0) {
        out.set(r.key, out.get(r.key) + give);
        remaining -= give;
        gaveAny = true;
      }
    }
    pending = pending.filter((r) => out.get(r.key) < r.want);
    if (!gaveAny) break;
  }
  return out;
}

// Atomically reserve N ready pool accounts. Returns the claimed docs; on
// partial failure the caller must release them via releasePoolAccounts.
async function claimPoolAccounts(n, note) {
  const claimed = [];
  for (let i = 0; i < n; i++) {
    const doc = await AvailableAccount.findOneAndUpdate(
      readyPoolQuery(),
      {
        $set: {
          status: "claimed",
          claimedAt: new Date(),
          claimedNote: note,
        },
      },
      { new: true, sort: { lastCheckAt: -1 } }, // freshest-verified first
    );
    if (!doc) break;
    claimed.push(doc);
  }
  return claimed;
}

async function releasePoolAccounts(docs) {
  if (!docs.length) return;
  await AvailableAccount.updateMany(
    { _id: { $in: docs.map((d) => d._id) } },
    { $set: { status: "available", claimedAt: null, claimedNote: "" } },
  ).catch(() => {});
}

// Containers currently in use by live auto-farm tasks (the capacity gate).
async function activeAutoBotCount() {
  const rows = await AutoFarmTask.find(
    { status: "active" },
    { bots: 1 },
  ).lean();
  const seen = new Set();
  for (const t of rows) {
    for (const b of t.bots || []) seen.add(b.host + "|" + b.container);
  }
  return seen.size;
}

// The most recent task for this game that owns bots we can restart —
// weekly campaigns reuse infrastructure instead of burning new accounts.
async function reusableTaskForGame(game) {
  return AutoFarmTask.findOne({
    game,
    "bots.0": { $exists: true },
    status: { $in: ["active", "completed", "stopped"] },
  })
    .sort({ createdAt: -1 })
    .lean();
}

function tg(text) {
  return sendTelegram(text).catch(() => {});
}

/* --------------------------- decision + exec --------------------------- */

// Decide (and in live mode execute) one campaign. `budgetMap` caps how many
// accounts this campaign may claim this tick (fair-share result).
async function processCampaign(c, ctx) {
  const { af, host, hostOnline, budgetMap } = ctx;
  const game = c.game || c.name || "?";
  const key = c.campaignId;

  const base = {
    game,
    campaignId: c.campaignId,
    campaignName: c.name || "",
    campaignEndAt: c.endAt || null,
    dryRun: !!af.dryRun,
  };

  async function record(fields) {
    // upsert keeps the unique (game, campaignId) index happy on retries
    return AutoFarmTask.findOneAndUpdate(
      { game, campaignId: c.campaignId },
      { $set: { ...base, ...fields } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  // 1) Sellability gate.
  const research = await researchForGame(game);
  const alloc = demandAllocation(research, af);
  if (alloc.skip) {
    await record({
      decision: "skip_low_demand",
      status: "skipped",
      reason:
        "Market research shows demand score " +
        alloc.demand +
        " — items for this game don't sell; not worth pool accounts.",
      demandScore: alloc.demand,
      hadResearch: true,
    });
    await tg(
      "🤖 Auto-farm SKIP — " +
        game +
        "\nDemand score " +
        alloc.demand +
        " (items not salable). No accounts spent.",
    );
    return { decision: "skip_low_demand" };
  }
  const demandScore = research ? Number(research.demandScore || 0) : null;

  // 2) Time gate.
  const hrs = hoursLeft(c.endAt);
  if (hrs < af.minHoursLeft) {
    await record({
      decision: "skip_ends_soon",
      status: "skipped",
      reason:
        "Campaign ends in " +
        Math.max(0, Math.round(hrs)) +
        "h (< " +
        af.minHoursLeft +
        "h) — too late to farm meaningfully.",
      demandScore,
      hadResearch: !!research,
    });
    return { decision: "skip_ends_soon" };
  }

  // 3) Host gate.
  if (!hostOnline) {
    await record({
      decision: "skip_host_offline",
      status: "skipped",
      reason:
        "Farm host " +
        (host ? host.label : "?") +
        " unreachable — will retry next tick.",
      demandScore,
      hadResearch: !!research,
    });
    return { decision: "skip_host_offline" };
  }

  // 4) Reuse-first: weekly campaigns restart the game's existing auto-bot.
  const reusable = await reusableTaskForGame(game);
  if (reusable) {
    const bots = reusable.bots || [];
    const reason =
      "Recurring campaign for a game we already farm — reusing existing bot" +
      (bots.length > 1 ? "s" : "") +
      " (" +
      bots.map((b) => b.container).join(", ") +
      ") with their " +
      (reusable.assignedAccounts || []).length +
      " accounts instead of spending new pool accounts.";
    if (af.dryRun) {
      await record({
        decision: "reuse_existing",
        status: "planned",
        reason,
        demandScore,
        hadResearch: !!research,
        bots: bots.map((b) => ({ ...b, reused: true })),
        plannedAccounts: 0,
      });
      await tg("🤖 Auto-farm PLAN (dry-run) — " + game + "\n" + reason);
      return { decision: "reuse_existing", dryRun: true };
    }
    const started = [];
    const failed = [];
    for (const b of bots) {
      try {
        await botFactory.startContainer(hosts.resolveHost(b.host), b.container);
        started.push(b.container);
      } catch (e) {
        failed.push(b.container + ": " + e.message);
      }
    }
    await record({
      decision: "reuse_existing",
      status: started.length ? "active" : "failed",
      reason,
      demandScore,
      hadResearch: !!research,
      bots: bots.map((b) => ({ ...b, reused: true })),
      assignedAccounts: reusable.assignedAccounts || [],
      plannedAccounts: (reusable.assignedAccounts || []).length,
      error: failed.join("; "),
      executedAt: new Date(),
    });
    await tg(
      "🤖 Auto-farm REUSE — " +
        game +
        "\nRestarted " +
        started.join(", ") +
        (failed.length ? "\nFailed: " + failed.join("; ") : "") +
        "\nCampaign: " +
        (c.name || c.campaignId),
    );
    return { decision: "reuse_existing" };
  }

  // 5) Allocation: fair-share budget for this tick, capped by tier target.
  const budget = budgetMap.get(key) || 0;
  const target = Math.min(alloc.target, af.maxPerGame, budget);
  if (target < 1) {
    await record({
      decision: "skip_no_accounts",
      status: "skipped",
      reason:
        "Pool has no spendable accounts (reserve floor " +
        af.poolReserve +
        " protects manual work) — will retry when the pool refills.",
      demandScore,
      hadResearch: !!research,
      plannedAccounts: 0,
    });
    return { decision: "skip_no_accounts" };
  }

  // 6) Capacity gate: how many new containers can we still run?
  const activeBots = await activeAutoBotCount();
  const slotsFree = Math.max(0, af.maxAutoBots - activeBots);
  if (slotsFree < 1) {
    await record({
      decision: "skip_no_capacity",
      status: "skipped",
      reason:
        "All " +
        af.maxAutoBots +
        " auto-bot slots on " +
        host.label +
        " are busy — queued; retries when a campaign ends and frees a slot.",
      demandScore,
      hadResearch: !!research,
      plannedAccounts: target,
    });
    return { decision: "skip_no_capacity" };
  }
  // Trim the plan to fit free container slots.
  const accounts = Math.min(target, slotsFree * af.accountsPerBot);
  const botCount = Math.ceil(accounts / af.accountsPerBot);
  const decision = alloc.probe ? "probe" : "farm";
  const reason =
    (alloc.probe
      ? "New game with no sales history — farming a small probe batch to test the market. "
      : alloc.tierNote + ". ") +
    "Plan: " +
    accounts +
    " account" +
    (accounts === 1 ? "" : "s") +
    " across " +
    botCount +
    " bot" +
    (botCount === 1 ? "" : "s") +
    " on " +
    host.label +
    " (campaign ends in " +
    Math.round(hrs) +
    "h).";

  // 7) Dry-run: record the plan, alert, touch nothing.
  if (af.dryRun) {
    await record({
      decision,
      status: "planned",
      reason,
      demandScore,
      hadResearch: !!research,
      plannedAccounts: accounts,
    });
    await tg(
      "🤖 Auto-farm PLAN (dry-run) — " +
        game +
        "\n" +
        reason +
        "\nApprove it from the Bots → Auto farm tab to execute.",
    );
    return { decision, dryRun: true };
  }

  // 8) Live: claim accounts, create bots, activate.
  const task = await record({
    decision,
    status: "planned",
    reason,
    demandScore,
    hadResearch: !!research,
    plannedAccounts: accounts,
  });
  return executeTask(task, ctx);
}

// Execute a planned task for real: claim pool accounts, create bot(s) on the
// farm host, mark active. Used by live-mode ticks AND the one-click
// "approve" button on dry-run plans.
async function executeTask(task, ctx) {
  const af = ctx && ctx.af ? ctx.af : cfg();
  const host = ctx && ctx.host ? ctx.host : resolveFarmHost(af);
  if (!host) throw new Error("No farm host configured");
  const game = task.game;

  const want = Math.min(task.plannedAccounts || 0, af.maxPerGame);
  if (want < 1) throw new Error("Task has no planned accounts");

  // Re-check the reserve floor at execution time (things may have changed
  // since the plan was made).
  const ready = await countReadyPool();
  const spendable = Math.max(0, ready - af.poolReserve);
  const n = Math.min(want, spendable);
  if (n < 1) {
    await AutoFarmTask.updateOne(
      { _id: task._id },
      {
        $set: {
          status: "failed",
          error: "Pool below reserve floor at execution time",
        },
      },
    );
    throw new Error(
      "Pool below reserve floor (" +
        ready +
        " ready, reserve " +
        af.poolReserve +
        ")",
    );
  }

  const claimed = await claimPoolAccounts(
    n,
    "auto-farm: " + game + " (" + task.campaignId + ")",
  );
  if (!claimed.length) {
    await AutoFarmTask.updateOne(
      { _id: task._id },
      {
        $set: { status: "failed", error: "Could not claim any pool accounts" },
      },
    );
    throw new Error("Could not claim any pool accounts");
  }

  const bots = [];
  const deployed = [];
  let error = "";
  try {
    for (let i = 0; i < claimed.length; i += af.accountsPerBot) {
      const batch = claimed.slice(i, i + af.accountsPerBot);
      const bot = await botFactory.createBot(host, batch, game, {
        startRunning: true,
      });
      bots.push({
        host: bot.host,
        file: bot.file,
        container: bot.container,
        reused: false,
      });
      for (const b of batch) deployed.push(b);
      if (bot.startError) error += bot.container + ": " + bot.startError + "; ";
    }
  } catch (e) {
    error += e.message;
    // Release the accounts that were claimed but never made it into a config.
    const leftover = claimed.filter((c) => !deployed.includes(c));
    await releasePoolAccounts(leftover);
  }

  const ok = bots.length > 0;
  await AutoFarmTask.updateOne(
    { _id: task._id },
    {
      $set: {
        status: ok ? "active" : "failed",
        dryRun: false,
        bots,
        assignedAccounts: deployed.map((d) => d.username),
        error: error.trim(),
        executedAt: new Date(),
      },
    },
  );
  await tg(
    (ok ? "🤖 Auto-farm LIVE — " : "🤖 Auto-farm FAILED — ") +
      game +
      "\n" +
      (ok
        ? deployed.length +
          " accounts across " +
          bots.length +
          " bot(s) on " +
          host.label +
          ": " +
          bots.map((b) => b.container).join(", ")
        : "Could not create bots") +
      (error ? "\nIssues: " + error : ""),
  );
  if (!ok) throw new Error(error || "Bot creation failed");
  return { bots, accounts: deployed.length };
}

// Stop the bots of tasks whose campaign has ended. Accounts stay deployed
// (they hold the farmed inventory the drop scanner sells from); the config
// stays on disk so a future campaign for the same game reuses it.
async function completeEndedTasks() {
  const active = await AutoFarmTask.find({ status: "active" });
  let completed = 0;
  for (const t of active) {
    const c = await TwitchCampaign.findOne({ campaignId: t.campaignId }).lean();
    const ended =
      !c ||
      c.status === "EXPIRED" ||
      (c.endAt && new Date(c.endAt) < new Date());
    if (!ended) continue;
    const stopped = [];
    for (const b of t.bots || []) {
      try {
        const h = hosts.resolveHost(b.host);
        if (h) {
          await botFactory.stopContainer(h, b.container);
          stopped.push(b.container);
        }
      } catch {
        /* container may already be gone; completing anyway */
      }
    }
    t.status = "completed";
    t.completedAt = new Date();
    await t.save().catch(() => {});
    completed++;
    await tg(
      "🤖 Auto-farm DONE — " +
        t.game +
        "\nCampaign ended; stopped " +
        (stopped.join(", ") || "(no containers)") +
        ". " +
        (t.assignedAccounts || []).length +
        " farmed accounts kept as inventory.",
    );
  }
  return completed;
}

/* -------------------------------- tick --------------------------------- */

async function runOnce() {
  if (state.running) return { skipped: "already running" };
  state.running = true;
  try {
    const af = cfg();
    if (!af.enabled) {
      state.lastSummary = { enabled: false };
      return state.lastSummary;
    }

    // Always tidy up ended campaigns first — this frees container slots that
    // this same tick can then hand to queued campaigns.
    const completed = await completeEndedTasks();

    const host = resolveFarmHost(af);
    let hostOnline = false;
    if (host) {
      try {
        await hosts.readdir(host);
        hostOnline = true;
      } catch {
        hostOnline = false;
      }
    }

    // Candidates: live campaigns not yet decided, plus retryable skips.
    const now = new Date();
    const live = await TwitchCampaign.find({
      active: true,
      status: "ACTIVE",
      $or: [{ endAt: null }, { endAt: { $gt: now } }],
    }).lean();

    const candidates = [];
    for (const c of live) {
      if (!c.game) continue;
      const existing = await AutoFarmTask.findOne({
        game: c.game,
        campaignId: c.campaignId,
      }).lean();
      if (!existing) {
        candidates.push(c);
      } else if (
        existing.status === "skipped" &&
        RETRYABLE.has(existing.decision)
      ) {
        candidates.push(c); // conditions may have changed — re-decide
      }
    }

    // Fair-share budget across everything competing in this tick.
    const ready = await countReadyPool();
    const spendable = Math.max(0, ready - af.poolReserve);
    const requests = [];
    for (const c of candidates) {
      const research = await researchForGame(c.game);
      const alloc = demandAllocation(research, af);
      if (alloc.skip) {
        requests.push({ key: c.campaignId, want: 0, weight: 0 });
      } else {
        requests.push({
          key: c.campaignId,
          want: Math.min(alloc.target, af.maxPerGame),
          weight: research ? Math.max(1, Number(research.demandScore || 0)) : 5,
        });
      }
    }
    const budgetMap = fairShare(requests, spendable);

    const results = [];
    for (const c of candidates) {
      try {
        const r = await processCampaign(c, { af, host, hostOnline, budgetMap });
        results.push({ game: c.game, ...r });
      } catch (e) {
        results.push({ game: c.game, error: e.message });
      }
    }

    state.lastError = "";
    state.lastSummary = {
      enabled: true,
      dryRun: af.dryRun,
      host: host ? host.id : null,
      hostOnline,
      poolReady: ready,
      poolSpendable: spendable,
      candidates: candidates.length,
      completed,
      results,
    };
    return state.lastSummary;
  } catch (err) {
    state.lastError = err.message || String(err);
    throw err;
  } finally {
    state.lastRun = new Date();
    state.running = false;
  }
}

function status() {
  return {
    started: state.started,
    running: state.running,
    lastRun: state.lastRun,
    lastError: state.lastError,
    lastSummary: state.lastSummary,
    intervalMinutes: TICK_MS / 60000,
  };
}

function start() {
  if (state.started) return;
  state.started = true;
  const tick = async () => {
    try {
      await runOnce();
    } catch (err) {
      console.error("autoFarmer error:", err.message);
    }
    const t = setTimeout(tick, TICK_MS);
    if (t.unref) t.unref();
  };
  const t = setTimeout(tick, FIRST_TICK_DELAY_MS);
  if (t.unref) t.unref();
}

module.exports = {
  start,
  runOnce,
  status,
  executeTask,
  completeEndedTasks,
  // exported for tests
  fairShare,
  demandAllocation,
  resolveFarmHost,
};
