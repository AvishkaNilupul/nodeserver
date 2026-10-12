// Read models for the SOOP panel: turns the farm's in-memory state into the
// State / Account / Bot / Alert shapes of docs/SOOP-FARM-CONTRACT.md §11.
// Pure functions — nothing here touches the database or SOOP.
const { creditStatus } = require("./geo");

const DEAD = "not_logged_in";
// Signed in on the main site but refused by the drops site: SOOP still answers
// "who am I" for the login, while every drops call says "please log in". It
// cannot read the campaign list, its watch time or its inventory.
const REJECTED = "drops_rejected";
const canFarm = (a) => !a.sold && a.status !== DEAD;
// What the panel may call a working login. canFarm stays wider on purpose: the
// farm keeps trying a refused login, which is how it comes back by itself when
// the drops site accepts it again. On 2026-10-11 every login was refused at
// once and the panel showed them as "ok, sleeping" for nine hours.
const usable = (a) => canFarm(a) && a.status !== REJECTED;

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
    session: sessionView(session) || (botId && sleep && usable(a) ? sleepView(sleep, minutes) : null),
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
    else if (!acc || !usable(acc) || (mine && mine.view.state === "error")) counts.error++;
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

// "in 3 hours" / "in 12 days", for a deadline in an alert.
function inWords(ms) {
  const hours = Math.max(1, Math.round(ms / 3600000));
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `in ${Math.round(hours / 24)} days`;
}

// Conditions the owner should act on, worst first.
// claims: what ./autoClaim.js waiting() answered, or null when it could not be read.
function alertsView({ egress, accounts, sessions, scan, inventoryTotals, claims, now }) {
  const out = [];
  const add = (level, kind, msg, extra = {}) =>
    out.push({
      id: [kind, extra.accountId || "", extra.botId || ""].concat(extra.tag ? [extra.tag] : []).join(":"),
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
    if (a.sold) continue;
    if (a.status === DEAD) {
      add("error", "auth", `${a.loginId} is logged out — re-import its cookie.`, { accountId: a.loginId, at: a.deadAt || a.unusableSince || a.lastCheckedAt });
    } else if (a.status === REJECTED) {
      // `lastCheckedAt` moves with every re-check, so it cannot say since when.
      add("error", "auth", `${a.loginId} is refused by the drops site, so it cannot farm — re-import its cookie.`, { accountId: a.loginId, at: a.unusableSince || a.lastCheckedAt });
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
  // Codes are claimed as they are earned, so one still unclaimed is stuck: on a
  // login that cannot claim, or on a reward SOOP keeps refusing.
  const stuck = claims && claims.stuck;
  if (stuck && stuck.rewards > 0) {
    const ids = stuck.logins || [];
    const names = ids.slice(0, 6).join(", ") + (ids.length > 6 ? ` and ${ids.length - 6} more` : "");
    const left = stuck.soonest ? new Date(stuck.soonest).getTime() - now : null;
    add(
      "warn",
      "claim",
      `${stuck.rewards} code reward(s) are waiting on ${ids.length} login(s) that cannot claim them (${names}) — re-import their cookies` +
        (left !== null && left > 0 ? `; the first runs out ${inWords(left)}.` : "."),
      { tag: "stuck" },
    );
  }
  const failed = claims && claims.failed;
  if (failed && failed.rewards > 0) {
    add("warn", "claim", `${failed.rewards} code reward(s) could not be claimed automatically (${failed.error || "no reason given"}) — they are tried again every few hours.`, { tag: "failed" });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

function totalsView(accounts, sessions, bots, inBot = () => false) {
  const t = { accounts: accounts.length, ok: 0, dead: 0, rejected: 0, sold: 0, farming: 0, waiting: 0, sleeping: 0, idle: 0, bots: bots.length, botsActive: 0 };
  for (const a of accounts) {
    if (a.sold) t.sold++;
    else if (a.status === DEAD) t.dead++;
    else if (a.status === REJECTED) t.rejected++;
    else t.ok++;
    const s = sessions.get(a.loginId);
    if (!s) {
      // A refused login in a bot is not asleep: nothing will wake it.
      if (!usable(a)) continue;
      if (inBot(a.loginId)) t.sleeping++;
      else t.idle++;
    } else if (s.view.state === "farming") t.farming++;
    else t.waiting++;
  }
  for (const b of bots) if (b.active) t.botsActive++;
  return t;
}

module.exports = { canFarm, usable, sessionView, sleepView, accountView, botView, egressView, alertsView, totalsView, DEAD, REJECTED };
