// Buyer-facing Epic mail viewer — guards on the two security boundaries that
// matter: the sender allow-list (so the viewer never surfaces Microsoft or
// SOOP mail from the same inbox) and the session's isLive() contract (so an
// expired or revoked cookie can never load /mail/inbox).
//
// We intentionally do not spin up Express here; routes are hit by the live
// integration deploys. These are the two deterministic pieces that would be
// hardest to notice regressing by eye.

const test = require("node:test");
const assert = require("node:assert");

const { isEpicSender, EPIC_SENDER_DOMAINS } = require("../utils/outlookGraphReader");
const BuyerMailSession = require("../models/BuyerMailSession");
const buyerMailRoutes = require("../routes/buyerMailRoutes");
const watcher = require("../utils/buyerSessionWatcher");

test("isEpicSender accepts the real Epic sender domains", () => {
  for (const d of EPIC_SENDER_DOMAINS) {
    assert.strictEqual(isEpicSender("noreply@" + d), true, d + " should pass");
  }
  assert.strictEqual(isEpicSender("help@accounts.epicgames.com"), true);
  assert.strictEqual(isEpicSender("Help@EpicGames.com"), true); // case
});

test("isEpicSender rejects lookalike and Microsoft/SOOP senders", () => {
  // The exact kind of mail that MUST never appear on the buyer page.
  assert.strictEqual(isEpicSender("account-security-noreply@accountprotection.microsoft.com"), false);
  assert.strictEqual(isEpicSender("no-reply@sooplive.com"), false);
  assert.strictEqual(isEpicSender("recovery@outlook.com"), false);
  // Lookalikes: suffix must match a FULL domain segment.
  assert.strictEqual(isEpicSender("evil@fakeepicgames.com"), false);
  assert.strictEqual(isEpicSender("evil@epicgames.com.evil.co"), false);
  // Empty / malformed inputs never pass.
  assert.strictEqual(isEpicSender(""), false);
  assert.strictEqual(isEpicSender(null), false);
  assert.strictEqual(isEpicSender(undefined), false);
});

test("detectsEmailChange matches Epic's email-change subjects, nothing else", () => {
  const hitSubjects = [
    "Your Epic Games email has been changed",
    "Your email was updated",
    "Email address has been updated",
    "Email change successful",
    "Your Epic Games account email was changed",
  ];
  for (const subject of hitSubjects) {
    assert.ok(
      watcher.detectsEmailChange([{ subject }]),
      "should match: " + subject,
    );
  }
  const missSubjects = [
    "Welcome to Epic Games",
    "Your weekly free game is here",
    "Your Epic Games verification code",
    "Password reset request",
    "Order confirmation",
    "",
  ];
  for (const subject of missSubjects) {
    assert.strictEqual(
      watcher.detectsEmailChange([{ subject }]),
      null,
      "should NOT match: " + subject,
    );
  }
  // Non-array input is defended against.
  assert.strictEqual(watcher.detectsEmailChange(null), null);
  assert.strictEqual(watcher.detectsEmailChange(undefined), null);
});

test("login rate limiter blocks after N attempts in a window", () => {
  const t = buyerMailRoutes._test;
  t._resetLoginAttempts();
  // Nine attempts within the window: still allowed.
  for (let i = 0; i < 9; i++) t.noteLoginAttempt("1.2.3.4", "a@b");
  assert.strictEqual(t.peekLoginAttempts("1.2.3.4", "a@b"), 9);
  assert.ok(t.peekLoginAttempts("1.2.3.4", "a@b") < t.LOGIN_MAX_ATTEMPTS);
  // Tenth attempt: at the cap — the route still processes this one, but the
  // ELEVENTH would be refused (peekLoginAttempts >= cap on next hit).
  t.noteLoginAttempt("1.2.3.4", "a@b");
  assert.strictEqual(t.peekLoginAttempts("1.2.3.4", "a@b"), 10);
  // A different IP + same email: separate bucket, so a shared NAT isn't locked
  // out by one noisy neighbor.
  assert.strictEqual(t.peekLoginAttempts("9.9.9.9", "a@b"), 0);
  // Same IP + different email: separate bucket.
  assert.strictEqual(t.peekLoginAttempts("1.2.3.4", "c@d"), 0);
  t._resetLoginAttempts();
});

test("BuyerMailSession.isLive is false when revoked and false when expired", () => {
  const future = new Date(Date.now() + 60_000);
  const past = new Date(Date.now() - 60_000);

  const liveRow = new BuyerMailSession({
    epicAccountId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    mailAccountId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    inboxAddress: "x@outlook.com",
    passwordHash: "x",
    expiresAt: future,
  });
  assert.strictEqual(liveRow.isLive(), true);

  liveRow.revokedAt = new Date();
  assert.strictEqual(liveRow.isLive(), false, "revoked row must not be live");

  const expired = new BuyerMailSession({
    epicAccountId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    mailAccountId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    inboxAddress: "x@outlook.com",
    passwordHash: "x",
    expiresAt: past,
  });
  assert.strictEqual(expired.isLive(), false, "expired row must not be live");
});
