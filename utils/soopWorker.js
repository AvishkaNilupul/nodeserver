// One SOOP account's farm loop. utils/soopFarm.js runs many of these inside a
// single Node process (docs/SOOP-FARM-CONTRACT.md §10).
//
// The loop is: choose a campaign -> check it is not already finished -> hold the
// bridge socket on a live channel -> watch the mission counter. Every wait is
// interruptible through `signal`, so a stop takes effect at once, and every
// decision is reported through `onEvent` as a plain sentence the panel can show.
const { isAuthError, isEgressError } = require("./soop/errors");

const DEFAULT_TIMINGS = {
  pollMs: 60000, // how often the mission counter is read while farming
  idleMs: 60000, // wait between looks when there is nothing to farm
  retryMs: 30000, // after a socket drop / stream end
  joinWaitMs: 10000,
  flatPolls: 3, // polls with no new minute before "not crediting"
  backoffMs: [120000, 300000, 600000, 900000],
  readFailures: 5, // unreadable counters in a row before rejoining
};

// Resolves after `ms`, or immediately once `signal` aborts.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal) signal.addEventListener("abort", done, { once: true });
  });
}

// Which channel of a campaign was last really on air, shared by every session
// in the process so N accounts do not each re-probe every channel.
const channelMemo = new Map();
const MEMO_NONE_MS = 90000;

const goalOf = (camp, target) => {
  const steps = camp.steps || [];
  if (!steps.length) return null;
  return target === "first" ? steps[0] : steps[steps.length - 1];
};

async function pickChannel(client, camp, now) {
  const key = String(camp.dropsIdx);
  const memo = channelMemo.get(key);
  if (memo && memo.noneAt && now() - memo.noneAt < MEMO_NONE_MS) return null;

  let order;
  if (camp.categoryWide) {
    order = await client.categoryChannels(camp.cateNo, 5);
  } else {
    const list = camp.channels || [];
    order = [
      ...(memo && memo.bj ? [memo.bj] : []),
      ...list.filter((c) => c.onAir).map((c) => c.id),
      ...list.map((c) => c.id),
    ];
  }
  // The on-air flags go stale on remembered campaigns, so every candidate is
  // checked for real before a socket is opened on it.
  for (const bj of [...new Set(order)].slice(0, 12)) {
    const info = await client.liveInfo(bj).catch(() => null);
    if (info && info.RESULT === 1) {
      channelMemo.set(key, { bj, at: now() });
      return bj;
    }
  }
  channelMemo.set(key, { noneAt: now() });
  return null;
}

