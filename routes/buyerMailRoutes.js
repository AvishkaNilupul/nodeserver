// Buyer-facing mail viewer. Mounted BEFORE enforce2fa so the buyer never
// touches the admin session cascade. Its own cookie carries the sessionId.
//
//   GET  /mail/              → login form
//   POST /mail/login         → verify {email,password}, set cookie, 302 /mail/inbox
//   GET  /mail/inbox         → list messages (Epic senders, after session.createdAt)
//   GET  /mail/message/:id   → one message
//   POST /mail/logout        → clear cookie
//
// Threat model: anyone on the public internet can hit this. The cookie must
// be HttpOnly + SameSite=Lax, the session row must say isLive(), and every
// mail read goes through utils/outlookGraphReader whose allow-list keeps
// non-Epic mail (microsoft resets, soop recovery, outlook aliases) off this
// page even when the token itself can see them. Any failure path returns the
// same generic error so a probing buyer can't fingerprint the fleet.

const express = require("express");
const crypto = require("crypto");
const bcrypt = require("bcrypt");

const BuyerMailSession = require("../models/BuyerMailSession");
const EpicAccount = require("../models/EpicAccount");
const outlook = require("../utils/outlookGraphReader");

const router = express.Router();

const COOKIE_NAME = "redeemer_mail_sid";
// Fifteen minutes of browser-side cookie life. The server-side expiresAt on
// the session row is the real cap (7 days by default); the cookie just means
// an idle buyer re-logs after 15 min.
const COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

// --- Login rate limiter (in-memory, per IP+email). ---
// Timing-constant bcrypt already removes most of the signal from a brute
// forcer, but a dumb bot pounding one address is still waste. Window is
// 10 minutes, cap is 10 attempts, keyed on IP + email so one noisy address
// doesn't lock the rest of the inbox out. Stored in-process: a restart wipes
// the counters, which is fine — the attacker has to re-connect anyway.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map();

function loginAttemptKey(ip, email) {
  return (ip || "?") + "|" + (email || "?");
}

function noteLoginAttempt(ip, email, now = Date.now()) {
  const key = loginAttemptKey(ip, email);
  const cutoff = now - LOGIN_WINDOW_MS;
  const arr = (loginAttempts.get(key) || []).filter((t) => t > cutoff);
  arr.push(now);
  loginAttempts.set(key, arr);
  return arr.length;
}

function peekLoginAttempts(ip, email, now = Date.now()) {
  const key = loginAttemptKey(ip, email);
  const cutoff = now - LOGIN_WINDOW_MS;
  const arr = (loginAttempts.get(key) || []).filter((t) => t > cutoff);
  if (arr.length) loginAttempts.set(key, arr); // trim stale
  else loginAttempts.delete(key);
  return arr.length;
}

function _resetLoginAttempts() {
  // Exposed for tests only.
  loginAttempts.clear();
}

// Light background clean-up so a slow trickle of distinct keys doesn't grow
// the map forever. Runs every 30 min on an unref'd timer.
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  for (const [k, arr] of loginAttempts) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length) loginAttempts.set(k, kept);
    else loginAttempts.delete(k);
  }
}, 30 * 60 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();

function parseCookie(req, name) {
  const header = req.headers?.cookie || "";
  if (!header) return "";
  for (const kv of header.split(/;\s*/)) {
    const [k, ...rest] = kv.split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );
}

function cookieHeader(value, maxAgeMs, secure) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/mail",
    "HttpOnly",
    "SameSite=Lax",
    maxAgeMs > 0
      ? `Max-Age=${Math.floor(maxAgeMs / 1000)}`
      : "Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function isSecureRequest(req) {
  if (req.secure) return true;
  const forwarded = String(req.headers["x-forwarded-proto"] || "").toLowerCase();
  return forwarded === "https";
}

// Pull the sessionId cookie, look up the row, and bail unless it's live. The
// returned shape is {session, epicAccount} on success, otherwise null and the
// handler should 302 back to /mail/.
async function currentSession(req) {
  const sid = parseCookie(req, COOKIE_NAME);
  // The cookie carries the session's Mongo ObjectId: 24 hex characters. (The
  // first version accepted only 32-64, so every signed-in buyer was sent
  // straight back to the login page.)
  if (!sid || !/^[a-f0-9]{24}$/i.test(sid)) return null;
  const session = await BuyerMailSession.findOne({ _id: sid }).catch(() => null);
  if (!session || !session.isLive()) return null;
  const acct = await EpicAccount.findById(session.epicAccountId)
    .select("accountId displayName sold")
    .lean()
    .catch(() => null);
  if (!acct) return null;
  return { session, epicAccount: acct };
}

async function markView(session) {
  const now = new Date();
  const update = { lastViewAt: now, $inc: { viewCount: 1 } };
  if (!session.firstViewAt) update.firstViewAt = now;
  await BuyerMailSession.updateOne({ _id: session._id }, update).catch(() => {});
}

