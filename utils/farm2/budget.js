// The arbiter: the one piece of genuinely new engineering in the lane engine.
//
// WHY THIS EXISTS
//
// The legacy utils/autoFarmer.js is safe against over-spending for an accidental
// reason: it does everything for every game in ONE serial pass, so a single
// running counter is enough. The moment lanes run concurrently that guarantee is
// gone. Three global resources are contended:
//
//   1. the ready account pool     — over-claiming drains past poolReserve
//   2. host container slots       — over-creating blows through maxAutoBots
//   3. SSH concurrency to the Pi  — the link is seconds of RTT per call, so
//                                   unbounded parallel host reads are far worse
//                                   than serial ones
//
// Naive parallelism would therefore be WORSE than today's mess, not better.
//
// The design is a sealed-allowance broker. Once per cycle the supervisor
// computes the global budget, splits it across the due lanes, and hands each
// lane an allowance it may spend without further coordination. A lane can never
// exceed its allowance, so the sum can never exceed the global budget — no
// cross-lane locking on the hot path, and the invariant holds by construction.
//
// TWO INDEPENDENT SAFETY NETS BACK THIS UP. The allowance is an upper bound, not
// a reservation:
//   * AvailableAccount claims go through autoFarmer.claimPoolAccounts, whose
//     per-account findOneAndUpdate is atomic — two lanes can never be handed the
//     same account even if the arithmetic here were wrong.
//   * Bot config writes go through utils/fileLock.js, which serialises the
//     read-mutate-write cycle per (host, file).
// The arbiter enforces POLICY (fair division, reserve floors); those two enforce
// CORRECTNESS. A bug here costs fairness, never integrity.

const HOST_CONCURRENCY_DEFAULT = 2;

// A single cycle's budget, split and then spent down by the lanes.
class BudgetCycle {
  constructor({ accounts, seats, containers, perGameCap, hostConcurrency, reason }) {
    this.totalAccounts = Math.max(0, Number(accounts) || 0);
    this.totalSeats = Math.max(0, Number(seats) || 0);
    this.totalContainers = Math.max(0, Number(containers) || 0);
    this.perGameCap = Math.max(0, Number(perGameCap) || 0);
    this.reason = reason || "";
    this.grants = new Map(); // laneKey -> { accounts, seats, spentAccounts, spentSeats }
    // SSH fan-out limiter. The Pi's link is seconds of RTT and an offline host
    // costs ~63s per read, so lanes must not all reach for it at once. This is
    // a semaphore, not an allowance: it bounds concurrency, not total work.
    this._hostSlots = Math.max(1, Number(hostConcurrency) || HOST_CONCURRENCY_DEFAULT);
    this._hostQueue = [];
  }

  // Divide the cycle budget across the lanes that want accounts this cycle.
  // Reuses autoFarmer.fairShare so the split is the SAME algorithm the legacy
  // engine already uses to divide a scarce pool between campaigns — one
  // behaviour, one implementation, no second source of truth to drift.
  allocate(requests) {
    let fairShare;
    try {
      ({ fairShare } = require("../autoFarmer"));
    } catch {
      fairShare = null;
    }
    const wants = requests.map((r) => ({
      key: r.key,
      want: Math.max(0, Math.min(Number(r.want) || 0, this.perGameCap || Infinity)),
      weight: Math.max(1, Number(r.weight) || 1),
    }));

    let split;
    if (fairShare) {
      split = fairShare(wants, this.totalAccounts);
    } else {
      // Defensive equal split if the legacy module could not be loaded. Never
      // expected in practice; keeps a lane cycle from dying on a require error.
      split = new Map();
      let left = this.totalAccounts;
      for (const w of wants) {
        const give = Math.min(w.want, Math.ceil(left / Math.max(1, wants.length)));
        split.set(w.key, give);
        left -= give;
      }
    }

    // Seats are divided in proportion to the accounts actually granted: a lane
    // that got no accounts needs no containers.
    for (const w of wants) {
      const acc = Math.max(0, split.get(w.key) || 0);
      const seatShare =
        this.totalAccounts > 0
          ? Math.floor((this.totalSeats * acc) / this.totalAccounts)
          : 0;
      this.grants.set(w.key, {
        accounts: acc,
        seats: seatShare,
        spentAccounts: 0,
        spentSeats: 0,
      });
    }
    return this.grants;
  }

  grantFor(laneKey) {
    return (
      this.grants.get(laneKey) || {
        accounts: 0,
        seats: 0,
        spentAccounts: 0,
        spentSeats: 0,
      }
    );
  }

  // How many accounts this lane may still claim. Lanes MUST call this
  // immediately before claiming and claim no more than it returns.
  remainingAccounts(laneKey) {
    const g = this.grantFor(laneKey);
    return Math.max(0, g.accounts - g.spentAccounts);
  }

