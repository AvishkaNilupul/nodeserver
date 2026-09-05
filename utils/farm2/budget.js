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
    this.grants = new Map(); // laneKey -> { accounts, seats, spentAccounts, spentSeats, onDemand }
    // The part of the budget no lane has been allocated. Lanes draw from it ON
    // DEMAND (spendAccounts), which is how the engine behaves like the legacy
    // tick once every game has a lane: legacy fair-shares the pool among the
    // handful of campaigns that need fresh accounts THIS tick, not among every
    // game it knows. Pre-allocating to 50 lanes — most of which reuse warm
    // bots and spend nothing — diluted a real fresh farm to six accounts.
    this.unallocated = this.totalAccounts;
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
    let allocated = 0;
    for (const w of wants) {
      const acc = Math.max(0, split.get(w.key) || 0);
      allocated += acc;
      const seatShare =
        this.totalAccounts > 0
          ? Math.floor((this.totalSeats * acc) / this.totalAccounts)
          : 0;
      this.grants.set(w.key, {
        accounts: acc,
        seats: seatShare,
        spentAccounts: 0,
        spentSeats: 0,
        onDemand: 0,
      });
    }
    this.unallocated = Math.max(0, this.totalAccounts - allocated);
    return this.grants;
  }

  grantFor(laneKey) {
    return (
      this.grants.get(laneKey) || {
        accounts: 0,
        seats: 0,
        spentAccounts: 0,
        spentSeats: 0,
        onDemand: 0,
      }
    );
  }

  _grantRemaining(g) {
    return Math.max(0, g.accounts - (g.spentAccounts - g.onDemand));
  }

  // How many accounts this lane may still claim: what is left of its own
  // allocation plus what nobody has been allocated, capped per game. Lanes
  // MUST call this immediately before claiming and claim no more than it
  // returns.
  remainingAccounts(laneKey) {
    const g = this.grantFor(laneKey);
    const own = this._grantRemaining(g);
    const capRoom =
      this.perGameCap > 0 ? Math.max(0, this.perGameCap - g.spentAccounts - own) : Infinity;
    return own + Math.max(0, Math.min(this.unallocated, capRoom));
  }

  // Spend: the lane's own allocation first, then the unallocated remainder.
  // The sum over all lanes can never exceed totalAccounts — the invariant the
  // arbiter exists for — because on-demand draws come out of one shared
  // counter that only ever goes down.
  spendAccounts(laneKey, n) {
    const room = this.remainingAccounts(laneKey);
    const take = Math.max(0, Math.min(Number(n) || 0, room));
    if (!take) return 0;
    let g = this.grants.get(laneKey);
    if (!g) {
      g = { accounts: 0, seats: 0, spentAccounts: 0, spentSeats: 0, onDemand: 0 };
      this.grants.set(laneKey, g);
    }
    const fromGrant = Math.min(take, this._grantRemaining(g));
    const fromPool = take - fromGrant;
    this.unallocated = Math.max(0, this.unallocated - fromPool);
    g.spentAccounts += take;
    g.onDemand += fromPool;
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

  // A NOTIONAL copy of this cycle's budget, for shadow lanes.
  //
  // Shadow lanes must not be granted from the real ledger — an account promised
  // to a lane that will never spend it is an account a LIVE lane could have
  // used. But granting them zero was worse: every shadow decision came out
  // "trimmed to 0 of 16", so the comparison could only ever validate intent,
  // never the allocation amount, which is half of what the trial exists to
  // check.
  //
  // A fork has the same totals and its own independent ledger, so shadow lanes
  // allocate realistically against a copy while the real budget stays untouched.
  // The SSH semaphore is SHARED, deliberately: host concurrency is a physical
  // limit on the Pi, and shadow reads consume it exactly as live ones do.
  fork(reason) {
    const f = new BudgetCycle({
      accounts: this.totalAccounts,
      seats: this.totalSeats,
      containers: this.totalContainers,
      perGameCap: this.perGameCap,
      reason: reason || this.reason,
    });
    f._hostSlots = 0;
    f._hostQueue = [];
    f._acquireHost = this._acquireHost.bind(this);
    f._releaseHost = this._releaseHost.bind(this);
    f.notional = true;
    return f;
  }

  summary() {
    const out = {};
    for (const [k, g] of this.grants) out[k] = { ...g };
    return {
      notional: !!this.notional,
      totalAccounts: this.totalAccounts,
      unallocated: this.unallocated,
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
  const spendable = Math.max(0, ready - reserve);
  if (spendable === 0) reasons.push(`pool at/below reserve (${ready}/${reserve})`);

  // NOT capped by marketStockFloor. An earlier version did
  // `spendable = min(spendable, marketStockFloor(af))`, reading the floor as a
  // fleet-wide ceiling. It is the opposite: the MINIMUM stock a single
  // campaign must farm to fill every enabled market's shelf (legacy:
  // `wanted = max(alloc.target, floor)`), and the lane's decide step applies
  // it there. As a cap it limited every live lane's fresh spend to a share of
  // 18 accounts per cycle on prod — six live lanes, three accounts each —
  // where the legacy tick fair-shares the whole spendable pool.

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
  // cycle is trying to bound. The lane's decide step consults
  // autoFarmer.autoSeatCapacity only when no container is free, and executeTask
  // packs into free seats (fillExistingBots) under the host semaphore.
  const seats = containersFree * perBot;

  // The ACCOUNT budget is the spendable pool, exactly as the legacy tick's
  // `fairShare(requests, spendable)`. It is NOT `min(spendable, seats)`:
  // capacity is a per-campaign gate (seats in free containers PLUS free seats
  // in running bots), and with the fleet at its container cap the seats term
  // here is 0 while running bots may still hold hundreds of free seats. An
  // earlier version applied that min and would have recorded skip_no_accounts
  // — "pool has no spendable accounts" — for a pool of 340.
  const budget = spendable;

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
