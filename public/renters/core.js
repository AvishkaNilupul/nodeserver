/*
 * renters/core.js — the spine. Loaded FIRST, defines window.RT.
 *
 * Every other module in public/renters/ codes against the surface published
 * here and against nothing else (see CONTRACT.md "Cross-module exposure").
 *
 * The reason this rebuild exists: the original renters.html built inline
 * onclick attributes by interpolating runtime values (logins, passwords,
 * tokens) into JS string literals, escaped with esc(). esc() is HTML-escaping,
 * not JS-string-escaping — the HTML parser decodes &#39; back to ' before the
 * JS parser ever sees it, so any value containing ' or \ terminated the string
 * early. Broken handler, and an injection vector.
 *
 * The fix here is structural, not cosmetic: there is one delegated click
 * listener and a name -> function registry, so no runtime value is ever
 * interpolated into JS source. Markup carries an action NAME and small
 * non-secret scalars in data-*; secrets are looked up from a module's loaded
 * array by id, or attached after insertion via el.dataset.copy.
 */
(function () {
  "use strict";

  // ---- dom + format -------------------------------------------------------
  const $ = (id) => document.getElementById(id);

  function toast(m){ const t=$("toast"); t.textContent=m; t.classList.add("show"); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove("show"), Math.min(8000, 2200 + String(m).length*45)); }

  function esc(s){ return String(s==null?"":s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  // Deliberately does NOT redirect on 401/403. That behaviour belongs to
  // renter.html (the tenant-facing page); this is the operator console and a
  // surprise redirect here would swallow the real error message.
  async function api(path, opts){
    const res = await fetch(path, { credentials:"same-origin", headers:{"Content-Type":"application/json"}, ...opts });
    let d={}; try{ d=await res.json(); }catch(e){}
    if (!res.ok || d.success===false) throw new Error(d.message || "Request failed ("+res.status+")");
    return d;
  }

  function fmtDate(d){ return d ? new Date(d).toLocaleDateString() : "—"; }

  function remaining(end){ if(!end) return "no expiry"; const ms=new Date(end)-Date.now(); if(ms<=0) return "expired"; const dd=Math.floor(ms/864e5); return dd>=1?dd+"d left":Math.max(1,Math.floor(ms/36e5))+"h left"; }

  // ---- badges (pure -> html string) ---------------------------------------
  function statusBadge(r){ if(r.status==="suspended") return '<span class="badge suspended">Suspended</span>'; if(r.expired) return '<span class="badge expired">Expired</span>'; return '<span class="badge active">Active</span>'; }

  function botStatusHtml(bot){
    if(!bot || !bot.assigned) return '<span class="badge wait">No bot</span>';
    if(bot.running===true) return '<span class="badge active">Running</span>';
    if(bot.running===false) return '<span class="badge suspended">Stopped</span>';
    return '<span class="badge wait">Unknown</span>';
  }

  // The running-state pill. online===null means "we haven't asked a host yet" —
  // distinct from online===false, which is a host we asked and could not reach.
  // Without that distinction every bot flashes "Host offline" on load, which
  // reads as a broken system rather than a pending check.
  function botPill(b){
    if (b.online === null || b.online === undefined) return '<span class="badge wait">Checking…</span>';
    if (!b.online) return '<span class="badge wait">Host offline</span>';
    if (b.running === true) return '<span class="badge active">Running</span>';
    if (b.running === false) return '<span class="badge suspended">Stopped</span>';
    return '<span class="badge wait">Unknown</span>';
  }

  const SCAN_BADGE = {
    ok: '<span class="badge active">OK</span>',
    token_invalid: '<span class="badge suspended">Token invalid</span>',
    error: '<span class="badge expired">Error</span>',
    pending: '<span class="badge wait">Pending</span>',
  };
  function scanBadge(status){ return SCAN_BADGE[status] || SCAN_BADGE.pending; }

  function farmCell(a){
    if (a.farmEndedAt) return '<span class="badge expired">farm ended '+fmtDate(a.farmEndedAt)+'</span>';
    if (!a.farmUntil) return '<span class="muted">no limit</span>';
    return '<span class="badge '+(new Date(a.farmUntil)<=Date.now()?"expired":"wait")+'">'+esc(remaining(a.farmUntil))+' · '+fmtDate(a.farmUntil)+'</span>';
  }

  // `show` is passed in rather than read from a module-level flag: accounts.js
  // owns the Show/Hide secrets toggle, and core must stay stateless about it so
  // detail.js can render the same rows with a different visibility.
  function secret(v, show){
    if (!v) return '<span class="muted">—</span>';
    return show ? '<code>'+esc(v)+'</code>' : '<code>'+"\u2022".repeat(8)+'</code>';
  }

  function setMetric(name, value, detail, tone){
    const valueEl = $("metric" + name);
    const detailEl = $("metric" + name + "Detail");
    const card = $("metric" + name + "Card");
    if (valueEl) valueEl.textContent = value == null ? "—" : String(value);
    if (detailEl) detailEl.textContent = detail || "";
    if (card) {
      card.classList.remove("good");
      card.classList.remove("warn");
      card.classList.remove("alert");
      if (tone === "good" || tone === "warn" || tone === "alert") card.classList.add(tone);
    }
  }

  function hostSelectHtml(id){
    const opts = state.HOSTS.map(h=>'<option value="'+esc(h.id)+'">'+esc(h.label||h.id)+'</option>');
    if(!opts.length) opts.push('<option value="local">Server</option>');
    return '<select id="'+id+'" style="width:auto;min-width:120px">'+opts.join("")+'</select>';
  }

  // ---- shared state -------------------------------------------------------
  const state = { HOSTS: [], BOTS: [], CURRENT: null };

  // ---- modal --------------------------------------------------------------
  // Teardowns replace the original's hard-coded stopLogs() call inside
  // closeModal: core must not know that bots.js has a log poller. Whoever
  // starts something that outlives a render registers its own cleanup.
  let TEARDOWNS = [];

  function modalEl(){ return $("modal"); }

  function openModal(html){
    const m = modalEl();
    if (m) m.innerHTML = html;
    $("overlay").classList.add("show");
  }

  // Note: #modal innerHTML is intentionally left in place (as in the original)
  // so re-opening the same renter doesn't flash an empty panel. CURRENT is
  // cleared here; the opener (detail.js) is what sets it.
  function closeModal(){
    const fns = TEARDOWNS;
    TEARDOWNS = [];
    for (const fn of fns) { try { fn(); } catch (e) { /* a broken teardown must not block the close */ } }
    $("overlay").classList.remove("show");
    state.CURRENT = null;
  }

  function onClose(fn){
    if (typeof fn !== "function") return;
    if (TEARDOWNS.indexOf(fn) === -1) TEARDOWNS.push(fn);
  }

  // ---- action registry — replaces every inline onclick --------------------
  const ACTIONS = {};

  function on(name, fn){ ACTIONS[name] = fn; }

  // One delegated listener on document, so it covers the page AND anything
  // rendered into the modal later without re-binding.
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-act]");
    if (!el) return;
    const fn = ACTIONS[el.dataset.act];
    if (!fn) return;
    e.preventDefault();
    fn(el, el.dataset);
  });

  // ---- reload registry ----------------------------------------------------
  // Modules assign their loader here: hosts, botPicker, approvals, renters,
  // bots, accounts, drops. accounts.js/drops.js register only AFTER their first
  // successful load, which is how the original's ACCS_LOADED / DROPS_LOADED
  // flags are preserved: reloadMany skips absent keys, so a global Refresh
  // never force-fetches a section the operator never opened.
  const reload = {};

  function reloadMany(keys){
    const list = (Array.isArray(keys) ? keys : [keys]).filter((k) => typeof reload[k] === "function");
    return Promise.all(list.map((k) => reload[k]()));
  }

  // ---- clipboard ----------------------------------------------------------
  async function copy(text){
    try { await navigator.clipboard.writeText(text); toast("Copied"); }
    catch(e){ toast("Copy failed"); }
  }

  window.RT = {
    $, esc, toast, api, fmtDate, remaining,
    statusBadge, botStatusHtml, botPill, scanBadge, farmCell, secret, hostSelectHtml, setMetric,
    openModal, closeModal, modalEl, onClose,
    on,
    state,
    reload, reloadMany,
    copy,
  };

  // ---- static wiring core owns -------------------------------------------
  on("closeModal", () => closeModal());

  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

  // Backdrop click. Bound to #overlay itself (as in the original) so only a
  // click on the backdrop closes — clicks inside .modal bubble to #overlay but
  // have a different target. Deferred when core.js is loaded before the markup.
  function bindOverlay(){
    const ov = $("overlay");
    if (!ov) return false;
    ov.addEventListener("click", (e) => { if (e.target === ov) closeModal(); });
    return true;
  }
  if (!bindOverlay()) document.addEventListener("DOMContentLoaded", bindOverlay, { once: true });
})();
