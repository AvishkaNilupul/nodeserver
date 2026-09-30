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
// notifications — is served here, through the server's own session. The one
// write is an operator-typed reply on an order thread (the POST route below);
// everything else is read-only, and delivery stays with the fulfiller.
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
  sendOr401(res, () =>
    mp.playerauctionsInbox({
      pageIndex: parseInt(req.query.page, 10) || 1,
      pageSize: Math.min(50, parseInt(req.query.size, 10) || 30),
    }),
  ),
);

// One thread's transcript. `system` (from the inbox row's isFromSystem) picks the
// right detail variant. PlayerAuctions returns each comment's body as HTML, so it
// is stripped to plain text here and the sender is labelled against sellerName —
// the console only ever esc()s the text, so nothing HTML reaches the page.
router.get("/playerauctions/messages/:id", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, async () => {
    const d =
      (await mp.playerauctionsMessageThread(req.params.id, req.query.system === "true")) || {};
    const strip = (h) =>
      String(h || "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div)>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<")
        .replace(/&amp;/g, "&")
        .replace(/&nbsp;/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    return {
      orderId: d.orderId,
      subject: d.subject,
      orderStatus: d.orderStatus,
      buyerName: d.buyerName,
      sellerName: d.sellerName,
      offerUrl: d.offerUrl,
      comments: (d.comments || []).map((c) => ({
        who: c.memberName === d.sellerName ? "You" : c.memberName || "—",
        mine: c.memberName === d.sellerName,
        at: c.sendTimeString,
        text: strip(c.content),
      })),
    };
  }),
);

// SEND a reply on an order thread — the one write this console makes, and only
// when the operator types it and clicks Send. Reuses the fulfiller's own proven
// send path (playerauctionsSendOrderMessage -> POST /messages, objectIdType
// Order), which enforces the 300-char PlayerAuctions cap and treats an
// isSuccess:false envelope as a throw. System threads carry no orderId and are
// not repliable.
router.post("/playerauctions/messages/reply", requireSuperadmin, enforce2fa, (req, res) =>
  sendOr401(res, async () => {
    const orderId = String((req.body && req.body.orderId) || "").trim();
    const content = String((req.body && req.body.content) || "").trim();
    if (!orderId) throw new Error("orderId is required");
    if (!content) throw new Error("the message is empty");
    await mp.playerauctionsSendOrderMessage(orderId, content);
    return { sent: true, orderId: orderId, length: content.length };
  }),
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
