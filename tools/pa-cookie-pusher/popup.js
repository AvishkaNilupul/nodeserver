// PA Cookie Pusher — popup logic.
//
// The popup is now a configuration + fallback surface; the day-to-day push is
// done automatically by background.js the moment a fresh login lands. Here the
// operator sets the server URL + secret, toggles auto-push / tab-close, sees
// the last auto-push result, and can still push or copy by hand if they want.
//
// No login is ever automated and no captcha is touched. The privileged part is
// only reading the httpOnly session cookies the operator is ALREADY signed in
// with (ext.cookies) and POSTing them to the operator's own server.

// Engine-agnostic namespace: Chrome/Edge expose `chrome`, Safari/Orion expose
// `browser` (and usually `chrome` too). Bind once.
const ext = (typeof browser !== "undefined" && browser) || (typeof chrome !== "undefined" && chrome);

const $ = (id) => document.getElementById(id);
const statusEl = () => $("status");

function setStatus(kind, msg) {
  const el = statusEl();
  el.className = kind;
  el.textContent = msg;
}

function showLast(result) {
  const el = $("last");
  if (!result || !result.at) {
    el.className = "";
    return;
  }
  const when = new Date(result.at).toLocaleString();
  if (result.ok) {
    el.className = "ok";
    el.textContent = "Last auto-push ✓ " + when + "\nGood until: " + (result.until || "unknown");
  } else {
    el.className = "err";
    el.textContent = "Last auto-push failed " + when + "\n" + (result.msg || "");
  }
}

async function loadSettings() {
  const {
    prodUrl = "",
    secret = "",
    autoPush = true,
    closeTabs = true,
    lastResult = null,
  } = await ext.storage.local.get(["prodUrl", "secret", "autoPush", "closeTabs", "lastResult"]);
  $("url").value = prodUrl;
  $("secret").value = secret;
  $("autoPush").checked = autoPush !== false;
  $("closeTabs").checked = closeTabs !== false;
  $("push").disabled = !prodUrl || !secret;
  showLast(lastResult);
  // Opening the popup acknowledges whatever the badge was reporting.
  try {
    await ext.action.setBadgeText({ text: "" });
  } catch {
    /* badge may not be set */
  }
}

function normBase(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

async function saveSettings() {
  const prodUrl = normBase($("url").value);
  const secret = $("secret").value.trim();
  const autoPush = $("autoPush").checked;
  const closeTabs = $("closeTabs").checked;
  await ext.storage.local.set({ prodUrl, secret, autoPush, closeTabs });
  // Ask for permission to call the configured server origin. Reading cookies is
  // already covered by the static host permission; the server fetch is the one
  // that needs the operator's per-origin consent.
  if (prodUrl) {
    try {
      const origin = new URL(prodUrl).origin + "/*";
      await ext.permissions.request({ origins: [origin] });
    } catch (e) {
      setStatus("err", "Could not request access to that URL: " + e.message);
      return;
    }
  }
  $("push").disabled = !prodUrl || !secret;
  setStatus("info", "Saved." + (autoPush ? " Auto-push is on." : " Auto-push is OFF — you'll push by hand."));
}

// Assemble the Cookie header from every playerauctions.com cookie, via the
// shared helper so the popup and the service worker agree on the format.
async function gatherJar() {
  const list = await globalThis.PAL.gatherAll(ext.cookies);
  return globalThis.PAL.jarFromCookies(list);
}

// On-device feasibility check. Reads playerauctions.com cookies WITHOUT any
// login and reports whether this browser lets the extension see httpOnly
// cookies — the one thing that decides if the iPhone flow can ever work. Safe
// to run any time: it only reads, never signs in, never pushes.
async function runCheck() {
  setStatus("info", "Checking…");
  let list = [];
  try {
    list = await globalThis.PAL.gatherAll(ext.cookies);
  } catch (e) {
    setStatus("err", "Could not read cookies: " + e.message);
    return;
  }
  const p = globalThis.PAL.probe(list);
  if (p.signedIn) {
    setStatus("ok", "Ready ✓ Signed-in PlayerAuctions session is readable on this device — Grab & push will work. Tap it.");
    return;
  }
  if (p.total === 0) {
    setStatus("info", "No PlayerAuctions cookies seen yet. Open member.playerauctions.com in a tab first (no need to sign in), then tap Check again.");
    return;
  }
  if (p.httpOnlyBlocked) {
    setStatus(
      "err",
      "This browser hides httpOnly cookies from the extension, so it can never read the PlayerAuctions session here. " +
        "(" + p.total + " cookie(s) visible, none httpOnly.) The phone flow won't work on this device — use the remote-desktop route instead.",
    );
    return;
  }
  setStatus("ok", "Looks good ✓ This browser lets the extension read httpOnly cookies (" + p.total + " seen). Sign in to PlayerAuctions, then tap Grab & push.");
}

async function copyHeader() {
  const jar = await gatherJar();
  if (!jar.ok) {
    setStatus("err", "Not signed in to PlayerAuctions in this browser — open member.playerauctions.com and log in first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(jar.header);
    setStatus("ok", "Cookie header copied. Paste it into the PlayerAuctions credential in the listings keys modal, then close the PA tab.");
  } catch {
    setStatus("err", "Clipboard blocked — use Grab & push instead.");
  }
}

async function pushToServer() {
  const prodUrl = normBase($("url").value);
  const secret = $("secret").value.trim();
  if (!prodUrl || !secret) {
    setStatus("err", "Set the server URL and secret in Settings first.");
    return;
  }
  const jar = await gatherJar();
  if (!jar.ok) {
    setStatus("err", "Not signed in to PlayerAuctions in this browser — open member.playerauctions.com and log in first.");
    return;
  }
  setStatus("info", "Installing…");
  $("push").disabled = true;
  try {
    const res = await fetch(prodUrl + "/playerauctions/session/install", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pa-install-secret": secret },
      body: JSON.stringify({ cookie: jar.header }),
    });
    if (res.status === 404) {
      setStatus("err", "Server rejected the secret (or the feature is off). Check the install secret in Settings.");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      const until = data.refreshExpiry ? new Date(data.refreshExpiry).toLocaleString() : "unknown";
      // Record the pushed refresh token so the auto-pusher does not re-send this
      // same login a second time.
      await ext.storage.local.set({
        lastPushedRefresh: jar.refresh,
        lastResult: { ok: true, at: Date.now(), until },
      });
      showLast({ ok: true, at: Date.now(), until });
      setStatus("ok", (data.detail || "Session installed.") + "\nGood until: " + until + "\n\nNow close the PlayerAuctions tab so the server stays the only session.");
    } else {
      setStatus("err", data.message || data.detail || "Install failed (HTTP " + res.status + ").");
    }
  } catch (e) {
    setStatus("err", "Could not reach the server: " + e.message + "\nIf this is the first push, open Settings and press Save to grant access to the URL.");
  } finally {
    $("push").disabled = !prodUrl || !secret;
  }
}

$("save").addEventListener("click", saveSettings);
$("copy").addEventListener("click", copyHeader);
$("push").addEventListener("click", pushToServer);
$("check").addEventListener("click", runCheck);
loadSettings();
