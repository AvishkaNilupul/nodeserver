/* global setInterval, clearInterval */
// SOOP account health (docs/SOOP-FARM-CONTRACT.md §9).
//
// Answers one question per account: can this login still farm drops? Two
// requests — "who am I" on the main site, then the missions list on the drops
// site, which validates the session separately.
//
// The rule that matters: only a DEFINITE answer from SOOP changes an account's
// status. A proxy that is down, a timeout or a garbled reply says nothing about
// the login, so it is recorded in `lastError` and nothing else — otherwise one
// tunnel blip during a sweep would mark the whole fleet dead and stop it farming.

const { isAuthError } = require("./errors");
const { plainMessage } = require("./errors");
const { createBatchRunner } = require("./inventory");

const MSG_LOGGED_OUT = "Logged out — re-import the cookie";
const MSG_DROPS_REJECTED =
  "The drops site rejected this session — re-export the cookie while logged in to drops.sooplive.com";

function createHealthService({
  models,
  getClient,
  activity,
  onDead,
  paceMs = 4000,
  everyMs = 6 * 3600 * 1000,
  now = Date.now,
} = {}) {
  if (typeof getClient !== "function") throw new TypeError("health service needs getClient");
  const Account = () => (models && models.SoopAccount) || require("../../models/SoopAccount");
  const inFlight = new Map();
  let interval = null;

  function note(entry) {
    try {
      if (activity) activity.add({ kind: "health", ...entry });
    } catch {
      /* the log is never a reason to fail a check */
    }
  }

  function fireDead(id, reason) {
    if (typeof onDead !== "function") return;
    try {
      const r = onDead(id, reason);
      if (r && typeof r.catch === "function") {
        r.catch((err) => console.error("soop health onDead error:", err.message));
      }
    } catch (err) {
      console.error("soop health onDead error:", err.message);
    }
  }

  async function doCheck(id) {
    const before = await Account().findOne({ loginId: id }).select("loginId status").lean();
    if (!before) throw Object.assign(new Error("account not found"), { code: "NOT_FOUND" });

    let info = null;
    let missions = [];
    let dropsError = null;
    try {
      const client = await getClient(id);
      info = (await client.privateInfo()) || {};
      if (info.loggedIn) {
        try {
          missions = (await client.missions()) || [];
        } catch (err) {
          if (!isAuthError(err)) throw err;
          dropsError = String(err.message || "drops site rejected the session").slice(0, 300);
        }
      }
    } catch (err) {
      // No definite answer: remember why, leave status / deadAt / lastCheckedAt alone.
      const lastError = String(plainMessage(err)).slice(0, 300);
      await Account().updateOne({ loginId: id }, { $set: { lastError } });
      throw err;
    }

    const at = new Date(now());
    const loggedIn = !!info.loggedIn;
    const status = !loggedIn ? "not_logged_in" : dropsError ? "drops_rejected" : "ok";
    const result = {
      at: at.toISOString(),
      loggedIn,
      nick: info.nick || null,
      country: info.country || null,
      dropsOk: loggedIn && !dropsError,
      dropsError,
      missions: missions.length,
    };
    const set = {
      status,
      lastCheckedAt: at,
      check: result,
      lastError: !loggedIn ? MSG_LOGGED_OUT : dropsError ? MSG_DROPS_REJECTED : "",
    };
    if (loggedIn) {
      set.deadAt = null; // the login works again (or still), whatever the drops site says
      if (info.nick) set.nickname = info.nick;
      if (info.country) set.country = info.country;
    }
    await Account().updateOne({ loginId: id }, { $set: set });

    if (!loggedIn) {
      // Stamping deadAt is the claim on "this death has been reported": only the
      // write that finds it empty raises onDead, so repeated checks, overlapping
      // checks and a restart all report one death once.
      const claim = await Account().updateOne({ loginId: id, deadAt: null }, { $set: { deadAt: at } });
      if (claim && claim.modifiedCount === 1) {
        note({ level: "error", accountId: id, msg: MSG_LOGGED_OUT });
        fireDead(id, "not_logged_in");
      }
    } else if (before.status !== status) {
      if (status === "ok") note({ accountId: id, msg: "Login check passed" });
      else note({ level: "warn", accountId: id, msg: MSG_DROPS_REJECTED });
    }
    return result;
  }

  // Overlapping checks of one account share a single round trip.
  function check(rawId) {
    const id = String(rawId || "");
    if (!id) return Promise.reject(new Error("no account given"));
    if (inFlight.has(id)) return inFlight.get(id);
    const p = doCheck(id).finally(() => inFlight.delete(id));
    inFlight.set(id, p);
    return p;
  }

  const batch = createBatchRunner({
    run: check,
    paceMs,
    now,
    onIdle: (s) => {
      if (!s.errors.length) return;
      note({
        level: "warn",
        msg: `Health check got no answer for ${s.errors.length} of ${s.total} account(s) — their status was left unchanged`,
        data: { codes: [...new Set(s.errors.map((e) => e.code))] },
      });
    },
  });

  // Sold accounts are no longer ours to probe.
  async function sweep() {
    if (batch.status().running) return;
    const armed = interval;
    const rows = await Account().find({ sold: { $ne: true } }).select("loginId").lean();
    if (!armed || interval !== armed) return; // stop() landed while the list was loading
    batch.enqueue(rows.map((r) => r.loginId));
  }

  function start() {
    if (interval) return;
    interval = setInterval(() => {
      sweep().catch((err) => console.error("soop health sweep error:", err.message));
    }, Math.max(1, Number(everyMs) || 1));
    if (interval.unref) interval.unref();
  }

  function stop() {
    if (interval) clearInterval(interval);
    interval = null;
    batch.cancel();
  }

  return {
    check,
    checkMany: (ids) => batch.enqueue(ids),
    status: () => batch.status(),
    start,
    stop,
  };
}

module.exports = { createHealthService };
