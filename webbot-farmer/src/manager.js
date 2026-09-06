// Multi-account orchestrator. Reads WebBotAccount rows from Mongo and farms
// them through a bounded worker pool: at most `maxConcurrent` accounts watch
// at once, each for one channel-lease, then the account is requeued and the
// freed slot goes to whoever has been waiting longest. Progress is written
// back to Mongo so nodeserver admin views can render it.
//
// Why a pool instead of `Promise.all` over every row: with hundreds of
// accounts, launching them all at once floods Twitch's GQL/spade/usher
// endpoints in the same instant (and keeps every worker's 20s/60s ping phase
// aligned, so the flood repeats forever). The pool caps how many farm
// simultaneously and staggers launches, which also permanently de-syncs the
// ping phases. When the cap is >= the number of live accounts, every account
// farms continuously just like before — the cap only rotates when there are
// more accounts than slots.

import { makeSession, validate, getInventory } from "./twitch.js";
import { watchChannel } from "./watcher.js";
import { pickGame } from "./autoPicker.js";
import { createChannelPool, channelsFilePath, doneCampaignsFromInventory } from "./channelPool.js";
import {
  connect as mongoConnect,
  loadActiveAccounts,
  writeState,
  bumpClaim,
} from "./mongoStore.js";

// Fresh channel every N minutes even if progress is fine — protects against
// a streamer going offline mid-farm, and rotates load off any one channel.
// Also bounds a single pool "turn" so slots free up for other accounts.
const CHANNEL_LEASE_MINUTES = 30;

// How many accounts may farm at the same time. A safe default for one box;
// override with --max-concurrent / WEBBOT_MAX_CONCURRENT. Set it >= your
// account count to farm everyone continuously (no rotation).
const DEFAULT_MAX_CONCURRENT = 25;

// Gap between launching successive workers. Spreads the startup burst and
// keeps each worker's ping phase offset from its neighbours.
const LAUNCH_STAGGER_MS = 400;

// Per-account cooldowns before an account is eligible for another turn.
const IDLE_BACKOFF_MS = 5 * 60 * 1000; // nothing to farm
const NO_CHANNEL_BACKOFF_MS = 2 * 60 * 1000; // game had no live channel
const ERROR_BACKOFF_MS = 60 * 1000; // watch threw

// No-session rotation: leave a channel that has shown "no active drop-session"
// (and no credited minute) for this long and re-pick, avoiding it — the
// channel is not crediting (typically outside the campaign's ACL). Once per
// turn. Env WEBBOT_NO_SESSION_EXIT_MS overrides; 0 disables.
const DEFAULT_NO_SESSION_EXIT_MS = 10 * 60 * 1000;
const NO_SESSION_EXIT_MS = (() => {
  const raw = process.env.WEBBOT_NO_SESSION_EXIT_MS;
  if (raw === undefined || raw === "") return DEFAULT_NO_SESSION_EXIT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_NO_SESSION_EXIT_MS;
})();

const log = (msg, extra) => {
  const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  extra !== undefined
    ? console.log(`[${stamp}] [mgr] ${msg}`, extra)
    : console.log(`[${stamp}] [mgr] ${msg}`);
};

