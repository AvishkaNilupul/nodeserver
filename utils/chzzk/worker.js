// Per-account watch loop for the CHZZK drops farm. One worker per Naver login.
// Contract: docs/CHZZK-FARM.md §9 (+ §15, v2). Keeps a Naver session "watching"
// one stream's HTTP heartbeat until the campaign's code rewards are earned,
// then picks the next campaign. Never sends a logged-in call once a login is
// seen to be out — AUTH ends the session so the farm can mark the account.
//
// "Earned" is decided by utils/chzzk/progress.js from BOTH challenges() and
// claims(): a reward missing from challenges() alone proves nothing (CHZZK
// leaves a campaign out of that list until it credits the first minute).

const crypto = require("crypto");
const { isAuthError, isEgressError } = require("./errors");
const { isCampaignFarmable } = require("./normalize");
const { progressOf } = require("./progress");

const DEFAULTS = {
  heartbeatMs: 30_000,         // WATCH_CONTINUED cadence
  statusMs: 30_000,            // live-status before each beat (fresh tokens; close detect), as the probe did
  challengesMs: 180_000,       // progress read + "crediting?" check
  idlePollMs: 60_000,          // sleep while nothing is farmable
  egressWaitMs: 30_000,        // back off when the tunnel is unreachable
  streamBackoffMs: 30 * 60_000, // a bad stream rests this long
  campaignBackoffMs: 30 * 60_000, // three bad streams in a row
  noStreamBackoffMs: 10 * 60_000, // no usable live stream at all: look again sooner
  precheckMs: 10 * 60_000,     // reuse a campaign's progress read this long
  noCreditReads: 3,            // consecutive flat reads = not crediting
  badStreamsPerCampaign: 3,    // strike-out threshold
  tickMs: 1000,                // inner loop pacing
};

const LEFT_WHY = {
  "no-credit": "CHZZK did not credit any minutes",
  closed: "the stream ended or stopped counting for this campaign",
  unread: "CHZZK's progress lists did not answer",
};

class AbortError extends Error {
  constructor() { super("aborted"); this.name = "AbortError"; }
}

function nowOf(clock) { return clock && clock.now ? clock.now() : Date.now(); }

