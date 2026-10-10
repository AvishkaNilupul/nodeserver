// Read models for the SOOP panel: turns the farm's in-memory state into the
// State / Account / Bot / Alert shapes of docs/SOOP-FARM-CONTRACT.md §11.
// Pure functions — nothing here touches the database or SOOP.
const { creditStatus } = require("./geo");

const DEAD = "not_logged_in";
const canFarm = (a) => !a.sold && a.status !== DEAD;

function sessionView(s) {
  if (!s) return null;
  const v = s.view;
  return {
    state: v.state,
    detail: v.detail,
    dropsIdx: v.dropsIdx,
    title: v.title,
    channel: v.channel,
    minutes: v.minutes,
    goal: v.goal,
    since: v.since,
    lastEventAt: v.lastEventAt,
    credited: v.credited,
  };
}

// An account in an active bot with no session is asleep: nothing runs for it
// until the watcher sees something to farm. Shown as a session-shaped row so
// the panel needs no special case.
function sleepView(z, minutes) {
  return {
    state: "sleeping",
    detail: z.detail || "Sleeping — nothing to farm right now",
    dropsIdx: z.dropsIdx || null,
    title: z.title || null,
    channel: null,
    minutes: minutes || 0,
    goal: z.goal ?? null,
    since: z.at || null,
    lastEventAt: null,
    credited: null,
  };
}

function accountView(a, { session, botId, sleep, minutes }) {
  return {
    id: a.loginId,
    nick: a.nickname || null,
    country: a.country || null,
    status: a.status,
    lastError: a.lastError || null,
    sold: !!a.sold,
    note: a.note || "",
    createdAt: a.createdAt || null,
    cookieAt: a.cookieAt || a.createdAt || null,
    lastCheckedAt: a.lastCheckedAt || null,
    botId: botId || null,
    session: sessionView(session) || (botId && sleep && canFarm(a) ? sleepView(sleep, minutes) : null),
  };
}

// ctx: { sessions: Map, accountsById: Map, progress: Map, campaignTitle(dropsIdx), gameName(gameNo) }
function botView(bot, ctx) {
  const counts = { total: bot.accountIds.length, farming: 0, waiting: 0, done: 0, error: 0 };
  const minutes = { sum: 0, goalSum: 0 };
  const done = new Set(bot.doneIds);
  for (const id of bot.accountIds) {
    const s = ctx.sessions.get(id);
    const mine = s && s.botId === bot.id ? s : null;
    const acc = ctx.accountsById.get(id);
    if (done.has(id)) counts.done++;
    else if (!acc || !canFarm(acc) || (mine && mine.view.state === "error")) counts.error++;
    else if (mine && mine.view.state === "farming") counts.farming++;
    else if (bot.active) counts.waiting++;

    if (mine && mine.view.goal != null) {
      minutes.sum += Math.min(Number(mine.view.minutes) || 0, mine.view.goal);
      minutes.goalSum += mine.view.goal;
    } else if (bot.mode === "campaign" && bot.dropsIdx) {
      // A sleeping account's progress may have been read without its goal.
      const p = (ctx.progress.get(id) || {})[String(bot.dropsIdx)];
      const goal = (p && p.goal) ?? (ctx.campaignGoal ? ctx.campaignGoal(bot.dropsIdx, bot.target) : null);
      if (goal != null) {
        minutes.sum += Math.min(Number(p && p.max) || 0, goal);
        minutes.goalSum += goal;
      }
    }
  }
  let state;
  if (!bot.active) {
    state = counts.total > 0 && counts.done >= counts.total ? "finished" : "stopped";
  } else if (counts.farming > 0) {
    state = "running";
  } else {
    // No session at all for its accounts: the bot is asleep, costing nothing.
    const awake = bot.accountIds.some((id) => ctx.sessions.has(id) && ctx.sessions.get(id).botId === bot.id);
    state = awake ? "waiting" : "sleeping";
  }
  return {
    id: bot.id,
    name: bot.name,
    mode: bot.mode,
    dropsIdx: bot.dropsIdx || null,
    gameNo: bot.gameNo || null,
    gameName: bot.gameNo ? ctx.gameName(bot.gameNo) : null,
    title: bot.dropsIdx ? ctx.campaignTitle(bot.dropsIdx) : null,
    target: bot.target,
    codesOnly: !!bot.codesOnly,
    priorityGameNo: bot.priorityGameNo || null,
    priorityGameName: bot.priorityGameNo ? ctx.gameName(bot.priorityGameNo) : null,
    active: !!bot.active,
    state,
    createdAt: bot.createdAt || bot.startedAt || null,
    startedAt: bot.startedAt || null,
    endedAt: bot.endedAt || null,
    accountIds: bot.accountIds.slice(),
    doneIds: bot.doneIds.slice(),
    counts,
    minutes,
  };
}

