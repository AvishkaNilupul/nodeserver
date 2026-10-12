// Tells the owner when SOOP logins stop being able to farm, and when they are
// back (docs/SOOP-FARM-CONTRACT.md §16).
//
// On 2026-10-11 the drops site began refusing all eight logins in the same five
// minutes. Nothing was farmed for nine hours and nothing said so: the panel
// counted a refused login as healthy, and the farm had no way to reach anyone.
//
// A pass reads account STATE rather than listening for events, so a login that
// died just before a restart is not missed, and one that flips between "logged
// out" and "refused by the drops site" is still one problem, reported once. Two
// fields on the account carry that across restarts:
//
//   unusableSince    the first pass that found the login unable to farm
//   unusableAlertAt  when the owner was told
//
// Both are cleared once the login is `ok` again, so the next failure is news.
// Logins rarely die alone (one scan reads the campaign list through three of
// them), so a message waits for the batch to settle and names every one.
const { DEAD, REJECTED } = require("./farmViews");

// A login must have been unusable this long before anyone is told — a single
// refused call that the next check takes back is not worth a message...
const WAIT_MS = 5 * 60000;
// ...and no other login may have joined it for this long...
const QUIET_MS = 2 * 60000;
// ...but the news is never held longer than this.
const MAX_WAIT_MS = 15 * 60000;
// A login found unusable this soon after its cookie was imported never worked
// with that cookie.
const NEW_COOKIE_MS = 10 * 60000;
const FIELDS = "loginId status cookieAt unusableSince unusableAlertAt";
const NAMES_SHOWN = 12;

const unusable = (a) => a.status === DEAD || a.status === REJECTED;
const ms = (d) => (d ? new Date(d).getTime() : 0);
const newCookie = (a) => {
  const gap = ms(a.unusableSince) - ms(a.cookieAt);
  return Boolean(a.cookieAt) && gap >= 0 && gap < NEW_COOKIE_MS;
};
const logins = (n) => `${n} login${n === 1 ? "" : "s"}`;

function names(rows) {
  const ids = rows.map((a) => a.loginId);
  const more = ids.length - NAMES_SHOWN;
  return ids.slice(0, NAMES_SHOWN).join(", ") + (more > 0 ? ` and ${more} more` : "");
}

// `fresh` = the logins this message is about, `down` = every login that cannot
// farm right now, `total` = every login that is not sold.
function downMessage({ fresh, down, total }) {
  const all = down.length === total;
  const lines = [
    all
      ? `⚠️ SOOP farm: ${total === 1 ? "its only login" : `none of the ${logins(total)}`} can farm — nothing is being earned.`
      : `⚠️ SOOP farm: ${down.length} of ${logins(total)} can no longer farm.`,
    "",
  ];
  const refused = fresh.filter((a) => a.status === REJECTED);
  const out = fresh.filter((a) => a.status === DEAD);
  if (refused.length) lines.push(`Refused by the drops site (${refused.length}): ${names(refused)}`);
  if (out.length) lines.push(`Logged out (${out.length}): ${names(out)}`);
  const again = fresh.filter(newCookie).length;
  if (again) {
    const whose = fresh.length === 1 ? "Its cookie was" : again === fresh.length ? "Their cookies were" : `${again} of these had a cookie`;
    lines.push(`${whose} imported minutes before — the new cookie does not work either.`);
  }
  const earlier = down.length - fresh.length;
  if (earlier > 0) lines.push(`${earlier} more reported earlier still need a cookie.`);
  lines.push(
    "",
    "Fix: sign each one in, open drops.sooplive.com, export its cookies and import them on the SOOP page (Accounts → Import accounts).",
  );
  return lines.join("\n");
}

function backMessage({ total }) {
  return `✅ SOOP farm: ${total === 1 ? "its login is" : `all ${logins(total)} are`} accepted again.`;
}

