// Signup orchestration. Outlook stays on localhost; panel gets no mail tokens.
const MAIL = 'http://127.0.0.1:3999';
const KEY = 'epicgen.active';
const PENDING = 'epicgen.pending';
const isEpic = (url) => {
  try { const u = new URL(url); return u.protocol === 'https:' &&
    ['www.epicgames.com', 'epicgames.com', 'store.epicgames.com', 'accounts.epicgames.com'].includes(u.hostname); } catch { return false; }
};
const isPanel = (url) => {
  try { const u = new URL(url); return ['https:', 'http:'].includes(u.protocol) && u.pathname === '/epic-accounts.html'; }
  catch { return false; }
};
async function request(url, init = {}, timeout = 24000) {
  let res;
  try { res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) }); }
  catch { throw new Error(url.startsWith(MAIL) ? 'Local Outlook reader unavailable. Start scripts/mail-dashboard.js on port 3999.' : 'Panel request failed or timed out'); }
  const body = await res.json();
  if (!res.ok || body.ok === false || body.success === false) throw new Error(body.message || body.error || `HTTP ${res.status}`);
  return body;
}
const local = (path, body) => request(MAIL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }, path === '/api/epic/proxy' ? 30000 : 24000);
const server = (s, path, body) => request(s.nodeserverOrigin + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + s.bearer }, body: JSON.stringify(body),
});
async function relay(s, payload) {
  try { await chrome.tabs.sendMessage(s.adminTab, { type: 'epicgen-relay', payload: { sessionId: s.sessionId, ...payload } }); } catch {}
}
async function finish(s, status, detail = '') {
  // Keep the reservation consumed on a failure: Epic may have accepted the email.
  await local('/api/pool/release', { email: s.identity.email, for: 'epic', status, detail });
}
let mutationBusy = false;
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const mutation = ['epicgen-allocate', 'epicgen-drive', 'epicgen-cancel', 'epicgen-open-redirect'].includes(msg?.type);
  if (mutation && mutationBusy) { respond({ ok: false, error: 'Signup operation already in progress' }); return false; }
  if (mutation) mutationBusy = true;
  (async () => {
    if (!msg?.type?.startsWith('epicgen-')) return { ok: false };
    const panel = isPanel(sender.tab?.url);
    if (msg.type === 'epicgen-ping') return { ok: panel, version: '1.5.0' };
    if (msg.type === 'epicgen-allocate') {
      if (!panel) throw new Error('Open the Epic Accounts panel first');
      const stored = await chrome.storage.session.get([KEY, PENDING]);
      if (stored[KEY] || stored[PENDING]) throw new Error('A signup or reservation is already active. Finish or cancel it first.');
      // Every signup gets a clean cookie jar, independently of proxy choice.
      if (!await chrome.extension.isAllowedIncognitoAccess()) throw new Error('Enable Allow in Incognito for this extension at chrome://extensions to isolate this signup.');
      if ((await chrome.windows.getAll()).some(w => w.incognito)) throw new Error('Close other private Chrome windows before starting an isolated signup.');
      let proxy = null;
      if (msg.useProxy) {
        const current = await chrome.proxy.settings.get({ incognito: true });
        if (current.levelOfControl === 'controlled_by_other_extensions' || current.levelOfControl === 'not_controllable') throw new Error('Another extension or Chrome policy controls the proxy.');
        proxy = (await local('/api/epic/proxy')).proxy;
      }
      let mailbox;
      if (msg.resumeMailbox) {
        const pool = await request(MAIL + '/api/accounts');
        const owned = pool.find(a => a.email.toLowerCase() === msg.resumeMailbox.address?.toLowerCase() && a.uses?.epic);
        if (!owned) throw new Error('This inbox has no existing Epic reservation');
        mailbox = { address: owned.email, provider: 'outlook-local', reservedAt: new Date().toISOString() };
        await local('/api/pool/release', { email: owned.email, for: 'epic', status: 'reserved', detail: 'Resume existing Epic signup' });
      } else {
        const row = await local('/api/pool/pick?for=epic');
        mailbox = { address: row.email, provider: 'outlook-local', reservedAt: new Date().toISOString() };
      }
      await chrome.storage.session.set({ [PENDING]: { mailbox, proxy, adminTab: sender.tab.id } });
      return { ok: true, mailbox, creationLocation: proxy?.location || null };
    }
    if (msg.type === 'epicgen-cancel') {
      if (!panel) throw new Error('Open the Epic Accounts panel first');
      const stored = await chrome.storage.session.get([KEY, PENDING]);
      const s = stored[KEY]; const p = stored[PENDING];
      if ((s || p)?.adminTab !== sender.tab.id) throw new Error('No signup belongs to this panel tab');
      if (s) {
        await server(s, `/api/epic/signup/${s.sessionId}/status`, { status: 'failed', lastError: 'Cancelled from panel' });
        await finish(s, 'fail', 'Cancelled from panel');
      } else if (p) {
        await local('/api/pool/release', { email: p.mailbox.address, for: 'epic', status: 'fail', detail: 'Cancelled before signup' });
      }
      await chrome.storage.session.remove([KEY, PENDING]);
      if (s?.windowId) await chrome.windows.remove(s.windowId).catch(() => {});
      return { ok: true };
    }
    if (msg.type === 'epicgen-drive') {
      if (!panel) throw new Error('Open the Epic Accounts panel first');
      const stored = await chrome.storage.session.get([PENDING, KEY]);
      const pending = stored[PENDING];
      if (stored[KEY] || pending?.adminTab !== sender.tab.id || pending.mailbox.address !== msg.identity?.email) throw new Error('Outlook reservation does not match this signup');
      const s = { sessionId: msg.sessionId, bearer: msg.bearer, identity: msg.identity,
        redirectUrl: msg.redirectUrl, nodeserverOrigin: new URL(sender.tab.url).origin,
        adminTab: sender.tab.id, reservedAt: pending.mailbox.reservedAt, proxy: pending.proxy, tabs: [], automation: {autoSubmit:msg.automation?.autoSubmit===true,autoAcceptEula:msg.automation?.autoAcceptEula===true}, login: Boolean(msg.login), otpDelivered: Boolean(msg.login) };
      if (!isEpic(s.redirectUrl)) throw new Error('Invalid Epic redirect URL');
      // Chrome private windows share one jar: reject an existing private window.
      if (!await chrome.extension.isAllowedIncognitoAccess()) throw new Error('Enable Allow in Incognito for this extension before continuing.');
      if ((await chrome.windows.getAll()).some(w => w.incognito)) throw new Error('Close other private Chrome windows before starting an isolated signup.');
      const win = await chrome.windows.create({ url: 'about:blank', incognito: true });
      s.windowId = win.id; const tab = win.tabs[0];
      if (s.proxy) {
        try {
          await chrome.proxy.settings.set({ scope: 'incognito_session_only', value: {
            mode: 'fixed_servers', rules: { singleProxy: { scheme: s.proxy.scheme, host: s.proxy.host, port: s.proxy.port }, bypassList: ['localhost', '127.0.0.1'] },
          } });
        } catch (e) { await chrome.windows.remove(win.id); throw e; }
      }
      s.tabs.push(tab.id);
      await chrome.storage.session.set({ [KEY]: s });
      await chrome.storage.session.remove(PENDING);
      await chrome.tabs.update(tab.id, { url: 'https://www.epicgames.com/id/' + (s.login ? 'login' : 'register') + '?lang=en-US#epicgen=' + encodeURIComponent(s.sessionId) });
      return { ok: true };
    }
    const { [KEY]: s } = await chrome.storage.session.get(KEY);
    if (!s || !isEpic(sender.tab?.url) || !s.tabs.includes(sender.tab.id)) throw new Error('No signup assigned to this Epic tab');
    if (msg.type !== 'epicgen-session-request' && msg.sessionId !== s.sessionId) throw new Error('Session mismatch');
    if (msg.type === 'epicgen-session-request') return { ok: true, session: { sessionId: s.sessionId, identity: s.identity, login: s.login, automation:s.automation } };
    if (msg.type === 'epicgen-status') {
      await server(s, `/api/epic/signup/${s.sessionId}/status`, { status: msg.status, ...msg.extra, creationLocation:s.proxy?.location || null });
      await relay(s, { kind: 'status', status: msg.status });
      return { ok: true };
    }
    if (msg.type === 'epicgen-request-otp') {
      // One bounded read per message keeps the MV3 worker alive and lets
      // the content script retry without a five-minute message channel.
      try {
        const since = s.lastOtpReceivedAt && Number.isFinite(Date.parse(s.lastOtpReceivedAt))
          ? new Date(Math.max(Date.parse(s.reservedAt), Date.parse(s.lastOtpReceivedAt) + 1)).toISOString() : s.reservedAt;
        const hit = await local(`/api/accounts/${encodeURIComponent(s.identity.email)}/otp?for=epic&since=${encodeURIComponent(since)}&via=graph`);
        if (hit.receivedAt && Number.isFinite(Date.parse(hit.receivedAt))) s.lastOtpReceivedAt = hit.receivedAt;
        s.otpDelivered = true;
        await chrome.storage.session.set({ [KEY]: s });
        return { ok: true, code: hit.code };
      } catch (e) { return { ok: true, waiting: true, error: e.message }; }
    }
    if (msg.type === 'epicgen-resume-current') {
      // Explicit operator retry in the assigned tab; never reserve another inbox.
      s.challengeReloads = 0; s.failureReason = '';
      await chrome.storage.session.set({ [KEY]: s });
      await server(s, `/api/epic/signup/${s.sessionId}/status`, { status: 'wizard_open', lastError: '' });
      await relay(s, { kind: 'status', status: 'wizard_open' });
      return { ok: true };
    }
    if (msg.type === 'epicgen-retry-challenge') {
      if ((s.challengeReloads || 0) >= 2) throw new Error('Epic rejected the CAPTCHA response after two refreshes. Recover this signup later.');
      s.challengeReloads = (s.challengeReloads || 0) + 1;
      if(new URL(sender.tab.url).pathname.startsWith('/id/login'))s.login=true;
      await chrome.storage.session.set({ [KEY]: s });
      return { ok: true };
    }
    if (msg.type === 'epicgen-reset-auth-context') {
      if ((s.authContextResets || 0) >= 1) throw new Error('Epic login context recovery already attempted. Recover this signup later.');
      s.authContextResets = (s.authContextResets || 0) + 1; s.login = true;
      await chrome.storage.session.set({ [KEY]: s });
      return { ok: true };
    }
    if (msg.type === 'epicgen-recover-auth') {
      if (!s.otpDelivered || (s.authRecoveries || 0) >= 1) throw new Error('Email authentication recovery already attempted. Recover this account from the panel.');
      s.authRecoveries = (s.authRecoveries || 0) + 1; s.login = true;
      await chrome.storage.session.set({ [KEY]: s });
      return { ok: true };
    }
    if (msg.type === 'epicgen-open-redirect') {
      if (!s.otpDelivered) throw new Error('No signup verification was completed. Sign out of the existing Epic account and start again.');
      let captureId = s.captureTabId;
      if (!captureId) {
        const tab = await chrome.tabs.create({ url: 'about:blank', active: false, ...(s.windowId ? { windowId: s.windowId } : {}) });
        captureId = tab.id; s.captureTabId = captureId; s.tabs.push(captureId);
        await chrome.storage.session.set({ [KEY]: s });
      }
      await chrome.tabs.update(captureId, { url: s.redirectUrl + '#epicgen=' + encodeURIComponent(s.sessionId) });
      return { ok: true };
    }
    if (msg.type === 'epicgen-authcode') {
      if (!s.otpDelivered) throw new Error('Signup verification is incomplete');
      const result = await server(s, '/api/epic/accounts/from-extension', { sessionId: s.sessionId, authorizationCode: msg.code });
      // Account is saved even if local usage finalization fails. Reservation
      // remains consumed and prevents reuse of this address.
      let warning = '';
      try { await finish(s, 'ok'); } catch (e) { warning = e.message; }
      await relay(s, { kind: 'verified', account: result.account, warning });
      await chrome.storage.session.remove(KEY);
      if (s.windowId) await chrome.windows.remove(s.windowId).catch(() => {});
      return { ok: true, account: result.account };
    }
    if (msg.type === 'epicgen-abort') {
      s.failureReason = msg.reason || 'Signup stopped';
      await chrome.storage.session.set({ [KEY]: s });
      await server(s, `/api/epic/signup/${s.sessionId}/status`, { status: 'failed', lastError: msg.reason || 'Signup stopped' });
      try { await finish(s, 'fail', msg.reason); } catch {}
      await relay(s, { kind: 'failed', error: msg.reason });
      // Preserve the window, proxy, and session for inspection or token retry.
      // Explicit Cancel or closing the private window still cleans up.
      return { ok: true };
    }
    throw new Error('Unknown signup message');
  })().then(value => { if (mutation) mutationBusy = false; respond(value); }, e => { if (mutation) mutationBusy = false; respond({ ok: false, error: e.message }); });
  return true;
});

