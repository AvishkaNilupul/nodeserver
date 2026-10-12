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
// code, not expired, not tied to a game account, and its account is ours and
// can still log in. Links, forms and in-game rewards are left to a person.
//
// Everything runs through one queue: one account at a time, one call to SOOP
// that claims or reads a code every `paceMs`. Nothing here logs or returns a code.
const { isAuthError, isEgressError, plainMessage } = require("./errors");
const { DEAD, REJECTED } = require("./farmViews");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// A reward SOOP reissues comes back as a new item: look once more for it.
const ROUNDS = 2;
// `raw.ingameGiveYn`: such a reward goes to a game account, linked or not. On
// an account with one linked it would not ask for a link, and a claim would
// send it there instead of handing out a code.
const WAITING = { division: "available", kind: "code", needsLink: { $ne: true }, "raw.ingameGiveYn": { $ne: "Y" } };
// Claimed (by us, by hand on SOOP, or by a claim whose reply was lost) but with
// no code stored yet: reading it back is the same call, and only reads.
const CODELESS = { division: "acquired", kind: "code", hasCode: { $ne: true } };
const ROW_FIELDS = "loginId name expiresAt sentAt claimedAt createdAt raw.itemCodeIdx auto claim.kind";
// ...unless SOOP already said there is no code to have (it went to a game
// account): only a reward never read, or one SOOP owes a code for.
const owedCode = (r) => !r.claim || !r.claim.kind || r.claim.kind === "pending";

const canClaim = (a) => Boolean(a) && !a.sold && a.status !== DEAD && a.status !== REJECTED;
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
// Nothing was learned about the reward: the tunnel is down, SOOP did not
// answer, or what came back could not be read (an error page).
const unanswered = (err) => isEgressError(err) || Boolean(err && err.code === "HTTP");
const blank = (id) => ({ id, claimed: 0, read: 0, failed: 0, pending: 0, added: 0, synced: false, skipped: null });

