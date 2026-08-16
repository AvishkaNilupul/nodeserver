/* approvals.js — pending renter submissions: list + reveal/approve/reject modal.
   Ported from public/renters.html lines 305-339 (loadApprovals / reveal / copyCreds /
   approve / reject). Front-end only: endpoints, request bodies and rendered fields
   are unchanged.

   Security notes (see renters/CONTRACT.md):
   - No inline on* handlers, no window.* handler globals: every button carries
     data-act (+ data-id) and is dispatched by core.js.
   - Submitted username:password lines are still shown in the readonly #credOut
     textarea (superadmin-only view, intended), but they are assigned via
     el.value AFTER insertion — no credential ever reaches an HTML string, a
     data-* attribute, or a JS string literal. Cleared again on modal close.
*/
(function () {
  "use strict";

  var RT = window.RT;
  if (!RT) { console.error("approvals.js: RT (core.js) not loaded"); return; }

  // Call through RT so a `this`-dependent implementation still works.
  var $ = function (id) { return RT.$(id); };
  var esc = function (s) { return RT.esc(s); };
  var toast = function (m) { return RT.toast(m); };
  var api = function (path, opts) { return RT.api(path, opts); };

  // ---- list ----------------------------------------------------------------

  function itemHtml(x) {
    var id = esc(String(x.id == null ? "" : x.id));
    var who = x.renter ? esc(x.renter.username) : "?";
    var logins = (x.logins && x.logins.length)
      ? '<div class="lg">' + esc(x.logins.slice(0, 8).join(", ")) + (x.logins.length > 8 ? " …" : "") + "</div>"
      : "";
    return '<div class="approve-item"><div><div><b>' + who + "</b> · " +
      esc(String(x.count)) + ' account(s) · <span class="muted">' +
      esc(new Date(x.createdAt).toLocaleString()) + "</span></div>" +
      logins +
      '</div><div class="acts">' +
        '<button class="btn sm" data-act="subReveal" data-id="' + id + '">Process</button>' +
        '<button class="btn danger sm" data-act="subReject" data-id="' + id + '">Reject</button>' +
      "</div></div>";
  }

  async function loadApprovals() {
    try {
      var d = await api("/renter-submissions?status=pending");
      var s = d.submissions || [];
      RT.setMetric("Pending", s.length, s.length ? "Needs review" : "Queue clear", s.length ? "warn" : "good");
      var pc = $("pendCount");
      if (pc) {
        pc.style.display = s.length ? "" : "none";
        pc.textContent = s.length + " pending";
      }
      if (!s.length) {
        $("approvals").innerHTML = '<div class="muted" style="padding:6px 2px">Nothing waiting for approval.</div>';
        return;
      }
      $("approvals").innerHTML = s.map(itemHtml).join("");
    } catch (e) {
      RT.setMetric("Pending", "—", "Unavailable", "alert");
      $("approvals").innerHTML = '<div class="muted">' + esc(e.message) + "</div>";
    }
  }

  // ---- process (reveal) modal ---------------------------------------------

  // Process a submission: reveal username:password, paste the tokens you fetched, approve.
  async function reveal(el, ds) {
    var id = (ds && ds.id) || "";
    if (!id) return;
    try {
      var d = await api("/renter-submissions/" + encodeURIComponent(id) + "/creds");
      var creds = (d.accounts || [])
        .map(function (a) { return a.username + ":" + a.password + (a.email ? ":" + a.email : ""); })
        .join("\n");

      RT.openModal(
        '<div class="mh"><div><h2 style="font-size:17px">Process submission</h2>' +
          '<div class="sub">Copy the accounts, fetch their ClientSecrets, paste the tokens, then Approve &amp; start.</div>' +
          '</div><button class="btn ghost sm" data-act="closeModal">Close</button></div>' +
        '<label class="fld">Submitted accounts (username:password)</label>' +
        '<textarea id="credOut" style="min-height:110px" readonly></textarea>' +
        '<div style="margin:8px 0 4px"><button class="btn ghost sm" data-act="subCopyCreds">Copy all</button></div>' +
        '<label class="fld" style="margin-top:10px">Account tokens — paste ClientSecrets (one per line, or "login token", or JSON)</label>' +
        '<textarea id="tokOut" style="min-height:120px" placeholder="token&#10;login token&#10;or the JSON from a config"></textarea>' +
        '<div style="display:flex;gap:8px;margin-top:14px">' +
          '<button class="btn" data-act="subApprove" data-id="' + esc(id) + '">Approve &amp; start</button>' +
          '<button class="btn danger" data-act="subReject" data-id="' + esc(id) + '">Reject</button>' +
        "</div>"
      );

      // Credentials go in by value, never through markup.
      var out = $("credOut");
      if (out) out.value = creds;

      var wiped = false;
      RT.onClose(function () {
        if (wiped) return;
        wiped = true;
        var t = $("credOut");
        if (t) t.value = "";
        creds = "";
      });
    } catch (e) { toast(e.message); }
  }

  function copyCreds() {
    var t = $("credOut");
    RT.copy(t ? t.value : "");
  }

  // ---- approve / reject ----------------------------------------------------

  async function approve(el, ds) {
    var id = (ds && ds.id) || "";
    if (!id) return;
    var btn = el;
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    var tEl = $("tokOut");
    var tokens = tEl ? tEl.value : "";
    try {
      var d = await api("/renter-submissions/" + encodeURIComponent(id) + "/approve",
        { method: "POST", body: JSON.stringify({ tokens: tokens }) });
      toast(d.note || "Approved");
      RT.closeModal();
      await RT.reloadMany(["approvals", "renters"]);
    } catch (e) {
      toast(e.message);
      if (btn) { btn.disabled = false; btn.textContent = "Approve & start"; }
    }
  }

  async function reject(el, ds) {
    var id = (ds && ds.id) || "";
    if (!id) return;
    var reason = prompt("Reason (optional):") || "";
    try {
      await api("/renter-submissions/" + encodeURIComponent(id) + "/reject",
        { method: "POST", body: JSON.stringify({ reason: reason }) });
      toast("Rejected");
      RT.closeModal();
      await RT.reloadMany(["approvals"]);
    } catch (e) { toast(e.message); }
  }

  // ---- register (no fetching at load) -------------------------------------

  RT.on("subReveal", reveal);
  RT.on("subCopyCreds", copyCreds);
  RT.on("subApprove", approve);
  RT.on("subReject", reject);
  RT.reload.approvals = loadApprovals;
})();
