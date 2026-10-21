// One structural auto-farm operation at a time.
//
// "Structural" is anything that decides or changes WHICH accounts sit in WHICH
// bot across more than one file: placing a farm (pack into existing bots, then
// create the rest), re-arming a reused farm and topping it up, ending a
// campaign's task (trim shared bots, delete dedicated ones, recycle), reaping
// retired bots, the probe stop-loss, and the repack that moves accounts between
// containers and retires the donors.
//
// The legacy tick ran all of these one after another, so none ever saw another
// half-done. The lane engine (utils/farm2) places farms from its own cycle,
// two at a time, while that tick still does the janitor work — and the per-file
// lock (utils/fileLock) cannot make a step that spans files safe:
//   * a farm placed into a container the repack has already drained (the
//     donor is stopped, its accounts copied out, its config about to be
//     renamed away) is retired with it;
//   * a farm placed into the dedicated bot of a task that is being ended is
//     deleted with it;
//   * a reused farm re-armed in a donor mid-repack moves switched off.
// Each leaves accounts that their task counts as deployed and no bot farms —
// the state utils/armedAudit reports.
//
// So every such step runs through run(): one at a time, in arrival order.
// Nothing here is per-file and nothing here is held by the rent-farm, the
// no-claim farm or the admin routes — they keep to the per-file lock. Always
// taken OUTSIDE any file lock, never inside one.
//
// Re-entry: a step that calls another (executeReuse's top-up calls
// executeTask) runs it inline — by async context, like utils/fileLock. A step
// that had to wait is started by whichever step ended before it, so it is
// bound to its OWN caller's async context first: left to the starter's, it
// would see that caller's file locks as its own and walk into a config
// another writer holds.
//
// run() refuses a caller that holds a file lock (utils/fileLock): a step waits
// for the turn, the holder of the turn waits for files, and a caller doing
// both ways round is the one arrangement here that can never finish.
//
// Switch: autoFarm.farmOpsLock === false turns the turn-taking off live (no
// restart): every step then starts at once, as before 2026-10-11. For the day
// a holder is stuck and farms must be placed anyway; steps already waiting
// still wait for it.
//
// A step that cannot start within `waitMs` is NOT started: run() rejects with
// an error isBusy() recognises, and the caller retries on its own schedule (a
// lane job on its backoff, a janitor step on the next tick). Nothing is ever
// pre-empted: a holder runs to its end, and one that runs for HOLD_WARN_MS is
// reported once — a stuck holder means nothing is being placed.
const { AsyncLocalStorage, AsyncResource } = require("node:async_hooks");
const fileLock = require("./fileLock");

const WAIT_MAX_MS = 10 * 60 * 1000;
const HOLD_WARN_MS = 10 * 60 * 1000;

const inside = new AsyncLocalStorage(); // { active } while a step runs
const queue = [];
let busy = null; // { label, since }

function startNext() {
  const next = queue.shift();
  if (next) next.start();
}

function warnLongHold(holder) {
  const mins = Math.round((Date.now() - holder.since) / 60000);
  const detail =
    "“" + holder.label + "” has held the auto-farm operation lock for " + mins +
    " min; " + queue.length + " step(s) are waiting behind it and no farm can be placed or ended meanwhile.";
  console.error("[farmOps] " + detail);
  try {
    require("./systemLog").logEvent({
      category: "autofarm",
      action: "ops_lock_held",
      actor: "farmOps",
      severity: "error",
      subject: holder.label,
      count: queue.length,
      detail,
    });
  } catch {
    /* the log line above stands */
  }
  // To the owner's phone as well: nothing farms a new campaign while this lasts.
  try {
    require("./telegram")
      .sendTelegram("⏳ Auto-farm is waiting on one step — " + detail)
      .catch(() => {});
  } catch {
    /* the log line above stands */
  }
}

// Run fn() as the only structural operation in progress. Returns fn's result
// (or rejection). `label` says what the step is, for the wait/hold messages.
function switchedOff() {
  try {
    return require("./settings").getAutoFarm().farmOpsLock === false;
  } catch {
    return false;
  }
}

function run(label, fn, { waitMs = WAIT_MAX_MS, holdWarnMs = HOLD_WARN_MS } = {}) {
  const here = inside.getStore();
  if (here && here.active) return (async () => fn())();
  if (switchedOff()) return (async () => fn())();
  if (typeof fileLock.insideFileLock === "function" && fileLock.insideFileLock()) {
    return Promise.reject(
      new Error("“" + label + "” asked for the auto-farm turn while holding a bot config's lock — refused, it could never be granted safely"),
    );
  }
  return new Promise((resolve, reject) => {
    const waiter = { label, timer: null };
    const token = { active: false };
    // The step, in the async context of whoever asked for it.
    const step = AsyncResource.bind(() => inside.run(token, fn));
    waiter.start = () => {
      if (waiter.timer) clearTimeout(waiter.timer);
      token.active = true;
      const holder = { label, since: Date.now() };
      busy = holder;
      const warn = setTimeout(() => warnLongHold(holder), holdWarnMs);
      if (typeof warn.unref === "function") warn.unref();
      const done = () => {
        token.active = false;
        clearTimeout(warn);
        if (busy === holder) busy = null;
        startNext();
      };
      (async () => step())().then(
        (value) => {
          done();
          resolve(value);
        },
        (err) => {
          done();
          reject(err);
        },
      );
    };
    if (!busy && !queue.length) return waiter.start();
    queue.push(waiter);
    if (Number.isFinite(waitMs)) {
      waiter.timer = setTimeout(() => {
        const i = queue.indexOf(waiter);
        if (i < 0) return; // already started
        queue.splice(i, 1);
        const holder = busy;
        const e = new Error(
          "the auto-farm is busy" +
            (holder
              ? " with “" + holder.label + "” (" + Math.round((Date.now() - holder.since) / 1000) + "s so far)"
              : "") +
            " — “" + label + "” was not started",
        );
        e.code = "FARM_OPS_BUSY";
        // Nothing failed — the step never ran. The engines' catch blocks
        // write a task_failed row for an error that is not marked recorded.
        e.autoFarmEventRecorded = true;
        reject(e);
      }, waitMs);
      if (typeof waiter.timer.unref === "function") waiter.timer.unref();
    }
  });
}

const isBusy = (e) => !!(e && e.code === "FARM_OPS_BUSY");

// What is running and how many are waiting — for the health board.
function status() {
  return {
    busy: busy ? { label: busy.label, heldMs: Date.now() - busy.since } : null,
    waiting: queue.length,
  };
}

module.exports = { run, isBusy, status, WAIT_MAX_MS, HOLD_WARN_MS };
