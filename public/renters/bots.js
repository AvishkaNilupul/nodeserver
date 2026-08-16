/* renters/bots.js — "Rented bots" section.
 *
 * Owns: the bots overview rows, the live running-state pills, the renter
 * drop-scanner stat line, start/stop/restart, and the live docker log tail.
 * Ported from public/renters.html lines 359-432 and 502-548.
 *
 * Contract: public/renters/CONTRACT.md. No inline on* attributes, no handler
 * globals — every button carries data-act and is dispatched by core.js.
 */
(function () {
  "use strict";

  const RT = window.RT;
  if (!RT) { console.error("bots.js: RT (core.js) not loaded"); return; }

  // Wrappers, not destructured references: a helper must never be called
  // detached from RT in case core.js implements one as a `this`-using method.
  const $ = (id) => RT.$(id);
  const esc = (v) => RT.esc(v);
  const api = (p, o) => RT.api(p, o);
  const toast = (m) => RT.toast(m);

  // Counts come from the API as numbers, but they are still runtime values, so
  // they go through esc() too. String() first so esc() never sees a non-string.
  const num = (v) => esc(String(v == null ? "" : v));

  // ---- rented bots overview ----

  async function loadRentBots() {
    try {
      const d = await api("/renter-bots");
      const bots = d.bots || [];
      const issues = bots.reduce((sum, b) => sum + (Number(b.tokenIssues) || 0), 0);
      RT.setMetric("Bots", bots.length, bots.length ? "Checking live state" : "No bots assigned", bots.length ? "" : "warn");
      RT.setMetric("Issues", issues, issues ? "Requires attention" : "All tokens healthy", issues ? "alert" : "good");
      if (!bots.length) {
        $("rentBots").innerHTML =
          '<div class="muted" style="padding:6px 2px">No rented bots yet. Create one from a renter’s <b>Manage</b> panel.</div>';
        return;
      }
      $("rentBots").innerHTML = bots.map((b) => {
        // botPill lives in core.js; online===null must stay distinct from false.
        const runPill = RT.botPill(b);
        return '<div class="row" data-bot="' + esc(b.renterId) + '">' +
          '<div><div class="nm">' + esc(b.username) + ' ' +
            (b.status === "suspended" ? '<span class="badge suspended">Suspended</span>' : '') + '</div>' +
            '<div class="meta">' + esc(b.hostLabel || b.host) + ' · ' + esc(b.file) +
              (b.sharedBy > 1 ? ' · <b>shared ×' + num(b.sharedBy) + '</b>' : '') +
              ' · ' + num(b.accounts) + ' account(s) · ' + num(b.drops) + ' drop(s)' +
              (b.tokenIssues
                ? ' · <span class="tokwarn">⚠ ' + num(b.tokenIssues) + ' token issue' +
                  (b.tokenIssues > 1 ? 's' : '') + '</span>'
                : '') +
            '</div></div>' +
          '<div class="meta" data-pill="' + esc(b.renterId) + '">' + runPill + '</div>' +
          '<div class="meta mono">' + esc(b.container || "") + '</div>' +
          '<div class="acts">' +
            '<button class="btn sm" data-act="botOp" data-op="start" data-id="' + esc(b.renterId) + '">Start</button>' +
            '<button class="btn ghost sm" data-act="botOp" data-op="restart" data-id="' + esc(b.renterId) + '">Restart</button>' +
            '<button class="btn warn sm" data-act="botOp" data-op="stop" data-id="' + esc(b.renterId) + '">Stop</button>' +
            '<button class="btn ghost sm" data-act="botLogs" data-id="' + esc(b.renterId) + '">Logs</button>' +
            '<button class="btn ghost sm" data-act="botManage" data-id="' + esc(b.renterId) + '">Manage</button>' +
          '</div></div>';
      }).join("");
    } catch (e) {
      RT.setMetric("Bots", "—", "Unavailable", "alert");
      RT.setMetric("Issues", "—", "Unavailable", "alert");
      $("rentBots").innerHTML = '<div class="muted">' + esc(e.message) + '</div>';
    }
    loadScanStat();
    // Deliberately NOT awaited: the rows are already painted, and the live
    // check is the slow part (SSH to the Pi, ~3s cold). Nothing on this page
    // may wait for it.
    loadRentBotsLive();
  }

  // Fetch the real container states and swap them into the already-painted
  // rows. Kept out of loadRentBots' await chain for the reason above.
  async function loadRentBotsLive() {
    try {
      const d = await api("/renter-bots/live");
      const live = d.live || [];
      const running = live.filter((b) => b && b.online && b.running === true).length;
      const reachable = live.filter((b) => b && b.online).length;
      RT.setMetric("Bots", live.length, running + " running · " + reachable + " reachable", running === live.length && live.length ? "good" : "warn");
      // Rows may have been re-rendered while we waited, so re-query and match
      // on dataset instead of building a selector out of a runtime id.
      const byId = new Map();
      document.querySelectorAll("[data-pill]").forEach((c) => byId.set(c.dataset.pill, c));
      for (const l of live) {
        const cell = byId.get(String(l.renterId));
        if (cell) cell.innerHTML = RT.botPill(l);
      }
    } catch (e) {
      const value = $("metricBots") ? $("metricBots").textContent : "—";
      RT.setMetric("Bots", value, "Live state unavailable", "warn");
      // Leaving the pills on "Checking…" forever would be a lie, so say the
      // check itself failed and let the operator retry with Refresh.
      document.querySelectorAll("[data-pill]").forEach((cell) => {
        cell.innerHTML = '<span class="badge wait" title="' + esc(e.message || "") + '">Status unavailable</span>';
      });
    }
  }

  // Renter drop-scanner status line (next to the Rented bots heading).
  async function loadScanStat() {
    const el = $("scanStat");
    if (!el) return;
    try {
      const d = await api("/renter-scan/progress");
      const p = d.progress || {}, c = p.counts || {};
      if (!c.total) { el.textContent = ""; return; }
      const bits = ["Scanner: " + (c.scannedWindow || 0) + "/" + c.total + " scanned", (c.due || 0) + " due"];
      if (c.paused) bits.push(c.paused + " paused (access ended)");
      if (c.tokenInvalid) bits.push(c.tokenInvalid + " token issue" + (c.tokenInvalid > 1 ? "s" : ""));
      if (p.scanning && p.currentLogin) bits.push("scanning " + p.currentLogin);
      el.textContent = bits.join(" · ");
    } catch (e) {
      el.textContent = "";
    }
  }

  // ---- start / stop / restart ----

  async function botOp(id, action, el) {
    if (el) el.disabled = true;
    try {
      await api("/renters/" + id + "/bot/" + action, { method: "POST" });
      toast(action === "start" ? "Bot started" : action === "stop" ? "Bot stopped" : "Bot restarting");
      await RT.reloadMany(["renters", "bots"]);
      // Not awaited, same as the original: the detail modal refreshes itself.
      if (RT.state.CURRENT === id) RT.detail.reopen();
    } catch (e) {
      toast(e.message);
    } finally {
      if (el) el.disabled = false;
    }
  }

  // ---- live bot logs (same docker tail the Bots page shows) ----

  let _logTimer = null;

  // Idempotent: registered with RT.onClose so closing the modal always kills
  // the poller (the original called stopLogs() from inside closeModal).
  function stopLogs() {
    if (_logTimer) { clearInterval(_logTimer); _logTimer = null; }
  }

  // First paint should land at the newest lines.
  function wrapScrollInit() {
    setTimeout(() => { const w = $("logWrap"); if (w) w.scrollTop = w.scrollHeight; }, 350);
  }

  function toggleLogs(id) {
    const box = $("botLogBox");
    if (!box) return;

    if (_logTimer || box.innerHTML) {
      stopLogs();
      box.innerHTML = "";
      const btn = $("logBtn");
      if (btn) btn.textContent = "Logs";
      return;
    }

    box.innerHTML =
      '<div class="logbar"><span class="live"><i></i> Live</span>' +
        '<span>Tail <select id="logTail" class="selin" style="min-width:auto"><option>100</option><option selected>200</option><option>500</option><option>1000</option></select> lines</span>' +
        '<span id="logMeta" style="margin-left:auto"></span></div>' +
      '<div class="logwrap" id="logWrap">Loading logs…</div>';
    const btn = $("logBtn");
    if (btn) btn.textContent = "Hide logs";

    let last = null;
    async function poll() {
      const wrap = $("logWrap");
      if (!wrap) { stopLogs(); return; }   // modal re-rendered or closed
      const tail = $("logTail") ? $("logTail").value : 200;
      try {
        const r = await api("/renters/" + id + "/bot/logs?tail=" + encodeURIComponent(tail));
        const text = (r.logs || "").replace(/\s+$/, "") || "(no log output yet)";
        if (text !== last) {
          const atBottom = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 30;
          wrap.textContent = text; last = text;
          if (atBottom) wrap.scrollTop = wrap.scrollHeight;
        }
        if ($("logMeta")) $("logMeta").textContent = "updated " + new Date().toLocaleTimeString();
      } catch (e) {
        wrap.textContent = (/offline|unreachable/i.test(e.message) ? "⚠️ " : "") + e.message;
      }
    }

    poll();
    wrapScrollInit();
    _logTimer = setInterval(poll, 2500);
    // The teardown, registered per open: closeModal() runs it, so the poller
    // can no longer outlive the modal.
    RT.onClose(stopLogs);
  }

  // Bots-row "Logs": open the renter's modal, then start the tail inside it.
  // detail.open() swallows its own failure (it toasts and returns), so we must
  // NOT assume the modal opened. It sets RT.state.CURRENT = id only after the
  // render succeeded, so that is the success signal. Without this gate a failed
  // open would still start the 2.5s poller: it would tail docker logs into a
  // hidden, stale modal body, and because no modal was opened there is no
  // closeModal() to run the RT.onClose(stopLogs) teardown that kills it.
  async function openLogs(id) {
    await RT.detail.open(id);
    if (RT.state.CURRENT === id) toggleLogs(id);
  }

  // ---- registration (no fetching at load) ----

  RT.reload.bots = loadRentBots;

  RT.on("botOp", (el, ds) => { botOp(ds.id, ds.op, el); });
  RT.on("botLogs", (el, ds) => { openLogs(ds.id); });
  RT.on("botManage", (el, ds) => { RT.detail.open(ds.id); });

  RT.bots = { toggleLogs: toggleLogs, openLogs: openLogs };
})();
