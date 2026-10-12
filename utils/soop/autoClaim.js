// Claims code rewards as soon as they are earned (docs/SOOP-FARM-CONTRACT.md §18).
//
// SOOP hands a reward's code out only when the reward is claimed, and a reward
// can only be claimed while its login works. A login can stop working on any
// day: on 2026-10-11 the drops site dropped all eight at once, and what was
// still unclaimed on them could not be reached until each account had been
// signed in again by hand — by which time 32 one-day rewards had run out. A
// code that HAS been claimed is stored encrypted (./inventory.js) and stays
// ours whatever happens to the login.
//
// So nothing waits for a click. A reward is claimed when it is unclaimed, a
// code, not expired, needs no linked game account, and its account is ours
// and can still log in. Links, forms and in-game rewards are left to a person.
//
// Everything runs through one queue: one account at a time, one call to SOOP
// every `paceMs`. Nothing here logs or returns a code.
const { isAuthError, isEgressError, plainMessage } = require("./errors");
const { DEAD, REJECTED } = require("./farmViews");

const HOUR = 3600 * 1000;
// A reward SOOP reissues comes back as a new item: look once more for it.
const ROUNDS = 2;
const WAITING = { division: "available", kind: "code", needsLink: { $ne: true } };
// Claimed (by us, by hand on SOOP, or by a claim whose reply was lost) but with
// no code stored yet: reading it back is the same call, and only reads.
const CODELESS = { division: "acquired", kind: "code", hasCode: { $ne: true } };
const ROW_FIELDS = "loginId name expiresAt sentAt raw.itemCodeIdx auto claim.kind";
// ...unless SOOP already said there is no code to have (it went to a linked
// game account): only a reward never read, or one SOOP owes a code for.
const owedCode = (r) => !r.claim || !r.claim.kind || r.claim.kind === "pending";

const canClaim = (a) => Boolean(a) && !a.sold && a.status !== DEAD && a.status !== REJECTED;
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