function createAutoClaimer({
  models,
  inventory,
  activity,
  enabled = () => true,
  // async (id) -> { dropsOk } — the login check. Asked when SOOP answers a
  // claim with "please log in", to tell a dead login from one odd reward.
  checkLogin = async () => null,
  paceMs = 7000,
  // Between two logins in a sweep.
  checkPaceMs = 2500,
  // Before a claim SOOP refused is tried again...
  retryMs = 30 * MIN,
  // ...and before a code SOOP owes is asked for again. Under six hours, so the
  // second three-hourly sweep after it is not seconds too early.
  owedMs = 5.5 * HOUR,
  // An owed code is asked for this long after the claim, then left alone.
  owedForMs = 30 * DAY,
  // Unclaimed this long on a login that works: something is wrong, say so.
  overdueMs = 4 * HOUR,
  // Refusals in a row before the rest of an account is left for the next run.
  maxRefusals = 2,
  now = Date.now,
  sleep = (ms) =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      if (t.unref) t.unref();
    }),
} = {}) {
  if (!inventory || typeof inventory.claim !== "function") throw new TypeError("auto-claim needs the inventory service");
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

  const ms = (d) => (d ? new Date(d).getTime() : 0);
  const hasId = (r) => Boolean(r.raw && r.raw.itemCodeIdx);
  const notExpired = (r, t) => !r.expiresAt || ms(r.expiresAt) > t;
  // A reward that was refused, or that SOOP has no code for yet, is not asked
  // for again until its wait has passed.
  const due = (r, t) => !(r.auto && r.auto.at) || t - ms(r.auto.at) >= (r.auto.kind === "failed" ? retryMs : owedMs);

  // Unclaimed rewards to claim now. `force`: a fresh login is a fresh start —
  // what an earlier attempt was refused is tried again at once.
  async function waitingRows(id, { force = false } = {}) {
    const t = now();
    const rows = await Item().find({ ...WAITING, loginId: id }).select(ROW_FIELDS).sort({ sentAt: 1, _id: 1 }).lean();
    return rows.filter((r) => hasId(r) && notExpired(r, t) && (force || due(r, t)));
  }

  // Claimed rewards whose code is still to be read. The date on such a row is
  // the code's own, not a deadline for asking: SOOP can deliver an owed code
  // days later, so it is asked for until `owedForMs` after the claim.
  async function codelessRows(id) {
    const t = now();
    const rows = await Item().find({ ...CODELESS, loginId: id }).select(ROW_FIELDS).sort({ sentAt: 1, _id: 1 }).lean();
    return rows.filter((r) => hasId(r) && owedCode(r) && due(r, t) && t - ms(r.claimedAt || r.createdAt) < owedForMs);
  }

  function stamp(row, kind, error) {
    const tries = (Number(row.auto && row.auto.tries) || 0) + 1;
    const auto = { kind, tries, at: new Date(now()), error: String(error || "").slice(0, 200) };
    return Item().updateOne({ _id: row._id }, { $set: { auto } });
  }
  const clear = (row) => (row.auto ? Item().updateOne({ _id: row._id }, { $set: { auto: null } }) : null);
  const why = (err) => (err && err.code === "API" && err.message) || plainMessage(err);

  // -> "code" | "pending" | "renewed" | "other" | "refused" | "failed"
  // Throws when nothing was learned (see `unanswered`) or SOOP said "log in".
  async function claimOne(row) {
    let res;
    try {
      res = await inventory.claim(String(row._id), { sync: false });
    } catch (err) {
      if (unanswered(err) || isAuthError(err)) throw err;
      await stamp(row, "failed", why(err));
      return "failed";
    }
    // Refused before SOOP was asked: the stored row is out of date (claimed
    // elsewhere, or just expired). The next read of the inventory puts it right.
    if (!res || !res.ok) return "refused";
    const { kind, message, code } = res.result;
    if (code) {
      await clear(row);
      state.claimed += 1;
      state.lastClaimAt = new Date(now());
      return "code";
    }
    if (kind === "pending" || kind === "renewed") {
      await stamp(row, kind, message);
      return kind;
    }
    // Claimed, and there is no code to have: nothing is owed, nothing to retry.
    await clear(row);
    return "other";
  }

  async function readOne(row) {
    let found;
    try {
      found = await inventory.reveal(String(row._id));
    } catch (err) {
      if (unanswered(err) || isAuthError(err)) throw err;
      await stamp(row, "pending", why(err));
      return false;
    }
    if (found && found.code) {
      await clear(row);
      state.read += 1;
      return true;
    }
    await stamp(row, "pending", (found && found.claim && found.claim.message) || "SOOP returned no code for this reward");
    return false;
  }

  // Everything waiting on one login. `sync: false` trusts the stored copy
  // instead of reading the inventory first.
  // -> { id, claimed, read, failed, pending, added, synced, skipped }
  async function runAccount(id, { sync = true, force = false } = {}) {
    const out = blank(id);
    if (!on()) return { ...out, skipped: "off" };
    const mayClaim = async () => {
      const acc = await Account().findOne({ loginId: id }).select("loginId status sold").lean();
      if (!acc) return "unknown";
      return canClaim(acc) ? null : acc.sold ? "sold" : "login";
    };
    out.skipped = await mayClaim();
    if (out.skipped) return out;
    await inventory.settled(id); // claims never start in the middle of a sync
    if (sync) {
      // Quiet: thirty logins read every three hours would bury the activity log.
      const read = await inventory.syncAccount(id, { quiet: true });
      out.synced = true;
      out.added = Number(read && read.added) || 0;
    }

    let loginOk = null; // asked once, when SOOP answers a claim with "log in"
    let refusals = 0;
    for (let round = 0; round < ROUNDS; round++) {
      const rows = await waitingRows(id, { force });
      let reissued = false;
      for (const row of rows) {
        // Sold, or its login marked dead, a moment ago: not ours to claim on.
        if (!on() || (await mayClaim())) break;
        await pace();
        let got;
        try {
          got = await claimOne(row);
        } catch (err) {
          if (!isAuthError(err)) throw err;
          // The login, or this one reward? A login the drops site still
          // accepts was not what SOOP refused.
          if (loginOk === null) loginOk = await loginWorks(id);
          if (!loginOk) throw Object.assign(err, { loginChecked: true });
          await stamp(row, "failed", why(err));
          got = "failed";
        }
        if (got === "code") out.claimed += 1;
        else if (got === "pending") out.pending += 1;
        else if (got === "renewed") reissued = true;
        if (got === "failed") {
          out.failed += 1;
          // Refused twice running: whatever it is, it is not about one
          // reward. The rest is left as it is for the next run.
          if (++refusals >= maxRefusals) return out;
        } else if (got !== "refused") {
          refusals = 0;
        }
      }
      // A claim writes the reward's new state itself, so nothing has to be
      // read back — unless SOOP reissued one: that is a new item, known only
      // to SOOP until its inventory is read again.
      if (!reissued) break;
      await inventory.syncAccount(id, { quiet: true }).catch(() => {});
    }

    for (const row of await codelessRows(id)) {
      if (!on()) break;
      await pace();
      if (await readOne(row)) out.read += 1;
      else out.pending += 1;
    }
    return out;
  }

  async function loginWorks(id) {
    try {
      const check = await checkLogin(id);
      return Boolean(check && check.dropsOk);
    } catch {
      return false;
    }
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
  // error: "auth" the login is refused · "egress" nothing was learned (tunnel,
  // timeout, unreadable reply) · "error" anything else.
  async function guarded(id, opts) {
    try {
      const out = await runAccount(id, opts);
      report(out);
      return out;
    } catch (err) {
      state.lastError = { at: new Date(now()), accountId: id, error: plainMessage(err) };
      if (isAuthError(err)) {
        note({ level: "warn", accountId: id, msg: `SOOP refused ${id} while its rewards were being claimed — anything unclaimed on it waits until its cookie is re-imported` });
        // So the panel and the login alert say so now, not at the next sweep.
        if (!err.loginChecked) loginWorks(id);
        return { ...blank(id), error: "auth" };
      }
      if (unanswered(err)) return { ...blank(id), error: "egress" };
      note({ level: "warn", accountId: id, msg: `Automatic claiming stopped on ${id}: ${plainMessage(err)}` });
      return { ...blank(id), error: "error" };
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
    const done = () => {
      state.running = queued.size > 0;
    };
    chain = p.then(done, done);
    queued.set(key, p);
    return p;
  }

  function account(rawId, { sync = true, force = false } = {}) {
    const id = String(rawId || "");
    if (!id) return Promise.resolve({ ...blank(id), skipped: "unknown" });
    return enqueue(`account:${id}:${sync ? "sync" : "db"}:${force ? "force" : ""}`, () => guarded(id, { sync, force }));
  }

  // The safety net: every login that can claim has its inventory read and
  // whatever is waiting claimed. A reward can land without the farm seeing it
  // (a restart between a step and its sync, a reward handed out late), and a
  // claim can fail.
  // -> { accounts, claimed, read, failed, pending, added, stopped }
  async function doSweep() {
    const sum = { accounts: 0, claimed: 0, read: 0, failed: 0, pending: 0, added: 0, stopped: null };
    if (!on()) return { ...sum, stopped: "off" };
    const rows = await Account().find({ sold: { $ne: true } }).select("loginId status sold").sort({ createdAt: 1 }).lean();
    for (const a of rows.filter(canClaim)) {
      if (!on()) {
        sum.stopped = "off";
        break;
      }
      if (sum.accounts) await sleep(checkPaceMs);
      sum.accounts += 1;
      const out = await guarded(a.loginId, { sync: true });
      for (const k of ["claimed", "read", "failed", "pending", "added"]) sum[k] += out[k];
      // A dead tunnel is dead for every login: the caller starts over later.
      if (out.error === "egress") {
        sum.stopped = "egress";
        break;
      }
    }
    state.lastSweepAt = new Date(now());
    state.lastSweep = sum;
    if (sum.claimed || sum.read || sum.failed || sum.stopped === "egress") {
      note({
        level: sum.failed || sum.stopped ? "warn" : "info",
        msg:
          `Checked ${plural(sum.accounts, "login")} for unclaimed codes: ${sum.claimed} claimed, ${sum.read} read back` +
          (sum.failed ? `, ${sum.failed} could not be claimed` : "") +
          (sum.stopped === "egress" ? " — stopped early: SOOP could not be reached" : ""),
      });
    }
    return sum;
  }

  const sweep = () =>
    enqueue("sweep", () =>
      doSweep().catch((err) => {
        state.lastError = { at: new Date(now()), accountId: null, error: plainMessage(err) };
        return { accounts: 0, claimed: 0, read: 0, failed: 0, pending: 0, added: 0, stopped: "error" };
      }),
    );

  // For the panel, from the database only: codes that are waiting where
  // nothing can claim them (`stuck`), ones the claim keeps being refused
  // (`failed`), and ones left unclaimed too long on a login that works (`overdue`).
  async function waiting() {
    const t = now();
    const [rows, accounts] = await Promise.all([
      Item().find(WAITING).select("loginId expiresAt createdAt raw.itemCodeIdx auto").lean(),
      Account().find({}).select("loginId status sold").lean(),
    ]);
    const byId = new Map(accounts.map((a) => [a.loginId, a]));
    const stuck = { rewards: 0, logins: new Set(), soonest: null };
    const failed = { rewards: 0, error: "" };
    const overdue = { rewards: 0 };
    for (const r of rows) {
      const a = byId.get(r.loginId);
      if (!a || a.sold || !hasId(r) || !notExpired(r, t)) continue;
      if (!canClaim(a)) {
        stuck.rewards += 1;
        stuck.logins.add(r.loginId);
        const exp = r.expiresAt ? new Date(r.expiresAt) : null;
        if (exp && (!stuck.soonest || exp < stuck.soonest)) stuck.soonest = exp;
      } else if (r.auto && r.auto.error) {
        failed.rewards += 1;
        failed.error = failed.error || String(r.auto.error);
      } else if (t - ms(r.createdAt) > overdueMs) {
        overdue.rewards += 1;
      }
    }
    return { enabled: on(), stuck: { rewards: stuck.rewards, logins: [...stuck.logins].sort(), soonest: stuck.soonest }, failed, overdue };
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

  // Resolves when everything queued so far has run. Never rejects.
  const idle = () => chain;

  return { account, sweep, waiting, status, idle };
}

module.exports = { createAutoClaimer, canClaim };
