/* global fetch */
(() => {
  'use strict';
  const root = document.getElementById('steamBoostBody');
  if (!root) return;
  let data, busy = false, initialized = false, scope = 'all', search = '';
  const refs = {};
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  const append = (node, ...children) => { node.append(...children); return node; };
  const ago = v => { if (!v) return 'Not reported'; const seconds = Math.max(0, Math.floor((Date.now() - new Date(v)) / 1000)); return seconds < 60 ? seconds + 's ago' : Math.floor(seconds / 60) + 'm ago'; };
  const duration = minutes => minutes == null ? 'Awaiting Steam' : minutes < 60 ? minutes + 'm' : Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm';
  async function api(path, method = 'GET', body) {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok || !d.success) throw Error(d.message || 'Request failed'); return d;
  }
  async function action(fn) {
    if (busy) return; busy = true; if (refs.notice) refs.notice.textContent = ''; root.setAttribute('aria-busy', 'true');
    try { await fn(); await load(); } catch (e) { if (refs.notice) refs.notice.textContent = e.message; else root.textContent = e.message; } finally { busy = false; root.removeAttribute('aria-busy'); }
  }
  function input(label, value, type = 'number') {
    const n = el('input'); n.type = type; type === 'checkbox' ? n.checked = value : n.value = value;
    const l = el('label', null, type === 'checkbox' ? 'boost-toggle' : 'st-field');
    if (type === 'checkbox') l.append(n, el('span', label)); else l.append(el('span', label), n);
    return { label: l, input: n };
  }
  function button(text, fn, primary = false) { const b = el('button', text, 'btn' + (primary ? ' btn-primary' : '')); b.type = 'button'; b.onclick = () => action(fn); return b; }
  function init() {
    root.replaceChildren(); root.classList.add('boost-panel');
    refs.notice = el('p', '', 'boost-notice'); refs.notice.setAttribute('role', 'status');
    refs.worker = el('div', null, 'boost-worker'); refs.stats = el('div', null, 'boost-stats'); refs.policy = el('p', null, 'boost-policy');
    root.append(refs.notice, refs.worker, refs.stats, refs.policy);
    const toolbar = el('div', null, 'boost-toolbar');
    const finder = el('input'); finder.type = 'search'; finder.placeholder = 'Find an account'; finder.setAttribute('aria-label', 'Find farm account'); finder.oninput = () => { search = finder.value.toLowerCase(); renderRows(); };
    const filter = el('select'); filter.setAttribute('aria-label', 'Filter farm accounts');
    for (const [value, label] of [['all','All farm accounts'], ['game','Game preparation'], ['boost','Hour boosting'], ['attention','Needs attention'], ['ready','Ready / listed']]) { const o = el('option', label); o.value = value; filter.append(o); }
    filter.onchange = () => { scope = filter.value; renderRows(); };
    toolbar.append(finder, filter, button('Refresh checks', async () => {}), button('Run allocation', () => api('/api/steam/sales/distribute', 'POST'))); root.append(toolbar);
    refs.rows = el('div', null, 'boost-rows'); root.append(refs.rows);
    const settings = el('details', null, 'boost-settings'); settings.append(el('summary', 'Allocation, games & pricing')); root.append(settings);
    const form = el('form', null, 'boost-settings-body'), cfg = data.settings;
    const toggles = el('div', null, 'boost-toggles');
    const enabled = input('Allocate incoming accounts', cfg.enabled, 'checkbox'), prepare = input('Prepare game accounts too', cfg.prepareGames, 'checkbox'); toggles.append(enabled.label, prepare.label);
    const grid = el('div', null, 'boost-settings-grid');
    const cap = input('Farm capacity', cfg.maxAccounts); cap.input.min = 0; cap.input.max = 500;
    const keep = input('Empty stock per region', cfg.keepPerRegion); keep.input.min = 0; keep.input.max = 50;
    const priceGame = input('Game account price ($)', cfg.gamePriceUsd), priceBoost = input('Boosted account price ($)', cfg.boostPriceUsd);
    for (const p of [priceGame, priceBoost]) { p.input.step = '.01'; p.input.min = '.05'; p.input.max = 500; }
    const target = el('label', null, 'st-field'), select = el('select'); target.append(el('span', 'Boost target'), select);
    for (const h of [500,1000]) { const o = el('option', h.toLocaleString() + ' hours / game'); o.value = h; o.selected = h === cfg.targetHours; select.append(o); }
    grid.append(cap.label, keep.label, target, priceGame.label, priceBoost.label);
    const gameBox = el('fieldset', null, 'boost-game-options'); gameBox.append(el('legend', 'Games')); const choices = el('div', null, 'boost-game-grid'), checks = [];
    for (const g of data.catalog) { const f = input(g.name, cfg.games.includes(g.appId), 'checkbox'); choices.append(f.label); checks.push([g.appId, f.input]); } gameBox.append(choices);
    const save = el('button', 'Save settings', 'btn btn-primary'); save.type = 'submit';
    form.append(toggles, grid, gameBox, save);
    form.onsubmit = e => { e.preventDefault(); action(() => api('/api/steam/boost/settings', 'PATCH', { enabled: enabled.input.checked, prepareGames: prepare.input.checked, maxAccounts: Number(cap.input.value), keepPerRegion: Number(keep.input.value), targetHours: Number(select.value), gamePriceUsd: Number(priceGame.input.value), boostPriceUsd: Number(priceBoost.input.value), games: checks.filter(([, c]) => c.checked).map(([id]) => id) })); }; settings.append(form);
    const manual = el('details', null, 'boost-settings'); manual.append(el('summary', 'Add available stock manually'));
    refs.pickerBox = el('div', null, 'boost-settings-body'); manual.append(refs.pickerBox); root.append(manual); manual.ontoggle = () => { if (manual.open) loadStock().catch(e => { refs.notice.textContent = e.message; }); };
    root.append(el('p', 'Hours come from Steam. A worker heartbeat does not prove that hours have been recorded. Accounts stay reserved until their verification and logout checks pass.', 'boost-footnote'));
    initialized = true;
  }
  async function loadStock() {
    const d = await api('/api/steam/accounts'); refs.pickerBox.replaceChildren(); const stock = d.accounts.filter(a => a.stage === 'stock');
    if (!stock.length) { refs.pickerBox.append(el('p', 'No unreserved stock is available. New accounts are allocated automatically.', 'st-muted')); return; }
    const label = el('label', null, 'st-field'); label.append(el('span', 'Available accounts')); const picker = el('select'); picker.multiple = true; picker.size = Math.min(6, stock.length); label.append(picker);
    for (const a of stock) { const o = el('option', a.accountName + ' · ' + (a.signupCountry || '?')); o.value = a._id; picker.append(o); }
    refs.pickerBox.append(label, button('Reserve selected for boosting', async () => { const ids = [...picker.selectedOptions].map(o => o.value); if (!ids.length) throw Error('Choose at least one account'); const r = await api('/api/steam/boost/add', 'POST', { accountIds: ids }); await loadStock(); if (r.result.refused.length) throw Error(r.result.refused.map(x => x.why).join('; ')); }));
  }
  function cell(label, ...children) { const c = el('td'); c.dataset.label = label; c.append(...children); return c; }
  function renderRows() {
    const rows = [...data.live, ...data.ended].filter(a => (!search || (a.accountName + ' ' + a.regionName).toLowerCase().includes(search)) && (scope === 'all' || a.purpose === scope || scope === 'attention' && a.checks.health === 'attention' || scope === 'ready' && ['ready','listed','sold'].includes(a.checks.health)));
    refs.rows.replaceChildren();
    if (!rows.length) { refs.rows.append(el('div', 'No accounts match this view.', 'st-empty')); return; }
    const table = el('table', null, 'boost-table'); const thead = el('thead'), headers = el('tr');
    for (const title of ['Account','Purpose','Farm checks','Game progress','Last report','Actions']) headers.append(el('th', title)); thead.append(headers); const tbody = el('tbody');
    for (const a of rows) {
      const h = a.checks, tr = el('tr');
      const identity = append(el('div', null, 'boost-account'), el('strong', a.accountName), el('small', a.regionName + ' · ' + (a.accountStage || a.state)));
      const purpose = append(el('div', null, 'boost-stack'), el('strong', a.purpose === 'game' ? 'Game preparation' : 'Hour boost'), el('small', a.purpose === 'game' ? 'License + Steam time check' : a.targetHours.toLocaleString() + ' hours per game'));
      const checks = el('div', null, 'boost-stack'); checks.append(el('span', h.health === 'healthy' ? 'Connected' : h.health === 'attention' ? 'Needs attention' : h.health === 'listed' ? 'On Eldorado' : h.health === 'sold' ? 'Sold' : h.health === 'ready' ? 'Ready to list' : 'Checking', 'boost-badge is-' + h.health), el('span', h.message), el('small', 'Licenses ' + h.licenseCount + '/' + h.targetGames + ' · ' + a.playing + ' idling'));
      const progress = el('div', null, 'boost-stack');
      for (const g of a.gameProgress) progress.append(append(el('div', null, 'boost-game-time'), el('span', g.name), el('b', g.licensed ? duration(g.minutes) : 'License pending')));
      if (a.purpose === 'boost') { const bar = el('progress'); bar.max = 100; bar.value = h.progress; bar.setAttribute('aria-label', 'Verified progress toward target'); progress.append(bar, el('small', h.timeVerified ? h.progress.toFixed(2) + '% verified' : 'No recorded hours yet')); }
      const report = append(el('div', null, 'boost-stack'), el('span', ago(a.lastSeenAt)), el('small', a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleTimeString() : 'Awaiting first report'));
      const controls = el('div', null, 'boost-row-actions'); const op = ['queued','boosting'].includes(a.state) ? 'stop' : ['failed','stopped'].includes(a.state) ? 'retry' : null;
      if (op) controls.append(button(op === 'stop' ? 'Stop' : 'Retry', () => api('/api/steam/boost/' + a._id + '/' + op, 'POST')));
      tr.append(cell('Account', identity), cell('Purpose', purpose), cell('Farm checks', checks), cell('Game progress', progress), cell('Last report', report), cell('Actions', controls)); tbody.append(tr);
    }
    table.append(thead, tbody); refs.rows.append(table);
  }
  function renderLive() {
    const h = data.health;
    refs.worker.replaceChildren(); refs.worker.append(el('span', data.worker.online ? 'Worker connected' : 'Worker offline', 'boost-badge is-' + (data.worker.online ? 'healthy' : 'attention')), el('span', 'Heartbeat ' + ago(data.worker.lastSeenAt)), el('span', h.attention ? h.attention + ' account(s) need attention' : h.assigned ? 'Account checks below' : 'Waiting for incoming accounts'));
    refs.stats.replaceChildren();
    for (const [label, value, hint] of [['Assigned',h.assigned,h.preparing + ' prepare · ' + h.boosting + ' boost'], ['Idling',h.idling,'live account reports'], ['Time verified',h.verified,'Steam returned minutes'], ['Checking',h.waiting,'login / logout pending'], ['Attention',h.attention,'retry or stale report'], ['On Eldorado',h.listed,'recent prepared stock']]) refs.stats.append(append(el('div', null, 'st-stat'), el('span', label, 'st-stat-label'), el('strong', value, 'st-stat-value'), el('small', hint, 'st-stat-hint')));
    const selected = data.catalog.filter(g => data.settings.games.includes(g.appId)).map(g => g.name).join(', ');
    refs.policy.textContent = 'Eldorado only · keep ' + data.settings.keepPerRegion + ' empty accounts per region · overflow alternates game preparation and boosting · ' + data.settings.targetHours.toLocaleString() + ' h target. Games: ' + selected + '.';
    renderRows();
  }
  async function load() { const d = await api('/api/steam/boost'); data = d.boost; if (!initialized) init(); renderLive(); }
  for (const button of document.querySelectorAll('[data-steam-tab]')) button.onclick = () => {
    const boost = button.dataset.steamTab === 'boost'; document.getElementById('steamBoostSection').hidden = !boost; document.getElementById('steamSalesSection').hidden = boost;
    for (const b of document.querySelectorAll('[data-steam-tab]')) b.setAttribute('aria-selected', String(b === button));
    if (boost) action(async () => {});
  };
  load().catch(e => { root.textContent = e.message; });
  setInterval(() => { if (initialized && !busy && !document.hidden && !document.getElementById('steamBoostSection').hidden) action(async () => {}); }, 30000);
})();
