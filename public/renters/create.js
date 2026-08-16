/* create.js — hosts load, bot picker, "Add a renter" form.
 * Ported from public/renters.html lines 230-303 (minus hostSelectHtml 234-238,
 * which core.js owns). Registers only; boot.js drives the first paint.
 *
 * Owns:
 *   RT.reload.hosts      -> GET /bot-configs/hosts   -> RT.state.HOSTS
 *   RT.reload.botPicker  -> GET /renters/bots        -> RT.state.BOTS + #cBot
 *   RT.create.botOptionLabel(b)  (detail.js's assign-bot <select> reuses it)
 */
(function () {
  "use strict";

  const RT = window.RT;
  if (!RT) { console.error("renters/create.js: core.js must load first"); return; }

  const $ = (id) => RT.$(id);
  const esc = (s) => RT.esc(s);
  const api = (path, opts) => RT.api(path, opts);
  const toast = (m) => RT.toast(m);

  // ---- hosts picker (for provisioning a renter's own bot) ----
  // A failed hosts read must not break the page: core.js's hostSelectHtml()
  // falls back to a lone "Server" option when RT.state.HOSTS is empty.
  async function loadHosts() {
    try {
      const d = await api("/bot-configs/hosts");
      RT.state.HOSTS = d.hosts || [];
    } catch (e) {
      RT.state.HOSTS = [];
    }
  }

  // ---- bot picker (create form + assign-existing) ----
  function botOptionLabel(b) {
    const who = (b.renters || []).length
      ? " — shared with " + b.renters.join(", ")
      : " — free";
    return (b.hostLabel || b.host) + " · " + b.file + who;
  }

  function retryLink() {
    return '<a href="#" data-act="retryBotPicker">Retry</a>';
  }

  // Fill the Bot dropdown. Reading the hosts' config directories is remote
  // work that can take seconds (and fails outright when a host is off), so
  // the picker says which of the three states it is in rather than sitting
  // on "No bot yet" — that option is a real choice, and leaving it alone
  // while the list loaded made a working picker look like a broken one.
  async function loadBotPicker() {
    const sel = $("cBot"), note = $("cBotNote");
    if (sel) {
      sel.disabled = true;
      sel.innerHTML = '<option value="">Loading bots…</option>';
    }
    if (note) note.innerHTML = "";
    try {
      const d = await api("/renters/bots");
      RT.state.BOTS = d.bots || [];
      if (sel) {
        const hostsList = RT.state.HOSTS.length
          ? RT.state.HOSTS
          : [{ id: "local", label: "Server" }];
        sel.innerHTML = '<option value="">No bot yet</option>' +
          hostsList.map((h) => '<option value="new:' + esc(h.id) + '">➕ Create a new bot on ' + esc(h.label || h.id) + "</option>").join("") +
          RT.state.BOTS.map((b, i) => '<option value="' + i + '">' + esc(botOptionLabel(b)) + "</option>").join("");
        sel.disabled = false;
      }
      // A host we couldn't reach still has bots on it; say so instead of
      // presenting a short list as the whole fleet.
      const off = d.offlineHosts || [];
      if (note && off.length) {
        note.innerHTML = '<span class="tokwarn">⚠ ' +
          esc(off.map((h) => h.label || h.id).join(", ")) +
          " unreachable</span> — bots there aren’t listed. " + retryLink();
      }
    } catch (e) {
      if (sel) {
        sel.innerHTML = '<option value="">No bot yet</option>';
        sel.disabled = false;
      }
      if (note) {
        note.innerHTML = '<span class="tokwarn">Couldn’t load the bot list</span> — ' +
          esc(e.message) + ". " + retryLink();
      }
    }
  }

  // ---- create ----
  async function createRenter(btn) {
    const username = $("cU").value.trim(), password = $("cP").value;
    if (!username || !password) return toast("Username and password required");
    const botVal = $("cBot").value;
    const newHost = botVal.indexOf("new:") === 0 ? botVal.slice(4) : "";
    const pick = newHost ? null : (RT.state.BOTS[parseInt(botVal, 10)] || null);
    btn.disabled = true;
    try {
      const d = await api("/renters", {
        method: "POST",
        body: JSON.stringify({
          username, password,
          newBotHost: newHost,
          botHost: pick ? pick.host : "", botFile: pick ? pick.file : "",
          farmGames: $("cGames").value,
          maxAccounts: parseInt($("cMax").value, 10) || 0,
          accessStart: $("cStart").value || null, accessEnd: $("cEnd").value || null,
        }),
      });
      const botNote = d.renter.botFile
        ? "Bot: <b>" + esc(d.renter.botFile) + "</b>" + (newHost ? " (newly created)" : " (shared)") + "."
        : "Open <b>Manage → Create bot</b> to give them a bot.";
      $("cResult").innerHTML = '<div class="credbox">Renter <b>' + esc(d.renter.username) +
        "</b> created. " + botNote + " Share the login: <code>" +
        esc(location.origin) + "/renter-login.html</code> — username <code>" +
        esc(d.renter.username) + "</code>, and the password you set.</div>";
      $("cU").value = ""; $("cP").value = ""; $("cGames").value = ""; $("cBot").value = "";
      await RT.reloadMany(["renters", "botPicker", "bots"]);
    } catch (e) {
      toast(e.message);
    }
    btn.disabled = false;
  }

  // ---- registration only ----
  RT.reload.hosts = loadHosts;
  RT.reload.botPicker = loadBotPicker;

  RT.on("retryBotPicker", () => loadBotPicker());

  RT.create = { botOptionLabel };

  const cBtn = $("cBtn");
  if (cBtn) cBtn.addEventListener("click", () => createRenter(cBtn));
})();
