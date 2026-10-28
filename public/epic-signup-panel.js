(function () {
  const status = document.getElementById('signupStatus');
  const start = document.getElementById('signupStart');
  const cancel = document.getElementById('signupCancel');
  let active = null;
  function extension(type, data = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Extension did not respond. Reload version 1.4.0 at chrome://extensions, then refresh this page.')); }, timeout);
      function listener(ev) {
        if (ev.source !== window || ev.origin !== location.origin || ev.data?.type !== type + '-ack') return;
        clearTimeout(timer); window.removeEventListener('message', listener);
        ev.data.ok ? resolve(ev.data.payload) : reject(new Error(/context invalidated/i.test(ev.data.error || '') ? 'Extension was reloaded. Refresh this generator page to reconnect, then try again.' : ev.data.error || 'Extension request failed'));
      }
      window.addEventListener('message', listener);
      window.postMessage({ ...data, type }, location.origin);
    });
  }
  async function signupApi(path, options) {
    let response;
    try { const localToken=document.querySelector?.('meta[name="epic-local-token"]')?.content; response = await fetch(path, {credentials:'same-origin',cache:'no-store',...options,headers:{...(options?.headers||{}),...(localToken?{'X-Local-Token':localToken}:{})}}); }
    catch { throw new Error('Cannot reach the local generator. Reopen http://127.0.0.1:4107/epic-accounts.html and check its background service.'); }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.success === false) throw new Error(data?.message || (response.status === 401 ? 'Sign in to the server again.' : 'Signup service unavailable (HTTP ' + response.status + ').'));
    return data;
  }
  start.addEventListener('click', async () => {
    start.disabled = true;
    let reserved = false;
    try {
      status.textContent = 'Checking local generator…';
      await signupApi('/api/epic/signup/health');
      const ping=await extension('epicgen-ping', {}, 3000);
      if(document.getElementById('signupAuto')?.checked && ping.version!=='1.4.0')throw Error('Reload extension version 1.4.0 before using automatic submission.');
      status.textContent = 'Reserving an Outlook inbox…';
      const { mailbox } = await extension('epicgen-allocate', { useProxy: document.getElementById('signupProxy').checked });
      reserved = true;
      status.textContent = 'Preparing signup for ' + mailbox.address + '…';
      const body = await signupApi('/api/epic/signup/start', {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({mailbox,automation:{autoSubmit:!!document.getElementById('signupAuto')?.checked,autoAcceptEula:!!document.getElementById('signupAuto')?.checked}})});
      active = body.session.sessionId;
      await extension('epicgen-drive', body.session);
      status.textContent = 'Signup opened for ' + mailbox.address + '. Complete any captcha in the Epic tab; Outlook verification runs automatically.';
    } catch (e) {
      if (reserved && !active) { try { await extension('epicgen-cancel'); } catch {} }
      status.textContent = e.message;
      start.disabled = false;
    }
  });
  async function resumeSignup(mode = 'register') {
    const resume = document.getElementById(mode === 'login' ? 'signupRecover' : 'signupResume');
    resume.disabled = true; start.disabled = true;
    try {
      status.textContent = 'Checking local generator…';
      await signupApi('/api/epic/signup/health');
      const ping=await extension('epicgen-ping', {}, 3000);
      if(document.getElementById('signupAuto')?.checked && ping.version!=='1.4.0')throw Error('Reload extension version 1.4.0 before using automatic submission.');
      const recent = await signupApi('/api/epic/signup/recent?limit=1');
      const last = recent.sessions?.[0];
      if (!last || last.status === 'verified') throw new Error('No interrupted signup to resume');
      const data = await signupApi('/api/epic/signup/' + encodeURIComponent(last.sessionId) + '/resume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode,automation:{autoSubmit:!!document.getElementById('signupAuto')?.checked,autoAcceptEula:!!document.getElementById('signupAuto')?.checked} }) });
      await extension('epicgen-allocate', { useProxy: document.getElementById('signupProxy').checked, resumeMailbox: data.session.mailbox });
      active = data.session.sessionId;
      await extension('epicgen-drive', data.session);
      status.textContent = 'Resuming signup with the same Outlook address.';
    } catch (e) { status.textContent = e.message; start.disabled = false; }
    finally { resume.disabled = false; }
  }
  document.getElementById('signupResume').addEventListener('click', () => resumeSignup());
  document.getElementById('signupRecover').addEventListener('click', () => resumeSignup('login'));
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    try {
      await extension('epicgen-cancel');
      active = null; start.disabled = false;
      status.textContent = 'Signup cancelled. The inbox stays reserved to prevent duplicate Epic registrations.';
    } catch (e) { status.textContent = e.message; }
    finally { cancel.disabled = false; }
  });
  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== location.origin || ev.data?.type !== 'epicgen-relay') return;
    const p = ev.data.payload;
    if (active && p.sessionId !== active) return;
    if (p.kind === 'verified') {
      status.textContent = 'Epic account saved locally.' + (p.warning ? ' ' + p.warning : '');
      active = null; start.disabled = false;
      if (typeof load === 'function') load();
    } else if (p.kind === 'failed') {
      status.textContent = p.error || 'Signup failed'; active = null; start.disabled = false;
    } else if (p.kind === 'status') status.textContent = p.status.replace(/_/g, ' ');
  });
})();
