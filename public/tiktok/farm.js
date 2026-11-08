(() => {
  'use strict';
  const $ = (selector) => document.querySelector(selector);
  const make = (tag, cls, value) => { const node = document.createElement(tag); if (cls) node.className = cls; if (value != null) node.textContent = value; return node; };
  const set = (selector, value) => { $(selector).textContent = value; };
  const root = '/api/tiktok-farm';
  let data = { accounts: [], runs: [], codes: [], hosts: [] }, skew = 0, refreshing, lastGood = 0, pickerSignature = '', accountSignature = '';
  let activeTab = 'overview', inventory = null, inventoryPage = 1, inventoryRequest = 0, inventoryBusy = false, searchTimer, lastInventory = 0;
  const choices = new Map(), pending = new Set();
  const now = () => Date.now() + skew;
  const date = (value) => value ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Not recorded';
  const relative = (value) => { if (!value) return 'Not yet'; const seconds = Math.max(0, (now() - new Date(value).getTime()) / 1000); return seconds < 60 ? 'Just now' : seconds < 3600 ? Math.floor(seconds / 60) + 'm ago' : seconds < 86400 ? Math.floor(seconds / 3600) + 'h ago' : Math.floor(seconds / 86400) + 'd ago'; };
  const duration = (seconds) => seconds % 60 ? seconds + 's' : seconds / 60 + ' min';
  const badge = (label, tone = 'neutral') => make('span', 'badge ' + tone, label);
  const empty = (target, title, detail) => { const box = make('div', 'empty'); box.append(make('strong', '', title)); if (detail) box.append(make('span', '', detail)); target.append(box); };
  const activeRun = (account) => data.runs.find((run) => run.account === account && run.active);
  const selected = () => data.accounts.filter((worker) => choices.get(worker.account) ?? worker.online);
  const available = () => selected().filter((worker) => worker.online && worker.canScan && !worker.scanning && !activeRun(worker.account));
  const report = (message) => { set('#status', message); $('#status').hidden = !message; };
  const error = (message) => { set('#error', message); $('#error').hidden = !message; };
  const titleFor = (item) => item.eventName || item.name || data.accounts.flatMap((a) => a.catalog?.campaigns || []).find((c) => c.campaign === item.campaign)?.name || data.codes.find((c) => c.campaign === item.campaign && c.eventName)?.eventName || 'Campaign ' + item.campaign;

  async function api(path, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const result = await fetch(root + path, { signal: controller.signal, cache: 'no-store', credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(body !== undefined && { 'Content-Type': 'application/json' }) },
        ...(body !== undefined && { method: 'POST', body: JSON.stringify(body) }) });
      if (!result.headers.get('content-type')?.includes('application/json')) {
        scrubSecrets();
        throw new Error('The server returned a page instead of data. Reload and sign in again.');
      }
      const value = await result.json();
      if (!result.ok) {
        if ([401, 403].includes(result.status)) scrubSecrets();
        throw new Error(value.error || value.message || ([401, 403].includes(result.status) ? 'Your admin session needs sign-in. Reload the page to continue.' : 'The server could not complete this request.'));
      }
      return value;
    } catch (failure) {
      if (failure.name === 'AbortError') throw new Error('The server took too long to respond. Retrying automatically.');
      throw failure;
    } finally { clearTimeout(timeout); }
  }

  function workerState(worker) {
    const run = activeRun(worker.account), schedule = worker.schedule || worker.automation || {};
    if (!worker.online) return [worker.lastSeen ? 'Offline' : 'Not connected', 'bad'];
    if (run) return [run.stopRequested ? 'Stopping' : ({ watching: 'Watching', claiming: 'Claiming', queued: 'Queued', bootstrap: 'Starting' }[run.phase] || 'Working'), 'live'];
    if (worker.scanning) return ['Checking events', 'live'];
    if (worker.catalog?.error === 'session-required' || schedule.lastResult === 'Sign-in check needed') return ['Sign-in needed', 'bad'];
    if (worker.catalog?.error || schedule.lastResult === 'Scan failed') return ['Check failed', 'warning'];
    if (worker.catalog?.partial) return ['Partial check', 'warning'];
    return worker.automation ? ['Ready', 'good'] : ['Paused', 'neutral'];
  }
  function nextCheck(worker) {
    if (!worker.automation) return 'Automatic checks paused';
    if (activeRun(worker.account)) return 'Next check after this run';
    if (worker.scanning) return 'Checking events now';
    if (!worker.online) return 'Resumes when worker reconnects';
    const seconds = (new Date(worker.automation.nextScanAt).getTime() - now()) / 1000;
    return Number.isFinite(seconds) && seconds > 0 ? 'Next check in ' + Math.ceil(seconds / 60) + ' min' : 'Next check shortly';
  }
  function progress(run, parent) {
    if (!run.duration) return;
    const meter = make('progress'); meter.max = run.duration; meter.value = Math.min(run.seconds || 0, run.duration);
    meter.setAttribute('aria-label', titleFor(run) + ' watch progress'); parent.append(meter);
  }
  function controls() {
    const chosen = selected(), free = available(), busy = pending.size > 0;
    for (const id of ['scan', 'auto']) $('#' + id).disabled = busy || !free.length;
    $('#enableAutomation').disabled = busy || !chosen.some((a) => a.online && a.canScan && !a.automation);
    $('#pauseAutomation').disabled = busy || !chosen.some((a) => a.automation);
    $('#start button').disabled = busy || !free.length;
    $('#setupButton').disabled = busy || !data.setupOnline;
    set('#scanScope', chosen.length + ' account' + (chosen.length === 1 ? '' : 's') + ' selected · ' + free.length + ' available now');
  }
  async function action(key, path, body) {
    if (pending.has(key)) return;
    pending.add(key); controls(); error('');
    try {
      const reply = await api(path, body);
      report(reply.results ? reply.results.map((item) => item.account + ': ' + (item.reason || (item.queued ? 'run queued' : item.scanning ? 'checking events' : item.enabled ? 'auto farm enabled' : 'auto farm paused'))).join(' · ') : 'Change saved.');
      await refresh();
    } catch (failure) { error(failure.message); }
    finally { pending.delete(key); controls(); }
  }
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function openTab(id) {
    const active = tabs.find((tab) => tab.id === 'tab-' + id) || tabs[0];
    const next = active.id.slice(4);
    if (activeTab === 'codes' && next !== 'codes') scrubSecrets();
    activeTab = next;
    for (const tab of tabs) { const yes = tab === active; tab.setAttribute('aria-selected', String(yes)); tab.tabIndex = yes ? 0 : -1; document.getElementById(tab.getAttribute('aria-controls')).hidden = !yes; }
    if (next === 'codes') loadInventory();
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => { location.hash = tab.id.slice(4); };
    tab.onkeydown = (event) => { const next = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1 }[event.key]; if (next === undefined) return; event.preventDefault(); const target = tabs[(next + tabs.length) % tabs.length]; target.click(); target.focus(); };
  });
  addEventListener('hashchange', () => openTab(location.hash.slice(1)));

  function renderOverview() {
    const online = data.accounts.filter((a) => a.online), enabled = data.accounts.filter((a) => a.automation), runs = data.runs.filter((r) => r.active);
    set('#online', online.length + ' / ' + data.accounts.length); set('#onlineHelp', online.length === data.accounts.length && online.length ? 'All accounts connected' : 'Connected account workers');
    set('#automationCount', enabled.length); set('#activeCount', runs.length); set('#activeHelp', runs.length ? 'Watching, queued or claiming' : 'Waiting for eligible rewards');
    set('#storedCount', data.codeCount ?? data.codes.length); set('#storedHelp', '+' + (data.totals?.claimed24h || 0) + ' in the last 24 hours');
    set('#farmTitle', enabled.length ? 'Automatic farming enabled' : 'Automatic farming paused');
    set('#farmHelp', enabled.length + ' of ' + data.accounts.length + ' accounts enabled · Checks every ' + data.autoScanMinutes + ' minutes while idle');
    $('#farmDot').className = 'pulse' + (enabled.some((a) => a.online) ? ' good' : '');
    const box = $('#workerSummary'); box.replaceChildren();
    if (!data.accounts.length) empty(box, 'No accounts enrolled', 'Add a saved account from the Accounts tab.');
    for (const worker of data.accounts) {
      const run = activeRun(worker.account), row = make('article', 'worker-row'), copy = make('div', 'worker-copy'), side = make('div', 'worker-side');
      copy.append(make('strong', '', worker.account));
      copy.append(make('small', '', run ? titleFor(run) + (run.duration ? ' · ' + Math.min(run.seconds, run.duration) + '/' + run.duration + 's' : '') : nextCheck(worker)));
      if (run) progress(run, copy);
      side.append(badge(...workerState(worker)), make('small', '', (worker.statistics?.codes || 0) + ' codes stored'));
      row.append(make('span', 'slot-icon', worker.account.replace('tiktok-', '')), copy, side); box.append(row);
    }
    const host = data.hosts?.filter((h) => h.online).sort((a, b) => b.reportedAt - a.reportedAt)[0] || data.hosts?.sort((a, b) => b.reportedAt - a.reportedAt)[0];
    const hostBox = $('#hostDetails'); hostBox.replaceChildren();
    $('#hostBadge').replaceWith(Object.assign(badge(host?.online ? 'Connected' : host ? 'Offline' : 'Waiting', host?.online ? 'good' : 'neutral'), { id: 'hostBadge' }));
    if (host) {
      hostBox.append(make('h3', 'host-name', 'Android host'), make('p', 'host-sub', 'Shared API worker · ' + host.accounts.length + ' accounts'));
      const uptime = host.uptimeSeconds + (host.online ? Math.max(0, (now() - host.reportedAt) / 1000) : 0);
      const hours = Math.floor(uptime / 3600), minutes = Math.floor(uptime % 3600 / 60);
      const values = [['Memory in use', (host.rssKiB * 1024 / 1e6).toFixed(1) + ' MB'], ['Peak memory', (host.peakRssKiB * 1024 / 1e6).toFixed(1) + ' MB'], ['Worker uptime', hours ? hours + 'h ' + minutes + 'm' : minutes + ' min'], ['Crash recovery', host.supervised ? 'Supervised' : 'Not reported']];
      const list = make('dl', 'host-stats'); for (const [label, value] of values) { const cell = make('div'); cell.append(make('dt', '', label), make('dd', '', value)); list.append(cell); } hostBox.append(list, make('small', 'footnote', 'Last report: ' + relative(host.reportedAt)));
    } else empty(hostBox, 'Worker details pending', 'Account connectivity is shown separately while health details arrive.');
    const recent = $('#recentClaims'); recent.replaceChildren();
    if (!data.codes.length) empty(recent, 'No rewards stored yet', 'Claimed codes will appear here automatically.');
    for (const code of data.codes.slice(0, 3)) { const item = make('article', 'recent-reward'); item.append(make('strong', '', titleFor(code)), make('small', '', code.account + (code.duration ? ' · ' + duration(code.duration) : '')), make('small', '', relative(code.updatedAt))); recent.append(item); }
    const review = data.totals?.review || 0, issues = data.accounts.filter((a) => ['bad', 'warning'].includes(workerState(a)[1]));
    $('#attention').hidden = !review && !issues.length;
    set('#attention', [review && review + ' run(s) need review in Activity. Uncertain claims are not retried automatically.', issues.length && issues.length + ' account(s) need attention. Check Accounts for details.'].filter(Boolean).join(' '));
  }

  function renderAccounts() {
    const signature = JSON.stringify(data.accounts.map((a) => [a.account, a.online]));
    if (signature !== pickerSignature) {
      pickerSignature = signature; $('#accounts').replaceChildren(); const filter = $('#codeAccount'), selectedFilter = filter.value; filter.replaceChildren(make('option', '', 'All accounts')); filter.firstChild.value = '';
      for (const worker of data.accounts) {
        const label = make('label'), input = make('input'); input.type = 'checkbox'; input.value = worker.account; input.checked = choices.get(worker.account) ?? worker.online;
        input.onchange = () => { choices.set(worker.account, input.checked); controls(); renderEvents(); };
        label.append(input, worker.account); $('#accounts').append(label);
        const option = make('option', '', worker.account); option.value = worker.account; filter.append(option);
      }
      filter.value = selectedFilter;
    }
    const detailSignature = Math.floor(now() / 60000) + JSON.stringify(data.accounts.map((a) => [a.account, a.online, a.automation, a.schedule, a.statistics, a.catalog?.error, a.catalog?.updatedAt, a.catalog?.partial, a.setup, a.credentialsSavedAt, a.runtime?.kind, workerState(a)]));
    if (detailSignature === accountSignature) return;
    accountSignature = detailSignature; const box = $('#accountDetails'); box.replaceChildren();
    if (!data.accounts.length) empty(box, 'No saved accounts', 'Use saved logins below to add account details.');
    for (const worker of data.accounts) {
      const card = make('article', 'account-card'), title = make('div', 'card-title'); title.append(make('h3', '', worker.account), badge(...workerState(worker))); card.append(title);
      card.append(make('small', '', worker.runtime?.kind === 'android-api' ? 'Android API worker' : worker.apiRoute === 'phone' ? 'Phone API route' : worker.apiRoute === 'mac' ? 'Mac worker' : 'Awaiting enrollment'));
      const stats = make('div', 'stats-line'); for (const [value, label] of [[worker.statistics?.codes || 0, 'Codes stored'], [worker.statistics?.review || 0, 'Need review']]) { const item = make('div'); item.append(make('strong', '', value), make('small', '', label)); stats.append(item); } card.append(stats);
      card.append(make('small', '', 'Last event check · ' + date(worker.catalog?.updatedAt || worker.schedule?.lastScanAt)), make('small', '', 'Last contact · ' + date(worker.lastSeen)), make('small', '', nextCheck(worker)));
      const last = worker.schedule?.lastResult || worker.automation?.lastResult; if (last) card.append(make('p', '', last));
      card.append(make('small', '', worker.credentialsSavedAt ? 'Login saved securely' : 'API session enrolled; login not saved in this vault'));
      const login = make('button', '', worker.credentialsSavedAt ? 'View saved login' : 'Save login');
      login.onclick = async () => {
        if (!worker.credentialsSavedAt) { const form = $('#credentialsForm'); $('#loginEditor').open = true; form.elements.account.value = worker.account; form.elements.username.focus(); return; }
        login.disabled = true;
        try { const result = await api('/accounts/' + worker.account + '/credentials'); set('#loginUsername', result.username); set('#loginPassword', result.password); $('#loginDialog').showModal(); } catch (failure) { error(failure.message); } finally { login.disabled = false; }
      }; card.append(login);
      if (worker.setup && worker.setup.state !== 'ready' && !worker.online) { const detail = make('details', 'advanced'); detail.append(make('summary', '', 'One-time setup: ' + worker.setup.state), make('p', '', worker.setup.reason ? worker.setup.reason.replaceAll('-', ' ') : 'Setup worker is required to continue.')); if (['attention', 'failed'].includes(worker.setup.state)) { const resume = make('button', '', 'Resume setup'); resume.disabled = !data.setupOnline; resume.onclick = () => action('resume-' + worker.account, '/accounts/' + worker.account + '/setup/resume', {}); detail.append(resume); } card.append(detail); }
      box.append(card);
    }
    set('#automationHelp', 'Checks every ' + data.autoScanMinutes + ' minutes while idle, even with this page closed.');
    set('#setupWorkerStatus', data.setupOnline ? 'Mac setup worker connected. One-time setup is available.' : 'Mac setup worker is off. Existing phone accounts continue farming normally.');
  }

  function renderEvents() {
    const events = new Map(), campaigns = new Map(), upcoming = new Map();
    let fresh = 0;
    for (const worker of data.accounts) {
      const catalog = worker.catalog;
      if (catalog && !catalog.stale && !catalog.error) fresh++;
      if (worker.online && !catalog?.stale && !catalog?.error) for (const event of catalog?.events || []) { const key = event.campaign + ':' + event.task; if (!events.has(key)) events.set(key, { ...event, accounts: [] }); events.get(key).accounts.push(worker.account); }
      for (const campaign of catalog?.campaigns || []) { if (!campaigns.has(campaign.campaign)) campaigns.set(campaign.campaign, { ...campaign, workers: [] }); campaigns.get(campaign.campaign).workers.push({ ...worker, campaignStatus: campaign.status }); }
      for (const event of worker.upcoming || []) if ((!event.endsAt || event.endsAt > now()) && !upcoming.has(event.campaign)) upcoming.set(event.campaign, event);
    }
    set('#eventCount', events.size); const box = $('#events'); box.replaceChildren();
    if (!events.size) empty(box, fresh ? 'No unfinished watch rewards available' : 'Waiting for a fresh event check', fresh ? 'Enabled accounts will keep checking for the next eligible event.' : 'Saved campaigns remain below until a worker refreshes them.');
    for (const event of events.values()) { const card = make('article', 'event'); card.append(make('h3', '', event.name), make('p', '', duration(event.duration) + ' watch reward'), make('small', '', event.accounts.length + ' eligible account(s)')); if (event.endsAt) card.append(make('small', '', 'Ends ' + date(event.endsAt))); const button = make('button', 'primary', 'Farm reward'); const accounts = available().filter((a) => event.accounts.includes(a.account)).map((a) => a.account); button.disabled = !accounts.length || pending.size > 0; button.onclick = () => action('farm-' + event.task, '/start', { mode: 'event', accounts, campaign: event.campaign, task: event.task }); card.append(button); box.append(card); }
    set('#catalogCoverage', fresh + ' of ' + data.accounts.length + ' accounts have a recent feed. Saved feeds are marked below.');
    const campaignBox = $('#activeCampaigns'); campaignBox.replaceChildren();
    if (!campaigns.size) empty(campaignBox, 'No campaign feed yet', 'Check events when a worker is connected.');
    const labels = { eligible: 'Reward available', 'no-live-room': 'Waiting for LIVE', 'no-eligible-task': 'No eligible watch task', incomplete: 'Check incomplete' };
    for (const campaign of [...campaigns.values()].sort((a, b) => (a.endsAt || Infinity) - (b.endsAt || Infinity))) {
      const card = make('article', 'event'); if (campaign.game) card.append(make('div', 'eyebrow', campaign.game)); card.append(make('h3', '', campaign.name));
      const tiers = make('div', 'tiers'); for (const seconds of campaign.watchSeconds || []) tiers.append(make('span', '', duration(seconds))); card.append(tiers);
      if (campaign.endsAt) card.append(make('small', '', 'Ends ' + date(campaign.endsAt)));
      const list = make('dl'); for (const worker of campaign.workers) { const item = make('div'); item.append(make('dt', '', worker.account), make('dd', '', (labels[worker.campaignStatus] || worker.campaignStatus) + (worker.catalog?.stale ? ' · saved' : ''))); list.append(item); } card.append(list);
      if (campaign.otherTasks) card.append(make('small', '', 'Also lists tasks that need separate action.')); campaignBox.append(card);
    }
    const future = $('#upcoming'); future.replaceChildren(); if (!upcoming.size) empty(future, 'No upcoming events reported', 'This reflects the latest available account feeds.');
    for (const event of upcoming.values()) { const card = make('article', 'event'); card.append(make('h3', '', event.name), make('p', '', event.startsAt ? 'Starts ' + date(event.startsAt) : 'Start time not published')); future.append(card); }
  }

  function tableRow(table, labels) { const row = document.createElement('tr'); for (const label of labels) { const cell = document.createElement('td'); if (label) cell.dataset.label = label; row.append(cell); } table.append(row); return [...row.cells]; }
  function renderRuns() {
    const filter = $('#runState').value, runs = data.runs.filter((r) => !filter || (filter === 'active' ? r.active : r.state === filter));
    const box = $('#runs'); box.replaceChildren();
    if (!runs.length) { const [cell] = tableRow(box, ['']); cell.colSpan = 5; empty(cell, 'No matching activity', 'New runs will appear here automatically.'); }
    const phases = { 'session-required': 'Sign-in needed', 'lease-expired': 'Connection interrupted; review required', 'claim-uncertain': 'Claim result needs review', 'room-ended': 'LIVE ended or stopped crediting', 'capture-timeout': 'LIVE connection timed out', 'reward-read-failed': 'Could not read reward', 'worker-error': 'Worker interrupted', 'duplicate-code': 'Code already stored', stored: 'Code stored', watching: 'Watching', claiming: 'Claiming', queued: 'Queued', bootstrap: 'Connecting' };
    for (const run of runs) {
      const cells = tableRow(box, ['', 'Result', 'Progress', 'Updated', '']); cells[0].append(make('strong', '', titleFor(run)), make('small', '', run.account + (run.automatic ? ' · Automatic' : ' · Manual')));
      const ids = make('details'); ids.append(make('summary', '', 'Campaign / task IDs'), make('code', '', run.campaign + ' / ' + run.task)); cells[0].append(ids);
      cells[1].append(badge(run.stopRequested && run.active ? 'Stopping' : run.state, run.state === 'completed' ? 'good' : ['review', 'failed'].includes(run.state) ? 'warning' : run.active ? 'live' : 'neutral'), make('small', '', phases[run.phase] || run.phase));
      cells[2].append(make('span', '', run.duration ? Math.min(run.seconds || 0, run.duration) + ' / ' + run.duration + 's' : (run.seconds || 0) + 's')); progress(run, cells[2]); cells[3].textContent = date(run.updatedAt);
      if (run.active && !run.stopRequested && run.phase !== 'claiming') { const stop = make('button', '', 'Stop run'); stop.disabled = pending.has(run._id); stop.onclick = () => action(run._id, '/runs/' + run._id + '/stop', {}); cells[4].append(stop); }
    }
  }

  function scrubSecrets() {
    $('#loginUsername').textContent = ''; $('#loginPassword').textContent = ''; if ($('#loginDialog').open) $('#loginDialog').close();
    if (inventory) renderCodes();
  }
  $('#loginDialog').addEventListener('close', () => { set('#loginUsername', ''); set('#loginPassword', ''); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) scrubSecrets(); else refresh(); });
  function renderCodes() {
    const box = $('#codes'); box.replaceChildren(); if (!inventory) return;
    set('#inventoryCount', inventory.total + ' code' + (inventory.total === 1 ? '' : 's')); set('#pageInfo', 'Page ' + inventory.page + ' of ' + inventory.pages + ' · ' + inventory.total + ' results');
    $('#previousPage').disabled = inventoryBusy || inventory.page <= 1; $('#nextPage').disabled = inventoryBusy || inventory.page >= inventory.pages;
    if (!inventory.codes.length) { const [cell] = tableRow(box, ['']); cell.colSpan = 4; empty(cell, 'No matching codes', 'Try another search or account filter.'); }
    for (const code of inventory.codes) {
      const cells = tableRow(box, ['', 'Watch tier', 'Stored', '']); cells[0].append(make('strong', '', titleFor(code)), make('small', '', code.account));
      const ids = make('details'); ids.append(make('summary', '', 'Campaign / task IDs'), make('code', '', code.campaign + ' / ' + code.task)); cells[0].append(ids);
      cells[1].textContent = code.duration ? duration(code.duration) : 'Watch reward'; cells[2].textContent = date(code.updatedAt);
      const buttons = make('div', 'actions'), reveal = make('button', '', 'Reveal'), copy = make('button', '', 'Copy'); copy.hidden = true; let clear = null, secret;
      reveal.onclick = async () => {
        if (clear !== null) { clear = null; secret?.remove(); reveal.textContent = 'Reveal'; copy.hidden = true; return; }
        reveal.disabled = true;
        try { const result = await api('/codes/' + code._id); if (!reveal.isConnected || activeTab !== 'codes' || document.hidden) return; clear = result.code; secret = make('code', 'secret-value', clear); cells[3].prepend(secret); reveal.textContent = 'Hide'; copy.hidden = false; } catch (failure) { error(failure.message); } finally { reveal.disabled = false; }
      };
      copy.onclick = async () => { if (!clear) return; try { await navigator.clipboard.writeText(clear); report('Code copied.'); } catch { error('Clipboard access was unavailable. Select the revealed code to copy it.'); } };
      buttons.append(reveal, copy); cells[3].append(buttons);
    }
  }
  async function loadInventory() {
    const request = ++inventoryRequest; inventoryBusy = true; $('#previousPage').disabled = $('#nextPage').disabled = true;
    try {
      const query = new URLSearchParams({ page: String(inventoryPage), account: $('#codeAccount').value, q: $('#codeSearch').value });
      const reply = await api('/inventory?' + query); if (request !== inventoryRequest) return;
      inventory = reply; inventoryPage = reply.page; lastInventory = Date.now(); inventoryBusy = false; renderCodes();
    } catch (failure) { if (request === inventoryRequest) { inventoryBusy = false; error(failure.message); } }
  }
  $('#codeSearch').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { inventoryPage = 1; loadInventory(); }, 250); };
  $('#codeAccount').onchange = () => { inventoryPage = 1; loadInventory(); };
  $('#previousPage').onclick = () => { if (!inventoryBusy && inventoryPage > 1) { inventoryPage--; loadInventory(); } };
  $('#nextPage').onclick = () => { if (!inventoryBusy && inventoryPage < inventory.pages) { inventoryPage++; loadInventory(); } };
  $('#runState').onchange = renderRuns;
  for (const [id, auto] of [['scan', false], ['auto', true]]) $('#' + id).onclick = () => action(id, '/scan', { accounts: available().map((a) => a.account), auto });
  for (const [id, enabled] of [['enableAutomation', true], ['pauseAutomation', false]]) $('#' + id).onclick = () => action(id, '/automation', { accounts: selected().filter((a) => enabled ? a.online && a.canScan && !a.automation : a.automation).map((a) => a.account), enabled });
  $('#start').onsubmit = (event) => { event.preventDefault(); action('manual', '/start', { ...Object.fromEntries(new FormData(event.currentTarget)), accounts: available().map((a) => a.account) }); };
  $('#credentialsForm').onsubmit = async (event) => {
    event.preventDefault(); const form = event.currentTarget, button = event.submitter || form.querySelector('button'), setup = button.value === 'setup';
    if (setup && !data.setupOnline) return error('The Mac setup worker is offline. Saving a login does not require it.');
    const { account, username, password } = Object.fromEntries(new FormData(form)); if (pending.has('credentials')) return; pending.add('credentials'); button.disabled = true;
    try { await api('/accounts/' + encodeURIComponent(account) + (setup ? '/setup' : '/credentials'), { credential: { username, password } }); form.reset(); report(setup ? 'One-time setup queued for ' + account : 'Login saved securely for ' + account + '. The active API session is unchanged.'); await refresh(); } catch (failure) { error(failure.message); } finally { pending.delete('credentials'); button.disabled = false; controls(); }
  };
  function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const next = await api('/state'), codeChanged = data.codeCount !== next.codeCount;
        data = next; skew = (data.serverTime || Date.now()) - Date.now(); lastGood = Date.now(); error('');
        $('#connection').className = 'badge good'; set('#connection', 'Live updates');
        renderOverview(); renderAccounts(); renderEvents(); renderRuns(); controls();
        set('#lastRefresh', 'Updated ' + new Date().toLocaleTimeString());
        if (activeTab === 'codes' && !inventoryBusy && (codeChanged || Date.now() - lastInventory > 30000)) await loadInventory();
      } catch (failure) {
        error(failure.message); $('#connection').className = 'badge warning'; set('#connection', 'Updates interrupted');
        set('#lastRefresh', lastGood ? 'Last successful update ' + new Date(lastGood).toLocaleTimeString() : 'No server response yet');
      } finally { refreshing = null; }
    })();
    return refreshing;
  }
  $('#refresh').onclick = async () => { $('#refresh').disabled = true; await refresh(); $('#refresh').disabled = false; };
  $('#themeToggle').onclick = () => { if (typeof window.toggleTheme === 'function') window.toggleTheme(); };
  fetch('/whoami', { credentials: 'same-origin' }).then((response) => response.ok ? response.json() : null).then((value) => { if (value?.admin) { set('#meName', value.admin.username || value.admin.name || 'Admin'); set('#meRole', value.admin.role === 'superadmin' ? 'Superadmin' : 'Admin'); } }).catch(() => {});
  openTab(location.hash.slice(1)); refresh(); setInterval(() => { if (!document.hidden) refresh(); }, 5000);
})();
