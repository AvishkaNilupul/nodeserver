// Guards the 2FA enrolment exemption. Getting this wrong locks every admin out
// of every page — including the settings page where they would enrol — because
// enforce2fa redirects there and would then redirect the redirect. That is a
// real outage that happened on 2026-07-29, so the exemption is pinned here.
const test = require("node:test");
const assert = require("node:assert");

const { isTfaEnrollmentPath } = require("../middleware/auth");
const p = (path) => isTfaEnrollmentPath({ path });

test("the page enforce2fa redirects to is never itself gated", () => {
  // If this ever returns false the redirect becomes an infinite loop.
  assert.strictEqual(p("/settings.html"), true);
});

test("the endpoints the settings page calls to enrol stay reachable", () => {
  assert.strictEqual(p("/admin/2fa/setup"), true);
  assert.strictEqual(p("/admin/2fa/enable"), true);
  assert.strictEqual(p("/admin/2fa/status"), true);
  assert.strictEqual(p("/admin/2fa/require"), true);
  assert.strictEqual(p("/admin-2fa"), true); // login second step
});

test("a stuck admin can always log out", () => {
  assert.strictEqual(p("/admin-logout"), true);
});

test("the legacy security bookmark is exempt too", () => {
  assert.strictEqual(p("/security.html"), true);
});

test("the per-admin settings endpoints the same page uses are exempt", () => {
  assert.strictEqual(p("/me/telegram"), true);
  assert.strictEqual(p("/me/telegram/link"), true);
});

test("ordinary admin pages are still gated", () => {
  assert.strictEqual(p("/integrity.html"), false);
  assert.strictEqual(p("/admin.html"), false);
  assert.strictEqual(p("/bots.html"), false);
  assert.strictEqual(p("/marketplaces/guardian/findings"), false);
  assert.strictEqual(p("/orders"), false);
});

test("the exemption is not a loose prefix match", () => {
  // "/settings.htmlx" or a nested path must NOT slip through the gate.
  assert.strictEqual(p("/settings.html.bak"), false);
  assert.strictEqual(p("/admin/2fa"), false); // no trailing slash = not a sub-endpoint
  assert.strictEqual(p("/notadmin/2fa/setup"), false);
});

test("a missing or empty path does not throw and stays gated", () => {
  assert.strictEqual(isTfaEnrollmentPath({}), false);
  assert.strictEqual(p(""), false);
});