function egressView(transport, country) {
  const st = transport.stats();
  return {
    proxied: !!transport.proxied,
    ready: !!transport.ready,
    via: transport.describe(),
    country: country || null,
    credited: country ? creditStatus(country) : "unknown",
    lastOkAt: st.lastOkAt ? new Date(st.lastOkAt).toISOString() : null,
    lastErrorAt: st.lastErrorAt ? new Date(st.lastErrorAt).toISOString() : null,
    lastError: st.lastError || null,
  };
}

// Conditions the owner should act on, worst first.
function alertsView({ egress, accounts, sessions, scan, inventoryTotals, now }) {
  const out = [];
  const add = (level, kind, msg, extra = {}) =>
    out.push({
      id: [kind, extra.accountId || "", extra.botId || ""].join(":"),
      level,
      kind,
      msg,
      accountId: extra.accountId || null,
      botId: extra.botId || null,
      at: extra.at || new Date(now),
    });

  if (egress.proxied && !egress.ready) {
    add("error", "egress", "The proxy is configured but could not be started, so nothing is sent to SOOP. Check SOOP_PROXY_URL and the socks-proxy-agent package.");
  } else if (
    egress.lastErrorAt &&
    (!egress.lastOkAt || new Date(egress.lastErrorAt) > new Date(egress.lastOkAt)) &&
    now - new Date(egress.lastErrorAt).getTime() < 5 * 60000
  ) {
    add("error", "egress", "SOOP is unreachable through the egress right now (" + egress.lastError + ").", { at: egress.lastErrorAt });
  }
  if (egress.country && egress.credited === "no") {
    add("error", "country", `SOOP sees this connection in ${egress.country}, where watch time is not credited. Point the proxy at a host in a credited country.`);
  }
  if (scan && scan.ok === false && scan.error) {
    add("warn", "scan", "The campaign list could not be refreshed: " + scan.error, { at: scan.at });
  }
  for (const a of accounts) {
    if (a.status === DEAD && !a.sold) {
      add("error", "auth", `${a.loginId} is logged out — re-import its cookie.`, { accountId: a.loginId, at: a.deadAt || a.lastCheckedAt });
    }
  }
  for (const s of sessions.values()) {
    if (s.view.credited === false) {
      add("warn", "not-crediting", `${s.id} joined ${s.view.title || "a campaign"} but SOOP is not counting minutes.`, { accountId: s.id, botId: s.botId, at: s.view.lastEventAt });
    }
  }
  if (inventoryTotals && inventoryTotals.expiringSoon > 0) {
    add("warn", "expiring", `${inventoryTotals.expiringSoon} unclaimed reward(s) expire within 72 hours.`);
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

function totalsView(accounts, sessions, bots, inBot = () => false) {
  const t = { accounts: accounts.length, ok: 0, dead: 0, sold: 0, farming: 0, waiting: 0, sleeping: 0, idle: 0, bots: bots.length, botsActive: 0 };
  for (const a of accounts) {
    if (a.sold) t.sold++;
    else if (a.status === DEAD) t.dead++;
    else t.ok++;
    const s = sessions.get(a.loginId);
    if (!s) {
      if (!canFarm(a)) continue;
      if (inBot(a.loginId)) t.sleeping++;
      else t.idle++;
    } else if (s.view.state === "farming") t.farming++;
    else t.waiting++;
  }
  for (const b of bots) if (b.active) t.botsActive++;
  return t;
}

module.exports = { canFarm, sessionView, sleepView, accountView, botView, egressView, alertsView, totalsView, DEAD };
