// PA Cookie Pusher — background service worker (the zero-click half).
//
// Watches the browser's PlayerAuctions cookies and, the moment a fresh sign-in
// lands, pushes the new session jar to the redeemer's token-gated install route
// on its own — no popup, no button. The operator's only job stays the login +
// captcha itself (never automated here).
//
// Safety is entirely in WHEN it fires: only when the refresh token changes,
// i.e. exactly once per human login. See logic.js (shouldInstall) for why that
// avoids re-pushing the browser's own 30-minute access-token refreshes, which
// would make this browser and prod fight for the single allowed session and
// kill it — the failure mode that has bitten this integration repeatedly.
//
// After a successful push it closes the PlayerAuctions tabs so the browser goes
// dormant and prod stays the sole session owner (the "close the tab" rule, made
// automatic). That tab close uses the extension's existing playerauctions.com
// host permission, so it needs no extra permission prompt.
importScripts("logic.js");
const { jarFromCookies, shouldInstall, isRefreshTokenChange, gatherAll } = self.PAL;

// Engine-agnostic namespace: Chrome/Edge expose `chrome`, Safari/Orion expose
// `browser` (and usually `chrome` too). Bind once so the rest of the file does
// not care which engine it is running under.
const ext = (typeof browser !== "undefined" && browser) || (typeof chrome !== "undefined" && chrome);

// A login writes several cookies in a burst; wait for it to settle before we
// read the jar, so we send the whole thing and not a half-written one.
const SETTLE_MS = 1500;
let settleTimer = null;

ext.cookies.onChanged.addListener((info) => {
  if (!isRefreshTokenChange(info)) return;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(handleFreshLogin, SETTLE_MS);
});

async function handleFreshLogin() {
  settleTimer = null;
  const st = await ext.storage.local.get([
    "prodUrl",
    "secret",
    "autoPush",
    "closeTabs",
    "lastPushedRefresh",
  ]);
  if (st.autoPush === false) return; // operator turned auto-push off
  if (!st.prodUrl || !st.secret) {
    await flag("err", "Signed in — now set the server URL + secret in the extension to auto-push.");
    return;
  }
  const jar = jarFromCookies(await gatherAll(ext.cookies));
  if (!shouldInstall(jar, st.lastPushedRefresh || "")) return;
  await install(jar, st);
}

async function install(jar, st) {
  const base = String(st.prodUrl).trim().replace(/\/+$/, "");
  try {
    const res = await fetch(base + "/playerauctions/session/install", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pa-install-secret": st.secret },
      body: JSON.stringify({ cookie: jar.header }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      const until = data.refreshExpiry ? new Date(data.refreshExpiry).toLocaleString() : "unknown";
      // Record the pushed refresh token so the same login is never re-sent.
      await ext.storage.local.set({
        lastPushedRefresh: jar.refresh,
        lastResult: { ok: true, at: Date.now(), until },
      });
      await flag("ok", "Installed ✓ good until " + until);
      if (st.closeTabs !== false) await closePaTabs();
    } else {
      const msg = data.message || data.detail || "HTTP " + res.status;
      await ext.storage.local.set({ lastResult: { ok: false, at: Date.now(), msg } });
      await flag("err", "Push failed: " + msg);
    }
  } catch (e) {
    const msg = (e && e.message) || String(e);
    await ext.storage.local.set({ lastResult: { ok: false, at: Date.now(), msg } });
    await flag("err", "Push failed (server unreachable): " + msg);
  }
}

// Close signed-in PlayerAuctions tabs so the browser stops making requests that
// would refresh the session out from under prod. Gated by the host permission
// the extension already holds; if that is somehow absent the catch leaves
// dormancy to the operator closing the tab themselves.
async function closePaTabs() {
  try {
    const tabs = await ext.tabs.query({ url: "https://*.playerauctions.com/*" });
    const ids = tabs.map((t) => t.id).filter((id) => id != null);
    if (ids.length) await ext.tabs.remove(ids);
  } catch {
    /* host permission not granted for tab access; harmless */
  }
}

// The toolbar icon is the confirmation: a green check on success, a red ! on
// failure, with the detail in the tooltip. No notifications permission needed.
async function flag(kind, text) {
  try {
    await ext.action.setBadgeText({ text: kind === "ok" ? "✓" : "!" });
    await ext.action.setBadgeBackgroundColor({ color: kind === "ok" ? "#1a7f37" : "#b42318" });
    await ext.action.setTitle({ title: "PA Cookie Pusher — " + text });
  } catch {
    /* badge is a nicety, not required */
  }
}
