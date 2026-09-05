// Operator notifications for the lane engine.
//
// The legacy engine alerts the owner on Telegram for every consequential
// decision — a terminal skip, a reuse, a live deployment, a listing — and the
// owner audits the farm from those messages. A lane must produce the same
// trail or a game that moves to a lane goes silent. Every send here is
// best-effort and never throws: a Telegram hiccup must not fail a job.
//
// Routed through this one module (rather than each step importing telegram
// directly) so a test can replace `telegram` in one place and so the sender
// can be swapped without touching the steps.

const telegram = require("../telegram");

async function sendTelegram(text) {
  try {
    await telegram.sendTelegram(text);
  } catch {
    /* notifications never break farming */
  }
}

module.exports = { telegram: sendTelegram };
