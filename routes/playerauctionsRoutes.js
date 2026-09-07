// ---------------------------------------------------------------------------
// Read-only PlayerAuctions console.
//
// This exists for one reason, and it is not convenience.
//
// PlayerAuctions allows ONE session per account. Signing in anywhere — the
// operator opening member.playerauctions.com in their own browser — rotates the
// session id and invalidates every other copy, including the server's. Merely
// visiting the login page signs the account out. So the browser is the single
// thing that breaks auto-delivery, and it broke it four times on 2026-09-07.
//
// The server cannot log itself back in either: the login page is gated by
// Cloudflare Turnstile AND reCAPTCHA.
//
// So the fix is to remove the REASON to open the site: everything the operator
// normally goes there to look at — orders, offers, balance, messages,
// notifications — is served here, through the server's own session. Nothing in
// this file writes to PlayerAuctions; delivery stays with the fulfiller.
//
// Every endpoint is a separate on-demand read so the page opens on one cheap
// snapshot and only makes the slower calls when a tab is actually opened.
const express = require("express");

const { requireSuperadmin, enforce2fa } = require("../middleware/auth");
const mp = require("../utils/marketplaces");
const sessionWatch = require("../utils/playerauctionsSessionWatch");

const router = express.Router();

// A dead session is the expected failure here, not an exceptional one, so it is
// reported as data the page can render rather than as a 500.
function sendOr401(res, fn) {
  return Promise.resolve()
    .then(fn)
    .then((data) => res.json({ success: true, data }))
    .catch((e) => {
      const dead = /session not accepted|401|not configured/i.test(e.message || "");
      res.json({
        success: false,
        sessionDead: dead,
        message: e.message,
        ...(dead
          ? {
              howToFix:
                "Sign in at member.playerauctions.com, copy the whole Cookie " +
                "request header from any request there, and paste it into the " +
                "PlayerAuctions credential in the listings keys modal.",
            }
          : {}),
      });
    });
}

// Cheap: does not call PlayerAuctions at all. Lets the page show session health
// even when the session is dead.
router.get("/playerauctions/session", requireSuperadmin, enforce2fa, (req, res) => {
  const configured = !!(mp.keyStatus().playerauctions || {}).configured;
  const exp = mp.playerauctionsTokenExpiry();
  const mins = (d) => (d ? Math.round((d - Date.now()) / 60000) : null);
  res.json({
    success: true,
    data: {
      configured,
      accessMinsLeft: mins(exp.access),
      refreshMinsLeft: mins(exp.refresh),
      // The watchdog's view: whether it has alerted on an outage.
      alerted: sessionWatch.state.alerted,
      lastOkAt: sessionWatch.state.lastOkAt,
    },
  });
});

// Live probe, and the one the page's "check now" button calls.
router.get("/playerauctions/health", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () => sessionWatch.check()),
);

router.get("/playerauctions/snapshot", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () => mp.playerauctionsSnapshot()),
);

router.get("/playerauctions/offers", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () =>
    mp.playerauctionsMyListings(
      parseInt(req.query.page, 10) || 1,
      Math.min(50, parseInt(req.query.size, 10) || 50),
    ),
  ),
);

router.get("/playerauctions/orders", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () =>
    mp.playerauctionsOrders({
      pageIndex: parseInt(req.query.page, 10) || 1,
      pageSize: Math.min(100, parseInt(req.query.size, 10) || 100),
    }),
  ),
);

router.get("/playerauctions/orders/:id", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () => mp.playerauctionsOrderDetail(req.params.id)),
);

// What the delivery bot would ship on its next tick.
router.get("/playerauctions/pending", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () => mp.playerauctionsPendingOrders({ pageSize: 100 })),
);

router.get("/playerauctions/balance", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () => mp.playerauctionsBalance()),
);

router.get("/playerauctions/messages", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () => mp.playerauctionsMessages()),
);

router.get("/playerauctions/notifications", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, () =>
    mp.playerauctionsNotifications({
      pageIndex: parseInt(req.query.page, 10) || 1,
      pageSize: Math.min(50, parseInt(req.query.size, 10) || 20),
    }),
  ),
);

module.exports = router;
