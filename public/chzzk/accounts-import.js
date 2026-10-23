/* CHZZK farm — the login import dialog and the page-wide file drop (contract §4.3).
   Logins arrive as Cookie-Editor exports: files dropped anywhere on the page or
   chosen (many at once), and pasted text. Each file, and the paste box, goes in
   a POST of its own to /accounts/import; every login the server finds in it gets
   one result line. Cookie text is a secret: it is only ever POSTed — never shown,
   logged, toasted or put in a URL — and it is dropped once it has been sent. */
(function () {
  "use strict";
  if (!window.Chzzk) return;
  const { el, ui, fmt } = Chzzk;
  const MAX_BYTES = 90 * 1024;                   // the server's cap, measured as it does: UTF-8 bytes of the trimmed text
  const READ_CAP = 1024 * 1024;                  // a file this big is not even read
  const MAX_FILES = 200;                         // one queue; each file is a request that asks CHZZK who the login is
  const ROW = { padding: "6px 10px" };
  const COOKIE_FILE = /\.(json|txt)$/i;

  const plural = (n, word) => fmt.num(n) + " " + word + (n === 1 ? "" : "s");
  const kb = (n) => fmt.num(Math.max(1, Math.ceil(n / 1024))) + " kB";
  const enc = new TextEncoder(), bytes = (s) => enc.encode(s).length;
  const put = (node, ...kids) => { node.textContent = ""; node.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return node; };
  const isCookieFile = (f) => COOKIE_FILE.test(f.name) || f.type === "application/json" || f.type === "text/plain";
  const sameFile = (a, b) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
  const readText = (file) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === "string" ? r.result : null);
    r.onerror = r.onabort = () => resolve(null);
    try { r.readAsText(file); } catch (e) { resolve(null); }
  });

  function lifetime(r) {
    if (r.cookieKind === "session") return { text: "session only", cls: "s-warn", title: "Ends when this CHZZK session does. Sign in with 'Stay signed in' ticked and import again to keep it longer." };
    if (r.cookieKind === "persistent") return { text: r.cookieExpiresAt ? "keeps until " + fmt.when(r.cookieExpiresAt) : "stays signed in", cls: "s-ok" };
    return { text: "lifetime unknown", cls: "s-muted" };
  }
  // The server's reasons, in the operator's words where one is known. Server
  // errors never carry cookie text (checked against utils/chzzk/cookies.js).
  function reason(err) {
    const e = String(err || "").slice(0, 300);
    if (!e) return "the server gave no reason";
    if (/logged out/i.test(e)) return "logged out — sign in to naver.com again ('Stay signed in' ticked), export, and import that";
    if (/^Egress:/i.test(e)) return "could not reach CHZZK (egress is down) — try again in a minute";
    if (/userIdHash/.test(e)) return "CHZZK did not say who this login is — export again while signed in";
    return e;
  }

  // ---- the dialog ---------------------------------------------------------------
  let dialog = null;                             // the one open dialog: { add(files) }
  function open(files) {
    if (!dialog) dialog = build();
    if (files) dialog.add(files);
  }

  function build() {
    let queue = [], running = false, stop = false, alive = true;
    const pick = el("input", { type: "file", multiple: true, hidden: true, accept: ".json,.txt,application/json,text/plain",
      onChange: () => { add(pick.files); pick.value = ""; } });
    const area = el("textarea", { class: "s-textarea", rows: 6, spellcheck: "false", autocomplete: "off", autocapitalize: "off",
      "data-autofocus": true, placeholder: "Paste a Cookie-Editor export here", onInput: () => recount() });
    const hint = el("span", { class: "s-help", "aria-live": "polite" });
    const go = ui.button("Import", { tone: "primary", icon: "upload", disabled: true, onClick: () => start() });
    const tally = el("b", { role: "status" }), files = el("ul", { class: "s-list" });
    const fileBox = el("div", { class: "s-stack is-tight", hidden: true },
      el("div", { class: "s-spread" }, tally, ui.button("Remove all", { size: "sm", tone: "ghost", onClick: () => { queue = []; draw(); } })),
      el("div", { class: "s-scroll" }, files));
    const status = el("span", { class: "s-small", role: "status" }), results = el("ul", { class: "s-list" });
    const resultBox = el("div", { class: "s-stack is-tight", hidden: true }, el("p", { class: "s-eyebrow" }, "Results"), status, el("div", { class: "s-scroll" }, results));
    const body = el("div", { class: "s-stack" },
      el("div", { class: "s-note" }, ui.icon("info"), el("span", null,
        "Cookie-Editor export of chzzk.naver.com / naver.com while signed in. Tick 'Stay signed in' (로그인 상태 유지) when you sign in — those cookies last much longer.")),
      el("div", { class: "s-drop" }, ui.icon("upload", 22), el("b", "Drop cookie files anywhere on this page"),
        el("span", null, ".json or .txt, many at once — each file is imported on its own"),
        ui.button("Choose files", { size: "sm", onClick: () => pick.click() }), pick),
      fileBox,
      el("label", { class: "s-field" }, "Or paste one or more exports", area, hint),
      el("p", { class: "s-muted s-small" }, "Cookies are stored encrypted and are never shown again. Closing this dialog stops an import that is running."),
      resultBox);
    const m = Chzzk.modal({ title: "Import CHZZK logins", size: "lg", sticky: true, body,
      actions: [ui.button("Close", { onClick: () => m.close() }), go],
      onClose: () => { alive = false; stop = true; dialog = null; area.value = ""; queue = []; } });

    function recount() {
      const t = area.value.trim(), size = t ? bytes(t) : 0, over = size > MAX_BYTES;
      hint.className = "s-help" + (over ? " s-warn" : "");
      hint.textContent = !t ? "Nothing pasted." : kb(size) + " pasted" + (over ? " — over 90 kB, so it will not be sent. Split it into smaller pastes or files." : " — sent as one import.");
      area.disabled = running;
      go.disabled = running || !(queue.length || t);
    }
    function fileRow(f) {
      const big = f.size > MAX_BYTES;
      return el("li", { class: "s-list-item", style: ROW }, ui.dot(big ? "warn" : "ok", big ? "Too large" : "Queued"),
        el("span", { class: "s-grow s-trunc", title: f.name }, el("b", f.name),
          el("span", { class: big ? "s-warn" : "s-muted" }, " — " + kb(f.size) + (big ? ", over 90 kB — it will not be sent" : ""))),
        ui.button("", { size: "sm", tone: "ghost", icon: "x", title: "Remove " + f.name, onClick: () => { queue = queue.filter((x) => x !== f); draw(); } }));
    }
    function draw() {
      const big = queue.filter((f) => f.size > MAX_BYTES).length;
      fileBox.hidden = !queue.length;
      tally.textContent = plural(queue.length, "file") + " queued" + (big ? " · " + fmt.num(big) + " too large" : "");
      put(files, queue.map(fileRow));
      recount();
    }
    // Files are only queued here; nothing is read or sent before Import is pressed.
    function add(list) {
      const all = Array.prototype.slice.call(list || []).filter((f) => f instanceof Blob && typeof f.name === "string");
      let skipped = 0, dupes = 0, over = 0;
      all.forEach((f) => {
        if (!isCookieFile(f)) skipped++;
        else if (queue.some((q) => sameFile(q, f))) dupes++;
        else if (queue.length >= MAX_FILES) over++;
        else queue.push(f);
      });
      if (skipped) Chzzk.toast(plural(skipped, "file") + " skipped — only .json or .txt cookie exports are read", "warn");
      if (dupes) Chzzk.toast(plural(dupes, "file") + (dupes === 1 ? " is" : " are") + " already queued", "info");
      if (over) Chzzk.toast("Only " + MAX_FILES + " files fit in one import — " + plural(over, "file") + " left out", "warn");
      draw();
    }

    // ---- the run: one request per file, then one for the paste ----
    function line(label) {
      const li = el("li", { class: "s-list-item", style: ROW });
      li.set = (tone, say, ...kids) => put(li, ui.dot(tone, say), el("span", { class: "s-grow" }, kids));
      li.set(null, "Waiting", el("b", label), el("span", { class: "s-muted" }, " — waiting its turn"));
      return li;
    }
    function showResult(li, r, label) {
      if (!r.ok) return li.set("error", "Failed", el("b", label), el("span", { class: "s-error" }, " — " + reason(r.error)));
      const life = lifetime(r);
      li.set("ok", "Imported", el("b", r.nickname || "No nickname"), el("span", { class: "s-mono s-muted" }, " (" + (r.userIdHash8 || "–") + ")"),
        " — " + (r.created ? "new" : "updated") + " — ", el("span", { class: life.cls, title: life.title || null }, life.text),
        el("span", { class: "s-muted s-small" }, " · " + label));
    }
    async function send(job) {                   // -> results[]; local refusals look like the server's
      let text = job.text;
      job.text = "";
      if (job.file) {
        if (job.file.size > READ_CAP) return [{ ok: false, error: "too large to be a cookie export (" + kb(job.file.size) + ") — not sent" }];
        text = await readText(job.file);
        if (text == null) return [{ ok: false, error: "could not be read — choose it again" }];
      }
      text = text.trim();
      if (!text) return [{ ok: false, error: "empty — nothing to send" }];
      const size = bytes(text);
      if (size > MAX_BYTES) return [{ ok: false, error: "too large to send (" + kb(size) + ", over 90 kB) — split it into smaller files" }];
      try {
        const res = (await Chzzk.api.post("/accounts/import", { cookies: text })).results;
        return Array.isArray(res) && res.length ? res : [{ ok: false, error: "no CHZZK login found in it" }];
      } catch (e) {
        if (e && (e.status === 401 || e.status === 403)) stop = true;
        return [{ ok: false, error: (e && e.message) || "the request failed" }];
      }
    }
    async function start() {
      if (running) return;
      const jobs = queue.map((file) => ({ label: file.name, file }));
      const pasted = area.value.trim();
      if (pasted) jobs.push({ label: "pasted text", text: pasted });
      if (!jobs.length) return;
      queue = []; running = true; stop = false; draw();
      resultBox.hidden = false; status.className = "s-small";
      put(results);
      const lines = jobs.map((j) => results.appendChild(line(j.label)));
      let ok = 0, fresh = 0, session = 0, failed = 0, sent = 0;
      try {
        for (let i = 0; i < jobs.length && !stop; i++) {
          status.textContent = "Importing " + (i + 1) + " of " + jobs.length + "…";
          lines[i].set("info", "Importing", el("b", jobs[i].label), el("span", { class: "s-muted" }, " — importing…"));
          if (!results.matches(":hover")) lines[i].scrollIntoView({ block: "nearest" });      // follow the run, unless the list is being read
          const res = await send(jobs[i]);
          sent++;
          let li = null;                         // one line per login found, in the server's order
          res.forEach((r) => {
            li = li ? results.insertBefore(line(jobs[i].label), li.nextSibling) : lines[i];
            if (r && r.ok) { ok++; if (r.created) fresh++; if (r.cookieKind === "session") session++; } else failed++;
            showResult(li, r || {}, jobs[i].label);
          });
        }
      } finally {
        jobs.forEach((j) => { j.text = ""; j.file = null; });
        running = false;
      }
      for (let i = sent; i < jobs.length; i++) lines[i].set(null, "Not sent", el("b", jobs[i].label), el("span", { class: "s-muted" }, " — not sent, the import was stopped"));
      if (ok) { area.value = ""; Chzzk.refresh(); }
      const left = jobs.length - sent;
      const text = (ok ? plural(ok, "login") + " imported" + (fresh ? " (" + fmt.num(fresh) + " new)" : "") : "No login was imported")
        + (failed ? ", " + fmt.num(failed) + " failed" : "") + (left ? ", " + fmt.num(left) + " not sent" : "") + ".";
      const tone = ok && !failed && !left ? "ok" : ok ? "warn" : "error";
      if (!alive) { Chzzk.toast("Import stopped when the dialog closed: " + text, tone); return; }
      status.className = "s-small s-" + tone;
      status.textContent = text + (session ? " " + (session === 1 ? "One is" : fmt.num(session) + " are") + " session only — sign in with 'Stay signed in' ticked and import again to keep " + (session === 1 ? "it" : "them") + " longer." : "");
      draw();
    }

    draw();
    return { add };
  }

  // ---- dropping files anywhere on the page --------------------------------------
  // The veil covers the page while files are dragged over the window, so a drop
  // cannot miss and make the browser open the file (and show its cookies) instead.
  let veil = null, veilTimer = 0, own = false;   // own: the drag began on this page (an image, a link) — not a file brought in
  const dragsFiles = (e) => !own && !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1;
  function showVeil(on) {
    clearTimeout(veilTimer);
    if (!veil && on) veil = document.body.appendChild(el("div", { class: "s-dropveil", hidden: true, onClick: () => showVeil(false), onDragleave: () => showVeil(false) },
      el("div", { class: "s-drop" }, ui.icon("upload", 28), el("b", "Drop to import CHZZK logins"), el("span", null, "Cookie files (.json or .txt). Nothing is sent until you press Import."))));
    if (veil) veil.hidden = !on;
    if (on) veilTimer = setTimeout(() => showVeil(false), 1500);      // a drag that ends without a dragleave must not leave the page covered
  }
  // Files of one drop, taken at once (the browser empties a DataTransfer when the
  // handler returns). Folders are counted, not opened.
  function dropped(dt) {
    const out = [];
    let folders = 0;
    Array.prototype.forEach.call(dt.items || [], (it) => {
      if (it.kind !== "file") return;
      const entry = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
      if (entry && entry.isDirectory) { folders++; return; }
      const file = it.getAsFile();
      if (file) out.push(file);
    });
    if (!out.length && !folders) Array.prototype.forEach.call(dt.files || [], (f) => out.push(f));
    return { files: out, folders };
  }
  window.addEventListener("dragstart", () => { own = true; });
  window.addEventListener("dragend", () => { own = false; });
  window.addEventListener("mousemove", () => { own = false; });     // no mouse events fire mid-drag; this un-sticks `own` if dragend never reached us
  window.addEventListener("dragenter", (e) => { if (dragsFiles(e)) showVeil(true); });
  window.addEventListener("dragover", (e) => { if (dragsFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; showVeil(true); } });
  window.addEventListener("drop", (e) => {
    if (!dragsFiles(e)) { own = false; return; }
    e.preventDefault(); showVeil(false);
    const { files, folders } = dropped(e.dataTransfer);
    if (folders) Chzzk.toast(plural(folders, "folder") + " not opened — drop the cookie files inside instead", "warn");
    if (files.length || !folders) open(files);
  });

  window.ChzzkImport = { open: (files) => { open(files); } };
})();
