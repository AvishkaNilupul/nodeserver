// Keeps the PlayerAuctions seller session alive so the auto-lister and the
// delivery bot never silently die on a lapsed cookie.
//
// PlayerAuctions' auth is cookie-based: the session lives in httpOnly cookies
// and POST account-api/api/SignIn/RefreshToken (empty body) renews it from the
// refresh cookie. The renewed Set-Cookie is folded straight back into the
// stored jar by utils/marketplaces.js, so once the operator has pasted a
// signed-in cookie header once, the server keeps it fresh on its own.
//
// No-op when the PlayerAuctions credential is unset.
const mp = require("./marketplaces");

const TICK_MS = 6 * 60 * 60 * 1000; // check every 6h
let started = false;

async function tick() {
  try {
    if ((mp.keyStatus().playerauctions || {}).configured) {
      // Probes the session first and only refreshes when it has actually
      // lapsed, so a healthy session is left alone.
      const renewed = await mp.playerauctionsEnsureFreshSession();
      if (renewed) console.log("playerauctions session refresher: session renewed");
    }
  } catch (e) {
    console.error("playerauctions session refresher:", e.message);
  }
  const t = setTimeout(tick, TICK_MS);
  if (t.unref) t.unref();
}

function start() {
  if (started) return;
  started = true;
  // First check shortly after boot so a session that lapsed while the server
  // was down is renewed before the first publish or delivery is attempted.
  const t = setTimeout(tick, 35 * 1000);
  if (t.unref) t.unref();
}

module.exports = { start };
