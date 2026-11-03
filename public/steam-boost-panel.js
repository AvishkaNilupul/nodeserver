/* global fetch */
(() => {
  'use strict';
  const panel = document.getElementById('steamBoostBody');
  if (!panel) return;
  let data, busy = false;
  const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
  async function api(path, method = 'GET', body) {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const d = await r.json(); if (!r.ok || !d.success) throw Error(d.message || 'Request failed'); return d;
  }
  function field(label, value, type = 'number') {
    const l = el('label', label, 'st-field'); const i = el('input'); i.type = type; if (type === 'checkbox') i.checked = value; else i.value = value; l.append(i); return { label: l, input: i };
  }
  async function action(fn) {
    if (busy) return; busy = true;
    try { await fn(); await load(); } catch (e) { panel.prepend(el('p', e.message, 'st-warn')); } finally { busy = false; }
  }
  function render() {
    panel.replaceChildren(); const cfg = data.settings;
    panel.append(el('p', data.worker.online ? 'Worker online · ' + data.worker.note : 'Worker offline · reserved accounts remain held', data.worker.online ? 'st-small' : 'st-warn'));
    panel.append(el('p', 'Eldorado only. Keep empty regional stock first; overflow is split between game preparation and hour boosting. Prepared stock is listed after confirmed logout. Boosted hours are idle time, not gameplay.', 'st-small st-muted'));
    const form = el('form'); const row = el('div', null, 'st-toolbar');
    const enabled = field('Allocate incoming accounts', cfg.enabled, 'checkbox');
    const prepare = field('Prepare game accounts too', cfg.prepareGames, 'checkbox');
    const cap = field('Pool limit', cfg.maxAccounts); cap.input.min = 0; cap.input.max = 500;
    const keep = field('Empty accounts per region', cfg.keepPerRegion); keep.input.min = 0; keep.input.max = 50;
    const target = el('label', 'Boost target', 'st-field'), select = el('select');
    for (const h of [500, 1000]) { const o = el('option', h + ' hours per game'); o.value = h; o.selected = h === cfg.targetHours; select.append(o); } target.append(select);
    const priceGame = field('Game account price ($)', cfg.gamePriceUsd); priceGame.input.step = '0.01'; priceGame.input.min = '0.05';
    const priceBoost = field('Boosted account price ($)', cfg.boostPriceUsd); priceBoost.input.step = '0.01'; priceBoost.input.min = '0.05';
    for (const f of [enabled, prepare, cap, keep, priceGame, priceBoost]) row.append(f.label); row.append(target); form.append(row);
    const games = el('div', null, 'st-toolbar'); const checks = [];
    for (const g of data.catalog) { const f = field(g.name, cfg.games.includes(g.appId), 'checkbox'); games.append(f.label); checks.push([g.appId, f.input]); }
    const details = el('details'); details.append(el('summary', 'Games to prepare / boost')); details.append(games); form.append(details);
    const save = el('button', 'Save settings', 'btn btn-sm'); save.type = 'submit'; form.append(save);
    form.onsubmit = e => { e.preventDefault(); action(() => api('/api/steam/boost/settings', 'PATCH', { enabled: enabled.input.checked, prepareGames: prepare.input.checked, maxAccounts: Number(cap.input.value), keepPerRegion: Number(keep.input.value), targetHours: Number(select.value), gamePriceUsd: Number(priceGame.input.value), boostPriceUsd: Number(priceBoost.input.value), games: checks.filter(([, c]) => c.checked).map(([id]) => id) })); }; panel.append(form);
    const run = el('button', 'Allocate / refill now', 'btn btn-sm'); run.onclick = () => action(() => api('/api/steam/sales/distribute', 'POST')); panel.append(run);
    const refresh = el('button', 'Refresh progress', 'btn btn-sm'); refresh.onclick = () => action(load); panel.append(refresh);
    const add = el('button', 'Add selected stock accounts', 'btn btn-sm'); const picker = el('select'); picker.multiple = true; picker.size = 4;
    api('/api/steam/accounts').then(d => { for (const a of d.accounts.filter(a => a.stage === 'stock')) { const o = el('option', a.accountName + ' · ' + (a.signupCountry || '?')); o.value = a._id; picker.append(o); } }).catch(() => {});
    add.onclick = () => action(async () => { const r = await api('/api/steam/boost/add', 'POST', { accountIds: [...picker.selectedOptions].map(o => o.value) }); if (r.result.refused.length) throw Error(r.result.refused.map(x => x.why).join('; ')); }); panel.append(picker, add);
    panel.append(el('p', 'Apex and CS2 gain hours together. 500 hours takes about 21 days; 1,000 takes about 42 days, plus interruptions. The display uses Steam-recorded minutes.', 'st-small st-muted'));
    const table = el('table', null, 'acc-table'); const head = el('tr');
    for (const h of ['Account', 'Country', 'Purpose / target', 'State', 'Apex / CS2 hours', 'Games playing', 'Last report', 'Details', 'Actions']) head.append(el('th', h)); table.append(head);
    for (const a of [...data.live, ...data.ended]) {
      const tr = el('tr'); for (const value of [a.accountName, a.regionName, (a.purpose === 'game' ? 'Game preparation' : 'Boost ' + a.targetHours + ' h'), a.state + (a.workerState ? ' · ' + a.workerState : ''), a.apexHours + ' / ' + a.cs2Hours, a.playing, a.lastSeenAt ? new Date(a.lastSeenAt).toLocaleString() : 'Waiting', a.lastError || a.stopReason || '']) tr.append(el('td', value));
      const buttons = el('td'); const op = ['queued', 'boosting'].includes(a.state) ? 'stop' : ['failed', 'stopped'].includes(a.state) ? 'retry' : null;
      if (op) { const b = el('button', op === 'stop' ? 'Stop' : 'Retry', 'btn btn-sm'); b.onclick = () => action(() => api('/api/steam/boost/' + a._id + '/' + op, 'POST')); buttons.append(b); } tr.append(buttons); table.append(tr);
    }
    const wrap = el('div', null, 'st-table-wrap'); wrap.append(table); panel.append(wrap);
  }
  async function load() { const d = await api('/api/steam/boost'); data = d.boost; render(); }
  for (const button of document.querySelectorAll('[data-steam-tab]')) button.onclick = () => {
    const boost = button.dataset.steamTab === 'boost'; document.getElementById('steamBoostSection').hidden = !boost; document.getElementById('steamSalesSection').hidden = boost;
    for (const b of document.querySelectorAll('[data-steam-tab]')) b.setAttribute('aria-selected', String(b === button));
    if (boost) action(load);
  };
  load().catch(e => { panel.textContent = e.message; });
  setInterval(() => { if (!busy && !document.hidden && !document.getElementById('steamBoostSection').hidden) action(load); }, 30000);
})();
