// Keeps the ZeusX seller access_token fresh so the auto-lister (and, later,
// auto-delivery) never silently dies on an expired token.
//
// ZeusX access tokens last ~7 days; their refresh_token is REUSABLE (verified
// 2026-08-04 — /user/exchange-token returns the same refresh_token), so once the
// operator has pasted a session once (access + refresh stored in settings), the
// server can mint fresh access tokens from the refresh token forever. This just
// checks periodically and refreshes when the token is within ~2 days of expiry.
//
// No-op when ZeusX keys are unset or no refresh token was stored (an older
// paste, access-token-only) — in that case the token still expires the old way
// and the operator re-pastes, exactly as before.
const mp = require("./marketplaces");

const TICK_MS = 6 * 60 * 60 * 1000; // check every 6h
let started = false;

async function tick() {
  try {
    const refreshed = await mp.zeusxEnsureFreshToken();
    if (refreshed) console.log("zeusx token refresher: access_token refreshed");
  } catch (e) {
    console.error("zeusx token refresher:", e.message);
  }
  const t = setTimeout(tick, TICK_MS);
  if (t.unref) t.unref();
}

function start() {
  if (started) return;
  started = true;
  // First check shortly after boot so a token that lapsed while the server was
  // down gets renewed right away.
  const t = setTimeout(tick, 30 * 1000);
  if (t.unref) t.unref();
}

module.exports = { start };
