/* accounts.js — the "Renter accounts" section (original renters.html 473-493,
 * 549-599, 606-642).
 *
 * This inventory is intentionally outside the Drops Archive: it is the one place
 * the operator can read an account's credentials and its per-account farming
 * window, so it is also the module with the most sensitive values flowing
 * through it. Two rules from CONTRACT.md do the heavy lifting here:
 *
 *   - No runtime value is ever interpolated into JS source. Handlers get their
 *     payload from `data-id` + a lookup in this module's own arrays, or from
 *     `el.dataset.copy` assigned in JS after insertion. That is the actual fix
 *     for the three broken handlers: delAcct (login), and showCreds's two copy
 *     buttons (login:pass, token), all of which died on a `'` or `\`.
 *   - Secrets never reach markup as handler arguments. The only place a
 *     password/token is written into HTML is RT.secret()/showCreds display text,
 *     escaped, which is the point of the feature.
 *
 * Lazy-section rule: `RT.reload.accounts` is registered only after the first
 * successful load, so a global Refresh never force-fetches a section the
 * operator never opened (the old ACCS_LOADED flag).
 */
(function () {
  "use strict";

  const RT = window.RT;
  if (!RT) { console.error("accounts.js: RT (core.js) not loaded"); return; }

  // Section state. ACCS backs the page section; ROWS is the last array handed to
  // rowsHtml() by detail.js's modal — kept so modal handlers can look an account
  // up by id instead of carrying its login/secrets through the markup.
  let ACCS = [];
  let ROWS = [];
  let SHOW = false;      // reveal-secrets toggle (owned here, passed to RT.secret)
  let LOADED = false;    // first successful load happened
  let inflight = null;   // de-dupes overlapping loads (Refresh spam / double wiring)
  let inflightSel = null; // the #accFilter value `inflight` is fetching for

  // Modal-first lookup: the modal renderer needs ROWS to win, so accFarm /
  // accRemove (which read only login + farmUntil, present in BOTH payloads) use
  // this.
  const findAcc = (id) =>
    ROWS.find((x) => x && x.id === id) || ACCS.find((x) => x && x.id === id) || null;

  // Section-scoped lookup: ACCS only, never ROWS. The two payloads mint the SAME
  // id (both `String(a._id)`) but carry different fields — GET /renters/:id (the
  // modal, -> ROWS) projects login/status/dropCount/farm* only, with NO password
  // and NO token, while GET /renter-accounts (this section, -> ACCS) carries
  // both. ROWS is never cleared, so a findAcc() shadow after any Manage modal had
  // been opened made the section's copy buttons emit "login:" and "" — with a
  // "Copied" toast — while the row on screen still showed the real values.
  // Anything reading a credential off the section MUST resolve through here.
  const findSectionAcc = (id) => ACCS.find((x) => x && x.id === id) || null;

  // ---- load + render the page section ----------------------------------------

  // Read live, and tolerate a missing element the same way the original did
  // (`|| "all"`), so a filter read can never throw synchronously out of load().
  const filterVal = () => {
    const el = RT.$("accFilter");
    return (el && el.value) || "all";
  };

  // Coalescing is keyed on the filter value: two Refresh clicks for the same
  // renter share one request, but an #accFilter change mid-flight must NOT get
  // the in-flight promise for the OLD filter back (the section would keep the
  // previous renter's rows while the dropdown read the new one, with no
  // re-fetch). A different value chains a fresh load onto the current one, so
  // the newest filter renders last and wins.
  function load() {
    const sel = filterVal();
    if (inflight && inflightSel === sel) return inflight;
    const p = inflight
      ? inflight.catch(() => {}).then(() => doLoad(sel))
      : doLoad(sel);
    inflight = p;
    inflightSel = sel;
    p.catch(() => {}).then(() => {
      // Only the newest load clears the slot; an older link in the chain
      // finishing must not unlock a still-running successor.
      if (inflight === p) { inflight = null; inflightSel = null; }
    });
    return p;
  }

  async function doLoad(sel) {
    try {
      const d = await RT.api(
        "/renter-accounts" + (sel !== "all" ? "?renter=" + encodeURIComponent(sel) : "")
      );
      ACCS = d.accounts || [];
    } catch (e) {
      RT.$("rentAccs").innerHTML = '<div class="muted">' + RT.esc(e.message) + "</div>";
      return;
    }
    // Lazy rule: only now does a global Refresh get to touch this section.
    LOADED = true;
    RT.reload.accounts = load;
    render();
  }

  function render() {
    RT.$("accTotal").textContent = ACCS.length ? ACCS.length + " account(s)" : "";
    if (!ACCS.length) {
      RT.$("rentAccs").innerHTML = '<div class="muted">No renter accounts yet.</div>';
      return;
    }
    RT.$("rentAccs").innerHTML =
      '<div class="rows">' + ACCS.map(sectionRow).join("") + "</div>";
  }

  function sectionRow(a) {
    const id = RT.esc(a.id);
    return (
      '<div class="approve-item"><div>' +
        '<div><b class="mono">' + RT.esc(a.login || "—") + "</b> " +
          '<span class="muted">' + RT.esc(a.renter) +
            (a.configFile ? " · " + RT.esc(a.configFile) : "") + "</span> " +
          RT.scanBadge(a.status) + " " + RT.farmCell(a) + "</div>" +
        '<div class="lg">Password ' + RT.secret(a.password, SHOW) +
          " &nbsp;·&nbsp; Token " + RT.secret(a.token, SHOW) +
          (a.credSource ? ' <span class="muted">(' + RT.esc(a.credSource) + ")</span>" : "") +
          " &nbsp;·&nbsp; " + RT.esc(a.dropCount || 0) + " drop(s)</div>" +
      '</div><div class="acts">' +
        '<button class="btn ghost sm" data-act="accCopyPair" data-id="' + id + '">Copy login:pass</button>' +
        '<button class="btn ghost sm" data-act="accCopyToken" data-id="' + id + '">Copy token</button>' +
        '<button class="btn ghost sm" data-act="accFarm" data-id="' + id + '">Farm days</button>' +
      "</div></div>"
    );
  }

  // ---- rows rendered inside detail.js's modal (original accountRows) ----------
  // Pure: returns an html string, touches no DOM. It does remember the array it
  // was given (ROWS) so the Remove/Farm handlers can resolve a login by id —
  // that is the contract's sanctioned alternative to putting values in markup.
  function rowsHtml(accs) {
    ROWS = Array.isArray(accs) ? accs : [];
    if (!ROWS.length) return '<div class="muted">No accounts yet.</div>';
    return (
      '<div class="rows">' +
      ROWS.map((a) => {
        const id = RT.esc(a.id);
        return (
          '<div class="approve-item"><div><b class="mono">' + RT.esc(a.login || "—") + "</b> " +
            RT.farmCell(a) + " · " + RT.esc(a.dropCount || 0) + " drop(s) · " +
            '<span class="muted">' +
              (a.lastScanAt ? "scanned " + new Date(a.lastScanAt).toLocaleString() : "never scanned") +
            "</span>" +
            (a.error && a.status !== "ok" ? '<div class="lg">' + RT.esc(a.error) + "</div>" : "") +
          '</div><div class="acts">' + RT.scanBadge(a.status) +
            '<button class="btn ghost sm" data-act="accCreds" data-id="' + id + '">Creds</button>' +
            '<button class="btn ghost sm" data-act="accScan" data-id="' + id + '">Scan</button>' +
            '<button class="btn ghost sm" data-act="accFarm" data-id="' + id + '">Farm days</button>' +
            '<button class="btn danger sm" data-act="accRemove" data-id="' + id + '">Remove</button>' +
          "</div>" +
          '<div class="credslot" id="creds-' + id + '"></div></div>'
        );
      }).join("") +
      "</div>"
    );
  }

  // ---- handlers ---------------------------------------------------------------

  // Reveal one account's live login / token / password. Superadmin-only data:
  // the renter's own portal never sees either the token or the password.
  async function showCreds(id, btn) {
    const box = RT.$("creds-" + id);
    if (!box) return;
    if (box.innerHTML) {
      box.innerHTML = "";
      if (btn) btn.textContent = "Creds";
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      const d = await RT.api("/renter-accounts/" + id + "/creds");
      const a = d.account || {};
      const pw = a.password
        ? "<code>" + RT.esc(a.password) + "</code>"
        : '<span class="muted">not stored anywhere — the token still works</span>';
      box.innerHTML =
        '<div class="credline">' +
          "<div><b>Login</b> <code>" + RT.esc(a.login || "—") + "</code></div>" +
          "<div><b>Password</b> " + pw +
            (a.source ? ' <span class="muted">(' + RT.esc(a.source) + ")</span>" : "") + "</div>" +
          (a.email ? "<div><b>Email</b> <code>" + RT.esc(a.email) + "</code></div>" : "") +
          "<div><b>Token</b> <code>" + RT.esc(a.token || "—") + "</code></div>" +
          '<div style="margin-top:7px;display:flex;gap:6px;flex-wrap:wrap">' +
            '<button class="btn ghost sm" data-act="accCopyVal">Copy login:pass</button>' +
            '<button class="btn ghost sm" data-act="accCopyVal">Copy token</button>' +
          "</div>" +
        "</div>";
      // The two copy payloads come straight off this response and may contain
      // quotes or backslashes, so they are assigned AFTER insertion — never
      // rendered into the html above (this is the original's broken spot).
      const btns = box.querySelectorAll('button[data-act="accCopyVal"]');
      if (btns[0]) btns[0].dataset.copy = (a.login || "") + ":" + (a.password || "");
      if (btns[1]) btns[1].dataset.copy = a.token || "";
      if (btn) btn.textContent = "Hide";
    } catch (e) {
      RT.toast(e.message);
      if (btn) btn.textContent = "Creds";
    }
    if (btn) btn.disabled = false;
  }

  // Rescan one renter account now (clears a stale token_invalid, verifies a fix).
  async function scanAcct(id, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Scanning…"; }
    try {
      const d = await RT.api("/renter-accounts/" + id + "/scan", { method: "POST" });
      RT.toast("Scanned — " + (d.newDrops || 0) + " new drop(s), " + (d.total || 0) + " total");
    } catch (e) {
      RT.toast(e.message);
    }
    // Mirror showCreds: restore the button BEFORE the reopen. reopen() normally
    // replaces this node, but it is a no-op when nothing is open and it never
    // runs at all if it throws — either way an error must not leave the button
    // stuck on a disabled "Scanning…" for the life of the modal.
    if (btn) { btn.disabled = false; btn.textContent = "Scan"; }
    RT.detail.reopen();
    RT.reloadMany(["bots"]);
  }

  // Remove one renter account (a dead one): pulled off the bot + deleted from
  // the renter's inventory. Their farmed drops stay in the archive.
  async function delAcct(id) {
    const a = findAcc(id) || {};
    if (!confirm("Remove " + (a.login || "this account") + " from this renter? It is pulled off the bot and deleted from their inventory (farmed drops stay in the archive).")) return;
    try {
      const d = await RT.api("/renter-accounts/" + id, { method: "DELETE" });
      RT.toast(d.note || "Account removed");
      await RT.reloadMany(["renters", "bots", "accounts"]);
      RT.detail.reopen();
    } catch (e) {
      RT.toast(e.message);
    }
  }

  // Set or clear one account's farming window without touching the renter's own
  // lease.
  async function setFarm(id) {
    const a = findAcc(id) || {};
    const ans = prompt(
      "Farm " + (a.login || "this account") + " for how many days from now?\n\n0 = no limit (runs as long as the renter's lease).",
      a.farmUntil ? String(Math.max(1, Math.ceil((new Date(a.farmUntil) - Date.now()) / 864e5))) : "15"
    );
    if (ans === null) return;
    const days = parseInt(ans, 10);
    if (!(days >= 0)) return RT.toast("Enter a number of days");
    try {
      const d = await RT.api("/renter-accounts/" + id + "/farm", {
        method: "POST",
        body: JSON.stringify({ days }),
      });
      RT.toast(d.farmUntil ? "Farms until " + RT.fmtDate(d.farmUntil) : "Farming window cleared");
      RT.reloadMany(["accounts"]);
    } catch (e) {
      RT.toast(e.message);
    }
  }

  // ---- registration (no fetching at load) ------------------------------------
  // Every action below is dispatched by a [data-act] element this module renders
  // (sectionRow, rowsHtml, showCreds). There is deliberately no action for the
  // section's Load/Refresh buttons: those are plain static markup wired by
  // boot.js, so an action name for them would be dead code.

  // These two read a PASSWORD and a TOKEN, so they resolve through
  // findSectionAcc (ACCS only). findAcc would let a stale ROWS entry from an
  // already-opened Manage modal — a payload with neither field — shadow the real
  // one and copy "login:" / "" behind a "Copied" toast.
  RT.on("accCopyPair", (el, ds) => {
    const a = findSectionAcc(ds.id);
    if (!a) return RT.toast("Account not found");
    RT.copy((a.login || "") + ":" + (a.password || ""));
  });
  RT.on("accCopyToken", (el, ds) => {
    const a = findSectionAcc(ds.id);
    if (!a) return RT.toast("Account not found");
    RT.copy(a.token || "");
  });
  RT.on("accCopyVal", (el, ds) => RT.copy(ds.copy || ""));
  RT.on("accFarm", (el, ds) => setFarm(ds.id));
  RT.on("accCreds", (el, ds) => showCreds(ds.id, el));
  RT.on("accScan", (el, ds) => scanAcct(ds.id, el));
  RT.on("accRemove", (el, ds) => delAcct(ds.id));

  // Reveal secrets: this module owns the flag, so it owns the button. This is
  // the ONLY static element accounts.js listens on — #loadAccsBtn, #refreshAccs
  // and #accFilter are wired by boot.js alone, and a second listener here would
  // fire a duplicate fetch on every click.
  const revealBtn = RT.$("accReveal");
  if (revealBtn) {
    revealBtn.addEventListener("click", () => {
      SHOW = !SHOW;
      revealBtn.textContent = SHOW ? "Hide secrets" : "Show secrets";
      render();
    });
  }

  RT.accounts = {
    rowsHtml,
    // Contract surface: no-op until the section has been loaded once.
    reload: () => (LOADED ? load() : Promise.resolve()),
    // First-open entry point, called directly by boot.js's "Load renter
    // accounts" / section "Refresh" buttons and by an #accFilter change once the
    // section is open. It has to be direct: RT.reload.accounts does not exist
    // until the load below succeeds, and RT.reloadMany would skip the key.
    load,
  };
})();
