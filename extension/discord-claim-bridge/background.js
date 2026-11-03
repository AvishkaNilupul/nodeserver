/* global chrome, fetch, atob */
// Sessions stay in extension session storage, never in a page or on disk.
// Capture is armed for one selected tab for two minutes and consumes one header.
const TARGETS = new Set(["https://redeemhub.lets.game", "http://127.0.0.1:3000"]);
function discordTab(url) {
  try { const u = new URL(url); return u.origin === "https://discord.com"; }
  catch { return false; }
}
function accountId(token) {
  try {
    const parts = token.split(".");
    const id = atob(parts[0].replace(/-/g, "+").replace(/_/g, "/"));
    return parts.length === 3 && /^\d{15,25}$/.test(id) && parts.every((p) => /^[\w-]+$/.test(p)) ? id : null;
  } catch { return null; }
}
async function capture(details) {
  const { armed } = await chrome.storage.session.get("armed");
  if (!armed || armed.tabId !== details.tabId || Date.now() > armed.until) return;
  const token = details.requestHeaders?.find((h) => h.name.toLowerCase() === "authorization")?.value;
  const userId = token && accountId(token);
  if (!userId) return;
  await chrome.storage.session.set({ captured: { token, userId, tabId: details.tabId, until: Date.now() + 5 * 60 * 1000 } });
  await chrome.storage.session.remove("armed");
}
chrome.webRequest.onBeforeSendHeaders.addListener((details) => { capture(details).catch(() => {}); },
  { urls: ["https://discord.com/api/v9/users/@me*", "https://discord.com/api/v10/users/@me*", "https://discord.com/api/v9/quests/*", "https://discord.com/api/v10/quests/*"] }, ["requestHeaders"]);

async function handle(message, sender) {
  // Only the extension's own popup can arm capture or transmit a session.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("Unsupported sender");
  if (message.action === "clear") {
    await chrome.storage.session.remove(["armed", "captured"]); return { ok: true };
  }
  if (message.action === "arm") {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !discordTab(tab.url)) throw new Error("Open the test account in Discord web first.");
    await chrome.storage.session.remove("captured");
    await chrome.storage.session.set({ armed: { tabId: tab.id, until: Date.now() + 120000 } });
    await chrome.tabs.reload(tab.id);
    return { ok: true };
  }
  const { captured } = await chrome.storage.session.get("captured");
  if (!captured || Date.now() > captured.until) throw new Error("Select Connect on the Discord test account tab first.");
  if (message.action === "status") return { ok: true, userId: captured.userId };
  if (message.action !== "import" || !TARGETS.has(message.target)) throw new Error("Unsupported destination");
  const tab = await chrome.tabs.get(captured.tabId);
  if (!discordTab(tab.url)) throw new Error("The connected Discord tab has closed or navigated away.");
  const r = await fetch(message.target + "/admin/discord-farm/ingest", {
    method: "POST", credentials: "include", redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token: captured.token }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(r.status === 401 || r.status === 403
    ? "Sign into Nodeserver as superadmin and complete two-factor authentication first."
    : "The account could not be verified. Check its Discord account standing and retry.");
  await chrome.storage.session.remove("captured");
  return { ok: true, userId: data.userId, state: data.state };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  handle(message, sender).then(reply).catch((error) => reply({ ok: false,
    error: /^(Unsupported|Open the|Select Connect|The connected|Sign into|The account)/.test(error.message)
      ? error.message : "Connection failed. Check the page and retry." }));
  return true;
});
