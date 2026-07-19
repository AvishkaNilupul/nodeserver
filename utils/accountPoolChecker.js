// Auto-verifies newly-imported account-pool entries against Twitch instead of
// requiring a manual "Check" click per row — same fetchInventory call and
// lastCheckAt/lastCheckStatus bookkeeping the manual button uses (see
// routes/accountPoolRoutes.js's /:id/check), just queued and drained in the
// background so importing hundreds of accounts at once doesn't fire that many
// concurrent requests at Twitch.
//
// The draining is split across machines. The server always runs one worker; in
// addition, each configured remote bot host (a Raspberry Pi, an Android phone,
// …) runs its own worker that makes the very same Twitch calls *from that host*
// over SSH + curl (see utils/twitchInventory.js's host transport). All workers
// pull from one shared queue, so the pool is checked faster AND the Twitch
// traffic is spread across several IPs instead of hammering everything from the
// server's one address. Each worker keeps its own CHECK_DELAY_MS pace, so the
// per-IP request rate is unchanged — only the aggregate throughput goes up.
//
// A remote host can vanish at any instant (a Pi gets unplugged, a phone drops
// off Wi-Fi), so the split is built to treat that as normal, not an error:
//   - a host is probed before it's given any account, and skipped if it's down;
//   - a "couldn't reach Twitch through this host" failure (.transportFailed)
//     never writes a status onto the account — the account is put back on the
//     queue and the server worker finishes it;
//   - the worker whose host just died retires for the rest of the run instead
//     of spinning through the remaining accounts re-failing against a dead host.
// The server worker alone is always enough to drain the whole queue, so losing
// every remote host only makes the sweep slower, never wrong and never stuck.
const AvailableAccount = require("../models/AvailableAccount");
const dropScanner = require("./dropScanner");
const botHosts = require("./botHosts");
const { fetchInventory, fetchDropCampaigns } = require("./twitchInventory");

const CHECK_DELAY_MS = Number(process.env.ACCOUNT_POOL_CHECK_DELAY_MS) || 1200;

const queue = [];
// Ids queued or currently in flight. Without this an id can be queued twice —
// kicking off a sweep while one is already draining would re-check every
// account and fire double the requests at Twitch. An id is only released once
// its check finishes, so the one being checked right now can't be re-queued
// underneath the drain either. (A transport-failed id is intentionally NOT
// released — it's requeued while still "owned" so another worker takes it up
// without a concurrent import re-adding it.)
const queued = new Set();
const state = { running: false, checked: 0, total: 0 };
let coordinating = false;
// Host ids helping with the current run, for the status endpoint / UI.
let activeHosts = [];

// Which remote hosts help the server scan. Defaults to every configured remote
// host; a host that's actually offline is filtered out at run time, and any
// host that lacks curl simply transport-fails and retires, so the default is
// safe even for a host that can't help. Override with ACCOUNT_POOL_SCAN_HOSTS:
// a comma-separated list of host ids to restrict to, or "none"/"off"/"local"
// to keep all scanning on the server.
function resolveScanHosts() {
  const raw = (process.env.ACCOUNT_POOL_SCAN_HOSTS || "").trim();
  if (/^(none|off|local)$/i.test(raw)) return [];
  const remoteIds = botHosts
    .listHosts()
    .map((h) => h.id)
    .filter((id) => id !== "local");
  let ids = remoteIds;
  if (raw) {
    const want = new Set(
      raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    );
    ids = remoteIds.filter((id) => want.has(id.toLowerCase()));
  }
  // resolveHost returns the full host object (with the ssh block) that the
  // twitchInventory host transport needs; listHosts only returns descriptors.
  return ids.map((id) => botHosts.resolveHost(id)).filter(Boolean);
}

