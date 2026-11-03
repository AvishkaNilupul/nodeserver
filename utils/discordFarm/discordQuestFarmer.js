// Discord Quest farmer — the orchestrator that takes a Discord session plus
// a captcha-solver function and runs the full enroll → spoof-progress → solve
// captcha → claim-reward loop for one or many quests.
//
// This module is kept transport-agnostic: HTTP goes through discordHttp.js
// (so the whole flow exits through the same host IP as the solver's proxy),
// and the solver is injected by the caller as a closure that returns a token
// — this module never touches 2captcha / CapSolver directly, which keeps the
// vendor swap we hit tonight a one-line change at the call site.
//
// Supported task event types (as of 2026-10, Discord quest API v2):
//   - WATCH_VIDEO / WATCH_VIDEO_ON_MOBILE  → POST /quests/{id}/video-progress
//     with incrementing `timestamp` values up to the quest's `target` seconds.
//     The ramp is deliberately gentle (5 steps + 1s dwell between) to look
//     like a watcher, not a clicker; Discord has accepted this cleanly in
//     every probe we've run so far.
//   - PLAY_ON_DESKTOP                      → POST /quests/{id}/heartbeat
//     with the game's application_id. Discord sits in the heartbeat loop
//     accepting application=<game> for `target` seconds; we send one every
//     30s with a jittered duration until target is reached.
//   - STREAM_ON_DESKTOP                    → same heartbeat endpoint but with
//     `stream=true` to mark a stream session; sends every 30s like PLAY.
// Anything else throws `unsupported` — add a branch here when a new type
// appears so the system fails loud, not silent.

const { discordRequest, buildSuperProperties, fingerprintForUserAgent } = require("./discordHttp");

// Default fingerprint for a freshly-opened Discord web client. Callers can
// override any field; the account-level locale/timezone we observed in the
// probe should be passed through here so Discord sees internally-consistent
// headers across the three requests (enroll, progress, claim).
function defaultFingerprint() {
  const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
  return {
    ua,
    xsp: buildSuperProperties({ userAgent: ua }),
    locale: "en-US",
    timezone: "Etc/UTC",
  };
}

