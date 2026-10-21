/* SOOP farm — the Twitch-logins import dialog. A SOOP login made through Twitch
   is signed back in automatically from that Twitch login's twitch.tv cookies
   (the cookie renewer). This dialog is where those cookie jars come in: the
   harvester's web-twitch-cookies.json, dropped on the dialog, chosen, or pasted
   — many logins at once. One request per login; a cookie is only ever POSTed,
   never shown or logged. Loaded by tab-accounts.js; entry point
   Soop._twitchLogins.open(). Mirrors account-import.js in shape. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const MAX_FILES = 200, MAX_FILE_BYTES = 8 * 1024 * 1024;   // one harvest of a few hundred logins is well under this
  const ROW = { padding: "6px 10px" };
  const plural = (n, word) => fmt.num(n) + " " + word + (n === 1 ? "" : "s");
  const put = (node, ...kids) => { node.textContent = ""; node.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return node; };
  const LOGIN_RE = /^[a-z0-9_]{2,25}$/;                       // same as utils/soop/twitchJar.js
  const isTwitch = (c) => c && typeof c === "object" && typeof c.name === "string" && c.value != null && /(^|\.)twitch\.tv$/i.test(String(c.domain || "").trim());

  /* Pure: the harvester's file (or a paste of it) in, one entry per Twitch login
     out. Shapes handled:
       1. { "<login>": { cookies:[…], soopId?, capturedAt?, source?, … }, … }
       2. [ { login|Login, cookies:[…], soopId?, … }, … ]
       3. one { cookies:[…], login?, soopId? }  (a single export)
     The login is taken from the key / the login|Login field, else from the jar's
     own `login` cookie. Entries with no twitch.tv cookie are dropped; the dialog
     says how many. -> [{ login, soopId, cookies, capturedAt, source }] */
  function parseTwitchFile(text) {
    let data;
    try { data = JSON.parse(String(text == null ? "" : text)); } catch { return []; }
    let pairs;
    if (Array.isArray(data)) pairs = data.map((v) => [null, v]);
    else if (data && typeof data === "object" && Array.isArray(data.cookies)) pairs = [[null, data]];
    else if (data && typeof data === "object") pairs = Object.entries(data);
    else return [];
    const out = [];
    for (const [key, v] of pairs) {
      if (!v || typeof v !== "object" || !Array.isArray(v.cookies)) continue;
      const cookies = v.cookies.filter(isTwitch);
      if (!cookies.length) continue;
      // The jar's own `login` cookie wins — it is what the server stores the jar
      // under and verifies a renewal against. The key / field is only a fallback.
      const own = (cookies.find((c) => c.name === "login") || {}).value;
      const login = String(own || key || v.login || v.Login || "").trim().toLowerCase();
      if (!LOGIN_RE.test(login)) continue;
      out.push({
        login,
        soopId: String(v.soopId || v.soopid || "").trim(),
        cookies,
        capturedAt: v.capturedAt || v.harvestedAt || null,
        source: v.source || "SOOP page import",
      });
    }
    // One login once; the last entry (freshest capture) wins.
    const byLogin = new Map();
    out.forEach((e) => byLogin.set(e.login, e));
    return [...byLogin.values()];
  }
  const jarHealth = (cookies) => {
    const names = new Set(cookies.map((c) => c.name));
    const p = cookies.find((c) => c.name === "persistent");
    const days = p && p.expirationDate ? Math.round((p.expirationDate * 1000 - Date.now()) / 864e5) : null;
    return { hasAuth: names.has("auth-token"), shortLived: !names.has("persistent"), days };
  };

  let dialog = null;
  function open() { return dialog || (dialog = build()); }

  function build() {
    let entries = [], jobs = [], running = false, stopped = false, alive = true;
    const area = el("textarea", { class: "s-textarea", style: { minHeight: "90px" }, spellcheck: "false", autocomplete: "off", "data-autofocus": true, placeholder: "Paste a web-twitch-cookies.json here", onInput: () => fromPaste() });
    const pasteNote = el("span", { class: "s-help", "aria-live": "polite" });
    const go = ui.button("Import", { tone: "primary", icon: "upload", disabled: true, onClick: start });
    const pick = el("input", { type: "file", multiple: true, accept: ".json,application/json", hidden: true, onChange: () => { fromFiles(pick.files); pick.value = ""; } });
    const drop = el("div", { class: "s-drop" }, ui.icon("upload", 22), el("b", "Drop web-twitch-cookies.json here"),
      el("div", { class: "s-row" }, ui.button("Choose files", { size: "sm", onClick: () => pick.click() })), pick);
    // The dialog's own drop zone (account-import.js owns the page-wide one, for SOOP account cookies — a second would clash).
    drop.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; drop.classList.add("is-over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("is-over"); if (e.dataTransfer) fromFiles(e.dataTransfer.files); });

    const tally = el("b", { role: "status" }), list = el("ul", { class: "s-list" });
    const listBox = el("div", { class: "s-stack is-tight", hidden: true },
      el("div", { class: "s-spread" }, tally, ui.button("Clear", { size: "sm", tone: "ghost", onClick: () => { entries = []; area.value = ""; draw(); } })),
      el("div", { class: "s-scroll" }, list));
    const form = el("div", { class: "s-stack" },
      el("div", { class: "s-note" }, ui.icon("info"), el("span", null, "These are the ", el("b", "Twitch"), " cookies that let the server sign a SOOP login back in by itself. Each login links to the SOOP account it was made for when the file names it; otherwise its jar is stored and you link it on the account (the ", el("b", "Twitch login"), " box in an account's panel).")),
      drop,
      el("label", { class: "s-field" }, "Or paste the file's contents", area, pasteNote),
      listBox,
      el("p", { class: "s-muted s-small", style: { margin: "0" } }, "Cookies are stored encrypted and never shown again. Nothing is sent until you press Import."));

    const bar = ui.progress(0, 1), status = el("span", { class: "s-small", role: "status" }), runList = el("ul", { class: "s-list" }), summary = el("div", { hidden: true });
    const runView = el("div", { class: "s-stack", hidden: true }, el("div", { class: "s-stack is-tight" }, status, bar), summary, el("div", { class: "s-scroll" }, runList));

    const m = Soop.modal({ title: "Twitch logins", size: "lg", sticky: true, body: el("div", null, form, runView),
      onClose: () => { alive = false; stopped = true; dialog = null; area.value = ""; entries = []; jobs = []; } });
    const formActions = () => m.setActions([ui.button("Cancel", { onClick: () => m.close() }), go]);

    // ---- gathering ----
    function merge(found, label) {
      if (!found.length) return 0;
      const have = new Map(entries.map((e) => [e.login, e]));
      found.forEach((e) => have.set(e.login, e));   // a repeat login refreshes to the newest jar
      entries = [...have.values()].sort((a, b) => a.login.localeCompare(b.login));
      draw();
      return found.length;
    }
    function fromPaste() {
      const found = parseTwitchFile(area.value);
      pasteNote.className = "s-help" + (area.value.trim() && !found.length ? " s-warn" : "");
      pasteNote.textContent = !area.value.trim() ? "" : !found.length ? "No Twitch login found in this paste yet." : plural(found.length, "login") + " found in the paste.";
      merge(found, "paste");
    }
    async function fromFiles(fileList) {
      const files = Array.prototype.slice.call(fileList || [], 0, MAX_FILES).filter((f) => f.size <= MAX_FILE_BYTES);
      if (!files.length) { Soop.toast("Those files were empty or too large to be a cookie export", "warn"); return; }
      let added = 0, bad = 0;
      for (const f of files) {
        let text = null;
        try { text = await f.text(); } catch { bad++; continue; }
        if (!alive) return;
        const found = parseTwitchFile(text);
        if (found.length) added += merge(found, f.name); else bad++;
      }
      if (added) Soop.toast(plural(added, "login") + " read from " + plural(files.length, "file"), "ok");
      else Soop.toast("No Twitch login was found in " + (bad === 1 ? "that file" : "those files"), "warn");
    }

    function entryRow(e) {
      const h = jarHealth(e.cookies), tone = !h.hasAuth ? "warn" : h.shortLived ? "warn" : "ok";
      const bits = [h.hasAuth ? (h.days != null ? "good for ~" + h.days + "d" : h.shortLived ? "short-lived" : "ok") : "no auth-token — signed out", e.soopId ? "links to " + e.soopId : "store only"];
      return el("li", { class: "s-list-item", style: ROW }, ui.dot(tone, h.hasAuth ? "Ready" : "Incomplete"),
        el("span", { class: "s-grow s-trunc", title: e.login + " — " + bits.join(" · ") }, el("b", e.login), el("span", { class: h.hasAuth ? "s-muted" : "s-warn" }, " — " + bits.join(" · "))),
        ui.button("", { size: "sm", tone: "ghost", icon: "x", title: "Remove " + e.login, onClick: () => { entries = entries.filter((x) => x !== e); draw(); } }));
    }
    function draw() {
      listBox.hidden = !entries.length;
      const incomplete = entries.filter((e) => !jarHealth(e.cookies).hasAuth).length, linkable = entries.filter((e) => e.soopId).length;
      tally.textContent = plural(entries.length, "login") + (linkable ? " · " + linkable + " link automatically" : "") + (incomplete ? " · " + incomplete + " signed out" : "");
      put(list, entries.map(entryRow));
      go.disabled = running || !entries.length;
      go.lastChild.nodeValue = entries.length ? "Import " + plural(entries.length, "login") : "Import";
    }
    function showForm() { runView.hidden = true; form.hidden = false; m.setTitle("Twitch logins"); draw(); formActions(); }

    // ---- the run: one request per login ----
    function line(label) {
      const li = el("li", { class: "s-list-item", style: ROW });
      li.set = (tone, say, textNode, cls) => put(li, ui.dot(tone, say), el("span", { class: "s-grow" }, el("b", label), el("span", { class: cls || "s-muted" }, " — " + textNode)));
      li.set(null, "Waiting", "waiting its turn");
      return li;
    }
    const LINK = {
      linked: ["s-ok", (r) => "linked to " + r.link.soopId],
      already: ["s-muted", (r) => "already linked" + (r.link.soopId ? " to " + r.link.soopId : "")],
      unlinked: ["s-muted", () => "stored — link it on the account"],
      no_account: ["s-warn", (r) => "stored, but " + r.link.soopId + " is not in the farm"],
      conflict: ["s-warn", (r) => "stored — " + r.link.soopId + " already renews through " + r.link.other],
      taken: ["s-warn", (r) => "stored — this login already renews " + r.link.other],
    };
    function start() {
      if (running) return;
      jobs = entries.map((e) => ({ label: e.login, body: { login: e.login, cookies: e.cookies, soopId: e.soopId || undefined, capturedAt: e.capturedAt || undefined, source: e.source } }));
      entries = []; area.value = "";              // from here the cookies live only in `jobs`, dropped once sent
      if (!jobs.length) return;
      running = true; stopped = false;
      put(runList); summary.hidden = true;
      form.hidden = true; runView.hidden = false;
      m.setTitle("Importing Twitch logins");
      m.setActions([ui.button("Stop", { icon: "stop", onClick: () => { stopped = true; } })]);
      run();
    }
    async function run() {
      const total = jobs.length, lines = jobs.map((j) => runList.appendChild(line(j.label)));
      let stored = 0, linked = 0, failed = 0, sent = 0;
      bar.set(0, total);
      for (let i = 0; i < total && !stopped; i++) {
        lines[i].set("info", "Importing", "importing…");
        if (!runList.matches(":hover")) lines[i].scrollIntoView({ block: "nearest" });
        status.textContent = "Importing " + (i + 1) + " of " + total + "…";
        let r = null, err = null;
        try { r = await Soop.api.post("/accounts/twitch-cookies/import", jobs[i].body); }
        catch (e) { err = e; if (e.status === 401 || e.status === 403) stopped = true; }
        jobs[i].body.cookies = [];                 // drop the jar as soon as it is sent
        if (err) { failed++; lines[i].set("error", "Failed", "failed: " + err.message, "s-error"); }
        else {
          stored++;
          const st = (r.link && r.link.state) || "unlinked", meta = LINK[st] || LINK.unlinked;
          if (st === "linked") linked++;
          const kept = r.saved ? (r.saved.replaced ? "cookie replaced" : "cookie stored") : "already stored";
          lines[i].set(st === "linked" ? "ok" : meta[0] === "s-warn" ? "warn" : "info", st === "linked" ? "Linked" : "Stored", kept + " · " + meta[1](r), meta[0]);
        }
        sent++; bar.set(sent, total);
      }
      jobs = [];
      await Soop.refresh();
      running = false;
      const left = total - sent;
      const text = (stored ? plural(stored, "login") + " stored" : "Nothing stored") + (linked ? ", " + linked + " linked" : "") + (failed ? ", " + failed + " failed" : "") + (left ? ", " + left + " not sent" : "") + ".";
      const unlinkedLeft = stored - linked;
      const advice = unlinkedLeft > 0 ? " " + (unlinkedLeft === stored && !linked ? (unlinkedLeft === 1 ? "Link it" : "Link them") : fmt.num(unlinkedLeft) + " still need linking") + " on the Accounts tab — open an account and set its Twitch login." : "";
      if (!alive) { Soop.toast("Import closed early: " + text, failed ? "warn" : "ok"); return; }
      for (let i = sent; i < total; i++) lines[i].set(null, "Not sent", "not sent — the import was stopped");
      status.textContent = left ? "Stopped." : "Finished.";
      summary.hidden = false; summary.className = "s-note " + (failed || left ? "is-warn" : unlinkedLeft > 0 ? "is-warn" : "is-ok");
      put(summary, ui.icon(failed || left || unlinkedLeft > 0 ? "alert" : "check"), el("span", null, el("b", text), advice));
      m.setTitle(left ? "Import stopped" : "Import finished");
      m.setActions([ui.button("Import more", { icon: "plus", onClick: () => { showForm(); area.focus(); } }), ui.button("Done", { tone: "primary", onClick: () => m.close() })]);
    }
    draw(); formActions();
    return {};
  }

  // parseTwitchFile is exported for tests/soopTwitchLoginsUi.test.js.
  Soop._twitchLogins = { open: () => { open(); }, parseTwitchFile };
})();