// ----- HTML (inline, deliberately bare) -------------------------------------

function layout({ title, body }) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px; font: 15px/1.5 -apple-system, system-ui, 'Segoe UI', sans-serif; background: #f5f6f8; color: #111; }
  @media (prefers-color-scheme: dark) { body { background: #0e0f12; color: #e6e8ec; } .card { background: #15171c; border-color: #22252c; } input { background: #0a0b0e; color: #e6e8ec; border-color: #22252c; } .msg { border-color: #22252c; } }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  .card { background: white; border: 1px solid #e3e5e8; border-radius: 10px; padding: 20px; }
  label { display: block; font-size: 12px; font-weight: 600; color: #666; margin-top: 10px; text-transform: uppercase; letter-spacing: 0.4px; }
  input { width: 100%; padding: 10px 12px; font: inherit; border: 1px solid #d2d4d7; border-radius: 6px; margin-top: 4px; background: white; color: inherit; }
  button { margin-top: 16px; width: 100%; padding: 11px; font: inherit; font-weight: 600; background: #2563eb; color: white; border: none; border-radius: 6px; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .err { color: #c0392b; font-size: 13px; margin-top: 10px; }
  .notice { background: #fff8e1; border: 1px solid #ffe08a; color: #6b4a00; padding: 12px 14px; border-radius: 8px; margin-bottom: 16px; font-size: 13px; }
  @media (prefers-color-scheme: dark) { .notice { background: #2d2a0f; border-color: #5a521a; color: #facc15; } }
  .msg { border: 1px solid #e3e5e8; border-radius: 8px; padding: 14px 16px; margin-top: 10px; background: white; }
  @media (prefers-color-scheme: dark) { .msg { background: #15171c; } }
  .msg-head { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: #666; margin-bottom: 6px; }
  .msg-subj { font-weight: 600; font-size: 15px; }
  .msg-preview { color: #555; font-size: 13px; margin-top: 4px; }
  .msg-body { margin-top: 10px; padding: 10px 12px; background: #f5f6f8; border-radius: 6px; white-space: pre-wrap; word-break: break-word; font-size: 13px; max-height: 420px; overflow: auto; }
  @media (prefers-color-scheme: dark) { .msg-body { background: #0a0b0e; } }
  .row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
  .row form { margin: 0; }
  .ghost { background: transparent; color: #666; border: 1px solid #d2d4d7; width: auto; padding: 6px 12px; margin: 0; font-weight: 500; }
  .empty { color: #888; font-style: italic; padding: 18px; text-align: center; }
</style>
</head><body><div class="wrap">${body}</div></body></html>`;
}

function loginPage({ error, email }) {
  return layout({
    title: "Mail viewer",
    body: `
      <h1>Mail viewer</h1>
      <div class="sub">Sign in with the email login and email password from your order.</div>
      <div class="card">
        <form method="POST" action="/mail/login">
          <label for="email">Email address</label>
          <input id="email" name="email" type="email" autocomplete="username" required value="${escapeHtml(email || "")}">
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required>
          <button type="submit">Sign in</button>
          ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
        </form>
      </div>
      <div class="sub" style="margin-top:18px;">
        This page shows mail from Epic Games only. Please change the Epic
        account email to your own as soon as you sign in.
      </div>
    `,
  });
}

function inboxPage({ session, epicAccount, messages, error }) {
  const items = messages
    .map(
      (m) => `
    <div class="msg">
      <div class="msg-head">
        <span>${escapeHtml(m.from)}</span>
        <span>${escapeHtml(
          m.receivedDateTime
            ? new Date(m.receivedDateTime).toISOString().replace("T", " ").slice(0, 16) + "Z"
            : "",
        )}</span>
      </div>
      <div class="msg-subj">${escapeHtml(m.subject)}</div>
      <div class="msg-preview">${escapeHtml((m.bodyPreview || "").slice(0, 200))}</div>
      <div class="msg-body">${escapeHtml(m.body || m.bodyPreview || "")}</div>
    </div>`,
    )
    .join("");
  const expires = session.expiresAt
    ? new Date(session.expiresAt).toISOString().replace("T", " ").slice(0, 16) + "Z"
    : "";
  return layout({
    title: "Mail viewer",
    body: `
      <div class="row">
        <div>
          <h1>${escapeHtml(session.inboxAddress)}</h1>
          <div class="sub">Access ends ${escapeHtml(expires)}. Change the Epic email on your account before then.</div>
        </div>
        <form method="POST" action="/mail/logout"><button class="ghost" type="submit">Sign out</button></form>
      </div>
      <div class="notice">
        <b>Important:</b> after you have the first code or confirmation link, open
        <a href="https://www.epicgames.com/account/personal" target="_blank" rel="noreferrer noopener">epicgames.com/account/personal</a>
        and change the email address to your own. This viewer only shows mail from Epic Games and only mail received after your purchase — nothing else.
      </div>
      ${error ? `<div class="err" style="margin:0 0 10px;">${escapeHtml(error)}</div>` : ""}
      ${items || '<div class="empty">No mail from Epic yet. Trigger a code or password reset on Epic and reload this page.</div>'}
    `,
  });
}

// ----- routes ---------------------------------------------------------------

// `/mail` and `/mail/` share this handler: Express default routing already
// treats the trailing slash as optional, so we DO NOT also register a
// `/mail` -> `/mail/` 302 (that would then be re-matched by this route and
// loop forever).
router.get("/mail", async (req, res) => {
  const ctx = await currentSession(req);
  if (ctx) return res.redirect(302, "/mail/inbox");
  res.set("Cache-Control", "no-store").type("html").send(loginPage({}));
});

router.post("/mail/login", express.urlencoded({ extended: false }), async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) {
    return res
      .status(400)
      .type("html")
      .send(loginPage({ error: "Enter the email and password from your delivery.", email }));
  }
  const ip = (req.ip || req.connection?.remoteAddress || "")
    .toString()
    .replace(/^::ffff:/, "");
  if (peekLoginAttempts(ip, email) >= LOGIN_MAX_ATTEMPTS) {
    return res
      .status(429)
      .type("html")
      .send(
        loginPage({
          error: "Too many sign-in attempts. Please wait 10 minutes and try again.",
          email,
        }),
      );
  }
  noteLoginAttempt(ip, email);
  // Pull the newest non-revoked, non-expired row for this address.
  const now = new Date();
  const session = await BuyerMailSession.findOne({
    inboxAddress: email,
    revokedAt: null,
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1 })
    .catch(() => null);
  // Always bcrypt-compare SOMETHING so a timing probe can't learn whether the
  // address is in our table. bcrypt.compare against a known-mismatch hash is
  // the standard "equal-time" trick.
  const dummy = "$2b$10$aaaaaaaaaaaaaaaaaaaaaO3ygUmdQb4Yrt0eO5pG5bq0Dw2.ERXWO";
  const ok = await bcrypt
    .compare(password, session?.passwordHash || dummy)
    .catch(() => false);
  if (!session || !ok) {
    return res
      .status(401)
      .type("html")
      .send(loginPage({ error: "Those details did not match.", email }));
  }
  res.set("Set-Cookie", cookieHeader(String(session._id), COOKIE_MAX_AGE_MS, isSecureRequest(req)));
  res.redirect(302, "/mail/inbox");
});

router.get("/mail/inbox", async (req, res) => {
  const ctx = await currentSession(req);
  if (!ctx) return res.redirect(302, "/mail/");
  const { session, epicAccount } = ctx;
  // Only mail from after the purchase (or, for a listing whose sale has not
  // been recorded yet, after the listing) — see BuyerMailSession.mailCutoff.
  const sinceIso = BuyerMailSession.mailCutoff(session).toISOString();
  let messages = [];
  let error = "";
  try {
    const r = await outlook.readEpicMailFor({
      inboxAddress: session.inboxAddress,
      sinceIso,
      top: 20,
    });
    messages = r.messages;
  } catch (err) {
    error = "Mailbox unavailable right now. Please try again in a minute.";
    console.warn(
      "[buyer-mail] inbox read failed",
      session._id.toString(),
      err && err.message,
    );
  }
  await markView(session);
  res
    .set("Cache-Control", "no-store")
    .type("html")
    .send(inboxPage({ session, epicAccount, messages, error }));
});

router.get("/mail/message/:id", async (req, res) => {
  const ctx = await currentSession(req);
  if (!ctx) return res.redirect(302, "/mail/");
  const { session } = ctx;
  try {
    const message = await outlook.readOneMessage({
      inboxAddress: session.inboxAddress,
      messageId: req.params.id,
    });
    // Same cutoff as the inbox list: an older Epic message (from before this
    // buyer's purchase) is not theirs, even when its id is known.
    const at = Date.parse((message && message.receivedDateTime) || "");
    if (!Number.isFinite(at) || at < BuyerMailSession.mailCutoff(session).getTime()) {
      return res.redirect(302, "/mail/inbox");
    }
    await markView(session);
    return res
      .set("Cache-Control", "no-store")
      .type("html")
      .send(
        inboxPage({
          session,
          epicAccount: ctx.epicAccount,
          messages: [message],
          error: "",
        }),
      );
  } catch (err) {
    return res.redirect(302, "/mail/inbox");
  }
});

router.post("/mail/logout", (req, res) => {
  res.set("Set-Cookie", cookieHeader("", 0, isSecureRequest(req)));
  res.redirect(302, "/mail/");
});

// Internals exported for the test suite only — not for route callers.
module.exports = router;
module.exports._test = {
  noteLoginAttempt,
  peekLoginAttempts,
  _resetLoginAttempts,
  LOGIN_WINDOW_MS,
  LOGIN_MAX_ATTEMPTS,
};