// opts: { id, getClient, plan, campaigns, resolveCampaign, progress, onEvent,
//         signal, clock, timings }
//   plan: { mode: "campaign"|"game"|"auto", dropsIdx, gameNo, target, codesOnly }
//   campaigns(): shared list of listed, normalised campaigns
//   resolveCampaign(dropsIdx): a campaign that left the list, or null
//   progress: { get(dropsIdx) -> { max, done } | null, set(dropsIdx, patch) }
// Resolves with { reason: "stopped" | "finished" | "ended" | "auth" | "error" }.
async function runSession(opts) {
  const {
    id,
    getClient,
    plan,
    campaigns,
    resolveCampaign = async () => null,
    progress,
    onEvent = () => {},
    signal,
  } = opts;
  const clock = { now: Date.now, sleep, ...(opts.clock || {}) };
  const T = { ...DEFAULT_TIMINGS, ...(opts.timings || {}) };
  const stopped = () => !!(signal && signal.aborted);
  const emit = (o) => onEvent({ id, at: new Date(clock.now()), ...o });
  const wait = (ms) => clock.sleep(ms, signal);
  const end = (reason, detail) => {
    emit({ k: "end", reason, detail: detail || "" });
    return { reason };
  };
  const isDone = (camp) => {
    const p = progress.get(camp.dropsIdx);
    const goal = goalOf(camp, plan.target);
    return !!(p && (p.done || (goal != null && (Number(p.max) || 0) >= goal)));
  };

  // One read of the account's mission counters at start: the panel can show
  // what it already has while it waits, and a dead login is caught before any
  // socket is opened. Anything but a dead login is ignored here.
  async function prime(client) {
    try {
      for (const m of await client.missions()) {
        const prev = progress.get(m.dropsIdx) || {};
        const minutes = Number(m.minutes) || 0;
        progress.set(m.dropsIdx, { minutes, max: Math.max(Number(prev.max) || 0, minutes) });
      }
    } catch (e) {
      if (isAuthError(e)) return e;
    }
    return null;
  }
  const wanted = (c) =>
    (!plan.codesOnly || !c.needsLink) && (c.steps || []).length > 0;

  // -> { camp, channel } | { wait: detail, startAt? } | { finished } | { ended }
  async function choose(client) {
    const listed = await campaigns();
    let pool;
    if (plan.mode === "campaign") {
      const key = String(plan.dropsIdx);
      const hit =
        listed.find((c) => String(c.dropsIdx) === key) ||
        (await resolveCampaign(key));
      if (!hit) return { wait: `Campaign ${key} is not listed by SOOP yet` };
      if (isDone(hit)) return { finished: true };
      if (hit.endAt && new Date(hit.endAt).getTime() < clock.now()) {
        return { ended: true };
      }
      pool = [hit];
    } else {
      pool = listed.filter(
        (c) =>
          c.guaranteed &&
          wanted(c) &&
          (plan.mode === "auto" || String(c.gameNo) === String(plan.gameNo)),
      );
      pool = pool.filter((c) => !isDone(c));
      if (!pool.length) {
        return { wait: "Nothing to farm right now — waiting for the next campaign" };
      }
    }

    // A campaign that left SOOP's list has no trustworthy live flag: try it.
    const live = pool
      .filter((c) => c.live || c.filter === "unlisted")
      .sort(
        (a, b) =>
          (a.endAt ? new Date(a.endAt).getTime() : Infinity) -
          (b.endAt ? new Date(b.endAt).getTime() : Infinity),
      );
    if (!live.length) {
      const next = pool
        .filter((c) => c.startAt && new Date(c.startAt).getTime() > clock.now())
        .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))[0];
      const first = next || pool[0];
      return {
        wait: next
          ? "Campaign has not started yet"
          : "Campaign is not live right now — waiting for the next broadcast",
        camp: first,
        startAt: next ? next.startAt : null,
      };
    }
    for (const camp of live) {
      const channel = await pickChannel(client, camp, clock.now).catch(() => null);
      if (channel) return { camp, channel };
    }
    return { wait: "Campaign is live but no channel is on air yet", camp: live[0] };
  }

  // Holds the bridge on one channel and watches the counter.
  // -> { done } | { auth } | { egress } | { notCrediting } | { retry }
  async function farm(client, camp, channel) {
    const goal = goalOf(camp, plan.target);
    const base = { dropsIdx: camp.dropsIdx, title: camp.title, channel, goal };
    const readMinutes = async () => {
      const row = (await client.missions()).find(
        (m) => String(m.dropsIdx) === String(camp.dropsIdx),
      );
      return row ? Number(row.minutes) || 0 : 0;
    };
    const record = (minutes) => {
      const prev = progress.get(camp.dropsIdx) || {};
      const max = Math.max(Number(prev.max) || 0, minutes);
      const done = goal != null && max >= goal;
      progress.set(camp.dropsIdx, { minutes, max, goal, done, title: camp.title });
      return { max, done };
    };

    // Already finished? Then never open a socket for it.
    let last = 0;
    try {
      last = await readMinutes();
    } catch (e) {
      if (isAuthError(e)) return { auth: e.message };
      if (isEgressError(e)) return { egress: e.message };
      return { retry: "could not read progress: " + e.message };
    }
    if (record(last).done) return { done: true, minutes: last, goal };
    if (stopped()) return { retry: "stopped" };

    let ch = await client.liveInfo(channel).catch(() => null);
    if (!ch || ch.RESULT !== 1) return { retry: "the stream went off air" };
    ch = (await client.liveInfo(channel, String(ch.BNO)).catch(() => null)) || ch;

    emit({ k: "state", state: "starting", detail: "Joining " + channel, ...base, minutes: last });
    const bridge = client.openBridge(channel, ch, {});
    try {
      const deadline = clock.now() + T.joinWaitMs;
      while (!bridge.joined && !bridge.closed && !stopped() && clock.now() < deadline) {
        await wait(250);
      }
      if (stopped()) return { retry: "stopped" };
      if (!bridge.joined) {
        if (bridge.error === "geo" || bridge.error === "egress") {
          return { egress: "could not confirm the egress country" };
        }
        return { retry: "the viewer socket did not join" };
      }

      let credited = null;
      let everCredited = false;
      let flat = 0;
      let unreadable = 0;
      const crossed = new Set((camp.steps || []).filter((s) => s <= last));
      emit({ k: "state", state: "farming", detail: "Watching " + channel, ...base, minutes: last, credited });

      while (!stopped()) {
        await wait(T.pollMs);
        if (stopped()) break;
        let mins;
        try {
          mins = await readMinutes();
          unreadable = 0;
        } catch (e) {
          if (isAuthError(e)) return { auth: e.message };
          if (++unreadable >= T.readFailures) {
            return isEgressError(e)
              ? { egress: e.message }
              : { retry: "progress unreadable: " + e.message };
          }
          continue;
        }
        if (mins > last) {
          credited = true;
          everCredited = true;
          flat = 0;
        } else if (mins === last) {
          flat++;
        } else {
          flat = 0; // the counter restarts when the broadcast changes
        }
        last = mins;
        const { done } = record(mins);
        for (const s of camp.steps || []) {
          if (mins >= s && !crossed.has(s)) {
            crossed.add(s);
            emit({ k: "step", ...base, minutes: mins, step: s });
          }
        }
        if (flat >= T.flatPolls) credited = false;
        emit({ k: "state", state: "farming", detail: "Watching " + channel, ...base, minutes: mins, credited });
        if (done) return { done: true, minutes: mins, goal };
        if (bridge.closed) return { retry: "the viewer socket closed" };
        if (flat >= T.flatPolls) {
          return { notCrediting: true, minutes: mins, everCredited };
        }
      }
      return { retry: "stopped" };
    } finally {
      bridge.stop();
    }
  }

  let backoff = 0;
  let primed = false;
  while (!stopped()) {
    let client;
    try {
      client = getClient();
      if (!client) throw new Error("account is not loaded");
    } catch (e) {
      emit({ k: "error", msg: e.message });
      return end("error", e.message);
    }
    if (!primed) {
      primed = true;
      const dead = await prime(client);
      if (dead) return end("auth", dead.message);
      if (stopped()) break;
    }

    let pick;
    try {
      pick = await choose(client);
    } catch (e) {
      if (isAuthError(e)) return end("auth", e.message);
      emit({
        k: "state",
        state: "waiting",
        detail: isEgressError(e)
          ? "Cannot reach SOOP (egress is down) — retrying"
          : "Could not read the campaign list — retrying",
        error: e.message,
      });
      await wait(T.idleMs);
      continue;
    }
    if (pick.finished) return end("finished");
    if (pick.ended) return end("ended", "The campaign ended before the goal was reached");
    if (pick.wait) {
      emit({
        k: "state",
        state: "waiting",
        detail: pick.wait,
        dropsIdx: pick.camp ? pick.camp.dropsIdx : null,
        title: pick.camp ? pick.camp.title : null,
        goal: pick.camp ? goalOf(pick.camp, plan.target) : null,
        startAt: pick.startAt || null,
      });
      await wait(T.idleMs);
      continue;
    }

    const { camp, channel } = pick;
    const out = await farm(client, camp, channel);
    if (stopped()) break;
    if (out.auth) return end("auth", out.auth);
    if (out.done) {
      backoff = 0;
      emit({ k: "campaign-done", dropsIdx: camp.dropsIdx, title: camp.title, minutes: out.minutes, goal: out.goal });
      if (plan.mode === "campaign") return end("finished");
      continue;
    }
    const ref = { dropsIdx: camp.dropsIdx, title: camp.title, channel, goal: goalOf(camp, plan.target) };
    if (out.notCrediting) {
      // Minutes were flowing and then stopped: most likely the broadcast ended,
      // so start the back-off from the short end again.
      if (out.everCredited) backoff = 0;
      const ms = T.backoffMs[Math.min(backoff++, T.backoffMs.length - 1)];
      emit({
        k: "state",
        state: "backoff",
        detail: `Joined, but SOOP is not counting minutes — retrying in ${Math.round(ms / 60000)} min`,
        ...ref,
        minutes: out.minutes,
        credited: false,
      });
      await wait(ms);
      continue;
    }
    if (out.egress) {
      emit({ k: "state", state: "waiting", detail: "Egress problem — " + out.egress, ...ref, error: out.egress });
      await wait(T.idleMs);
      continue;
    }
    emit({ k: "state", state: "waiting", detail: "Rejoining — " + out.retry, ...ref });
    await wait(T.retryMs);
  }
  return end("stopped");
}

module.exports = { runSession, sleep, goalOf, pickChannel, DEFAULT_TIMINGS, channelMemo };
