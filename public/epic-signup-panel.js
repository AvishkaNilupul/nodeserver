(function () {
  const status = document.getElementById('signupStatus');
  const start = document.getElementById('signupStart');
  const cancel = document.getElementById('signupCancel');
  const batchStart = document.getElementById('signupBatchStart');
  const batchStop = document.getElementById('signupBatchStop');
  const batchCount = document.getElementById('signupBatchCount');
  const batchStatus = document.getElementById('signupBatchStatus');
  let active = null, preparing = false, batch = null, nextTimer = null;
  function controls() {
    start.disabled = !!active || preparing || !!batch;
    for (const id of ['signupResume', 'signupRecover']) document.getElementById(id).disabled = !!active || preparing || !!batch;
    cancel.disabled = preparing;
    for (const id of ['signupProxy', 'signupAuto', 'signupSampleContact']) { const node = document.getElementById(id); if (node) node.disabled = preparing || !!active || !!batch; }
    if (batchStart) batchStart.disabled = start.disabled;
    if (batchCount) batchCount.disabled = start.disabled;
    if (batchStop) batchStop.disabled = !batch || batch.stopping;
  }
  function progress(detail) {
    if (batchStatus) batchStatus.textContent = detail;
  }
  function endBatch(detail) {
    clearTimeout(nextTimer); nextTimer = null; batch = null;
    progress(detail); controls();
  }
  function options() {
    return {useProxy:!!document.getElementById('signupProxy')?.checked,
      generateSampleContact:!!document.getElementById('signupSampleContact')?.checked,
      automation:{autoSubmit:!!document.getElementById('signupAuto')?.checked,autoAcceptEula:!!document.getElementById('signupAuto')?.checked}};
  }
  function extension(type, data = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener('message', listener); reject(new Error('Extension did not respond. Reload version 1.5.0 at chrome://extensions, then refresh this page.')); }, timeout);
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
  async function startSignup(settings = options()) {
    if (active || preparing) return;
    preparing = true; controls();
    let reserved = false;
    try {
      status.textContent = 'Checking local generator…';
      await signupApi('/api/epic/signup/health');
      const ping=await extension('epicgen-ping', {}, 3000);
      if(settings.automation.autoSubmit && ping.version!=='1.5.0')throw Error('Reload extension version 1.5.0 before using automatic submission.');
      status.textContent = 'Reserving an Outlook inbox…';
      const { mailbox, creationLocation } = await extension('epicgen-allocate', { useProxy: settings.useProxy }, 60000);
      reserved = true;
      status.textContent = 'Preparing signup for ' + mailbox.address + '…';
      const body = await signupApi('/api/epic/signup/start', {method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({mailbox,creationLocation,generateSampleContact:settings.generateSampleContact,automation:settings.automation})});
      active = body.session.sessionId;
      await extension('epicgen-drive', body.session);
      status.textContent = 'Signup opened for ' + mailbox.address + '. Complete any captcha in the Epic tab; Outlook verification runs automatically.';
    } catch (e) {
      if (reserved && !active) { try { await extension('epicgen-cancel'); } catch {} }
      active = null;
      status.textContent = e.message;
      if (batch) endBatch('Batch stopped: ' + batch.completed + ' of ' + batch.total + ' saved. ' + e.message);
    } finally { preparing = false; controls(); }
  }
  start.addEventListener('click', () => { if (!batch) return startSignup(); });
  batchStart?.addEventListener('click', async () => {
    if (active || preparing || batch) return;
    const total = Number(batchCount.value);
    if (!Number.isInteger(total) || total < 1 || total > 50) { progress('Choose a whole number from 1 to 50.'); return; }
    const settings = options();
    if (!settings.automation.autoSubmit) { progress('Enable automatic submission above before starting a batch.'); return; }
    batch = {total, completed:0, settings, stopping:false}; controls();
    progress('Account 1 of ' + total + ' — 0 saved.');
    await startSignup(settings);
  });
  batchStop?.addEventListener('click', () => {
    if (!batch) return;
    if (active || preparing) {
      batch.stopping = true; controls();
      progress('Stopping after this account. ' + batch.completed + ' of ' + batch.total + ' saved.');
    } else endBatch('Batch stopped. ' + batch.completed + ' of ' + batch.total + ' saved.');
  });
  async function resumeSignup(mode = 'register') {
    if (active || preparing || batch) return;
    preparing = true;
    controls();
    try {
      status.textContent = 'Checking local generator…';
      await signupApi('/api/epic/signup/health');
      const ping=await extension('epicgen-ping', {}, 3000);
      if(document.getElementById('signupAuto')?.checked && ping.version!=='1.5.0')throw Error('Reload extension version 1.5.0 before using automatic submission.');
      const recent = await signupApi('/api/epic/signup/recent?limit=1');
      const chosen=document.getElementById('signupSession')?.value;
      const last = chosen ? recent.sessions?.find(s=>s.sessionId===chosen) : recent.sessions?.find(s=>s.status!=='verified');
      if (!last || last.status === 'verified') throw new Error('No interrupted signup to resume');
      const data = await signupApi('/api/epic/signup/' + encodeURIComponent(last.sessionId) + '/resume', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode,automation:{autoSubmit:!!document.getElementById('signupAuto')?.checked,autoAcceptEula:!!document.getElementById('signupAuto')?.checked} }) });
      await extension('epicgen-allocate', { useProxy: document.getElementById('signupProxy').checked, resumeMailbox: data.session.mailbox });
      active = data.session.sessionId;
      await extension('epicgen-drive', data.session);
      status.textContent = 'Resuming signup with the same Outlook address.';
    } catch (e) { active = null; status.textContent = e.message; }
    finally { preparing = false; controls(); }
  }
  document.getElementById('signupResume').addEventListener('click', () => resumeSignup());
  document.getElementById('signupRecover').addEventListener('click', () => resumeSignup('login'));
  cancel.addEventListener('click', async () => {
    if (batch) endBatch('Batch cancelled. ' + batch.completed + ' of ' + batch.total + ' saved.');
    cancel.disabled = true;
    try {
      await extension('epicgen-cancel');
      active = null; controls();
      status.textContent = 'Signup cancelled. The inbox stays reserved to prevent duplicate Epic registrations.';
    } catch (e) { status.textContent = e.message; }
    finally { cancel.disabled = false; }
  });
  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== location.origin || ev.data?.type !== 'epicgen-relay') return;
    const p = ev.data.payload;
    if (!active || p.sessionId !== active) return;
    if (p.kind === 'verified') {
      status.textContent = 'Epic account saved locally.' + (p.warning ? ' ' + p.warning : '');
      active = null;
      if (typeof load === 'function') load();
      if (batch) {
        batch.completed++;
        if (p.warning) endBatch('Batch stopped: ' + batch.completed + ' of ' + batch.total + ' saved. ' + p.warning);
        else if (batch.stopping || batch.completed >= batch.total) endBatch((batch.stopping ? 'Batch stopped. ' : 'Batch complete. ') + batch.completed + ' of ' + batch.total + ' saved.');
        else {
          progress(batch.completed + ' of ' + batch.total + ' saved. Next account starts in 5 seconds…');
          nextTimer = setTimeout(() => {
            nextTimer = null;
            if (!batch) return;
            progress('Account ' + (batch.completed + 1) + ' of ' + batch.total + ' — ' + batch.completed + ' saved.');
            startSignup(batch.settings);
          }, 5000);
        }
      }
      controls();
    } else if (p.kind === 'failed') {
      status.textContent = p.error || 'Signup failed'; active = null;
      if (batch) endBatch('Batch stopped: ' + batch.completed + ' of ' + batch.total + ' saved. Recover the interrupted account before continuing.');
      controls();
    } else if (p.kind === 'status') {
      status.textContent = p.status.replace(/_/g, ' ');
      if (batch) progress('Account ' + (batch.completed + 1) + ' of ' + batch.total + ' — ' + batch.completed + ' saved. ' + (p.status === 'awaiting_captcha' ? 'Complete the security check in the Epic window; the batch will wait.' : status.textContent));
    }
  });
})();
