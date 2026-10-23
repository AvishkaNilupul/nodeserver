// Per-account watch loop for the CHZZK drops farm. One worker per Naver login.
// Contract: docs/CHZZK-FARM.md §9. Keeps a Naver session "watching" one
// stream's HTTP heartbeat until the campaign's rewards all claim, then picks
// the next campaign. Never sends a logged-in call once a login is seen to be
// out — AUTH ends the session so the farm can mark the account.

const crypto = require("crypto");
const { isAuthError, isEgressError } = require("./errors");
const { isFarmableReward, isCampaignFarmable } = require("./normalize");

const DEFAULTS = {
  heartbeatMs: 30_000,         // WATCH_CONTINUED cadence
  statusMs: 60_000,            // live-status refresh (new tokens; close detect)
  challengesMs: 180_000,       // my-progress read + "crediting?" check
  idlePollMs: 60_000,          // sleep while nothing is farmable
  egressWaitMs: 30_000,        // back off when the tunnel is unreachable
  streamBackoffMs: 30 * 60_000, // 30 min — a bad stream rests this long
  campaignBackoffMs: 30 * 60_000, // 30 min — three bad streams in a row
  noCreditReads: 3,            // consecutive flat challenges = not crediting
  badStreamsPerCampaign: 3,    // strike-out threshold
  tickMs: 1000,                // inner loop pacing
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

/**
 * runSession({ account, client, campaigns, pickStream, onEvent, onProgress,
 *              onEarned, signal, clock, timings })
 *
 * - account   : ChzzkAccount doc; the worker reads `_id` (or `id`) and `nickname`.
 * - client    : §6 client (userStatus / liveDetail / liveStatus / watchEvent /
 *               challenges / claims / couponCode / egressCountry).
 * - campaigns : { list(): [camp], campaign(no): camp, markFarmed(accountId, no),
 *                 isDone(accountId, no) } — camp shape per §5 normalize + the
 *                 model's { enabled, source, lastSeenAt, refreshedAt, rewards }.
 * - pickStream(camp, account) -> { channelId, channelName? } | null (shared memo
 *   lives in the farm; §9 wants top 5 by viewers spread across accounts).
 * - onEvent({state, campaignNo, title, channelId, channelName, since, minutes, note})
 *   — the account's `current` view; emitted on every state change.
 * - onProgress({campaignNo, rewardNo, minutes, done}) — per-reward progress on
 *   each challenges() read.
 * - onEarned(account) — hint for the farm to run the codes collector.
 * - signal : AbortSignal — ends the session.
 * - clock  : { now(), sleep(ms, signal) } — injectable for tests.
 * - timings: shallow overrides of DEFAULTS.
 *
 * Returns { reason: "abort" | "auth" | "end", at }.
 */
async function runSession(opts) {
  const {
    account, client, campaigns, pickStream,
    onEvent, onProgress, onEarned,
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

  const accountId = account._id || account.id;

  try {
    while (!signal || !signal.aborted) {
      const camp = await pickCampaign();
      if (!camp) {
        safeEmit({ state: "idle", note: "no farmable campaign" });
        await sleep(T.idlePollMs, signal, clock);
        continue;
      }

      const stream = await selectStream(camp);
      if (!stream) {
        bumpCampaignBad(camp.campaignNo);
        continue;
      }

      const outcome = await watchStream(camp, stream);
      if (outcome === "auth") return { reason: "auth", at: nowOf(clock) };
      if (outcome === "abort") return { reason: "abort", at: nowOf(clock) };
      // "retry" / "egress" / "closed" / "campaign-done" fall through to next loop.
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
      .filter((c) => !isDone(c.campaignNo))
      .filter((c) => !isBackedOff(campaignBad, c.campaignNo, now));

    pool.sort((a, b) => {
      const ea = +new Date(a.endAt || 0) || Infinity;
      const eb = +new Date(b.endAt || 0) || Infinity;
      return ea - eb;
    });

    return pool[0] || null;
  }

  function isDone(no) {
    try { return !!campaigns.isDone(accountId, no); } catch (_e) { return false; }
  }

  async function selectStream(camp) {
    const now = nowOf(clock);
    let s;
    try {
      s = await pickStream(camp, account);
    } catch (e) {
      if (isAuthError(e)) throw e;
      if (isEgressError(e)) {
        safeEmit({
          state: "waiting",
          campaignNo: camp.campaignNo, title: camp.title,
          note: "egress",
        });
        await sleep(T.egressWaitMs, signal, clock);
        return null;
      }
      return null;
    }
    if (!s || isBackedOff(streamBad, s.channelId, now)) return null;
    return s;
  }

  async function watchStream(camp, stream) {
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
      bumpCampaignBad(camp.campaignNo);
      return "retry";
    }

    const streamOk =
      status && status.status === "OPEN" &&
      status.dropsCampaignNo === camp.campaignNo &&
      !status.krOnly && !status.blindType;
    if (!streamOk) {
      markStreamBad(channelId);
      bumpCampaignBad(camp.campaignNo);
      return "retry";
    }

    const liveId = detail && detail.liveId;
    const openAt = (+new Date(detail && detail.openAt)) || nowOf(clock);
    let liveTokens = Array.isArray(status.liveTokens) ? status.liveTokens : [];
    const sessionId = crypto.randomUUID();
    const since = nowOf(clock);
    const sessionStart = since;

    safeEmit({
      state: "watching",
      campaignNo: camp.campaignNo, title: camp.title,
      channelId, channelName, since, minutes: 0, note: "",
    });

    const started = await beat("WATCH_STARTED", {
      channelId, liveId, sessionId, openAt,
      awt: 0, liveTokens, sessionStart,
    });
    if (started === "auth") return "auth";
    // On start egress, drop the stream and let the outer loop retry — the
    // tunnel is probably down and the next pick will decide to wait.
    if (started === "egress") {
      markStreamBad(channelId);
      return "egress";
    }

    let lastBeat = nowOf(clock);
    let lastStatus = lastBeat;
    let lastChallenges = lastBeat;
    // Session-scoped progress trackers. `maxMinutesEver` only grows (so an
    // in-progress reward hitting its minutes and dropping off the challenges
    // list cannot roll it back to 0). `earnedRewardNos` collects every
    // farmable reward of this campaign we have reason to believe is claimed
    // on CHZZK — either absent from challenges() entirely (claimed in a
    // previous session or just moved to claims) or still shown but with
    // accumWatchMinutes past conditionForMinutes.
    let maxMinutesEver = 0;
    const earnedRewardNos = new Set();
    let lastEarnedCount = 0;
    let noCreditStreak = 0;
    let exit = null;

    while (!exit && (!signal || !signal.aborted)) {
      try { await sleep(T.tickMs, signal, clock); }
      catch (e) { if (e instanceof AbortError) { exit = "abort"; break; } throw e; }

      const t = nowOf(clock);

      if (t - lastStatus >= T.statusMs) {
        lastStatus = t;
        try {
          const s = await client.liveStatus(channelId);
          if (!s || s.status !== "OPEN" ||
              s.dropsCampaignNo !== camp.campaignNo ||
              s.krOnly || s.blindType) {
            exit = "closed"; break;
          }
          if (Array.isArray(s.liveTokens) && s.liveTokens.length) {
            liveTokens = s.liveTokens;
          }
        } catch (e) {
          if (isAuthError(e)) { exit = "auth"; break; }
          if (isEgressError(e)) { await sleep(T.egressWaitMs, signal, clock); continue; }
          // transient — swallow, next tick retries
        }
      }

      if (t - lastBeat >= T.heartbeatMs) {
        const awt = Math.max(0, Math.round((t - sessionStart) / 1000));
        const res = await beat("WATCH_CONTINUED", {
          channelId, liveId, sessionId, openAt, awt, liveTokens, sessionStart,
        });
        lastBeat = t;
        if (res === "auth") { exit = "auth"; break; }
        if (res === "egress") {
          await sleep(T.egressWaitMs, signal, clock);
          continue;
        }
      }

      if (t - lastChallenges >= T.challengesMs) {
        lastChallenges = t;
        try {
          const chList = await client.challenges();
          const forCamp = (chList || []).filter(
            (c) => c && c.campaignNo === camp.campaignNo
          );
          const currentForCampNos = new Set(forCamp.map((r) => r.rewardNo));

          // Any farmable reward NOT in the challenges list is either already
          // claimed (previous session or just now) or absent for a reason we
          // can't farm against — treat as earned so campDone can fire and
          // bump maxMinutesEver to its known conditionForMinutes.
          for (const r of (camp.rewards || [])) {
            if (!isFarmableReward(r)) continue;
            if (!currentForCampNos.has(r.rewardNo)) {
              earnedRewardNos.add(r.rewardNo);
              if (typeof r.minutes === "number") {
                maxMinutesEver = Math.max(maxMinutesEver, r.minutes);
              }
            }
          }
          // A reward whose accumWatchMinutes passed its condition is earned
          // even while it still shows in the challenges list.
          for (const r of forCamp) {
            if ((r.accumWatchMinutes || 0) >= (r.conditionForMinutes || 0)) {
              earnedRewardNos.add(r.rewardNo);
            }
          }

          const currentMax = forCamp.reduce(
            (m, r) => Math.max(m, r.accumWatchMinutes || 0), 0
          );
          const newMax = Math.max(maxMinutesEver, currentMax);
          const grew = newMax > maxMinutesEver || earnedRewardNos.size > lastEarnedCount;
          maxMinutesEver = newMax;
          const minutes = maxMinutesEver;

          safeEmit({
            state: "watching",
            campaignNo: camp.campaignNo, title: camp.title,
            channelId, channelName, since, minutes, note: "",
          });

          if (earnedRewardNos.size > lastEarnedCount) {
            try { if (onEarned) await onEarned(account); } catch (_e) { /* swallow */ }
          }

          if (!grew) noCreditStreak++;
          else noCreditStreak = 0;
          lastEarnedCount = earnedRewardNos.size;

          let camp2 = camp;
          try { camp2 = (await campaigns.campaign(camp.campaignNo)) || camp; }
          catch (_e) { camp2 = camp; }
          const rewards = (camp2.rewards || []).filter(isFarmableReward);

          for (const r of rewards) {
            try {
              if (onProgress) await onProgress({
                campaignNo: camp.campaignNo,
                rewardNo: r.rewardNo,
                minutes,
                done: earnedRewardNos.has(r.rewardNo) || minutes >= (r.minutes || 0),
              });
            } catch (_e) { /* swallow */ }
          }

          // Done when every farmable reward of this campaign is in our
          // earned set. Resists the "earned reward dropped out of the list"
          // case the old `rewards.every(minutes >= r.minutes)` could not.
          const campDone =
            rewards.length > 0 &&
            rewards.every((r) => earnedRewardNos.has(r.rewardNo));
          if (campDone) {
            try { if (campaigns.markFarmed) campaigns.markFarmed(accountId, camp.campaignNo); }
            catch (_e) { /* swallow */ }
            exit = "campaign-done"; break;
          }

          if (noCreditStreak >= T.noCreditReads) {
            exit = "no-credit"; break;
          }
        } catch (e) {
          if (isAuthError(e)) { exit = "auth"; break; }
          if (isEgressError(e)) { await sleep(T.egressWaitMs, signal, clock); continue; }
          // transient — swallow
        }
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
    if (exit === "no-credit") {
      markStreamBad(channelId);
      bumpCampaignBad(camp.campaignNo);
      return "retry";
    }
    if (exit === "closed") {
      markStreamBad(channelId);
      // A closed stream is not a credit problem — don't strike the campaign.
      return "retry";
    }
    // "campaign-done" and anything else: move on.
    return "retry";
  }

  async function beat(type, { channelId, liveId, sessionId, openAt, awt, liveTokens, sessionStart }) {
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
      // Non-auth, non-egress — treat as transient so the next tick retries.
      return "ok";
    }
  }

  function markStreamBad(id) {
    streamBad.set(id, nowOf(clock) + T.streamBackoffMs);
  }

  function bumpCampaignBad(no) {
    const streak = (campaignBadStreak.get(no) || 0) + 1;
    campaignBadStreak.set(no, streak);
    if (streak >= T.badStreamsPerCampaign) {
      campaignBad.set(no, nowOf(clock) + T.campaignBackoffMs);
      campaignBadStreak.set(no, 0);
    }
  }

  function safeEmit(current) {
    if (!onEvent) return;
    try { onEvent(current); } catch (_e) { /* swallow */ }
  }
}

module.exports = { runSession, DEFAULTS, AbortError };