  spendAccounts(laneKey, n) {
    const g = this.grants.get(laneKey);
    if (!g) return 0;
    const take = Math.max(0, Math.min(Number(n) || 0, g.accounts - g.spentAccounts));
    g.spentAccounts += take;
    return take;
  }

  remainingSeats(laneKey) {
    const g = this.grantFor(laneKey);
    return Math.max(0, g.seats - g.spentSeats);
  }

  spendSeats(laneKey, n) {
    const g = this.grants.get(laneKey);
    if (!g) return 0;
    const take = Math.max(0, Math.min(Number(n) || 0, g.seats - g.spentSeats));
    g.spentSeats += take;
    return take;
  }

  // Bound concurrent host (SSH) work across all lanes. Usage:
  //   await cycle.withHost(() => hosts.readFile(...))
  async withHost(fn) {
    await this._acquireHost();
    try {
      return await fn();
    } finally {
      this._releaseHost();
    }
  }

  _acquireHost() {
    if (this._hostSlots > 0) {
      this._hostSlots -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this._hostQueue.push(resolve));
  }

  _releaseHost() {
    const next = this._hostQueue.shift();
    if (next) return next();
    this._hostSlots += 1;
  }

  summary() {
    const out = {};
    for (const [k, g] of this.grants) out[k] = { ...g };
    return {
      totalAccounts: this.totalAccounts,
      totalSeats: this.totalSeats,
      totalContainers: this.totalContainers,
      perGameCap: this.perGameCap,
      reason: this.reason,
      grants: out,
    };
  }
}

// Compute this cycle's global budget from live state, using the LEGACY engine's
// own helpers so the numbers agree with the existing Auto-farm page and the
// allocation forecast by construction rather than by careful copying.
async function computeCycleBudget(af, opts = {}) {
  const autoFarmer = require("../autoFarmer");
  const AutoFarmTask = require("../../models/AutoFarmTask");

  const reasons = [];

  // --- Accounts -------------------------------------------------------------
  let ready = 0;
  try {
    ready = await autoFarmer.countReadyPool();
  } catch (e) {
    reasons.push("pool count failed: " + e.message);
  }
  const reserve = Math.max(0, Number(af.poolReserve) || 0);
  let spendable = Math.max(0, ready - reserve);
  if (spendable === 0) reasons.push(`pool at/below reserve (${ready}/${reserve})`);

  // The market stock floor can hold spending back independently of the pool.
  try {
    const floor = autoFarmer.marketStockFloor(af);
    if (Number.isFinite(floor) && floor >= 0) {
      spendable = Math.min(spendable, Math.max(0, floor));
      if (spendable === 0) reasons.push("market stock floor is 0");
    }
  } catch {
    /* floor is advisory; a failure must not zero the budget */
  }

  // --- Containers / seats ---------------------------------------------------
  const maxAutoBots = Math.max(0, Number(af.maxAutoBots) || 0);
  const perBot = Math.max(1, Number(af.accountsPerBot) || 1);
  let activeContainers = 0;
  try {
    const rows = await AutoFarmTask.find({ status: "active" }, { bots: 1 }).lean();
    const seen = new Set();
    for (const t of rows) {
      for (const b of t.bots || []) {
        const key = (b.host || "") + "|" + (b.container || "");
        if (b.container && !seen.has(key)) seen.add(key);
      }
    }
    activeContainers = seen.size;
  } catch (e) {
    // Unknown container count must NOT be read as "plenty free" — assume the
    // cap is reached so this cycle creates nothing rather than over-creating.
    activeContainers = maxAutoBots;
    reasons.push("container count failed: " + e.message);
  }
  const containersFree = Math.max(0, maxAutoBots - activeContainers);
  if (containersFree === 0)
    reasons.push(`container cap reached (${activeContainers}/${maxAutoBots})`);

  // Seats available for NEW accounts: what free containers could hold. Free
  // seats inside EXISTING containers are deliberately excluded here — counting
  // them needs a per-container host read, which is exactly the SSH fan-out this
  // cycle is trying to bound. The lane's own execute step consults
  // autoFarmer.fillExistingBots for consolidation, under the host semaphore.
  const seats = containersFree * perBot;

  const budget = Math.min(spendable, seats);

  return new BudgetCycle({
    accounts: budget,
    seats,
    containers: containersFree,
    perGameCap: Math.max(0, Number(af.maxPerGame) || 0),
    hostConcurrency: Number(opts.hostConcurrency) || HOST_CONCURRENCY_DEFAULT,
    reason: reasons.join("; ") || "ok",
  });
}

module.exports = { BudgetCycle, computeCycleBudget, HOST_CONCURRENCY_DEFAULT };