// Cheap "is this host up right now" probe before we commit accounts to it, so a
// powered-off Pi is skipped up front rather than failing the first account.
async function hostReachable(host) {
  try {
    await botHosts.runShell(host, "true", { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

// Inventory succeeding only proves the token authenticates. The bot's own drops
// query (ViewerDropsDashboard) is integrity-gated, and a supplier token that
// never went through device-auth passes Inventory and fails that gate — which
// is how an account used to sit here badged "verified · 0 drops" while every
// bot it was handed to logged "failed integrity check". So check the gate the
// bot actually uses.
//
// Only a genuine integrity rejection downgrades the account: a network blip or
// rate-limit here shouldn't mark an otherwise-good token unusable, so anything
// else is treated as "still ok" and left for the next sweep to retry. A remote
// scan host being unreachable (.transportFailed) is re-thrown so the worker can
// requeue the account rather than falsely passing it on a call that never ran.
async function checkIntegrity(token, host) {
  try {
    await fetchDropCampaigns(token, { host });
    return { ok: true, message: "" };
  } catch (e) {
    if (e.transportFailed) throw e;
    if (e.code === "integrity_failed") {
      return { ok: false, message: (e.message || String(e)).slice(0, 300) };
    }
    return { ok: true, message: "" };
  }
}

// Check one account, optionally routing the Twitch calls through a remote host.
// A .transportFailed error (the host went away) propagates out untouched and
// with NO write to the account — the caller requeues it. Every other outcome,
// including a real Twitch rejection, is recorded on the row exactly as the
// server-only path always did.
async function checkOne(id, host) {
  const acc = await AvailableAccount.findById(id);
  if (!acc || !acc.clientSecret) return;
  const now = new Date();

  let inv;
  try {
    inv = await fetchInventory(acc.clientSecret, { host });
  } catch (e) {
    if (e.transportFailed) throw e;
    acc.lastCheckAt = now;
    acc.lastCheckStatus =
      e.code === "token_invalid"
        ? "token_invalid"
        : e.code === "integrity_failed"
          ? "integrity_failed"
          : "error";
    acc.lastCheckError = (e.message || String(e)).slice(0, 300);
    await acc.save();
    return;
  }

  // Inventory passed. Verify the integrity-gated query too; this may itself
  // transport-fail (host died between the two calls), which throws before any
  // save so the account is left exactly as it was for a clean retry elsewhere.
  if (inv.twitchId) acc.twitchId = inv.twitchId;
  acc.dropCount = inv.drops.length;
  const integrity = await checkIntegrity(acc.clientSecret, host);
  acc.lastCheckAt = now;
  acc.lastCheckStatus = integrity.ok ? "ok" : "integrity_failed";
  acc.lastCheckError = integrity.ok ? "" : integrity.message;
  // Best-effort — a drops-archive write hiccup shouldn't fail the check itself
  // (the account is still verified either way).
  await dropScanner
    .upsertDrops(acc._id, "AvailableAccount", acc.username, inv.drops)
    .catch((e) =>
      console.error(
        "accountPoolChecker: drop-archive upsert failed for",
        id,
        e.message,
      ),
    );
  await acc.save();
}

// One draining worker. `host` is null for the server (axios) worker or a host
// object for a remote (curl-over-SSH) worker. Returns when the queue is drained
// or — for a remote worker — the moment its host stops responding, so a dead
// host can't hold up the sweep. `retired` collects host ids that died this run
// so the coordinator won't respawn them.
async function runWorker(label, host, retired) {
  while (queue.length) {
    const id = queue.shift();
    if (id === undefined) break;
    try {
      await checkOne(id, host);
      queued.delete(id);
      state.checked++;
    } catch (err) {
      if (err && err.transportFailed) {
        // The scan host vanished mid-check. Hand the account back (still
        // "owned", so no double-queue) for the server worker, and stop this
        // worker rather than re-failing every remaining account against it.
        queue.unshift(id);
        if (host) retired.add(host.id);
        console.warn(
          "accountPoolChecker: scan host " +
            label +
            " unreachable, retiring its worker; " +
            queue.length +
            " account(s) left for the remaining workers",
        );
        return;
      }
      // A real per-account failure was already recorded on the row by checkOne.
      queued.delete(id);
      state.checked++;
      console.error("accountPoolChecker: check failed for", id, err.message);
    }
    // Pace each worker independently; per-IP rate is unchanged, only aggregate
    // throughput rises with more workers.
    if (queue.length) await new Promise((r) => setTimeout(r, CHECK_DELAY_MS));
  }
}

async function drain() {
  if (coordinating) return;
  coordinating = true;
  state.running = true;
  // Host ids that died during THIS run — skip them on later passes so we don't
  // re-probe a host that just went offline over and over.
  const retired = new Set();
  try {
    do {
      // Pick the reachable helper hosts for this pass. A host that's off, or
      // that died and retired earlier in the run, is left out; everything it
      // would have checked simply flows to the server worker.
      const hosts = [];
      for (const host of resolveScanHosts()) {
        if (retired.has(host.id)) continue;
        if (await hostReachable(host)) hosts.push(host);
        else retired.add(host.id);
      }
      activeHosts = hosts.map((h) => h.id);
      const workers = [runWorker("local", null, retired)];
      for (const host of hosts) {
        workers.push(runWorker(host.label || host.id, host, retired));
      }
      await Promise.all(workers);
      // Loop again if a retiring remote worker requeued an account after the
      // server worker had already drained to empty (a narrow timing window).
    } while (queue.length);
  } finally {
    activeHosts = [];
    state.running = false;
    coordinating = false;
  }
}

// Queues account ids for a background auth check, skipping any already queued
// or in flight (deduped within the batch too, not just against the queue).
// Starting a fresh batch (queue was empty and idle) resets the progress
// counters so the UI's "checked/total" reads as this batch's progress, not a
// lifetime tally. Returns how many were actually queued, so callers can report
// the real number rather than what they asked for.
function enqueue(ids) {
  const fresh = [];
  for (const raw of ids || []) {
    if (!raw) continue;
    const id = String(raw);
    if (queued.has(id)) continue;
    queued.add(id);
    fresh.push(id);
  }
  if (!fresh.length) return 0;
  if (!queue.length && !coordinating) {
    state.checked = 0;
    state.total = 0;
  }
  queue.push(...fresh);
  state.total += fresh.length;
  drain().catch(() => {});
  return fresh.length;
}

function status() {
  return {
    running: state.running,
    queued: queue.length,
    checked: state.checked,
    total: state.total,
    // Remote hosts currently sharing the scan with the server (e.g. ["pi"]);
    // empty when everything is running on the server alone.
    scanHosts: activeHosts.slice(),
  };
}

module.exports = { enqueue, status };
