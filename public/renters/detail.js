/* renters/detail.js — the renters list and the renter detail modal.
 *
 * Owns: the renters list rows, suspend/unsuspend, the whole detail modal
 * (renderModal), the stored-client-token lookup, manual account add,
 * add-from-pool, create/assign bot, save changes, password reset/show/copy
 * and delete renter.
 * Ported from public/renters.html lines 341-357, 461-472, 647-715, 716-815.
 *
 * Contract: public/renters/CONTRACT.md.
 *
 * renderModal() re-renders the modal WHOLESALE after every mutation, so no
 * control inside it may own a listener: every button is a data-act dispatched
 * by core.js's delegated listener on `document`, which keeps working across
 * re-renders for free. The one non-click control (the username field's token
 * lookup) is delegated from `document` for exactly the same reason.
 */
(function () {
  "use strict";

  const RT = window.RT;
  if (!RT) { console.error("renters/detail.js: core.js must load first"); return; }

  // Wrappers, not destructured references: a helper must never be called
  // detached from RT in case core.js implements one as a `this`-using method.
  const $ = (id) => RT.$(id);
  const esc = (v) => RT.esc(v);
  const api = (p, o) => RT.api(p, o);
  const toast = (m) => RT.toast(m);

  // Counts arrive as numbers, but they are still runtime values, so they go
  // through esc() too. String() first so esc() never sees a non-string.
  const num = (v) => esc(String(v == null ? "" : v));

  // Value of a modal field; "" when the modal isn't rendered.
  const val = (id) => { const el = $(id); return el ? el.value : ""; };
  const intVal = (id) => parseInt(val(id), 10) || 0;

  // <input type="date"> wants yyyy-mm-dd. toISOString() THROWS on an
  // unparseable date, which would take the whole modal down, so guard it.
  function dateVal(v) {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
  }

  // ---- renters list ----

  async function loadRenters() {
    try {
      const d = await api("/renters");
      const rs = d.renters || [];
      const blocked = rs.filter((r) => r.status === "suspended" || r.expired).length;
      RT.setMetric("Renters", rs.length, blocked ? blocked + " blocked or expired" : "All access active", blocked ? "warn" : "good");
      if (!rs.length) {
        $("renters").innerHTML = '<div class="muted" style="padding:6px 2px">No renters yet.</div>';
        return;
      }
      $("renters").innerHTML = rs.map((r) => {
        const id = esc(r.id);
        // The original esc()'d the whole thing, which HTML-escaped its own
        // "no bot" markup and printed the tags as visible text. Only the
        // runtime value needs escaping.
        const bot = r.botFile ? esc(r.botFile) : '<span class="muted">no bot</span>';
        return '<div class="row"><div><div class="nm">' + esc(r.username) + ' ' + RT.statusBadge(r) + '</div>' +
            '<div class="meta">' + bot + ' · ' + num(r.used) + '/' + num(r.maxAccounts) + ' accounts' +
              (r.pendingAccounts ? ' · ' + num(r.pendingAccounts) + ' pending' : '') + '</div></div>' +
          '<div class="meta">Access: ' + RT.fmtDate(r.accessStart) + ' → ' + RT.fmtDate(r.accessEnd) + '<br>' +
            esc(RT.remaining(r.accessEnd)) + '</div>' +
          '<div class="meta">Last in: ' + (r.lastLoginAt ? esc(new Date(r.lastLoginAt).toLocaleDateString()) : "never") + '</div>' +
          '<div class="acts"><button class="btn ghost sm" data-act="openRenter" data-id="' + id + '">Manage</button>' +
            (r.status === "suspended"
              ? '<button class="btn sm" data-act="setSusp" data-val="false" data-id="' + id + '">Unsuspend</button>'
              : '<button class="btn warn sm" data-act="setSusp" data-val="true" data-id="' + id + '">Suspend</button>') +
          '</div></div>';
      }).join("");
    } catch (e) {
      RT.setMetric("Renters", "—", "Unavailable", "alert");
      $("renters").innerHTML = '<div class="muted">' + esc(e.message) + '</div>';
    }
  }

  async function setSusp(id, suspend) {
    if (suspend && !confirm("Suspend this renter? Their access is blocked and their farming stops (a shared bot keeps running for the other renters).")) return;
    try {
      const d = await api("/renters/" + id + "/" + (suspend ? "suspend" : "unsuspend"), { method: "POST" });
      toast(suspend ? ("Suspended" + (d.botStopped ? " · bot stopped" : "")) : "Unsuspended");
      await RT.reloadMany(["renters", "bots"]);
      // Only refresh the modal when it is showing THIS renter: suspend is also
      // fired from the list rows, where no modal is open.
      if (RT.state.CURRENT === id) open(id);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---- renter detail modal ----

  // Resolves TRUE when the modal actually re-rendered, FALSE when it didn't.
  // The failure is still swallowed (toast + return) because most callers fire
  // and forget — but a caller that put a button into a busy state before a
  // mutation needs to know the re-render that would have reset that button
  // never happened. bots.js's separate `RT.state.CURRENT === id` success gate
  // is unaffected: CURRENT is still only ever set after a successful render.
  async function open(id) {
    try {
      const d = await api("/renters/" + id);
      renderModal(d.renter, d.submissions || [], d.bot || {}, d.accounts || []);
      RT.state.CURRENT = id;
      return true;
    } catch (e) {
      toast(e.message);
      return false;
    }
  }

  // Re-render whatever the modal is already showing (bots.js calls this after
  // start/stop/restart).
  function reopen() {
    const id = RT.state.CURRENT;
    return id ? open(id) : Promise.resolve();
  }

  // Cross-module reads, guarded so one missing module can't blank the modal
  // and take Save / Suspend / Delete down with it.
  function accountRows(accs) {
    return (RT.accounts && RT.accounts.rowsHtml)
      ? RT.accounts.rowsHtml(accs)
      : '<div class="muted">Accounts list unavailable.</div>';
  }
  function botOptionLabel(b) {
    return (RT.create && RT.create.botOptionLabel)
      ? RT.create.botOptionLabel(b)
      : (b.file || "");
  }

  function renderModal(r, subs, bot, accs) {
    // A wholesale re-render wipes #mUser/#mToken, so a pending lookup and its
    // "token already stored" verdict belong to a form that no longer exists.
    // Carrying tokenLookupFound over would let manualAdd() post an empty
    // token for a different username.
    cancelTokenLookup();
    cancelQuickFarmLookups();

    const id = esc(r.id);
    const assigned = !!(bot && bot.assigned);
    const bots = RT.state.BOTS || [];

    const botMeta = assigned
      ? esc((bot.hostLabel || "") + " · " + (bot.file || "") + " · " + (bot.accounts || 0) + " account(s)") +
        ((bot.sharedWith || []).length ? ' · <b>shared with ' + esc(bot.sharedWith.join(", ")) + '</b>' : '')
      : "no bot yet";

    const subsHtml = subs.length
      ? '<div class="rows">' + subs.map((s) =>
          '<div class="approve-item"><div><b>' + num(s.count) + '</b> account(s) · <span class="muted">' +
            esc(new Date(s.createdAt).toLocaleString()) + '</span>' +
            (s.status === "approved" ? ' · ' + num(s.added) + ' added' : '') +
            (s.status === "rejected" && s.rejectReason ? ' · ' + esc(s.rejectReason) : '') +
          '</div><span class="badge ' +
            (s.status === "approved" ? "active" : s.status === "rejected" ? "suspended" : "wait") +
          '">' + esc(s.status) + '</span></div>').join("") + '</div>'
      : '<div class="muted">No submissions.</div>';

    RT.openModal(
      '<div class="mh"><div><h2 style="font-size:18px">' + esc(r.username) + ' ' + RT.statusBadge(r) + '</h2>' +
        '<div class="sub">' + num(r.used) + '/' + num(r.maxAccounts) + ' accounts · ' + esc(RT.remaining(r.accessEnd)) + '</div></div>' +
        '<button class="btn ghost sm" data-act="closeModal">Close</button></div>' +
      '<div class="grid3" style="margin-top:6px">' +
        '<div><label class="fld">Account limit</label><input id="eMax" type="number" min="0" value="' + num(r.maxAccounts) + '"/></div>' +
        '<div><label class="fld">Display name</label><input id="eName" value="' + esc(r.displayName || "") + '"/></div>' +
        '<div><label class="fld">Games to farm <span class="muted">(armed on their accounts)</span></label><input id="eGames" placeholder="e.g. Rust, VALORANT" value="' + esc((r.farmGames || []).join(", ")) + '"/></div>' +
      '</div>' +
      '<div class="grid3" style="margin-top:12px">' +
        '<div><label class="fld">Access start</label><input id="eStart" type="date" value="' + esc(dateVal(r.accessStart)) + '"/></div>' +
        '<div><label class="fld">Access end</label><input id="eEnd" type="date" value="' + esc(dateVal(r.accessEnd)) + '"/></div>' +
        '<div style="display:flex;align-items:flex-end"><button class="btn" style="width:100%" data-act="saveRenter" data-id="' + id + '">Save changes</button></div>' +
      '</div>' +
      '<div class="credbox" style="margin-top:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">' +
        '<b>Bot</b> ' + RT.botStatusHtml(bot) +
        '<span class="muted">' + botMeta + '</span>' +
        (assigned
          ? '<span style="flex:1"></span>' +
            '<button class="btn sm" data-act="botOp" data-op="start" data-id="' + id + '">Start</button>' +
            '<button class="btn ghost sm" data-act="botOp" data-op="restart" data-id="' + id + '">Restart</button>' +
            '<button class="btn warn sm" data-act="botOp" data-op="stop" data-id="' + id + '">Stop</button>' +
            '<button class="btn ghost sm" id="logBtn" data-act="modalLogs" data-id="' + id + '">Logs</button>'
          : '<span style="flex:1"></span>' +
            '<span class="muted" style="font-size:12px">Host</span>' + RT.hostSelectHtml("eBotHost") +
            '<button class="btn sm" data-act="createRenterBot" data-id="' + id + '">Create stack</button>' +
            '<span class="muted" style="font-size:12px">or share</span>' +
            '<select id="eAssignBot" style="width:auto;min-width:150px"><option value="">rental stack…</option>' +
              // boot.js paints the renters list and the bot picker CONCURRENTLY
              // (deliberately), and the picker's host reads take seconds, so
              // RT.state.BOTS is routinely still empty when a modal is opened
              // early. An empty <select> reads as "there are no bots to share",
              // which is a different (and wrong) answer from "not known yet" —
              // so say which one it is, exactly as create.js does for #cBot.
              // Not selectable, so assignBot() can't be handed a bogus index.
              (bots.length
                ? bots.map((b, i) => '<option value="' + i + '"' +
                    ((Number(b.remaining) || 0) <= 0 ? " disabled" : "") + '>' +
                    esc(botOptionLabel(b)) + '</option>').join("")
                : '<option value="" disabled>Loading rental stacks…</option>') +
            '</select>' +
            '<button class="btn ghost sm" data-act="assignBot" data-id="' + id + '">Assign</button>') +
      '</div>' +
      '<div id="botLogBox"></div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">' +
        '<button class="btn ghost sm" data-act="resetPw" data-id="' + id + '">Reset password</button>' +
        (r.status === "suspended"
          ? '<button class="btn sm" data-act="setSusp" data-val="false" data-id="' + id + '">Unsuspend</button>'
          : '<button class="btn warn sm" data-act="setSusp" data-val="true" data-id="' + id + '">Suspend + stop bot</button>') +
        '<button class="btn danger sm" data-act="delRenter" data-id="' + id + '">Delete renter</button>' +
      '</div>' +
      '<div class="credbox" style="margin-top:12px">Login <code>' + esc(r.username) + '</code> &nbsp;·&nbsp; Password <code id="pwView">••••••••</code> ' +
        '<button class="btn ghost sm" style="margin-left:8px" data-act="showPw" data-id="' + id + '">Show</button> ' +
        '<button class="btn ghost sm" id="copyLoginBtn" data-act="copyLogin" data-id="' + id + '">Copy login</button></div>' +
      '<h2 style="font-size:14px;margin:18px 0 8px">Accounts <span class="muted" style="font-size:12px;font-weight:600">(' + num(accs.length) + ')</span></h2>' +
      accountRows(accs) +
      '<div class="credbox" style="margin-top:10px;border-color:color-mix(in srgb,var(--accent) 45%,var(--line))">' +
        '<div style="font-weight:700;font-size:13px">Quick farm</div>' +
        '<div class="grid3" style="margin-top:8px">' +
          '<div><label class="fld">Twitch username</label><input id="qUser" autocapitalize="none" spellcheck="false" autocomplete="off" placeholder="username"/><div id="qUserInfo" class="sub" style="margin-top:4px"></div></div>' +
          '<div><label class="fld">Game</label><input id="qGame" list="qGameOptions" autocomplete="off" placeholder="Type to search"/><datalist id="qGameOptions"></datalist><div id="qGameInfo" class="sub" style="margin-top:4px"></div></div>' +
          '<div><label class="fld">Farm for</label><select id="qDays">' +
            '<option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option><option value="60">60 days</option><option value="90">90 days</option>' +
          '</select></div>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:9px;flex-wrap:wrap"><button class="btn sm" id="qAddBtn" data-act="quickFarm" data-id="' + id + '">Start farming</button><span id="qFarmInfo" class="sub"></span></div>' +
      '</div>' +
      '<div class="credbox" style="margin-top:10px">' +
        '<div style="font-weight:700;font-size:13px">Add account manually</div>' +
        '<div class="sub" style="margin:4px 0 8px">If this Twitch account is already on any bot (yours or another renter\'s), it is moved off there onto this renter\'s bot automatically — it never farms in two places.</div>' +
        '<div class="grid3">' +
          '<div><label class="fld">Username</label><input id="mUser" autocomplete="off" placeholder="twitch login"/></div>' +
          '<div><label class="fld">Password <span class="muted">(optional)</span></label><input id="mPass" autocomplete="off" placeholder="stored for Creds reveal"/></div>' +
          '<div><label class="fld">Client token <span class="muted">(auto if stored)</span></label><input id="mToken" autocomplete="off" placeholder="ClientSecret"/><div id="mTokenInfo" class="sub" style="margin-top:4px"></div></div>' +
        '</div>' +
        '<div class="grid3" style="margin-top:8px">' +
          '<div><label class="fld">Farm for (days) <span class="muted">(optional)</span></label><input id="mDays" type="number" min="0" autocomplete="off" placeholder="e.g. 15 — blank = renter\'s lease"/></div>' +
          '<div></div><div></div>' +
        '</div>' +
        '<div style="margin-top:8px"><button class="btn sm" id="mAddBtn" data-act="manualAdd" data-id="' + id + '">Add account</button></div>' +
      '</div>' +
      '<div class="credbox" style="margin-top:10px">' +
        '<div style="font-weight:700;font-size:13px">Add from account pool</div>' +
        '<div class="sub" style="margin:4px 0 8px">Auto-pick fully-functional, unused accounts from your pool. Only pristine accounts auto-farm isn\'t using (not deployed, not sold/reserved, not listed, verified token) are eligible — so this never disturbs auto-farm.</div>' +
        '<div class="grid3">' +
          '<div><label class="fld">How many</label><input id="mPoolCount" type="number" min="1" value="1" autocomplete="off"/></div>' +
          '<div style="display:flex;align-items:flex-end"><button class="btn ghost sm" id="mPoolPreviewBtn" data-act="previewPool" data-id="' + id + '" style="width:100%">Preview</button></div>' +
          '<div style="display:flex;align-items:flex-end"><button class="btn sm" id="mPoolAddBtn" data-act="addFromPool" data-id="' + id + '" style="width:100%">Add from pool</button></div>' +
        '</div>' +
        '<div id="mPoolInfo" class="sub" style="margin-top:8px"></div>' +
      '</div>' +
      '<h2 style="font-size:14px;margin:18px 0 8px">Submissions</h2>' +
      subsHtml
    );

    // The username is handed to the button as data AFTER insertion, never
    // interpolated into JS source — this is the handler the original broke on
    // any login containing a quote or backslash (contract rule 3).
    const cl = $("copyLoginBtn");
    if (cl) cl.dataset.copy = r.username || "";

    // Per-open teardown: closeModal() runs it, so no lookup outlives the form.
    RT.onClose(cancelTokenLookup);
    RT.onClose(cancelQuickFarmLookups);
  }

  // ---- stored-token lookup (as the username is typed) ----
  // If the server already holds a client token for that login, the token field
  // can stay empty.

  let tokenLookupTimer = null;
  let tokenLookupFound = false;

  // Idempotent — registered with RT.onClose and also called on re-render.
  function cancelTokenLookup() {
    clearTimeout(tokenLookupTimer);
    tokenLookupTimer = null;
    tokenLookupFound = false;
  }

  function tokenLookup() {
    clearTimeout(tokenLookupTimer);
    tokenLookupFound = false;
    const info = $("mTokenInfo");
    if (info) info.textContent = "";
    const u = (val("mUser") || "").trim();
    if (u.length < 3) return;
    tokenLookupTimer = setTimeout(async () => {
      try {
        const d = await api("/renters/account-token?username=" + encodeURIComponent(u));
        // The field may have moved on (or the modal been re-rendered) while
        // the request was in flight; a stale verdict must not be shown.
        const cur = (val("mUser") || "").trim();
        if (cur !== u || !$("mTokenInfo")) return;
        tokenLookupFound = !!d.found;
        $("mTokenInfo").innerHTML = d.found
          ? '<span style="color:var(--ok,#3fb950)">✓ Client token already stored (' + esc(d.source) + ') — leave this empty, it is pulled automatically.</span>'
          : 'Not found on the server — paste the client token.';
      } catch (e) { /* lookup is best effort */ }
    }, 400);
  }

  // ---- Quick farm lookups ----

  let quickTokenTimer = null;
  let quickGameTimer = null;

  function cancelQuickFarmLookups() {
    clearTimeout(quickTokenTimer);
    clearTimeout(quickGameTimer);
    quickTokenTimer = null;
    quickGameTimer = null;
  }

  function quickTokenLookup() {
    clearTimeout(quickTokenTimer);
    const info = $("qUserInfo");
    if (info) info.textContent = "";
    const username = (val("qUser") || "").trim();
    if (username.length < 3) return;
    quickTokenTimer = setTimeout(async () => {
      try {
        const d = await api("/renters/account-token?username=" + encodeURIComponent(username));
        if ((val("qUser") || "").trim() !== username || !$("qUserInfo")) return;
        $("qUserInfo").innerHTML = d.found
          ? '<span style="color:var(--ok,#3fb950)">Client token found · ' + esc(d.source) + '</span>'
          : '<span style="color:#c0392b">No stored client token</span>';
      } catch (e) { /* lookup is best effort; submit performs the authoritative check */ }
    }, 350);
  }

  function quickGameLookup() {
    clearTimeout(quickGameTimer);
    const options = $("qGameOptions");
    const info = $("qGameInfo");
    if (options) options.innerHTML = "";
    if (info) info.textContent = "";
    const query = (val("qGame") || "").trim();
    if (query.length < 2) return;
    quickGameTimer = setTimeout(async () => {
      try {
        const d = await api("/renters/game-search?q=" + encodeURIComponent(query));
        if ((val("qGame") || "").trim() !== query || !$("qGameOptions")) return;
        const games = Array.isArray(d.games) ? d.games.slice(0, 20) : [];
        $("qGameOptions").innerHTML = games.map((game) => '<option value="' + esc(game) + '"></option>').join("");
        if ($("qGameInfo")) $("qGameInfo").textContent = games.length ? games.length + " matches" : "No matches";
      } catch (e) { /* typed values remain valid even if suggestions are unavailable */ }
    }, 300);
  }

  async function quickFarm(id) {
    const username = (val("qUser") || "").trim();
    const game = (val("qGame") || "").trim();
    const farmDays = intVal("qDays");
    if (!username) { toast("Username is required"); return; }
    if (!game) { toast("Choose a game"); return; }
    if (farmDays <= 0) { toast("Choose a farming duration"); return; }
    const btn = $("qAddBtn");
    const info = $("qFarmInfo");
    if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
    if (info) info.textContent = "Finding an available rental bot…";
    try {
      const d = await api("/renters/" + id + "/accounts/manual", {
        method: "POST",
        body: JSON.stringify({
          username,
          quick: true,
          autoAssign: true,
          games: [game],
          farmDays,
        }),
      });
      toast(d.note || "Farming started");
      await RT.reloadMany(["renters", "bots"]);
      const ok = await open(id);
      if (!ok && btn) { btn.disabled = false; btn.textContent = "Start farming"; }
    } catch (e) {
      toast(e.message);
      if (info) info.textContent = e.message;
      if (btn) { btn.disabled = false; btn.textContent = "Start farming"; }
    }
  }

  // ---- manual add ----

  async function manualAdd(id) {
    const username = (val("mUser") || "").trim();
    const password = val("mPass") || "";
    const token = (val("mToken") || "").trim();
    if (!username) { toast("Username is required"); return; }
    if (!token && !tokenLookupFound) {
      toast("Client token is required (none stored on the server for that username)");
      return;
    }
    const btn = $("mAddBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
    try {
      const d = await api("/renters/" + id + "/accounts/manual", {
        method: "POST",
        body: JSON.stringify({ username, password, token, farmDays: intVal("mDays") }),
      });
      toast(d.note || "Account added");
      await RT.reloadMany(["renters", "bots"]);
      // Re-renders the modal, which also resets the form and the button — but
      // only if it succeeds. When the refresh fails the old modal (and this
      // button) is still on screen, so undo the busy state by hand or "Adding…"
      // stays stuck forever on an add that already went through.
      const ok = await open(id);
      if (!ok && btn) { btn.disabled = false; btn.textContent = "Add account"; }
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Add account"; }
    }
  }

  // ---- add-from-pool: preview what would be taken, then commit ----

  async function previewPool(id) {
    const count = intVal("mPoolCount");
    const info = $("mPoolInfo");
    const btn = $("mPoolPreviewBtn");
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      const d = await api("/renters/" + id + "/accounts/from-pool/preview?count=" + encodeURIComponent(count));
      const names = (d.preview || []).map((a) => esc(a.username)).join(", ");
      if (info) {
        info.innerHTML = 'Will add <b>' + num(d.willAdd) + '</b> of ' + num(count) + ' requested · ' +
          num(d.eligibleTotal) + ' eligible in pool · ' + num(d.quotaRemaining) + ' quota left' +
          (names ? '<div style="margin-top:4px">' + names + '</div>' : '') +
          (!d.botAssigned ? '<div style="margin-top:4px;color:#c0392b">No bot assigned yet — create one first.</div>' : '');
      }
    } catch (e) {
      if (info) info.textContent = e.message;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Preview"; }
    }
  }

  async function addFromPool(id) {
    const count = intVal("mPoolCount");
    if (!(count > 0)) { toast("Enter how many to add"); return; }
    if (!confirm("Auto-pick up to " + count + " pristine pool account(s) and add them to this renter?")) return;
    const btn = $("mPoolAddBtn");
    if (btn) { btn.disabled = true; btn.textContent = "Adding…"; }
    try {
      const d = await api("/renters/" + id + "/accounts/from-pool", {
        method: "POST",
        body: JSON.stringify({ count }),
      });
      toast(d.message || ("Added " + d.added + " account(s)"));
      if (d.skipped && d.skipped.length) {
        toast(d.skipped.length + " skipped: " +
          d.skipped.map((s) => esc(s.username) + " (" + esc(s.reason) + ")").join("; "));
      }
      await RT.reloadMany(["renters", "bots"]);
      // Same as manualAdd: a failed refresh leaves this button on screen, so
      // its busy state has to be undone here.
      const ok = await open(id);
      if (!ok && btn) { btn.disabled = false; btn.textContent = "Add from pool"; }
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Add from pool"; }
    }
  }

  // ---- bot: create / assign ----

  async function createRenterBot(id) {
    const host = val("eBotHost") || "local";
    if (!confirm("Create a dedicated rental stack for this renter on " + host + "? It is isolated from normal bots and starts once accounts are approved.")) return;
    try {
      await api("/renters/" + id + "/create-bot", { method: "POST", body: JSON.stringify({ host }) });
      toast("Rental stack created");
      await RT.reloadMany(["renters", "bots"]);
      open(id);
    } catch (e) {
      toast(e.message);
    }
  }

  async function assignBot(id) {
    const pick = (RT.state.BOTS || [])[parseInt(val("eAssignBot"), 10)];
    if (!pick) { toast("Pick a rental stack to assign"); return; }
    const who = (pick.renters || []).length ? " It is shared with " + pick.renters.join(", ") + "." : "";
    if (!confirm("Assign rental stack " + pick.file + " on " + (pick.hostLabel || pick.host) + " to this renter?" + who)) return;
    try {
      await api("/renters/" + id, {
        method: "PUT",
        body: JSON.stringify({ botHost: pick.host, botFile: pick.file }),
      });
      toast("Rental stack assigned");
      await RT.reloadMany(["renters", "bots", "botPicker"]);
      open(id);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---- save / password / delete ----

  async function saveRenter(id) {
    try {
      const d = await api("/renters/" + id, {
        method: "PUT",
        body: JSON.stringify({
          maxAccounts: intVal("eMax"),
          displayName: val("eName"),
          farmGames: val("eGames"),
          accessStart: val("eStart") || null,
          accessEnd: val("eEnd") || null,
        }),
      });
      toast(d.gamesApplied ? "Saved — games armed on their accounts" : "Saved");
      await RT.reloadMany(["renters"]);
      open(id);
    } catch (e) {
      toast(e.message);
    }
  }

  async function resetPw(id) {
    const password = prompt("New password (min 8 chars):");
    if (!password) return;
    try {
      await api("/renters/" + id + "/password", { method: "POST", body: JSON.stringify({ password }) });
      toast("Password reset");
      // textContent, so the new password is never parsed as markup.
      const el = $("pwView");
      if (el) el.textContent = password;
    } catch (e) {
      toast(e.message);
    }
  }

  async function showPw(id) {
    try {
      const d = await api("/renters/" + id + "/password");
      const el = $("pwView");
      if (el) el.textContent = d.password ? d.password : "(not set — reset it to view)";
    } catch (e) {
      toast(e.message);
    }
  }

  // The username comes from the button's dataset (assigned in renderModal),
  // the password straight from the API — neither ever touches JS source.
  // Kept off RT.copy() to preserve the original's "Login copied" toast.
  async function copyLogin(username, id) {
    try {
      const d = await api("/renters/" + id + "/password");
      const line = username + (d.password ? ":" + d.password : "");
      await navigator.clipboard.writeText(line);
      toast("Login copied");
    } catch (e) {
      toast(e.message);
    }
  }

  async function delRenter(id) {
    if (!confirm("Delete this renter? Their accounts and drops inventory are removed; the bot config file is left on the host.")) return;
    try {
      await api("/renters/" + id, { method: "DELETE" });
      toast("Deleted");
      RT.closeModal();
      await RT.reloadMany(["renters", "bots"]);
    } catch (e) {
      toast(e.message);
    }
  }

  // ---- registration (no fetching at load) ----

  RT.reload.renters = loadRenters;

  RT.on("openRenter", (el, ds) => { open(ds.id); });
  RT.on("setSusp", (el, ds) => { setSusp(ds.id, ds.val === "true"); });
  RT.on("saveRenter", (el, ds) => { saveRenter(ds.id); });
  RT.on("createRenterBot", (el, ds) => { createRenterBot(ds.id); });
  RT.on("assignBot", (el, ds) => { assignBot(ds.id); });
  RT.on("quickFarm", (el, ds) => { quickFarm(ds.id); });
  RT.on("manualAdd", (el, ds) => { manualAdd(ds.id); });
  RT.on("previewPool", (el, ds) => { previewPool(ds.id); });
  RT.on("addFromPool", (el, ds) => { addFromPool(ds.id); });
  RT.on("resetPw", (el, ds) => { resetPw(ds.id); });
  RT.on("showPw", (el, ds) => { showPw(ds.id); });
  RT.on("copyLogin", (el, ds) => { copyLogin(ds.copy || "", ds.id); });
  RT.on("delRenter", (el, ds) => { delRenter(ds.id); });
  // The modal's own Logs button tails into #botLogBox in place; the bots-row
  // one has to open the modal first, which is bots.js's openLogs.
  RT.on("modalLogs", (el, ds) => { if (RT.bots && RT.bots.toggleLogs) RT.bots.toggleLogs(ds.id); });

  // Delegated so it survives the modal being re-rendered wholesale — the same
  // reason every button here is a data-act.
  document.addEventListener("input", (e) => {
    if (e.target && e.target.id === "mUser") tokenLookup();
    if (e.target && e.target.id === "qUser") quickTokenLookup();
    if (e.target && e.target.id === "qGame") quickGameLookup();
  });

  RT.detail = { open: open, reopen: reopen };
})();