const authAttempts = new Map();
// Answer only the configured proxy's challenge, only for assigned signup tabs.
chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  chrome.storage.session.get(KEY).then(({ [KEY]: s }) => {
    if (!details.isProxy || !s?.proxy || !s.tabs.includes(details.tabId) ||
        details.challenger.host !== s.proxy.host || details.challenger.port !== s.proxy.port) return callback({});
    const attempts = (authAttempts.get(details.requestId) || 0) + 1;
    authAttempts.set(details.requestId, attempts);
    if (attempts > 2) return callback({ cancel: true });
    callback({ authCredentials: { username: s.proxy.username, password: s.proxy.password } });
  }).catch(() => callback({}));
}, { urls: ['<all_urls>'] }, ['asyncBlocking']);
chrome.windows.onRemoved.addListener(async windowId => {
  const { [KEY]: s } = await chrome.storage.session.get(KEY);
  if (!s || s.windowId !== windowId) return;
  const reason=s.failureReason || 'Signup window closed';
  if(!s.failureReason) { try { await server(s, `/api/epic/signup/${s.sessionId}/status`, { status: 'failed', lastError: reason }); } catch {} }
  try { await finish(s, 'fail', reason); } catch {}
  await relay(s, { kind: 'failed', error: reason });
  await chrome.storage.session.remove(KEY);
});

const clearAuthAttempt = d => authAttempts.delete(d.requestId);
chrome.webRequest.onCompleted.addListener(clearAuthAttempt, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(clearAuthAttempt, { urls: ['<all_urls>'] });
