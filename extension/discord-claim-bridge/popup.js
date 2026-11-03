/* global chrome, document */
const status = document.getElementById("status");
async function send(action) {
  return chrome.runtime.sendMessage({ action, target: document.getElementById("target").value });
}
for (const [id, action] of [["connect", "arm"], ["save", "import"], ["clear", "clear"]]) {
  document.getElementById(id).onclick = async (event) => {
    event.target.disabled = true;
    try {
      const r = await send(action);
      status.textContent = !r.ok ? r.error : action === "arm"
        ? "Discord is refreshing. Reopen this popup after it loads, then save the account."
        : action === "clear" ? "Captured session forgotten."
          : `Saved account ${r.userId} (${r.state}). Open Discord Farm and Sync rewards.`;
    } catch { status.textContent = "Connection failed. Reopen the popup and retry."; }
    finally { event.target.disabled = false; }
  };
}
send("status").then((r) => { if (r.ok) status.textContent = `Account ${r.userId} ready to save.`; }).catch(() => {});
