// Periodic driver for SOOP cookie auto-renew.
//
// Scans SoopAccount rows that look dead (status drops_rejected / not_logged_in)
// and have a linked Twitch login, then calls farm.renewAccount(id). This
// catches the gap left by the reactive paths — accounts that haven't been
// health-probed since restart, or that lost their session while idle.
//
// Follows the project convention set by utils/eldoradoSessionRefresher.js:
// self-managed setTimeout loop, unref'd so it does not hold the process up on
// shutdown, 60s warm-up delay so the DB is up before the first tick.
//
// Serial per tick (not parallel) — the Pi SOCKS tunnel is single-threaded for
// our purposes and Twitch does not love burst traffic. ~15 s per account × 10
// per tick = ~2.5 min worst case; TICK_MS is 3 h so there is plenty of room.

const SoopAccount = require("../models/SoopAccount");
const TwitchWebCookie = require("../models/TwitchWebCookie");
const farm = require("./soopFarm");

const TICK_MS = parseInt(process.env.SOOP_COOKIE_REFRESH_MS || `${3 * 60 * 60 * 1000}`, 10);
const WARMUP_MS = parseInt(process.env.SOOP_COOKIE_REFRESH_WARMUP_MS || "60000", 10);
const MAX_PER_TICK = parseInt(process.env.SOOP_COOKIE_REFRESH_BATCH || "10", 10);

let started = false;

async function tick() {
  try {
    // Only act on accounts whose twitchLogin HAS a stored cookie jar — the
    // link field alone is not enough.
    const haveJar = (await TwitchWebCookie.find({}).select("twitchLogin").lean())
      .map((r) => (r.twitchLogin || "").trim().toLowerCase())
      .filter(Boolean);
    if (!haveJar.length) return scheduleNext();

    const candidates = await SoopAccount.find({
      status: { $in: ["drops_rejected", "not_logged_in", "dead"] },
      sold: { $ne: true },
      twitchLogin: { $in: haveJar },
    })
      .select("loginId twitchLogin")
      .limit(MAX_PER_TICK)
      .lean();

    if (!candidates.length) return scheduleNext();

    console.log(`[soop cookie refresher] tick: ${candidates.length} candidate(s)`);
    for (const c of candidates) {
      try {
        await farm.renewAccount(c.loginId, { reason: "periodic" });
      } catch (e) {
        console.error(`[soop cookie refresher] ${c.loginId}: ${e.message}`);
      }
    }
  } catch (e) {
    console.error("[soop cookie refresher] tick err:", e.message);
  }
  scheduleNext();
}

function scheduleNext() {
  const t = setTimeout(tick, TICK_MS);
  if (t.unref) t.unref();
}

function start() {
  if (started) return;
  started = true;
  const t = setTimeout(tick, WARMUP_MS);
  if (t.unref) t.unref();
  console.log(
    `[soop cookie refresher] scheduled (tick every ${(TICK_MS / 3600000).toFixed(1)}h, warmup ${(WARMUP_MS / 1000).toFixed(0)}s)`,
  );
}

module.exports = { start, _tick: tick };
