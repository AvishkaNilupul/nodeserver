// /chzzk/app.js — behaviour for the CHZZK farm admin page. See docs/CHZZK-FARM.md §13.
// Vanilla DOM, no frameworks. All text from the API is rendered via textContent.
// Fetch uses same-origin cookies; a 401 bounces to /admin-login.html.

(function () {
  'use strict';

  // -------- Tiny DOM helpers ---------------------------------------------
  const $  = (sel, root) => (root || document).querySelector(sel);

  // el("tag", {class, style, text, onclick, ...attrs}, child|children)
  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null) continue;
        if (k === 'class')      n.className = v;
        else if (k === 'style') n.setAttribute('style', v);
        else if (k === 'text')  n.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') {
          n.addEventListener(k.slice(2), v);
        } else {
          n.setAttribute(k, v);
        }
      }
    }
    if (children != null) {
      (Array.isArray(children) ? children : [children]).forEach(c => {
        if (c == null) return;
        if (typeof c === 'string' || typeof c === 'number') {
          n.appendChild(document.createTextNode(String(c)));
        } else {
          n.appendChild(c);
        }
      });
    }
    return n;
  }

  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

  function toast(msg, kind) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast show ' + (kind || 'ok');
    setTimeout(() => { t.className = 'toast ' + (kind || 'ok'); }, 3600);
  }

  // -------- Time + number helpers ----------------------------------------
  function _parse(iso) {
    if (!iso) return 0;
    const d = new Date(iso);
    const t = d.getTime();
    return isFinite(t) ? t : 0;
  }

  function fmtAgo(iso) {
    const t = _parse(iso);
    if (!t) return '—';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (s < 60)    return s + 's ago';
    if (s < 3600)  return Math.floor(s / 60)   + ' m ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return Math.floor(s / 86400) + ' d ago';
  }

  function fmtIn(iso) {
    const t = _parse(iso);
    if (!t) return '—';
    const diff = Math.floor((t - Date.now()) / 1000);
    if (diff < 0) return fmtAgo(iso);
    if (diff < 60)    return 'in ' + diff + 's';
    if (diff < 3600)  return 'in ' + Math.floor(diff / 60)   + ' m';
    if (diff < 86400) return 'in ' + Math.floor(diff / 3600) + ' h';
    return 'in ' + Math.floor(diff / 86400) + ' d';
  }

  function fmtDate(iso) {
    const t = _parse(iso);
    if (!t) return '—';
    return new Date(t).toLocaleString();
  }

  function fmtInt(n) {
    if (n == null || !isFinite(n)) return '—';
    return Number(n).toLocaleString();
  }

  // -------- API wrapper --------------------------------------------------
  // Unwraps { success, ... }; on 401 sends the browser to login.
  async function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
      opts.body = JSON.stringify(opts.body);
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    }
    let r;
    try { r = await fetch(path, opts); }
    catch (e) { throw new Error('network: ' + (e && e.message ? e.message : e)); }
    if (r.status === 401) {
      window.location.href = '/admin-login.html';
      throw new Error('unauthenticated');
    }
    let data = {};
    try { data = await r.json(); } catch (e) { /* non-JSON body is OK on 204 */ }
    if (!r.ok || data.success === false) {
      throw new Error(data.error || data.message || ('HTTP ' + r.status));
    }
    return data;
  }

  // -------- State --------------------------------------------------------
  let pollTimers = { state: null, lists: null };
  // One live reveal per reward row — tracked so re-reveals clear the old timer.
  const revealTimers = new Map();

  function statusChipClass(status) {
    if (status === 'ok')              return 'chip ok';
    if (status === 'not_logged_in')   return 'chip err';
    return 'chip warn';
  }
  function statusChipText(status) {
    if (status === 'ok')              return 'ok';
    if (status === 'not_logged_in')   return 'logged out';
    return status || 'untested';
  }
  function rewardStateChip(st) {
    if (st === 'stored') return 'chip ok';
    if (st === 'earned') return 'chip warn';
    if (st === 'in_app') return 'chip off';
    return 'chip off';
  }
  function rewardTypeLabel(rt) {
    if (rt === 'CODE_FIRST_COME') return 'CODE';
    if (rt === 'CODE_LOTTERY')    return 'LOTTERY';
    if (rt === 'IN_APP')          return 'IN-APP';
    return rt || '—';
  }

  // -------- Render: state (header + totals + accounts) -------------------
  function renderState(s) {
    const sw   = $('#switchBtn');
    const chip = $('#egressChip');

    // Switch
    const on = !!(s && s.switch && s.switch.on);
    sw.textContent = on ? 'FARM: ON' : 'FARM: OFF';
    sw.className   = 'switch ' + (on ? 'on' : 'off');
    sw.setAttribute('data-on', on ? '1' : '0');
    sw.disabled    = false;

    // Egress
    const e = (s && s.egress) || {};
    if (e.ok === true) {
      chip.textContent = 'via ' + (e.via || 'none') + ' · ' + (e.country || '—') + ' · ok';
      chip.className   = 'chip ok';
    } else if (e.ok === false) {
      chip.textContent = 'via ' + (e.via || 'none') + ' · ' + (e.country || '—') + ' · ' + (e.error || 'blocked');
      chip.className   = 'chip err';
    } else {
      chip.textContent = 'egress: checking…';
      chip.className   = 'chip off';
    }

    // Totals
    const t = (s && s.totals) || {};
    $('#t-accounts').textContent  = fmtInt(t.accounts || 0);
    $('#t-ok').textContent        = fmtInt(t.ok || 0);
    $('#t-loggedout').textContent = fmtInt(t.loggedOut || 0);
    $('#t-watching').textContent  = fmtInt(t.watching || 0);
    $('#t-codes').textContent     = fmtInt(t.codes || 0);
    $('#t-campaigns').textContent = fmtInt(t.campaigns || 0);

    renderAccounts((s && s.accounts) || []);
  }

  function renderAccounts(list) {
    const host = $('#accountsTable');
    clear(host);
    $('#accountsCount').textContent = list.length ? '· ' + list.length : '';
    if (!list.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No accounts yet — paste a Cookie-Editor export above.' }));
      return;
    }
    const table = el('table');
    table.appendChild(el('thead', null, el('tr', null, [
      el('th', { text: 'Nickname' }),
      el('th', { text: 'Status' }),
      el('th', { text: 'Now' }),
      el('th', { text: 'Codes' }),
      el('th', { text: 'Cookie age' }),
      el('th', { style: 'text-align:right;', text: 'Actions' }),
    ])));
    const tbody = el('tbody');
    list.forEach(a => tbody.appendChild(renderAccountRow(a)));
    table.appendChild(tbody);
    host.appendChild(el('div', { class: 'table-wrap' }, table));
  }

  function renderAccountRow(a) {
    const tr = el('tr');

    // Nickname + userIdHash
    const name = el('td');
    name.appendChild(el('strong', { text: a.nickname || '(no nickname)' }));
    const sub = el('div', { class: 'mono', style: 'color: var(--muted); font-size: 11px; margin-top: 2px;' });
    sub.textContent = (a.userIdHash || '') + (a.note ? '  ·  ' + a.note : '');
    name.appendChild(sub);
    tr.appendChild(name);

    // Status chips + lastError
    const statusTd = el('td');
    const stack = el('div', { style: 'display: flex; gap: 4px; flex-wrap: wrap;' });
    stack.appendChild(el('span', { class: statusChipClass(a.status), text: statusChipText(a.status) }));
    if (a.sold)   stack.appendChild(el('span', { class: 'chip off',  text: 'sold' }));
    if (a.paused) stack.appendChild(el('span', { class: 'chip warn', text: 'paused' }));
    statusTd.appendChild(stack);
    if (a.lastError) {
      const err = el('div', { style: 'color: var(--err); font-size: 11px; margin-top: 4px; overflow-wrap: anywhere;' });
      err.textContent = a.lastError;
      statusTd.appendChild(err);
    }
    tr.appendChild(statusTd);

    // Now
    const nowTd = el('td');
    const nw = a.current;
    if (!nw || typeof nw !== 'object') {
      nowTd.appendChild(el('span', { class: 'now', text: '—' }));
    } else {
      const line1 = el('div', { class: 'now' });
      line1.appendChild(el('b', { text: nw.state || 'idle' }));
      if (nw.title) line1.appendChild(document.createTextNode(' · ' + nw.title));
      nowTd.appendChild(line1);
      const bits = [];
      if (nw.channelName) bits.push(nw.channelName);
      if (nw.minutes != null) bits.push(fmtInt(Math.floor(nw.minutes)) + ' m');
      if (nw.since) bits.push('since ' + fmtAgo(nw.since));
      if (bits.length) {
        const line2 = el('div', { class: 'now', style: 'margin-top: 2px;' });
        line2.textContent = bits.join(' · ');
        nowTd.appendChild(line2);
      }
      if (nw.note) {
        const line3 = el('div', { class: 'now', style: 'margin-top: 2px; font-style: italic;' });
        line3.textContent = nw.note;
        nowTd.appendChild(line3);
      }
    }
    tr.appendChild(nowTd);

    // Codes count
    tr.appendChild(el('td', { style: 'font-variant-numeric: tabular-nums;', text: fmtInt(a.codes || 0) }));

    // Cookie age
    tr.appendChild(el('td', {
      class: 'mono', style: 'color: var(--muted); font-size: 12px;',
      text: fmtAgo(a.cookieAt),
    }));

    // Actions
    const actionsTd = el('td');
    const bar = el('div', { class: 'actions' });
    bar.appendChild(el('button', {
      class: 'small', text: 'Check',
      onclick: () => accountCheck(a.id),
    }));
    bar.appendChild(el('button', {
      class: 'small', text: a.paused ? 'Resume' : 'Pause',
      onclick: () => accountUpdate(a.id, { paused: !a.paused }, (a.paused ? 'Resumed ' : 'Paused ') + (a.nickname || 'account')),
    }));
    bar.appendChild(el('button', {
      class: 'small', text: a.sold ? 'Unsold' : 'Mark sold',
      onclick: () => accountUpdate(a.id, { sold: !a.sold }, (a.nickname || 'account') + (a.sold ? ' unmarked' : ' marked sold')),
    }));
    bar.appendChild(el('button', {
      class: 'small danger', text: 'Delete',
      onclick: () => accountDelete(a.id, a.nickname || a.id),
    }));
    actionsTd.appendChild(bar);
    tr.appendChild(actionsTd);

    return tr;
  }

  // -------- Account actions ---------------------------------------------
  async function accountCheck(id) {
    try {
      await api('/api/chzzk/accounts/check', { method: 'POST', body: { ids: [id] } });
      toast('Login check queued');
      setTimeout(reloadState, 1500);
    } catch (e) { toast('Check failed: ' + e.message, 'err'); }
  }

  async function accountUpdate(id, patch, okMsg) {
    try {
      await api('/api/chzzk/accounts/update', { method: 'POST', body: Object.assign({ id }, patch) });
      toast(okMsg || 'Updated');
      await reloadState();
    } catch (e) { toast('Update failed: ' + e.message, 'err'); }
  }

  async function accountDelete(id, nickname) {
    if (!confirm('Delete account "' + nickname + '"?\n\nEarned codes are kept.')) return;
    try {
      const r = await api('/api/chzzk/accounts/delete', { method: 'POST', body: { ids: [id] } });
      toast('Deleted ' + (r.deleted || 0) + ' · kept ' + (r.keptCodes || 0) + ' code row(s)');
      await reloadState();
      await reloadRewards();
    } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
  }

  // -------- Campaigns ---------------------------------------------------
  async function reloadCampaigns() {
    try {
      const r = await api('/api/chzzk/campaigns');
      renderCampaigns(r.campaigns || []);
    } catch (e) {
      const host = $('#campaignsTable');
      clear(host);
      host.appendChild(el('div', { class: 'empty', style: 'color: var(--err);', text: 'Load failed: ' + e.message }));
    }
  }

  function renderCampaigns(list) {
    const host = $('#campaignsTable');
    clear(host);
    $('#campaignsCount').textContent = list.length ? '· ' + list.length : '';
    if (!list.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No campaigns yet — press Refresh.' }));
      return;
    }
    const table = el('table');
    table.appendChild(el('thead', null, el('tr', null, [
      el('th', { text: 'Game' }),
      el('th', { text: 'Title' }),
      el('th', { text: 'Ends' }),
      el('th', { text: 'Rewards' }),
      el('th', { text: 'Status' }),
      el('th', { style: 'text-align:right;', text: 'Actions' }),
    ])));
    const tbody = el('tbody');
    list.forEach(c => tbody.appendChild(renderCampaignRow(c)));
    table.appendChild(tbody);
    host.appendChild(el('div', { class: 'table-wrap' }, table));
  }

  function renderCampaignRow(c) {
    const tr = el('tr');

    // Game
    const game = el('td');
    game.appendChild(el('strong', { text: c.categoryValue || c.categoryId || '—' }));
    game.appendChild(el('div', {
      class: 'mono', style: 'color: var(--muted); font-size: 11px; margin-top: 2px;',
      text: '#' + c.campaignNo,
    }));
    tr.appendChild(game);

    // Title
    const title = el('td');
    title.appendChild(el('span', { text: c.title || '—' }));
    if (c.needsLink) {
      title.appendChild(el('div', { style: 'margin-top: 4px;' },
        el('span', { class: 'chip warn', text: 'needs account link' })));
    }
    tr.appendChild(title);

    // Ends: local time + "in 5 h"
    const ends = el('td');
    ends.textContent = fmtDate(c.endAt);
    ends.appendChild(el('div', {
      style: 'color: var(--muted); font-size: 11px; margin-top: 2px;',
      text: fmtIn(c.endAt),
    }));
    tr.appendChild(ends);

    // Rewards
    const rewardsTd = el('td');
    const rewards = c.rewards || [];
    if (!rewards.length) {
      rewardsTd.appendChild(document.createTextNode('—'));
    } else {
      rewards.forEach(r => {
        const bits = [];
        if (r.minutes != null) bits.push(r.minutes + ' m');
        bits.push(rewardTypeLabel(r.rewardType));
        if (r.remaining != null) bits.push(fmtInt(r.remaining) + ' left');
        if (r.earned != null)    bits.push(fmtInt(r.earned) + ' ours');
        rewardsTd.appendChild(el('div', { style: 'margin-bottom: 2px;', text: bits.join(' · ') }));
      });
    }
    tr.appendChild(rewardsTd);

    // Status chips
    const st = el('td');
    const stack = el('div', { style: 'display: flex; gap: 4px; flex-wrap: wrap;' });
    stack.appendChild(el('span', {
      class: c.farmable ? 'chip ok' : 'chip off',
      text: c.farmable ? 'farmable' : (c.state ? c.state.toLowerCase() : 'not farmable'),
    }));
    if (!c.enabled) stack.appendChild(el('span', { class: 'chip off', text: 'disabled' }));
    st.appendChild(stack);
    tr.appendChild(st);

    // Actions
    const actionsTd = el('td');
    const bar = el('div', { class: 'actions' });
    bar.appendChild(el('button', {
      class: 'small', text: c.enabled ? 'Disable' : 'Enable',
      onclick: () => campaignEnable(c.campaignNo, !c.enabled),
    }));
    actionsTd.appendChild(bar);
    tr.appendChild(actionsTd);

    return tr;
  }

  async function campaignEnable(no, enabled) {
    try {
      await api('/api/chzzk/campaigns/enable', { method: 'POST', body: { campaignNo: no, enabled: !!enabled } });
      toast('Campaign ' + (enabled ? 'enabled' : 'disabled'));
      reloadCampaigns();
    } catch (e) { toast('Update failed: ' + e.message, 'err'); }
  }

  async function campaignRefresh() {
    const btn = $('#refreshCampaignsBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/chzzk/campaigns/refresh', { method: 'POST' });
      toast('Found ' + (r.found || 0) + ' · updated ' + (r.updated || 0));
      await reloadCampaigns();
    } catch (e) { toast('Refresh failed: ' + e.message, 'err'); }
    finally { btn.disabled = false; }
  }

  async function campaignAdd() {
    const input = $('#addCampaignNo');
    const n = parseInt(input.value, 10);
    if (!n || n < 1) { toast('Enter a campaign number', 'err'); return; }
    const btn = $('#addCampaignBtn');
    btn.disabled = true;
    try {
      await api('/api/chzzk/campaigns/add', { method: 'POST', body: { campaignNo: n } });
      toast('Campaign ' + n + ' added');
      input.value = '';
      await reloadCampaigns();
    } catch (e) { toast('Add failed: ' + e.message, 'err'); }
    finally { btn.disabled = false; }
  }

  // -------- Rewards (Codes) ---------------------------------------------
  async function reloadRewards() {
    try {
      const r = await api('/api/chzzk/rewards');
      renderRewards(r.rewards || []);
    } catch (e) {
      const host = $('#rewardsTable');
      clear(host);
      host.appendChild(el('div', { class: 'empty', style: 'color: var(--err);', text: 'Load failed: ' + e.message }));
    }
  }

  function renderRewards(list) {
    const host = $('#rewardsTable');
    clear(host);
    $('#codesCount').textContent = list.length ? '· ' + list.length : '';
    if (!list.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No codes earned yet.' }));
      return;
    }
    const table = el('table');
    table.appendChild(el('thead', null, el('tr', null, [
      el('th', { text: 'Earned at' }),
      el('th', { text: 'Account' }),
      el('th', { text: 'Game' }),
      el('th', { text: 'Reward' }),
      el('th', { text: 'State' }),
      el('th', { style: 'text-align:right;', text: 'Code' }),
    ])));
    const tbody = el('tbody');
    list.forEach(r => tbody.appendChild(renderRewardRow(r)));
    table.appendChild(tbody);
    host.appendChild(el('div', { class: 'table-wrap' }, table));
  }

  function renderRewardRow(r) {
    const tr = el('tr');
    tr.appendChild(el('td', {
      class: 'mono', style: 'font-size: 12px; color: var(--muted); white-space: nowrap;',
      text: fmtDate(r.earnedAt),
    }));
    tr.appendChild(el('td', { text: r.nickname || r.userIdHash || r.accountId || '—' }));
    tr.appendChild(el('td', { text: r.campaignTitle || r.categoryId || '—' }));
    const rwTd = el('td');
    rwTd.appendChild(el('span', { text: r.title || '—' }));
    rwTd.appendChild(el('div', {
      style: 'color: var(--muted); font-size: 11px; margin-top: 2px;',
      text: rewardTypeLabel(r.rewardType),
    }));
    tr.appendChild(rwTd);
    tr.appendChild(el('td', null, el('span', { class: rewardStateChip(r.state), text: r.state || '—' })));

    const codeTd = el('td', { style: 'text-align: right;' });
    if (r.state === 'in_app') {
      codeTd.appendChild(el('span', { style: 'color: var(--muted);', text: 'in-app reward' }));
    } else if (!r.hasCode) {
      const note = r.lastError ? ('retry · ' + r.lastError) : 'pending';
      codeTd.appendChild(el('span', { style: 'color: var(--muted); font-size: 12px;', text: note }));
    } else {
      renderCodeCell(codeTd, r.id, null);
    }
    tr.appendChild(codeTd);
    return tr;
  }

  // Puts a "Reveal" button in the cell (code=null) or the revealed code + Copy + countdown.
  function renderCodeCell(cell, rewardId, code) {
    clear(cell);
    // Dropping the old countdown — clear any interval tied to this reward row.
    const old = revealTimers.get(rewardId);
    if (old) { clearInterval(old); revealTimers.delete(rewardId); }

    if (code == null) {
      const bar = el('div', { class: 'actions', style: 'justify-content: flex-end;' });
      bar.appendChild(el('button', {
        class: 'small', text: 'Reveal',
        onclick: () => doReveal(rewardId, cell),
      }));
      cell.appendChild(bar);
      return;
    }

    const wrap = el('span', { class: 'code-cell' });
    wrap.appendChild(el('span', { text: code }));
    wrap.appendChild(el('button', {
      class: 'small', text: 'Copy',
      onclick: () => {
        if (!navigator.clipboard) { toast('Clipboard unsupported', 'err'); return; }
        navigator.clipboard.writeText(code).then(
          () => toast('Code copied'),
          () => toast('Copy blocked by browser', 'err'),
        );
      },
    }));
    const cd = el('span', { class: 'countdown', text: '60s' });
    wrap.appendChild(cd);
    cell.appendChild(wrap);

    let left = 60;
    const iv = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(iv);
        revealTimers.delete(rewardId);
        renderCodeCell(cell, rewardId, null);
      } else {
        cd.textContent = left + 's';
      }
    }, 1000);
    revealTimers.set(rewardId, iv);
  }

  async function doReveal(rewardId, cell) {
    try {
      const r = await api('/api/chzzk/rewards/reveal', { method: 'POST', body: { id: rewardId } });
      if (!r || !r.code) { toast('No code to reveal', 'err'); return; }
      renderCodeCell(cell, rewardId, r.code);
    } catch (e) { toast('Reveal failed: ' + e.message, 'err'); }
  }

  // -------- Activity ----------------------------------------------------
  async function reloadActivity() {
    try {
      const r = await api('/api/chzzk/activity?limit=100');
      renderActivity(r.entries || []);
    } catch (e) {
      const host = $('#activityList');
      clear(host);
      host.appendChild(el('div', { class: 'empty', style: 'color: var(--err);', text: 'Load failed: ' + e.message }));
    }
  }

  function renderActivity(entries) {
    const host = $('#activityList');
    clear(host);
    if (!entries.length) {
      host.appendChild(el('div', { class: 'empty', text: 'No activity yet.' }));
      return;
    }
    entries.forEach(entry => {
      const row = el('div', { class: 'entry' });
      row.appendChild(el('div', { class: 'at', text: fmtAgo(entry.at) }));
      const lvl = (entry.level || 'info').toLowerCase();
      row.appendChild(el('div', { class: 'lvl ' + lvl, text: lvl }));
      const msg = el('div', { class: 'msg' });
      msg.textContent = (entry.kind ? '[' + entry.kind + '] ' : '') + (entry.msg || '');
      row.appendChild(msg);
      host.appendChild(row);
    });
  }

  // -------- Switch ------------------------------------------------------
  async function switchClick() {
    const btn = $('#switchBtn');
    const on  = btn.getAttribute('data-on') === '1';
    if (on && !confirm('Turn the CHZZK farm OFF?\n\nAll workers will stop; cookies, codes and accounts are kept.')) {
      return;
    }
    btn.disabled = true;
    try {
      await api('/api/chzzk/switch', { method: 'POST', body: { on: !on } });
      toast('Farm turned ' + (on ? 'off' : 'on'));
      await reloadState();
    } catch (e) {
      toast('Switch failed: ' + e.message, 'err');
      btn.disabled = false;
    }
  }

  // -------- Import ------------------------------------------------------
  async function doImport() {
    const ta = $('#importText');
    const text = (ta.value || '').trim();
    if (!text) { toast('Paste a Cookie-Editor export first', 'err'); return; }
    if (text.length > 90 * 1024) { toast('Paste is too large (>90 kB)', 'err'); return; }
    const btn = $('#importBtn');
    btn.disabled = true;
    try {
      const r = await api('/api/chzzk/accounts/import', { method: 'POST', body: { cookies: text } });
      const results = r.results || [];
      renderImportResults(results);
      if (results.some(x => x && x.ok)) ta.value = '';
      await reloadState();
    } catch (e) {
      renderImportResults([]);
      toast('Import failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
    }
  }

  function renderImportResults(results) {
    const host = $('#importResults');
    clear(host);
    if (!results.length) {
      host.appendChild(el('div', { class: 'line err', text: 'No jars found in the paste.' }));
      return;
    }
    results.forEach((x, i) => {
      const line = el('div', { class: 'line ' + (x && x.ok ? 'ok' : 'err') });
      const bits = ['Jar ' + (i + 1)];
      if (x && x.ok) {
        bits.push('ok');
        if (x.nickname)    bits.push(x.nickname);
        if (x.userIdHash8) bits.push(x.userIdHash8);
        bits.push(x.created ? 'new' : 'updated');
      } else {
        bits.push('error');
        if (x && x.error) bits.push(x.error);
      }
      line.textContent = bits.join(' · ');
      host.appendChild(line);
    });
  }

  // -------- Polling + wiring --------------------------------------------
  async function reloadState() {
    try {
      const s = await api('/api/chzzk/state');
      renderState(s);
    } catch (e) {
      // Leave the previous view in place; the chip stays red on egress trouble.
    }
  }

  function startPolling() {
    reloadState();
    reloadCampaigns();
    reloadRewards();
    reloadActivity();
    if (pollTimers.state) clearInterval(pollTimers.state);
    if (pollTimers.lists) clearInterval(pollTimers.lists);
    pollTimers.state = setInterval(reloadState, 10000);
    pollTimers.lists = setInterval(() => {
      reloadCampaigns();
      reloadRewards();
      reloadActivity();
    }, 60000);
  }

  function wire() {
    $('#switchBtn').addEventListener('click', switchClick);
    $('#importBtn').addEventListener('click', doImport);
    $('#addCampaignBtn').addEventListener('click', campaignAdd);
    $('#refreshCampaignsBtn').addEventListener('click', campaignRefresh);
    $('#addCampaignNo').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); campaignAdd(); }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { wire(); startPolling(); });
  } else {
    wire();
    startPolling();
  }
})();
