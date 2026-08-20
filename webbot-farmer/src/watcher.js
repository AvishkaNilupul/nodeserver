import { getChannelShell, getInventory, getDropCurrentSession, claimDrop } from "./twitch.js";
import { sendMinuteWatched, makePlaySessionId } from "./spade.js";
import { fetchMasterPlaylist, pingVariant } from "./playback.js";

const SPADE_INTERVAL_MS = 20_000;
const PLAYLIST_INTERVAL_MS = 60_000;
const PROGRESS_INTERVAL_MS = 60_000;

const log = (msg, obj) => {
  const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
  if (obj !== undefined) {
    console.log(`[${stamp}] ${msg}`, obj);
  } else {
    console.log(`[${stamp}] ${msg}`);
  }
};

async function resolveChannel(session, login) {
  const res = await getChannelShell(session, login);
  const user = res?.data?.user;
  if (!user) throw new Error(`channel not found: ${login}`);
  if (!user.stream) throw new Error(`channel is offline: ${login}`);
  return {
    userId: user.id,
    login: user.login,
    displayName: user.displayName,
    broadcastId: user.stream.id,
    gameId: user.stream.game?.id,
    gameName: user.stream.game?.displayName || "",
  };
}

async function attachPlayback(session, login) {
  const { variants } = await fetchMasterPlaylist(session, login);
  if (!variants.length) throw new Error("no playlist variants returned");
  return variants[0];
}

function summarizeInventory(inv) {
  const progress = inv?.data?.currentUser?.inventory?.dropCampaignsInProgress || [];
  const rows = [];
  for (const c of progress) {
    for (const d of c.timeBasedDrops || []) {
      rows.push({
        campaign: c.name,
        game: c.game?.displayName || "",
        drop: d.name,
        minutes: `${d.self?.currentMinutesWatched ?? 0}/${d.requiredMinutesWatched}`,
        claimed: !!d.self?.isClaimed,
        instance: d.self?.dropInstanceID || null,
      });
    }
  }
  return rows;
}

// Drops that are ready to claim: complete, have an instance id, not yet
// claimed. Kept separate from the claim mutation so we can still *report*
// "ready but unclaimed" even when this token can't clear the claim gate.
function readyToClaim(inv) {
  const progress = inv?.data?.currentUser?.inventory?.dropCampaignsInProgress || [];
  const ready = [];
  for (const c of progress) {
    for (const d of c.timeBasedDrops || []) {
      const s = d.self;
      if (!s?.dropInstanceID) continue;
      if (s.isClaimed) continue;
      if ((s.currentMinutesWatched || 0) < (d.requiredMinutesWatched || Infinity)) continue;
      ready.push({
        drop: d.name,
        campaign: c.name,
        game: c.game?.displayName || "",
        dropInstanceID: s.dropInstanceID,
      });
    }
  }
  return ready;
}

function isIntegrityError(res) {
  return (res?.errors || []).some(
    (e) => e?.extensions?.code === "IntegrityCheckFailed" || /integrity/i.test(e?.message || ""),
  );
}

// Attempt to claim every ready drop. Web-client OAuth tokens CANNOT clear
// Twitch's integrity gate on ClaimDropRewards — it returns IntegrityCheckFailed.
// When we hit that, we stop (every remaining attempt fails identically) and
// return `integrityBlocked` so the caller flips to farm-only and records the
// drops as "ready, needs an external/integrity-valid claim".
async function claimReady(session, ready, onClaim) {
  const claims = [];
  let integrityBlocked = false;
  for (const r of ready) {
    log(`claiming: ${r.campaign} → ${r.drop} (${r.dropInstanceID})`);
    const res = await claimDrop(session, r.dropInstanceID);
    if (isIntegrityError(res)) {
      integrityBlocked = true;
      log("  claim blocked: web token can't clear the integrity gate on ClaimDropRewards");
      break; // the rest fail the same way — leave them for an external claim
    }
    const ok = !res?.errors && !!res?.data?.claimDropRewards;
    if (res?.errors) log("  claim errors:", JSON.stringify(res.errors));
    else log("  claim result:", JSON.stringify(res?.data));
    claims.push({ drop: r.drop, campaign: r.campaign, game: r.game, ok });
    if (onClaim) {
      try {
        await onClaim({ drop: r.drop, campaign: r.campaign, game: r.game, ok });
      } catch (e) {
        log("  onClaim callback threw:", e.message);
      }
    }
  }
  return { claims, integrityBlocked };
}

