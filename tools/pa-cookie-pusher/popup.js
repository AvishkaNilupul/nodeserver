// PA Cookie Pusher — popup logic.
//
// The whole job: read the PlayerAuctions session cookies that the operator is
// ALREADY signed in with (a privileged chrome.cookies read — it can see the
// httpOnly session tokens that page JS cannot), assemble them into a Cookie
// header, and POST that header to the redeemer's token-gated install route. The
// human still does the login in their browser; this only replaces the
// devtools-copy-and-paste half of the daily re-supply.
//
// No login is ever automated here and no captcha is touched.

const $ = (id) => document.getElementById(id);
const statusEl = () => $("status");

function setStatus(kind, msg) {
  const el = statusEl();
  el.className = kind;
  el.textContent = msg;
}

async function loadSettings() {
  const { prodUrl = "", secret = "" } = await chrome.storage.local.get(["prodUrl", "secret"]);
  $("url").value = prodUrl;
  $("secret").value = secret;
  // The push button only makes sense once a server is configured.
  $("push").disabled = !prodUrl || !secret;
}

function normBase(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}

async function saveSettings() {
  const prodUrl = normBase($("url").value);
  const secret = $("secret").value.trim();
  await chrome.storage.local.set({ prodUrl, secret });
  // Ask for permission to call the configured server origin. Reading cookies
  // is already covered by the static host permission; the server fetch is the
  // one that needs the operator's per-origin consent.
  if (prodUrl) {
    try {
      const origin = new URL(prodUrl).origin + "/*";
      await chrome.permissions.request({ origins: [origin] });
    } catch (e) {
      setStatus("err", "Could not request access to that URL: " + e.message);
      return;
    }
  }
  $("push").disabled = !prodUrl || !secret;
  setStatus("info", "Saved.");
}

// Assemble the Cookie header from every playerauctions.com cookie, deduped by
// name (last one wins, matching how a browser collapses a jar).
async function gatherCookieHeader() {
  const cookies = await chrome.cookies.getAll({ domain: "playerauctions.com" });
  const byName = new Map();
  for (const c of cookies) byName.set(c.name, c.value);
  const header = [...byName.entries()].map(([k, v]) => k + "=" + v).join("; ");
  const ok = byName.has("Production_access_token") && byName.has("Production_refresh_token");
  return { header, ok, count: byName.size };
}

async function copyHeader() {
  const { header, ok } = await gatherCookieHeader();
  if (!ok) {
    setStatus("err", "Not signed in to PlayerAuctions in this browser — open member.playerauctions.com and log in first.");
    return;
  }
  try {
    await navigator.clipboard.writeText(header);
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
  const { header, ok } = await gatherCookieHeader();
  if (!ok) {
    setStatus("err", "Not signed in to PlayerAuctions in this browser — open member.playerauctions.com and log in first.");
    return;
  }
  setStatus("info", "Installing…");
  $("push").disabled = true;
  try {
    const res = await fetch(prodUrl + "/playerauctions/session/install", {
      method: "POST",
      headers: { "content-type": "application/json", "x-pa-install-secret": secret },
      body: JSON.stringify({ cookie: header }),
    });
    if (res.status === 404) {
      setStatus("err", "Server rejected the secret (or the feature is off). Check the install secret in Settings.");
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      const until = data.refreshExpiry ? new Date(data.refreshExpiry).toLocaleString() : "unknown";
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
loadSettings();
