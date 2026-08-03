// Service worker: orchestrates extension-driven Epic Games signups.
// Flow (paired with nodeserver-bridge.js + epic-signup.js):
//   1. Admin page (nodeserver origin) posts {type:"epicgen-drive", ...}.
//   2. nodeserver-bridge.js forwards it to us via chrome.runtime.sendMessage.
//   3. We stash the session, open a new tab on epicgames.com/id/register.
//   4. epic-signup.js content script asks us for the session, drives the
//      wizard, asks us to fetch the OTP, and eventually reports the
//      scraped authorizationCode.
//   5. We POST /api/epic/accounts/from-extension and relay success/failure
//      back to the admin page.

const SESSION_KEY = (sessionId) => "epicgen.session." + sessionId;
const ORIGIN_KEY = "epicgen.nodeserverOrigin";

async function saveSession(session) {
  await chrome.storage.session.set({
    [SESSION_KEY(session.sessionId)]: session,
    [ORIGIN_KEY]: session.nodeserverOrigin,
  });
}

async function loadSession(sessionId) {
  const key = SESSION_KEY(sessionId);
  const stored = await chrome.storage.session.get(key);
  return stored[key] || null;
}

async function clearSession(sessionId) {
  await chrome.storage.session.remove(SESSION_KEY(sessionId));
}

async function serverFetch(session, path, init = {}) {
  const url = session.nodeserverOrigin + path;
  const headers = Object.assign(
    { "Content-Type": "application/json", Accept: "application/json" },
    init.headers || {},
  );
  headers["Authorization"] = "Bearer " + session.bearer;
  const res = await fetch(url, Object.assign({}, init, { headers }));
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { success: false, message: "Non-JSON response: " + text.slice(0, 200) };
  }
  if (!res.ok || body.success === false) {
    throw new Error(body.message || "HTTP " + res.status);
  }
  return body;
}

async function reportStatus(session, status, extra = {}) {
  try {
    await serverFetch(session, "/api/epic/signup/" + session.sessionId + "/status", {
      method: "POST",
      body: JSON.stringify(Object.assign({ status }, extra)),
    });
  } catch (err) {
    console.warn("epicgen status report failed:", err.message);
  }
}

async function relayToAdmin(payload) {
  try {
    const stored = await chrome.storage.session.get(ORIGIN_KEY);
    const origin = stored[ORIGIN_KEY];
    if (!origin) return;
    const tabs = await chrome.tabs.query({ url: origin + "/*" });
    for (const t of tabs) {
      try {
        await chrome.tabs.sendMessage(t.id, {
          type: "epicgen-relay",
          payload,
        });
      } catch {
        // Tab was closed — fine.
      }
    }
  } catch (err) {
    console.warn("epicgen admin relay failed:", err.message);
  }
}

async function pollOtp(session, deadlineTs) {
  while (Date.now() < deadlineTs) {
    try {
      const res = await serverFetch(
        session,
        "/api/epic/signup/" + session.sessionId + "/otp",
      );
      if (res.code) return res.code;
    } catch (err) {
      console.warn("epicgen otp poll error:", err.message);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error("OTP timed out after " + Math.round((Date.now() - deadlineTs) / 1000) + "s");
}

// Message handlers.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg && msg.type === "epicgen-drive") {
        // Admin page kicked off a signup. Stash session, open Epic tab.
        const session = {
          sessionId: msg.sessionId,
          bearer: msg.bearer,
          identity: msg.identity,
          redirectUrl: msg.redirectUrl,
          nodeserverOrigin: msg.nodeserverOrigin,
          startedAt: Date.now(),
        };
        await saveSession(session);
        await chrome.tabs.create({
          url:
            "https://www.epicgames.com/id/register?lang=en-US#epicgen=" +
            encodeURIComponent(session.sessionId),
        });
        sendResponse({ ok: true });
        return;
      }
      if (msg && msg.type === "epicgen-session-request") {
        const s = await loadSession(msg.sessionId);
        sendResponse(s ? { ok: true, session: s } : { ok: false });
        return;
      }
      if (msg && msg.type === "epicgen-status") {
        const s = await loadSession(msg.sessionId);
        if (!s) return sendResponse({ ok: false });
        await reportStatus(s, msg.status, msg.extra || {});
        await relayToAdmin({
          kind: "status",
          sessionId: s.sessionId,
          status: msg.status,
          extra: msg.extra || {},
        });
        sendResponse({ ok: true });
        return;
      }
      if (msg && msg.type === "epicgen-request-otp") {
        const s = await loadSession(msg.sessionId);
        if (!s) return sendResponse({ ok: false, error: "session missing" });
        const deadline = Date.now() + 5 * 60 * 1000;
        try {
          const code = await pollOtp(s, deadline);
          sendResponse({ ok: true, code });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
      if (msg && msg.type === "epicgen-open-redirect") {
        const s = await loadSession(msg.sessionId);
        if (!s) return sendResponse({ ok: false, error: "session missing" });
        // Open the OAuth redirect URL in a new tab; epic-signup.js's
        // second matcher (on /id/api/redirect) will scrape the code.
        const tab = await chrome.tabs.create({
          url: s.redirectUrl + "#epicgen=" + encodeURIComponent(s.sessionId),
          active: false,
        });
        sendResponse({ ok: true, tabId: tab.id });
        return;
      }
      if (msg && msg.type === "epicgen-authcode") {
        const s = await loadSession(msg.sessionId);
        if (!s) return sendResponse({ ok: false, error: "session missing" });
        try {
          const res = await serverFetch(s, "/api/epic/accounts/from-extension", {
            method: "POST",
            body: JSON.stringify({
              sessionId: s.sessionId,
              authorizationCode: msg.code,
              totpSecret: msg.totpSecret || "",
              label: msg.label || "",
            }),
          });
          await relayToAdmin({
            kind: "verified",
            sessionId: s.sessionId,
            account: res.account,
          });
          await clearSession(s.sessionId);
          if (sender.tab && sender.tab.id) {
            chrome.tabs.remove(sender.tab.id).catch(() => {});
          }
          sendResponse({ ok: true, account: res.account });
        } catch (err) {
          await relayToAdmin({
            kind: "failed",
            sessionId: s.sessionId,
            error: err.message,
          });
          sendResponse({ ok: false, error: err.message });
        }
        return;
      }
      if (msg && msg.type === "epicgen-abort") {
        const s = await loadSession(msg.sessionId);
        if (s) {
          await reportStatus(s, "failed", {
            lastError: msg.reason || "aborted",
          });
          await clearSession(s.sessionId);
        }
        await relayToAdmin({
          kind: "failed",
          sessionId: msg.sessionId,
          error: msg.reason || "aborted",
        });
        sendResponse({ ok: true });
        return;
      }
      sendResponse({ ok: false, error: "unknown message type" });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();
  return true; // keep the channel open for async sendResponse
});
