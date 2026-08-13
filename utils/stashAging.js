// Account aging: give a freshly-made Twitch account a plausible history before
// it goes to work, instead of handing a bot (or a buyer) an account that was
// created five minutes ago and has never done anything.
//
// The ladder, one rung per account, driven forward by the tick loop below:
//
//   new    -> has a token at all?           -> verify   (else paused)
//   verify -> live-check passes?            -> settle   (else dead)
//   settle -> policy.settleDays of nothing  -> warmup
//   warmup -> WARMUP_SESSIONS short watches -> active
//   active -> gates satisfied?              -> mature
//   mature -> policy.autoGraduate?          -> Account Pool
//
// Scheduling is entirely per-account: every row carries its own jittered
// `aging.nextEligibleAt`, and the runner's only question each tick is "who is
// due". Nothing iterates a set, nothing runs in lockstep, and a thousand
// accounts spread themselves across the week for free.
//
// Three properties this deliberately preserves:
//   - It is off unless a set opts in. A set with aging.enabled false is never
//     queried, never touched, and behaves exactly as it did before this file
//     existed.
//   - It never writes a bot config, never touches the Drops Archive, and never
//     deletes an account. The only way a row leaves the stash is through
//     utils/stashPromote.js — the same helper the manual button calls.
//   - It never posts into a channel. Sessions are viewing telemetry; the only
//     other outbound action is following a channel the account actually
//     watched, capped by policy.followTarget.
const mongoose = require("mongoose");

const StashSet = require("../models/StashSet");
const StashAccount = require("../models/StashAccount");
const StashAgingLog = require("../models/StashAgingLog");
const twitchWatch = require("./twitchWatch");
const twitchFollow = require("./twitchFollow");
const stashChecker = require("./stashChecker");
const { promoteAccounts } = require("./stashPromote");
const hosts = require("./botHosts");
const { decrypt } = require("./secretBox");

// How often we look for due accounts. Sessions last tens of minutes, so a
// minute of scheduling granularity is far finer than anything here needs.
const TICK_MS = Number(process.env.STASH_AGING_TICK_MS) || 60 * 1000;

// Let the rest of boot settle before the first sweep — the other runners all
// start at once and there is nothing time-critical here.
const FIRST_TICK_DELAY_MS = 45 * 1000;

// Ceiling across every set. Each live session is a handful of HTTP calls per
// minute, so this is about bounding concurrent connections (and, on the Pi,
// concurrent SSH channels) rather than CPU.
const MAX_GLOBAL_CONCURRENT =
  Number(process.env.STASH_AGING_MAX_CONCURRENT) || 8;

// Short watches before an account is trusted with full-length ones.
const WARMUP_SESSIONS = 3;

// Consecutive failures before an account is parked for a human to look at.
const MAX_STRIKES = 5;

// Buffer added to the longest possible session when leasing an account, so a
// lease can never expire under a session that is still legitimately running.
const LEASE_BUFFER_MS = 15 * 60 * 1000;

// Upper bound on claims per tick. Bookkeeping rungs finish instantly and give
// their slot straight back, so without a budget one tick could loop for
// minutes draining a large set. Anything left over is simply picked up next
// tick — the ladder is measured in days, so this costs nothing.
const MAX_CLAIMS_PER_TICK = 40;

// Stages the tick loop will pick up. `mature` is included because an account
// with autoGraduate on still needs one more visit to be promoted.
const DUE_STAGES = ["new", "verify", "settle", "warmup", "active", "mature"];

let timer = null;
let ticking = false;
let started = false;
let stopped = false;

// accountId -> live session detail, for the "what's happening right now" panel.
// In-memory only: this is a view of work in flight, and work in flight does not
// survive a restart (the lease expires and the account is simply retried).
//
// Only populated once an account is genuinely watching, so it is NOT what the
// concurrency caps read — `inFlight` is. The two differ for the seconds an
// account spends resolving taste and liveness, and using liveSessions for the
// cap would let the tick loop over-claim during exactly that window.
const liveSessions = new Map();

// accountId -> setId, for every account the runner currently owns, from the
// moment it is claimed to the moment its lease is released.
const inFlight = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms, frac) {
  const f = Math.max(0, Math.min(1, frac == null ? 0.35 : frac));
  const lo = ms * (1 - f);
  const hi = ms * (1 + f);
  return Math.round(lo + Math.random() * (hi - lo));
}

