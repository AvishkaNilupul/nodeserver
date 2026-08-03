// Bridge between the nodeserver admin page and the extension service
// worker. Runs on every page (cheap — just a couple of listeners) but
// only reacts to epicgen-* postMessages, and re-broadcasts service-worker
// relay messages back to the page via postMessage.
(function () {
  "use strict";
  if (window.__epicgenBridgeInstalled) return;
  window.__epicgenBridgeInstalled = true;

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var m = ev.data;
    if (!m || typeof m !== "object" || typeof m.type !== "string") return;
    if (m.type.indexOf("epicgen-") !== 0) return;
    // Only "epicgen-drive" and "epicgen-ping" originate on the page.
    if (m.type !== "epicgen-drive" && m.type !== "epicgen-ping") return;
    try {
      chrome.runtime.sendMessage(m, function (resp) {
        window.postMessage(
          {
            type: m.type + "-ack",
            ok: !!(resp && resp.ok),
            error: resp && resp.error,
            payload: resp,
          },
          location.origin,
        );
      });
    } catch (err) {
      window.postMessage(
        {
          type: m.type + "-ack",
          ok: false,
          error: err && err.message,
        },
        location.origin,
      );
    }
  });

  // Answer presence pings so the admin card can show "extension detected".
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "epicgen-relay") {
      window.postMessage(
        { type: "epicgen-relay", payload: msg.payload },
        location.origin,
      );
      sendResponse({ ok: true });
      return;
    }
    return false;
  });

  // Announce presence to any listener already registered on the page.
  window.postMessage(
    { type: "epicgen-hello", version: "1.2.0" },
    location.origin,
  );
})();