function createAutoClaimer({
  models,
  inventory,
  getClient,
  activity,
  enabled = () => true,
  onAuth = () => {},
  paceMs = 7000,
  checkPaceMs = 2500,
  retryMs = 6 * HOUR,
  now = Date.now,
  sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (t.unref) t.unref();
    }),
} = {}) {
  if (!inventory || typeof inventory.claim !== "function") throw new TypeError("auto-claim needs the inventory service");
  if (typeof getClient !== "function") throw new TypeError("auto-claim needs getClient");
  const Item = () => (models && models.SoopInventoryItem) || require("../../models/SoopInventoryItem");
  const Account = () => (models && models.SoopAccount) || require("../../models/SoopAccount");

  const state = { running: false, claimed: 0, read: 0, lastClaimAt: null, lastSweepAt: null, lastSweep: null, lastError: null };
  const queued = new Map(); // key -> promise, for work that has not started yet
  let chain = Promise.resolve();
  let lastCallAt = 0;

  // The switch is read before every call to SOOP. A switch that cannot be read
  // is "on": the cost of claiming is nothing, the cost of not claiming is the code.
  function on() {
    try {
      return enabled() !== false;
    } catch {
      return true;
    }
  }

  function note(entry) {
    try {
      if (activity) activity.add({ kind: "claim", ...entry });
    } catch {
      /* the log is never a reason to stop claiming */
    }
  }

  async function pace() {
    const wait = lastCallAt + paceMs - now();
    if (wait > 0) await sleep(wait);
    lastCallAt = now();
  }

  const usableRow = (r, t) => Boolean(r.raw && r.raw.itemCodeIdx) && (!r.expiresAt || new Date(r.expiresAt).getTime() > t);
  // A reward that failed, or that SOOP has no code for yet, is not asked for
  // again until `retryMs` has passed.
  const due = (r, t) => !(r.auto && r.auto.at) || t - new Date(r.auto.at).getTime() >= retryMs;

  async function rowsOf(id, query) {
    const t = now();
    const rows = await Item().find({ ...query, loginId: id }).select(ROW_FIELDS).sort({ sentAt: 1, _id: 1 }).lean();
    return rows.filter((r) => usableRow(r, t) && due(r, t));
  }

  function stamp(row, error) {
    const tries = (Number(row.auto && row.auto.tries) || 0) + 1;
    const auto = { tries, at: new Date(now()), error: String(error || "").slice(0, 200) };
    return Item().updateOne({ _id: row._id }, { $set: { auto } });
  }
  const clear = (row) => (row.auto ? Item().updateOne({ _id: row._id }, { $set: { auto: null } }) : null);

  // A dead login or a dead tunnel is not this reward's fault: it goes up to
  // the caller, which stops asking. Anything else is recorded on the reward.
  const fatal = (err) => isAuthError(err) || isEgressError(err);
  const why = (err) => (err && err.code === "API" && err.message) || plainMessage(err);

  // -> "code" | "pending" | "renewed" | "other" | "refused" | "failed"
  async function claimOne(row) {
    let res;
    try {
      res = await inventory.claim(String(row._id), { sync: false });
    } catch (err) {
      if (fatal(err)) throw err;
      await stamp(row, why(err));
      return "failed";
    }
    // Refused before SOOP was asked: the stored row is out of date (claimed
    // elsewhere, or just expired). The sync that follows puts it right.
    if (!res || !res.ok) return "refused";
    const { kind, message, code } = res.result;
    if (code) {
      await clear(row);
      state.claimed += 1;
      state.lastClaimAt = new Date(now());
      return "code";
    }
    await stamp(row, message);
    return kind === "pending" || kind === "renewed" ? kind : "other";
  }

  async function readOne(row) {
    let found;
    try {
      found = await inventory.reveal(String(row._id));
    } catch (err) {
      if (fatal(err)) throw err;
      await stamp(row, why(err));
      return false;
    }
    if (found && found.code) {
      await clear(row);
      state.read += 1;
      return true;
    }
    await stamp(row, (found && found.claim && found.claim.message) || "SOOP returned no code for this reward");
    return false;
  }

  // Does SOOP hold something for this login that the stored copy does not show?
  // One small call: an unclaimed reward we do not know of, or a claim made elsewhere.
  async function outOfDate(id) {
    const counts = await (await getClient(id)).inventoryCounts();
    const have = (division) => Item().countDocuments({ loginId: id, division, goneAt: null });
    return Number(counts.available) !== (await have("available")) || Number(counts.acquired) > (await have("acquired"));
  }

  // Everything waiting on one login. `sync`: true reads its inventory first,
  // "check" reads it only when SOOP's own counters disagree with the stored
  // copy, false trusts the copy (the caller has just synced).
  // -> { id, claimed, read, failed, pending, synced, skipped }
  async function runAccount(id, { sync = false } = {}) {
    const out = { id, claimed: 0, read: 0, failed: 0, pending: 0, synced: false, skipped: null };
    if (!on()) return { ...out, skipped: "off" };
    const acc = await Account().findOne({ loginId: id }).select("loginId status sold").lean();
    if (!acc) return { ...out, skipped: "unknown" };
    if (!canClaim(acc)) return { ...out, skipped: acc.sold ? "sold" : "login" };
    await inventory.settled(id); // claims never start in the middle of a sync
    if (sync === true || (sync === "check" && (await outOfDate(id)))) {
      await inventory.syncAccount(id);
      out.synced = true;
    }

    for (let round = 0; round < ROUNDS; round++) {
      const rows = await rowsOf(id, WAITING);
      let asked = 0;
      let reissued = false;
      for (const row of rows) {
        if (!on()) break;
        await pace();
        const got = await claimOne(row);
        if (got !== "refused") asked += 1;
        if (got === "code") out.claimed += 1;
        else if (got === "failed") out.failed += 1;
        else if (got === "pending") out.pending += 1;
        else if (got === "renewed") reissued = true;
      }
      if (!rows.length) break;
      // One sync for the batch: where SOOP now files each reward, and anything
      // it reissued. The codes are already stored, so a failure here is no loss.
      if (asked) await inventory.syncAccount(id).catch(() => {});
      if (!reissued) break;
    }

    for (const row of (await rowsOf(id, CODELESS)).filter(owedCode)) {
      if (!on()) break;
      await pace();
      if (await readOne(row)) out.read += 1;
      else out.pending += 1;
    }
    return out;
  }

  // What happened, in one line, when something did.
  function report(out) {
    if (out.failed) {
      note({ level: "warn", accountId: out.id, msg: `${plural(out.failed, "reward")} on ${out.id} could not be claimed automatically — it is tried again later` });
    }
    if (out.pending) {
      note({ level: "warn", accountId: out.id, msg: `SOOP has no code yet for ${plural(out.pending, "reward")} on ${out.id} — it is asked again later` });
    }
    if (out.read) note({ accountId: out.id, msg: `Read back the code of ${plural(out.read, "claimed reward")} on ${out.id}` });
  }

  // Never rejects: the result says what stopped it.
  async function guarded(id, opts) {
    try {
      const out = await runAccount(id, opts);
      report(out);
      return out;
    } catch (err) {
      const base = { id, claimed: 0, read: 0, failed: 0, pending: 0, synced: false, skipped: null };
      state.lastError = { at: new Date(now()), accountId: id, error: plainMessage(err) };
      if (isAuthError(err)) {
        note({ level: "warn", accountId: id, msg: `SOOP refused ${id} while its rewards were being claimed — anything unclaimed on it waits until its cookie is re-imported` });
        try {
          onAuth(id);
        } catch {
          /* a hook must not break the queue */
        }
        return { ...base, error: "auth" };
      }
      if (isEgressError(err)) return { ...base, error: "egress" };
      note({ level: "warn", accountId: id, msg: `Automatic claiming stopped on ${id}: ${plainMessage(err)}` });
      return { ...base, error: "error" };
    }
  }

  function enqueue(key, work) {
    if (queued.has(key)) return queued.get(key);
    const p = chain.then(() => {
      // Off the list the moment it starts: a reward that lands while this
      // account is being worked on queues a run of its own.
      queued.delete(key);
      state.running = true;
      return work();
    });
    chain = p.then(
      () => (state.running = queued.size > 0),
      () => (state.running = queued.size > 0),
    );
    queued.set(key, p);
    return p;
  }

  function account(rawId, { sync = false } = {}) {
    const id = String(rawId || "");
    if (!id) return Promise.resolve({ id, claimed: 0, read: 0, failed: 0, pending: 0, synced: false, skipped: "unknown" });
    return enqueue(`account:${id}:${sync}`, () => guarded(id, { sync }));
  }

  // The safety net: every login that can claim. A reward can land without the
  // farm seeing it (a restart between a step and its sync, a reward handed out
  // late), and a claim can fail. One small call per login; its inventory is
  // read only when that call says something changed.
  // -> { accounts, synced, claimed, read, failed, pending, stopped }
  async function doSweep() {
    const sum = { accounts: 0, synced: 0, claimed: 0, read: 0, failed: 0, pending: 0, stopped: null };
    if (!on()) return { ...sum, stopped: "off" };
    const rows = await Account().find({ sold: { $ne: true } }).select("loginId status sold").sort({ createdAt: 1 }).lean();
    for (const a of rows.filter(canClaim)) {
      if (!on()) {
        sum.stopped = "off";
        break;
      }
      if (sum.accounts) await sleep(checkPaceMs);
      sum.accounts += 1;
      const out = await guarded(a.loginId, { sync: "check" });
      if (out.synced) sum.synced += 1;
      for (const k of ["claimed", "read", "failed", "pending"]) sum[k] += out[k];
      // A dead tunnel is dead for every login: the next sweep starts over.
      if (out.error === "egress") {
        sum.stopped = "Could not reach SOOP — the proxy or the network is down";
        break;
      }
    }
    state.lastSweepAt = new Date(now());
    state.lastSweep = sum;
    if (sum.claimed || sum.read || sum.failed || sum.stopped) {
      note({
        level: sum.failed || (sum.stopped && sum.stopped !== "off") ? "warn" : "info",
        msg:
          `Checked ${plural(sum.accounts, "login")} for unclaimed codes: ${sum.claimed} claimed, ${sum.read} read back` +
          (sum.failed ? `, ${sum.failed} could not be claimed` : "") +
          (sum.stopped && sum.stopped !== "off" ? ` — stopped early: ${sum.stopped}` : ""),
      });
    }
    return sum;
  }

  const sweep = () =>
    enqueue("sweep", () =>
      doSweep().catch((err) => {
        state.lastError = { at: new Date(now()), accountId: null, error: plainMessage(err) };
        return { accounts: 0, synced: 0, claimed: 0, read: 0, failed: 0, pending: 0, stopped: plainMessage(err) };
      }),
    );

  // For the panel: codes that are waiting where nothing can claim them, and
  // ones the claim keeps failing on. Database only — SOOP is not asked.
  async function waiting() {
    const t = now();
    const [rows, accounts] = await Promise.all([
      Item().find(WAITING).select("loginId expiresAt raw.itemCodeIdx auto").lean(),
      Account().find({}).select("loginId status sold").lean(),
    ]);
    const byId = new Map(accounts.map((a) => [a.loginId, a]));
    const stuck = { rewards: 0, logins: new Set(), soonest: null };
    const failed = { rewards: 0, error: "" };
    for (const r of rows) {
      const a = byId.get(r.loginId);
      if (!a || a.sold || !usableRow(r, t)) continue;
      if (!canClaim(a)) {
        stuck.rewards += 1;
        stuck.logins.add(r.loginId);
        const exp = r.expiresAt ? new Date(r.expiresAt) : null;
        if (exp && (!stuck.soonest || exp < stuck.soonest)) stuck.soonest = exp;
      } else if (r.auto && r.auto.error) {
        failed.rewards += 1;
        failed.error = failed.error || String(r.auto.error);
      }
    }
    return { stuck: { rewards: stuck.rewards, logins: [...stuck.logins].sort(), soonest: stuck.soonest }, failed };
  }

  function status() {
    return {
      enabled: on(),
      running: state.running,
      claimed: state.claimed,
      read: state.read,
      lastClaimAt: state.lastClaimAt,
      lastSweepAt: state.lastSweepAt,
      lastSweep: state.lastSweep ? { ...state.lastSweep } : null,
      lastError: state.lastError ? { ...state.lastError } : null,
    };
  }

  return { account, sweep, waiting, status };
}

module.exports = { createAutoClaimer, canClaim };