function randInt(lo, hi) {
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function pickRandom(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Best-effort decrypt, same contract as the follow runner: secretBox.decrypt
// returns its input for a plaintext value that isn't a sealed envelope, so
// calling it unconditionally is safe either way.
function readToken(acc) {
  const raw = acc.clientSecret || "";
  if (!raw) return "";
  try {
    return decrypt(raw);
  } catch {
    return raw;
  }
}

async function logEvent(acc, setId, fields) {
  try {
    await StashAgingLog.create({
      accountId: acc._id,
      setId,
      username: acc.username || "",
      ...fields,
    });
  } catch (err) {
    // History is nice to have; never let it break a session.
    console.error("[stashAging] log write failed:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

function policyOf(set) {
  const p = (set && set.aging) || {};
  return {
    enabled: !!p.enabled,
    settleDays: p.settleDays ?? 2,
    minDays: p.minDays ?? 14,
    minSessions: p.minSessions ?? 10,
    minWatchMinutes: p.minWatchMinutes ?? 240,
    sessionsPerWeek: p.sessionsPerWeek ?? 5,
    minSessionMinutes: p.minSessionMinutes ?? 15,
    maxSessionMinutes: p.maxSessionMinutes ?? 45,
    tasteSize: p.tasteSize ?? 4,
    followTarget: p.followTarget ?? 3,
    avoidDropChannels: p.avoidDropChannels !== false,
    channelPool: Array.isArray(p.channelPool) ? p.channelPool : [],
    hostIds: Array.isArray(p.hostIds) ? p.hostIds : [],
    maxConcurrent: p.maxConcurrent ?? 3,
    autoGraduate: !!p.autoGraduate,
    dryRun: p.dryRun !== false,
  };
}

// Gap until this account's next session. sessionsPerWeek sets the average; the
// jitter is wide (±45%) and there's a one-in-six chance of an extra idle day,
// because a perfectly regular cadence is its own tell across a fleet.
function nextSessionGap(policy) {
  const base = (7 * DAY_MS) / Math.max(1, policy.sessionsPerWeek);
  let gap = jitter(base, 0.45);
  if (Math.random() < 0.17) gap += jitter(DAY_MS, 0.5);
  // Never schedule closer than 20 minutes out, whatever the arithmetic says.
  return Math.max(20 * 60 * 1000, gap);
}

function sessionMinutes(policy, stage) {
  const lo = Math.max(1, policy.minSessionMinutes);
  const hi = Math.max(lo, policy.maxSessionMinutes);
  if (stage === "warmup") {
    // Warm-up sessions sit in the bottom of the range — a brand-new account
    // binge-watching for an hour is not the shape we want to establish.
    return randInt(lo, Math.max(lo, Math.round(lo + (hi - lo) * 0.4)));
  }
  return randInt(lo, hi);
}

function isMature(acc, policy) {
  const ageDays = (Date.now() - new Date(acc.createdAt).getTime()) / DAY_MS;
  const a = acc.aging || {};
  return (
    ageDays >= policy.minDays &&
    (a.sessions || 0) >= policy.minSessions &&
    (a.watchMinutes || 0) >= policy.minWatchMinutes
  );
}

// What's still missing before this account can mature — drives the UI's
// "why isn't this one ready" line.
function maturityGaps(acc, policy) {
  const ageDays = (Date.now() - new Date(acc.createdAt).getTime()) / DAY_MS;
  const a = acc.aging || {};
  return {
    days: Math.max(0, Math.ceil(policy.minDays - ageDays)),
    sessions: Math.max(0, policy.minSessions - (a.sessions || 0)),
    minutes: Math.max(0, policy.minWatchMinutes - (a.watchMinutes || 0)),
  };
}

// Which host does this account egress from? Empty hostIds means local only —
// deliberately not "every host", so switching aging on can never quietly add
// load to the Pi without the operator choosing it.
function pickHost(policy) {
  if (!policy.hostIds.length) return hosts.resolveHost("local");
  const id = pickRandom(policy.hostIds);
  return hosts.resolveHost(id) || hosts.resolveHost("local");
}

// ---------------------------------------------------------------------------
// Channel selection
// ---------------------------------------------------------------------------

// Directory results are shared across accounts for a few minutes so a set
// starting twenty sessions doesn't fire twenty identical directory queries.
let directoryCache = { at: 0, channels: [], dropGames: new Set() };
const DIRECTORY_TTL_MS = 5 * 60 * 1000;

async function refreshDirectory(token, host, policy) {
  if (Date.now() - directoryCache.at < DIRECTORY_TTL_MS && directoryCache.channels.length) {
    return directoryCache;
  }
  const channels = await twitchWatch.discoverChannels(token, { host, limit: 80 });
  const dropGames = policy.avoidDropChannels
    ? await twitchWatch.activeDropGames(token, { host })
    : new Set();
  directoryCache = { at: Date.now(), channels, dropGames };
  return directoryCache;
}

// Top up an account's taste list to policy.tasteSize.
//
// A stable handful of channels per account is the point: it makes each
// account's history read like a person with a few haunts, where uniform-random
// draws across a fleet this size would be a fingerprint in their own right.
async function ensureTaste(acc, policy, token, host) {
  const taste = Array.isArray(acc.aging?.taste) ? acc.aging.taste.slice() : [];
  if (taste.length >= policy.tasteSize) return taste;

  // A hand-pinned pool wins outright — the operator asked for these channels.
  if (policy.channelPool.length) {
    for (const c of policy.channelPool) {
      const login = String(c || "").toLowerCase().trim();
      if (login && !taste.includes(login)) taste.push(login);
      if (taste.length >= policy.tasteSize) break;
    }
    return taste;
  }

  const { channels, dropGames } = await refreshDirectory(token, host, policy);
  // Shuffle so two accounts topping up from the same cached directory don't
  // both take the top entries.
  const shuffled = channels.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  for (const ch of shuffled) {
    if (taste.length >= policy.tasteSize) break;
    if (taste.includes(ch.login)) continue;
    // The single most important filter here: a session on a drop-enabled
    // channel produces history indistinguishable from what the farm already
    // generates, so it costs requests and buys nothing.
    if (policy.avoidDropChannels && ch.game && dropGames.has(ch.game.toLowerCase())) continue;
    taste.push(ch.login);
  }
  return taste;
}

// Choose a live channel from the account's taste, checking liveness rather than
// assuming it. Returns { login, refreshedTaste } — the taste list may come back
// with a dead slot swapped out.
async function pickLiveChannel(taste, policy, token, host) {
  const order = taste.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  for (const login of order) {
    try {
      const info = await twitchWatch.getStreamInfo(token, login, { host });
      if (info.live) return { login: info.login, taste };
    } catch (e) {
      if (e.code === "token_invalid" || e.code === "integrity_failed") throw e;
      // channel_not_found / transient — fall through and try the next one.
    }
  }

  // Everyone in the taste list is offline. Pull one live replacement from the
  // directory and rotate out the least recently useful slot (the first one).
  const { channels, dropGames } = await refreshDirectory(token, host, policy);
  for (const ch of channels) {
    if (taste.includes(ch.login)) continue;
    if (policy.avoidDropChannels && ch.game && dropGames.has(ch.game.toLowerCase())) continue;
    const next = taste.slice(1).concat([ch.login]);
    return { login: ch.login, taste: next };
  }
  return { login: "", taste };
}

// ---------------------------------------------------------------------------
// Stage handlers
// ---------------------------------------------------------------------------

async function setStage(acc, setId, toStage, message, extra) {
  const from = acc.aging?.stage || "new";
  acc.aging.stage = toStage;
  if (extra) Object.assign(acc.aging, extra);
  await acc.save();
  if (from !== toStage) {
    await logEvent(acc, setId, {
      kind: "stage",
      fromStage: from,
      toStage,
      message: message || from + " → " + toStage,
    });
  }
}

// new -> verify (or paused, when there's nothing to verify with)
async function handleNew(acc, set, _policy) {
  if (!acc.clientSecret) {
    await setStage(
      acc,
      set._id,
      "paused",
      "No auth token stored — mint one with the token fetcher, then resume",
      { lastError: "No auth token stored for this account", nextEligibleAt: null },
    );
    return;
  }
  await setStage(acc, set._id, "verify", "Token present — queued for verification", {
    nextEligibleAt: new Date(),
    startedAt: acc.aging.startedAt || new Date(),
  });
}

// verify -> settle (or dead). Uses the stash's own checker so the verdict here
// and the verdict from a manual Scan are the same verdict.
async function handleVerify(acc, set, policy) {
  if (policy.dryRun) {
    const ms = Math.max(0, policy.settleDays) * DAY_MS;
    await setStage(acc, set._id, "settle", "Dry run — verification skipped", {
      nextEligibleAt: new Date(Date.now() + (ms > 0 ? jitter(ms, 0.3) : 60 * 1000)),
    });
    return;
  }
  let ok = false;
  try {
    ok = await stashChecker.checkOne(acc);
  } catch (err) {
    acc.aging.strikes = (acc.aging.strikes || 0) + 1;
    acc.aging.lastError = (err.message || String(err)).slice(0, 300);
    acc.aging.nextEligibleAt = new Date(Date.now() + jitter(6 * 60 * 60 * 1000, 0.3));
    await acc.save();
    await logEvent(acc, set._id, {
      kind: "error",
      ok: false,
      message: "Verification error: " + acc.aging.lastError,
    });
    return;
  }

  await logEvent(acc, set._id, {
    kind: "verify",
    ok,
    message: ok
      ? "Live-check passed — token authenticates"
      : "Live-check failed: " + (acc.lastCheckStatus || "unknown"),
  });

  if (!ok) {
    // token_invalid / integrity_failed are terminal for aging: there is nothing
    // to age. A transient 'error' is not — retry it later instead.
    if (acc.lastCheckStatus === "error") {
      acc.aging.strikes = (acc.aging.strikes || 0) + 1;
      acc.aging.nextEligibleAt = new Date(Date.now() + jitter(6 * 60 * 60 * 1000, 0.3));
      await acc.save();
      return;
    }
    await setStage(acc, set._id, "dead", "Token rejected by Twitch — excluded from aging", {
      nextEligibleAt: null,
    });
    return;
  }

  // settleDays 0 means "don't settle" — come back on the next tick. It must NOT
  // fall through to a default the way an unset value would; `settleMs || 1h`
  // read an explicit zero as "unset" and sat on the account for an hour.
  const settleMs = Math.max(0, policy.settleDays) * DAY_MS;
  const settleWait = settleMs > 0 ? jitter(settleMs, 0.2) : 60 * 1000;
  await setStage(
    acc,
    set._id,
    "settle",
    settleMs > 0
      ? "Settling for " + policy.settleDays + " day(s) before first session"
      : "No settle window configured — first session next tick",
    { strikes: 0, lastError: "", nextEligibleAt: new Date(Date.now() + settleWait) },
  );
}

// settle -> warmup. Being due IS the transition; there's no work to do.
async function handleSettle(acc, set, _policy) {
  await setStage(acc, set._id, "warmup", "Settled — starting warm-up sessions", {
    nextEligibleAt: new Date(Date.now() + jitter(30 * 60 * 1000, 0.6)),
  });
}

// The working stages: run one session, bank it, decide what's next.
async function handleSession(acc, set, policy) {
  const stage = acc.aging.stage;
  const host = pickHost(policy);
  const minutes = sessionMinutes(policy, stage);
  const token = readToken(acc);

  if (!token) {
    await setStage(acc, set._id, "paused", "Token disappeared — paused", {
      lastError: "No auth token stored for this account",
      nextEligibleAt: null,
    });
    return;
  }

  // ---- dry run: plan the session, write the timeline, fire nothing.
  if (policy.dryRun) {
    const planned = pickRandom(acc.aging.taste) || pickRandom(policy.channelPool) || "(directory pick)";
    acc.aging.sessions = (acc.aging.sessions || 0) + 1;
    acc.aging.watchMinutes = (acc.aging.watchMinutes || 0) + minutes;
    acc.aging.lastSessionAt = new Date();
    acc.aging.lastChannel = planned;
    acc.aging.lastSessionKind = "dry";
    acc.aging.nextEligibleAt = new Date(Date.now() + nextSessionGap(policy));
    await acc.save();
    await logEvent(acc, set._id, {
      kind: "session",
      dryRun: true,
      channel: planned,
      minutes,
      host: host ? host.id : "local",
      kindDetail: "dry",
      message: "DRY RUN — would watch " + planned + " for " + minutes + "m",
    });
    await maybeAdvanceAfterSession(acc, set, policy);
    return;
  }

  // ---- taste + channel
  let taste;
  let channel = "";
  try {
    taste = await ensureTaste(acc, policy, token, host);
    const picked = await pickLiveChannel(taste, policy, token, host);
    channel = picked.login;
    taste = picked.taste;
  } catch (err) {
    return recordSessionFailure(acc, set, policy, err);
  }

  if (!taste.length || !channel) {
    // Nothing live to watch right now. Not a failure of the account — try again
    // in a while without burning a strike.
    acc.aging.taste = taste;
    acc.aging.nextEligibleAt = new Date(Date.now() + jitter(90 * 60 * 1000, 0.4));
    await acc.save();
    await logEvent(acc, set._id, {
      kind: "session",
      ok: false,
      host: host ? host.id : "local",
      message: "No live channel available — retrying later",
    });
    return;
  }

  acc.aging.taste = taste;
  await acc.save();

  // ---- the session itself
  const live = {
    accountId: String(acc._id),
    setId: String(set._id),
    username: acc.username,
    stage,
    channel,
    host: host ? host.id : "local",
    minutesTarget: minutes,
    minutesDone: 0,
    startedAt: Date.now(),
  };
  liveSessions.set(String(acc._id), live);

  let result;
  try {
    result = await twitchWatch.watchSession(token, {
      channelLogin: channel,
      minutes,
      host,
      onProgress: (p) => {
        live.minutesDone = p.minute;
      },
    });
  } catch (err) {
    liveSessions.delete(String(acc._id));
    return recordSessionFailure(acc, set, policy, err);
  }
  liveSessions.delete(String(acc._id));

  if (result.kind === "offline") {
    acc.aging.nextEligibleAt = new Date(Date.now() + jitter(60 * 60 * 1000, 0.5));
    await acc.save();
    await logEvent(acc, set._id, {
      kind: "session",
      ok: false,
      channel,
      host: live.host,
      message: channel + " went offline before the session started",
    });
    return;
  }

  // A session runs for tens of minutes, which is plenty of time for an
  // operator to hit Pause on this account. `acc` is a snapshot from before the
  // session, so without re-reading we would write our stage and schedule
  // straight back over their decision. Re-read, bank the minutes either way
  // (they really were watched), and respect an intervention.
  const fresh = await StashAccount.findById(acc._id).select("aging.stage").lean();
  const interrupted =
    fresh && (fresh.aging?.stage === "paused" || fresh.aging?.stage === "dead");

  acc.aging.sessions = (acc.aging.sessions || 0) + 1;
  acc.aging.watchMinutes = (acc.aging.watchMinutes || 0) + (result.minutesWatched || 0);
  acc.aging.lastSessionAt = new Date();
  acc.aging.lastChannel = result.channel || channel;
  acc.aging.lastSessionKind = result.kind;
  acc.aging.strikes = 0;
  acc.aging.lastError = "";
  if (interrupted) {
    acc.aging.stage = fresh.aging.stage;
    acc.aging.nextEligibleAt = null;
  } else {
    acc.aging.nextEligibleAt = new Date(Date.now() + nextSessionGap(policy));
  }
  await acc.save();

  await logEvent(acc, set._id, {
    kind: "session",
    ok: true,
    channel: result.channel || channel,
    minutes: result.minutesWatched || 0,
    host: live.host,
    kindDetail: result.kind,
    message:
      (result.kind === "watched" ? "Watched " : "Present on ") +
      (result.channel || channel) +
      " for " +
      (result.minutesWatched || 0) +
      "m" +
      (result.game ? " (" + result.game + ")" : "") +
      (result.stopped && result.stopped !== "completed" ? " — " + result.stopped : ""),
  });

  // An operator pause stops here: the session is banked and logged, but the
  // account doesn't follow anyone or climb another rung.
  if (interrupted) return;

  await maybeFollow(acc, set, policy, result.channel || channel, host, token);
  await maybeAdvanceAfterSession(acc, set, policy);
}

// Follow a channel this account actually watched. Watch-then-follow is a
// coherent history; follows floating free of any viewing are not. Rate is
// deliberately low — followTarget over the whole aging window, not per session.
async function maybeFollow(acc, set, policy, channelLogin, host, token) {
  if (policy.followTarget <= 0) return;
  if ((acc.aging.follows || 0) >= policy.followTarget) return;
  if (acc.aging.stage === "warmup") return; // warm-up watches only

  // Spread the remaining follows over the remaining sessions rather than
  // firing them all in the first week.
  const remainingSessions = Math.max(1, policy.minSessions - (acc.aging.sessions || 0));
  const remainingFollows = policy.followTarget - (acc.aging.follows || 0);
  if (Math.random() > remainingFollows / remainingSessions) return;

  try {
    const info = await twitchWatch.getStreamInfo(token, channelLogin, { host });
    if (!info.id) return;
    await twitchFollow.followChannel(token, info.id, {
      host,
      channelLogin: info.login,
      warmUp: true,
      randomizeNotifications: true,
    });
    acc.aging.follows = (acc.aging.follows || 0) + 1;
    await acc.save();
    await logEvent(acc, set._id, {
      kind: "follow",
      channel: info.login,
      host: host ? host.id : "local",
      message: "Followed " + info.login + " after watching",
    });
  } catch (err) {
    // A failed follow is not worth a strike — the session it rode on succeeded.
    await logEvent(acc, set._id, {
      kind: "follow",
      ok: false,
      channel: channelLogin,
      message: "Follow failed: " + (err.message || String(err)).slice(0, 160),
    });
  }
}

// warmup -> active -> mature, evaluated after every banked session.
async function maybeAdvanceAfterSession(acc, set, policy) {
  if (acc.aging.stage === "warmup" && (acc.aging.sessions || 0) >= WARMUP_SESSIONS) {
    await setStage(acc, set._id, "active", "Warm-up complete — normal sessions from here");
  }
  if (acc.aging.stage === "active" && isMature(acc, policy)) {
    await setStage(acc, set._id, "mature", "Aged enough — ready for the Account Pool", {
      maturedAt: new Date(),
      // Come back promptly so autoGraduate (if on) acts without a long wait.
      nextEligibleAt: new Date(Date.now() + 60 * 1000),
    });
  }
}

async function recordSessionFailure(acc, set, policy, err) {
  const msg = (err.message || String(err)).slice(0, 300);

  // A dead token ends aging outright — there's nothing left to age.
  if (err.code === "token_invalid" || err.code === "integrity_failed") {
    await setStage(acc, set._id, "dead", "Token rejected during a session — excluded", {
      lastError: msg,
      nextEligibleAt: null,
    });
    await logEvent(acc, set._id, { kind: "error", ok: false, message: msg });
    return;
  }

  // A host problem says nothing about the account. Retry soon, no strike.
  if (err.transportFailed) {
    acc.aging.nextEligibleAt = new Date(Date.now() + jitter(30 * 60 * 1000, 0.5));
    await acc.save();
    await logEvent(acc, set._id, {
      kind: "error",
      ok: false,
      message: "Egress host unavailable — retrying later (" + msg + ")",
    });
    return;
  }

  acc.aging.strikes = (acc.aging.strikes || 0) + 1;
  acc.aging.lastError = msg;
  if (acc.aging.strikes >= MAX_STRIKES) {
    await setStage(
      acc,
      set._id,
      "paused",
      "Paused after " + MAX_STRIKES + " failed sessions in a row",
      { nextEligibleAt: null },
    );
  } else {
    acc.aging.nextEligibleAt = new Date(Date.now() + jitter(2 * 60 * 60 * 1000, 0.4));
    await acc.save();
  }
  await logEvent(acc, set._id, { kind: "error", ok: false, message: msg });
}

// mature -> the Account Pool, through the same helper the manual button uses.
async function handleMature(acc, set, policy) {
  if (!policy.autoGraduate) {
    // Nothing more to do automatically. Park it: the operator moves it by hand.
    acc.aging.nextEligibleAt = null;
    await acc.save();
    return;
  }
  if (policy.dryRun) {
    acc.aging.nextEligibleAt = null;
    await acc.save();
    await logEvent(acc, set._id, {
      kind: "graduate",
      dryRun: true,
      message: "DRY RUN — would move to the Account Pool now",
    });
    return;
  }

  acc.aging.graduatedAt = new Date();
  await acc.save();

  try {
    const result = await promoteAccounts(set, [acc]);
    const placed = result.added + result.merged + result.alreadyInUseCount;
    await logEvent(acc, set._id, {
      kind: "graduate",
      ok: placed > 0,
      message: placed
        ? "Moved to the Account Pool after " +
          (acc.aging.sessions || 0) +
          " sessions / " +
          (acc.aging.watchMinutes || 0) +
          "m watched"
        : "Promotion produced no pool row — left in the stash",
    });
    if (!placed) {
      // Nothing was placed, so the row is still here. Don't spin on it.
      acc.aging.nextEligibleAt = new Date(Date.now() + 12 * 60 * 60 * 1000);
      await acc.save();
    }
  } catch (err) {
    acc.aging.graduatedAt = null;
    acc.aging.nextEligibleAt = new Date(Date.now() + 6 * 60 * 60 * 1000);
    await acc.save();
    await logEvent(acc, set._id, {
      kind: "graduate",
      ok: false,
      message: "Promotion failed: " + (err.message || String(err)).slice(0, 200),
    });
  }
}

// ---------------------------------------------------------------------------
// Tick loop
// ---------------------------------------------------------------------------

// Claim one due account from an enabled set, atomically. The lease is what
// makes this safe against overlapping ticks and against a restart landing
// mid-session: a crashed session's lease simply expires and the account
// becomes claimable again.
async function claimNext(setIds, leaseMs) {
  const now = new Date();
  return StashAccount.findOneAndUpdate(
    {
      setId: { $in: setIds },
      // `null` in the list is load-bearing: it makes $in match documents with
      // no `aging` subdocument at all. Every StashAccount that predates this
      // feature is in that state — Mongoose defaults apply when a document is
      // hydrated, never retroactively to what's already stored — and so is
      // anything inserted through a raw bulkWrite. Without this the runner
      // would silently ignore exactly the accounts it exists to age.
      "aging.stage": { $in: DUE_STAGES.concat([null]) },
      // Missing/null nextEligibleAt means "never scheduled" — due immediately.
      // $not/$gt covers null, missing and past dates in one predicate.
      "aging.nextEligibleAt": { $not: { $gt: now } },
      $or: [{ "aging.leaseUntil": null }, { "aging.leaseUntil": { $lt: now } }],
    },
    { $set: { "aging.leaseUntil": new Date(Date.now() + leaseMs) } },
    { new: true, sort: { "aging.nextEligibleAt": 1 } },
  );
}

async function releaseLease(accId) {
  try {
    await StashAccount.updateOne(
      { _id: accId },
      { $set: { "aging.leaseUntil": null } },
    );
  } catch {
    // The lease expires on its own; a failed release is not worth surfacing.
  }
}

async function processAccount(acc, set, policy) {
  // Belt and braces for rows that predate the aging schema: hydration should
  // fill this in from the subdocument default, but every handler writes to
  // acc.aging directly and none of them should have to check first.
  if (!acc.aging) acc.aging = {};
  const stage = acc.aging.stage || "new";
  switch (stage) {
    case "new":
      return handleNew(acc, set, policy);
    case "verify":
      return handleVerify(acc, set, policy);
    case "settle":
      return handleSettle(acc, set, policy);
    case "warmup":
    case "active":
      return handleSession(acc, set, policy);
    case "mature":
      return handleMature(acc, set, policy);
    default:
      // dead / paused are terminal until an operator acts.
      acc.aging.nextEligibleAt = null;
      await acc.save();
      return undefined;
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const sets = await StashSet.find({ "aging.enabled": true }).lean();
    if (!sets.length) return;

    const bySetId = new Map(sets.map((s) => [String(s._id), s]));
    const setIds = sets.map((s) => s._id);

    let claimsThisTick = 0;
    while (
      inFlight.size < MAX_GLOBAL_CONCURRENT &&
      claimsThisTick < MAX_CLAIMS_PER_TICK
    ) {
      // Per-set in-flight counts, recomputed from inFlight on EVERY iteration
      // rather than tracked in a local counter.
      //
      // This matters more than it looks. The caps exist to bound concurrent
      // watch SESSIONS — work that runs for tens of minutes. But most rungs of
      // the ladder are bookkeeping that finishes in milliseconds (new→verify,
      // settle→warmup). With a local counter those instant transitions held a
      // slot for the rest of the tick, so a set could only ever advance
      // maxConcurrent rows per minute no matter how trivial the work: a
      // 179-account set would take an hour just to walk everyone to `settle`.
      // Re-deriving from inFlight gives a finished handler its slot straight
      // back, so bookkeeping drains fast while real sessions still hold theirs.
      const perSet = new Map();
      for (const sid of inFlight.values()) {
        perSet.set(sid, (perSet.get(sid) || 0) + 1);
      }

      // Only consider sets with room left under their own cap.
      const roomySetIds = setIds.filter((id) => {
        const s = bySetId.get(String(id));
        const p = policyOf(s);
        return (perSet.get(String(id)) || 0) < p.maxConcurrent;
      });
      if (!roomySetIds.length) break;

      const maxSessionMin = Math.max(
        ...roomySetIds.map((id) => policyOf(bySetId.get(String(id))).maxSessionMinutes),
      );
      const leaseMs = maxSessionMin * 60 * 1000 + LEASE_BUFFER_MS;

      const acc = await claimNext(roomySetIds, leaseMs);
      if (!acc) break;

      const set = bySetId.get(String(acc.setId));
      if (!set) {
        await releaseLease(acc._id);
        continue;
      }
      const policy = policyOf(set);
      inFlight.set(String(acc._id), String(acc.setId));
      claimsThisTick++;

      // Fire and forget: a session runs for tens of minutes, so awaiting it
      // here would stall every other set. The lease is what keeps it exclusive.
      void (async () => {
        try {
          await processAccount(acc, set, policy);
        } catch (err) {
          console.error(
            "[stashAging] " + acc.username + " failed:",
            err.message,
          );
          try {
            await logEvent(acc, set._id, {
              kind: "error",
              ok: false,
              message: "Runner error: " + (err.message || String(err)).slice(0, 200),
            });
          } catch {
            // already logged to console
          }
        } finally {
          liveSessions.delete(String(acc._id));
          inFlight.delete(String(acc._id));
          await releaseLease(acc._id);
        }
      })();

      // Small stagger so twenty claims don't all open connections at once.
      await sleep(250);
    }
  } catch (err) {
    console.error("[stashAging] tick failed:", err.message);
  } finally {
    ticking = false;
  }
}

// Self-rescheduling timeout rather than an interval, matching the other
// runners in utils/ — and it means the next tick is only scheduled once the
// current one has finished, so a slow tick can never stack on itself.
function start() {
  if (started) return;
  if (mongoose.connection.readyState !== 1) {
    mongoose.connection.once("connected", () => start());
    return;
  }
  started = true;

  // Clear any lease stranded by an unclean shutdown so accounts mid-session
  // when the process died become claimable immediately rather than waiting out
  // a lease nobody is holding.
  StashAccount.updateMany(
    { "aging.leaseUntil": { $ne: null } },
    { $set: { "aging.leaseUntil": null } },
  ).catch(() => {});

  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      console.error("[stashAging] tick error:", err.message);
    }
    if (!stopped) {
      timer = setTimeout(loop, TICK_MS);
      if (timer.unref) timer.unref();
    }
  };
  timer = setTimeout(loop, FIRST_TICK_DELAY_MS);
  if (timer.unref) timer.unref();
  console.log("[stashAging] started (tick " + Math.round(TICK_MS / 1000) + "s)");
}

function stop() {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}

// Live view for the UI: what is running right now, across every set.
function liveStatus(setId) {
  const all = [...liveSessions.values()];
  const rows = setId ? all.filter((s) => s.setId === String(setId)) : all;
  const claimed = setId
    ? [...inFlight.values()].filter((sid) => sid === String(setId)).length
    : inFlight.size;
  return {
    running: rows.length,
    // Claimed but not yet watching — resolving taste / checking who's live.
    // Shown separately so a set that looks idle is distinguishable from one
    // that's mid-handshake.
    claimed,
    globalRunning: all.length,
    globalClaimed: inFlight.size,
    maxConcurrent: MAX_GLOBAL_CONCURRENT,
    sessions: rows.map((s) => ({
      accountId: s.accountId,
      username: s.username,
      stage: s.stage,
      channel: s.channel,
      host: s.host,
      minutesDone: s.minutesDone,
      minutesTarget: s.minutesTarget,
      elapsedMs: Date.now() - s.startedAt,
    })),
  };
}

// Run one account immediately, outside the schedule. This is the canary: point
// a real account at a real session and watch what comes back, instead of
// trusting that the pipeline works because nothing errored.
async function runNow(accountId) {
  const acc = await StashAccount.findById(accountId);
  if (!acc) throw new Error("Account not found");
  const set = await StashSet.findById(acc.setId).lean();
  if (!set) throw new Error("Set not found");
  const policy = policyOf(set);
  if (inFlight.has(String(acc._id))) {
    return { started: false, message: "That account already has a session running" };
  }
  acc.aging.nextEligibleAt = new Date();
  acc.aging.leaseUntil = new Date(Date.now() + policy.maxSessionMinutes * 60 * 1000 + LEASE_BUFFER_MS);
  await acc.save();
  inFlight.set(String(acc._id), String(acc.setId));

  void (async () => {
    try {
      await processAccount(acc, set, policy);
    } catch (err) {
      console.error("[stashAging] runNow failed:", err.message);
      await logEvent(acc, set._id, {
        kind: "error",
        ok: false,
        message: "Run-now failed: " + (err.message || String(err)).slice(0, 200),
      });
    } finally {
      liveSessions.delete(String(acc._id));
      inFlight.delete(String(acc._id));
      await releaseLease(acc._id);
    }
  })();

  return { started: true };
}

module.exports = {
  start,
  stop,
  tick,
  liveStatus,
  runNow,
  policyOf,
  isMature,
  maturityGaps,
  WARMUP_SESSIONS,
  MAX_STRIKES,
  MAX_GLOBAL_CONCURRENT,
};
