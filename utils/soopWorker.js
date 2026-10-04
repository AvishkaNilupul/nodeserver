// One SOOP account's farm loop. utils/soopFarm.js runs many of these inside a
// single Node process. Ported from _soop-probe/worker.js (verified live).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stepsOf = (e) =>
  [
    ...new Set(e.itemList.map((i) => Number(i.giveTerm)).filter((n) => n > 0)),
  ].sort((a, b) => a - b);

// Shared across sessions in this process: which channel of a campaign was last
// actually live, so N accounts don't each re-probe every channel.
const channelMemo = new Map();

// opts: { id, getClient, drops, target, campaigns, resolveCampaign, onEvent, health }
//   getClient(): a soopClient for this account (throws if it no longer exists)
//   campaigns(): shared live+offline campaign list (account-independent)
//   resolveCampaign(dropsIdx): last-seen record for a campaign that dropped out
//   health: { stopped: bool, stop() }
async function runSession(opts) {
  const {
    id,
    getClient,
    drops = "auto",
    target = "all",
    campaigns,
    resolveCampaign,
    onEvent = () => {},
    health,
  } = opts;
  const emit = (o) => onEvent({ id, t: new Date().toISOString(), ...o });
  let c;
  try {
    c = getClient();
  } catch (e) {
    emit({ k: "error", msg: "cookie: " + e.message });
    return emit({ k: "done", reason: "error" });
  }

  const oldStop = health.stop;
  let bridge = null;
  health.stop = () => {
    if (bridge) {
      try {
        bridge.stop();
      } catch {
        // best-effort teardown; the session is being stopped anyway
      }
    }
    oldStop.call(health);
  };

  const pickChannel = async (e) => {
    if (!(e.broadIdList || []).length && e.cateNo) {
      return c.categoryChannel(e.cateNo); // category-wide campaign
    }

    // Candidates in order: last known live channel, channels flagged on air,
    // then the rest. The flags go stale on remembered campaigns, so every
    // candidate is verified for real.
    const list = e.broadIdList || [];
    const key = String(e.dropsIdx);
    const memo = channelMemo.get(key);
    // Someone checked recently and nothing was live — don't re-probe every
    // channel for every account.
    if (memo && memo.noneAt && Date.now() - memo.noneAt < 90000) return null;
    const order = [];
    if (memo && memo.bj) order.push(memo.bj);
    order.push(...list.filter((b) => b.onAir).map((b) => b.userId));
    order.push(...list.map((b) => b.userId));
    for (const bj of [...new Set(order)].slice(0, 12)) {
      const info = await c.liveInfo(bj).catch(() => null);
      if (info && info.RESULT === 1) {
        channelMemo.set(key, { bj, at: Date.now() });
        return bj;
      }
    }
    channelMemo.set(key, { noneAt: Date.now() });
    return null;
  };

  const minutesFor = async (dropsIdx) => {
    const row = (await c.missions().catch(() => [])).find(
      (d) => String(d.dropsIdx) === String(dropsIdx),
    );
    return row
      ? Math.max(0, ...row.itemList.map((i) => Number(i.viewTime)))
      : 0;
  };

  // { camp } farm now · { waiting } campaign exists but no stream ·
  // { remembered } dropped out of the list but seen recently · { none } unknown.
  const pick = async () => {
    const terms = (await campaigns()).filter((e) => e.giveCon === "term");
    const mine =
      drops === "auto"
        ? terms
        : terms.filter((e) => String(e.dropsIdx) === String(drops));
    const live = mine.filter((e) => e.live);
    if (live.length) return { camp: live[0] };
    if (mine.length) return { waiting: mine[0] };
    if (drops !== "auto" && resolveCampaign) {
      const rec = await resolveCampaign(drops);
      if (rec) return { remembered: rec };
    }
    return { none: true };
  };

  // Holds the bridge on one channel and watches the counter until the goal is reached.
  async function farmChannel(camp, bj) {
    const steps = stepsOf(camp);
    const goal = target === "first" ? steps[0] : steps[steps.length - 1];
    let ch = await c.liveInfo(bj).catch(() => null);
    if (!ch || ch.RESULT !== 1) {
      emit({
        k: "waiting",
        dropsIdx: camp.dropsIdx,
        title: camp.title,
        state: "no stream on air",
        msg: "waiting for a streamer to come online",
      });
      return { stalled: true, mins: 0, goal };
    }
    ch = await c.liveInfo(bj, String(ch.BNO)).catch(() => null);
    if (!ch) return { stalled: true, mins: 0, goal };
    bridge = c.openBridge(bj, ch, {
      onEvent: (ev) => emit({ k: "socket", ev }),
    });
    for (let i = 0; i < 20 && !bridge.joined && !health.stopped; i++) {
      await sleep(500);
    }
    if (!bridge.joined) {
      emit({ k: "error", msg: "bridge did not join; retry in 60s" });
      bridge.stop();
      bridge = null;
      return { stalled: true, mins: 0, goal };
    }

    let mins = 0;
    let last = -1;
    let flat = 0;
    while (!health.stopped) {
      await sleep(30000);
      try {
        mins = await minutesFor(camp.dropsIdx);
      } catch (e) {
        emit({ k: "error", msg: "mission read: " + e.message });
      }
      emit({
        k: "progress",
        dropsIdx: camp.dropsIdx,
        title: camp.title,
        channel: bj,
        minutes: mins,
        target: goal,
      });
      if (mins >= goal) break;
      // Two polls with no credit means it is not paying (drops off / delisted)
      // — stop burning the socket.
      flat = mins === last ? flat + 1 : 0;
      last = mins;
      if (flat >= 2) {
        emit({
          k: "waiting",
          dropsIdx: camp.dropsIdx,
          title: camp.title,
          state: "not crediting watch time",
          msg: "waiting for a streamer to come online",
        });
        break;
      }
      if (bridge.closed) {
        emit({ k: "status", msg: "socket closed; rejoining" });
        break;
      }
      const still = (await campaigns().catch(() => [])).find(
        (e) => String(e.dropsIdx) === String(camp.dropsIdx) && e.live,
      );
      if (!still && !resolveCampaign) {
        emit({ k: "status", msg: "campaign no longer live" });
        break;
      }
    }
    bridge.stop();
    bridge = null;
    return { stalled: mins < goal, mins, goal };
  }

  while (!health.stopped) {
    let sel;
    try {
      sel = await pick();
    } catch (e) {
      emit({ k: "error", msg: "campaign scan: " + e.message });
      await sleep(60000);
      continue;
    }

    if (sel.waiting) {
      const w = sel.waiting;
      emit({
        k: "waiting",
        dropsIdx: w.dropsIdx,
        title: w.title,
        state:
          w.filter === "scheduled" ? "not started yet" : "no stream on air",
        startsAt: w.startDate || null,
        msg: "waiting for a streamer to come online",
      });
      await sleep(60000);
      continue;
    }
    if (sel.none) {
      emit({
        k: "status",
        msg:
          drops === "auto"
            ? "no live guaranteed campaign; waiting"
            : `campaign ${drops} is not listed right now; waiting`,
      });
      await sleep(60000);
      continue;
    }
    if (sel.remembered) {
      const r = sel.remembered;
      const bj = await pickChannel(r).catch(() => null);
      if (!bj) {
        emit({
          k: "waiting",
          dropsIdx: r.dropsIdx,
          title: r.title,
          state: "no stream live yet",
          msg: "waiting for a streamer to come online",
        });
        await sleep(60000);
        continue;
      }
      const steps = stepsOf(r);
      emit({
        k: "campaign",
        dropsIdx: r.dropsIdx,
        title: r.title,
        steps,
        target: target === "first" ? steps[0] : steps.slice(-1)[0],
        delisted: true,
      });
      await farmChannel(r, bj);
      await sleep(60000);
      continue;
    }

    const camp = sel.camp;
    const bj = await pickChannel(camp).catch(() => null);
    if (!bj) {
      emit({
        k: "waiting",
        dropsIdx: camp.dropsIdx,
        title: camp.title,
        state: "live, no streamer on air",
        msg: "waiting for a streamer to come online",
      });
      await sleep(60000);
      continue;
    }
    const steps = stepsOf(camp);
    emit({
      k: "campaign",
      dropsIdx: camp.dropsIdx,
      title: camp.title,
      steps,
      target: target === "first" ? steps[0] : steps.slice(-1)[0],
      categoryWide: !camp.broadIdList.length,
    });
    const out = await farmChannel(camp, bj);
    if (out.mins >= out.goal) {
      return emit({
        k: "done",
        reason: "target",
        dropsIdx: camp.dropsIdx,
        minutes: out.mins,
        target: out.goal,
      });
    }
    await sleep(30000);
  }
  emit({ k: "done", reason: "stopped" });
}

module.exports = { runSession, sleep, stepsOf };
