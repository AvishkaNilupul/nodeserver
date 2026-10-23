// Read models for the CHZZK panel (docs/CHZZK-PANEL-V2.md §2). Pure: rows in,
// JSON-safe objects out. Callers project `cookies` and `codeEnc` away before
// calling, so nothing here can ever see a cookie or a code.

const { isCampaignFarmable, isFarmableReward, CODE_TYPES } = require("./normalize");

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const SHORT = (h) => (h ? String(h).slice(0, 8) : "");
const ms = (d) => {
  const t = d instanceof Date ? d.getTime() : d ? Date.parse(d) : NaN;
  return Number.isFinite(t) ? t : null;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + "s"}`;
const isCode = (r) => CODE_TYPES.includes(r && r.rewardType);

// English names for alert text; the panel's core.js keeps the same map.
const GAME_NAMES = {
  overwatch: "Overwatch", lost_ark: "Lost Ark", black_desert: "Black Desert",
  call_of_duty_modern_warfare4: "Call of Duty: MW4", world_of_warcraft_midnight: "WoW: Midnight",
  dokkaebi: "Dokkaebi World", once_human: "Once Human", stellasora: "Stella Sora",
  wutheringwaves: "Wuthering Waves", arknights_endfield: "Arknights: Endfield", fifa_online4: "FC Online",
};
function gameName(categoryId, categoryValue) {
  const id = String(categoryId || "");
  if (GAME_NAMES[id.toLowerCase()]) return GAME_NAMES[id.toLowerCase()];
  if (id) return id.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (ch) => ch.toUpperCase());
  return categoryValue || "game";
}

// Why a campaign is not farmed, in the operator's words. "" when it is farmed.
function campaignWhy(c, now) {
  if (!c) return "Unknown campaign";
  if (c.enabled === false) return "Turned off here";
  if (c.state === "TERMINATED") return "Ended by CHZZK";
  if (c.needsLink) return "Needs a linked game account";
  const start = ms(c.startAt);
  const end = ms(c.endAt);
  if (start != null && start > now) return "Not started yet";
  if (end != null && end <= now) return "Ended";
  const rewards = c.rewards || [];
  if (!rewards.some(isCode)) return "In-game rewards only (no codes)";
  if (!rewards.some(isFarmableReward)) return "Every code is gone";
  if (!isCampaignFarmable({ ...c, enabled: true }, now)) return "Not farmable";
  return "";
}

// v1 wrote done:true without checking; only a verified mark counts as done.
function progressView(progress) {
  const out = {};
  for (const [no, p] of Object.entries(progress || {})) {
    if (!p || typeof p !== "object") continue;
    out[no] = {
      minutes: Number(p.minutes) || 0,
      next: p.next == null ? null : Number(p.next),
      done: !!(p.done && p.verified),
      rewards: p.rewards && typeof p.rewards === "object" ? p.rewards : {},
      at: p.doneAt || p.at || null,
    };
  }
  return out;
}

function whyIdle(a, { switchOn, egressOk }) {
  if (a.sold) return "Sold";
  if (a.paused) return "Paused";
  if (a.status === "not_logged_in") return "Logged out — re-import its cookie";
  if (!switchOn) return "Farm is switched off";
  if (!egressOk) return "Egress is down";
  return "Starting…";
}

function accountView(a, { worker, codes = 0, switchOn, egressOk, now }) {
  const running = !!worker;
  const imported = ms(a.cookieAt);
  const dead = a.status === "not_logged_in" ? ms(a.unusableSince) : null;
  return {
    id: String(a._id),
    nickname: a.nickname || "",
    userIdHash: SHORT(a.userIdHash),
    status: a.status || "untested",
    lastError: a.lastError || "",
    cookieAt: a.cookieAt || null,
    lastCheckedAt: a.lastCheckedAt || null,
    sold: !!a.sold,
    paused: !!a.paused,
    note: a.note || "",
    running,
    why: running ? "" : whyIdle(a, { switchOn, egressOk }),
    current: running ? (worker.current || null) : null,
    progress: progressView(a.progress),
    codes,
    login: {
      kind: a.cookieKind || "unknown",
      expiresAt: a.cookieExpiresAt || null,
      ageDays: imported != null ? Math.max(0, Math.floor((now - imported) / DAY)) : null,
      deadSince: dead != null ? new Date(dead) : null,
      livedDays: dead != null && imported != null ? Math.max(0, Math.round(((dead - imported) / DAY) * 10) / 10) : null,
    },
  };
}

// Per-campaign view. `accounts` are accountView()s (for the per-login summary).
function campaignView(c, { earnedByReward, accounts = [], now }) {
  const why = campaignWhy(c, now);
  const no = String(c.campaignNo);
  const eligible = accounts.filter((a) => a.status !== "not_logged_in" && !a.sold && !a.paused);
  const logins = [];
  let done = 0;
  let watching = 0;
  for (const a of eligible) {
    const p = a.progress[no];
    const isWatching = !!(a.current && Number(a.current.campaignNo) === Number(c.campaignNo) && a.current.state === "watching");
    if (p && p.done) done++;
    if (isWatching) watching++;
    if (p || isWatching) {
      logins.push({
        id: a.id, nickname: a.nickname,
        minutes: isWatching ? Number(a.current.minutes) || (p ? p.minutes : 0) : p ? p.minutes : 0,
        done: !!(p && p.done), watching: isWatching,
      });
    }
  }
  const maxMinutes = (c.rewards || []).filter(isFarmableReward).reduce((m, r) => Math.max(m, Number(r.minutes) || 0), 0);
  return {
    campaignNo: c.campaignNo,
    title: c.title || "",
    categoryType: c.categoryType || "",
    categoryId: c.categoryId || "",
    categoryValue: c.categoryValue || "",
    state: c.state || "",
    startAt: c.startAt || null,
    endAt: c.endAt || null,
    imageUrl: c.imageUrl || "",
    enabled: c.enabled !== false,
    source: c.source || "",
    needsLink: !!c.needsLink,
    guide: String(c.guide || "").slice(0, 2000),
    lastSeenAt: c.lastSeenAt || null,
    refreshedAt: c.refreshedAt || null,
    farmable: !why,
    why,
    maxMinutes,
    rewards: (c.rewards || []).map((r) => ({
      rewardNo: r.rewardNo,
      title: r.title || "",
      rewardType: r.rewardType || "",
      minutes: r.minutes,
      remaining: r.remaining,
      imageUrl: r.imageUrl || "",
      farmable: isFarmableReward(r),
      earned: (earnedByReward && earnedByReward.get(r.rewardNo)) || 0,
    })),
    logins: { eligible: eligible.length, done, watching, list: logins },
  };
}

function rewardView(r, { accountsById, campaignsByNo }) {
  const acc = accountsById.get(String(r.accountId));
  const camp = campaignsByNo.get(Number(r.campaignNo));
  return {
    id: String(r._id),
    accountId: r.accountId,
    nickname: (acc && acc.nickname) || "",
    userIdHash: SHORT(r.userIdHash),
    campaignNo: r.campaignNo,
    rewardNo: r.rewardNo,
    title: r.title || "",
    rewardType: r.rewardType || "",
    categoryId: r.categoryId || "",
    gameName: (camp && camp.categoryValue) || r.categoryId || "",
    campaignTitle: r.campaignTitle || (camp && camp.title) || "",
    state: r.state || "",
    hasCode: !!r.hasCode,
    earnedAt: r.earnedAt || null,
    codeAt: r.codeAt || null,
    codeEndAt: r.codeEndAt || null,
    tries: r.tries || 0,
    nextTryAt: r.nextTryAt || null,
    lastError: r.lastError || "",
    revealedAt: r.revealedAt || null,
    revealedBy: r.revealedBy || "",
  };
}

// Stock: one line per reward kind. "fresh" = stored and never revealed —
// the codes nobody has seen yet (what could be sold later).
function stockView(rows, { campaignsByNo, now }) {
  const groups = new Map();
  for (const r of rows) {
    if (r.state === "in_app") continue;
    const key = r.campaignNo + "|" + r.rewardNo;
    let g = groups.get(key);
    if (!g) {
      const camp = campaignsByNo.get(Number(r.campaignNo));
      g = {
        campaignNo: r.campaignNo, rewardNo: r.rewardNo,
        game: (camp && camp.categoryValue) || r.categoryId || "",
        campaignTitle: r.campaignTitle || (camp && camp.title) || "",
        title: r.title || "", rewardType: r.rewardType || "",
        stored: 0, fresh: 0, revealed: 0, waiting: 0, expired: 0,
        useBy: null, lastEarnedAt: null,
      };
      groups.set(key, g);
    }
    const end = ms(r.codeEndAt);
    if (r.hasCode) {
      g.stored++;
      if (end != null && end <= now) g.expired++;
      else if (r.revealedAt) g.revealed++;
      else g.fresh++;
      if (end != null && end > now && (g.useBy == null || end < ms(g.useBy))) g.useBy = new Date(end);
    } else {
      g.waiting++;
    }
    const earned = ms(r.earnedAt);
    if (earned != null && (g.lastEarnedAt == null || earned > ms(g.lastEarnedAt))) g.lastEarnedAt = new Date(earned);
  }
  const stock = [...groups.values()].sort((a, b) =>
    String(a.game).localeCompare(String(b.game)) || a.campaignNo - b.campaignNo || a.rewardNo - b.rewardNo);
  const totals = stock.reduce((t, g) => {
    for (const k of ["stored", "fresh", "revealed", "waiting", "expired"]) t[k] += g[k];
    return t;
  }, { stored: 0, fresh: 0, revealed: 0, waiting: 0, expired: 0 });
  return { stock, totals };
}

// Server-side alerts for the header and Overview. Plain sentences, worst first.
function alerts({ switchOn, egress, accounts, campaigns, counts, now }) {
  const out = [];
  const live = accounts.filter((a) => !a.sold);
  if (!switchOn) out.push({ level: "warn", kind: "switch", msg: "The farm is switched off — nothing is being watched." });
  else if (!egress.ok) out.push({ level: "error", kind: "egress", msg: `Egress is down (${egress.error || "not checked yet"}) — no login is used until it is back.` });

  const out1 = live.filter((a) => a.status === "not_logged_in");
  if (out1.length) {
    out.push({ level: "error", kind: "login", msg: `${plural(out1.length, "login")} logged out — re-import ${out1.length === 1 ? "its cookie" : "their cookies"}: ${out1.map((a) => a.nickname || a.userIdHash).join(", ")}` });
  }
  if (counts.waiting) {
    out.push({ level: "warn", kind: "codes", msg: `${plural(counts.waiting, "earned code")} could not be read yet — the farm retries every 30 min.` });
  }

  const eligible = live.filter((a) => a.status === "ok" && !a.paused);
  for (const c of campaigns) {
    if (!c.farmable) continue;
    const end = ms(c.endAt);
    if (end == null || end - now > 12 * HOUR) continue;
    const left = eligible.filter((a) => !(a.progress[String(c.campaignNo)] || {}).done);
    if (!left.length) continue;
    const hours = Math.max(1, Math.round((end - now) / HOUR));
    out.push({
      level: "warn", kind: "ending", campaignNo: c.campaignNo,
      msg: `${gameName(c.categoryId, c.categoryValue)}: "${c.title}" ends in ${plural(hours, "hour")} — ${left.length} of ${plural(eligible.length, "login")} still to finish it (${c.maxMinutes} min needed).`,
    });
  }

  if (switchOn && egress.ok && eligible.length && !campaigns.some((c) => c.farmable)) {
    out.push({ level: "info", kind: "idle", msg: "No campaign can be farmed right now — the logins wait for the next one." });
  }
  const session = eligible.filter((a) => a.login.kind === "session");
  if (session.length) {
    out.push({ level: "info", kind: "cookie", msg: `${plural(session.length, "login")} ${session.length === 1 ? "was" : "were"} exported without "Stay signed in" (로그인 상태 유지) — session cookies may log out sooner.` });
  }
  const soon = eligible.filter((a) => { const e = ms(a.login.expiresAt); return e != null && e - now < 7 * DAY; });
  if (soon.length) {
    out.push({ level: "warn", kind: "cookie", msg: `The cookies of ${plural(soon.length, "login")} expire within 7 days — re-export ${soon.length === 1 ? "it" : "them"} before then.` });
  }
  if (counts.expiringSoon) {
    out.push({ level: "info", kind: "codes", msg: `${plural(counts.expiringSoon, "unrevealed code")} expire${counts.expiringSoon === 1 ? "s" : ""} within 7 days.` });
  }
  const rank = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

module.exports = { gameName, campaignWhy, progressView, accountView, campaignView, rewardView, stockView, alerts };