function priorityGamesFromEnv() {
  const raw = (process.env.WEBBOT_PRIORITY_GAMES || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveMaxConcurrent(explicit) {
  const fromEnv = Number(process.env.WEBBOT_MAX_CONCURRENT);
  const n = explicit || (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 0) || DEFAULT_MAX_CONCURRENT;
  return Math.max(1, Math.floor(n));
}

// One farming turn for a single account: validate → pick game → pick channel
// → watch for up to one channel-lease → return. The return value is the
// backoff (ms) the pool waits before this account is eligible again, or
// `null` to drop it from rotation entirely (dead token). Keeping every turn
// bounded is what lets the pool cap concurrency without starving the tail.
async function farmTurn(row, priorityGames, stopSignal, channelPool) {
  const label = row.login || row.webToken.slice(-6);
  const session = makeSession({ token: row.webToken });

  try {
    await validate(session);
  } catch (e) {
    log(`[${label}] validate failed → dropping from rotation: ${e.message}`);
    await writeState(row.webToken, { lastStatus: "dead", lastStatusMessage: e.message });
    return null;
  }
  await writeState(row.webToken, {
    login: session.login,
    twitchId: session.userId,
  });

  // 1. Pick game
  let target;
  if (row.pinnedGame) {
    target = { game: row.pinnedGame, source: "pinned" };
  } else {
    try {
      target = await pickGame(session, priorityGames);
    } catch (e) {
      log(`[${label}] pickGame threw: ${e.message}`);
    }
  }
  if (!target) {
    log(`[${label}] no game to farm — backing off ${IDLE_BACKOFF_MS / 60000}m`);
    await writeState(row.webToken, {
      lastStatus: "idle",
      lastStatusMessage: "no in-progress drops and no priority match",
      currentGame: "",
      currentChannel: "",
    });
    return IDLE_BACKOFF_MS;
  }

  // 1b. Per-account campaign exclusion (pinned path only — pickGame already
  // chose a game with unfinished drops). One inventory read per turn: the
  // campaigns of the pinned game this account has fully earned are excluded
  // from channel selection, so a live official channel that only credits a
  // campaign this account finished does not attract it. A failed read means
  // no exclusion (fail toward farming).
  let doneCampaigns = [];
  if (target.source === "pinned") {
    try {
      doneCampaigns = doneCampaignsFromInventory(await getInventory(session), target.game);
    } catch (e) {
      log(`[${label}] getInventory threw (no campaign exclusion this turn): ${e.message}`);
      doneCampaigns = [];
    }
  }
  const noChannelBackoff = async (suffix = "") => {
    const done = channelPool.source?.(target.game, { doneCampaigns }) === "done";
    if (done) {
      log(`[${label}] every live campaign of ${target.game} already complete${suffix} — backing off ${NO_CHANNEL_BACKOFF_MS / 60000}m`);
    } else {
      log(`[${label}] no live channel for ${target.game}${suffix} — backing off ${NO_CHANNEL_BACKOFF_MS / 60000}m`);
    }
    await writeState(row.webToken, {
      lastStatus: done ? "idle" : "attaching",
      lastStatusMessage: done
        ? `every live campaign of ${target.game} already complete`
        : `no live channel for ${target.game}`,
      currentGame: target.game,
      currentChannel: "",
    });
    return NO_CHANNEL_BACKOFF_MS;
  };

  // 2. Pick channel — round-robin across the game's live drops channels so
  // accounts spread out instead of all landing on the single top stream.
  let channel;
  try {
    channel = await channelPool.next(session, target.game, { doneCampaigns });
  } catch (e) {
    log(`[${label}] pickChannel(${target.game}) threw: ${e.message}`);
  }
  if (!channel) return noChannelBackoff();

  // 3. Watch — bounded to a channel-lease so the slot frees for others. At
  // most ONE no-session rotation per turn: if the channel never attaches a
  // drop session for NO_SESSION_EXIT_MS we re-pick once, avoiding it; a second
  // no-session exit ends the turn normally (lease semantics unchanged).
  let rotated = false;
  while (true) {
    log(
      `[${label}] farming ${target.game} via ${channel.login} ` +
        `(${channel.viewers}v, drops=${channel.hasDropTag}${channel.fromAcl ? ", acl" : ""}, src=${target.source})`,
    );
    await writeState(row.webToken, {
      lastStatus: "attaching",
      lastStatusMessage: "watching",
      currentGame: target.game,
      currentChannel: channel.login,
    });

    let result;
    try {
      result = await watchChannel(session, channel.login, {
        maxMinutes: CHANNEL_LEASE_MINUTES,
        stopSignal,
        noSessionExitMs: NO_SESSION_EXIT_MS,
        // Seed from the recorded flag so a known-blocked account never even
        // attempts a claim on its first tick.
        claimBlocked: !!row.claimBlocked,
        onProgress: async ({ currentSession, minutesWatched, readyUnclaimed, claimBlocked }) => {
          // Remember it in-memory so this account's later turns skip claims too.
          if (claimBlocked) row.claimBlocked = true;
          const drop = currentSession?.dropID;
          const patch = {
            lastStatus: drop ? "ok" : "attaching",
            lastStatusMessage: drop
              ? `${currentSession.currentMinutesWatched}/${currentSession.requiredMinutesWatched} on ${currentSession.channel?.displayName || channel.login}` +
                (readyUnclaimed ? ` · ${readyUnclaimed} ready, needs external claim` : "")
              : "spade pinging, no drop-session attached yet",
            currentDropId: drop || "",
            currentMinutes: currentSession?.currentMinutesWatched || 0,
            requiredMinutes: currentSession?.requiredMinutesWatched || 0,
            totalMinutesWatched: (row.totalMinutesWatched || 0) + minutesWatched,
            dropsReadyUnclaimed: readyUnclaimed || 0,
            claimBlocked: !!claimBlocked,
          };
          await writeState(row.webToken, patch);
        },
        onClaim: async ({ ok, drop, campaign }) => {
          if (ok) {
            await bumpClaim(row.webToken);
            log(`[${label}] claimed: ${campaign} / ${drop}`);
          } else {
            log(`[${label}] claim FAILED: ${campaign} / ${drop}`);
          }
        },
      });
    } catch (e) {
      log(`[${label}] watch threw: ${e.message} — backing off ${ERROR_BACKOFF_MS / 1000}s`);
      await writeState(row.webToken, {
        lastStatus: "error",
        lastStatusMessage: e.message,
      });
      return ERROR_BACKOFF_MS;
    }

    if (result?.reason !== "no-session" || rotated || stopSignal?.stopped) {
      // Lease ended cleanly — eligible for another turn immediately (re-pick).
      return 0;
    }

    rotated = true;
    const left = channel.login;
    log(`[${label}] no drop session on ${left} for ${Math.round(NO_SESSION_EXIT_MS / 60000)}m — rotating`);
    let nextChannel = null;
    try {
      nextChannel = await channelPool.next(session, target.game, { avoid: [left], doneCampaigns });
    } catch (e) {
      log(`[${label}] pickChannel(${target.game}) threw on rotation: ${e.message}`);
    }
    if (!nextChannel) return noChannelBackoff(" after rotation");
    channel = nextChannel;
  }
}

// Bounded worker pool. Holds at most `cap` turns in flight; refills freed
// slots with the ready account that has been waiting longest. Dead accounts
// (farmTurn → null) leave the rotation. Exits when stopped or when every
// account has dropped out.
async function runPool(rows, cap, priorityGames, stopSignal, channelPool) {
  const byToken = new Map(rows.map((r) => [r.webToken, r]));
  const eligibleAt = new Map(rows.map((r) => [r.webToken, 0])); // token → ts; delete to drop
  const running = new Set(); // tokens with a turn in flight
  const inFlight = new Set(); // the turn promises

  const startTurn = (token) => {
    running.add(token);
    const p = (async () => {
      let backoff = ERROR_BACKOFF_MS;
      try {
        backoff = await farmTurn(byToken.get(token), priorityGames, stopSignal, channelPool);
      } catch (e) {
        log(`[${token.slice(-6)}] pool turn crashed: ${e.message}`);
      } finally {
        running.delete(token);
        inFlight.delete(p);
        if (backoff === null) {
          eligibleAt.delete(token); // dead token → out of rotation
        } else {
          eligibleAt.set(token, Date.now() + backoff);
        }
      }
    })();
    inFlight.add(p);
  };

  // Longest-waiting ready account (smallest eligibleAt not already running).
  const pickReady = () => {
    const now = Date.now();
    let pick = null;
    let pickTs = Infinity;
    for (const [token, ts] of eligibleAt) {
      if (running.has(token) || ts > now) continue;
      if (ts < pickTs) {
        pick = token;
        pickTs = ts;
      }
    }
    return pick;
  };

  while (!stopSignal.stopped) {
    // Fill open slots, staggered.
    while (running.size < cap && !stopSignal.stopped) {
      const token = pickReady();
      if (token === null) break; // nothing ready this instant
      startTurn(token);
      if (LAUNCH_STAGGER_MS) await sleep(LAUNCH_STAGGER_MS);
    }

    if (eligibleAt.size === 0) {
      log("all accounts dropped out (dead tokens) — nothing left to farm");
      break;
    }

    // Wake on the next slot freeing, or after 1s to catch expired backoffs.
    if (inFlight.size) await Promise.race([Promise.race(inFlight), sleep(1000)]);
    else await sleep(1000);
  }

  await Promise.allSettled(inFlight);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Run the farming pool over a set of already-loaded account rows. Separated
// from runManager so a load-test harness (or any other caller) can drive the
// exact same pool without a Mongo round trip. `rows` are plain objects with at
// least { webToken }; optional { login, pinnedGame, claimBlocked,
// totalMinutesWatched }. `stopSignal` is a shared { stopped } object.
export async function farmAccounts({ rows, priorityGames = [], maxConcurrent, stopSignal } = {}) {
  if (!rows?.length) {
    log("farmAccounts: no rows — nothing to do");
    return;
  }
  const cap = resolveMaxConcurrent(maxConcurrent);
  log(
    cap >= rows.length
      ? `max-concurrent ${cap} >= ${rows.length} accounts — all farm continuously`
      : `max-concurrent ${cap} — ${rows.length} accounts rotate through ${cap} slots`,
  );
  log(
    `channels file: ${channelsFilePath()} (server ACL hints; missing/stale = community discovery) · ` +
      `no-session rotation: ${NO_SESSION_EXIT_MS ? `${Math.round(NO_SESSION_EXIT_MS / 60000)}m` : "off"}`,
  );
  const channelPool = createChannelPool();
  await runPool(rows, cap, priorityGames, stopSignal, channelPool);
}

export async function runManager({ mongoUri, priorityGames, maxConcurrent, metrics } = {}) {
  const useMetrics = metrics || process.env.WEBBOT_METRICS === "1";
  let reporter = null;
  let formatReport = null;
  if (useMetrics) {
    const m = await import("./metrics.js");
    m.installMetrics();
    formatReport = m.formatReport;
    reporter = setInterval(() => log("metrics ·\n" + formatReport()), 60_000);
    reporter.unref?.(); // don't keep the process alive just for the report timer
  }

  await mongoConnect(mongoUri);
  const rows = await loadActiveAccounts();
  log(`loaded ${rows.length} active accounts`);
  if (!rows.length) {
    log(`no accounts — nothing to do. Use --import-file <path> to seed.`);
    if (reporter) clearInterval(reporter);
    return;
  }

  const games = priorityGames && priorityGames.length ? priorityGames : priorityGamesFromEnv();
  if (games.length) log(`priority games: ${games.join(", ")}`);
  else log(`no priority games set (env WEBBOT_PRIORITY_GAMES) — pinned-only mode`);

  const stopSignal = { stopped: false };
  const stop = () => {
    stopSignal.stopped = true;
    log("shutdown signal");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  await farmAccounts({ rows, priorityGames: games, maxConcurrent, stopSignal });

  if (reporter) clearInterval(reporter);
  if (formatReport) log("final metrics ·\n" + formatReport());
  log("all workers exited");
}
