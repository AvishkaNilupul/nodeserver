/* SOOP farm — the account import dialog (contract §17). Loaded by
   tab-accounts.js at start-up; its entry point is Soop._accountImport.open().
   Accounts arrive as cookie files — dropped anywhere on the page or chosen, many
   at once or a whole folder — and as pasted text, and everything goes in one
   run: one request and one result line per account. A cookie is only ever
   POSTed; it is never shown or logged, and it is forgotten once it is sent. */
(function () {
  "use strict";
  const { el, ui, fmt } = Soop;
  const MAX_FILES = 500, MAX_DEPTH = 4;          // one drop: this many files, this many folders deep
  const MAX_FILE_BYTES = 1024 * 1024;            // an export is a few KB; a file this big is something else
  const MAX_BODY = 98000;                        // the server takes about 100 KB of JSON per request
  const STALE_MS = 3 * 864e5;                    // where the Accounts table starts calling a cookie old
  const SAME = "Already in the list", ROW = { padding: "6px 10px" };

  /* Splitter — pure: pasted or file text in, one string per account out, in
     order. The result is only ever POSTed; it is never shown and never logged.
     Mirrors splitCookieExports in utils/soopClient.js. Cases:
       1. one Cookie-Editor export             [ {..}, {..} ]              -> [that text]
       2. JSON arrays back to back             [..][..]  or  [..],[..]     -> one per array
       3. JSON arrays split by blank lines     [..]\n\n[..]                -> one per array
       4. one "AuthTicket=…" per line                                      -> one per line
          (other name=value lines join the ticket above them, or the first one)
       5. a mix of 2–4; a bracket inside a JSON string or in the middle of a
          cookie-header line never starts an export
       6. nothing recognisable -> [whole text] (the server says why); blank -> [] */
  function splitCookiePaste(text) {
    const t = String(text == null ? "" : text).trim();
    if (!t) return [];
    const TICKET = /(^|[;\s])AuthTicket\s*=/;
    const jsonEnd = (start) => {                 // index just past the JSON value opening at `start`
      let depth = 0, inStr = false;
      for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (inStr) { if (c === "\\") i++; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if (c === "[" || c === "{") depth++;
        else if ((c === "]" || c === "}") && --depth === 0) return i + 1;
      }
      return t.length;
    };
    const loose = (chunk) => {                   // header lines between JSON exports
      const groups = [], lead = [];
      chunk.split(/\r?\n/).map((s) => s.trim()).forEach((line) => {
        if (TICKET.test(line)) groups.push(lead.splice(0).concat(line));
        else if (line.includes("=")) (groups[groups.length - 1] || lead).push(line);
      });
      return groups.map((g) => g.join("\n"));
    };
    const out = [];
    let from = 0, i = 0, lineStart = 0;
    while (i < t.length) {
      const c = t[i];
      if (c === "\n") lineStart = i + 1;
      if ((c === "[" || c === "{") && /^[\s,]*$/.test(t.slice(Math.max(from, lineStart), i))) {
        const end = jsonEnd(i);
        out.push(...loose(t.slice(from, i)), t.slice(i, end));
        from = i = end;
      } else i++;
    }
    out.push(...loose(t.slice(from)));
    return out.length ? out : [t];
  }

  const hasTicket = (s) => s.includes("AuthTicket");
  const plural = (n, word) => fmt.num(n) + " " + word + (n === 1 ? "" : "s");
  const put = (node, ...kids) => { node.textContent = ""; node.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return node; };
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.path.localeCompare(b.path);
  // A file's age is measured on this computer's clock and shown on the page's (the server's).
  const savedAgo = (at) => fmt.ago(new Date((Soop.state ? Date.parse(Soop.state.now) : Date.now()) - Math.max(0, Date.now() - at)));
  // .DS_Store, ._name and the like ride along with a folder; they are not listed at all.
  const hiddenPath = (path) => path.split("/").some((seg) => seg.charAt(0) === "." || seg === "__MACOSX");

  /* What one file brings — pure. `f` is { path, size, at, text } (text null: it
     was not read); `have` holds the exports already listed and gains this
     file's. -> { name, path, at, parts, skip }: `parts` are the exports worth
     sending, one per account, and `skip` says why there are none. */
  function planFile(f, have) {
    const src = { name: f.path.split("/").pop(), path: f.path, at: f.at || 0, parts: [], skip: null };
    if (f.text == null) { src.skip = f.size > MAX_FILE_BYTES ? "Too large to be a cookie export" : "Could not be read"; return src; }
    const found = splitCookiePaste(f.text).filter(hasTicket);
    found.forEach((p) => { if (!have.has(p)) { have.add(p); src.parts.push(p); } });
    if (!src.parts.length) src.skip = found.length ? SAME : "No AuthTicket cookie in it";
    return src;
  }

  // ---- reading what was dropped or chosen -------------------------------------
  const fromInput = (input) => Array.prototype.map.call(input.files || [], (file) => ({ file, path: file.webkitRelativePath || file.name }));
  const listDir = (dir) => new Promise((resolve) => {      // a folder is listed in batches (100 at a time in Chrome)
    const reader = dir.createReader(), all = [];
    (function more() { reader.readEntries((batch) => { if (batch.length) { all.push(...batch); more(); } else resolve(all); }, () => resolve(all)); })();
  });
  async function walk(entry, depth, out) {
    const path = String(entry.fullPath || entry.name || "").replace(/^\/+/, "");
    if (hiddenPath(path)) return;
    if (out.length >= MAX_FILES) { out.more = true; return; }
    if (entry.isFile) { const file = await new Promise((resolve) => entry.file(resolve, () => resolve(null))); if (file) out.push({ file, path }); }
    else if (entry.isDirectory && depth < MAX_DEPTH) for (const child of await listDir(entry)) await walk(child, depth + 1, out);
  }
  // Files and folders of one drop -> [{ file, path }]. The entries are taken at
  // once: the browser empties a DataTransfer when its drop handler returns.
  function fromDrop(dt) {
    const roots = [], out = [], plain = (file) => ({ isFile: true, fullPath: file.name, file: (done) => done(file) });
    Array.prototype.forEach.call(dt.items || [], (it) => {
      if (it.kind !== "file") return;
      const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null, file = entry ? null : it.getAsFile();
      if (entry) roots.push(entry); else if (file) roots.push(plain(file));
    });
    if (!roots.length) Array.prototype.forEach.call(dt.files || [], (file) => roots.push(plain(file)));
    return roots.reduce((p, r) => p.then(() => walk(r, 0, out)), Promise.resolve()).then(() => out);
  }
  const readOne = ({ file, path }) => (file.size > MAX_FILE_BYTES ? Promise.resolve(null) : file.text().catch(() => null))
    .then((text) => ({ path, size: file.size, at: file.lastModified || 0, text }));

  // ---- the dialog ---------------------------------------------------------------
  let dialog = null;                             // the one open dialog: { add(listing), busy() }
  function open() { return dialog || (dialog = build()); }

  function build() {
    let sources = [], jobs = [], reading = 0, running = false, stopped = false, alive = true;
    const area = el("textarea", { class: "s-textarea", style: { minHeight: "110px" }, spellcheck: "false", autocomplete: "off", autocapitalize: "off", "data-autofocus": true,
      placeholder: "Paste here", onInput: recount });
    const found = el("span", { class: "s-help", "aria-live": "polite" });
    const go = ui.button("Import", { tone: "primary", icon: "upload", disabled: true, onClick: start });
    const chosen = (input) => { add(fromInput(input)); input.value = ""; };
    const pick = el("input", { type: "file", multiple: true, accept: ".json,.txt,application/json,text/plain", hidden: true, onChange: () => chosen(pick) });
    const pickDir = el("input", { type: "file", webkitdirectory: true, hidden: true, onChange: () => chosen(pickDir) });
    const folders = "webkitdirectory" in pickDir;
    const tally = el("b", { role: "status" }), oldNote = el("div", { class: "s-note is-warn", style: { flexWrap: "wrap" }, hidden: true }), files = el("ul", { class: "s-list" });
    const fileBox = el("div", { class: "s-stack is-tight", hidden: true },
      el("div", { class: "s-spread" }, tally, ui.button("Remove all", { size: "sm", tone: "ghost", onClick: () => { sources = []; draw(); } })), oldNote, el("div", { class: "s-scroll" }, files));
    const form = el("div", { class: "s-stack" },
      el("div", { class: "s-note" }, ui.icon("info"), el("span", null, "Sign in to sooplive.com, open the Cookie-Editor extension there and press Export. Save each export as a file and drop the files here, or paste the exports below — as many accounts as you like in one go. Every export must contain the ", el("b", "AuthTicket"), " cookie; one made while signed out is rejected.")),
      el("div", { class: "s-drop" }, ui.icon("upload", 22), el("b", "Drop cookie files" + (folders ? " or a folder" : "") + " anywhere on this page"),
        el("div", { class: "s-row" }, ui.button("Choose files", { size: "sm", onClick: () => pick.click() }), folders ? ui.button("Choose a folder", { size: "sm", onClick: () => pickDir.click() }) : null), pick, pickDir),
      fileBox,
      el("label", { class: "s-field" }, "Or paste one or many Cookie-Editor exports", area, found),
      el("p", { class: "s-muted s-small", style: { margin: "0" } }, "Cookies are stored encrypted and are never shown again. SOOP logins have died within about 2 days, so expect to re-import now and then."));
    const bar = ui.progress(0, 1), status = el("span", { class: "s-small", role: "status" }), list = el("ul", { class: "s-list" }), summary = el("div", { hidden: true });
    const runView = el("div", { class: "s-stack", hidden: true }, el("div", { class: "s-stack is-tight" }, status, bar), summary, el("div", { class: "s-scroll" }, list));
    const m = Soop.modal({ title: "Import accounts", size: "lg", sticky: true, body: el("div", null, form, runView),
      onClose: () => { alive = false; stopped = true; dialog = null; area.value = ""; sources = []; jobs = []; } });
    const formActions = () => m.setActions([ui.button("Cancel", { onClick: () => m.close() }), go]);
    const accountsIn = (srcs) => srcs.reduce((n, s) => n + s.parts.length, 0);

    // ---- the form: files and paste ----
    function recount() {
      const p = splitCookiePaste(area.value), good = p.filter(hasTicket).length, bad = p.length - good, fromFiles = accountsIn(sources);
      go.disabled = reading > 0 || !(good + fromFiles);
      go.lastChild.nodeValue = go.disabled ? "Import" : "Import " + plural(p.length + fromFiles, "account");
      found.className = "s-help" + (p.length && bad ? " s-warn" : "");
      found.textContent = !p.length ? "Nothing pasted yet." : !good ? "No account found in this paste yet — an export must contain AuthTicket."
        : plural(p.length, "account") + " detected" + (bad ? " — " + bad + (bad === 1 ? " has" : " have") + " no AuthTicket and will be rejected." : ".");
    }
    function fileRow(s, now) {
      const old = !s.skip && s.at > 0 && now - s.at > STALE_MS;
      const text = s.skip ? s.skip + " — skipped" : plural(s.parts.length, "account") + (s.at ? " · saved " + savedAgo(s.at) : "") + (old ? " — probably expired" : "");
      return el("li", { class: "s-list-item", style: ROW }, ui.dot(s.skip || old ? "warn" : "ok", s.skip ? "Skipped" : old ? "Old" : "Ready"),
        el("span", { class: "s-grow s-trunc", title: s.path + " — " + text }, el("b", s.name), el("span", { class: s.skip || old ? "s-warn" : "s-muted" }, " — " + text)),
        ui.button("", { size: "sm", tone: "ghost", icon: "x", title: "Remove " + s.name, onClick: () => { sources = sources.filter((x) => x !== s); draw(); } }));
    }
    function draw() {
      const now = Date.now(), good = sources.filter((s) => !s.skip), old = good.filter((s) => s.at > 0 && now - s.at > STALE_MS), skipped = sources.length - good.length;
      fileBox.hidden = !sources.length && !reading;
      tally.textContent = reading ? "Reading the files…" : plural(sources.length, "file") + " · " + plural(accountsIn(good), "account") + " to import" + (skipped ? " · " + fmt.num(skipped) + " skipped" : "");
      oldNote.hidden = !old.length;
      if (old.length) put(oldNote, ui.icon("alert"), el("span", { style: { flex: "1 1 240px" } }, (old.length === 1 ? "One file was" : fmt.num(old.length) + " files were") + " saved more than 3 days ago. SOOP logins have died within about 2 days, so " + (old.length === 1 ? "its cookie has" : "their cookies have") + " probably expired — and importing one replaces the cookie that account has now."),
        ui.button(old.length === 1 ? "Remove the old file" : "Remove the " + fmt.num(old.length) + " old files", { size: "sm", onClick: () => { sources = sources.filter((s) => old.indexOf(s) === -1); draw(); } }));
      put(files, sources.map((s) => fileRow(s, now)));
      recount();
    }
    // Files, or a promise of them, as [{ file, path }]. Read at once; nothing is sent before Import is pressed.
    async function add(listing) {
      if (form.hidden) showForm();
      reading++; draw();
      let read = [], more = false;
      try {
        const raw = await listing, shown = raw.filter((x) => !hiddenPath(x.path));
        more = !!raw.more || shown.length > MAX_FILES;
        read = await Promise.all(shown.slice(0, MAX_FILES).map(readOne));
      } catch (e) { Soop.toast("Those files could not be read — try choosing them instead", "error"); }
      reading--;
      if (!alive) return;
      const have = new Set(), fresh = [];
      sources.forEach((s) => s.parts.forEach((p) => have.add(p)));
      read.forEach((f) => {                      // a file dropped twice is listed once, whether or not it holds an account
        const s = planFile(f, have);
        if (s.skip !== SAME && !(s.skip && sources.concat(fresh).some((x) => x.skip && x.path === s.path))) fresh.push(s);
      });
      sources = sources.concat(fresh).sort(byName);
      const same = read.length - fresh.length;
      if (same) Soop.toast(plural(same, "file") + (same === 1 ? " is" : " are") + " already in the list", "info");
      if (more) Soop.toast("Only the first " + MAX_FILES + " files were read — import the rest in a second run", "warn");
      else if (!read.length) Soop.toast("There was no file to read in that", "warn");
      draw();
    }
    function showForm() { runView.hidden = true; form.hidden = false; m.setTitle("Import accounts"); draw(); formActions(); }

    // ---- the run: one request per account ----
    function line(label) {
      const li = el("li", { class: "s-list-item", style: ROW });
      li.set = (tone, say, text, cls) => put(li, ui.dot(tone, say), el("span", { class: "s-grow" }, el("b", label), el("span", { class: cls || "s-muted" }, " — " + text)));
      li.set(null, "Waiting", "waiting its turn");
      return li;
    }
    function start() {
      if (running || reading) return;
      jobs = [];
      sources.forEach((s) => s.parts.forEach((text, i) => jobs.push({ label: s.name + (s.parts.length > 1 ? " (" + (i + 1) + ")" : ""), text })));
      splitCookiePaste(area.value).forEach((text, i) => jobs.push({ label: "Pasted export " + (i + 1), text }));
      area.value = ""; sources = []; draw();     // from here the cookies exist only in `jobs`, and each is dropped once sent
      if (!jobs.length) return;
      running = true; stopped = false;
      put(list); summary.hidden = true;
      form.hidden = true; runView.hidden = false;
      m.setTitle("Importing accounts");
      m.setActions([ui.button("Stop", { icon: "stop", onClick: () => { stopped = true; } })]);
      run();
    }
    async function run() {
      const total = jobs.length, lines = jobs.map((j) => list.appendChild(line(j.label))), imported = [];
      let ok = 0, failed = 0, sent = 0;
      bar.set(0, total);
      for (let i = 0; i < total && !stopped; i++) {
        const label = jobs[i].label, body = { cookies: jobs[i].text };
        lines[i].set("info", "Importing", "importing…");
        if (!list.matches(":hover")) lines[i].scrollIntoView({ block: "nearest" });      // follow the run, unless the list is being read
        status.textContent = "Importing " + (i + 1) + " of " + total + "…";
        let res;
        if (JSON.stringify(body).length > MAX_BODY) res = [{ ok: false, error: "This export is too large to send — it should hold one account's sooplive.com cookies only" }];
        else try { res = (await Soop.api.post("/accounts/import", body)).results || []; }
        catch (e) { res = [{ ok: false, error: e.message }]; if (e.status === 401 || e.status === 403) stopped = true; }
        body.cookies = ""; if (jobs[i]) jobs[i].text = "";
        if (!res.length) res = [{ ok: false, error: "The server found no account in this export" }];
        res.forEach((r, n) => {
          const li = n ? list.insertBefore(line(label), lines[i].nextSibling) : lines[i];
          if (r.ok) { ok++; imported.push({ li, r }); li.set("ok", "Imported", ["Imported " + r.id, r.nick, r.country ? "seen from " + r.country : null].filter(Boolean).join(" · "), "s-ok"); }
          else { failed++; li.set("error", "Failed", "Failed: " + (r.error || "The server gave no reason"), "s-error"); }
        });
        sent++; bar.set(sent, total);
      }
      jobs = [];
      await Soop.refresh();                      // this one may be a poll that left before the last import had finished
      const fresh = await Soop.refresh();
      running = false;
      let refused = 0;
      if (fresh) imported.forEach(({ li, r }) => {          // what the login check made of each new cookie
        const a = Soop.accountById(r.id), why = a && !a.sold && (a.status === "drops_rejected" ? "the drops site refuses this login" : a.status === "not_logged_in" ? "SOOP now says it is logged out" : "");
        if (why) { refused++; li.set("warn", "Cannot farm", "Imported " + r.id + ", but " + why + " — export its cookie again while signed in", "s-warn"); }
      });
      const left = total - sent, text = (ok ? plural(ok, "account") + " imported" : "No account was imported") + (failed ? ", " + failed + " failed" : "") + (left ? ", " + left + " not sent" : "") + ".";
      const advice = (refused ? " " + (refused === ok ? (ok === 1 ? "It cannot" : "None of them can") : fmt.num(refused) + " of them cannot") + " farm yet." : "")
        + (failed || refused ? " Export the ones marked below again while signed in to sooplive.com, then import them here." : "");
      if (!alive) { Soop.toast("Import closed early: " + text + advice, ok && !failed && !refused ? "ok" : "warn"); return; }
      for (let i = sent; i < total; i++) lines[i].set(null, "Not sent", "not sent — the import was stopped");
      status.textContent = left ? "Stopped." : "Finished.";
      summary.hidden = false; summary.className = "s-note " + (failed || left || refused ? (ok > refused ? "is-warn" : "is-error") : "is-ok");
      put(summary, ui.icon(failed || left || refused ? "alert" : "check"), el("span", null, el("b", text), advice));
      m.setTitle(left ? "Import stopped" : "Import finished");
      m.setActions([ui.button("Import more", { icon: "plus", onClick: () => { showForm(); area.focus(); } }), ui.button("Done", { tone: "primary", onClick: () => m.close() })]);
    }
    draw(); formActions();
    return { add, busy: () => running };
  }

  // ---- dropping files anywhere on the page --------------------------------------
  // The veil covers the page while files are dragged over the window, so a drop
  // cannot miss and make the browser open the file (and show its cookies) instead.
  let veil = null, veilTimer = 0, own = false;   // own: the drag began on this page (an image, a link) — not a file being brought in
  const dragsFiles = (e) => !own && !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1;
  function showVeil(on) {
    clearTimeout(veilTimer);
    if (!veil && on) veil = document.body.appendChild(el("div", { class: "s-dropveil", hidden: true, onClick: () => showVeil(false), onDragleave: () => showVeil(false) },
      el("div", { class: "s-drop" }, ui.icon("upload", 28), el("b", "Drop to import accounts"), el("span", "Cookie files, or a folder of them. Nothing is sent until you press Import."))));
    if (veil) veil.hidden = !on;
    if (on) veilTimer = setTimeout(() => showVeil(false), 1500);      // a drag that ends without a dragleave must not leave the page covered
  }
  window.addEventListener("dragstart", () => { own = true; });
  window.addEventListener("dragend", () => { own = false; });
  window.addEventListener("dragenter", (e) => { if (dragsFiles(e)) showVeil(true); });
  window.addEventListener("dragover", (e) => { if (dragsFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; showVeil(true); } });
  window.addEventListener("drop", (e) => {
    if (!dragsFiles(e)) return;
    e.preventDefault(); showVeil(false);
    const d = open();
    if (d.busy()) Soop.toast("An import is running — drop the files again when it has finished", "warn");
    else d.add(fromDrop(e.dataTransfer));
  });

  // splitCookiePaste, planFile and fromDrop are here for tests/soopAccountImport.test.js.
  Soop._accountImport = { open: () => { open(); }, splitCookiePaste, planFile, fromDrop };
})();
