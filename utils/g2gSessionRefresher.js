// Keeps the G2G seller session alive so the auto-lister and the delivery bot
// never silently die on an expired access token.
//
// G2G's Open API is not usable for Game Items, so the connector drives the same
// internal seller API the website does, and its auth is a bare JWT access token
// that lives only minutes-to-hours — nothing like ZeusX's 7 days. What makes
// that survivable is that the durable half of the credential (user_id +
// refresh_token + active_device_token) is a ONE-TIME PASTE: the operator copies
// the session once out of Local Storage and this loop is the only thing that
// keeps it alive from then on. Without it the connector works right after a
// paste and is dead by morning.
//
// G2G MAY rotate the refresh token on each /user/refresh_access, and
// g2gRefreshAccess already writes back every value the response returns, so a
// rotated refresh token is picked up automatically and the paste never has to
// be repeated. That is also why refreshing on a timer is safe rather than
// wasteful — a skipped rotation is what would eventually strand the session.
//
// No-op (logged once, not thrown once per tick) when no G2G session is stored.
const mp = require("./marketplaces");

const TICK_MS = 30 * 60 * 1000; // check every 30m — G2G access tokens are short-lived
let started = false;
let warnedUnset = false;

async function tick() {
  try {
    // Read the masked status rather than the plaintext keys: all this needs to
    // know is whether a refresh token exists at all.
    const refreshToken = ((mp.keyStatus().g2g || {}).fields || {}).refreshToken;
    if (!refreshToken) {
      // An unconfigured marketplace is the normal state before the first paste,
      // so say so once and keep ticking — the operator may paste at any time.
      if (!warnedUnset) {
        warnedUnset = true;
        console.log(
          "g2g session refresher: no G2G session stored, idle until one is pasted",
        );
      }
    } else {
      warnedUnset = false;
      // Only refreshes when the access token is within ~10 minutes of expiry, so
      // a healthy token is left alone. Any gap between ticks is covered by
      // g2gRequest, which refreshes and retries once on a 401.
      const refreshed = await mp.g2gEnsureFreshToken();
      if (refreshed) console.log("g2g session refresher: access token refreshed");
    }
  } catch (e) {
    // A refresh failure must never take the process down: the next tick (and
    // g2gRequest's own 401 retry) get another chance.
    console.error("g2g session refresher:", e.message);
  }
  const t = setTimeout(tick, TICK_MS);
  if (t.unref) t.unref();
}

function start() {
  if (started) return;
  started = true;
  // First check shortly after boot so a token that expired while the server was
  // down is renewed before the first publish or delivery is attempted. Offset
  // from the other refreshers so a restart does not fire every marketplace's
  // refresh in the same second.
  const t = setTimeout(tick, 40 * 1000);
  if (t.unref) t.unref();
}

module.exports = { start };