function discordHeaders(session) {
  const fp = session.fingerprint || defaultFingerprint();
  return {
    Authorization: session.token,
    "User-Agent": fp.ua,
    "X-Super-Properties": fp.xsp,
    "X-Discord-Locale": fp.locale,
    "X-Discord-Timezone": fp.timezone,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: "https://discord.com/channels/@me",
    Origin: "https://discord.com",
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pull the full `/quests/@me` catalog and return only quests the server says
// are currently live for this account. `userStatus` is also returned so the
// caller can see enrollment / completion / claim state.
async function listLiveQuests(session) {
  const r = await discordRequest(session.host, {
    method: "GET",
    path: "/api/v9/quests/@me",
    headers: discordHeaders(session),
    proxy: session.proxy,
  });
  if (r.status !== 200) throw new Error("listLiveQuests: HTTP " + r.status);
  const now = Date.now();
  const live = [];
  for (const q of (r.data && r.data.quests) || []) {
    const cfg = q.config || {};
    const expMs = cfg.expires_at ? Date.parse(cfg.expires_at) : 0;
    const startMs = cfg.starts_at ? Date.parse(cfg.starts_at) : 0;
    if (!expMs || expMs < now) continue;
    if (startMs && startMs > now) continue;
    live.push({
      id: q.id,
      name: (cfg.messages && cfg.messages.quest_name) || cfg.application?.name || q.id,
      application: cfg.application || null,
      expiresAt: cfg.expires_at,
      taskConfig: cfg.task_config_v2 || cfg.tasks_config || null,
      rewards: (cfg.rewards_config && cfg.rewards_config.rewards) || [],
      userStatus: q.user_status || null,
      config: cfg,
    });
  }
  return live;
}

// Enroll in a quest. Idempotent on the server side (409 "already enrolled" is
// treated as success — we re-read the state after).
async function enrollQuest(session, questId) {
  const r = await discordRequest(session.host, {
    method: "POST",
    path: "/api/v9/quests/" + encodeURIComponent(questId) + "/enroll",
    headers: discordHeaders(session),
    body: { location: 0 },
    proxy: session.proxy,
  });
  // 200 = fresh enrol; 409 or 400-with-already-enrolled is fine too
  if (r.status === 200) return r.data;
  if (r.status === 409) return r.data;
  // Discord sometimes returns 400 with a "already enrolled" code — treat as OK
  if (r.status === 400 && r.data && (r.data.code === 50068 || /already/i.test(r.data.message || ""))) {
    return r.data;
  }
  throw new Error("enrollQuest " + questId + ": HTTP " + r.status + " " + JSON.stringify(r.data).slice(0, 200));
}

// Dispatch task completion based on the event type. `taskConfig` is the
// `task_config_v2.tasks` sub-object from the quest config AFTER enrollment
// (pre-enrollment it's empty — Discord only reveals it to enrolled users).
async function completeTask(session, questId, taskConfig, { log = () => {} } = {}) {
  if (!taskConfig || !taskConfig.tasks) {
    throw new Error("completeTask: task config missing");
  }
  const tasks = taskConfig.tasks;
  // Prefer the DESKTOP variant when the quest offers desktop OR mobile; our
  // request headers advertise Mac Chrome, so mobile would be inconsistent.
  const order = ["WATCH_VIDEO", "PLAY_ON_DESKTOP", "STREAM_ON_DESKTOP", "WATCH_VIDEO_ON_MOBILE"];
  let chosen = null;
  for (const t of order) {
    if (tasks[t]) { chosen = t; break; }
  }
  if (!chosen) chosen = Object.keys(tasks)[0];
  const task = tasks[chosen];
  const target = Number(task && task.target) || 0;
  if (!target) throw new Error("completeTask: no target seconds for " + chosen);
  log(`completeTask: ${chosen} target=${target}s`);
  if (chosen === "WATCH_VIDEO" || chosen === "WATCH_VIDEO_ON_MOBILE") {
    return completeVideoTask(session, questId, target, { log });
  }
  if (chosen === "PLAY_ON_DESKTOP" || chosen === "STREAM_ON_DESKTOP") {
    const stream = chosen === "STREAM_ON_DESKTOP";
    return completePlayTask(session, questId, target, {
      applicationId: (session.questApplicationId) || null,
      stream,
      log,
    });
  }
  throw new Error("completeTask: unsupported task type " + chosen);
}

// Ramp timestamp POSTs to `/video-progress` until the server marks the task
// complete. Discord's server sets `progress.{EVENT}.completed_at` once the
// POSTed value reaches `target` — we return the final response for the caller
// to inspect.
async function completeVideoTask(session, questId, target, { log }) {
  const steps = buildRamp(target);
  let last = null;
  for (let i = 0; i < steps.length; i++) {
    const ts = steps[i];
    const r = await discordRequest(session.host, {
      method: "POST",
      path: "/api/v9/quests/" + encodeURIComponent(questId) + "/video-progress",
      headers: discordHeaders(session),
      body: { timestamp: ts },
      proxy: session.proxy,
    });
    if (r.status !== 200) {
      throw new Error("video-progress ts=" + ts + " HTTP " + r.status + " " + JSON.stringify(r.data).slice(0, 200));
    }
    last = r.data;
    log(`video-progress ts=${ts} completed_at=${last && last.completed_at}`);
    if (last && last.completed_at) return last;
    if (i < steps.length - 1) await sleep(1000 + Math.floor(Math.random() * 500));
  }
  return last;
}

// A gentle ramp — Discord accepts straight jumps too (we tested) but a human-
// looking ramp lowers the anti-cheat signal if they ever tighten this.
// For target=24 → [5,10,15,20,24]; for larger targets we insert more steps.
function buildRamp(target) {
  if (target <= 0) return [0];
  if (target <= 10) return [Math.ceil(target / 2), target];
  if (target <= 30) {
    const n = 4;
    const step = Math.floor(target / n);
    return Array.from({ length: n }, (_, i) => (i + 1) * step).concat(target).filter((v, i, a) => a.indexOf(v) === i);
  }
  // Larger: ~6-8 steps max
  const n = Math.min(8, Math.ceil(target / 15));
  const step = Math.floor(target / n);
  const out = Array.from({ length: n }, (_, i) => (i + 1) * step);
  if (out[out.length - 1] !== target) out.push(target);
  return out;
}

// PLAY_ON_DESKTOP / STREAM_ON_DESKTOP heartbeats. Discord accepts a
// `heartbeat` POST roughly every 30s with the game's application_id and
// accumulates "played time" against the target. We send 1 heartbeat per
// 30s window with a small jitter until target is reached. If no
// applicationId is supplied, we try the quest's own application.id (which
// Discord accepts for test runs — a legit client-side detection would use
// the game's detectable application id, but the server's heartbeat endpoint
// doesn't cross-check against the game process).
async function completePlayTask(session, questId, target, { applicationId, stream, log }) {
  const path = "/api/v9/quests/" + encodeURIComponent(questId) + "/heartbeat";
  const start = Date.now();
  let last = null;
  while ((Date.now() - start) / 1000 < target + 30) {
    const body = { stream: !!stream };
    if (applicationId) body.application_id = String(applicationId);
    const r = await discordRequest(session.host, {
      method: "POST",
      path,
      headers: discordHeaders(session),
      body,
      proxy: session.proxy,
    });
    if (r.status !== 200) {
      throw new Error("heartbeat HTTP " + r.status + " " + JSON.stringify(r.data).slice(0, 200));
    }
    last = r.data;
    const progress = last && last.stream_progress_seconds;
    log(`heartbeat progress=${progress}s target=${target}s`);
    if (last && last.completed_at) return last;
    if (progress != null && progress >= target) return last;
    await sleep(30000 + Math.floor(Math.random() * 3000));
  }
  return last;
}

// Trigger the captcha challenge then call solverFn to get a solved token and
// retry the claim. The request shape here is NOT what the public API docs
// imply — Discord's current (2026-10) web client posts an expanded body with
// `location: 11` (quest widget source) and additional metadata fields, and
// passes the solved captcha token as an `X-Captcha-Key` HEADER, not in the
// body. This was reverse-engineered from the Vencord quest-autocompleter
// plugin (Seramicx/discord-quest-autocompleter → questAutocompleter/native.ts).
// Our first implementation used `location: 0` with captcha_key in the body
// and every solved token came back as "invalid-response" — Discord's way of
// saying "your request shape is wrong," confusingly presented as a captcha
// rejection. The solver itself doesn't need rqdata or proxy for Discord's
// current challenge (Proxyless + sitekey + pageUrl is enough).
//
// solverFn signature stays the same so later vendors (e.g. puppeteer-driven
// solve) can slot in without the farmer caring: ({ sitekey, data, userAgent,
// pageUrl }) => token. We still pass data/userAgent — a vendor can ignore
// them.
//
// `traffic_metadata_sealed` is pulled from the quest config when available
// (farmQuest threads it through session.trafficMetadataSealed). Null is the
// safe default and Discord accepts it for most quests.
async function claimReward(session, questId, solverFn, { log = () => {}, maxAttempts = 3 } = {}) {
  if (solverFn.prepareSession) await solverFn.prepareSession(session);
  const claimPath = "/api/v9/quests/" + encodeURIComponent(questId) + "/claim-reward";
  const baseBody = {
    platform: 0,
    location: 11,
    is_targeted: false,
    metadata_sealed: null,
    traffic_metadata_sealed: session.trafficMetadataSealed || null,
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const trigger = await discordRequest(session.host, {
      method: "POST",
      path: claimPath,
      headers: discordHeaders(session),
      body: baseBody,
      proxy: session.proxy,
    });
    if (trigger.status === 200) return trigger.data; // Already-claimable path (rare)
    if (trigger.status !== 400 || !trigger.data || !trigger.data.captcha_sitekey) {
      throw new Error("claimReward trigger: HTTP " + trigger.status + " " + JSON.stringify(trigger.data).slice(0, 300));
    }
    const { captcha_sitekey, captcha_rqdata, captcha_rqtoken, captcha_session_id } = trigger.data;
    log(`claim attempt ${attempt}: captcha challenge sitekey=${captcha_sitekey}`);
    const solved = await solverFn({
      sitekey: captcha_sitekey,
      data: captcha_rqdata,
      userAgent: (session.fingerprint && session.fingerprint.ua) || defaultFingerprint().ua,
      pageUrl: "https://discord.com/", // Vencord-confirmed: root, trailing slash
    });
    const token = typeof solved === "string" ? solved : solved?.token;
    if (!token) throw new Error("captcha solver returned an empty token");
    if (solved?.userAgent) session.fingerprint = fingerprintForUserAgent(solved.userAgent, session.fingerprint);
    log(`claim attempt ${attempt}: solver returned ${token ? "a token" : "(empty)"}`);
    const retryHeaders = {
      ...discordHeaders(session),
      "X-Captcha-Key": token,
      ...(captcha_rqtoken ? { "X-Captcha-Rqtoken": captcha_rqtoken } : {}),
      ...(captcha_session_id ? { "X-Captcha-Session-Id": captcha_session_id } : {}),
    };
    const retry = await discordRequest(session.host, {
      method: "POST",
      path: claimPath,
      headers: retryHeaders,
      body: baseBody,
      proxy: session.proxy,
    });
    if (retry.status === 200) return retry.data;
    if (retry.status === 400 && retry.data && retry.data.captcha_sitekey) {
      log(`claim attempt ${attempt}: token rejected (${(retry.data.captcha_key || [])[0] || "unknown"}), retrying`);
      continue;
    }
    throw new Error("claimReward retry: HTTP " + retry.status + " " + JSON.stringify(retry.data).slice(0, 300));
  }
  throw new Error("claimReward: exhausted " + maxAttempts + " captcha attempts");
}

// End-to-end: enroll, pull live task config, complete, claim. Returns a
// structured record of the whole run.
async function farmQuest(session, questId, solverFn, { log = () => {} } = {}) {
  const record = { questId, startedAt: new Date().toISOString() };
  try {
    await enrollQuest(session, questId);
    log(`enrolled ${questId}`);
    const live = await listLiveQuests(session);
    const q = live.find((x) => x.id === questId);
    if (!q) throw new Error("quest not found in live set after enrol: " + questId);
    record.questName = q.name;
    record.rewardName = (q.rewards[0] && q.rewards[0].messages && q.rewards[0].messages.name) || null;
    record.rewardType = q.rewards[0] && q.rewards[0].type;
    // Thread the quest's own application_id (for heartbeat path) AND the
    // quest-specific traffic_metadata_sealed (for claim body) through session.
    // The traffic metadata lives on the user_status (per-enrollment), not on
    // the quest config (per-quest definition) — Vencord confirms this.
    const sessionWithApp = {
      ...session,
      questApplicationId: q.application && q.application.id,
      trafficMetadataSealed: (q.userStatus && q.userStatus.traffic_metadata_sealed) || null,
    };
    const completed = await completeTask(sessionWithApp, questId, q.taskConfig, { log });
    record.completedAt = (completed && completed.completed_at) || null;
    if (!record.completedAt) throw new Error("completion ran but completed_at not set");
    const claim = await claimReward(sessionWithApp, questId, solverFn, { log });
    record.claimedAt = (claim && claim.claimed_at) || new Date().toISOString();
    record.orbsClaimed = (claim && claim.orb_quantity_claimed) || null;
    record.ok = true;
  } catch (e) {
    record.ok = false;
    record.error = String(e && e.message || e);
  } finally {
    record.finishedAt = new Date().toISOString();
  }
  return record;
}

// Farm every currently-live quest sequentially. Returns an array of per-quest
// records. Stops on the first captcha-solver error (that's usually a vendor
// issue affecting all solves) but continues on per-quest failures.
async function farmAllLiveQuests(session, solverFn, { log = () => {} } = {}) {
  const live = await listLiveQuests(session);
  log(`farming ${live.length} live quests`);
  const results = [];
  for (const q of live) {
    if (q.userStatus && q.userStatus.claimed_at) {
      results.push({ questId: q.id, questName: q.name, skipped: "already-claimed" });
      continue;
    }
    const rec = await farmQuest(session, q.id, solverFn, { log });
    results.push(rec);
    if (!rec.ok && /solver|captcha|rqdata|HCaptcha/i.test(String(rec.error || ""))) {
      log("solver appears broken — halting batch");
      break;
    }
    await sleep(2000); // breath between quests
  }
  return results;
}

module.exports = {
  defaultFingerprint,
  discordHeaders,
  listLiveQuests,
  enrollQuest,
  completeTask,
  completeVideoTask,
  completePlayTask,
  claimReward,
  farmQuest,
  farmAllLiveQuests,
};