export async function watchChannel(session, channelLogin, opts = {}) {
  const maxMinutes = opts.maxMinutes || 0;
  const verbose = !!opts.verbose;
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const onClaim = typeof opts.onClaim === "function" ? opts.onClaim : null;
  const stopSignal = opts.stopSignal || null; // { stopped: boolean }
  const startedAt = Date.now();
  const playSessionId = makePlaySessionId();

  const channel = await resolveChannel(session, channelLogin);
  log(`resolved: ${channel.displayName} — ${channel.gameName} (broadcast ${channel.broadcastId}, game_id ${channel.gameId})`);
  log(`play_session_id: ${playSessionId}`);

  let variant = await attachPlayback(session, channelLogin);
  log(`playlist variant: ${variant.resolution || "?"} @ ${variant.bandwidth} bps`);

  // initial snapshot
  const inv0 = await getInventory(session);
  const rows = summarizeInventory(inv0);
  if (rows.length) {
    log("in-progress drops:");
    for (const r of rows) log(`  · ${r.game} | ${r.drop} — ${r.minutes} ${r.claimed ? "(claimed)" : ""}`);
  } else {
    log("in-progress drops: none — bot will still try to farm the game this channel is streaming");
  }

  let lastSpade = 0;
  let lastPlaylist = Date.now();
  let lastProgress = 0;
  let stopping = false;
  // Once we learn this token can't clear the claim integrity gate, we stop
  // attempting claims entirely (farm-only). The manager can seed this from a
  // previously-recorded WebBotAccount.claimBlocked so we never even try.
  let claimBlocked = !!opts.claimBlocked;

  const stop = () => {
    stopping = true;
    log("stopping (signal)");
  };
  // Only handle signals in standalone single-account mode. In managed mode the
  // manager owns shutdown via stopSignal; attaching a handler per watchChannel
  // call would leak listeners across many accounts and rotations.
  if (!stopSignal) {
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  }

  while (!stopping) {
    const now = Date.now();

    if (now - lastSpade >= SPADE_INTERVAL_MS) {
      const r = await sendMinuteWatched({
        session,
        channelId: channel.userId,
        channelLogin: channel.login,
        broadcastId: channel.broadcastId,
        gameId: channel.gameId,
        gameName: channel.gameName,
        playSessionId,
      });
      if (!r.ok || verbose) {
        log(`spade ping: ${r.status}${r.body ? ` body=${r.body.slice(0, 120)}` : ""}`);
      }
      lastSpade = now;
    }

    if (now - lastPlaylist >= PLAYLIST_INTERVAL_MS) {
      const r = await pingVariant(session, variant.url);
      if (!r.ok) {
        log(`variant ${r.status} — refetching master playlist`);
        try {
          variant = await attachPlayback(session, channelLogin);
        } catch (e) {
          log("re-attach failed:", e.message);
        }
      }
      lastPlaylist = now;
    }

    if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
      const sess = await getDropCurrentSession(session, channel.userId, channel.login);
      const cur = sess?.data?.currentUser?.dropCurrentSession;
      if (cur && cur.dropID) {
        log(
          `progress → drop ${cur.dropID.slice(0, 8)}… ` +
            `${cur.currentMinutesWatched}/${cur.requiredMinutesWatched} min ` +
            `(channel ${cur.channel?.displayName || "?"})`,
        );
      } else if (verbose) {
        log("progress → no active drop-session — raw:", JSON.stringify(sess));
      } else {
        log("progress → no active drop-session on this channel yet");
      }

      // ALSO poll inventory — if spade is being credited on a game the
      // account is opted into, the campaign will appear here even before
      // dropCurrentSession attaches.
      const inv = await getInventory(session);
      const rows = summarizeInventory(inv);
      if (rows.length) {
        for (const r of rows) log(`  inv · ${r.game} | ${r.drop} — ${r.minutes} ${r.claimed ? "✓" : ""}`);
      }
      // Claim ready drops (reusing the inventory we just fetched). Skip
      // entirely once integrity-blocked — every retry would fail identically.
      const ready = readyToClaim(inv);
      let readyUnclaimed = ready.length;
      if (ready.length && !claimBlocked) {
        const { claims, integrityBlocked } = await claimReady(session, ready, onClaim);
        readyUnclaimed = ready.length - claims.filter((c) => c.ok).length;
        if (integrityBlocked) {
          claimBlocked = true;
          log(
            `claim integrity-gated — ${readyUnclaimed} drop(s) ready but unclaimable with a web ` +
              `token; leaving for external claim, will not retry`,
          );
        }
      } else if (ready.length && verbose) {
        log(`${ready.length} drop(s) ready but claim is integrity-blocked — skipping`);
      }

      if (onProgress) {
        try {
          await onProgress({
            channel,
            currentSession: cur,
            inventory: rows,
            readyUnclaimed,
            claimBlocked,
            minutesWatched: Math.floor((now - startedAt) / 60000),
          });
        } catch (e) {
          log("onProgress callback threw:", e.message);
        }
      }
      lastProgress = now;
    }

    if (stopSignal?.stopped) {
      log("stopping (stopSignal)");
      break;
    }

    if (maxMinutes > 0 && (now - startedAt) / 60000 >= maxMinutes) {
      log(`max-minutes reached (${maxMinutes}) — stopping`);
      break;
    }

    await sleep(1000);
  }

  log("watcher exit");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
