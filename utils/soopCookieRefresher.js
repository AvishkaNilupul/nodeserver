// Periodic driver for SOOP cookie auto-renew.
//
// Scans accounts that look dead (status drops_rejected / not_logged_in) and
// have a linked Twitch login, then calls farm.renewAccount(id). This catches
// the gap left by the reactive hook in checkAccount — accounts that haven't
// been health-probed since restart, or that lost their session while idle.
//
// Follows the project convention set by utils/eldoradoSessionRefresher.js:
// self-managed setTimeout loop, unref'd so it doesn't hold the process up on
// shutdown, 50s warm-up delay so the DB is up before the first tick.
//
// No-op when the residential proxy credentials aren't set (prod with the proxy
// unconfigured would just hammer the DB for no reason).

const SoopAccount = require("../models/SoopAccount");
const farm = require("./soopFarm");
const twitchOauth = require("./twitchOauthRefresher");

const TICK_MS = parseInt(
  process.env.SOOP_COOKIE_REFRESH_MS || `${3 * 60 * 60 * 1000}`,
  10,
); // every 3h
const WARMUP_MS = 50 * 1000;
const MAX_PER_TICK = 10; // cap concurrency per sweep so one bad batch doesn't eat an hour

let started = false;

async function tick() {
  try {
    if (!twitchOauth.residentialConfigured()) {
      // Nothing to do without egress credentials.
      scheduleNext();
      return;
    }
    const candidates = await SoopAccount.find({
      status: { $in: ["drops_rejected", "not_logged_in"] },
      sold: { $ne: true },
      twitchLogin: { $exists: true, $ne: "" },
    })
      .select("loginId twitchLogin")
      .limit(MAX_PER_TICK)
      .lean();

    if (!candidates.length) {
      scheduleNext();
      return;
    }
    console.log(
      `[soop cookie refresher] tick: ${candidates.length} candidate(s)`,
    );
    // Serial — the residential proxy can run them concurrently fine but Twitch
    // doesn't love burst traffic. ~15s each × 10 = ~2.5min worst case.
    for (const c of candidates) {
      try {
        await farm.renewAccount(c.loginId, { reason: "periodic" });
      } catch (e) {
        console.error(
          `[soop cookie refresher] ${c.loginId}: ${e.message}`,
        );
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

module.exports = { start };