async function sleep(ms, signal, clock) {
  if (signal && signal.aborted) throw new AbortError();
  if (clock && clock.sleep) return clock.sleep(ms, signal);
  await new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    if (!signal) return;
    const onAbort = () => { clearTimeout(t); rej(new AbortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isBackedOff(map, key, now) {
  const until = map.get(key);
  return typeof until === "number" && until > now;
}

const hasFirstCome = (c) => (c.rewards || []).some((r) => r.rewardType === "CODE_FIRST_COME");
const mins = (ms) => Math.max(0, Math.round(ms / 60_000));

/**
 * runSession({ account, client, campaigns, pickStream, onEvent, onProgress,
 *              onEarned, onLog, signal, clock, timings })
 *
 * - account   : ChzzkAccount doc; the worker reads `_id` (or `id`) and `nickname`.
 * - client    : §6 client.
 * - campaigns : { list(), campaign(no), markFarmed(accountId, no, info), isDone(accountId, no) }
 *               info = { minutes, states } — markFarmed means VERIFIED done.
 * - pickStream(camp, account, { avoid }) -> { channelId, channelName? } | null
 *   avoid = Set of channelIds this worker has resting; the farm skips them.
 * - onEvent(current) — current = { state, campaignNo, title, channelId,
 *   channelName, since, minutes, needed, watched, credited, note }.
 * - onProgress({ campaignNo, minutes, states, done, next }) — once per read.
 * - onEarned(account) — a reward newly finished; the farm runs the collector.
 * - onLog({ level, kind, campaignNo, msg }) — one plain sentence per decision.
 * - signal / clock / timings — abort, injectable time, DEFAULTS overrides.
 *
 * Returns { reason: "abort" | "auth", at }.
 */
async function runSession(opts) {
  const {
    account, client, campaigns, pickStream,
    onEvent, onProgress, onEarned, onLog,
    signal, clock, timings,
  } = opts || {};

  if (!account || !client || !campaigns || typeof pickStream !== "function") {
    throw new Error(
      "runSession: missing required opts (account, client, campaigns, pickStream)"
    );
  }

  const T = { ...DEFAULTS, ...(timings || {}) };
  const streamBad = new Map();         // channelId -> until epoch
  const campaignBad = new Map();       // campaignNo -> until epoch
  const campaignBadStreak = new Map(); // campaignNo -> consecutive strikes
  const lastRead = new Map();          // campaignNo -> { at, prog }
  const seenMax = new Map();           // campaignNo -> most minutes seen in a real read
  const unknownLogged = new Set();     // "rewardNo|status" already logged
  const finishedHere = new Set();      // campaigns finished this session (guards a store that ignores markFarmed)

  const accountId = account._id || account.id;

  try {
    while (!signal || !signal.aborted) {
      const camp = await pickCampaign();
      if (!camp) {
        safeEmit({ state: "idle", note: "no farmable campaign" });
        await sleep(T.idlePollMs, signal, clock);
        continue;
      }

      const pre = await precheck(camp);
      if (pre === "egress") continue;
      if (pre && pre.done) {
        finish(camp, pre, "already");
        continue;
      }

      const stream = await selectStream(camp);
      if (!stream) {
        bumpCampaignBad(camp, "no live stream to watch", T.noStreamBackoffMs);
        continue;
      }

      const outcome = await watchStream(camp, stream, pre);
      if (outcome === "auth") return { reason: "auth", at: nowOf(clock) };
      if (outcome === "abort") return { reason: "abort", at: nowOf(clock) };
    }
    return { reason: "abort", at: nowOf(clock) };
  } catch (e) {
    if (e instanceof AbortError) return { reason: "abort", at: nowOf(clock) };
    if (isAuthError(e)) return { reason: "auth", at: nowOf(clock) };
    throw e;
  }

  async function pickCampaign() {
    const now = nowOf(clock);
    let list;
    try { list = await campaigns.list(); } catch (_e) { return null; }

    const pool = (list || [])
      .filter((c) => c && c.enabled !== false)
      .filter((c) => !c.needsLink)
      .filter((c) => isCampaignFarmable(c, now))
      .filter((c) => !finishedHere.has(Number(c.campaignNo)) && !isDone(c.campaignNo))
      .filter((c) => !isBackedOff(campaignBad, c.campaignNo, now));

    // Soonest end first; on a tie a guaranteed code beats a lottery.
    pool.sort((a, b) => {
      const ea = +new Date(a.endAt || 0) || Infinity;
      const eb = +new Date(b.endAt || 0) || Infinity;
      if (ea !== eb) return ea - eb;
      return Number(hasFirstCome(b)) - Number(hasFirstCome(a));
    });

    return pool[0] || null;
  }

  function isDone(no) {
    try { return !!campaigns.isDone(accountId, no); } catch (_e) { return false; }
  }

  // Reads both lists for one campaign. Throws AUTH; EGRESS/TIMEOUT -> "egress".
  async function readProgress(camp) {
    const ch = await client.challenges();
    const cl = await client.claims();
    const prog = progressOf(camp, ch, cl, { floorMinutes: seenMax.get(camp.campaignNo) || 0 });
    if (prog.listed) seenMax.set(camp.campaignNo, prog.minutes);
    lastRead.set(camp.campaignNo, { at: nowOf(clock), prog });
    for (const u of prog.unknown) {
      const k = u.rewardNo + "|" + u.status;
      if (unknownLogged.has(k)) continue;
      unknownLogged.add(k);
      log("warn", "progress", camp, `CHZZK shows reward ${u.rewardNo} of "${camp.title}" as "${u.status}" — not counted as earned`);
    }
    return prog;
  }

  async function precheck(camp) {
    const memo = lastRead.get(camp.campaignNo);
    if (memo && nowOf(clock) - memo.at < T.precheckMs) return memo.prog;
    try {
      return await readProgress(camp);
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (isEgressError(e)) {
        safeEmit({ state: "waiting", campaignNo: camp.campaignNo, title: camp.title, note: "egress" });
        await sleep(T.egressWaitMs, signal, clock);
        return "egress";
      }
      return null; // unknown answer: watch anyway, the in-stream reads decide
    }
  }

  function finish(camp, prog, how) {
    finishedHere.add(Number(camp.campaignNo));
    try {
      if (campaigns.markFarmed) {
        campaigns.markFarmed(accountId, camp.campaignNo, { minutes: prog.minutes, states: prog.states });
      }
    } catch (_e) { /* swallow */ }
    try {
      if (onProgress) onProgress({ campaignNo: camp.campaignNo, minutes: prog.minutes, states: prog.states, done: true, next: null });
    } catch (_e) { /* swallow */ }
    log("info", "farm", camp, how === "already"
      ? `"${camp.title}": every code reward was already earned on this login — skipped`
      : `Finished "${camp.title}": every code reward earned (${prog.minutes} min credited)`);
  }

  async function selectStream(camp) {
    const now = nowOf(clock);
    let s;
    const avoid = new Set();
    for (const [id, until] of streamBad) if (until > now) avoid.add(id);
    try {
      s = await pickStream(camp, account, { avoid });
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (isEgressError(e)) {
        safeEmit({ state: "waiting", campaignNo: camp.campaignNo, title: camp.title, note: "egress" });
        await sleep(T.egressWaitMs, signal, clock);
      }
      return null;
    }
    if (!s || isBackedOff(streamBad, s.channelId, now)) return null;
    return s;
  }

  async function watchStream(camp, stream, pre) {
    const channelId = stream.channelId;
    const channelName = stream.channelName || "";

    let detail, status;
    try {
      detail = await client.liveDetail(channelId);
      status = await client.liveStatus(channelId);
    } catch (e) {
      if (isAuthError(e)) return "auth";
      if (isEgressError(e)) {
        await sleep(T.egressWaitMs, signal, clock);
        return "egress";
      }
      markStreamBad(channelId);
      bumpCampaignBad(camp, "a stream did not answer");
      return "retry";
    }

    const streamOk =
      status && status.status === "OPEN" &&
      Number(status.dropsCampaignNo) === Number(camp.campaignNo) &&
      !status.krOnly && !status.blindType;
    if (!streamOk) {
      markStreamBad(channelId);
      bumpCampaignBad(camp, "streams were closed, Korea-only or on another campaign");
      return "retry";
    }

    const liveId = detail && detail.liveId;
    const openAt = (+new Date(detail && detail.openAt)) || nowOf(clock);
    let liveTokens = Array.isArray(status.liveTokens) ? status.liveTokens : [];
    const sessionId = crypto.randomUUID();
    const since = nowOf(clock);
    const sessionStart = since;
    const base = pre && typeof pre === "object" ? pre : null;
    const startMinutes = base ? base.minutes : 0;
    let lastMinutes = startMinutes;
    let lastFinished = base ? base.finished : 0;
    let needed = base ? base.next : null;
    let noCreditStreak = 0;
    let exit = null;

    const view = (minutes, note) => ({
      state: "watching",
      campaignNo: camp.campaignNo, title: camp.title,
      channelId, channelName, since, minutes,
      needed, watched: mins(nowOf(clock) - sessionStart),
      credited: Math.max(0, minutes - startMinutes), note: note || "",
    });

    safeEmit(view(startMinutes));
    log("info", "watch", camp, `Watching ${channelName || channelId} for "${camp.title}" (${startMinutes}${needed ? "/" + needed : ""} min)`);

    const started = await beat("WATCH_STARTED", { channelId, liveId, sessionId, openAt, awt: 0, liveTokens });
    if (started === "auth") return "auth";
    if (started === "egress") {
      markStreamBad(channelId);
      return "egress";
    }

    let lastBeat = nowOf(clock);
    let lastStatus = lastBeat;
    let lastChallenges = lastBeat;

    while (!exit && (!signal || !signal.aborted)) {
      try { await sleep(T.tickMs, signal, clock); }
      catch (e) { if (e instanceof AbortError) { exit = "abort"; break; } throw e; }

      const t = nowOf(clock);

      if (t - lastStatus >= T.statusMs) {
        lastStatus = t;
        try {
          const s = await client.liveStatus(channelId);
          if (!s || s.status !== "OPEN" ||
              Number(s.dropsCampaignNo) !== Number(camp.campaignNo) ||
              s.krOnly || s.blindType) {
            exit = "closed"; break;
          }
          if (Array.isArray(s.liveTokens) && s.liveTokens.length) liveTokens = s.liveTokens;
        } catch (e) {
          if (isAuthError(e)) { exit = "auth"; break; }
          if (isEgressError(e)) { if (!(await pause(T.egressWaitMs))) { exit = "abort"; break; } continue; }
        }
      }

      if (t - lastBeat >= T.heartbeatMs) {
        const awt = Math.max(0, Math.round((t - sessionStart) / 1000));
        const res = await beat("WATCH_CONTINUED", { channelId, liveId, sessionId, openAt, awt, liveTokens });
        lastBeat = t;
        if (res === "auth") { exit = "auth"; break; }
        if (res === "egress") { if (!(await pause(T.egressWaitMs))) { exit = "abort"; break; } continue; }
      }

      if (t - lastChallenges >= T.challengesMs) {
        lastChallenges = t;
        let prog;
        try {
          let camp2 = camp;
          try { camp2 = (await campaigns.campaign(camp.campaignNo)) || camp; } catch (_e) { camp2 = camp; }
          prog = await readProgress({ ...camp, rewards: camp2.rewards || camp.rewards });
        } catch (e) {
          if (isAuthError(e)) { exit = "auth"; break; }
          if (isEgressError(e)) { if (!(await pause(T.egressWaitMs))) { exit = "abort"; break; } continue; }
          // Any other failure counts as a flat read, so a list that keeps
          // failing cannot keep this stream forever.
          noCreditStreak++;
          if (noCreditStreak >= T.noCreditReads) { exit = "unread"; break; }
          continue;
        }

        const grew = prog.minutes > lastMinutes || prog.finished > lastFinished;
        const earnedMore = prog.finished > lastFinished;
        needed = prog.next;
        lastMinutes = Math.max(lastMinutes, prog.minutes);
        lastFinished = Math.max(lastFinished, prog.finished);
        noCreditStreak = grew ? 0 : noCreditStreak + 1;
        if (grew) campaignBadStreak.set(camp.campaignNo, 0); // strikes count in a row

        safeEmit(view(prog.minutes, noCreditStreak ? "no new minutes yet" : ""));
        try {
          if (onProgress) onProgress({ campaignNo: camp.campaignNo, minutes: prog.minutes, states: prog.states, done: prog.done, next: prog.next });
        } catch (_e) { /* swallow */ }
        if (earnedMore) {
          try { if (onEarned) await onEarned(account); } catch (_e) { /* swallow */ }
        }

        if (prog.done) {
          finish(camp, prog, "watched");
          exit = "campaign-done"; break;
        }
        if (noCreditStreak >= T.noCreditReads) { exit = "no-credit"; break; }
      }
    }

    // WATCH_ENDED — always, best-effort.
    try {
      const t = nowOf(clock);
      await client.watchEvent({
        channelId, liveId, type: "WATCH_ENDED", sessionId,
        positionAt: Math.max(0, Math.round((t - openAt) / 1000)),
        awt: Math.max(0, Math.round((t - sessionStart) / 1000)),
        liveTokens,
      });
    } catch (_e) { /* swallow */ }

    if (exit === "abort") return "abort";
    if (exit === "auth") return "auth";
    if (LEFT_WHY[exit]) {
      const watched = mins(nowOf(clock) - sessionStart);
      log(exit === "no-credit" ? "warn" : "info", "watch", camp,
        `Left ${channelName || channelId} after ${watched} min: ${LEFT_WHY[exit]} (${Math.max(0, lastMinutes - startMinutes)} min credited)`);
      markStreamBad(channelId);
      if (exit === "no-credit") bumpCampaignBad(camp, "streams did not credit minutes");
      if (exit === "unread") bumpCampaignBad(camp, "CHZZK's progress lists did not answer");
    }
    return "retry";
  }

  // A wait inside a stream: false when the session was stopped meanwhile, so
  // the caller can still send WATCH_ENDED instead of throwing out of the loop.
  async function pause(ms) {
    try { await sleep(ms, signal, clock); return true; }
    catch (e) { if (e instanceof AbortError) return false; throw e; }
  }

  async function beat(type, { channelId, liveId, sessionId, openAt, awt, liveTokens }) {
    const t = nowOf(clock);
    try {
      await client.watchEvent({
        channelId, liveId, type, sessionId,
        positionAt: Math.max(0, Math.round((t - openAt) / 1000)),
        awt,
        liveTokens,
      });
      return "ok";
    } catch (e) {
      if (isAuthError(e)) return "auth";
      if (isEgressError(e)) return "egress";
      return "ok"; // transient — the next tick retries
    }
  }

  function markStreamBad(id) {
    streamBad.set(id, nowOf(clock) + T.streamBackoffMs);
  }

  function bumpCampaignBad(camp, why, restMs = T.campaignBackoffMs) {
    const no = camp.campaignNo;
    const streak = (campaignBadStreak.get(no) || 0) + 1;
    campaignBadStreak.set(no, streak);
    if (streak >= T.badStreamsPerCampaign) {
      campaignBad.set(no, nowOf(clock) + restMs);
      campaignBadStreak.set(no, 0);
      log("info", "farm", camp, `Resting "${camp.title}" for ${mins(restMs)} min: ${why}`);
    }
  }

  function log(level, kind, camp, msg) {
    if (!onLog) return;
    try { onLog({ level, kind, campaignNo: camp ? camp.campaignNo : undefined, msg }); } catch (_e) { /* swallow */ }
  }

  function safeEmit(current) {
    if (!onEvent) return;
    try { onEvent(current); } catch (_e) { /* swallow */ }
  }
}

module.exports = { runSession, DEFAULTS, AbortError };
