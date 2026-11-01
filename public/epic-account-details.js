/* Account details tab of /epic-accounts.html (layout contract: docs/EPIC-PAGE-UI.md).
   Account records share Epic's existing claim inventory and sold state.
   A searchable account list on the left, the chosen account's form on the right. */
(() => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const SEARCH_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>';

  function init() {
    const panel = document.getElementById('epic-details-panel');
    if (!panel || panel.dataset.ready) return;
    panel.dataset.ready = '1';
    panel.innerHTML = `
      <div class="ed-layout">
        <aside class="ep-card ed-side">
          <div class="ep-card-hd">
            <h2 class="ep-card-title">Accounts</h2><span class="ep-card-meta" id="epic-detail-count"></span>
            <div class="ep-card-actions"><button type="button" class="btn btn-sm" id="epic-detail-refresh">Refresh</button></div>
          </div>
          <div class="ed-side-bd">
            <label class="ep-search">${SEARCH_ICON}<input type="search" id="epic-detail-search" placeholder="Search accounts" aria-label="Search accounts" autocomplete="off" /></label>
            <div class="ed-list" id="epic-detail-list" aria-label="Accounts"><div class="ep-empty">Loading…</div></div>
          </div>
          <div class="ep-card-ft">
            <details class="ep-help ed-tools"><summary>Bulk tools</summary>
              <div>
                <label class="ep-check"><input type="checkbox" id="epic-detail-samples" /> Include fictional internal contact samples</label>
                <button type="button" class="btn btn-sm" id="epic-detail-backfill">Fill missing details for past accounts</button>
              </div>
            </details>
          </div>
        </aside>
        <div class="ed-main">
          <div class="ep-card" id="epic-detail-empty">
            <div class="ep-empty"><b>Choose an account</b><span id="epic-detail-empty-msg">Pick one from the list to see and edit its sign-in, owner and contact details.</span></div>
          </div>
          <form id="epic-detail-form" class="ep-card" hidden autocomplete="off">
            <div class="ep-card-hd ed-form-hd">
              <div class="ed-title"><h2 class="ep-card-title" id="epic-detail-name"></h2><span class="ed-badges" id="epic-detail-badges"></span></div>
              <p class="ep-card-meta" id="epic-detail-summary"></p>
            </div>
            <div class="ep-card-bd">
              <section class="ed-sec"><h3>Sign-in</h3><div class="epic-detail-grid">
                <label>Stock label<input name="label" maxlength="160" /></label>
                <label>Stored sign-in email<input name="email" type="email" maxlength="254" autocomplete="off" /></label>
                <label>Epic password<input name="password" type="password" maxlength="256" autocomplete="new-password" placeholder="Leave blank to keep saved password" /></label>
                <label>2FA setup key<input name="totpSecret" type="password" maxlength="256" autocomplete="new-password" placeholder="Leave blank to keep saved key" /></label>
              </div></section>
              <section class="ed-sec"><h3>Owner</h3><div class="epic-detail-grid">
                <label>First name<input name="firstName" maxlength="80" /></label>
                <label>Last name<input name="lastName" maxlength="80" /></label>
                <label>Date of birth<input name="dateOfBirth" type="date" min="1900-01-01" /></label>
              </div></section>
              <section class="ed-sec"><h3>Location</h3><div class="epic-detail-grid">
                <label>Epic account country<input name="country" maxlength="2" placeholder="e.g. CO" /></label>
                <label>Creation country<input id="epic-creation-country" readonly /></label>
                <label>Creation location source<input id="epic-creation-source" readonly /></label>
                <label>Signup IP<input id="epic-creation-ip" readonly /></label>
              </div></section>
              <section class="ed-sec"><h3>Contact (internal)</h3><div class="epic-detail-grid">
                <label>Phone number (internal)<input name="phone" maxlength="80" /></label>
                <label>Address<input name="address" maxlength="500" /></label>
              </div>
              <div class="ed-contact-row"><p id="epic-contact-source" class="hint"></p><button type="button" class="btn btn-sm" id="epic-detail-generate">Generate internal contact samples</button></div></section>
              <section class="ed-sec"><h3>Notes</h3><label class="epic-detail-notes">Internal notes<textarea name="notes" maxlength="4000" rows="4"></textarea></label></section>
            </div>
            <div class="ep-card-ft ed-savebar">
              <button class="btn btn-primary" id="epic-detail-save" type="submit">Save details</button>
              <button type="button" class="btn" id="epic-detail-reveal">Show saved credentials</button>
              <button type="button" class="btn" id="epic-detail-copy">Copy sale details</button>
              <span class="ep-badge is-warn" id="epic-detail-dirty" hidden>Unsaved changes</span>
              <p id="epic-detail-status" class="ed-status" role="status"></p>
            </div>
            <div class="ep-card-bd ed-after">
              <div id="epic-detail-secrets" class="epic-detail-grid" hidden>
                <label>Saved Epic password<input id="epic-detail-saved-password" type="text" readonly autocomplete="off" /></label>
                <label>Saved 2FA setup key<input id="epic-detail-saved-totp" type="text" readonly autocomplete="off" /></label>
              </div>
              <p class="hint">Copied sale details include saved login details, name, date of birth, country and owned games. Internal notes and sign-in tokens are excluded.</p>
              <h3>Owned games</h3><ul id="epic-detail-games" class="ed-games"></ul>
            </div>
          </form>
        </div>
      </div>`;

    const $ = (id) => document.getElementById(id);
    const form = $('epic-detail-form'), listEl = $('epic-detail-list'), search = $('epic-detail-search');
    let selected = null, currentId = '', dirty = false, hideTimer, requestVersion = 0, accounts = [];
    const visible = () => !panel.hidden;
    const narrow = () => window.matchMedia('(max-width: 1000px)').matches;
    const status = (text, error = false) => {
      for (const id of ['epic-detail-status', 'epic-detail-empty-msg']) {
        $(id).textContent = text;
        $(id).classList.toggle('ep-error', !!error);
      }
    };
    const setDirty = (on) => { dirty = on; $('epic-detail-dirty').hidden = !on; };
    const labelOf = (a) => a.label || a.displayName || a.accountId;
    async function request(path, opts = {}) {
      const r = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
      const data = await r.json(); if (!r.ok || data.success === false) throw Error(data.message || 'Request failed'); return data;
    }
    function hideSecrets() {
      clearTimeout(hideTimer); $('epic-detail-secrets').hidden = true;
      $('epic-detail-saved-password').value = ''; $('epic-detail-saved-totp').value = '';
      $('epic-detail-reveal').textContent = 'Show saved credentials';
    }
    function showForm(on) { form.hidden = !on; $('epic-detail-empty').hidden = on; }

    // Unsold first, newest first: the accounts you work on are at the top.
    function sortAccounts(rows) {
      const t = (a) => new Date(a.createdAt).getTime() || 0;
      return rows.slice().sort((x, y) => (x.sold ? 1 : 0) - (y.sold ? 1 : 0) || t(y) - t(x));
    }
    function renderList() {
      const q = search.value.trim().toLowerCase();
      const rows = accounts.filter((a) => !q || [a.label, a.displayName, a.accountId, a.country].join(' ').toLowerCase().includes(q));
      $('epic-detail-count').textContent = accounts.length ? accounts.length + ' total' : '';
      listEl.innerHTML = rows.length
        ? rows.map((a) => {
            const on = String(a._id) === currentId;
            const tags = (a.sold ? '<span class="ep-badge">Sold</span>' : '') + (a.status !== 'ok' ? '<span class="ep-badge is-error">Needs login</span>' : '');
            return '<button type="button" class="ed-item' + (on ? ' is-on' : '') + '" data-id="' + esc(a._id) + '" aria-pressed="' + on + '">' +
              '<span class="ed-item-name"><b>' + esc(labelOf(a)) + '</b>' + (a.country ? '<span class="cc">' + esc(a.country) + '</span>' : '') + '</span>' +
              '<span class="ed-item-sub">' + esc([a.displayName !== labelOf(a) ? a.displayName : '', (a.libraryCount || 0) + ' games'].filter(Boolean).join(' · ')) + '</span>' +
              (tags ? '<span class="ed-item-tags">' + tags + '</span>' : '') + '</button>';
          }).join('')
        : '<div class="ep-empty">' + (accounts.length ? 'No accounts match.' : 'No accounts yet.') + '</div>';
    }
    function badge(text, tone) { return '<span class="ep-badge' + (tone ? ' is-' + tone : '') + '">' + esc(text) + '</span>'; }
    function fill(a) {
      selected = a; currentId = String(a._id); setDirty(false); hideSecrets(); showForm(true);
      $('epic-detail-name').textContent = a.displayName || a.label || a.accountId;
      $('epic-detail-badges').innerHTML = [
        a.sold ? badge('Sold') : badge('Unsold', 'accent'),
        a.status === 'ok' ? badge('Login connected', 'ok') : badge('Needs login', 'error'),
        badge(a.libraryCount + ' games'),
        a.hasPassword ? badge('Password saved', 'ok') : badge('Password missing', 'warn'),
      ].join('');
      $('epic-detail-summary').textContent = ['Source: ' + a.source, 'Epic ID: ' + a.accountId].join(' · ');
      for (const key of ['label', 'email']) form.elements[key].value = a[key] || '';
      for (const key of ['firstName', 'lastName', 'dateOfBirth', 'country', 'notes', 'phone', 'address']) form.elements[key].value = a.details[key] || '';
      $('epic-creation-country').value = a.details.creationCountry || 'Unknown';
      $('epic-creation-source').value = a.details.creationCountrySource === 'proxy-ip' ? 'Signup proxy IP checked' : a.details.creationCountrySource ? 'Recorded account country; original IP unknown' : 'Not recorded';
      $('epic-creation-ip').value = a.details.creationIp || 'Not recorded';
      $('epic-contact-source').textContent = a.details.contactSource === 'synthetic-internal' ? 'Fictional internal samples. Not verified phone/address details.' : a.details.contactSource === 'manual' ? 'Manually entered contact details.' : '';
      for (const key of ['password', 'totpSecret']) form.elements[key].value = '';
      $('epic-detail-games').replaceChildren();
      for (const title of a.games.length ? a.games : ['No games recorded yet.']) { const li = document.createElement('li'); li.textContent = title; $('epic-detail-games').append(li); }
      status(a.detailsUpdatedAt ? 'Last saved ' + new Date(a.detailsUpdatedAt).toLocaleString() : 'No extra details saved yet.');
      renderList();
    }
    async function choose(id) {
      const version = ++requestVersion; hideSecrets(); selected = null; currentId = id ? String(id) : ''; showForm(false); setDirty(false);
      renderList();
      if (!id) { status('Choose an account to view or edit its details.'); return; }
      status('Loading account details…');
      try {
        const data = await request('/api/epic/accounts/' + encodeURIComponent(id) + '/details');
        if (version === requestVersion) { fill(data.account); if (visible()) EpicTabs.setArg('?account=' + encodeURIComponent(id)); }
      } catch (e) { if (version === requestVersion) status(e.message, true); }
    }
    async function refresh() {
      if (dirty && !confirm('Discard unsaved account detail changes?')) return;
      const before = currentId;
      try {
        const data = await request('/api/epic/accounts');
        accounts = sortAccounts(data.accounts || []);
        // A deep link (#details?account=ID, e.g. from a Claims row) wins over the last choice.
        const arg = visible() ? EpicTabs.arg() : '';
        const wanted = new URLSearchParams(arg.split('?')[1] || '').get('account') || before;
        await choose(accounts.some((a) => String(a._id) === String(wanted)) ? wanted : '');
      } catch (e) { status(e.message, true); }
    }
    listEl.addEventListener('click', async (event) => {
      const item = event.target.closest('[data-id]');
      if (!item || item.dataset.id === currentId) return;
      if (dirty && !confirm('Discard unsaved account detail changes?')) return;
      await choose(item.dataset.id);
      // On a narrow screen the form sits below the list: bring it into view.
      if (narrow() && !form.hidden) form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    search.addEventListener('input', renderList);
    form.addEventListener('input', () => setDirty(true));
    form.addEventListener('submit', async (event) => {
      event.preventDefault(); if (!selected) return;
      const id = selected._id, version = requestVersion;
      const body = Object.fromEntries(new FormData(form));
      $('epic-detail-save').disabled = true;
      try {
        const data = await request('/api/epic/accounts/' + id + '/details', { method: 'PATCH', body: JSON.stringify(body) });
        if (version !== requestVersion) return;
        const row = accounts.find((a) => String(a._id) === String(data.account._id));
        if (row) Object.assign(row, { label: data.account.label, displayName: data.account.displayName, sold: data.account.sold });
        fill(data.account);
        status('Account details saved.');
        if (typeof window.load === 'function') window.load();
      } catch (e) { if (version === requestVersion) status(e.message, true); }
      finally { $('epic-detail-save').disabled = false; }
    });
    async function secrets(id) { return request('/api/epic/accounts/' + id + '/details/reveal', { method: 'POST', body: '{}' }); }
    $('epic-detail-reveal').addEventListener('click', async () => {
      if (!selected) return;
      if (!$('epic-detail-secrets').hidden) { hideSecrets(); return; }
      const id = selected._id, version = requestVersion;
      try {
        const data = await secrets(id); if (version !== requestVersion || !visible()) return;
        $('epic-detail-saved-password').value = data.password || ''; $('epic-detail-saved-totp').value = data.totpSecret || '';
        $('epic-detail-secrets').hidden = false; $('epic-detail-reveal').textContent = 'Hide saved credentials';
        hideTimer = setTimeout(hideSecrets, 60000);
      } catch (e) { status(e.message, true); }
    });
    $('epic-detail-copy').addEventListener('click', async () => {
      if (!selected) return;
      if (dirty) { status('Save your changes before copying sale details.', true); return; }
      const a = selected, version = requestVersion;
      try {
        const data = await secrets(a._id); if (version !== requestVersion || !visible()) return;
        const rows = [['Epic display name', a.displayName], ['Epic account ID', a.accountId], ['Email', data.email], ['Epic password', data.password], ['2FA setup key', data.totpSecret], ['First name', a.details.firstName], ['Last name', a.details.lastName], ['Date of birth', a.details.dateOfBirth], ['Country', a.details.country]];
        const text = rows.filter(([, v]) => v).map(([k, v]) => k + ': ' + v).join('\n') + '\nGames: ' + (a.games.join(', ') || 'No games recorded');
        await navigator.clipboard.writeText(text); status('Saved sale details copied.');
      } catch (e) { status('Could not copy details. ' + e.message, true); }
    });
    $('epic-detail-generate').addEventListener('click', async () => {
      if (!selected) return;
      if (dirty) { status('Save changes before generating samples.', true); return; }
      const version = requestVersion;
      try { const data = await request('/api/epic/accounts/' + selected._id + '/details/sample-contact', { method: 'POST', body: '{}' }); if (version === requestVersion) fill(data.account); } catch (e) { status(e.message, true); }
    });
    $('epic-detail-backfill').addEventListener('click', async () => {
      if (dirty) { status('Save changes before filling past account details.', true); return; }
      const button = $('epic-detail-backfill'); button.disabled = true;
      try { const data = await request('/api/epic/accounts/details/backfill-location', { method: 'POST', body: JSON.stringify({ generateSamples: $('epic-detail-samples').checked }) }); await refresh(); status('Updated ' + data.changed + ' account records; kept ' + data.skipped + ' unchanged.'); } catch (e) { status(e.message, true); } finally { button.disabled = false; }
    });
    $('epic-detail-refresh').addEventListener('click', refresh);
    document.addEventListener('visibilitychange', () => { if (document.hidden) hideSecrets(); });
    window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

    // The tab controller (epic-tabs.js) shows and hides the panel and owns the URL.
    EpicTabs.on('details', {
      show: () => { refresh(); },
      hide: () => { hideSecrets(); setDirty(false); },
      guard: () => !dirty || confirm('Discard unsaved account detail changes?'),
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