function createLoginAlert({
  models,
  send,
  activity,
  waitMs = WAIT_MS,
  quietMs = QUIET_MS,
  maxWaitMs = MAX_WAIT_MS,
  now = Date.now,
} = {}) {
  const Account = () => (models && models.SoopAccount) || require("../../models/SoopAccount");
  // Required lazily: Telegram must never be able to stop the farm loading.
  const deliver = typeof send === "function" ? send : (text) => require("../telegram").sendTelegram(text);
  // What this process has seen and said, for a pass that cannot write the
  // database: the wait still runs, and a message is never sent twice.
  const seen = new Map(); // loginId -> first seen unusable (ms)
  const told = new Set(); // loginIds named in a "cannot farm" message
  const backSaid = new Set(); // loginIds a "works again" message covered
  let running = null;

  function note(level, msg) {
    try {
      if (activity) activity.add({ level, kind: "alert", msg });
    } catch {
      /* the log is never a reason to fail a pass */
    }
  }

  // The stamps make a restart harmless; losing one write only costs a repeat of
  // the wait, so a failed write is logged and the pass carries on.
  async function save(filter, set) {
    try {
      await Account().updateMany(filter, { $set: set });
    } catch (err) {
      console.error("soop login alert: could not save its stamps:", err.message);
    }
  }

  async function doPass() {
    const at = now();
    const rows = await Account().find({ sold: { $ne: true } }).select(FIELDS).lean();
    const down = rows.filter(unusable);
    const downIds = new Set(down.map((a) => a.loginId));
    for (const id of [...seen.keys()]) if (!downIds.has(id)) seen.delete(id);
    for (const id of [...told]) if (!downIds.has(id)) told.delete(id);
    for (const id of [...backSaid]) if (downIds.has(id)) backSaid.delete(id);

    // 1. Logins that work again. `untested` (a cookie just imported, its check
    //    still to come) proves nothing either way and is left alone.
    const healed = rows.filter((a) => a.status === "ok" && (a.unusableSince || a.unusableAlertAt));
    if (healed.length) {
      await save({ loginId: { $in: healed.map((a) => a.loginId) } }, { unusableSince: null, unusableAlertAt: null });
    }

    // 2. A cookie imported after the owner was told, and the login is unusable
    //    all the same: that is a new problem, and the one they most need to hear.
    for (const a of down) {
      if (!a.unusableAlertAt || ms(a.cookieAt) <= ms(a.unusableAlertAt)) continue;
      a.unusableSince = null;
      a.unusableAlertAt = null;
      seen.delete(a.loginId);
      told.delete(a.loginId);
      await save({ loginId: a.loginId }, { unusableSince: null, unusableAlertAt: null });
    }

    // 3. Newly unusable: note since when.
    for (const a of down) {
      if (a.unusableSince) continue;
      if (!seen.has(a.loginId)) seen.set(a.loginId, at);
      a.unusableSince = new Date(seen.get(a.loginId));
      await save({ loginId: a.loginId, unusableSince: null }, { unusableSince: a.unusableSince });
    }

    // 4. Everything is back, and the owner had been told otherwise. Held while
    //    a reported login is still waiting for its check, so it is said once.
    if (!down.length) {
      const owed = healed.some((a) => a.unusableAlertAt && !backSaid.has(a.loginId));
      const waiting = rows.some((a) => a.status !== "ok" && a.unusableAlertAt);
      if (!owed || waiting) return { sent: null, down: 0, pending: 0 };
      const text = backMessage({ total: rows.length });
      await deliver(text);
      for (const a of healed) backSaid.add(a.loginId);
      note("info", "Told the owner on Telegram: every login is accepted again");
      return { sent: "back", text, down: 0, pending: 0 };
    }

    // 5. Anyone the owner has not been told about, and has the batch settled?
    const fresh = down.filter((a) => !a.unusableAlertAt && !told.has(a.loginId));
    const result = { sent: null, down: down.length, pending: fresh.length };
    if (!fresh.length) return result;
    const ages = fresh.map((a) => at - ms(a.unusableSince));
    const oldest = Math.max(...ages);
    const due = oldest >= maxWaitMs || (oldest >= waitMs && Math.min(...ages) >= quietMs);
    if (!due) return result;

    const text = downMessage({ fresh, down, total: rows.length });
    await deliver(text); // a throw leaves nothing stamped, so the next pass tries again
    for (const a of fresh) told.add(a.loginId);
    await save({ loginId: { $in: fresh.map((a) => a.loginId) } }, { unusableAlertAt: new Date(at) });
    note("error", `Told the owner on Telegram: ${down.length} of ${logins(rows.length)} cannot farm`);
    return { ...result, sent: "down", text };
  }

  // Overlapping passes share one run.
  function pass() {
    if (!running) {
      running = doPass().finally(() => {
        running = null;
      });
    }
    return running;
  }

  return { pass };
}

module.exports = { createLoginAlert, downMessage, backMessage, WAIT_MS, QUIET_MS, MAX_WAIT_MS };
